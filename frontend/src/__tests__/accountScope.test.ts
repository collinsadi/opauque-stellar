import { describe, it, expect, beforeEach } from "vitest";
import { useTxHistoryStore } from "../store/txHistoryStore";
import { usePoolNoteStore } from "../store/poolNoteStore";
import { useWatchlistStore } from "../hooks/useWatchlist";
import type { PoolNote } from "../lib/poolNotes";

const ACCOUNT_A = "GAAA_ACCOUNT_A";
const ACCOUNT_B = "GBBB_ACCOUNT_B";

function makeNote(overrides: Partial<PoolNote> = {}): PoolNote {
  return {
    cluster: "testnet",
    poolId: "pool-1",
    value: "10000000",
    scope: 1,
    leafIndex: 0,
    nullifier: "111",
    secret: "222",
    commitment: "0xabc",
    spent: false,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("Account-scoped stores", () => {
  beforeEach(() => {
    useTxHistoryStore.setState({ byChain: {}, activeAccount: null });
    usePoolNoteStore.setState({ notes: [], activeAccount: null });
    useWatchlistStore.setState({ entries: [], activeAccount: null });
  });

  describe("txHistoryStore", () => {
    it("each account sees only its own history", () => {
      // Account A pushes an entry
      useTxHistoryStore.getState().setActiveAccount(ACCOUNT_A);
      useTxHistoryStore.getState().push({
        cluster: "testnet",
        kind: "sent",
        counterparty: "G...",
        amountStroops: "1000",
        tokenSymbol: "XLM",
        tokenAddress: null,
        amount: "0.0001",
      });

      expect(useTxHistoryStore.getState().getForCluster("testnet")).toHaveLength(1);

      // Switch to account B — should see empty
      useTxHistoryStore.getState().setActiveAccount(ACCOUNT_B);
      expect(useTxHistoryStore.getState().getForCluster("testnet")).toHaveLength(0);

      // Switch back — should see the entry again
      useTxHistoryStore.getState().setActiveAccount(ACCOUNT_A);
      expect(useTxHistoryStore.getState().getForCluster("testnet")).toHaveLength(1);
    });

    it("clear scopes to active account", () => {
      useTxHistoryStore.getState().setActiveAccount(ACCOUNT_A);
      useTxHistoryStore.getState().push({
        cluster: "testnet",
        kind: "sent",
        counterparty: "G...",
        amountStroops: "1000",
        tokenSymbol: "XLM",
        tokenAddress: null,
        amount: "0.0001",
      });

      useTxHistoryStore.getState().setActiveAccount(ACCOUNT_B);
      useTxHistoryStore.getState().push({
        cluster: "testnet",
        kind: "received",
        counterparty: "G...",
        amountStroops: "2000",
        tokenSymbol: "XLM",
        tokenAddress: null,
        amount: "0.0002",
      });

      // Clear only account B
      useTxHistoryStore.getState().clear();

      // Account A's data survives
      useTxHistoryStore.getState().setActiveAccount(ACCOUNT_A);
      expect(useTxHistoryStore.getState().getForCluster("testnet")).toHaveLength(1);
    });
  });

  describe("poolNoteStore", () => {
    it("each account sees only its own notes", () => {
      usePoolNoteStore.getState().setActiveAccount(ACCOUNT_A);
      usePoolNoteStore.getState().addNote(makeNote({ leafIndex: 0 }));

      expect(usePoolNoteStore.getState().getForCluster("testnet")).toHaveLength(1);

      usePoolNoteStore.getState().setActiveAccount(ACCOUNT_B);
      expect(usePoolNoteStore.getState().getForCluster("testnet")).toHaveLength(0);

      usePoolNoteStore.getState().setActiveAccount(ACCOUNT_A);
      expect(usePoolNoteStore.getState().getForCluster("testnet")).toHaveLength(1);
    });

    it("clear scopes to active account and cluster", () => {
      usePoolNoteStore.getState().setActiveAccount(ACCOUNT_A);
      usePoolNoteStore.getState().addNote(makeNote({ leafIndex: 0, cluster: "testnet" }));
      usePoolNoteStore.getState().addNote(makeNote({ leafIndex: 1, cluster: "mainnet" }));

      usePoolNoteStore.getState().setActiveAccount(ACCOUNT_B);
      usePoolNoteStore.getState().addNote(makeNote({ leafIndex: 2 }));

      // Clear only account A's testnet notes
      usePoolNoteStore.getState().setActiveAccount(ACCOUNT_A);
      usePoolNoteStore.getState().clear({ cluster: "testnet" });

      // Account A's mainnet note survives
      expect(usePoolNoteStore.getState().getForCluster("mainnet")).toHaveLength(1);

      // Account B's notes survive
      usePoolNoteStore.getState().setActiveAccount(ACCOUNT_B);
      expect(usePoolNoteStore.getState().getForCluster("testnet")).toHaveLength(1);
    });
  });

  describe("watchlistStore", () => {
    it("each account sees only its own watchlist", () => {
      useWatchlistStore.getState().setActiveAccount(ACCOUNT_A);
      useWatchlistStore.getState().add("testnet", "G_ADDR_1");

      expect(useWatchlistStore.getState().getActiveAddresses("testnet")).toHaveLength(1);

      useWatchlistStore.getState().setActiveAccount(ACCOUNT_B);
      expect(useWatchlistStore.getState().getActiveAddresses("testnet")).toHaveLength(0);

      useWatchlistStore.getState().setActiveAccount(ACCOUNT_A);
      expect(useWatchlistStore.getState().getActiveAddresses("testnet")).toHaveLength(1);
    });
  });
});
