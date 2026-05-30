/**
 * Pending transaction poller (#114).
 *
 * Reads the persisted `pendingTxStore` and polls a `TxStatusFetcher`
 * (production: Horizon `/transactions/<hash>`) until each entry
 * resolves to `confirmed` / `failed` / `timed_out`. The poller is
 * pure-logic — the network call is injected so unit tests can drive
 * it with canned responses.
 *
 * Caller wires this from `App.tsx` on boot:
 *
 *   useEffect(() => {
 *     const cancel = pollPendingTransactions({ fetchStatus, intervalMs: 4000 });
 *     return cancel;
 *   }, []);
 */

import { usePendingTxStore, type PendingTxEntry, type PendingTxStatus } from "../store/pendingTxStore";

/**
 * Result of one status check against the chain. `notFound` is a
 * non-terminal state — Horizon may not have indexed the tx yet —
 * and the poller treats it as "keep polling".
 */
export type ChainStatusResult =
  | { state: "confirmed"; message?: string }
  | { state: "failed"; message?: string }
  | { state: "notFound" };

export type TxStatusFetcher = (txHash: string) => Promise<ChainStatusResult>;

export interface PollPendingOptions {
  fetchStatus: TxStatusFetcher;
  /** Polling interval in milliseconds. Defaults to 4s. */
  intervalMs?: number;
  /** Hard timeout per entry. Defaults to 5 minutes. */
  timeoutMs?: number;
  /** Override of Date.now() — tests pass a clock so timeouts are deterministic. */
  now?: () => number;
}

/**
 * Drive the polling loop. Returns a cancel function that the caller
 * runs from a React effect cleanup.
 */
export function pollPendingTransactions(opts: PollPendingOptions): () => void {
  const { fetchStatus, intervalMs = 4_000, timeoutMs = 5 * 60 * 1000, now = Date.now } = opts;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  const tick = async () => {
    if (cancelled) return;
    const store = usePendingTxStore.getState();
    const pending = Object.values(store.byHash).filter((e) => e.status === "pending");
    await Promise.all(pending.map((e) => pollOne(e, fetchStatus, timeoutMs, now)));
    store.prune(now());
    if (cancelled) return;
    timer = setTimeout(tick, intervalMs);
  };

  // Kick off immediately so the first reload feedback isn't gated on a 4s delay.
  void tick();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}

async function pollOne(
  entry: PendingTxEntry,
  fetchStatus: TxStatusFetcher,
  timeoutMs: number,
  now: () => number,
): Promise<void> {
  if (now() - entry.submittedAt > timeoutMs) {
    setStatus(entry.txHash, "timed_out", "Polling timed out before chain confirmation");
    return;
  }
  try {
    const result = await fetchStatus(entry.txHash);
    if (result.state === "confirmed") {
      setStatus(entry.txHash, "confirmed", result.message);
    } else if (result.state === "failed") {
      setStatus(entry.txHash, "failed", result.message);
    }
    // notFound → leave it pending and re-poll next tick.
  } catch {
    // Network blip — keep the entry pending.
  }
}

function setStatus(hash: string, status: PendingTxStatus, message?: string): void {
  usePendingTxStore.getState().setStatus(hash, status, message);
}
