import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  OPAQUE_LOCAL_STORAGE_KEYS,
  PERSIST_ON_DISCONNECT,
  CLEAR_ON_PRIVACY_WIPE,
  clearAllLocalSensitiveData,
  disconnectWalletSession,
} from "../localDataManager";
import { clearGhostPassword, hasGhostPassword, setGhostPassword } from "../../store/ghostAddressStore";

describe("localDataManager", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("localStorage", {
      setItem: (k: string, v: string) => storage.set(k, v),
      getItem: (k: string) => storage.get(k) ?? null,
      removeItem: (k: string) => storage.delete(k),
    });
    vi.stubGlobal("sessionStorage", {
      removeItem: (k: string) => storage.delete(k),
    });
    vi.stubGlobal("indexedDB", undefined);
    for (const key of OPAQUE_LOCAL_STORAGE_KEYS) {
      storage.set(key, "stub");
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearGhostPassword();
  });

  it("lists all opaque localStorage keys for privacy wipe", () => {
    expect(OPAQUE_LOCAL_STORAGE_KEYS).toContain("opaque-ghost-addresses");
    expect(OPAQUE_LOCAL_STORAGE_KEYS).toContain("opaque-tx-history");
    expect(OPAQUE_LOCAL_STORAGE_KEYS).toContain("opaque-watchlist");
  });

  it("documents persist vs wipe scopes", () => {
    expect(PERSIST_ON_DISCONNECT.length).toBeGreaterThan(0);
    expect(CLEAR_ON_PRIVACY_WIPE.some((s) => s.includes("IndexedDB"))).toBe(
      true,
    );
  });

  it("disconnectWalletSession clears in-memory ghost password", () => {
    setGhostPassword("test-password");
    expect(hasGhostPassword()).toBe(true);
    const clearKeys = vi.fn();
    const clearVault = vi.fn();
    const disconnectWallet = vi.fn();
    disconnectWalletSession({ clearKeys, clearVault, disconnectWallet });
    expect(hasGhostPassword()).toBe(false);
    expect(clearKeys).toHaveBeenCalledOnce();
    expect(clearVault).toHaveBeenCalledOnce();
    expect(disconnectWallet).toHaveBeenCalledOnce();
  });

  it("clearAllLocalSensitiveData removes opaque localStorage keys", async () => {
    await clearAllLocalSensitiveData();
    for (const key of OPAQUE_LOCAL_STORAGE_KEYS) {
      expect(storage.has(key)).toBe(false);
    }
  });
});
