/**
 * useScanner: IndexedDB-backed announcement scanner.
 * - Primary: single GraphQL fetch to Subgraph (latest 1000 announcements). No getLogs in this path.
 * - Fallback: if Subgraph fetch fails, uses chunked RPC getLogs (adaptive range, halve on limit).
 * - Loads cached events first; incremental sync from lastScannedSlot when using RPC.
 * - Per-chain sync state; back-fill "Optimizing Vault... [%]" when cache empty (RPC path).
 * - WASM matching offloaded with requestIdleCallback; call markSyncComplete when done (indexer path).
 */

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Buffer } from "buffer";
import {
  scValToNative,
  StrKey,
  xdr,
} from "@stellar/stellar-sdk";
import type { StellarNetwork } from "../lib/chain";
import { getManifestForNetwork } from "../contracts/deploymentManifest";
import {
  getAnnouncementsForCluster,
  getSyncState,
  setSyncState,
  clearSyncState,
  putAnnouncements,
  clearClusterCache,
  recordUnscannedRange,
  type CachedAnnouncement,
  type UnscannedRange,
} from "../lib/opaqueCache";
import { getSorobanServer } from "../lib/stellar";
import {
  getUserFacingSyncMessage,
  logSyncError,
} from "../lib/syncErrorUtils";
import { getStoredGhostEntries } from "../store/ghostAddressStore";
import { getPollingBackoff, type BackoffState } from "../lib/horizonBackoff";

/**
 * Minimal chain-read surface the scanner needs. Backed by the Horizon-derived
 * `connection` adapter from `useWallet` (native balance + latest ledger).
 */
export interface ScannerConnection {
  getBalance: (address: string) => Promise<bigint>;
  getSlot: () => Promise<number>;
}

type PublicClient = ScannerConnection | null;

export type ScanProgress = {
  phase: "idle" | "loading-cache" | "indexer-fetch" | "indexer-fetched" | "syncing" | "backfilling" | "matching" | "done" | "error";
  /** 0-100 for backfilling/syncing */
  percent: number;
  message: string;
  fromBlock: bigint;
  toBlock: bigint;
  currentBlock: bigint;
  error: string | null;
  /**
   * Ledgers in the requested scan range that could not be read because the
   * RPC no longer retains them. Payments announced there are NOT reflected in
   * `announcements`; the UI must tell the user. `null` when coverage is complete.
   */
  unscannedRange: UnscannedRange | null;
};

export type { UnscannedRange };

/** Called when part of the requested range lies outside RPC retention and is skipped. */
export type OnUnscannedRange = (range: UnscannedRange) => void | Promise<void>;

export type UseScannerOptions = {
  cluster: StellarNetwork | null;
  publicClient: PublicClient | null;
  announcerAddress: string | null;
  enabled: boolean;
  ghostAddresses?: string[];
  watchlistAddresses?: string[];
  /**
   * Maps a stealth identifier (the 0x-hex key the UI uses) to the Stellar
   * ed25519 G-address that actually holds funds. Balances are queried at the
   * G-address but keyed by the original identifier.
   */
  addressResolver?: Record<string, string>;
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
  // #111: opaque-mainnet-v1 is XLM-only. Asset / token balances are
  // explicitly out of v1 scope; the field
  // below was previously marked "reserved for future use" but the
  // shape stays empty in v1. Keeping the key (always `{}`) so
  // downstream consumers don't have to fork their types on v1 vs the
  // multi-asset follow-up.
  ghostTokenBalances: Record<string, Record<string, bigint>>;
  /** Whether we are in "back-fill" (cache was empty, scanning from START_BLOCK) */
  isBackfilling: boolean;
  /** Trigger a full rescan from deployment block (clears cache for this chain) */
  retrySync: () => Promise<void>;
  /** Re-run scan from lastScannedSlot+1 to latest (incremental) */
  refresh: () => Promise<void>;
  /** Call when WASM matching has finished (e.g. after indexer path) so progress can move to "done" */
  markSyncComplete: () => void;
  /** Adaptive backoff state for Horizon balance polling (#542). */
  pollingBackoff: BackoffState;
};

function getStartBlock(cluster: StellarNetwork): bigint {
  // Announcements only exist from the contract deployment ledger onward.
  // Starting there (rather than ledger 1) keeps a fresh scan to a small range
  // near the chain head instead of grinding the entire RPC retention window,
  // which made fresh scans appear to hang before reaching recent events.
  const deployLedger = getManifestForNetwork(cluster)?.deploymentLedger ?? null;
  return deployLedger != null && deployLedger > 0 ? BigInt(deployLedger) : 1n;
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

/**
 * Parse the oldest retained ledger from a getEvents -32600 range error, e.g.
 * "startLedger must be within the ledger range: 1884103 - 3093702". The RPC's
 * reported oldestLedger (getHealth) can lag this by one or more as the window
 * slides, so the error itself is the authoritative lower bound.
 */
function parseOldestLedgerFromRangeError(err: unknown): number | null {
  let msg = "";
  if (err instanceof Error) msg = err.message;
  else if (typeof err === "string") msg = err;
  else if (err && typeof err === "object") {
    const o = err as { message?: unknown };
    msg = typeof o.message === "string" ? o.message : JSON.stringify(err);
  }
  const m = /ledger range:\s*(\d+)\s*-\s*(\d+)/.exec(msg);
  return m ? Number(m[1]) : null;
}

/** Ledger range per `getEvents` call. */
const BATCH_SIZE = 10000n;

/**
 * Default number of page ranges fetched concurrently by {@link fetchLogsAdaptive} (#603).
 * Configurable via the `concurrency` parameter for callers that want to tune
 * network parallelism (e.g. lower it for rate-limited RPC endpoints).
 */
export const DEFAULT_FETCH_CONCURRENCY = 4;

/** A single `[from, to]` ledger range to fetch one page of events for. */
export interface PageRange {
  from: bigint;
  to: bigint;
}

/**
 * Splits `[fromBlock, toBlock]` into consecutive, non-overlapping `BATCH_SIZE`
 * ledger ranges in ascending order. Pure and exported for unit testing.
 */
export function buildPageRanges(
  fromBlock: bigint,
  toBlock: bigint,
  batchSize: bigint = BATCH_SIZE,
): PageRange[] {
  const ranges: PageRange[] = [];
  let currentFrom = fromBlock;
  while (currentFrom <= toBlock) {
    const currentTo =
      currentFrom + batchSize > toBlock ? toBlock : currentFrom + batchSize;
    ranges.push({ from: currentFrom, to: currentTo });
    currentFrom = currentTo + 1n;
  }
  return ranges;
}

function mapAnnouncementEvents(
  events: Awaited<ReturnType<ReturnType<typeof getSorobanServer>["getEvents"]>>["events"],
  cluster: StellarNetwork,
): CachedAnnouncement[] {
  // Track per-tx event counts so each announcement within a single
  // transaction gets a distinct logIndex (and therefore a distinct id).
  const txEventIndex = new Map<string, number>();
  return events.map((ev) => {
    const txKey = ev.txHash;
    const idx = txEventIndex.get(txKey) ?? 0;
    txEventIndex.set(txKey, idx + 1);

    // Event value is (scheme_id, stealth_address, caller, ephemeral_pub_key, metadata)
    const val = scValToNative(ev.value) as Uint8Array[];
    return {
      id: `${ev.txHash}:${ev.ledger}:${idx}`,
      cluster,
      transactionSignature: ev.txHash,
      logIndex: idx,
      slot: ev.ledger,
      args: {
        stealthAddress: "0x" + Buffer.from(val[1]).toString("hex"),
        ephemeralPubKey: "0x" + Buffer.from(val[3]).toString("hex"),
        metadata: "0x" + Buffer.from(val[4]).toString("hex"),
      },
    };
  });
}

/** Fetches a single page range, retrying once from the RPC's reported lower bound on a range error. */
async function fetchPage(
  publicClient: ReturnType<typeof getSorobanServer>,
  announcerAddress: string,
  range: PageRange,
  cluster: StellarNetwork,
  onUnscanned?: OnUnscannedRange,
): Promise<{ from: bigint; to: bigint; logs: CachedAnnouncement[] }> {
  const getEventsArgs = {
    startLedger: Number(range.from),
    filters: [
      {
        type: "contract" as const,
        contractIds: [announcerAddress],
        // The announcer publishes a two-segment topic:
        // (Symbol("Announcement"), EVENT_VERSION). Soroban getEvents matches
        // topic filters positionally and requires the filter length to equal
        // the event's topic length, so a single-segment ["Announcement"]
        // filter matches nothing. The trailing "*" wildcard matches the
        // version segment and stays correct across EVENT_VERSION bumps.
        topics: [[xdr.ScVal.scvSymbol("Announcement").toXDR("base64"), "*"]],
      },
    ],
  };

  let response;
  try {
    response = await publicClient.getEvents(getEventsArgs);
  } catch (err) {
    // The retention window can slide forward between the getHealth clamp
    // in fetchLogsAdaptive and this call, so getEvents may still report a
    // startLedger below its range. Retry once from the authoritative lower
    // bound it reports.
    const oldest = parseOldestLedgerFromRangeError(err);
    if (oldest != null && Number(range.from) < oldest) {
      // Ledgers [range.from, oldest - 1] are gone; report them rather than
      // pretending this page was fully scanned.
      await onUnscanned?.({
        fromLedger: Number(range.from),
        toLedger: Math.min(oldest - 1, Number(range.to)),
      });
      getEventsArgs.startLedger = oldest;
      response = await publicClient.getEvents(getEventsArgs);
    } else {
      throw err;
    }
  }

  return { from: range.from, to: range.to, logs: mapAnnouncementEvents(response.events, cluster) };
}

/**
 * Fetches announcement pages with bounded concurrency while preserving
 * in-order delivery to `onChunk` (#603). Ranges are dispatched up to
 * `concurrency` at a time; completed pages that arrive out of order are
 * buffered and flushed to `onChunk` strictly in ascending range order, so
 * downstream consumers (cache writes, sync-state, progress) see identical
 * results to the previous fully-sequential implementation.
 *
 * Any part of the range older than the RPC retention window cannot be read.
 * It is skipped, and reported through `onUnscanned` before any chunk is
 * delivered, so callers can persist the gap before advancing their cursor.
 */
export async function fetchLogsAdaptive(
  announcerAddress: string,
  fromBlock: bigint,
  toBlock: bigint,
  _cluster: StellarNetwork,
  onChunk: (from: bigint, to: bigint, logs: CachedAnnouncement[]) => Promise<void>,
  concurrency: number = DEFAULT_FETCH_CONCURRENCY,
  onUnscanned?: OnUnscannedRange,
): Promise<void> {
  const publicClient = getSorobanServer();
  let effectiveFrom = fromBlock;

  // Soroban RPC only retains a sliding window of ledgers. Asking for events
  // from a startLedger older than the oldest retained ledger fails with
  // -32600, so clamp the start to the oldest retained ledger and proceed,
  // reporting the skipped ledgers so the user is told what was not scanned.
  let clampedTo: bigint | null = null;
  try {
    const health = await publicClient.getHealth();
    const oldest = BigInt(health.oldestLedger);
    if (effectiveFrom < oldest) {
      console.warn(
        "[useScanner] startLedger below RPC retention window, clamping",
        { requested: String(effectiveFrom), oldestLedger: String(oldest) },
      );
      clampedTo = oldest;
      effectiveFrom = oldest;
    }
  } catch {
    // Health unavailable, proceed with the requested start ledger.
  }

  if (clampedTo != null && onUnscanned && fromBlock <= toBlock) {
    const lastSkipped = clampedTo - 1n < toBlock ? clampedTo - 1n : toBlock;
    await onUnscanned({ fromLedger: Number(fromBlock), toLedger: Number(lastSkipped) });
  }

  if (effectiveFrom > toBlock) return;

  const ranges = buildPageRanges(effectiveFrom, toBlock);
  const results = new Map<number, { from: bigint; to: bigint; logs: CachedAnnouncement[] }>();
  let nextToFlush = 0;
  let nextToDispatch = 0;
  let firstError: unknown = null;

  // Flush any buffered results that have become the next-in-order chunk.
  async function drainReady(): Promise<void> {
    while (results.has(nextToFlush)) {
      const result = results.get(nextToFlush)!;
      results.delete(nextToFlush);
      await onChunk(result.from, result.to, result.logs);
      nextToFlush += 1;
    }
  }

  async function worker(): Promise<void> {
    while (true) {
      if (firstError) return;
      const index = nextToDispatch;
      if (index >= ranges.length) return;
      nextToDispatch += 1;
      try {
        const result = await fetchPage(publicClient, announcerAddress, ranges[index], _cluster, onUnscanned);
        results.set(index, result);
        // Only the worker that completes the current in-order chunk needs to
        // drain; others just buffer their result and return to pick up more work.
        if (index === nextToFlush) {
          await drainReady();
        }
      } catch (err) {
        if (!firstError) firstError = err;
        return;
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, ranges.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (firstError) throw firstError;
  // Safety net: if the chunk that completes each in-order step never ends up
  // being the one that calls drainReady (e.g. a later worker fills a gap),
  // flush whatever became ready afterward.
  await drainReady();
}

async function checkWatchlistBalances(
  connection: NonNullable<PublicClient>,
  watchlist: string[],
  addressResolver: Record<string, string> = {},
): Promise<WatchlistBalances> {
  const eth: Record<string, bigint> = {};
  const tokensOut: Record<string, Record<string, bigint>> = {};
  for (const addr of watchlist) {
    tokensOut[addr] = {};
    // Stealth identifiers are stored in 0x-hex form; resolve to the Stellar
    // G-address that actually holds funds before querying Horizon, and skip
    // values that are not valid ed25519 accounts so Horizon does not 400.
    const queryAddr = addressResolver[addr.toLowerCase()] ?? addr;
    if (!StrKey.isValidEd25519PublicKey(queryAddr)) {
      eth[addr] = 0n;
      continue;
    }
    try {
      eth[addr] = await connection.getBalance(queryAddr);
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
  const { cluster, publicClient, announcerAddress, enabled, ghostAddresses = [], watchlistAddresses = [], addressResolver = {} } = opts;
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
    unscannedRange: null,
  });
  const [isBackfilling, setIsBackfilling] = useState(false);
  const refreshKeyRef = useRef(0);
  const [pollingBackoff, setPollingBackoff] = useState<BackoffState>(() =>
    getPollingBackoff(30_000).getState()
  );
  const backoffRef = useRef(getPollingBackoff(30_000));

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
        },
        DEFAULT_FETCH_CONCURRENCY,
        async (range) => {
          const merged = await recordUnscannedRange(cluster!, range);
          setProgress((p: ScanProgress) => ({ ...p, unscannedRange: merged }));
        },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opts only appears in type annotations
    [cluster]
  );

  const runScan = useCallback(
    async (clearCache: boolean) => {
      if (cluster == null || !publicClient || !announcerAddress || !enabled) return;


      const startBlock = getStartBlock(cluster);
      const subgraphUrl = getSubgraphUrl(cluster);

      if (clearCache) {
        await clearClusterCache(cluster);
        // A full rescan re-evaluates retention coverage from scratch.
        await clearSyncState(cluster);
        setAnnouncements([]);
      }

      setProgress((p: ScanProgress) => ({ ...p, phase: "loading-cache", message: "Loading cache…", error: null }));

      const cached = await getAnnouncementsForCluster(cluster);
      const sync = await getSyncState(cluster);
      const lastScanned = sync?.lastScannedSlot ?? null;
      // Surface a previously recorded retention gap even when this run is a
      // no-op incremental sync; those ledgers are still unscanned.
      const knownUnscanned = sync?.unscannedRange ?? null;
      setProgress((p: ScanProgress) => ({ ...p, unscannedRange: knownUnscanned }));
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
            error: "Ledger gap detected, cache cleared. Click \"Full Rescan\" to re-sync.",
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

  // Subscribe to adaptive backoff state changes for the diagnostics view (#542).
  useEffect(() => {
    const unsub = backoffRef.current.onStateChange((state) => {
      setPollingBackoff(state);
    });
    return unsub;
  }, []);

  // State-polling: check watchlist + ghost addresses + opaque-ghost-addresses (current chain only)
  const ghostAddrKey = ghostAddresses.join(",");
  const watchlistAddrKey = watchlistAddresses.join(",");
  // Re-poll when the 0x->G resolver changes (e.g. after wasm loads and an
  // older ghost entry can finally be resolved to its Stellar G-address).
  const resolverKey = Object.entries(addressResolver)
    .map(([k, v]) => `${k}:${v}`)
    .join(",");
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
            addressResolver,
          );
          if (cancelled) return;
          setGhostBalances(eth);
          setGhostTokenBalances(tokens);
        } else {
          const results = await Promise.all(
            addressesToPoll.map(async (addr) => {
              const queryAddr = addressResolver[addr.toLowerCase()] ?? addr;
              if (!StrKey.isValidEd25519PublicKey(queryAddr)) return 0n;
              try {
                return await publicClient.getBalance(queryAddr);
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
        backoffRef.current.recordSuccess();
      } catch {
        backoffRef.current.recordFailure();
        if (!cancelled) {
          setGhostBalances({});
          setGhostTokenBalances({});
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ghostAddrKey/watchlistAddrKey/resolverKey are stable string proxies for the array/object deps
  }, [publicClient, cluster, ghostAddrKey, watchlistAddrKey, resolverKey]);

  // Memoize the returned object so its identity is stable across renders. All
  // fields are already stable (useState values + useCallback functions); a bare
  // object literal would be a new reference every render, and consumer effects
  // that depend on `scanner` would re-run on every render and, combined with a
  // setState, loop infinitely.
  return useMemo(
    () => ({
      announcements,
      progress,
      ghostBalances,
      ghostTokenBalances,
      isBackfilling,
      retrySync,
      refresh,
      markSyncComplete,
      pollingBackoff,
    }),
    [
      announcements,
      progress,
      ghostBalances,
      ghostTokenBalances,
      isBackfilling,
      retrySync,
      refresh,
      markSyncComplete,
      pollingBackoff,
    ],
  );
}
