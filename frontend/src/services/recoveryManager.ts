export interface BackupPayload {
  stealthMasterKeys: any[];
  metaAddresses: any[];
  scanKeys: any[];
  ghostEntries: any[];
  recoveryMetadata: any;
}

export interface BackupFile {
  version: number;
  timestamp: string;
  encrypted_payload: string; // Base64
  salt: string; // Base64
  nonce: string; // Base64
}

export class RecoveryManager {
  private static ITERATIONS = 100000;
  private static KEY_LENGTH = 256;

  private static async getDerivationKey(password: string): Promise<CryptoKey> {
    const enc = new TextEncoder();
    return window.crypto.subtle.importKey(
      "raw",
      enc.encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );
  }

  private static async deriveAESKey(passwordKey: CryptoKey, salt: Uint8Array): Promise<CryptoKey> {
    return window.crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt,
        iterations: this.ITERATIONS,
        hash: "SHA-256",
      },
      passwordKey,
      { name: "AES-GCM", length: this.KEY_LENGTH },
      false,
      ["encrypt", "decrypt"]
    );
  }

  static async exportBackup(password: string, payload: BackupPayload): Promise<BackupFile> {
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const nonce = window.crypto.getRandomValues(new Uint8Array(12));

    const passwordKey = await this.getDerivationKey(password);
    const aesKey = await this.deriveAESKey(passwordKey, salt);

    const enc = new TextEncoder();
    const encodedPayload = enc.encode(JSON.stringify(payload));

    const encryptedContent = await window.crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
      },
      aesKey,
      encodedPayload
    );

    return {
      version: 1,
      timestamp: new Date().toISOString(),
      encrypted_payload: btoa(String.fromCharCode(...new Uint8Array(encryptedContent))),
      salt: btoa(String.fromCharCode(...salt)),
      nonce: btoa(String.fromCharCode(...nonce)),
    };
  }

  static async importBackup(password: string, backup: BackupFile): Promise<BackupPayload> {
    const salt = Uint8Array.from(atob(backup.salt), c => c.charCodeAt(0));
    const nonce = Uint8Array.from(atob(backup.nonce), c => c.charCodeAt(0));
    const encryptedData = Uint8Array.from(atob(backup.encrypted_payload), c => c.charCodeAt(0));

    const passwordKey = await this.getDerivationKey(password);
    const aesKey = await this.deriveAESKey(passwordKey, salt);

    try {
      const decryptedContent = await window.crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: nonce,
        },
        aesKey,
        encryptedData
      );

      const dec = new TextDecoder();
      const decodedPayload = dec.decode(decryptedContent);
      return JSON.parse(decodedPayload) as BackupPayload;
    } catch (e) {
      throw new Error("Invalid password or corrupted backup file.");
    }
  }

  static downloadBackupFile(backup: BackupFile) {
    const dateStr = new Date().toISOString().split('T')[0];
    const fileName = `opaque-backup-${dateStr}.opq`;
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
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
