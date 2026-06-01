import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createSafeLocalStorage,
  setPersistErrorListener,
} from "../safePersistStorage";

describe("safePersistStorage", () => {
  const storage = new Map<string, string>();
  let lastError: { ok: false; message: string } | null = null;

  beforeEach(() => {
    storage.clear();
    lastError = null;
    vi.stubGlobal("localStorage", {
      setItem: (k: string, v: string) => storage.set(k, v),
      getItem: (k: string) => storage.get(k) ?? null,
      removeItem: (k: string) => storage.delete(k),
    });
    setPersistErrorListener((result) => {
      if (!result.ok) lastError = result;
    });
  });

  afterEach(() => {
    setPersistErrorListener(null);
    vi.unstubAllGlobals();
  });

  it("notifies listener when persist write fails", () => {
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
      getItem: () => null,
      removeItem: () => {},
    });
    const safe = createSafeLocalStorage();
    safe.setItem("opaque-vault-entries", "[]");
    expect(lastError?.ok).toBe(false);
    expect(lastError?.message).toMatch(/full|storage/i);
  });
});
