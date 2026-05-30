/**
 * Transaction history reconciliation from chain (#113).
 *
 * Local history was localStorage-only; clearing browser storage or
 * switching devices made it vanish. This module rebuilds the
 * `TxHistoryEntry` list from on-chain sources and merges the result
 * back into the local store, deduped by tx hash.
 *
 * The chain side is injected via a `ChainHistoryFetcher` so unit
 * tests can drive the merge logic without touching Horizon /
 * Soroban; production wiring fills it from
 * `services/stellarClient.ts` (Horizon `operations` + Soroban event
 * stream) — same pattern the scanner already uses.
 *
 * Acceptance criteria:
 *   - History can be rebuilt after clearing local storage.
 *   - Duplicate entries are deduped by tx hash.
 *   - Failed/pending states are represented.
 */

import type { TxHistoryEntry } from "../store/txHistoryStore";

export type ChainHistoryStatus = "confirmed" | "failed" | "pending";

/** Single entry produced by the chain side, in pre-merge form. */
export interface ChainHistoryItem {
  txHash: string;
  /** Cluster / network the tx belongs to. */
  cluster: string;
  kind: TxHistoryEntry["kind"];
  counterparty: string;
  amountStroops: string;
  amount: string;
  tokenSymbol: string;
  tokenAddress: string | null;
  stealthAddress?: string;
  /** Unix ms when the operation was created on chain. */
  timestamp: number;
  status: ChainHistoryStatus;
}

export type ChainHistoryFetcher = (input: {
  cluster: string;
  ghostAddresses: string[];
  since?: number;
}) => Promise<ChainHistoryItem[]>;

export interface ReconciledHistory {
  /** Final, deduped + sorted entries — UI consumes this directly. */
  entries: ReconciledEntry[];
  /** How many on-chain items were merged onto the existing store. */
  addedCount: number;
  /** How many duplicates were skipped by tx-hash. */
  dedupedCount: number;
}

export interface ReconciledEntry extends TxHistoryEntry {
  /** Surface the chain status on every reconciled entry. */
  chainStatus: ChainHistoryStatus;
}

/**
 * Merge the chain-side payload with whatever local history exists.
 * Local entries win the metadata battle (the user's labels / kind
 * classification stay) but the chain status is always taken from the
 * latest chain read, so a `pending` entry that the chain now reports
 * as `failed` flips to `failed`.
 */
export function reconcileHistory(
  local: TxHistoryEntry[],
  chain: ChainHistoryItem[],
): ReconciledHistory {
  const byHash = new Map<string, ReconciledEntry>();
  let dedupedCount = 0;

  // Seed with local entries. We assume locally-stored entries are
  // either user-authored (no chain status — treat as confirmed
  // implicitly) or already-merged from a prior reconciliation
  // (chain status not stored).
  for (const entry of local) {
    if (!entry.txHash) continue;
    byHash.set(entry.txHash, { ...entry, chainStatus: "confirmed" });
  }

  let addedCount = 0;
  for (const item of chain) {
    const existing = byHash.get(item.txHash);
    if (existing) {
      dedupedCount += 1;
      byHash.set(item.txHash, {
        ...existing,
        // Always trust the freshest chain status for pending → terminal flips.
        chainStatus: item.status,
        // Backfill empty local fields from the chain payload when present.
        stealthAddress: existing.stealthAddress ?? item.stealthAddress,
      });
      continue;
    }
    addedCount += 1;
    byHash.set(item.txHash, {
      id: `chain-${item.cluster}-${item.txHash}`,
      cluster: item.cluster,
      kind: item.kind,
      counterparty: item.counterparty,
      amountStroops: item.amountStroops,
      amount: item.amount,
      tokenSymbol: item.tokenSymbol,
      tokenAddress: item.tokenAddress,
      stealthAddress: item.stealthAddress,
      txHash: item.txHash,
      timestamp: item.timestamp,
      chainStatus: item.status,
    });
  }

  const entries = Array.from(byHash.values()).sort((a, b) => b.timestamp - a.timestamp);
  return { entries, addedCount, dedupedCount };
}

/**
 * Convenience: fetch + merge + return. Production callers wire the
 * `local` slice from `useTxHistoryStore.getState().getForCluster(...)`
 * and `fetch` from the chain client.
 */
export async function reconcileFromChain(
  fetch: ChainHistoryFetcher,
  args: { local: TxHistoryEntry[]; cluster: string; ghostAddresses: string[]; since?: number },
): Promise<ReconciledHistory> {
  const chain = await fetch({
    cluster: args.cluster,
    ghostAddresses: args.ghostAddresses,
    since: args.since,
  });
  return reconcileHistory(args.local, chain);
}
