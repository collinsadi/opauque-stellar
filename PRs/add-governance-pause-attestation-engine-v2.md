# PR: Add Governance Init + Emergency Pause Controls to `attestation-engine-v2`

## Summary

This PR introduces a one-time governance initialization and narrowly scoped emergency pause controls for the `attestation-engine-v2` contract. It enables a governance/admin actor to safely halt critical flows (attestation issuance, Merkle/root updates, and proof verification) while preserving all read-only APIs.

## Files changed
- `contracts/attestation-engine-v2/src/lib.rs`
  - Added `GovernanceConfig` contract-type storing `admin`, `governance`, `schema_registry`, `version`, `upgrade_info`, and pause flags.
  - Updated `initialize()` signature to `initialize(env, admin, governance, schema_registry, version)` and enforced one-time initialization.
  - Added `get_config()` read-only accessor for governance state.
  - Implemented `pause_*` and `unpause_*` methods for: `attestation` issuance, `merkle_updates`, and `proof_verification`.
  - Added `AttestationError::Paused` and checks in `attest` to fail closed when paused.
  - Updated test helpers and added new tests for pause behavior and governance authorization.

## Public contract API (added)
- `initialize(admin: Address, governance: Address, schema_registry: Address, version: u32) -> Result<(), AttestationError>`
- `get_config() -> Result<GovernanceConfig, AttestationError>`
- `pause_attestation(caller: Address)`, `unpause_attestation(caller: Address)`
- `pause_merkle_updates(caller: Address)`, `unpause_merkle_updates(caller: Address)`
- `pause_proof_verification(caller: Address)`, `unpause_proof_verification(caller: Address)`

Governance-authorized callers are `admin` or `governance` (future multisig/delegation mechanisms may wrap the `governance` address).

## Behavioural notes
- Initialization is one-time. Re-initialization returns `AlreadyInitialized`.
- Pause operations require authenticated governance caller (`admin` or `governance`).
- When paused, protected write flows (issuance, merkle updates, proof verification) return `AttestationError::Paused` and fail closed.
- All read-only APIs (e.g., `get_attestation`, `get_config`) remain available while paused.

## Tests
- Added tests in the contract test module:
  - `test_attest_paused_blocks_issuance_but_allows_reads_and_gov`
  - `test_pause_requires_governance_authority`
- All `attestation-engine-v2` unit tests pass locally (19 tests).

## Migration / Integration
- Deployment must call `initialize` once with the chosen `admin` and `governance` addresses and `schema_registry` contract address.
- Clients/operators should switch to calling the new `initialize` signature during first deployment.
- Existing deployments that relied on previous `initialize(admin, schema_registry)` must be migrated by a stateful upgrade (if possible) or redeployment and re-seeding of state.

## Security considerations
- Pausing is deliberately narrow-scoped; it avoids disabling reads to preserve auditability.
- Governance address should be a multisig or a governance contract to avoid single-key centralization.
- Consider adding timelock or multisig wrappers for `governance` for higher assurance.

## Deployment checklist
- [ ] Choose `admin` and `governance` addresses (can be the same initially)
- [ ] Deploy updated `attestation-engine-v2` contract artifact
- [ ] Call `initialize(admin, governance, schema_registry, version)` exactly once
- [ ] Verify `get_config()` returns expected values
- [ ] Optionally call `pause_*`/`unpause_*` in a staging environment to validate behavior

## Follow-ups / Improvements
- Implement a governance multisig wrapper and/or on-chain threshold verification.
- Add events for pause/unpause actions for easier off-chain monitoring.
- Add structured upgrade/migration fields and helper methods to support safe state upgrades.

---

If you'd like, I can:
- open a GitHub Pull Request using this markdown as the PR body, or
- create a short PR template under `.github/PULL_REQUEST_TEMPLATE.md` and open the PR, or
- expand the migration steps into a runnable script for stateful upgrades.

Which option do you prefer?