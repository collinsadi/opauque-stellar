# Release notes

## v1 (in progress)

Mainnet v1 deployment evidence is recorded in versioned manifests under `deployments/v1/`.

| Network | Manifest | Status |
|---------|----------|--------|
| Testnet | [deployments/v1/testnet.json](deployments/v1/testnet.json) | Template — contract IDs filled after deploy |
| Mainnet | [deployments/v1/mainnet.json](deployments/v1/mainnet.json) | Not deployed |

### What each manifest records

- Soroban contract IDs and per-contract WASM SHA-256 hashes
- Stellar network passphrase, deployment ledger, and timestamps
- Deployer, admin, and multisig accounts (when applicable)
- `verification.command` and captured `verification.output` for reproducible checks
- Frontend build git commit (`artifacts.frontend.buildCommit`)
- Scanner WASM hash (`artifacts.scanner.wasmHash`)
- Circom artifact hashes for V1 and V2 (`artifacts.circuits.v1|v2`)

### Expected artifact hashes (audit reference)

Canonical values are pinned in [`artifacts/manifest.json`](artifacts/manifest.json). Current v1 pins:

| Artifact | SHA-256 |
|:---------|:--------|
| Scanner `cryptography_bg.wasm` | `2bbc00491df10a5bdbd53457274903188b40eadb259de5edae8f2994490932c2` |
| V1 witness WASM | `48308a1097217d50bebe859d1cdab52da51dcc8ba2aa959eb7198f9a734d8913` |
| V1 zkey (`sa_final.zkey`) | `4fc1d57377b43435853a70dcca374dc9f878e49a410adf53b479ed5edee78a42` |
| V1 contract embedded VK | `db96564b4e1668bbd8455f4d0f4ecb5544b8358e19449380e44307b78b70b4d7` |
| V2 witness WASM | `0fdc435cc602b4ab0c2e5fa41533901f876a158657f41183022d93eb76297a05` |
| V2 zkey | `5a4545c179818742dbbd8efd73f9dbfd8b8f0427145c07c1bf37fff44a350897` |
| V2 verification key JSON | `24d0fe6a5ef1174ab616a5d39df846442af7a7818962b0ed346586bb1eb74b47` |
| V2 contract embedded VK | `8cd3043dcd8b97b11828cda7fbdf8e919c7d727fe05e7f62a20110bcb2dcfce6` |

V2 `contractVkHash` is derived from `groth16-verifier` byte constants; `zkeyHashBinding` must match the zkey used to export the verification key encoded into the contract.

### Verifying a release

```bash
npm run verify:deployment
npm run verify:artifacts -- --strict
# After contracts are built:
node scripts/verify-deployment-manifest.mjs --network testnet --check-wasm --strict
node scripts/verify-artifact-manifest.mjs --vk-binding
```

CI runs manifest validation, builds scanner WASM with hash verification, and runs circuit regression tests on every push.

### Updating after deploy

See [deployments/README.md](deployments/README.md) and [artifacts/README.md](artifacts/README.md).
