/**
 * OpaqueCache — IndexedDB persistence for announcement logs and per-cluster sync state.
 * Database: OpaqueCache
 * Stores: announcements (indexed by cluster, slot), syncState (keyed by cluster)
 */

import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export type CachedAnnouncement = {
  id: string;
  /**
   * Composite dedup key derived from the Stellar Soroban event's own unique ID.
   * Used to prevent duplicate entries from reorgs or replayed RPC responses.
   * Format: Soroban event `id` when available; falls back to `${txSig}-${logIndex}`.
   */
  eventId: string;
  /** @deprecated Use `network` instead (Stellar) */
  cluster: string;
  /** @deprecated Use `ledger` instead (Stellar) */
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
  /** @deprecated Use `network` instead (Stellar) */
  cluster: string;
  /** @deprecated Use `lastScannedLedger` instead (Stellar) */
  lastScannedSlot: number;
  /** Timestamp when this checkpoint was created */
  checkpointTimestamp?: number;
  /** Version identifier for checkpoint format */
  checkpointVersion?: number;
  /** Network passphrase to detect network changes */
  networkPassphrase?: string;
};

interface OpaqueCacheDBSchema extends DBSchema {
  announcements: {
    key: string;
    value: CachedAnnouncement;
    indexes: {
      "by-cluster": string;
      "by-slot": number;
      "by-cluster-slot": [string, number];
      "by-event-id": string;
    };
  };
  syncState: {
    key: string;
    value: SyncState;
  };
  /** Incremental scan checkpoints for resume capability */
  scanCheckpoints: {
    key: string;
    value: {
      cluster: string;
      lastProcessedLedger: number;
      targetLedger: number;
      timestamp: number;
      networkPassphrase: string;
      partialResultsCount: number;
    };
  };
}

const DB_NAME = "OpaqueCache";
/** Schema version 3: adds `eventId` field + `by-event-id` index for dedup (#402) + scanCheckpoints store for resume (#396). */
const DB_VERSION = 3;
const CHECKPOINT_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<OpaqueCacheDBSchema>> | null = null;

function getDB(): Promise<IDBPDatabase<OpaqueCacheDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<OpaqueCacheDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 2) {
          if (db.objectStoreNames.contains("announcements")) {
            db.deleteObjectStore("announcements");
          }
          if (db.objectStoreNames.contains("syncState")) {
            db.deleteObjectStore("syncState");
          }
        }
        
        if (!db.objectStoreNames.contains("announcements")) {
          const announcements = db.createObjectStore("announcements", { keyPath: "id" });
          announcements.createIndex("by-cluster", "cluster");
          announcements.createIndex("by-slot", "slot");
          announcements.createIndex("by-cluster-slot", ["cluster", "slot"]);
          announcements.createIndex("by-event-id", "eventId");
        }
        
        if (!db.objectStoreNames.contains("syncState")) {
          db.createObjectStore("syncState", { keyPath: "cluster" });
        }
        
        if (oldVersion < 3 && !db.objectStoreNames.contains("scanCheckpoints")) {
          db.createObjectStore("scanCheckpoints", { keyPath: "cluster" });
        }
      },
    });
  }
  return dbPromise;
}

/** Legacy record ID from txSig + logIndex (fallback when no Soroban event ID is available). */
export function announcementId(cluster: string, txSig: string, logIndex: number): string {
  return `${cluster}-${txSig}-${logIndex}`;
}

/**
 * Derives the canonical IndexedDB record ID from a Stellar Soroban event ID.
 * Using the native event ID as the dedup key prevents duplicate entries when
 * the same event is re-fetched after a reorg or RPC replay (#402).
 */
export function announcementIdFromEventId(cluster: string, eventId: string): string {
  return `${cluster}:${eventId}`;
}

export async function putAnnouncements(
  cluster: string,
  logs: Array<{
    /** Stellar Soroban event unique ID — used as the primary dedup key when present. */
    eventId?: string | null;
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
    const fallbackEventId = `${log.transactionSignature ?? ""}-${log.logIndex ?? 0}`;
    const resolvedEventId = log.eventId ?? fallbackEventId;
    const id = log.eventId
      ? announcementIdFromEventId(cluster, log.eventId)
      : announcementId(cluster, log.transactionSignature ?? "", log.logIndex ?? 0);
    await tx.store.put({
      id,
      eventId: resolvedEventId,
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

// =============================================================================
// Incremental scan checkpoint persistence
// =============================================================================

export type ScanCheckpoint = {
  cluster: string;
  lastProcessedLedger: number;
  targetLedger: number;
  timestamp: number;
  networkPassphrase: string;
  partialResultsCount: number;
};

/**
 * Saves a scan checkpoint for resume capability.
 * Called periodically during long scans to enable resume on page reload.
 */
export async function saveScanCheckpoint(
  cluster: string,
  lastProcessedLedger: number,
  targetLedger: number,
  networkPassphrase: string
): Promise<void> {
  const db = await getDB();
  const partialResultsCount = await getAnnouncementCountForCluster(cluster);
  await db.put("scanCheckpoints", {
    cluster,
    lastProcessedLedger,
    targetLedger,
    timestamp: Date.now(),
    networkPassphrase,
    partialResultsCount,
  });
}

/**
 * Retrieves the scan checkpoint for a cluster.
 * Returns null if no checkpoint exists.
 */
export async function getScanCheckpoint(cluster: string): Promise<ScanCheckpoint | null> {
  const db = await getDB();
  const checkpoint = await db.get("scanCheckpoints", cluster);
  return checkpoint ?? null;
}

/**
 * Validates a checkpoint against current network state.
 * Returns true if checkpoint is valid and can be resumed.
 * Returns false if checkpoint is corrupt or network changed.
 */
export async function validateCheckpoint(
  cluster: string,
  currentNetworkPassphrase: string
): Promise<boolean> {
  const checkpoint = await getScanCheckpoint(cluster);
  if (!checkpoint) return false;
  
  // Check network passphrase matches (detects network change)
  if (checkpoint.networkPassphrase !== currentNetworkPassphrase) {
    console.warn(
      `[opaqueCache] Network passphrase mismatch for ${cluster}. Checkpoint invalid.`,
      { stored: checkpoint.networkPassphrase, current: currentNetworkPassphrase }
    );
    return false;
  }
  
  // Check timestamp is recent (within 7 days)
  const MAX_CHECKPOINT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const age = Date.now() - checkpoint.timestamp;
  if (age > MAX_CHECKPOINT_AGE_MS) {
    console.warn(
      `[opaqueCache] Checkpoint for ${cluster} is stale (${Math.round(age / 1000 / 60 / 60)}h old). Discarding.`
    );
    return false;
  }
  
  // Check ledger range is sane
  if (checkpoint.lastProcessedLedger > checkpoint.targetLedger) {
    console.warn(
      `[opaqueCache] Checkpoint for ${cluster} has invalid ledger range. Corrupt.`
    );
    return false;
  }
  
  // Check partial results count matches IndexedDB state
  const actualCount = await getAnnouncementCountForCluster(cluster);
  if (Math.abs(actualCount - checkpoint.partialResultsCount) > 100) {
    console.warn(
      `[opaqueCache] Checkpoint for ${cluster} has mismatched result count. Corrupt.`,
      { expected: checkpoint.partialResultsCount, actual: actualCount }
    );
    return false;
  }
  
  return true;
}

/**
 * Clears the scan checkpoint for a cluster.
 * Called after successful sync completion or when checkpoint is corrupt.
 */
export async function clearScanCheckpoint(cluster: string): Promise<void> {
  const db = await getDB();
  await db.delete("scanCheckpoints", cluster);
}

/**
 * Clears all checkpoints for all clusters.
 * Useful for global reset or network change detection.
 */
export async function clearAllCheckpoints(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("scanCheckpoints", "readwrite");
  await tx.store.clear();
  await tx.done;
}
