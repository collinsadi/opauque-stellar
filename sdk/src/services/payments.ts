/**
 * Stealth private payments. Derive an identity and meta-address, register it,
 * send a stealth XLM payment (one-time account + announcement), and sweep a
 * detected stealth account. `scan()` matches against a caller-supplied
 * announcement list; `scanIterator()` reads announcements from chain itself
 * and streams matches incrementally with a resumable cursor.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import {
  computeStealthAddressAndViewTag,
  deriveKeysFromSignature,
  deriveStealthStellarKeypairFromStealthPrivKey,
  hexToBytes,
  keysToStealthMetaAddress,
  memoRiskFor,
  parseXlmToStroops,
  resolveTransferMemo,
  scanAnnouncements,
  stealthMetaAddressToHex,
  bytesToHex,
  type Hex,
  type ScanMatch,
  type StealthAnnouncement,
  type TransferMemo,
} from "../crypto/index";
import { keypairSigner } from "../signer/index";
import { MemoError, RetentionGapError, UnannouncedPaymentError } from "../errors/index";
import type { RetentionGap } from "../rpc/events";
import type { OpaqueClientContext } from "./context";

export interface StealthIdentity {
  viewingKey: Uint8Array;
  spendingKey: Uint8Array;
  metaAddress: Uint8Array;
  metaHex: Hex;
}

/** Domain separator for scan-cursor keys. Bump it to re-key every stored cursor. */
const SCAN_CURSOR_DOMAIN = "opaque-scan-cursor-v1";

/**
 * The `ScanStore` key a scan for `identity` persists its cursor under.
 *
 * Derived from the **public** viewing key through a domain-separated SHA-256,
 * never from the private viewing scalar. A `ScanStore` (including plaintext and
 * third-party implementations) sees these keys, and the viewing key is the
 * secret that discovers every incoming payment, so it must not be stored.
 *
 * Keyed per identity, so one client can watch many identities without one
 * identity's scan resuming past another's payments.
 */
export function scanCursorKey(identity: Pick<StealthIdentity, "viewingKey">): string {
  const publicViewingKey = secp256k1.getPublicKey(identity.viewingKey, true);
  const domain = new TextEncoder().encode(SCAN_CURSOR_DOMAIN);
  const input = new Uint8Array(domain.length + publicViewingKey.length);
  input.set(domain, 0);
  input.set(publicViewingKey, domain.length);
  return `sc1:${bytesToHex(sha256(input))}`;
}

/**
 * The pre-#1076 cursor key, which embedded the private viewing key. It is only
 * ever read, to migrate a cursor saved before the change, and never written.
 */
function legacyScanCursorKey(identity: Pick<StealthIdentity, "viewingKey">): string {
  return `vk:${bytesToHex(identity.viewingKey)}`;
}

export class PaymentsService {
  constructor(private readonly ctx: OpaqueClientContext) {}

  /** Derive viewing/spending keys + meta-address from a wallet signature. */
  deriveIdentity(signatureHex: string): StealthIdentity {
    const { viewingKey, spendingKey } = deriveKeysFromSignature(signatureHex);
    const { metaAddress } = keysToStealthMetaAddress(viewingKey, spendingKey);
    return {
      viewingKey,
      spendingKey,
      metaAddress,
      metaHex: stealthMetaAddressToHex(metaAddress),
    };
  }

  /** Register a stealth meta-address for the signer's account. */
  async register(opts: { metaAddress: Uint8Array }): Promise<string> {
    return this.ctx.contracts.stealthRegistry.registerKeys({
      stealthMetaAddress: opts.metaAddress,
      signer: this.ctx.requireSigner(),
    });
  }

  /** Pure: compute a one-time stealth address + announcement params for a recipient. */
  prepareTransfer(recipientMetaHex: string) {
    return computeStealthAddressAndViewTag(recipientMetaHex);
  }

  /**
   * Send a stealth XLM payment: pay the one-time stealth Stellar account, then
   * publish the announcement so the recipient can detect and sweep it.
   *
   * `memo` is attached to the payment. Known custodial destinations *require*
   * a memo ({@link MemoError}); any provided memo is validated against the
   * Stellar memo spec.
   *
   * If the payment lands but the announcement transaction fails, throws
   * {@link UnannouncedPaymentError} carrying the exact ephemeral key and
   * metadata needed to retry with {@link announcePaidTransfer} — the funds
   * are recoverable, not lost.
   */
  async send(opts: {
    to: string;
    amountXlm: string;
    /** Memo attached to the underlying payment; required for custodial destinations. */
    memo?: TransferMemo;
    /** Max fee per operation for the payment, in stroops. */
    feePerOperation?: string | number;
  }): Promise<{
    stealthStellarAddress: string;
    ephemeralPubKey: Uint8Array;
    paymentTxHash: string;
    announceTxHash: string;
  }> {
    const signer = this.ctx.requireSigner();
    const memo = this.resolveMemo(opts.to, opts.memo);
    const stealth = computeStealthAddressAndViewTag(opts.to);
    const amountStroops = parseXlmToStroops(opts.amountXlm);

    const paymentTxHash = await this.ctx.sendNativeTransfer({
      destination: stealth.stealthStellarAddress,
      amountStroops,
      signer,
      memo,
      feePerOperation: opts.feePerOperation,
    });

    let announceTxHash: string;
    try {
      announceTxHash = await this.ctx.contracts.stealthAnnouncer.announce({
        stealthAddress: hexToBytes(stealth.stealthAddress),
        ephemeralPubKey: stealth.ephemeralPubKey,
        metadata: stealth.metadata,
        signer,
      });
    } catch (err) {
      // The payment is on-chain but undiscoverable until announced. Surface
      // every parameter of the exact transfer so the caller can retry the
      // announcement without re-paying.
      throw new UnannouncedPaymentError({
        paymentTxHash,
        recipientMetaHex: opts.to,
        stealthAddressHex: stealth.stealthAddress,
        ephemeralPubKey: stealth.ephemeralPubKey,
        metadata: stealth.metadata,
        amountStroops,
        cause: err,
      });
    }

    return {
      stealthStellarAddress: stealth.stealthStellarAddress,
      ephemeralPubKey: stealth.ephemeralPubKey,
      paymentTxHash,
      announceTxHash,
    };
  }

  /**
   * Retry the announcement half of a send whose payment landed but whose
   * announcement failed (see {@link UnannouncedPaymentError}). Pass
   * `err.toAnnounceParams()` — or the equivalent fields from a persisted
   * record — to publish the *exact* original announcement; re-deriving from
   * the recipient meta-address would produce a different stealth address.
   *
   * @returns the announcement transaction hash.
   */
  async announcePaidTransfer(opts: {
    stealthAddress: Uint8Array;
    ephemeralPubKey: Uint8Array;
    metadata: Uint8Array;
  }): Promise<string> {
    const signer = this.ctx.requireSigner();
    return this.ctx.contracts.stealthAnnouncer.announce({
      stealthAddress: opts.stealthAddress,
      ephemeralPubKey: opts.ephemeralPubKey,
      metadata: opts.metadata,
      signer,
    });
  }

  /**
   * Sweep a detected stealth account to a destination. The stealth account signs
   * itself (derived from the one-time key), so the connected wallet is never the
   * source. `amountStroops` is the exact amount to move (compute the spendable
   * balance from Horizon, reserving fee + minimum balance).
   *
   * `memo` is attached to the sweep payment; known custodial destinations
   * require one ({@link MemoError}).
   */
  async sweep(opts: {
    stealthPrivKey: Uint8Array;
    destination: string;
    amountStroops: bigint;
    /** Memo attached to the sweep payment; required for custodial destinations. */
    memo?: TransferMemo;
    /** Max fee per operation, in stroops. */
    feePerOperation?: string | number;
  }): Promise<string> {
    const memo = this.resolveMemo(opts.destination, opts.memo);
    const keypair = deriveStealthStellarKeypairFromStealthPrivKey(opts.stealthPrivKey);
    return this.ctx.sendNativeTransfer({
      destination: opts.destination,
      amountStroops: opts.amountStroops,
      signer: keypairSigner(keypair),
      memo,
      feePerOperation: opts.feePerOperation,
    });
  }

  /**
   * Sweep a stealth account by *merging* it into `destination`, recovering the
   * full balance **including the base reserve** a payment-based sweep strands.
   *
   * The account must hold nothing but native XLM: a trustline or open offer
   * makes `accountMerge` fail on-chain, so those states are detected up-front
   * and rejected with a clear error — fall back to {@link sweep} with the
   * spendable balance in that case.
   *
   * @returns the merge transaction hash.
   */
  async sweepWithMerge(opts: {
    stealthPrivKey: Uint8Array;
    destination: string;
  }): Promise<string> {
    const keypair = deriveStealthStellarKeypairFromStealthPrivKey(opts.stealthPrivKey);
    return this.ctx.accountMerge({
      sourceSigner: keypairSigner(keypair),
      destination: opts.destination,
    });
  }

  /** Validate a transfer memo, surfacing failures as {@link MemoError}. */
  private resolveMemo(
    destination: string,
    memo?: TransferMemo,
  ): TransferMemo | undefined {
    try {
      return resolveTransferMemo(destination, memo);
    } catch (err) {
      const risk = memoRiskFor(destination);
      throw new MemoError((err as Error).message, {
        destination,
        custodianName: risk.custodianName,
        cause: err,
      });
    }
  }

  /**
   * Scan announcements for transfers addressed to `identity`, returning each
   * match with its reconstructed one-time key and Stellar account. The caller
   * supplies the announcements (read from the stealth-announcer contract events).
   */
  scan(opts: {
    announcements: StealthAnnouncement[];
    identity: Pick<StealthIdentity, "viewingKey" | "spendingKey">;
  }): ScanMatch[] {
    return scanAnnouncements({
      announcements: opts.announcements,
      viewingKey: opts.identity.viewingKey,
      spendingKey: opts.identity.spendingKey,
    });
  }

  /**
   * Stream announcement matches from chain instead of waiting for the full
   * range to resolve. The scan position persists to the configured `ScanStore`
   * after every page, so a caller can resume later without re-reading (and
   * re-yielding) announcements already delivered. Stop early (`break` out of
   * the `for await`) to release the scan without reading further pages.
   *
   * **Resumption is exact.** The cursor is a ledger, and a page can end partway
   * through one. Matches from the newest ledger seen are therefore held back
   * until a later page (or the end of the scan) shows that ledger is complete,
   * and a cut-short page persists the ledger *before* it. A resumed run re-reads
   * the partly-read ledger in full, so no announcement is skipped and none is
   * yielded twice. The cost is that a match is delivered once the scan has moved
   * past its ledger, rather than the moment its page arrives.
   *
   * The cursor is **per identity** (see {@link scanCursorKey}), so several
   * identities can be watched from one client without one identity's scan
   * resuming past another's.
   *
   * The cursor also advances through ranges that hold no announcements: a page
   * that comes back quiet still counts as scanned, and the last page of a
   * drained scan persists `endLedger`, the end of the whole scanned range rather
   * than just the last transfer in it. Without that, a quiet range would be
   * re-read on every single run, forever.
   *
   * @throws EventTruncationError when the event page cap is hit with events
   * left unread (transfers may be missing). The persisted cursor stays at the
   * last ledger read in full, so the next run resumes exactly there. Pass
   * `allowTruncation` to accept a partial scan instead of failing.
   * @throws RetentionGapError when the scan needs ledgers the RPC has pruned, so
   * some announcements can never be read. Pass `allowRetentionGap` to accept the
   * partial scan; `onRetentionGap` then reports the pruned range.
   */
  async *scanIterator(
    opts: ScanIteratorOptions,
  ): AsyncGenerator<ScanMatch & { ledger: number }> {
    const cursorKey = opts.cursorKey ?? scanCursorKey(opts.identity);
    let startLedger = opts.startLedger;
    if (startLedger == null && !opts.skipCursor) {
      let cursor = await this.ctx.scanStore.getCursor(cursorKey);
      if (cursor == null && opts.cursorKey == null) {
        cursor = await this.migrateLegacyCursor(opts.identity, cursorKey);
      }
      // The stored cursor is the last ledger read in full; resume after it so
      // its events are not re-fetched (`getEvents`' startLedger is inclusive).
      if (cursor != null) startLedger = cursor + 1;
    }

    let held: Array<ScanMatch & { ledger: number }> = [];
    for await (const page of this.ctx.contracts.stealthAnnouncer.scanEvents({
      startLedger,
      maxPages: opts.maxPages,
      throwOnTruncation: !opts.allowTruncation,
    })) {
      if (page.retentionGap) {
        if (!opts.allowRetentionGap) {
          throw new RetentionGapError({
            scope: "stealth-announcer:Announcement",
            ...page.retentionGap,
          });
        }
        opts.onRetentionGap?.(page.retentionGap);
      }

      const ledgerOf = new Map<StealthAnnouncement, number>(
        page.announcements.map((a): [StealthAnnouncement, number] => [a, a.ledger]),
      );
      for (const match of scanAnnouncements({
        announcements: page.announcements,
        viewingKey: opts.identity.viewingKey,
        spendingKey: opts.identity.spendingKey,
      })) {
        held.push({ ...match, ledger: ledgerOf.get(match.announcement) ?? page.ledger });
      }

      // Every ledger before `boundary` has been read in full. A drained scan has
      // read them all; a cut-short page leaves `page.ledger` itself still open.
      const boundary = page.complete ? Number.POSITIVE_INFINITY : page.ledger;
      const ready = held.filter((m) => m.ledger < boundary);
      held = held.filter((m) => m.ledger >= boundary);
      for (const match of ready) yield match;

      if (!opts.skipCursor) {
        // A drained scan read every ledger through `endLedger`, quiet ones
        // included, so persist that and the next run starts after the whole
        // range. A cut-short page proves only the ledgers before `page.ledger`.
        await this.ctx.scanStore.setCursor(
          page.complete ? page.endLedger : page.ledger - 1,
          cursorKey,
        );
      }
    }
  }

  /**
   * One-time move of a cursor saved under the pre-#1076 key to
   * {@link scanCursorKey}. The legacy key is read through the store the caller
   * already gave the SDK, then deleted where the store supports it, so it is
   * never written again. Returns the migrated cursor, or null when none exists.
   */
  private async migrateLegacyCursor(
    identity: Pick<StealthIdentity, "viewingKey">,
    cursorKey: string,
  ): Promise<number | null> {
    const store = this.ctx.scanStore;
    const legacyKey = legacyScanCursorKey(identity);
    const legacy = await store.getCursor(legacyKey);
    if (legacy == null) return null;
    await store.setCursor(legacy, cursorKey);
    await store.deleteCursor?.(legacyKey);
    return legacy;
  }
}

/** Options for {@link PaymentsService.scanIterator}. */
export interface ScanIteratorOptions {
  identity: Pick<StealthIdentity, "viewingKey" | "spendingKey">;
  /** Resume from this ledger instead of the persisted cursor. */
  startLedger?: number;
  /** Skip reading/writing the persisted cursor (default false). */
  skipCursor?: boolean;
  /**
   * Cursor key to persist under. Defaults to this identity's own key
   * ({@link scanCursorKey}); override only to share one cursor across
   * identities that scan the same range.
   */
  cursorKey?: string;
  /** Event page cap before the scan is treated as truncated (default 200). */
  maxPages?: number;
  /**
   * Return a partial scan instead of throwing {@link EventTruncationError} when
   * the page cap is hit (default false). Only safe when the caller can detect
   * the gap some other way — a truncated scan may have missed transfers. Matches
   * from the last ledger reached are not yielded in that case; the next run
   * delivers them, because that ledger is re-read in full.
   */
  allowTruncation?: boolean;
  /**
   * Accept a scan that needs ledgers the RPC has pruned (default false). Without
   * it, such a scan throws {@link RetentionGapError}. A stale persisted cursor,
   * older than the retention window, hits this too; pass `startLedger` to start
   * from a retained ledger instead.
   */
  allowRetentionGap?: boolean;
  /** Called with the pruned range when {@link allowRetentionGap} lets the scan continue. */
  onRetentionGap?: (gap: RetentionGap) => void;
}
