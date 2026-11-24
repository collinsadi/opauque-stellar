# Integrate: Privacy Pool

End-to-end shielded deposit and withdrawal: deposit XLM into the pool, generate a
zero-knowledge withdrawal proof, and withdraw to any recipient — breaking the
link between deposit and withdrawal. See [Privacy Pool](/concepts/privacy-pool)
for the model.

## Prerequisites

```sh
npm install @opaquecash/stellar "@stellar/stellar-sdk" "@noble/curves@^1" "@noble/hashes@^1" circomlibjs snarkjs
```

- `circomlibjs` — Poseidon hashing for commitments (deposit + withdraw).
- `snarkjs` — Groth16 proof generation (withdraw only).
- **Circuit artifacts** — the v3 `privacy_pool_withdraw.wasm` + `.zkey`, resolved
  via an `ArtifactResolver` (required for `proveWithdraw`).
- A **`NoteStore`** — notes are your spending material; losing one loses the
  funds. Use a persistent store in production (the default is in-memory).

```ts
import { OpaqueClient, keypairSigner, urlArtifactResolver } from "@opaquecash/stellar";

const opaque = new OpaqueClient({
  network: "testnet",
  signer: keypairSigner(process.env.STELLAR_SECRET!),
  artifacts: urlArtifactResolver({ baseUrl: "https://your-cdn.example" }), // serves circuits/v3/*
  storage: { notes: myPersistentNoteStore },                              // implements NoteStore
});
```

## Step 1 — Deposit

`deposit` reads the next leaf index, derives the commitment from fresh secrets,
submits the on-chain deposit, and **persists the note** to your `NoteStore`.

```ts
const { note, txHash } = await opaque.pool.deposit({ amountXlm: "5" });
// note.commitment — the on-chain leaf
// note.nullifier / note.secret — spending material (persisted; back these up!)
```

Back up notes out-of-band — encrypt them with the [backup helpers](/api/) and
store them somewhere the user controls.

## Step 2 — Wait for the roots to cover your deposit

Withdrawals prove against the **published** state + ASP roots, and the pool
itself has to *know* those roots. `isDepositCovered` checks both — plus the
pause flags and tree headroom — in one read, so you never build a witness
against roots the pool will reject:

```ts
const coverage = await opaque.pool.isDepositCovered();
if (!coverage.covered) {
  switch (coverage.reasons[0]) {
    case "no-state-root":
    case "no-asp-root":
      // The ASP/indexer hasn't published a root covering recent deposits yet.
      break;
    case "unknown-state-root":
    case "unknown-asp-root":
      // A root arrived that the contract does not recognise — usually a fork,
      // a stale read, or an ASP publishing ahead of the pool.
      break;
    case "withdrawals-paused":
      // A pause request has passed its timelock. Warn the user; nothing can be
      // withdrawn until it lifts.
      break;
    case "note-not-in-state":
    case "excluded-from-asp":
      // Pass `note` to check one deposit: it is missing from the state tree or
      // the ASP association set, so this note cannot be withdrawn (yet).
      break;
    case "state-root-expired":
    case "asp-root-expired":
      // Only reported when you pass `rootLedgers`; republish/refresh the root.
      break;
  }
  await new Promise((r) => setTimeout(r, 5000));
  // …poll again.
}
```

To see the underlying values — or to check roots you cached earlier rather than
the latest published pair — read them directly:

```ts
const roots = await opaque.pool.getRoots();
// roots.state / roots.asp — Uint8Array (published) or null (not yet)
const known = await opaque.pool.isKnownStateRoot({ root: roots.state! });
const pause = await opaque.pool.getWithdrawalPauseRequest(); // countdown to a pending pause
const minimum = await opaque.pool.getWithdrawalMinimum();    // reject too-small withdrawals early
const capacity = await opaque.pool.getTreeCapacityInfo();    // headroom, as a utilization fraction
const custody = await opaque.pool.getCustody();              // lifetime deposited / withdrawn / held
```

All of these take an optional `source` (the account to simulate the read from),
so a read-only server can serve them without holding the user's key.

## Step 3 — Generate the withdrawal proof

`proveWithdraw` reconstructs the pool's commitment tree from on-chain
Deposit/Withdraw events automatically, builds the witness, and produces a
Groth16 proof bundle. Requires the `artifacts` resolver.

```ts
const proof = await opaque.pool.proveWithdraw({
  note,
  recipient: payoutAddress, // who receives the withdrawn XLM
  // optional: fee, relayer (default 0 / recipient), scope (default pool scope)
});
```

::: tip Faster proving with cached state
`proveWithdraw` reads chain events each call. If you already have the
reconstructed leaves, pass `stateLeaves` + `depositIndices` to skip the read —
get them from `opaque.contracts.privacyPool.reconstructState({ startLedger })`.

That reconstruction is event-paged, so it is bounded. If a pool's history
outgrows the cap, `reconstructState` raises `EventTruncationError` rather than
returning a tree with holes in it (a wrong Merkle root looks like a right one).
Widen the read with `reconstruct: { maxPages }`, or ask for the partial state
explicitly with `onTruncation: "return"`, which hands back
`complete: false` plus the `continuation` cursors to resume from.

Pass the pool's `startLedger` (its deployment ledger) so the read covers the
pool's whole life. Without it the read starts at the oldest retained ledger.
If the RPC has pruned history the pool needs, `reconstructState` raises
`RetentionGapError` rather than building a tree with missing deposits. Pass
`allowRetentionGap: true` to accept the partial result, which then reports
`complete: false` and the `retentionGap` range.
:::

## Step 4 — Withdraw

Submit the proof. On success, mark the note spent so it isn't reused:

```ts
const withdrawTx = await opaque.pool.withdraw({
  proof,
  recipient: payoutAddress,
  noteCommitment: note.commitment, // marks the note spent in your NoteStore
});
```

The contract verifies the proof, enforces nullifier-replay protection and root
validity, and pays the recipient. To withdraw through a market relayer instead of
your own wallet (so the submitting account isn't yours), see
[Relayer Market](/integrate/relayer-market) — you pass this same `proof`.

## Full end-to-end script

```ts
import { OpaqueClient, keypairSigner, urlArtifactResolver } from "@opaquecash/stellar";

const opaque = new OpaqueClient({
  network: "testnet",
  signer: keypairSigner(process.env.STELLAR_SECRET!),
  artifacts: urlArtifactResolver({ baseUrl: ARTIFACT_BASE_URL }),
  storage: { notes: myNoteStore },
});

// 1. deposit
const { note } = await opaque.pool.deposit({ amountXlm: "5" });

// 2. wait for the published roots to be provable against
for (;;) {
  const coverage = await opaque.pool.isDepositCovered();
  if (coverage.covered) break;
  console.log("not provable yet:", coverage.reasons.join(", "));
  await new Promise((r) => setTimeout(r, 5000));
}

// 3. prove + 4. withdraw
const proof = await opaque.pool.proveWithdraw({ note, recipient: PAYOUT });
await opaque.pool.withdraw({ proof, recipient: PAYOUT, noteCommitment: note.commitment });
```

## Notes & errors

- **Full withdrawals only (v1):** the change leaf is a throwaway zero-value
  commitment. Partial withdrawals are a planned follow-up.
- `NotWiredError` from `proveWithdraw` → no `artifacts` resolver configured.
- `RootUnavailableError` / empty roots → the ASP/indexer hasn't published a root
  covering your deposit yet; retry. `isDepositCovered()` reports the same thing
  without throwing, and says which precondition is missing.
- `EventTruncationError` from `reconstructState` / `scanIterator` → the event
  page cap stopped a read with events left unread, so the result would be
  incomplete. `lastScannedLedger` / `continuationCursor` say where to resume.
- `ContractError` on `withdraw` → e.g. nullifier already spent (note reused) or a
  stale root; inspect `.contractCode`.
