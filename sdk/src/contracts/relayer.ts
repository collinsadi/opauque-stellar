/**
 * Binding for the relayer-registry contract: the full operator lifecycle
 * (register, stake, unstake, withdraw stake) plus the wallet-side job
 * lifecycle (create a blind withdrawal job with an escrowed fee, cancel it, or
 * slash an accepted-but-unsubmitted job), the job/relayer reads behind those
 * decisions, and the on-chain slashing surface.
 *
 * Every method maps 1:1 to a `RelayerRegistry` contract method, so read one
 * source: `contracts/relayer-registry/src/lib.rs`.
 */
import type { ContractInvoker } from "../rpc/client";
import type { OpaqueSigner } from "../signer/index";
import { xdr } from "@stellar/stellar-sdk";
import {
  addressToScVal,
  bytesToScVal,
  i128ToScVal,
  stringToScVal,
  u32ToScVal,
  u64ToScVal,
} from "../rpc/scval";

/**
 * A `#[contracttype] struct` crosses the wire as an ScVal::Map keyed by
 * **Symbol** field names, with entries sorted by key (the host rejects an
 * unsorted map or string keys). Build it explicitly so field values keep their
 * real types (an address stays an address, not a string).
 */
export function structToScVal(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        (key) =>
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: fields[key] as xdr.ScVal }),
      ),
  );
}

/**
 * A `#[contracttype]` enum declared with explicit integer discriminants
 * (`DoubleSign = 0`) crosses the wire as a plain u32 — not a Vec[Symbol], which
 * is the encoding for enums with unit variants *without* discriminants.
 * Mirrors `SlashableOffense` in `contracts/relayer-registry/src/slashing.rs`.
 */
export const SLASHABLE_OFFENSE_VALUES = {
  DoubleSign: 0,
  InvalidSignature: 1,
} as const satisfies Record<SlashableOffense, number>;

export function slashableOffenseToScVal(offense: SlashableOffense): xdr.ScVal {
  const value = SLASHABLE_OFFENSE_VALUES[offense];
  if (value === undefined) throw new Error(`Unknown SlashableOffense: ${String(offense)}`);
  return u32ToScVal(value);
}

/**
 * A contract `Option<T>` decodes as a one-element vec (`Some`) or void
 * (`None`), so the native value is `[value]` or `null` — unwrap it rather than
 * handing callers a boxed array.
 */
function optionFromNative<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) return (raw[0] as T) ?? null;
  return raw as T;
}

/** Live registry configuration, as read by `get_config`. */
export interface RegistryConfig {
  admin: string;
  /** The SAC contract every stake and fee moves through. */
  nativeSac: string;
  /** The pool whose withdrawals this registry relays. */
  privacyPool: string;
  /** Stake floor `register` enforces, in the SAC's smallest unit. */
  minimumStake: bigint;
  unstakeCooldownLedgers: number;
  /** Upper bound on how far ahead a job's deadline may be set. */
  maxDeadlineLedgers: number;
}

/** A registered relayer's record, as read by `get_relayer`. */
export interface RelayerRecord {
  operator: string;
  /** x25519 pubkey a creator encrypts the withdrawal payload to. */
  x25519Pubkey: Uint8Array;
  endpoint: string;
  /** Stake available to bond to a job. */
  freeStake: bigint;
  /** Stake currently bonded to accepted jobs. */
  bondedStake: bigint;
  /** Stake requested out, still in cooldown. */
  pendingUnstake: bigint;
  /** Ledger `pendingUnstake` becomes withdrawable at; 0 with nothing pending. */
  unstakeUnlockLedger: number;
}

/** A job's record, as read by `get_job`. */
export interface JobRecord {
  creator: string;
  /** Hash the accepted relayer's submission must reproduce exactly. */
  payloadHash: Uint8Array;
  fee: bigint;
  deadlineLedger: number;
  /** The relayer that accepted the job, or null while it is still open. */
  acceptedRelayer: string | null;
  /** One of {@link JOB_STATUS}: open | accepted | submitted | slashed | canceled. */
  status: number;
  createdLedger: number;
  submittedLedger: number;
}

/** `get_unbonding_status`: what is pending, when it unlocks, and whether it is. */
export interface UnbondingStatus {
  pendingUnstake: bigint;
  unstakeUnlockLedger: number;
  /** True once the cooldown has elapsed and `withdraw_stake` will succeed. */
  isUnlockable: boolean;
}

/** An offense a slash can be reported for — both are verifiable on-chain. */
export type SlashableOffense = "DoubleSign" | "InvalidSignature";

/** Cryptographic evidence for a `report_slash` call. Anyone may report. */
export interface SlashingProof {
  relayer: string;
  offense: SlashableOffense;
  /** Offense-specific evidence: two distinct signatures, or a failing one. */
  evidence: Uint8Array;
  timestamp: bigint;
  /** Receives the slashed amount. */
  reporter: string;
}

/** A relayer's slashing history, as read by `get_slashing_record` (null when clean). */
export interface RelayerSlashRecord {
  relayer: string;
  totalSlashed: bigint;
  slashCount: number;
  lastSlashTime: bigint;
}

/** The status codes a job record can hold, as read back from the contract. */
export interface JobStatus {
  open: number;
  accepted: number;
  submitted: number;
  slashed: number;
  canceled: number;
}

/**
 * Local mirror of those codes, for the common case where the registry has not
 * changed. Compare a job's `status` against `jobStatuses()` (read from the
 * contract) rather than these, when correctness across upgrades matters.
 */
export const JOB_STATUS = {
  OPEN: 0,
  ACCEPTED: 1,
  SUBMITTED: 2,
  SLASHED: 3,
  CANCELED: 4,
} as const;

/**
 * Job statuses read from the contract rather than hardcoded: a relayer
 * comparing a gateway's claim against chain state cannot afford a stale
 * constant.
 */
export async function readJobStatuses(
  rpc: ContractInvoker,
  contractId: string,
  source: string,
): Promise<JobStatus> {
  const read = async (method: string) =>
    Number(
      (await rpc.readNative<number>({ source, contractId, method, args: [] })) ?? -1,
    );
  const [open, accepted, submitted, slashed, canceled] = await Promise.all([
    read("status_open"),
    read("status_accepted"),
    read("status_submitted"),
    read("status_slashed"),
    read("status_canceled"),
  ]);
  return { open, accepted, submitted, slashed, canceled };
}

export class RelayerRegistry {
  constructor(
    private readonly rpc: ContractInvoker,
    readonly contractId: string,
  ) {}

  private invoke(
    method: string,
    source: string,
    args: xdr.ScVal[],
    signer: OpaqueSigner,
  ): Promise<string> {
    return this.rpc.invoke({
      source,
      contractId: this.contractId,
      method,
      contractPackage: "relayer-registry",
      args,
      signer,
    });
  }

  private read<T>(method: string, source: string, args: xdr.ScVal[] = []) {
    return this.rpc.readNative<T>({ source, contractId: this.contractId, method, args });
  }

  /** Read the deployed contract interface version. */
  async version(source: string): Promise<number> {
    return Number(await this.read<number>("version", source));
  }

  // --- reads -----------------------------------------------------------------

  /** Live registry configuration. */
  async getConfig(source: string): Promise<RegistryConfig> {
    const raw = await this.read<Record<string, unknown>>("get_config", source);
    return {
      admin: raw.admin as string,
      nativeSac: raw.native_sac as string,
      privacyPool: raw.privacy_pool as string,
      minimumStake: BigInt(raw.minimum_stake as bigint | number),
      unstakeCooldownLedgers: Number(raw.unstake_cooldown_ledgers),
      maxDeadlineLedgers: Number(raw.max_deadline_ledgers),
    };
  }

  /** A registered relayer's record; reverts `RelayerMissing` when unregistered. */
  async getRelayer(opts: { source: string; operator: string }): Promise<RelayerRecord> {
    const raw = await this.read<Record<string, unknown>>("get_relayer", opts.source, [
      addressToScVal(opts.operator),
    ]);
    return {
      operator: raw.operator as string,
      x25519Pubkey: Uint8Array.from(raw.x25519_pubkey as Uint8Array),
      endpoint: raw.endpoint as string,
      freeStake: BigInt(raw.free_stake as bigint | number),
      bondedStake: BigInt(raw.bonded_stake as bigint | number),
      pendingUnstake: BigInt(raw.pending_unstake as bigint | number),
      unstakeUnlockLedger: Number(raw.unstake_unlock_ledger),
    };
  }

  /** A relayer's unbonding status: amount pending, unlock ledger, and readiness. */
  async getUnbondingStatus(opts: {
    source: string;
    operator: string;
  }): Promise<UnbondingStatus> {
    const raw = await this.read<[bigint, number, boolean]>(
      "get_unbonding_status",
      opts.source,
      [addressToScVal(opts.operator)],
    );
    return {
      pendingUnstake: BigInt(raw[0]),
      unstakeUnlockLedger: Number(raw[1]),
      isUnlockable: Boolean(raw[2]),
    };
  }

  /** A job's record; reverts `JobMissing` for an unknown id. */
  async getJob(opts: { source: string; jobId: Uint8Array }): Promise<JobRecord> {
    const raw = await this.read<Record<string, unknown>>("get_job", opts.source, [
      bytesToScVal(opts.jobId),
    ]);
    return {
      creator: raw.creator as string,
      payloadHash: Uint8Array.from(raw.payload_hash as Uint8Array),
      fee: BigInt(raw.fee as bigint | number),
      deadlineLedger: Number(raw.deadline_ledger),
      acceptedRelayer: optionFromNative<string>(raw.accepted_relayer),
      status: Number(raw.status),
      createdLedger: Number(raw.created_ledger),
      submittedLedger: Number(raw.submitted_ledger),
    };
  }

  /**
   * The payload hash a submission must reproduce: hash it off-chain before
   * creating the job, then have the relayer hash its own submission and
   * compare — this is the same function the registry checks `submit` against,
   * so a mismatch here is a mismatch on-chain.
   */
  async hashPoolWithdrawPayload(opts: {
    source: string;
    proofA: Uint8Array;
    proofB: Uint8Array;
    proofC: Uint8Array;
    withdrawnValue: bigint;
    stateRoot: Uint8Array;
    aspRoot: Uint8Array;
    nullifierHash: Uint8Array;
    newCommitment: Uint8Array;
    recipient: string;
    poolFee: bigint;
    poolRelayer: string;
  }): Promise<Uint8Array> {
    return Uint8Array.from(
      await this.read<Uint8Array>("hash_pool_withdraw_payload", opts.source, [
        bytesToScVal(opts.proofA),
        bytesToScVal(opts.proofB),
        bytesToScVal(opts.proofC),
        i128ToScVal(opts.withdrawnValue),
        bytesToScVal(opts.stateRoot),
        bytesToScVal(opts.aspRoot),
        bytesToScVal(opts.nullifierHash),
        bytesToScVal(opts.newCommitment),
        addressToScVal(opts.recipient),
        i128ToScVal(opts.poolFee),
        addressToScVal(opts.poolRelayer),
      ]),
    );
  }

  /** The registry's status codes for a job, read from the contract. */
  async jobStatuses(source: string): Promise<JobStatus> {
    return readJobStatuses(this.rpc, this.contractId, source);
  }

  /** A relayer's slashing record, or null when they have never been slashed. */
  async getSlashingRecord(opts: {
    source: string;
    relayer: string;
  }): Promise<RelayerSlashRecord | null> {
    const record = optionFromNative<Record<string, unknown>>(
      await this.read<unknown>("get_slashing_record", opts.source, [
        addressToScVal(opts.relayer),
      ]),
    );
    if (!record) return null;
    return {
      relayer: record.relayer as string,
      totalSlashed: BigInt(record.total_slashed as bigint | number),
      slashCount: Number(record.slash_count),
      lastSlashTime: BigInt(record.last_slash_time as bigint | number),
    };
  }

  /**
   * Basis points of the relayer's original stake slashed so far
   * (`total_slashed * 10000 / original_stake`) — 0 for a relayer whose original
   * stake is unknown or whose stake was not slashed.
   */
  async getSlashingPercentage(opts: {
    source: string;
    relayer: string;
  }): Promise<number> {
    return Number(
      await this.read<number | bigint>("get_slashing_percentage", opts.source, [
        addressToScVal(opts.relayer),
      ]),
    );
  }

  // --- operator lifecycle ----------------------------------------------------

  /**
   * Register as a relayer, escrowing the initial `stake` (which must be at
   * least `config.minimum_stake`, or the call reverts `StakeTooLow`). The
   * operator authorizes this, so the signer is the operator account.
   */
  async register(opts: {
    x25519Pubkey: Uint8Array;
    endpoint: string;
    stake: bigint;
    signer: OpaqueSigner;
    operator?: string;
  }): Promise<string> {
    const operator = opts.operator ?? (await opts.signer.publicKey());
    return this.invoke(
      "register",
      operator,
      [
        addressToScVal(operator),
        bytesToScVal(opts.x25519Pubkey),
        stringToScVal(opts.endpoint),
        i128ToScVal(opts.stake),
      ],
      opts.signer,
    );
  }

  /** Add `amount` to the operator's free stake. */
  async addStake(opts: { amount: bigint; signer: OpaqueSigner }): Promise<string> {
    const operator = await opts.signer.publicKey();
    return this.invoke(
      "add_stake",
      operator,
      [addressToScVal(operator), i128ToScVal(opts.amount)],
      opts.signer,
    );
  }

  /**
   * Queue `amount` out of free stake. The operator must first move the whole
   * amount out of `bonded_stake` (via the pool's `unbond`/unlock path) — the
   * registry rejects a request that would leave bonded stake unfunded. The
   * queue then unlocks after `config.unstake_cooldown_ledgers`.
   */
  async requestUnstake(opts: { amount: bigint; signer: OpaqueSigner }): Promise<string> {
    const operator = await opts.signer.publicKey();
    return this.invoke(
      "request_unstake",
      operator,
      [addressToScVal(operator), i128ToScVal(opts.amount)],
      opts.signer,
    );
  }

  /**
   * Withdraw the pending unstake once its cooldown has elapsed. Reverts
   * `UnstakeLocked` before `unstake_unlock_ledger` — read
   * {@link getUnbondingStatus} rather than sleeping for a fixed time.
   */
  async withdrawStake(opts: { signer: OpaqueSigner }): Promise<string> {
    const operator = await opts.signer.publicKey();
    return this.invoke("withdraw_stake", operator, [addressToScVal(operator)], opts.signer);
  }

  /** Accept an open job, bonding the escrowed fee against your own stake. */
  async acceptJob(opts: { jobId: Uint8Array; signer: OpaqueSigner }): Promise<string> {
    const operator = await opts.signer.publicKey();
    return this.invoke(
      "accept_job",
      operator,
      [addressToScVal(operator), bytesToScVal(opts.jobId)],
      opts.signer,
    );
  }

  /**
   * Submit an accepted job: relays the pool withdrawal and collects the fee.
   * The registry re-hashes the payload and rejects a mismatch
   * (`PayloadHashMismatch`), then forwards the withdrawal to the pool — so the
   * submission is the only place the pool's withdrawal executes.
   */
  async submitPoolWithdraw(opts: {
    jobId: Uint8Array;
    proofA: Uint8Array;
    proofB: Uint8Array;
    proofC: Uint8Array;
    withdrawnValue: bigint;
    stateRoot: Uint8Array;
    aspRoot: Uint8Array;
    nullifierHash: Uint8Array;
    newCommitment: Uint8Array;
    recipient: string;
    poolFee: bigint;
    poolRelayer: string;
    signer: OpaqueSigner;
  }): Promise<string> {
    const operator = await opts.signer.publicKey();
    return this.invoke(
      "submit_pool_withdraw",
      operator,
      [
        addressToScVal(operator),
        bytesToScVal(opts.jobId),
        bytesToScVal(opts.proofA),
        bytesToScVal(opts.proofB),
        bytesToScVal(opts.proofC),
        i128ToScVal(opts.withdrawnValue),
        bytesToScVal(opts.stateRoot),
        bytesToScVal(opts.aspRoot),
        bytesToScVal(opts.nullifierHash),
        bytesToScVal(opts.newCommitment),
        addressToScVal(opts.recipient),
        i128ToScVal(opts.poolFee),
        addressToScVal(opts.poolRelayer),
      ],
      opts.signer,
    );
  }

  // --- wallet-side job lifecycle ---------------------------------------------

  /** Create a blind job with an escrowed fee and a payload hash + deadline. */
  async createJob(opts: {
    jobId: Uint8Array;
    payloadHash: Uint8Array;
    deadlineLedger: number;
    fee: bigint;
    signer: OpaqueSigner;
  }): Promise<string> {
    const creator = await opts.signer.publicKey();
    return this.invoke(
      "create_job",
      creator,
      [
        addressToScVal(creator),
        bytesToScVal(opts.jobId),
        bytesToScVal(opts.payloadHash),
        u32ToScVal(opts.deadlineLedger),
        i128ToScVal(opts.fee),
      ],
      opts.signer,
    );
  }

  /** Cancel a never-accepted job after its deadline; refunds the escrow fee. */
  async cancelJob(opts: { jobId: Uint8Array; signer: OpaqueSigner }): Promise<string> {
    return this.jobAction("cancel_job", opts);
  }

  /** Slash an accepted-but-unsubmitted job after its deadline. */
  async slashJob(opts: { jobId: Uint8Array; signer: OpaqueSigner }): Promise<string> {
    return this.jobAction("slash_job", opts);
  }

  private async jobAction(
    method: "cancel_job" | "slash_job",
    opts: { jobId: Uint8Array; signer: OpaqueSigner },
  ): Promise<string> {
    const creator = await opts.signer.publicKey();
    return this.invoke(
      method,
      creator,
      [addressToScVal(creator), bytesToScVal(opts.jobId)],
      opts.signer,
    );
  }

  // --- admin -----------------------------------------------------------------

  /**
   * Initialize the registry (one-shot; reverts `AlreadyInitialized` afterwards).
   * `minimumStake` / `unstakeCooldownLedgers` / `maxDeadlineLedgers` fall back
   * to the contract's defaults when non-positive.
   */
  async initialize(opts: {
    admin: string;
    nativeSac: string;
    privacyPool: string;
    minimumStake: bigint;
    unstakeCooldownLedgers: number;
    maxDeadlineLedgers: number;
    signer: OpaqueSigner;
  }): Promise<string> {
    return this.invoke(
      "initialize",
      opts.admin,
      [
        addressToScVal(opts.admin),
        addressToScVal(opts.nativeSac),
        addressToScVal(opts.privacyPool),
        i128ToScVal(opts.minimumStake),
        u32ToScVal(opts.unstakeCooldownLedgers),
        u32ToScVal(opts.maxDeadlineLedgers),
      ],
      opts.signer,
    );
  }

  /** Update the stake floor, unstake cooldown, and job deadline cap. Admin only. */
  async setConfig(opts: {
    minimumStake: bigint;
    unstakeCooldownLedgers: number;
    maxDeadlineLedgers: number;
    signer: OpaqueSigner;
  }): Promise<string> {
    const admin = await opts.signer.publicKey();
    return this.invoke(
      "set_config",
      admin,
      [
        addressToScVal(admin),
        i128ToScVal(opts.minimumStake),
        u32ToScVal(opts.unstakeCooldownLedgers),
        u32ToScVal(opts.maxDeadlineLedgers),
      ],
      opts.signer,
    );
  }

  /**
   * Move admin authority to `newAdmin` — the migration path from a single-key
   * admin to a multisig contract's address, with no redeployment. Once this
   * succeeds the old admin can no longer authorize admin-gated operations.
   */
  async transferAdmin(opts: {
    newAdmin: string;
    signer: OpaqueSigner;
  }): Promise<string> {
    const admin = await opts.signer.publicKey();
    return this.invoke(
      "transfer_admin",
      admin,
      [addressToScVal(admin), addressToScVal(opts.newAdmin)],
      opts.signer,
    );
  }

  // --- slashing --------------------------------------------------------------

  /**
   * Report an offense and slash the relayer's stake (bonded first, then free),
   * paying `slashAmount` to the reporter. Callable by anyone — no signer
   * authorization of the *relayer* is involved, which is the point.
   */
  async reportSlash(opts: {
    proof: SlashingProof;
    slashAmount: bigint;
    signer: OpaqueSigner;
  }): Promise<string> {
    const reporter = await opts.signer.publicKey();
    const { relayer, offense, evidence, timestamp } = opts.proof;
    return this.invoke(
      "report_slash",
      reporter,
      [
        // SlashingProof is one struct argument, not a spread of arguments.
        structToScVal({
          relayer: addressToScVal(relayer),
          offense: slashableOffenseToScVal(offense),
          evidence: bytesToScVal(evidence),
          timestamp: u64ToScVal(timestamp),
          reporter: addressToScVal(opts.proof.reporter),
        }),
        i128ToScVal(opts.slashAmount),
      ],
      opts.signer,
    );
  }
}
