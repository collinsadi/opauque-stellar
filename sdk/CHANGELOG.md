# @opaquecash/stellar

The format follows [Changesets](https://github.com/changesets/changesets) output
and the project's [Versioning & Deprecation Policy](./docs/reference/versioning.md).
Unreleased work accumulates below until the next release.

## Unreleased

### Minor Changes

- Add `PoolService.isNullifierSpent` and `PoolService.reconcileWithdrawal`, plus
  the underlying `PrivacyPool.isNullifierSpent` binding, so callers can reconcile
  local note state with on-chain nullifier state after an ambiguous withdrawal
  RPC failure (a submission that may or may not have landed). No note is ever
  marked spent for a withdrawal that did not confirm on-chain.

### Patch Changes

- Document the withdrawal flow's fault-recovery guarantee and add fault-injection
  coverage for RPC failures before, during, and after submission (no burned note,
  no double payout).
- Enforce per-module test-coverage thresholds in CI (strictest on the proof- and
  note-handling modules); `npm test` now emits a coverage report.
- Add a Versioning & Deprecation Policy (`docs/reference/versioning.md`) and an
  end-to-end release-gate test (announce -> scan -> deposit -> prove -> relayed
  withdrawal).

## 0.2.0

### Minor Changes

- Require Node.js >= 20 (Node 18 is end-of-life; the toolchain and Web Crypto
  globals need 20+).
- Release tooling: tag-driven publish workflow with npm provenance, a clean-room
  install gate, Changesets, and build-time version injection.

## 0.1.1

### Patch Changes

- Lazy-load `circomlibjs` so payments-only consumers do not need it installed; the
  package now imports cleanly with only its required peers.
- Document pinning `@noble/*` peers to v1 (v2 is a breaking API change).
- Fix CJS/ESM type resolution (conditional `types` per `import`/`require`).

## 0.1.0

### Minor Changes

- Initial release. A typed, framework-free SDK for Stellar/Soroban:
  - **payments** — DKSAP stealth addresses (derive, register, send, pure-TS scan, sweep)
  - **pool** — privacy-pool deposit/withdraw with Groth16 proving and on-chain
    state reconstruction
  - **reputation** — on-chain ZK reputation (Groth16 verified in a Soroban contract)
  - **relayer** — relayer-market job lifecycle + gateway client
  - injected config, signer adapters, typed errors, storage/telemetry hooks
  - ESM + CJS + type declarations, subpath exports (`/crypto`, `/relayer-protocol`)
