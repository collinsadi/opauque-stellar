/**
 * reconcileHistory + reconcileFromChain tests (#113).
 */

import { describe, it, expect, vi } from "vitest";
import {
  reconcileHistory,
  reconcileFromChain,
  type ChainHistoryItem,
} from "../history-reconciliation";
import type { TxHistoryEntry } from "../../store/txHistoryStore";

function local(hash: string, timestamp = 1_700_000_000_000): TxHistoryEntry {
  return {
    id: `local-${hash}`,
    cluster: "testnet",
    kind: "sent",
    counterparty: "GAAA",
    amountStroops: "10000000",
    tokenSymbol: "XLM",
    tokenAddress: null,
    amount: "1.000",
    txHash: hash,
    timestamp,
  };
}

function chain(hash: string, status: ChainHistoryItem["status"] = "confirmed"): ChainHistoryItem {
  return {
    txHash: hash,
    cluster: "testnet",
    kind: "sent",
    counterparty: "GBBB",
    amountStroops: "20000000",
    amount: "2.000",
    tokenSymbol: "XLM",
    tokenAddress: null,
    timestamp: 1_700_000_005_000,
    status,
  };
}

describe("reconcileHistory (#113)", () => {
  it("rebuilds the list when local is empty (clear-storage recovery)", () => {
    const out = reconcileHistory([], [chain("h1"), chain("h2")]);
    expect(out.entries).toHaveLength(2);
    expect(out.addedCount).toBe(2);
    expect(out.dedupedCount).toBe(0);
  });

  it("dedupes by tx hash", () => {
    const out = reconcileHistory([local("h1")], [chain("h1"), chain("h2")]);
    expect(out.entries).toHaveLength(2);
    expect(out.addedCount).toBe(1);
    expect(out.dedupedCount).toBe(1);
  });

  it("preserves the local entry's user-authored metadata on dedupe", () => {
    const out = reconcileHistory([local("h1")], [chain("h1")]);
    const entry = out.entries.find((e) => e.txHash === "h1")!;
    // counterparty came from local, not chain.
    expect(entry.counterparty).toBe("GAAA");
  });

  it("represents failed and pending statuses from the chain", () => {
    const out = reconcileHistory(
      [],
      [chain("h1", "confirmed"), chain("h2", "failed"), chain("h3", "pending")],
    );
    expect(out.entries.find((e) => e.txHash === "h2")!.chainStatus).toBe("failed");
    expect(out.entries.find((e) => e.txHash === "h3")!.chainStatus).toBe("pending");
  });

  it("flips a stored pending entry to failed when chain says so", () => {
    const out = reconcileHistory([local("h1")], [chain("h1", "failed")]);
    expect(out.entries[0].chainStatus).toBe("failed");
  });

  it("returns entries newest-first", () => {
    const out = reconcileHistory(
      [local("h-old", 1_000), local("h-new", 5_000)],
      [],
    );
    expect(out.entries.map((e) => e.txHash)).toEqual(["h-new", "h-old"]);
  });
});

describe("reconcileFromChain (#113)", () => {
  it("delegates to the injected fetcher and merges the result", async () => {
    const fetch = vi.fn().mockResolvedValue([chain("h1"), chain("h2")]);
    const out = await reconcileFromChain(fetch, {
      local: [local("h1")],
      cluster: "testnet",
      ghostAddresses: ["GAAA", "GBBB"],
    });
    expect(fetch).toHaveBeenCalledWith({
      cluster: "testnet",
      ghostAddresses: ["GAAA", "GBBB"],
      since: undefined,
    });
    expect(out.entries).toHaveLength(2);
    expect(out.addedCount).toBe(1);
  });
});
