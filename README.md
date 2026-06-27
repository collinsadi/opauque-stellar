<div align="center">

# Opaque Stellar

### Private payments · Provable reputation · Zero wallet exposure

**The Stellar/Soroban implementation of the Opaque privacy protocol** — DKSAP stealth addresses, on-chain ZK reputation, and a Freighter-powered browser wallet.

<br/>

[![MIT License](https://img.shields.io/badge/license-MIT-ffd020?style=for-the-badge&labelColor=060914)](LICENSE)
[![Stellar Soroban](https://img.shields.io/badge/Soroban-smart%20contracts-00b2ff?style=for-the-badge&labelColor=060914)](https://soroban.stellar.org)
[![Freighter](https://img.shields.io/badge/wallet-Freighter-ffd020?style=for-the-badge&labelColor=060914)](https://freighter.app)

<br/>

[**Launch the wallet →**](frontend/) · [**GitHub**](https://github.com/collinsadi/opauque-stellar) · [**Solana sibling**](https://github.com/collinsadi/opaque-solana)

<br/>

```
   Recipient                          Sender
   ─────────                          ──────
   Publishes meta-address V ∥ S
                                      Ephemeral key → one-time Stellar account
                                      Pays XLM + announces on Soroban
   WASM scanner finds it → sweep to main wallet
```

</div>

---

## What is this?

**Opaque Stellar** is the canonical [Stellar](https://stellar.org) port of [Opaque](https://github.com/collinsadi/opaque-solana) — the same DKSAP cryptography and Groth16 reputation layer, settled on **XLM + Soroban** instead of Solana.

| Layer | What it does |
|:------|:-------------|
| **Stealth payments** | Fresh one-time receive accounts per payment — only you can derive the spend key |
| **Soroban contracts** | Registry, announcer, schemas, attestations, Groth16 + reputation verifiers |
| **Browser wallet** | Freighter signing · Rust→WASM scanner · snarkjs proofs — all on-device |
| **ZK reputation** | Prove traits without linking them to your public Stellar address |

> Experimental software. Read [DISCLAIMER.md](DISCLAIMER.md) before using real funds.

---

## Quick start

### Prerequisites

Rust · [Stellar CLI](https://developers.stellar.org/docs/build/smart-contracts/getting-started/setup) · Node 20+ · [Freighter](https://freighter.app) · [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)

```bash
git clone https://github.com/collinsadi/opauque-stellar.git
cd opauque-stellar
```

### 1 · Frontend wallet (fastest path)

Contract IDs ship in [`deployments/v1/testnet.json`](deployments/v1/testnet.json) — no deploy needed to try the UI.

```bash
npm run build:scanner          # Rust → WASM scanner
npm run fetch:circuits         # ZK artifacts (from release when published)

cd frontend
cp .env.example .env           # VITE_STELLAR_NETWORK=testnet
npm install
npm run dev
```

Open **http://localhost:5173** · connect Freighter on testnet · initialize stealth keys.

#### WASM SIMD Optimization (Optional)

For modern browsers, build with SIMD support for 1.5-3x faster scanning:

```bash
cd scanner
RUSTFLAGS="-C target-feature=+simd128,+bulk-memory" \
  wasm-pack build --release --target web --profile wasm-simd --out-dir ../frontend/public/pkg
```

**Browser requirements**: Chrome 91+, Firefox 89+, Safari 16.4+. See [WASM_SIMD_EVALUATION.md](docs/WASM_SIMD_EVALUATION.md) for details.

### 2 · Deploy contracts (optional)

```bash
cp .env.example .env
stellar keys generate opaque-deployer --network testnet --fund
# Set STELLAR_DEPLOYER=opaque-deployer in .env

npm run deploy:testnet         # build WASM + deploy + update manifest
npm run deploy:testnet -- --dry-run   # preview only
```

---

## Repository map

Everything has one job. If you only care about the wallet, start with `frontend/`.

```
opaque-stellar/
├── frontend/          React wallet (Freighter, send, receive, scan, reputation)
├── contracts/         6 Soroban smart contracts (Rust workspace)
├── scanner/           DKSAP engine → WASM for the browser
├── circuits/          Circom Groth16 circuits + regression fixtures
├── deployments/       On-chain address book (contract IDs + WASM hashes)  ← read this
├── scripts/           TypeScript tooling (deploy, verify, artifacts)
├── artifacts/         Pinned SHA-256 hashes for scanner + circuit builds
├── Cargo.toml         Rust workspace root
├── soroban.toml       Stellar CLI contract build config
├── deny.toml          cargo-deny supply-chain policy
├── package.json       Root npm scripts (tsx)
├── .env.example       Deployer config for npm run deploy:*
├── SECURITY.md        Vulnerability disclosure
└── DISCLAIMER.md      Legal / experimental notice
```

### What is `deployments/`?

**The on-chain address book.** After you deploy (or when we publish a release), `deployments/v1/testnet.json` holds every Soroban contract ID, WASM hash, and RPC URL. The frontend reads it at build time — you don't hardcode `C…` addresses in source. See [`deployments/README.md`](deployments/README.md).

### What is `circuits/fixtures/`?

**Deterministic test vectors for ZK regression.** Each folder (`v1/`, `v2/`) has `valid-input.json`, `invalid-input.json`, and `expected-public.json`. CI runs `npm run test:circuits` to prove the Circom circuits still produce the same public outputs — no drift in proof semantics.

---

## Soroban contracts

| Contract | Role |
|:---------|:-----|
| `stealth-registry` | Wallet → stealth meta-address |
| `stealth-announcer` | On-chain payment announcements (view tags) |
| `schema-registry` | Attestation schema definitions |
| `attestation-engine-v2` | Issue / revoke credentials |
| `groth16-verifier` | BN254 proof verification |
| `reputation-verifier` | Merkle roots, nullifiers, PSR checks |

Build: `stellar contract build` · Test: `cargo test --workspace`

### Protocol Read APIs

Stealth announcement schemes:

| `scheme_id` | Payloads |
|:------------|:---------|
| `1` | secp256k1 DKSAP: 20-byte stealth id, 33-byte compressed ephemeral pubkey, `metadata[0]` view tag |
| `2` | Stellar-native Ed25519 DKSAP: 32-byte raw Stellar account id, 32-byte Ed25519 ephemeral pubkey, `metadata[0]` view tag |

`reputation-verifier.are_nullifiers_spent(ids)` accepts up to 128 nullifier hashes per read and returns spent status in input order.

`attestation-engine-v2.get_attestation_count()` and `get_storage_stats()` expose write-maintained counters, so operator dashboards can read growth metrics without unbounded iteration.

---

## Scripts (TypeScript)

All root tooling is **TypeScript** run via [tsx](https://github.com/privatenumber/tsx):

| Command | Does |
|:--------|:-----|
| `npm run deploy:testnet` | Build + deploy all contracts + update manifest |
| `npm run build:scanner` | Compile scanner to `frontend/public/pkg/` |
| `npm run fetch:circuits` | Download pinned ZK artifacts |
| `npm run verify:deployment` | Validate deployment manifests |
| `npm run verify:artifacts` | Check scanner/circuit SHA-256 hashes |
| `npm run test:circuits` | Groth16 regression against fixtures |

---

## Environment

| File | Purpose |
|:-----|:--------|
| `.env` (root) | `STELLAR_DEPLOYER`, `STELLAR_NETWORK` for deploy scripts |
| `frontend/.env` | `VITE_STELLAR_NETWORK`, optional RPC overrides |

Contract IDs default from `deployments/v1/<network>.json`. Override with `VITE_TESTNET_*_CONTRACT` only for local dev.

---

## Recovery {#recovery}

Stealth **master keys** recover by re-signing with the same Freighter wallet — deterministic derivation, no server.

**Manual ghost receives** bind ephemeral keys to the browser. Back them up or you lose those funds on device loss.

Session cache (`Remember signature`) is **not** a backup — ~30 minutes per tab.

---

## Privacy {#privacy}

Stealth breaks the link between your public wallet and individual receives. It does **not** hide that you interacted with Opaque contracts, that you scanned announcements, or network-level metadata.

The in-app [privacy threat model](frontend/src/lib/privacyThreatModel.ts) maps mitigations to code.

---

## Payment links {#payment-links}

Opaque payment URLs encode amount, asset (XLM), and recipient meta-address for one-click sends. Generated in-app from the Receive tab.

---

## Cross-chain

Same DKSAP layout as [EIP-5564](https://eips.ethereum.org/EIPS/eip-5564) / [ERC-6538](https://eips.ethereum.org/EIPS/erc-6538). Meta-addresses are portable; settlement here is Stellar.

| Repo | Chain |
|:-----|:------|
| [**opauque-stellar**](https://github.com/collinsadi/opauque-stellar) (this) | Stellar / Soroban |
| [opaque-solana](https://github.com/collinsadi/opaque-solana) | Solana |

---

## Contributing

See [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md). CI is strict: `cargo test`, `clippy -D warnings`, frontend lint/typecheck/vitest, circuit regression, manifest verification.

Report vulnerabilities via [SECURITY.md](SECURITY.md).

---

<div align="center">

**[MIT License](LICENSE)** · Built by [Collins Adi](https://github.com/collinsadi)

*Every transaction deserves the right to be private.*

</div>
