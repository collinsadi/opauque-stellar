# Schema Authoring Guide

This guide covers the constraints that apply when registering schemas and issuing
attestations on Opaque Stellar. Violating any of these limits at issuance time will
cause the contract to return an error; pre-validating on the client side avoids
wasted transaction fees.

## Attestation payload size limit

The attestation engine enforces a hard cap of **512 bytes** on the encoded payload
(`data` field) of every attestation. This limit is intentionally tight to prevent
footprint blow-ups and protect the network from denial-of-service via large
submissions.

The limit is exposed on-chain via two read-only contract calls:

| Call | Returns |
|---|---|
| `query_metadata_size_limit()` | `u32` — current cap in bytes |
| `get_storage_stats()` | `StorageStats.max_attestation_data_len` |

If a call to `attest()` supplies a payload larger than this cap the contract returns
`MetadataTooLarge` (error code `16`) immediately, before any cross-contract schema
validation runs.

### Payload encoding rules

Fields are packed in declaration order using the canonical binary encoding:

| Field type | Encoded size |
|---|---|
| `bool` | 1 byte |
| `u8` | 1 byte |
| `u16` | 2 bytes |
| `u32` | 4 bytes |
| `u64` | 8 bytes |
| `pubkey` | 32 bytes |
| `string` | 4-byte length prefix + UTF-8 content bytes |

**Worst-case sizing example** — a schema with three `string` fields must fit all
three strings (plus their 4-byte length prefixes) inside 512 bytes. If each string
can be up to 100 characters that is `3 × (4 + 100) = 312 bytes`, safely within
budget. Strings up to `(512 − 3×4) / 3 ≈ 166` characters each will fit.

### Designing schemas to stay within budget

- Prefer fixed-width types (`u32`, `u64`, `pubkey`) over `string` wherever the
  value space is bounded.
- If you need free-form text, store a hash (`pubkey`) on-chain and keep the
  full text off-chain.
- Use the **Attestation Manager** UI in the frontend — it shows a live byte
  budget bar as you fill in field values so you know before submitting whether
  the payload will fit.
- Call `query_metadata_size_limit()` programmatically if you need to adapt to
  future limit changes without hard-coding `512`.

## Field definition length limit

The `field_definitions` string passed at schema registration is capped at
**256 bytes** (`MAX_FIELD_DEFS_STR_LEN`). This covers the textual representation
(`"string name,u64 score"` syntax). The Schema Studio UI shows a live character
counter and prevents submission once this limit is reached.

## Maximum fields per schema

A schema may define at most **16 fields** (`MAX_FIELDS`). Schemas with more fields
will be rejected at registration.

## String field values

Individual `string` field values encoded into an attestation are capped at
**128 bytes** of UTF-8 content (`MAX_STRING_VALUE_LEN`). Values exceeding this
limit will cause `InvalidAttestationData` at issuance time.

## Summary table

| Constraint | Limit | Error returned |
|---|---|---|
| Attestation payload total | 512 bytes | `MetadataTooLarge` (16) |
| Field definitions string | 256 bytes | `InvalidAttestationData` (12) |
| Fields per schema | 16 | parse error at registration |
| Single string field value | 128 bytes | `InvalidAttestationData` (12) |
