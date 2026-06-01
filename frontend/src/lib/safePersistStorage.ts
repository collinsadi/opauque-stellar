/**
 * Zustand persist adapter that surfaces localStorage write failures to the UI.
 */

import {
  removeLocalStorage,
  writeLocalStorage,
  type StorageWriteResult,
} from "./storageHealth";

type PersistErrorListener = (result: StorageWriteResult) => void;

let _persistErrorListener: PersistErrorListener | null = null;

export function setPersistErrorListener(
  listener: PersistErrorListener | null,
): void {
  _persistErrorListener = listener;
}

/** StateStorage-compatible wrapper around writeLocalStorage. */
export function createSafeLocalStorage(): Storage {
  return {
    getItem: (name) => {
      if (typeof localStorage === "undefined") return null;
      return localStorage.getItem(name);
    },
    setItem: (name, value) => {
      const result = writeLocalStorage(name, value);
      if (!result.ok) _persistErrorListener?.(result);
    },
    removeItem: (name) => {
      const result = removeLocalStorage(name);
      if (!result.ok) _persistErrorListener?.(result);
    },
  };
}
