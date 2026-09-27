/**
 * Bounded-concurrency announcement page fetching (#603).
 *
 * The scanner used to fetch announcement pages strictly one at a time, so
 * scan time grew linearly with history length. These tests verify the
 * concurrent implementation still delivers pages to `onChunk` in strict
 * ascending order — identical to the old sequential path — while allowing
 * multiple `getEvents` calls to be in flight at once.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import { buildPageRanges, fetchLogsAdaptive, DEFAULT_FETCH_CONCURRENCY } from "../useScanner";

vi.mock("../../lib/stellar", () => ({
  getSorobanServer: vi.fn(),
}));

import { getSorobanServer } from "../../lib/stellar";

function makeEvent(ledger: number) {
  const stealth = new Uint8Array(20).fill(1);
  const caller = new Uint8Array(32).fill(2);
  const ephemeral = new Uint8Array(33).fill(3);
  const metadata = new Uint8Array(4).fill(4);
  return {
    ledger,
    txHash: `tx-${ledger}`,
    value: xdr.ScVal.scvVec([
      xdr.ScVal.scvBytes(Buffer.from(new Uint8Array(1))), // scheme_id
      xdr.ScVal.scvBytes(Buffer.from(stealth)),
      xdr.ScVal.scvBytes(Buffer.from(caller)),
      xdr.ScVal.scvBytes(Buffer.from(ephemeral)),
      xdr.ScVal.scvBytes(Buffer.from(metadata)),
    ]),
  };
}

describe("buildPageRanges (#603)", () => {
  it("splits a range into consecutive non-overlapping batches", () => {
    // Matches the original sequential implementation's math exactly: each
    // range is `batchSize` wide measured from its start (inclusive), so the
    // second range's `to` is 10001 + 10000 = 20001, not 20000.
    const ranges = buildPageRanges(0n, 25000n, 10000n);
    expect(ranges).toEqual([
      { from: 0n, to: 10000n },
      { from: 10001n, to: 20001n },
      { from: 20002n, to: 25000n },
    ]);
  });

  it("returns a single range when span fits in one batch", () => {
    const ranges = buildPageRanges(100n, 200n, 10000n);
    expect(ranges).toEqual([{ from: 100n, to: 200n }]);
  });

  it("returns an empty array when fromBlock > toBlock", () => {
    expect(buildPageRanges(500n, 100n, 10000n)).toEqual([]);
  });
});

describe("fetchLogsAdaptive concurrency (#603)", () => {
  let getEventsMock: ReturnType<typeof vi.fn>;
  let getHealthMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    getHealthMock = vi.fn().mockResolvedValue({ oldestLedger: "0" });
    getEventsMock = vi.fn();
    vi.mocked(getSorobanServer).mockReturnValue({
      getHealth: getHealthMock,
      getEvents: getEventsMock,
    } as never);
  });

  it("delivers chunks to onChunk in strict ascending order even when later pages resolve first", async () => {
    // Page 2 (20002-30000) resolves fast; page 0 (0-10000) resolves slow.
    // onChunk must still be called 0, 1, 2 in that order.
    const delays: Record<number, number> = { 0: 30, 1: 10, 2: 0 };
    getEventsMock.mockImplementation(async ({ startLedger }: { startLedger: number }) => {
      const pageIndex = Math.floor(startLedger / 10001);
      await new Promise((r) => setTimeout(r, delays[pageIndex] ?? 0));
      return { events: [makeEvent(startLedger)] };
    });

    const seen: Array<{ from: bigint; to: bigint }> = [];
    await fetchLogsAdaptive(
      "CANNOUNCER",
      0n,
      30000n,
      "testnet" as never,
      async (from, to) => {
        seen.push({ from, to });
      },
      3, // all 3 pages dispatched concurrently
    );

    expect(seen).toEqual([
      { from: 0n, to: 10000n },
      { from: 10001n, to: 20001n },
      { from: 20002n, to: 30000n },
    ]);
  });

  it("produces identical results to a fully sequential fetch (order + content)", async () => {
    getEventsMock.mockImplementation(async ({ startLedger }: { startLedger: number }) => ({
      events: [makeEvent(startLedger), makeEvent(startLedger + 1)],
    }));

    const concurrentSeen: unknown[] = [];
    await fetchLogsAdaptive(
      "CANNOUNCER",
      0n,
      25000n,
      "testnet" as never,
      async (from, to, logs) => {
        concurrentSeen.push({ from, to, count: logs.length });
      },
      4,
    );

    getEventsMock.mockClear();
    const sequentialSeen: unknown[] = [];
    await fetchLogsAdaptive(
      "CANNOUNCER",
      0n,
      25000n,
      "testnet" as never,
      async (from, to, logs) => {
        sequentialSeen.push({ from, to, count: logs.length });
      },
      1, // sequential
    );

    expect(concurrentSeen).toEqual(sequentialSeen);
  });

  it("respects the configured concurrency limit (never more than N in flight)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    getEventsMock.mockImplementation(async ({ startLedger }: { startLedger: number }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { events: [makeEvent(startLedger)] };
    });

    await fetchLogsAdaptive(
      "CANNOUNCER",
      0n,
      100000n, // 11 pages at BATCH_SIZE=10000
      "testnet" as never,
      async () => {},
      2,
    );

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(0);
  });

  it("propagates an error from any page and stops without silently dropping it", async () => {
    getEventsMock.mockImplementation(async ({ startLedger }: { startLedger: number }) => {
      if (startLedger === 10001) throw new Error("rpc boom");
      return { events: [] };
    });

    await expect(
      fetchLogsAdaptive("CANNOUNCER", 0n, 30000n, "testnet" as never, async () => {}, 3),
    ).rejects.toThrow("rpc boom");
  });

  it("clamps the start ledger to the RPC's oldest retained ledger", async () => {
    getHealthMock.mockResolvedValue({ oldestLedger: "5000" });
    getEventsMock.mockImplementation(async ({ startLedger }: { startLedger: number }) => ({
      events: [makeEvent(startLedger)],
    }));

    const seen: Array<{ from: bigint }> = [];
    await fetchLogsAdaptive(
      "CANNOUNCER",
      0n,
      6000n,
      "testnet" as never,
      async (from) => {
        seen.push({ from });
      },
      DEFAULT_FETCH_CONCURRENCY,
    );

    expect(seen).toEqual([{ from: 5000n }]);
  });

  it("reports ledgers skipped by the retention clamp before delivering any chunk", async () => {
    getHealthMock.mockResolvedValue({ oldestLedger: "5000" });
    getEventsMock.mockImplementation(async ({ startLedger }: { startLedger: number }) => ({
      events: [makeEvent(startLedger)],
    }));

    const order: string[] = [];
    const onUnscanned = vi.fn(async () => {
      order.push("unscanned");
    });
    await fetchLogsAdaptive(
      "CANNOUNCER",
      100n,
      6000n,
      "testnet" as never,
      async () => {
        order.push("chunk");
      },
      DEFAULT_FETCH_CONCURRENCY,
      onUnscanned,
    );

    expect(onUnscanned).toHaveBeenCalledTimes(1);
    expect(onUnscanned).toHaveBeenCalledWith({ fromLedger: 100, toLedger: 4999 });
    expect(order).toEqual(["unscanned", "chunk"]);
  });

  it("caps the reported gap at toBlock when the whole range is pruned", async () => {
    getHealthMock.mockResolvedValue({ oldestLedger: "5000" });
    const onUnscanned = vi.fn();
    const onChunk = vi.fn();
    await fetchLogsAdaptive("CANNOUNCER", 100n, 2000n, "testnet" as never, onChunk, 2, onUnscanned);
    expect(onUnscanned).toHaveBeenCalledWith({ fromLedger: 100, toLedger: 2000 });
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("does not report a gap when the range is fully retained", async () => {
    getHealthMock.mockResolvedValue({ oldestLedger: "50" });
    getEventsMock.mockResolvedValue({ events: [] });
    const onUnscanned = vi.fn();
    await fetchLogsAdaptive("CANNOUNCER", 100n, 2000n, "testnet" as never, async () => {}, 2, onUnscanned);
    expect(onUnscanned).not.toHaveBeenCalled();
  });

  it("reports ledgers skipped when getEvents rejects a start below a slid window", async () => {
    // getHealth says 0 is retained, but the window slides before getEvents.
    getHealthMock.mockResolvedValue({ oldestLedger: "0" });
    getEventsMock.mockImplementation(async ({ startLedger }: { startLedger: number }) => {
      if (startLedger < 300) {
        throw new Error("startLedger must be within the ledger range: 300 - 9000");
      }
      return { events: [] };
    });
    const onUnscanned = vi.fn();
    await fetchLogsAdaptive("CANNOUNCER", 100n, 2000n, "testnet" as never, async () => {}, 1, onUnscanned);
    expect(onUnscanned).toHaveBeenCalledWith({ fromLedger: 100, toLedger: 299 });
  });

  it("does nothing when fromBlock is already past toBlock after clamping", async () => {
    getHealthMock.mockResolvedValue({ oldestLedger: "0" });
    const onChunk = vi.fn();
    await fetchLogsAdaptive("CANNOUNCER", 100n, 50n, "testnet" as never, onChunk, 2);
    expect(onChunk).not.toHaveBeenCalled();
    expect(getEventsMock).not.toHaveBeenCalled();
  });
});
