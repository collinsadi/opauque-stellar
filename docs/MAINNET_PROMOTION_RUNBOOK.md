# Testnet → Mainnet Promotion Runbook

Step-by-step procedure for promoting an audited Opaque Stellar **v1** release from testnet validation to mainnet deployment. Another engineer should be able to execute this runbook without tribal knowledge.

**Related docs:**

- [deployments/README.md](../deployments/README.md) — manifest fields
- [REPRODUCIBLE_BUILDS.md](./REPRODUCIBLE_BUILDS.md) — build determinism
- [artifacts/README.md](../artifacts/README.md) — circuit / scanner artifact pins
- [FEATURE_FLAGS.md](./FEATURE_FLAGS.md) — mainnet frontend flags
- [RUNBOOK.md](./RUNBOOK.md) — post-launch monitoring and incident response

---

## 0. Roles, artifacts, and audit log

### Roles

| Role | Responsibility |
|------|----------------|
| **Release engineer** | Runs build, deploy, manifest updates |
| **Second engineer** | Independent verification of hashes and manifest |
| **Admin / multisig signers** | Contract admin transfer and upgrades |
| **On-call** | Post-launch monitoring |

### Required tools

| Tool | Verify version |
|------|----------------|
| Git | `git --version` |
| Rust (stable) | `rustc --version` |
| Stellar CLI | `stellar --version` |
| Node.js 20+ | `node --version` |
| wasm-pack | `wasm-pack --version` |
| jq | `jq --version` |
| curl | `curl --version` |

### Accounts (record in promotion log)

| Account | Purpose |
|---------|---------|
| `DEPLOYER` | Funds deploy + initialization txs (hot, rotated after handoff) |
| `MULTISIG_ADMIN` | Target admin for all governed contracts |
| `SMOKE_WALLET` | Freighter wallet for manual UI smoke tests |

### Promotion log (fill in as you go)

Copy this table into your release ticket or ops doc:

| Step | Timestamp (UTC) | Operator | Git commit | Tx hash / artifact | Pass? |
|------|-------------------|----------|------------|-------------------|-------|
| 1. Testnet sign-off | | | | | |
| 2. Build + verify | | | | | |
| 3. Ceremony artifacts | | | | | |
| 4. Mainnet deploy | | | | | |
| 5. Initialize | | | | | |
| 6. Admin transfer | | | | | |
| 7. Manifest update | | | | | |
| 8. Frontend build | | | | | |
| 9. Smoke tests | | | | | |
| 10. Monitoring live | | | | | |

---

## 1. Go / no-go and halt criteria

### Proceed only if ALL are true

- [ ] Testnet deployment is `deploymentStatus: "deployed"` with filled contract IDs in [`deployments/v1/testnet.json`](../deployments/v1/testnet.json)
- [ ] Testnet smoke tests passed within the last 7 days (Section 3)
- [ ] Release git tag exists (e.g. `v1.0.0`) and CI release workflow is green
- [ ] Ceremony artifact hashes match [`artifacts/manifest.json`](../artifacts/manifest.json)
- [ ] Multisig admin account funded and signers available
- [ ] Production RPC and Horizon URLs provisioned (not public defaults — see [`frontend/src/lib/chain.ts`](../frontend/src/lib/chain.ts))
- [ ] Mainnet feature flags reviewed ([FEATURE_FLAGS.md](./FEATURE_FLAGS.md))

### Halt immediately if

- WASM hash mismatch between build and manifest
- Circuit zkey hash ≠ on-chain Groth16 VK binding (`--vk-binding` fails)
- Any contract simulation reverts on initialization
- Deployer balance insufficient for remaining deploy steps
- Unexpected ledger / network passphrase mismatch

**Halt procedure:** Stop all deploy steps. Do **not** publish frontend. Document state in promotion log. See [Section 12 — Rollback and abort](#12-rollback-and-abort).

---

## 2. Testnet sign-off (pre-promotion gate)

Run on the **release commit** you intend to promote.

### 2.1 Checkout release

```bash
git fetch --tags
git checkout v1.0.0   # replace with release tag
git rev-parse HEAD
```

**Expected output:**

```
abc123def456789...   # 40-char commit SHA — record in promotion log
```

### 2.2 Install dependencies

```bash
npm ci
npm ci --prefix frontend
npm ci --prefix circuits
cargo fetch
```

**Expected output:** Commands exit `0` with no error lines.

### 2.3 Validate testnet manifest

```bash
npm run verify:deployment
node scripts/verify-deployment-manifest.mjs --network testnet --strict
```

**Expected output:**

```
OK: verified testnet manifest(s) (strict)
```

If testnet is not yet deployed, manifest validation passes in template mode but `--strict` with empty IDs will fail — complete testnet deploy first.

### 2.4 Testnet health check

```bash
./scripts/health-check.sh --network testnet
```

**Expected output:**

```
=== Opaque Stellar Health Check [testnet] ===

  [PASS] Soroban RPC is reachable
  [PASS] Horizon is reachable
  [PASS] Latest ledger is Ns old
  [PASS] Deployment manifest exists
  [PASS] WASM hash verification
  [PASS] Manifest schema validation

All health checks passed.
```

### 2.5 Testnet integration smoke (optional automated)

```bash
export FUNDER_SECRET=S...   # funded testnet account
cd frontend && npx tsx scripts/lifecycle-integration.ts
```

**Expected output:** Steps log `success: true` for register, stealth derivation, and scan paths. Record any `success: false` as a **halt**.

---

## 3. Build (reproducible artifacts)

All commands from repository root unless noted.

### 3.1 Build Soroban contracts

```bash
stellar contract build
```

**Expected output:** Ends with successful compilation; six WASM files under:

```
target/wasm32v1-none/release/stealth_registry.wasm
target/wasm32v1-none/release/stealth_announcer.wasm
target/wasm32v1-none/release/groth16_verifier.wasm
target/wasm32v1-none/release/reputation_verifier.wasm
target/wasm32v1-none/release/schema_registry.wasm
target/wasm32v1-none/release/attestation_engine_v2.wasm
```

Verify:

```bash
ls -1 target/wasm32v1-none/release/*.wasm | wc -l
```

**Expected output:**

```
6
```

### 3.2 Contract unit tests

```bash
cargo test --workspace
```

**Expected output:**

```
test result: ok. N passed; 0 failed
```

### 3.3 Build scanner WASM

```bash
npm run build:scanner
```

**Expected output:** Ends with wasm-pack success; files appear in `frontend/public/pkg/`.

### 3.4 Fetch and verify circuit artifacts

```bash
npm run fetch:circuits
npm run verify:artifacts -- --strict
node scripts/verify-artifact-manifest.mjs --vk-binding --strict
```

**Expected output:**

```
OK: scanner.cryptography_bg.wasm
OK: circuits.v1...
OK: circuits.v2...

OK: artifact manifest verified
```

VK binding verifies that the zkey hash embedded in `groth16-verifier` matches the audited proving key.

### 3.5 Update mainnet manifest WASM hashes (do not deploy yet)

```bash
node scripts/update-manifest-wasm-hashes.mjs --network mainnet
```

**Expected output (example — hashes will differ per build):**

```
stealthRegistry: a1b2c3...
stealthAnnouncer: d4e5f6...
groth16Verifier: ...
reputationVerifier: ...
schemaRegistry: ...
attestationEngineV2: ...
Updated deployments/v1/mainnet.json
```

### 3.6 Strict manifest + WASM check

```bash
node scripts/verify-deployment-manifest.mjs --network mainnet --check-wasm --strict
```

**Expected output:**

```
OK: verified mainnet manifest(s) (strict)
```

**Second engineer:** Re-run 3.1–3.6 independently and confirm identical WASM hashes.

### 3.7 Frontend production build (dry run)

```bash
cd frontend
npm ci
npm run lint
npx tsc -b --noEmit
VITE_STELLAR_NETWORK=testnet npm run build
```

**Expected output:** `dist/` created; no TypeScript or lint errors.

---

## 4. Ceremony artifact verification

This step proves the trusted setup artifacts match what is pinned in-repo.

### 4.1 Verify pinned hashes

```bash
node scripts/verify-artifact-manifest.mjs --circuits --strict
```

**Expected output:** Lines starting with `OK: circuits.v1...` and `OK: circuits.v2...`, ending with:

```
OK: artifact manifest verified
```

### 4.2 Verify zkey ↔ contract VK binding

```bash
node scripts/verify-artifact-manifest.mjs --vk-binding --strict
```

**Expected output:**

```
OK: artifact manifest verified
```

Failure here means the Groth16 verifier WASM must be rebuilt after re-exporting the verification key:

```bash
node contracts/groth16-verifier/scripts/encode_vk.mjs path/to/verification_key.json
stellar contract build
node scripts/update-manifest-wasm-hashes.mjs --network mainnet
```

### 4.3 Record ceremony evidence

Update [`RELEASE_NOTES.md`](../RELEASE_NOTES.md) table if hashes changed. Capture:

```bash
sha256sum frontend/public/circuits/v2/stealth_reputation_final.zkey
sha256sum frontend/public/circuits/v2/stealth_reputation.wasm
git rev-parse HEAD
```

Paste outputs into `deployments/v1/mainnet.json` → `verification.output` after Section 8.

---

## 5. Mainnet contract deploy

Configure Stellar CLI for mainnet:

```bash
export STELLAR_NETWORK=mainnet
export STELLAR_RPC_URL=https://your-production-rpc.example.com
export STELLAR_HORIZON_URL=https://your-production-horizon.example.com
stellar keys address DEPLOYER
```

**Expected output:** `G...` deployer address with sufficient XLM balance (recommend ≥ 50 XLM buffer).

### Deploy order

Deploy in dependency order. Record each contract ID in the promotion log.

| Order | Package | WASM path | Notes |
|-------|---------|-----------|-------|
| 1 | stealth-registry | `target/wasm32v1-none/release/stealth_registry.wasm` | No initialize |
| 2 | stealth-announcer | `.../stealth_announcer.wasm` | No initialize |
| 3 | groth16-verifier | `.../groth16_verifier.wasm` | VK embedded at build time |
| 4 | schema-registry | `.../schema_registry.wasm` | No initialize |
| 5 | attestation-engine-v2 | `.../attestation_engine_v2.wasm` | Initialize after schema-registry |
| 6 | reputation-verifier | `.../reputation_verifier.wasm` | Initialize after groth16-verifier |

### Deploy command (repeat per contract)

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/stealth_registry.wasm \
  --source-account DEPLOYER \
  --network mainnet
```

**Expected output:**

```
Contract deployed with id: CAQ...55CHARS
```

Record the `C...` contract ID and transaction hash for each deploy.

### Verify deploy ledger

```bash
curl -s "${STELLAR_HORIZON_URL}/transactions/{TX_HASH}" | jq '.successful, .ledger'
```

**Expected output:**

```
true
12345678
```

---

## 6. Contract initialization

Only these contracts require explicit initialization:

### 6.1 Attestation Engine V2

Requires deployed `schema-registry` ID.

```bash
stellar contract invoke \
  --id "${ATTESTATION_ENGINE_ID}" \
  --source-account DEPLOYER \
  --network mainnet \
  -- \
  initialize \
  --admin "${DEPLOYER}" \
  --governance "${DEPLOYER}" \
  --schema_registry "${SCHEMA_REGISTRY_ID}" \
  --version 1
```

**Expected output:** Transaction succeeds (`success: true` on Horizon). Double-init must revert — verify once only.

### 6.2 Reputation Verifier

Requires deployed `groth16-verifier` ID.

```bash
stellar contract invoke \
  --id "${REPUTATION_VERIFIER_ID}" \
  --source-account DEPLOYER \
  --network mainnet \
  -- \
  initialize \
  --admin "${DEPLOYER}" \
  --groth16_verifier "${GROTH16_VERIFIER_ID}"
```

**Expected output:** Transaction succeeds. Simulate read:

```bash
stellar contract invoke \
  --id "${REPUTATION_VERIFIER_ID}" \
  --network mainnet \
  --send=no \
  -- \
  get_config
```

**Expected output:** JSON config with `admin` and `groth16_verifier` fields matching deployed IDs.

### 6.3 Stealth registry smoke

Register a test meta-address from the smoke wallet (via UI or CLI) and confirm resolution works before announcing mainnet frontend.

---

## 7. Admin transfer to multisig

Use the in-app **Manage → Admin** panel or CLI. Target: `MULTISIG_ADMIN` with threshold ≥ 2.

Governed contracts (see [`AdminPanel.tsx`](../frontend/src/components/AdminPanel.tsx)):

- Reputation Verifier
- Groth16 Verifier
- Attestation Engine V2
- Schema Registry

### 7.1 Propose transfer (per contract, from current admin)

```bash
stellar contract invoke \
  --id "${CONTRACT_ID}" \
  --source-account DEPLOYER \
  --network mainnet \
  -- \
  transfer_admin \
  --new_admin "${MULTISIG_ADMIN}"
```

**Expected output:** Transaction succeeds. `get_pending_admin()` returns multisig address.

### 7.2 Accept transfer (from multisig)

Multisig signers build and co-sign the `accept_admin` transaction offline (see AdminPanel multisig guide), then submit.

**Expected output:** `get_admin()` returns `MULTISIG_ADMIN`; `get_pending_admin()` is empty.

### 7.3 Post-handoff

- [ ] Revoke or remove deployer key from multisig threshold paths
- [ ] Record final admin addresses in manifest `admin` and `multisig` fields
- [ ] Confirm no pending admin transfers remain

---

## 8. Update mainnet deployment manifest

Edit [`deployments/v1/mainnet.json`](../deployments/v1/mainnet.json):

```json
{
  "deploymentStatus": "deployed",
  "deploymentLedger": 12345678,
  "deployedAt": "2026-05-29T18:00:00Z",
  "deployer": "G...DEPLOYER",
  "admin": "G...MULTISIG_ADMIN",
  "multisig": "G...MULTISIG_ADMIN",
  "contracts": {
    "stealthRegistry": { "id": "CAQ...", "wasmHash": "..." },
    "...": "..."
  },
  "artifacts": {
    "frontend": { "buildCommit": "<git-sha-from-section-3>" }
  }
}
```

Refresh hashes if not already done:

```bash
node scripts/update-manifest-wasm-hashes.mjs --network mainnet
node scripts/verify-deployment-manifest.mjs --network mainnet --check-wasm --strict \
  | tee /tmp/mainnet-verify.txt
```

**Expected output:**

```
OK: verified mainnet manifest(s) (strict)
```

Paste `/tmp/mainnet-verify.txt` into `verification.output` in the manifest. Commit manifest changes:

```bash
git add deployments/v1/mainnet.json
git commit -m "Record mainnet v1 deployment manifest"
```

---

## 9. Frontend configuration and publish

### 9.1 Production environment

Create `frontend/.env.production` (or CI secrets) — **do not commit secrets**:

```env
VITE_STELLAR_NETWORK=mainnet
VITE_STELLAR_RPC_URL=https://your-production-rpc.example.com
VITE_STELLAR_HORIZON_URL=https://your-production-horizon.example.com

# Explicit mainnet feature flags — see docs/FEATURE_FLAGS.md
VITE_FEATURE_MANUAL_GHOST=false
VITE_FEATURE_REPUTATION_PROOFS=false
VITE_FEATURE_SCHEMA_MANAGEMENT=false
VITE_FEATURE_DEMO_VERIFIER_LINKS=false
VITE_FEATURE_DEBUG_LOGS=false
```

Contract IDs are read from `deployments/v1/mainnet.json` in production builds. Do not rely on dev-only `VITE_*_CONTRACT` overrides in production.

### 9.2 Verify env exports match manifest

```bash
eval "$(node scripts/export-manifest-env.mjs mainnet)"
node scripts/verify-deployment-manifest.mjs --network mainnet --strict
cd frontend && npm run verify:deployment
```

**Expected output:**

```
OK: verified mainnet manifest(s) (strict)
```

(Frontend verify script exits 0.)

### 9.3 Build and record bundle hash

```bash
cd frontend
npm ci
npm run build
find dist -type f | sort | xargs sha256sum | tee /tmp/frontend-dist.sha256
git rev-parse HEAD
```

**Expected output:** `dist/index.html` and assets listed with SHA-256 hashes. Record commit in manifest `artifacts.frontend.buildCommit`.

### 9.4 Publish

Deploy `frontend/dist/` to your CDN / static host. Record the public URL in the promotion log.

---

## 10. Smoke tests (mainnet)

Run immediately after frontend publish.

### 10.1 Automated health check

```bash
VITE_STELLAR_RPC_URL=https://your-production-rpc.example.com \
VITE_STELLAR_HORIZON_URL=https://your-production-horizon.example.com \
./scripts/health-check.sh --network mainnet
```

**Expected output:**

```
All health checks passed.
```

### 10.2 Manifest strict verification

```bash
node scripts/verify-deployment-manifest.mjs --network mainnet --check-wasm --strict
npm run verify:artifacts -- --strict
```

**Expected output:** Both exit `0` with `OK:` lines.

### 10.3 Manual wallet smoke checklist

Using `SMOKE_WALLET` with a **small** XLM amount:

| # | Flow | Pass? |
|---|------|-------|
| 1 | Connect Freighter on mainnet; sign domain-separated setup message | |
| 2 | Register stealth meta-address on registry | |
| 3 | Send XLM via payment link receive path (second wallet) | |
| 4 | Scanner detects funds on Private balance | |
| 5 | Withdraw to main Stellar address | |
| 6 | Explorer links resolve correctly | |

If reputation flags are enabled, additionally:

| # | Flow | Pass? |
|---|------|-------|
| 7 | Issue test attestation (schema authority wallet) | |
| 8 | Generate V2 proof in browser | |
| 9 | Submit proof on-chain | |

Any failure → [Section 12 — Rollback](#12-rollback-and-abort).

---

## 11. Monitoring (post-launch)

Enable monitoring before announcing the launch publicly.

### 11.1 Alert rules

Configure alerts per [RUNBOOK.md](./RUNBOOK.md):

| Alert | Threshold |
|-------|-----------|
| `root_expiry` | No scanner sync in 5 min |
| `rpc_failures` | >3 RPC failures / hour |
| `high_tx_failure_rate` | >20% contract call failures |
| `proof_verification_failures` | Any failure |

### 11.2 RPC health probe

```bash
curl -sf -X POST "${STELLAR_RPC_URL}" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | jq .
```

**Expected output:**

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "status": "healthy" } }
```

(Exact schema may vary by provider; non-error HTTP 200 is required.)

### 11.3 Ledger freshness

```bash
curl -s "${STELLAR_HORIZON_URL}/ledgers?order=desc&limit=1" \
  | jq '._embedded.records[0] | {sequence, closed_at}'
```

**Expected output:** `closed_at` within the last 60 seconds during normal network operation.

### 11.4 Wallet balance watch

Monitor XLM balance of admin / deployer / fee-payer accounts. Alert when below configured threshold.

---

## 12. Rollback and abort

### 12.1 Abort before frontend publish

If failure occurs during Sections 5–8:

1. **Halt** — do not publish frontend or update DNS.
2. Document deployed contract IDs (even partial) in the promotion log.
3. If contracts are uninitialized and hold no user funds, note them as **experimental** — Soroban contracts cannot be undeployed; abandoned IDs remain on-chain.
4. Fix the issue on testnet first, then restart from Section 2.

### 12.2 Frontend rollback

If smoke tests fail after publish:

1. Identify last known good `artifacts.frontend.buildCommit` from manifest history or git tag.
2. Rebuild:
   ```bash
   git checkout <LAST_GOOD_COMMIT>
   cd frontend && npm ci && npm run build
   ```
3. Redeploy `dist/` to CDN (overwrite previous release).
4. Verify health check passes against rolled-back bundle.

**Expected output:** Health check and manual smoke pass on rolled-back version.

### 12.3 Contract pause / freeze (if supported)

If attestation or proof paths misbehave but stealth payments work:

1. Multisig calls governance pause on `attestation-engine-v2` (see contract `pause_*` methods).
2. Disable affected feature flags in frontend rebuild (`VITE_FEATURE_REPUTATION_PROOFS=false`, etc.).
3. Publish hotfix frontend.

### 12.4 Contract upgrade rollback

Upgrades are forward-only on Soroban. Rollback strategy:

1. Deploy **previous** WASM to a **new** contract ID (if upgrade path unavailable).
2. Update manifest with new IDs.
3. Publish frontend pointing to previous contract set.
4. Multisig deprecates faulty contracts via admin controls where available.

See [RUNBOOK.md — Contract Upgrade](./RUNBOOK.md#contract-upgrade).

### 12.5 Emergency halt checklist

| Action | Command / location |
|--------|-------------------|
| Stop CDN deploy pipeline | Cancel CI / hold DNS |
| Disable risky features | Rebuild with flags `false` ([FEATURE_FLAGS.md](./FEATURE_FLAGS.md)) |
| Pause attestations | Multisig → `attestation-engine-v2` pause |
| Page on-call | See [RUNBOOK.md — Owner & Escalation](./RUNBOOK.md#owner--escalation) |
| Public comms | Status page + Discord #announcements (48h notice for planned maintenance) |

---

## 13. Quick reference — verification commands

| Purpose | Command | Expected |
|---------|---------|----------|
| Manifest schema | `npm run verify:deployment` | Exit 0 |
| Manifest strict | `node scripts/verify-deployment-manifest.mjs --network mainnet --strict` | `OK: verified mainnet...` |
| WASM hashes | `... --check-wasm --strict` | Exit 0, no mismatch lines |
| Artifacts | `npm run verify:artifacts -- --strict` | Exit 0 |
| VK binding | `node scripts/verify-artifact-manifest.mjs --vk-binding --strict` | `OK: artifact manifest verified` |
| Health | `./scripts/health-check.sh --network mainnet` | `All health checks passed.` |
| Export env | `eval "$(node scripts/export-manifest-env.mjs mainnet)"` | Shell exports, exit 0 |

---

## 14. Post-promotion

- [ ] Update [RELEASE_NOTES.md](../RELEASE_NOTES.md) with mainnet status `deployed`
- [ ] Tag manifest commit if not already tagged
- [ ] Archive promotion log + verification outputs in release ticket
- [ ] Schedule 48h post-launch review (metrics, error rates, user reports)
- [ ] Rotate deployer key credentials
