/**
 * Privacy pool. Deposit (derive a note's commitment and persist the note),
 * sweep a stealth account straight into a deposit, withdraw with a
 * precomputed proof, and read pool state (deposit count, roots, pause flags,
 * custody, capacity). Withdrawal proof *generation* needs the proving layer
 * (snarkjs + circuit artifacts) and is surfaced as a not-wired capability in
 * this build: bring a precomputed proof bundle to withdraw().
 */
import {
  bigIntToBytes32,
  deriveDeposit,
  deriveStealthStellarKeypairFromStealthPrivKey,
  newNoteSecrets,
  parseXlmToStroops,
  toHex32,
  type PoolNote,
} from "../crypto/index";
import { NotWiredError } from "../errors/index";
import { PoolMerkleTree, provePoolWithdraw, type PoolWithdrawProof } from "../prove/pool";
import { getPoseidon, hashFields } from "../crypto/notes";
import type { SimulationReport } from "../rpc/client";
import type { OpaqueSigner } from "../signer/index";
import { keypairSigner } from "../signer/index";
import { validateDepositAmount } from "./pool-validation";
import { resolveReadSource } from "./read-source";
import type { OpaqueClientContext } from "./context";
import type {
  PoolCustody,
  ReconstructStateOptions,
  TreeCapacityInfo,
  WithdrawalPauseRequest,
} from "../contracts/pool";

/** A withdrawal proof bundle (everything except the public recipient/fee/relayer). */
export type WithdrawProofBundle = PoolWithdrawProof;

/** Why a deposit is not (yet) provable against the published roots. */
export type DepositCoverageReason =
  | "no-state-root"
  | "no-asp-root"
  | "unknown-state-root"
  | "unknown-asp-root"
  | "note-not-in-state"
  | "excluded-from-asp"
  | "state-root-expired"
  | "asp-root-expired"
  | "withdrawals-paused";

/**
 * Whether the published roots can carry a withdrawal for a deposit, composed
 * from the pool's own views — see {@link PoolService.isDepositCovered}.
 */
export interface DepositCoverage {
  /** True when the published state + ASP roots can prove a withdrawal for a deposit. */
  covered: boolean;
  /** The latest published state root, or null when none is published. */
  stateRoot: Uint8Array | null;
  /** The latest published ASP root, or null when none is published. */
  aspRoot: Uint8Array | null;
  /** The pool knows `stateRoot` as a published state root. */
  stateRootKnown: boolean;
  /** The pool knows `aspRoot` as a published ASP root. */
  aspRootKnown: boolean;
  /** Empty when `covered`; otherwise why the deposit cannot be proven yet. */
  reasons: DepositCoverageReason[];
  /**
   * Commitment-tree capacity, informational only (it never blocks a withdrawal).
   * `null` when the deployed pool predates `get_tree_capacity_info` (#1070).
   */
  capacity: TreeCapacityInfo | null;
  /** Whether deposits are currently accepted (a paused pool accepts no new deposits). */
  depositsPaused: boolean;
  /** Whether withdrawals are currently paused. */
  withdrawalsPaused: boolean;
}

export class PoolService {
  constructor(private readonly ctx: OpaqueClientContext) {}

  private async source(explicit?: string): Promise<string> {
    return resolveReadSource(this.ctx, explicit);
  }

  /**
   * Deposit `amountXlm` into the pool. Reads the next leaf index, derives the
   * commitment from fresh (or provided) secrets, submits, and persists the note.
   */
  async deposit(opts: {
    amountXlm: string;
    secrets?: { nullifier: string; secret: string };
    createdAt?: number;
    /** Skip the pre-flight amount validation (default false). */
    skipValidation?: boolean;
  }): Promise<{ note: PoolNote; txHash: string }> {
    const signer = this.ctx.requireSigner();
    const value = parseXlmToStroops(opts.amountXlm);
    return this.depositWithSigner({
      signer,
      value,
      amountXlmForValidation: opts.amountXlm,
      secrets: opts.secrets,
      createdAt: opts.createdAt,
      skipValidation: opts.skipValidation,
    });
  }

  /**
   * Fund a pool deposit straight from a discovered stealth account, without
   * the connected wallet ever signing — the stealth account (derived from
   * `stealthPrivKey`) is the depositor, tx source, and fee payer. This is the
   * README's flagship "sweep into the pool" flow: the resulting note is
   * indistinguishable from any other pool deposit, and shares this class's
   * exact deposit/note-persistence path via {@link depositWithSigner}.
   *
   * `amountStroops` should be the stealth account's spendable balance minus a
   * fee buffer (compute it however the caller sources balances — e.g. via
   * Horizon) — this method does not itself query or reserve for fees.
   */
  async sweep(opts: {
    stealthPrivKey: Uint8Array;
    amountStroops: bigint;
    secrets?: { nullifier: string; secret: string };
    createdAt?: number;
    /** Skip the pre-flight amount validation (default false). */
    skipValidation?: boolean;
  }): Promise<{ note: PoolNote; txHash: string }> {
    const keypair = deriveStealthStellarKeypairFromStealthPrivKey(opts.stealthPrivKey);
    return this.depositWithSigner({
      signer: keypairSigner(keypair),
      value: opts.amountStroops,
      // No user-typed decimal string exists for a sweep; stringifying the
      // integer stroop amount still exercises the non-positive /
      // exceeds-field-modulus checks (an integer has 0 fractional digits, so
      // the precision check never fires against it).
      amountXlmForValidation: opts.amountStroops.toString(),
      secrets: opts.secrets,
      createdAt: opts.createdAt,
      skipValidation: opts.skipValidation,
    });
  }

  /** Shared deposit path: derive the commitment, submit, and persist the note. */
  private async depositWithSigner(opts: {
    signer: OpaqueSigner;
    value: bigint;
    amountXlmForValidation: string;
    secrets?: { nullifier: string; secret: string };
    createdAt?: number;
    skipValidation?: boolean;
  }): Promise<{ note: PoolNote; txHash: string }> {
    const source = await opts.signer.publicKey();
    const scope = this.ctx.config.pool.scope;
    const value = opts.value;

    if (!opts.skipValidation) {
      const decimals = await this.ctx.contracts.privacyPool.getNativeAssetDecimals(source);
      validateDepositAmount({ amountXlm: opts.amountXlmForValidation, valueStroops: value, decimals });
    }

    const expectedIndex = await this.ctx.contracts.privacyPool.getDepositCount(source);
    const secrets = opts.secrets ?? newNoteSecrets();
    const { commitment } = await deriveDeposit({
      value,
      scope,
      leafIndex: expectedIndex,
      nullifier: BigInt(secrets.nullifier),
      secret: BigInt(secrets.secret),
    });

    const txHash = await this.ctx.contracts.privacyPool.deposit({
      value,
      commitment: bigIntToBytes32(commitment),
      expectedIndex,
      signer: opts.signer,
    });

    const note: PoolNote = {
      cluster: this.ctx.config.network,
      poolId: this.ctx.config.contracts.privacyPool,
      value: value.toString(),
      scope,
      leafIndex: expectedIndex,
      nullifier: secrets.nullifier,
      secret: secrets.secret,
      commitment: toHex32(commitment),
      spent: false,
      createdAt: opts.createdAt ?? 0,
    };
    await this.ctx.notes.add(note);
    return { note, txHash };
  }

  /**
   * Withdraw using a precomputed proof bundle. Marks the note spent **only after**
   * the on-chain withdrawal is confirmed successful.
   *
   * Fault safety: {@link PrivacyPool.withdraw} resolves only once the transaction
   * has been polled to a `SUCCESS` result, so any fault before that point (a
   * network error before submission, an RPC error/timeout during submission, or a
   * lost confirmation after submission) rejects here and the note is left
   * **unspent** — a note is never burned for a withdrawal that did not land.
   *
   * The remaining ambiguous window is a submission that actually landed on-chain
   * but whose confirmation was lost client-side: the note stays locally unspent,
   * yet a naive retry cannot double-pay because the pool rejects the reused
   * nullifier ({@link ContractError} `NullifierUsed`). Use
   * {@link reconcileWithdrawal} (or {@link isNullifierSpent}) to reconcile local
   * note state with on-chain truth after such a failure.
   */
  async withdraw(opts: {
    proof: WithdrawProofBundle;
    recipient: string;
    fee?: bigint;
    relayer?: string;
    /** Note commitment to mark spent once the withdrawal lands. */
    noteCommitment?: string;
  }): Promise<string> {
    const signer = this.ctx.requireSigner();
    const txHash = await this.ctx.contracts.privacyPool.withdraw({
      ...opts.proof,
      recipient: opts.recipient,
      fee: opts.fee ?? 0n,
      relayer: opts.relayer ?? opts.recipient,
      signer,
    });
    if (opts.noteCommitment) await this.ctx.notes.markSpent(opts.noteCommitment);
    return txHash;
  }

  /**
   * Whether a withdrawal's nullifier is already spent on-chain. Cheap read used
   * to determine, after an ambiguous submission failure, whether the withdrawal
   * actually landed (`true`) or is safe to retry (`false`).
   */
  async isNullifierSpent(opts: {
    nullifierHash: Uint8Array;
    source?: string;
  }): Promise<boolean> {
    return this.ctx.contracts.privacyPool.isNullifierSpent({
      source: await this.source(opts.source),
      nullifierHash: opts.nullifierHash,
    });
  }

  /**
   * Reconcile a note's local spent-state with on-chain nullifier state after an
   * ambiguous withdrawal failure. Marks the note spent iff its nullifier is spent
   * on-chain; otherwise leaves it untouched (safe to retry). Retry-safe and
   * idempotent — it never burns a note whose withdrawal did not land, and never
   * triggers a payout. Returns whether the note is (now) considered spent.
   */
  async reconcileWithdrawal(opts: {
    proof: WithdrawProofBundle;
    noteCommitment: string;
    source?: string;
  }): Promise<{ spent: boolean }> {
    const spent = await this.isNullifierSpent({
      nullifierHash: opts.proof.nullifierHash,
      source: opts.source,
    });
    if (spent) await this.ctx.notes.markSpent(opts.noteCommitment);
    return { spent };
  }

  /** Read the next deposit leaf index. */
  async getDepositCount(opts?: { source?: string }): Promise<number> {
    return this.ctx.contracts.privacyPool.getDepositCount(await this.source(opts?.source));
  }

  /** Read the latest published state and ASP roots (or null when unpublished). */
  async getRoots(opts?: {
    source?: string;
  }): Promise<{ state: Uint8Array | null; asp: Uint8Array | null }> {
    const source = await this.source(opts?.source);
    const [state, asp] = await Promise.all([
      this.ctx.contracts.privacyPool.getLatestRoot({ source, kind: "state" }),
      this.ctx.contracts.privacyPool.getLatestRoot({ source, kind: "asp" }),
    ]);
    return { state, asp };
  }

  /** Whether the pool knows `root` as a published state root. */
  async isKnownStateRoot(opts: { root: Uint8Array; source?: string }): Promise<boolean> {
    return this.ctx.contracts.privacyPool.isKnownStateRoot({
      root: opts.root,
      source: await this.source(opts.source),
    });
  }

  /** Whether the pool knows `root` as a published ASP root. */
  async isKnownAspRoot(opts: { root: Uint8Array; source?: string }): Promise<boolean> {
    return this.ctx.contracts.privacyPool.isKnownAspRoot({
      root: opts.root,
      source: await this.source(opts.source),
    });
  }

  /** Whether new deposits are currently paused. */
  async isDepositsPaused(opts?: { source?: string }): Promise<boolean> {
    return this.ctx.contracts.privacyPool.isDepositsPaused(await this.source(opts?.source));
  }

  /** Whether withdrawals are currently paused (pause timelock elapsed). */
  async isWithdrawalsPaused(opts?: { source?: string }): Promise<boolean> {
    return this.ctx.contracts.privacyPool.isWithdrawalsPaused(await this.source(opts?.source));
  }

  /**
   * The pending withdrawal-pause request and the countdown to when it takes
   * effect, so a UI can warn before withdrawals stop.
   */
  async getWithdrawalPauseRequest(opts?: {
    source?: string;
  }): Promise<WithdrawalPauseRequest> {
    return this.ctx.contracts.privacyPool.getWithdrawalPauseRequest(
      await this.source(opts?.source),
    );
  }

  /**
   * The current minimum withdrawal amount, in the pool's native asset's
   * smallest unit. Check it against a note's value *before* proving: too small
   * a withdrawal reverts with `WithdrawalBelowMinimum` after the proof is built.
   */
  async getWithdrawalMinimum(opts?: { source?: string }): Promise<bigint> {
    return this.ctx.contracts.privacyPool.getWithdrawalMinimum(await this.source(opts?.source));
  }

  /** Lifetime custody counters: deposited, withdrawn, and what is still held. */
  async getCustody(opts?: { source?: string }): Promise<PoolCustody> {
    return this.ctx.contracts.privacyPool.getCustody(await this.source(opts?.source));
  }

  /** Commitment-tree capacity, including the current utilization fraction. */
  async getTreeCapacityInfo(opts?: { source?: string }): Promise<TreeCapacityInfo> {
    return this.ctx.contracts.privacyPool.getTreeCapacityInfo(await this.source(opts?.source));
  }

  /**
   * Can a withdrawal be proven *and accepted* right now? Pass the `note` to
   * check that specific deposit: its commitment is in the state tree, its label
   * is in the ASP set, both derived roots are known to the pool, and (when the
   * publish ledgers are supplied) neither root has expired. The reasons mirror
   * what actually makes `withdraw()` revert; tree capacity is not one of them
   * (it only limits new deposits) and is reported separately.
   *
   * Without a `note` this is the coarse pool-level check against the latest
   * published roots (or the `stateRoot`/`aspRoot` you pass).
   *
   * Root expiry: the pool exposes no view of when a root was published, so
   * freshness is only judged when you supply `rootLedgers` (the ledger of the
   * root's publish event). Otherwise it is not assessed and never claimed stale.
   *
   * Optional entrypoints missing from an older deployment are skipped rather
   * than failing the check (#1070). `reasons` is empty exactly when `covered`.
   */
  async isDepositCovered(opts?: {
    note?: PoolNote;
    /** Leaves/indices to skip the on-chain reconstruction (note mode). */
    stateLeaves?: bigint[];
    depositIndices?: number[];
    reconstruct?: ReconstructStateOptions;
    /** Ledgers at which the state / ASP roots were published, to judge expiry. */
    rootLedgers?: { state?: number; asp?: number };
    stateRoot?: Uint8Array;
    aspRoot?: Uint8Array;
    source?: string;
  }): Promise<DepositCoverage> {
    const source = await this.source(opts?.source);
    const pool = this.ctx.contracts.privacyPool;
    const [latestState, latestAsp, depositsPaused, withdrawalsPaused, capacity] =
      await Promise.all([
        pool.getLatestRoot({ source, kind: "state" }),
        pool.getLatestRoot({ source, kind: "asp" }),
        pool.isDepositsPaused(source),
        pool.isWithdrawalsPaused(source),
        // Optional entrypoint: absent on older deployments, so skip it there.
        pool.tryGetTreeCapacityInfo(source),
      ]);

    const reasons: DepositCoverageReason[] = [];
    let stateRoot = opts?.stateRoot ?? latestState;
    let aspRoot = opts?.aspRoot ?? latestAsp;

    const note = opts?.note;
    if (note) {
      let { stateLeaves, depositIndices } = opts;
      if (!stateLeaves || !depositIndices) {
        const state = await pool.reconstructState({
          startLedger: this.ctx.config.startLedger,
          ...opts.reconstruct,
        });
        stateLeaves = state.stateLeaves;
        depositIndices = state.depositIndices;
      }
      const poseidon = await getPoseidon();
      const inState =
        stateLeaves[note.leafIndex] != null &&
        toHex32(stateLeaves[note.leafIndex]!).toLowerCase() === note.commitment.toLowerCase();
      if (!inState) reasons.push("note-not-in-state");
      // The roots a withdrawal would actually be proven against.
      stateRoot = bigIntToBytes32(new PoolMerkleTree(poseidon, stateLeaves).root());
      const scope = BigInt(this.ctx.config.pool.scope);
      const aspLeaves = depositIndices.map((i) => hashFields(poseidon, [scope, BigInt(i)]));
      aspRoot = bigIntToBytes32(new PoolMerkleTree(poseidon, aspLeaves).root());
      if (!depositIndices.includes(note.leafIndex)) reasons.push("excluded-from-asp");
    }

    const [stateRootKnown, aspRootKnown] = await Promise.all([
      stateRoot ? pool.isKnownStateRoot({ source, root: stateRoot }) : Promise.resolve(false),
      aspRoot ? pool.isKnownAspRoot({ source, root: aspRoot }) : Promise.resolve(false),
    ]);

    if (!stateRoot) reasons.push("no-state-root");
    else if (!stateRootKnown) reasons.push("unknown-state-root");
    if (!aspRoot) reasons.push("no-asp-root");
    else if (!aspRootKnown) reasons.push("unknown-asp-root");

    // `withdraw` rejects a root once `now - publishedLedger > root_expiry_ledgers`.
    const ledgers = opts?.rootLedgers;
    if (ledgers && (ledgers.state != null || ledgers.asp != null)) {
      const [config, now] = await Promise.all([
        pool.getConfig(source),
        this.ctx.rpc.getLatestLedger(),
      ]);
      if (ledgers.state != null && stateRootKnown && now - ledgers.state > config.rootExpiryLedgers) {
        reasons.push("state-root-expired");
      }
      if (ledgers.asp != null && aspRootKnown && now - ledgers.asp > config.rootExpiryLedgers) {
        reasons.push("asp-root-expired");
      }
    }
    if (withdrawalsPaused) reasons.push("withdrawals-paused");

    return {
      covered: reasons.length === 0,
      stateRoot,
      aspRoot,
      stateRootKnown,
      aspRootKnown,
      reasons,
      capacity,
      depositsPaused,
      withdrawalsPaused,
    };
  }

  /**
   * Generate a full-withdrawal proof for a note. Requires an artifact resolver
   * (`new OpaqueClient({ artifacts })`). The pool leaves are reconstructed from
   * on-chain Deposit/Withdraw events automatically; pass `stateLeaves` +
   * `depositIndices` to skip the on-chain read (e.g. in tests).
   */
  async proveWithdraw(opts: {
    note: PoolNote;
    recipient: string;
    relayer?: string;
    fee?: bigint;
    scope?: number;
    stateLeaves?: bigint[];
    depositIndices?: number[];
    /** How to read the leaves from chain when they are not supplied. */
    reconstruct?: ReconstructStateOptions;
    /** Testing only: inject a stub in place of `snarkjs`. */
    snarkjs?: Parameters<typeof provePoolWithdraw>[0]["snarkjs"];
  }): Promise<PoolWithdrawProof> {
    if (!this.ctx.artifacts) {
      throw new NotWiredError(
        "Pool withdrawal proof generation",
        "Construct OpaqueClient with { artifacts } to enable proving, or pass a precomputed bundle to withdraw().",
      );
    }
    let { stateLeaves, depositIndices } = opts;
    if (!stateLeaves || !depositIndices) {
      const state = await this.ctx.contracts.privacyPool.reconstructState({
        startLedger: this.ctx.config.startLedger,
        ...opts.reconstruct,
      });
      stateLeaves = state.stateLeaves;
      depositIndices = state.depositIndices;
    }
    return provePoolWithdraw({
      note: opts.note,
      recipient: opts.recipient,
      relayer: opts.relayer ?? opts.recipient,
      fee: opts.fee ?? 0n,
      scope: opts.scope ?? this.ctx.config.pool.scope,
      stateLeaves,
      depositIndices,
      artifacts: this.ctx.artifacts,
      snarkjs: opts.snarkjs,
    });
  }

  /**
   * Dry-run a full withdrawal for a note: generates the proof and simulates the
   * withdrawal transaction, but never signs or submits it. Lets an integrator
   * validate a withdrawal end-to-end — including the real payout and resource
   * cost — without spending the note's nullifier.
   */
  async dryRunWithdraw(opts: {
    note: PoolNote;
    recipient: string;
    relayer?: string;
    fee?: bigint;
    scope?: number;
    stateLeaves?: bigint[];
    depositIndices?: number[];
    /** Account to simulate the transaction from (defaults to the connected signer). */
    source?: string;
    /** Testing only: inject a stub in place of `snarkjs`. */
    snarkjs?: Parameters<typeof provePoolWithdraw>[0]["snarkjs"];
  }): Promise<DryRunWithdrawResult> {
    const fee = opts.fee ?? 0n;
    const relayer = opts.relayer ?? opts.recipient;
    const source = await this.source(opts.source);

    const proof = await this.proveWithdraw({
      note: opts.note,
      recipient: opts.recipient,
      relayer,
      fee,
      scope: opts.scope,
      stateLeaves: opts.stateLeaves,
      depositIndices: opts.depositIndices,
      snarkjs: opts.snarkjs,
    });

    const simulation = await this.ctx.contracts.privacyPool.simulateWithdraw({
      ...proof,
      recipient: opts.recipient,
      fee,
      relayer,
      source,
    });

    return {
      proof,
      recipient: opts.recipient,
      relayer,
      fee,
      expectedPayout: proof.withdrawnValue - fee,
      simulation,
    };
  }
}

export interface DryRunWithdrawResult {
  proof: PoolWithdrawProof;
  recipient: string;
  relayer: string;
  fee: bigint;
  /** `proof.withdrawnValue - fee`: what `recipient` would actually receive. */
  expectedPayout: bigint;
  /** Simulated fee + resource usage; nothing here was submitted on-chain. */
  simulation: SimulationReport;
}
