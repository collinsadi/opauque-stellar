# Reproducible Contract Builds

This document describes how Opaque ensures deployed contracts are reproducible and verifiable from source code. It covers the build process, hash verification, and release procedures.

## Overview

Reproducible builds allow anyone to rebuild contracts from source and verify the WASM hash matches the deployed version. This prevents supply chain attacks and provides cryptographic proof of what code is running on-chain.

## Build Determinism

### Prerequisites

All contributors must use the same toolchain versions to ensure identical builds:

- **Rust**: Stable (version pinned in `rust-toolchain.toml`)
- **Soroban SDK**: Version pinned in `Cargo.lock`
- **wasm-pack**: Version specified in CI (for scanner builds)
- **Cargo build flags**: Identical across all builds

### Build Command

#### Contracts

```bash
stellar contract build
```

This command:
1. Validates all Cargo manifests
2. Compiles Rust code to WASM
3. Produces deterministic bytecode in `target/wasm32-unknown-unknown/release/`

#### Scanner WASM

```bash
wasm-pack build --target web --out-dir ../frontend/public/pkg
```

#### Circuits

```bash
circom circuits/v2/stealth_reputation.circom --r1cs
circom circuits/v2/stealth_reputation.circom --sym --wasm
```

### Lockfile Requirement

Dependency versions are locked in:
- `Cargo.lock` - Rust dependencies
- `package-lock.json` - Node dependencies (scanner, circuits, frontend)

Lockfiles are checked into git and required for builds. Never run `cargo update` or `npm update` without explicit approval.

## Hash Verification

### Computing Hashes

After building, compute SHA-256 hashes:

```bash
# Rust contracts
sha256sum target/wasm32-unknown-unknown/release/*.wasm

# Scanner WASM
sha256sum frontend/public/pkg/cryptography_bg.wasm
sha256sum frontend/public/pkg/cryptography.js

# Circuits (after build)
sha256sum circuits/build/stealth_attestation.r1cs
sha256sum circuits/build/stealth_reputation.wasm
sha256sum circuits/build/verification_key.json
```

### Storing Hashes

Hashes are stored in deployment manifests:

**File**: `deployments/v1/{network}.json`

```json
{
  "contracts": {
    "reputation-verifier": {
      "id": "CAQ...",
      "wasmHash": "abc123...def456"
    }
  },
  "artifacts": {
    "scanner": {
      "wasmHash": "def456...ghi789"
    }
  }
}
```

### Verification Script

Use the provided verification script to check builds:

```bash
# Verify testnet manifest
node scripts/verify-deployment-manifest.mjs --network testnet --check-wasm

# Strict verification (fail on any mismatches)
node scripts/verify-deployment-manifest.mjs --network testnet --strict
```

The script:
1. Reads expected hashes from manifest
2. Computes hashes of built artifacts
3. Compares them
4. Reports any discrepancies

## Release Process

### Pre-Release Checklist

Before creating a release, verify all hashes:

```bash
# 1. Ensure working directory is clean
git status

# 2. Fetch latest dependencies
cargo fetch --depth 1
npm ci

# 3. Rebuild everything
stellar contract build
node scripts/build-scanner-wasm.mjs
npm run build:circuits --prefix circuits

# 4. Verify hashes match manifest
node scripts/verify-deployment-manifest.mjs --network mainnet --strict

# 5. Run full test suite
cargo test
npm run test --prefix circuits
npm run test --prefix frontend

# 6. Check for warnings or issues
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

### Hash Documentation

1. **Compute hashes** of all built artifacts
2. **Update manifest** with new hashes
3. **Document build command** in manifest:
   ```json
   {
     "verification": {
       "command": "stellar contract build && node scripts/update-manifest-wasm-hashes.mjs --network mainnet",
       "timestamp": "2025-06-02T15:30:00Z",
       "buildCommit": "abc123def456..."
     }
   }
   ```
4. **Record verification output**:
   ```bash
   node scripts/verify-deployment-manifest.mjs --network mainnet > /tmp/verify.txt
   ```
   Paste the output into manifest `verification.output` field

### Mainnet Deployment Hash Verification

For mainnet deployments, the following documentation is required:

1. **Build Source Commit**
   - Git commit hash used for the release build
   - Stored in `artifacts.frontend.buildCommit`
   - Allows anyone to checkout exact source and rebuild

2. **WASM Hash Per Contract**
   - SHA-256 hash of each deployed contract's WASM
   - Stored in `contracts.{name}.wasmHash`
   - Can be verified on-chain via contract introspection

3. **Build Environment**
   - Rust version (pinned in `rust-toolchain.toml`)
   - Soroban SDK version (from `Cargo.lock`)
   - Build platform (Linux/macOS x86-64)

4. **Verification Command**
   - Exact command to rebuild and verify
   - Stored in `verification.command`
   - Example: `stellar contract build && node scripts/verify-deployment-manifest.mjs --network mainnet --check-wasm`

5. **Verification Output**
   - Complete output of `verify-deployment-manifest.mjs --strict`
   - Confirms all hashes match
   - Stored in `verification.output`

### Automated Verification in CI

The CI pipeline automatically verifies builds:

```yaml
- name: Verify contract WASM hashes
  if: success()
  run: node scripts/verify-deployment-manifest.mjs --network testnet --check-wasm
```

This runs on every PR and push to catch hash mismatches early.

## Rollback and History

### Maintaining Build History

Each deployment maintains historical records:

```json
{
  "deploymentHistory": [
    {
      "deployment": 1,
      "timestamp": "2025-05-01T10:00:00Z",
      "contracts": {
        "reputation-verifier": {
          "wasmHash": "abc123..."
        }
      }
    },
    {
      "deployment": 2,
      "timestamp": "2025-06-02T15:30:00Z",
      "contracts": {
        "reputation-verifier": {
          "wasmHash": "def456..."
        }
      }
    }
  ]
}
```

### Verifying Historical Deployments

To verify a past deployment:

```bash
git checkout <deployment-commit>
stellar contract build
sha256sum target/wasm32-unknown-unknown/release/*.wasm
# Compare with deployment record
```

## Handling Build Non-Determinism

If builds produce different hashes for the same source:

1. **Check Rust version**
   ```bash
   rustc --version  # Should match rust-toolchain.toml
   rustup update
   ```

2. **Clear build cache**
   ```bash
   cargo clean
   rm -rf target/
   ```

3. **Verify lockfiles are current**
   ```bash
   cargo fetch
   npm ci
   ```

4. **Rebuild and compare hashes**
   ```bash
   stellar contract build
   sha256sum target/wasm32-unknown-unknown/release/*.wasm
   ```

5. **Document in issue** if problem persists

## External Verification

Anyone can independently verify deployed contracts:

```bash
# 1. Clone the repository
git clone https://github.com/collinsadi/opauque-stellar.git
cd opauque-stellar

# 2. Checkout release tag
git checkout v1.0.0

# 3. Rebuild contracts
stellar contract build

# 4. Compare hashes
sha256sum target/wasm32-unknown-unknown/release/*.wasm
# Compare output with deployments/v1/mainnet.json

# 5. Automated verification
node scripts/verify-deployment-manifest.mjs --network mainnet --check-wasm
```

## Tools and Scripts

### Scripts Available

| Script | Purpose |
|--------|---------|
| `scripts/update-manifest-wasm-hashes.mjs` | Update manifest with new WASM hashes after building |
| `scripts/verify-deployment-manifest.mjs` | Verify manifest hashes match built artifacts |
| `scripts/verify-artifact-manifest.mjs` | Verify scanner and circuit artifact hashes |

### Usage Examples

```bash
# Update hashes after rebuilding
node scripts/update-manifest-wasm-hashes.mjs --network testnet

# Verify testnet manifest
node scripts/verify-deployment-manifest.mjs --network testnet

# Strict verification (fail on mismatch)
node scripts/verify-deployment-manifest.mjs --network testnet --strict

# Verify with WASM hash check
node scripts/verify-deployment-manifest.mjs --network testnet --check-wasm
```

## Troubleshooting

### Hashes Don't Match

1. Verify Rust version matches `rust-toolchain.toml`
2. Ensure `Cargo.lock` is not modified
3. Check for uncommitted changes: `git status`
4. Clean build cache: `cargo clean`
5. Rebuild: `stellar contract build`

### Script Errors

```bash
# If verify-deployment-manifest.mjs fails:
node scripts/verify-deployment-manifest.mjs --network testnet --strict

# Check manifest syntax:
jq . deployments/v1/testnet.json

# Validate against schema:
npx ajv validate -s deployments/manifest.schema.json -d deployments/v1/testnet.json
```

## References

- [Soroban Build Documentation](https://developers.stellar.org/learn/fundamentals-and-concepts/stellar-ecosystem/state-expiration)
- [Reproducible Builds Initiative](https://reproducible-builds.org/)
- Deployment manifests: `deployments/v1/`
- Artifact hashes: `artifacts/manifest.json`
