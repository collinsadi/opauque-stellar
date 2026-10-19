/**
 * Minimal reputation publisher HTTP API.
 *
 * POST   /v1/reputation/leaves        - requires Bearer token in PUBLISHER_SUBMIT_TOKENS
 * GET    /v1/reputation/root/:leaf
 * GET    /v1/reputation/snapshot/:verifierId
 * GET    /v1/reputation/quarantine    - requires Bearer token in PUBLISHER_OPERATOR_TOKENS
 * GET    /metrics                     - requires Bearer token in PUBLISHER_OPERATOR_TOKENS
 * GET    /health
 *
 * `POST /v1/reputation/leaves` only queues the commitment into the durable inbox and
 * acknowledges immediately (202). Publication — the on-chain Soroban round trip — runs on
 * a background tick loop at PUBLISHER_INTERVAL_MS, independent of any single request, with
 * retry on the next interval if a tick fails. Submitters confirm inclusion once the
 * background loop publishes via GET /v1/reputation/root/:leaf or /snapshot/:verifierId.
 * See src/auth.ts for the token issuance flow and src/trusted-proxy.ts for
 * PUBLISHER_TRUSTED_PROXIES, which gates how X-Forwarded-For is honored.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { StellarReputationAdapter } from "../src/chains/stellar.ts";
import { createMetrics } from "../src/engine.ts";
import { FileStore } from "../src/store.ts";
import { createRateLimiterFromEnv } from "../src/rate-limit.ts";
import { createPublisherHttpServer, runPublisherLoop } from "../src/http.ts";
import { loadAuthConfigFromEnv } from "../src/auth.ts";
import { loadTrustedProxiesFromEnv } from "../src/trusted-proxy.ts";
import { numberEnv } from "../src/env.ts";
import { createLogger } from "../src/logger.ts";
import { getDeploymentManifest, requireDeployedContract, resolveDeploymentNetwork } from "../../deployments/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAX_INBOX_SIZE = numberEnv("PUBLISHER_MAX_INBOX", 10_000, { min: 1, integer: true });
const MAX_BODY_BYTES = numberEnv("PUBLISHER_MAX_BODY_BYTES", 32 * 1024, { min: 1, integer: true });

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
    dataDir: process.env.PUBLISHER_DATA_DIR
      ? resolve(process.env.PUBLISHER_DATA_DIR)
      : join(__dirname, "..", "data"),
    host: process.env.PUBLISHER_HTTP_HOST ?? "127.0.0.1",
    port: numberEnv("PUBLISHER_HTTP_PORT", 8790, { min: 1, max: 65535, integer: true }),
    intervalMs: numberEnv("PUBLISHER_INTERVAL_MS", 15000, { min: 1 }),
    corsOrigin: process.env.PUBLISHER_CORS_ORIGIN ?? "",
  };
}

async function main() {
  const cfg = loadConfig();
  const store = new FileStore(cfg.dataDir, MAX_INBOX_SIZE);
  const metrics = createMetrics();
  const adapter = new StellarReputationAdapter({
    rpcUrl: cfg.rpcUrl,
    networkPassphrase: cfg.networkPassphrase,
    verifierId: cfg.verifierId,
    attestationEngineId: cfg.attestationEngineId,
    publisher: cfg.publisher,
  });
  const rateLimiter = createRateLimiterFromEnv();
  const authCfg = loadAuthConfigFromEnv();
  const trustedProxies = loadTrustedProxiesFromEnv();

  runPublisherLoop({
    verifierId: cfg.verifierId,
    adapter,
    store,
    metrics,
    dataDir: cfg.dataDir,
    intervalMs: cfg.intervalMs,
    onTick: (res) => {
      if (!res.published) return;
      createLogger("publisher", { verifierId: cfg.verifierId, network: cfg.network }).info("root published", { root: res.localRoot, txHash: res.txHash });
    },
    onError: (err) => {
      createLogger("publisher", { verifierId: cfg.verifierId, network: cfg.network }).error("background publish tick failed", { error: err });
    },
  }).catch((err) => {
    createLogger("publisher", { verifierId: cfg.verifierId, network: cfg.network }).error("publish loop crashed", { error: err });
    process.exit(1);
  });

  const server = createPublisherHttpServer({
    verifierId: cfg.verifierId,
    store,
    metrics,
    rateLimiter,
    dataDir: cfg.dataDir,
    corsOrigin: cfg.corsOrigin,
    maxBodyBytes: MAX_BODY_BYTES,
    authConfig: authCfg,
    chainAdapter: adapter,
    trustedProxies,
  });

  server.listen(cfg.port, cfg.host, () => {
    createLogger("publisher", { verifierId: cfg.verifierId, network: cfg.network }).info("api listening", { endpoint: `http://${cfg.host}:${cfg.port}`, maxInbox: MAX_INBOX_SIZE, publishIntervalMs: cfg.intervalMs });
  });
}

main().catch((err) => {
  createLogger("publisher").error("server crashed", { error: err });
  process.exit(1);
});

