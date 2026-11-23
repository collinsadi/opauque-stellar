/**
 * Core ASP interfaces. The Association Set Provider is liveness + curation, never
 * integrity: it decides which deposits are "clean" and publishes the association-tree
 * root that the withdraw circuit proves against. It can never mint, steal, or forge
 * double-spends — a bad label list simply fails proof generation (withdrawers recompute
 * the root locally and check it equals the on-chain aspRoot). See README for the full
 * trust boundary.
 */

/** A deposit observed on-chain (from a `Deposit` event). */
export interface Deposit {
  /** Sequential leaf index assigned by the pool contract at deposit time. */
  index: number;
  /** The commitment inserted into the state tree (hex, 0x-prefixed, 32 bytes). */
  commitment: string;
  /** Deposited value in stroops. */
  value: string;
  /** The pool's scope (domain separator for labels). */
  scope: number;
  /** Ledger the deposit was finalized at. */
  ledger: number;
}

export type PolicyVerdict = "approve" | "reject" | "defer";

/** Pluggable screening policy: decides whether a deposit's label joins the clean set. */
export interface Policy {
  readonly name: string;
  screen(deposit: Deposit): Promise<PolicyVerdict> | PolicyVerdict;
  /** Optional human-readable reason for the decision (used for audit logging). */
  reason?(deposit: Deposit): string;
}

/** Persisted per-pool ASP state. */
export interface PoolState {
  poolId: string;
  scope: number;
  /** Deposit indices that have been approved, in approval order (== tree leaf order). */
  approvedIndices: number[];
  /** Deposit indices explicitly excluded by policy, for audit and appeals. */
  rejectedIndices?: number[];
  /** Deposit indices deferred for a later screening pass. */
  deferredIndices?: number[];
  /** Highest deposit index seen (so ticks resume without rescanning from genesis). */
  lastIndex: number;
  /** Ledger cursor for incremental event reads. */
  lastLedger: number;
  /** Auditable policy decisions, including re-evaluations of deferred deposits. */
  decisions?: PolicyDecisionRecord[];
  /** Durable state-event cursor and accumulated state leaves. */
  stateEventCursor?: number;
  stateLeaves?: string[];
}

export interface PolicyDecisionRecord {
  depositIndex: number;
  policy: string;
  verdict: PolicyVerdict;
  reason: string;
  timestamp: string;
}

/** Full state-tree snapshot reconstructed from Deposit + Withdraw events. */
export interface StateTreeSnapshot {
  /** Commitment/new-commitment leaves in state-tree index order, hex 0x-prefixed. */
  leaves: string[];
  /** Number of pool events used to build the snapshot. */
  eventCount: number;
  /** Highest leaf index present, or -1 when the pool is empty. */
  maxIndex: number;
  /** Incremental event updates, when supplied by a chain adapter. */
  events?: Array<{ index: number; leaf: string }>;
  /** Next ledger cursor to persist after consuming this snapshot. */
  cursor?: number;
}

/** A published association-set manifest (self-authenticating: anyone recomputes the root). */
export interface SetManifest {
  poolId: string;
  root: string;
  version: number;
  levels: number;
  algo: "poseidon-bn254";
  /** Approved labels in tree-leaf order (decimal field elements). */
  labels: string[];
  /** Deposit index for each label (parallel to `labels`). */
  indices: number[];
  generatedAt: string;
  /** sha256 binding `root` to its exact label set — the value posted on-chain (see `computeDatasetHash`). */
  datasetHash: string;
  /** Name of the screening policy that produced this set. */
  policy: string;
  /** Highest ledger the set reflects (the ASP's deposit cursor when it was built). */
  ledger: number;
  /** Stellar G-address of the Ed25519 key that signed this manifest (#1081). */
  signer?: string;
  /** Hex Ed25519 signature over `canonicalManifestBytes` (#1081). */
  signature?: string;
}

/**
 * Chain adapter abstraction so the engine is chain-agnostic. The Stellar implementation
 * reads finalized `Deposit` events and posts the root via `update_asp_root`.
 */
export interface ChainAdapter {
  /** Read finalized deposits with index > afterIndex (and from ledger cursor). */
  readDeposits(afterIndex: number, fromLedger: number): Promise<Deposit[]>;
  /** The currently published on-chain ASP root (hex), or null if none. */
  currentAspRoot(): Promise<string | null>;
  /** Publish a new ASP root + dataset hash. */
  postAspRoot(root: string, datasetHash: string): Promise<void>;
  /** Latest finalized ledger (for the cursor). */
  latestLedger(): Promise<number>;
  /** Optional: rebuild all state-tree leaves from pool Deposit + Withdraw events. */
  readStateLeaves?(fromLedger?: number): Promise<StateTreeSnapshot>;
  /** Optional: latest published state root. */
  currentStateRoot?(): Promise<string | null>;
  /** Optional: publish a new state root. */
  postStateRoot?(root: string, datasetHash: string): Promise<void>;
}
