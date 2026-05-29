pragma circom 2.1.6;

// =============================================================================
// Stealth Reputation Circuit — V2 (Opaque Cash)
//
// Proves ownership of a stealth address that holds a specific schema-bound
// attestation issued by a specific authority, without revealing the stealth
// address itself.
//
// V2 changes vs V1:
//   · Leaf now commits to (stealth_pk, schema_id, issuer_pk_x, trait_data_hash, nonce)
//     instead of (stealth_address_commitment, attestation_id).
//   · nullifier_hash is a public INPUT (not an output), bound to the circuit.
//   · attestation_id (= schema_id) is a public INPUT used to enforce schema binding.
//   · issuer_pk_x, trait_data_hash, and nonce are private, preventing enumeration.
//   · Breaking change: new trusted setup required.
//
// Private inputs:
//   stealth_pk          BN254 field element of the stealth private key scalar
//   schema_id           Schema identifier packed from [u8; 32] → BN254 field element
//   issuer_pk_x         Issuer's Ed25519 public key (32 bytes) as BN254 field element.
//                       Canonical encoding: big-endian 256-bit integer (0x-hex format).
//                       See ISSUER_ENCODING.md for specification.
//   trait_data_hash     Poseidon hash of the ABI-encoded attestation data fields
//   nonce               Random secret preventing leaf enumeration across sessions
//   merkle_path[20]     Sibling hashes along the Merkle inclusion path
//   merkle_path_indices[20]  Direction bits: 0 = current node is left, 1 = right
//
// Public inputs:
//   merkle_root         The published Merkle root (stored on-chain or in announcement)
//   attestation_id      = schema_id as a field element (verifier checks this matches)
//   external_nullifier  Domain separator preventing cross-app proof replay
//   nullifier_hash      Poseidon(stealth_pk, external_nullifier) — consumed on-chain
// =============================================================================

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/mux1.circom";

template StealthReputation(levels) {
    // ── Private Inputs ────────────────────────────────────────────────────────
    signal input stealth_pk;              // BN254 field element of stealth address scalar
    signal input schema_id;               // Schema identifier (packed [u8;32] → field)
    signal input issuer_pk_x;             // Issuer's BabyJubJub x-coordinate
    signal input trait_data_hash;         // Poseidon hash of attestation data payload
    signal input nonce;                   // Random secret preventing leaf enumeration
    signal input merkle_path[levels];         // Sibling hashes up the tree
    signal input merkle_path_indices[levels]; // 0=left, 1=right at each level

    // ── Public Inputs ─────────────────────────────────────────────────────────
    signal input merkle_root;             // The published root (on-chain or in announcement)
    signal input attestation_id;          // = schema_id publicly — verifier checks binding
    signal input external_nullifier;      // Domain separator (prevents cross-app replay)
    signal input nullifier_hash;          // Poseidon(stealth_pk, external_nullifier) — consumed on-chain

    // ── Compute V2 Leaf ───────────────────────────────────────────────────────
    // leaf = Poseidon(stealth_pk, schema_id, issuer_pk_x, trait_data_hash, nonce)
    // This binds the proof to a specific schema AND a specific issuer.
    component leaf_hasher = Poseidon(5);
    leaf_hasher.inputs[0] <== stealth_pk;
    leaf_hasher.inputs[1] <== schema_id;
    leaf_hasher.inputs[2] <== issuer_pk_x;
    leaf_hasher.inputs[3] <== trait_data_hash;
    leaf_hasher.inputs[4] <== nonce;

    signal leaf <== leaf_hasher.out;

    // ── Merkle Inclusion Proof ────────────────────────────────────────────────
    component merkle_hashers[levels];
    component mux_left[levels];
    component mux_right[levels];

    signal computed_path[levels + 1];
    computed_path[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        // Constrain path indices to be binary
        merkle_path_indices[i] * (1 - merkle_path_indices[i]) === 0;

        // 0 = current node is left child, sibling is right
        // 1 = current node is right child, sibling is left
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

    // ── Root Check ────────────────────────────────────────────────────────────
    // The computed root from the Merkle path must equal the public merkle_root.
    computed_path[levels] === merkle_root;

    // ── Schema Binding ────────────────────────────────────────────────────────
    // Constrain: the private schema_id used to build the leaf equals the public
    // attestation_id. This prevents a prover from using a leaf built for schema A
    // to satisfy a verification request for schema B.
    component schema_check = IsEqual();
    schema_check.in[0] <== schema_id;
    schema_check.in[1] <== attestation_id;
    schema_check.out === 1;

    // ── Nullifier Binding ─────────────────────────────────────────────────────
    // Compute nullifier_hash = Poseidon(stealth_pk, external_nullifier) and
    // constrain it to equal the public nullifier_hash input.
    // The on-chain verifier stores this hash to prevent the same stealth address
    // from proving the same action twice (Sybil resistance).
    component nullifier_hasher = Poseidon(2);
    nullifier_hasher.inputs[0] <== stealth_pk;
    nullifier_hasher.inputs[1] <== external_nullifier;
    nullifier_hasher.out === nullifier_hash;
}

// Instantiate with Merkle tree depth 20 (~1M announcement capacity)
// Public signals: merkle_root, attestation_id, external_nullifier, nullifier_hash
component main {public [
    merkle_root,
    attestation_id,
    external_nullifier,
    nullifier_hash
]} = StealthReputation(20);
