/**
 * Event-scan bounds and per-identity cursors (issues #1004, #1007).
 *
 * Two failure modes are pinned here, both of which used to be invisible:
 *  - a scan that hits the page cap used to stop silently, so a truncated read
 *    (missed stealth payment, or a Merkle tree with holes in it) looked exactly
 *    like a complete one;
 *  - the scan cursor used to be a single number shared by every identity on a
 *    client, so scanning identity A could move identity B's position past B's
 *    own payments.
 *
 * Driven entirely through a stub invoker - no network, no test run required.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Keypair, rpc, xdr } from "@stellar/stellar-sdk";
import {
  OpaqueClient,
  keypairSigner,
  EventTruncationError,
  MemoryScanStore,
  paginateContractEvents,
  scanCursorKey,
  addressToScVal,
  bytesToScVal,
  u64ToScVal,
  hexToBytes,
  computeStealthAddressAndViewTag,
  type ContractInvoker,
  type InvokeOptions,
  type ReadOptions,
} from "../../src/index";

const PK = Keypair.random().publicKey();
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

class StubInvoker implements ContractInvoker {
  last?: InvokeOptions;
  eventPages: (rpc.Api.GetEventsResponse | Error)[] = [];
  eventsCallCount = 0;
  eventsRequests: rpc.Server.GetEventsRequest[] = [];
  latestLedgerValue = 0;
  reads: Record<string, unknown> = {};

  async invoke(opts: InvokeOptions): Promise<string> {
    this.last = opts;
    return "TXHASH";
  }
  async readNative<T>(opts: ReadOptions): Promise<T> {
    if (opts.method in this.reads) return this.reads[opts.method] as T;
    throw new Error(`unstubbed read: ${opts.method}`);
  }
  async simulateRead(): Promise<xdr.ScVal | undefined> {
    return undefined;
  }
  async getEvents(request: rpc.Server.GetEventsRequest): Promise<rpc.Api.GetEventsResponse> {
    this.eventsCallCount++;
    this.eventsRequests.push(request);
    const next = this.eventPages.shift();
    if (next instanceof Error) throw next;
    return (
      next ?? ({ events: [], latestLedger: this.latestLedgerValue, cursor: "" } as unknown as rpc.Api.GetEventsResponse)
    );
  }
  async getLatestLedger(): Promise<number> {
    return this.latestLedgerValue;
  }
}

/** A page with one event, an advancing cursor, and a reported latest ledger. */
const page = (ledger: number, cursor: string): rpc.Api.GetEventsResponse =>
  ({
    events: [
      {
        value: xdr.ScVal.scvVec([
          u64ToScVal(1n),
          bytesToScVal(bytes(20, ledger % 251)),
          addressToScVal(PK),
          bytesToScVal(bytes(33, 2)),
          bytesToScVal(new Uint8Array([1])),
        ]),
        ledger,
      },
    ],
    latestLedger: ledger,
    cursor,
  }) as unknown as rpc.Api.GetEventsResponse;

const quietPage = (latestLedger: number): rpc.Api.GetEventsResponse =>
  ({ events: [], latestLedger, cursor: "" }) as unknown as rpc.Api.GetEventsResponse;

const announcementFilters = [
  {
    type: "contract" as const,
    contractIds: ["CANNOUNCE"],
    topics: [["Announcement", "*"]],
  },
];

/** An on-chain `Announcement` event for `stealthAddress`, at `ledger`. */
const announcement = (opts: {
  stealthAddress: string;
  ephemeralPubKey: Uint8Array;
  viewTag: number;
  ledger: number;
}): rpc.Api.EventResponse =>
  ({
    value: xdr.ScVal.scvVec([
      u64ToScVal(1n),
      bytesToScVal(hexToBytes(opts.stealthAddress)),
      addressToScVal(PK),
      bytesToScVal(opts.ephemeralPubKey),
      bytesToScVal(new Uint8Array([opts.viewTag])),
    ]),
    ledger: opts.ledger,
  }) as unknown as rpc.Api.EventResponse;

let inv: StubInvoker;
beforeEach(() => {
  inv = new StubInvoker();
});

describe("paginateContractEvents", () => {
  it("throws a typed EventTruncationError with a resume cursor at the page cap", async () => {
    inv.eventPages = [page(100, "c1"), page(200, "c2"), page(300, "c3")];

    const read = async () => {
      for await (const _p of paginateContractEvents({
        invoker: inv,
        filters: announcementFilters,
        scope: "stealth-announcer:Announcement",
        startLedger: 1,
        maxPages: 2,
        throwOnTruncation: true,
      })) {
        // consume
      }
    };

    await expect(read()).rejects.toBeInstanceOf(EventTruncationError);
    expect(inv.eventsCallCount).toBe(2);
  });

  it("carries the resume cursor and last scanned ledger on the error", async () => {
    inv.eventPages = [page(100, "c1"), page(200, "c2"), page(300, "c3")];

    const error = await (async () => {
      try {
        for await (const _p of paginateContractEvents({
          invoker: inv,
          filters: announcementFilters,
          scope: "privacy-pool:Deposit",
          startLedger: 1,
          maxPages: 2,
          throwOnTruncation: true,
        })) {
          // consume
        }
        return null;
      } catch (err) {
        return err as EventTruncationError;
      }
    })();

    expect(error).toBeInstanceOf(EventTruncationError);
    expect(error!.code).toBe("EVENT_TRUNCATION");
    expect(error!.scope).toBe("privacy-pool:Deposit");
    expect(error!.pagesRead).toBe(2);
    expect(error!.continuationCursor).toBe("c2");
    // Ledger 200 may be only partly read (its events continue on the next page),
    // so the last ledger known to be complete is 199.
    expect(error!.lastScannedLedger).toBe(199);
  });

  it("yields a truncated marker page instead of throwing when asked to", async () => {
    inv.eventPages = [page(100, "c1"), page(200, "c2"), page(300, "c3")];

    const pages = [];
    for await (const p of paginateContractEvents({
      invoker: inv,
      filters: announcementFilters,
      scope: "privacy-pool:Deposit",
      startLedger: 1,
      maxPages: 2,
    })) {
      pages.push(p);
    }

    expect(pages.length).toBe(2);
    expect(pages[1].truncated).toBe(true);
    expect(pages[1].complete).toBe(false);
    expect(pages[1].continuationCursor).toBe("c2");
    expect(pages[1].ledger).toBe(200);
  });

  it("reports a drained scan as complete, with endLedger past a quiet tail", async () => {
    inv.eventPages = [page(100, "c1"), quietPage(500)];

    const pages = [];
    for await (const p of paginateContractEvents({
      invoker: inv,
      filters: announcementFilters,
      scope: "stealth-announcer:Announcement",
      startLedger: 1,
    })) {
      pages.push(p);
    }

    expect(pages.length).toBe(2);
    expect(pages[1].complete).toBe(true);
    expect(pages[1].truncated).toBe(false);
    // The last page held no events, but the scan still read through ledger 500.
    expect(pages[1].endLedger).toBe(500);
  });
});

describe("per-identity scan cursors", () => {
  it("MemoryScanStore keeps one cursor per identity and an unkeyed default", async () => {
    const store = new MemoryScanStore();
    expect(await store.getCursor()).toBeNull();
    await store.setCursor(10, "vk:aa");
    await store.setCursor(20, "vk:bb");
    expect(await store.getCursor("vk:aa")).toBe(10);
    expect(await store.getCursor("vk:bb")).toBe(20);
    expect(await store.getCursor()).toBeNull();
    await store.setCursor(5);
    expect(await store.getCursor()).toBe(5);
  });

  it("scanCursorKey is stable per viewing key and distinct across identities", () => {
    const a = scanCursorKey({ viewingKey: bytes(32, 1) });
    const b = scanCursorKey({ viewingKey: bytes(32, 2) });
    expect(a).toBe(scanCursorKey({ viewingKey: bytes(32, 1) }));
    expect(a).not.toBe(b);
  });
});

describe("PaymentsService.scanIterator", () => {
  it("advances the cursor past a quiet range so the next run does not rescan it", async () => {
    const client = new OpaqueClient({
      network: "testnet",
      signer: keypairSigner(Keypair.random()),
      invoker: inv,
    });
    const identity = client.payments.deriveIdentity("0x" + "11".repeat(64));
    const mine = computeStealthAddressAndViewTag(identity.metaHex);

    // One announcement at ledger 100, then a quiet run up to ledger 900.
    inv.eventPages = [
      {
        events: [announcement({ ...mine, ledger: 100 })],
        latestLedger: 100,
        cursor: "page1",
      } as unknown as rpc.Api.GetEventsResponse,
      quietPage(900),
    ];
    inv.latestLedgerValue = 900;

    const first = [];
    for await (const match of client.payments.scanIterator({ identity })) first.push(match);
    expect(first.length).toBe(1);
    // Persisted end-of-scan, not the last transfer's ledger: a cursor at 100
    // would re-read ledgers 101..900 on every future run.
    expect(await client.scanStore.getCursor(scanCursorKey(identity))).toBe(900);

    // Second run starts after 900, so the quiet range is never re-read.
    inv.eventPages = [
      {
        events: [announcement({ ...mine, ledger: 1000 })],
        latestLedger: 1000,
        cursor: "",
      } as unknown as rpc.Api.GetEventsResponse,
    ];
    inv.latestLedgerValue = 1000;
    const second = [];
    for await (const match of client.payments.scanIterator({ identity })) second.push(match);
    expect(second.length).toBe(1);
    expect(second[0].ledger).toBe(1000);
    const lastRequest = inv.eventsRequests[inv.eventsRequests.length - 1] as { startLedger?: number };
    expect(lastRequest.startLedger).toBe(901);
  });

  it("keeps identities independent: scanning one does not skip the other's payments", async () => {
    const client = new OpaqueClient({
      network: "testnet",
      signer: keypairSigner(Keypair.random()),
      invoker: inv,
    });
    const alice = client.payments.deriveIdentity("0x" + "aa".repeat(64));
    const bob = client.payments.deriveIdentity("0x" + "bb".repeat(64));
    const toAlice = computeStealthAddressAndViewTag(alice.metaHex);
    const toBob = computeStealthAddressAndViewTag(bob.metaHex);

    inv.latestLedgerValue = 300;
    inv.eventPages = [
      {
        events: [announcement({ ...toAlice, ledger: 100 })],
        latestLedger: 100,
        cursor: "",
      } as unknown as rpc.Api.GetEventsResponse,
    ];
    for await (const _m of client.payments.scanIterator({ identity: alice })) {
      // consume
    }
    expect(await client.scanStore.getCursor(scanCursorKey(alice))).toBe(300);
    expect(await client.scanStore.getCursor(scanCursorKey(bob))).toBeNull();

    // Bob's scan still starts at the beginning of the range, so a payment sent
    // to Bob inside ledgers Alice already passed is not skipped.
    inv.eventPages = [
      {
        events: [announcement({ ...toBob, ledger: 200 })],
        latestLedger: 300,
        cursor: "",
      } as unknown as rpc.Api.GetEventsResponse,
    ];
    const bobMatches = [];
    for await (const match of client.payments.scanIterator({ identity: bob })) {
      bobMatches.push(match);
    }
    expect(bobMatches.length).toBe(1);
    expect(bobMatches[0].stealthStellarAddress).toBe(toBob.stealthStellarAddress);
    const bobRequest = inv.eventsRequests[inv.eventsRequests.length - 1] as { startLedger?: number };
    expect(bobRequest.startLedger).toBe(1);
  });

  it("fails loudly on a truncated scan, leaving the cursor at the last full page", async () => {
    const client = new OpaqueClient({
      network: "testnet",
      signer: keypairSigner(Keypair.random()),
      invoker: inv,
    });
    const identity = client.payments.deriveIdentity("0x" + "cc".repeat(64));
    const mine = computeStealthAddressAndViewTag(identity.metaHex);

    inv.latestLedgerValue = 10_000;
    inv.eventPages = [
      {
        events: [announcement({ ...mine, ledger: 100 })],
        latestLedger: 100,
        cursor: "page1",
      } as unknown as rpc.Api.GetEventsResponse,
      {
        events: [announcement({ ...mine, ledger: 200 })],
        latestLedger: 200,
        cursor: "page2",
      } as unknown as rpc.Api.GetEventsResponse,
      quietPage(10_000),
    ];

    const read = async () => {
      const matches = [];
      for await (const match of client.payments.scanIterator({
        identity,
        maxPages: 2,
      })) {
        matches.push(match);
      }
      return matches;
    };

    await expect(read()).rejects.toBeInstanceOf(EventTruncationError);
    // Ledger 100 was only partly read when the cap hit, so the cursor stops
    // before it. Resuming then re-reads ledger 100 in full (issue #1075).
    expect(await client.scanStore.getCursor(scanCursorKey(identity))).toBe(99);
  });

  it("can be asked for a partial scan instead of failing", async () => {
    const client = new OpaqueClient({
      network: "testnet",
      signer: keypairSigner(Keypair.random()),
      invoker: inv,
    });
    const identity = client.payments.deriveIdentity("0x" + "dd".repeat(64));
    const mine = computeStealthAddressAndViewTag(identity.metaHex);

    inv.latestLedgerValue = 10_000;
    inv.eventPages = [
      {
        events: [announcement({ ...mine, ledger: 100 })],
        latestLedger: 100,
        cursor: "page1",
      } as unknown as rpc.Api.GetEventsResponse,
      {
        events: [announcement({ ...mine, ledger: 200 })],
        latestLedger: 200,
        cursor: "page2",
      } as unknown as rpc.Api.GetEventsResponse,
    ];

    const matches = [];
    for await (const match of client.payments.scanIterator({
      identity,
      maxPages: 2,
      allowTruncation: true,
    })) {
      matches.push(match);
    }
    // The match from ledger 100 is complete (the scan moved on to 200). The match
    // from ledger 200 was only partly read, so it waits for the next run, which
    // re-reads ledger 200 in full. Nothing is lost and nothing is yielded twice.
    expect(matches.length).toBe(1);
    expect(matches[0].ledger).toBe(100);
    expect(await client.scanStore.getCursor(scanCursorKey(identity))).toBe(199);
  });
});
