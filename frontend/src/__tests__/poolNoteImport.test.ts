import { describe, it, expect, beforeEach } from "vitest";
import { usePoolNoteStore } from "../store/poolNoteStore";
import type { PoolNote } from "../lib/poolNotes";

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

describe("poolNoteStore.importNotes", () => {
  beforeEach(() => {
    usePoolNoteStore.setState({ notes: [] });
  });

  it("never reverts a locally spent note to unspent", () => {
    // Local state: note at leaf 0 is spent.
    const spentNote = makeNote({ leafIndex: 0, spent: true });
    usePoolNoteStore.setState({ notes: [spentNote] });

    // Stale backup says it's unspent.
    const staleBackup = [makeNote({ leafIndex: 0, spent: false })];
    const result = usePoolNoteStore.getState().importNotes(staleBackup);

    const notes = usePoolNoteStore.getState().notes;
    expect(notes).toHaveLength(1);
    expect(notes[0].spent).toBe(true);
    expect(result.spentPreserved).toBe(1);
    expect(result.imported).toBe(0);
  });

  it("imports new notes that don't exist locally", () => {
    const local = makeNote({ leafIndex: 0 });
    usePoolNoteStore.setState({ notes: [local] });

    const imported = [makeNote({ leafIndex: 5, nullifier: "555", secret: "666" })];
    const result = usePoolNoteStore.getState().importNotes(imported);

    const notes = usePoolNoteStore.getState().notes;
    expect(notes).toHaveLength(2);
    expect(result.imported).toBe(1);
    expect(result.spentPreserved).toBe(0);
  });

  it("reports conflicts when restoring a stale backup over newer state", () => {
    // Local state: two notes, one spent and one unspent.
    const spentNote = makeNote({ leafIndex: 0, spent: true });
    const unspentNote = makeNote({ leafIndex: 1, spent: false });
    usePoolNoteStore.setState({ notes: [spentNote, unspentNote] });

    // Stale backup: both notes are unspent, plus a new one.
    const staleBackup = [
      makeNote({ leafIndex: 0, spent: false }),
      makeNote({ leafIndex: 1, spent: false }),
      makeNote({ leafIndex: 2, nullifier: "333", secret: "444" }),
    ];
    const result = usePoolNoteStore.getState().importNotes(staleBackup);

    const notes = usePoolNoteStore.getState().notes;
    // 3 notes total: leaf 0 still spent, leaf 1 updated, leaf 2 new.
    expect(notes).toHaveLength(3);
    expect(notes.find((n) => n.leafIndex === 0)?.spent).toBe(true);
    expect(result.spentPreserved).toBe(1);
    expect(result.imported).toBe(2);
  });

  it("accepts a spent import over an unspent local note", () => {
    const local = makeNote({ leafIndex: 0, spent: false });
    usePoolNoteStore.setState({ notes: [local] });

    const imported = [makeNote({ leafIndex: 0, spent: true })];
    const result = usePoolNoteStore.getState().importNotes(imported);

    const notes = usePoolNoteStore.getState().notes;
    expect(notes[0].spent).toBe(true);
    expect(result.imported).toBe(1);
  });
});
