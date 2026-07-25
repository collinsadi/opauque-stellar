# @opaquecash/stellar

Stealth private payments, privacy pools, relayer-market submission, and on-chain
zero-knowledge reputation for [Stellar](https://stellar.org) / Soroban — in one
framework-free, typed, isomorphic (browser + Node) package.

> Status: pre-release (`0.x`). All layers are implemented and tested: crypto,
> config, signer, RPC, contract bindings, domain services, the high-level
> `OpaqueClient`, Groth16 proof generation (reputation + pool), pure-TS
> announcement scanning, on-chain pool-state reconstruction, and the
> relayer-market gateway. Proving requires circuit artifacts via an
> `ArtifactResolver`; relayer payload encryption requires the optional `tweetnacl`
> peer dependency.

## Install

```sh
npm install @opaquecash/stellar
```

Peer dependencies (install the ones your usage needs):

```sh
# @noble/* must be v1 (the SDK targets the v1 API; v2 is a breaking change)
npm install @stellar/stellar-sdk "@noble/curves@^1" "@noble/hashes@^1"
# pool / reputation proving:
npm install circomlibjs snarkjs
# relayer market:
npm install tweetnacl
```

## Subpath exports

The package is tree-shakeable; import the narrowest surface you need.

| Import | Contents |
|--------|----------|
| `@opaquecash/stellar` | umbrella: `OpaqueClient`, services, bindings, config, signer |
| `@opaquecash/stellar/crypto` | isomorphic primitives, **no chain dependency** |
| `@opaquecash/stellar/relayer-protocol` | relayer wire format, payload hashing, box crypto, gateway client |

## High-level client

```ts
import { OpaqueClient, keypairSigner } from "@opaquecash/stellar";

// Server-side with a raw keypair (browser apps pass a Freighter-backed signer).
const opaque = new OpaqueClient({
  network: "testnet",                       // testnet addresses are baked in
  signer: keypairSigner(process.env.SECRET!),
});

// Stealth payments
const id = opaque.payments.deriveIdentity(walletSignatureHex);
await opaque.payments.register({ metaAddress: id.metaAddress });
await opaque.payments.send({ to: recipientMetaHex, amountXlm: "10" });

// On-chain ZK reputation (bring a precomputed proof until the prover lands)
await opaque.reputation.verifyOnChain(proofBundle);

// Privacy pool
const { note } = await opaque.pool.deposit({ amountXlm: "5" });
await opaque.pool.withdraw({ proof, recipient, noteCommitment: note.commitment });

// Schema administration
const { schemaId } = await opaque.schemas.register({
  name: "credit", fieldDefinitions: "u64 score, bool verified",
  revocable: true, schemaExpiryLedger: 5_000_000,
});

// Escape hatches
opaque.contracts.privacyPool;  // typed contract bindings
opaque.soroban;                // built-in RpcClient (Soroban + Horizon)
```

Override any default (RPC URLs, contract addresses, gateways) via the constructor;
plug your own `NoteStore`/`VaultStore`/`ScanStore`, `Logger`, and `Telemetry`.

## Crypto layer (available now)

```ts
import {
  deriveKeysFromSignature,
  keysToStealthMetaAddress,
  stealthMetaAddressToHex,
  computeStealthAddressAndViewTag,
  checkViewTagMatch,
  reconstructStealthPrivateKey,
  deriveStealthStellarKeypairFromStealthPrivKey,
} from "@opaquecash/stellar/crypto";

// Recipient: derive a stealth meta-address from a wallet signature.
const { viewingKey, spendingKey } = deriveKeysFromSignature(walletSignatureHex);
const { metaAddress } = keysToStealthMetaAddress(viewingKey, spendingKey);
const metaHex = stealthMetaAddressToHex(metaAddress);

// Sender: derive a one-time stealth address + the Stellar account that receives funds.
const send = computeStealthAddressAndViewTag(metaHex);
// -> send.stealthStellarAddress is the G-address to pay.

// Recipient: detect (cheap) then reconstruct the spending key.
if (checkViewTagMatch({ viewingKey, ephemeralPubKey: send.ephemeralPubKey, viewTag: send.viewTag })) {
  const stealthPriv = reconstructStealthPrivateKey({
    viewingKey,
    spendingKey,
    ephemeralPubKey: send.ephemeralPubKey,
  });
  const keypair = deriveStealthStellarKeypairFromStealthPrivKey(stealthPriv);
  // keypair.publicKey() === send.stealthStellarAddress
}
```

Also in `crypto`: privacy-pool note derivation (`deriveDeposit`, `newNoteSecrets`),
schema / attestation codecs (`computeSchemaId`, `encodeAttestationData`), encrypted
backups (`encryptGhostEntries`), payment links (`createPaymentLink`), and memo
validation (`validateMemo`).

## Testing

```sh
npm test          # runs the full vitest suite with coverage (enforced thresholds)
npm run test:e2e  # end-to-end tests only
```

`npm test` generates a coverage report and fails if per-module thresholds are
breached (strictest on the proof- and note-handling modules). Tests that need the
v3 circuit artifacts or a live network are skipped automatically when their
inputs are absent.

### Release gate

`tests/e2e/flagship-flow.e2e.test.ts` exercises the flagship flow end to end —
**announce → scan → deposit → prove → relayed withdrawal** — asserting balances,
nullifier state, and emitted `Deposit` / `Withdraw` events. It is an in-process
simulation of the pool contract (there is no local Soroban sandbox network in
this repo), driving the real SDK services, crypto, and relayer-protocol code.
**This test must pass before cutting a release.**

## Versioning

This package follows semantic versioning and a published deprecation policy —
see [Versioning & Deprecation Policy](./docs/reference/versioning.md) and
[`CHANGELOG.md`](./CHANGELOG.md). Every change to the public API ships with a
changeset and a changelog entry.

## License

MIT
