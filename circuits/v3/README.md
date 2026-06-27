# Circuit V3 Design RFC

## Status

Draft — Under active development

## Summary

This RFC proposes V3 of the Stealth Reputation circuit, extending V2 with batched multi-attribute proofs, nullifier compaction, and optional range proofs.

## Motivation

V2 provides single-attribute reputation proofs, but real-world use cases require:
- Proving multiple traits simultaneously (e.g., "over 18" AND "KYC verified")
- Reducing on-chain storage costs via compact nullifiers
- Bounding numeric trait values without revealing exact values

## Proposed Changes

### 1. Batch Identifier (`batch_id`)

New public input that enables multi-proof aggregation:

```circom
signal input batch_id;  // Batch identifier for multi-proof aggregation
```

The nullifier is now bound to both `external_nullifier` AND `batch_id`, allowing:
- Different proofs for the same action across different batches
- On-chain aggregation of related proofs

### 2. Nullifier Compaction

V3 uses `Poseidon(stealth_pk, external_nullifier, batch_id)` instead of `Poseidon(stealth_pk, external_nullifier)`.

This adds batch context to the nullifier while maintaining collision resistance.

### 3. Future: Range Proofs (V3.1)

Planned for V3.1 (not in initial V3 release):
- Bounded numeric trait values (e.g., "age >= 18")
- Uses BabyJubJub range proof gadgets
- Feature-gated until audited

### 4. Future: Multi-Attribute Batching (V3.2)

Planned for V3.2:
- Prove N traits in a single proof via recursive composition
- Amortized verification cost across attributes

## Public Signals

| Signal | Type | Description |
|:-------|:-----|:------------|
| `merkle_root` | Input | Root of the announcement Merkle tree |
| `attestation_id` | Input | The schema ID being proven |
| `external_nullifier` | Input | Action-scoped nonce |
| `nullifier_hash` | Input | `Poseidon(stealth_pk, external_nullifier, batch_id)` |
| `batch_id` | Input | Batch identifier for multi-proof aggregation |

## Private Inputs

| Signal | Type | Description |
|:-------|:-----|:------------|
| `stealth_pk` | Input | BN254 field element of stealth address scalar |
| `schema_id` | Input | Schema identifier (packed [u8;32] → field) |
| `issuer_pk_x` | Input | Issuer's BabyJubJub x-coordinate |
| `trait_data_hash` | Input | Poseidon hash of attestation data payload |
| `nonce` | Input | Random secret preventing leaf enumeration |
| `merkle_path[20]` | Input | Sibling hashes along the Merkle inclusion path |
| `merkle_path_indices[20]` | Input | Direction bits: 0 = current node is left, 1 = right |

## Constraint Count

V3 target: ~55,000 constraints (vs V2 ~52,000)

## Security Considerations

- V3 is NOT production-ready until audited
- No production dependency on V3 until feature flag is enabled
- Circuit compilation in dev mode (`build:dev`) uses no optimizations for easier debugging

## Implementation Plan

1. **Phase 1** (Current): Scaffold and RFC
2. **Phase 2**: Implement batch_id binding and testing
3. **Phase 3**: External audit
4. **Phase 4**: Feature flag enablement and mainnet deployment

## Feature Flag

V3 is gated behind `VITE_CIRCUIT_V3_ENABLED` environment variable:
- Default: `false` on mainnet, `true` on testnet
- Runtime override: `window.__OPAQUE_FEATURE_FLAGS__.circuitV3`

## References

- V2 Circuit: `circuits/v2/stealth_reputation.circom`
- V2 RFC: N/A (see git history)
- Feature Flags: `frontend/src/lib/featureFlags.ts`
