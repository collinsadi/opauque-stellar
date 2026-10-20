import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-in for the IndexedDB `syncState` store. Like IndexedDB, a
// readwrite transaction holds the store until its requests settle, so
// overlapping transactions run one after another.
const memory = vi.hoisted(() => {
  const rows = new Map<string, unknown>();
  const copy = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
  let tail: Promise<void> = Promise.resolve();

  function startTransaction() {
    const previous = tail;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    tail = done;
    let pending = 0;
    const settle = () =>
      setTimeout(() => {
        if (pending === 0) finish();
      }, 0);
    const run = async <T>(operation: () => T): Promise<T> => {
      pending++;
      try {
        await previous;
        return operation();
      } finally {
        pending--;
        settle();
      }
    };
    settle();
    return {
      store: {
        get: (key: string) => run(() => copy(rows.get(key))),
        put: (value: { cluster: string }) =>
          run(() => {
            rows.set(value.cluster, copy(value));
          }),
      },
      done,
    };
  }

  const db = {
    transaction: () => startTransaction(),
    get: async (_store: string, key: string) => {
      const transaction = startTransaction();
      return transaction.store.get(key);
    },
  };

  return { rows, db };
});

vi.mock("idb", () => ({
  openDB: async () => memory.db,
}));

import {
  getSyncState,
  getUnscannedRanges,
  mergeUnscannedRanges,
  recordUnscannedRange,
  setSyncState,
} from "../opaqueCache";

describe("mergeUnscannedRanges", () => {
  it("keeps disjoint gaps separate and sorted", () => {
    const merged = mergeUnscannedRanges(
      [{ fromLedger: 40, toLedger: 50 }],
      { fromLedger: 10, toLedger: 20 },
    );
    expect(merged).toEqual([
      { fromLedger: 10, toLedger: 20 },
      { fromLedger: 40, toLedger: 50 },
    ]);
  });

  it("joins gaps that overlap or touch, and absorbs contained gaps", () => {
    expect(
      mergeUnscannedRanges([{ fromLedger: 10, toLedger: 20 }], { fromLedger: 21, toLedger: 30 }),
    ).toEqual([{ fromLedger: 10, toLedger: 30 }]);
    expect(
      mergeUnscannedRanges([{ fromLedger: 10, toLedger: 30 }], { fromLedger: 15, toLedger: 18 }),
    ).toEqual([{ fromLedger: 10, toLedger: 30 }]);
  });

  it("does not mutate the stored ranges it was given", () => {
    const stored = [{ fromLedger: 10, toLedger: 20 }];
    mergeUnscannedRanges(stored, { fromLedger: 15, toLedger: 40 });
    expect(stored).toEqual([{ fromLedger: 10, toLedger: 20 }]);
  });
});

describe("getUnscannedRanges", () => {
  it("reads the single-span form written before gaps were split", () => {
    expect(getUnscannedRanges({ cluster: "testnet", lastScannedSlot: 1, unscannedRange: { fromLedger: 1, toLedger: 5 } })).toEqual([
      { fromLedger: 1, toLedger: 5 },
    ]);
    expect(getUnscannedRanges(null)).toEqual([]);
  });
});

describe("sync state updates", () => {
  beforeEach(() => {
    memory.rows.clear();
  });

  it("keeps both the cursor and the gap when the two updates run concurrently", async () => {
    await Promise.all([
      recordUnscannedRange("testnet", { fromLedger: 10, toLedger: 20 }),
      setSyncState("testnet", 500),
      setSyncState("testnet", 600),
    ]);

    const state = await getSyncState("testnet");
    expect(state?.lastScannedSlot).toBe(600);
    expect(getUnscannedRanges(state)).toEqual([{ fromLedger: 10, toLedger: 20 }]);
  });

  it("stores disjoint gaps separately across concurrent recordings", async () => {
    await Promise.all([
      recordUnscannedRange("testnet", { fromLedger: 10, toLedger: 20 }),
      recordUnscannedRange("testnet", { fromLedger: 40, toLedger: 50 }),
      setSyncState("testnet", 900),
    ]);

    const state = await getSyncState("testnet");
    expect(state?.lastScannedSlot).toBe(900);
    expect(getUnscannedRanges(state)).toEqual([
      { fromLedger: 10, toLedger: 20 },
      { fromLedger: 40, toLedger: 50 },
    ]);
  });

  it("returns the merged list from recordUnscannedRange", async () => {
    await recordUnscannedRange("testnet", { fromLedger: 10, toLedger: 20 });
    const merged = await recordUnscannedRange("testnet", { fromLedger: 60, toLedger: 70 });
    expect(merged).toEqual([
      { fromLedger: 10, toLedger: 20 },
      { fromLedger: 60, toLedger: 70 },
    ]);
  });
});
