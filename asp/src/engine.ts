/**
 * The pool tick: read finalized deposits → screen via the policy → maintain the ordered
 * approved set → reconcile the local ASP root against the on-chain root → (re)publish the
 * manifest and post `update_asp_root` only when they differ. When the chain adapter
 * supports it, the same tick also rebuilds the public pool state tree from Deposit +
 * Withdraw events and posts `update_state_root` on mismatch.
 *
 * Reconcile-not-append makes it idempotent and self-healing: the root is always recomputed
 * from the durable `approvedIndices`, so a crash mid-publish is resolved on the next tick
 * when the on-chain/local mismatch is re-detected.
 */
import { AssociationSet } from "./set.ts";
import { MerkleTree, getPoseidon, toHex32 } from "./merkle.ts";
import { computeDatasetHash, writeManifest, type ManifestSigner } from "./publish.ts";
import { PublicationMonitor } from "./monitor.ts";
import { ReorgGuard } from "./reorg-guard.ts";
import type { Store } from "./store.ts";
import type { ChainAdapter, Deposit, Policy, PoolState, PolicyDecisionRecord } from "./types.ts";
import { PolicyEngine } from "./policy-engine.ts";

export interface TickConfig {
  poolId: string;
  scope: number;
  adapter: ChainAdapter;
  store: Store;
  policy: Policy;
  /** If set, the manifest JSON is written under this directory. */
  dataDir?: string;
  /**
   * Ed25519 key that signs every published manifest (#1081). Required whenever
   * `dataDir` is set; a Stellar `Keypair` works directly.
   */
  manifestSigner?: ManifestSigner;
  /**
   * Confirmations to wait before treating a deposit as final. A deposit in ledger L
   * has `latest - L + 1` confirmations; deposits below this depth are left for a
   * later tick (neither screened nor advancing the cursor). 0 or 1 = process at once.
   */
  confirmations?: number;
  /** Clock injection for deterministic tests. */
  now?: () => string;
  /** Optional publication monitor — when set, the tick records publications and checks for staleness. */
  publicationMonitor?: PublicationMonitor;
  /** Optional reorg guard — when set, the tick validates ledger continuity before publishing. */
  reorgGuard?: ReorgGuard;
}

export interface TickResult {
  poolId: string;
  approvedCount: number;
  newlyApproved: number;
  rejectedCount: number;
  newlyRejected: number;
  deferredCount: number;
  localRoot: string;
  onChainRoot: string | null;
  published: boolean;
  stateLeafCount?: number;
  stateRoot?: string;
  onChainStateRoot?: string | null;
  statePublished?: boolean;
  /** True when the reorg guard halted publication due to a continuity break. */
  haltedForReorg?: boolean;
  /** Publication staleness alert, if one fired. */
  staleAlert?: { root: string; ageMs: number; thresholdMs: number } | null;
}

function initState(poolId: string, scope: number): PoolState {
  return { poolId, scope, approvedIndices: [], rejectedIndices: [], deferredIndices: [], decisions: [], lastIndex: -1, lastLedger: 0 };
}

/**
 * Drop deposits that have not yet reached `confirmations` depth. Deposit ledgers are
 * monotonic in index, so only a tail is ever dropped and the cursor stays consistent.
 */
export async function confirmedDeposits(
  adapter: ChainAdapter,
  deposits: Deposit[],
  confirmations: number,
): Promise<Deposit[]> {
  if (confirmations <= 1 || deposits.length === 0) return deposits;
  const maxFinalLedger = (await adapter.latestLedger()) - confirmations + 1;
  return deposits.filter((d) => d.ledger <= maxFinalLedger);
}

export async function runPoolTick(cfg: TickConfig): Promise<TickResult> {
  if (cfg.dataDir && !cfg.manifestSigner) {
    throw new Error("ASP manifest publishing requires manifestSigner (set ASP_MANIFEST_SECRET or ASP_SECRET)");
  }
  const now = cfg.now ?? (() => new Date().toISOString());
  const state = cfg.store.load(cfg.poolId) ?? initState(cfg.poolId, cfg.scope);
  state.rejectedIndices ??= [];
  state.deferredIndices ??= [];
  state.decisions ??= [];

  // 1. Read finalized deposits and screen any index without a terminal decision.
  const readAfterIndex = state.deferredIndices.length > 0 ? -1 : state.lastIndex;
  const deposits = await confirmedDeposits(
    cfg.adapter,
    await cfg.adapter.readDeposits(readAfterIndex, state.lastLedger),
    cfg.confirmations ?? 0,
  );
  let newlyApproved = 0;
  let newlyRejected = 0;
  const approved = new Set(state.approvedIndices);
  const rejected = new Set(state.rejectedIndices);
  const nextDeferred = new Set<number>();
  for (const dep of deposits) {
    if (approved.has(dep.index) || rejected.has(dep.index)) continue;
    const evaluated = cfg.policy instanceof PolicyEngine
      ? await cfg.policy.evaluate(dep)
      : await (async () => {
          const screened = await cfg.policy.screen(dep);
          return { verdict: screened, decisions: [{ policy: cfg.policy.name, deposit: dep, verdict: screened, reason: cfg.policy.reason?.(dep) ?? `policy returned ${screened}`, timestamp: now() }] };
        })();
    const verdict = evaluated.verdict;
    for (const decision of evaluated.decisions) {
      const record: PolicyDecisionRecord = { depositIndex: dep.index, policy: decision.policy, verdict: decision.verdict, reason: decision.reason, timestamp: decision.timestamp };
      state.decisions.push(record);
    }
    if (verdict === "approve") {
      state.approvedIndices.push(dep.index);
      approved.add(dep.index);
      newlyApproved++;
    } else if (verdict === "reject") {
      state.rejectedIndices.push(dep.index);
      rejected.add(dep.index);
      newlyRejected++;
    } else {
      nextDeferred.add(dep.index);
    }
    if (verdict !== "defer") state.lastIndex = Math.max(state.lastIndex, dep.index);
    state.lastLedger = Math.max(state.lastLedger, dep.ledger);
  }
  state.rejectedIndices.sort((a, b) => a - b);
  state.deferredIndices = Array.from(nextDeferred).sort((a, b) => a - b);

  // 2. Rebuild the set + local root from the durable approved indices (reconcile).
  const set = await AssociationSet.create(cfg.scope);
  for (const idx of state.approvedIndices) set.add(idx);
  const localRoot = set.rootHex();

  // 3. Reorg guard: verify ledger continuity before publishing.
  let haltedForReorg = false;
  if (cfg.reorgGuard && deposits.length > 0) {
    const latestLedger = Math.max(...deposits.map((d) => d.ledger));
    const check = cfg.reorgGuard.validate(state.lastLedger);
    if (!check.ok) {
      haltedForReorg = true;
      cfg.store.save(state);
      return {
        poolId: cfg.poolId,
        approvedCount: state.approvedIndices.length,
        newlyApproved,
        rejectedCount: state.rejectedIndices.length,
        newlyRejected,
        deferredCount: state.deferredIndices.length,
        localRoot,
        onChainRoot: await cfg.adapter.currentAspRoot(),
        published: false,
        haltedForReorg,
      };
    }
    cfg.reorgGuard.commit(latestLedger);
  }

  // 4. Compare to on-chain; publish only on mismatch (idempotent).
  const onChainRoot = await cfg.adapter.currentAspRoot();
  let published = false;
  if (set.size > 0 && localRoot !== onChainRoot) {
    const manifest = set.manifest(cfg.poolId, now(), { policy: cfg.policy.name, ledger: state.lastLedger });
    if (cfg.dataDir) writeManifest(cfg.dataDir, manifest, cfg.manifestSigner!);
    await cfg.adapter.postAspRoot(localRoot, manifest.datasetHash);
    published = true;
    if (cfg.publicationMonitor) {
      cfg.publicationMonitor.recordPublication(localRoot, state.lastLedger);
    }
  }

  // 5. Publication staleness check.
  let staleAlert: TickResult["staleAlert"] = null;
  if (cfg.publicationMonitor) {
    const alert = cfg.publicationMonitor.check();
    if (alert) {
      staleAlert = { root: alert.lastRoot, ageMs: alert.ageMs, thresholdMs: alert.thresholdMs };
    }
  }

  let stateLeafCount: number | undefined;
  let stateRoot: string | undefined;
  let onChainStateRoot: string | null | undefined;
  let statePublished = false;
  if (
    cfg.adapter.readStateLeaves &&
    cfg.adapter.currentStateRoot &&
    cfg.adapter.postStateRoot
  ) {
    const snapshot = await cfg.adapter.readStateLeaves(state.stateEventCursor ?? 0);
    const accumulated = state.stateLeaves ?? [];
    if (snapshot.events) {
      for (const event of snapshot.events) accumulated[event.index] = event.leaf;
      state.stateLeaves = accumulated;
    } else if ((state.stateEventCursor ?? 0) === 0) {
      state.stateLeaves = [...snapshot.leaves];
    }
    if (snapshot.cursor !== undefined) state.stateEventCursor = snapshot.cursor;
    const leaves = state.stateLeaves ?? snapshot.leaves;
    stateLeafCount = leaves.length;
    if (snapshot.eventCount > 0 || leaves.length > 0) {
      const missing = leaves.findIndex((leaf) => typeof leaf !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(leaf));
      if (missing >= 0) {
        throw new Error(`ASP state history is incomplete at leaf ${missing}; restore an ASP state snapshot or configure the pool deployment ledger and backfill events before restarting.`);
      }
      const poseidon = await getPoseidon();
      const tree = new MerkleTree(poseidon);
      for (const leaf of leaves) {
        tree.insert(BigInt(leaf));
      }
      stateRoot = toHex32(tree.root());
      onChainStateRoot = await cfg.adapter.currentStateRoot();
      if (stateRoot !== onChainStateRoot) {
        await cfg.adapter.postStateRoot(stateRoot, computeDatasetHash(stateRoot, leaves));
        statePublished = true;
      }
    }
  }

  cfg.store.save(state);
  return {
    poolId: cfg.poolId,
    approvedCount: state.approvedIndices.length,
    newlyApproved,
    rejectedCount: state.rejectedIndices.length,
    newlyRejected,
    deferredCount: state.deferredIndices.length,
    localRoot,
    onChainRoot,
    published,
    stateLeafCount,
    stateRoot,
    onChainStateRoot,
    statePublished,
    haltedForReorg,
    staleAlert,
  };
}
