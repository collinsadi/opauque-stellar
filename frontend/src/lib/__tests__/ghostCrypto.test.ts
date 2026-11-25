import { describe, expect, it } from "vitest";
import {
  decryptGhostEntries,
  encryptGhostEntries,
  exportEncryptedBackup,
  importEncryptedBackup,
  type GhostEntryLike,
} from "../ghostCrypto";

const ENTRIES: GhostEntryLike[] = [
  {
    cluster: "testnet",
    stealthAddress: "0x1111111111111111111111111111111111111111",
    ephemeralPrivKeyHex: "0x" + "11".repeat(32),
    createdAt: 1_700_000_000,
  },
  {
    cluster: "testnet",
    stealthAddress: "0x2222222222222222222222222222222222222222",
    createdAt: 1_700_000_100,
  },
];

describe("ghostCrypto", () => {
  it("round-trips encrypted ghost entries", async () => {
    const payload = await encryptGhostEntries(ENTRIES, "correct horse battery");
    expect(payload.version).toBe(1);
    expect(payload.entries[0]?.ephemeralPrivKeyEncrypted).toBeDefined();
    expect(JSON.stringify(payload)).not.toContain("11".repeat(32));

    const restored = await decryptGhostEntries(payload, "correct horse battery");
    expect(restored).toEqual(ENTRIES);
  });

  it("rejects the wrong password", async () => {
    const payload = await encryptGhostEntries(ENTRIES, "right-pin");
    await expect(decryptGhostEntries(payload, "wrong-pin")).rejects.toThrow();
  });

  it("rejects unsupported payload versions", async () => {
    await expect(
      decryptGhostEntries(
        // Deliberately invalid: version 2 does not exist.
        { version: 2, salt: "AA==", entries: [] } as unknown as Parameters<typeof decryptGhostEntries>[0],
        "pin",
      ),
    ).rejects.toThrow("Unsupported encrypted payload version");
  });

  it("round-trips the backup helpers", async () => {
    const backup = await exportEncryptedBackup(ENTRIES, "pin-1234");
    const restored = await importEncryptedBackup(backup, "pin-1234");
    expect(restored).toEqual(ENTRIES);
  });
});
