# ZK Reputation

A holder can prove they possess an attestation (a trait) without revealing which
stealth identity holds it. The proof is a Groth16 SNARK generated in-process and
**verified inside a Soroban contract** using Stellar's BN254 host functions
(Protocol 25 "X-Ray" and later).

## Flow

1. An authority registers a **schema** (`schema-registry`).
2. An issuer **attests** to a stealth identity under that schema
   (`attestation-engine-v2`).
3. Attestations form a Poseidon Merkle tree whose **root is published** on
   `reputation-verifier`.
4. The holder builds a witness and generates a Groth16 proof, then submits it to
   `reputation-verifier.verify_reputation`, which enforces root validity and
   nullifier-replay protection and calls `groth16-verifier`.

## Public signals (V2)

Canonical order, matching the circuit and contract:

```
[0] merkle_root   [1] attestation_id   [2] external_nullifier   [3] nullifier_hash
```

The **external nullifier** scopes a proof to an application context; the
**nullifier hash** prevents the same identity from proving twice in that context.

## SDK

```ts
// generate (needs circuit artifacts)
const proof = await opaque.reputation.prove({
   attestationId: schemaIdField,
  stealthPrivKey,
  externalNullifier: 42n,
   attestationWitness, // issuerPkX, traitDataHash, nonce for the actual leaf
   publisherProof, // root, pathElements, pathIndices from the publisher
});

// verify on-chain — returns the tx hash; reverts on replay or stale root
const txHash = await opaque.reputation.verifyOnChain(proof);

// or in one call
await opaque.reputation.proveAndVerify({
   attestationId: schemaIdField, stealthPrivKey, externalNullifier: 42n,
   attestationWitness, publisherProof,
});
```

Already have a proof from elsewhere? Pass the bundle straight to `verifyOnChain`
without an artifact resolver.

## Trusted setup

The proving key comes from a development ceremony today. See the
[Security Model](/reference/security#trusted-setup) for the path to an audited
MPC ceremony before mainnet.
