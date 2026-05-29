# Contract Error Codes Reference

This document defines all error codes returned by Opaque Soroban contracts, their meanings, likely causes, and recommended user-facing messages.

## Error Code Format

Errors are returned as numeric codes in contract invocations. Each contract defines its own error enum, prefixed by the contract name for clarity. When integrating, map these codes to user-friendly messages.

## Attestation Engine v2 (`attestation_engine_v2`)

| Code | Error | Meaning | Likely Cause | User Message |
|------|-------|---------|--------------|--------------|
| 1 | DataTooLarge | Attestation data exceeds maximum size | Data payload is too large (max 4KB typically) | "Attestation data is too large. Please reduce the data size." |
| 2 | UnauthorizedIssuer | Caller is not an authorized issuer | Caller is not in the authorized issuer list | "You are not authorized to issue attestations." |
| 3 | ExpirationInPast | Expiration timestamp is in the past | Provided expiration time has already passed | "Expiration time cannot be in the past." |
| 4 | AttestationNotFound | Referenced attestation does not exist | Attestation ID does not match any stored attestation | "Attestation not found." |
| 5 | AlreadyRevoked | Attestation is already revoked | Attempt to revoke an already-revoked attestation | "Attestation is already revoked." |
| 6 | NotRevocable | Attestation cannot be revoked | Attestation was created as non-revocable | "This attestation cannot be revoked." |
| 7 | Unauthorized | Caller lacks required authority | Caller is not the authority or issuer | "You do not have permission to perform this action." |
| 8 | AttestationAlreadyExists | Attestation with this ID already exists | Duplicate attestation ID | "An attestation with this ID already exists." |
| 9 | NotInitialized | Contract has not been initialized | Contract.init() has not been called | "Contract is not properly initialized." |
| 10 | AlreadyInitialized | Contract is already initialized | Attempt to initialize an already-initialized contract | "Contract is already initialized." |
| 11 | Paused | Contract is paused | Contract operations are paused by administrator | "Contract is currently paused. Please try again later." |
| 12 | InvalidAttestationData | Attestation data format is invalid | Data does not conform to expected schema | "Invalid attestation data format." |
| 13 | SchemaDeprecated | Referenced schema is deprecated | The schema used for this attestation is deprecated | "The attestation schema is deprecated." |
| 14 | SchemaExpired | Referenced schema has expired | The schema used for this attestation has passed its expiry ledger | "The attestation schema has expired." |
| 15 | SchemaNotFound | Referenced schema does not exist | Schema ID does not match any registered schema | "Attestation schema not found." |

## Groth16 Verifier (`groth16_verifier`)

| Code | Error | Meaning | Likely Cause | User Message |
|------|-------|---------|--------------|--------------|
| 1 | InvalidPublicSignal | Public signal does not match proof | ZK proof public signals do not match provided values | "Proof verification failed: public signal mismatch." |
| 2 | Bn128AdditionFailed | BN128 addition operation failed | Cryptographic operation error (should not occur with valid input) | "Proof verification failed: cryptographic error." |
| 3 | Bn128MultiplicationFailed | BN128 multiplication operation failed | Cryptographic operation error (should not occur with valid input) | "Proof verification failed: cryptographic error." |
| 4 | Bn128PairingFailed | BN128 pairing operation failed | Cryptographic operation error (should not occur with valid input) | "Proof verification failed: cryptographic error." |

## Reputation Verifier (`reputation_verifier`)

| Code | Error | Meaning | Likely Cause | User Message |
|------|-------|---------|--------------|--------------|
| 1 | Unauthorized | Caller is not authorized | Proof was not signed by or for the caller | "You are not authorized to verify this proof." |
| 2 | RootExpired | Merkle root has expired | Proof references a root beyond the current rotation period | "Root is expired. Please use a recent proof." |
| 3 | InvalidProof | ZK proof is invalid | Proof does not verify against the circuit | "Proof is invalid." |
| 4 | NullifierUsed | Proof nullifier has already been used | This proof has been verified before (nullifier already consumed) | "This proof has already been used." |
| 5 | AlreadyInitialized | Contract is already initialized | Attempt to initialize an already-initialized contract | "Contract is already initialized." |
| 6 | AttestationExpired | Attestation has expired | Attestation referenced by proof has passed its expiry | "Attestation has expired." |
| 7 | InvalidDatasetHash | Attestation dataset hash does not match | Dataset hash in proof does not match the stored attestation | "Dataset mismatch." |

## Schema Registry (`schema_registry`)

| Code | Error | Meaning | Likely Cause | User Message |
|------|-------|---------|--------------|--------------|
| 1 | NameTooLong | Schema name exceeds maximum length | Name is longer than 256 characters | "Schema name is too long." |
| 2 | FieldDefsTooLong | Field definitions exceed maximum length | Field definitions string is longer than 10KB | "Field definitions are too long." |
| 3 | InvalidSchemaId | Schema ID is not valid | Derived schema ID does not match expected format | "Invalid schema ID." |
| 4 | Unauthorized | Caller is not authorized | Caller is not the schema authority or delegate | "You do not have permission to perform this action." |
| 5 | DelegateLimitReached | Maximum number of delegates exceeded | Schema has reached maximum number of authorized delegates | "Maximum delegates reached for this schema." |
| 6 | DelegateAlreadyExists | Delegate is already authorized | Attempt to add a delegate that is already authorized | "This delegate is already authorized." |
| 7 | DelegateNotFound | Delegate is not found | Attempt to remove a delegate that is not in the list | "Delegate not found." |
| 8 | SchemaAlreadyExists | Schema with this ID already exists | Duplicate schema registration attempt | "A schema with this ID already exists." |
| 9 | InvalidExpiryLedger | Expiry ledger is invalid | Expiry ledger is in the past or zero when required | "Invalid expiry ledger." |
| 10 | InvalidFieldDefs | Field definitions are invalid | Field definitions do not conform to specification | "Invalid field definitions." |
| 11 | EmptyFieldDefs | Field definitions are empty | At least one field must be defined | "Schema must have at least one field." |
| 12 | TooManyFields | Field count exceeds maximum | Schema has more than 255 fields | "Schema has too many fields." |
| 13 | InvalidFieldName | Field name is invalid | Field name does not meet naming requirements | "Invalid field name." |
| 14 | InvalidFieldType | Field type is invalid | Field type is not a recognized type | "Invalid field type." |
| 15 | DuplicateFieldName | Field name is duplicated | Two fields have the same name | "Duplicate field name." |
| 16 | MalformedFieldSegment | Field definition segment is malformed | Field definition string has syntax errors | "Malformed field definition." |

## Stealth Announcer (`stealth_announcer`)

| Code | Error | Meaning | Likely Cause | User Message |
|------|-------|---------|--------------|--------------|
| 1 | InvalidEphemeralKey | Ephemeral key is invalid | Ephemeral public key does not conform to format | "Invalid ephemeral key." |
| 2 | MetadataMissingViewTag | View tag is missing from metadata | Metadata payload does not include required view tag | "Invalid metadata: missing view tag." |
| 3 | InvalidKeyPrefix | Key prefix is invalid | Public key prefix byte is invalid | "Invalid key prefix." |
| 4 | UnsupportedSchemeId | Scheme ID is not supported | Stealth address scheme version is not recognized | "Unsupported stealth address scheme." |
| 5 | InvalidStealthAddressLength | Stealth address length is incorrect | Stealth address has wrong byte length | "Invalid stealth address length." |
| 6 | InvalidStealthAddressEncoding | Stealth address encoding is invalid | Stealth address is malformed or improperly encoded | "Invalid stealth address encoding." |
| 7 | DuplicateLogId | Log ID is duplicated | Attempt to log an event with a duplicate ID | "Duplicate event log ID." |

## Stealth Registry (`stealth_registry`)

| Code | Error | Meaning | Likely Cause | User Message |
|------|-------|---------|--------------|--------------|
| 1 | InvalidMetaAddress | Meta-address is invalid | Meta-address does not conform to format specification | "Invalid meta-address." |
| 2 | InvalidPrefix | Key prefix is invalid | Public key prefix byte does not match expected value | "Invalid key prefix." |
| 3 | SameKeys | Spend and view keys are identical | Spend and view keys cannot be the same | "Spend and view keys must be different." |

## Integration Notes

### Frontend Error Mapping

Frontend applications should map error codes to user-facing messages:

```typescript
const ERROR_MESSAGES: Record<number, string> = {
  // Attestation Engine
  1: "Data is too large",
  2: "You are not authorized",
  3: "Expiration cannot be in the past",
  // ... etc
};
```

### Testing Error Codes

Contract tests should verify that expected error codes are returned for each error condition:

```rust
#[test]
fn test_unauthorized_error() {
  let result = contract.revoke_attestation(attestation_id, unauthorized_caller);
  assert_eq!(result, Err(AttestationError::Unauthorized));
}
```

### Version Compatibility

Error codes are stable across versions. If a new error is added, it receives a new code rather than reusing existing codes. This ensures backward compatibility with existing integrations.
