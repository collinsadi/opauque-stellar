# Security Policy

## Reporting a vulnerability

**Please do not** open public GitHub issues for security vulnerabilities.

| Channel | Contact |
|---------|---------|
| **Security email** | [security@opaqueprotocol.org](mailto:security@opaqueprotocol.org) |
| **GitHub (private)** | [Create a security advisory](https://github.com/collinsadi/opaque-stellar/security/advisories/new) |

We aim to acknowledge security reports within **5 business days**.

## Reporting abuse or sanctions concerns

See [docs/ABUSE_AND_SANCTIONS_POLICY.md](docs/ABUSE_AND_SANCTIONS_POLICY.md) or email [abuse@opaqueprotocol.org](mailto:abuse@opaqueprotocol.org).

## Supported versions

Security fixes are applied to the latest release on the `main` branch and documented in [RELEASE_NOTES.md](RELEASE_NOTES.md).

## Scope

- Soroban contracts in `contracts/`
- Reference frontend in `frontend/`
- Scanner WASM in `scanner/`
- Deployment manifests and CI verification scripts

Out of scope: third-party wallets, Stellar network consensus, and self-hosted forks unless they use official deployment credentials we operate.
