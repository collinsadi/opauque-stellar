/**
 * "Pending Manual Receives" — manual ghost receive addresses per chain.
 * Used for one-time receive without on-chain announcement; scanner checks balance via multicall.
 * Persisted (localStorage) so the app can monitor and claim incoming funds.
 *
 * Ephemeral private keys are encrypted at rest using a user-held password (PBKDF2 + AES-256-GCM).
 * See docs/GHOST_THREAT_MODEL.md for residual browser compromise risks.
 */

import { useEffect, useRef } from "react";
import { create } from "zustand";
import {
  encryptGhostEntries,
  decryptGhostEntries,
  type EncryptedGhostPayload,
} from "../lib/ghostCrypto";
import {
  classifyStorageError,
  storageFailureMessage,
  writeLocalStorage,
  type StorageWriteResult,
} from "../lib/storageHealth";

type Address = string;

export type GhostEntry = {
  cluster: string;
  stealthAddress: Address;
  /** Hex 0x... 32-byte ephemeral private key for key reconstruction. Omitted when importing by address only (balance visible, claim requires key). */
  ephemeralPrivKeyHex?: string;
  createdAt: number;
};

export const GHOST_ADDRESSES_STORAGE_KEY = "opaque-ghost-addresses";

const STORAGE_KEY = GHOST_ADDRESSES_STORAGE_KEY;

/** Module-level password held in memory only. Never persisted. */
let _password: string | null = null;

export function setGhostPassword(password: string): void {
  _password = password;
}

export function clearGhostPassword(): void {
  _password = null;
}

export function hasGhostPassword(): boolean {
  return _password !== null;
}

/** Read ghost entries from the in-memory store (synchronous, for use in scanner). */
export function getStoredGhostEntries(): GhostEntry[] {
  return useGhostAddressStore.getState().entries;
}

/** Normalize entry so all fields are JSON-safe (explicit strings where needed). */
function normalizeEntry(entry: Omit<GhostEntry, "createdAt">): GhostEntry {
  return {
    cluster: String(entry.cluster),
    stealthAddress: String(entry.stealthAddress) as Address,
    ephemeralPrivKeyHex:
      entry.ephemeralPrivKeyHex != null && entry.ephemeralPrivKeyHex !== ""
        ? String(entry.ephemeralPrivKeyHex)
        : undefined,
    createdAt: Number(Date.now()),
  };
}

/** Parse stored payload: supports raw array or legacy persist shape. */
function parseStored(raw: string | null): GhostEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed;
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray(
        (parsed as { state?: { entries?: unknown } }).state?.entries,
      )
    ) {
      return (parsed as { state: { entries: GhostEntry[] } }).state.entries;
    }
    return [];
  } catch {
    return [];
  }
}

type GhostPersistListener = (result: StorageWriteResult) => void;
let _persistListener: GhostPersistListener | null = null;

export function setGhostPersistListener(listener: GhostPersistListener | null): void {
  _persistListener = listener;
}

type GhostState = {
  entries: GhostEntry[];
  add: (entry: Omit<GhostEntry, "createdAt">) => void;
  remove: (stealthAddress: string, cluster: string) => void;
  /** Replace entries (used when rehydrating from localStorage). */
  setEntries: (entries: GhostEntry[]) => void;
  /** Remove entries missing ephemeralPrivKeyHex (zombies). Call on app mount. */
  sanitizeGhostAddresses: () => void;
  /** Find a single entry by stealthAddress and cluster (for withdrawal matching). */
  getEntry: (
    stealthAddress: string,
    cluster: string,
  ) => GhostEntry | undefined;
  getForCluster: (cluster: string) => GhostEntry[];
};

export async function persistGhostEntries(
  entries: GhostEntry[],
): Promise<StorageWriteResult> {
  if (typeof localStorage === "undefined") {
    return {
      ok: false,
      kind: "unavailable",
      message: "Browser storage is unavailable.",
    };
  }
  try {
    const payload = _password
      ? await encryptGhostEntries(entries, _password)
      : entries;
    return writeLocalStorage(STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    const kind = classifyStorageError(error);
    return { ok: false, kind, message: storageFailureMessage(kind) };
  }
}

function notifyPersistResult(result: StorageWriteResult): void {
  if (!result.ok) _persistListener?.(result);
}

export const useGhostAddressStore = create<GhostState>()((set, get) => ({
  entries: [],

  add: (entry) => {
    if (
      entry.ephemeralPrivKeyHex == null ||
      entry.ephemeralPrivKeyHex === ""
    ) {
      return;
    }
    const newEntry = normalizeEntry(entry);
    set((state) => ({
      entries: [...state.entries, newEntry],
    }));
  },

  remove: (stealthAddress, cluster) =>
    set((state) => {
      const entries = state.entries.filter(
        (e) =>
          e.cluster !== cluster ||
          String(e.stealthAddress).toLowerCase() !==
            stealthAddress.toLowerCase(),
      );
      void persistGhostEntries(entries).then(notifyPersistResult);
      return { entries };
    }),

  setEntries: (entries) =>
    set({
      entries: entries.map((e) => ({
        cluster: String(e.cluster),
        stealthAddress: String(e.stealthAddress) as Address,
        ephemeralPrivKeyHex:
          e.ephemeralPrivKeyHex != null
            ? String(e.ephemeralPrivKeyHex)
            : undefined,
        createdAt: Number(e.createdAt),
      })),
    }),

  sanitizeGhostAddresses: () =>
    set((state) => ({
      entries: state.entries.filter((e) => !!e.ephemeralPrivKeyHex),
    })),

  getEntry: (stealthAddress, cluster) =>
    get().entries.find(
      (e) =>
        e.cluster === cluster &&
        String(e.stealthAddress).toLowerCase() ===
          stealthAddress.toLowerCase(),
    ),

  getForCluster: (cluster: string) =>
    get().entries.filter((e) => e.cluster === cluster),
}));

/**
 * Loads ghost entries from localStorage on mount and persists whenever entries change.
 * Skips writing an empty array until the first load has completed to avoid overwriting storage on initial load.
 */
export function useGhostAddressPersistence(): void {
  const entries = useGhostAddressStore((s) => s.entries);
  const setEntries = useGhostAddressStore((s) => s.setEntries);
  const hasLoadedFromStorage = useRef(false);

  // Rehydrate from localStorage once on mount; mark loaded so we don't write during/after initial load until ready
  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      hasLoadedFromStorage.current = true;
      return;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      // Encrypted format
      if (
        parsed &&
        typeof parsed === "object" &&
        "version" in parsed &&
        "salt" in parsed
      ) {
        if (_password) {
          void decryptGhostEntries(
            parsed as EncryptedGhostPayload,
            _password,
          ).then((decrypted) => {
            setEntries(decrypted as GhostEntry[]);
            hasLoadedFromStorage.current = true;
          });
          return;
        }
        // No password set yet — can't decrypt, wait for password
        hasLoadedFromStorage.current = true;
        return;
      }
      // Legacy plaintext
      const stored = parseStored(raw);
      setEntries(stored);
    } catch {
      // corrupt data
    }
    hasLoadedFromStorage.current = true;
  }, [setEntries]);

  // Persist whenever entries change. Hydration guard: do not write until initial getItem has completed.
  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    if (!hasLoadedFromStorage.current) return;
    void persistGhostEntries(entries).then(notifyPersistResult);
  }, [entries]);
}

/**
 * Re-decrypt entries after password is set (call this after setGhostPassword).
 */
export async function rehydrateWithPassword(): Promise<void> {
  if (typeof localStorage === "undefined" || !_password) return;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "version" in parsed &&
      "salt" in parsed
    ) {
      const decrypted = await decryptGhostEntries(
        parsed as EncryptedGhostPayload,
        _password,
      );
      useGhostAddressStore.getState().setEntries(decrypted as GhostEntry[]);
    }
  } catch {
    // wrong password or corrupt data
  }
}
