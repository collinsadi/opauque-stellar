# OpaqueClient

The high-level entry point. One config + one signer wires the network, RPC
client, contract bindings, storage, and the domain services.

## Construction

```ts
new OpaqueClient({
  network: "testnet" | "mainnet" | "futurenet" | "local",
  signer?: OpaqueSigner,            // required for writes
  rpcUrls?: string[],               // default: network preset
  horizonUrls?: string[],           // default: network preset
  contracts?: Partial<ContractAddresses>,   // override baked addresses
  relayerGatewayUrls?: string[],
  artifacts?: ArtifactResolver,     // enables proof generation
  storage?: { notes?, vault?, scan? },       // default: in-memory
  logger?: Logger,                  // default: silent
  telemetry?: Telemetry,            // default: no-op
})
```

Testnet contract addresses, pool scope, and relayer parameters are baked in.
Mainnet requires explicit `rpcUrls`, `horizonUrls`, and `contracts`.

## Signers

| Adapter | Use |
|---------|-----|
| `keypairSigner(secretOrKeypair)` | server / Node |
| `callbackSigner({ publicKey, signTransaction })` | Freighter, a hardware wallet, or any custom backend |

See the [hardware wallet guide](/guide/hardware-wallet) for a Ledger-backed
signer, including the blind-signing limitations of Soroban invocations.

## Services

### `payments`
- `deriveIdentity(signatureHex)` — viewing/spending keys + meta-address
- `register({ metaAddress })`
- `prepareTransfer(metaHex)` — one-time address + announcement params
- `send({ to, amountXlm, memo?, feePerOperation? })` — memo required for known custodial destinations; if the payment lands but the announcement fails, throws `UnannouncedPaymentError` with everything needed to retry
- `announcePaidTransfer({ stealthAddress, ephemeralPubKey, metadata })` — retry a failed announcement (`err.toAnnounceParams()` supplies the arguments)
- `scan({ announcements, identity })` — pure-TS, returns matches
- `scanIterator({ identity, startLedger?, cursorKey?, maxPages?, allowTruncation?, allowRetentionGap?, onRetentionGap? })` — async generator, streams matches from chain with a resumable, **per-identity** cursor; a match is yielded once its ledger is fully read, so resumption is exact. Throws `EventTruncationError` rather than returning a partial scan, and `RetentionGapError` when the RPC has pruned ledgers the scan needs
- `scanCursorKey(identity)` — the `ScanStore` key an identity's cursor lives under, derived from the public viewing key (no private key material)
- `sweep({ stealthPrivKey, destination, amountStroops, memo?, feePerOperation? })`
- `sweepWithMerge({ stealthPrivKey, destination })` — merges the stealth account, recovering the full balance including the base reserve; throws `MergeIncompatibleError` for trustlines/offers (fall back to `sweep`)

### `pool`
- `deposit({ amountXlm })` — reads index, derives commitment, persists note
- `withdraw({ proof, recipient, fee?, relayer?, noteCommitment? })`
- `withdrawBatch({ notes, recipient, fee?, relayer? })` — proves + submits multiple notes to one recipient, reports per-note success/failure *(needs `artifacts`)*
- `proveWithdraw({ note, recipient })` — reconstructs leaves from chain *(needs `artifacts`)*
- `getDepositCount()`, `getRoots()`
- `isDepositCovered({ stateRoot?, aspRoot? })` — can a withdrawal be proven right now? reports `reasons` (`no-state-root`, `unknown-asp-root`, `withdrawals-paused`, `tree-at-capacity`, …)
- `isKnownStateRoot({ root })`, `isKnownAspRoot({ root })`
- `isDepositsPaused()`, `isWithdrawalsPaused()`, `getWithdrawalPauseRequest()`, `getWithdrawalMinimum()`, `getCustody()`, `getTreeCapacityInfo()`
- `contracts.privacyPool.reconstructState({ startLedger, maxPages, onTruncation })` — raw leaf reconstruction; `EventTruncationError` at the page cap unless `onTruncation: "return"`

### `reputation`
- `attest({ schemaId, stealthAddressHash, fieldValues, fieldDefinitions, … })`
- `prove({ attestationId, stealthPrivKey, externalNullifier })` *(needs `artifacts`)*
- `verifyOnChain(proof)` — submit to `reputation-verifier`
- `proveAndVerify(input)`
- `getLatestRoot()`

### `schemas`
- `register({ name, fieldDefinitions, revocable, schemaExpiryLedger, … })`
- `attest(…)`, `revoke({ uid })`, `deprecate({ schemaId })`
- `addDelegate(…)`, `removeDelegate(…)`

### `relayer`
- `buildWithdrawPayload({ proof, recipient })`, `buildJobDraft({ payload, fee, deadlineLedger })`
- `deadlineLedger(ledgers?)`, `createJobForDraft(draft)` / `createJob({ … })`
- `advertise(draft)`, `fetchBids(jobIdHex)`, `pickBid(bids)`, `deliverPayload({ draft, bid })`
- `jobStatus(jobIdHex)`, `cancelJob({ jobId })`, `slashJob({ jobId })`

The wire format + gateway client are also exported from
`@opaquecash/stellar/relayer-protocol`.

## Fees

Every transaction path submits with `BASE_FEE` (100 stroops per operation)
unless told otherwise:

- `feePerOperation` — accepted by `payments.send`, `payments.sweep`, and the
  low-level `sendNativeTransfer`. It caps the fee per operation, in stroops;
  stellar-sdk multiplies by the operation count. Raise it to get included
  during congestion.

Stuck transactions can be fee-bumped instead of rebuilt:

```ts
await opaque.feeBumpTransaction({
  feeSigner,                      // pays the bumped fee
  innerTransactionXdr,            // the original signed transaction
  feePerOperation: "5000",        // must exceed the inner fee
});
```

The bump wraps the inner transaction in a new envelope; Horizon replaces the
stalled entry when it lands. `buildFeeBumpXdr` (exported from the rpc module)
builds the envelope without submitting it.

## Escape hatches

```ts
opaque.contracts.privacyPool;  // typed contract bindings
opaque.rpc;                    // ContractInvoker
opaque.soroban;                // built-in RpcClient (Soroban + Horizon), or undefined
```

## Errors

All errors extend `OpaqueError` with a stable `code`: `ConfigError`,
`SignerError`, `RpcError`, `SimulationError`, `ContractError` (carries
`contract` + `contractCode`), `RootUnavailableError`, `ArtifactError`,
`NotWiredError`, `MemoError` (custodial destination without/with invalid
memo), `UnannouncedPaymentError` (payment landed, announcement failed;
carries retry parameters), `MergeIncompatibleError` (merge sweep blocked by
trustlines/offers).
