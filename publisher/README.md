# @opaquecash/reputation-publisher

The reputation publisher is the off-chain service that keeps the PSR
`reputation-verifier` usable. It accepts holder-submitted V2 leaf commitments, builds the
deterministic Poseidon Merkle tree, and publishes the latest root to Soroban with
`update_merkle_root`.

The browser cannot complete `Submit On-Chain` until the proof's Merkle root is present in
the verifier contract. This service is the missing liveness piece.

## Why This Exists

The V2 reputation circuit proves inclusion of a leaf:

```text
Poseidon(stealth_pk, schema_id, issuer_pk_x, trait_data_hash, nonce)
```

Two of those values, `stealth_pk` and `trait_data_hash`, are private holder-side data.
A passive indexer that only listens to public attestation announcements cannot derive the
leaf. That is intentional: otherwise reputation leaves could be enumerated.

So the publisher's input is not "all public attestations." Its input is the set of leaf
commitments that holders or wallet clients choose to submit:

```text
holder wallet -> computes leaf locally -> submits leaf commitment -> publisher -> root
```

The publisher never receives the stealth private key, decoded trait data, or proof witness.

## How It Works Now

This workspace ships a file-backed MVP:

1. Holder/client writes leaf JSON into `publisher/data/inbox/`.
2. The publisher loop reads the inbox and normalizes each 32-byte leaf commitment.
3. It deduplicates by id and leaf.
4. It rebuilds a depth-20 Poseidon(2) Merkle tree from the ordered leaf set.
5. It compares the local root with `reputation-verifier.get_latest_root`.
6. If the root differs, it writes a root manifest under `publisher/data/roots/` and sends
   `update_merkle_root(admin, root, dataset_hash)`.
7. Accepted inbox files are archived and durable state is written under
   `publisher/data/state/`.

The current testnet contract allows only the verifier admin to publish roots, so the MVP
uses `PUBLISHER_SECRET` with the admin/deployer key. This is acceptable for testnet and
local demos only.

## Production Shape

In production, this should become a dedicated root-publisher service:

- Replace the file inbox with an authenticated HTTPS endpoint or queue.
- Add a dedicated `root_publisher` role in the contract instead of using the admin key.
- Store commitments and cursors in Postgres or another durable database.
- Backfill from a durable event/source log on restart.
- Publish before the current root expiry window elapses, even if no new leaves arrived.
- Expose an API for wallets to fetch the current root and Merkle path for their leaf.
- Monitor ingestion lag, publish failures, root age, and signer balance.
- Run the signer with minimal privileges and key isolation.

The production service can still listen to public attestation announcements, but those
events are only context for validation and observability. They are not enough to build the
private V2 leaf.

## Install

```bash
cd publisher
npm ci
```

## Configure

Create an environment file outside git:

```bash
nano ~/.opaque-reputation-publisher.env
chmod 600 ~/.opaque-reputation-publisher.env
```

Example:

```bash
PUBLISHER_SECRET=S...current_testnet_admin_secret...
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
PUBLISHER_INTERVAL_MS=15000
PUBLISHER_HTTP_HOST=127.0.0.1
PUBLISHER_HTTP_PORT=8790
PUBLISHER_CORS_ORIGIN=http://localhost:5173
PUBLISHER_DATA_DIR=/var/lib/opaque-reputation-publisher
PUBLISHER_SUBMIT_TOKENS=<random-token-per-holder-or-service>
PUBLISHER_OPERATOR_TOKENS=<random-token-per-operator>
PUBLISHER_TRUSTED_PROXIES=127.0.0.1
```

Variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PUBLISHER_SECRET` | required | Signer allowed to call `update_merkle_root`. On current testnet this is the verifier admin. |
| `DEPLOYER_SECRET` | fallback | Accepted only as a local/testnet convenience when `PUBLISHER_SECRET` is unset. |
| `REPUTATION_VERIFIER_ID` | manifest value | Override verifier contract id. |
| `ATTESTATION_ENGINE_V2_ID` | manifest value | Override attestation-engine-v2 contract id used to validate and prune submissions. |
| `STELLAR_RPC_URL` | manifest RPC | Soroban RPC endpoint. |
| `PUBLISHER_INTERVAL_MS` | `15000` | Loop interval for continuous publishing. |
| `PUBLISHER_HTTP_HOST` | `127.0.0.1` | HTTP API bind host. |
| `PUBLISHER_HTTP_PORT` | `8790` | HTTP API port. |
| `PUBLISHER_CORS_ORIGIN` | none (cross-origin disabled) | Browser origin allowed to submit leaves/fetch paths. Must be set explicitly; there is no wildcard default. |
| `PUBLISHER_DATA_DIR` | `publisher/data` | Durable inbox/state/root manifest directory. |
| `PUBLISHER_MAX_INBOX` | `10000` | Maximum inbox queue size before backpressure is applied. |
| `PUBLISHER_MAX_BODY_BYTES` | `32768` | Streaming request-body size cap for `POST /v1/reputation/leaves`; oversized bodies are aborted mid-stream with `413 PAYLOAD_TOO_LARGE`. |
| `PUBLISHER_SUBMIT_TOKENS` | none (submission disabled) | Comma-separated bearer tokens allowed to `POST /v1/reputation/leaves`. Generate with e.g. `openssl rand -hex 32` and hand out per holder/service. |
| `PUBLISHER_OPERATOR_TOKENS` | none (reads disabled) | Comma-separated bearer tokens allowed to read `GET /v1/reputation/quarantine` and `GET /metrics`. |
| `PUBLISHER_TRUSTED_PROXIES` | none | Comma-separated socket addresses of reverse proxies allowed to set `X-Forwarded-For`. Without it, rate limiting always uses the raw socket address. |

## Run The HTTP API

This is the mode the frontend uses for Option 2. `POST /v1/reputation/leaves`
queues a holder-computed leaf into the durable inbox and acknowledges immediately (202).
Publication — the on-chain `update_merkle_root` Soroban round trip — runs on a background
tick loop (`PUBLISHER_INTERVAL_MS`) independent of the request, with retry on the next
interval if a tick fails. Submitters confirm inclusion once the background loop
publishes, via `GET /v1/reputation/root/:leaf` or `/v1/reputation/snapshot/:verifierId`.

```bash
cd publisher
set -a
source ~/.opaque-reputation-publisher.env
set +a
npm run serve
```

Endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/reputation/leaves` | Queue a holder-submitted V2 leaf commitment into the inbox. Returns `202` with an acknowledgement (not the publish result); returns `429` when the inbox is full, `413` when the body exceeds `PUBLISHER_MAX_BODY_BYTES`. |
| `GET` | `/v1/reputation/root/:leaf` | Return current root, leaf index, and Merkle path for a leaf (reflects the latest background-published root). |
| `GET` | `/v1/reputation/snapshot/:verifierId` | Export an auditable tree snapshot with leaves and intermediate hashes. |
| `GET` | `/metrics` | Prometheus exposition format metrics (inbox depth, latency, publication counters). |
| `GET` | `/health` | Health check with verifier id, inbox depth, and last publish time. |

Submit body (the holder signature is recoverable secp256k1 over the domain-separated UID, schema, and leaf):

```json
{
  "id": "attestation-uid-or-client-generated-id",
  "leaf": "0x...",
  "schemaId": "0x...",
  "attestationUid": "0x...",
  "holderSignature": "0x...",
  "txHash": "...",
  "ledger": 3123456
}
```

Root response:

```json
{
  "verifierId": "C...",
  "leaf": "0x...",
  "leafIndex": 0,
  "leafCount": 1,
  "root": "0x...",
  "datasetHash": "0x...",
  "pathElements": ["0x..."],
  "pathIndices": [0]
}
```

## Submit A Leaf Locally

For local/demo use, write a leaf into the inbox:

```bash
cd publisher
npm run submit:leaf -- \
  --id demo-leaf-1 \
  --leaf 0x0000000000000000000000000000000000000000000000000000000000000001
```

The holder signs `OPAQUE_REPUTATION_SUBMISSION_V1\n<attestationUid>\n<schemaId>\n<leaf>` with the
private key for the attested stealth address. The publisher verifies that signature against
the on-chain recipient hash and checks schema, revocation, and expiration before queueing and
again immediately before publication. Revoked and expired leaves are removed on the next
publisher tick; removal compacts the tree, so surviving holders must fetch fresh inclusion paths.

## Run One Tick

```bash
cd publisher
set -a
source ~/.opaque-reputation-publisher.env
set +a
npm run publisher:once
```

Healthy output:

```text
leaves=1 (+1) root=0x1234abcd... PUBLISHED <txHash>
```

If the on-chain root already matches:

```text
leaves=1 (+0) root=0x1234abcd... in-sync
```

## Run Continuously

The loop mode is useful when another process writes inbox files. The wallet flow usually
uses `npm run serve` instead.

```bash
cd publisher
set -a
source ~/.opaque-reputation-publisher.env
set +a
npm run publisher
```

## systemd Example

```ini
[Unit]
Description=Opaque reputation root publisher
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=opaque
WorkingDirectory=/srv/opaque/stellar/publisher
EnvironmentFile=/home/opaque/.opaque-reputation-publisher.env
ExecStart=/usr/bin/npm run publisher
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

## Data Files

```text
publisher/data/inbox/*.json             pending holder-submitted leaves
publisher/data/archive/*.json           accepted inbox files
publisher/data/state/<verifier>.json    durable leaf set and last published root
publisher/data/roots/<verifier>/*.json  published root manifests
```

Inbox item shape:

```json
{
  "id": "attestation-uid-or-client-generated-id",
  "leaf": "0x...",
  "schemaId": "0x...",
  "attestationUid": "0x...",
  "txHash": "...",
  "ledger": 3123456
}
```

Only `id` and `leaf` are required.

## Backpressure

When the inbox exceeds `PUBLISHER_MAX_INBOX` (default 10,000), new submissions receive an
HTTP 429 response with a `retryAfterSeconds` hint. This prevents unbounded memory growth
under submission floods while allowing the publisher to catch up.

```json
{
  "ok": false,
  "error": "inbox full",
  "retryAfterSeconds": 30,
  "inboxDepth": 10000
}
```

Processing latency for accepted items stays within target under flood tests because
backpressure limits the work-per-tick. Flood events are visible in the `/metrics` endpoint
via `publisher_total_rejected`.

## Snapshot Export

Export an auditable tree snapshot that contains the leaves and intermediate hashes needed
to independently reproduce a published root:

```bash
curl http://localhost:8790/v1/reputation/snapshot/<verifierId>
```

Response includes the full `SnapshotExport` object with:
- `version`: schema version (currently 1)
- `root`: the Merkle root
- `leaves`: all leaf values in order
- `intermediateHashes`: all intermediate tree nodes keyed by `level:index`
- `snapshotHash`: SHA-256 binding of root + leaves

A third-party verifier can reconstruct the tree from the snapshot and confirm it matches
the published root without accessing the full pipeline.

## Metrics (Prometheus)

Scrape `GET /metrics` for operational observability:

```text
publisher_total_submitted 42
publisher_total_accepted 40
publisher_total_rejected 2
publisher_total_published 5
publisher_inbox_depth 12
publisher_leaf_count 150
publisher_last_publish_latency_ms 340
publisher_uptime_seconds 3600.0
```

No metric exposes leaf contents or submitter identity.

## Security Notes

- Do not run the daemon with the admin key in production.
- Add a dedicated root-publisher role before mainnet usage.
- Treat the signer as a hot key and isolate it from web request handling.
- Rate-limit and authenticate holder leaf submissions.
- Keep the append-only commitment log so roots can be reconstructed and audited.
- A malicious publisher can censor leaves or publish stale roots, but it cannot forge a
  holder's Groth16 proof or bypass nullifier replay protection in the verifier.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `set PUBLISHER_SECRET` | Missing signer secret. | Export `PUBLISHER_SECRET` in the environment file. |
| Frontend says no root | No leaves have been accepted or publish transaction failed. | Add a leaf and run `npm run publisher:once`; check signer funding. |
| Frontend says root mismatch | The proof was generated against a leaf/root not in the published tree. | Submit the exact leaf commitment used by the proof, publish, then regenerate/fetch the path. |
| `Unauthorized` from Soroban | Signer is not verifier admin on current contract. | Use the current admin for testnet, or deploy a contract with a root-publisher role. |
| Repeated publishing | On-chain root read is failing or another publisher is racing. | Check RPC health and ensure only one active publisher per verifier. |
