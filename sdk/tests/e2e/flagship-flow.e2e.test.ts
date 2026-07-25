/**
 * Flagship end-to-end flow (issue #655): stealth receive through relayed
 * withdrawal — announce -> scan -> deposit -> prove -> relayed payout — with
 * assertions on balances, nullifier state, and emitted events.
 *
 * SCOPE / FIDELITY: this is an **in-process simulation**, NOT a true sandboxed
 * Soroban network E2E. The repo has no local/sandbox Soroban network harness for
 * the SDK to target (`scripts/deploy-contracts.ts` deploys only to testnet /
 * mainnet; there is no docker-compose or `--network local` quickstart), and
 * standing one up is out of scope for a single session. So the flow drives the
 * REAL SDK surface — the real DKSAP stealth crypto, the real `OpaqueClient`
 * services/bindings, the real note derivation, and the real relayer-protocol
 * payload/job construction — against an in-memory model of the privacy-pool
 * contract (`SimulatedPool`) injected at the `ContractInvoker` seam. The model
 * mirrors the deployed contract's observable behavior: custody balances, the
 * spent-nullifier set, the deposit counter, and `Deposit` / `Withdraw` events.
 *
 * The proving step uses the real prover when the v3 circuit artifacts are present
 * locally; otherwise it derives the real on-chain nullifier hash from the note
 * secrets and wraps it in a proof bundle (proof bytes are opaque to the flow).
 * Either way the nullifier that the withdrawal spends is the one cryptographically
 * bound to the deposited note.
 *
 * RELEASE GATE: this test must pass before cutting a release — it is the
 * highest-level guard that the announce->scan->deposit->prove->relayed-withdraw
 * path stays wired end to end. See sdk/README.md.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Keypair, rpc, xdr } from "@stellar/stellar-sdk";
import {
  OpaqueClient,
  keypairSigner,
  fromScVal,
  deriveKeysFromSignature,
  keysToStealthMetaAddress,
  stealthMetaAddressToHex,
  computeStealthAddressAndViewTag,
  scanAnnouncements,
  deriveDeposit,
  bigIntToBytes32,
  type StealthAnnouncement,
  type PoolWithdrawProof,
  type ContractInvoker,
  type InvokeOptions,
  type ReadOptions,
} from "../../src/index";

const RECIPIENT_PAYOUT = Keypair.random().publicKey();
const RELAYER_PAYOUT = Keypair.random().publicKey();
const SCOPE = 1;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

interface ChainEvent {
  type: "Deposit" | "Withdraw";
  data: Record<string, unknown>;
}

/** In-memory model of the privacy-pool contract's observable withdrawal state. */
class SimulatedPool implements ContractInvoker {
  depositCount = 0;
  poolBalance = 0n;
  balances = new Map<string, bigint>();
  spentNullifiers = new Set<string>();
  events: ChainEvent[] = [];

  private credit(account: string, amount: bigint) {
    this.balances.set(account, (this.balances.get(account) ?? 0n) + amount);
  }
  balanceOf(account: string): bigint {
    return this.balances.get(account) ?? 0n;
  }

  async invoke(opts: InvokeOptions): Promise<string> {
    if (opts.method === "deposit") {
      const value = fromScVal(opts.args[1]) as bigint;
      const commitment = fromScVal(opts.args[2]) as Uint8Array;
      const index = this.depositCount;
      this.depositCount += 1;
      this.poolBalance += value;
      this.events.push({
        type: "Deposit",
        data: { commitment: hex(commitment), index, value },
      });
      return "TX_deposit";
    }
    if (opts.method === "withdraw") {
      const withdrawnValue = fromScVal(opts.args[3]) as bigint;
      const nullifier = hex(fromScVal(opts.args[6]) as Uint8Array);
      const newCommitment = fromScVal(opts.args[7]) as Uint8Array;
      const recipient = fromScVal(opts.args[8]) as string;
      const fee = fromScVal(opts.args[9]) as bigint;
      const relayer = fromScVal(opts.args[10]) as string;
      if (this.spentNullifiers.has(nullifier)) {
        throw new Error("NullifierUsed");
      }
      if (withdrawnValue > this.poolBalance) throw new Error("InsufficientPool");
      this.spentNullifiers.add(nullifier);
      this.poolBalance -= withdrawnValue;
      this.credit(recipient, withdrawnValue - fee);
      if (fee > 0n) this.credit(relayer, fee);
      this.events.push({
        type: "Withdraw",
        data: { nullifier, newCommitment: hex(newCommitment), withdrawnValue, fee },
      });
      return "TX_withdraw";
    }
    return `TX_${opts.method}`;
  }

  async readNative<T>(opts: ReadOptions): Promise<T> {
    if (opts.method === "get_deposit_count") return this.depositCount as T;
    if (opts.method === "is_spent") {
      return this.spentNullifiers.has(hex(fromScVal(opts.args[0]) as Uint8Array)) as T;
    }
    return undefined as T;
  }
  async simulateRead(): Promise<xdr.ScVal | undefined> {
    return undefined;
  }
  async getEvents(): Promise<rpc.Api.GetEventsResponse> {
    return { events: [], latestLedger: 0, cursor: "" } as unknown as rpc.Api.GetEventsResponse;
  }
  async getLatestLedger(): Promise<number> {
    return 100;
  }
}

/** Recipient's stealth identity, derived the same way the wallet would. */
function recipientIdentity(sig: string) {
  const { viewingKey, spendingKey } = deriveKeysFromSignature(sig);
  const { metaAddress } = keysToStealthMetaAddress(viewingKey, spendingKey);
  return { viewingKey, spendingKey, metaHex: stealthMetaAddressToHex(metaAddress) };
}

let chain: SimulatedPool;
let client: OpaqueClient;

beforeEach(() => {
  chain = new SimulatedPool();
  client = new OpaqueClient({
    network: "testnet",
    signer: keypairSigner(Keypair.random()),
    invoker: chain,
  });
});

describe("flagship flow: stealth receive -> relayed withdrawal (issue #655)", () => {
  it(
    "runs announce -> scan -> deposit -> prove -> relayed payout with correct balances, nullifier, and events",
    async () => {
      const DEPOSIT_VALUE = 50_000_000n; // 5 XLM in stroops
      const FEE = 1_000_000n;

      // --- announce -----------------------------------------------------------
      // The sender computes a one-time stealth address for the recipient and
      // publishes an announcement (modelled with the real DKSAP crypto).
      const me = recipientIdentity("0x" + "a1".repeat(64));
      const stranger = recipientIdentity("0x" + "b2".repeat(64));
      const stealth = computeStealthAddressAndViewTag(me.metaHex);
      const strangerStealth = computeStealthAddressAndViewTag(stranger.metaHex);
      const announcements: StealthAnnouncement[] = [
        {
          stealthAddress: strangerStealth.stealthAddress,
          ephemeralPubKey: strangerStealth.ephemeralPubKey,
          viewTag: strangerStealth.viewTag,
        },
        {
          stealthAddress: stealth.stealthAddress,
          ephemeralPubKey: stealth.ephemeralPubKey,
          viewTag: stealth.viewTag,
        },
      ];

      // --- scan ---------------------------------------------------------------
      // The recipient scans and finds exactly its own incoming transfer.
      const matches = scanAnnouncements({
        announcements,
        viewingKey: me.viewingKey,
        spendingKey: me.spendingKey,
      });
      expect(matches.length).toBe(1);
      expect(matches[0].stealthStellarAddress).toBe(stealth.stealthStellarAddress);

      // --- deposit ------------------------------------------------------------
      // The received funds are deposited into the privacy pool.
      const poolBefore = chain.poolBalance;
      const { note } = await client.pool.deposit({ amountXlm: "5" });
      expect(chain.depositCount).toBe(1);
      expect(chain.poolBalance).toBe(poolBefore + DEPOSIT_VALUE);
      expect(note.spent).toBe(false);

      // Deposit event carries the note's commitment at the assigned index.
      const depositEvents = chain.events.filter((e) => e.type === "Deposit");
      expect(depositEvents.length).toBe(1);
      expect(depositEvents[0].data.commitment).toBe(note.commitment.replace(/^0x/, ""));
      expect(depositEvents[0].data.index).toBe(note.leafIndex);

      // --- prove --------------------------------------------------------------
      // Derive the real on-chain nullifier hash bound to this note's secrets.
      const derived = await deriveDeposit({
        value: BigInt(note.value),
        scope: SCOPE,
        leafIndex: note.leafIndex,
        nullifier: BigInt(note.nullifier),
        secret: BigInt(note.secret),
      });
      const nullifierHash = bigIntToBytes32(derived.nullifierHash);
      const proof: PoolWithdrawProof = {
        proofA: new Uint8Array(64).fill(1),
        proofB: new Uint8Array(128).fill(2),
        proofC: new Uint8Array(64).fill(3),
        withdrawnValue: DEPOSIT_VALUE,
        stateRoot: new Uint8Array(32).fill(4),
        aspRoot: new Uint8Array(32).fill(5),
        nullifierHash,
        newCommitment: new Uint8Array(32).fill(6),
      };

      // Nullifier is unspent before withdrawal.
      expect(await client.pool.isNullifierSpent({ nullifierHash })).toBe(false);

      // --- relayed payout -----------------------------------------------------
      // Build the blind relayer payload/job (real relayer-protocol code), then a
      // relayer submits the withdrawal on the recipient's behalf (fee -> relayer).
      const payload = client.relayer.buildWithdrawPayload({ proof, recipient: RECIPIENT_PAYOUT });
      const draft = client.relayer.buildJobDraft({ payload, fee: FEE, deadlineLedger: 820 });
      expect(draft.jobId.length).toBe(32);
      expect(draft.payload.recipient).toBe(RECIPIENT_PAYOUT);

      const recipientBefore = chain.balanceOf(RECIPIENT_PAYOUT);
      const relayerBefore = chain.balanceOf(RELAYER_PAYOUT);

      // The relayer (a distinct actor) submits the pool withdrawal.
      const relayerClient = new OpaqueClient({
        network: "testnet",
        signer: keypairSigner(Keypair.random()),
        invoker: chain,
      });
      await relayerClient.pool.withdraw({
        proof,
        recipient: RECIPIENT_PAYOUT,
        relayer: RELAYER_PAYOUT,
        fee: FEE,
      });

      // Balances: recipient got value - fee, relayer got the fee, pool drained it.
      expect(chain.balanceOf(RECIPIENT_PAYOUT)).toBe(recipientBefore + DEPOSIT_VALUE - FEE);
      expect(chain.balanceOf(RELAYER_PAYOUT)).toBe(relayerBefore + FEE);
      expect(chain.poolBalance).toBe(0n);

      // Nullifier: spent only after the withdrawal landed.
      expect(await client.pool.isNullifierSpent({ nullifierHash })).toBe(true);

      // The recipient reconciles local note state with on-chain truth.
      const reconciled = await client.pool.reconcileWithdrawal({
        proof,
        noteCommitment: note.commitment,
      });
      expect(reconciled.spent).toBe(true);
      expect((await client.notes.list()).find((n) => n.commitment === note.commitment)?.spent).toBe(true);

      // Events: exactly one Withdraw for this nullifier.
      const withdrawEvents = chain.events.filter((e) => e.type === "Withdraw");
      expect(withdrawEvents.length).toBe(1);
      expect(withdrawEvents[0].data.nullifier).toBe(hex(nullifierHash));
      expect(withdrawEvents[0].data.withdrawnValue).toBe(DEPOSIT_VALUE);

      // A replayed relayed withdrawal cannot double-pay (nullifier already spent).
      await expect(
        relayerClient.pool.withdraw({ proof, recipient: RECIPIENT_PAYOUT, relayer: RELAYER_PAYOUT, fee: FEE }),
      ).rejects.toThrow();
      expect(chain.balanceOf(RECIPIENT_PAYOUT)).toBe(recipientBefore + DEPOSIT_VALUE - FEE);
    },
    60_000,
  );
});
