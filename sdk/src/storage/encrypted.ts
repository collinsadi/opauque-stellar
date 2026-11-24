/**
 * Passphrase-encrypted persistent storage adapters implementing the SDK's
 * {@link NoteStore}/{@link VaultStore}/{@link ScanStore} interfaces (issue #833).
 *
 * Ports the frontend's PBKDF2 + AES-256-GCM scheme
 * (`frontend/src/lib/encryptedStorage.ts`) behind an injectable
 * {@link EncryptedStorageBackend} so the same encryption logic works against
 * `localStorage` in a browser or a file/in-memory backend in Node — the SDK
 * itself never touches `localStorage` or `fs` directly.
 *
 * Two write-path guarantees (issue #1077):
 *  - **Serialized mutations.** Each read-modify-write over one encrypted blob
 *    runs under a per-key lock, so concurrent `add`/`markSpent`/`setCursor`
 *    calls in one process cannot load the same blob and drop each other's change.
 *  - **Derive once per unlock.** PBKDF2 (600k iterations) runs once per store
 *    and salt, and the AES key is cached. Writes reuse the salt already in use,
 *    so a `setCursor` on every scanned page costs an AES call, not a derivation.
 *
 * Threat model: protects persisted data against read-only access to the
 * backend (localStorage exfiltration via XSS, a leaked backup file). It does
 * NOT protect against a passphrase captured at entry time, runtime memory
 * inspection while decrypted, or a fully compromised host. The write lock is
 * per process: it does not coordinate two processes writing the same blob.
 */
import { StorageError } from "../errors/index";
import type { PoolNote } from "../crypto/notes";
import type { GhostEntryLike } from "../crypto/backup";
import type { NoteStore, VaultStore, ScanStore } from "./index";

const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const ENVELOPE_VERSION = 1;

interface EncryptedEnvelope {
  version: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

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

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(new TextEncoder().encode(password)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: toArrayBuffer(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Seals and opens envelopes for one passphrase. The PBKDF2 derivation is the
 * expensive step, so the derived key is cached against the salt it used. A
 * write reuses the salt in use (the stored one, once loaded), which keeps that
 * key cached across the store's lifetime. Each write still draws a fresh IV.
 */
class EnvelopeCipher {
  private cached?: { salt: string; key: Promise<CryptoKey> };
  private writeSalt?: Uint8Array;

  constructor(private readonly password: string) {}

  private keyFor(salt: Uint8Array): Promise<CryptoKey> {
    const id = bytesToBase64(salt);
    if (this.cached && this.cached.salt === id) return this.cached.key;
    const key = deriveKey(this.password, salt);
    this.cached = { salt: id, key };
    // A failed derivation must not stay cached and poison later calls.
    void key.catch(() => {
      if (this.cached?.key === key) this.cached = undefined;
    });
    return key;
  }

  async seal(data: unknown): Promise<EncryptedEnvelope> {
    if (!this.writeSalt) this.writeSalt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const salt = this.writeSalt;
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const key = await this.keyFor(salt);
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: toArrayBuffer(iv) },
        key,
        new TextEncoder().encode(JSON.stringify(data)),
      ),
    );
    return {
      version: ENVELOPE_VERSION,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(ciphertext),
    };
  }

  async open<T>(raw: string): Promise<T> {
    let envelope: EncryptedEnvelope;
    try {
      envelope = JSON.parse(raw) as EncryptedEnvelope;
    } catch (cause) {
      throw new StorageError("Corrupt encrypted storage payload: not valid JSON.", "corrupt-payload", { cause });
    }
    if (
      envelope.version !== ENVELOPE_VERSION ||
      typeof envelope.salt !== "string" ||
      typeof envelope.iv !== "string" ||
      typeof envelope.ciphertext !== "string"
    ) {
      throw new StorageError("Corrupt encrypted storage payload: missing or unsupported envelope fields.", "corrupt-payload");
    }

    let salt: Uint8Array;
    let iv: Uint8Array;
    let ciphertext: Uint8Array;
    try {
      salt = base64ToBytes(envelope.salt);
      iv = base64ToBytes(envelope.iv);
      ciphertext = base64ToBytes(envelope.ciphertext);
    } catch (cause) {
      throw new StorageError("Corrupt encrypted storage payload: invalid base64.", "corrupt-payload", { cause });
    }

    // Adopt the stored salt for future writes, so they reuse the derived key
    // instead of deriving again on every save.
    this.writeSalt ??= salt;
    const key = await this.keyFor(salt);
    try {
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(ciphertext));
      return JSON.parse(new TextDecoder().decode(plaintext)) as T;
    } catch (cause) {
      // AES-GCM authentication failure (wrong key) and a truncated/tampered
      // ciphertext both surface as a generic DOMException from `decrypt` —
      // Web Crypto doesn't distinguish them, so neither can we.
      throw new StorageError("Failed to decrypt storage payload: wrong passphrase or corrupted data.", "wrong-passphrase", { cause });
    }
  }
}

/** The tail of the mutation queue for each storage key in this process. */
const keyQueues = new Map<string, Promise<void>>();

/**
 * Runs `fn` once every earlier operation on the same storage key has settled.
 * Read-modify-write cycles over one encrypted blob are therefore serialized: two
 * concurrent `add` calls each load the list after the other has saved, so neither
 * drops a note. Operations on different keys do not wait on each other.
 */
function serializeOnKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = keyQueues.get(key) ?? Promise.resolve();
  const run = previous.then(fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  keyQueues.set(key, settled);
  void settled.then(() => {
    if (keyQueues.get(key) === settled) keyQueues.delete(key);
  });
  return run;
}

/** Low-level read/write of one opaque string blob. Implement this to target a new platform. */
export interface EncryptedStorageBackend {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}

/** Browser backend: reads/writes `localStorage`. */
export function localStorageBackend(): EncryptedStorageBackend {
  return {
    async read(key) {
      if (typeof localStorage === "undefined") return null;
      return localStorage.getItem(key);
    },
    async write(key, value) {
      if (typeof localStorage === "undefined") {
        throw new StorageError("localStorage is not available in this environment.", "corrupt-payload");
      }
      localStorage.setItem(key, value);
    },
  };
}

/** In-memory backend: works anywhere (Node, tests), not persisted across process restarts. */
export function memoryBackend(): EncryptedStorageBackend {
  const map = new Map<string, string>();
  return {
    async read(key) {
      return map.get(key) ?? null;
    },
    async write(key, value) {
      map.set(key, value);
    },
  };
}

/**
 * Node backend: reads/writes one JSON file per key under `dir`.
 *
 * Writes are atomic: the blob goes to a sibling temp file, is fsynced, and is
 * then renamed over the target. A crash or a torn write leaves either the
 * previous blob or the new one on disk, never a half-written file that would
 * make every note unreadable.
 */
export function fileBackend(dir: string): EncryptedStorageBackend {
  return {
    async read(key) {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      try {
        return await readFile(join(dir, `${key}.json`), "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async write(key, value) {
      const { mkdir, open, rename, rm } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { randomUUID } = await import("node:crypto");
      await mkdir(dir, { recursive: true });
      const target = join(dir, `${key}.json`);
      const tmp = `${target}.${randomUUID()}.tmp`;
      try {
        const handle = await open(tmp, "w");
        try {
          await handle.writeFile(value, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(tmp, target);
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
    },
  };
}

/** Encrypted {@link NoteStore}: the full note list is stored as one encrypted blob per write. */
export class EncryptedNoteStore implements NoteStore {
  private readonly cipher: EnvelopeCipher;

  constructor(
    private readonly backend: EncryptedStorageBackend,
    private readonly password: string,
    private readonly key = "opaque:notes",
  ) {
    this.cipher = new EnvelopeCipher(password);
  }

  private async load(): Promise<PoolNote[]> {
    const raw = await this.backend.read(this.key);
    if (!raw) return [];
    return this.cipher.open<PoolNote[]>(raw);
  }

  private async save(notes: PoolNote[]): Promise<void> {
    await this.backend.write(this.key, JSON.stringify(await this.cipher.seal(notes)));
  }

  async list(): Promise<PoolNote[]> {
    return serializeOnKey(this.key, () => this.load());
  }

  async add(note: PoolNote): Promise<void> {
    return serializeOnKey(this.key, async () => {
      const notes = await this.load();
      notes.push(note);
      await this.save(notes);
    });
  }

  async markSpent(commitment: string): Promise<void> {
    return serializeOnKey(this.key, async () => {
      const notes = await this.load();
      const updated = notes.map((n) => (n.commitment === commitment ? { ...n, spent: true } : n));
      await this.save(updated);
    });
  }
}

/** Encrypted {@link VaultStore}: the full ghost-entry list is stored as one encrypted blob per write. */
export class EncryptedVaultStore implements VaultStore {
  private readonly cipher: EnvelopeCipher;

  constructor(
    private readonly backend: EncryptedStorageBackend,
    private readonly password: string,
    private readonly key = "opaque:vault",
  ) {
    this.cipher = new EnvelopeCipher(password);
  }

  private async load(): Promise<GhostEntryLike[]> {
    const raw = await this.backend.read(this.key);
    if (!raw) return [];
    return this.cipher.open<GhostEntryLike[]>(raw);
  }

  private async save(entries: GhostEntryLike[]): Promise<void> {
    await this.backend.write(this.key, JSON.stringify(await this.cipher.seal(entries)));
  }

  async listGhosts(): Promise<GhostEntryLike[]> {
    return serializeOnKey(this.key, () => this.load());
  }

  async saveGhost(entry: GhostEntryLike): Promise<void> {
    return serializeOnKey(this.key, async () => {
      const entries = await this.load();
      const idx = entries.findIndex((e) => e.stealthAddress === entry.stealthAddress);
      if (idx >= 0) entries[idx] = entry;
      else entries.push(entry);
      await this.save(entries);
    });
  }
}

/**
 * Encrypted {@link ScanStore}: the cursor map is stored as one encrypted blob
 * per write, keyed per identity so a client watching several stealth
 * identities keeps each one's position separately.
 */
export class EncryptedScanStore implements ScanStore {
  private readonly cipher: EnvelopeCipher;

  constructor(
    private readonly backend: EncryptedStorageBackend,
    private readonly password: string,
    private readonly key = "opaque:scan-cursor",
  ) {
    this.cipher = new EnvelopeCipher(password);
  }

  private async load(): Promise<Record<string, number>> {
    const raw = await this.backend.read(this.key);
    if (!raw) return {};
    const stored = await this.cipher.open<Record<string, number> | number | null>(raw);
    // A pre-keying store persisted a bare number; keep it readable as the
    // unkeyed cursor rather than failing the scan that resumes from it.
    if (typeof stored === "number") return { "": stored };
    if (typeof stored === "object" && stored !== null) return stored;
    return {};
  }

  private async save(cursors: Record<string, number>): Promise<void> {
    await this.backend.write(this.key, JSON.stringify(await this.cipher.seal(cursors)));
  }

  async getCursor(identity = ""): Promise<number | null> {
    return serializeOnKey(this.key, async () => {
      const cursors = await this.load();
      return cursors[identity] ?? null;
    });
  }

  async setCursor(ledger: number, identity = ""): Promise<void> {
    return serializeOnKey(this.key, async () => {
      const cursors = await this.load();
      cursors[identity] = ledger;
      await this.save(cursors);
    });
  }

  async deleteCursor(identity = ""): Promise<void> {
    return serializeOnKey(this.key, async () => {
      const cursors = await this.load();
      if (!Object.hasOwn(cursors, identity)) return;
      delete cursors[identity];
      await this.save(cursors);
    });
  }
}
