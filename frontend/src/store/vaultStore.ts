/**
 * Persistent store for discovered stealth addresses (owned by this recipient).
 * Uses Zustand with localStorage persistence. Master private keys are NEVER stored here.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
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
            console.log("🗄️ [Opaque] Vault upsert (update)", {
              stealth: normalized.stealthAddress.slice(0, 14) + "…",
            });
          } else {
            next.push(normalized as StealthVaultEntry);
            console.log("🗄️ [Opaque] Vault upsert (new)", {
              stealth: normalized.stealthAddress.slice(0, 14) + "…",
              block: String(normalized.blockNumber),
            });
          }
          return { entries: next };
        }),

      markSpent: (stealthAddress) =>
        set((state) => {
          console.log("🗄️ [Opaque] Vault markSpent", {
            stealth: stealthAddress.slice(0, 14) + "…",
          });
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
            updates.map((u) => [
              u.stealthAddress.toLowerCase(),
              u.amountStroops,
            ]),
          );
          const changed = updates.length;
          if (changed > 0)
            console.log("🗄️ [Opaque] Vault setBalances", { count: changed });
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
        if (block !== null)
          console.log("🗄️ [Opaque] Vault setLastSyncedBlock", {
            block: String(block),
          });
        set({ lastSyncedBlock: block });
      },

      getEntry: (stealthAddress) =>
        get().entries.find(
          (e) =>
            e.stealthAddress.toLowerCase() === stealthAddress.toLowerCase(),
        ),

      clear: () => {
        console.log("🗄️ [Opaque] Vault clear");
        set(defaultState);
      },
    }),
    {
      name: VAULT_STORAGE_KEY,
      partialize: (s) => ({
        entries: s.entries.map((e) => ({
          ...e,
          blockNumber: e.blockNumber.toString(),
          amountStroops: e.amountStroops.toString(),
        })),
        lastSyncedBlock:
          s.lastSyncedBlock !== null ? s.lastSyncedBlock.toString() : null,
      }),
      merge: (persisted, current) => {
        const p = persisted as {
          entries?: Array<
            Omit<StealthVaultEntry, "blockNumber" | "amountStroops"> & {
              blockNumber?: string;
              amountStroops?: string;
              amountWei?: string; // Legacy field for migration
            }
          >;
          lastSyncedBlock?: string | null;
        };
        if (p.entries?.length)
          console.log("🗄️ [Opaque] Vault rehydrated from storage", {
            entries: p.entries.length,
            lastSynced: p.lastSyncedBlock ?? null,
          });
        const entries: StealthVaultEntry[] = (p.entries ?? []).map((e) => ({
          ...e,
          blockNumber:
            typeof e.blockNumber === "string"
              ? BigInt(e.blockNumber)
              : e.blockNumber !== undefined
                ? e.blockNumber
                : 0n,
          // Migration: support old amountWei field
          amountStroops:
            typeof e.amountStroops === "string"
              ? BigInt(e.amountStroops)
              : typeof e.amountWei === "string"
                ? BigInt(e.amountWei)
                : (e.amountStroops ?? 0n),
        }));
        return {
          ...current,
          entries,
          lastSyncedBlock:
            p.lastSyncedBlock != null
              ? BigInt(p.lastSyncedBlock)
              : current.lastSyncedBlock,
        };
      },
    },
  ),
);
