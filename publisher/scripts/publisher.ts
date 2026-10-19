/**
 * Reputation publisher CLI.
 *
 *   npm run publisher:once
 *   npm run publisher
 *
 * Config: PUBLISHER_SECRET, STELLAR_RPC_URL, PUBLISHER_INTERVAL_MS,
 * PUBLISHER_DATA_DIR, PUBLISHER_MAX_INBOX. The verifier id is read from
 * deployments/v1/testnet.json unless REPUTATION_VERIFIER_ID overrides it.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { StellarReputationAdapter } from "../src/chains/stellar.ts";
import { runPublisherTick, createMetrics } from "../src/engine.ts";
import { FileStore } from "../src/store.ts";
import { numberEnv } from "../src/env.ts";
import { correlationId, createLogger } from "../src/logger.ts";
import { getDeploymentManifest, requireDeployedContract, resolveDeploymentNetwork } from "../../deployments/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAX_INBOX_SIZE = numberEnv("PUBLISHER_MAX_INBOX", 10_000, { min: 1, integer: true });

function loadConfig() {
  const network = resolveDeploymentNetwork(process.env.OPAQUE_NETWORK ?? process.env.STELLAR_NETWORK ?? "testnet");
  const manifest = getDeploymentManifest(network) as any;
  const verifierId = process.env.REPUTATION_VERIFIER_ID?.trim() || requireDeployedContract(manifest, "reputationVerifier", "publisher");
  const attestationEngineId = process.env.ATTESTATION_ENGINE_V2_ID?.trim() || requireDeployedContract(manifest, "attestationEngineV2", "publisher");

  const secret = process.env.PUBLISHER_SECRET?.trim() ?? process.env.DEPLOYER_SECRET?.trim();
  if (!secret) throw new Error("set PUBLISHER_SECRET (current testnet requires the verifier admin key)");

  return {
    network,
    networkPassphrase: process.env.NETWORK_PASSPHRASE?.trim() || manifest.networkPassphrase,
    verifierId,
    attestationEngineId,
    publisher: Keypair.fromSecret(secret),
    rpcUrl: process.env.STELLAR_RPC_URL ?? manifest.rpcUrl ?? "https://soroban-testnet.stellar.org",
    intervalMs: numberEnv("PUBLISHER_INTERVAL_MS", 15000, { min: 1 }),
    dataDir: process.env.PUBLISHER_DATA_DIR
      ? resolve(process.env.PUBLISHER_DATA_DIR)
      : join(__dirname, "..", "data"),
  };
}

async function tick(cfg, adapter, store, metrics, parentLogger = createLogger("publisher")) {
  const res = await runPublisherTick({
    verifierId: cfg.verifierId,
    attestationEngineId: cfg.attestationEngineId,
    adapter,
    store,
    dataDir: cfg.dataDir,
  }, metrics);
  const actions = [res.published ? `PUBLISHED ${res.txHash}` : null].filter(Boolean);
  const log = parentLogger.child({ correlationId: correlationId("publisher-tick"), verifierId: cfg.verifierId, network: cfg.network });
  log.info("tick complete", { leaves: res.leafCount, newlyAccepted: res.newlyAccepted, root: res.localRoot, inbox: metrics.currentInboxDepth, latencyMs: res.latencyMs, actions });
  return res;
}

async function main() {
  const once = process.argv.includes("--once");
  const cfg = loadConfig();
  const adapter = new StellarReputationAdapter({
    rpcUrl: cfg.rpcUrl,
    networkPassphrase: cfg.networkPassphrase,
    verifierId: cfg.verifierId,
    publisher: cfg.publisher,
  });
  const store = new FileStore(cfg.dataDir, MAX_INBOX_SIZE);
  const metrics = createMetrics();

  if (once) {
    await tick(cfg, adapter, store, metrics, createLogger("publisher", { verifierId: cfg.verifierId, network: cfg.network }));
    return;
  }

  const log = createLogger("publisher", { verifierId: cfg.verifierId, network: cfg.network });
  log.info("publisher loop started", { intervalMs: cfg.intervalMs, maxInbox: MAX_INBOX_SIZE });
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    try {
      await tick(cfg, adapter, store, metrics, createLogger("publisher", { verifierId: cfg.verifierId, network: cfg.network }));
    } catch (err) {
      log.error("tick failed", { error: err });
    }
    await new Promise((r) => setTimeout(r, cfg.intervalMs));
  }
}

main().catch((err) => {
  createLogger("publisher").error("publisher crashed", { error: err });
  process.exit(1);
});
