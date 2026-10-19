import JSZip from "jszip";
import type { PoolNote } from "./poolNotes";
import { KDF_ITERATIONS, KDF_PARAMS } from "./kdfConfig";

export const BACKUP_FORMAT_VERSION = 2;
export const BACKUP_SCHEMA_URI =
  "https://opaque.cash/schemas/pool-notes-backup-v2.json";
export const KDF_ITERATIONS_LEGACY_250K = 250_000;
export const KDF_ITERATIONS = KDF_PARAMS.iterations;

export interface VersionedNoteBackupEnvelope {
  $schema: string;
  formatVersion: number;
  appVersion: string;
  createdAt: string;
  cluster: string;
  poolId?: string | null;
  noteCount: number;
  integrityChecksum: string;
  cipher: "AES-256-GCM";
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string; // Base64
  iv: string; // Base64
  encryptedPayload: string; // Base64
}

export interface DecryptedNoteBackupPayload {
  version: number;
  createdAt: string;
  cluster: string;
  poolId?: string | null;
  notes: PoolNote[];
}

export class CorruptedBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptedBackupError";
  }
}

export class InvalidPasswordError extends Error {
  constructor(message: string = "Invalid PIN or corrupted backup.") {
    super(message);
    this.name = "InvalidPasswordError";
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(length));
  crypto.getRandomValues(out);
  return out;
}

export async function computeSha256Hex(data: Uint8Array): Promise<string> {
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function deriveBackupKey(
  pin: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number = KDF_ITERATIONS,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function poolNoteBackupFilename(createdAt = new Date()): string {
  const stamp = createdAt.toISOString().replace(/[:.]/g, "-");
  return `opaque-pool-notes-v${BACKUP_FORMAT_VERSION}-${stamp}.zip`;
}

/**
 * Creates a versioned, self-describing encrypted note backup envelope.
 */
export async function createVersionedNoteBackupEnvelope(opts: {
  notes: PoolNote[];
  pin: string;
  cluster: string;
  poolId?: string;
  appVersion?: string;
}): Promise<{ envelope: VersionedNoteBackupEnvelope; ciphertext: Uint8Array }> {
  const createdAt = new Date().toISOString();
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveBackupKey(opts.pin, salt);

  const payload: DecryptedNoteBackupPayload = {
    version: BACKUP_FORMAT_VERSION,
    createdAt,
    cluster: opts.cluster,
    poolId: opts.poolId ?? null,
    notes: opts.notes,
  };

  const plaintext = new TextEncoder().encode(JSON.stringify(payload, null, 2));
  const encryptedBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext,
  );
  const ciphertext = new Uint8Array(encryptedBuf);
  const integrityChecksum = await computeSha256Hex(ciphertext);

  const envelope: VersionedNoteBackupEnvelope = {
    $schema: BACKUP_SCHEMA_URI,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: opts.appVersion ?? "1.0.0",
    createdAt,
    cluster: opts.cluster,
    poolId: opts.poolId ?? null,
    noteCount: opts.notes.length,
    integrityChecksum,
    cipher: "AES-256-GCM",
    kdf: "PBKDF2-SHA256",
    iterations: KDF_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    encryptedPayload: bytesToBase64(ciphertext),
  };

  return { envelope, ciphertext };
}

/**
 * Builds an encrypted ZIP archive containing the versioned backup envelope,
 * encrypted notes payload, and human-readable README.
 */
export async function buildEncryptedPoolNoteBackup(opts: {
  notes: PoolNote[];
  pin: string;
  cluster: string;
  poolId?: string;
}): Promise<Blob> {
  const { envelope, ciphertext } =
    await createVersionedNoteBackupEnvelope(opts);

  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(envelope, null, 2));
  zip.file("pool-notes.json.enc", ciphertext);
  zip.file(
    "README.txt",
    [
      "Opaque Privacy-Pool Note Backup (Version 2)",
      "=========================================",
      "",
      "This archive contains encrypted pool note spending material.",
      "The encrypted JSON cannot be recovered without the PIN used at export time.",
      "Anyone with the decrypted notes can withdraw the matching pool funds.",
      "",
      `Format Version: ${envelope.formatVersion}`,
      `Created At: ${envelope.createdAt}`,
      `Note Count: ${envelope.noteCount}`,
      `Integrity Checksum (SHA-256): ${envelope.integrityChecksum}`,
      "",
    ].join("\n"),
  );
  return zip.generateAsync({ type: "blob", compression: "DEFLATE" });
}

/**
 * Decrypts and imports notes from a versioned backup (envelope JSON or ZIP).
 * Validates format version, performs integrity checksum verification,
 * handles schema migrations for legacy versions, and throws CorruptedBackupError on any mismatch.
 */
export async function importEncryptedPoolNoteBackup(
  input: Blob | ArrayBuffer | Uint8Array | string,
  pin: string,
): Promise<DecryptedNoteBackupPayload> {
  let envelope: Partial<VersionedNoteBackupEnvelope> | null = null;
  let ciphertext: Uint8Array | null = null;

  if (typeof input === "string") {
    // Attempt parsing as JSON envelope
    try {
      const parsed = JSON.parse(input) as VersionedNoteBackupEnvelope;
      if (parsed && parsed.encryptedPayload && parsed.salt && parsed.iv) {
        envelope = parsed;
        ciphertext = base64ToBytes(parsed.encryptedPayload);
      }
    } catch {
      throw new CorruptedBackupError("Invalid backup JSON format.");
    }
  }

  // Handle binary / ZIP input
  if (!envelope || !ciphertext) {
    let zipBuffer: ArrayBuffer;
    if (input instanceof Blob) {
      zipBuffer = await input.arrayBuffer();
    } else if (input instanceof Uint8Array) {
      zipBuffer = input.buffer as ArrayBuffer;
    } else if (typeof input === "string") {
      throw new CorruptedBackupError("Unrecognized backup file contents.");
    } else {
      zipBuffer = input;
    }

    try {
      const zip = await JSZip.loadAsync(zipBuffer);
      const manifestFile = zip.file("manifest.json");
      const encFile = zip.file("pool-notes.json.enc");

      if (!manifestFile || !encFile) {
        throw new CorruptedBackupError(
          "Backup ZIP is missing manifest or encrypted notes payload.",
        );
      }

      const manifestStr = await manifestFile.async("string");
      envelope = JSON.parse(
        manifestStr,
      ) as Partial<VersionedNoteBackupEnvelope>;
      ciphertext = await encFile.async("uint8array");
    } catch (e) {
      if (e instanceof CorruptedBackupError) throw e;
      throw new CorruptedBackupError(
        "Failed to parse backup ZIP archive. File may be corrupted.",
      );
    }
  }

  if (!envelope || !ciphertext) {
    throw new CorruptedBackupError(
      "Unable to locate encrypted payload in backup.",
    );
  }

  // Validate format version & envelope headers
  const formatVersion =
    envelope.formatVersion ?? (envelope as { version?: number }).version ?? 1;
  if (typeof formatVersion !== "number" || formatVersion < 1) {
    throw new CorruptedBackupError(
      `Unsupported backup format version: ${String(formatVersion)}`,
    );
  }

  // Integrity Check for V2+
  if (envelope.integrityChecksum) {
    const computedChecksum = await computeSha256Hex(ciphertext);
    if (
      computedChecksum.toLowerCase() !==
      envelope.integrityChecksum.toLowerCase()
    ) {
      throw new CorruptedBackupError(
        "Backup integrity check failed: payload checksum mismatch.",
      );
    }
  }

  // Decryption
  if (!envelope.salt || !envelope.iv) {
    throw new CorruptedBackupError(
      "Backup manifest is missing cryptographic salt or IV parameters.",
    );
  }

  const salt = base64ToBytes(envelope.salt);
  const iv = base64ToBytes(envelope.iv);
  const iterations =
    typeof envelope.iterations === "number" && envelope.iterations > 0
      ? envelope.iterations
      : KDF_ITERATIONS;
  const key = await deriveBackupKey(pin, salt, iterations);

  let decryptedPlaintext: string;
  try {
    const decryptedBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );
    decryptedPlaintext = new TextDecoder().decode(decryptedBuf);
  } catch {
    throw new InvalidPasswordError("Invalid PIN or corrupted backup payload.");
  }

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(decryptedPlaintext);
  } catch {
    throw new CorruptedBackupError("Decrypted note payload is not valid JSON.");
  }

  // Migration & Schema Normalization
  return migrateDecryptedNotes(
    rawPayload,
    formatVersion,
    envelope.cluster ?? "testnet",
  );
}

/**
 * Migrates older backup schemas to the current normalized schema structure.
 */
export function migrateDecryptedNotes(
  payload: unknown,
  sourceVersion: number,
  fallbackCluster: string,
): DecryptedNoteBackupPayload {
  if (!payload || typeof payload !== "object") {
    throw new CorruptedBackupError("Decrypted note payload is malformed.");
  }

  const obj = payload as Record<string, unknown>;
  const rawNotes = Array.isArray(obj.notes)
    ? obj.notes
    : Array.isArray(payload)
      ? payload
      : [];

  const migratedNotes: PoolNote[] = rawNotes.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new CorruptedBackupError(`Corrupted note item at index ${index}.`);
    }
    const noteObj = item as Record<string, unknown>;
    if (!noteObj.nullifier || !noteObj.secret || !noteObj.value) {
      throw new CorruptedBackupError(
        `Note at index ${index} is missing essential cryptographic parameters.`,
      );
    }

    return {
      cluster:
        typeof noteObj.cluster === "string" ? noteObj.cluster : fallbackCluster,
      poolId: typeof noteObj.poolId === "string" ? noteObj.poolId : "default",
      value: String(noteObj.value),
      scope: typeof noteObj.scope === "number" ? noteObj.scope : 0,
      leafIndex: typeof noteObj.leafIndex === "number" ? noteObj.leafIndex : 0,
      nullifier: String(noteObj.nullifier),
      secret: String(noteObj.secret),
      commitment:
        typeof noteObj.commitment === "string" ? noteObj.commitment : "",
      spent: Boolean(noteObj.spent),
      createdAt:
        typeof noteObj.createdAt === "number" ? noteObj.createdAt : Date.now(),
    };
  });

  return {
    version: BACKUP_FORMAT_VERSION,
    createdAt:
      typeof obj.createdAt === "string"
        ? obj.createdAt
        : new Date().toISOString(),
    cluster: typeof obj.cluster === "string" ? obj.cluster : fallbackCluster,
    poolId: typeof obj.poolId === "string" ? obj.poolId : null,
    notes: migratedNotes,
  };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
