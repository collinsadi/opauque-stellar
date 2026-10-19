import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeAtomic } from "../../shared/atomic-file.ts";
import type { RelayerBid } from "./messages.ts";
import type { RelayerHubStats } from "./hub.ts";
import type { JobLedgerEntry } from "./reconciler.ts";
import type { AcceptedJobEntry } from "./job-queue.ts";

// ---------------------------------------------------------------------------
// Hub state (serialisable snapshot of RelayerHub internals)
// ---------------------------------------------------------------------------

type OutcomeEntry = { result: "completed" | "failed"; at: number };

export type HubState = {
  bids: ReadonlyArray<readonly [string, ReadonlyArray<RelayerBid>]>;
  outcomes: ReadonlyArray<readonly [string, ReadonlyArray<OutcomeEntry>]>;
  knownOperators: string[];
  lastHeartbeatAt: ReadonlyArray<readonly [string, number]>;
  assignments: ReadonlyArray<readonly [string, string | { operator: string; addedAt: number }]>;
  stats: RelayerHubStats;
};

export interface HubStore {
  load(): Promise<HubState | null>;
  save(state: HubState): Promise<void>;
  clear(): Promise<void>;
  getBids(): Promise<[string, RelayerBid[]][] | null>;
  getOutcomes(): Promise<[string, OutcomeEntry[]][] | null>;
  getKnownOperators(): Promise<string[] | null>;
  getLastHeartbeatAt(): Promise<[string, number][] | null>;
  getAssignments(): Promise<[string, string][] | null>;
  getStats(): Promise<RelayerHubStats | null>;
}

// ---------------------------------------------------------------------------
// Job ledger store
// ---------------------------------------------------------------------------

export interface LedgerStore {
  load(): Promise<JobLedgerEntry[] | null>;
  save(entries: JobLedgerEntry[]): Promise<void>;
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Accepted-jobs store (accepted but not yet submitted — issue #975)
// ---------------------------------------------------------------------------

export interface AcceptedJobStore {
  load(): Promise<AcceptedJobEntry[] | null>;
  save(entries: AcceptedJobEntry[]): Promise<void>;
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory implementations (tests)
// ---------------------------------------------------------------------------

export class MemoryHubStore implements HubStore {
  private state: HubState | null = null;

  async load(): Promise<HubState | null> {
    return this.state;
  }

  async save(state: HubState): Promise<void> {
    this.state = state;
  }

  async clear(): Promise<void> {
    this.state = null;
  }

  async getBids(): Promise<[string, RelayerBid[]][] | null> {
    return this.state?.bids ?? null;
  }

  async getOutcomes(): Promise<[string, OutcomeEntry[]][] | null> {
    return this.state?.outcomes ?? null;
  }

  async getKnownOperators(): Promise<string[] | null> {
    return this.state?.knownOperators ?? null;
  }

  async getLastHeartbeatAt(): Promise<[string, number][] | null> {
    return this.state?.lastHeartbeatAt ?? null;
  }

  async getAssignments(): Promise<[string, string][] | null> {
    return this.state?.assignments ?? null;
  }

  async getStats(): Promise<RelayerHubStats | null> {
    return this.state?.stats ?? null;
  }
}

export class MemoryLedgerStore implements LedgerStore {
  private entries: JobLedgerEntry[] | null = null;

  async load(): Promise<JobLedgerEntry[] | null> {
    return this.entries;
  }

  async save(entries: JobLedgerEntry[]): Promise<void> {
    this.entries = entries;
  }

  async clear(): Promise<void> {
    this.entries = null;
  }
}

export class MemoryAcceptedJobStore implements AcceptedJobStore {
  private entries: AcceptedJobEntry[] | null = null;

  async load(): Promise<AcceptedJobEntry[] | null> {
    return this.entries;
  }

  async save(entries: AcceptedJobEntry[]): Promise<void> {
    this.entries = entries;
  }

  async clear(): Promise<void> {
    this.entries = null;
  }
}

// ---------------------------------------------------------------------------
// File-backed implementations
// ---------------------------------------------------------------------------

const HUB_FILE = "hub.json";
const LEDGER_FILE = "ledger.json";
const ACCEPTED_JOBS_FILE = "accepted-jobs.json";
const STATE_VERSION = 1;

function readJsonFile<T>(filePath: string): T | null {
  return readJson<T>(filePath);
}

function writeJsonFile(
  filePath: string,
  data: unknown,
  replacer?: (key: string, value: unknown) => unknown,
): void {
  ensureDir(filePath);
  writeFileSync(filePath, JSON.stringify(data, replacer ?? null, 2) + "\n", "utf8");
}

function serialiseBigInt(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return `__bigint__:${value.toString()}`;
  return value;
}

function deserializeFee(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string") {
    const decimal = value.startsWith("__bigint__:") ? value.slice("__bigint__:".length) : value;
    return BigInt(decimal);
  }
  throw new TypeError("ledger expectedFee must be an integer");
}

export class FileHubStore implements HubStore {
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, HUB_FILE);
  }

  async load(): Promise<HubState | null> {
    const raw = readJsonFile<{ version?: number; state: HubState }>(this.filePath);
    if (!raw || raw.version !== STATE_VERSION) return null;
    const s = raw.state;
    return {
      bids: (s.bids ?? []).map(([k, v]) => [k, v]),
      outcomes: (s.outcomes ?? []).map(([k, v]) => [k, v]),
      knownOperators: s.knownOperators ?? [],
      lastHeartbeatAt: (s.lastHeartbeatAt ?? []).map(([k, v]) => [k, v]),
      assignments: (s.assignments ?? []).map(([k, v]) => [k, v]),
      stats: s.stats,
    };
  }

  async save(state: HubState): Promise<void> {
    writeJsonFile(this.filePath, { version: STATE_VERSION, state }, serialiseBigInt);
  }

  async clear(): Promise<void> {
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(this.filePath);
    } catch {
      // ignore
    }
  }

  async getBids(): Promise<[string, RelayerBid[]][] | null> {
    return (await this.load())?.bids ?? null;
  }

  async getOutcomes(): Promise<[string, OutcomeEntry[]][] | null> {
    return (await this.load())?.outcomes ?? null;
  }

  async getKnownOperators(): Promise<string[] | null> {
    return (await this.load())?.knownOperators ?? null;
  }

  async getLastHeartbeatAt(): Promise<[string, number][] | null> {
    return (await this.load())?.lastHeartbeatAt ?? null;
  }

  async getAssignments(): Promise<[string, string][] | null> {
    return (await this.load())?.assignments ?? null;
  }

  async getStats(): Promise<RelayerHubStats | null> {
    return (await this.load())?.stats ?? null;
  }
}

export class FileLedgerStore implements LedgerStore {
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, LEDGER_FILE);
  }

  async load(): Promise<JobLedgerEntry[] | null> {
    const raw = readJsonFile<{ version?: number; entries: JobLedgerEntry[] }>(this.filePath);
    if (!raw || raw.version !== STATE_VERSION) return null;
    return (raw.entries ?? []).map((e) => ({
      ...e,
      expectedFee: deserializeFee(e.expectedFee),
    }));
  }

  async save(entries: JobLedgerEntry[]): Promise<void> {
    writeJsonFile(
      this.filePath,
      {
        version: STATE_VERSION,
        entries: entries.map((e) => ({ ...e, expectedFee: e.expectedFee.toString() })),
      },
      serialiseBigInt,
    );
  }

  async clear(): Promise<void> {
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(this.filePath);
    } catch {
      // ignore
    }
  }
}

/**
 * Accepted-but-unsubmitted jobs, persisted so a crash between `accept_job` and
 * `submit_pool_withdraw` is recoverable on the next boot (#975). Entries hold
 * only plain JSON — the payload is pre-serialized and the fee is a decimal
 * string — so no bigint encoding is needed here.
 */
export class FileAcceptedJobStore implements AcceptedJobStore {
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, ACCEPTED_JOBS_FILE);
  }

  async load(): Promise<AcceptedJobEntry[] | null> {
    const raw = readJsonFile<{ version?: number; entries: AcceptedJobEntry[] }>(this.filePath);
    if (!raw || raw.version !== STATE_VERSION) return null;
    return raw.entries ?? [];
  }

  async save(entries: AcceptedJobEntry[]): Promise<void> {
    writeJsonFile(this.filePath, { version: STATE_VERSION, entries });
  }

  async clear(): Promise<void> {
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(this.filePath);
    } catch {
      // ignore
    }
  }
}
