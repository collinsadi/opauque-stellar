/**
 * Binding for the privacy-pool contract: deposit, withdraw (with a v3 proof),
 * and admin root publishing. Deposits and withdrawals are permissionless; the
 * signer's account is the tx source.
 */
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import type { ContractInvoker, SimulationReport } from "../rpc/client";
import type { OpaqueSigner } from "../signer/index";

import { NotWiredError, RetentionGapError, SimulationError } from "../errors/index";

import { ContractCompatibilityError, NotWiredError, SimulationError } from "../errors/index";

import {
  addressToScVal,
  boolToScVal,
  bytesToScVal,
  i128ToScVal,
  u64ToScVal,
} from "../rpc/scval";
import { paginateContractEvents, type RetentionGap } from "../rpc/events";

/** Live on-chain pool configuration, as read by `get_config`. */
export interface PoolConfig {
  admin: string;
  groth16Verifier: string;
  nativeSac: string;
  scope: number;
  rootExpiryLedgers: number;
}

/** Pool custody counters, as read by `get_custody`. */
export interface PoolCustody {
  /** Lifetime total deposited, in the pool's native asset's smallest unit. */
  totalDeposited: bigint;
  /** Lifetime total withdrawn, in the pool's native asset's smallest unit. */
  totalWithdrawn: bigint;
  /** `totalDeposited - totalWithdrawn` — what the pool is still holding. */
  netHeld: bigint;
}

/** Commitment-tree capacity, as read by `get_tree_capacity_info`. */
export interface TreeCapacityInfo {
  maxCapacity: number;
  currentCount: number;
  depth: number;
  /** Ledger timestamp (unix seconds) of the last capacity update. */
  lastUpdated: number;
  /** `currentCount / maxCapacity` as a fraction (0 when there is no capacity). */
  utilization: number;
}

/** A pending or active withdrawal pause request, as read by `get_withdrawal_pause_request`. */
export interface WithdrawalPauseRequest {
  /** Ledger the admin requested the pause at; 0 when none is pending. */
  requestedAt: number;
  /** Ledger the pause actually takes effect at (after the timelock); 0 when none is pending. */
  activatesAt: number;
  /** True when a pause has been requested and is still in effect. */
  pending: boolean;
  /** Ledgers left until `activatesAt`; 0 once it has passed or with no request. */
  ledgersUntilActivation: number;
}

export interface PoolWithdrawInputs {
  proofA: Uint8Array;
  proofB: Uint8Array;
  proofC: Uint8Array;
  withdrawnValue: bigint;
  stateRoot: Uint8Array;
  aspRoot: Uint8Array;
  nullifierHash: Uint8Array;
  newCommitment: Uint8Array;
  recipient: string;
  fee: bigint;
  relayer: string;
}

/** The reconstructed pool state, plus whether the read that produced it was whole. */
export interface PoolStateReconstruction {
  stateLeaves: bigint[];
  depositIndices: number[];
  /**
   * False when the leaves may be missing history: the event page cap stopped a
   * topic's scan with events left unread, or the RPC pruned part of the range
   * (see {@link retentionGap}). Either way the leaves cover only part of the
   * tree, so a proof built from them would be against a root the pool never
   * published. A default call raises instead of returning `false`; this is
   * reported only when `allowRetentionGap` or `onTruncation: "return"` asked for it.
   */
  complete: boolean;
  /** Per-topic cursors to resume a truncated read from. */
  continuation?: PoolStateContinuation;
  /** Ledgers the RPC pruned before the read could reach them, when any. */
  retentionGap?: RetentionGap;
}

/** Opaque `getEvents` cursors for the pool's Deposit/Withdraw topics. */
export interface PoolStateContinuation {
  deposit?: string;
  withdraw?: string;
}

/** Options for {@link PrivacyPool.reconstructState}. */
export interface ReconstructStateOptions {
  /**
   * First ledger to read (inclusive). Pass the pool's deployment ledger so the
   * read covers the pool's whole life. Without it the read starts at the oldest
   * retained ledger, and any pruned history is reported rather than skipped.
   */
  startLedger?: number;
  /** Event page cap per topic (default `EVENT_PAGE_LIMIT`). */
  maxPages?: number;
  /**
   * How to report a scan stopped by the page cap: `"throw"` (default) raises
   * `EventTruncationError`, `"return"` hands back the partial leaves with
   * `complete: false` and the cursors to continue from. Never silent either way.
   */
  onTruncation?: "throw" | "return";
  /**
   * Accept leaves built from pruned history (default false). Without it, a read
   * that needs ledgers the RPC no longer retains raises `RetentionGapError`. With
   * it, the partial leaves come back with `complete: false` and `retentionGap`.
   */
  allowRetentionGap?: boolean;
}

/** Simulation failure text the host produces when an entrypoint does not exist in the deployed wasm. */
const MISSING_ENTRYPOINT = /non-existent contract function|MissingValue|function.{0,20}not found|no such (contract )?function/i;

export class PrivacyPool {
  /** Optional entrypoints this deployment is known not to have (per instance, so per contract). */
  private readonly unsupported = new Set<string>();

  constructor(
    private readonly rpc: ContractInvoker,
    readonly contractId: string,
  ) {}

  /**
   * Run a read of an optional entrypoint (added after the first deployments).
   * A deployment without it yields a typed {@link ContractCompatibilityError}
   * naming this contract and the method; the result is remembered so later
   * calls skip the doomed simulation. Every other failure propagates.
   */
  private async optionalRead<T>(method: string, read: () => Promise<T>): Promise<T> {
    const unavailable = () =>
      new ContractCompatibilityError({ contract: this.contractId, method });
    if (this.unsupported.has(method)) throw unavailable();
    try {
      return await read();
    } catch (err) {
      const text =
        err instanceof SimulationError
          ? `${err.diagnostics ?? ""} ${err.message}`
          : err instanceof Error
            ? err.message
            : "";
      if (MISSING_ENTRYPOINT.test(text)) {
        this.unsupported.add(method);
        throw new ContractCompatibilityError({ contract: this.contractId, method, cause: err });
      }
      throw err;
    }
  }

  /**
   * Like {@link getTreeCapacityInfo} but resolves to `null` when the deployed
   * pool predates `get_tree_capacity_info`, so composite helpers can skip it.
   */
  async tryGetTreeCapacityInfo(source: string): Promise<TreeCapacityInfo | null> {
    try {
      return await this.getTreeCapacityInfo(source);
    } catch (err) {
      if (err instanceof ContractCompatibilityError) return null;
      throw err;
    }
  }

  /** Read the deployed contract interface version. */
  async version(source: string): Promise<number> {
    return Number(
      await this.rpc.readNative<number>({
        source,
        contractId: this.contractId,
        method: "version",
        args: [],
      }),
    );
  }

  /** Deposit `value` stroops under a precomputed commitment at `expectedIndex`. */
  async deposit(opts: {
    value: bigint;
    commitment: Uint8Array;
    expectedIndex: number;
    signer: OpaqueSigner;
  }): Promise<string> {
    const depositor = await opts.signer.publicKey();
    return this.rpc.invoke({
      source: depositor,
      contractId: this.contractId,
      method: "deposit",
      contractPackage: "privacy-pool",
      args: [
        addressToScVal(depositor),
        i128ToScVal(opts.value),
        bytesToScVal(opts.commitment),
        u64ToScVal(BigInt(opts.expectedIndex)),
      ],
      signer: opts.signer,
    });
  }

  private withdrawArgs(opts: PoolWithdrawInputs): xdr.ScVal[] {
    return [
      bytesToScVal(opts.proofA),
      bytesToScVal(opts.proofB),
      bytesToScVal(opts.proofC),
      i128ToScVal(opts.withdrawnValue),
      bytesToScVal(opts.stateRoot),
      bytesToScVal(opts.aspRoot),
      bytesToScVal(opts.nullifierHash),
      bytesToScVal(opts.newCommitment),
      addressToScVal(opts.recipient),
      i128ToScVal(opts.fee),
      addressToScVal(opts.relayer),
    ];
  }

  /** Withdraw to `recipient` (minus `fee` to `relayer`) with a v3 proof. */
  async withdraw(
    opts: PoolWithdrawInputs & { signer: OpaqueSigner },
  ): Promise<string> {
    const caller = await opts.signer.publicKey();
    return this.rpc.invoke({
      source: caller,
      contractId: this.contractId,
      method: "withdraw",
      contractPackage: "privacy-pool",
      args: this.withdrawArgs(opts),
      signer: opts.signer,
    });
  }

  /**
   * Dry-run a withdrawal: builds and simulates the same transaction `withdraw`
   * would submit, but never signs or sends it, so no nullifier is consumed.
   * Requires an invoker that implements `simulateInvoke`.
   */
  async simulateWithdraw(
    opts: PoolWithdrawInputs & { source: string },
  ): Promise<SimulationReport> {
    if (!this.rpc.simulateInvoke) {
      throw new NotWiredError(
        "Withdrawal dry run",
        "The configured invoker does not implement simulateInvoke.",
      );
    }
    return this.rpc.simulateInvoke({
      source: opts.source,
      contractId: this.contractId,
      method: "withdraw",
      args: this.withdrawArgs(opts),
    });
  }

  /** Publish a tree root (admin only). `kind` selects the state vs ASP root. */
  async updateRoot(opts: {
    kind: "state" | "asp";
    root: Uint8Array;
    datasetHash: Uint8Array;
    signer: OpaqueSigner;
  }): Promise<string> {
    const admin = await opts.signer.publicKey();
    return this.rpc.invoke({
      source: admin,
      contractId: this.contractId,
      method: opts.kind === "state" ? "update_state_root" : "update_asp_root",
      contractPackage: "privacy-pool",
      args: [
        addressToScVal(admin),
        bytesToScVal(opts.root),
        bytesToScVal(opts.datasetHash),
      ],
      signer: opts.signer,
    });
  }

  /** Read the pool's live on-chain configuration (`get_config`). */
  async getConfig(source: string): Promise<PoolConfig> {
    const raw = await this.rpc.readNative<Record<string, unknown>>({
      source,
      contractId: this.contractId,
      method: "get_config",
      args: [],
    });
    return {
      admin: String(raw.admin),
      groth16Verifier: String(raw.groth16_verifier),
      nativeSac: String(raw.native_sac),
      scope: Number(raw.scope),
      rootExpiryLedgers: Number(raw.root_expiry_ledgers),
    };
  }

  /**
   * Read the decimal precision of the pool's backing asset (its native SAC's
   * `decimals()`), by way of the live pool config rather than an assumed constant.
   */
  async getNativeAssetDecimals(source: string): Promise<number> {
    const config = await this.getConfig(source);
    const decimals = await this.rpc.readNative<number>({
      source,
      contractId: config.nativeSac,
      method: "decimals",
      args: [],
    });
    return Number(decimals);
  }

  /** Read the next deposit leaf index (the value `deposit` will assign). */
  async getDepositCount(source: string): Promise<number> {
    const count = await this.rpc.readNative<number | bigint>({
      source,
      contractId: this.contractId,
      method: "get_deposit_count",
      args: [],
    });
    return Number(count);
  }

  /**
   * Read whether a withdrawal nullifier has already been spent on-chain. Use
   * this to reconcile local note state after an ambiguous RPC failure (a
   * withdrawal whose submission was sent but whose confirmation was lost): a
   * `true` result means the withdrawal landed and the note must be treated as
   * spent; `false` means it is safe to retry.
   */
  async isNullifierSpent(opts: {
    source: string;
    nullifierHash: Uint8Array;
  }): Promise<boolean> {
    const spent = await this.rpc.readNative<boolean | undefined>({
      source: opts.source,
      contractId: this.contractId,
      method: "is_spent",
      args: [bytesToScVal(opts.nullifierHash)],
    });
    return Boolean(spent);
  }

  /**
   * Read the latest published state (or ASP) root, or null when none is.
   *
   * "None yet" is a normal state for a young pool, and the contract reports it
   * by reverting (`UnknownStateRoot` / `UnknownAspRoot`) rather than returning
   * an empty value — so that one revert is translated to `null`. Every other
   * failure still propagates: a coverage check that swallowed real errors would
   * be worse than no check at all.
   */
  async getLatestRoot(opts: {
    source: string;
    kind: "state" | "asp";
  }): Promise<Uint8Array | null> {
    try {
      const root = await this.rpc.readNative<Uint8Array | undefined>({
        source: opts.source,
        contractId: this.contractId,
        method: "get_latest_root",
        args: [boolToScVal(opts.kind === "state")],
      });
      return root ? Uint8Array.from(root) : null;
    } catch (err) {
      const diagnostics =
        err instanceof SimulationError ? (err.diagnostics ?? "") : "";
      const unpublished = opts.kind === "state" ? /UnknownStateRoot/i : /UnknownAspRoot/i;
      if (unpublished.test(diagnostics)) return null;
      throw err;
    }
  }

  /**
   * Whether the contract knows `root` as a published state root
   * (`is_known_state_root`). A root the pool has never published cannot be
   * proven against, so this is the cheap pre-check before spending proving time
   * on a withdrawal built from a root an ASP published late, reorged, or never.
   *
   * Note this tests that the root is *known*, not that it is still fresh —
   * freshness (`root_expiry_ledgers`) is enforced inside `withdraw`.
   */
  async isKnownStateRoot(opts: { source: string; root: Uint8Array }): Promise<boolean> {
    return this.isKnownRoot("is_known_state_root", opts.source, opts.root);
  }

  /** Whether the contract knows `root` as a published ASP root (`is_known_asp_root`). */
  async isKnownAspRoot(opts: { source: string; root: Uint8Array }): Promise<boolean> {
    return this.isKnownRoot("is_known_asp_root", opts.source, opts.root);
  }

  private async isKnownRoot(
    method: "is_known_state_root" | "is_known_asp_root",
    source: string,
    root: Uint8Array,
  ): Promise<boolean> {
    const known = await this.rpc.readNative<boolean | undefined>({
      source,
      contractId: this.contractId,
      method,
      args: [bytesToScVal(root)],
    });
    return Boolean(known);
  }

  /** Whether new deposits are currently paused (`is_deposits_paused`). */
  async isDepositsPaused(source: string): Promise<boolean> {
    return Boolean(
      await this.rpc.readNative<boolean | undefined>({
        source,
        contractId: this.contractId,
        method: "is_deposits_paused",
        args: [],
      }),
    );
  }

  /**
   * Whether withdrawals are currently paused (`is_withdrawals_paused`). The
   * pause is derived from the timelock, not latched: it flips exactly
   * {@link WithdrawalPauseRequest.activatesAt} ledgers after the request, with
   * no extra transaction in between.
   */
  async isWithdrawalsPaused(source: string): Promise<boolean> {
    return Boolean(
      await this.rpc.readNative<boolean | undefined>({
        source,
        contractId: this.contractId,
        method: "is_withdrawals_paused",
        args: [],
      }),
    );
  }

  /**
   * The pending withdrawal-pause request (`get_withdrawal_pause_request`) with
   * the countdown to when withdrawals actually stop, or `pending: false` when
   * none was requested. Lets a UI warn about an approaching pause instead of
   * discovering it as a failed withdrawal.
   */
  async getWithdrawalPauseRequest(
    source: string,
  ): Promise<WithdrawalPauseRequest> {
    const raw = await this.optionalRead("get_withdrawal_pause_request", () =>
      this.rpc.readNative<[number, number]>({
        source,
        contractId: this.contractId,
        method: "get_withdrawal_pause_request",
        args: [],
      }),
    );
    const requestedAt = Number(raw?.[0] ?? 0);
    const activatesAt = Number(raw?.[1] ?? 0);
    const pending = requestedAt > 0;
    const now = await this.rpc.getLatestLedger();
    return {
      requestedAt,
      activatesAt,
      pending,
      ledgersUntilActivation: pending ? Math.max(0, activatesAt - now) : 0,
    };
  }

  /**
   * The current minimum withdrawal amount, in the pool's native asset's
   * smallest unit (`get_withdrawal_minimum`). Read it before proving: a
   * withdrawal below it reverts with `WithdrawalBelowMinimum` after the proof
   * has been generated and the fee paid.
   */
  async getWithdrawalMinimum(source: string): Promise<bigint> {
    const minimum = await this.optionalRead("get_withdrawal_minimum", () =>
      this.rpc.readNative<bigint | number | string>({
        source,
        contractId: this.contractId,
        method: "get_withdrawal_minimum",
        args: [],
      }),
    );
    return BigInt(minimum ?? 0);
  }

  /** Lifetime custody counters, in the pool's native asset's smallest unit. */
  async getCustody(source: string): Promise<PoolCustody> {
    const raw = await this.optionalRead("get_custody", () =>
      this.rpc.readNative<[bigint, bigint]>({
        source,
        contractId: this.contractId,
        method: "get_custody",
        args: [],
      }),
    );
    const totalDeposited = BigInt(raw?.[0] ?? 0);
    const totalWithdrawn = BigInt(raw?.[1] ?? 0);
    return { totalDeposited, totalWithdrawn, netHeld: totalDeposited - totalWithdrawn };
  }

  /**
   * Commitment-tree capacity (`get_tree_capacity_info`). `currentCount` is
   * bumped by deposits only, so it is a lower bound on the leaves in the tree;
   * treat `utilization` as the headroom indicator, not an exact occupancy.
   */
  async getTreeCapacityInfo(source: string): Promise<TreeCapacityInfo> {
    const raw = await this.optionalRead("get_tree_capacity_info", () =>
      this.rpc.readNative<Record<string, unknown>>({
        source,
        contractId: this.contractId,
        method: "get_tree_capacity_info",
        args: [],
      }),
    );
    const maxCapacity = Number(raw.max_capacity);
    const currentCount = Number(raw.current_count);
    return {
      maxCapacity,
      currentCount,
      depth: Number(raw.depth),
      lastUpdated: Number(raw.last_updated),
      utilization: maxCapacity > 0 ? currentCount / maxCapacity : 0,
    };
  }

  /**
   * Reconstruct the pool's commitment leaves from on-chain events. Returns the
   * commitment at each state-tree index (`stateLeaves`, deposits + withdrawal
   * remainders) and the state index of each deposit in event order
   * (`depositIndices`, == ASP-tree order). Feed these into the withdrawal prover.
   *
   * The event read is bounded by a page cap (~20k events per topic). Reaching it
   * means leaves are missing and any proof built from them would be against a
   * root the pool never published, so the default is to raise
   * `EventTruncationError`; pass `onTruncation: "return"` to get the
   * partial leaves with `complete: false` and the cursors to continue from.
   *
   * History the RPC has pruned is handled the same way. A read that starts before
   * the retention window raises `RetentionGapError` unless `allowRetentionGap` is
   * set. Leaves built across a pruned range are never returned as complete.
   *
   * Without `startLedger` the read starts at the oldest retained ledger. It does
   * not use a fixed lookback, which would silently drop older deposits from the
   * tree. Pass the pool's deployment ledger to read only the pool's own history.
   */
  async reconstructState(opts?: ReconstructStateOptions): Promise<PoolStateReconstruction> {
    const depositTopic = xdr.ScVal.scvSymbol("Deposit").toXDR("base64");
    const withdrawTopic = xdr.ScVal.scvSymbol("Withdraw").toXDR("base64");
    const byIndex = new Map<number, bigint>();
    const depositIndices: number[] = [];
    const continuation: PoolStateContinuation = {};
    // Ledger 1 is never retained on a pruning RPC, so the first page is clamped and
    // the clamp is reported as a retention gap instead of being hidden by a lookback.
    const startLedger = opts?.startLedger && opts.startLedger > 0 ? opts.startLedger : 1;
    let complete = true;
    let retentionGap: RetentionGap | undefined;

    for (const [topic, kind, isDeposit] of [
      [depositTopic, "Deposit", true],
      [withdrawTopic, "Withdraw", false],
    ] as const) {
      const filters = [
        { type: "contract" as const, contractIds: [this.contractId], topics: [[topic, "*"]] },
      ];
      // getEvents pages ~10k ledgers at a time and returns empty pages before
      // the ones holding events; follow the cursor until it stops advancing.
      for await (const page of paginateContractEvents({
        invoker: this.rpc,
        filters,
        scope: `privacy-pool:${kind}`,
        startLedger,
        maxPages: opts?.maxPages,
        throwOnTruncation: opts?.onTruncation !== "return",
      })) {
        if (page.retentionGap) {
          if (!opts?.allowRetentionGap) {
            throw new RetentionGapError({
              scope: `privacy-pool:${kind}`,
              ...page.retentionGap,
            });
          }
          const gap = page.retentionGap;
          retentionGap = retentionGap
            ? {
                fromLedger: Math.min(retentionGap.fromLedger, gap.fromLedger),
                toLedger: Math.max(retentionGap.toLedger, gap.toLedger),
              }
            : { ...gap };
        }
        for (const ev of page.events) {
          const data = scValToNative(ev.value) as unknown[];
          if (isDeposit) {
            const commitment = BigInt(
              "0x" + Buffer.from(data[0] as Uint8Array).toString("hex"),
            );
            const index = Number(data[1]);
            byIndex.set(index, commitment);
            depositIndices.push(index);
          } else {
            const newCommitment = BigInt(
              "0x" + Buffer.from(data[1] as Uint8Array).toString("hex"),
            );
            byIndex.set(Number(data[2]), newCommitment);
          }
        }
        if (page.truncated) {
          complete = false;
          if (isDeposit) continuation.deposit = page.continuationCursor;
          else continuation.withdraw = page.continuationCursor;
        }
      }
    }

    const max = byIndex.size === 0 ? -1 : Math.max(...byIndex.keys());
    const stateLeaves: bigint[] = [];
    for (let i = 0; i <= max; i++) stateLeaves.push(byIndex.get(i) ?? 0n);
    depositIndices.sort((a, b) => a - b);
    const result: PoolStateReconstruction = {
      stateLeaves,
      depositIndices,
      complete: complete && retentionGap === undefined,
    };
    if (!complete) result.continuation = continuation;
    if (retentionGap) result.retentionGap = retentionGap;
    return result;
  }
}
