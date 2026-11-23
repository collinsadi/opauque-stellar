/**
 * Tests for #1104: markSpent skipping legacy and cross-account notes.
 *
 * Before the fix:
 *   - markSpent required (n.account ?? "") === (s.activeAccount ?? ""), so
 *     legacy notes (no account field) were never marked spent when an account
 *     was active, and cross-account notes visible via getForCluster were also
 *     never marked spent — leading to overstated balances and double-spend
 *     errors on already-spent nullifiers.
 *   - noteKey() omitted account while addNote deduped by account, creating an
 *     inconsistency that could cause the wrong note to be overwritten on import.
 *
 * After the fix:
 *   - markSpent marks a note spent if its account matches activeAccount OR if
 *     the note has no account (legacy).
 *   - noteKey() includes account so dedup identity is consistent with addNote.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { usePoolNoteStore } from "../store/poolNoteStore";
import type { PoolNote } from "../lib/poolNotes";

const ACCOUNT_A = "GAAA_ACCOUNT_A";
const ACCOUNT_B = "GBBB_ACCOUNT_B";
const CLUSTER = "testnet";
const POOL_ID = "pool-1";

function makeNote(overrides: Partial<PoolNote> = {}): PoolNote {
  return {
    cluster: CLUSTER,
    poolId: POOL_ID,
    value: "10000000",
    scope: 1,
    leafIndex: 0,
    nullifier: "null_111",
    secret: "sec_222",
    commitment: "0xabc",
    spent: false,
    createdAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  usePoolNoteStore.setState({ notes: [], activeAccount: null });
});

// ---------------------------------------------------------------------------
// markSpent — legacy notes (no account)
// ---------------------------------------------------------------------------

describe("markSpent — legacy notes (no account field)", () => {
  it("marks a legacy note spent when an account is active", () => {
    // Inject a legacy note directly (no account field, as it would appear from
    // before account-scoping was introduced)
    usePoolNoteStore.setState({
      notes: [makeNote({ leafIndex: 5, nullifier: "legacy_null" })],
      activeAccount: ACCOUNT_A,
    });

    usePoolNoteStore.getState().markSpent(CLUSTER, POOL_ID, 5);

    const note = usePoolNoteStore
      .getState()
      .notes.find((n) => n.leafIndex === 5);
    expect(note?.spent).toBe(true);
  });

  it("does not mark a different account's scoped note spent for a legacy leaf index", () => {
    // Account B has a scoped note at leafIndex 5
    usePoolNoteStore.setState({
      notes: [makeNote({ leafIndex: 5, account: ACCOUNT_B })],
      activeAccount: ACCOUNT_A,
    });

    usePoolNoteStore.getState().markSpent(CLUSTER, POOL_ID, 5);

    // Account B's note must NOT be marked spent by account A's markSpent call
    const note = usePoolNoteStore
      .getState()
      .notes.find((n) => n.leafIndex === 5);
    expect(note?.spent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// markSpent — scoped notes
// ---------------------------------------------------------------------------

describe("markSpent — scoped notes", () => {
  it("marks the active account's own note spent", () => {
    usePoolNoteStore.getState().setActiveAccount(ACCOUNT_A);
    usePoolNoteStore.getState().addNote(makeNote({ leafIndex: 0 }));

    usePoolNoteStore.getState().markSpent(CLUSTER, POOL_ID, 0);

    const note = usePoolNoteStore
      .getState()
      .getForCluster(CLUSTER)
      .find((n) => n.leafIndex === 0);
    expect(note?.spent).toBe(true);
  });

  it("does not mark another account's note spent when accounts share a cluster", () => {
    // Account A note at index 0
    usePoolNoteStore.getState().setActiveAccount(ACCOUNT_A);
    usePoolNoteStore.getState().addNote(makeNote({ leafIndex: 0, nullifier: "a0" }));

    // Account B note at index 0 (same cluster, same pool, same index)
    usePoolNoteStore.getState().setActiveAccount(ACCOUNT_B);
    usePoolNoteStore.getState().addNote(makeNote({ leafIndex: 0, nullifier: "b0" }));

    // B marks its note spent
    usePoolNoteStore.getState().markSpent(CLUSTER, POOL_ID, 0);

    // A's note must remain unspent
    usePoolNoteStore.getState().setActiveAccount(ACCOUNT_A);
    const aNotes = usePoolNoteStore.getState().getForCluster(CLUSTER);
    expect(aNotes.find((n) => n.nullifier === "a0")?.spent).toBe(false);

    // B's note must be spent
    usePoolNoteStore.getState().setActiveAccount(ACCOUNT_B);
    const bNotes = usePoolNoteStore.getState().getForCluster(CLUSTER);
    expect(bNotes.find((n) => n.nullifier === "b0")?.spent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// noteKey / addNote dedup consistency (#1104)
// ---------------------------------------------------------------------------

describe("noteKey and addNote dedup consistency", () => {
  it("two accounts can hold notes at the same leafIndex without collision", () => {
    usePoolNoteStore.getState().setActiveAccount(ACCOUNT_A);
    usePoolNoteStore.getState().addNote(makeNote({ leafIndex: 0, secret: "secretA" }));

    usePoolNoteStore.getState().setActiveAccount(ACCOUNT_B);
    usePoolNoteStore.getState().addNote(makeNote({ leafIndex: 0, secret: "secretB" }));

    // Both notes must coexist — no silent dedup across accounts
    expect(usePoolNoteStore.getState().notes).toHaveLength(2);

    const secrets = usePoolNoteStore.getState().notes.map((n) => n.secret);
    expect(secrets).toContain("secretA");
    expect(secrets).toContain("secretB");
  });

  it("re-adding the same note for the same account deduplicates correctly", () => {
    usePoolNoteStore.getState().setActiveAccount(ACCOUNT_A);
    usePoolNoteStore.getState().addNote(makeNote({ leafIndex: 0, secret: "v1" }));
    usePoolNoteStore.getState().addNote(makeNote({ leafIndex: 0, secret: "v2" }));

    // Should still be 1 note (deduplicated), with the latest value
    const aNotes = usePoolNoteStore.getState().notes.filter((n) => n.account === ACCOUNT_A);
    expect(aNotes).toHaveLength(1);
    expect(aNotes[0].secret).toBe("v2");
  });
});
