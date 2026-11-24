---
"@opaquecash/stellar": minor
---

Optional peers load lazily again, and ASP inclusion paths stay private.

- **tweetnacl is optional again (#1078).** The main entry no longer imports
  `tweetnacl` at load time. `sealBox`, `openBox`, and `generateX25519Keypair` are
  async again — the signatures published in 0.2.0 — and reject with the new
  `MissingPeerDependencyError` (code `MISSING_PEER_DEPENDENCY`) when `tweetnacl`
  is not installed. Code holding its own `tweetnacl` can get synchronous
  functions with `createNaclBox(nacl)`.
- **Freighter signer on a subpath (#1079).** `freighterSigner` moves to
  `@opaquecash/stellar/freighter`, with `@stellar/freighter-api` (>=2) declared
  as an optional peer dependency and loaded lazily. Freighter's returned
  `{ error }` results map to `SignerRejectedError` (user rejected) or
  `SignerError`, never to an `undefined` signed XDR. The active address is
  re-read on every `publicKey()`, and signing with a switched account fails with
  `SignerError` `reason: "account-changed"`. `SignerError` gains a `reason`.
  `stellarWalletsKitSigner` gets the same error mapping.
- **ASP inclusion paths are computed locally (#1080).** `fetchAspInclusion`
  downloads the whole manifest for the root and derives the path client-side, so
  the label being withdrawn is never sent to the ASP. The per-label endpoint is
  used only with `revealLabelToAsp: true`. `AspInclusionProof.pathIndices` is now
  `string[]`, matching the prover's `aspIndex` input, and the depth is checked
  against the withdraw circuit (`ASP_TREE_DEPTH`, 20). New:
  `computeAspInclusionFromManifest`.
- **ASP manifest signatures (#1081).** `verifyAspManifestSignature` checks a
  manifest's Ed25519 signature against the ASP's published key;
  `fetchAspManifest` / `fetchAspInclusion` enforce it when `aspPublicKey` is set.
