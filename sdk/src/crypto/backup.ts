/**
 * Encrypted backup of stealth ephemeral private keys ("ghost entries").
 * PBKDF2-SHA256 key derivation + AES-256-GCM, using the Web Crypto API
 * (available in browsers and Node 18+).
 *
 * Threat model: protects key material at rest against read-only exfiltration of
 * stored backups. It does NOT protect against capture of the password at entry
 * time, runtime memory inspection while decrypted, or a fully compromised host.
 */

const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

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

async function encryptField(plaintext: string, key: CryptoKey): Promise<string> {
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

async function decryptField(packed: string, key: CryptoKey): Promise<string> {
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

export type GhostEntryLike = {
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
 * Encrypt ghost entries. Only `ephemeralPrivKeyHex` is encrypted; metadata
 * (cluster, stealth address, timestamp) stays readable.
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
  return { version: 1, salt: bytesToBase64(salt), entries: encrypted };
}

/** Decrypt ghost entries produced by {@link encryptGhostEntries}. */
export async function decryptGhostEntries(
  payload: EncryptedGhostPayload,
  password: string,
): Promise<GhostEntryLike[]> {
  if (payload.version !== 1) {
    throw new Error("Unsupported encrypted payload version");
  }
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

/** Export ghost entries as an encrypted JSON string. */
export async function exportEncryptedBackup(
  entries: GhostEntryLike[],
  password: string,
): Promise<string> {
  return JSON.stringify(await encryptGhostEntries(entries, password));
}

/** Import ghost entries from an encrypted backup string. */
export async function importEncryptedBackup(
  backupJson: string,
  password: string,
): Promise<GhostEntryLike[]> {
  const payload = JSON.parse(backupJson) as EncryptedGhostPayload;
  return decryptGhostEntries(payload, password);
}

// ─── Versioned vault backup (notes + stealth keys + ghost entries) ─────────
//
// Ports `frontend/src/services/recoveryManager.ts`'s format into the SDK
// (issue #834). The envelope's shape, field names, PBKDF2 iteration count,
// and AES-GCM parameters are intentionally identical to the frontend's so a
// backup produced by either interoperates with the other. `notes` is an SDK
// addition beyond the frontend's current schema; the frontend's importer
// already ignores unknown top-level fields, so this stays forward-compatible
// in both directions (see the forward-compatibility test in
// `sdk/tests/unit/backup.test.ts`).

// Issue #1010: Align vault backup KDF with ghost backup iterations.
// Ghost entries use 600,000 iterations; vault backups (which hold notes and
// master keys — strictly more sensitive material) must use at least the same
// work factor. Old vault files produced with 100,000 iterations are still
// decryptable via version migration in `decryptVaultBackup`.
const VAULT_BACKUP_ITERATIONS = 600_000;
const VAULT_BACKUP_LEGACY_ITERATIONS = 100_000;
/** Upper bound on a file-supplied iteration count, so a crafted file cannot hang the importer. */
const VAULT_BACKUP_MAX_ITERATIONS = 10_000_000;
const VAULT_BACKUP_KEY_LENGTH = 256; // matches RecoveryManager.KEY_LENGTH
const VAULT_BACKUP_SCHEMA = "https://opaque.cash/schemas/recovery-backup-v2.json";

/** Everything a wallet needs to fully recover: notes, stealth keys, and ghost entries. */
export interface VaultBackupPayload {
  stealthMasterKeys: unknown[];
  metaAddresses: unknown[];
  scanKeys: unknown[];
  ghostEntries: GhostEntryLike[];
  /** SDK-side pool notes (spending material); absent from the frontend's current schema. */
  notes?: unknown[];
  recoveryMetadata?: unknown;
}

/** The versioned, encrypted envelope written to / read from a `.opq` backup file. */
export interface VaultBackupFile {
  $schema?: string;
  version: number;
  formatVersion?: number;
  timestamp: string;
  /** SHA-256 hex digest of the encrypted payload, for tamper/corruption detection. */
  checksum: string;
  /** Base64 AES-GCM ciphertext of the JSON-encoded {@link VaultBackupPayload}. */
  encrypted_payload: string;
  /** Base64 PBKDF2 salt. */
  salt: string;
  /** Base64 AES-GCM nonce (IV). */
  nonce: string;
  /**
   * PBKDF2 iteration count used to derive the key (issue #1071). Same field name
   * as the frontend's `BackupFile.iterations`. When absent the file predates
   * recorded parameters and the importer probes the known counts.
   */
  iterations?: number;
}

async function deriveVaultKey(
  password: string,
  salt: Uint8Array,
  iterations: number = VAULT_BACKUP_ITERATIONS,
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
      iterations,
      hash: "SHA-256",
    },
    passwordKey,
    { name: "AES-GCM", length: VAULT_BACKUP_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Encrypt a full vault backup (notes, stealth keys, ghost entries) into the
 * versioned envelope format shared with the frontend.
 */
export async function exportVaultBackup(
  payload: VaultBackupPayload,
  password: string,
): Promise<VaultBackupFile> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const nonce = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveVaultKey(password, salt);

  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(nonce) }, key, encoded),
  );
  const checksum = await sha256Hex(ciphertext);

  return {
    $schema: VAULT_BACKUP_SCHEMA,
    version: 1,
    formatVersion: 2,
    timestamp: new Date().toISOString(),
    checksum,
    encrypted_payload: bytesToBase64(ciphertext),
    salt: bytesToBase64(salt),
    nonce: bytesToBase64(nonce),
    iterations: VAULT_BACKUP_ITERATIONS,
  };
}

/**
 * Decrypt a vault backup produced by {@link exportVaultBackup} or by the
 * frontend's `RecoveryManager.exportBackup`. Missing/legacy fields default
 * to an empty array so older or partial backups still restore.
 *
 * The PBKDF2 iteration count is read from the file's `iterations` field
 * (issue #1071), so version-2 files written with 100,000 iterations still
 * decrypt; files with no recorded count are tried at 600,000 and 100,000.
 *
 * @throws if the checksum (when present) doesn't match, or if decryption
 * fails (wrong password or corrupt payload).
 */
export async function importVaultBackup(
  backup: VaultBackupFile,
  password: string,
): Promise<VaultBackupPayload> {
  if (!backup || !backup.encrypted_payload || !backup.salt || !backup.nonce) {
    throw new Error("Corrupted backup file: missing required fields.");
  }

  const salt = base64ToBytes(backup.salt);
  const nonce = base64ToBytes(backup.nonce);
  const ciphertext = base64ToBytes(backup.encrypted_payload);

  if (backup.checksum) {
    const computed = await sha256Hex(ciphertext);
    if (computed.toLowerCase() !== backup.checksum.toLowerCase()) {
      throw new Error("Integrity check failed: corrupted backup payload.");
    }
  }

  // Issue #1071: use the iteration count recorded in the file. formatVersion
  // alone cannot tell 100k from 600k (version-2 files exist with both). Files
  // without a recorded count are tried at every known count.
  const recorded =
    typeof backup.iterations === "number" &&
    Number.isInteger(backup.iterations) &&
    backup.iterations > 0
      ? backup.iterations
      : undefined;
  if (recorded !== undefined && recorded > VAULT_BACKUP_MAX_ITERATIONS) {
    throw new Error("Unsupported backup: PBKDF2 iteration count is out of range.");
  }
  const candidates =
    recorded !== undefined
      ? [recorded]
      : (backup.formatVersion ?? 1) < 2
        ? [VAULT_BACKUP_LEGACY_ITERATIONS, VAULT_BACKUP_ITERATIONS]
        : [VAULT_BACKUP_ITERATIONS, VAULT_BACKUP_LEGACY_ITERATIONS];

  let parsed: Record<string, unknown> | undefined;
  for (const iterations of candidates) {
    try {
      const key = await deriveVaultKey(password, salt, iterations);
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: toArrayBuffer(nonce) },
        key,
        toArrayBuffer(ciphertext),
      );
      parsed = JSON.parse(new TextDecoder().decode(decrypted)) as Record<string, unknown>;
      break;
    } catch {
      // try the next candidate
    }
  }
  if (!parsed) throw new Error("Invalid password or corrupted backup file.");

  return {
    stealthMasterKeys: Array.isArray(parsed.stealthMasterKeys) ? parsed.stealthMasterKeys : [],
    metaAddresses: Array.isArray(parsed.metaAddresses) ? parsed.metaAddresses : [],
    scanKeys: Array.isArray(parsed.scanKeys) ? parsed.scanKeys : [],
    ghostEntries: Array.isArray(parsed.ghostEntries) ? (parsed.ghostEntries as GhostEntryLike[]) : [],
    notes: Array.isArray(parsed.notes) ? parsed.notes : [],
    recoveryMetadata: parsed.recoveryMetadata ?? {},
  };
}
