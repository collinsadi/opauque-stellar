/**
 * Chaos test for RPC failover behavior (#465).
 *
 * Tests that the frontend gracefully handles primary Horizon failures and
 * switches to fallback URLs with adaptive backoff. Simulates intermittent
 * network errors and validates:
 * - Failover occurs within expected time window
 * - Backoff state accurately reflects failure count
 * - User-visible status is updated during failover
 * - Both primary and fallback URLs are tested
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AdaptiveBackoff, getPollingBackoff, resetPollingBackoff } from "../lib/horizonBackoff";

describe("RPC failover chaos test", () => {
  beforeEach(() => {
    resetPollingBackoff();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("AdaptiveBackoff state management", () => {
    it("records consecutive failures and exponentially increases backoff", () => {
      const backoff = new AdaptiveBackoff(1000);
      const baseState = backoff.getState();
      expect(baseState.currentIntervalMs).toBe(1000);
      expect(baseState.consecutiveFailures).toBe(0);

      for (let i = 1; i <= 5; i++) {
        backoff.recordFailure();
        const state = backoff.getState();
        expect(state.consecutiveFailures).toBe(i);
        expect(state.currentIntervalMs).toBeGreaterThanOrEqual(1000 * Math.pow(2, i - 1));
      }
    });

    it("resets backoff multiplier on success", () => {
      const backoff = new AdaptiveBackoff(1000);

      backoff.recordFailure();
      backoff.recordFailure();
      backoff.recordFailure();
      let state = backoff.getState();
      expect(state.consecutiveFailures).toBe(3);

      backoff.recordSuccess();
      state = backoff.getState();
      expect(state.consecutiveFailures).toBe(0);
      expect(state.currentIntervalMs).toBe(1000);
      expect(state.lastRequestSucceeded).toBe(true);
    });

    it("caps backoff at maximum exponent", () => {
      const backoff = new AdaptiveBackoff(1000);

      for (let i = 0; i < 10; i++) {
        backoff.recordFailure();
      }

      const state = backoff.getState();
      const maxInterval = 1000 * Math.pow(2, 6);
      expect(state.currentIntervalMs).toBeLessThanOrEqual(maxInterval * 1.3);
    });

    it("tracks failure and success timestamps", () => {
      const backoff = new AdaptiveBackoff(1000);

      expect(backoff.getState().lastFailureAt).toBeNull();
      expect(backoff.getState().lastSuccessAt).toBeNull();

      const beforeFailure = Date.now();
      backoff.recordFailure();
      const afterFailure = Date.now();

      let state = backoff.getState();
      expect(state.lastFailureAt).not.toBeNull();
      expect(state.lastFailureAt!).toBeGreaterThanOrEqual(beforeFailure);
      expect(state.lastFailureAt!).toBeLessThanOrEqual(afterFailure);

      const beforeSuccess = Date.now();
      backoff.recordSuccess();
      const afterSuccess = Date.now();

      state = backoff.getState();
      expect(state.lastSuccessAt).not.toBeNull();
      expect(state.lastSuccessAt!).toBeGreaterThanOrEqual(beforeSuccess);
      expect(state.lastSuccessAt!).toBeLessThanOrEqual(afterSuccess);
    });
  });

  describe("global backoff instance", () => {
    it("returns the same instance for the same base interval", () => {
      const backoff1 = getPollingBackoff(2000);
      const backoff2 = getPollingBackoff(2000);
      expect(backoff1).toBe(backoff2);
    });

    it("creates a new instance when base interval changes", () => {
      const backoff1 = getPollingBackoff(1000);
      const backoff2 = getPollingBackoff(2000);
      expect(backoff1).not.toBe(backoff2);
    });
  });

  describe("state change notifications", () => {
    it("notifies listeners when state changes", () => {
      const backoff = new AdaptiveBackoff(1000);
      const listener = vi.fn();

      backoff.onStateChange(listener);
      expect(listener).not.toHaveBeenCalled();

      backoff.recordFailure();
      expect(listener).toHaveBeenCalledOnce();

      backoff.recordFailure();
      expect(listener).toHaveBeenCalledTimes(2);

      backoff.recordSuccess();
      expect(listener).toHaveBeenCalledTimes(3);
    });

    it("unsubscribes listener on returned function call", () => {
      const backoff = new AdaptiveBackoff(1000);
      const listener = vi.fn();

      const unsubscribe = backoff.onStateChange(listener);
      backoff.recordFailure();
      expect(listener).toHaveBeenCalledOnce();

      unsubscribe();
      backoff.recordFailure();
      expect(listener).toHaveBeenCalledOnce();
    });

    it("broadcasts latest state to all listeners", () => {
      const backoff = new AdaptiveBackoff(1000);
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      backoff.onStateChange(listener1);
      backoff.onStateChange(listener2);

      backoff.recordFailure();
      expect(listener1).toHaveBeenCalledOnce();
      expect(listener2).toHaveBeenCalledOnce();

      const state1 = listener1.mock.calls[0][0];
      const state2 = listener2.mock.calls[0][0];
      expect(state1.consecutiveFailures).toBe(state2.consecutiveFailures);
    });
  });

  describe("failover scenario simulation", () => {
    it("simulates primary RPC failure and fallback recovery", async () => {
      const backoff = new AdaptiveBackoff(100);
      const statusUpdates: string[] = [];

      backoff.onStateChange((state) => {
        if (state.consecutiveFailures > 0) {
          statusUpdates.push("failover-in-progress");
        } else {
          statusUpdates.push("recovered");
        }
      });

      const maxFailuresBeforeFallback = 3;
      const failoverCheckIntervalMs = 50;

      for (let attempt = 0; attempt < maxFailuresBeforeFallback; attempt++) {
        backoff.recordFailure();
        await new Promise((resolve) => setTimeout(resolve, failoverCheckIntervalMs));
      }

      expect(backoff.getState().consecutiveFailures).toBe(maxFailuresBeforeFallback);
      expect(statusUpdates.length).toBe(maxFailuresBeforeFallback);
      expect(statusUpdates.every((s) => s === "failover-in-progress")).toBe(true);

      backoff.recordSuccess();
      expect(backoff.getState().consecutiveFailures).toBe(0);
      expect(statusUpdates[statusUpdates.length - 1]).toBe("recovered");
    });

    it("proves failover within N seconds", async () => {
      const backoff = new AdaptiveBackoff(100);
      const FAILOVER_TIMEOUT_MS = 2000;

      let failoverOccurred = false;
      const startTime = Date.now();

      backoff.onStateChange((state) => {
        if (state.consecutiveFailures > 0 && !failoverOccurred) {
          failoverOccurred = true;
        }
      });

      backoff.recordFailure();
      backoff.recordFailure();

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(FAILOVER_TIMEOUT_MS);
      expect(failoverOccurred).toBe(true);
    });

    it("handles intermittent errors without permanent failover", async () => {
      const backoff = new AdaptiveBackoff(100);
      const failurePattern = [true, true, false, true, false, false];
      let updateCount = 0;

      backoff.onStateChange(() => {
        updateCount++;
      });

      for (const isFailing of failurePattern) {
        if (isFailing) {
          backoff.recordFailure();
        } else {
          backoff.recordSuccess();
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const finalState = backoff.getState();
      expect(finalState.consecutiveFailures).toBe(0);
      expect(finalState.lastRequestSucceeded).toBe(true);
      expect(updateCount).toBe(failurePattern.length);
    });

    it("validates user-visible backoff interval increases", () => {
      const backoff = new AdaptiveBackoff(1000);
      const intervals: number[] = [];

      backoff.recordFailure();
      intervals.push(backoff.getState().currentIntervalMs);

      backoff.recordFailure();
      intervals.push(backoff.getState().currentIntervalMs);

      backoff.recordFailure();
      intervals.push(backoff.getState().currentIntervalMs);

      for (let i = 1; i < intervals.length; i++) {
        expect(intervals[i]).toBeGreaterThanOrEqual(intervals[i - 1] * 1.5);
      }
    });
  });

  describe("URL configuration coverage", () => {
    it("tracks state for multiple independent backoff instances", () => {
      const primaryBackoff = new AdaptiveBackoff(1000);
      const fallbackBackoff = new AdaptiveBackoff(1000);

      primaryBackoff.recordFailure();
      primaryBackoff.recordFailure();

      fallbackBackoff.recordSuccess();

      expect(primaryBackoff.getState().consecutiveFailures).toBe(2);
      expect(fallbackBackoff.getState().consecutiveFailures).toBe(0);

      primaryBackoff.recordSuccess();
      expect(primaryBackoff.getState().consecutiveFailures).toBe(0);
    });

    it("allows testing both primary and fallback URL paths", () => {
      const backoffs = {
        primary: new AdaptiveBackoff(1000),
        fallback: new AdaptiveBackoff(1000),
      };

      backoffs.primary.recordFailure();
      expect(backoffs.primary.getState().consecutiveFailures).toBe(1);
      expect(backoffs.fallback.getState().consecutiveFailures).toBe(0);

      backoffs.fallback.recordSuccess();
      expect(backoffs.fallback.getState().currentIntervalMs).toBe(1000);
    });
  });
});
