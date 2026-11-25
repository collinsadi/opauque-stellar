/**
 * poolProver never builds a withdrawal tree from incomplete history (#921): it
 * detects the getEvents page cap, refuses to zero-fill missing leaves, and can fill
 * gaps from an opt-in indexer (VITE_INDEXER_URL) whose data is cross-checked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const server = {
  getLatestLedger: vi.fn(async () => ({ sequence: 500_000 })),
  getHealth: vi.fn(async () => ({ oldestLedger: 1 })),
  getEvents: vi.fn(),
};
vi.mock("../stellar", () => ({ getSorobanServer: () => server }));
vi.mock("../../contracts/deploymentManifest", () => ({
  getActiveManifest: () => ({ deploymentLedger: 1_000 }),
}));

import {
  EVENT_PAGE_CAP,
  assemblePoolEvents,
  fetchStateLeavesFromIndexer,
  readPoolEvents,
  type RawPoolEvents,
} from "../poolProver";
import { PoolHistoryIncompleteError } from "../errors";

const POOL = "C" + "A".repeat(55);
const hex = (n: number) => "0x" + n.toString(16).padStart(64, "0");

function raw(leaves: Record<number, number>, extra: Partial<RawPoolEvents> = {}): RawPoolEvents {
  const byIndex = new Map(Object.entries(leaves).map(([i, v]) => [Number(i), BigInt(v)]));
  return { byIndex, depositIndices: [...byIndex.keys()], truncated: false, clipped: false, ...extra };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  server.getEvents.mockReset();
});

describe("RPC paging (#921)", () => {
  it("flags truncation when the page cap is hit before the cursor settles", async () => {
    let n = 0;
    // Every page is empty but the cursor keeps advancing: the loop never catches up.
    server.getEvents.mockImplementation(async () => ({ events: [], cursor: `c${++n}` }));

    const err = await readPoolEvents(POOL, { indexerUrl: null }).catch((e) => e);
    expect(err).toBeInstanceOf(PoolHistoryIncompleteError);
    expect(err.truncated).toBe(true);
    expect(err.message).toMatch(new RegExp(`${EVENT_PAGE_CAP}-page cap`));
    expect(err.message).toMatch(/VITE_INDEXER_URL/);
    // Deposit and Withdraw topics each stop at the cap.
    expect(server.getEvents).toHaveBeenCalledTimes(EVENT_PAGE_CAP * 2);
  });

  it("does not flag truncation when the cursor stops advancing", async () => {
    server.getEvents.mockImplementation(async () => ({ events: [], cursor: "same" }));
    await expect(readPoolEvents(POOL, { indexerUrl: null })).resolves.toEqual({ stateLeaves: [], depositIndices: [] });
  });
});

describe("assemblePoolEvents (#921)", () => {
  it("returns a contiguous tree when no leaf is missing", () => {
    expect(assemblePoolEvents(POOL, raw({ 0: 10, 1: 11, 2: 12 }))).toEqual({
      stateLeaves: [10n, 11n, 12n],
      depositIndices: [0, 1, 2],
    });
  });

  it("refuses to zero-fill missing leaves", () => {
    const err = (() => {
      try {
        assemblePoolEvents(POOL, raw({ 2: 12, 3: 13 }));
      } catch (e) {
        return e as PoolHistoryIncompleteError;
      }
    })();
    expect(err).toBeInstanceOf(PoolHistoryIncompleteError);
    expect(err?.missingLeafIndices).toEqual([0, 1]);
    expect(err?.message).toMatch(/missing 2 leaf/);
  });

  it("fills gaps from the indexer and merges deposit indices", () => {
    const indexer = { leaves: [hex(10), hex(11), hex(12), hex(13)], depositIndices: [0, 1, 2] };
    expect(assemblePoolEvents(POOL, raw({ 2: 12, 3: 13 }, { depositIndices: [2] }), indexer)).toEqual({
      stateLeaves: [10n, 11n, 12n, 13n],
      depositIndices: [0, 1, 2],
    });
  });

  it("rejects an indexer that disagrees with on-chain events", () => {
    const indexer = { leaves: [hex(10), hex(11), hex(999)], depositIndices: [0] };
    expect(() => assemblePoolEvents(POOL, raw({ 2: 12 }), indexer)).toThrow(/disagrees with on-chain events/);
  });
});

describe("indexer fallback (#921)", () => {
  it("is only consulted when RPC history is incomplete", async () => {
    const fetchImpl = vi.fn();
    await readPoolEvents(POOL, {
      readRpc: async () => raw({ 0: 10, 1: 11 }),
      indexerUrl: "https://indexer.example",
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fills a retention gap from VITE_INDEXER_URL", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ leaves: [hex(10), hex(11), hex(12)], depositIndices: [0, 1, 2] }));
    const events = await readPoolEvents(POOL, {
      readRpc: async () => raw({ 2: 12 }, { clipped: true }),
      indexerUrl: "https://indexer.example",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(events.stateLeaves).toEqual([10n, 11n, 12n]);
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://indexer.example/pools/${POOL}/state-leaves`,
      expect.anything(),
    );
  });

  it("reports a failed indexer as incomplete history, not a silent zero leaf", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "down" }, 503));
    await expect(
      readPoolEvents(POOL, {
        readRpc: async () => raw({ 1: 11 }),
        indexerUrl: "https://indexer.example",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/indexer fallback failed: Indexer returned HTTP 503/);
  });

  it("validates the indexer response shape", async () => {
    const bad = vi.fn(async () => jsonResponse({ leaves: ["0x12"], depositIndices: [0] }));
    await expect(fetchStateLeavesFromIndexer("https://i", POOL, bad as unknown as typeof fetch)).rejects.toThrow(
      /malformed/,
    );
  });
});
