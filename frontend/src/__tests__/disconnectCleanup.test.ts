import { describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * Asserts that a full-wipe disconnect removes all sensitive opaque-* keys
 * from localStorage. This test exercises the cleanup logic inline since
 * the actual `executeDisconnect` lives in a React component.
 */

// Simulated localStorage keys that each store persists
const OPAQUE_STORAGE_KEYS = [
  "opaque-vault-entries",
  "opaque-tx-history",
  "opaque.pool.notes.v1",
  "opaque-ghost-addresses",
  "opaque-ghost-announced",
  "opaque-watchlist",
  "opaque-issued-attestations-v1",
  "opaque-schema-store-v2",
  "opaque-pending-tx",
  "opaque-reputation-traits",
  "opaque-security-settings",
];

// Non-opaque keys that should survive
const NON_OPAQUE_KEYS = [
  "some-other-app-key",
  "user-theme-preference",
];

function fullWipeLocalStorage() {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith("opaque")) keysToRemove.push(key);
  }
  for (const key of keysToRemove) localStorage.removeItem(key);
}

// Simple in-memory localStorage shim for Node environments.
function createMockLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
  };
}

describe("Disconnect cleanup", () => {
  let originalLocalStorage: Storage | undefined;

  beforeEach(() => {
    originalLocalStorage =
      typeof globalThis.localStorage !== "undefined"
        ? globalThis.localStorage
        : undefined;
    (globalThis as Record<string, unknown>).localStorage = createMockLocalStorage();
    localStorage.clear();
    // Populate all known opaque keys
    for (const key of OPAQUE_STORAGE_KEYS) {
      localStorage.setItem(key, JSON.stringify({ test: true }));
    }
    // Populate non-opaque keys
    for (const key of NON_OPAQUE_KEYS) {
      localStorage.setItem(key, "value");
    }
  });

  afterEach(() => {
    if (originalLocalStorage) {
      (globalThis as Record<string, unknown>).localStorage = originalLocalStorage;
    }
  });

  it("removes all opaque-* localStorage keys after full wipe", () => {
    // Verify precondition: opaque keys exist
    for (const key of OPAQUE_STORAGE_KEYS) {
      expect(localStorage.getItem(key)).not.toBeNull();
    }

    fullWipeLocalStorage();

    // All opaque keys should be gone
    for (const key of OPAQUE_STORAGE_KEYS) {
      expect(localStorage.getItem(key)).toBeNull();
    }
  });

  it("preserves non-opaque localStorage keys", () => {
    fullWipeLocalStorage();

    for (const key of NON_OPAQUE_KEYS) {
      expect(localStorage.getItem(key)).toBe("value");
    }
  });

  it("no sensitive keys remain after wipe", () => {
    fullWipeLocalStorage();

    const remaining: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) remaining.push(key);
    }

    // No key starting with "opaque" should remain
    const sensitiveRemaining = remaining.filter((k) => k.startsWith("opaque"));
    expect(sensitiveRemaining).toEqual([]);
  });
});
