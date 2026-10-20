/**
 * "Pending Manual Receives": manual ghost receive addresses per chain.
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

type Address = string;

export type GhostEntry = {
  cluster: string;
  stealthAddress: Address;
  /** Stellar ed25519 G-address derived from the stealth key. This is where XLM
   *  is actually held, so balances must be queried at this address (not the 0x
   *  identifier). Optional for entries created before this field existed. */
  stealthStellarAddress?: string;
  /** Hex 0x... 32-byte ephemeral private key for key reconstruction. Omitted when importing by address only (balance visible, claim requires key). */
  ephemeralPrivKeyHex?: string;
  /** Connected wallet G-address that owns this ghost. Entries without it are
   *  unattributed and are never included in account-scoped chain queries. */
  account?: string;
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
    stealthStellarAddress:
      entry.stealthStellarAddress != null && entry.stealthStellarAddress !== ""
        ? String(entry.stealthStellarAddress)
        : undefined,
    ephemeralPrivKeyHex:
      entry.ephemeralPrivKeyHex != null && entry.ephemeralPrivKeyHex !== ""
        ? String(entry.ephemeralPrivKeyHex)
        : undefined,
    account: entry.account != null && entry.account !== "" ? String(entry.account) : undefined,
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

type GhostState = {
  entries: GhostEntry[];
  persistenceFailed: boolean;
  /** Connected wallet G-address; stamped onto entries created while set. */
  activeAccount: string | null;
  setActiveAccount: (account: string | null) => void;
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

async function persistEntries(entries: GhostEntry[]): Promise<boolean> {
  if (typeof localStorage === "undefined") return false;
  try {
    if (_password) {
      const encrypted = await encryptGhostEntries(entries, _password);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(encrypted));
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    }
    return true;
  } catch {
    return false;
  }
}

export const useGhostAddressStore = create<GhostState>()((set, get) => ({
  entries: [],
  persistenceFailed: false,
  activeAccount: null,
  setActiveAccount: (account) => set({ activeAccount: account }),

  add: (entry) => {
    if (
      entry.ephemeralPrivKeyHex == null ||
      entry.ephemeralPrivKeyHex === ""
    ) {
      return;
    }
    const newEntry = normalizeEntry({
      ...entry,
      account: entry.account ?? get().activeAccount ?? undefined,
    });
    const nextEntries = [...get().entries, newEntry];
    set({ entries: nextEntries });
    void persistEntries(nextEntries).then((ok) => {
      if (!ok) set({ persistenceFailed: true });
    });
  },

  remove: (stealthAddress, cluster) =>
    set((state) => {
      const entries = state.entries.filter(
        (e) =>
          e.cluster !== cluster ||
          String(e.stealthAddress).toLowerCase() !==
            stealthAddress.toLowerCase(),
      );
      void persistEntries(entries).then((ok) => {
        if (!ok) set({ persistenceFailed: true });
      });
      return { entries };
    }),

  setEntries: (entries) =>
    set({
      entries: entries.map((e) => ({
        cluster: String(e.cluster),
        stealthAddress: String(e.stealthAddress) as Address,
        stealthStellarAddress:
          e.stealthStellarAddress != null
            ? String(e.stealthStellarAddress)
            : undefined,
        ephemeralPrivKeyHex:
          e.ephemeralPrivKeyHex != null
            ? String(e.ephemeralPrivKeyHex)
            : undefined,
        account: e.account != null ? String(e.account) : undefined,
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
        // No password set yet, can't decrypt, wait for password
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
    void persistEntries(entries).then((ok) => {
      if (!ok) useGhostAddressStore.setState({ persistenceFailed: true });
    });
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
