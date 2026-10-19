# Getting Started

`@opaquecash/stellar` packages four privacy capabilities for Stellar/Soroban —
stealth payments, privacy-pool deposits/withdrawals, relayer-market submission,
and on-chain ZK reputation — behind one typed `OpaqueClient`.

## Install

```sh
npm install @opaquecash/stellar
```

Peer dependencies (install the ones your usage needs):

```sh
# @noble/* must be v1 (the SDK targets the v1 API; v2 is a breaking change)
npm install @stellar/stellar-sdk "@noble/curves@^1" "@noble/hashes@^1"
# pool / reputation proof generation:
npm install snarkjs circomlibjs
# relayer-market payload encryption:
npm install tweetnacl
```

## Create a client

Testnet contract addresses are baked in. Pass a signer to do anything that
writes on-chain.

```ts
import { OpaqueClient, keypairSigner } from "@opaquecash/stellar";

const opaque = new OpaqueClient({
  network: "testnet",
  signer: keypairSigner(process.env.SECRET!), // or a Freighter-backed signer
});
```

A client built without a `signer` is read-only (scanning, reads, and preparing
payloads still work).

## Send a stealth payment

```ts
// recipient publishes a meta-address derived from a wallet signature
const id = opaque.payments.deriveIdentity(walletSignatureHex);
await opaque.payments.register({ metaAddress: id.metaAddress });

// sender pays the recipient's meta-address
await opaque.payments.send({ to: id.metaHex, amountXlm: "10" });

// recipient scans announcements (read them from the announcer contract events)
const matches = opaque.payments.scan({ announcements, identity: id });
await opaque.payments.sweep({
  stealthPrivKey: matches[0].stealthPrivKey,
  destination,
  amountStroops,
});
```

## Verify a ZK proof on Stellar

```ts
// generate a proof (requires circuit artifacts — see the Node guide)
const proof = await opaque.reputation.prove({
  attestationId,
  stealthPrivKey: id.spendingKey,
  externalNullifier: 42n,
  attestationWitness,
  publisherProof,
});

// verify it inside the reputation-verifier Soroban contract
const txHash = await opaque.reputation.verifyOnChain(proof);
```

## Privacy pool

```ts
const { note } = await opaque.pool.deposit({ amountXlm: "5" });

// withdraw with a precomputed proof bundle
await opaque.pool.withdraw({ proof, recipient, noteCommitment: note.commitment });
```

## What needs extra setup

- **Proof generation** (`reputation.prove`, `pool.proveWithdraw`) needs circuit
  artifacts via an [`ArtifactResolver`](/reference/client). Without one
  these throw `NotWiredError`; you can always pass a precomputed proof to
  `verifyOnChain` / `withdraw`.
- **Relayer payload encryption** needs the optional `tweetnacl` peer dependency.

## Building a payout/custody integration

If you're a platform (exchange, custodial wallet) sending private payouts to
users at scale rather than a single sender/recipient, see
[Custodial Platforms](/integrate/custodial-platforms) for the write-path
flow, batch detection, compliance touchpoints, and key custody patterns.
