# Solana-to-Stellar Implementation Parity Analysis

This document provides a feature-by-feature parity status for teams migrating from opaque-solana to the Stellar implementation (opaque-stellar). It clarifies which features are fully supported, in beta, or not yet available.

## Overview

The Stellar implementation is a **feature-complete port** of the Solana protocol with equivalent cryptographic guarantees. Key architectural differences (Soroban contracts vs. Solana programs, Stellar's account model) are documented.

---

## Core Protocol & Cryptography

| Feature | Solana Status | Stellar Status | Notes |
|---------|---|---|---|
| Ghost address generation (secp256k1) | GA | GA | Identical implementation; derivation paths match |
| View tag filtering | GA | GA | Same BN254 field arithmetic; identical false positive rate (~1/256) |
| Groth16 proof verification | GA | GA | Uses BN254; verifier contract deployed & tested |
| Nullifier-based replay protection | GA | GA | Merkle tree logic ported to Soroban |
| Selective disclosure | GA | GA | Full support; circuit signatures match |

**Summary:** All core cryptographic operations are feature-parity with Solana.

---

## Smart Contract Layer

### Reputation Verifier

| Feature | Solana | Stellar | Status | Gap Details |
|---------|--------|---------|--------|---|
| Proof verification (Groth16) | Supported | Supported | GA | Identical soundness checks |
| Nullifier management | Supported | Supported | GA | Maps nullifier hash -> bool; no upgrade path |
| Reputation scores | Supported | Supported | GA | Same reputation enum (Fresh, Seasoned, Established) |
| Admin-gated root updates | Supported | Supported | GA | `MerkleRootManager` contract handles updates |
| Access control (require_auth) | Supported | Supported | GA | Soroban-native authorization checks |

### Merkle Root Manager

| Feature | Solana | Stellar | Status | Gap Details |
|---------|--------|---------|--------|---|
| Root history tracking | Supported | Supported | GA | Last 3 roots kept for valid-in-past proofs |
| Incremental root updates | Supported | Supported | GA | Append-only log; timestamps recorded |
| Admin upgrades | Supported | Supported | Beta | Contract is pausable but not immutable yet |

**Summary:** Smart contract functionality is feature-complete.

---

## Frontend & User Interface

### Core Features

| Feature | Solana | Stellar | Status | Gap Details |
|---------|--------|---------|--------|---|
| Ghost address generation UI | GA | GA | Yes | Same flow; Freighter wallet integration verified |
| Key import/export | GA | GA | Yes | Stellar uses native format (Base32 seed) |
| Transaction signing (Freighter) | GA | GA | Yes | Browser extension integration confirmed |
| Address book & payment links | GA | GA | Yes | Fully ported; QR code generation included |
| Local nullifier caching | GA | GA | Yes | IndexedDB storage; no server dependency |

### WASM Scanner

| Feature | Solana | Stellar | Status | Gap Details |
|---------|--------|---------|--------|---|
| Announcement stream parsing | GA | GA | GA | Uses Stellar Horizon API instead of Solana RPC |
| Nullifier derivation & matching | GA | GA | GA | Identical Poseidon hash computation |
| View tag filtering | GA | GA | GA | BN254 arithmetic matches exactly |
| Incremental scanning | GA | GA | GA | Resume from checkpoint; persisted in local storage |
| Multi-network support | GA | GA | Beta | Testnet only; mainnet deployment pending |

### Payment Links

| Feature | Solana | Stellar | Status | Gap Details |
|---------|--------|---------|--------|---|
| Generate shareable link | GA | GA | GA | Encodes ghost address + metadata |
| QR code rendering | GA | GA | GA | Same format; scannability tested |
| Link expiration (optional) | GA | GA | GA | Optional TTL; backend-agnostic |
| Wallet auto-import | GA | GA | Beta | Freighter auto-import works; mobile wallets pending |

**Summary:** Frontend feature parity is near-complete. Mobile wallet integration is the primary gap.

---

## CLI Tools & Integrator Experience

| Feature | Solana | Stellar | Status | Details |
|---------|--------|---------|--------|---|
| Key derivation CLI | Supported | Supported | GA | opaque-cli; accepts seed phrase or mnemonic |
| Proof generation (offline) | Supported | Supported | GA | WASM-based; no network required |
| Proof verification (local) | Supported | Supported | GA | Groth16Verifier contract provided as reference |
| Transaction simulation | Supported | Supported | Beta | Stellar RPC supports simulation; documentation pending |
| Batch nullifier checks | Supported | Supported | Beta | Not yet exposed in CLI |

**Summary:** Core CLI functionality is available; some advanced integrator features are in beta.

---

## Deployment & Infrastructure

| Aspect | Solana Status | Stellar Status | Notes |
|--------|---|---|---|
| Testnet contracts deployed | Yes | Yes | Addresses in `deployments/manifest.json` |
| Mainnet contracts deployed | Yes | No | Target: Q3 2026 |
| Contract upgrade mechanism | Yes (via authority) | Frozen (immutable on deploy) | Soroban doesn't support contract upgrades yet |
| Multichain bridge | Planned | Not planned | Stellar focus for this roadmap |

---

## Documentation & Resources

### Solana-Only Documentation

The following resources are Solana-specific and do not have Stellar equivalents:

- Anchor IDL definitions (Solana)
- Solana Program Library (SPL) token integration (not applicable to Stellar)
- Solana RPC-specific optimizations (see [docs/RPC_RATE_LIMIT_POLICY.md](RPC_RATE_LIMIT_POLICY.md) for Stellar equivalents)

### Equivalent Stellar Resources

| Topic | Solana Equivalent | Stellar Equivalent |
|-------|---|---|
| Integration guide | opaque-solana README | [docs/INTEGRATOR_QUICKSTART.md](INTEGRATOR_QUICKSTART.md) |
| Smart contract API | Anchor IDL | Soroban contract specs in `contracts/` |
| Proof verification | Solana verifier program | `contracts/verifier/` (Groth16Verifier) |
| Key management | Anchor CLI | opaque-cli in `packages/cli` |
| RPC configuration | Solana RPC docs | [docs/RPC_RATE_LIMIT_POLICY.md](RPC_RATE_LIMIT_POLICY.md) |

---

## Migration Checklist

Use this checklist when porting Solana integrations to Stellar:

- [ ] Update key derivation to use Stellar's secp256k1 BIP32 paths
- [ ] Replace Solana RPC calls with Stellar Horizon API
- [ ] Update transaction signing to use Stellar transaction format (XDR)
- [ ] Replace Anchor IDL with Soroban contract specs
- [ ] Update smart contract calls to match ReputationVerifier ABI
- [ ] Test on Stellar testnet before mainnet (when available)
- [ ] Update documentation links and examples
- [ ] Verify proof verification using Groth16Verifier contract
- [ ] Test with Freighter wallet (primary Stellar wallet)

---

## Roadmap & Future Parity

### Features Coming to Stellar (2026+)

- **Mainnet contracts:** Scheduled for Q3 2026
- **Mobile wallet support:** Freighter mobile in beta; native Stellar wallets TBD
- **Contract immutability:** Full guarantee once Soroban matures
- **Batch operations:** Multi-nullifier checks via contract

### Features Not Coming to Stellar

- **Multichain bridge:** Out of scope for current roadmap
- **Solana-specific optimizations:** Not applicable due to different chain architecture

---

## Breaking Changes

When upgrading from Solana to Stellar:

1. **Contract addresses:** New Stellar contract IDs required (see `deployments/manifest.json`)
2. **RPC endpoints:** Solana RPC calls fail; use Stellar Horizon
3. **Key format:** Stellar uses Base32 seed encoding (not Solana's Base58)
4. **Transaction signing:** XDR format instead of Solana message format
5. **Fee model:** Stellar uses reserve-based model (different cost structure)

---

## Support

For teams migrating from Solana:

1. Start with [docs/INTEGRATOR_QUICKSTART.md](INTEGRATOR_QUICKSTART.md)
2. Review contract ABIs in `contracts/`
3. Test on testnet (free test XLM available)
4. Open an issue on GitHub for specific migration blockers

**Maintained:** This document is updated with each release to reflect parity status changes.

---

**Last Updated:** 2026-06-28  
**Stellar Version:** opaque-stellar main branch
