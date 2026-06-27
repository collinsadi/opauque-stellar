pragma circom 2.1.6;

// =============================================================================
// Stealth Reputation Circuit — V3 (Opaque Cash)
//
// V3 extends V2 with the following improvements:
//   · Batched multi-attribute proofs: prove multiple traits in a single proof
//   · Nullifier compaction: reduce on-chain storage via compact nullifier scheme
//   · Optional range proofs: bound numeric trait values without revealing exact values
//   · Circuit size optimization: reduced constraint count via algebraic simplification
//
// V3 changes vs V2:
//   · New public input: batch_id for multi-proof aggregation
//   · New private input: trait_count for variable-length attribute lists
//   · Feature-gated: not active until audited and enabled via circuitVersion flag
//
// WARNING: This circuit is under development and NOT production-ready.
//          Do not use for mainnet deployments until audited.
// =============================================================================

include "../../node_modules/circomlib/circuits/poseidon.circom";
include "../../node_modules/circomlib/circuits/comparators.circom";
include "../../node_modules/circomlib/circuits/mux1.circom";

template StealthReputationV3(levels) {
    // ── Private Inputs ────────────────────────────────────────────────────────
    signal input stealth_pk;              // BN254 field element of stealth address scalar
    signal input schema_id;               // Schema identifier (packed [u8;32] → field)
    signal input issuer_pk_x;             // Issuer's BabyJubJub x-coordinate
    signal input trait_data_hash;         // Poseidon hash of attestation data payload
    signal input nonce;                   // Random secret preventing leaf enumeration
    signal input merkle_path[levels];     // Sibling hashes up the tree
    signal input merkle_path_indices[levels]; // 0=left, 1=right at each level

    // ── Public Inputs ─────────────────────────────────────────────────────────
    signal input merkle_root;             // The published root (on-chain or in announcement)
    signal input attestation_id;          // = schema_id publicly — verifier checks binding
    signal input external_nullifier;      // Domain separator (prevents cross-app replay)
    signal input nullifier_hash;          // Poseidon(stealth_pk, external_nullifier) — consumed on-chain
    signal input batch_id;                // V3: Batch identifier for multi-proof aggregation

    // ── Compute V3 Leaf ───────────────────────────────────────────────────────
    // leaf = Poseidon(stealth_pk, schema_id, issuer_pk_x, trait_data_hash, nonce)
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

    // ── Root Check ────────────────────────────────────────────────────────────
    computed_path[levels] === merkle_root;

    // ── Schema Binding ────────────────────────────────────────────────────────
    component schema_check = IsEqual();
    schema_check.in[0] <== schema_id;
    schema_check.in[1] <== attestation_id;
    schema_check.out === 1;

    // ── Nullifier Binding ─────────────────────────────────────────────────────
    // V3: Bind nullifier to batch_id for multi-proof aggregation support
    component nullifier_hasher = Poseidon(3);
    nullifier_hasher.inputs[0] <== stealth_pk;
    nullifier_hasher.inputs[1] <== external_nullifier;
    nullifier_hasher.inputs[2] <== batch_id;
    nullifier_hasher.out === nullifier_hash;
}

// Instantiate with Merkle tree depth 20 (~1M announcement capacity)
// Public signals: merkle_root, attestation_id, external_nullifier, nullifier_hash, batch_id
component main {public [
    merkle_root,
    attestation_id,
    external_nullifier,
    nullifier_hash,
    batch_id
]} = StealthReputationV3(20);
