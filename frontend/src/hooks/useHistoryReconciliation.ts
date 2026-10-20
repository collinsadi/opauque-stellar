/**
 * Runs chain-derived history reconciliation (#113) against the local store.
 *
 * - `reconcile()` is what the history view's "Sync from chain" button calls.
 *   This is the only path that queries Horizon unless the user opts in.
 * - With `autoOnEmpty` AND the persisted auto-sync opt-in, a fresh device
 *   (hydrated, empty local history for this cluster) reconciles once per
 *   cluster + wallet per session. Off by default.
 * - Ghost addresses sent in a query are limited to the connected account's
 *   own ghosts, so one account's wallet is never queried alongside another
 *   account's ghosts.
 *
 * Status lives in a shared store so the view reflects a sync started from
 * app boot.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { reconcileHistory, type ChainHistoryFetcher } from "../lib/history-reconciliation";
import { createHorizonHistoryFetcher } from "../lib/chainHistoryFetchers";
import { useTxHistoryStore, type TxHistoryEntry } from "../store/txHistoryStore";
import { useGhostAddressStore } from "../store/ghostAddressStore";

export type ReconcileStatus = "idle" | "syncing" | "done" | "error";

interface ReconcileState {
  status: ReconcileStatus;
  addedCount: number;
  error: string | null;
}

export const useReconcileStatusStore = create<ReconcileState>()(() => ({
  status: "idle",
  addedCount: 0,
  error: null,
}));

const HISTORY_SYNC_CONSENT_KEY = "opaque-history-auto-sync";

interface HistorySyncConsentState {
  /** Persisted per device. When true, an empty history rebuilds from chain on load. */
  autoSyncEnabled: boolean;
  setAutoSyncEnabled: (enabled: boolean) => void;
}

export const useHistorySyncConsentStore = create<HistorySyncConsentState>()(
  persist(
    (set) => ({
      autoSyncEnabled: false,
      setAutoSyncEnabled: (enabled) => set({ autoSyncEnabled: enabled }),
    }),
    {
      name: HISTORY_SYNC_CONSENT_KEY,
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

/** Cluster:address keys already auto-reconciled this session. */
const autoAttempted = new Set<string>();

/** Test hook: forget auto-reconcile attempts and reset status. */
export function resetHistoryReconciliationState(): void {
  autoAttempted.clear();
  useReconcileStatusStore.setState({ status: "idle", addedCount: 0, error: null });
}

function subscribeHydration(cb: () => void): () => void {
  return useTxHistoryStore.persist?.onFinishHydration(() => cb()) ?? (() => {});
}

function getHydrated(): boolean {
  return useTxHistoryStore.persist?.hasHydrated() ?? true;
}

export interface UseHistoryReconciliationOptions {
  cluster: string;
  address: string | null | undefined;
  enabled?: boolean;
  autoOnEmpty?: boolean;
  /** Override for tests; defaults to the Horizon fetcher. */
  fetcher?: ChainHistoryFetcher;
}

export function useHistoryReconciliation({
  cluster,
  address,
  enabled = true,
  autoOnEmpty = false,
  fetcher,
}: UseHistoryReconciliationOptions) {
  const hydrated = useSyncExternalStore(subscribeHydration, getHydrated, getHydrated);
  const localCount = useTxHistoryStore((s) => s.byChain[cluster]?.length ?? 0);
  const autoSyncEnabled = useHistorySyncConsentStore((s) => s.autoSyncEnabled);
  const ghostEntries = useGhostAddressStore((s) => s.entries);
  const ghostAddresses = useMemo(
    () =>
      ghostEntries
        .filter(
          (e) =>
            e.cluster === cluster &&
            !!address &&
            e.account === address &&
            !!e.stealthStellarAddress,
        )
        .map((e) => e.stealthStellarAddress!),
    [ghostEntries, cluster, address],
  );
  const status = useReconcileStatusStore();

  const reconcile = useCallback(async () => {
    if (!address) return;
    if (useReconcileStatusStore.getState().status === "syncing") return;
    useReconcileStatusStore.setState({ status: "syncing", error: null });
    try {
      const chain = await (fetcher ?? createHorizonHistoryFetcher(address))({
        cluster,
        ghostAddresses,
      });
      // Read local after the fetch so rows pushed meanwhile aren't dropped.
      const local = useTxHistoryStore.getState().getForCluster(cluster);
      const result = reconcileHistory(local, chain);
      // reconcileHistory only carries hash-bearing rows; keep the rest.
      const hashless = local.filter((e) => !e.txHash);
      const merged: TxHistoryEntry[] = [...result.entries, ...hashless].sort(
        (a, b) => b.timestamp - a.timestamp,
      );
      useTxHistoryStore.getState().replaceForCluster(cluster, merged);
      useReconcileStatusStore.setState({ status: "done", addedCount: result.addedCount });
    } catch (err) {
      useReconcileStatusStore.setState({
        status: "error",
        error: err instanceof Error ? err.message : "History sync failed",
      });
    }
  }, [address, cluster, ghostAddresses, fetcher]);

  useEffect(() => {
    if (!enabled || !autoOnEmpty || !autoSyncEnabled || !hydrated || !address || localCount > 0) return;
    const key = `${cluster}:${address}`;
    if (autoAttempted.has(key)) return;
    autoAttempted.add(key);
    void reconcile();
  }, [enabled, autoOnEmpty, autoSyncEnabled, hydrated, address, cluster, localCount, reconcile]);

  return { ...status, reconcile, canReconcile: enabled && !!address };
}
