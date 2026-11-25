/**
 * Durable per-pool ASP state. `FileStore` persists JSON under a data directory;
 * `MemoryStore` is for tests. State is small (indices + cursors), so JSON is plenty.
 *
 * Every writer (the indexer tick, `asp:reinstate`) must hold `lock(poolId)` across
 * its whole load → mutate → save cycle, otherwise one writer's save silently
 * overwrites the other's changes (#1086).
 */
import { join } from "node:path";
import { readJson, writeAtomic } from "../../shared/atomic-file.ts";
import { acquireFileLock, KeyedMutex, type LockOptions, type ReleaseLock } from "./lock.ts";
import type { PoolState } from "./types.ts";

export interface Store {
  load(poolId: string): PoolState | null;
  save(state: PoolState): void;
  /** Take the exclusive per-pool writer lock. */
  lock(poolId: string, opts?: LockOptions): Promise<ReleaseLock>;
}

export class FileStore implements Store {
  constructor(private readonly dataDir: string) {}

  private path(poolId: string): string {
    return join(this.dataDir, "state", `${poolId}.json`);
  }

  load(poolId: string): PoolState | null {
    const p = this.path(poolId);
    return readJson<PoolState>(p);
  }

  save(state: PoolState): void {
    const p = this.path(state.poolId);
    writeAtomic(p, `${JSON.stringify(state, null, 2)}\n`);
  }

  lock(poolId: string, opts?: LockOptions): Promise<ReleaseLock> {
    return acquireFileLock(`${this.path(poolId)}.lock`, opts);
  }
}

export class MemoryStore implements Store {
  private states = new Map<string, PoolState>();
  private mutex = new KeyedMutex();
  /** Number of `save` calls, so tests can assert that no-op ticks skip the write. */
  saves = 0;
  load(poolId: string): PoolState | null {
    const s = this.states.get(poolId);
    return s ? structuredClone(s) : null;
  }
  save(state: PoolState): void {
    this.saves++;
    this.states.set(state.poolId, structuredClone(state));
  }
  lock(poolId: string): Promise<ReleaseLock> {
    return this.mutex.acquire(poolId);
  }
}

/** Run `fn` while holding the store's per-pool writer lock. */
export async function withPoolLock<T>(store: Store, poolId: string, fn: () => Promise<T> | T, opts?: LockOptions): Promise<T> {
  const release = await store.lock(poolId, opts);
  try {
    return await fn();
  } finally {
    release();
  }
}
