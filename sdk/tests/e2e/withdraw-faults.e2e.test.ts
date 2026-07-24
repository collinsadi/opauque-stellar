/**
 * Fault-injection tests for RPC failures mid-withdrawal (issue #656).
 *
 * The window between proof generation and a confirmed on-chain withdrawal is the
 * most dangerous untested part of the pool flow: a fault here must never (a) burn
 * a note (mark it spent when the withdrawal did not land) nor (b) cause a double
 * payout (two payouts for one note across a retry).
 *
 * Faults are injected at the `ContractInvoker` seam — the boundary the withdrawal
 * flow depends on (`PoolService.withdraw` -> `PrivacyPool.withdraw` -> invoker).
 * That is exactly where the burned-note / double-payout invariant lives, because
 * `PoolService` only marks a note spent *after* the invoker resolves, and the
 * built-in `RpcClient.invoke` only resolves once a transaction has been polled to
 * a `SUCCESS` result. Injecting at this seam is deterministic and needs no
 * network, while faithfully modelling each real fault window:
 *   - before submission: a network error before the RPC call goes out
 *   - during submission: the RPC call throws / returns a malformed response
 *   - after submission: the server applied the tx but the client lost the
 *     confirmation (poll timed out) — the classic "did it actually land?" case
 *
 * The fake also models the pool contract's on-chain nullifier replay guard, so a
 * retry after an ambiguous failure exercises the real double-spend rejection.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Keypair, rpc, xdr } from "@stellar/stellar-sdk";
import {
  OpaqueClient,
  ContractError,
  RpcError,
  keypairSigner,
  fromScVal,
  type ContractInvoker,
  type InvokeOptions,
  type ReadOptions,
  type PoolWithdrawProof,
  type PoolNote,
} from "../../src/index";

type Fault = "none" | "before" | "during" | "after";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/**
 * In-memory model of the privacy-pool contract's withdrawal-relevant state: the
 * spent-nullifier set and a payout ledger. `fault` controls where a withdrawal
 * fails relative to the on-chain state change.
 */
class FakePoolChain implements ContractInvoker {
  spentNullifiers = new Set<string>();
  payouts: string[] = [];
  withdrawAttempts = 0;
  fault: Fault = "none";
  depositCount = 0;

  async invoke(opts: InvokeOptions): Promise<string> {
    if (opts.method !== "withdraw") return `TX_${opts.method}`;
    this.withdrawAttempts += 1;
    const nullifier = hex(fromScVal(opts.args[6]) as Uint8Array);

    // On-chain replay guard runs first: a reused nullifier reverts before any
    // payout, exactly like the deployed contract (PoolError::NullifierUsed = 4).
    if (this.spentNullifiers.has(nullifier)) {
      throw new ContractError({
        contract: "privacy-pool",
        contractCode: 4,
        errorName: "NullifierUsed",
      });
    }

    switch (this.fault) {
      case "before":
        // Network error before the transaction is submitted; nothing applied.
        throw new RpcError("getAccount failed: network unreachable");
      case "during":
        // RPC rejects / returns malformed data mid-submission; nothing applied.
        throw new RpcError("sendTransaction rejected: malformed response");
      case "after":
        // Server applied the tx (nullifier spent + payout) but the client lost
        // the confirmation: poll timed out. State changed; caller sees a reject.
        this.spentNullifiers.add(nullifier);
        this.payouts.push(nullifier);
        throw new RpcError("Transaction polling timed out for TXHASH");
      case "none":
      default:
        this.spentNullifiers.add(nullifier);
        this.payouts.push(nullifier);
        return "TXHASH";
    }
  }

  async readNative<T>(opts: ReadOptions): Promise<T> {
    if (opts.method === "is_spent") {
      const nullifier = hex(fromScVal(opts.args[0]) as Uint8Array);
      return this.spentNullifiers.has(nullifier) as T;
    }
    if (opts.method === "get_deposit_count") return this.depositCount as T;
    return undefined as T;
  }
  async simulateRead(): Promise<xdr.ScVal | undefined> {
    return undefined;
  }
  async getEvents(): Promise<rpc.Api.GetEventsResponse> {
    return { events: [], latestLedger: 0, cursor: "" } as unknown as rpc.Api.GetEventsResponse;
  }
  async getLatestLedger(): Promise<number> {
    return 0;
  }
}

const RECIPIENT = "GCMPINZMMQVQ7MWIJLB34F5JRAHLQQTWCP6XB5HEZR353PPPWRUWHLPU";

function proofWithNullifier(fill: number): PoolWithdrawProof {
  return {
    proofA: new Uint8Array(64).fill(1),
    proofB: new Uint8Array(128).fill(2),
    proofC: new Uint8Array(64).fill(3),
    withdrawnValue: 50_000_000n,
    stateRoot: new Uint8Array(32).fill(4),
    aspRoot: new Uint8Array(32).fill(5),
    nullifierHash: new Uint8Array(32).fill(fill),
    newCommitment: new Uint8Array(32).fill(6),
  };
}

const note = (commitment: string): PoolNote => ({
  cluster: "testnet",
  value: "50000000",
  scope: 1,
  leafIndex: 0,
  nullifier: "1",
  secret: "2",
  commitment,
  spent: false,
  createdAt: 0,
});

let chain: FakePoolChain;
let client: OpaqueClient;

beforeEach(() => {
  chain = new FakePoolChain();
  client = new OpaqueClient({
    network: "testnet",
    signer: keypairSigner(Keypair.random()),
    invoker: chain,
  });
});

async function noteSpent(commitment: string): Promise<boolean> {
  return (await client.notes.list()).find((n) => n.commitment === commitment)?.spent === true;
}

describe("withdrawal fault injection (issue #656)", () => {
  it("network error BEFORE submission: no burned note, no payout, safe retry", async () => {
    await client.notes.add(note("0xc1"));
    const proof = proofWithNullifier(0x11);
    chain.fault = "before";

    await expect(
      client.pool.withdraw({ proof, recipient: RECIPIENT, noteCommitment: "0xc1" }),
    ).rejects.toBeInstanceOf(RpcError);

    // Note is NOT burned and nothing was paid out.
    expect(await noteSpent("0xc1")).toBe(false);
    expect(chain.payouts.length).toBe(0);
    // Recovery guidance matches on-chain truth: nothing landed -> safe to retry.
    expect(await client.pool.isNullifierSpent({ nullifierHash: proof.nullifierHash })).toBe(false);

    // Retry succeeds exactly once.
    chain.fault = "none";
    const tx = await client.pool.withdraw({ proof, recipient: RECIPIENT, noteCommitment: "0xc1" });
    expect(tx).toBe("TXHASH");
    expect(await noteSpent("0xc1")).toBe(true);
    expect(chain.payouts).toEqual([hex(proof.nullifierHash)]);
  });

  it("RPC error DURING submission: no burned note, no payout, safe retry", async () => {
    await client.notes.add(note("0xc2"));
    const proof = proofWithNullifier(0x22);
    chain.fault = "during";

    await expect(
      client.pool.withdraw({ proof, recipient: RECIPIENT, noteCommitment: "0xc2" }),
    ).rejects.toBeInstanceOf(RpcError);

    expect(await noteSpent("0xc2")).toBe(false);
    expect(chain.payouts.length).toBe(0);
    expect(await client.pool.isNullifierSpent({ nullifierHash: proof.nullifierHash })).toBe(false);

    chain.fault = "none";
    await client.pool.withdraw({ proof, recipient: RECIPIENT, noteCommitment: "0xc2" });
    expect(await noteSpent("0xc2")).toBe(true);
    expect(chain.payouts.length).toBe(1);
  });

  it("lost confirmation AFTER submission: note not locally spent, but retry cannot double-pay", async () => {
    await client.notes.add(note("0xc3"));
    const proof = proofWithNullifier(0x33);
    chain.fault = "after";

    // The withdrawal actually landed on-chain, but the client sees a timeout.
    await expect(
      client.pool.withdraw({ proof, recipient: RECIPIENT, noteCommitment: "0xc3" }),
    ).rejects.toBeInstanceOf(RpcError);

    // Optimistically NOT marked spent (withdraw only marks on confirmed success).
    expect(await noteSpent("0xc3")).toBe(false);
    // But it did land: exactly one payout, nullifier spent on-chain.
    expect(chain.payouts.length).toBe(1);
    expect(await client.pool.isNullifierSpent({ nullifierHash: proof.nullifierHash })).toBe(true);

    // A naive retry does NOT double-pay: the contract rejects the reused nullifier.
    await expect(
      client.pool.withdraw({ proof, recipient: RECIPIENT, noteCommitment: "0xc3" }),
    ).rejects.toBeInstanceOf(ContractError);
    expect(chain.payouts.length).toBe(1); // still one payout
    expect(await noteSpent("0xc3")).toBe(false); // failed retry never marks spent
  });

  it("reconcileWithdrawal syncs local state to on-chain truth after each fault", async () => {
    const proof = proofWithNullifier(0x44);

    // Ambiguous-landed case: reconcile marks the note spent.
    await client.notes.add(note("0xc4"));
    chain.fault = "after";
    await expect(
      client.pool.withdraw({ proof, recipient: RECIPIENT, noteCommitment: "0xc4" }),
    ).rejects.toThrow();
    const reconciled = await client.pool.reconcileWithdrawal({ proof, noteCommitment: "0xc4" });
    expect(reconciled.spent).toBe(true);
    expect(await noteSpent("0xc4")).toBe(true);
    expect(chain.payouts.length).toBe(1); // reconcile never triggers a payout

    // Did-not-land case: reconcile leaves the note untouched (retry-safe).
    const proof2 = proofWithNullifier(0x55);
    await client.notes.add(note("0xc5"));
    chain.fault = "before";
    await expect(
      client.pool.withdraw({ proof: proof2, recipient: RECIPIENT, noteCommitment: "0xc5" }),
    ).rejects.toThrow();
    const reconciled2 = await client.pool.reconcileWithdrawal({ proof: proof2, noteCommitment: "0xc5" });
    expect(reconciled2.spent).toBe(false);
    expect(await noteSpent("0xc5")).toBe(false);
  });

  it("no fault window produces a double payout across the full retry lifecycle", async () => {
    await client.notes.add(note("0xc6"));
    const proof = proofWithNullifier(0x66);

    // before -> during -> after -> reconcile -> retry
    for (const fault of ["before", "during", "after"] as const) {
      chain.fault = fault;
      await expect(
        client.pool.withdraw({ proof, recipient: RECIPIENT, noteCommitment: "0xc6" }),
      ).rejects.toThrow();
    }
    await client.pool.reconcileWithdrawal({ proof, noteCommitment: "0xc6" });
    chain.fault = "none";
    // Note already spent on-chain (the "after" attempt landed) -> retry reverts.
    await expect(
      client.pool.withdraw({ proof, recipient: RECIPIENT, noteCommitment: "0xc6" }),
    ).rejects.toBeInstanceOf(ContractError);

    expect(chain.payouts.length).toBe(1);
    expect(await noteSpent("0xc6")).toBe(true);
  });
});
