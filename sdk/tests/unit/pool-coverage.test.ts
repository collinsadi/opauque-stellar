/**
 * Pool state reads and the pre-proving coverage check (issue #1005).
 *
 * A withdrawal proof is the expensive step, and it is wasted work if the pool
 * will not accept the result: no root published yet, a root the contract does
 * not know, a pause in effect, or a full tree. `isDepositCovered` composes the
 * pool's own views into one read and says which of those is blocking, so the
 * check can gate proving instead of guessing.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import {
  ContractCompatibilityError,
  OpaqueClient,
  SimulationError,
  deriveDeposit,
  type PoolNote,
  keypairSigner,
  type ContractInvoker,
  type ReadOptions,
} from "../../src/index";

const PK = Keypair.random().publicKey();
const ROOT = new Uint8Array(32).fill(9);

class StubInvoker implements ContractInvoker {
  reads: Record<string, unknown> = {};
  readMethods: string[] = [];

  async invoke(): Promise<string> {
    return "TXHASH";
  }
  async readNative<T>(opts: ReadOptions): Promise<T> {
    this.readMethods.push(opts.method);
    if (opts.method in this.reads) return this.reads[opts.method] as T;
    throw new Error(`unstubbed read: ${opts.method}`);
  }
  async simulateRead(): Promise<xdr.ScVal | undefined> {
    return undefined;
  }
  async getEvents(): Promise<never> {
    throw new Error("not used");
  }
  async getLatestLedger(): Promise<number> {
    return 5_000;
  }
}

let inv: StubInvoker;
let client: OpaqueClient;
beforeEach(() => {
  inv = new StubInvoker();
  client = new OpaqueClient({
    network: "testnet",
    signer: keypairSigner(Keypair.random()),
    invoker: inv,
  });
});

/** Stub the reads `isDepositCovered` composes. */
const stubCoverage = (overrides: Record<string, unknown> = {}) => {
  inv.reads = {
    get_latest_root: Buffer.from(ROOT),
    is_known_state_root: true,
    is_known_asp_root: true,
    is_deposits_paused: false,
    is_withdrawals_paused: false,
    get_tree_capacity_info: {
      max_capacity: 65536,
      current_count: 100,
      depth: 10,
      last_updated: 1_700_000_000,
    },
    ...overrides,
  };
};

describe("PoolService state reads", () => {
  it("getTreeCapacityInfo decodes the contract struct and derives utilization", async () => {
    inv.reads.get_tree_capacity_info = {
      max_capacity: 1_000,
      current_count: 250,
      depth: 8,
      last_updated: 1_700_000_000,
    };
    const capacity = await client.pool.getTreeCapacityInfo();
    expect(capacity.maxCapacity).toBe(1_000);
    expect(capacity.currentCount).toBe(250);
    expect(capacity.depth).toBe(8);
    expect(capacity.utilization).toBe(0.25);
  });

  it("getCustody reports deposited, withdrawn, and what is still held", async () => {
    inv.reads.get_custody = [1_000n, 400n];
    const custody = await client.pool.getCustody();
    expect(custody.totalDeposited).toBe(1_000n);
    expect(custody.totalWithdrawn).toBe(400n);
    expect(custody.netHeld).toBe(600n);
  });

  it("getWithdrawalPauseRequest turns the (requested, activates) pair into a countdown", async () => {
    inv.reads.get_withdrawal_pause_request = [4_000, 4_500];
    const pause = await client.pool.getWithdrawalPauseRequest();
    expect(pause.pending).toBe(true);
    expect(pause.requestedAt).toBe(4_000);
    expect(pause.activatesAt).toBe(4_500);
    // The stub reports ledger 5_000 as latest, so the pause is already active.
    expect(pause.ledgersUntilActivation).toBe(0);

    inv.reads.get_withdrawal_pause_request = [0, 0];
    const none = await client.pool.getWithdrawalPauseRequest();
    expect(none.pending).toBe(false);
    expect(none.ledgersUntilActivation).toBe(0);
  });

  it("getWithdrawalMinimum reads the threshold in the pool's smallest unit", async () => {
    inv.reads.get_withdrawal_minimum = 1_000_000n;
    expect(await client.pool.getWithdrawalMinimum()).toBe(1_000_000n);
  });

  it("reads accept an explicit source, so a read-only server needs no key", async () => {
    stubCoverage();
    const readonly = new OpaqueClient({ network: "testnet", invoker: inv });
    const coverage = await readonly.pool.isDepositCovered({ source: PK });
    expect(coverage.covered).toBe(true);
  });
});

describe("PoolService.isDepositCovered", () => {
  it("is covered when both roots are published, known, and the pool is open", async () => {
    stubCoverage();
    const coverage = await client.pool.isDepositCovered();
    expect(coverage.covered).toBe(true);
    expect(coverage.reasons).toEqual([]);
    expect(coverage.stateRootKnown).toBe(true);
    expect(coverage.aspRootKnown).toBe(true);
  });

  it("reports a root the contract does not know as unknown, not covered", async () => {
    stubCoverage({ is_known_state_root: false });
    const coverage = await client.pool.isDepositCovered();
    expect(coverage.covered).toBe(false);
    expect(coverage.reasons).toEqual(["unknown-state-root"]);
  });

  it("reports an unpublished root without asking the known-root questions", async () => {
    stubCoverage({ get_latest_root: undefined });
    const coverage = await client.pool.isDepositCovered();
    expect(coverage.covered).toBe(false);
    expect(coverage.reasons).toEqual(["no-state-root", "no-asp-root"]);
    expect(inv.readMethods).not.toContain("is_known_state_root");
  });

  it("reports a withdrawal pause as a reason to wait", async () => {
    stubCoverage({ is_withdrawals_paused: true });
    const coverage = await client.pool.isDepositCovered();
    expect(coverage.covered).toBe(false);
    expect(coverage.reasons).toEqual(["withdrawals-paused"]);
    expect(coverage.withdrawalsPaused).toBe(true);
  });

  it("does not treat a full tree as a withdrawal blocker", async () => {
    stubCoverage({
      get_tree_capacity_info: {
        max_capacity: 1_000,
        current_count: 1_000,
        depth: 8,
        last_updated: 1_700_000_000,
      },
    });
    const coverage = await client.pool.isDepositCovered();
    expect(coverage.covered).toBe(true);
    expect(coverage.reasons).toEqual([]);
    expect(coverage.capacity?.currentCount).toBe(1_000);
  });

  it("skips get_tree_capacity_info on an older deployment instead of failing (#1070)", async () => {
    stubCoverage();
    const base = inv.readNative.bind(inv);
    inv.readNative = (async (opts: ReadOptions) => {
      if (opts.method === "get_tree_capacity_info") {
        throw new SimulationError("Simulation failed", {
          diagnostics: "HostError: trying to invoke non-existent contract function",
        });
      }
      return base(opts);
    }) as typeof inv.readNative;
    const coverage = await client.pool.isDepositCovered();
    expect(coverage.covered).toBe(true);
    expect(coverage.capacity).toBeNull();
    await expect(client.pool.getTreeCapacityInfo()).rejects.toMatchObject({
      code: "CONTRACT_COMPATIBILITY",
      method: "get_tree_capacity_info",
    });
    await expect(client.pool.getTreeCapacityInfo()).rejects.toBeInstanceOf(
      ContractCompatibilityError,
    );
  });

  it("checks specific roots when the caller supplies them", async () => {
    stubCoverage({ is_known_asp_root: false });
    const coverage = await client.pool.isDepositCovered({
      stateRoot: ROOT,
      aspRoot: ROOT,
    });
    expect(coverage.covered).toBe(false);
    expect(coverage.reasons).toEqual(["unknown-asp-root"]);
  });

  it("carries the pause flags and capacity so a UI can explain the answer", async () => {
    stubCoverage({ is_deposits_paused: true });
    const coverage = await client.pool.isDepositCovered();
    expect(coverage.depositsPaused).toBe(true);
    expect(coverage.capacity?.currentCount).toBe(100);
    expect(coverage.capacity?.maxCapacity).toBe(65_536);
  });
});

describe("PoolService.isDepositCovered with a note (#1073)", () => {
  const stateLeaf = async (leafIndex: number) => {
    const d = await deriveDeposit({ value: 10_000_000n, scope: 1, leafIndex, nullifier: 11n, secret: 22n });
    const note = {
      value: "10000000",
      leafIndex,
      nullifier: "11",
      secret: "22",
      commitment: "0x" + d.commitment.toString(16).padStart(64, "0"),
    } as unknown as PoolNote;
    return { d, note };
  };

  it("is covered for an included note whose derived roots are known and fresh", async () => {
    const { d, note } = await stateLeaf(0);
    stubCoverage({ get_config: { root_expiry_ledgers: 1_000 } });
    const coverage = await client.pool.isDepositCovered({
      note,
      stateLeaves: [d.commitment],
      depositIndices: [0],
      rootLedgers: { state: 4_900, asp: 4_900 },
    });
    expect(coverage.reasons).toEqual([]);
    expect(coverage.covered).toBe(true);
  });

  it("flags a note the ASP set excludes", async () => {
    const { d, note } = await stateLeaf(0);
    stubCoverage();
    const coverage = await client.pool.isDepositCovered({
      note,
      stateLeaves: [d.commitment],
      depositIndices: [],
    });
    expect(coverage.covered).toBe(false);
    expect(coverage.reasons).toContain("excluded-from-asp");
  });

  it("flags a note missing from the state tree", async () => {
    const { note } = await stateLeaf(0);
    stubCoverage();
    const coverage = await client.pool.isDepositCovered({
      note,
      stateLeaves: [123n],
      depositIndices: [0],
    });
    expect(coverage.reasons).toContain("note-not-in-state");
  });

  it("flags stale roots using the pool's expiry window (age > expiry)", async () => {
    const { d, note } = await stateLeaf(0);
    // latest ledger is 5_000; state published 3_999 ago... 5_000-3_999=1_001 > 1_000
    stubCoverage({ get_config: { root_expiry_ledgers: 1_000 } });
    const coverage = await client.pool.isDepositCovered({
      note,
      stateLeaves: [d.commitment],
      depositIndices: [0],
      rootLedgers: { state: 3_999, asp: 4_000 },
    });
    expect(coverage.covered).toBe(false);
    expect(coverage.reasons).toEqual(["state-root-expired"]);
  });
});
