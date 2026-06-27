import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type ProofHistoryStatus = "generated" | "verified" | "failed";

export type ProofHistoryEntry = {
  id: string;
  cluster: string;
  schemaId: string;
  schemaName: string;
  nullifierHash: string;
  externalNullifier: string;
  merkleRoot: string;
  attestationId: string;
  txHash?: string;
  status: ProofHistoryStatus;
  error?: string;
  source: "local" | "on-chain";
  timestamp: number;
};

type ProofHistoryInput = Omit<ProofHistoryEntry, "id" | "timestamp">;

type ProofHistoryState = {
  entries: ProofHistoryEntry[];
  upsert: (entry: ProofHistoryInput) => void;
  getForCluster: (cluster: string) => ProofHistoryEntry[];
  clear: () => void;
};

function historyKey(entry: Pick<ProofHistoryEntry, "cluster" | "schemaId" | "nullifierHash" | "externalNullifier">) {
  return [
    entry.cluster,
    entry.schemaId.toLowerCase(),
    entry.nullifierHash,
    entry.externalNullifier,
  ].join(":");
}

export const useProofHistoryStore = create<ProofHistoryState>()(
  persist(
    (set, get) => ({
      entries: [],

      upsert: (entry) =>
        set((state) => {
          const nextEntry: ProofHistoryEntry = {
            ...entry,
            id: `proof-${historyKey(entry)}`,
            timestamp: Date.now(),
          };
          const key = historyKey(nextEntry);
          const existing = state.entries.findIndex((item) => historyKey(item) === key);
          if (existing === -1) {
            return { entries: [nextEntry, ...state.entries].slice(0, 100) };
          }
          const entries = state.entries.slice();
          entries[existing] = { ...entries[existing], ...nextEntry };
          return { entries };
        }),

      getForCluster: (cluster) =>
        get()
          .entries.filter((entry) => entry.cluster === cluster)
          .sort((a, b) => b.timestamp - a.timestamp),

      clear: () => set({ entries: [] }),
    }),
    {
      name: "opaque-proof-history",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
