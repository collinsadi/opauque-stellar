# Security

## Responsible Disclosure & Bug Bounty Program

### Scope

We encourage responsible security research on the Opaque Stellar implementation. The following are **in-scope** for vulnerability reports:

**Smart Contracts (Stellar Soroban):**
- `ReputationVerifier` contract and its cryptographic validation
- `MerkleRootManager` contract for root administration and state transitions
- `Groth16Verifier` contract and proof verification logic
- All Soroban contract authorization and access control mechanisms
- See deployment manifest at `deployments/manifest.json` for current contract addresses

**Circuits & ZK Proof System:**
- Witness generation and constraint logic in `circuits/`
- Proof generation and serialization
- Public signal validation
- Groth16 setup and parameters

**Frontend Application:**
- Client-side key derivation and storage
- Ghost address generation and local persistence
- WASM scanner implementation in `packages/wasm-scanner`
- User authentication and session handling

**Tooling & Infrastructure:**
- CLI tools in `packages/cli`
- Docker configurations and deployment scripts
- RPC endpoint interactions and request handling

**Out-of-Scope:**
- Third-party dependencies and libraries (report directly to maintainers)
- Configuration or deployment issues on user infrastructure
- Social engineering or phishing attacks
- Denial of service attacks not related to logic flaws
- Issues already known and documented in this repository

### Safe Harbor

We commit to the following safe harbor protections for security researchers:

1. We will not pursue civil action or law enforcement investigation against you for good-faith security research.
2. You will not face legal liability under the Computer Fraud and Abuse Act (CFAA) or equivalent in your jurisdiction for testing our systems with permission.
3. We ask that you allow us 90 days to develop a fix before public disclosure; we will make every effort to release patches faster.
4. Security researchers who responsibly disclose novel vulnerabilities may be credited publicly if desired.

### Reporting a Vulnerability

**DO NOT** open a public GitHub issue for security vulnerabilities.

**Preferred:** Use [GitHub Security Advisory](https://github.com/collinsadi/opauque-stellar/security/advisories/new) for private reporting.

**Alternative Contact:** Email security@opaque.ai with:
- Issue description and impact assessment
- Steps to reproduce (if applicable)
- Affected contract addresses or code locations
- Your contact information and PGP key (if available)

**Response SLA:**
- **Acknowledgment:** Within 48 hours of report submission
- **Assessment:** Initial severity determination within 7 days
- **Fix & Patch:** Critical issues patched within 14 days; others within 30 days
- **Disclosure Timeline:** 90 days from fix deployment before public disclosure

---

## Authorization

See [docs/AUTHORIZATION_MATRIX.md](docs/AUTHORIZATION_MATRIX.md) for the
cross-contract authorization matrix covering all admin-only and
authority-gated methods across Opaque Soroban contracts.

## Threat Model

- **Ghost key encryption threat model:** [docs/GHOST_THREAT_MODEL.md](docs/GHOST_THREAT_MODEL.md)

## Groth16 Proof Malleability

Groth16 proofs are **malleable**: an adversary who observes a valid proof
can modify the `proof_a` (G1) element by adding a known G1 point, producing
a different but still-valid proof for the same public signals. This does not
violate Groth16's soundness (no false statements can be proven), but it means
that on-chain nullifier replay protection must be **per nullifier hash**, not
per proof bytes. The `ReputationVerifier` contract correctly enforces this:
it marks nullifiers as spent and rejects any proof (original or malleated)
that uses an already-spent nullifier.

### Verifier Contract Status

The `Groth16Verifier` Soroban contract does **not** perform explicit subgroup
or non-malleability checks on proof elements. It relies on:

1. The BN254 prime-order G1 group (no small subgroup exists).
2. Nullifier-based replay protection in the `ReputationVerifier` caller.
3. Public signal scalar field validity checks (`is_valid_scalar`).

See [docs/FORMAL_VERIFICATION_SCOPING.md](docs/FORMAL_VERIFICATION_SCOPING.md)
for the formal verification scope, including malleability as an out-of-scope
property.

## Reporting a Vulnerability

This project is experimental and unaudited. If you discover a security issue,
please open a [GitHub Security Advisory](https://github.com/collinsadi/opauque-stellar/security/advisories/new).
