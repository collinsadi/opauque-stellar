/**
 * Advisory per-pool lock so the indexer tick and operator tools such as
 * `asp:reinstate` never interleave a load → mutate → save cycle on the same state
 * file (#1086). The lock is a file created with O_EXCL; it records the holder's
 * PID so a lock left behind by a crashed process is reclaimed instead of wedging
 * the pool forever.
 */
import { mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export type ReleaseLock = () => void;

export interface LockOptions {
  /** Give up after this long. Default 60s — longer than any healthy tick. */
  timeoutMs?: number;
  /** Poll interval while the lock is held elsewhere. */
  retryMs?: number;
}

export class LockTimeoutError extends Error {
  constructor(lockPath: string, holder: string) {
    super(`timed out waiting for ASP state lock ${lockPath} (held by ${holder || "unknown"})`);
    this.name = "LockTimeoutError";
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readHolder(lockPath: string): string {
  try {
    return readFileSync(lockPath, "utf8").trim();
  } catch {
    return "";
  }
}

/** Try once to take the lock. Returns a release function, or null if it is held. */
export function tryAcquireFileLock(lockPath: string): ReleaseLock | null {
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const pid = Number(readHolder(lockPath).split(/\s+/)[0]);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && !processAlive(pid)) {
      // Stale lock from a crashed holder: remove it and retry once.
      try {
        unlinkSync(lockPath);
      } catch {
        // Someone else reclaimed it first.
      }
      return tryAcquireFileLock(lockPath);
    }
    return null;
  }
  const token = `${process.pid} ${Date.now()} ${Math.random().toString(36).slice(2)}`;
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Only remove the lock if it is still ours.
    if (readHolder(lockPath) === token) unlinkSync(lockPath);
  };
}

export async function acquireFileLock(lockPath: string, opts: LockOptions = {}): Promise<ReleaseLock> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const retryMs = opts.retryMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const release = tryAcquireFileLock(lockPath);
    if (release) return release;
    if (Date.now() >= deadline) throw new LockTimeoutError(lockPath, readHolder(lockPath));
    await new Promise((r) => setTimeout(r, retryMs));
  }
}

/** In-process FIFO mutex keyed by pool id, used by `MemoryStore`. */
export class KeyedMutex {
  private tails = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<ReleaseLock> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => next);
    this.tails.set(key, tail);
    await prev;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.tails.get(key) === tail) this.tails.delete(key);
      release();
    };
  }
}
