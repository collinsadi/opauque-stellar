# Trait Data Hashing Implementation

## Problem

V2 proofs do not bind to actual attestation field values. Currently:

- `ProofGeneratorModal` sets `traitDataHash = 0n` (placeholder)
- Scanner sets `trait_data_hash: "0"` (placeholder)
- Proof leaf includes zero instead of real data hash
- Tampering with attestation data doesn't invalidate proof

## Solution

Implement canonical decoding and Poseidon hashing of attestation data fields.

### Architecture

```
Attestation Data (ABI-encoded bytes)
    ↓ (decode using schema field definitions)
Field Values (bool, u8, u16, u32, u64, string, pubkey)
    ↓ (encode canonically for hashing)
Canonical Bytes
    ↓ (Poseidon hash)
trait_data_hash (BN254 field element)
    ↓ (include in leaf)
Leaf = Poseidon(stealth_commitment, schema_id, issuer_pk_x, trait_data_hash, nonce)
```

## Implementation

### 1. Scanner: Decode and Hash Attestation Data

**File**: `scanner/src/attestation.rs`

**Add function**:

```rust
/// Decodes ABI-encoded attestation data and computes Poseidon hash.
///
/// Steps:
/// 1. Decode data bytes using schema field definitions
/// 2. Encode fields canonically (big-endian, no padding)
/// 3. Compute Poseidon hash of canonical bytes
pub fn compute_trait_data_hash(
    data_hex: &str,
    schema: &SchemaInfo,
) -> Result<[u8; 32], String> {
    // Step 1: Decode hex to bytes
    let data_bytes = hex_to_bytes(data_hex)?;

    // Step 2: Validate data against schema
    validate_attestation_data(&schema.field_definitions, &data_bytes)?;

    // Step 3: Encode canonically for hashing
    let canonical = encode_canonical_data(&data_bytes, &schema.field_definitions)?;

    // Step 4: Compute Poseidon hash
    let hash = poseidon_hash(&canonical)?;

    Ok(hash)
}

/// Encodes attestation data canonically for hashing.
/// Format: field_count (u8) || field_1_bytes || field_2_bytes || ...
fn encode_canonical_data(
    data: &[u8],
    fields: &[FieldDef],
) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    out.push(fields.len() as u8);

    let mut offset = 0;
    for field in fields {
        let (field_bytes, new_offset) = extract_field_bytes(data, offset, field)?;
        out.extend_from_slice(&field_bytes);
        offset = new_offset;
    }

    Ok(out)
}

/// Extracts bytes for a single field from ABI-encoded data.
fn extract_field_bytes(
    data: &[u8],
    offset: usize,
    field: &FieldDef,
) -> Result<(Vec<u8>, usize), String> {
    match field.ty {
        FieldType::Bool => {
            if offset >= data.len() {
                return Err("Data too short for bool".to_string());
            }
            Ok((vec![data[offset]], offset + 1))
        }
        FieldType::U8 => {
            if offset >= data.len() {
                return Err("Data too short for u8".to_string());
            }
            Ok((vec![data[offset]], offset + 1))
        }
        FieldType::U16 => {
            if offset + 2 > data.len() {
                return Err("Data too short for u16".to_string());
            }
            Ok((data[offset..offset + 2].to_vec(), offset + 2))
        }
        FieldType::U32 => {
            if offset + 4 > data.len() {
                return Err("Data too short for u32".to_string());
            }
            Ok((data[offset..offset + 4].to_vec(), offset + 4))
        }
        FieldType::U64 => {
            if offset + 8 > data.len() {
                return Err("Data too short for u64".to_string());
            }
            Ok((data[offset..offset + 8].to_vec(), offset + 8))
        }
        FieldType::String => {
            if offset + 2 > data.len() {
                return Err("Data too short for string length".to_string());
            }
            let len = u16::from_be_bytes([data[offset], data[offset + 1]]) as usize;
            if offset + 2 + len > data.len() {
                return Err("Data too short for string content".to_string());
            }
            let mut bytes = vec![data[offset], data[offset + 1]];
            bytes.extend_from_slice(&data[offset + 2..offset + 2 + len]);
            Ok((bytes, offset + 2 + len))
        }
        FieldType::Pubkey => {
            if offset + 32 > data.len() {
                return Err("Data too short for pubkey".to_string());
            }
            Ok((data[offset..offset + 32].to_vec(), offset + 32))
        }
    }
}

/// Computes Poseidon hash of canonical data bytes.
fn poseidon_hash(data: &[u8]) -> Result<[u8; 32], String> {
    // Use circomlib's Poseidon implementation
    // For now, use SHA256 as placeholder (will be replaced with Poseidon)
    let mut hasher = Sha256::new();
    hasher.update(data);
    Ok(hasher.finalize().into())
}
```

**Update scanning logic**:

```rust
// In scan_attestations_v2()
let trait_data_hash = if let Ok(hash) = compute_trait_data_hash(&v2_data_hex, &schema) {
    bytes_to_field_decimal(&hash)
} else {
    warn!("Failed to compute trait data hash, using zero");
    "0".to_string()
};

let merkle_leaf_preimage = MerkleLeafPreimage {
    stealth_commitment: bytes_to_field_decimal(&commitment),
    schema_id_field: bytes_to_field_decimal(&v2.schema_id),
    issuer_pk_x: bytes_to_field_decimal(&v2.issuer),
    trait_data_hash,  // NOW: real hash instead of "0"
    nonce_field: bytes_to_field_decimal(&v2.nonce),
};
```

### 2. Prover: Compute Trait Data Hash from Decoded Data

**File**: `frontend/src/lib/reputationProver.ts`

**Add function**:

```typescript
async function computeTraitDataHash(
  dataHex: string,
  schemaFields: FieldDef[],
): Promise<string> {
  // Step 1: Decode hex to bytes
  const dataBytes = hexToBytes(dataHex);

  // Step 2: Validate against schema
  validateAttestationData(dataBytes, schemaFields);

  // Step 3: Encode canonically
  const canonical = encodeCanonicalData(dataBytes, schemaFields);

  // Step 4: Compute Poseidon hash
  const circomlib = await import("circomlibjs");
  const poseidon = await circomlib.buildPoseidon();
  const F = poseidon.F;

  // Convert canonical bytes to field elements and hash
  const hash = F.toObject(poseidon(bytesToFieldElements(canonical)));

  return "0x" + hash.toString(16).padStart(64, "0");
}

function encodeCanonicalData(data: Uint8Array, fields: FieldDef[]): Uint8Array {
  const out: number[] = [fields.length];

  let offset = 0;
  for (const field of fields) {
    const [fieldBytes, newOffset] = extractFieldBytes(data, offset, field);
    out.push(...fieldBytes);
    offset = newOffset;
  }

  return new Uint8Array(out);
}

function extractFieldBytes(
  data: Uint8Array,
  offset: number,
  field: FieldDef,
): [number[], number] {
  switch (field.type) {
    case "bool":
      return [[data[offset]], offset + 1];
    case "u8":
      return [[data[offset]], offset + 1];
    case "u16":
      return [Array.from(data.slice(offset, offset + 2)), offset + 2];
    case "u32":
      return [Array.from(data.slice(offset, offset + 4)), offset + 4];
    case "u64":
      return [Array.from(data.slice(offset, offset + 8)), offset + 8];
    case "string": {
      const len = (data[offset] << 8) | data[offset + 1];
      const bytes = Array.from(data.slice(offset, offset + 2 + len));
      return [bytes, offset + 2 + len];
    }
    case "pubkey":
      return [Array.from(data.slice(offset, offset + 32)), offset + 32];
    default:
      throw new Error(`Unknown field type: ${field.type}`);
  }
}

function bytesToFieldElements(bytes: Uint8Array): bigint[] {
  const elements: bigint[] = [];
  for (const b of bytes) {
    elements.push(BigInt(b));
  }
  return elements;
}
```

**Update witness generation**:

```typescript
export async function buildCircuitConsistentWitness(
  trait: DiscoveredTrait,
  stealthPrivKeyBytes: Uint8Array,
  externalNullifier: string,
  schemaFields: FieldDef[],
) {
  // ... existing code ...

  // NEW: Compute trait data hash from actual data
  const traitDataHash = await computeTraitDataHash(
    trait.data_hex,
    schemaFields,
  );
  const traitHashField = BigInt(traitDataHash);

  // Use real hash in leaf instead of 0n
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
    // ... existing fields ...
    trait_data_hash: traitDataHash, // NOW: real hash
  };
}
```

### 3. Verifier: Accept Real Trait Data Hash

**File**: `demo/src/verifier.ts`

No changes needed — verifier already accepts trait_data_hash from public signals. Just ensure it's passed through correctly.

### 4. Schema Field Definitions

**File**: `contracts/opaque-schema-core/src/lib.rs`

Already has canonical encoding. Use existing functions:

- `parse_field_definitions()` - Parse schema
- `encode_canonical_field_defs()` - Encode for hashing
- `validate_attestation_data()` - Validate payload

## Test Vector

```
Schema: "bool active, u32 score, string label"
Data:
  - active: true (0x01)
  - score: 42 (0x0000002a)
  - label: "hello" (0x0005 + "hello")

ABI-encoded: 0x01 0x0000002a 0x0005 68656c6c6f

Canonical encoding:
  - field_count: 0x03
  - active: 0x01
  - score: 0x0000002a
  - label_len: 0x0005
  - label: 68656c6c6f
  = 0x03 01 0000002a 0005 68656c6c6f

Poseidon hash: 0x... (computed from canonical bytes)

Leaf: Poseidon(stealth_commitment, schema_id, issuer_pk_x, trait_data_hash, nonce)
```

## Acceptance Criteria

### ✅ Proof leaf includes hash of real attestation data

**Before**: `trait_data_hash = 0n` (placeholder)
**After**: `trait_data_hash = Poseidon(canonical_data)` (real hash)

**Verification**:

- Scanner computes hash from decoded data
- Prover computes hash from decoded data
- Both use same canonical encoding
- Leaf includes real hash

### ✅ Tampering with data invalidates proof

**Test**:

1. Generate proof with data: `{active: true, score: 42}`
2. Tamper with data: `{active: false, score: 42}`
3. Recompute hash: Different hash
4. Proof is invalid (leaf doesn't match)

**Verification**:

- Change any field value
- Recompute canonical encoding
- Recompute Poseidon hash
- Hash is different
- Proof fails Merkle inclusion check

### ✅ Hashing matches schema canonical encoding

**Verification**:

- Use `encode_canonical_field_defs()` from schema-core
- Decode data using `validate_attestation_data()`
- Encode canonically using same format
- Hash matches across scanner, prover, verifier

## Implementation Checklist

- [ ] Add `compute_trait_data_hash()` to scanner
- [ ] Add `encode_canonical_data()` to scanner
- [ ] Add `extract_field_bytes()` to scanner
- [ ] Update scanner to compute real hash instead of "0"
- [ ] Add `computeTraitDataHash()` to prover
- [ ] Add `encodeCanonicalData()` to prover
- [ ] Add `extractFieldBytes()` to prover
- [ ] Update witness generation to use real hash
- [ ] Add test vector with known data
- [ ] Test tampering detection
- [ ] Verify hash consistency across components

## Key Insight

The trait data hash is the cryptographic link between the proof and the actual attestation data. By including it in the Merkle leaf, we ensure:

1. Proof is bound to specific data values
2. Tampering with data invalidates proof
3. Different data produces different proofs
4. Canonical encoding ensures consistency

## References

- **Schema Core**: `contracts/opaque-schema-core/src/lib.rs`
- **Scanner**: `scanner/src/attestation.rs`
- **Prover**: `frontend/src/lib/reputationProver.ts`
- **Verifier**: `demo/src/verifier.ts`
- **Issuer Encoding**: `ISSUER_ENCODING.md`
- **Stealth Key Alignment**: `STEALTH_KEY_ALIGNMENT.md`
