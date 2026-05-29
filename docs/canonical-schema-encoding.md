# Canonical Schema Encoding (#44 / #45)

This document defines the shared wire formats used by the Soroban contracts,
`opaque-schema-core`, and the frontend.

## Field definitions (human form)

Comma-separated segments of **`type name`** (type first, single space, no extra spaces):

```
bool active,u32 score,string label
```

| Rule | Limit |
|------|-------|
| Allowed types | `bool`, `u8`, `u16`, `u32`, `u64`, `string`, `pubkey` |
| Field names | 1–32 chars, `[a-zA-Z_][a-zA-Z0-9_]*`, unique |
| Max fields | 16 |
| Max stored string length | 256 bytes |

Legacy `name:type` form is **rejected**.

### Canonical binary (for hashing)

```
field_count: u8
repeat field_count times:
  type:     u8   (enum 0..6)
  name_len: u8
  name:     [name_len] utf8 bytes
```

### Canonical stored string

Normalized form with no spaces after commas: `bool active,u32 score`.

## Schema ID (#44)

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
| `authority_bytes` | 32-byte Ed25519 public key (strkey decode of G… address) |
| `name_utf8` | UTF-8 schema name (max 64 bytes) |
| `version_be_u32` | 4-byte big-endian `u32` |
| `canonical_field_defs_binary` | Layout above |

`register_schema` requires `authority_key: BytesN<32>` and rejects a mismatched `schema_id`.

## Attestation payload (#45)

Fields are encoded **in schema order**, big-endian for multi-byte integers:

| Type | Encoding |
|------|----------|
| `bool` | 1 byte: `0` or `1` |
| `u8` | 1 byte |
| `u16` | 2 bytes BE |
| `u32` | 4 bytes BE |
| `u64` | 8 bytes BE |
| `string` | `u16` BE length + UTF-8 (max value 128 bytes) |
| `pubkey` | 32 raw bytes (hex `0x` + 64 hex chars off-chain) |

Max total payload: **512 bytes**. `attest` loads the schema from the registry and validates layout before storage.

## Test vectors

See [schema-id-vectors.md](./schema-id-vectors.md) for cross-language SHA-256 vectors.

Run contract tests:

```bash
cd contracts && cargo test -p opaque-schema-core -p schema-registry -p attestation-engine-v2
```

Run frontend tests:

```bash
cd frontend && npm test -- src/lib/__tests__/schemaEncoding.test.ts
```
