<div align="center">

```
╔══════════════════════════════════════════════════════╗
║                                                      ║
║    ██████╗ ██████╗  █████╗  ██████╗ ██╗   ██╗███████╗║
║   ██╔═══██╗██╔══██╗██╔══██╗██╔═══██╗██║   ██║██╔════╝║
║   ██║   ██║██████╔╝███████║██║   ██║██║   ██║█████╗  ║
║   ██║   ██║██╔═══╝ ██╔══██║██║▄▄ ██║██║   ██║██╔══╝  ║
║   ╚██████╔╝██║     ██║  ██║╚██████╔╝╚██████╔╝███████╗║
║    ╚═════╝ ╚═╝     ╚═╝  ╚═╝ ╚══▀▀═╝  ╚═════╝ ╚══════╝║
║                                                      ║
╚══════════════════════════════════════════════════════╝
```

### *Private payments. Provable reputation. Zero exposure.*

**Stealth addresses and on-chain ZK reputation on Stellar (Soroban + Freighter).**

<br/>

[![MIT License](https://img.shields.io/badge/license-MIT-5c7cfa?style=flat-square)](https://opensource.org/licenses/MIT)
[![Stellar Testnet](https://img.shields.io/badge/network-Stellar%20Testnet-7D00FF?style=flat-square)](https://stellar.org)


[**GitHub**](https://github.com/collinsadi/opaque-stellar)


---

## Overview

Opaque is an open protocol for **unlinkable payments** and **proof-backed reputation** on **Stellar**. It combines:

1. **Stealth payments (DKSAP)** — Each receive uses a fresh, one-time Stellar account derived from a published meta-address. Senders pay XLM to that address; only the recipient can discover and sweep funds.
2. **Programmable Stealth Reputation (PSR)** — Issuers register schemas and attest to stealth identities (hashed, not wallet-linked). Holders prove traits with Groth16 ZK proofs verified on Soroban.

The reference wallet runs in the browser: **Freighter** for signing, **WASM** for scanning announcements, **snarkjs** for proofs.

---

## How it works

### Stealth payments

Opaque implements the **Dual-Key Stealth Address Protocol (DKSAP)** (EIP-5564 / ERC-6538 compatible cryptography on secp256k1):

```
Recipient                              Sender
─────────                              ──────
Publishes meta-address  V ∥ S
                                       Ephemeral key r, shared secret, view tag
                                       Stealth pubkey P → Stellar account (Ed25519)
                                       Pays XLM + announces on stealth-announcer
Scanner (WASM) filters by view tag, derives matching stealth keys, sweeps to main wallet
```

Stealth Stellar accounts are derived deterministically from the stealth secp256k1 point (`opaque-stellar-stealth-v1` domain separation).

### Private reputation

- **Schema registry** — Field layouts and authorities on Soroban.
- **Attestation engine** — Credentials bound to `keccak256(stealth_address)`, not a public wallet.
- **Groth16 verifier** — BN254 pairing via Soroban crypto primitives.
- **Reputation verifier** — Merkle root checks, nullifiers, and proof verification.

---

## Repository map

| Path | Contents |
|:-----|:---------|
| [`frontend/`](frontend/) | React / TypeScript wallet UI (Freighter, send, receive, scan, reputation) |
| [`contracts/`](contracts/) | Soroban contracts: registry, announcer, schema registry, attestation, Groth16, reputation |
| [`scanner/`](scanner/) | Rust → WASM: DKSAP engine, view-tag filter, attestation discovery |
| [`circuits/`](circuits/) | Circom Groth16 circuit for stealth attestation proofs |

---

## Soroban contracts

| Contract | Role |
|:---------|:-----|
| `stealth-registry` | Map Stellar account → stealth meta-address |
| `stealth-announcer` | On-chain announcements (ephemeral key, view tag, metadata) |
| `schema-registry` | Register attestation schemas |
| `attestation-engine-v2` | Issue / revoke attestations |
| `groth16-verifier` | Verify Groth16 proofs (BN254) |
| `reputation-verifier` | PSR verification + nullifiers |

Deploy with the [Stellar CLI](https://developers.stellar.org/docs/build/smart-contracts/getting-started/setup), then record contract IDs in the canonical manifest at [`deployments/v1/testnet.json`](deployments/v1/testnet.json) (see [`deployments/README.md`](deployments/README.md)). Optional `VITE_<NETWORK>_*` overrides in `frontend/.env` are for local dev only.

---

## Running locally

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Stellar CLI](https://developers.stellar.org/docs/build/smart-contracts/getting-started/setup)
- [Node.js](https://nodejs.org/) 18+
- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/) (scanner WASM)
- [Freighter](https://www.freighter.app/) browser extension

### 1. Clone

```bash
git clone https://github.com/collinsadi/opaque.git
cd opaque
```

### 2. Build contracts

```bash
stellar contract build
# Deploy to testnet and note contract IDs
```

### 3. Build scanner (WASM) and circuit artifacts

Scanner WASM is built automatically before `frontend` builds. You can also run steps manually:

```bash
# Scanner (DKSAP / announcement filter)
npm run build:scanner

# Circuit zkey + witness WASM (from GitHub release when published)
npm run fetch:circuits

# Verify pinned SHA-256 hashes
npm run verify:artifacts
```

See [`artifacts/README.md`](artifacts/README.md) for the artifact source of truth, release retrieval, and VK↔zkey binding.

### 4. Frontend

```bash
cd frontend
cp .env.example .env
# Edit VITE_STELLAR_NETWORK; contract IDs come from deployments/v1/testnet.json
npm install
npm run dev
```

Open `http://localhost:5173`, connect Freighter on testnet.

### 5. Circuits (optional — developers changing ZK logic)

Source circuits and reproducible scripts live under `circuits/`. Large artifacts are **not** committed; fetch release assets or rebuild locally:

```bash
# Fetch audited zkey + witness WASM (when release is published)
npm run fetch:circuits

# Recompile from source (requires circom + ptau — see circuits/README.md)
cd circuits && npm install && npm run build
cd circuits/v2 && npm install && npm run build

# Regression tests (deterministic fixtures)
npm run test:circuits
```

---

## Environment variables

See [`frontend/.env.example`](frontend/.env.example) and [`deployments/README.md`](deployments/README.md). Key settings:

- `VITE_STELLAR_NETWORK` — `testnet` | `mainnet` | `futurenet` | `local`
- `VITE_STELLAR_RPC_URL` / `VITE_STELLAR_HORIZON_URL` (optional; manifest defaults)
- **Canonical contract IDs** — [`deployments/v1/testnet.json`](deployments/v1/testnet.json) / [`deployments/v1/mainnet.json`](deployments/v1/mainnet.json)
- Release evidence — [`RELEASE_NOTES.md`](RELEASE_NOTES.md)

---

## Cryptographic stack

| Layer | Primitive | Purpose |
|:------|:----------|:--------|
| Stealth keys | secp256k1 ECDH | DKSAP shared secret |
| Address hash | Keccak-256 | Cross-chain stealth identifier (EVM-compatible hex) |
| Stellar account | Ed25519 from hashed stealth point | One-time receive accounts |
| View tag | 1 byte from shared secret | Fast announcement filtering |
| ZK | Groth16 (BN254) | In-browser reputation proofs |
| On-chain verify | Soroban BN254 | Pairing verification in contracts |
| Nullifiers | Poseidon | Replay resistance |

---

## Standards & cross-chain

Opaque follows the same DKSAP layout as the [Ethereum Opaque](https://github.com/collinsadi/opaque) implementation:

- [EIP-5564](https://eips.ethereum.org/EIPS/eip-5564) — Stealth addresses  
- [ERC-6538](https://eips.ethereum.org/EIPS/erc-6538) — Stealth meta-address registry  

Meta-addresses and scanner logic are compatible across chains; settlement layer is Stellar (XLM + Soroban).

> **Disclaimer:** Experimental software. Read [DISCLAIMER.md](DISCLAIMER.md) before using with real funds.

---

## License

[MIT](LICENSE) — Built in public by [Collins Adi](https://github.com/collinsadi).

*Every transaction deserves the right to be private.*
