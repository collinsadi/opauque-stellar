# Stealth Key Alignment: secp256k1 Wallet ↔ BN254 Circuit

## Problem Statement

**Cryptographic Mismatch**: The wallet derives stealth addresses using **secp256k1 DKSAP** (EIP-5564), but the ZK circuit proves ownership using **BabyJubJub** (BN254). The stealth private key is reinterpreted as a BabyJubJub scalar, creating a proof that is **cryptographically disconnected from the actual sealth address**.

### What the Wallet Does (secp256k1)

```
1. Derive stealth private key: p_stealth = spending_key + s_h (mod n_secp256k1)
2. Compute stealth public key: P_stealth = p_stealth * G_secp256k1
3. Derive stealth address: keccak256(uncompressed(P_stealth))[12:32] (20 bytes)
4. Derive Stellar account: sha256("opaque-stellar-stealth-v1" || uncompressed(P_stealth))
```

### What the Circuit Proves (BabyJubJub)

```
1. Reinterpret stealth private key as BabyJubJub scalar
2. Compute BabyJubJub public key: P_stealth_bj = stealth_pk * G_BabyJubJub
3. Compute Poseidon commitment: Poseidon(ECDH_BabyJubJub, P_stealth_bj)
4. Prove Merkle inclusion of this commitment
```

### The Mismatch

- **Wallet address**: `keccak256(secp256k1_pubkey)[12:32]`
- **Circuit commitment**: `Poseidon(BabyJubJub_ECDH, BabyJubJub_pubkey)`
- **Result**: The circuit proves ownership of a **different key** than the wallet actually uses

## Solution: Hash Commitment Model

### Core Idea

Instead of trying to prove secp256k1 operations in BN254 (impossible), prove that you know the **preimage of a hash commitment** that was created from the secp256k1 stealth address.

### Implementation

#### Step 1: Create Hash Commitment (Off-Chain, Wallet)

When the wallet generates a stealth address, it also computes a commitment:

```typescript
// frontend/src/lib/stealth.ts
export function computeStealthCommitment(
  stealthPrivKeyBytes: Uint8Array,
  stealthPubKeyUncompressed: Uint8Array,
): { commitment: string; preimage: string } {
  // Commitment = sha256(stealth_private_key || stealth_public_key)
  // This binds the proof to the actual secp256k1 keys

  const preimage = new Uint8Array(32 + 65);
  preimage.set(stealthPrivKeyBytes, 0);
  preimage.set(stealthPubKeyUncompressed, 32);

  const commitment = sha256(preimage);

  return {
    commitment: "0x" + bytesToHex(commitment),
    preimage: "0x" + bytesToHex(preimage),
  };
}
```

#### Step 2: Update Circuit to Prove Hash Commitment

**New Circuit Statement**:

```
Given public inputs (merkle_root, attestation_id, external_nullifier, nullifier_hash, stealth_commitment),
prove that you know:
  1. stealth_private_key (BN254 field element, reinterpreted from secp256k1)
  2. stealth_public_key (65 bytes, uncompressed secp256k1 point)
  3. schema_id, issuer_pk_x, trait_data_hash, nonce (as before)
  4. merkle_path (Merkle inclusion proof)

Such that:
  1. sha256(stealth_private_key || stealth_public_key) == stealth_commitment
  2. leaf = Poseidon(stealth_commitment, schema_id, issuer_pk_x, trait_data_hash, nonce)
  3. Merkle(leaf, merkle_path) == merkle_root
  4. schema_id == attestation_id
  5. Poseidon(stealth_private_key, external_nullifier) == nullifier_hash
```

**Circuit Changes** (`circuits/v2/stealth_reputation.circom`):

```circom
pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/sha256/sha256.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/mux1.circom";

template StealthReputation(levels) {
    // ── Private Inputs ────────────────────────────────────────────────────────
    signal input stealth_pk;              // BN254 field element (reinterpreted secp256k1 scalar)
    signal input stealth_pubkey_bytes[65]; // Uncompressed secp256k1 public key (65 bytes)
    signal input schema_id;               // Schema identifier
    signal input issuer_pk_x;             // Issuer Ed25519 public key
    signal input trait_data_hash;         // Poseidon hash of attestation data
    signal input nonce;                   // Random secret
    signal input merkle_path[levels];     // Sibling hashes
    signal input merkle_path_indices[levels]; // Direction bits

    // ── Public Inputs ─────────────────────────────────────────────────────────
    signal input merkle_root;             // Published Merkle root
    signal input attestation_id;          // Schema ID (public binding)
    signal input external_nullifier;      // Domain separator
    signal input nullifier_hash;          // Poseidon(stealth_pk, external_nullifier)
    signal input stealth_commitment;      // sha256(stealth_pk || stealth_pubkey)

    // ── Step 1: Verify Hash Commitment ────────────────────────────────────────
    // Prove: sha256(stealth_pk || stealth_pubkey) == stealth_commitment

    // Convert stealth_pk (field element) to 32 bytes
    component pk_to_bits = Num2Bits(256);
    pk_to_bits.in <== stealth_pk;

    component pk_bytes = Bits2Num(8);
    for (var i = 0; i < 8; i++) {
        pk_bytes.in[i] <== pk_to_bits.out[i];
    }
    // ... (repeat for all 32 bytes of stealth_pk)

    // Concatenate stealth_pk (32 bytes) + stealth_pubkey (65 bytes) = 97 bytes
    signal preimage[97];
    // ... (set preimage from pk_bytes and stealth_pubkey_bytes)

    // Compute SHA256 of preimage
    component sha256_hasher = Sha256(97 * 8);
    for (var i = 0; i < 97 * 8; i++) {
        sha256_hasher.in[i] <== preimage_bits[i];
    }

    // Verify commitment matches
    signal computed_commitment[256];
    for (var i = 0; i < 256; i++) {
        computed_commitment[i] <== sha256_hasher.out[i];
    }

    // Convert computed_commitment to field element and verify
    component commitment_to_field = Bits2Num(256);
    for (var i = 0; i < 256; i++) {
        commitment_to_field.in[i] <== computed_commitment[i];
    }
    commitment_to_field.out === stealth_commitment;

    // ── Step 2: Compute V2 Leaf ───────────────────────────────────────────────
    // leaf = Poseidon(stealth_commitment, schema_id, issuer_pk_x, trait_data_hash, nonce)
    // Note: Use stealth_commitment instead of stealth_pk to bind to actual secp256k1 key

    component leaf_hasher = Poseidon(5);
    leaf_hasher.inputs[0] <== stealth_commitment;
    leaf_hasher.inputs[1] <== schema_id;
    leaf_hasher.inputs[2] <== issuer_pk_x;
    leaf_hasher.inputs[3] <== trait_data_hash;
    leaf_hasher.inputs[4] <== nonce;

    signal leaf <== leaf_hasher.out;

    // ── Step 3: Merkle Inclusion Proof ────────────────────────────────────────
    // (Same as before: prove leaf is in tree at merkle_root)

    component merkle_hashers[levels];
    component mux_left[levels];
    component mux_right[levels];

    signal computed_path[levels + 1];
    computed_path[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        merkle_path_indices[i] * (1 - merkle_path_indices[i]) === 0;

        mux_left[i] = Mux1();
        mux_left[i].c[0] <== computed_path[i];
        mux_left[i].c[1] <== merkle_path[i];
        mux_left[i].s <== merkle_path_indices[i];

        mux_right[i] = Mux1();
        mux_right[i].c[0] <== merkle_path[i];
        mux_right[i].c[1] <== computed_path[i];
        mux_right[i].s <== merkle_path_indices[i];

        merkle_hashers[i] = Poseidon(2);
        merkle_hashers[i].inputs[0] <== mux_left[i].out;
        merkle_hashers[i].inputs[1] <== mux_right[i].out;

        computed_path[i + 1] <== merkle_hashers[i].out;
    }

    computed_path[levels] === merkle_root;

    // ── Step 4: Nullifier Binding ─────────────────────────────────────────────
    // Verify: Poseidon(stealth_pk, external_nullifier) == nullifier_hash

    component nullifier_hasher = Poseidon(2);
    nullifier_hasher.inputs[0] <== stealth_pk;
    nullifier_hasher.inputs[1] <== external_nullifier;

    nullifier_hasher.out === nullifier_hash;

    // ── Step 5: Schema Binding ────────────────────────────────────────────────
    // Verify: schema_id == attestation_id

    schema_id === attestation_id;
}
```

#### Step 3: Update Scanner to Generate Commitments

**Scanner Changes** (`scanner/src/attestation.rs`):

```rust
/// Computes the stealth commitment for binding proofs to actual secp256k1 keys.
/// commitment = sha256(stealth_private_key || stealth_public_key_uncompressed)
pub fn compute_stealth_commitment(
    stealth_privkey: &[u8; 32],
    stealth_pubkey_uncompressed: &[u8; 65],
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(stealth_privkey);
    hasher.update(stealth_pubkey_uncompressed);
    hasher.finalize().into()
}

/// Updated V2 leaf preimage with stealth commitment
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MerkleLeafPreimage {
    /// Stealth commitment (sha256(stealth_pk || stealth_pubkey)) — binds to actual secp256k1 key
    pub stealth_commitment: String,
    /// Schema identifier (packed [u8;32] → field)
    pub schema_id_field: String,
    /// Issuer Ed25519 public key (32 bytes) as BN254 field element (0x-hex format)
    pub issuer_pk_x: String,
    /// Poseidon(data fields) decimal string
    pub trait_data_hash: String,
    /// Random nonce (decimal string)
    pub nonce_field: String,
}
```

#### Step 4: Update Proof Generation

**Prover Changes** (`frontend/src/lib/reputationProver.ts`):

```typescript
export async function buildCircuitConsistentWitness(
  stealthPrivKeyBytes: Uint8Array,
  stealthPubKeyUncompressed: Uint8Array,
  schemaId: string,
  issuerPkX: string,
  traitDataHash: string,
  nonce: string,
  externalNullifier: string,
  merkleRoot: string,
  merklePathElements: string[],
  merklePathIndices: number[],
) {
  const circomlib = await import("circomlibjs");
  const poseidon = await circomlib.buildPoseidon();
  const F = poseidon.F;

  // Step 1: Compute stealth commitment
  const commitment = computeStealthCommitment(
    stealthPrivKeyBytes,
    stealthPubKeyUncompressed,
  );
  const commitmentField = BigInt(commitment.commitment);

  // Step 2: Convert inputs to field elements
  const stealthPriv = F.toObject(F.e(bytesToBigInt(stealthPrivKeyBytes)));
  const schemaIdField = BigInt(schemaId);
  const issuerField = BigInt(issuerPkX);
  const traitHashField = BigInt(traitDataHash);
  const nonceField = BigInt(nonce);
  const extNullifier = BigInt(externalNullifier);

  // Step 3: Compute leaf with stealth commitment
  const leaf = F.toObject(
    poseidon([
      commitmentField,
      schemaIdField,
      issuerField,
      traitHashField,
      nonceField,
    ]),
  );

  // Step 4: Compute nullifier
  const nullifierHash = F.toObject(poseidon([stealthPriv, extNullifier]));

  // Step 5: Build Merkle proof (same as before)
  // ...

  return {
    merkle_root: merkleRoot,
    attestation_id: schemaId,
    external_nullifier: externalNullifier,
    nullifier_hash: nullifierHash.toString(),
    stealth_commitment: commitment.commitment,
    stealth_private_key: stealthPriv.toString(),
    stealth_pubkey_bytes: Array.from(stealthPubKeyUncompressed),
    schema_id: schemaId,
    issuer_pk_x: issuerPkX,
    trait_data_hash: traitDataHash,
    nonce: nonce,
    merkle_path_elements: merklePathElements,
    merkle_path_indices: merklePathIndices,
  };
}
```

## Acceptance Criteria

### ✅ Circuit Statement Matches Wallet Key Derivation

**Before**: Circuit proved BabyJubJub operations unrelated to secp256k1 keys
**After**: Circuit proves knowledge of secp256k1 stealth key via hash commitment

**Verification**:

- Circuit input: `stealth_commitment = sha256(stealth_pk || stealth_pubkey)`
- Circuit verifies: `sha256(stealth_pk || stealth_pubkey) == stealth_commitment`
- Wallet computes: Same commitment from actual secp256k1 keys
- **Result**: Proof is cryptographically bound to actual stealth address

### ✅ Proof Fixtures Generated from Real App Keys

**Test Vector**:

```
Stealth Private Key: 0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
Stealth Public Key (uncompressed): 0x04 + 64 hex chars
Stealth Commitment: sha256(privkey || pubkey) = 0x...
Leaf: Poseidon(commitment, schema_id, issuer, trait_hash, nonce)
Merkle Root: Poseidon tree root
Proof: Groth16 proof of Merkle inclusion + commitment verification
```

**Verification**:

- Generate commitment from real secp256k1 keys
- Build witness with commitment
- Generate Groth16 proof
- Verify proof with public signals including commitment
- **Result**: Proof is generated from actual wallet keys

### ✅ Documentation Explains Cryptographic Binding

**Key Points**:

1. **Wallet Reality**: secp256k1 DKSAP derives stealth address via Keccak hash
2. **Circuit Model**: Proves knowledge of secp256k1 key via hash commitment
3. **Binding**: `stealth_commitment = sha256(stealth_pk || stealth_pubkey)` links proof to actual key
4. **Leaf**: Uses commitment instead of raw key, ensuring Merkle tree is consistent
5. **Nullifier**: Still uses stealth_pk for replay protection

## Implementation Checklist

- [ ] Update `circuits/v2/stealth_reputation.circom` to verify hash commitment
- [ ] Add SHA256 circuit component (or use existing circomlib)
- [ ] Update `scanner/src/attestation.rs` to compute commitments
- [ ] Update `frontend/src/lib/reputationProver.ts` to generate commitments
- [ ] Update `demo/src/verifier.ts` to accept stealth_commitment in public signals
- [ ] Add test vectors with real secp256k1 keys
- [ ] Document cryptographic binding in STEALTH_KEY_ALIGNMENT.md
- [ ] Verify Merkle tree consistency (commitment-based leaves)
- [ ] Test end-to-end: wallet → scanner → prover → verifier

## Implementation Guide

### 1. Circuit: Add Hash Commitment Verification

**File**: `circuits/v2/stealth_reputation.circom`

**Add to private inputs**:

```circom
signal input stealth_pubkey_bytes[65];  // Uncompressed secp256k1 public key
```

**Add to public inputs**:

```circom
signal input stealth_commitment;  // sha256(stealth_pk || stealth_pubkey)
```

**Add verification step** (before Merkle proof):

```circom
// Verify: sha256(stealth_pk || stealth_pubkey) == stealth_commitment
component sha256_hasher = Sha256(97 * 8);  // 32 + 65 bytes
// ... (convert stealth_pk to bits, concatenate with stealth_pubkey_bytes)
// ... (verify computed hash equals stealth_commitment)
```

**Update leaf computation**:

```circom
// OLD: leaf = Poseidon(stealth_pk, schema_id, issuer_pk_x, trait_data_hash, nonce)
// NEW: leaf = Poseidon(stealth_commitment, schema_id, issuer_pk_x, trait_data_hash, nonce)
component leaf_hasher = Poseidon(5);
leaf_hasher.inputs[0] <== stealth_commitment;  // Use commitment instead of raw key
leaf_hasher.inputs[1] <== schema_id;
leaf_hasher.inputs[2] <== issuer_pk_x;
leaf_hasher.inputs[3] <== trait_data_hash;
leaf_hasher.inputs[4] <== nonce;
```

### 2. Scanner: Compute Commitments

**File**: `scanner/src/attestation.rs`

**Add function**:

```rust
pub fn compute_stealth_commitment(
    stealth_privkey: &[u8; 32],
    stealth_pubkey_uncompressed: &[u8; 65],
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(stealth_privkey);
    hasher.update(stealth_pubkey_uncompressed);
    hasher.finalize().into()
}
```

**Update `MerkleLeafPreimage`**:

```rust
pub struct MerkleLeafPreimage {
    pub stealth_commitment: String,  // NEW: sha256(stealth_pk || stealth_pubkey)
    pub schema_id_field: String,
    pub issuer_pk_x: String,
    pub trait_data_hash: String,
    pub nonce_field: String,
}
```

**Update scanning logic**:

```rust
let commitment = compute_stealth_commitment(&stealth_privkey, &stealth_pubkey_uncompressed);
let merkle_leaf_preimage = MerkleLeafPreimage {
    stealth_commitment: bytes_to_field_decimal(&commitment),
    schema_id_field: bytes_to_field_decimal(&v2.schema_id),
    issuer_pk_x: bytes_to_field_decimal(&v2.issuer),
    trait_data_hash: "0".to_string(),
    nonce_field: bytes_to_field_decimal(&v2.nonce),
};
```

### 3. Prover: Generate Commitments

**File**: `frontend/src/lib/reputationProver.ts`

**Add function**:

```typescript
function computeStealthCommitment(
  stealthPrivKeyBytes: Uint8Array,
  stealthPubKeyUncompressed: Uint8Array,
): string {
  const preimage = new Uint8Array(32 + 65);
  preimage.set(stealthPrivKeyBytes, 0);
  preimage.set(stealthPubKeyUncompressed, 32);
  const hash = sha256(preimage);
  return "0x" + bytesToHex(hash);
}
```

**Update witness generation**:

```typescript
const commitment = computeStealthCommitment(
  stealthPrivKeyBytes,
  stealthPubKeyUncompressed,
);
const commitmentField = BigInt(commitment);

// Use commitment in leaf instead of stealth_pk
const leaf = F.toObject(
  poseidon([
    commitmentField,
    schemaIdField,
    issuerField,
    traitHashField,
    nonceField,
  ]),
);

return {
  stealth_commitment: commitment, // NEW: public signal
  stealth_pubkey_bytes: Array.from(stealthPubKeyUncompressed), // NEW: private input
  // ... rest of witness
};
```

### 4. Verifier: Accept Commitment in Public Signals

**File**: `demo/src/verifier.ts`

**Update public signals layout**:

```typescript
// OLD: [merkle_root, attestation_id, external_nullifier, nullifier_hash]
// NEW: [merkle_root, attestation_id, external_nullifier, nullifier_hash, stealth_commitment]

const [
  merkleRoot,
  attestationId,
  externalNullifier,
  nullifierHash,
  stealthCommitment,
] = publicSignals;
```

### 5. Wallet: Generate Commitments

**File**: `frontend/src/lib/stealth.ts`

**Add function**:

```typescript
export function computeStealthCommitment(
  stealthPrivKeyBytes: Uint8Array,
  stealthPubKeyUncompressed: Uint8Array,
): string {
  const preimage = new Uint8Array(32 + 65);
  preimage.set(stealthPrivKeyBytes, 0);
  preimage.set(stealthPubKeyUncompressed, 32);
  const hash = sha256(preimage);
  return "0x" + bytesToHex(hash);
}
```

**Use in key derivation**:

```typescript
const { stealthAddress, stealthPubKeyUncompressed } = stealthPointAndAddress(
  spendPubKey,
  sH,
);
const commitment = computeStealthCommitment(
  stealthPrivKeyBytes,
  stealthPubKeyUncompressed,
);

return {
  stealthAddress,
  stealthPubKeyUncompressed,
  commitment, // NEW: store for proof generation
};
```

## Test Vector

```
Stealth Private Key: 0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
Stealth Public Key (uncompressed): 0x04 + 64 hex chars
Preimage: stealth_pk || stealth_pubkey (97 bytes)
Commitment: sha256(preimage) = 0x...

Leaf: Poseidon(commitment, schema_id, issuer_pk_x, trait_data_hash, nonce)
Merkle Root: Poseidon tree root
Nullifier: Poseidon(stealth_pk, external_nullifier)

Public Signals: [merkle_root, attestation_id, external_nullifier, nullifier_hash, stealth_commitment]
Private Inputs: [stealth_pk, stealth_pubkey_bytes, schema_id, issuer_pk_x, trait_data_hash, nonce, merkle_path, merkle_path_indices]
```

## Verification Checklist

- [ ] Circuit verifies `sha256(stealth_pk || stealth_pubkey) == stealth_commitment`
- [ ] Leaf uses commitment: `Poseidon(commitment, schema_id, issuer_pk_x, trait_data_hash, nonce)`
- [ ] Scanner computes commitment from secp256k1 keys
- [ ] Prover generates commitment in witness
- [ ] Verifier accepts commitment in public signals
- [ ] Wallet generates commitment for proof generation
- [ ] Test vector passes end-to-end
- [ ] Merkle tree is consistent (commitment-based leaves)
- [ ] Nullifier still uses stealth_pk for replay protection

## Key Insight

**Before**: Proof proved "I know a BabyJubJub scalar" (unrelated to wallet)
**After**: Proof proves "I know the secp256k1 key whose hash is this commitment" (bound to wallet)

The commitment `sha256(stealth_pk || stealth_pubkey)` is the cryptographic link between the wallet's secp256k1 key and the circuit's BN254 proof.

## References

- **Wallet Key Derivation**: `frontend/src/lib/stealth.ts`
- **Scanner**: `scanner/src/scanner.rs`, `scanner/src/attestation.rs`
- **V2 Circuit**: `circuits/v2/stealth_reputation.circom`
- **Prover**: `frontend/src/lib/reputationProver.ts`
- **Verifier**: `demo/src/verifier.ts`
- **Issuer Encoding**: `ISSUER_ENCODING.md`
