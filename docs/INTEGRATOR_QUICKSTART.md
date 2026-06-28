# Integrator Quickstart

This guide covers the essential APIs and workflows for reading contract state and verifying proofs on Opaque Stellar.

---

## Manifest & deployment addresses

Contract IDs are published per network in `deployments/v1/<network>.json`. The frontend reads these at build time; integrators should read from the same manifest.

```ts
import { DEPLOYMENT_MANIFESTS } from "@deployments/index";

const testnet = DEPLOYMENT_MANIFESTS.testnet;
console.log(testnet.contracts.stealthRegistry);
```

| Network | Manifest path |
|:--------|:--------------|
| testnet | `deployments/v1/testnet.json` |
| mainnet | `deployments/v1/mainnet.json` |

---

## Read APIs (Soroban)

All read operations use `rpc.Server.getContract` or direct `simulateTransaction` calls.

### Get stealth meta-address

```ts
import { rpc, Contract } from "@stellar/stellar-sdk";
import { Address } from "@stellar/stellar-sdk";

const server = new rpc.Server("https://soroban-testnet.stellar.org");
const registry = new Contract(REGISTRY_CONTRACT_ID);

const result = await server.simulateTransaction(
  // build & prepare a read-only call to registry.get_meta_address(wallet)
);
```

### Check nullifier spent status

```ts
const nullifierIds = [...];  // up to 128
const result = await reputationVerifier.are_nullifiers_spent(nullifierIds);
// Returns boolean[] in input order
```

### Get attestation counts

```ts
const count = await attestationEngine.get_attestation_count();
const stats = await attestationEngine.get_storage_stats();
```

Full read API reference: [Read-Only SDK guide](docs/integrators/read-only-sdk.md)

---

## Proof format

ZK proofs are Groth16 over BN254. Circuits live in `circuits/`.

| Field | Type | Description |
|:------|:-----|:------------|
| `proof` | `{ pi_a, pi_b, pi_c }` | Groth16 proof (snarkjs format) |
| `publicSignals` | `string[]` | Public inputs/outputs |
| `circuit` | `string` | Circuit identifier (e.g. `v1/trait-proof`) |

### Verification (on-chain)

```solidity
// Solidity-style — your contract calls groth16-verifier
bool ok = groth16Verifier.verifyProof(proof, publicSignals);
```

### Verification (off-chain)

```ts
import { groth16 } from "snarkjs";

const vKey = await fetch("/circuits/v1/verification_key.json").then(r => r.json());
const ok = await groth16.verify(vKey, publicSignals, proof);
```

---

## Testnet faucet

| Resource | URL |
|:---------|:----|
| Stellar friendbot | `https://friendbot.stellar.org` |
| Freighter testnet | Switch Freighter to `TESTNET` via extension settings |

```bash
curl "https://friendbot.stellar.org?addr=YOUR_PUBLIC_KEY"
```

---

## Common integration patterns

### 1. Monitor incoming stealth payments

Periodically call `stealth-announcer` for announcements, then scan with the WASM scanner (see `scanner/`). Announcements contain view tags for fast filtering.

### 2. Issue attestations

Use `attestation-engine-v2.issue(schema_id, subject, data)` — only the schema authority may issue.

### 3. Verify reputation proofs

Submit `(proof, publicSignals)` to `reputation-verifier.verify`. The verifier checks the Groth16 proof and nullifier freshness in one call.

---

## Resources

- [Schema Authoring Guide](docs/integrators/schema-authoring-guide.md)
- [Reputation Proof Guide](docs/integrators/reputation-proof-guide.md)
- [Read-Only SDK](docs/integrators/read-only-sdk.md)
- [WASM SIMD Evaluation](docs/WASM_SIMD_EVALUATION.md)
- [Testnet deployment manifest](deployments/v1/testnet.json)
