/**
 * Encryption utilities for ghost address ephemeral private keys.
 * Uses PBKDF2 for key derivation and AES-256-GCM for encryption.
 *
 * Threat model: protects against localStorage read-only access (XSS exfiltration
 * of storage, browser extensions reading storage). Does NOT protect against:
 * - XSS that captures the password at entry time
 * - Runtime memory inspection while keys are decrypted
 * - Compromised browser extensions with full DOM access
 */

import { KDF_ITERATIONS, KDF_IV_BYTES, KDF_SALT_BYTES } from "./kdfConfig";

const PBKDF2_ITERATIONS = KDF_ITERATIONS;
const SALT_BYTES = KDF_SALT_BYTES;
const IV_BYTES = KDF_IV_BYTES;

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

async function deriveKeyFromPassword(
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

async function encryptField(
  plaintext: string,
  key: CryptoKey,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      encoded,
    ),
  );
  return `${bytesToBase64(iv)}:${bytesToBase64(ciphertext)}`;
}

async function decryptField(
  packed: string,
  key: CryptoKey,
): Promise<string> {
  const [ivB64, ctB64] = packed.split(":");
  if (!ivB64 || !ctB64) throw new Error("Invalid encrypted field format");
  const iv = base64ToBytes(ivB64);
  const ciphertext = base64ToBytes(ctB64);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(ciphertext),
  );
  return new TextDecoder().decode(new Uint8Array(decrypted));
}

// ---- Public API ----

type GhostEntryLike = {
  cluster: string;
  stealthAddress: string;
  ephemeralPrivKeyHex?: string;
  createdAt: number;
};

export type EncryptedGhostPayload = {
  version: 1;
  salt: string;
  entries: Array<{
    cluster: string;
    stealthAddress: string;
    ephemeralPrivKeyEncrypted?: string;
    createdAt: number;
  }>;
};

/**
 * Encrypt ghost entries for localStorage storage.
 * Only the `ephemeralPrivKeyHex` field is encrypted; metadata stays readable.
 */
export async function encryptGhostEntries(
  entries: GhostEntryLike[],
  password: string,
): Promise<EncryptedGhostPayload> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await deriveKeyFromPassword(password, salt);

  const encrypted = [];
  for (const entry of entries) {
    encrypted.push({
      cluster: entry.cluster,
      stealthAddress: entry.stealthAddress,
      ephemeralPrivKeyEncrypted: entry.ephemeralPrivKeyHex
        ? await encryptField(entry.ephemeralPrivKeyHex, key)
        : undefined,
      createdAt: entry.createdAt,
    });
  }

  return {
    version: 1,
    salt: bytesToBase64(salt),
    entries: encrypted,
  };
}

/**
 * Decrypt ghost entries from localStorage.
 */
export async function decryptGhostEntries(
  payload: EncryptedGhostPayload,
  password: string,
): Promise<GhostEntryLike[]> {
  if (payload.version !== 1) throw new Error("Unsupported encrypted payload version");

  const salt = base64ToBytes(payload.salt);
  const key = await deriveKeyFromPassword(password, salt);

  const decrypted = [];
  for (const entry of payload.entries) {
    decrypted.push({
      cluster: entry.cluster,
      stealthAddress: entry.stealthAddress,
      ephemeralPrivKeyHex: entry.ephemeralPrivKeyEncrypted
        ? await decryptField(entry.ephemeralPrivKeyEncrypted, key)
        : undefined,
      createdAt: entry.createdAt,
    });
  }

  return decrypted;
}

/**
 * Export ghost entries as an encrypted JSON string for backup.
 */
export async function exportEncryptedBackup(
  entries: GhostEntryLike[],
  password: string,
): Promise<string> {
  const payload = await encryptGhostEntries(entries, password);
  return JSON.stringify(payload);
}

/**
 * Import ghost entries from an encrypted backup string.
 */
export async function importEncryptedBackup(
  backupJson: string,
  password: string,
): Promise<GhostEntryLike[]> {
  const payload = JSON.parse(backupJson) as EncryptedGhostPayload;
  return decryptGhostEntries(payload, password);
}
