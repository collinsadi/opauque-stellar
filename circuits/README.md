# Circuits — Stealth Attestation ZK Proof

This directory contains the **Circom circuit** for Opaque's Programmable Stealth Reputation (PSR) system. The circuit enables a user to prove they own a stealth address with a specific attestation (trait/badge) without revealing the address itself or any other identifying information.

## Circuit: `stealth_attestation.circom`

**Proof system:** Groth16 (BN254 / alt_bn128)
**Tree depth:** 20 (~1,048,576 announcement capacity)
**Constraint count:** ~50,000

### What It Proves

Given public inputs `(merkle_root, attestation_id, external_nullifier)`, the prover demonstrates:

1. They know a `stealth_private_key` that derives a valid BabyJubJub public key.
2. An ECDH shared secret between that key and an `ephemeral_pubkey` produces a stealth address commitment.
3. A leaf `Poseidon(commitment, attestation_id)` is included in the Merkle tree at the given `merkle_root`.
4. The announcement's `attestation_id` matches the claimed public `attestation_id`.
5. A **nullifier** `Poseidon(stealth_private_key, external_nullifier)` is output — binding the proof to a specific action context and preventing replay.

### Signal Layout

| Signal | Visibility | Description |
|:---|:---|:---|
| `merkle_root` | Public input | Root of the announcement Merkle tree |
| `attestation_id` | Public input | The trait/badge ID being proven |
| `external_nullifier` | Public input | Action-scoped nonce (vote ID, campaign ID, etc.) |
| `stealth_private_key` | Private input | Scalar on BabyJubJub |
| `ephemeral_pubkey[2]` | Private input | BabyJubJub point (x, y) from the announcement |
| `announcement_attestation_id` | Private input | Attestation ID stored in the announcement leaf |
| `merkle_path_elements[20]` | Private input | Sibling hashes for Merkle inclusion proof |
| `merkle_path_indices[20]` | Private input | Direction bits (0=left, 1=right) for each level |
| `nullifier` | Output | `Poseidon(stealth_private_key, external_nullifier)` |
| `is_valid` | Output | `1` if all checks pass, `0` otherwise |

### Cryptographic Primitives

- **BabyJubJub** — Elliptic curve for in-circuit scalar multiplication (key derivation + ECDH)
- **Poseidon** — SNARK-friendly hash for Merkle tree, address commitments, and nullifiers
- **EscalarMulAny** — Arbitrary-base scalar multiplication from circomlib

## Build & Setup

### Prerequisites

- [Circom](https://docs.circom.io/getting-started/installation/) 2.1.6+
- [snarkjs](https://github.com/iden3/snarkjs) 0.7+
- Node.js 18+

### Commands

```bash
# Install dependencies (circomlib)
npm install

# Compile the circuit (generates R1CS, WASM witness generator, and C++ witness generator)
npm run build

# Run Groth16 trusted setup with Powers of Tau
npm run setup

# Contribute to the ceremony (adds randomness)
npm run contribute

# Export verification key (JSON)
npm run export-vkey

# Export Solidity verifier contract
npm run export-sol
```

### Generating a Proof

```bash
# Generate witness (requires input.json with private + public signals)
node build/stealth_attestation_js/generate_witness.js \
  build/stealth_attestation_js/stealth_attestation.wasm \
  input.json \
  build/witness.wtns

# Generate Groth16 proof
npm run prove

# Verify locally
npm run verify
```

In the frontend, proof generation happens entirely in-browser via snarkjs, using the WASM witness generator and the final zkey verified against [`artifacts/manifest.json`](../artifacts/manifest.json). Fetch release assets with `npm run fetch:circuits` (see [`artifacts/README.md`](../artifacts/README.md)).

## Build Artifacts

| File | Description |
|:-----|:------------|
| `build/stealth_attestation.r1cs` | Rank-1 Constraint System |
| `build/stealth_attestation_js/` | WASM witness generator |
| `build/stealth_attestation_cpp/` | C++ witness generator |
| `build/sa_final.zkey` | Final zkey (after ceremony contributions) |
| `build/verification_key.json` | Verification key (used by on-chain verifier) |
| `build/Groth16Verifier.sol` | Auto-generated Solidity verifier (reference for the Anchor program) |

## Trusted Setup

The `.ptau` files in this directory are from the Hermez Phase 1 Powers of Tau ceremony. The `.zkey` files include Phase 2 contributions specific to this circuit. **These are for development only** — a production deployment requires a properly audited multi-party ceremony.
