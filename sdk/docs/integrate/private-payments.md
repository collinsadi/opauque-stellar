# Integrate: Private Payments

A complete, end-to-end walkthrough of a stealth XLM payment — from both the
**sender** and **recipient** sides. By the end you'll have funds sent to a
recipient's published meta-address, detected by the recipient, and swept to a
fresh account, with no on-chain link between sender and recipient.

See [Stealth Payments](/concepts/stealth-payments) for the cryptography behind
this. Every method used here is in the [API reference](/api/).

## Prerequisites

```sh
npm install @opaquecash/stellar "@stellar/stellar-sdk" "@noble/curves@^1" "@noble/hashes@^1"
```

```ts
import { OpaqueClient, keypairSigner, buildDomainSeparatedMessage } from "@opaquecash/stellar";

const opaque = new OpaqueClient({
  network: "testnet",
  signer: keypairSigner(process.env.STELLAR_SECRET!), // or a Freighter signer in the browser
});
```

The signer's account pays for and authorizes on-chain calls (registering the
meta-address, announcing transfers). It is never linked to the funds the
recipient ultimately controls.

## Step 1 — Recipient derives a stealth identity

The recipient derives a viewing key + spending key from a **single signature**
used as entropy. Sign a stable, domain-separated message once and reuse it.

```ts
// The message is informational entropy — signing it moves no funds.
const message = buildDomainSeparatedMessage({
  origin: "https://your-app.example",
  networkPassphrase: opaque.config.passphrase,
  walletPublicKey: await opaque.signer!.publicKey(),
  purpose: "stealth-keys",
});

// Browser (Freighter): const { signedMessage } = await signMessage(message)
// Server: sign the message bytes with your keypair.
const signatureHex = signMessageSomehow(message); // hex string

const identity = opaque.payments.deriveIdentity(signatureHex);
// identity.viewingKey  (Uint8Array) — detects incoming transfers
// identity.spendingKey (Uint8Array) — controls the funds (keep secret)
// identity.metaAddress (Uint8Array, 66 bytes)
// identity.metaHex     (0x… 134 chars) — this is what senders use
```

::: warning Persist the identity
Re-deriving requires the **same signature**. Persist either the signature or the
derived keys (encrypted) so the identity is stable across sessions. The same
signature always yields the same identity.
:::

## Step 2 — Recipient publishes the meta-address

Register the meta-address on the stealth-registry so senders can look it up
(or share `identity.metaHex` directly / via a [payment link](/api/)):

```ts
await opaque.payments.register({ metaAddress: identity.metaAddress });
```

## Step 3 — Sender pays the meta-address

The sender needs only the recipient's `metaHex`. `send` derives a one-time
stealth account, funds it, and publishes an announcement so the recipient can
find it:

```ts
const result = await opaque.payments.send({
  to: recipientMetaHex,   // identity.metaHex from the recipient
  amountXlm: "10",
});
// result.stealthStellarAddress — the one-time account that received the XLM
// result.paymentTxHash         — the XLM transfer
// result.announceTxHash        — the on-chain announcement
```

Each call derives a **fresh** stealth address, so repeated payments to the same
recipient are unlinkable on-chain.

::: tip Build the transfer without sending
Need the stealth address before paying (e.g. to show the user)? Use the pure
helper: `const t = opaque.payments.prepareTransfer(recipientMetaHex)` returns
`{ stealthStellarAddress, ephemeralPubKey, stealthAddress, viewTag, metadata }`
without touching the network.
:::

## Step 4 — Recipient scans for incoming transfers

`scanIterator` reads announcements from the stealth-announcer contract and
**matches** them against the recipient's keys (pure crypto, no network),
yielding each transfer addressed to this identity once its ledger is fully read.
A page can end partway through a ledger, so matches from the newest ledger
wait until the scan moves past it. That keeps resumption exact: nothing is
skipped and nothing is yielded twice.

<<< @/snippets/private-payments.ts#scan

Only transfers addressed to this identity are yielded. A coincidental view-tag
collision is rejected (it confirms by recomputing the stealth id), so matches
are exact. `break` out of the loop to stop without reading further pages.

The scan follows the RPC's event cursor to the end of the range. Soroban RPC can
return empty pages before the ones holding events, so an empty page does not
end the scan. The cursor is persisted to the client's `ScanStore` after every
page and is **keyed per identity**, so one client can watch many identities
without one identity's scan resuming past another's payments. A range with no
announcements still counts as scanned, so quiet ledgers are not re-read on
every run.

Scans are event-paged and bounded: a scan that hits the page cap raises
`EventTruncationError` (transfers may be missing) with `lastScannedLedger` and
`continuationCursor`, rather than reporting a partial result as a complete one.
The persisted cursor stays at the last ledger read in full, so calling
`scanIterator` again resumes there. Pass `allowTruncation: true` only if a gap
is acceptable to you.

A scan that starts in history the RPC has pruned raises `RetentionGapError`,
because those announcements can never be read. A cursor saved long ago can hit
this too. Start from a retained ledger with `startLedger`, or pass
`allowRetentionGap: true` with `onRetentionGap` to continue and record the
pruned range.

::: details Supplying your own announcements
`payments.scan({ announcements, identity })` matches an announcement list you
supply. To read the list from chain yourself, page through the announcer's
events with `contracts.stealthAnnouncer.scanEvents()`. It yields one page per
`getEvents` response, empty ones included, and stops only when the range
drains:

<<< @/snippets/private-payments.ts#fetch

This path does not read or write the `ScanStore` cursor; track the resume
point yourself: on the page with `complete: true`, resume at `endLedger + 1`.
:::

## Step 5 — Recipient sweeps the funds

Move the funds from the one-time stealth account to a destination the recipient
controls. The stealth account signs **itself** (derived from the one-time key),
so the connected wallet is never the source.

The preferred path is a **merge sweep**: `accountMerge` deletes the stealth
account and moves the *entire* balance — including the ~0.5–1 XLM base reserve
a payment-based sweep strands in every swept account:

```ts
import { parseXlmToStroops } from "@opaquecash/stellar";

await opaque.payments.sweepWithMerge({
  stealthPrivKey: matches[0].stealthPrivKey,
  destination: myMainAccount,
});
```

If the stealth account holds state a merge cannot delete (a trustline or open
offer), `sweepWithMerge` throws `MergeIncompatibleError` — fall back to a
partial sweep that reserves the base reserve and fee:

```ts
await opaque.payments.sweep({
  stealthPrivKey: matches[0].stealthPrivKey,
  destination: myMainAccount,
  amountStroops: parseXlmToStroops("9.9"), // reserve some for fees/min-balance
});
```

Compute `amountStroops` from the account balance minus the Stellar base reserve
and fee. Querying the stealth account's spendable balance:
`opaque.soroban?.horizon().loadAccount(matches[0].stealthStellarAddress)`.

## Full end-to-end script

<<< @/snippets/private-payments-e2e.ts#full

## Errors to handle

| Error | When | Handling |
|-------|------|----------|
| `SignerError` | an operation needs a signer but none/invalid | construct the client with a `signer` |
| `RpcError` | network/RPC failure | retry; the client already retries reads |
| `SimulationError` | a contract call fails pre-flight | inspect `.diagnostics` |

All extend `OpaqueError` with a stable `.code`. See [errors in the API reference](/api/).
