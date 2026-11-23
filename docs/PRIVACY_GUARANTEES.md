# Formal Privacy Guarantees

Issue: #647 — *Add formal privacy guarantees document* (restored and updated
for #1090).

> **Status:** Experimental, unaudited software. This document states what
> the protocol is *designed* to guarantee and its precise boundaries — it is
> not an audit result and carries the same caveats as
> [`DISCLAIMER.md`](../DISCLAIMER.md).

Each property below states what a defined adversary **can** and **cannot**
learn, any known weakening of that guarantee, and the component that
enforces it. This supersedes informal privacy statements elsewhere in the
repo (README § Privacy, `frontend/src/lib/privacyThreatModel.ts`) as the
precise reference — those remain useful as UI-facing summaries of the same
facts.

## Adversary models

| Adversary | Capability |
|---|---|
| **Chain observer** | Reads all public Soroban ledger state: contract events, transaction envelopes, amounts, timestamps, source/fee-payer accounts. Cannot see anything not committed on-chain. |
| **RPC / Horizon operator** | Everything a chain observer sees, plus the query patterns of clients connecting through it: which contract/method/args a specific IP address requests, and when. |
| **Wallet software (Freighter)** | Sees every signing request it's asked to approve, tied to the connected G-address. Trusted not to exfiltrate, but is a single point of observation for all of a user's Opaque actions. |
| **Client-side compromise (XSS / malicious extension)** | Can read runtime memory, the DOM, and `localStorage` of an open Opaque tab while the user is active. |
| **Proof verifier / relying party** | Sees exactly the public signals of a submitted Groth16 proof — nothing about the private witness beyond what those signals encode. |
| **Reputation publisher** | Receives the leaf-submission body and root inquiries described in [Publisher data flow](#publisher-data-flow), plus ordinary HTTP metadata (source IP, request timing, and configured auth/rate-limit identifiers). It does not receive private witness values, private keys, or raw attestation content. |

## Properties

### P1 — Receive address unlinkability

**Statement:** Each incoming payment is sent to a fresh, one-time Stellar
account derived via DKSAP (Dual-Key Stealth Address Protocol) from the
recipient's public meta-address and a random ephemeral key.

- **Cannot learn:** A chain observer cannot derive the recipient's
  persistent meta-address, or link two separate stealth receives to the
  same recipient, from the announcement/address data alone.
- **Can learn:** That a payment occurred, its amount, its timing, and the
  sender's account (see P2/P3 below — this property covers *address*
  linkability only).
- **Known weakening:** Distinctive timing or amount patterns across
  multiple receives can still allow statistical correlation by a
  sophisticated observer; the protocol does not add cryptographic timing
  or amount obfuscation in v1.
- **Enforced by:** `frontend/src/lib/stealth.ts` (DKSAP derivation),
  `contracts/stealth-registry` (meta-address registration),
  `contracts/stealth-announcer` (per-payment announcement). Manual ghost
  announcements additionally use a distinct derived fee payer; see
  [Ghost announcer funding](#ghost-announcer-funding).

### P2 — Sender / fee-payer visibility (explicit non-guarantee)

**Statement:** The account that pays for and signs a stealth payment
(`createAccount`/payment + `announce()`) is a normal, public Stellar source
account.

- **Cannot learn:** Nothing is hidden here — this is not a guarantee, it is
  a stated boundary.
- **Can learn:** Any chain observer sees exactly who sent a given stealth
  payment, when, and for how much. Opaque never obscures the sender of the
  funding payment. The one exception is the separate `announce()` fee payer
  for a manual ghost, which is a one-time announcer account funded from the
  ghost rather than from the connected wallet; see
  [Ghost announcer funding](#ghost-announcer-funding). The funding transfer
  from the ghost to that announcer remains public.
- **Known weakening:** N/A — always true, by design; see
  [Custodial Platforms](https://github.com/collinsadi/opauque-stellar/blob/main/sdk/docs/integrate/custodial-platforms.md)
  § Association set and policy implications for what this means for
  platform integrators specifically.
- **Enforced by:** The Stellar ledger itself (outside protocol control);
  documented in `DISCLAIMER.md` § Metadata leakage and
  `privacyThreatModel.ts`'s `PRIVACY_NOT_HIDDEN`.

### P3 — Amount and timing exposure (explicit non-guarantee)

**Statement:** On-chain payment amounts and ledger close times are public
to any chain observer, unconditionally.

- **Cannot learn:** Nothing is hidden here either — stated as a boundary,
  not a guarantee.
- **Can learn:** Exact amount and timestamp of every stealth payment.
  Unusual privacy-pool deposit amounts can also narrow the set of deposits
  that could fund a later withdrawal; see
  [Pool deposit linkability](#pool-deposit-linkability).
- **Known weakening:** N/A — always true. `privacyThreatModel.ts` lists this
  as mitigation `M14`, whose actual mitigation is "user education", i.e.
  there is no cryptographic shielding of amount or timing in v1.
- **Enforced by:** N/A (inherent to a public ledger); see `DISCLAIMER.md` §
  Metadata leakage.

### P4 — Scan privacy via view tags (partial guarantee)

**Statement:** Announcements carry a 1-byte view tag that lets a recipient's
scanner cheaply rule out ~255/256 of irrelevant announcements before running
full DKSAP derivation.

- **Cannot learn:** From the view tag alone, an observer cannot determine
  which specific announcements belong to a given recipient — it is a
  256-way-ambiguous filter, not an identifier.
- **Can learn:** An RPC/Horizon operator still sees *that* a specific client
  IP is polling announcement events, and roughly how often — this is
  metadata about scan activity, not about which payments are the client's.
- **Known weakening:** Self-hosting your own RPC endpoint (`M15` in
  `privacyThreatModel.ts`) removes this leak; it is not the default
  configuration.
- **Enforced by:** `scanner/src/scanner.rs` (view-tag prefilter, `M2`/`M3`),
  `frontend/src/lib/stealth.ts` (`keccak_256(sharedSecret)[0]`),
  `contracts/stealth-announcer` (`metadata[0]` view tag field).

### P5 — Reputation proof selective disclosure

**Statement:** A submitted Groth16 reputation proof reveals only its
circuit-defined public signals to the on-chain verifier. The live
`verify_reputation` entrypoint uses the 4-signal V2 layout
(`merkle_root, attestation_id, external_nullifier, nullifier_hash`, checked
via `Groth16Verifier.verify_proof_v2`) — see
[ZK Reputation](https://github.com/collinsadi/opauque-stellar/blob/main/sdk/docs/integrate/reputation.md).
`Groth16Verifier` also exposes a generic 5-signal `verify_proof` and a
6-signal `verify_proof_v3` (used by the privacy pool's withdraw circuit,
not the reputation flow); neither changes what this property covers.

This property describes the **proof verifier**, not the off-chain publisher
that supplies the Merkle inclusion path. The publisher sees the additional
submission fields listed in [Publisher data flow](#publisher-data-flow),
and the on-chain submission is made by the connected wallet:
`submitProofOnChain` passes the wallet public key as `user`, and
`verify_reputation` emits that address with the attestation ID, nullifier,
and root. Those are separate observations from the proof's public signals.

- **Cannot learn:** The verifier learns nothing about the underlying
  attested private trait data, the prover's stealth or spend keys, or which
  specific leaf of the reputation Merkle tree the prover holds, beyond what
  the public signals encode.
- **Can learn:** Whichever fields the circuit designates public — notably
  `attestation_id` (which schema this proof pertains to) is always
  disclosed. The connected wallet address, root, external nullifier,
  nullifier hash, and event metadata are public at submission. See P7 for
  why schema disclosure matters for anonymity-set size.
- **Known weakening:** Circuit correctness itself (that the circuit
  actually enforces "prover holds a valid, unrevoked, unexpired attestation
  under this root" and nothing weaker) is **out of scope** for on-chain
  verification. The on-chain verifier only checks the proof is valid for the
  *stated* public signals; it trusts the circuit to have encoded the right
  statement.
- **Enforced by:** `contracts/groth16-verifier` (`verify_proof_v2`, invoked
  from `contracts/reputation-verifier`'s `verify_reputation`),
  `circuits/v2/stealth_reputation.circom`, `frontend/src/lib/reputationProver.ts`.

#### Publisher data flow

When a trait is proved, `ProofGeneratorModal` first computes the leaf
locally, then calls `submitLeafAndFetchInclusion`
(`frontend/src/components/ProofGeneratorModal.tsx:263-285`) before building
the witness against the publisher's root and path. The request is defined in
`frontend/src/lib/reputationPublisher.ts:12-19,60-83`:

```http
POST {VITE_REPUTATION_PUBLISHER_URL}/v1/reputation/leaves
Content-Type: application/json
```

The JSON body is exactly the `ReputationLeafSubmission` object assembled at
the call site:

| Field | Value supplied by the wallet | Privacy consequence |
|---|---|---|
| `id` | `trait.attestationUid` when present, otherwise the computed `leafHex` | An attestation UID is a stable public identifier; the fallback is the same value as `leaf`. |
| `leaf` | `draft.leafHex`, the Poseidon leaf commitment | A commitment to private witness values, not the raw attestation content, but it is stable and can be looked up later. |
| `schemaId` | `bigintToHex32(stringToBigInt(trait.merkleLeafPreimage.schemaIdField))` | Reveals the attestation schema to the publisher, matching the disclosed `attestation_id` in the proof. |
| `attestationUid` | `trait.attestationUid` | Optional; when present, a stable identifier for indexing. |
| `txHash` | `trait.txHash` | Optional but normally present; already public on Stellar, but here it is sent directly with the leaf and schema. |
| `ledger` | `trait.slot` | Optional but normally present; the ledger slot of that public transaction. |

`JSON.stringify` omits fields whose value is `undefined`. The client helper
also defines an `x-reputation-signature` header over
`{ id, leaf, timestamp }` (`frontend/src/lib/reputationPublisher.ts:43-73`);
that authentication step is separate from the body fields above. The
publisher's server-side validation expects a holder signature bound to the
attestation UID, schema ID, and leaf (`publisher/src/http.ts:140-149`). The
publisher then returns an inclusion record (`leafIndex`, `leafCount`,
`root`, `datasetHash`, and the Merkle path); a later
`GET /v1/reputation/root/{leaf}` can query the same leaf.

**Boundary:** the publisher cannot reconstruct raw attestation content,
private trait data, stealth/spend keys, or the proof witness from this
request. It *can* correlate the leaf, schema ID, UID, transaction hash, and
ledger with public chain data and with the source IP/timing of the request;
`txHash` and `ledger` being public does not make that correlation invisible.
Treat the publisher as a party that sees proof-submission metadata, not as
a party that sees only the four proof public signals.

### P6 — Nullifier unlinkability across contexts, linkability within one

**Statement:** `nullifier_hash` is scoped by both a per-identity nullifier
secret and the `external_nullifier` (context) value.

- **Cannot learn:** Whether the same underlying identity produced proofs in
  two *different* contexts (different `external_nullifier` values) — those
  nullifier hashes are computationally unrelated to an observer.
- **Can learn:** Whether the *same* nullifier was used twice within one
  context — this is intentional: it's how replay is detected and rejected
  (`NullifierUsed`).
- **Known weakening:** None beyond the above — this is working as designed,
  not a compromise.
- **Enforced by:** `contracts/reputation-verifier` (per-nullifier storage
  check and `NullifierUsed` rejection inside `verify_reputation`), circuit
  nullifier derivation in `circuits/`.

### P7 — Anonymity-set size is structural, not protocol-guaranteed

**Statement:** The strength of P5's "cannot learn which leaf" guarantee is
bounded by how many leaves exist under the proven root that share the
disclosed `attestation_id`/schema — not by anything the ZK circuit itself
adds.

- **Cannot learn:** Precisely which leaf/holder produced a given proof.
- **Can learn (structural weakening):** The disclosed `attestation_id`
  narrows the possible set to holders of *that specific* attestation
  schema. If an issuer has only issued a handful of attestations under that
  schema, the effective anonymity set is that small — trivially so if it's
  1–2 holders. The circuit and verifier make no attempt to enforce a
  minimum set size. The publisher's `leafCount` response discloses the
  current tree size but does not strengthen that set.
- **Responsible for this boundary:** Issuers and platforms choosing schema
  granularity, not the ZK circuit. See
  `contracts/schema-registry` (schema definitions) and
  `contracts/attestation-engine-v2` (issuance volume per schema) — this is
  the parameter that actually controls real-world privacy strength for a
  given proof. Platform integrators: see
  [Custodial Platforms](https://github.com/collinsadi/opauque-stellar/blob/main/sdk/docs/integrate/custodial-platforms.md)
  § Association set and policy implications before making privacy claims
  about proofs tied to low-volume schemas.

### P8 — Local key custody boundary

**Statement:** Master viewing/spending keys are derived on-device from a
wallet signature and held in memory only; encrypted backups and ghost-key
stores protect data at rest only when a password is configured.

- **Cannot learn (network/server adversary):** A remote adversary with no
  device access can never observe a user's master keys — the protocol has
  no server-side custody of any kind (`frontend/src/context/KeysContext.tsx`
  keeps master keys in memory only, never persisted).
- **Can learn (local/device adversary):** An XSS or malicious extension
  active in the tab can read master keys from memory while the session is
  active. Pool-note backups use the shared PBKDF2-SHA256 configuration
  (`frontend/src/lib/kdfConfig.ts`, 600,000 iterations) and encrypted
  backup format, but passive `localStorage` exfiltration can read ghost
  entries in plaintext when no ghost password has been set
  (`frontend/src/store/ghostAddressStore.ts:118-126`); an active compromise
  that captures a password or reads runtime memory defeats encryption at
  rest regardless.
- **Known weakening:** These are documented scope limits, not hidden
  defects. Disconnect cleanup wipes local Opaque state
  (`frontend/src/lib/disconnectCleanup.ts`), but it cannot undo data already
  copied elsewhere.
- **Enforced by:** `frontend/src/context/KeysContext.tsx`,
  `frontend/src/lib/kdfConfig.ts`, `frontend/src/lib/poolNoteBackup.ts`,
  `frontend/src/lib/ghostCrypto.ts`, `frontend/src/lib/disconnectCleanup.ts`.

### P9 — Reputation root authenticity is an admin trust boundary

**Statement:** Proof verification correctness is only as good as the
Merkle root the `reputation-verifier` admin published — the protocol does
not cryptographically prove the off-chain dataset behind a root was built
fairly or completely.

- **Cannot learn (any party, without independent audit):** Whether a given
  root's underlying dataset fairly includes/excludes accounts, from on-chain
  data alone.
- **Can learn:** Root publications are public on-chain. `get_root_history`
  returns up to the most recent 100 roots; each publication also emits a
  `MerkleRootPublished` event containing the root and `dataset_hash`. These
  allow ex-post independent audit of what was published and when, but do not
  prevent a dishonest root from being published in the first place.
- **Known weakening:** The admin can publish an arbitrary root at any time —
  `update_merkle_root` only checks that the caller matches the configured
  admin address, not that the underlying dataset is fair or complete. Admin
  transfer is enforced on-chain (`transfer_admin`), and an admin-triggered
  freeze of proof generation is currently UI gating via
  `frontend/src/hooks/useFreezeStatus.ts`, not an enforced on-chain contract
  state. This is a named trust assumption, not a bug.
- **Enforced by:** `contracts/reputation-verifier` (`update_merkle_root`,
  `transfer_admin`, `get_root_history`, `MerkleRootPublished`),
  `frontend/src/hooks/useFreezeStatus.ts`.

### P10 — Claim destination and memo linkage (partial guarantee)

**Statement:** Withdrawing a stealth or pool balance to a connected or
already-used address creates a public link between that destination and the
funds being claimed.

- **Cannot learn:** The UI does not pre-fill the claim destination with the
  connected wallet; choosing it requires explicit acknowledgement in the
  claim form.
- **Can learn:** A user can still type the main wallet or any reused address
  manually, and the claim warns rather than disables submission. A memo
  attached for a custodial destination is public and can link the claim to
  an off-chain account or support conversation.
- **Known weakening:** The acknowledgement is a UI guard, not a protocol
  rule. Prefer a fresh address and an empty memo when privacy matters.
- **Enforced by:** `frontend/src/lib/destinationPrivacy.ts`,
  `frontend/src/lib/destination-memo.ts`, `frontend/src/components/ClaimModal.tsx`,
  `frontend/src/components/PrivateBalanceView.tsx`.

### P11 — Horizon history sync (opt-in disclosure)

<a id="horizon-history-sync"></a>

**Statement:** Transaction history is stored locally. Rebuilding it from
chain sends queries to Horizon and discloses the addresses being queried.

- **Cannot learn:** A fresh or cleared device does not query Horizon until
  the user clicks **Sync from chain** or opts in with **Rebuild history from
  chain automatically on this device**. The opt-in is saved on that device
  and is off by default.
- **Can learn:** A sync queries Horizon for the connected wallet's payments
  and account creations and for ghost addresses owned by that same account.
  Each address is queried separately, so a ghost is never queried alongside
  another account's wallet. Horizon can see those addresses, request
  timing, and source IP. Ghosts created before owner attribution existed
  have no recorded owner and are not sent to Horizon; their balances still
  display locally.
- **Known weakening:** Any manual or automatic sync is an explicit metadata
  disclosure to the Horizon operator; local storage alone does not prevent
  it.
- **Enforced by:** `frontend/src/hooks/useHistoryReconciliation.ts`,
  `frontend/src/lib/chainHistoryFetchers.ts`,
  `frontend/src/components/TransactionHistoryView.tsx`.

### P12 — Ghost announcer funding

<a id="ghost-announcer-funding"></a>

**Statement:** Manual ghost announcements use a one-time announcer account
derived from the ghost's ephemeral key.

- **Cannot learn:** The announcer is funded from the ghost's own balance,
  never from the connected wallet, so this flow does not place the main
  wallet directly next to the announcement as its fee payer. After the
  announcement is confirmed, the leftover reserve is merged back into the
  ghost.
- **Can learn:** The network still sees the ghost-to-announcer transfer,
  the announcement, and the reserve return. Timing and amount correlation
  between those transactions can link them to each other.
- **Known weakening:** This removes one direct wallet link; it is not a
  timing-obfuscation mechanism.
- **Enforced by:** `frontend/src/lib/stealthLifecycle.ts`,
  `frontend/src/components/GhostAnnounceModal.tsx`,
  `frontend/src/lib/privacyThreatModel.ts` (`M22`).

## Pool deposit linkability

Privacy-pool withdrawals are unlinkable only to the extent that the deposit
set is indistinguishable. A deposit amount that does not match a common
preset denomination is unusual and can make the later withdrawal trivially
linkable to that deposit.

- **Cannot learn:** A user following a preset denomination does not reveal
  a unique amount that singles out their deposit.
- **Can learn:** A unique custom amount narrows the candidate deposit set;
  the wallet shows a linkability warning and links to this section from the
  deposit form.
- **Known weakening:** Presets are a user-facing mitigation, not an
  on-chain enforcement of a minimum anonymity set. Current testnet presets
  are defined in `deployments/v1/testnet.json`.
- **Enforced by:** `frontend/src/lib/poolSweep.ts`,
  `frontend/src/components/PoolView.tsx`,
  `frontend/src/lib/docsLinks.ts` (`pool-linkability`).

## Known weakenings (summary)

- **Timing linkage** — not hidden; see P1, P3.
- **Amount linkage** — not hidden; see P3.
- **Pool denomination uniqueness** — unusual deposit amounts shrink the
  withdrawal anonymity set; see [Pool deposit linkability](#pool-deposit-linkability).
- **Deposit / sender linkage** — the funding account is always public; see
  P2. This is the property platform integrators most need to understand —
  see the custodial platform quickstart linked above.
- **Publisher metadata** — the reputation publisher receives the leaf,
  schema ID, UID, transaction hash, ledger, signature, and HTTP metadata;
  see [Publisher data flow](#publisher-data-flow).
- **On-chain submitter** — reputation verification is submitted by the
  connected wallet and emits that address; see P5.
- **Anonymity-set size** — bounded by schema issuance volume, not the
  circuit; see P7.
- **Claim destination / memo reuse** — explicit linkage chosen by the user;
  see P10.
- **Horizon sync** — opt-in but discloses queried addresses and IP timing;
  see P11.
- **Local compromise** — master/ghost keys are only as safe as the device
  they're used on; see P8.
- **Root/admin trust** — proof correctness inherits trust in whoever
  published the Merkle root; see P9.

None of these are hidden defects — each is stated here precisely so
reviewers and integrators don't have to infer it from README fragments or
source comments.
