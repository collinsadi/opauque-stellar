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

// ---------------------------------------------------------------------------
// #1103: Two-account isolation — PoolView, backup export, and dashboard
// ---------------------------------------------------------------------------
describe("Two-account note isolation (#1103)", () => {
  beforeEach(() => {
    usePoolNoteStore.setState({ notes: [], activeAccount: null });
  });

  it("PoolView note list: account B cannot see account A's notes via getForCluster", () => {
    // Account A deposits two notes
    usePoolNoteStore.getState().setActiveAccount(ACCOUNT_A);
    usePoolNoteStore.getState().addNote(makeNote({ leafIndex: 0, nullifier: "aaa1" }));
    usePoolNoteStore.getState().addNote(makeNote({ leafIndex: 1, nullifier: "aaa2" }));

    // Account B deposits one note
    usePoolNoteStore.getState().setActiveAccount(ACCOUNT_B);
    usePoolNoteStore.getState().addNote(makeNote({ leafIndex: 2, nullifier: "bbb1" }));

    // B's view: only 1 note
    expect(usePoolNoteStore.getState().getForCluster("testnet")).toHaveLength(1);
    expect(usePoolNoteStore.getState().getForCluster("testnet")[0].nullifier).toBe("bbb1");

    // A's view: only 2 notes
    usePoolNoteStore.getState().setActiveAccount(ACCOUNT_A);
    expect(usePoolNoteStore.getState().getForCluster("testnet")).toHaveLength(2);
  });

  it("backup export (exportNotes): only the active account's notes are returned", () => {
    usePoolNoteStore.getState().setActiveAccount(ACCOUNT_A);
    usePoolNoteStore.getState().addNote(makeNote({ leafIndex: 0, secret: "secretA" }));

    usePoolNoteStore.getState().setActiveAccount(ACCOUNT_B);
    usePoolNoteStore.getState().addNote(makeNote({ leafIndex: 1, secret: "secretB" }));

    // Export as account B — should only contain B's secret
    const exported = usePoolNoteStore.getState().exportNotes();
    expect(exported).toHaveLength(1);
    expect(exported[0].secret).toBe("secretB");

    // Export as account A — should only contain A's secret
    usePoolNoteStore.getState().setActiveAccount(ACCOUNT_A);
    const exportedA = usePoolNoteStore.getState().exportNotes();
    expect(exportedA).toHaveLength(1);
    expect(exportedA[0].secret).toBe("secretA");
  });

  it("dashboard balance: unspent total reflects only the active account's notes", () => {
    // Account A: one unspent note (value 10 XLM in stroops)
    usePoolNoteStore.getState().setActiveAccount(ACCOUNT_A);
    usePoolNoteStore.getState().addNote(
      makeNote({ leafIndex: 0, value: "100000000", spent: false }),
    );

    // Account B: two unspent notes
    usePoolNoteStore.getState().setActiveAccount(ACCOUNT_B);
    usePoolNoteStore.getState().addNote(
      makeNote({ leafIndex: 1, value: "200000000", spent: false }),
    );
    usePoolNoteStore.getState().addNote(
      makeNote({ leafIndex: 2, value: "300000000", spent: false }),
    );

    // As account B: getForCluster returns 2 notes
    const bNotes = usePoolNoteStore.getState().getForCluster("testnet");
    expect(bNotes).toHaveLength(2);
    expect(bNotes.every((n) => n.account === ACCOUNT_B)).toBe(true);

    // As account A: getForCluster returns 1 note
    usePoolNoteStore.getState().setActiveAccount(ACCOUNT_A);
    const aNotes = usePoolNoteStore.getState().getForCluster("testnet");
    expect(aNotes).toHaveLength(1);
    expect(aNotes[0].account).toBe(ACCOUNT_A);
  });

  it("legacy notes (no account field) are visible to any active account", () => {
    // Simulate a legacy note written before account scoping was introduced
    usePoolNoteStore.setState({
      notes: [makeNote({ leafIndex: 99, nullifier: "legacy" })],
      // legacy notes have no `account` field
      activeAccount: ACCOUNT_A,
    });

    // Both accounts can see the legacy note (migration / isolation fallback)
    expect(usePoolNoteStore.getState().getForCluster("testnet")).toHaveLength(1);

    usePoolNoteStore.getState().setActiveAccount(ACCOUNT_B);
    expect(usePoolNoteStore.getState().getForCluster("testnet")).toHaveLength(1);
  });
});
