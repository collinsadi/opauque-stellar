import { Keypair } from "@stellar/stellar-sdk";
import { RecoveryManager } from "./recoveryManager";
import type { BackupFile } from "./recoveryManager";

const LEGACY_KEYS_STORAGE_KEY = "opaque-legacy-keys";

export interface MetaAddress {
  address: string;
  isLegacy: boolean;
  isDeprecated: boolean;
  createdAt: string;
}

export class KeyRotationManager {
  /**
   * Generates a new meta-address using a real Ed25519 keypair.
   * Full DKSAP derivation (scan key + spend key → meta-address) requires
   * on-chain context not available in the frontend key service; this produces
   * a valid Stellar StrKey that is cryptographically distinct from the current
   * address and can be registered on-chain in a follow-up step.
   */
  static async generateNewMetaAddress(_currentAddress: string): Promise<string> {
    return Keypair.random().publicKey();
  }

  /**
   * Records an address as legacy in localStorage so it can still be used to
   * sweep any pending ghost funds that arrived before the rotation.
   */
  static markAddressAsLegacy(address: string): void {
    if (!address) return;
    try {
      const raw = localStorage.getItem(LEGACY_KEYS_STORAGE_KEY);
      const existing: string[] = raw ? (JSON.parse(raw) as string[]) : [];
      if (!existing.includes(address)) {
        existing.push(address);
        localStorage.setItem(LEGACY_KEYS_STORAGE_KEY, JSON.stringify(existing));
      }
    } catch {
      // Ignore storage errors
    }
  }

  /** Returns all addresses that have been rotated away from. */
  static getLegacyAddresses(): string[] {
    try {
      const raw = localStorage.getItem(LEGACY_KEYS_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * Exports an AES-256-GCM encrypted backup that includes both the old and
   * new addresses plus rotation metadata, then triggers a .opq file download.
   */
  static async exportRotationBackup(
    password: string,
    oldAddress: string,
    newAddress: string,
  ): Promise<BackupFile> {
    const backup = await RecoveryManager.exportBackup(password, {
      stealthMasterKeys: [],
      metaAddresses: [oldAddress, newAddress],
      scanKeys: [],
      ghostEntries: [],
      recoveryMetadata: {
        rotatedFrom: oldAddress,
        rotatedTo: newAddress,
        rotatedAt: new Date().toISOString(),
      },
    });
    RecoveryManager.downloadBackupFile(backup);
    return backup;
  }

  static getMigrationSteps() {
    return [
      { id: 1, title: "Generate new address" },
      { id: 2, title: "Export backup" },
      { id: 3, title: "Mark old as legacy" },
      { id: 4, title: "Notify sender contacts" },
      { id: 5, title: "Confirm cutover" },
    ];
  }
}
