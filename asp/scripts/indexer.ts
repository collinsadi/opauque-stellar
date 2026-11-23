/** ASP indexer CLI. Network, manifest, policy, cadence, and backoff are env-driven. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { StellarChainAdapter } from "../src/chains/stellar.ts";
import { FileStore } from "../src/store.ts";
import { allowlist, approveAll } from "../src/policy.ts";
import { runPoolTick } from "../src/engine.ts";
import { PublicationMonitor } from "../src/monitor.ts";
import { ReorgGuard } from "../src/reorg-guard.ts";
import type { AspMetrics } from "../src/metrics.ts";
import { recordTickFailure, recordTickSuccess } from "../src/metrics.ts";
import type { ChainAdapter } from "../src/types.ts";
import type { Store } from "../src/store.ts";
import type { Logger } from "../src/logger.ts";
import { numberEnv } from "../src/env.ts";
import { backoffDelayMs } from "../src/backoff.ts";
import { correlationId, createLogger } from "../src/logger.ts";
import { getDeploymentManifest, requireDeployedContract, resolveDeploymentNetwork } from "../../deployments/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MAX_ROOT_AGE_MS = 120_000;
const DEFAULT_MAX_BACKOFF_MS = 120_000;
const FAILURE_ALERT_THRESHOLD = 3;

function parseAllowlist(raw: string | undefined): number[] {
  if (!raw?.trim()) return [];
  if (existsSync(raw.trim())) raw = readFileSync(raw.trim(), "utf8");
  return raw
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0) throw new Error(`invalid ASP_ALLOWLIST_INDICES entry: ${part}`);
      return index;
    });
}

function loadPolicy() {
  const name = (process.env.ASP_POLICY ?? "approveAll").trim().toLowerCase();
  if (name === "approveall" || name === "approve-all") return approveAll;
  if (name === "allowlist") return allowlist(parseAllowlist(process.env.ASP_ALLOWLIST_INDICES));
  throw new Error(`unsupported ASP_POLICY "${process.env.ASP_POLICY}"; expected approveAll or allowlist`);
}

export function loadConfig() {
  const network = resolveDeploymentNetwork(process.env.OPAQUE_NETWORK ?? process.env.STELLAR_NETWORK ?? "testnet");
  const manifest = getDeploymentManifest(network) as any;
  const poolId = process.env.PRIVACY_POOL_ID?.trim() || requireDeployedContract(manifest, "privacyPool", "ASP");
  const scope = manifest.wiring?.privacyPool?.scope ?? 1;
  const secret = process.env.ASP_SECRET?.trim();
  if (!secret) throw new Error("set ASP_SECRET (the ASP authority S... seed)");
  // Ed25519 key that signs every published manifest (#1081). Defaults to the ASP
  // authority key, whose G-address is already the pool's published ASP identity.
  const manifestSecret = process.env.ASP_MANIFEST_SECRET?.trim() || secret;

  return {
    network,
    networkPassphrase: process.env.NETWORK_PASSPHRASE?.trim() || manifest.networkPassphrase,
    policy: loadPolicy(),
    poolId,
    scope,
    authority: Keypair.fromSecret(secret),
    manifestSigner: Keypair.fromSecret(manifestSecret),
    rpcUrl: process.env.STELLAR_RPC_URL ?? manifest.rpcUrl ?? "https://soroban-testnet.stellar.org",
    deploymentLedger: manifest.deploymentLedger ?? undefined,
    intervalMs: numberEnv("ASP_INTERVAL_MS", 15000, { min: 1 }),
    maxBackoffMs: numberEnv("ASP_MAX_BACKOFF_MS", DEFAULT_MAX_BACKOFF_MS, { min: 1 }),
    failureAlertThreshold: numberEnv("ASP_FAILURE_ALERT_THRESHOLD", FAILURE_ALERT_THRESHOLD, { min: 1, integer: true }),
    confirmations: numberEnv("ASP_CONFIRMATIONS", 1, { min: 0, integer: true }),
    maxRootAgeMs: numberEnv("ASP_MAX_ROOT_AGE_MS", DEFAULT_MAX_ROOT_AGE_MS, { min: 1 }),
    dataDir: process.env.ASP_DATA_DIR ? resolve(process.env.ASP_DATA_DIR) : join(__dirname, "..", "data"),
  };
}

export function createPublicationMonitor(cfg, overrides = {}) {
  return new PublicationMonitor({
    maxRootAgeMs: cfg.maxRootAgeMs,
    onAlert: (alert) => createLogger("asp", { correlationId: "monitor" }).warn("publication stale", { alert }),
    ...overrides,
  });
}

export function createReorgGuard(overrides = {}) {
  return new ReorgGuard({
    onDivergence: (event) => createLogger("asp", { correlationId: "reorg" }).error("ledger divergence", { event }),
    ...overrides,
  });
}

export async function tick(cfg, adapter, store, monitor, guard, metrics = undefined, parentLogger = createLogger("asp")) {
  const tickStart = Date.now();
  const log = parentLogger.child({ correlationId: correlationId("asp-tick"), poolId: cfg.poolId, network: cfg.network, policy: cfg.policy?.name ?? "approve-all" });
  let res;
  try {
    res = await runPoolTick({
      poolId: cfg.poolId,
      scope: cfg.scope,
      adapter,
      store,
      policy: cfg.policy ?? approveAll,
      dataDir: cfg.dataDir,
      manifestSigner: cfg.manifestSigner,
      confirmations: cfg.confirmations,
      publicationMonitor: monitor,
      reorgGuard: guard,
    });
  } catch (err) {
    if (metrics) recordTickFailure(metrics, err, Date.now() - tickStart);
    throw err;
  }
  if (metrics) recordTickSuccess(metrics, res, Date.now() - tickStart);
  const actions = [
    res.published ? "ASP_PUBLISHED" : null,
    res.statePublished ? "STATE_PUBLISHED" : null,
    res.haltedForReorg ? "HALTED_FOR_REORG" : null,
  ].filter(Boolean);
  log.info("tick complete", {
    approved: res.approvedCount,
    newlyApproved: res.newlyApproved,
    rejected: res.rejectedCount,
    newlyRejected: res.newlyRejected,
    deferred: res.deferredCount,
    aspRoot: res.localRoot,
    stateLeaves: res.stateLeafCount ?? null,
    actions,
  });
  return res;
}

async function main() {
  const once = process.argv.includes("--once");
  const cfg = loadConfig();
  const adapter = new StellarChainAdapter({
    rpcUrl: cfg.rpcUrl,
    networkPassphrase: cfg.networkPassphrase,
    poolId: cfg.poolId,
    scope: cfg.scope,
    authority: cfg.authority,
    deploymentLedger: cfg.deploymentLedger,
  });
  const store = new FileStore(cfg.dataDir);
  const monitor = createPublicationMonitor(cfg);
  const guard = createReorgGuard();
  const log = createLogger("asp", { poolId: cfg.poolId, network: cfg.network, policy: cfg.policy.name });

  if (once) {
    await tick(cfg, adapter, store, monitor, guard, undefined, log);
    return;
  }

  log.info("indexer loop started", { intervalMs: cfg.intervalMs, maxBackoffMs: cfg.maxBackoffMs, maxRootAgeMs: cfg.maxRootAgeMs });
  let failureStreak = 0;
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    try {
      await tick(cfg, adapter, store, monitor, guard, undefined, log);
      failureStreak = 0;
    } catch (e) {
      failureStreak += 1;
      log.error("tick failed", { error: e, failureStreak });
      if (failureStreak >= cfg.failureAlertThreshold) {
        log.error("failure streak alert", { failureStreak, threshold: cfg.failureAlertThreshold });
      }
    }
    const delayMs = backoffDelayMs(failureStreak, { baseIntervalMs: cfg.intervalMs, maxIntervalMs: cfg.maxBackoffMs });
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    createLogger("asp").error("indexer crashed", { error: e });
    process.exit(1);
  });
}