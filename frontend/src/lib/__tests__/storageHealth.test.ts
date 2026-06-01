import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  classifyStorageError,
  isLocalStorageAvailable,
  isIndexedDBAvailable,
  probeStorageHealth,
  writeLocalStorage,
  storageFailureMessage,
} from "../storageHealth";

describe("storageHealth", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("localStorage", {
      setItem: (k: string, v: string) => {
        storage.set(k, v);
      },
      getItem: (k: string) => storage.get(k) ?? null,
      removeItem: (k: string) => storage.delete(k),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies QuotaExceededError", () => {
    const err = new DOMException("quota", "QuotaExceededError");
    expect(classifyStorageError(err)).toBe("quota_exceeded");
  });

  it("writes successfully when storage works", () => {
    expect(isLocalStorageAvailable()).toBe(true);
    const result = writeLocalStorage("opaque-test", "[]");
    expect(result.ok).toBe(true);
    expect(storage.get("opaque-test")).toBe("[]");
  });

  it("surfaces quota failures on write", () => {
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
      getItem: () => null,
      removeItem: () => {},
    });
    const result = writeLocalStorage("opaque-test", "x");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("quota_exceeded");
      expect(result.message).toBe(storageFailureMessage("quota_exceeded"));
    }
  });

  it("detects unavailable storage when setItem throws SecurityError", () => {
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      getItem: () => null,
      removeItem: () => {},
    });
    expect(isLocalStorageAvailable()).toBe(false);
  });

  it("probeStorageHealth reports localStorage issues", async () => {
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      getItem: () => null,
      removeItem: () => {},
    });
    const health = await probeStorageHealth();
    expect(health.localStorage).toBe(false);
    expect(health.issues).toContain("unavailable");
  });

  it("reports IndexedDB unavailable when open fails", async () => {
    vi.stubGlobal("indexedDB", {
      open: () => {
        const req = {
          onerror: null as ((ev: Event) => void) | null,
          onsuccess: null,
          onupgradeneeded: null,
          result: { close: () => {} },
        };
        queueMicrotask(() => req.onerror?.({} as Event));
        return req;
      },
      deleteDatabase: () => ({ onsuccess: null, onerror: null }),
    });
    expect(await isIndexedDBAvailable()).toBe(false);
  });
});
