/**
 * Persistent store for discovered stealth addresses (owned by this recipient).
 * Uses Zustand with encrypted localStorage persistence via Web Crypto AES-GCM.
 * Master private keys are NEVER stored here. Data is passphrase-derived encrypted.
 *
 * Threat model: protects against localStorage read-only access (XSS
 * exfiltration, browser extensions). Does NOT protect against:
 * - XSS that captures the passphrase at entry time
 * - Runtime memory inspection while data is decrypted
 * - Compromised browser extensions with full DOM access
 *
 * Encryption: AES-256-GCM with PBKDF2-derived key (600k iterations).
 * The passphrase is held in memory only via securitySettingsStore.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createEncryptedStorage } from "../lib/encryptedStorage";
import { getEncryptionPassphrase } from "../lib/getEncryptionPassphrase";
type Address = string;
type Hex = string;

const VAULT_STORAGE_KEY = "opaque-vault-entries";

export type StealthVaultEntry = {
  /** Stealth address (one-time) */
  stealthAddress: Address;
  /** Ephemeral public key from announcement (33 bytes), stored as hex for persistence */
  ephemeralPubKeyHex: Hex;
  /** Block number of the Announcement event */
  blockNumber: bigint;
  /** Transaction hash that emitted the announcement */
  txHash: Hex;
  /** Stellar G-address holding stealth funds (derived Ed25519 account) */
  stellarAddress?: string;
  /** Native XLM balance in stroops (updated by refreshBalances) */
  amountStroops: bigint;
  /** Whether this address has been spent (withdrawn) */
  isSpent: boolean;
};

type VaultState = {
  entries: StealthVaultEntry[];
  /** Last block we synced up to (historical) */
  lastSyncedBlock: bigint | null;
  /** Add or update a single entry (idempotent by stealthAddress) */
  upsertEntry: (
    entry: Omit<StealthVaultEntry, "amountStroops"> & {
      amountStroops?: bigint;
    },
  ) => void;
  /** Mark entry as spent */
  markSpent: (stealthAddress: Address) => void;
  /** Update balances for a set of addresses (by stealthAddress) */
  setBalances: (
    updates: Array<{ stealthAddress: Address; amountStroops: bigint }>,
  ) => void;
  /** Set last synced block */
  setLastSyncedBlock: (block: bigint | null) => void;
  /** Get entry by stealth address */
  getEntry: (stealthAddress: Address) => StealthVaultEntry | undefined;
  /** Remove all entries (e.g. logout) */
  clear: () => void;
};

const defaultState = {
  entries: [] as StealthVaultEntry[],
  lastSyncedBlock: null as bigint | null,
};

const vaultStorage = createEncryptedStorage<VaultState>(
  VAULT_STORAGE_KEY,
  getEncryptionPassphrase,
);

export const useVaultStore = create<VaultState>()(
  persist(
    (set, get) => ({
      ...defaultState,

      upsertEntry: (entry) =>
        set((state) => {
          const normalized = {
            ...entry,
            amountStroops: entry.amountStroops ?? 0n,
          };
          const idx = state.entries.findIndex(
            (e) =>
              e.stealthAddress.toLowerCase() ===
              normalized.stealthAddress.toLowerCase(),
          );
          const next = [...state.entries];
          if (idx >= 0) {
            next[idx] = { ...next[idx], ...normalized };
          } else {
            next.push(normalized as StealthVaultEntry);
          }
          return { entries: next };
        }),

      markSpent: (stealthAddress) =>
        set((state) => {
          return {
            entries: state.entries.map((e) =>
              e.stealthAddress.toLowerCase() === stealthAddress.toLowerCase()
                ? { ...e, isSpent: true }
                : e,
            ),
          };
        }),

      setBalances: (updates) =>
        set((state) => {
          const map = new Map(
            updates.map((u) => [u.stealthAddress.toLowerCase(), u.amountStroops]),
          );
          return {
            entries: state.entries.map((e) => {
              const stroops = map.get(e.stealthAddress.toLowerCase());
              return stroops !== undefined
                ? { ...e, amountStroops: stroops }
                : e;
            }),
          };
        }),

      setLastSyncedBlock: (block) => {
        set({ lastSyncedBlock: block });
      },

      getEntry: (stealthAddress) =>
        get().entries.find(
          (e) =>
            e.stealthAddress.toLowerCase() === stealthAddress.toLowerCase(),
        ),

      clear: () => {
        set(defaultState);
      },
    }),
    {
      name: VAULT_STORAGE_KEY,
      storage: vaultStorage,
      onRehydrateStorage: () => (_state, _err) => {
        /* hydrated */
      },
      // Migrate plaintext data to encrypted when passphrase becomes available
      // Both encrypted (v1) and legacy plaintext state already have the VaultState
      // shape; encryptedStorage re-encrypts plaintext on the next write.
      migrate: async (persistedState: unknown) => persistedState as VaultState,
    }
  ),
);