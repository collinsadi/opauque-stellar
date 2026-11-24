/**
 * Typed error hierarchy for the SDK. Every thrown error carries a stable,
 * machine-readable `code` so callers can branch without string-matching
 * messages. Soroban contract failures map to {@link ContractError} with the
 * decoded contract error code (and a name when the contract's error enum is
 * known to the SDK).
 */

export class OpaqueError extends Error {
  /** Stable, machine-readable error code (e.g. "CONFIG", "CONTRACT"). */
  readonly code: string;

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Configuration is missing or invalid (e.g. mainnet without RPC URLs). */
export class ConfigError extends OpaqueError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "CONFIG", options);
  }
}

/**
 * Why a signer adapter failed:
 * - `"rejected"` — the user declined the request in their wallet.
 * - `"unavailable"` — the wallet is not installed, not connected, or not allowed.
 * - `"account-changed"` — the wallet signed with a different account than expected.
 * - `"failed"` — any other signing failure.
 */
export type SignerErrorReason = "rejected" | "unavailable" | "account-changed" | "failed";

/** A signer adapter failed to produce a signature. */
export class SignerError extends OpaqueError {
  /** Why signing failed; `"failed"` when the adapter cannot tell. */
  readonly reason: SignerErrorReason;
  constructor(
    message: string,
    options?: { cause?: unknown; reason?: SignerErrorReason },
  ) {
    super(message, "SIGNER", options);
    this.reason = options?.reason ?? "failed";
  }
}

/** The user declined a wallet request (connect, sign). `reason` is always `"rejected"`. */
export class SignerRejectedError extends SignerError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { ...options, reason: "rejected" });
  }
}

/**
 * An optional peer dependency (e.g. `tweetnacl`, `@stellar/freighter-api`) is
 * needed for the requested feature but is not installed. The SDK still loads
 * without it; only the feature that needs it fails, with this error.
 */
export class MissingPeerDependencyError extends OpaqueError {
  /** The npm package name to install. */
  readonly dependency: string;
  constructor(dependency: string, feature: string, options?: { cause?: unknown }) {
    super(
      `${dependency} is required for ${feature}; install it as a peer dependency (npm install ${dependency}).`,
      "MISSING_PEER_DEPENDENCY",
      options,
    );
    this.dependency = dependency;
  }
}

/** An RPC or Horizon request failed (network, timeout, or HTTP status). */
export class RpcError extends OpaqueError {
  readonly httpStatus?: number;
  constructor(
    message: string,
    options?: { httpStatus?: number; cause?: unknown },
  ) {
    super(message, "RPC", options);
    this.httpStatus = options?.httpStatus;
  }
}

/** A relayer gateway HTTP request failed (network, timeout, HTTP status, or abort). */
export class GatewayError extends OpaqueError {
  readonly httpStatus?: number;
  readonly gatewayUrl?: string;
  constructor(
    message: string,
    options?: { httpStatus?: number; gatewayUrl?: string; cause?: unknown },
  ) {
    super(message, "GATEWAY", options);
    this.httpStatus = options?.httpStatus;
    this.gatewayUrl = options?.gatewayUrl;
  }
}

/** A transaction failed during pre-flight simulation. */
export class SimulationError extends OpaqueError {
  readonly diagnostics?: string;
  constructor(
    message: string,
    options?: { diagnostics?: string; cause?: unknown },
  ) {
    super(message, "SIMULATION", options);
    this.diagnostics = options?.diagnostics;
  }
}

/** A Soroban contract invocation reverted with a contract error code. */
export class ContractError extends OpaqueError {
  readonly contract: string;
  readonly contractCode: number;
  /** Human-readable name when the contract's error enum is known. */
  readonly errorName?: string;
  constructor(opts: {
    contract: string;
    contractCode: number;
    errorName?: string;
    message?: string;
    cause?: unknown;
  }) {
    const label = opts.errorName
      ? `${opts.errorName} (#${opts.contractCode})`
      : `#${opts.contractCode}`;
    super(
      opts.message ?? `${opts.contract} reverted: ${label}`,
      "CONTRACT",
      { cause: opts.cause },
    );
    this.contract = opts.contract;
    this.contractCode = opts.contractCode;
    this.errorName = opts.errorName;
  }
}

/**
 * An optional contract entrypoint is not present on the deployed contract
 * (an older deployment than this SDK). Names the contract and method so callers
 * can degrade gracefully instead of surfacing an opaque simulation failure.
 */
export class ContractCompatibilityError extends OpaqueError {
  readonly contract: string;
  readonly method: string;
  constructor(opts: { contract: string; method: string; cause?: unknown }) {
    super(
      `Deployed contract ${opts.contract} does not support method "${opts.method}" (older deployment than this SDK expects).`,
      "CONTRACT_COMPATIBILITY",
      { cause: opts.cause },
    );
    this.contract = opts.contract;
    this.method = opts.method;
  }
}

/** The published reputation/pool root is unavailable or not yet indexed. */
export class RootUnavailableError extends OpaqueError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "ROOT_UNAVAILABLE", options);
  }
}

/**
 * A reputation-publisher request failed (network, timeout, HTTP status, or a
 * malformed response). `reason` distinguishes auth, rate limiting, a full
 * inbox, an invalid leaf, and a leaf not yet included in the published root.
 */
export class PublisherError extends OpaqueError {
  readonly httpStatus?: number;
  readonly reason:
    | "unauthorized"
    | "rate_limited"
    | "inbox_full"
    | "invalid_leaf"
    | "not_included"
    | "bad_response"
    | "network"
    | "http";
  /** Seconds the publisher asked the caller to wait before retrying, if any. */
  readonly retryAfterSeconds?: number;
  constructor(
    message: string,
    options: {
      reason: PublisherError["reason"];
      httpStatus?: number;
      retryAfterSeconds?: number;
      cause?: unknown;
    },
  ) {
    super(message, "PUBLISHER", options);
    this.reason = options.reason;
    this.httpStatus = options.httpStatus;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** A circuit artifact failed to resolve or failed its integrity check. */
export class ArtifactError extends OpaqueError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "ARTIFACT", options);
  }
}

/** An encrypted storage adapter failed to read or decrypt its persisted data. */
export class StorageError extends OpaqueError {
  /** "wrong-passphrase": AES-GCM auth tag rejected the derived key. "corrupt-payload": the stored envelope is malformed or has an unsupported version. */
  readonly reason: "wrong-passphrase" | "corrupt-payload";
  constructor(
    message: string,
    reason: "wrong-passphrase" | "corrupt-payload",
    options?: { cause?: unknown },
  ) {
    super(message, "STORAGE", options);
    this.reason = reason;
  }
}

/** A serialized note failed to decode: unknown schema version or a missing/malformed field. */
export class NoteSchemaError extends OpaqueError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "NOTE_SCHEMA", options);
  }
}

/** A deposit amount violates a pool constraint (bounds or precision). */
export class PoolValidationError extends OpaqueError {
  /** Name of the violated constraint, e.g. "non-positive" or "precision". */
  readonly constraint: string;
  constructor(
    message: string,
    constraint: string,
    options?: { cause?: unknown },
  ) {
    super(message, "POOL_VALIDATION", options);
    this.constraint = constraint;
  }
}

/**
 * A contract-event scan stopped at its page cap with events left unread. The
 * results are **incomplete** — a truncated announcement scan can miss payments
 * and a truncated state reconstruction can produce a wrong Merkle root — so
 * the SDK raises this instead of handing back partial data as if it were whole.
 *
 * Nothing at or below {@link lastScannedLedger} was skipped: resume there
 * (`lastScannedLedger + 1`) or continue raw cursor paging from
 * {@link continuationCursor}.
 */
export class EventTruncationError extends OpaqueError {
  /** What was being scanned, e.g. `"privacy-pool:Deposit"`. */
  readonly scope: string;
  /** `getEvents` pages actually read before the cap stopped the scan. */
  readonly pagesRead: number;
  /** The cap that was hit. */
  readonly pageCap: number;
  /** Highest ledger read in full. */
  readonly lastScannedLedger: number;
  /** Opaque `getEvents` cursor to continue from, when the scan was cursor-paged. */
  readonly continuationCursor?: string;

  constructor(opts: {
    scope: string;
    pagesRead: number;
    pageCap: number;
    lastScannedLedger: number;
    continuationCursor?: string;
    cause?: unknown;
  }) {
    super(
      `${opts.scope}: event scan stopped at the ${opts.pageCap}-page cap with events left ` +
        `unread (${opts.pagesRead} pages read); results are incomplete — resume from ledger ` +
        `${opts.lastScannedLedger + 1}.`,
      "EVENT_TRUNCATION",
      { cause: opts.cause },
    );
    this.scope = opts.scope;
    this.pagesRead = opts.pagesRead;
    this.pageCap = opts.pageCap;
    this.lastScannedLedger = opts.lastScannedLedger;
    this.continuationCursor = opts.continuationCursor;
  }
}

/**
 * A contract-event scan needs ledgers the RPC has already pruned. Those ledgers
 * were never read, so results built from them are **incomplete**: a skipped
 * announcement is a missed payment, and a missing deposit yields a wrong Merkle
 * root. The SDK raises this instead of quietly restarting from the oldest
 * retained ledger.
 *
 * Pass `allowRetentionGap` to accept a partial result. The gap is then reported
 * to the caller (`onRetentionGap`, or `retentionGap` on the result) rather than
 * hidden.
 */
export class RetentionGapError extends OpaqueError {
  /** What was being scanned, e.g. `"privacy-pool:Deposit"`. */
  readonly scope: string;
  /** First pruned ledger the scan was asked for (inclusive). */
  readonly fromLedger: number;
  /** Last pruned ledger (inclusive); the first retained ledger is this + 1. */
  readonly toLedger: number;

  constructor(opts: { scope: string; fromLedger: number; toLedger: number; cause?: unknown }) {
    super(
      `${opts.scope}: ledgers ${opts.fromLedger}-${opts.toLedger} are outside the RPC retention ` +
        `window and were not scanned, so results built from them are incomplete. Start from a ` +
        `retained ledger (e.g. the deployment ledger), or pass allowRetentionGap to accept a partial result.`,
      "EVENT_RETENTION_GAP",
      { cause: opts.cause },
    );
    this.scope = opts.scope;
    this.fromLedger = opts.fromLedger;
    this.toLedger = opts.toLedger;
  }
}

/**
 * A capability that depends on a layer not yet wired in this build (e.g. the
 * proving layer, the WASM scanner, or the relayer gateway client). Thrown so
 * the surface is discoverable and the failure is explicit rather than silent.
 */
export class NotWiredError extends OpaqueError {
  constructor(capability: string, hint?: string) {
    super(
      `${capability} is not wired in this build.` + (hint ? ` ${hint}` : ""),
      "NOT_WIRED",
    );
  }
}

/**
 * A Soroban contract interface version does not match the SDK's expected
 * version. Thrown at initialization so the caller can surface actionable
 * guidance before any transaction is built.
 */
export class CompatibilityError extends OpaqueError {
  readonly mismatches: Array<{ contract: string; contractId: string; expected: number; deployed: number }>;

  constructor(
    mismatches: Array<{ contract: string; contractId: string; expected: number; deployed: number }>,
  ) {
    const detail = mismatches
      .map(
        (m) =>
          `${m.contract} (${m.contractId}): expected v${m.expected}, deployed v${m.deployed}`,
      )
      .join("; ");
    super(`Contract version mismatch: ${detail}`, "COMPATIBILITY");
    this.mismatches = mismatches;
  }
}

/**
 * A transfer to a known custodial destination was attempted without a memo
 * (or with one that fails the Stellar memo spec). Exchanges route deposits by
 * memo, so an unmemoed transfer to a custodian is unrecoverable.
 */
export class MemoError extends OpaqueError {
  readonly destination?: string;
  readonly custodianName?: string;
  constructor(
    message: string,
    options?: { destination?: string; custodianName?: string; cause?: unknown },
  ) {
    super(message, "MEMO", options);
    this.destination = options?.destination;
    this.custodianName = options?.custodianName;
  }
}

/**
 * The payment half of a stealth send landed on-chain but the announcement
 * transaction failed. The funds are sitting in a one-time stealth account the
 * recipient cannot discover until the announcement is published. Carries
 * everything needed to retry the announcement via
 * `payments.announcePaidTransfer` — the exact ephemeral key and metadata
 * (re-deriving from the recipient meta-address would produce a *different*
 * stealth address).
 */
export class UnannouncedPaymentError extends OpaqueError {
  readonly paymentTxHash: string;
  readonly recipientMetaHex: string;
  readonly stealthAddressHex: string;
  readonly ephemeralPubKey: Uint8Array;
  readonly metadata: Uint8Array;
  readonly amountStroops: bigint;

  constructor(
    options: {
      paymentTxHash: string;
      recipientMetaHex: string;
      stealthAddressHex: string;
      ephemeralPubKey: Uint8Array;
      metadata: Uint8Array;
      amountStroops: bigint;
      cause?: unknown;
    },
  ) {
    super(
      `Payment ${options.paymentTxHash} succeeded but the announcement failed; the funds are in unannounced stealth account ${options.stealthAddressHex}. Retry with payments.announcePaidTransfer.`,
      "UNANNOUNCED_PAYMENT",
      { cause: options.cause },
    );
    this.paymentTxHash = options.paymentTxHash;
    this.recipientMetaHex = options.recipientMetaHex;
    this.stealthAddressHex = options.stealthAddressHex;
    this.ephemeralPubKey = options.ephemeralPubKey;
    this.metadata = options.metadata;
    this.amountStroops = options.amountStroops;
  }

  /** The exact parameters to pass to `payments.announcePaidTransfer`. */
  toAnnounceParams(): {
    stealthAddress: Uint8Array;
    ephemeralPubKey: Uint8Array;
    metadata: Uint8Array;
  } {
    // Decode from hex lazily so the error stays cheap to construct.
    const bytes = (hex: string): Uint8Array => {
      const h = hex.startsWith("0x") ? hex.slice(2) : hex;
      return Uint8Array.from(h.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    };
    return {
      stealthAddress: bytes(this.stealthAddressHex),
      ephemeralPubKey: this.ephemeralPubKey,
      metadata: this.metadata,
    };
  }
}

/**
 * An account-merge sweep cannot proceed because the stealth account holds a
 * state `accountMerge` cannot delete (typically a trustline or open offer).
 * Callers should fall back to {@link PaymentsService.sweep} with the spendable
 * balance, which leaves the base reserve behind but moves the funds.
 */
export class MergeIncompatibleError extends OpaqueError {
  readonly account: string;
  readonly balances: string[];
  constructor(account: string, balances: string[]) {
    super(
      `Account ${account} cannot be merged (incompatible state: ${balances.join(", ")}). ` +
        "Fall back to a partial sweep; the base reserve will remain in the account.",
      "MERGE_INCOMPATIBLE",
    );
    this.account = account;
    this.balances = balances;
  }
}

/**
 * Known contract error enums, keyed by contract package name. Populated as the
 * SDK binds each contract; an unknown code still surfaces as a numeric
 * {@link ContractError}. Source of truth is each contract's `#[contracterror]`.
 *
 * Regenerate after contract error changes:
 *   npx tsx scripts/generate-error-mapping.ts
 */
import { CONTRACT_ERROR_NAMES as _CONTRACT_ERROR_NAMES } from "./contract-errors.generated";
export { _CONTRACT_ERROR_NAMES as CONTRACT_ERROR_NAMES };

/** Look up a contract error name for a code, if the SDK knows the enum. */
export function contractErrorName(
  contractPackage: string,
  code: number,
): string | undefined {
  return _CONTRACT_ERROR_NAMES[contractPackage]?.[code];
}
