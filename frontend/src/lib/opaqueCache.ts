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

export type SyncState = {
  cluster: string;
  lastScannedSlot: number;
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
// `${cluster}-${txSig}-${logIndex}`. Bumping the version drops the stale
// stores so they are rebuilt with correct per-event IDs.
const DB_VERSION = 4;

let dbPromise: Promise<IDBPDatabase<OpaqueCacheDBSchema>> | null = null;

function getDB(): Promise<IDBPDatabase<OpaqueCacheDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<OpaqueCacheDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
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

export async function setSyncState(cluster: string, lastScannedSlot: number): Promise<void> {
  const db = await getDB();
  await db.put("syncState", { cluster, lastScannedSlot });
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
