/**
 * Polling Utilities (Issue #923)
 * 
 * Bounded polling with timeout, backoff, and abort handling.
 */

export interface PollConfig<T> {
  /** Function to poll */
  fetchFn: () => Promise<T>;
  /** Condition to stop polling (returns true when done) */
  condition: (result: T) => boolean;
  /** Max polling duration in ms (default: 30s) */
  timeoutMs?: number;
  /** Initial poll interval in ms (default: 1000ms) */
  intervalMs?: number;
  /** Backoff multiplier (default: 1.5) */
  backoffMultiplier?: number;
  /** Max interval in ms (default: 5000ms) */
  maxIntervalMs?: number;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
}

export interface PollResult<T> {
  success: boolean;
  result?: T;
  timedOut?: boolean;
  aborted?: boolean;
  error?: Error;
}

/**
 * Poll with timeout, exponential backoff, and abort handling
 */
export async function pollWithTimeout<T>(
  config: PollConfig<T>
): Promise<PollResult<T>> {
  const {
    fetchFn,
    condition,
    timeoutMs = 30_000,
    intervalMs = 1_000,
    backoffMultiplier = 1.5,
    maxIntervalMs = 5_000,
    signal,
  } = config;

  const startTime = Date.now();
  let currentInterval = intervalMs;

  while (true) {
    // Check abort signal
    if (signal?.aborted) {
      return { success: false, aborted: true };
    }

    // Check timeout
    if (Date.now() - startTime > timeoutMs) {
      return { success: false, timedOut: true };
    }

    try {
      const result = await fetchFn();
      
      if (condition(result)) {
        return { success: true, result };
      }

      // Wait with exponential backoff
      await sleep(currentInterval, signal);
      currentInterval = Math.min(currentInterval * backoffMultiplier, maxIntervalMs);
    } catch (error) {
      if (signal?.aborted) {
        return { success: false, aborted: true };
      }
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }

    const timeout = setTimeout(resolve, ms);
    
    signal?.addEventListener('abort', () => {
      clearTimeout(timeout);
      reject(new Error('Aborted'));
    }, { once: true });
  });
}

// Tests
if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;

  test('stops on condition', async () => {
    let count = 0;
    const result = await pollWithTimeout({
      fetchFn: async () => ++count,
      condition: (n) => n >= 3,
      intervalMs: 10,
      timeoutMs: 1000,
    });
    expect(result.success).toBe(true);
    expect(result.result).toBe(3);
  });

  test('times out after deadline', async () => {
    const result = await pollWithTimeout({
      fetchFn: async () => 'NOT_FOUND',
      condition: (s) => s === 'SUCCESS',
      intervalMs: 50,
      timeoutMs: 200,
    });
    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  test('respects abort signal', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    
    const result = await pollWithTimeout({
      fetchFn: async () => 'NOT_FOUND',
      condition: (s) => s === 'SUCCESS',
      intervalMs: 50,
      timeoutMs: 5000,
      signal: controller.signal,
    });
    expect(result.success).toBe(false);
    expect(result.aborted).toBe(true);
  });
}
