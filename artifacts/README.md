# Artifact manifest

Canonical SHA-256 fingerprints for audited WASM and ZK circuit artifacts live in [`manifest.json`](manifest.json).

Production builds **do not commit** large circuit binaries under `frontend/public/circuits/`; they are fetched or copied locally and verified against this manifest before `vite build`.

## Source of truth

| Artifact | Built from | Consumed by |
|:---------|:-----------|:------------|
| Scanner WASM (`cryptography_bg.wasm`) | `scanner/` via `wasm-pack` | `frontend/public/pkg/` |
| V1 witness WASM + zkey | `circuits/stealth_attestation.circom` + trusted setup | `frontend/public/circuits/` |
| V2 witness WASM + zkey | `circuits/v2/stealth_reputation.circom` + trusted setup | `frontend/public/circuits/v2/` |
| Contract VK bytes | zkey → `snarkjs zkey export verificationkey` → `encode_vk.mjs` | `contracts/groth16-verifier/src/lib.rs` |

Circom compile outputs under `circuits/**/build/` remain gitignored. Pin release binaries via this manifest and GitHub release tag `v1-circuit-artifacts`.

## Local workflow

```bash
# Build scanner WASM + verify pinned scanner hashes
npm run build:scanner
npm run verify:artifacts -- --scanner --strict

# Fetch pinned circuit artifacts from GitHub release (when published)
npm run fetch:circuits

# After rebuilding circuits locally, refresh hashes + deployment manifests
npm run update:artifacts
```

Frontend `npm run build` runs `prepare:frontend` automatically (build scanner, fetch circuits, verify scanner hashes).

## Retrieval from GitHub releases

When release assets are published at tag `v1-circuit-artifacts`:

```bash
npm run fetch:circuits
# or override mirror:
CIRCUIT_ARTIFACTS_BASE_URL=https://example.com/assets npm run fetch:circuits
```

Expected files (see `manifest.json` → `releaseAssets.files`):

- `sa_final.zkey` → `frontend/public/circuits/sa_final.zkey`
- `stealth_attestation.wasm` → `frontend/public/circuits/stealth_attestation_js/stealth_attestation.wasm`
- `stealth_reputation_final.zkey` → `frontend/public/circuits/v2/stealth_reputation_final.zkey`
- `stealth_reputation.wasm` → `frontend/public/circuits/v2/stealth_reputation.wasm`

## Contract VK ↔ zkey binding

Each circuit entry records:

- `frontend.zkey.sha256` — audited proving key
- `contractVk.zkeyHash` — must equal the zkey hash embedded on-chain
- `contractVk.embeddedVkHash` — SHA-256 of VK byte constants in `groth16-verifier`

Verify binding:

```bash
node scripts/verify-artifact-manifest.mjs --vk-binding
```

After exporting a new verification key from zkey, update Rust constants with:

```bash
node contracts/groth16-verifier/scripts/encode_vk.mjs path/to/verification_key.json
npm run update:artifacts
```

## Regression tests

Deterministic fixtures live in `circuits/fixtures/`. Run:

```bash
npm run test:circuits
# compile + witness-only (CI light job, requires circom):
cd circuits && npm run test:regression -- --compile --witness-only
```

See [RELEASE_NOTES.md](../RELEASE_NOTES.md) for published hashes per release.
