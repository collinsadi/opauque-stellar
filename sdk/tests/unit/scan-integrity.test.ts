/**
 * Scan integrity (issues #1074, #1075, #1076).
 *
 *  - #1074: a start ledger the RPC has pruned is reported as a retention gap,
 *    never silently restarted from; the pool reconstruction refuses to build
 *    leaves across it unless asked to.
 *  - #1075: resumption is exact across a page boundary that splits one ledger,
 *    and an event the RPC repeats is counted once.
 *  - #1076: scan cursor keys are one-way over public material, and a cursor saved
 *    under the old private-key-derived key migrates once.
 *
 * Driven through a stub invoker, so no network and no test run against a live RPC.
 */
import { describe, it, expect } from "vitest";
import { Keypair, rpc, xdr } from "@stellar/stellar-sdk";
import {
  OpaqueClient,
  keypairSigner,
  MemoryScanStore,
  PrivacyPool,
  RetentionGapError,
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
const PRUNED_RANGE_ERROR = "startLedger must be within the ledger range: 900 - 2000";

class RetentionStub implements ContractInvoker {
  /** Canned responses consumed in order; an `Error` entry is thrown instead. */
  eventPages: (rpc.Api.GetEventsResponse | Error)[] = [];
  requests: rpc.Server.GetEventsRequest[] = [];
  latestLedgerValue = 0;

  async invoke(_opts: InvokeOptions): Promise<string> {
    return "TXHASH";
  }
  async readNative<T>(_opts: ReadOptions): Promise<T> {
    throw new Error("unstubbed read");
  }
  async simulateRead(): Promise<xdr.ScVal | undefined> {
    return undefined;
  }
  async getEvents(request: rpc.Server.GetEventsRequest): Promise<rpc.Api.GetEventsResponse> {
    this.requests.push(request);
    const next = this.eventPages.shift();
    if (next instanceof Error) throw next;
    return (
      next ??
      ({ events: [], latestLedger: this.latestLedgerValue, cursor: "" } as unknown as rpc.Api.GetEventsResponse)
    );
  }
  async getLatestLedger(): Promise<number> {
    return this.latestLedgerValue;
  }
}

const pageOf = (events: rpc.Api.EventResponse[], latestLedger: number, cursor: string) =>
  ({ events, latestLedger, cursor }) as unknown as rpc.Api.GetEventsResponse;

/** An `Announcement` event for a stealth identity, at `ledger`, with an optional event id. */
const announcement = (opts: {
  stealthAddress: string;
  ephemeralPubKey: Uint8Array;
  viewTag: number;
  ledger: number;
  id?: string;
}): rpc.Api.EventResponse =>
  ({
    id: opts.id,
    value: xdr.ScVal.scvVec([
      u64ToScVal(1n),
      bytesToScVal(hexToBytes(opts.stealthAddress)),
      addressToScVal(PK),
      bytesToScVal(opts.ephemeralPubKey),
      bytesToScVal(new Uint8Array([opts.viewTag])),
    ]),
    ledger: opts.ledger,
  }) as unknown as rpc.Api.EventResponse;

/** A pool `Deposit` event: commitment bytes and its state-tree index. */
const depositEvent = (opts: { ledger: number; index: number; id?: string }): rpc.Api.EventResponse =>
  ({
    id: opts.id,
    value: xdr.ScVal.scvVec([bytesToScVal(new Uint8Array(32).fill(3)), u64ToScVal(BigInt(opts.index))]),
    ledger: opts.ledger,
  }) as unknown as rpc.Api.EventResponse;

const newClient = (inv: ContractInvoker, scan?: MemoryScanStore) =>
  new OpaqueClient({
    network: "testnet",
    signer: keypairSigner(Keypair.random()),
    invoker: inv,
    ...(scan ? { storage: { scan } } : {}),
  });

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("retention clamps (#1074)", () => {
  it("paginateContractEvents reports the pruned range on the page it clamps", async () => {
    const inv = new RetentionStub();
    inv.eventPages = [new Error(PRUNED_RANGE_ERROR), pageOf([], 950, "")];

    const pages = await collect(
      paginateContractEvents({ invoker: inv, filters: [], scope: "test:scope", startLedger: 1 }),
    );

    expect(pages.length).toBe(1);
    expect(pages[0].retentionGap).toEqual({ fromLedger: 1, toLedger: 899 });
    expect(pages[0].complete).toBe(true);
  });

  it("paginateContractEvents reports no gap when the requested start is retained", async () => {
    const inv = new RetentionStub();
    inv.eventPages = [pageOf([], 950, "")];

    const pages = await collect(
      paginateContractEvents({ invoker: inv, filters: [], scope: "test:scope", startLedger: 950 }),
    );

    expect(pages[0].retentionGap).toBeUndefined();
  });

  it("scanIterator refuses to start in pruned history by default", async () => {
    const inv = new RetentionStub();
    inv.latestLedgerValue = 1000;
    inv.eventPages = [new Error(PRUNED_RANGE_ERROR), pageOf([], 1000, "")];
    const client = newClient(inv);
    const identity = client.payments.deriveIdentity("0x" + "11".repeat(64));

    const run = collect(client.payments.scanIterator({ identity, startLedger: 1 }));
    await expect(run).rejects.toBeInstanceOf(RetentionGapError);
    await expect(run).rejects.toMatchObject({
      code: "EVENT_RETENTION_GAP",
      fromLedger: 1,
      toLedger: 899,
    });
  });

  it("scanIterator continues past a pruned range when allowed, and reports the range", async () => {
    const inv = new RetentionStub();
    inv.latestLedgerValue = 1000;
    const client = newClient(inv);
    const identity = client.payments.deriveIdentity("0x" + "22".repeat(64));
    const mine = computeStealthAddressAndViewTag(identity.metaHex);
    inv.eventPages = [
      new Error(PRUNED_RANGE_ERROR),
      pageOf([announcement({ ...mine, ledger: 950, id: "evt-1" })], 1000, ""),
    ];

    const gaps: { fromLedger: number; toLedger: number }[] = [];
    const matches = await collect(
      client.payments.scanIterator({
        identity,
        startLedger: 1,
        allowRetentionGap: true,
        onRetentionGap: (gap) => gaps.push(gap),
      }),
    );

    expect(matches.length).toBe(1);
    expect(matches[0].ledger).toBe(950);
    expect(gaps).toEqual([{ fromLedger: 1, toLedger: 899 }]);
  });

  it("PrivacyPool.reconstructState refuses leaves built across pruned history by default", async () => {
    const inv = new RetentionStub();
    inv.latestLedgerValue = 1000;
    // Deposit topic: clamped on the first request, then drained. Withdraw: drained.
    inv.eventPages = [new Error(PRUNED_RANGE_ERROR), pageOf([], 1000, ""), pageOf([], 1000, "")];
    const pool = new PrivacyPool(inv, "CPOOL");

    await expect(pool.reconstructState()).rejects.toBeInstanceOf(RetentionGapError);
  });

  it("PrivacyPool.reconstructState with allowRetentionGap flags the result incomplete", async () => {
    const inv = new RetentionStub();
    inv.latestLedgerValue = 1000;
    inv.eventPages = [
      new Error(PRUNED_RANGE_ERROR),
      pageOf([depositEvent({ ledger: 950, index: 0 })], 1000, ""),
      pageOf([], 1000, ""),
    ];
    const pool = new PrivacyPool(inv, "CPOOL");

    const state = await pool.reconstructState({ allowRetentionGap: true });

    expect(state.complete).toBe(false);
    expect(state.retentionGap).toEqual({ fromLedger: 1, toLedger: 899 });
    expect(state.stateLeaves.length).toBe(1);
  });

  it("reconstructState starts from ledger 1 by default, not from a fixed lookback", async () => {
    const inv = new RetentionStub();
    inv.latestLedgerValue = 1_000_000;
    inv.eventPages = [pageOf([], 1_000_000, ""), pageOf([], 1_000_000, "")];
    const pool = new PrivacyPool(inv, "CPOOL");

    await pool.reconstructState();

    expect(inv.requests[0]).toMatchObject({ startLedger: 1 });
  });
});

describe("exact resumption across a split ledger (#1075)", () => {
  it("splits one ledger's events across pages and loses none", async () => {
    const inv = new RetentionStub();
    const client = newClient(inv);
    const identity = client.payments.deriveIdentity("0x" + "55".repeat(64));
    const a = computeStealthAddressAndViewTag(identity.metaHex);
    const b = computeStealthAddressAndViewTag(identity.metaHex);
    const c = computeStealthAddressAndViewTag(identity.metaHex);
    const d = computeStealthAddressAndViewTag(identity.metaHex);
    inv.latestLedgerValue = 101;
    inv.eventPages = [
      pageOf(
        [
          announcement({ ...a, ledger: 100, id: "e-a" }),
          announcement({ ...b, ledger: 100, id: "e-b" }),
        ],
        100,
        "c1",
      ),
      pageOf(
        [
          announcement({ ...c, ledger: 100, id: "e-c" }),
          announcement({ ...d, ledger: 101, id: "e-d" }),
        ],
        101,
        "",
      ),
    ];

    const matches = await collect(client.payments.scanIterator({ identity }));

    expect(matches.map((m) => m.stealthStellarAddress)).toEqual(
      [a, b, c, d].map((x) => x.stealthStellarAddress),
    );
    expect(matches.map((m) => m.ledger)).toEqual([100, 100, 100, 101]);
    expect(await client.scanStore.getCursor(scanCursorKey(identity))).toBe(101);
  });

  it("a run cut short mid-ledger resumes and delivers that ledger exactly once", async () => {
    const inv = new RetentionStub();
    const scan = new MemoryScanStore();
    const client = newClient(inv, scan);
    const identity = client.payments.deriveIdentity("0x" + "66".repeat(64));
    const a = computeStealthAddressAndViewTag(identity.metaHex);
    const b = computeStealthAddressAndViewTag(identity.metaHex);
    const c = computeStealthAddressAndViewTag(identity.metaHex);
    const evA = announcement({ ...a, ledger: 100, id: "e-a" });
    const evB = announcement({ ...b, ledger: 100, id: "e-b" });
    const evC = announcement({ ...c, ledger: 100, id: "e-c" });

    // Run 1: the page cap cuts the scan partway through ledger 100.
    inv.latestLedgerValue = 100;
    inv.eventPages = [pageOf([evA, evB], 100, "c1")];
    const first = await collect(
      client.payments.scanIterator({ identity, maxPages: 1, allowTruncation: true }),
    );
    expect(first.length).toBe(0);
    // Ledger 100 is not done, so the cursor stops before it.
    expect(await scan.getCursor(scanCursorKey(identity))).toBe(99);

    // Run 2: resumes at ledger 100 and re-reads it in full.
    inv.eventPages = [pageOf([evA, evB, evC], 100, "")];
    const second = await collect(client.payments.scanIterator({ identity }));

    expect(second.map((m) => m.stealthStellarAddress)).toEqual(
      [a, b, c].map((x) => x.stealthStellarAddress),
    );
    expect(inv.requests[inv.requests.length - 1]).toMatchObject({ startLedger: 100 });
  });

  it("an event the RPC repeats is counted once", async () => {
    const inv = new RetentionStub();
    const client = newClient(inv);
    const identity = client.payments.deriveIdentity("0x" + "77".repeat(64));
    const a = computeStealthAddressAndViewTag(identity.metaHex);
    const b = computeStealthAddressAndViewTag(identity.metaHex);
    const c = computeStealthAddressAndViewTag(identity.metaHex);
    inv.latestLedgerValue = 101;
    inv.eventPages = [
      pageOf(
        [
          announcement({ ...a, ledger: 100, id: "e-a" }),
          announcement({ ...b, ledger: 101, id: "e-b" }),
        ],
        101,
        "c1",
      ),
      pageOf(
        [
          announcement({ ...a, ledger: 100, id: "e-a" }),
          announcement({ ...c, ledger: 101, id: "e-c" }),
        ],
        101,
        "",
      ),
    ];

    const matches = await collect(client.payments.scanIterator({ identity }));

    expect(matches.map((m) => m.stealthStellarAddress)).toEqual(
      [a, b, c].map((x) => x.stealthStellarAddress),
    );
  });
});

describe("scan cursor keys are one-way (#1076)", () => {
  it("a cursor key is a domain-separated hash that carries no viewing-key bytes", () => {
    const client = newClient(new RetentionStub());
    const identity = client.payments.deriveIdentity("0x" + "88".repeat(64));
    const viewingKeyHex = Buffer.from(identity.viewingKey).toString("hex");

    const key = scanCursorKey(identity);

    expect(key).toMatch(/^sc1:[0-9a-f]{64}$/);
    expect(key).not.toContain(viewingKeyHex);
  });

  it("a scan writes only derived keys to the ScanStore, never the viewing key", async () => {
    class RecordingScanStore extends MemoryScanStore {
      readonly writtenKeys: string[] = [];
      async setCursor(ledger: number, identity = ""): Promise<void> {
        this.writtenKeys.push(identity);
        return super.setCursor(ledger, identity);
      }
    }
    const inv = new RetentionStub();
    const scan = new RecordingScanStore();
    const client = newClient(inv, scan);
    const identity = client.payments.deriveIdentity("0x" + "99".repeat(64));
    const viewingKeyHex = Buffer.from(identity.viewingKey).toString("hex");
    inv.latestLedgerValue = 500;
    inv.eventPages = [pageOf([], 500, "")];

    await collect(client.payments.scanIterator({ identity }));

    expect(scan.writtenKeys.length).toBeGreaterThan(0);
    for (const key of scan.writtenKeys) expect(key).not.toContain(viewingKeyHex);
  });

  it("a cursor saved under the legacy key migrates once, and the legacy entry is removed", async () => {
    const scan = new MemoryScanStore();
    const inv = new RetentionStub();
    const client = newClient(inv, scan);
    const identity = client.payments.deriveIdentity("0x" + "aa".repeat(64));
    const legacyKey = `vk:${Buffer.from(identity.viewingKey).toString("hex")}`;
    await scan.setCursor(500, legacyKey);
    inv.latestLedgerValue = 600;
    inv.eventPages = [pageOf([], 600, "")];

    await collect(client.payments.scanIterator({ identity }));

    // Resumed after the migrated cursor, not from the lookback.
    expect(inv.requests[0]).toMatchObject({ startLedger: 501 });
    expect(await scan.getCursor(legacyKey)).toBeNull();
    expect(await scan.getCursor(scanCursorKey(identity))).toBe(600);
  });
});
