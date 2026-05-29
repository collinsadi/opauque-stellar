# Issuer Encoding Quick Reference

## TL;DR

**Issuer is a 32-byte Ed25519 public key, encoded as a big-endian 256-bit integer in 0x-hex format.**

```
Stellar Address → 32-byte Ed25519 key → 0x-hex field element → Circuit input
```

## Canonical Format

| Property           | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| **Type**           | 32-byte array                                                      |
| **Source**         | Stellar Ed25519 public key                                         |
| **Interpretation** | Big-endian 256-bit integer                                         |
| **JSON Format**    | `0x` + 64 hex characters (lowercase)                               |
| **Example**        | `0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f` |
| **NOT**            | BabyJubJub coordinate, Stellar address, or verified in circuit     |

## Component Responsibilities

### Contract (Authority of Truth)

- Stores issuer as `Address` (Soroban native)
- Validates authorization: `issuer == schema.authority || issuer in schema.delegates`
- Never converts to field element

### Scanner (Encoding Layer)

- Extracts issuer as 32-byte array from announcement metadata (bytes 34-66)
- Converts to hex: `hex_encode(&issuer)` → `0x...` (64 hex chars)
- Converts to field element: `bytes_to_field_decimal(&issuer)` → `0x...` (same hex)
- Stores in `V2StealthAttestation.issuer` as hex string
- Stores in `MerkleLeafPreimage.issuer_pk_x` as 0x-hex field element

### Circuit (Proof Generation)

- Receives `issuer_pk_x` as private input (BN254 field element)
- Includes in leaf hash: `Poseidon(stealth_pk, schema_id, issuer_pk_x, trait_data_hash, nonce)`
- Binds proof to specific issuer (prevents cross-issuer replay)
- Does NOT verify issuer validity (contract already did)

## Test Vectors

### Vector 1: All Zeros

```
Bytes: 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
Hex:   0x0000000000000000000000000000000000000000000000000000000000000000
```

### Vector 2: Sequential

```
Bytes: 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f 10 11 12 13 14 15 16 17 18 19 1a 1b 1c 1d 1e 1f
Hex:   0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
```

### Vector 3: Max Field Element (BN254_MODULUS - 1)

```
Bytes: 30 64 4e 72 e1 31 a0 26 b8 2b 99 c8 d5 5a 06 16 e6 ff 0c dc 4f ee 0e 17 88 4d 8c 08 3c 05 5c f7
Hex:   0x30644e72e131a0264b82b99c8d55a0616e6ff0cdc4fee0e17884d8c083c055cf7
```

### Vector 4: Realistic (All 0x2a)

```
Bytes: 2a 2a 2a 2a 2a 2a 2a 2a 2a 2a 2a 2a 2a 2a 2a 2a 2a 2a 2a 2a 2a 2a 2a 2a 2a 2a 2a 2a 2a 2a 2a 2a
Hex:   0x2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a
```

## Key Points

✅ **Canonical**: Big-endian 256-bit integer as 0x-hex
✅ **Consistent**: All components use identical encoding
✅ **Documented**: ISSUER_ENCODING.md specifies format
✅ **Tested**: 7 unit tests verify encoding
✅ **Clear**: NOT a BabyJubJub coordinate

❌ **NOT**: BabyJubJub x-coordinate
❌ **NOT**: Full Stellar address
❌ **NOT**: Verified in circuit (contract already verified)
❌ **NOT**: Revealed in proof (private input)

## Encoding Algorithm

```rust
// Input: 32-byte array (Ed25519 public key)
let issuer_bytes: [u8; 32] = [...];

// Step 1: Interpret as big-endian 256-bit integer
// (no transformation needed; bytes are already in big-endian order)

// Step 2: Convert to hex string
let hex = issuer_bytes
    .iter()
    .map(|b| format!("{:02x}", b))
    .collect::<String>();

// Step 3: Add 0x prefix
let field_element = format!("0x{}", hex);

// Result: 0x-prefixed hex string (64 hex digits)
// Example: 0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
```

## Validation Flow

```
1. Contract: Issuer calls attest(schema_id, issuer, ...)
   ↓
2. Contract: Check is_authorized_issuer(schema_id, issuer)
   ↓
3. Contract: If authorized, store attestation with issuer
   ↓
4. Scanner: Extract issuer as 32-byte array from metadata
   ↓
5. Scanner: Check schema.is_authorized_issuer(&issuer_bytes)
   ↓
6. Scanner: If authorized, convert to 0x-hex field element
   ↓
7. Circuit: Receive field element as private input
   ↓
8. Circuit: Include in Poseidon hash (binds proof to issuer)
   ↓
9. Proof: Bound to specific issuer (cannot be replayed with different issuer)
```

## Common Mistakes to Avoid

❌ **Mistake 1**: Treating issuer as BabyJubJub coordinate
✅ **Correct**: Issuer is raw Ed25519 public key (32 bytes)

❌ **Mistake 2**: Using little-endian byte order
✅ **Correct**: Use big-endian (bytes[0] is most significant)

❌ **Mistake 3**: Omitting 0x prefix in JSON
✅ **Correct**: Always use `0x` prefix (e.g., `0x0102...`)

❌ **Mistake 4**: Verifying issuer in circuit
✅ **Correct**: Contract verifies; circuit only commits to value

❌ **Mistake 5**: Revealing issuer in proof
✅ **Correct**: Issuer is private input (hidden in proof)

## References

- **Full Specification**: ISSUER_ENCODING.md
- **Implementation Summary**: ISSUER_ENCODING_IMPLEMENTATION.md
- **Integration Tests**: tests/issuer_encoding_integration.md
- **Changes**: CHANGES_SUMMARY.md

## Questions?

Refer to ISSUER_ENCODING.md for complete specification and examples.
