# Canonical Schema ID Format

## Algorithm (#44)

```
schema_id = SHA-256(
  authority_bytes
  || name_utf8
  || version_be_u32
  || canonical_field_defs_binary
)
```

| Input | Encoding |
|-------|----------|
| `authority_bytes` | 32-byte raw Ed25519 public key of the authority `Address` |
| `name_utf8` | UTF-8 bytes of the schema name (max 64 bytes) |
| `version_be_u32` | Schema version as 4-byte big-endian unsigned integer |
| `canonical_field_defs_binary` | See [canonical-schema-encoding.md](./canonical-schema-encoding.md) |

The four components are concatenated with no separators before hashing.

## Deriving `authority_bytes` from an address

On Stellar, a G... account address encodes a 32-byte Ed25519 public key via
strkey encoding. Strip the 1-byte version prefix and 2-byte checksum to obtain
the raw 32 bytes, or use the SDK's strkey decode path.

In JavaScript:

```ts
import { StrKey } from '@stellar/stellar-sdk';
const authorityBytes = StrKey.decodeEd25519PublicKey(gAddress); // Uint8Array(32)
```

## Test vectors

All values below are hex-encoded.

### Vector 1 — full cross-language vector

| Field | Value |
|-------|-------|
| `authority_bytes` | `2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a` (32 × `0x2a`) |
| `name_utf8` | `4d79536368656d61` (`"MySchema"`) |
| `field_definitions` | `string name` |
| `canonical_field_defs_binary` | `0105046e616d65` (`count=1`, `type=5`, `len=4`, `"name"`) |
| `version_be_u32` | `00000001` (1) |
| `schema_id` | `9dfa94834360623aa1fdc98ac048339004cf326bb1b49d853e15dc063f6c2547` |

Verified by:

- Rust: `cargo test -p schema-registry derive_schema_id_is_deterministic`
- Rust: `cargo test -p opaque-schema-core schema_id_includes_field_defs`
- JS: `frontend/src/lib/__tests__/schemaEncoding.test.ts`

### Vector 2 — version change produces different ID

Same authority, name, and field definitions as Vector 1 but `version = 2`.  
Expected: output differs from Vector 1.  
Verified by test `derive_schema_id_differs_by_version`.

### Vector 3 — name change produces different ID

Same authority, version, and field definitions as Vector 1 but `name = "Bar"`.  
Expected: output differs from Vector 1.  
Verified by test `derive_schema_id_differs_by_name`.

### Vector 4 — field definition change produces different ID

Same authority, name, and version as Vector 1 but `field_definitions = "u32 name"`.  
Expected: output differs from Vector 1.  
Verified by test `derive_schema_id_differs_by_field_defs`.

## Migration plan

Schemas registered before canonical field-definition binding used client-generated
IDs without enforced derivation or field-def validation. To migrate:

1. **New schemas** — derive the ID off-chain using the formula above (including
   canonical field-definition bytes) before calling `register_schema`. Pass
   `authority_key` (32-byte public key) and the matching `schema_id`.
2. **Existing schemas** — re-register is not possible (`SchemaAlreadyExists`
   guard). Existing schemas remain at their current IDs; the canonical formula
   applies only to schemas created after this change.
3. **Frontend** — `prepareRegisterSchema()` computes the ID from authority,
   name, version, and canonical field definitions before submitting the transaction.

## Legacy note (pre-#44)

Earlier documentation described:

```
schema_id = SHA-256(authority_bytes || name_utf8 || version_be_u32)
```

That formula omitted field definitions. It is retained as `derive_schema_id_legacy`
in the contract for reference only; new registrations must use the #44 formula.
