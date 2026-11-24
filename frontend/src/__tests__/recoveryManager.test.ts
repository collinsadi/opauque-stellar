import { describe, it, expect, beforeAll } from "vitest";
import { RecoveryManager, type BackupPayload, type BackupFile } from "../services/recoveryManager";

// Polyfill crypto for node/vitest if necessary, though Vitest may have it.
import { webcrypto } from "node:crypto";

beforeAll(() => {
  if (!globalThis.crypto) {
    (globalThis as { crypto?: Crypto }).crypto = webcrypto as unknown as Crypto;
  }
});

describe("RecoveryManager", () => {
  const dummyPayload: BackupPayload = {
    stealthMasterKeys: [{ key: "test-key" }],
    metaAddresses: [{ address: "test-address" }],
    scanKeys: [],
    ghostEntries: [],
    recoveryMetadata: { version: 1 }
  };
  const password = "SuperSecretPassword123!";

  it("should encrypt and decrypt payload correctly", async () => {
    const backup: BackupFile = await RecoveryManager.exportBackup(password, dummyPayload);
    
    expect(backup.version).toBe(1);
    expect(backup.encrypted_payload).toBeDefined();
    expect(backup.salt).toBeDefined();
    expect(backup.nonce).toBeDefined();

    const restoredPayload = await RecoveryManager.importBackup(password, backup);
    
    expect(restoredPayload).toEqual(dummyPayload);
  });

  it("should fail decryption with wrong password", async () => {
    const backup: BackupFile = await RecoveryManager.exportBackup(password, dummyPayload);
    
    await expect(RecoveryManager.importBackup("WrongPassword", backup)).rejects.toThrow();
  });

  it("should fail with corrupted payload", async () => {
    const backup: BackupFile = await RecoveryManager.exportBackup(password, dummyPayload);
    backup.encrypted_payload = "bad" + backup.encrypted_payload.substring(3);
    
    await expect(RecoveryManager.importBackup(password, backup)).rejects.toThrow();
  });
});

describe("RecoveryManager KDF compatibility (#1071)", () => {
  const password = "SuperSecretPassword123!";
  const payload: BackupPayload = {
    stealthMasterKeys: [{ key: "k" }],
    metaAddresses: [],
    scanKeys: [],
    ghostEntries: [],
    recoveryMetadata: {},
  };

  async function craft(iterations: number, record: boolean): Promise<BackupFile> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new TextEncoder().encode(JSON.stringify(payload))),
    );
    const checksum = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", ct)))
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    return {
      version: 1,
      formatVersion: 2,
      timestamp: new Date().toISOString(),
      checksum,
      encrypted_payload: btoa(String.fromCharCode(...ct)),
      salt: btoa(String.fromCharCode(...salt)),
      nonce: btoa(String.fromCharCode(...nonce)),
      ...(record ? { iterations } : {}),
    } as BackupFile;
  }

  it("opens a v2 file at 100,000 iterations with or without a recorded count", async () => {
    for (const record of [false, true]) {
      const out = await RecoveryManager.importBackup(password, await craft(100_000, record));
      expect(out.stealthMasterKeys).toEqual(payload.stealthMasterKeys);
    }
  });

  it("opens an SDK-style v2 file that records 600,000 iterations", async () => {
    const out = await RecoveryManager.importBackup(password, await craft(600_000, true));
    expect(out.stealthMasterKeys).toEqual(payload.stealthMasterKeys);
  });
});
