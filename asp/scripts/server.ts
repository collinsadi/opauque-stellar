/**
 * ASP HTTP server: runs the reconcile loop in the background and exposes health, metrics,
 * the current association-set manifest, historical manifests by root, and per-label
 * inclusion paths so an orchestrator can probe it, Prometheus can scrape it, and a
 * withdrawing client can fetch the proof material for the exact root it references —
 * mirroring the publisher's `/health` + `/metrics` API.
 *
 *   GET /health                      — tick success + root freshness (503 when stale/failing)
 *   GET /metrics                     — Prometheus exposition format (tick duration, publication lag, failures)
 *   GET /manifest                    — current association-set manifest (data/sets/<poolId>/latest.json)
 *   GET /manifest/:root              — a specific historical manifest (data/sets/<poolId>/<root>.json)
 *   GET /inclusion/:root/:label      — that label's inclusion path for a given root (#972)
 *
 * Config: same env vars as `indexer.ts` (see its header comment), plus:
 *   ASP_HTTP_HOST (default 127.0.0.1), ASP_HTTP_PORT (default 8791), ASP_CORS_ORIGIN (default *).
 */
import { createServer } from "node:http";
import { StellarChainAdapter } from "../src/chains/stellar.ts";
import { FileStore } from "../src/store.ts";
import { createAspMetrics, formatPrometheusMetrics, rootAgeMs } from "../src/metrics.ts";
import { readInclusion, readLatestManifest, readManifestByRoot } from "../src/manifest-service.ts";
import { createPublicationMonitor, createReorgGuard, loadConfig, tick } from "./indexer.ts";
import { backoffDelayMs } from "../src/backoff.ts";
import { createLogger } from "../src/logger.ts";


function send(res, status, body, corsOrigin, contentType = "application/json") {
  res.writeHead(status, {
    "access-control-allow-origin": corsOrigin,
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": contentType,
  });
  res.end(contentType === "application/json" ? JSON.stringify(body) : body);
}

const publicErrors: Record<string, { code: string; message: string }> = {
  "root must be a 0x-prefixed 32-byte hex string": { code: "INVALID_ROOT", message: "The requested root is invalid." },
  "label must be a decimal field element": { code: "INVALID_LABEL", message: "The requested label is invalid." },
};

async function main() {
  const cfg = loadConfig();
  const host = process.env.ASP_HTTP_HOST ?? "127.0.0.1";
  const port = Number(process.env.ASP_HTTP_PORT ?? 8791);
  const corsOrigin = process.env.ASP_CORS_ORIGIN ?? "*";

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
  const metrics = createAspMetrics();
  const requestWindow = new Map<string, { startedAt: number; count: number }>();

  const log = createLogger("asp", { poolId: cfg.poolId, network: cfg.network, policy: cfg.policy.name });
  async function loop() {
    let failureStreak = 0;
    // eslint-disable-next-line no-constant-condition
    for (;;) {
      try {
        await tick(cfg, adapter, store, monitor, guard, metrics, log);
        failureStreak = 0;
      } catch (e) {
        failureStreak += 1;
        log.error("tick failed", { error: e, failureStreak });
        if (failureStreak >= cfg.failureAlertThreshold) log.error("failure streak alert", { failureStreak, threshold: cfg.failureAlertThreshold });
      }
      const delayMs = backoffDelayMs(failureStreak, { baseIntervalMs: cfg.intervalMs, maxIntervalMs: cfg.maxBackoffMs });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  loop();

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        send(res, 204, {}, corsOrigin);
        return;
      }
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "GET" && (url.pathname === "/manifest" || url.pathname.startsWith("/manifest/") || url.pathname.startsWith("/inclusion/"))) {
        const now = Date.now();
        const key = req.socket.remoteAddress ?? "unknown";
        const window = requestWindow.get(key);
        if (!window || now - window.startedAt >= 60_000) requestWindow.set(key, { startedAt: now, count: 1 });
        else if (++window.count > 60) {
          send(res, 429, { ok: false, code: "RATE_LIMITED", error: "Too many requests." }, corsOrigin);
          return;
        }
      }

      if (req.method === "GET" && url.pathname === "/health") {
        const age = rootAgeMs(metrics);
        // Fresh until a root has ever published and its age exceeds the monitor threshold.
        const rootFresh = age === null || age <= cfg.maxRootAgeMs;
        const ok = metrics.lastTickError === null && rootFresh;
        send(
          res,
          ok ? 200 : 503,
          {
            ok,
            poolId: cfg.poolId,
            totalTicks: metrics.totalTicks,
            totalFailures: metrics.totalFailures,
            consecutiveFailures: metrics.consecutiveFailures,
            lastTickAt: metrics.lastTickAt,
            lastTickError: metrics.lastTickError,
            lastPublishAt: metrics.lastPublishAt,
            rootAgeMs: age,
            maxRootAgeMs: cfg.maxRootAgeMs,
            rootFresh,
          },
          corsOrigin,
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/metrics") {
        send(res, 200, formatPrometheusMetrics(metrics), corsOrigin, "text/plain; version=0.0.4; charset=utf-8");
        return;
      }

      if (req.method === "GET" && url.pathname === "/manifest") {
        const result = readLatestManifest(cfg.dataDir, cfg.poolId);
        send(res, result.status, result.body, corsOrigin);
        return;
      }

      // #972: historical manifests by root, and the inclusion path for a single
      // label — a withdrawing client needs the proof material for the specific
      // root its proof references, not just whatever is current.
      const manifestByRoot = /^\/manifest\/(0x[0-9a-fA-F]{64})$/.exec(url.pathname);
      if (req.method === "GET" && manifestByRoot) {
        const result = readManifestByRoot(cfg.dataDir, cfg.poolId, manifestByRoot[1]!);
        send(res, result.status, result.body, corsOrigin);
        return;
      }

      const inclusion = /^\/inclusion\/(0x[0-9a-fA-F]{64})\/(\d{1,78})$/.exec(url.pathname);
      if (req.method === "GET" && inclusion) {
        const result = await readInclusion(cfg.dataDir, cfg.poolId, inclusion[1]!, inclusion[2]!);
        send(res, result.status, result.body, corsOrigin);
        return;
      }

      send(res, 404, { ok: false, error: "not found" }, corsOrigin);
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      log.error("HTTP request failed", { error: err, path: req.url });
      const known = publicErrors[rawMessage];
      send(res, known ? 400 : 500, known
        ? { ok: false, ...known }
        : { ok: false, code: "INTERNAL_ERROR", error: "The request could not be completed." }, corsOrigin);
    }
  });

  server.listen(port, host, () => {
    log.info("http server listening", { endpoint: `http://${host}:${port}` });
  });
}

main().catch((err) => {
  createLogger("asp").error("http server crashed", { error: err });
  process.exit(1);
});
