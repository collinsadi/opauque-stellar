import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowlist } from "../src/policy.ts";
import { FileStore, MemoryStore, type Store } from "../src/store.ts";
import { runPoolTick } from "../src/engine.ts";
import { REINSTATEMENT_POLICY, reinstateDeposit } from "../src/reinstate.ts";
import { acquireFileLock, LockTimeoutError } from "../src/lock.ts";
import type { ChainAdapter, Deposit, Policy } from "../src/types.ts";

const deposit = (index: number, ledger = 10 + index): Deposit => ({ index, commitment: "0x00", value: "1", scope: 1, ledger });

class FakeAdapter implements ChainAdapter {
  deposits: Deposit[] = [];
  root: string | null = null;
  posts: string[] = [];
  reads: number[] = [];
  /** When set, readDeposits blocks until the gate resolves (simulates a slow RPC). */
  gate: Promise<void> | null = null;
  onRead: (() => void) | null = null;
  async readDeposits(afterIndex: number): Promise<Deposit[]> {
    this.reads.push(afterIndex);
    this.onRead?.();
    if (this.gate) await this.gate;
    return this.deposits.filter((d) => d.index > afterIndex);
  }
  async currentAspRoot() {
    return this.root;
  }
  async postAspRoot(root: string) {
    this.root = root;
    this.posts.push(root);
  }
  async latestLedger() {
    return 1_000;
  }
}

const deferAll: Policy = { name: "pending-review", screen: () => "defer", reason: () => "awaiting screening data" };

describe("decision history is bounded (#1086)", () => {
  it("re-evaluating an unchanged deferral appends no new decision and skips the save", async () => {
    const adapter = new FakeAdapter();
    adapter.deposits = [deposit(0), deposit(1)];
    const store = new MemoryStore();
    const base = { poolId: "pool", scope: 1, adapter, store, policy: deferAll };

    await runPoolTick(base);
    const first = store.load("pool")!;
    expect(first.deferredIndices).toEqual([0, 1]);
    expect(first.decisions).toHaveLength(2);
    const savesAfterFirst = store.saves;

    for (let i = 0; i < 25; i++) await runPoolTick(base);
    expect(store.load("pool")!.decisions).toHaveLength(2);
    // Nothing changed, so the state file is not rewritten every tick.
    expect(store.saves).toBe(savesAfterFirst);
  });

  it("records a new decision when a deferral's verdict or reason changes", async () => {
    const adapter = new FakeAdapter();
    adapter.deposits = [deposit(0)];
    const store = new MemoryStore();
    let reason = "awaiting screening data";
    let verdict: "defer" | "approve" = "defer";
    const policy: Policy = { name: "pending-review", screen: () => verdict, reason: () => reason };
    const base = { poolId: "pool", scope: 1, adapter, store, policy };

    await runPoolTick(base);
    await runPoolTick(base);
    reason = "provider timed out";
    await runPoolTick(base);
    verdict = "approve";
    reason = "cleared";
    await runPoolTick(base);
    await runPoolTick(base);

    const decisions = store.load("pool")!.decisions!;
    expect(decisions.map((d) => [d.verdict, d.reason])).toEqual([
      ["defer", "awaiting screening data"],
      ["defer", "provider timed out"],
      ["approve", "cleared"],
    ]);
    expect(store.load("pool")!.approvedIndices).toEqual([0]);
  });

  it("resumes reads just before the oldest deferral instead of from genesis", async () => {
    const adapter = new FakeAdapter();
    adapter.deposits = [deposit(0), deposit(1), deposit(2), deposit(3)];
    const store = new MemoryStore();
    const policy: Policy = { name: "p", screen: (d) => (d.index === 2 ? "defer" : "approve") };
    await runPoolTick({ poolId: "pool", scope: 1, adapter, store, policy });
    await runPoolTick({ poolId: "pool", scope: 1, adapter, store, policy });
    expect(adapter.reads).toEqual([-1, 1]);
  });
});

function reinstateSuite(name: string, makeStore: () => Store) {
  describe(`reinstatement under concurrency (${name})`, () => {
    async function seedRejected(store: Store, adapter: FakeAdapter) {
      adapter.deposits = [deposit(0), deposit(1), deposit(2)];
      await runPoolTick({ poolId: "pool", scope: 1, adapter, store, policy: allowlist([1]) });
      expect(store.load("pool")!.rejectedIndices).toEqual([0, 2]);
    }

    it("records an audit decision", async () => {
      const store = makeStore();
      const adapter = new FakeAdapter();
      await seedRejected(store, adapter);
      const res = await reinstateDeposit(store, "pool", 2, { operator: "alice", reason: "appeal #7", now: () => "T" });
      const state = store.load("pool")!;
      expect(state.approvedIndices).toEqual([1, 2]);
      expect(state.rejectedIndices).toEqual([0]);
      expect(state.decisions!.at(-1)).toEqual({
        depositIndex: 2,
        policy: REINSTATEMENT_POLICY,
        verdict: "approve",
        reason: "appeal approved; reinstated into next association set; operator=alice; reason=appeal #7",
        timestamp: "T",
      });
      expect(res.decision).toEqual(state.decisions!.at(-1));
    });

    it("is not overwritten by a tick that is in flight when it runs", async () => {
      const store = makeStore();
      const adapter = new FakeAdapter();
      await seedRejected(store, adapter);

      // Start a tick and hold it inside readDeposits (after it has taken the lock).
      let open!: () => void;
      adapter.gate = new Promise<void>((r) => (open = r));
      const entered = new Promise<void>((r) => (adapter.onRead = r));
      const tick = runPoolTick({ poolId: "pool", scope: 1, adapter, store, policy: allowlist([1]) });
      await entered;

      let reinstated = false;
      const reinstate = reinstateDeposit(store, "pool", 2, { lock: { retryMs: 5 } }).then((r) => {
        reinstated = true;
        return r;
      });
      // The reinstatement must wait for the in-flight tick to release the lock.
      await new Promise((r) => setTimeout(r, 40));
      expect(reinstated).toBe(false);

      open();
      await tick;
      await reinstate;
      adapter.gate = null;

      const state = store.load("pool")!;
      expect(state.approvedIndices).toEqual([1, 2]);
      expect(state.rejectedIndices).toEqual([0]);
      expect(state.decisions!.filter((d) => d.policy === REINSTATEMENT_POLICY)).toHaveLength(1);

      // And the next tick publishes a root that includes the reinstated deposit.
      const postsBefore = adapter.posts.length;
      const res = await runPoolTick({ poolId: "pool", scope: 1, adapter, store, policy: allowlist([1]) });
      expect(res.approvedCount).toBe(2);
      expect(res.published).toBe(true);
      expect(adapter.posts.length).toBe(postsBefore + 1);
      expect(store.load("pool")!.approvedIndices).toEqual([1, 2]);
    });

    it("serialises concurrent reinstatements so none are lost", async () => {
      const store = makeStore();
      const adapter = new FakeAdapter();
      adapter.deposits = [0, 1, 2, 3, 4, 5].map((i) => deposit(i));
      await runPoolTick({ poolId: "pool", scope: 1, adapter, store, policy: allowlist([]) });

      const results = await Promise.allSettled([
        reinstateDeposit(store, "pool", 1, { lock: { retryMs: 1 } }),
        reinstateDeposit(store, "pool", 3, { lock: { retryMs: 1 } }),
        reinstateDeposit(store, "pool", 5, { lock: { retryMs: 1 } }),
        reinstateDeposit(store, "pool", 3, { lock: { retryMs: 1 } }),
        runPoolTick({ poolId: "pool", scope: 1, adapter, store, policy: allowlist([]) }),
      ]);
      expect(results.slice(0, 3).every((r) => r.status === "fulfilled")).toBe(true);
      // The duplicate request sees the first one's result and is refused.
      expect(results[3]).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/not a persisted rejection/) }) });
      expect(results[4].status).toBe("fulfilled");

      const state = store.load("pool")!;
      expect(state.approvedIndices).toEqual([1, 3, 5]);
      expect(state.rejectedIndices).toEqual([0, 2, 4]);
      expect(state.decisions!.filter((d) => d.policy === REINSTATEMENT_POLICY).map((d) => d.depositIndex).sort()).toEqual([1, 3, 5]);
    });
  });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "asp-reinstate-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

reinstateSuite("MemoryStore", () => new MemoryStore());
reinstateSuite("FileStore", () => new FileStore(dir));

describe("file lock", () => {
  it("times out while another holder is alive and releases cleanly", async () => {
    const lockPath = join(dir, "state", "pool.json.lock");
    const release = await acquireFileLock(lockPath);
    await expect(acquireFileLock(lockPath, { timeoutMs: 30, retryMs: 5 })).rejects.toBeInstanceOf(LockTimeoutError);
    release();
    expect(existsSync(lockPath)).toBe(false);
    (await acquireFileLock(lockPath, { timeoutMs: 30 }))();
  });

  it("reclaims a lock left by a process that no longer exists", async () => {
    const lockPath = join(dir, "state", "pool.json.lock");
    mkdirSync(join(dir, "state"), { recursive: true });
    // PIDs this large are never allocated on Linux/macOS.
    writeFileSync(lockPath, "2147483646 0 stale");
    const release = await acquireFileLock(lockPath, { timeoutMs: 100 });
    release();
    expect(existsSync(lockPath)).toBe(false);
  });
});
