import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJson, writeAtomic } from "../../shared/atomic-file.ts";
import { normalizeHex32 } from "./bytes.ts";
import { validateLeafCommitment } from "./validate.ts";
import type { LeafCommitment, PublisherState, QuarantinedFile } from "./types.ts";
import { createLogger } from "./logger.ts";

const DEFAULT_MAX_INBOX_SIZE = 10_000;
const log = createLogger("publisher-store");

export interface Store {
  load(verifierId: string): PublisherState | null;
  save(state: PublisherState): void;
  readInbox(now: () => string): LeafCommitment[];
  writeInbox(commitment: LeafCommitment): boolean;
  archiveInbox(ids: string[]): void;
  inboxSize(): number;
  quarantineFile(filename: string, raw: unknown, errors: string[], now: () => string): void;
  listQuarantine(): QuarantinedFile[];
  quarantineSize(): number;
}

export function normalizeCommitment(raw: unknown, now: () => string): LeafCommitment {
  const result = validateLeafCommitment(raw);
  if (!result.ok) {
    throw new Error(`invalid commitment: ${result.errors.join("; ")}`);
  }
  // Server-assigned timestamp — never trust client-supplied submittedAt (#967)
  result.commitment.submittedAt = now();
  return result.commitment;
}

export class FileStore implements Store {
  private readonly maxInboxSize: number;

  constructor(private readonly dataDir: string, maxInboxSize?: number) {
    this.maxInboxSize = maxInboxSize ?? DEFAULT_MAX_INBOX_SIZE;
  }

  private statePath(verifierId: string): string {
    return join(this.dataDir, "state", `${verifierId}.json`);
  }

  private inboxDir(): string {
    return join(this.dataDir, "inbox");
  }

  private archiveDir(): string {
    return join(this.dataDir, "archive");
  }

  private quarantineDir(): string {
    return join(this.dataDir, "quarantine");
  }

  load(verifierId: string): PublisherState | null {
    const p = this.statePath(verifierId);
    if (!existsSync(p)) return null;
    return readJson<PublisherState>(p);
  }

  save(state: PublisherState): void {
    const p = this.statePath(state.verifierId);
    mkdirSync(dirname(p), { recursive: true });
    writeAtomic(p, `${JSON.stringify(state, null, 2)}\n`);
  }

  inboxSize(): number {
    const dir = this.inboxDir();
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter((x) => x.endsWith(".json")).length;
  }

  readInbox(now: () => string): LeafCommitment[] {
    const dir = this.inboxDir();
    if (!existsSync(dir)) return [];
    const out: LeafCommitment[] = [];
    for (const name of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
      const p = join(dir, name);
      try {
        const raw = JSON.parse(readFileSync(p, "utf8"));
        const result = validateLeafCommitment(raw);
        if (result.ok) {
          out.push(result.commitment);
        } else {
          this.quarantineFile(name, raw, result.errors, now);
          unlinkSync(p);
          log.warn("quarantined invalid inbox file", { name, errors: result.errors });
        }
      } catch (err) {
        const raw = { parseError: true };
        this.quarantineFile(name, raw, [`parse error: ${err instanceof Error ? err.message : String(err)}`], now);
        unlinkSync(p);
        log.warn("quarantined unparseable inbox file", { name });
      }
    }
    return out;
  }

  writeInbox(commitment: LeafCommitment): boolean {
    if (this.inboxSize() >= this.maxInboxSize) {
      return false;
    }
    const safeId = commitment.id.replace(/[^a-z0-9_.-]/gi, "_");
    // Use timestamp prefix to prevent filename collisions for distinct ids
    // that sanitize to the same value (#965).
    const ts = Date.now().toString(36);
    const p = join(this.inboxDir(), `${ts}_${safeId}.json`);
    mkdirSync(dirname(p), { recursive: true });
    writeAtomic(p, `${JSON.stringify(commitment, null, 2)}\n`);
    return true;
  }

  archiveInbox(ids: string[]): void {
    if (ids.length === 0) return;
    const dir = this.inboxDir();
    if (!existsSync(dir)) return;
    mkdirSync(this.archiveDir(), { recursive: true });
    const wanted = new Set(ids);
    for (const name of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const p = join(dir, name);
      try {
        const raw = JSON.parse(readFileSync(p, "utf8"));
        const commitment = normalizeCommitment(raw, () => new Date().toISOString());
        if (wanted.has(commitment.id)) {
          renameSync(p, join(this.archiveDir(), name));
        }
      } catch (err) {
        this.quarantineFile(
          name,
          { parseError: true },
          [`parse error: ${err instanceof Error ? err.message : String(err)}`],
          () => new Date().toISOString(),
        );
        unlinkSync(p);
      }
    }
  }

  quarantineFile(filename: string, raw: unknown, errors: string[], now: () => string): void {
    const dir = this.quarantineDir();
    mkdirSync(dir, { recursive: true });
    const entry: QuarantinedFile = {
      filename,
      originalContent: raw,
      errors,
      quarantinedAt: now(),
    };
    const safeName = filename.replace(/[^a-z0-9_.-]/gi, "_");
    writeAtomic(join(dir, `${safeName}.json`), `${JSON.stringify(entry, null, 2)}\n`);
  }

  listQuarantine(): QuarantinedFile[] {
    const dir = this.quarantineDir();
    if (!existsSync(dir)) return [];
    const out: QuarantinedFile[] = [];
    for (const name of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
      try {
        out.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as QuarantinedFile);
      } catch {
        // skip corrupt quarantine entries
      }
    }
    return out;
  }

  quarantineSize(): number {
    const dir = this.quarantineDir();
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter((x) => x.endsWith(".json")).length;
  }
}

export class MemoryStore implements Store {
  private state: PublisherState | null = null;
  private readonly maxInboxSize: number;
  inbox: LeafCommitment[] = [];
  archived: string[] = [];
  quarantined: QuarantinedFile[] = [];

  constructor(maxInboxSize?: number) {
    this.maxInboxSize = maxInboxSize ?? DEFAULT_MAX_INBOX_SIZE;
  }

  load(): PublisherState | null {
    return this.state ? structuredClone(this.state) : null;
  }

  save(state: PublisherState): void {
    this.state = structuredClone(state);
  }

  inboxSize(): number {
    return this.inbox.length;
  }

  readInbox(now?: () => string): LeafCommitment[] {
    const effectiveNow = now ?? (() => new Date().toISOString());
    const valid: LeafCommitment[] = [];
    for (const item of this.inbox) {
      const result = validateLeafCommitment(item as unknown);
      if (result.ok) {
        valid.push(structuredClone(result.commitment));
      } else {
        this.quarantineFile(item.id ?? "unknown", item, result.errors, effectiveNow);
        log.warn("quarantined invalid in-memory inbox item", { id: item.id ?? "unknown", errors: result.errors });
      }
    }
    this.inbox = valid;
    return valid;
  }

  writeInbox(commitment: LeafCommitment): boolean {
    if (this.inbox.length >= this.maxInboxSize) {
      return false;
    }
    this.inbox.push(structuredClone(commitment));
    return true;
  }

  archiveInbox(ids: string[]): void {
    this.archived.push(...ids);
    this.inbox = this.inbox.filter((x) => !ids.includes(x.id));
  }

  quarantineFile(_filename: string, raw: unknown, errors: string[], now: () => string): void {
    this.quarantined.push({
      filename: _filename,
      originalContent: structuredClone(raw),
      errors,
      quarantinedAt: now(),
    });
  }

  listQuarantine(): QuarantinedFile[] {
    return structuredClone(this.quarantined);
  }

  quarantineSize(): number {
    return this.quarantined.length;
  }
}
