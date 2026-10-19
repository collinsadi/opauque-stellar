import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { buildProof } from "./merkle.ts";
import { computeDatasetHash } from "./publish.ts";
import { normalizeCommitment } from "./store.ts";
import { normalizeHex32 } from "./bytes.ts";
import { buildTreeSnapshot, computeSnapshotHash } from "./snapshot.ts";
import { formatPrometheusMetrics } from "./metrics.ts";
import { runPublisherTick } from "./engine.ts";
import { PayloadTooLargeError, readJsonLimited } from "./body.ts";
import { isAuthorizedSubmitter, isAuthorizedOperator, type AuthConfig } from "./auth.ts";
import { resolveClientSource } from "./trusted-proxy.ts";
import { verifyHolderSignature } from "./identity.ts";
import type { RateLimiter } from "./rate-limit.ts";
import type { Store } from "./store.ts";
import type { ChainAdapter, PublisherMetrics } from "./types.ts";

const DEFAULT_MAX_BODY_BYTES = 32 * 1024;

export interface PublisherHttpDeps {
  verifierId: string;
  chainAdapter?: ChainAdapter;
  store: Store;
  metrics: PublisherMetrics;
  rateLimiter: RateLimiter;
  dataDir?: string;
  corsOrigin?: string;
  /** Streaming body-size cap enforced before the payload is buffered. Default 32 KiB. */
  maxBodyBytes?: number;
  /**
   * Bearer-token config gating POST /v1/reputation/leaves (submitTokens) and
   * /v1/reputation/quarantine + /metrics (operatorTokens). Omitted means no
   * auth is enforced on any route — only safe for local/test use;
   * scripts/server.ts always passes this via loadAuthConfigFromEnv() in
   * production.
   */
  authConfig?: AuthConfig;
  /**
   * Peers allowed to set X-Forwarded-For for rate-limit source resolution
   * (see trusted-proxy.ts). Omitted means the header is never trusted and
   * the raw socket address is used.
   */
  trustedProxies?: Set<string>;
}

function send(res: ServerResponse, status: number, body: unknown, corsOrigin: string, contentType = "application/json") {
  res.writeHead(status, {
    "access-control-allow-origin": corsOrigin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": contentType,
  });
  res.end(contentType === "application/json" ? JSON.stringify(body) : body);
}

async function rootResponse(store: Store, verifierId: string, leaf: string) {
  const normalizedLeaf = normalizeHex32(leaf, "leaf");
  const state = store.load(verifierId);
  const leaves = state?.leaves ?? [];
  const leafValues = leaves.map((x) => x.leaf);
  const proof = await buildProof(leafValues, normalizedLeaf);
  const datasetHash = computeDatasetHash(proof.root, leafValues);
  return {
    verifierId,
    leaf: normalizedLeaf,
    leafIndex: proof.leafIndex,
    leafCount: leafValues.length,
    root: proof.root,
    datasetHash,
    pathElements: proof.pathElements,
    pathIndices: proof.pathIndices,
  };
}

/**
 * Builds the publisher HTTP API. `POST /v1/reputation/leaves` only queues the commitment
 * into the durable inbox and returns immediately — publication (the on-chain Soroban round
 * trip) runs on the background tick loop (see `runPublisherLoop`), not inside the request.
 * Submitters confirm inclusion later via the root/snapshot endpoints once a tick publishes.
 */
export function createPublisherHttpServer(deps: PublisherHttpDeps) {
  const corsOrigin = deps.corsOrigin ?? "*";
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const trustedProxies = deps.trustedProxies ?? new Set<string>();
  const { verifierId, store, metrics, rateLimiter, authConfig, chainAdapter } = deps;

  return createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        send(res, 204, {}, corsOrigin);
        return;
      }

      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "POST" && url.pathname === "/v1/reputation/leaves") {
        if (authConfig && !isAuthorizedSubmitter(req, authConfig)) {
          send(res, 401, { ok: false, error: "unauthorized" }, corsOrigin);
          return;
        }
        const source = resolveClientSource(req, trustedProxies);
        const rl = rateLimiter.consume(source);
        if (!rl.allowed) {
          const retryAfter = Math.ceil((rl.resetMs - Date.now()) / 1000);
          send(
            res,
            429,
            { ok: false, error: "rate limit exceeded", retryAfterSeconds: retryAfter, limit: rl.limit, remaining: rl.remaining },
            corsOrigin,
          );
          res.setHeader("X-RateLimit-Limit", String(rl.limit));
          res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
          res.setHeader("X-RateLimit-Reset", String(Math.ceil(rl.resetMs / 1000)));
          res.setHeader("Retry-After", String(retryAfter));
          return;
        }

        const commitment = normalizeCommitment(await readJsonLimited(req, maxBodyBytes), () => new Date().toISOString());
        if (!chainAdapter?.getAttestation || !chainAdapter.currentLedger) {
          send(res, 503, { ok: false, error: "on-chain attestation validation is unavailable" }, corsOrigin);
          return;
        }
        const attestation = await chainAdapter.getAttestation(commitment.attestationUid);
        const ledger = await chainAdapter.currentLedger();
        if (!attestation) {
          send(res, 422, { ok: false, error: "attestation UID does not exist on-chain" }, corsOrigin);
          return;
        }
        if (attestation.schemaId.toLowerCase() !== commitment.schemaId.toLowerCase()) {
          send(res, 422, { ok: false, error: "attestation schema does not match submission" }, corsOrigin);
          return;
        }
        if (attestation.revocationLedger !== 0) {
          send(res, 422, { ok: false, error: "attestation has been revoked" }, corsOrigin);
          return;
        }
        if (attestation.expirationLedger !== 0 && attestation.expirationLedger <= ledger) {
          send(res, 422, { ok: false, error: "attestation has expired" }, corsOrigin);
          return;
        }
        if (!verifyHolderSignature({
          attestationUid: commitment.attestationUid,
          schemaId: commitment.schemaId,
          leaf: commitment.leaf,
          signature: commitment.holderSignature,
          stealthAddressHash: attestation.stealthAddressHash,
        })) {
          send(res, 422, { ok: false, error: "holder signature does not control the attested stealth identity" }, corsOrigin);
          return;
        }
        metrics.totalSubmitted += 1;
        const accepted = store.writeInbox(commitment);
        if (!accepted) {
          metrics.totalRejected += 1;
          send(res, 429, { ok: false, error: "inbox full", retryAfterSeconds: 30, inboxDepth: store.inboxSize() }, corsOrigin);
          return;
        }
        metrics.totalAccepted += 1;
        metrics.currentInboxDepth = store.inboxSize();
        // Ack immediately — publication happens asynchronously on the background tick.
        send(
          res,
          202,
          { ok: true, accepted: commitment, queued: true, inboxDepth: metrics.currentInboxDepth },
          corsOrigin,
        );
        return;
      }

      const rootMatch = /^\/v1\/reputation\/root\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && rootMatch) {
        try {
          send(res, 200, await rootResponse(store, verifierId, decodeURIComponent(rootMatch[1])), corsOrigin);
        } catch {
          send(res, 404, { ok: false, error: "leaf not included in the current reputation root" }, corsOrigin);
        }
        return;
      }

      const snapshotMatch = /^\/v1\/reputation\/snapshot\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && snapshotMatch) {
        const snapshotVerifierId = decodeURIComponent(snapshotMatch[1]);
        const state = store.load(snapshotVerifierId);
        if (!state || state.leaves.length === 0) {
          send(res, 404, { ok: false, error: "no leaves found for this verifier" }, corsOrigin);
          return;
        }
        const leafValues = state.leaves.map((x) => x.leaf);
        const snapshot = await buildTreeSnapshot(snapshotVerifierId, leafValues);
        const snapshotHash = computeSnapshotHash(snapshot);
        send(res, 200, { ok: true, snapshot, snapshotHash }, corsOrigin);
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/reputation/quarantine") {
        if (authConfig && !isAuthorizedOperator(req, authConfig)) {
          send(res, 401, { ok: false, error: "unauthorized" }, corsOrigin);
          return;
        }
        const quarantine = store.listQuarantine();
        send(res, 200, { ok: true, count: quarantine.length, files: quarantine }, corsOrigin);
        return;
      }

      if (req.method === "GET" && url.pathname === "/metrics") {
        if (authConfig && !isAuthorizedOperator(req, authConfig)) {
          send(res, 401, { ok: false, error: "unauthorized" }, corsOrigin);
          return;
        }
        send(res, 200, formatPrometheusMetrics(metrics), corsOrigin, "text/plain; version=0.0.4; charset=utf-8");
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        send(
          res,
          200,
          {
            ok: true,
            verifierId,
            inboxDepth: store.inboxSize(),
            quarantineSize: store.quarantineSize(),
            lastPublishAt: metrics.lastPublishAt,
            totalTickFailures: metrics.totalTickFailures,
          },
          corsOrigin,
        );
        return;
      }

      send(res, 404, { ok: false, error: "not found" }, corsOrigin);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        send(res, 413, { ok: false, error: err.message, code: err.code }, corsOrigin);
        return;
      }
      console.error("[publisher] request error:", err);
      send(res, 500, { ok: false, error: "Internal server error", code: "INTERNAL_ERROR" }, corsOrigin);
    }
  });
}

export interface PublisherLoopOptions {
  verifierId: string;
  adapter: ChainAdapter;
  store: Store;
  metrics: PublisherMetrics;
  dataDir?: string;
  intervalMs: number;
  /** Optional abort signal to stop the loop (used by tests). */
  signal?: AbortSignal;
  onTick?: (result: Awaited<ReturnType<typeof runPublisherTick>>) => void;
  onError?: (err: unknown) => void;
}

/**
 * Runs `runPublisherTick` on a fixed interval, independent of the HTTP request path.
 * A failed tick is logged (and counted) but never thrown — the loop simply retries on the
 * next interval, which is the retry behavior required for background publication.
 */
export async function runPublisherLoop(opts: PublisherLoopOptions): Promise<void> {
  const { verifierId, adapter, store, metrics, dataDir, intervalMs, signal, onTick, onError } = opts;
  while (!signal?.aborted) {
    try {
      const result = await runPublisherTick({ verifierId, adapter, store, dataDir }, metrics);
      onTick?.(result);
    } catch (err) {
      metrics.totalTickFailures += 1;
      onError?.(err);
    }
    if (signal?.aborted) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
