# Deployment manifests

Canonical Soroban deployment records for Opaque Stellar. The frontend reads **only** these manifests (via `deployedAddresses.ts`); legacy `deployed-addresses.json` / Solana-style configs are removed.

## Layout

| File | Purpose |
|------|---------|
| `manifest.schema.json` | JSON Schema for v1 manifests |
| `types.ts` | Shared TypeScript types and helpers |
| `v1/testnet.json` | Testnet deployment record |
| `v1/mainnet.json` | Mainnet v1 deployment record |

## Manifest fields

Each network manifest records:

- **Network**: `network`, `networkPassphrase`, optional `rpcUrl` / `horizonUrl`
- **On-chain**: `contracts.*.id`, `deploymentLedger`, `deployedAt`
- **Artifacts**: `contracts.*.wasmHash` (SHA-256 hex of built WASM)
- **Scanner / circuits**: `artifacts.scanner.wasmHash`, `artifacts.circuits.v1|v2.*` (witness WASM, zkey, contract VK hashes)
- **Governance**: `deployer`, `admin`, `multisig`
- **Reproducibility**: `verification.command` / `verification.output`, `artifacts.frontend.buildCommit`, `artifacts.circuits.v2.*` hashes

## Updating after deploy

1. Build contracts: `stellar contract build`
2. Deploy to the target network and note contract IDs + ledger sequence.
3. Refresh WASM hashes: `node scripts/update-manifest-wasm-hashes.mjs --network testnet`
4. Edit `deployments/v1/<network>.json` with contract IDs, ledger, deployer, admin, and set `deploymentStatus` to `deployed`.
5. Record verification output: `node scripts/verify-deployment-manifest.mjs --network testnet > /tmp/verify.txt` and paste into `verification.output`.
6. Set `artifacts.frontend.buildCommit` to the git SHA used for the release frontend build.
7. Verify: `node scripts/verify-deployment-manifest.mjs --network testnet --strict`

## Frontend / CI

- Local dev may override manifest IDs with `VITE_<NETWORK>_*` env vars (non-production only).
- Production builds require manifest IDs or matching env overrides; CI runs `verify-deployment-manifest.mjs` to ensure env and manifest agree.
- See [RELEASE_NOTES.md](../RELEASE_NOTES.md) for release links.
