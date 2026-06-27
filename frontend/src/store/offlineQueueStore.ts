import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type OfflineQueuedIntent =
  | {
      id: string;
      type: "send";
      recipient: string;
      amount: string;
      cluster: string;
      createdAt: number;
    }
  | {
      id: string;
      type: "scan_traits";
      cluster: string;
      createdAt: number;
    };

type OfflineQueueState = {
  intents: OfflineQueuedIntent[];
  enqueueSend: (input: { recipient: string; amount: string; cluster: string }) => string;
  enqueueTraitScan: (input: { cluster: string }) => string;
  remove: (id: string) => void;
  clear: () => void;
};

function makeId(type: OfflineQueuedIntent["type"], cluster: string) {
  return `${type}-${cluster}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export const useOfflineQueueStore = create<OfflineQueueState>()(
  persist(
    (set) => ({
      intents: [],

      enqueueSend: ({ recipient, amount, cluster }) => {
        const normalizedRecipient = recipient.trim();
        const normalizedAmount = amount.trim();
        const id = makeId("send", cluster);
        set((state) => {
          const duplicate = state.intents.some(
            (intent) =>
              intent.type === "send" &&
              intent.cluster === cluster &&
              intent.recipient === normalizedRecipient &&
              intent.amount === normalizedAmount,
          );
          if (duplicate) return state;
          return {
            intents: [
              ...state.intents,
              {
                id,
                type: "send",
                recipient: normalizedRecipient,
                amount: normalizedAmount,
                cluster,
                createdAt: Date.now(),
              },
            ],
          };
        });
        return id;
      },

      enqueueTraitScan: ({ cluster }) => {
        const id = makeId("scan_traits", cluster);
        set((state) => {
          const duplicate = state.intents.some(
            (intent) => intent.type === "scan_traits" && intent.cluster === cluster,
          );
          if (duplicate) return state;
          return {
            intents: [
              ...state.intents,
              { id, type: "scan_traits", cluster, createdAt: Date.now() },
            ],
          };
        });
        return id;
      },

      remove: (id) =>
        set((state) => ({
          intents: state.intents.filter((intent) => intent.id !== id),
        })),

      clear: () => set({ intents: [] }),
    }),
    {
      name: "opaque-offline-intent-queue",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

export function isLikelyOfflineError(error: unknown): boolean {
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /network|offline|fetch|failed to fetch|load failed|timeout|connection/i.test(message);
}
