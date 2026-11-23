/**
 * Stellar/Soroban chain adapter: reads finalized `Deposit` events from the privacy-pool
 * contract, rebuilds public pool state leaves, and posts roots signed by the ASP authority
 * keypair (the pool admin for the demo). Never run in CI — the engine is tested against an
 * in-memory fake adapter; this talks to a live network.
 */
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { ChainAdapter, Deposit, StateTreeSnapshot } from "../types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface StellarAdapterConfig {
  rpcUrl: string;
  networkPassphrase: string;
  poolId: string;
  scope: number;
  authority: Keypair;
  /** Ledger the pool was deployed at (preferred cold-start cursor). */
  deploymentLedger?: number;
  /** Max ledgers to look back on a cold start when deploymentLedger is unknown. */
  lookback?: number;
}

function parseOldestLedgerFromRangeError(err: unknown): number | null {
  let msg = "";
  if (err instanceof Error) msg = err.message;
  else if (typeof err === "string") msg = err;
  else if (err && typeof err === "object") {
    const o = err as { message?: unknown };
    msg = typeof o.message === "string" ? o.message : "";
  }
  const m = /ledger range:\s*(\d+)\s*-\s*(\d+)/.exec(msg);
  return m ? Number(m[1]) : null;
}

export class StellarChainAdapter implements ChainAdapter {
  private server: rpc.Server;
  constructor(private cfg: StellarAdapterConfig) {
    this.server = new rpc.Server(cfg.rpcUrl);
  }

  async latestLedger(): Promise<number> {
    return (await this.server.getLatestLedger()).sequence;
  }

  private async resolveEventStartLedger(fromLedger = 0): Promise<number> {
    if (fromLedger > 0) return fromLedger;
    const latest = await this.latestLedger();
    const lookback = this.cfg.lookback ?? 16000;
    let start = this.cfg.deploymentLedger && this.cfg.deploymentLedger > 0
      ? this.cfg.deploymentLedger
      : Math.max(1, latest - lookback);
    try {
      const health = await this.server.getHealth();
      const oldest = Number(health.oldestLedger);
      if (start < oldest) start = oldest;
    } catch {
      /* health unavailable */
    }
    return start;
  }

  private async getEventsFrom(startLedger: number, filters: any[]): Promise<any> {
    try {
      return await this.server.getEvents({ startLedger, filters, limit: 100 });
    } catch (err) {
      const oldest = parseOldestLedgerFromRangeError(err);
      if (oldest != null && startLedger < oldest) {
        return await this.server.getEvents({ startLedger: oldest, filters, limit: 100 });
      }
      throw err;
    }
  }

  private async currentRoot(state: boolean): Promise<string | null> {
    try {
      const acct = await this.server.getAccount(this.cfg.authority.publicKey());
      const tx = new TransactionBuilder(acct, {
        fee: BASE_FEE,
        networkPassphrase: this.cfg.networkPassphrase,
      })
        .addOperation(new Contract(this.cfg.poolId).call("get_latest_root", xdr.ScVal.scvBool(state)))
        .setTimeout(30)
        .build();
      const sim = await this.server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) {
        const text = JSON.stringify(sim);
        if (text.includes(state ? "UnknownStateRoot" : "UnknownAspRoot")) return null;
        throw new Error(`simulation failed while reading ${state ? "state" : "ASP"} root`);
      }
      if (!sim.result?.retval) throw new Error(`missing ${state ? "state" : "ASP"} root simulation result`);
      const native = scValToNative(sim.result.retval);
      return "0x" + Buffer.from(native).toString("hex");
    } catch (err) {
      throw new Error(`RPC read failed while reading ${state ? "state" : "ASP"} root`, { cause: err });
    }
  }

  private async postRoot(state: boolean, root: string, datasetHash: string): Promise<void> {
    const kp = this.cfg.authority;
    const acct = await this.server.getAccount(kp.publicKey());
    const toBytes = (hex: string) => xdr.ScVal.scvBytes(Buffer.from(hex.replace(/^0x/, ""), "hex"));
    const method = state ? "update_state_root" : "update_asp_root";
    let tx = new TransactionBuilder(acct, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(
        new Contract(this.cfg.poolId).call(
          method,
          new Address(kp.publicKey()).toScVal(),
          toBytes(root),
          toBytes(datasetHash),
        ),
      )
      .setTimeout(120)
      .build();
    tx = await this.server.prepareTransaction(tx);
    tx.sign(kp);
    const sent = await this.server.sendTransaction(tx);
    if (sent.status === "ERROR") {
      throw new Error(`${method} rejected: ${JSON.stringify(sent.errorResult ?? sent)}`);
    }
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      const r = await this.server.getTransaction(sent.hash);
      if (r.status === "SUCCESS") return;
      if (r.status === "FAILED") throw new Error(`${method} FAILED ${sent.hash}`);
    }
    throw new Error(`${method} not confirmed: ${sent.hash}`);
  }

  async readDeposits(afterIndex: number, fromLedger: number): Promise<Deposit[]> {
    const startLedger = await this.resolveEventStartLedger(fromLedger);
    const depositTopic = xdr.ScVal.scvSymbol("Deposit").toXDR("base64");
    const filters: rpc.Api.EventFilter[] = [{ type: "contract", contractIds: [this.cfg.poolId], topics: [[depositTopic, "*"]] }];

    const deposits: Deposit[] = [];
    let cursor: string | undefined;
    let prevCursor: string | undefined;
    // Page through events; the Deposit topic is 2 segments [Symbol, version], so the
    // filter is exactly 2 long (matches Soroban's exact-length topic rule).
    // getEvents scans the ledger range ~10k ledgers per page and returns many EMPTY
    // pages before the populated ones, so follow the cursor until it stops advancing
    // (caught up to latestLedger). Breaking on the first short page would miss every
    // deposit beyond the first page.
    let exhausted = false;
    for (let page = 0; page < 400; page++) {
      const res = cursor
        ? await this.server.getEvents({ cursor, filters, limit: 100 })
        : await this.getEventsFrom(startLedger, filters);
      for (const ev of res.events ?? []) {
        const [commitment, index, value, scope] = scValToNative(ev.value);
        const idx = Number(index);
        if (idx <= afterIndex) continue;
        deposits.push({
          index: idx,
          commitment: "0x" + Buffer.from(commitment).toString("hex"),
          value: value.toString(),
          scope: Number(scope),
          ledger: ev.ledger,
        });
      }
      cursor = res.cursor;
      if (!cursor || cursor === prevCursor) { exhausted = true; break; }
      prevCursor = cursor;
    }
    if (!exhausted) throw new Error("ASP deposit event page limit reached; cursor was not advanced. Increase pagination capacity or backfill from a recent ledger.");
    deposits.sort((a, b) => a.index - b.index);
    return deposits;
  }

  async currentAspRoot(): Promise<string | null> {
    return this.currentRoot(false);
  }

  async postAspRoot(root: string, datasetHash: string): Promise<void> {
    return this.postRoot(false, root, datasetHash);
  }

  async currentStateRoot(): Promise<string | null> {
    return this.currentRoot(true);
  }

  async postStateRoot(root: string, datasetHash: string): Promise<void> {
    return this.postRoot(true, root, datasetHash);
  }

  async readStateLeaves(fromLedger = 0): Promise<StateTreeSnapshot> {
    const health = await this.server.getHealth();
    const oldestLedger = Number(health.oldestLedger);
    if (fromLedger > 0 && fromLedger < oldestLedger) {
      throw new Error(`state event retention gap: cursor ${fromLedger} is older than RPC oldest ledger ${oldestLedger}`);
    }
    let startLedger = fromLedger;
    if (startLedger === 0) {
      const latest = await this.latestLedger();
      const lookback = this.cfg.lookback ?? 16000;
      startLedger = this.cfg.deploymentLedger && this.cfg.deploymentLedger > 0
        ? this.cfg.deploymentLedger
        : Math.max(1, latest - lookback);
      if (startLedger < oldestLedger) {
        throw new Error(`state event retention gap: required start ${startLedger} is older than RPC oldest ledger ${oldestLedger}`);
      }
    }
    const depositTopic = xdr.ScVal.scvSymbol("Deposit").toXDR("base64");
    const withdrawTopic = xdr.ScVal.scvSymbol("Withdraw").toXDR("base64");
    const byIndex = new Map<number, string>();
    const events: Array<{ index: number; leaf: string }> = [];
    let eventCount = 0;

    let completedLedger = startLedger;
    for (const [topic, isDeposit] of [
      [depositTopic, true],
      [withdrawTopic, false],
    ] as const) {
      const filters: rpc.Api.EventFilter[] = [{ type: "contract", contractIds: [this.cfg.poolId], topics: [[topic, "*"]] }];
      let cursor: string | undefined;
      let prevCursor: string | undefined;
      // Follow the cursor until it stops advancing; getEvents returns many EMPTY
      // pages before the populated ones, so breaking on a short page would miss
      // leaves beyond the first page.
      let exhausted = false;
      for (let page = 0; page < 400; page++) {
        const res = cursor
          ? await this.server.getEvents({ cursor, filters, limit: 100 })
          : await this.server.getEvents({ startLedger, filters, limit: 100 });
        for (const ev of res.events ?? []) {
          const data = scValToNative(ev.value);
          const commitment = isDeposit ? data[0] : data[1];
          const index = Number(isDeposit ? data[1] : data[2]);
          const leaf = "0x" + Buffer.from(commitment).toString("hex");
          byIndex.set(index, leaf);
          events.push({ index, leaf });
          eventCount++;
          completedLedger = Math.max(completedLedger, Number(ev.ledger));
        }
        cursor = res.cursor;
        if (!cursor || cursor === prevCursor) { exhausted = true; break; }
        prevCursor = cursor;
      }
      if (!exhausted) throw new Error("ASP state event page limit reached; cursor was not advanced. Retry with a larger page limit or backfill from deployment.");
    }

    const maxIndex = byIndex.size === 0 ? -1 : Math.max(...byIndex.keys());
    const leaves: string[] = [];
    for (let i = 0; i <= maxIndex; i++) {
      leaves.push(byIndex.get(i) ?? `0x${"00".repeat(32)}`);
    }
    return { leaves, eventCount, maxIndex, events, cursor: completedLedger };
  }
}
