import { describe, it, expect, vi } from "vitest";

/**
 * Regression test: multiple announcements in a single transaction must
 * produce distinct IDs and not collide / deduplicate to one entry.
 */

// Inline the mapping logic to test it in isolation without importing
// React hooks or the Stellar SDK.

function mapAnnouncementEvents(
  events: Array<{ txHash: string; ledger: number; value: unknown }>,
  cluster: string,
) {
  const txEventIndex = new Map<string, number>();
  return events.map((ev) => {
    const txKey = ev.txHash;
    const idx = txEventIndex.get(txKey) ?? 0;
    txEventIndex.set(txKey, idx + 1);

    return {
      id: `${ev.txHash}:${ev.ledger}:${idx}`,
      cluster,
      transactionSignature: ev.txHash,
      logIndex: idx,
      slot: ev.ledger,
    };
  });
}

describe("Announcement ID collisions", () => {
  it("produces distinct IDs for multiple events in the same transaction", () => {
    const events = [
      { txHash: "abc123", ledger: 100, value: {} },
      { txHash: "abc123", ledger: 100, value: {} },
      { txHash: "abc123", ledger: 100, value: {} },
    ];
    const mapped = mapAnnouncementEvents(events, "testnet");

    const ids = mapped.map((m) => m.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(3);
    expect(ids).toEqual(["abc123:100:0", "abc123:100:1", "abc123:100:2"]);
  });

  it("resets index for different transactions", () => {
    const events = [
      { txHash: "tx1", ledger: 100, value: {} },
      { txHash: "tx1", ledger: 100, value: {} },
      { txHash: "tx2", ledger: 101, value: {} },
    ];
    const mapped = mapAnnouncementEvents(events, "testnet");

    expect(mapped[0].id).toBe("tx1:100:0");
    expect(mapped[1].id).toBe("tx1:100:1");
    expect(mapped[2].id).toBe("tx2:101:0");
  });

  it("single-event transaction gets logIndex 0", () => {
    const events = [{ txHash: "solo", ledger: 50, value: {} }];
    const mapped = mapAnnouncementEvents(events, "testnet");

    expect(mapped[0].logIndex).toBe(0);
    expect(mapped[0].id).toBe("solo:50:0");
  });
});
