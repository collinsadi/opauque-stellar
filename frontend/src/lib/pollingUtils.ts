/**
 * Bounded polling with timeout, backoff, and abort (#923).
 *
 * Replaces open-ended `while (status === "NOT_FOUND")` loops: every poll ends with a
 * result, a timeout, an abort, or the fetch error, so the UI can never hang forever.
 */

export type PollOutcome<T> =
  | { success: true; result: T; attempts: number }
  | { success: false; timedOut: true; aborted: false; attempts: number; lastResult?: T }
  | { success: false; timedOut: false; aborted: true; attempts: number; lastResult?: T }
  | { success: false; timedOut: false; aborted: false; error: Error; attempts: number; lastResult?: T };

export interface PollOptions<T> {
  fetchFn: () => Promise<T>;
  /** Stop polling once this returns true for a fetched value. */
  condition: (value: T) => boolean;
  /** Total time budget, measured from the first fetch. */
  timeoutMs: number;
  /** Delay before the second fetch. */
  intervalMs: number;
  /** Multiply the delay by this after each attempt (1 = fixed interval). */
  backoffMultiplier?: number;
  /** Upper bound for a single delay. */
  maxIntervalMs?: number;
  signal?: AbortSignal;
  /** Injected for tests. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function pollWithTimeout<T>(opts: PollOptions<T>): Promise<PollOutcome<T>> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const multiplier = Math.max(1, opts.backoffMultiplier ?? 1);
  const maxInterval = opts.maxIntervalMs ?? Number.POSITIVE_INFINITY;
  const deadline = now() + opts.timeoutMs;
  let delay = opts.intervalMs;
  let attempts = 0;
  let lastResult: T | undefined;

  for (;;) {
    if (opts.signal?.aborted) return { success: false, timedOut: false, aborted: true, attempts, lastResult };
    attempts++;
    try {
      lastResult = await opts.fetchFn();
    } catch (err) {
      return {
        success: false,
        timedOut: false,
        aborted: false,
        error: err instanceof Error ? err : new Error(String(err)),
        attempts,
        lastResult,
      };
    }
    if (opts.condition(lastResult)) return { success: true, result: lastResult, attempts };

    const remaining = deadline - now();
    if (remaining <= 0) return { success: false, timedOut: true, aborted: false, attempts, lastResult };
    await sleep(Math.min(delay, remaining, maxInterval), opts.signal);
    delay = Math.min(delay * multiplier, maxInterval);
  }
}

export class TransactionConfirmationError extends Error {
  readonly reason: "timeout" | "aborted" | "error";

  constructor(message: string, reason: "timeout" | "aborted" | "error", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransactionConfirmationError";
    this.reason = reason;
  }
}

/**
 * Wait for a submitted Soroban transaction to leave `NOT_FOUND` (#923). Resolves with
 * the first non-`NOT_FOUND` response; throws `TransactionConfirmationError` on
 * timeout, abort, or an RPC error instead of polling forever.
 */
export async function waitForTransaction<T extends { status: string }>(
  getTransaction: () => Promise<T>,
  opts: {
    timeoutMs: number;
    signal?: AbortSignal;
    intervalMs?: number;
    now?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  },
): Promise<T> {
  const poll = await pollWithTimeout({
    fetchFn: getTransaction,
    condition: (resp) => resp.status !== "NOT_FOUND",
    timeoutMs: opts.timeoutMs,
    intervalMs: opts.intervalMs ?? 1_000,
    backoffMultiplier: 1.5,
    maxIntervalMs: 5_000,
    signal: opts.signal,
    now: opts.now,
    sleep: opts.sleep,
  });
  if (poll.success) return poll.result;
  if (poll.timedOut) {
    throw new TransactionConfirmationError(
      `Transaction not confirmed after ${Math.round(opts.timeoutMs / 1000)}s. ` +
        "It may still land — check the explorer before retrying.",
      "timeout",
    );
  }
  if (poll.aborted) throw new TransactionConfirmationError("Transaction confirmation was cancelled.", "aborted");
  throw new TransactionConfirmationError(`Could not check transaction status: ${poll.error.message}`, "error", {
    cause: poll.error,
  });
}
