/**
 * Pending-tx store + poller tests (#114).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { usePendingTxStore } from "../../store/pendingTxStore";
import { pollPendingTransactions, type ChainStatusResult } from "../pending-tx-poller";

beforeEach(() => {
  // Reset the persisted slice between tests.
  usePendingTxStore.setState({ byHash: {} });
});

describe("pendingTxStore (#114)", () => {
  it("rejects duplicate submissions (duplicate-submit guard)", () => {
    const ok = usePendingTxStore.getState().add({
      txHash: "h1",
      cluster: "testnet",
      kind: "send",
    });
    expect(ok).toBe(true);
    const again = usePendingTxStore.getState().add({
      txHash: "h1",
      cluster: "testnet",
      kind: "send",
    });
    expect(again).toBe(false);
    expect(Object.keys(usePendingTxStore.getState().byHash)).toHaveLength(1);
  });

  it("filters by cluster on list()", () => {
    usePendingTxStore.getState().add({ txHash: "h1", cluster: "testnet", kind: "send" });
    usePendingTxStore.getState().add({ txHash: "h2", cluster: "mainnet", kind: "send" });
    expect(usePendingTxStore.getState().list("testnet").map((e) => e.txHash)).toEqual(["h1"]);
  });

  it("prune() drops terminal entries older than the cleanup window", () => {
    usePendingTxStore.getState().add({ txHash: "h1", cluster: "testnet", kind: "send" });
    usePendingTxStore.getState().setStatus("h1", "confirmed");
    // Advance fake time past the 60s cleanup.
    const future = Date.now() + 120_000;
    usePendingTxStore.getState().prune(future);
    expect(usePendingTxStore.getState().byHash.h1).toBeUndefined();
  });

  it("prune() keeps pending entries regardless of age", () => {
    usePendingTxStore.getState().add({ txHash: "h1", cluster: "testnet", kind: "send" });
    const future = Date.now() + 10 * 60_000;
    usePendingTxStore.getState().prune(future);
    expect(usePendingTxStore.getState().byHash.h1).toBeDefined();
  });
});

describe("pollPendingTransactions (#114)", () => {
  it("flips pending → confirmed on the next tick when the chain says so", async () => {
    usePendingTxStore.getState().add({ txHash: "h1", cluster: "testnet", kind: "send" });
    const fetchStatus = vi.fn().mockResolvedValue<ChainStatusResult>({
      state: "confirmed",
      message: "ok",
    } as ChainStatusResult);

    const cancel = pollPendingTransactions({ fetchStatus, intervalMs: 100_000 });
    // The poller kicks off immediately — give it a tick to settle.
    await new Promise((r) => setTimeout(r, 5));
    cancel();
    expect(usePendingTxStore.getState().byHash.h1.status).toBe("confirmed");
  });

  it("times out an entry past the configured maxWait", async () => {
    usePendingTxStore.getState().add({ txHash: "h1", cluster: "testnet", kind: "send" });
    const fetchStatus = vi.fn().mockResolvedValue<ChainStatusResult>({ state: "notFound" });
    const oldNow = Date.now() + 1_000_000;

    const cancel = pollPendingTransactions({
      fetchStatus,
      intervalMs: 100_000,
      timeoutMs: 1_000,
      now: () => oldNow,
    });
    await new Promise((r) => setTimeout(r, 5));
    cancel();
    expect(usePendingTxStore.getState().byHash.h1.status).toBe("timed_out");
  });

  it("treats a network blip as a non-terminal state", async () => {
    usePendingTxStore.getState().add({ txHash: "h1", cluster: "testnet", kind: "send" });
    const fetchStatus = vi.fn().mockRejectedValue(new Error("boom"));
    const cancel = pollPendingTransactions({ fetchStatus, intervalMs: 100_000 });
    await new Promise((r) => setTimeout(r, 5));
    cancel();
    expect(usePendingTxStore.getState().byHash.h1.status).toBe("pending");
  });
});
