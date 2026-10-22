import { describe, it, expect } from "vitest";
import { announcementId, rekeyV3Announcements, type CachedAnnouncement } from "../lib/opaqueCache";

/**
 * v3 -> v4 upgrade (#1113). v3 stored announcements under `${txHash}:${ledger}`
 * with `logIndex` always 0. The upgrade must keep every such record and re-key it
 * to the v4 id format, instead of dropping the store.
 */

function v3Record(overrides: Partial<CachedAnnouncement> & Pick<CachedAnnouncement, "transactionSignature">): CachedAnnouncement {
  return {
    id: `${overrides.transactionSignature}:100`,
    cluster: "testnet",
    slot: 100,
    logIndex: 0,
    args: { stealthAddress: "0xaa", ephemeralPubKey: "0xbb", metadata: "0xcc" },
    ...overrides,
  };
}

describe("rekeyV3Announcements", () => {
  it("keeps every cached payment across the upgrade", () => {
    const legacy = [
      v3Record({ transactionSignature: "tx-a", slot: 100 }),
      v3Record({ transactionSignature: "tx-b", slot: 205 }),
      v3Record({ transactionSignature: "tx-c", slot: 310, cluster: "mainnet" }),
    ];

    const rekeyed = rekeyV3Announcements(legacy);

    expect(rekeyed).toHaveLength(legacy.length);
    expect(new Set(rekeyed.map((r) => r.id)).size).toBe(legacy.length);
  });

  it("re-keys each record to the v4 id format", () => {
    const [record] = rekeyV3Announcements([v3Record({ transactionSignature: "tx-a" })]);

    expect(record.id).toBe(announcementId("testnet", "tx-a", 0));
    expect(record.id).toBe("testnet-tx-a-0");
  });

  it("leaves the payment data untouched", () => {
    const original = v3Record({ transactionSignature: "tx-a", slot: 4242 });

    const [record] = rekeyV3Announcements([original]);

    expect(record).toEqual({ ...original, id: "testnet-tx-a-0" });
  });

  it("does not merge records from different clusters that share a transaction hash", () => {
    const rekeyed = rekeyV3Announcements([
      v3Record({ transactionSignature: "same-tx", cluster: "testnet" }),
      v3Record({ transactionSignature: "same-tx", cluster: "mainnet" }),
    ]);

    expect(new Set(rekeyed.map((r) => r.id)).size).toBe(2);
  });

  it("returns an empty list for an empty store", () => {
    expect(rekeyV3Announcements([])).toEqual([]);
  });
});
