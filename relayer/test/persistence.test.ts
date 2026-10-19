import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { MemoryGossipTransport } from "../src/gossip.ts";
import { RelayerHub } from "../src/hub.ts";
import {
  FileHubStore,
  FileLedgerStore,
  MemoryHubStore,
  MemoryLedgerStore,
} from "../src/store.ts";
import { JobLedger, PayoutReconciler } from "../src/reconciler.ts";
import type { RelayerChainAdapter, OnChainJob, OnChainRelayer } from "../src/engine.ts";
import type { PoolWithdrawPayload } from "../src/shared/payload.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACCOUNT_A = "GABTYFQAXDR724JAJSNZVUH56T62JJ7CLWT6YL56ME7OPA4DIIMAMOI6";
const ACCOUNT_B = "GDKPRDH3AGALVIZ3OX5LJGNIXZOWUBCIX5HA36YXOSQOGEZLDCJOSGDR";
const CONTRACT = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";

function bytes(len: number, tag: number): Uint8Array {
  return new Uint8Array(len).fill(tag);
}

function bytesToHex(b: Uint8Array): string {
  return "0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function bidFor(jobIdHex: string, operator: string) {
  return {
    t: "bid" as const,
    v: 1 as const,
    jobId: jobIdHex,
    chain: 0,
    operator,
    x25519Pk: bytesToHex(bytes(32, operator.charCodeAt(0))),
    sig: "sig",
  };
}

class StubChain implements RelayerChainAdapter {
  constructor(private jobs: Map<string, OnChainJob> = new Map()) {}

  async getJob(jobId: string): Promise<OnChainJob | null> {
    return this.jobs.get(jobId.toLowerCase()) ?? null;
  }
  async getRelayer(): Promise<OnChainRelayer | null> {
    return null;
  }
  async latestLedger(): Promise<number> {
    return 0;
  }
  async simulatePoolWithdraw(): Promise<void> {}
  async acceptJob(): Promise<string> {
    return "acc-tx";
  }
  async submitPoolWithdraw(): Promise<string> {
    return "sub-tx";
  }
}

// ---------------------------------------------------------------------------
// MemoryHubStore
// ---------------------------------------------------------------------------

describe("MemoryHubStore", () => {
  it("returns null when empty", async () => {
    const store = new MemoryHubStore();
    expect(await store.load()).toBeNull();
  });

  it("round-trips hub state through save/load", async () => {
    const store = new MemoryHubStore();
    const state = {
      bids: [["job1", [bidFor("job1", ACCOUNT_A)]] as const],
      outcomes: [["op1", [{ result: "completed" as const, at: 1000 }]] as const],
      knownOperators: [ACCOUNT_A],
      lastHeartbeatAt: [[ACCOUNT_A, 2000] as const],
      assignments: [["job1", ACCOUNT_A] as const],
      stats: {
        advertsSeen: 1,
        bidsSeen: 2,
        payloadsSeen: 3,
        outcomesSeen: 4,
        heartbeatsSeen: 5,
        lastError: null,
      },
    };
    await store.save(state);
    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.bids).toHaveLength(1);
    expect(loaded!.bids[0][0]).toBe("job1");
    expect(loaded!.outcomes[0][1][0].result).toBe("completed");
    expect(loaded!.knownOperators).toEqual([ACCOUNT_A]);
    expect(loaded!.assignments[0][1]).toBe(ACCOUNT_A);
    expect(loaded!.stats.bidsSeen).toBe(2);
  });

  it("clear wipes state", async () => {
    const store = new MemoryHubStore();
    await store.save({
      bids: [],
      outcomes: [],
      knownOperators: [ACCOUNT_A],
      lastHeartbeatAt: [],
      assignments: [],
      stats: { advertsSeen: 0, bidsSeen: 0, payloadsSeen: 0, outcomesSeen: 0, heartbeatsSeen: 0, lastError: null },
    });
    await store.clear();
    expect(await store.load()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MemoryLedgerStore
// ---------------------------------------------------------------------------

describe("MemoryLedgerStore", () => {
  it("returns null when empty", async () => {
    const store = new MemoryLedgerStore();
    expect(await store.load()).toBeNull();
  });

  it("round-trips ledger entries", async () => {
    const store = new MemoryLedgerStore();
    const entries = [
      { jobId: "0x01", acceptedTx: "a1", submittedTx: "s1", expectedFee: 100n, submittedAt: 1000 },
      { jobId: "0x02", acceptedTx: "a2", submittedTx: "s2", expectedFee: 200n, submittedAt: 2000 },
    ];
    await store.save(entries);
    const loaded = await store.load();
    expect(loaded).toHaveLength(2);
    expect(loaded![0].expectedFee).toBe(100n);
    expect(loaded![1].expectedFee).toBe(200n);
  });

  it("clear wipes state", async () => {
    const store = new MemoryLedgerStore();
    await store.save([{ jobId: "0x01", acceptedTx: "a", submittedTx: "s", expectedFee: 10n, submittedAt: 1 }]);
    await store.clear();
    expect(await store.load()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FileHubStore
// ---------------------------------------------------------------------------

describe("FileHubStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "relayer-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when file does not exist", async () => {
    const store = new FileHubStore(join(tmpDir, "nonexistent"));
    expect(await store.load()).toBeNull();
  });

  it("round-trips hub state to disk", async () => {
    const store = new FileHubStore(tmpDir);
    const state = {
      bids: [["job1", [bidFor("job1", ACCOUNT_A)]] as const],
      outcomes: [["op1", [{ result: "completed" as const, at: 1000 }]] as const],
      knownOperators: [ACCOUNT_A],
      lastHeartbeatAt: [[ACCOUNT_A, 2000] as const],
      assignments: [["job1", ACCOUNT_A] as const],
      stats: { advertsSeen: 1, bidsSeen: 2, payloadsSeen: 3, outcomesSeen: 4, heartbeatsSeen: 5, lastError: null },
    };
    await store.save(state);
    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.bids[0][0]).toBe("job1");
    expect(loaded!.knownOperators).toEqual([ACCOUNT_A]);
  });

  it("clear removes the file", async () => {
    const store = new FileHubStore(tmpDir);
    await store.save({
      bids: [],
      outcomes: [],
      knownOperators: [],
      lastHeartbeatAt: [],
      assignments: [],
      stats: { advertsSeen: 0, bidsSeen: 0, payloadsSeen: 0, outcomesSeen: 0, heartbeatsSeen: 0, lastError: null },
    });
    await store.clear();
    expect(await store.load()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FileLedgerStore
// ---------------------------------------------------------------------------

describe("FileLedgerStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "relayer-ledger-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when file does not exist", async () => {
    const store = new FileLedgerStore(join(tmpDir, "nonexistent"));
    expect(await store.load()).toBeNull();
  });

  it("round-trips entries with bigint fee to disk", async () => {
    const store = new FileLedgerStore(tmpDir);
    const fee = 999999999999999999n;
    const entries = [
      { jobId: "0x01", acceptedTx: "a1", submittedTx: "s1", expectedFee: fee, submittedAt: 1000 },
    ];
    await store.save(entries);
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded![0].expectedFee).toBe(fee);
  });

  it("loads legacy ledger entries stored with numeric fees", async () => {
    writeFileSync(join(tmpDir, "ledger.json"), JSON.stringify({
      version: 1,
      entries: [{ jobId: "0xlegacy", acceptedTx: "a", submittedTx: "s", expectedFee: 123, submittedAt: 1000 }],
    }));

    const loaded = await new FileLedgerStore(tmpDir).load();

    expect(loaded?.[0].expectedFee).toBe(123n);
  });

  it("loads legacy tagged bigint fees", async () => {
    writeFileSync(join(tmpDir, "ledger.json"), JSON.stringify({
      version: 1,
      entries: [{ jobId: "0xtagged", acceptedTx: "a", submittedTx: "s", expectedFee: "__bigint__:456", submittedAt: 1000 }],
    }));

    const loaded = await new FileLedgerStore(tmpDir).load();

    expect(loaded?.[0].expectedFee).toBe(456n);
  });

  it("reconciles cleanly after restoring a saved bigint fee", async () => {
    const store = new FileLedgerStore(tmpDir);
    const fee = 999999999999999999n;
    await store.save([
      { jobId: "0xjob", acceptedTx: "a1", submittedTx: "s1", expectedFee: fee, submittedAt: 1000 },
    ]);

    const restartedLedger = new JobLedger(new FileLedgerStore(tmpDir));
    await restartedLedger.hydrate();
    const chain = new StubChain(new Map([
      ["0xjob", { exists: true, status: "submitted", fee, deadline: 9999, payloadHash: "0x" }],
    ]));
    const report = await new PayoutReconciler({ chain, ledger: restartedLedger }).reconcile();

    expect(report.summary).toBe("clean");
    expect(report.cleanCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Hub persistence — survives simulated restart
// ---------------------------------------------------------------------------

describe("hub persistence", () => {
  it("restores bids, outcomes, and assignments on restart", async () => {
    const store = new MemoryHubStore();
    const jobIdHex = bytesToHex(bytes(32, 0x70));

    // --- First lifecycle: build state ---
    const hub1 = new RelayerHub(new MemoryGossipTransport(), undefined, store);
    await hub1.start();

    hub1.rememberBid(bidFor(jobIdHex, ACCOUNT_A));
    hub1.rememberBid(bidFor(jobIdHex, ACCOUNT_B));
    hub1.recordOutcome(ACCOUNT_A, "completed");
    hub1.recordOutcome(ACCOUNT_A, "failed");
    hub1.recordHeartbeat(ACCOUNT_A);

    // Simulate assignment via payload
    await hub1.handlePayload({
      t: "payload",
      v: 1,
      jobId: jobIdHex,
      to: bidFor(jobIdHex, ACCOUNT_A).x25519Pk,
      box: "box",
    });

    // --- Second lifecycle: fresh hub with same store ---
    const hub2 = new RelayerHub(new MemoryGossipTransport(), undefined, store);
    await hub2.start();

    // Bids restored
    expect(hub2.bidsFor(jobIdHex)).toHaveLength(2);
    expect(hub2.bidsFor(jobIdHex).map((b) => b.operator)).toContain(ACCOUNT_A);
    expect(hub2.bidsFor(jobIdHex).map((b) => b.operator)).toContain(ACCOUNT_B);

    // Scores restored (outcomes persisted)
    const score = hub2.scoreFor(ACCOUNT_A);
    expect(score.completed).toBe(1);
    expect(score.failed).toBe(1);
    expect(score.score).toBeCloseTo(0.5);

    // Heartbeat restored — node should be alive
    expect(hub2.isNodeAlive(ACCOUNT_A)).toBe(true);
  });

  it("hub without store behaves identically (no persistence)", async () => {
    const hub = new RelayerHub(new MemoryGossipTransport());
    await hub.start();
    hub.rememberBid(bidFor(bytesToHex(bytes(32, 0x80)), ACCOUNT_A));
    // Should not throw
    expect(hub.bidsFor(bytesToHex(bytes(32, 0x80)))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// JobLedger persistence
// ---------------------------------------------------------------------------

describe("job ledger persistence", () => {
  it("restores entries from store on hydrate", async () => {
    const store = new MemoryLedgerStore();
    await store.save([
      { jobId: "0xaaa", acceptedTx: "a1", submittedTx: "s1", expectedFee: 100n, submittedAt: 1000 },
      { jobId: "0xbbb", acceptedTx: "a2", submittedTx: "s2", expectedFee: 200n, submittedAt: 2000 },
    ]);

    const ledger = new JobLedger(store);
    await ledger.hydrate();

    expect(ledger.size()).toBe(2);
    expect(ledger.get("0xaaa")?.expectedFee).toBe(100n);
    expect(ledger.get("0xbbb")?.expectedFee).toBe(200n);
  });

  it("persists new entries to store", async () => {
    const store = new MemoryLedgerStore();
    const ledger = new JobLedger(store);
    ledger.record({ jobId: "0x01", acceptedTx: "a", submittedTx: "s", expectedFee: 50n, submittedAt: 100 });

    const saved = await store.load();
    expect(saved).toHaveLength(1);
    expect(saved![0].jobId).toBe("0x01");
  });

  it("removes entry from store", async () => {
    const store = new MemoryLedgerStore();
    const ledger = new JobLedger(store);
    ledger.record({ jobId: "0x01", acceptedTx: "a", submittedTx: "s", expectedFee: 50n, submittedAt: 100 });
    ledger.record({ jobId: "0x02", acceptedTx: "b", submittedTx: "t", expectedFee: 60n, submittedAt: 200 });
    ledger.remove("0x01");

    expect(ledger.size()).toBe(1);
    expect(ledger.get("0x01")).toBeUndefined();

    // Verify store was updated
    const saved = await store.load();
    expect(saved).toHaveLength(1);
    expect(saved![0].jobId).toBe("0x02");
  });

  it("ledger without store works without errors", () => {
    const ledger = new JobLedger();
    ledger.record({ jobId: "0x01", acceptedTx: "a", submittedTx: "s", expectedFee: 50n, submittedAt: 100 });
    expect(ledger.size()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// PayoutReconciler.verifyOnBoot
// ---------------------------------------------------------------------------

describe("PayoutReconciler.verifyOnBoot", () => {
  it("removes stale ledger entries not found on-chain", async () => {
    const store = new MemoryLedgerStore();
    await store.save([
      { jobId: "0xstale", acceptedTx: "a", submittedTx: "s", expectedFee: 100n, submittedAt: 1000 },
    ]);

    const ledger = new JobLedger(store);
    const chain = new StubChain(new Map());
    const rec = new PayoutReconciler({ chain, ledger });

    const report = await rec.verifyOnBoot();

    expect(report.notFoundCount).toBe(1);
    expect(ledger.size()).toBe(0);
  });

  it("flags fee discrepancies but keeps the entry", async () => {
    const store = new MemoryLedgerStore();
    await store.save([
      { jobId: "0xfee", acceptedTx: "a", submittedTx: "s", expectedFee: 100n, submittedAt: 1000 },
    ]);

    const ledger = new JobLedger(store);
    const chain = new StubChain(
      new Map([["0xfee", { exists: true, status: "submitted", fee: 50n, deadline: 9999, payloadHash: "0x" }]]),
    );
    const rec = new PayoutReconciler({ chain, ledger });

    const report = await rec.verifyOnBoot();

    expect(report.discrepancyCount).toBe(1);
    expect(report.discrepancies[0].detail).toMatch(/fee mismatch/);
    // Entry kept — only not_found is removed
    expect(ledger.size()).toBe(1);
  });

  it("marks jobs with wrong status as discrepancy", async () => {
    const store = new MemoryLedgerStore();
    await store.save([
      { jobId: "0xstat", acceptedTx: "a", submittedTx: "s", expectedFee: 10n, submittedAt: 1000 },
    ]);

    const ledger = new JobLedger(store);
    const chain = new StubChain(
      new Map([["0xstat", { exists: true, status: "open", fee: 10n, deadline: 9999, payloadHash: "0x" }]]),
    );
    const rec = new PayoutReconciler({ chain, ledger });

    const report = await rec.verifyOnBoot();

    expect(report.discrepancyCount).toBe(1);
    expect(report.discrepancies[0].detail).toMatch(/unexpected status/);
    expect(ledger.size()).toBe(1);
  });

  it("returns clean report when all jobs match chain", async () => {
    const store = new MemoryLedgerStore();
    await store.save([
      { jobId: "0xok", acceptedTx: "a", submittedTx: "s", expectedFee: 100n, submittedAt: 1000 },
    ]);

    const ledger = new JobLedger(store);
    const chain = new StubChain(
      new Map([["0xok", { exists: true, status: "submitted", fee: 100n, deadline: 9999, payloadHash: "0x" }]]),
    );
    const rec = new PayoutReconciler({ chain, ledger });

    const report = await rec.verifyOnBoot();

    expect(report.summary).toBe("clean");
    expect(report.cleanCount).toBe(1);
    expect(ledger.size()).toBe(1);
  });

  it("hydrates ledger from store before reconciling", async () => {
    const store = new MemoryLedgerStore();
    await store.save([
      { jobId: "0xboot", acceptedTx: "a", submittedTx: "s", expectedFee: 100n, submittedAt: 1000 },
    ]);

    const ledger = new JobLedger(store);
    const chain = new StubChain(
      new Map([["0xboot", { exists: true, status: "submitted", fee: 100n, deadline: 9999, payloadHash: "0x" }]]),
    );
    const rec = new PayoutReconciler({ chain, ledger });

    expect(ledger.size()).toBe(0);
    const report = await rec.verifyOnBoot();
    expect(ledger.size()).toBe(1);
    expect(report.cleanCount).toBe(1);
  });
});
