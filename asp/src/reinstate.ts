/**
 * Reinstate an appealed deposit into the next association set (#1086).
 *
 * The change is made under the pool's writer lock — the same lock every indexer tick
 * holds — so a running indexer can neither overwrite the reinstatement with stale
 * in-memory state nor observe a half-applied edit. Every reinstatement appends an
 * audit decision so the appeal outcome is visible next to the original rejection.
 */
import type { LockOptions } from "./lock.ts";
import { withPoolLock, type Store } from "./store.ts";
import type { PolicyDecisionRecord } from "./types.ts";

export const REINSTATEMENT_POLICY = "manual-reinstatement";

export interface ReinstateOptions {
  /** Who approved the appeal (operator name, ticket id, ...). Recorded in the audit reason. */
  operator?: string;
  /** Free-form justification recorded in the audit decision. */
  reason?: string;
  now?: () => string;
  lock?: LockOptions;
}

export interface ReinstateResult {
  ok: true;
  poolId: string;
  index: number;
  decision: PolicyDecisionRecord;
}

export async function reinstateDeposit(
  store: Store,
  poolId: string,
  index: number,
  opts: ReinstateOptions = {},
): Promise<ReinstateResult> {
  if (!Number.isInteger(index) || index < 0) throw new Error("--index must be a non-negative integer");
  const now = opts.now ?? (() => new Date().toISOString());
  return withPoolLock(store, poolId, () => {
    const state = store.load(poolId);
    if (!state) throw new Error(`no state found for pool ${poolId}`);
    if (!(state.rejectedIndices ?? []).includes(index)) throw new Error(`deposit ${index} is not a persisted rejection`);

    state.rejectedIndices = (state.rejectedIndices ?? []).filter((n) => n !== index);
    state.deferredIndices = (state.deferredIndices ?? []).filter((n) => n !== index);
    if (!state.approvedIndices.includes(index)) state.approvedIndices.push(index);
    state.approvedIndices.sort((a, b) => a - b);

    const parts = ["appeal approved; reinstated into next association set"];
    if (opts.operator) parts.push(`operator=${opts.operator}`);
    if (opts.reason) parts.push(`reason=${opts.reason}`);
    const decision: PolicyDecisionRecord = {
      depositIndex: index,
      policy: REINSTATEMENT_POLICY,
      verdict: "approve",
      reason: parts.join("; "),
      timestamp: now(),
    };
    (state.decisions ??= []).push(decision);

    store.save(state);
    return { ok: true as const, poolId, index, decision };
  }, opts.lock);
}
