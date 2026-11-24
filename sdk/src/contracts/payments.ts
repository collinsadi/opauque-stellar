/**
 * Bindings for the stealth-registry and stealth-announcer contracts: publish a
 * meta-address and announce a one-time stealth transfer.
 */
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import type { ContractInvoker } from "../rpc/client";
import type { OpaqueSigner } from "../signer/index";
import { addressToScVal, bytesToScVal, u64ToScVal } from "../rpc/scval";
import { paginateContractEvents, type RetentionGap } from "../rpc/events";
import type { StealthAnnouncement } from "../crypto/index";
import { assertValidStealthMetaAddress } from "../crypto/dksap";

/** secp256k1 stealth scheme id, as registered on-chain. */
export const SCHEME_ID_SECP256K1 = 1n;

const ANNOUNCEMENT_EVENT_LOOKBACK = 16_000;
const ANNOUNCEMENT_TOPIC = xdr.ScVal.scvSymbol("Announcement").toXDR("base64");

/** A decoded announcement, tagged with the ledger it was emitted in. */
export interface LedgerAnnouncement extends StealthAnnouncement {
  /** Ledger the `Announcement` event belongs to. */
  ledger: number;
}

/** A page of `Announcement` events, plus how far the scan can be trusted to have read. */
export interface AnnouncementPage {
  /**
   * Announcements decoded from this page, each tagged with its own ledger.
   * Empty for a page over a quiet ledger range — such pages are yielded too, so
   * a caller can advance a persisted cursor past a range that holds no transfers
   * instead of rescanning it on every run.
   */
  announcements: LedgerAnnouncement[];
  /**
   * Highest ledger represented in `announcements`. That ledger may be only
   * partly read: a later page can still add its announcements (the scan's start
   * ledger for a quiet page).
   */
  ledger: number;
  /**
   * Highest ledger this scan has read through. Set on the last page of a
   * drained scan, where it can be well past {@link ledger}: the quiet ledgers
   * after the final announcement were read too. Persist a cursor from this
   * value (`cursor + 1` on resume) to skip exactly the range already scanned.
   */
  endLedger: number;
  /** True on the last page of a fully drained scan — nothing was left unread. */
  complete: boolean;
  /**
   * True when the page cap stopped the scan with events still unread: this
   * scan is **incomplete** and transfers may have been missed. Resume with
   * `continuationCursor`, or from the ledger before {@link ledger} on a later scan.
   */
  truncated: boolean;
  /** Opaque `getEvents` cursor to continue the truncated scan from. */
  continuationCursor?: string;
  /**
   * Ledgers skipped because the RPC has pruned them. Set from the first page the
   * clamp affects onward; absent when the requested start was retained.
   */
  retentionGap?: RetentionGap;
}

/** Options for {@link StealthAnnouncer.scanEvents}. */
export interface ScanEventsOptions {
  /** First ledger to read (inclusive). Defaults to a lookback window. */
  startLedger?: number;
  /** Page cap before the scan reports truncation (default `EVENT_PAGE_LIMIT`). */
  maxPages?: number;
  /**
   * Raise `EventTruncationError` at the page cap instead of yielding a
   * final page marked `truncated` (default false). Either way the scan says so;
   * this only chooses how.
   */
  throwOnTruncation?: boolean;
}

export class StealthRegistry {
  constructor(
    private readonly rpc: ContractInvoker,
    readonly contractId: string,
  ) {}

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

  /** Register a stealth meta-address for the signer's account. */
  async registerKeys(opts: {
    stealthMetaAddress: Uint8Array;
    schemeId?: bigint;
    signer: OpaqueSigner;
  }): Promise<string> {
    // Reject a malformed/off-curve key before it ever reaches the chain
    // (#736). The on-chain registry only checks length + prefix byte; a
    // garbage key that passes that check would register successfully and
    // be silently unusable to anyone who later tries to send to it.
    assertValidStealthMetaAddress(opts.stealthMetaAddress);
    const source = await opts.signer.publicKey();
    return this.rpc.invoke({
      source,
      contractId: this.contractId,
      method: "register_keys",
      contractPackage: "stealth-registry",
      args: [
        addressToScVal(source),
        u64ToScVal(opts.schemeId ?? SCHEME_ID_SECP256K1),
        bytesToScVal(opts.stealthMetaAddress),
      ],
      signer: opts.signer,
    });
  }

  /**
   * Resolve a registered G-address to its stealth meta-address.
   *
   * Returns the meta-address bytes if the address has registered keys,
   * or `null` if no registration exists.
   */
  async resolve(opts: {
    address: string;
    source: string;
  }): Promise<Uint8Array | null> {
    try {
      const result = await this.rpc.readNative<Uint8Array>({
        source: opts.source,
        contractId: this.contractId,
        method: "resolve",
        args: [addressToScVal(opts.address)],
      });
      return result ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve a registered G-address at a historical ledger.
   *
   * Returns the meta-address bytes if the address had registered keys
   * at the given ledger, or `null` otherwise.
   */
  async resolveHistorical(opts: {
    address: string;
    source: string;
    ledger: number;
  }): Promise<Uint8Array | null> {
    try {
      const result = await this.rpc.readNative<Uint8Array>({
        source: opts.source,
        contractId: this.contractId,
        method: "resolve_historical",
        args: [addressToScVal(opts.address), u64ToScVal(BigInt(opts.ledger))],
      });
      return result ?? null;
    } catch {
      return null;
    }
  }
}

export class StealthAnnouncer {
  constructor(
    private readonly rpc: ContractInvoker,
    readonly contractId: string,
  ) {}

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

  /** Announce a one-time stealth transfer (stealth id + ephemeral key + view tag). */
  async announce(opts: {
    stealthAddress: Uint8Array;
    ephemeralPubKey: Uint8Array;
    metadata: Uint8Array;
    schemeId?: bigint;
    signer: OpaqueSigner;
  }): Promise<string> {
    const source = await opts.signer.publicKey();
    return this.rpc.invoke({
      source,
      contractId: this.contractId,
      method: "announce",
      contractPackage: "stealth-announcer",
      args: [
        addressToScVal(source),
        u64ToScVal(opts.schemeId ?? SCHEME_ID_SECP256K1),
        bytesToScVal(opts.stealthAddress),
        bytesToScVal(opts.ephemeralPubKey),
        bytesToScVal(opts.metadata),
      ],
      signer: opts.signer,
    });
  }

  /**
   * Stream `Announcement` events page-by-page instead of resolving only after
   * scanning the full range. `startLedger` is inclusive (as with the
   * underlying `getEvents` call) — pass `endLedger + 1` from a completed page
   * to resume without re-reading (and re-yielding) its events.
   *
   * One page is yielded per `getEvents` response, quiet ones included, so a
   * scan over a range with no transfers still reports how far it read: take
   * `endLedger` from the page with `complete: true` and a cursor persisted from
   * it resumes after the whole scanned range.
   *
   * Stopping iteration early (`break` in a `for await`, or calling `.return()`)
   * stops further `getEvents` calls — no dangling requests keep running after
   * the consumer walks away.
   */
  async *scanEvents(opts?: ScanEventsOptions): AsyncGenerator<AnnouncementPage, void, unknown> {
    const filters = [
      {
        type: "contract" as const,
        contractIds: [this.contractId],
        topics: [[ANNOUNCEMENT_TOPIC, "*"]],
      },
    ];

    for await (const page of paginateContractEvents({
      invoker: this.rpc,
      filters,
      scope: "stealth-announcer:Announcement",
      startLedger: opts?.startLedger,
      lookback: ANNOUNCEMENT_EVENT_LOOKBACK,
      maxPages: opts?.maxPages,
      throwOnTruncation: opts?.throwOnTruncation,
    })) {
      const announcements: LedgerAnnouncement[] = [];
      for (const ev of page.events) {
        const data = scValToNative(ev.value) as unknown[];
        const stealthAddress = Buffer.from(data[1] as Uint8Array).toString("hex");
        const ephemeralPubKey = Uint8Array.from(data[3] as Uint8Array);
        const metadata = data[4] as Uint8Array;
        announcements.push({
          stealthAddress: "0x" + stealthAddress,
          ephemeralPubKey,
          viewTag: metadata[0] ?? 0,
          ledger: Number(ev.ledger),
        });
      }
      yield {
        announcements,
        ledger: page.ledger,
        endLedger: page.endLedger,
        complete: page.complete,
        truncated: page.truncated,
        continuationCursor: page.continuationCursor,
        retentionGap: page.retentionGap,
      };
    }
  }
}
