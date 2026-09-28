/**
 * Watchlist: addresses to poll for balances (state-polling fallback).
 * Manual imports and generated ghost addresses are added here so we can detect
 * direct transfers that don't appear in Announcement events.
 * Archived entries stay in the list but are excluded from RPC polling.
 *
 * Scoped by `account` (wallet public key) so switching Freighter accounts on a
 * shared machine does not expose another user's watchlist.
 */

import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

type Address = string;

export type WatchlistEntry = {
  cluster: string;
  address: Address;
  /** When true, we stop polling this address to keep RPC calls small. */
  archived: boolean;
  addedAt: number;
  /** Wallet public key that owns this entry. Legacy entries may not have this. */
  account?: string;
};

const STORAGE_KEY = "opaque-watchlist";

type WatchlistState = {
  entries: WatchlistEntry[];
  activeAccount: string | null;
  setActiveAccount: (account: string | null) => void;
  add: (cluster: string, address: Address) => void;
  archive: (cluster: string, address: string) => void;
  remove: (cluster: string, address: string) => void;
  unarchive: (cluster: string, address: string) => void;
  getActiveAddresses: (cluster: string) => Address[];
  getEntriesForCluster: (cluster: string) => WatchlistEntry[];
  /** Clear entries for the active account. Pass `{ allAccounts: true }` to wipe everything. */
  clear: (opts?: { cluster?: string; allAccounts?: boolean }) => void;
};

function matchesAccount(entry: WatchlistEntry, account: string | null): boolean {
  if (!account) return true;
  return !entry.account || entry.account === account;
}

export const useWatchlistStore = create<WatchlistState>()(
  persist(
    (set, get) => ({
      entries: [],
      activeAccount: null,

      setActiveAccount: (account) => set({ activeAccount: account }),

      add: (cluster, address) =>
        set((state) => {
          const acct = state.activeAccount;
          const existing = state.entries.find(
            (e) =>
              e.cluster === cluster &&
              e.address === address &&
              matchesAccount(e, acct),
          );
          if (existing) {
            return {
              entries: state.entries.map((e) =>
                e === existing ? { ...e, archived: false } : e
              ),
            };
          }
          return {
            entries: [
              ...state.entries,
              {
                cluster,
                address,
                archived: false,
                addedAt: Date.now(),
                account: acct ?? undefined,
              },
            ],
          };
        }),

      archive: (cluster, address) =>
        set((state) => ({
          entries: state.entries.map((e) =>
            e.cluster === cluster &&
            e.address === address &&
            matchesAccount(e, state.activeAccount)
              ? { ...e, archived: true }
              : e
          ),
        })),

      remove: (cluster, address) =>
        set((state) => ({
          entries: state.entries.filter(
            (e) =>
              !(
                e.cluster === cluster &&
                e.address === address &&
                matchesAccount(e, state.activeAccount)
              ),
          ),
        })),

      unarchive: (cluster, address) =>
        set((state) => ({
          entries: state.entries.map((e) =>
            e.cluster === cluster &&
            e.address === address &&
            matchesAccount(e, state.activeAccount)
              ? { ...e, archived: false }
              : e
          ),
        })),

      getActiveAddresses: (cluster) => {
        const state = get();
        return state.entries
          .filter(
            (e) =>
              e.cluster === cluster &&
              !e.archived &&
              matchesAccount(e, state.activeAccount),
          )
          .map((e) => e.address);
      },

      getEntriesForCluster: (cluster) => {
        const state = get();
        return state.entries.filter(
          (e) =>
            e.cluster === cluster &&
            matchesAccount(e, state.activeAccount),
        );
      },

      clear: (opts) =>
        set((state) => {
          if (opts?.allAccounts) return { entries: [] };
          const acct = state.activeAccount;
          return {
            entries: state.entries.filter((e) => {
              // Keep entries from other accounts
              if (acct && e.account && e.account !== acct) return true;
              // If cluster-scoped, keep entries from other clusters
              if (opts?.cluster && e.cluster !== opts.cluster) return true;
              return false;
            }),
          };
        }),
    }),
    { name: STORAGE_KEY }
  )
);

/** Hook-friendly: returns active watchlist addresses for the given cluster. */
export function useWatchlist(cluster: string | null): Address[] {
  const entries = useWatchlistStore((state) => state.entries);
  const activeAccount = useWatchlistStore((state) => state.activeAccount);
  return useMemo(() => {
    if (cluster == null) return [];
    return entries
      .filter(
        (e) =>
          e.cluster === cluster &&
          !e.archived &&
          matchesAccount(e, activeAccount),
      )
      .map((e) => e.address);
  }, [cluster, entries, activeAccount]);
}
