# Opaque Stellar Documentation

This index groups every document by its primary audience. Update this file when adding or removing docs.

## User

Guides for end-user wallet holders depositing, withdrawing, sending, and receiving.

| Document | Purpose |
|----------|---------|
| [EXCLUSION_APPEAL_PROCESS.md](EXCLUSION_APPEAL_PROCESS.md) | What to do if your deposit is excluded from the approved set |
| [KEY_MANAGEMENT_GUIDE.md](KEY_MANAGEMENT_GUIDE.md) | User-held secret management, risks, and backup practices |
| [testnet-faucet-guide.md](testnet-faucet-guide.md) | Getting testnet XLM for testing |
| [TROUBLESHOOTING_PROOF_GENERATION.md](TROUBLESHOOTING_PROOF_GENERATION.md) | Browser-side proof generation failure causes and fixes |

## Integrator

Architecture references, SDK guides, and protocol design decisions for developers building on Opaque.

| Document | Purpose |
|----------|---------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | On-chain/off-chain components, trust boundaries, protocol flows |
| [technical-overview.md](technical-overview.md) | High-level system component overview |
| [GLOSSARY.md](GLOSSARY.md) | Protocol terms used across documentation and code |
| [CIRCUIT_VERSIONING.md](CIRCUIT_VERSIONING.md) | Circuit versioning scheme and deprecation timeline |
| [DEPRECATION_POLICY.md](DEPRECATION_POLICY.md) | Semantic versioning and deprecation process for SDK/ASP APIs |
| [PUBLIC_SIGNALS.md](PUBLIC_SIGNALS.md) | Public signal ordering, encoding, and valid ranges |
| [PROVING_BENCHMARKS.md](PROVING_BENCHMARKS.md) | Groth16 proof generation times across device classes |
| [SECURITY_HEADERS.md](SECURITY_HEADERS.md) | Required browser security headers |
| [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md) | Full stack local development setup |
| [adr/0000_ADR_INDEX.md](adr/0000_ADR_INDEX.md) | Architecture Decision Record index |
| [adr/0001_off_chain_published_roots.md](adr/0001_off_chain_published_roots.md) | ADR: off-chain published roots |
| [adr/0002_browser_wasm_scanner.md](adr/0002_browser_wasm_scanner.md) | ADR: browser WASM scanner |
| [adr/0003_relayer_market_gossip_hub.md](adr/0003_relayer_market_gossip_hub.md) | ADR: relayer market gossip hub |
| [adr/0004_non_custodial_wallet.md](adr/0004_non_custodial_wallet.md) | ADR: non-custodial Freighter wallet |
| [adr/0005_soroban_privacy_pool.md](adr/0005_soroban_privacy_pool.md) | ADR: Soroban privacy pool contracts |
| [adr/0006_event_abi_versioning_policy.md](adr/0006_event_abi_versioning_policy.md) | ADR: contract event ABI versioning |
| [adr/ADR_TEMPLATE.md](adr/ADR_TEMPLATE.md) | Template for writing new ADRs |
| [ops/incident/integrator-api-status.md](ops/incident/integrator-api-status.md) | Incident communication for API consumers |

## Operator

Operational runbooks, service configuration, incident response, and infrastructure guides.

| Document | Purpose |
|----------|---------|
| [running-asp.md](running-asp.md) | Running and configuring the ASP indexer |
| [running-publisher.md](running-publisher.md) | Running and configuring the reputation publisher |
| [running-relayer.md](running-relayer.md) | Running and configuring a relayer node |
| [running-with-docker.md](running-with-docker.md) | Docker Compose deployment for all services |
| [secrets-management.md](secrets-management.md) | Secret storage, scoping, and rotation |
| [state-backups.md](state-backups.md) | Encrypted backup and restore procedures |
| [MULTISIG_ADMIN.md](MULTISIG_ADMIN.md) | Admin multisig migration overview |
| [MULTISIG_MIGRATION_RUNBOOK.md](MULTISIG_MIGRATION_RUNBOOK.md) | Operator checklist for multisig migration |
| [ADMIN_KEY_COMPROMISE_PLAYBOOKS.md](ADMIN_KEY_COMPROMISE_PLAYBOOKS.md) | Runbooks for admin key compromise |
| [publisher-key-rotation-runbook.md](publisher-key-rotation-runbook.md) | Publisher signing key rotation |
| [RELAYER_THREAT_MODEL.md](RELAYER_THREAT_MODEL.md) | Relayer operator threat model |
| [relayer-operator-economics.md](relayer-operator-economics.md) | Relayer fee model, stake, and slashing |
| [testnet-reset-runbook.md](testnet-reset-runbook.md) | Restoring services after testnet reset |
| [testnet-slos.md](testnet-slos.md) | Service level objectives for testnet |
| [SUPPORT_PLAYBOOK.md](SUPPORT_PLAYBOOK.md) | Support diagnostics without exposing secrets |
| [ops/incident/README.md](ops/incident/README.md) | Incident templates overview and severity levels |
| [ops/incident/initial-notice.md](ops/incident/initial-notice.md) | Initial public notice template |
| [ops/incident/status-update.md](ops/incident/status-update.md) | Incident status update template |
| [ops/incident/resolution-postmortem.md](ops/incident/resolution-postmortem.md) | Resolution notice and postmortem templates |
| [ops/incident/tabletop-log.md](ops/incident/tabletop-log.md) | Incident response tabletop exercise log |

## Auditor

Security audits, threat models, privacy reviews, and verification procedures.

| Document | Purpose |
|----------|---------|
| [CIRCUIT_RANGE_CHECK_AUDIT.md](CIRCUIT_RANGE_CHECK_AUDIT.md) | Amount-signal range check audit |
| [CIRCUIT_SOUNDNESS_CHECKLIST.md](CIRCUIT_SOUNDNESS_CHECKLIST.md) | PR checklist for circom changes |
| [NULLIFIER_SPEC.md](NULLIFIER_SPEC.md) | Nullifier derivation and security properties |
| [PRIVACY_GUARANTEES.md](PRIVACY_GUARANTEES.md) | Formal privacy guarantees, publisher data flow, and pool linkability boundaries |
| [PROOF_SUBMISSION_PRIVACY.md](PROOF_SUBMISSION_PRIVACY.md) | On-chain proof transaction privacy analysis |
| [GHOST_THREAT_MODEL.md](GHOST_THREAT_MODEL.md) | Browser localStorage ephemeral key threat model |
| [INDEXER_PRIVACY_REVIEW.md](INDEXER_PRIVACY_REVIEW.md) | ASP indexer privacy review |
| [REPRODUCIBLE_BUILDS.md](REPRODUCIBLE_BUILDS.md) | Reproducible contract builds via pinned Docker |
| [supply-chain-policy.md](supply-chain-policy.md) | Supply-chain guarantees and dependency scanning |
| [TRUSTED_SETUP_CEREMONY.md](TRUSTED_SETUP_CEREMONY.md) | Production MPC ceremony plan |
| [TRUSTED_SETUP_VERIFICATION.md](TRUSTED_SETUP_VERIFICATION.md) | Independent zkey verification |
| [UPGRADE_GOVERNANCE.md](UPGRADE_GOVERNANCE.md) | Contract immutability and governance model |
