/**
 * E2E-style restore flow test for issue #1105.
 *
 * Verifies the full path that PoolView now wires:
 *   buildEncryptedPoolNoteBackup  →  importEncryptedPoolNoteBackup
 *                                 →  poolNoteStore.importNotes
 *
 * This is the path that previously had no production caller.
 *
 * Acceptance criteria from #1105:
 *   - Users can restore an encrypted note backup (the round-trip works)
 *   - Restored, skipped, and spent-preserved counts are reported correctly
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { webcrypto } from "node:crypto";
import {
  buildEncryptedPoolNoteBackup,
  importEncryptedPoolNoteBackup,
  InvalidPasswordError,
} from "../lib/poolNoteBackup";
import { usePoolNoteStore } from "../store/poolNoteStore";
import type { PoolNote } from "../lib/poolNotes";

beforeAll(() => {
  // jsdom does not ship WebCrypto — polyfill it for PBKDF2/AES-GCM
  if (!globalThis.crypto) {
    (globalThis as { crypto?: Crypto }).crypto = webcrypto as unknown as Crypto;
  }
});

beforeEach(() => {
  usePoolNoteStore.setState({ notes: [], activeAccount: null });
});

function makeNote(overrides: Partial<PoolNote> = {}): PoolNote {
  return {
    cluster: "testnet",
    poolId: "pool-xlm-v1",
    value: "100000000",
    scope: 1,
    leafIndex: 0,
    nullifier: "111111",
    secret: "222222",
    commitment: "0xaabbccdd",
    spent: false,
    createdAt: Date.now(),
    ...overrides,
  };
}

const TEST_PIN = "123456";

// ---------------------------------------------------------------------------
// Round-trip: build → import → merge
// ---------------------------------------------------------------------------

describe("pool note restore flow (#1105)", () => {
  it("round-trips a backup: encrypted notes are fully restored via importEncryptedPoolNoteBackup + importNotes", async () => {
    const notes = [
      makeNote({ leafIndex: 0, nullifier: "aaa", secret: "s1" }),
      makeNote({ leafIndex: 1, nullifier: "bbb", secret: "s2" }),
    ];

    const blob = await buildEncryptedPoolNoteBackup({
      notes,
      pin: TEST_PIN,
      cluster: "testnet",
      poolId: "pool-xlm-v1",
    });

    const payload = await importEncryptedPoolNoteBackup(blob, TEST_PIN);
    expect(payload.notes).toHaveLength(2);

    const result = usePoolNoteStore.getState().importNotes(payload.notes);
    expect(result.imported).toBe(2);
    expect(result.spentPreserved).toBe(0);

    // Notes are now in the store
    const stored = usePoolNoteStore.getState().notes;
    expect(stored).toHaveLength(2);
    expect(stored.map((n) => n.nullifier)).toEqual(expect.arrayContaining(["aaa", "bbb"]));
  });

  it("reports spent-preserved count when a locally-spent note is in the backup as unspent", async () => {
    // Local: leaf 0 is already spent
    usePoolNoteStore.setState({
      notes: [makeNote({ leafIndex: 0, nullifier: "aaa", spent: true })],
      activeAccount: null,
    });

    // Backup was made before withdrawal — leaf 0 is unspent in backup
    const backupNotes = [
      makeNote({ leafIndex: 0, nullifier: "aaa", spent: false }),
      makeNote({ leafIndex: 1, nullifier: "bbb", spent: false }),
    ];
    const blob = await buildEncryptedPoolNoteBackup({
      notes: backupNotes,
      pin: TEST_PIN,
      cluster: "testnet",
    });

    const payload = await importEncryptedPoolNoteBackup(blob, TEST_PIN);
    const result = usePoolNoteStore.getState().importNotes(payload.notes);

    // leaf 0 spent state preserved, leaf 1 is new
    expect(result.spentPreserved).toBe(1);
    expect(result.imported).toBe(1);

    const stored = usePoolNoteStore.getState().notes;
    expect(stored.find((n) => n.nullifier === "aaa")?.spent).toBe(true);
    expect(stored.find((n) => n.nullifier === "bbb")?.spent).toBe(false);
  });

  it("surfaces InvalidPasswordError on wrong PIN — not a silent failure", async () => {
    const blob = await buildEncryptedPoolNoteBackup({
      notes: [makeNote()],
      pin: TEST_PIN,
      cluster: "testnet",
    });

    await expect(
      importEncryptedPoolNoteBackup(blob, "wrong-pin"),
    ).rejects.toBeInstanceOf(InvalidPasswordError);
  });

  it("merges with existing notes without duplicating them", async () => {
    // Existing note in store
    usePoolNoteStore.getState().importNotes([
      makeNote({ leafIndex: 0, nullifier: "existing" }),
    ]);

    // Backup contains the same note plus a new one
    const backupNotes = [
      makeNote({ leafIndex: 0, nullifier: "existing" }),
      makeNote({ leafIndex: 2, nullifier: "new_one" }),
    ];
    const blob = await buildEncryptedPoolNoteBackup({
      notes: backupNotes,
      pin: TEST_PIN,
      cluster: "testnet",
    });

    const payload = await importEncryptedPoolNoteBackup(blob, TEST_PIN);
    const result = usePoolNoteStore.getState().importNotes(payload.notes);

    // 2 imported (existing updated, new one added), no spent conflict
    expect(result.imported).toBe(2);
    expect(result.spentPreserved).toBe(0);

    // No duplication — still 2 notes
    expect(usePoolNoteStore.getState().notes).toHaveLength(2);
  });
});
