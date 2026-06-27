/**
 * useScanner — IndexedDB-backed announcement scanner.
 * - Primary: single GraphQL fetch to Subgraph (latest 1000 announcements). No getLogs in this path.
 * - Fallback: if Subgraph fetch fails, uses chunked RPC getLogs (adaptive range, halve on limit).
 * - Loads cached events first; incremental sync from lastScannedSlot when using RPC.
 * - Per-chain sync state; back-fill "Optimizing Vault... [%]" when cache empty (RPC path).
 * - WASM matching offloaded with requestIdleCallback; call markSyncComplete when done (indexer path).
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { Buffer } from "buffer";
import {
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { StellarNetwork } from "../lib/chain";
import {
  getAnnouncementsForCluster,
  getSyncState,
  setSyncState,
  clearSyncState,
  putAnnouncements,
  clearClusterCache,
  saveScanCheckpoint,
  getScanCheckpoint,
  validateCheckpoint,
  clearScanCheckpoint,
  type CachedAnnouncement,
} from "../lib/opaqueCache";
import { getSorobanServer } from "../lib/stellar";
import {
  getUserFacingSyncMessage,
  logSyncError,
} from "../lib/syncErrorUtils";
import { getStoredGhostEntries } from "../store/ghostAddressStore";
import { getManifestForNetwork } from "../contracts/deploymentManifest";
import { getNetworkPassphrase } from "../lib/chain";
import {
  scanAnnouncementsInWorker,
  type ScannerAnnouncement,
} from "../lib/scannerWorker/scannerWorkerClient";

export { scanAnnouncementsInWorker, type ScannerAnnouncement };

const SUPPORTED_EVENT_VERSION = 1;

/**
 * Number of announcements per scanner worker batch.
 * Tunable via VITE_SCANNER_CHUNK_SIZE env var; defaults to 200 (#401).
 */
export const SCANNER_CHUNK_SIZE: number = (() => {
  const raw = typeof import.meta !== "undefined"
    ? (import.meta.env?.VITE_SCANNER_CHUNK_SIZE as string | undefined)
    : undefined;
  const parsed = raw != null ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 200;
})();

/**
 * Minimal chain-read surface the scanner needs. Backed by the Horizon-derived
 * `connection` adapter from `useWallet` (native balance + latest ledger).
 */
export interface ScannerConnection {
  getBalance: (address: string) => Promise<bigint>;
  getTokenBalances?: (address: string) => Promise<Record<string, bigint>>;
  getSlot: () => Promise<number>;
}

type PublicClient = ScannerConnection | null;

export type ScanProgress = {
  phase: "idle" | "loading-cache" | "indexer-fetch" | "indexer-fetched" | "syncing" | "backfilling" | "matching" | "done" | "error";
  /** 0–100 for backfilling/syncing */
  percent: number;
  message: string;
  fromBlock: bigint;
  toBlock: bigint;
  currentBlock: bigint;
  error: string | null;
  warning: string | null;
  unsupportedEventVersionCount: number;
  /** RPC rate limit retry status */
  retryStatus?: {
    attempt: number;
    maxRetries: number;
    delayMs: number;
    reason: string;
  };
};

export type UseScannerOptions = {
  cluster: StellarNetwork | null;
  publicClient: PublicClient | null;
  announcerAddress: string | null;
  enabled: boolean;
  ghostAddresses?: string[];
  watchlistAddresses?: string[];
};

export type WatchlistBalances = {
  eth: Record<string, bigint>;
  tokens: Record<string, Record<string, bigint>>;
};

export type UseScannerResult = {
  /** All cached + newly synced announcements for the chain (raw, not yet matched with WASM) */
  announcements: CachedAnnouncement[];
  progress: ScanProgress;
  /** Native balance per ghost/watchlist address (manual scan). Use for displaying/claiming manual receives. */
  ghostBalances: Record<string, bigint>;
  /** Trustline balances per ghost/watchlist address, keyed as "CODE:ISSUER". */
  ghostTokenBalances: Record<string, Record<string, bigint>>;
  /** Whether we are in "back-fill" (cache was empty, scanning from START_BLOCK) */
  isBackfilling: boolean;
  /** Trigger a full rescan from ledger 1 (clears cache for this chain) */
  retrySync: () => Promise<void>;
  /** Re-run scan from lastScannedSlot+1 to latest (incremental) */
  refresh: () => Promise<void>;
  /** Call when WASM matching has finished (e.g. after indexer path) so progress can move to "done" */
  markSyncComplete: () => void;
};

export function getStartBlock(cluster: StellarNetwork, fullRescan = false): bigint {
  if (fullRescan) return 1n;
  const manifest = getManifestForNetwork(cluster);
  if (!manifest) return 1n;
  if (
    manifest.deploymentLedger == null ||
    !Number.isSafeInteger(manifest.deploymentLedger) ||
    manifest.deploymentLedger < 1
  ) {
    throw new Error(
      `[Opaque] Missing deploymentLedger in deployments/v1/${cluster}.json. Set the manifest deployment ledger, or use Full Rescan to scan from ledger 1.`,
    );
  }
  return BigInt(manifest.deploymentLedger);
}

function getSubgraphUrl(_cluster: StellarNetwork): string | null {
  return null;
}

/** Subgraph / indexer path disabled (no Apollo client). */
async function fetchFromSubgraph(
  _subgraphUrl: string,
  _cluster: StellarNetwork
): Promise<CachedAnnouncement[] | null> {
  return null;
}

async function fetchLogsAdaptive(
  announcerAddress: string,
  fromBlock: bigint,
  toBlock: bigint,
  _cluster: StellarNetwork,
  onChunk: (from: bigint, to: bigint, logs: Parameters<typeof putAnnouncements>[1], skippedUnsupportedVersions: number) => Promise<void>,
  onRetry?: (attempt: number, delayMs: number, error: string) => void
): Promise<void> {
  const publicClient = getSorobanServer();
  let currentFrom = fromBlock;
  const BATCH_SIZE = 10000n; // Ledger range per call

  const MAX_RETRIES = 5;
  const BASE_DELAY_MS = 1000;
  const MAX_DELAY_MS = 32000;

  async function fetchWithBackoff(startLedger: number, attempt = 0): Promise<any> {
    try {
      const response = await publicClient.getEvents({
        startLedger,
        filters: [
          {
            type: "contract",
            contractIds: [announcerAddress],
            topics: [[xdr.ScVal.scvSymbol("Announcement").toXDR("base64")]],
          },
        ],
      });
      return response;
    } catch (error: any) {
      const is429 = error?.response?.status === 429 || 
                    error?.status === 429 ||
                    error?.message?.includes("429") ||
                    error?.message?.toLowerCase().includes("rate limit");

      if (is429 && attempt < MAX_RETRIES) {
        const delayMs = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
        const errorMsg = error?.message || "Rate limit exceeded";
        
        if (onRetry) {
          onRetry(attempt + 1, delayMs, errorMsg);
        }
        
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return fetchWithBackoff(startLedger, attempt + 1);
      }
      
      throw error;
    }
  }

  while (currentFrom <= toBlock) {
    const currentTo =
      currentFrom + BATCH_SIZE > toBlock ? toBlock : currentFrom + BATCH_SIZE;

    const response = await fetchWithBackoff(Number(currentFrom));

    let skippedUnsupportedVersions = 0;
    const mapped: Parameters<typeof putAnnouncements>[1] = [];

    for (const ev of response.events) {
      const eventVersion = readEventVersion(ev);
      if (eventVersion != null && eventVersion > SUPPORTED_EVENT_VERSION) {
        skippedUnsupportedVersions += 1;
        continue;
      }
      // Event value is (scheme_id, stealth_address, caller, ephemeral_pub_key, metadata)
      const val = scValToNative(ev.value) as Uint8Array[];
      // Use the Soroban event's own unique ID as the dedup key so that
      // re-fetching the same event (e.g. after an RPC retry or reorg) always
      // resolves to the same IndexedDB record, preventing duplicate entries (#402).
      const eventId: string = (ev as { id?: string }).id ?? `${ev.txHash}-${ev.ledger}`;
      mapped.push({
        eventId,
        transactionSignature: ev.txHash,
        logIndex: 0,
        slot: ev.ledger,
        args: {
          stealthAddress: "0x" + Buffer.from(val[1]).toString("hex"),
          ephemeralPubKey: "0x" + Buffer.from(val[3]).toString("hex"),
          metadata: "0x" + Buffer.from(val[4]).toString("hex"),
        },
      });
    }

    await onChunk(currentFrom, currentTo, mapped, skippedUnsupportedVersions);
    currentFrom = currentTo + 1n;
  }
}

function readEventVersion(ev: unknown): number | null {
  const topics =
    typeof ev === "object" && ev !== null && "topic" in ev
      ? (ev as { topic?: unknown[] }).topic
      : typeof ev === "object" && ev !== null && "topics" in ev
        ? (ev as { topics?: unknown[] }).topics
        : undefined;
  if (!Array.isArray(topics) || topics.length < 2) return null;
  const rawVersion = topics[1];
  try {
    const native = rawVersion instanceof xdr.ScVal ? scValToNative(rawVersion) : rawVersion;
    if (typeof native === "number") return native;
    if (typeof native === "bigint") return Number(native);
    if (typeof native === "string") {
      try {
        const fromXdr = scValToNative(xdr.ScVal.fromXDR(native, "base64"));
        const parsedFromXdr = Number(fromXdr);
        if (Number.isFinite(parsedFromXdr)) return parsedFromXdr;
      } catch {
        // Fall back to numeric strings below.
      }
      const parsed = Number(native);
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (typeof native === "object" && native !== null && "value" in native) {
      const parsed = Number((native as { value: unknown }).value);
      return Number.isFinite(parsed) ? parsed : null;
    }
  } catch {
    return null;
  }
  return null;
}

async function checkWatchlistBalances(
  connection: NonNullable<PublicClient>,
  watchlist: string[],
): Promise<WatchlistBalances> {
  const eth: Record<string, bigint> = {};
  const tokensOut: Record<string, Record<string, bigint>> = {};
  for (const addr of watchlist) {
    tokensOut[addr] = {};
    try {
      eth[addr] = await connection.getBalance(addr);
    } catch {
      eth[addr] = 0n;
    }
    if (connection.getTokenBalances) {
      try {
        tokensOut[addr] = await connection.getTokenBalances(addr);
      } catch {
        tokensOut[addr] = {};
      }
    }
  }
  return { eth, tokens: tokensOut };
}

/**
 * Process items in batches during idle time to avoid blocking the UI (e.g. WASM matching).
 * Export for use in PrivateBalanceView when matching many cached announcements.
 */
export function processInIdleBatches<T, R>(
  items: T[],
  batchSize: number,
  process: (batch: T[]) => R | Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let offset = 0;

  return new Promise((resolve, reject) => {
    function runBatch() {
      if (offset >= items.length) {
        resolve(results);
        return;
      }
      const batch = items.slice(offset, offset + batchSize);
      offset += batchSize;
      Promise.resolve(process(batch))
        .then((r) => {
          results.push(r);
          if (typeof requestIdleCallback !== "undefined") {
            requestIdleCallback(runBatch, { timeout: 100 });
          } else {
            setTimeout(runBatch, 0);
          }
        })
        .catch(reject);
    }
    if (typeof requestIdleCallback !== "undefined") {
      requestIdleCallback(runBatch, { timeout: 100 });
    } else {
      setTimeout(runBatch, 0);
    }
  });
}

export function useScanner(opts: UseScannerOptions): UseScannerResult {
  const { cluster, publicClient, announcerAddress, enabled, ghostAddresses = [], watchlistAddresses = [] } = opts;
  const [announcements, setAnnouncements] = useState<CachedAnnouncement[]>([]);
  const [ghostBalances, setGhostBalances] = useState<Record<string, bigint>>({});
  const [ghostTokenBalances, setGhostTokenBalances] = useState<Record<string, Record<string, bigint>>>({});
  const [progress, setProgress] = useState<ScanProgress>({
    phase: "idle",
    percent: 0,
    message: "",
    fromBlock: 0n,
    toBlock: 0n,
    currentBlock: 0n,
    error: null,
    warning: null,
    unsupportedEventVersionCount: 0,
  });
  const [isBackfilling, setIsBackfilling] = useState(false);
  const refreshKeyRef = useRef(0);

  const runChunkedRpcSync = useCallback(
    async (
      _publicClient: NonNullable<typeof opts.publicClient>,
      announcerAddress: string,
      fromBlock: bigint,
      toBlock: bigint,
      cacheEmpty: boolean,
      startBlock: bigint,
      phaseOverride?: "backfilling" | "syncing",
      messagePrefix?: string,
    ) => {
      const networkPassphrase = getNetworkPassphrase();
      
      await fetchLogsAdaptive(
        announcerAddress,
        fromBlock,
        toBlock,
        cluster!,
        async (_from, end, logs, skippedUnsupportedVersions) => {
          await putAnnouncements(cluster!, logs);
          await setSyncState(cluster!, Number(end));
          
          // Save checkpoint every chunk for resume capability
          await saveScanCheckpoint(
            cluster!,
            Number(end),
            Number(toBlock),
            networkPassphrase
          );
          
          const totalBlocks = Number(toBlock - (cacheEmpty ? startBlock : fromBlock) + 1n);
          const doneBlocks = Number(end - (cacheEmpty ? startBlock : fromBlock) + 1n);
          const percent = totalBlocks > 0 ? Math.min(100, Math.round((doneBlocks / totalBlocks) * 100)) : 100;
          if (skippedUnsupportedVersions > 0) {
            console.warn(
              `[useScanner] Skipped ${skippedUnsupportedVersions} announcement event(s) with unsupported event_version > ${SUPPORTED_EVENT_VERSION}.`,
            );
          }
          setProgress((p: ScanProgress) => ({
            ...p,
            phase: phaseOverride ?? (cacheEmpty ? "backfilling" : "syncing"),
            percent,
            message: messagePrefix
              ? `${messagePrefix}… ${percent}%`
              : cacheEmpty
                ? `Optimizing Vault… [${percent}%]`
                : `Syncing… ${percent}%`,
            currentBlock: end,
            warning:
              skippedUnsupportedVersions > 0 || p.unsupportedEventVersionCount > 0
                ? "Some announcements use a newer scanner event version and were skipped."
                : p.warning,
            unsupportedEventVersionCount:
              p.unsupportedEventVersionCount + skippedUnsupportedVersions,
            retryStatus: undefined,
          }));
        },
        (attempt, delayMs, reason) => {
          setProgress((p: ScanProgress) => ({
            ...p,
            message: `Rate limited. Retrying in ${(delayMs / 1000).toFixed(0)}s (attempt ${attempt}/5)…`,
            retryStatus: {
              attempt,
              maxRetries: 5,
              delayMs,
              reason,
            },
          }));
        }
      );
      
      // Clear checkpoint after successful completion
      await clearScanCheckpoint(cluster!);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opts only appears in type annotations
    [cluster]
  );

  const runScan = useCallback(
    async (clearCache: boolean, fullRescan = false) => {
      console.log("runScan", cluster);
      console.log("publicClient", publicClient);
      console.log("announcerAddress", announcerAddress);
      console.log("enabled", enabled);
      if (cluster == null || !publicClient || !announcerAddress || !enabled) return;

      const networkPassphrase = getNetworkPassphrase();

      let startBlock: bigint;
      try {
        startBlock = getStartBlock(cluster, fullRescan);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setProgress((p: ScanProgress) => ({
          ...p,
          phase: "error",
          error: msg,
          message: "Scanner configuration error",
        }));
        return;
      }
      const subgraphUrl = getSubgraphUrl(cluster);

      if (clearCache) {
        await clearClusterCache(cluster);
        await clearScanCheckpoint(cluster);
        setAnnouncements([]);
      }

      setProgress((p: ScanProgress) => ({
        ...p,
        phase: "loading-cache",
        message: "Loading cache…",
        error: null,
        warning: null,
        unsupportedEventVersionCount: 0,
      }));

      // Check for resumable checkpoint
      const checkpoint = await getScanCheckpoint(cluster);
      let resumeFromCheckpoint = false;
      
      if (checkpoint && !clearCache && !fullRescan) {
        const isValid = await validateCheckpoint(cluster, networkPassphrase);
        if (isValid) {
          console.log("[useScanner] Found valid checkpoint, resuming from ledger", checkpoint.lastProcessedLedger);
          resumeFromCheckpoint = true;
          setProgress((p: ScanProgress) => ({
            ...p,
            phase: "loading-cache",
            message: "Resuming from checkpoint…",
          }));
        } else {
          console.warn("[useScanner] Checkpoint invalid, triggering full rescan");
          await clearScanCheckpoint(cluster);
          await clearClusterCache(cluster);
          setAnnouncements([]);
        }
      }

      const cached = await getAnnouncementsForCluster(cluster);
      const sync = await getSyncState(cluster);
      const lastScanned = sync?.lastScannedSlot ?? null;
      let repairedCache = cached;
      if (!clearCache && lastScanned != null) {
        const maxCachedSlot =
          cached.length > 0 ? Math.max(...cached.map((a) => a.slot)) : null;
        if (maxCachedSlot == null || maxCachedSlot < lastScanned) {
          const repairFrom = BigInt(
            Math.max((maxCachedSlot ?? Number(startBlock) - 1) + 1, Number(startBlock)),
          );
          const repairTo = BigInt(lastScanned);
          if (repairFrom > repairTo) {
            repairedCache = cached;
          } else {
          console.warn('[useScanner] Detected ledger gap between cached announcements and sync state. Backfilling missing range.', {
            maxCachedSlot,
            lastScanned,
            repairFrom: String(repairFrom),
            repairTo: String(repairTo),
          });
          setProgress((p: ScanProgress) => ({
            ...p,
            phase: "backfilling",
            percent: 0,
            message: "Repairing ledger gap… 0%",
            fromBlock: repairFrom,
            toBlock: repairTo,
            currentBlock: repairFrom,
            error: null,
          }));
          await runChunkedRpcSync(publicClient, announcerAddress, repairFrom, repairTo, true, repairFrom, "backfilling", "Repairing ledger gap");
          repairedCache = await getAnnouncementsForCluster(cluster);
          }
        }
      }
      const toBlock = BigInt(await publicClient.getSlot());
      const fromBlock =
        clearCache || lastScanned == null
          ? startBlock
          : BigInt(Math.max(lastScanned + 1, Number(startBlock)));
      const cacheEmpty = repairedCache.length === 0 && lastScanned == null;

      if (subgraphUrl) {
        setProgress((p) => ({
          ...p,
          phase: "indexer-fetch",
          message: "Syncing with Indexer…",
          error: null,
        }));
        try {
          const list = await fetchFromSubgraph(subgraphUrl, cluster);
          if (list != null && list.length >= 0) {
            await clearClusterCache(cluster);
            await putAnnouncements(cluster, list.map((a) => ({
              transactionSignature: a.transactionSignature,
              logIndex: a.logIndex,
              slot: a.slot,
              args: a.args,
            })));
            const maxSlot = list.length > 0 ? Math.max(...list.map((a) => a.slot)) : 0;
            await setSyncState(cluster, maxSlot);
            // Pass announcements directly so WASM scanning loop runs immediately (no cache read).
            setAnnouncements(list);
            setProgress((p: ScanProgress) => ({
              ...p,
              phase: "indexer-fetched",
              percent: 100,
              message: "Scanning Vault…",
              fromBlock: startBlock,
              toBlock,
              currentBlock: toBlock,
              error: null,
            }));
            setIsBackfilling(false);
            return;
          }
        } catch {
          // Fall through to chunked RPC fallback (safe mode)
        }
      }

      if (cacheEmpty && !clearCache) {
        setIsBackfilling(true);
        setProgress((p: ScanProgress) => ({
          ...p,
          phase: "backfilling",
          percent: 0,
          message: "Optimizing Vault… [0%]",
          fromBlock: startBlock,
          toBlock,
          currentBlock: startBlock,
          error: null,
        }));
      } else {
        setAnnouncements(repairedCache);
        if (fromBlock > toBlock) {
          setProgress((p: ScanProgress) => ({
            ...p,
            phase: "done",
            percent: 100,
            message: "Up to date",
            fromBlock,
            toBlock,
            currentBlock: toBlock,
            error: null,
          }));
          setIsBackfilling(false);
          return;
        }
        setProgress((p: ScanProgress) => ({
          ...p,
          phase: "syncing",
          percent: 0,
          message: "Syncing new blocks…",
          fromBlock,
          toBlock,
          currentBlock: fromBlock,
        }));
      }

      try {
        await runChunkedRpcSync(publicClient, announcerAddress, fromBlock, toBlock, cacheEmpty, startBlock);
        const updated = await getAnnouncementsForCluster(cluster);
        setAnnouncements(updated);
        setProgress((p: ScanProgress) => ({
          ...p,
          phase: "done",
          percent: 100,
          message: "Up to date",
          fromBlock,
          toBlock,
          currentBlock: toBlock,
          error: null,
        }));
        setIsBackfilling(false);
      } catch (err) {
        const msg = getUserFacingSyncMessage(err);
        logSyncError(err, "Sync failed");
        setProgress((p: ScanProgress) => ({
          ...p,
          phase: "error",
          error: msg,
          message: "Sync failed",
        }));
        setIsBackfilling(false);
      }
    },
    [cluster, publicClient, announcerAddress, enabled, runChunkedRpcSync]
  );

  useEffect(() => {
    if (!enabled || cluster == null || !publicClient || !announcerAddress) {
      console.log("[useScanner] effect skip (guard):", {
        cluster,
        enabled,
        hasPublicClient: !!publicClient,
        hasAnnouncerAddress: !!announcerAddress,
      });
      setProgress((p: ScanProgress) => ({ ...p, phase: "idle" }));
      return;
    }

    let cancelled = false;
    setProgress((p: ScanProgress) => ({ ...p, phase: "loading-cache", message: "Loading cache…" }));

    (async () => {
      const networkPassphrase = getNetworkPassphrase();
      
      // Check for network change and clear checkpoint if detected
      const checkpoint = await getScanCheckpoint(cluster);
      if (checkpoint && checkpoint.networkPassphrase !== networkPassphrase) {
        console.warn(
          "[useScanner] Network change detected, clearing checkpoint and cache",
          { stored: checkpoint.networkPassphrase, current: networkPassphrase }
        );
        await clearScanCheckpoint(cluster);
        await clearClusterCache(cluster);
      }
      
      const cached = await getAnnouncementsForCluster(cluster);
      if (cancelled) return;
      setAnnouncements(cached);

      const sync = await getSyncState(cluster);
      const toBlock = BigInt(await publicClient.getSlot());
      let startBlock: bigint;
      try {
        startBlock = getStartBlock(cluster);
      } catch {
        await runScan(false);
        return;
      }
      const lastScanned = sync?.lastScannedSlot ?? null;
      const fromBlock =
        lastScanned == null ? startBlock : BigInt(Math.max(lastScanned + 1, Number(startBlock)));

      if (fromBlock > toBlock) {
        // lastScannedSlot is ahead of chain head (corrupt or from wrong source); reset sync state and run scan from startBlock
        console.warn("[useScanner] lastScannedSlot ahead of chain head, resetting sync state:", {
          cluster,
          fromBlock: String(fromBlock),
          toBlock: String(toBlock),
        });
        await clearSyncState(cluster);
        await clearScanCheckpoint(cluster);
      }

      await runScan(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [cluster, enabled, publicClient, announcerAddress, runScan]);

  const retrySync = useCallback(async () => {
    if (cluster == null) return;
    refreshKeyRef.current += 1;
    await runScan(true, true);
  }, [cluster, runScan]);

  const refresh = useCallback(async () => {
    await runScan(false);
  }, [runScan]);

  const markSyncComplete = useCallback(() => {
    setProgress((p: ScanProgress) => {
      if (p.phase !== "indexer-fetched") return p;
      return { ...p, phase: "done", message: "Up to date" };
    });
  }, []);

  // State-polling: check watchlist + ghost addresses + opaque-ghost-addresses (current chain only)
  const ghostAddrKey = ghostAddresses.join(",");
  const watchlistAddrKey = watchlistAddresses.join(",");
  useEffect(() => {
    if (!publicClient || cluster == null) {
      setGhostBalances({});
      setGhostTokenBalances({});
      return;
    }
    // Only use stored entries for current chain
    const stored = getStoredGhostEntries().filter((e) => e.cluster === cluster);
    const storedAddresses = stored.map((e) => e.stealthAddress);
    const combined: string[] = [...watchlistAddresses, ...ghostAddresses, ...storedAddresses];
    const seen = new Set<string>();
    const addressesToPoll = combined.filter((addr) => {
      if (seen.has(addr)) return false;
      seen.add(addr);
      return true;
    });
    if (addressesToPoll.length === 0) {
      setGhostBalances({});
      setGhostTokenBalances({});
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        if (watchlistAddresses.length > 0 && cluster != null) {
          const { eth, tokens } = await checkWatchlistBalances(
            publicClient,
            addressesToPoll,
          );
          if (cancelled) return;
          setGhostBalances(eth);
          setGhostTokenBalances(tokens);
        } else {
          const results = await Promise.all(
            addressesToPoll.map(async (addr) => {
              try {
                const [native, tokens] = await Promise.all([
                  publicClient.getBalance(addr),
                  publicClient.getTokenBalances?.(addr) ?? Promise.resolve({}),
                ]);
                return { native, tokens };
              } catch {
                return { native: 0n, tokens: {} };
              }
            })
          );
          if (cancelled) return;
          const next: Record<string, bigint> = {};
          const nextTokens: Record<string, Record<string, bigint>> = {};
          addressesToPoll.forEach((addr, i) => {
            next[addr] = results[i]?.native ?? 0n;
            nextTokens[addr] = results[i]?.tokens ?? {};
          });
          setGhostBalances(next);
          setGhostTokenBalances(nextTokens);
        }
      } catch {
        if (!cancelled) {
          setGhostBalances({});
          setGhostTokenBalances({});
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ghostAddrKey/watchlistAddrKey are stable string proxies for the array deps
  }, [publicClient, cluster, ghostAddrKey, watchlistAddrKey]);

  return {
    announcements,
    progress,
    ghostBalances,
    ghostTokenBalances,
    isBackfilling,
    retrySync,
    refresh,
    markSyncComplete,
  };
}
