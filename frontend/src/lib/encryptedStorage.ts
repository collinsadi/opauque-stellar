/**
 * Generic encrypted localStorage wrapper using Web Crypto AES-GCM.
 *
 * Provides an opt-in encryption layer for Zustand persist stores that hold
 * sensitive data (transaction history, pool notes, reputation traits, etc.).
 * Encryption is passphrase-derived via PBKDF2 — the passphrase is held in
 * memory only and never persisted.
 *
 * Threat model: protects against localStorage read-only access (XSS
 * exfiltration, browser extensions). Does NOT protect against:
 * - XSS that captures the passphrase at entry time
 * - Runtime memory inspection while data is decrypted
 * - Compromised browser extensions with full DOM access
 *
 * For the ghost-address-specific encryption, see ghostCrypto.ts.
 * This module is a generic version for arbitrary JSON-serializable state.
 */

import { KDF_ITERATIONS, KDF_IV_BYTES, KDF_SALT_BYTES } from "./kdfConfig";

const PBKDF2_ITERATIONS = KDF_ITERATIONS;
const SALT_BYTES = KDF_SALT_BYTES;
const IV_BYTES = KDF_IV_BYTES;
const VERSION = 1;

// ── Internal helpers ──────────────────────────────────────────────────

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] ?? 0);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(encoder.encode(password)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: toArrayBuffer(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptJson(data: unknown, key: CryptoKey): Promise<string> {
  const plaintext = JSON.stringify(data);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  return `${bytesToBase64(iv)}:${bytesToBase64(ciphertext)}`;
}

async function decryptJson<T>(packed: string, key: CryptoKey): Promise<T> {
  const [ivB64, ctB64] = packed.split(":");
  if (!ivB64 || !ctB64) throw new Error("Invalid encrypted storage format");
  const iv = base64ToBytes(ivB64);
  const ciphertext = base64ToBytes(ctB64);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(new Uint8Array(decrypted))) as T;
}

// ── Public API ────────────────────────────────────────────────────────

export interface EncryptedPayload {
  version: number;
  salt: string;
  data: string;
}

/**
 * Encrypt arbitrary JSON-serializable data for localStorage storage.
 */
export async function encryptData<T>(
  data: T,
  password: string,
): Promise<EncryptedPayload> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await deriveKey(password, salt);
  return {
    version: VERSION,
    salt: bytesToBase64(salt),
    data: await encryptJson(data, key),
  };
}

/**
 * Decrypt data previously encrypted with `encryptData`.
 */
export async function decryptData<T>(
  payload: EncryptedPayload,
  password: string,
): Promise<T> {
  if (payload.version !== VERSION) {
    throw new Error(`Unsupported encrypted payload version: ${payload.version}`);
  }
  const salt = base64ToBytes(payload.salt);
  const key = await deriveKey(password, salt);
  return decryptJson<T>(payload.data, key);
}

/**
 * Check if a localStorage value is an encrypted payload (vs plaintext).
 */
export function isEncryptedPayload(value: unknown): value is EncryptedPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    "salt" in value &&
    "data" in value &&
    typeof (value as EncryptedPayload).salt === "string" &&
    typeof (value as EncryptedPayload).data === "string"
  );
}

/**
 * Create an encrypted localStorage adapter for Zustand's persist middleware.
 *
 * Usage in a store:
 * ```ts
 * import { createEncryptedStorage } from "../lib/encryptedStorage";
 *
 * const storage = createEncryptedStorage("my-store-key", () => getPassphrase());
 * // Pass `storage` as the `storage` option to zustand persist
 * ```
 */
export function createEncryptedStorage<TState>(
  storageKey: string,
  getPassphrase: () => string | null,
): {
  getItem: (name: string) => Promise<{ state: TState; version?: number } | null>;
  setItem: (name: string, value: { state: TState; version?: number }) => Promise<void>;
  removeItem: (name: string) => void;
} {
  return {
    getItem: async (name: string) => {
      if (typeof localStorage === "undefined") return null;
      const raw = localStorage.getItem(name);
      if (!raw) return null;

      try {
        const parsed = JSON.parse(raw) as unknown;

        // Encrypted format
        if (isEncryptedPayload(parsed)) {
          const passphrase = getPassphrase();
          if (!passphrase) return null; // can't decrypt yet
          try {
            const decrypted = await decryptData<{
              state: TState;
              version?: number;
            }>(parsed, passphrase);
            return decrypted;
          } catch {
            // Wrong password or corrupt data
            return null;
          }
        }

        // Legacy plaintext — return as-is for migration
        return parsed as { state: TState; version?: number };
      } catch {
        return null;
      }
    },

    setItem: async (name: string, value: { state: TState; version?: number }) => {
      if (typeof localStorage === "undefined") return;
      const passphrase = getPassphrase();
      if (passphrase) {
        try {
          const encrypted = await encryptData(value, passphrase);
          localStorage.setItem(name, JSON.stringify(encrypted));
        } catch {
          // Quota or crypto error — fall back to plaintext
          localStorage.setItem(name, JSON.stringify(value));
        }
      } else {
        localStorage.setItem(name, JSON.stringify(value));
      }
    },

    removeItem: (name: string) => {
      if (typeof localStorage === "undefined") return;
      localStorage.removeItem(name);
    },
  };
}
