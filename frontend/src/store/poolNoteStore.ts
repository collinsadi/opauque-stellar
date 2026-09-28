/**
 * Persisted privacy-pool notes (spending material). Notes are SECRETS — losing them
 * loses the funds — so they are persisted to localStorage and exposed for inclusion in
 * the wallet's encrypted backup/recovery flow via `exportNotes`/`importNotes`.
 *
 * Notes are scoped by `account` (wallet public key) so switching Freighter accounts
 * on a shared machine does not expose another user's spending material.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { PoolNote } from "../lib/poolNotes";
import { createEncryptedStorage } from "../lib/encryptedStorage";
import { getEncryptionPassphrase } from "../lib/getEncryptionPassphrase";

export type ImportConflict = {
  /** Number of notes in the import that were already locally marked as spent. */
  spentPreserved: number;
  /** Number of notes that were new or updated from the import. */
  imported: number;
};

function noteKey(n: PoolNote): string {
  return `${n.cluster}:${n.poolId ?? ""}:${n.leafIndex}`;
}

type PoolNoteState = {
  /** All notes across all accounts. The `account` field scopes them. */
  notes: PoolNote[];
  /** The currently active wallet public key. Set on connect/switch. */
  activeAccount: string | null;
  setActiveAccount: (account: string | null) => void;
  addNote: (note: PoolNote) => void;
  /** Mark the note with this leaf index (on a pool) spent. */
  markSpent: (cluster: string, poolId: string | undefined, leafIndex: number) => void;
  /** Returns notes for the active account and cluster. */
  getForCluster: (cluster: string) => PoolNote[];
  /** Merge imported notes conservatively: locally spent notes are never reverted.
   *  Returns conflict counts so the caller can inform the user. */
  importNotes: (notes: PoolNote[]) => ImportConflict;
  exportNotes: () => PoolNote[];
  /** Clear notes for the active account and optionally a specific cluster.
   *  Pass `{ allAccounts: true }` to wipe everything. */
  clear: (opts?: { cluster?: string; allAccounts?: boolean }) => void;
};

export const usePoolNoteStore = create<PoolNoteState>()(
  persist(
    (set, get) => ({
      notes: [],
      activeAccount: null,
      setActiveAccount: (account) => set({ activeAccount: account }),
      addNote: (note) =>
        set((s) => {
          const enriched = { ...note, account: note.account ?? s.activeAccount ?? undefined };
          // De-dup by (cluster, poolId, leafIndex). Legacy notes have no poolId.
          const without = s.notes.filter(
            (n) =>
              !(
                n.cluster === enriched.cluster &&
                (n.poolId ?? "") === (enriched.poolId ?? "") &&
                n.leafIndex === enriched.leafIndex &&
                (n.account ?? "") === (enriched.account ?? "")
              ),
          );
          return { notes: [...without, enriched] };
        }),
      markSpent: (cluster, poolId, leafIndex) =>
        set((s) => ({
          notes: s.notes.map((n) =>
            n.cluster === cluster &&
            (n.poolId ?? "") === (poolId ?? "") &&
            n.leafIndex === leafIndex &&
            (n.account ?? "") === (s.activeAccount ?? "")
              ? { ...n, spent: true }
              : n,
          ),
        })),
      getForCluster: (cluster) => {
        const s = get();
        const acct = s.activeAccount;
        return s.notes.filter(
          (n) =>
            n.cluster === cluster &&
            // Show notes belonging to this account, or legacy notes with no account.
            (!acct || !n.account || n.account === acct),
        );
      },
      importNotes: (notes) => {
        let spentPreserved = 0;
        let imported = 0;
        set((s) => {
          const acct = s.activeAccount;
          const byKey = new Map<string, PoolNote>();
          // Seed with existing local notes.
          for (const n of s.notes) {
            byKey.set(noteKey(n), n);
          }
          // Merge imported notes, but never revert a locally-spent note.
          for (const raw of notes) {
            const incoming = { ...raw, account: raw.account ?? acct ?? undefined };
            const key = noteKey(incoming);
            const existing = byKey.get(key);
            if (existing?.spent && !incoming.spent) {
              spentPreserved++;
              continue;
            }
            imported++;
            byKey.set(key, existing?.spent ? existing : incoming);
          }
          return { notes: [...byKey.values()] };
        });
        return { spentPreserved, imported };
      },
      exportNotes: () => {
        const s = get();
        const acct = s.activeAccount;
        return s.notes.filter((n) => !acct || !n.account || n.account === acct);
      },
      clear: (opts) =>
        set((s) => {
          if (opts?.allAccounts) return { notes: [] };
          const acct = s.activeAccount;
          return {
            notes: s.notes.filter((n) => {
              // Keep notes from other accounts
              if (acct && n.account && n.account !== acct) return true;
              // If cluster-scoped, keep notes from other clusters
              if (opts?.cluster && n.cluster !== opts.cluster) return true;
              return false;
            }),
          };
        }),
    }),
    {
      name: "opaque.pool.notes.v1",
      storage: createEncryptedStorage<PoolNoteState>(
        "opaque.pool.notes.v1",
        getEncryptionPassphrase,
      ),
    },
  ),
);
