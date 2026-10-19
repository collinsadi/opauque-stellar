import { KDF_ITERATIONS, KDF_KEY_LENGTH_BITS, KDF_PARAMS } from "../lib/kdfConfig";

export interface BackupPayload {
  stealthMasterKeys: unknown[];
  metaAddresses: unknown[];
  scanKeys: unknown[];
  ghostEntries: unknown[];
  recoveryMetadata: unknown;
}

export interface BackupFile {
  $schema?: string;
  version: number;
  formatVersion?: number;
  timestamp: string;
  checksum?: string; // SHA-256 hex of encrypted payload
  encrypted_payload: string; // Base64
  salt: string; // Base64
  nonce: string; // Base64
  /** PBKDF2 iteration count used for this payload. Absent on legacy files (100,000). */
  iterations?: number;
}

/** Iterations used by pre-unified backups; used when `iterations` is absent. */
const LEGACY_ITERATIONS = 100_000;

export class RecoveryManager {
  private static ITERATIONS = KDF_ITERATIONS;
  private static KEY_LENGTH = KDF_KEY_LENGTH_BITS;

  private static async getDerivationKey(password: string): Promise<CryptoKey> {
    const enc = new TextEncoder();
    return globalThis.crypto.subtle.importKey(
      "raw",
      enc.encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveKey"],
    );
  }

  private static async deriveAESKey(
    passwordKey: CryptoKey,
    salt: Uint8Array,
    iterations: number = this.ITERATIONS,
  ): Promise<CryptoKey> {
    return globalThis.crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: new Uint8Array(salt),
        iterations,
        hash: "SHA-256",
      },
      passwordKey,
      { name: "AES-GCM", length: this.KEY_LENGTH },
      false,
      ["encrypt", "decrypt"],
    );
  }

  private static async computeChecksum(data: Uint8Array): Promise<string> {
    const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  static async exportBackup(
    password: string,
    payload: BackupPayload,
  ): Promise<BackupFile> {
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));

    const passwordKey = await this.getDerivationKey(password);
    const aesKey = await this.deriveAESKey(passwordKey, salt);

    const enc = new TextEncoder();
    const encodedPayload = enc.encode(JSON.stringify(payload));

    const encryptedContent = await globalThis.crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
      },
      aesKey,
      encodedPayload,
    );

    const ciphertext = new Uint8Array(encryptedContent);
    const checksum = await this.computeChecksum(ciphertext);

    return {
      $schema: "https://opaque.cash/schemas/recovery-backup-v2.json",
      version: 1,
      formatVersion: 2,
      timestamp: new Date().toISOString(),
      checksum,
      encrypted_payload: btoa(String.fromCharCode(...ciphertext)),
      salt: btoa(String.fromCharCode(...salt)),
      nonce: btoa(String.fromCharCode(...nonce)),
      iterations: KDF_PARAMS.iterations,
    };
  }

  static async importBackup(
    password: string,
    backup: BackupFile,
  ): Promise<BackupPayload> {
    if (!backup || !backup.encrypted_payload || !backup.salt || !backup.nonce) {
      throw new Error("Corrupted backup file: missing required fields.");
    }

    const salt = Uint8Array.from(atob(backup.salt), (c) => c.charCodeAt(0));
    const nonce = Uint8Array.from(atob(backup.nonce), (c) => c.charCodeAt(0));
    const encryptedData = Uint8Array.from(atob(backup.encrypted_payload), (c) =>
      c.charCodeAt(0),
    );

    // Verify integrity checksum if present (v2+)
    if (backup.checksum) {
      const computed = await this.computeChecksum(encryptedData);
      if (computed.toLowerCase() !== backup.checksum.toLowerCase()) {
        throw new Error("Integrity check failed: corrupted backup payload.");
      }
    }

    const passwordKey = await this.getDerivationKey(password);
    const iterations =
      typeof backup.iterations === "number" && backup.iterations > 0
        ? backup.iterations
        : LEGACY_ITERATIONS;
    const aesKey = await this.deriveAESKey(passwordKey, salt, iterations);

    try {
      const decryptedContent = await globalThis.crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: nonce,
        },
        aesKey,
        encryptedData,
      );

      const dec = new TextDecoder();
      const decodedPayload = dec.decode(decryptedContent);
      const parsed = JSON.parse(decodedPayload) as Record<string, unknown>;

      // Auto-migrate legacy structures if needed
      return {
        stealthMasterKeys: Array.isArray(parsed.stealthMasterKeys)
          ? parsed.stealthMasterKeys
          : [],
        metaAddresses: Array.isArray(parsed.metaAddresses)
          ? parsed.metaAddresses
          : [],
        scanKeys: Array.isArray(parsed.scanKeys) ? parsed.scanKeys : [],
        ghostEntries: Array.isArray(parsed.ghostEntries)
          ? parsed.ghostEntries
          : [],
        recoveryMetadata: parsed.recoveryMetadata ?? {},
      };
    } catch (e) {
      if (e instanceof Error && e.message.includes("Integrity check failed")) {
        throw e;
      }
      throw new Error("Invalid password or corrupted backup file.");
    }
  }

  static downloadBackupFile(backup: BackupFile) {
    const dateStr = new Date().toISOString().split("T")[0];
    const fileName = `opaque-backup-v${backup.formatVersion || backup.version || 1}-${dateStr}.opq`;
    const blob = new Blob([JSON.stringify(backup, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}
