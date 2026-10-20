/**
 * Local-data cleanup behind "Disconnect & wipe all data" (#1114, #1115).
 *
 * `DisconnectConfirmModal` describes exactly what this module removes and what
 * it keeps, so the modal's copy and the implementation are defined in one place.
 */

import { clearSigningAuditLog } from "./signingAuditLog";

/** Every localStorage key the app writes starts with this prefix. */
const APP_KEY_PREFIX = "opaque";

/** Preferences a full wipe keeps. Every other `opaque*` key is removed. */
export const PRESERVED_LOCAL_STORAGE_KEYS: readonly string[] = [
  "opaque-security-settings",
  "opaque-locale-settings",
];

/** Phrase the user must type to wipe unspent pool notes. */
export const NOTE_LOSS_PHRASE = "delete my notes";

/**
 * Removes every app-owned localStorage key except the preserved preferences.
 * Takes the storage as an argument so tests run this exact function.
 */
export function clearSensitiveLocalStorage(storage: Storage | undefined = globalThis.localStorage): void {
  if (!storage) return;
  const keysToRemove: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(APP_KEY_PREFIX) && !PRESERVED_LOCAL_STORAGE_KEYS.includes(key)) {
      keysToRemove.push(key);
    }
  }
  for (const key of keysToRemove) storage.removeItem(key);
}

/** Full wipe of the local data that lives outside the in-memory stores. */
export async function wipeSensitiveLocalData(storage?: Storage): Promise<void> {
  clearSensitiveLocalStorage(storage);
  await clearSigningAuditLog();
}

export function isNoteLossAcknowledged(typed: string): boolean {
  return typed.trim().toLowerCase() === NOTE_LOSS_PHRASE;
}

/**
 * Whether a full wipe may run. Unspent pool notes are spending secrets, so
 * wiping them needs the typed loss acknowledgment. With no unspent notes
 * there is nothing to protect and no gate applies.
 */
export function canFullWipe({
  unspentNoteCount,
  typedAcknowledgment,
}: {
  unspentNoteCount: number;
  typedAcknowledgment: string;
}): boolean {
  return unspentNoteCount === 0 || isNoteLossAcknowledged(typedAcknowledgment);
}
