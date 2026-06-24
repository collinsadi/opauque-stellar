# Security

## Responsible Disclosure And Bug Bounty Program

### Reporting A Vulnerability

Do not open a public GitHub issue for security vulnerabilities. Report security
issues through one of these confidential channels:

- Preferred: [private GitHub security advisory](https://github.com/collinsadi/opauque-stellar/security/advisories/new)
- Email: `security@opaqueprotocol.org`

Include the affected component, network, contract ID if applicable, reproduction
steps, impact, and any proof-of-concept code or transaction hashes needed to
verify the report. Do not include secrets, private keys, seed phrases, or
personal data.

### Response SLA And Disclosure Timeline

We aim to:

- acknowledge security reports within 5 business days;
- provide an initial triage result within 10 business days;
- share remediation status at least every 14 calendar days while a report is open;
- coordinate public disclosure after a fix, mitigation, or accepted risk decision is available.

Please give us a reasonable remediation window before public disclosure. If you
believe active exploitation is underway, state that clearly in the report so we
can prioritize incident response.

### Reporting Abuse Or Sanctions Concerns

Open a GitHub issue for non-sensitive abuse-policy, sanctions-screening, or
compliance concerns. Do not include sensitive personal data in public issues.
The reference wallet surfaces an in-app abuse-policy summary at `/abuse-policy`;
see [`frontend/src/components/AbusePolicyPage.tsx`](frontend/src/components/AbusePolicyPage.tsx).

### Supported Versions

Security fixes are applied to the latest code on `main`. Release notes are
published through GitHub Releases when a tagged release is available.

### Scope

We encourage responsible security research on the Opaque Stellar implementation.
The current in-scope assets are:

| Area | In scope |
| --- | --- |
| Soroban contracts | `contracts/stealth-registry`, `contracts/stealth-announcer`, `contracts/groth16-verifier`, `contracts/reputation-verifier`, `contracts/schema-registry`, `contracts/attestation-engine-v2` |
| ZK circuits and artifacts | `circuits/`, `artifacts/manifest.json`, and the circuit verification key bindings used by the verifier contract |
| Reference wallet | `frontend/`, including wallet flows, scanner integration, proof generation, and contract invocation helpers |
| Scanner | `scanner/` Rust code and browser WASM build artifacts |
| Deployment manifests | `deployments/v1/testnet.json`, `deployments/v1/mainnet.json`, and `deployments/security/mainnet-audit-findings.json` |
| Tooling | Root scripts that build, deploy, verify, or publish security-relevant artifacts |

The following security areas are especially important:

- contract authorization and access control;
- root administration and state transitions;
- Groth16 proof verification logic;
- witness generation and constraint logic;
- proof generation, serialization, and public signal validation;
- client-side key derivation and local persistence;
- RPC endpoint interactions and request handling.

### Contract Addresses

Canonical contract IDs are recorded in the deployment manifests:

- Testnet: [`deployments/v1/testnet.json`](deployments/v1/testnet.json)
- Mainnet: [`deployments/v1/mainnet.json`](deployments/v1/mainnet.json)

Both manifests currently mark their contract ID fields as empty templates or
not-deployed records. Once a deployment is published, the manifest is the source
of truth for the in-scope contract IDs, WASM hashes, admin, multisig, RPC URL,
and deployment ledger.

### Out Of Scope

The following are out of scope unless a report demonstrates a direct impact on
an official deployment or artifact we operate:

- third-party wallets, wallet extensions, RPC providers, Horizon providers, or block explorers;
- Stellar network consensus or Soroban host behavior outside this repository;
- phishing, social engineering, spam, or physical attacks;
- denial of service that relies only on excessive public traffic without a protocol-specific flaw;
- browser, OS, or dependency vulnerabilities without an exploitable Opaque-specific path;
- self-hosted forks, modified deployments, or local development environments;
- lost funds caused by user key loss, deleted browser storage, or disclosed seed phrases;
- issues already known and documented in this repository.

### Rewards And Bounty Expectations

This repository may receive bounty-style issues or campaign labels. A security
report is not automatically rewardable unless a maintainer or campaign operator
confirms eligibility. Reward decisions may consider severity, novelty,
reproducibility, exploitability, report quality, and whether the issue affects an
official in-scope deployment.

Please do not demand payment, threaten disclosure, or submit duplicate reports.
Duplicate reports are normally credited to the first reproducible submission.

### Safe Harbor

We will not pursue legal action or ask law enforcement to investigate good-faith
security research that follows this policy. To stay within safe harbor:

- test only against your own accounts, local environments, or explicitly in-scope public deployments;
- avoid privacy violations, data destruction, service disruption, and unauthorized access to funds;
- stop testing and report promptly if you encounter sensitive data, private keys, or exploitable access;
- do not publicly disclose details until we have coordinated remediation or accepted the risk;
- do not use a vulnerability to extract value beyond the minimum needed to prove impact.

Good-faith researchers who comply with these rules are treated as contributors,
not attackers.

## Authorization

See [docs/AUTHORIZATION_MATRIX.md](docs/AUTHORIZATION_MATRIX.md) for the
cross-contract authorization matrix covering all admin-only and authority-gated
methods across Opaque Soroban contracts.

## Threat Model

- Ghost key encryption threat model: [docs/GHOST_THREAT_MODEL.md](docs/GHOST_THREAT_MODEL.md)

## Groth16 Proof Malleability

Groth16 proofs are malleable: an adversary who observes a valid proof can modify
the `proof_a` (G1) element by adding a known G1 point, producing a different but
still-valid proof for the same public signals. This does not violate Groth16's
soundness because no false statements can be proven, but it means that on-chain
nullifier replay protection must be per nullifier hash, not per proof bytes. The
`ReputationVerifier` contract correctly enforces this: it marks nullifiers as
spent and rejects any proof, original or malleated, that uses an already-spent
nullifier.

### Verifier Contract Status

The `Groth16Verifier` Soroban contract does not perform explicit subgroup or
non-malleability checks on proof elements. It relies on:

1. The BN254 prime-order G1 group, where no small subgroup exists.
2. Nullifier-based replay protection in the `ReputationVerifier` caller.
3. Public signal scalar field validity checks through `is_valid_scalar`.

See [docs/FORMAL_VERIFICATION_SCOPING.md](docs/FORMAL_VERIFICATION_SCOPING.md)
for the formal verification scope, including malleability as an out-of-scope
property.
