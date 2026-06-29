# Schema Authoring Best Practices

This guide helps schema designers create reliable, efficient, and proof-friendly schemas in Opaque. Poor schema design can lead to unprovable claims, bloated proofs, or silent validation failures. Follow these best practices to avoid common pitfalls.

## What Is a Schema?

A schema is a declarative blueprint for a verifiable credential that specifies:

- **Fields:** Name, type, and optional constraints (range, enum, format)
- **Metadata:** Issuer, expiration, and deprecation info
- **Privacy:** Which fields are disclosed and which are hidden

Example:
```json
{
  "issuer": "example.com",
  "fields": [
    { "name": "age", "type": "u32", "min": 0, "max": 150 },
    { "name": "country", "type": "string", "max_length": 3 },
    { "name": "verified", "type": "bool" }
  ],
  "expiration_days": 365
}
```

---

## Field Types & Constraints

### Supported Types

| Type | Size | Use Cases | Constraints |
|------|------|-----------|---|
| `bool` | 1 bit | Flags, yes/no questions | None |
| `u8` | 8 bits | Counts, small integers | None |
| `u32` | 32 bits | Ages, balances, IDs | min, max |
| `u64` | 64 bits | Large integers, timestamps | min, max |
| `bytes32` | 256 bits | Hashes, IDs, public keys | length must be 32 |
| `string` | Variable | Names, descriptions, text | max_length (ASCII only) |

### Best Practices by Type

#### Numeric Types (`u8`, `u32`, `u64`)

**DO:**
- Use the smallest type that fits your range. Age? Use `u8` (max 255). Timestamp? Use `u64`.
- Define explicit `min` and `max` constraints in the schema.
- Keep ranges meaningful (e.g., age 0-150, not 0-4294967295).

**DON'T:**
- Use `u64` for everything; it bloats proof size.
- Leave `min` and `max` unconstrained; the proof verifier needs them.
- Store negative numbers (no `i32`; use unsigned + offset if needed).

**Example:**
```json
{
  "name": "age",
  "type": "u32",
  "min": 0,
  "max": 150,
  "description": "User age in years"
}
```

#### Boolean Type

**DO:**
- Use for binary flags (verified, is_premium, has_document).
- Combine multiple bools only if truly independent.

**DON'T:**
- Use a bool where a 3-value enum would be clearer (pending, approved, denied).

#### String Fields

**DO:**
- Specify `max_length` to bound proof size (strings bloat proofs).
- Use ASCII; UTF-8 support is limited.
- Common max_length values: 64 (email), 50 (name), 3 (country code).

**DON'T:**
- Use unlimited strings; the proof becomes unprovable or huge.
- Store raw JSON in a string field; flatten the structure.

**Example:**
```json
{
  "name": "email",
  "type": "string",
  "max_length": 64,
  "description": "User email address"
}
```

#### Hash / Fixed-Size Binary

**DO:**
- Use `bytes32` for hashes, UUIDs, and public keys.
- Document the hash algorithm (SHA-256, Poseidon, etc.) in the description.

**DON'T:**
- Expect variable-length binary; use `bytes32` only.

#### Deprecated Fields

When removing a field, **DO NOT** delete it immediately. Instead, mark it deprecated and set an expiration:

```json
{
  "name": "legacy_id",
  "type": "u32",
  "deprecated_since": "2025-06-01",
  "deprecated_reason": "Replaced by new_id; discontinue issuance",
  "final_issuance_date": "2025-12-01"
}
```

This allows existing credentials to remain valid while preventing new issuances.

---

## Proof-Friendly Schema Design

### Circuit Constraints

Opaque's circuits verify fields using range proofs and equality checks. Each constraint in your schema becomes a gate in the circuit.

**Rule of Thumb:** Each field with a range constraint (`min`, `max`) adds ~1000 constraints to the circuit.

#### Minimizing Proof Size

1. **Reduce field count:** Only include fields you truly need disclosed.
2. **Use small types:** A `u8` (0-255) generates smaller proofs than `u64`.
3. **Set tight bounds:** `age: u32, min: 0, max: 150` is better than `max: 4294967295`.
4. **Avoid nested objects:** Flatten or split into separate credentials.

#### Proof Generation Times

- Simple schema (3 fields, no range checks): ~100ms
- Moderate schema (8 fields, ranges): ~500ms
- Complex schema (15+ fields, nested): ~2000ms+

**DO** test proof generation on your target device (especially mobile).

### Selective Disclosure Design

When designing a schema, consider which fields will be hidden vs. disclosed:

**DO:**
- Hide sensitive fields (age, balance) by default; show only aggregates (age_over_18).
- Design circuits to prove "age > 18" instead of revealing exact age.
- Use separate credentials for different disclosure contexts.

**DON'T:**
- Disclose all fields in every proof; this defeats privacy.
- Create fields that are useless when hidden (like country, which is often needed).

**Example:** Instead of a single "age" field, design two credentials:

```json
// Credential 1: Full age (issuer stores; only user sees)
{ "name": "age", "type": "u32", "min": 0, "max": 150 }

// Credential 2: Age gate (what verifiers receive)
{ "name": "is_over_18", "type": "bool" }
```

---

## Anti-Patterns to Avoid

### 1. Unbounded Strings

**DON'T:**
```json
{ "name": "bio", "type": "string" }  // No max_length!
```

**DO:**
```json
{ "name": "bio", "type": "string", "max_length": 256 }
```

**Why:** Unbounded strings make proofs unprovable or extremely large.

### 2. Overly Granular Timestamps

**DON'T:**
```json
{ "name": "issued_at", "type": "u64", "max": 9999999999999 }
```

**DO:**
```json
{ "name": "issued_at", "type": "u64", "min": 1704067200, "max": 2147483647 }
// Reasonable range: Jan 2024 to Jan 2038
```

**Why:** Tight bounds reduce proof size and circuit complexity.

### 3. Redundant Fields

**DON'T:**
```json
[
  { "name": "age", "type": "u32", "min": 0, "max": 150 },
  { "name": "age_in_days", "type": "u32", "min": 0, "max": 54750 },
  { "name": "is_adult", "type": "bool" }
]
```

**DO:**
```json
[
  { "name": "age", "type": "u32", "min": 0, "max": 150 },
  { "name": "is_adult", "type": "bool" }  // Computed from age
]
```

**Why:** Redundant fields add proof size and create consistency risks.

### 4. Complex Nested Schemas

**DON'T:**
```json
{
  "name": "address",
  "type": "object",
  "fields": [
    { "name": "street", "type": "string", "max_length": 128 },
    { "name": "city", "type": "string", "max_length": 64 },
    { "name": "country", "type": "string", "max_length": 3 }
  ]
}
```

**DO:** Split into separate fields or separate credentials:
```json
[
  { "name": "street", "type": "string", "max_length": 128 },
  { "name": "city", "type": "string", "max_length": 64 },
  { "name": "country", "type": "string", "max_length": 3 }
]
```

**Why:** Nested objects complicate circuit generation and proofs.

### 5. Vague Expiration

**DON'T:**
```json
{ "expiration_days": null }  // Never expires
```

**DO:**
```json
{ "expiration_days": 365 }  // Expires in 1 year
```

**Why:** Expiration forces credential rotation and limits the impact of stolen credentials.

---

## Practical Checklist

Before finalizing your schema:

- [ ] **Necessity:** Does every field serve a purpose? Remove unused fields.
- [ ] **Type fit:** Is the field type the smallest that fits the range? (`u8` vs. `u32`)
- [ ] **Bounds:** Are `min` and `max` specified for numeric fields? Are ranges tight?
- [ ] **String length:** All strings have `max_length`? (Typically 64 or less)
- [ ] **Expiration:** Is there a reasonable `expiration_days` (not null)?
- [ ] **Privacy:** Which fields will be disclosed? Is that enough for the use case?
- [ ] **Redundancy:** Are any fields derived from others? Consider removing.
- [ ] **Deprecation:** If replacing an old schema, mark old fields deprecated with dates.
- [ ] **Testing:** Tested proof generation on target devices? Times acceptable?
- [ ] **Documentation:** Described the purpose of each field and any constraints?

---

## Testing Your Schema

### Local Validation

Use the CLI to validate and test proof generation:

```bash
opaque-cli schema validate schema.json
opaque-cli schema test-proof schema.json --age 25 --country USA
```

### Integration Testing

1. Deploy schema to testnet (see [docs/INTEGRATOR_QUICKSTART.md](INTEGRATOR_QUICKSTART.md))
2. Generate sample proofs on your target device (web, mobile)
3. Verify proof generation time is acceptable
4. Check proof size (typically 128-256 bytes for modest schemas)

### Performance Targets

| Metric | Target | Warning |
|--------|--------|---------|
| Proof generation time | <1000ms | >2000ms indicates schema complexity |
| Proof size | 128-256 bytes | >512 bytes suggests over-engineering |
| Circuit gates | <10K | >50K indicates potential memory issues on mobile |

---

## Examples

### Simple Credential (KYC)

```json
{
  "issuer": "bank.example.com",
  "name": "KYC Credential",
  "expiration_days": 365,
  "fields": [
    { "name": "full_name", "type": "string", "max_length": 100 },
    { "name": "country", "type": "string", "max_length": 3 },
    { "name": "age", "type": "u32", "min": 0, "max": 150 },
    { "name": "verified", "type": "bool" }
  ]
}
```

### Complex Credential (Financial)

```json
{
  "issuer": "exchange.example.com",
  "name": "Trading Tier",
  "expiration_days": 90,
  "fields": [
    { "name": "account_id", "type": "bytes32" },
    { "name": "daily_limit_usd", "type": "u64", "min": 0, "max": 1000000 },
    { "name": "annual_volume_usd", "type": "u64", "min": 0, "max": 10000000 },
    { "name": "tier", "type": "u8", "min": 1, "max": 5 },
    { "name": "is_kyc_verified", "type": "bool" },
    { "name": "is_aml_clean", "type": "bool" }
  ]
}
```

---

## Further Reading

- **Circuit constraints:** See `circuits/` for underlying ZK implementation
- **Proof verification:** [FORMAL_VERIFICATION_SCOPING.md](FORMAL_VERIFICATION_SCOPING.md)
- **Integration examples:** [docs/integrators/](integrators/)

---

**Last Updated:** 2026-06-28  
**Opaque Version:** stellar main branch
