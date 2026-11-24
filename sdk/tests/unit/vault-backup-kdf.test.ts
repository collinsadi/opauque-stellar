/**
 * #1071 — vault backups record their PBKDF2 iteration count and decrypt with it,
 * so formatVersion-2 files written at 100,000 iterations still open.
 */
import { describe, it, expect } from "vitest";
import { exportVaultBackup, importVaultBackup, type VaultBackupFile } from "../../src/crypto/backup";

const PASSWORD = "correct horse battery staple";
const PAYLOAD = {
  stealthMasterKeys: ["k1"],
  metaAddresses: [],
  scanKeys: [],
  ghostEntries: [],
  notes: [{ id: 1 }],
};

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** Build a vault file the way an older writer (or the frontend's recoveryManager) would. */
async function craft(opts: {
  iterations: number;
  formatVersion: number;
  record: boolean;
}): Promise<VaultBackupFile> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(PASSWORD), "PBKDF2", false, [
    "deriveKey",
  ]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: opts.iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new TextEncoder().encode(JSON.stringify(PAYLOAD))),
  );
  const checksum = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", ct)))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  return {
    version: 1,
    formatVersion: opts.formatVersion,
    timestamp: new Date().toISOString(),
    checksum,
    encrypted_payload: b64(ct),
    salt: b64(salt),
    nonce: b64(nonce),
    ...(opts.record ? { iterations: opts.iterations } : {}),
  };
}

describe("vault backup KDF parameters (#1071)", () => {
  it("records the iteration count in new backups and round-trips", async () => {
    const file = await exportVaultBackup(PAYLOAD, PASSWORD);
    expect(file.formatVersion).toBe(2);
    expect(file.iterations).toBe(600_000);
    const out = await importVaultBackup(file, PASSWORD);
    expect(out.notes).toEqual(PAYLOAD.notes);
  });

  it("decrypts an existing formatVersion-2 file written with 100,000 iterations (no recorded count)", async () => {
    const file = await craft({ iterations: 100_000, formatVersion: 2, record: false });
    const out = await importVaultBackup(file, PASSWORD);
    expect(out.stealthMasterKeys).toEqual(["k1"]);
  });

  it("decrypts a frontend-style v2 file that records `iterations: 100000`", async () => {
    const file = await craft({ iterations: 100_000, formatVersion: 2, record: true });
    const out = await importVaultBackup(file, PASSWORD);
    expect(out.notes).toEqual(PAYLOAD.notes);
  });

  it("decrypts a 600,000-iteration v2 file with no recorded count", async () => {
    const file = await craft({ iterations: 600_000, formatVersion: 2, record: false });
    expect((await importVaultBackup(file, PASSWORD)).stealthMasterKeys).toEqual(["k1"]);
  });

  it("rejects a wrong password and an absurd recorded iteration count", async () => {
    const file = await exportVaultBackup(PAYLOAD, PASSWORD);
    await expect(importVaultBackup(file, "nope")).rejects.toThrow(/Invalid password/);
    await expect(importVaultBackup({ ...file, iterations: 2_000_000_000 }, PASSWORD)).rejects.toThrow(
      /out of range/,
    );
  });
});
