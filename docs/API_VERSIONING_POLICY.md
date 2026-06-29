# API Versioning Policy

This document defines semantic versioning rules for Opaque Stellar's manifest schema, event schema, and scanner compatibility requirements. All breaking changes follow a deprecation window before removal.

---

## Overview

Opaque Stellar's on-chain APIs evolve through three main components:

1. **Manifest schema** (`deployments/v1/<network>.json`) - Contract addresses, WASM hashes, network metadata
2. **Event schema** - Soroban contract event layout and topic structure
3. **Scanner compatibility** - WASM scanner version requirements for proof generation

Changes to any component follow semantic versioning (MAJOR.MINOR.PATCH):

- **MAJOR**: Breaking change (incompatible with older clients/scanners)
- **MINOR**: Backwards-compatible addition
- **PATCH**: Bug fix or internal optimization

---

## Manifest Schema Versioning

### Current Version: `v1`

The manifest schema is versioned in the directory structure: `deployments/v1/`, `deployments/v2/`, etc.

### Rules

#### MAJOR version bumps (v1 → v2):

Occurs when:
- Required fields are renamed or moved
- Contract address structure changes
- Network enum values change
- Deployment manifest must be regenerated for all networks

Example: If we rename `contracts.registry.address` to `contracts.identityRegistry.address`, all clients must update. This is a **v2 bump**.

**Deprecation window**: 12 weeks (3 months)
- Week 1: Announce breaking change on GitHub releases
- Week 4: v2 manifest published alongside v1
- Week 8: v1 marked as deprecated in the README
- Week 12: v1 support ends; clients must use v2

#### MINOR version bumps (v1.0 → v1.1):

Occurs when:
- New optional fields are added (e.g., a new contract)
- New metadata is added (e.g., audit information, deployment timestamp)
- Older minor versions continue to work with newer code

Example: Adding `contracts.escrow.address` to the manifest. Old clients ignore the field; new clients can use it.

**Deprecation window**: None. Backwards compatible by definition.

#### PATCH version bumps (v1.0.0 → v1.0.1):

Occurs when:
- WASM hash is updated (bug fix or security patch in contract)
- No schema changes
- Clients do not need to update (hash validation is transparent)

Example: Fixing a gas leak in the registry contract, rebuilding, and updating `contracts.registry.wasmHash`.

**Deprecation window**: None. Instantaneous deployment.

### Schema validation

Every manifest is validated against `deployments/manifest.schema.json` during CI:

```bash
npx tsx scripts/verify-deployment-manifest.ts --network testnet --strict
```

This prevents invalid manifests from entering the codebase.

---

## Event Schema Versioning

### Current Version: `v1`

Events emitted by Opaque Soroban contracts follow a versioning scheme encoded in the contract code.

### Event structure

Each event includes a schema version in the topics:

```rust
// In Soroban contract
#[derive(contractimpl)]
pub struct Registry;

#[contractimpl]
impl Registry {
  pub fn attest(...) -> Result<(), Error> {
    // Event schema v1
    env.events().publish(("opaque", "attest", "v1"), (...));
  }
}
```

The schema version is part of the event topic, allowing multiple versions to coexist on-chain.

### Rules

#### MAJOR version bumps (v1 → v2):

Occurs when:
- Event topic structure changes (e.g., reordering topics)
- Data types in event body change (e.g., `u32` → `u64`)
- Event names are removed or renamed
- Scanning logic must be updated to interpret events

Example: Changing from `("opaque", "attest", "v1")` to `("opaque", "attestation", "v2")` requires scanner update. Scanners reading v1 cannot parse v2 events.

**Deprecation window**: 8 weeks
- Week 1: Announce v2 event schema in RFC
- Week 2: v2 contracts deployed to testnet alongside v1
- Week 4: Scanner updated to support both v1 and v2
- Week 6: Mainnet v2 contracts deployed (v1 contracts remain active)
- Week 8: v1 contracts marked for deprecation; scanner stops emitting v1 events

#### MINOR version bumps (v1.0 → v1.1):

Occurs when:
- New optional fields are added to event body
- Event encoding gains new indexed data
- Older scanner versions still understand the event (backward compatible)

Example: Adding a timestamp field to attestation events. Old scanners still work; new scanners gain extra metadata.

**Deprecation window**: None. Backwards compatible.

#### PATCH version bumps (v1.0.0 → v1.0.1):

Occurs when:
- Bug fix in event emission (e.g., wrong data in existing field)
- No schema changes
- Scanners do not need updating

**Deprecation window**: None.

### Scanner compatibility matrix

The deployment manifest specifies minimum scanner versions:

```json
{
  "contracts": {
    "registry": {
      "address": "CAB...",
      "eventVersion": "v1",
      "minimumScannerVersion": "1.0.0"
    }
  }
}
```

Scanners read this at startup and refuse to index if their version is below the minimum.

**Example compatibility table**:

| Network | Contract Event Version | Min Scanner Version | Notes |
|---------|------------------------|--------------------|-------|
| testnet | v1 | 1.0.0 | Initial release |
| testnet | v2 | 1.2.0 | Optional v2 contracts (v1 still active) |
| mainnet | v1 | 1.0.0 | Audited contracts |
| mainnet | v2 | 1.3.0 | v2 contracts after 8-week deprecation |

---

## Deployment Manifest Backwards Compatibility

### Guarantees

Manifest versions are published in separate directories, and code supports multiple versions simultaneously during transitions:

**Rule**: A deployed client or scanner must support at least 2 manifest versions during a major bump.

Example:
- March 2024: Announce v2 manifest schema
- April 2024: v2 manifest published
- May 2024: v1 and v2 both supported by frontend/scanner
- June 2024: v1 deprecated, support may be dropped

### Breaking manifest changes require:

1. RFC (request for comments) issue filed on GitHub
2. Minimum 4-week notice before deployment to mainnet
3. Staged rollout: testnet first, then mainnet
4. Frontend and scanner both updated before mainnet deployment
5. Release notes explicitly calling out breaking changes

---

## Deprecation Policy

### Timeline for deprecating APIs

```
Week 1:  Announce deprecation in GitHub release notes
Week 2:  Add deprecation warning to code/docs
Week 4:  Publish docs/DEPRECATION_TIMELINE.md
Week 8:  Mainnet support for new API; old API still works
Week 12: Old API support ends; all code must migrate
```

### Before removal:

- [ ] Deprecation is documented in CONTRIBUTING.md
- [ ] At least 2 releases have passed since deprecation announcement
- [ ] GitHub issues/docs show migration path
- [ ] Maintainers announce removal date 4 weeks in advance

### Removal:

- [ ] Code for old API is deleted
- [ ] Tests that relied on old API are updated
- [ ] Release notes explicitly mention the removal
- [ ] Documentation is updated

---

## Version Numbering

### Format

Versions follow semantic versioning: `MAJOR.MINOR.PATCH`

- `1.0.0` - Initial release
- `1.1.0` - New optional event fields
- `1.1.1` - Bug fix
- `2.0.0` - Breaking change (new manifest structure)

### Pre-releases

For testing before final release:

- `1.1.0-rc1` - Release candidate 1
- `1.1.0-beta1` - Beta testing
- `1.1.0-alpha1` - Alpha testing

Pre-releases are not installed by default (`npm install` uses stable versions only).

### Release cadence

- **Bug fixes (PATCH)**: As-needed
- **New features (MINOR)**: Every 4-8 weeks
- **Breaking changes (MAJOR)**: Every 6-12 months (aligned with audit cycles)

---

## Scanner Compatibility Requirements

### Rule: Minimum scanner version per deployed contract

Before indexing a contract, the scanner checks:

```typescript
// In scanner initialization
const deployedVersion = manifest.contracts.registry.eventVersion;
const minimumScanner = manifest.contracts.registry.minimumScannerVersion;

if (compareVersions(currentScannerVersion, minimumScanner) < 0) {
  throw new Error(`Scanner version ${currentScannerVersion} is below minimum ${minimumScanner} for event schema ${deployedVersion}`);
}
```

### Upgrade path

If a new contract requires scanner v1.2.0 but a user has v1.0.0:

1. Wallet detects version mismatch on load
2. Shows error: "Please update your wallet for the latest security features"
3. Provides link to upgrade (GitHub releases or app store)
4. Blocks proof generation until upgrade is complete

### EOL (end-of-life) for old scanners

Old scanner versions are no longer built/released after 1 year:

| Scanner Version | Release Date | EOL Date | Status |
|---|---|---|---|
| 1.0.x | June 2024 | June 2025 | Supported |
| 1.1.x | August 2024 | August 2025 | Supported |
| 1.2.x | October 2024 | October 2025 | Supported |
| 0.9.x | April 2024 | April 2025 | Deprecated |

---

## Contributing

### When adding a new contract

1. Define the event schema version in the contract code
2. Add the contract to `deployments/v1/<network>.example.json`
3. Update the manifest schema if new fields are added
4. Document the minimum scanner version in the manifest
5. Update the compatibility matrix in this document

### When changing an event schema

1. Create an RFC (GitHub issue with `rfc:` label)
2. Wait for feedback (minimum 1 week)
3. Update the contract code with the new event topics
4. Update the scanner to support both old and new versions
5. Deploy to testnet, verify with test proofs
6. Start the deprecation timeline

### When bumping manifest versions

1. Create a new directory: `deployments/v2/`
2. Copy and update `manifest.schema.json` for new fields
3. Generate manifests for testnet and mainnet
4. Update frontend to read both v1 and v2
5. Update scanner to read both v1 and v2
6. Announce in release notes with migration guide

---

## Related Documentation

- [Deployment rollback runbook](runbooks/deployment-rollback.md)
- [Schema authoring guide](SCHEMA_AUTHORING_GUIDE.md)
- [RFC process](rfcs/)
- [CONTRIBUTING.md](../CONTRIBUTING.md)

---

## FAQ

### Can we have v1 and v2 contracts running simultaneously?

**Yes.** During the deprecation window, both versions operate in parallel. The manifest specifies which version is "canonical" for new operations; old contracts stay active for backwards compatibility.

### What if we deploy a contract with the wrong event schema?

The manifest verification CI step must fail. Never push a contract without updating the manifest and passing `verify-deployment-manifest`.

### How do we test breaking changes?

1. Deploy to testnet with the new version
2. Run the full test suite including scanner indexing
3. Have scanner version and contracts agree on schema versions
4. Publish the change to a pre-release branch for external testing
5. Wait for feedback before mainnet deployment

### Can we skip the deprecation window?

**No**, except in cases of critical security vulnerability. Cite the vulnerability in the release notes and announce a security advisory.

### What if a deployer accidentally pushes v1.0.1 before v1.1.0 is released?

The WASM hash changes, the manifest is updated, but the version string in `package.json` is not. This is unusual but not breaking—it just means a patch was released out of order. Update the manifest and release notes to explain.

---

**Version**: 1.0  
**Last updated**: June 2024  
**Maintained by**: Opaque core team
