/**
 * Per-account, per-cluster transaction history (last 50): sent, received, manual ghost discoveries.
 * Stored in localStorage keyed by `account:cluster`.
 * Token-aware: each entry includes tokenSymbol, tokenAddress, and formatted amount.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createEncryptedStorage } from "../lib/encryptedStorage";
import { getEncryptionPassphrase } from "../lib/getEncryptionPassphrase";
type Address = string;

const MAX_ITEMS_PER_CLUSTER = 50;
const STORAGE_KEY = "opaque-tx-history";

const hasRehydratedRef = { current: false };

/**
 * Encrypted localStorage adapter for transaction history.
 * Falls back to plaintext when no passphrase is set.
 */
const txHistoryStorage = createEncryptedStorage<TxHistoryState>(
  STORAGE_KEY,
  getEncryptionPassphrase,
);

export type TxHistoryKind = "sent" | "received" | "ghost" | "trait";

/** On-chain state of an entry's transaction (#113/#114). Absent = confirmed. */
export type TxHistoryChainStatus = "confirmed" | "failed" | "pending";

export type TxHistoryEntry = {
  id: string;
  cluster: string;
  kind: TxHistoryKind;
  counterparty: string;
  amountStroops: string;
  tokenSymbol: string;
  tokenAddress: Address | null;
  amount: string;
  txHash?: string;
  stealthAddress?: string;
  timestamp: number;
  chainStatus?: TxHistoryChainStatus;
};

export type TxHistoryPushInput = Omit<TxHistoryEntry, "id" | "timestamp">;

/**
 * Mask a long counterparty (e.g. a 66-byte stealth meta-address from older trait
 * entries) so it doesn't overflow history cards. Short, human-readable labels
 * like "Manual Ghost" and already-masked values are left untouched.
 */
export function maskCounterparty(value: string): string {
  const v = value.trim();
  if (v.length <= 24 || v.includes("…")) return v;
  return `${v.slice(0, 10)}…${v.slice(-6)}`;
}

/** Composite key: account:cluster */
function scopeKey(account: string | null, cluster: string): string {
  return account ? `${account}:${cluster}` : cluster;
}

type TxHistoryState = {
  byChain: Record<string, TxHistoryEntry[]>;
  activeAccount: string | null;
  setActiveAccount: (account: string | null) => void;
  push: (entry: TxHistoryPushInput) => void;
  getForCluster: (cluster: string) => TxHistoryEntry[];
  /** Replace a cluster's list with a chain-reconciled one (#113). */
  replaceForCluster: (cluster: string, entries: TxHistoryEntry[]) => void;
  /** Update the chain status of every entry carrying `txHash` (#114). */
  setChainStatus: (txHash: string, status: TxHistoryChainStatus) => void;
  /** Clear history for the active account and cluster. */
  clearForCluster: (cluster: string) => void;
  /** Clear all history. Pass `{ allAccounts: true }` to wipe everything. */
  clear: (opts?: { allAccounts?: boolean }) => void;
};

export const useTxHistoryStore = create<TxHistoryState>()(
  persist(
    (set, get) => ({
      byChain: {},
      activeAccount: null,

      setActiveAccount: (account) => set({ activeAccount: account }),

      push: (entry) =>
        set((state) => {
          const key = scopeKey(state.activeAccount, entry.cluster);
          const list = state.byChain[key] ?? [];
          if (entry.txHash) {
            const existingByTxHash = new Set(
              list.filter((e) => e.txHash).map((e) => e.txHash!),
            );
            if (existingByTxHash.has(entry.txHash)) return state;
          }
          const newEntry: TxHistoryEntry = {
            ...entry,
            tokenSymbol: entry.tokenSymbol ?? "XLM",
            tokenAddress: entry.tokenAddress ?? null,
            amount: entry.amount ?? "",
            id: `tx-${key}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            timestamp: Date.now(),
          };
          const next = [newEntry, ...list];
          const trimmed =
            next.length > MAX_ITEMS_PER_CLUSTER
              ? next.slice(0, MAX_ITEMS_PER_CLUSTER)
              : next;
          return {
            byChain: { ...state.byChain, [key]: trimmed },
          };
        }),

      getForCluster: (cluster) => {
        const state = get();
        const byChain = state.byChain;
        if (byChain == null || typeof byChain !== "object") return [];

        const key = scopeKey(state.activeAccount, cluster);
        const scoped = byChain[key];
        if (Array.isArray(scoped)) return scoped.slice();

        // Fallback: check the legacy unscoped key for backward compat
        const legacy = byChain[cluster];
        return Array.isArray(legacy) ? legacy.slice() : [];
      },

      replaceForCluster: (cluster, entries) =>
        set((state) => {
          const key = scopeKey(state.activeAccount, cluster);
          return {
            byChain: {
              ...state.byChain,
              [key]: entries.slice(0, MAX_ITEMS_PER_CLUSTER),
            },
          };
        }),

      setChainStatus: (txHash, status) =>
        set((state) => {
          let changed = false;
          const byChain: Record<string, TxHistoryEntry[]> = {};
          for (const [key, list] of Object.entries(state.byChain)) {
            byChain[key] = list.map((e) => {
              if (e.txHash !== txHash || e.chainStatus === status) return e;
              changed = true;
              return { ...e, chainStatus: status };
            });
          }
          return changed ? { byChain } : state;
        }),

      clearForCluster: (cluster) =>
        set((state) => {
          const key = scopeKey(state.activeAccount, cluster);
          return {
            byChain: { ...state.byChain, [key]: [] },
          };
        }),

      clear: (opts) =>
        set((state) => {
          if (opts?.allAccounts) return { byChain: {} };
          const acct = state.activeAccount;
          if (!acct) return { byChain: {} };
          // Remove only keys belonging to this account
          const byChain: Record<string, TxHistoryEntry[]> = {};
          for (const [key, list] of Object.entries(state.byChain)) {
            if (!key.startsWith(`${acct}:`)) {
              byChain[key] = list;
            }
          }
          return { byChain };
        }),
    }),
    {
      name: STORAGE_KEY,
      storage: txHistoryStorage,
      onRehydrateStorage: () => (_state, _err) => {
        hasRehydratedRef.current = true;
      },
      // Migrate plaintext data to encrypted when passphrase becomes available
      migrate: async (persistedState: unknown, version: number) => {
        return persistedState;
      },
    },
  ),
);
