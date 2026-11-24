/**
 * Storage abstractions. The SDK never imports a state container (no zustand, no
 * IndexedDB): pool notes, ghost entries, and scan cursors persist through these
 * interfaces. In-memory defaults are provided; a host app plugs its own
 * (zustand/IndexedDB in the browser, fs/sqlite on a server).
 */
import type { PoolNote } from "../crypto/notes";
import type { GhostEntryLike } from "../crypto/backup";

/** Persistence for privacy-pool notes (spending material). */
export interface NoteStore {
  list(): Promise<PoolNote[]>;
  add(note: PoolNote): Promise<void>;
  /** Mark the note with this commitment as spent. */
  markSpent(commitment: string): Promise<void>;
}

/** Persistence for stealth "ghost" entries (ephemeral keys + metadata). */
export interface VaultStore {
  listGhosts(): Promise<GhostEntryLike[]>;
  saveGhost(entry: GhostEntryLike): Promise<void>;
}

/**
 * Persistence for the announcement-scan cursor (last processed ledger),
 * **keyed per identity** — one client watching several stealth identities
 * stores one cursor per identity, so a scan for one never resumes past
 * another's payments. Omitting the key reads and writes the unkeyed slot,
 * which is where a single-identity caller (or a pre-keying store) lives.
 */
export interface ScanStore {
  /** Last processed ledger for `identity`, or null when it has never been scanned. */
  getCursor(identity?: string): Promise<number | null>;
  /** Record the last processed ledger for `identity`. */
  setCursor(ledger: number, identity?: string): Promise<void>;
  /**
   * Remove the cursor stored for `identity`. Optional: the SDK calls it only to
   * retire a cursor saved under a pre-migration key, so a store that omits it
   * simply keeps that stale entry.
   */
  deleteCursor?(identity?: string): Promise<void>;
}

/** In-memory {@link NoteStore}. Notes are keyed by commitment. */
export class MemoryNoteStore implements NoteStore {
  private notes = new Map<string, PoolNote>();
  async list(): Promise<PoolNote[]> {
    return [...this.notes.values()];
  }
  async add(note: PoolNote): Promise<void> {
    this.notes.set(note.commitment, note);
  }
  async markSpent(commitment: string): Promise<void> {
    const note = this.notes.get(commitment);
    if (note) this.notes.set(commitment, { ...note, spent: true });
  }
}

/** In-memory {@link VaultStore}. Ghost entries are keyed by stealth address. */
export class MemoryVaultStore implements VaultStore {
  private entries = new Map<string, GhostEntryLike>();
  async listGhosts(): Promise<GhostEntryLike[]> {
    return [...this.entries.values()];
  }
  async saveGhost(entry: GhostEntryLike): Promise<void> {
    this.entries.set(entry.stealthAddress, entry);
  }
}

/**
 * In-memory {@link ScanStore}. One cursor per identity key, so a client
 * watching several identities keeps each one's position separately.
 */
export class MemoryScanStore implements ScanStore {
  private cursors = new Map<string, number>();
  async getCursor(identity = ""): Promise<number | null> {
    return this.cursors.get(identity) ?? null;
  }
  async setCursor(ledger: number, identity = ""): Promise<void> {
    this.cursors.set(identity, ledger);
  }
  async deleteCursor(identity = ""): Promise<void> {
    this.cursors.delete(identity);
  }
}

export {
  EncryptedNoteStore,
  EncryptedVaultStore,
  EncryptedScanStore,
  localStorageBackend,
  memoryBackend,
  fileBackend,
  type EncryptedStorageBackend,
} from "./encrypted";
