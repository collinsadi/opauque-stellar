# Integrator API Documentation

This document provides specifications for integrating with Opaque's reputation and stealth payment system. It covers API formats, contract interfaces, nullifier construction, and version compatibility.

## Overview

Opaque provides three core capabilities for external integrators:

1. **Reputation Verification** - Verify privacy-preserving attestations via zero-knowledge proofs
2. **Stealth Payments** - Send payments to stealth addresses that hide recipient identity
3. **Schema Registration** - Register and manage attestation schemas

## Meta-Address Format

A meta-address is the root stealth address that encodes a user's spend and view keys.

### Structure

```
meta-address: {spend_key}:{view_key}
```

### Specification

- **spend_key** (32 bytes): ECDSA public key for payment derivation
- **view_key** (32 bytes): Scalar for linking tag derivation
- **encoding**: Hex format (lowercase), prefixed with `0x`
- **Total length**: 66 characters (0x + 64 hex digits)

### Example

```
0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef:0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210
```

### Validation

Before accepting a meta-address:

```typescript
function validateMetaAddress(metaAddr: string): boolean {
  // Format: 0x{64 hex chars}:{64 hex chars}
  const pattern = /^0x[0-9a-f]{64}:[0-9a-f]{64}$/i;
  return pattern.test(metaAddr);
}
```

## Payment Link Format

Payment links encode stealth payment requests. See [OPAQUE_PAYMENT_LINK_FORMAT.md](./OPAQUE_PAYMENT_LINK_FORMAT.md) for full specification.

### Quick Reference

```
opaque://v1/{network}/{meta-address}
```

### Parameters

| Parameter | Type | Required | Example |
|-----------|------|----------|---------|
| network | string | Yes | `testnet`, `mainnet` |
| meta-address | string | Yes | `0x...{64 hex}:0x...{64 hex}` |

## Proof Request Format

### Reputation Proof Request

To verify a user's reputation, request a proof with the following parameters:

```typescript
interface ReputationProofRequest {
  // User's Stellar address to bind proof to
  verifierAddress: string;
  
  // Attestation ID to prove
  attestationId: string;
  
  // External nullifier (see Nullifier Construction section)
  externalNullifier: string;
  
  // Maximum age in ledgers (optional)
  maxAge?: number;
}
```

### External Nullifier Construction

The external nullifier prevents replay attacks and binds proofs to specific use cases.

**Construction:**

```
external_nullifier = SHA256(
  "opaque-reputation-v1" ||
  verifier_contract_id ||
  use_case_identifier ||
  optional_nonce
)
```

**Parameters:**

- `verifier_contract_id` - Contract ID of the reputation verifier (32 bytes)
- `use_case_identifier` - Your dApp identifier (max 32 bytes, recommend SHA256 of dApp name)
- `optional_nonce` - Session-specific nonce to prevent reuse (optional, recommended)

### Example

```typescript
import { hash } from "@stellar/stellar-sdk";

function constructNullifier(
  verifierContractId: string,
  dappId: string,
  sessionNonce: string
): string {
  const combined = Buffer.concat([
    Buffer.from("opaque-reputation-v1"),
    Buffer.from(verifierContractId, "hex"),
    Buffer.from(dappId, "hex"),
    Buffer.from(sessionNonce, "hex")
  ]);
  return hash(combined).toString("hex");
}
```

**Safety Considerations:**

- Always use a unique nullifier per verification request
- Include a timestamp or nonce to prevent replay
- Use your dApp's canonical identifier consistently
- Never reuse the same nullifier twice

## Contract Interfaces

### Reputation Verifier Contract

Verifies zero-knowledge proofs of reputation.

```typescript
interface ReputationVerifier {
  // Verify a reputation proof
  verify_proof(
    proof: ZkProof,
    external_nullifier: string,
    attestation_id: string
  ): Result<{verified: boolean}, ReputationError>;
  
  // Query if a nullifier has been used (prevents double-use)
  is_nullifier_used(nullifier: string): Result<boolean, ReputationError>;
  
  // Get current Merkle root (used in proof construction)
  get_merkle_root(): Result<Buffer, ReputationError>;
}
```

### Schema Registry Contract

Registers and manages attestation schemas.

```typescript
interface SchemaRegistry {
  // Compute a schema ID for given parameters
  compute_schema_id(
    authority: Address,
    name: string,
    field_definitions: string,
    version: number
  ): Result<string, SchemaError>;
  
  // Retrieve schema details
  get_schema(schema_id: string): Result<Schema, SchemaError>;
  
  // List schemas (filtered by authority)
  list_schemas(authority?: Address): Result<Schema[], SchemaError>;
}
```

### Attestation Engine Contract

Issues and manages attestations.

```typescript
interface AttestationEngine {
  // Issue a new attestation
  issue_attestation(
    schema_id: string,
    subject: Address,
    issuer: Address,
    data: Buffer,
    expires_at: number
  ): Result<string, AttestationError>;
  
  // Verify attestation exists and is not revoked
  verify_attestation(attestation_id: string): Result<Attestation, AttestationError>;
  
  // Revoke an attestation
  revoke_attestation(attestation_id: string): Result<void, AttestationError>;
}
```

## Demo Verifier Integration

### Example: Simple Reputation Check

```typescript
import { Client } from "@stellar/stellar-sdk";

async function verifyReputation(
  client: Client,
  verifierContractId: string,
  userProof: ZkProof,
  attestationId: string,
  dappId: string
): Promise<boolean> {
  // Generate nullifier for this verification
  const nullifier = constructNullifier(
    verifierContractId,
    dappId,
    Date.now().toString()
  );
  
  // Call contract verify_proof method
  const contract = new Contract(verifierContractId);
  const tx = new TransactionBuilder(publicKey, {
    fee: "100",
    networkPassphrase: Networks.TESTNET_NETWORK_PASSPHRASE,
    base: sequenceNumber
  })
    .addOperation(
      contract.call(
        "verify_proof",
        userProof,
        nullifier,
        attestationId
      )
    )
    .build();
  
  const response = await client.submitTransaction(tx);
  return response.result_meta.success();
}
```

### Example: Stealth Payment

```typescript
async function sendStealthPayment(
  client: Client,
  metaAddress: string,
  amount: string,
  fromPublicKey: string
): Promise<string> {
  // Validate meta-address format
  if (!validateMetaAddress(metaAddress)) {
    throw new Error("Invalid meta-address format");
  }
  
  // Derive one-time address from meta-address
  const oneTimeAddress = deriveStealthAddress(metaAddress);
  
  // Send payment to derived address
  const tx = new TransactionBuilder(publicKey, {
    fee: "100",
    networkPassphrase: Networks.TESTNET_NETWORK_PASSPHRASE,
    base: sequenceNumber
  })
    .addOperation(
      Operation.payment({
        destination: oneTimeAddress,
        amount: amount,
        asset: Asset.native()
      })
    )
    .build();
  
  return await client.submitTransaction(tx);
}
```

## Version Compatibility

### Supported Versions

| Version | Network | Status | Support Ends |
|---------|---------|--------|--------------|
| v1 | Testnet | Active | TBD |
| v1 | Mainnet | Active | TBD |

### Version Headers

Include the version in API requests for forward compatibility:

```
X-Opaque-Version: v1
```

### Backward Compatibility

- Error codes are stable across versions
- New features are added in new API endpoints, not by modifying existing ones
- Deprecated features will be announced 6 months in advance

## Error Handling

See [CONTRACT_ERRORS.md](./CONTRACT_ERRORS.md) for complete error code reference.

### Common Errors

| Error | Cause | Recovery |
|-------|-------|----------|
| `InvalidProof` | ZK proof does not verify | Regenerate proof |
| `NullifierUsed` | Nullifier already consumed | Use a new nullifier |
| `RootExpired` | Merkle root is stale | Request fresh proof |
| `Unauthorized` | Proof not bound to caller | Verify proof was constructed correctly |

## Security Best Practices

1. **Nullifiers are Single-Use**: Never reuse a nullifier. Each verification request must have a unique nullifier.
2. **Proof Freshness**: Verify proofs within a reasonable time window (suggest < 1 hour).
3. **Contract ID Pinning**: Hard-code expected contract IDs in your application. Do not read them from user input.
4. **Network Binding**: Ensure proofs are constructed with the correct network identifier.
5. **Root Rotation**: Check proof root age using `get_merkle_root()` and enforce a maximum age.

## Testing

Test your integration against Testnet before mainnet deployment.

### Testnet Contract IDs

Retrieve from: `deployments/v1/testnet.json`

### Test Scenarios

1. Valid proof verification
2. Invalid proof rejection
3. Nullifier reuse prevention
4. Expired proof rejection
5. Unauthorized proof rejection

## Support

For technical issues or questions, open an issue on the [GitHub repository](https://github.com/collinsadi/opauque-stellar).
