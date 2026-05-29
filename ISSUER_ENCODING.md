# V2 Issuer Identity Encoding Specification

## Overview

The V2 system binds attestations to a specific issuer authority. This document defines the canonical encoding of Stellar Ed25519 issuer addresses across circuits, contracts, and the scanner.

## Canonical Issuer Encoding

### Definition

An **issuer** is a Stellar Ed25519 public key represented as **32 bytes** (the raw public key material, not a full Stellar address).

### Encoding Pipeline

```
Stellar Address (Soroban Address type)
    ↓ extract 32-byte Ed25519 public key
32-byte Ed25519 public key [u8; 32]
    ↓ big-endian interpretation
BN254 field element (0x-prefixed hex string in JSON)
    ↓ circuit input
issuer_pk_x private signal in Poseidon hash
```

### Byte Layout

- **Bytes 0-31**: Ed25519 public key (32 bytes)
- **Interpretation**: Big-endian 256-bit integer
- **Field Element Range**: [0, BN254_MODULUS) where BN254_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617

### JSON Representation

- **Format**: `0x` + 64 hex characters (lowercase)
- **Example**: `0x1234567890abcdef...` (64 hex digits)
- **Circom Acceptance**: Circom 2.x accepts both hex (0x...) and decimal formats

## Component Specifications

### 1. Soroban Contracts (Authority of Truth)

**File**: `contracts/attestation-engine-v2/src/lib.rs`

- Issuer stored as `Address` type (Soroban native)
- Authorization check: `is_authorized_issuer(schema_id, issuer)` compares issuer against schema authority and delegates
- Issuer is **never** converted to field element in contract code
- Contract emits issuer as `Address` in events

**Invariant**: The contract's `Address` type is the source of truth for issuer identity.

### 2. V2 Scanner (Encoding Layer)

**File**: `scanner/src/attestation.rs`

- Extracts issuer as 32-byte array from announcement metadata (bytes 34-66)
- Converts to hex string: `hex_encode(&issuer)` → `0x...` (64 hex chars)
- Converts to field element: `bytes_to_field_decimal(&issuer)` → `0x...` (same hex)
- Stores in `V2StealthAttestation.issuer` as hex string
- Stores in `MerkleLeafPreimage.issuer_pk_x` as 0x-hex field element

**Invariant**: Issuer bytes are treated as big-endian 256-bit integers, never reordered or transformed.

### 3. V2 Circuit (Proof Generation)

**File**: `circuits/v2/stealth_reputation.circom`

- Receives `issuer_pk_x` as private input (BN254 field element)
- Included in leaf hash: `Poseidon(stealth_pk, schema_id, issuer_pk_x, trait_data_hash, nonce)`
- Binds proof to specific issuer, preventing cross-issuer proof reuse
- Issuer identity is **hidden** in private input (not revealed in proof)

**Invariant**: The circuit does not verify issuer validity; it only commits to the issuer value in the leaf hash.

## Validation Flow

### At Attestation Issuance (Contract)

1. Issuer calls `attest(schema_id, issuer, ...)`
2. Contract calls `is_authorized_issuer(schema_id, issuer)` on schema registry
3. Schema registry checks: `issuer == schema.authority || issuer in schema.delegates`
4. If authorized, attestation is stored with issuer as `Address`

### At Scanning (Scanner)

1. Extract issuer as 32-byte array from announcement metadata
2. Look up schema in registry snapshot
3. Check: `schema.is_authorized_issuer(&issuer_bytes)` (32-byte comparison)
4. If authorized, include in results with `issuer_authorized = true`
5. If not authorized, filter out (rogue trait)

### At Proof Generation (Circuit)

1. Browser receives `issuer_pk_x` from scanner output
2. Passes to circuit as private input
3. Circuit includes in Merkle leaf hash
4. Proof is bound to this specific issuer (cannot be replayed with different issuer)

## Known Issuer Encoding Examples

### Example 1: All-zeros issuer

- **Bytes**: `00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00`
- **Hex**: `0x0000000000000000000000000000000000000000000000000000000000000000`
- **Field Element**: `0x0000000000000000000000000000000000000000000000000000000000000000`

### Example 2: Sequential issuer

- **Bytes**: `01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f 10 11 12 13 14 15 16 17 18 19 1a 1b 1c 1d 1e 1f`
- **Hex**: `0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f`
- **Field Element**: `0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f`

### Example 3: Max valid field element

- **Bytes**: `30 64 4e 72 e1 31 a0 26 b8 2b 99 c8 d5 5a 06 16 e6 ff 0c dc 4f ee 0e 17 88 4d 8c 08 3c 05 5c f7`
- **Hex**: `0x30644e72e131a0264b82b99c8d55a0616e6ff0cdc4fee0e17884d8c083c055cf7`
- **Field Element**: `0x30644e72e131a0264b82b99c8d55a0616e6ff0cdc4fee0e17884d8c083c055cf7`
- **Note**: This is BN254_MODULUS - 1 (largest valid field element)

## Testing Requirements

### Unit Tests

1. **Issuer extraction**: Verify 32-byte extraction from announcement metadata
2. **Hex encoding**: Verify big-endian hex representation
3. **Field element conversion**: Verify 0x-hex format matches circuit input
4. **Authorization check**: Verify authorized vs. unauthorized issuer filtering
5. **Known issuer vectors**: Test with known issuer addresses

### Integration Tests

1. **End-to-end flow**: Attestation issuance → scanning → proof generation
2. **Cross-component agreement**: Contract issuer == scanner issuer == circuit issuer
3. **Rogue trait filtering**: Unauthorized issuers are silently filtered
4. **Delegate authorization**: Delegates can issue attestations

## Non-Goals

- **BabyJubJub x-coordinate**: The issuer is NOT a BabyJubJub public key. It's a raw Ed25519 public key.
- **Issuer verification in circuit**: The circuit does not verify issuer validity; it only commits to the value.
- **Cross-chain issuer validation**: Issuer validation happens at contract level, not in circuit.

## References

- Soroban Address type: https://docs.rs/soroban-sdk/latest/soroban_sdk/struct.Address.html
- Ed25519 specification: https://tools.ietf.org/html/rfc8032
- BN254 field: https://en.wikipedia.org/wiki/Barreto%E2%80%93Naehrig_curve
- Circom field inputs: https://docs.circom.io/
