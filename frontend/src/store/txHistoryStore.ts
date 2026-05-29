/**
 * Per-cluster transaction history (last 50): sent, received, manual ghost discoveries.
 * Stored in localStorage keyed by cluster.
 * Token-aware: each entry includes tokenSymbol, tokenAddress, and formatted amount.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
type Address = string;

const MAX_ITEMS_PER_CLUSTER = 50;
const STORAGE_KEY = "opaque-tx-history";

const hasRehydratedRef = { current: false };

export type TxHistoryKind = "sent" | "received" | "ghost" | "trait";

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
};

export type TxHistoryPushInput = Omit<TxHistoryEntry, "id" | "timestamp">;

type TxHistoryState = {
  byChain: Record<string, TxHistoryEntry[]>;
  push: (entry: TxHistoryPushInput) => void;
  getForCluster: (cluster: string) => TxHistoryEntry[];
  clearForCluster: (cluster: string) => void;
  clear: () => void;
};

const txHistoryStorage = createJSONStorage<TxHistoryState>(() => ({
  getItem: (name: string): string | null => {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(name);
  },
  setItem: (name: string, value: string): void => {
    if (typeof localStorage === "undefined") return;
    if (!hasRehydratedRef.current) return;
    localStorage.setItem(name, value);
  },
  removeItem: (name: string): void => {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(name);
  },
}));

export const useTxHistoryStore = create<TxHistoryState>()(
  persist(
    (set, get) => ({
      byChain: {},

      push: (entry) =>
        set((state) => {
          const cluster = entry.cluster;
          const list = state.byChain[cluster] ?? [];
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
            id: `tx-${cluster}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            timestamp: Date.now(),
          };
          const next = [newEntry, ...list];
          const trimmed =
            next.length > MAX_ITEMS_PER_CLUSTER
              ? next.slice(0, MAX_ITEMS_PER_CLUSTER)
              : next;
          return {
            byChain: { ...state.byChain, [cluster]: trimmed },
          };
        }),

      getForCluster: (cluster) => {
        const byChain = get().byChain;
        if (byChain == null || typeof byChain !== "object") return [];
        const list = byChain[cluster];
        return Array.isArray(list) ? list.slice() : [];
      },

      clearForCluster: (cluster) =>
        set((state) => ({
          byChain: { ...state.byChain, [cluster]: [] },
        })),

      clear: () => set({ byChain: {} }),
    }),
    {
      name: STORAGE_KEY,
      storage: txHistoryStorage,
      onRehydrateStorage: () => (_state, _err) => {
        hasRehydratedRef.current = true;
      },
    },
  ),
);
