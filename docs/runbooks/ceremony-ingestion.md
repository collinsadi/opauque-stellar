# Trusted Setup Ceremony Runbook

This runbook documents the steps for ingesting ceremony outputs into the Opaque codebase after a Groth16 trusted setup ceremony.

## Prerequisites

1. Ceremony outputs are available locally:
   - Final zkey (e.g., `stealth_reputation_final.zkey`)
   - Witness WASM (e.g., `stealth_reputation.wasm`)
   - Verification key JSON (e.g., `verification_key.json`)

2. Git identity configured:
   ```bash
   git config user.name "trustosaretin"
   git config user.email "iwinosatrust@gmail.com"
   ```

3. Node.js 18+ installed.

## Ceremony Output Verification

### Step 1: Verify Ceremony Hashes

Before ingesting, verify the ceremony outputs match expected hashes:

```bash
node scripts/ingest-ceremony-artifacts.ts --circuit v2 --verify-only
```

This checks all existing artifacts in `artifacts/manifest.json` against the files on disk.

### Step 2: Dry Run Ingestion

Always start with a dry run to preview changes:

```bash
node scripts/ingest-ceremony-artifacts.ts \
  --circuit v2 \
  --zkey /path/to/stealth_reputation_final.zkey \
  --wasm /path/to/stealth_reputation.wasm \
  --vkey /path/to/verification_key.json \
  --dry-run
```

The dry run will:
- Compute SHA-256 hashes for all input files
- Print the hashes without copying files or updating the manifest
- Verify contract VK prefix exists in groth16-verifier

### Step 3: Execute Ingestion

When satisfied with the dry run, execute the ingestion:

```bash
node scripts/ingest-ceremony-artifacts.ts \
  --circuit v2 \
  --zkey /path/to/stealth_reputation_final.zkey \
  --wasm /path/to/stealth_reputation.wasm \
  --vkey /path/to/verification_key.json
```

This will:
1. Copy artifacts to their destination paths in `frontend/public/circuits/`
2. Update `artifacts/manifest.json` with new SHA-256 hashes
3. Bind the zkey hash to the contract VK entry
4. Verify VK and contract are in sync

### Step 4: Update Manifest Hashes

After ingestion, update all artifact hashes:

```bash
node scripts/update-artifact-manifest.ts --sync-deployments
```

### Step 5: Verify Manifest Integrity

```bash
node scripts/verify-artifact-manifest.ts --strict
```

## Contract VK Sync

After ceremony ingestion, verify the groth16-verifier contract has the correct VK prefix:

- V1 circuits: `VK_ALPHA`, `VK_BETA`, `VK_GAMMA`, `VK_DELTA`, `VK_IC`
- V2 circuits: `VK_ALPHA_V2`, `VK_BETA_V2`, `VK_GAMMA_V2`, `VK_DELTA_V2`, `VK_IC_V2`
- V3 circuits: `VK_ALPHA_V3`, `VK_BETA_V3`, `VK_GAMMA_V3`, `VK_DELTA_V3`, `VK_IC_V3`

If the prefix doesn't match, manually update `contracts/groth16-verifier/src/lib.rs` with the new VK values exported from the zkey.

## Post-Ingestion Smoke Tests

1. **Frontend build**:
   ```bash
   cd frontend && npm run build
   ```

2. **Circuit test**:
   ```bash
   cd circuits && npm run test:regression
   ```

3. **Manifest verification**:
   ```bash
   node scripts/verify-artifact-manifest.ts --strict
   ```

4. **Deployment verification** (if deploying):
   ```bash
   npx tsx scripts/verify-deployment-manifest.ts --network testnet --strict
   ```

## Troubleshooting

### Hash Mismatch

If hash verification fails:
1. Re-download the ceremony outputs from the trusted source
2. Verify the outputs with the ceremony coordinator
3. Re-run ingestion with the verified outputs

### Contract VK Prefix Not Found

If the VK prefix is not found in groth16-verifier:
1. Export VK from zkey: `snarkjs zkey export verificationkey <zkey> <output.json>`
2. Convert VK to contract constants using the snarkjs export commands
3. Manually update `contracts/groth16-verifier/src/lib.rs`

### Manifest Out of Sync

If manifests are out of sync:
```bash
node scripts/update-artifact-manifest.ts --sync-deployments
node scripts/verify-artifact-manifest.ts --strict
```

## Rollback

If ceremony ingestion causes issues, revert the changes:

```bash
git checkout -- artifacts/manifest.json
git checkout -- contracts/groth16-verifier/src/lib.rs
git checkout -- frontend/public/circuits/
```

Then re-run the ingestion with verified artifacts.
