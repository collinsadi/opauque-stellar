import { describe, it, expect, beforeAll } from "vitest";
import { RecoveryManager, BackupPayload, BackupFile } from "../services/recoveryManager";

// Polyfill crypto for node/vitest if necessary, though Vitest may have it.
import { webcrypto } from "node:crypto";

beforeAll(() => {
  if (!globalThis.crypto) {
    (globalThis as any).crypto = webcrypto;
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
