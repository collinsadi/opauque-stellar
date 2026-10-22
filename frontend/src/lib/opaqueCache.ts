/**
 * OpaqueCache: IndexedDB persistence for announcement logs and per-cluster sync state.
 * Database: OpaqueCache
 * Stores: announcements (indexed by cluster, slot), syncState (keyed by cluster)
 */

import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export type CachedAnnouncement = {
  id: string;
  cluster: string;
  slot: number;
  transactionSignature: string;
  logIndex: number;
  args: {
    stealthAddress?: string;
    ephemeralPubKey?: string;
    metadata?: string;
  };
};

/** Inclusive ledger range the scanner could not read (e.g. pruned from RPC retention). */
export type UnscannedRange = {
  fromLedger: number;
  toLedger: number;
};

export type SyncState = {
  cluster: string;
  lastScannedSlot: number;
  /**
   * Ledgers inside the scan range that were never fetched because they fell
   * outside the RPC retention window. Announcements there are invisible to
   * this device, so the UI must disclose the gap rather than imply a complete
   * scan. Persisted so incremental syncs keep reporting it. Disjoint gaps are
   * kept as separate entries, sorted by `fromLedger`.
   */
  unscannedRanges?: UnscannedRange[];
  /** Single-span form written before gaps were stored separately. Read only. */
  unscannedRange?: UnscannedRange | null;
};

interface OpaqueCacheDBSchema extends DBSchema {
  announcements: {
    key: string;
    value: CachedAnnouncement;
    indexes: { "by-cluster": string; "by-slot": number; "by-cluster-slot": [string, number] };
  };
  syncState: {
    key: string;
    value: SyncState;
  };
}

const DB_NAME = "OpaqueCache";
// v3: the pre-fix scanner filtered announcement events with a single-segment
// topic and silently matched nothing, yet still advanced lastScannedSlot to the
// chain head. That leaves an empty cache with a sync cursor past every real
// announcement, so incremental syncs never re-fetch them. Bumping the version
// drops the stale stores on upgrade, forcing one clean backfill from the
// deployment ledger with the corrected two-segment topic filter.
// v4: announcement IDs changed from `${txHash}:${ledger}` (which collapsed
// multiple announcements in the same transaction to one entry) to
// `${cluster}-${txSig}-${logIndex}`. Upgrading from v3 re-keys the cached
// announcements in place (see rekeyV3Announcements) so discovered payments are
// kept. Events that v3 had already collapsed are not recoverable from the cache;
// a full rescan re-fetches them.
const DB_VERSION = 4;

let dbPromise: Promise<IDBPDatabase<OpaqueCacheDBSchema>> | null = null;

/**
 * Maps v3 announcement records (`id` = `${txHash}:${ledger}`, `logIndex` always 0)
 * onto the v4 id format. A v3 id is unique per transaction, so no record is merged
 * or dropped. Pure so the upgrade path can be tested without IndexedDB.
 */
export function rekeyV3Announcements(records: CachedAnnouncement[]): CachedAnnouncement[] {
  return records.map((record) => ({
    ...record,
    id: announcementId(record.cluster, record.transactionSignature, record.logIndex),
  }));
}

function getDB(): Promise<IDBPDatabase<OpaqueCacheDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<OpaqueCacheDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, transaction) {
        if (oldVersion === 3 && db.objectStoreNames.contains("announcements")) {
          // Read, transform, then rewrite inside the versionchange transaction. The
          // transform runs before the clear so a failure cannot leave the store empty.
          const store = transaction.objectStore("announcements");
          void (async () => {
            const rekeyed = rekeyV3Announcements(await store.getAll());
            await store.clear();
            for (const record of rekeyed) await store.put(record);
          })();
          return;
        }
        if (db.objectStoreNames.contains("announcements")) {
          db.deleteObjectStore("announcements");
        }
        if (db.objectStoreNames.contains("syncState")) {
          db.deleteObjectStore("syncState");
        }
        const announcements = db.createObjectStore("announcements", { keyPath: "id" });
        announcements.createIndex("by-cluster", "cluster");
        announcements.createIndex("by-slot", "slot");
        announcements.createIndex("by-cluster-slot", ["cluster", "slot"]);
        db.createObjectStore("syncState", { keyPath: "cluster" });
      },
    });
  }
  return dbPromise;
}

export function announcementId(cluster: string, txSig: string, logIndex: number): string {
  return `${cluster}-${txSig}-${logIndex}`;
}

export async function putAnnouncements(
  cluster: string,
  logs: Array<{
    transactionSignature?: string | null;
    logIndex?: number | null;
    slot?: number | null;
    args?: { stealthAddress?: string; ephemeralPubKey?: string; metadata?: string };
  }>
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("announcements", "readwrite");
  for (const log of logs) {
    const slot = log.slot ?? 0;
    const id = announcementId(
      cluster,
      log.transactionSignature ?? "",
      log.logIndex ?? 0
    );
    await tx.store.put({
      id,
      cluster,
      slot,
      transactionSignature: log.transactionSignature ?? "",
      logIndex: log.logIndex ?? 0,
      args: log.args ?? {},
    });
  }
  await tx.done;
}

export async function getAnnouncementsForCluster(cluster: string): Promise<CachedAnnouncement[]> {
  const db = await getDB();
  const index = db.transaction("announcements").store.index("by-cluster-slot");
  const range = IDBKeyRange.bound([cluster, 0], [cluster, Number.MAX_SAFE_INTEGER]);
  const all = await index.getAll(range);
  return all.sort((a, b) => a.slot - b.slot);
}

export async function getMaxSlotForCluster(cluster: string): Promise<number | null> {
  const db = await getDB();
  const index = db.transaction("announcements").store.index("by-cluster");
  const all = await index.getAll(cluster);
  if (all.length === 0) return null;
  return Math.max(...all.map((a) => a.slot));
}

export async function getSyncState(cluster: string): Promise<SyncState | null> {
  const db = await getDB();
  const state = await db.get("syncState", cluster);
  return state ?? null;
}

/**
 * Read-modify-write one cluster's sync state inside a single readwrite
 * transaction. IndexedDB runs overlapping readwrite transactions on the same
 * store one after another, so a cursor update and a gap update can no longer
 * read the same snapshot and overwrite each other's field.
 */
async function updateSyncState(
  cluster: string,
  update: (prev: SyncState | undefined) => SyncState,
): Promise<SyncState> {
  const db = await getDB();
  const tx = db.transaction("syncState", "readwrite");
  const next = update(await tx.store.get(cluster));
  await tx.store.put(next);
  await tx.done;
  return next;
}

/** Disjoint unscanned gaps for a sync state, including records written before gaps were split. */
export function getUnscannedRanges(state: SyncState | null | undefined): UnscannedRange[] {
  if (state?.unscannedRanges) return state.unscannedRanges;
  return state?.unscannedRange ? [state.unscannedRange] : [];
}

/**
 * Insert `range` into a sorted list of disjoint gaps. A gap is joined only with
 * the gaps it overlaps or touches, so ledgers that were scanned between two
 * gaps stay scanned.
 */
export function mergeUnscannedRanges(ranges: UnscannedRange[], range: UnscannedRange): UnscannedRange[] {
  const sorted = [...ranges, range].sort((a, b) => a.fromLedger - b.fromLedger);
  const merged: UnscannedRange[] = [];
  for (const next of sorted) {
    const last = merged[merged.length - 1];
    if (last && next.fromLedger <= last.toLedger + 1) {
      last.toLedger = Math.max(last.toLedger, next.toLedger);
    } else {
      merged.push({ ...next });
    }
  }
  return merged;
}

export async function setSyncState(cluster: string, lastScannedSlot: number): Promise<void> {
  // Keep any recorded unscanned ranges: advancing the cursor does not make
  // pruned ledgers readable again.
  await updateSyncState(cluster, (prev) => ({ ...prev, cluster, lastScannedSlot }));
}

/**
 * Add `range` to the cluster's recorded unscanned ranges. Creates the sync
 * state record if none exists yet. Returns the full list after the merge.
 */
export async function recordUnscannedRange(cluster: string, range: UnscannedRange): Promise<UnscannedRange[]> {
  const next = await updateSyncState(cluster, (prev) => ({
    ...prev,
    cluster,
    lastScannedSlot: prev?.lastScannedSlot ?? 0,
    unscannedRanges: mergeUnscannedRanges(getUnscannedRanges(prev), range),
  }));
  return getUnscannedRanges(next);
}

export async function clearSyncState(cluster: string): Promise<void> {
  const db = await getDB();
  await db.delete("syncState", cluster);
}

export async function clearClusterCache(cluster: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("announcements", "readwrite");
  const index = tx.store.index("by-cluster");
  const keys = await index.getAllKeys(cluster);
  for (const key of keys) await tx.store.delete(key);
  await tx.done;
  await db.delete("syncState", cluster);
}

export async function getAnnouncementCountForCluster(cluster: string): Promise<number> {
  const db = await getDB();
  const index = db.transaction("announcements").store.index("by-cluster");
  return index.count(cluster);
}

export async function clearAllData(): Promise<void> {
  const db = await getDB();
  const txAnnouncements = db.transaction("announcements", "readwrite");
  await txAnnouncements.store.clear();
  await txAnnouncements.done;
  const txSync = db.transaction("syncState", "readwrite");
  await txSync.store.clear();
  await txSync.done;
}
