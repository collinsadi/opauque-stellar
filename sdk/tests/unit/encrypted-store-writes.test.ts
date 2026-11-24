/**
 * Encrypted store write safety (issue #1077): concurrent mutations keep every
 * change, a file write leaves no torn or temporary blob behind, and PBKDF2 runs
 * once per unlock instead of once per write.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EncryptedNoteStore,
  EncryptedScanStore,
  fileBackend,
  memoryBackend,
  type PoolNote,
} from "../../src/index";

const note = (i: number): PoolNote => ({
  cluster: "testnet",
  poolId: "CPOOL",
  commitment: `0xc${i}`,
  nullifier: `0xn${i}`,
  secret: `0xs${i}`,
  value: "1000000",
  scope: 1,
  leafIndex: i,
  spent: false,
  createdAt: 1_700_000_000 + i,
});

describe("EncryptedNoteStore concurrent writes (#1077)", () => {
  it("concurrent adds never lose a note", async () => {
    const store = new EncryptedNoteStore(memoryBackend(), "pw");
    const count = 12;

    await Promise.all(Array.from({ length: count }, (_, i) => store.add(note(i))));

    const commitments = (await store.list()).map((n) => n.commitment).sort();
    expect(commitments).toEqual(
      Array.from({ length: count }, (_, i) => `0xc${i}`).sort(),
    );
  });

  it("an add and a markSpent racing each other both land", async () => {
    const store = new EncryptedNoteStore(memoryBackend(), "pw");
    await store.add(note(0));

    await Promise.all([store.add(note(1)), store.markSpent("0xc0"), store.add(note(2))]);

    const byCommitment = new Map((await store.list()).map((n) => [n.commitment, n]));
    expect([...byCommitment.keys()].sort()).toEqual(["0xc0", "0xc1", "0xc2"]);
    expect(byCommitment.get("0xc0")?.spent).toBe(true);
  });
});

describe("key derivation runs once per unlock (#1077)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("five writes and a read derive the PBKDF2 key a single time", async () => {
    const derive = vi.spyOn(crypto.subtle, "deriveKey");
    const store = new EncryptedNoteStore(memoryBackend(), "pw");

    for (let i = 0; i < 5; i += 1) await store.add(note(i));
    await store.list();

    expect(derive).toHaveBeenCalledTimes(1);
  });
});

describe("fileBackend writes atomically (#1077)", () => {
  it("leaves only the target blob on disk, with no temp file left behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opaque-notes-"));
    try {
      const store = new EncryptedNoteStore(fileBackend(dir), "pw");
      await store.add(note(0));
      await store.add(note(1));

      expect(await readdir(dir)).toEqual(["opaque:notes.json"]);

      const reopened = new EncryptedNoteStore(fileBackend(dir), "pw");
      const commitments = (await reopened.list()).map((n) => n.commitment).sort();
      expect(commitments).toEqual(["0xc0", "0xc1"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("EncryptedScanStore.deleteCursor (#1076 migration support)", () => {
  it("removes one identity's cursor and leaves the others untouched", async () => {
    const store = new EncryptedScanStore(memoryBackend(), "pw");
    await store.setCursor(10, "sc1:aa");
    await store.setCursor(20, "sc1:bb");

    await store.deleteCursor("sc1:aa");

    expect(await store.getCursor("sc1:aa")).toBeNull();
    expect(await store.getCursor("sc1:bb")).toBe(20);
  });
});
