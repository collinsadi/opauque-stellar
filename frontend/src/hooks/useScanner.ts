/**
 * useScanner — IndexedDB-backed announcement scanner.
 * - Primary: single GraphQL fetch to Subgraph (latest 1000 announcements). No getLogs in this path.
 * - Fallback: if Subgraph fetch fails, uses chunked RPC getLogs (adaptive range, halve on limit).
 * - Loads cached events first; incremental sync from lastScannedSlot when using RPC.
 * - Per-chain sync state; back-fill "Optimizing Vault... [%]" when cache empty (RPC path).
 * - WASM matching offloaded with requestIdleCallback; call markSyncComplete when done (indexer path).
 */

import { rpc as StellarRpc, xdr } from "@stellar/stellar-sdk";
import { getRpcUrls } from "../lib/chain";
import { useState, useEffect, useCallback, useRef } from "react";
import { Buffer } from "buffer";
import {
  SorobanRpc,
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
  type CachedAnnouncement,
} from "../lib/opaqueCache";
import { getSorobanServer } from "../lib/stellar";
import {
  getUserFacingSyncMessage,
  logSyncError,
} from "../lib/syncErrorUtils";
import { getStoredGhostEntries } from "../store/ghostAddressStore";

type PublicClient = SorobanRpc.Server | null;

export type ScanProgress = {
  phase: "idle" | "loading-cache" | "indexer-fetch" | "indexer-fetched" | "syncing" | "backfilling" | "matching" | "done" | "error";
  /** 0–100 for backfilling/syncing */
  percent: number;
  message: string;
  fromBlock: bigint;
  toBlock: bigint;
  currentBlock: bigint;
  error: string | null;
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
  /** Token balances per address (reserved for future use). */
  ghostTokenBalances: Record<string, Record<string, bigint>>;
  /** Whether we are in "back-fill" (cache was empty, scanning from START_BLOCK) */
  isBackfilling: boolean;
  /** Trigger a full rescan from deployment block (clears cache for this chain) */
  retrySync: () => Promise<void>;
  /** Re-run scan from lastScannedSlot+1 to latest (incremental) */
  refresh: () => Promise<void>;
  /** Call when WASM matching has finished (e.g. after indexer path) so progress can move to "done" */
  markSyncComplete: () => void;
};

function getStartBlock(_cluster: StellarNetwork): bigint {
  return 1n; // Soroban events start from ledger 1
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

/** Maximum ledgers per getEvents page (Soroban RPC limit). */
const SOROBAN_EVENTS_PAGE_SIZE = 200;

/**
 * Parse a Soroban contract event into the CachedAnnouncement args shape.
 * The stealth-announcer emits: (stealthAddress, ephemeralPubKey, metadata)
 * as ScVal bytes values in the event body (map or vec).
 */
function parseSorobanAnnouncementEvent(event: StellarRpc.Api.EventResponse): {
  stealthAddress?: string;
  ephemeralPubKey?: string;
  metadata?: string;
} | null {
  try {
    const val = event.value; // already parsed xdr.ScVal

    function scValToHex(v: xdr.ScVal): string | undefined {
      try {
        if (v.switch() === xdr.ScValType.scvBytes()) {
          return "0x" + Buffer.from(v.bytes()).toString("hex");
        }
        if (v.switch() === xdr.ScValType.scvString()) {
          return Buffer.from(v.str()).toString("utf8");
        }
      } catch {
        return undefined;
      }
      return undefined;
    }

    if (val.switch() === xdr.ScValType.scvMap()) {
      const map = val.map() ?? [];
      const result: Record<string, string> = {};
      for (const entry of map) {
        const key =
          entry.key().switch() === xdr.ScValType.scvSymbol()
            ? Buffer.from(entry.key().sym()).toString("utf8")
            : undefined;
        if (!key) continue;
        const v = scValToHex(entry.val());
        if (v) result[key] = v;
      }
      return {
        stealthAddress: result["stealth_address"] ?? result["stealthAddress"],
        ephemeralPubKey: result["ephemeral_pub_key"] ?? result["ephemeralPubKey"],
        metadata: result["metadata"],
      };
    }

    if (val.switch() === xdr.ScValType.scvVec()) {
      const vec = val.vec() ?? [];
      return {
        stealthAddress: scValToHex(vec[0]),
        ephemeralPubKey: scValToHex(vec[1]),
        metadata: scValToHex(vec[2]),
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch Soroban contract events for the stealth-announcer contract using
 * the Soroban RPC `getEvents` endpoint. Paginates from `fromLedger` to
 * `toLedger` in chunks of SOROBAN_EVENTS_PAGE_SIZE, calling `onChunk` for
 * each page so the caller can persist and update progress incrementally.
 *
 * Replaces the old Solana `getSignaturesForAddress` / log-parsing approach.
 */
async function fetchLogsAdaptive(
  announcerAddress: string,
  fromBlock: bigint,
  toBlock: bigint,
  _cluster: StellarNetwork,
  onChunk: (from: bigint, to: bigint, logs: CachedAnnouncement[]) => Promise<void>
): Promise<void> {
  const publicClient = getSorobanServer();
  let currentFrom = fromBlock;
  const BATCH_SIZE = 10000n; // Ledger range per call

  while (currentFrom <= toBlock) {
    const currentTo =
      currentFrom + BATCH_SIZE > toBlock ? toBlock : currentFrom + BATCH_SIZE;

    const response = await publicClient.getEvents({
      startLedger: Number(currentFrom),
      filters: [
        {
          type: "contract",
          contractIds: [announcerAddress],
          topics: [[xdr.ScVal.scvSymbol("Announcement").toXDR("base64")]],
        },
      ],
    });

    const mapped: CachedAnnouncement[] = response.events.map((ev: SorobanRpc.Api.RawEventResponse) => {
      // Event value is (scheme_id, stealth_address, caller, ephemeral_pub_key, metadata)
      const val = scValToNative(ev.value) as any[];
      return {
        transactionSignature: ev.txHash,
        logIndex: 0,
        slot: ev.ledger,
        args: {
          stealthAddress: "0x" + Buffer.from(val[1]).toString("hex"),
          ephemeralPubKey: "0x" + Buffer.from(val[3]).toString("hex"),
          metadata: "0x" + Buffer.from(val[4]).toString("hex"),
        },
      };
    });

    await onChunk(currentFrom, currentTo, mapped);
    currentFrom = currentTo + 1n;
  }
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
      startBlock: bigint
    ) => {
      await fetchLogsAdaptive(
        announcerAddress,
        fromBlock,
        toBlock,
        cluster!,
        async (_from, end, logs) => {
          await putAnnouncements(cluster!, logs);
          await setSyncState(cluster!, Number(end));
          const totalBlocks = Number(toBlock - (cacheEmpty ? startBlock : fromBlock) + 1n);
          const doneBlocks = Number(end - (cacheEmpty ? startBlock : fromBlock) + 1n);
          const percent = totalBlocks > 0 ? Math.min(100, Math.round((doneBlocks / totalBlocks) * 100)) : 100;
          setProgress((p: ScanProgress) => ({
            ...p,
            phase: cacheEmpty ? "backfilling" : "syncing",
            percent,
            message: cacheEmpty ? `Optimizing Vault… [${percent}%]` : `Syncing… ${percent}%`,
            currentBlock: end,
          }));
        }
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opts only appears in type annotations
    [cluster]
  );

  const runScan = useCallback(
    async (clearCache: boolean) => {
      console.log("runScan", cluster);
      console.log("publicClient", publicClient);
      console.log("announcerAddress", announcerAddress);
      console.log("enabled", enabled);
      if (cluster == null || !publicClient || !announcerAddress || !enabled) return;


      const startBlock = getStartBlock(cluster);
      const subgraphUrl = getSubgraphUrl(cluster);

      if (clearCache) {
        await clearClusterCache(cluster);
        setAnnouncements([]);
      }

      setProgress((p: ScanProgress) => ({ ...p, phase: "loading-cache", message: "Loading cache…", error: null }));

      const cached = await getAnnouncementsForCluster(cluster);
      const sync = await getSyncState(cluster);
      const lastScanned = sync?.lastScannedSlot ?? null;
      // Gap detection: ensure cached announcements cover up to lastScannedSlot
      if (cached.length > 0 && lastScanned != null) {
        const maxCachedSlot = Math.max(...cached.map((a) => a.slot));
        if (maxCachedSlot < lastScanned) {
          console.warn('[useScanner] Detected gap between cached announcements and sync state. Resetting sync.', {
            maxCachedSlot,
            lastScanned,
          });
          await clearSyncState(cluster);
          // Inform UI that a gap was detected and a full sync may be needed
          setProgress((p) => ({
            ...p,
            phase: "error",
            error: "Ledger gap detected – cache cleared. Click \"Full Rescan\" to re-sync.",
            message: "Ledger gap detected",
          }));
        }
      }
      const toBlock = BigInt(await publicClient.getSlot());
      const fromBlock =
        clearCache || lastScanned == null
          ? startBlock
          : BigInt(Math.max(lastScanned + 1, Number(startBlock)));
      const cacheEmpty = cached.length === 0 && lastScanned == null;

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
        setAnnouncements(cached);
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

    // Resolve subgraph URL for the current supported chain
    // getSubgraphUrl(cluster);

    let cancelled = false;
    setProgress((p: ScanProgress) => ({ ...p, phase: "loading-cache", message: "Loading cache…" }));

    (async () => {
      const cached = await getAnnouncementsForCluster(cluster);
      if (cancelled) return;
      setAnnouncements(cached);

      const sync = await getSyncState(cluster);
      const toBlock = BigInt(await publicClient.getSlot());
      const startBlock = getStartBlock(cluster);
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
    await runScan(true);
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
                return await publicClient.getBalance(addr);
              } catch {
                return 0n;
              }
            })
          );
          if (cancelled) return;
          const next: Record<string, bigint> = {};
          addressesToPoll.forEach((addr, i) => {
            next[addr] = results[i] ?? 0n;
          });
          setGhostBalances(next);
          setGhostTokenBalances({});
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
