/**
 * Centralized local data lifecycle: disconnect vs full privacy wipe.
 * See docs/LOCAL_DATA_AND_DISCONNECT.md.
 */

import { deleteDB } from "idb";
import {
  useGhostAddressStore,
  GHOST_ADDRESSES_STORAGE_KEY,
  clearGhostPassword,
} from "../store/ghostAddressStore";
import { useVaultStore } from "../store/vaultStore";
import { useWatchlistStore } from "../hooks/useWatchlist";
import { useTxHistoryStore } from "../store/txHistoryStore";
import { useSchemaStore } from "../store/schemaStore";
import { useReputationStore } from "../store/reputationStore";
import { useGhostAnnouncementStore } from "../store/ghostAnnouncementStore";
import { useSecurityStore } from "../store/securityStore";
import { usePendingTxStore } from "../store/pendingTxStore";
import { removeLocalStorage } from "./storageHealth";

/** All localStorage keys used by Opaque (prefix opaque- or signature session). */
export const OPAQUE_LOCAL_STORAGE_KEYS = [
  GHOST_ADDRESSES_STORAGE_KEY,
  "opaque-vault-entries",
  "opaque-tx-history",
  "opaque-schema-store-v2",
  "opaque-pending-tx",
  "opaque-reputation-traits",
  "opaque-ghost-announced",
  "opaque-security-settings",
  "opaque-watchlist",
  "opaque-tour-done",
  "opaque-debug",
  "opaque-subens-name",
] as const;

const SESSION_SIGNATURE_KEYS = [
  "opaque.signature.session.data.v1",
  "opaque.signature.session.aes.v1",
  "opaque.signature.session.pref.v1",
] as const;

const OPAQUE_IDB_NAME = "OpaqueCache";

export type DisconnectScope = "session" | "all_local";

/**
 * Data cleared on wallet disconnect (session scope).
 * Ghost entries, history, schema cache, and IndexedDB announcements persist.
 */
export const PERSIST_ON_DISCONNECT = [
  "Ghost addresses (manual receives)",
  "Transaction history",
  "Schema and trait cache",
  "Announcement IndexedDB cache",
  "Watchlist",
  "Security acknowledgement flags",
] as const;

/**
 * Data removed by "Clear local data" (privacy wipe).
 */
export const CLEAR_ON_PRIVACY_WIPE = [
  ...OPAQUE_LOCAL_STORAGE_KEYS,
  "IndexedDB OpaqueCache (announcements + sync state)",
  "Session signature cache",
  "In-memory ghost encryption password",
  "Vault entries (also cleared on disconnect)",
] as const;

function clearSessionStorage(): void {
  if (typeof sessionStorage === "undefined") return;
  for (const key of SESSION_SIGNATURE_KEYS) {
    sessionStorage.removeItem(key);
  }
}

function removeAllOpaqueLocalStorage(): void {
  for (const key of OPAQUE_LOCAL_STORAGE_KEYS) {
    removeLocalStorage(key);
  }
}

async function deleteOpaqueIndexedDB(): Promise<void> {
  if (typeof window === "undefined" || !window.indexedDB) return;
  try {
    await deleteDB(OPAQUE_IDB_NAME);
  } catch {
    // best effort
  }
}

/** Reset in-memory Zustand stores after wiping persisted data. */
export function resetInMemoryStores(): void {
  useVaultStore.getState().clear();
  useGhostAddressStore.getState().setEntries([]);
  useWatchlistStore.setState({ entries: [] });
  useTxHistoryStore.getState().clear();
  useSchemaStore.setState({
    schemas: {},
    discoveredTraits: {},
    attestations: {},
    isFetchingSchemas: false,
    isScanning: false,
    lastScannedSlot: 0,
  });
  useReputationStore.getState().clearTraits();
  useGhostAnnouncementStore.setState({ keys: {} });
  usePendingTxStore.setState({ byHash: {} });
  clearGhostPassword();
}

export type DisconnectWalletCallbacks = {
  clearKeys: () => void;
  clearVault: () => void;
  disconnectWallet: () => void;
};

/**
 * Session disconnect: master keys, vault, signature session, in-memory ghost password.
 * Ghost entries, history, schema cache, and IndexedDB announcements persist.
 */
export function disconnectWalletSession(callbacks: DisconnectWalletCallbacks): void {
  clearGhostPassword();
  callbacks.clearKeys();
  callbacks.clearVault();
  callbacks.disconnectWallet();
}

/**
 * Privacy wipe: remove all sensitive local caches and metadata.
 * Does not disconnect Freighter; caller should clear in-memory keys separately.
 */
export async function clearAllLocalSensitiveData(): Promise<void> {
  removeAllOpaqueLocalStorage();
  clearSessionStorage();
  await deleteOpaqueIndexedDB();
  resetInMemoryStores();
  useSecurityStore.setState({
    hasBackedUp: false,
    hasAcknowledgedMainnetRisk: false,
    hasAcknowledgedReceiveRisk: false,
    expectedNetwork: useSecurityStore.getState().expectedNetwork,
  });
}
