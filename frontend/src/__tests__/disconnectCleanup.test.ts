import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  PRESERVED_LOCAL_STORAGE_KEYS,
  canFullWipe,
  clearSensitiveLocalStorage,
  isNoteLossAcknowledged,
  wipeSensitiveLocalData,
} from "../lib/disconnectCleanup";
import { clearSigningAuditLog } from "../lib/signingAuditLog";

/**
 * Exercises the production cleanup in lib/disconnectCleanup.ts (#1114), so a
 * change to the wipe scope fails here rather than in a copy of the logic.
 */

vi.mock("../lib/signingAuditLog", () => ({
  clearSigningAuditLog: vi.fn(() => Promise.resolve()),
}));

// Keys a full wipe must remove: every store that holds secrets or chain-derived data.
const SENSITIVE_KEYS = [
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
  "opaque.signature.session.data.v1",
  "opaque_pending_deposit_backup_gate",
];

// Preferences the disconnect modal promises to keep.
const KEPT_KEYS = ["opaque-security-settings", "opaque-locale-settings"];

const UNRELATED_KEYS = ["some-other-app-key", "user-theme-preference"];

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

function remainingKeys(storage: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key) keys.push(key);
  }
  return keys;
}

describe("Disconnect cleanup", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createMockLocalStorage();
    for (const key of [...SENSITIVE_KEYS, ...KEPT_KEYS]) storage.setItem(key, JSON.stringify({ test: true }));
    for (const key of UNRELATED_KEYS) storage.setItem(key, "value");
    vi.mocked(clearSigningAuditLog).mockClear();
  });

  it("removes every sensitive app key", () => {
    clearSensitiveLocalStorage(storage);

    for (const key of SENSITIVE_KEYS) expect(storage.getItem(key)).toBeNull();
  });

  it("keeps the preferences the modal lists as always kept", () => {
    clearSensitiveLocalStorage(storage);

    for (const key of KEPT_KEYS) expect(storage.getItem(key)).not.toBeNull();
    expect(PRESERVED_LOCAL_STORAGE_KEYS).toEqual(KEPT_KEYS);
  });

  it("leaves keys from other apps alone", () => {
    clearSensitiveLocalStorage(storage);

    for (const key of UNRELATED_KEYS) expect(storage.getItem(key)).toBe("value");
  });

  it("removes everything except the preserved keys and unrelated keys", () => {
    clearSensitiveLocalStorage(storage);

    expect(remainingKeys(storage).sort()).toEqual([...KEPT_KEYS, ...UNRELATED_KEYS].sort());
  });

  it("clears the signing audit log along with localStorage", async () => {
    await wipeSensitiveLocalData(storage);

    expect(clearSigningAuditLog).toHaveBeenCalledTimes(1);
    expect(remainingKeys(storage).sort()).toEqual([...KEPT_KEYS, ...UNRELATED_KEYS].sort());
  });
});

describe("Full wipe gate for unspent pool notes", () => {
  it("does not gate a wipe when there are no unspent notes", () => {
    expect(canFullWipe({ unspentNoteCount: 0, typedAcknowledgment: "" })).toBe(true);
  });

  it("blocks a wipe that would delete unspent notes without the typed acknowledgment", () => {
    expect(canFullWipe({ unspentNoteCount: 1, typedAcknowledgment: "" })).toBe(false);
    expect(canFullWipe({ unspentNoteCount: 3, typedAcknowledgment: "yes" })).toBe(false);
    expect(canFullWipe({ unspentNoteCount: 3, typedAcknowledgment: "delete" })).toBe(false);
  });

  it("allows the wipe once the loss phrase is typed, ignoring case and surrounding spaces", () => {
    expect(canFullWipe({ unspentNoteCount: 2, typedAcknowledgment: "delete my notes" })).toBe(true);
    expect(canFullWipe({ unspentNoteCount: 2, typedAcknowledgment: "  DELETE MY NOTES " })).toBe(true);
    expect(isNoteLossAcknowledged("delete my notes!")).toBe(false);
  });
});
