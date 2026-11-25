/**
 * Typed error hierarchy for proof, verification, and submission failures (#562).
 *
 * Every failure the pool/relayer stack can surface is thrown as an instance of a
 * class documented here. Integrators branch on `instanceof` (or the stable `code`
 * discriminant) instead of string-matching `error.message`, so message copy can be
 * reworded — for clarity, localisation, or UX — without breaking callers.
 *
 * Rules this module upholds:
 *  - Every class extends {@link OpaqueError} and is listed in {@link OPAQUE_ERROR_CLASSES}.
 *  - Every class carries structured fields; the message is presentation only.
 *  - `code` and `stage` are part of the public contract and never change for a class.
 *  - Underlying causes are preserved on `cause` so nothing is swallowed.
 *
 * @example
 * ```ts
 * try {
 *   await generateWithdrawProof(opts);
 * } catch (err) {
 *   if (err instanceof AspRootsUnpublishedError) scheduleRetry(err.context.poolId);
 *   else if (err instanceof ProofGenerationError) reportCircuitBug(err.circuit);
 *   else throw err;
 * }
 * ```
 */

/** Phase of the withdrawal pipeline a failure belongs to. */
export type OpaqueErrorStage =
  | "config"
  | "proof"
  | "verification"
  | "submission"
  | "rpc"
  | "relayer";

/**
 * Stable machine-readable discriminant. Safe to persist, log, and branch on.
 * Codes are append-only: an existing code never changes meaning or class.
 */
export type OpaqueErrorCode =
  // config
  | "POOL_NOT_DEPLOYED"
  | "RELAYER_NOT_CONFIGURED"
  // proof
  | "NOTE_NOT_INDEXED"
  | "NOTE_COMMITMENT_MISMATCH"
  | "POOL_ROOTS_UNPUBLISHED"
  | "POOL_ROOTS_STALE"
  | "POOL_HISTORY_INCOMPLETE"
  | "PROOF_ARTIFACT_UNAVAILABLE"
  | "PROOF_GENERATION_FAILED"
  // verification
  | "SIMULATION_FAILED"
  | "PROOF_REJECTED"
  // submission
  | "TX_REJECTED"
  | "TX_FAILED"
  | "TX_TIMEOUT"
  // rpc
  | "RPC_REQUEST_FAILED"
  | "RPC_RETRIES_EXHAUSTED"
  // relayer
  | "RELAYER_GATEWAY_REJECTED"
  | "RELAYER_NO_BIDS"
  | "RELAYER_JOB_FAILED"
  // fallback
  | "UNKNOWN";

/** Structured, non-secret detail attached to every error. */
export type OpaqueErrorContext = Readonly<Record<string, unknown>>;

export type OpaqueErrorInit = {
  /** Presentation copy. Never parse this — branch on the class or `code`. */
  message: string;
  /** The underlying failure, preserved verbatim. */
  cause?: unknown;
  /** Extra structured detail merged into `context`. */
  context?: Record<string, unknown>;
};

type OpaqueErrorSpec = OpaqueErrorInit & {
  name: string;
  code: OpaqueErrorCode;
  stage: OpaqueErrorStage;
  retryable: boolean;
};

/**
 * Base class for every error this SDK throws.
 *
 * `name`/`code`/`stage`/`retryable` are assigned in the constructor rather than as
 * class-field initialisers so they survive subclassing under `useDefineForClassFields`.
 */
export abstract class OpaqueError extends Error {
  /** Stable discriminant; see {@link OpaqueErrorCode}. */
  readonly code: OpaqueErrorCode;
  /** Pipeline phase the failure occurred in. */
  readonly stage: OpaqueErrorStage;
  /** Whether retrying the same operation unchanged can plausibly succeed. */
  readonly retryable: boolean;
  /** Structured detail. Frozen; contains no note secrets or keys. */
  readonly context: OpaqueErrorContext;
  /** Wall-clock time the error was constructed. */
  readonly occurredAt: number;

  protected constructor(spec: OpaqueErrorSpec) {
    super(
      spec.message,
      spec.cause !== undefined ? { cause: spec.cause } : undefined,
    );
    // Explicit literal (not `new.target.name`) so minified builds keep the name.
    this.name = spec.name;
    this.code = spec.code;
    this.stage = spec.stage;
    this.retryable = spec.retryable;
    this.context = Object.freeze({ ...(spec.context ?? {}) });
    this.occurredAt = Date.now();
  }

  /** Serialisable shape — used by logging and the error reporter (#560). */
  toJSON(): {
    name: string;
    code: OpaqueErrorCode;
    stage: OpaqueErrorStage;
    retryable: boolean;
    message: string;
    context: Record<string, unknown>;
    causeMessage?: string;
  } {
    const causeMessage =
      this.cause instanceof Error
        ? this.cause.message
        : this.cause !== undefined
          ? String(this.cause)
          : undefined;
    return {
      name: this.name,
      code: this.code,
      stage: this.stage,
      retryable: this.retryable,
      message: this.message,
      context: { ...this.context },
      ...(causeMessage !== undefined ? { causeMessage } : {}),
    };
  }
}

// ─── Configuration ──────────────────────────────────────────────────────────

/** The privacy pool is not deployed (or not wired) on the active network. */
export class PoolNotDeployedError extends OpaqueError {
  readonly network: string;

  constructor(init: OpaqueErrorInit & { network: string }) {
    super({
      ...init,
      name: "PoolNotDeployedError",
      code: "POOL_NOT_DEPLOYED",
      stage: "config",
      retryable: false,
      context: { ...init.context, network: init.network },
    });
    this.network = init.network;
  }
}

/** The relayer registry is absent from the active deployment manifest. */
export class RelayerNotConfiguredError extends OpaqueError {
  readonly network: string;

  constructor(init: OpaqueErrorInit & { network: string }) {
    super({
      ...init,
      name: "RelayerNotConfiguredError",
      code: "RELAYER_NOT_CONFIGURED",
      stage: "config",
      retryable: false,
      context: { ...init.context, network: init.network },
    });
    this.network = init.network;
  }
}

// ─── Proof generation ───────────────────────────────────────────────────────

/** Base class for every failure raised while building a withdrawal proof. */
export abstract class ProofError extends OpaqueError {}

/** The selected note's leaf index has no matching on-chain `Deposit` event. */
export class NoteNotIndexedError extends ProofError {
  readonly leafIndex: number;
  readonly indexedLeafIndices: readonly number[];

  constructor(
    init: OpaqueErrorInit & {
      leafIndex: number;
      indexedLeafIndices: readonly number[];
    },
  ) {
    super({
      ...init,
      name: "NoteNotIndexedError",
      code: "NOTE_NOT_INDEXED",
      stage: "proof",
      retryable: false,
      context: {
        ...init.context,
        leafIndex: init.leafIndex,
        indexedCount: init.indexedLeafIndices.length,
      },
    });
    this.leafIndex = init.leafIndex;
    this.indexedLeafIndices = [...init.indexedLeafIndices];
  }
}

/** The leaf exists on-chain but holds a different commitment (stale note). */
export class NoteCommitmentMismatchError extends ProofError {
  readonly leafIndex: number;
  readonly expectedCommitment: string;
  readonly onChainCommitment: string;

  constructor(
    init: OpaqueErrorInit & {
      leafIndex: number;
      expectedCommitment: string;
      onChainCommitment: string;
    },
  ) {
    super({
      ...init,
      name: "NoteCommitmentMismatchError",
      code: "NOTE_COMMITMENT_MISMATCH",
      stage: "proof",
      retryable: false,
      context: { ...init.context, leafIndex: init.leafIndex },
    });
    this.leafIndex = init.leafIndex;
    this.expectedCommitment = init.expectedCommitment;
    this.onChainCommitment = init.onChainCommitment;
  }
}

/** The pool has not published a state and/or ASP root yet. */
export class PoolRootsUnpublishedError extends ProofError {
  readonly poolId: string;
  readonly hasStateRoot: boolean;
  readonly hasAspRoot: boolean;

  constructor(
    init: OpaqueErrorInit & {
      poolId: string;
      hasStateRoot: boolean;
      hasAspRoot: boolean;
    },
  ) {
    super({
      ...init,
      name: "PoolRootsUnpublishedError",
      code: "POOL_ROOTS_UNPUBLISHED",
      stage: "proof",
      // The ASP indexer publishes on a schedule; waiting is the fix.
      retryable: true,
      context: {
        ...init.context,
        poolId: init.poolId,
        hasStateRoot: init.hasStateRoot,
        hasAspRoot: init.hasAspRoot,
      },
    });
    this.poolId = init.poolId;
    this.hasStateRoot = init.hasStateRoot;
    this.hasAspRoot = init.hasAspRoot;
  }
}

/** Locally rebuilt roots do not match the published ones (indexer lag). */
export class PoolRootsStaleError extends ProofError {
  readonly poolId: string;
  readonly stateRootMatches: boolean;
  readonly aspRootMatches: boolean;

  constructor(
    init: OpaqueErrorInit & {
      poolId: string;
      stateRootMatches: boolean;
      aspRootMatches: boolean;
    },
  ) {
    super({
      ...init,
      name: "PoolRootsStaleError",
      code: "POOL_ROOTS_STALE",
      stage: "proof",
      retryable: true,
      context: {
        ...init.context,
        poolId: init.poolId,
        stateRootMatches: init.stateRootMatches,
        aspRootMatches: init.aspRootMatches,
      },
    });
    this.poolId = init.poolId;
    this.stateRootMatches = init.stateRootMatches;
    this.aspRootMatches = init.aspRootMatches;
  }
}

/**
 * The wallet could not rebuild the complete pool state tree: RPC event paging hit its
 * cap, or leaves fall outside RPC retention and no indexer fallback filled them (#921).
 * Proving against a tree with holes would silently produce a wrong root.
 */
export class PoolHistoryIncompleteError extends ProofError {
  readonly poolId: string;
  readonly missingLeafIndices: number[];
  readonly truncated: boolean;

  constructor(
    init: OpaqueErrorInit & {
      poolId: string;
      missingLeafIndices: number[];
      truncated: boolean;
    },
  ) {
    super({
      ...init,
      name: "PoolHistoryIncompleteError",
      code: "POOL_HISTORY_INCOMPLETE",
      stage: "proof",
      retryable: false,
      context: {
        ...init.context,
        poolId: init.poolId,
        missingLeafCount: init.missingLeafIndices.length,
        firstMissingLeaf: init.missingLeafIndices[0],
        truncated: init.truncated,
      },
    });
    this.poolId = init.poolId;
    this.missingLeafIndices = init.missingLeafIndices;
    this.truncated = init.truncated;
  }
}

/** A circuit artifact (`.wasm` / `.zkey`) could not be fetched or is corrupt. */
export class ProofArtifactUnavailableError extends ProofError {
  readonly artifact: string;

  constructor(init: OpaqueErrorInit & { artifact: string }) {
    super({
      ...init,
      name: "ProofArtifactUnavailableError",
      code: "PROOF_ARTIFACT_UNAVAILABLE",
      stage: "proof",
      retryable: true,
      context: { ...init.context, artifact: init.artifact },
    });
    this.artifact = init.artifact;
  }
}

/** snarkjs failed to produce a proof from otherwise-valid inputs. */
export class ProofGenerationError extends ProofError {
  readonly circuit: string;

  constructor(init: OpaqueErrorInit & { circuit: string }) {
    super({
      ...init,
      name: "ProofGenerationError",
      code: "PROOF_GENERATION_FAILED",
      stage: "proof",
      retryable: false,
      context: { ...init.context, circuit: init.circuit },
    });
    this.circuit = init.circuit;
  }
}

// ─── Verification ───────────────────────────────────────────────────────────

/** Base class for pre-submission verification failures. */
export abstract class VerificationError extends OpaqueError {}

/** Soroban simulation rejected the transaction before it was signed. */
export class SimulationFailedError extends VerificationError {
  readonly contractId: string;
  readonly method: string;
  /** Decoded contract/host error token, when one could be extracted. */
  readonly contractError: string | null;

  constructor(
    init: OpaqueErrorInit & {
      contractId: string;
      method: string;
      contractError?: string | null;
    },
  ) {
    super({
      ...init,
      name: "SimulationFailedError",
      code: "SIMULATION_FAILED",
      stage: "verification",
      retryable: false,
      context: {
        ...init.context,
        contractId: init.contractId,
        method: init.method,
        contractError: init.contractError ?? null,
      },
    });
    this.contractId = init.contractId;
    this.method = init.method;
    this.contractError = init.contractError ?? null;
  }
}

/** The on-chain Groth16 verifier rejected the proof. */
export class ProofRejectedError extends VerificationError {
  readonly contractId: string;
  readonly nullifierHash: string | null;

  constructor(
    init: OpaqueErrorInit & {
      contractId: string;
      nullifierHash?: string | null;
    },
  ) {
    super({
      ...init,
      name: "ProofRejectedError",
      code: "PROOF_REJECTED",
      stage: "verification",
      retryable: false,
      context: { ...init.context, contractId: init.contractId },
    });
    this.contractId = init.contractId;
    this.nullifierHash = init.nullifierHash ?? null;
  }
}

// ─── Submission ─────────────────────────────────────────────────────────────

/** Base class for failures that happen once a transaction leaves the client. */
export abstract class SubmissionError extends OpaqueError {}

/** The RPC node refused the transaction outright (never reached the ledger). */
export class TransactionRejectedError extends SubmissionError {
  readonly status: string;
  readonly txHash: string | null;

  constructor(
    init: OpaqueErrorInit & { status: string; txHash?: string | null },
  ) {
    super({
      ...init,
      name: "TransactionRejectedError",
      code: "TX_REJECTED",
      stage: "submission",
      retryable: false,
      context: { ...init.context, status: init.status },
    });
    this.status = init.status;
    this.txHash = init.txHash ?? null;
  }
}

/** The transaction was included but the ledger reports a failure. */
export class TransactionFailedError extends SubmissionError {
  readonly txHash: string;
  readonly status: string;
  /** Decoded diagnostic events, when the node returned any. */
  readonly diagnostics: string | null;

  constructor(
    init: OpaqueErrorInit & {
      txHash: string;
      status: string;
      diagnostics?: string | null;
    },
  ) {
    super({
      ...init,
      name: "TransactionFailedError",
      code: "TX_FAILED",
      stage: "submission",
      retryable: false,
      context: {
        ...init.context,
        txHash: init.txHash,
        status: init.status,
      },
    });
    this.txHash = init.txHash;
    this.status = init.status;
    this.diagnostics = init.diagnostics ?? null;
  }
}

/**
 * Polling gave up before the transaction reached a terminal state. The
 * transaction may still land — `txHash` is always present so callers can
 * reconcile later rather than resubmitting.
 */
export class TransactionTimeoutError extends SubmissionError {
  readonly txHash: string;
  readonly waitedMs: number;

  constructor(init: OpaqueErrorInit & { txHash: string; waitedMs: number }) {
    super({
      ...init,
      name: "TransactionTimeoutError",
      code: "TX_TIMEOUT",
      stage: "submission",
      retryable: false,
      context: {
        ...init.context,
        txHash: init.txHash,
        waitedMs: init.waitedMs,
      },
    });
    this.txHash = init.txHash;
    this.waitedMs = init.waitedMs;
  }
}

// ─── RPC ────────────────────────────────────────────────────────────────────

/** A single RPC call failed. Wraps the transport-level error on `cause`. */
export class RpcRequestError extends OpaqueError {
  readonly provider: string;
  readonly method: string;
  readonly status: number | null;

  constructor(
    init: OpaqueErrorInit & {
      provider: string;
      method: string;
      status?: number | null;
      retryable?: boolean;
    },
  ) {
    super({
      ...init,
      name: "RpcRequestError",
      code: "RPC_REQUEST_FAILED",
      stage: "rpc",
      retryable: init.retryable ?? false,
      context: {
        ...init.context,
        provider: init.provider,
        method: init.method,
        status: init.status ?? null,
      },
    });
    this.provider = init.provider;
    this.method = init.method;
    this.status = init.status ?? null;
  }
}

/**
 * The configured retry policy ran out of attempts (#561).
 *
 * `cause` and `lastError` are both the final underlying failure, so the original
 * error is never lost behind the retry wrapper.
 */
export class RpcRetriesExhaustedError extends OpaqueError {
  readonly method: string;
  readonly attempts: number;
  readonly providersTried: number;
  readonly elapsedMs: number;
  /** The last underlying error; identical to `cause`. */
  readonly lastError: unknown;

  constructor(
    init: OpaqueErrorInit & {
      method: string;
      attempts: number;
      providersTried: number;
      elapsedMs: number;
    },
  ) {
    super({
      ...init,
      name: "RpcRetriesExhaustedError",
      code: "RPC_RETRIES_EXHAUSTED",
      stage: "rpc",
      retryable: false,
      context: {
        ...init.context,
        method: init.method,
        attempts: init.attempts,
        providersTried: init.providersTried,
        elapsedMs: init.elapsedMs,
      },
    });
    this.method = init.method;
    this.attempts = init.attempts;
    this.providersTried = init.providersTried;
    this.elapsedMs = init.elapsedMs;
    this.lastError = init.cause;
  }
}

// ─── Relayer market ─────────────────────────────────────────────────────────

/** Base class for relayer-market failures. */
export abstract class RelayerError extends OpaqueError {}

/** The relayer gateway returned a non-2xx response. */
export class RelayerGatewayError extends RelayerError {
  readonly gateway: string;
  readonly operation: "advert" | "bids" | "payload";
  readonly status: number;

  constructor(
    init: OpaqueErrorInit & {
      gateway: string;
      operation: "advert" | "bids" | "payload";
      status: number;
    },
  ) {
    super({
      ...init,
      name: "RelayerGatewayError",
      code: "RELAYER_GATEWAY_REJECTED",
      stage: "relayer",
      retryable: init.status >= 500 || init.status === 429,
      context: {
        ...init.context,
        operation: init.operation,
        status: init.status,
      },
    });
    this.gateway = init.gateway;
    this.operation = init.operation;
    this.status = init.status;
  }
}

/** No bid survived signature + on-chain stake verification. */
export class RelayerNoBidsError extends RelayerError {
  readonly jobIdHex: string;
  readonly receivedBids: number;

  constructor(
    init: OpaqueErrorInit & { jobIdHex: string; receivedBids: number },
  ) {
    super({
      ...init,
      name: "RelayerNoBidsError",
      code: "RELAYER_NO_BIDS",
      stage: "relayer",
      retryable: true,
      context: { ...init.context, receivedBids: init.receivedBids },
    });
    this.jobIdHex = init.jobIdHex;
    this.receivedBids = init.receivedBids;
  }
}

/** An escrowed job ended in a non-success terminal state. */
export class RelayerJobFailedError extends RelayerError {
  readonly jobIdHex: string;
  readonly jobStatus: string;

  constructor(init: OpaqueErrorInit & { jobIdHex: string; jobStatus: string }) {
    super({
      ...init,
      name: "RelayerJobFailedError",
      code: "RELAYER_JOB_FAILED",
      stage: "relayer",
      retryable: false,
      context: { ...init.context, jobStatus: init.jobStatus },
    });
    this.jobIdHex = init.jobIdHex;
    this.jobStatus = init.jobStatus;
  }
}

// ─── Fallback ───────────────────────────────────────────────────────────────

/**
 * Wrapper for a failure that escaped without a typed class — a third-party throw,
 * a browser exception, a bug. Exists so {@link toOpaqueError} can always hand back
 * an `OpaqueError`, keeping `instanceof OpaqueError` a total guarantee at API edges.
 */
export class UnknownOpaqueError extends OpaqueError {
  constructor(init: OpaqueErrorInit & { stage?: OpaqueErrorStage }) {
    super({
      ...init,
      name: "UnknownOpaqueError",
      code: "UNKNOWN",
      stage: init.stage ?? "rpc",
      retryable: false,
    });
  }
}

// ─── Registry & helpers ─────────────────────────────────────────────────────

/**
 * Every concrete class this module can throw.
 *
 * The test suite asserts each entry constructs, reports a unique `code`, and is an
 * `OpaqueError` — that is what makes "every thrown error is an instance of a
 * documented class" mechanically checkable rather than a convention.
 */
export const OPAQUE_ERROR_CLASSES = [
  PoolNotDeployedError,
  RelayerNotConfiguredError,
  NoteNotIndexedError,
  NoteCommitmentMismatchError,
  PoolRootsUnpublishedError,
  PoolRootsStaleError,
  ProofArtifactUnavailableError,
  ProofGenerationError,
  SimulationFailedError,
  ProofRejectedError,
  TransactionRejectedError,
  TransactionFailedError,
  TransactionTimeoutError,
  RpcRequestError,
  RpcRetriesExhaustedError,
  RelayerGatewayError,
  RelayerNoBidsError,
  RelayerJobFailedError,
  UnknownOpaqueError,
] as const;

export function isOpaqueError(err: unknown): err is OpaqueError {
  return err instanceof OpaqueError;
}

/** Branch on the stable code without importing the class. */
export function hasErrorCode(err: unknown, code: OpaqueErrorCode): boolean {
  return isOpaqueError(err) && err.code === code;
}

/** True when the operation is worth retrying unchanged. */
export function isRetryable(err: unknown): boolean {
  return isOpaqueError(err) && err.retryable;
}

/**
 * Normalise anything thrown into an `OpaqueError`, preserving the original on
 * `cause`. Already-typed errors pass through untouched.
 */
export function toOpaqueError(
  err: unknown,
  fallback?: { message?: string; stage?: OpaqueErrorStage },
): OpaqueError {
  if (isOpaqueError(err)) return err;
  const message =
    fallback?.message ??
    (err instanceof Error ? err.message : String(err)) ??
    "Unexpected failure";
  return new UnknownOpaqueError({ message, cause: err, stage: fallback?.stage });
}

/**
 * Walk the `cause` chain looking for a typed error of a given class. Useful when a
 * transport wrapper hides the interesting failure.
 */
export function findCause<T extends OpaqueError>(
  err: unknown,
  ctor: abstract new (...args: never[]) => T,
): T | null {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current != null; depth += 1) {
    if (current instanceof ctor) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
