/**
 * Browser storage health probes and safe write helpers.
 * Surfaces quota, private-mode, and unavailable storage to the UI.
 */

export type StorageFailureKind =
  | "unavailable"
  | "quota_exceeded"
  | "private_mode"
  | "unknown";

export type StorageWriteResult =
  | { ok: true }
  | { ok: false; kind: StorageFailureKind; message: string };

const PROBE_KEY = "__opaque_storage_probe__";

export function classifyStorageError(error: unknown): StorageFailureKind {
  if (error instanceof DOMException) {
    if (error.name === "QuotaExceededError" || error.code === 22) {
      return "quota_exceeded";
    }
    if (error.name === "SecurityError") {
      return "private_mode";
    }
  }
  const msg =
    error instanceof Error ? error.message : String(error ?? "unknown");
  const lower = msg.toLowerCase();
  if (lower.includes("quota") || lower.includes("exceeded")) {
    return "quota_exceeded";
  }
  if (
    lower.includes("denied") ||
    lower.includes("private") ||
    lower.includes("sandbox") ||
    lower.includes("security")
  ) {
    return "private_mode";
  }
  return "unknown";
}

export function storageFailureMessage(kind: StorageFailureKind): string {
  switch (kind) {
    case "unavailable":
      return "Browser storage is unavailable. Recovery data and caches may not persist.";
    case "quota_exceeded":
      return "Browser storage is full. Free space or clear site data, then try again.";
    case "private_mode":
      return "Private browsing may block or erase saved data. Back up ghost keys before closing this tab.";
    default:
      return "Could not save to browser storage. Your data may be lost on refresh.";
  }
}

export function isLocalStorageAvailable(): boolean {
  if (typeof window === "undefined" || typeof localStorage === "undefined") {
    return false;
  }
  try {
    localStorage.setItem(PROBE_KEY, "1");
    localStorage.removeItem(PROBE_KEY);
    return true;
  } catch {
    return false;
  }
}

export async function isIndexedDBAvailable(): Promise<boolean> {
  if (typeof window === "undefined" || !window.indexedDB) {
    return false;
  }
  const testDb = `__opaque_idb_probe_${Date.now()}`;
  return new Promise((resolve) => {
    try {
      const req = window.indexedDB.open(testDb, 1);
      req.onerror = () => resolve(false);
      req.onsuccess = () => {
        req.result.close();
        const del = window.indexedDB.deleteDatabase(testDb);
        del.onsuccess = () => resolve(true);
        del.onerror = () => resolve(true);
      };
      req.onupgradeneeded = () => {
        req.result.createObjectStore("probe");
      };
    } catch {
      resolve(false);
    }
  });
}

export type StorageHealthSnapshot = {
  localStorage: boolean;
  indexedDB: boolean;
  webCrypto: boolean;
  issues: StorageFailureKind[];
};

export async function probeStorageHealth(): Promise<StorageHealthSnapshot> {
  const localStorageOk = isLocalStorageAvailable();
  const indexedDBOk = await isIndexedDBAvailable();
  const webCryptoOk =
    typeof window !== "undefined" &&
    !!window.crypto?.subtle &&
    !!window.crypto?.getRandomValues;

  const issues: StorageFailureKind[] = [];
  if (!localStorageOk) issues.push("unavailable");
  if (!indexedDBOk) issues.push("private_mode");

  return {
    localStorage: localStorageOk,
    indexedDB: indexedDBOk,
    webCrypto: webCryptoOk,
    issues,
  };
}

export function writeLocalStorage(key: string, value: string): StorageWriteResult {
  if (!isLocalStorageAvailable()) {
    return {
      ok: false,
      kind: "unavailable",
      message: storageFailureMessage("unavailable"),
    };
  }
  try {
    localStorage.setItem(key, value);
    return { ok: true };
  } catch (error) {
    const kind = classifyStorageError(error);
    return { ok: false, kind, message: storageFailureMessage(kind) };
  }
}

export function removeLocalStorage(key: string): StorageWriteResult {
  if (!isLocalStorageAvailable()) {
    return {
      ok: false,
      kind: "unavailable",
      message: storageFailureMessage("unavailable"),
    };
  }
  try {
    localStorage.removeItem(key);
    return { ok: true };
  } catch (error) {
    const kind = classifyStorageError(error);
    return { ok: false, kind, message: storageFailureMessage(kind) };
  }
}
