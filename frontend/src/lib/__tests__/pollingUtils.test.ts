import { describe, expect, it, vi } from "vitest";
import { pollWithTimeout, TransactionConfirmationError, waitForTransaction } from "../pollingUtils";

/** Deterministic clock: `sleep` advances virtual time instead of waiting. */
function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

describe("pollWithTimeout (#923)", () => {
  it("resolves as soon as the condition holds", async () => {
    const clock = fakeClock();
    const responses = ["NOT_FOUND", "NOT_FOUND", "SUCCESS"];
    const res = await pollWithTimeout({
      fetchFn: async () => responses.shift()!,
      condition: (s) => s !== "NOT_FOUND",
      timeoutMs: 30_000,
      intervalMs: 1_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(res).toEqual({ success: true, result: "SUCCESS", attempts: 3 });
  });

  it("times out instead of looping forever", async () => {
    const clock = fakeClock();
    const fetchFn = vi.fn(async () => "NOT_FOUND");
    const res = await pollWithTimeout({
      fetchFn,
      condition: (s) => s !== "NOT_FOUND",
      timeoutMs: 10_000,
      intervalMs: 1_000,
      backoffMultiplier: 2,
      maxIntervalMs: 4_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(res.success).toBe(false);
    expect(res).toMatchObject({ timedOut: true, aborted: false });
    // Backoff 1s, 2s, 4s (capped), then only the remaining 3s of budget.
    expect(clock.sleeps).toEqual([1_000, 2_000, 4_000, 3_000]);
    expect(clock.now()).toBe(10_000);
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    const clock = fakeClock();
    let calls = 0;
    const res = await pollWithTimeout({
      fetchFn: async () => {
        if (++calls === 2) controller.abort();
        return "NOT_FOUND";
      },
      condition: (s) => s !== "NOT_FOUND",
      timeoutMs: 60_000,
      intervalMs: 1_000,
      signal: controller.signal,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(res).toMatchObject({ success: false, aborted: true, attempts: 2 });
  });

  it("surfaces fetch errors without retrying blindly", async () => {
    const res = await pollWithTimeout({
      fetchFn: async () => {
        throw new Error("rpc down");
      },
      condition: () => true,
      timeoutMs: 1_000,
      intervalMs: 100,
    });
    expect(res.success).toBe(false);
    if (!res.success && !res.timedOut && !res.aborted) expect(res.error.message).toBe("rpc down");
  });

  it("aborting wakes a pending real sleep immediately", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const promise = pollWithTimeout({
      fetchFn: async () => "NOT_FOUND",
      condition: (s) => s !== "NOT_FOUND",
      timeoutMs: 60_000,
      intervalMs: 30_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    await expect(promise).resolves.toMatchObject({ aborted: true });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("waitForTransaction (SendView announcement confirmation, #923)", () => {
  it("returns the first terminal response", async () => {
    const clock = fakeClock();
    const statuses = ["NOT_FOUND", "FAILED"];
    const resp = await waitForTransaction(async () => ({ status: statuses.shift()! }), {
      timeoutMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(resp.status).toBe("FAILED");
  });

  it("throws a timeout error when the tx never lands", async () => {
    const clock = fakeClock();
    const err = await waitForTransaction(async () => ({ status: "NOT_FOUND" }), {
      timeoutMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TransactionConfirmationError);
    expect(err.reason).toBe("timeout");
    expect(err.message).toMatch(/not confirmed after 60s/);
    expect(clock.now()).toBe(60_000);
  });

  it("throws an aborted error when the view unmounts", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      waitForTransaction(async () => ({ status: "NOT_FOUND" }), { timeoutMs: 60_000, signal: controller.signal }),
    ).rejects.toMatchObject({ reason: "aborted" });
  });
});
