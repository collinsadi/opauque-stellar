# Container image for the relayer service (#770).
#
# Two entrypoints share this image: the relayer operator (scripts/relayer.ts,
# default — self-hosts a gossip hub when RELAYER_HUB_URL is unset, matching
# the single-operator topology in docs/running-relayer.md) and the standalone
# gossip hub/gateway (scripts/hub.ts, override the command — used only for a
# multi-operator topology where the hub runs separately from any relayer).
# This service holds RELAYER_OPERATOR_SECRET and RELAYER_X25519_SECRET — see
# docs/secrets-management.md.
#
# BUILD CONTEXT: the repo root, same reason as asp/ and publisher/ — resolves
# ../deployments/v1/testnet.json relative to itself.
#   docker build -f relayer/Dockerfile -t opaque-relayer .
#
# Base image pinned by digest, same node:20-slim build used across all three
# service images (Node 20.20.2, Debian bookworm, as of 2026-08-25).
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS build

WORKDIR /app
COPY sdk/package.json sdk/package-lock.json ./sdk/
RUN npm ci --prefix sdk --no-audit --no-fund
COPY relayer/package.json relayer/package-lock.json ./relayer/
RUN npm ci --prefix relayer --no-audit --no-fund
COPY relayer/tsconfig.json ./relayer/
COPY relayer/src ./relayer/src
COPY relayer/scripts ./relayer/scripts
COPY sdk/src ./sdk/src
WORKDIR /app/relayer
RUN npx tsc --noEmit

FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 10001 opaque \
    && useradd --system --uid 10001 --gid opaque --home-dir /app --shell /usr/sbin/nologin opaque
WORKDIR /app
COPY --from=build /app/sdk/node_modules/tweetnacl ./sdk/node_modules/tweetnacl
COPY sdk/src ./sdk/src
COPY relayer/package.json relayer/package-lock.json ./relayer/
WORKDIR /app/relayer
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm install --no-save --no-audit --no-fund tsx@^4.19.4 \
    && npm cache clean --force
COPY relayer/src ./src
COPY relayer/scripts ./scripts
COPY --from=build /app/relayer/tsconfig.json ./tsconfig.json
COPY deployments /app/deployments

RUN mkdir -p /app/.opaque-relayer && chown -R opaque:opaque /app
USER opaque

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${RELAYER_PORT:-8787}/health" || exit 1

# Default to the relayer operator (self-hosted hub). Override the command
# (e.g. `["npx", "tsx", "scripts/hub.ts"]`) to run a standalone gossip hub —
# see docker-compose.yml.
ENTRYPOINT ["npx", "tsx"]
CMD ["scripts/relayer.ts"]
