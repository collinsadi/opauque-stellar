# Opaque Stellar Mainnet Runbook

## Overview

This runbook defines the monitoring, alerting, and incident response procedures
for the Opaque Stellar mainnet deployment. The system comprises:

- **Soroban smart contracts** (6 contracts) deployed on Stellar mainnet
- **Frontend wallet** (React/TypeScript) served via CDN/IPFS
- **Scanner engine** (Rust WASM) embedded in the frontend for stealth address detection
- **Indexer** (optional) for event backfill and historical scans

For the initial **testnet → mainnet promotion** procedure (build, deploy, init, admin transfer, smoke tests), see **[MAINNET_PROMOTION_RUNBOOK.md](./MAINNET_PROMOTION_RUNBOOK.md)**.

---

## Alert Rules

| Alert Name | Description | Severity | Response Time |
|---|---|---|---|
| `root_expiry` | Scanner has not synced in 5 minutes | P0 | 15 min |
| `rpc_failures` | >3 RPC failures in 1 hour | P1 | 30 min |
| `high_tx_failure_rate` | >20% contract call failures | P0 | 15 min |
| `proof_verification_failures` | Any proof verification failure | P1 | 30 min |

---

## Dashboards

### Mainnet Health Dashboard
- **Contract call success rate** (24h)
- **Scanner sync lag** (latest ledger vs last synced)
- **RPC availability** (% uptime per provider)
- **Critical wallet balances** (admin, deployer, multisig)
- **Proof verification rate** (success/failure per hour)

### Scanner Performance Dashboard
- **Announcements processed per minute**
- **WASM matching throughput**
- **View tag false positive rate**
- **Indexer lag** (blocks behind latest)

---

## Incident Response

### P0: Scanner Not Syncing (root_expiry)

1. Check Soroban RPC health:
   ```bash
   curl -X POST https://mainnet.sorobanrpc.com -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
   ```
2. Verify Horizon endpoint:
   ```bash
   curl https://horizon.stellar.org
   ```
3. Check latest ledger:
   ```bash
   curl -s https://horizon.stellar.org/ledgers?order=desc&limit=1 | jq '._embedded.records[0].sequence'
   ```
4. If RPC/Horizon are healthy, restart the scanner:
   - Frontend: reload the application
   - Indexer: restart the indexer service
5. If RPC is degraded, fail over to fallback RPC:
   - Set `VITE_STELLAR_RPC_FALLBACK_URLS` to an alternative provider
6. Escalate to Soroban RPC provider if unavailable for >30 min.

### P0: High Transaction Failure Rate

1. Identify failing contract and method from metrics.
2. Check contract state via simulation:
   ```bash
   stellar contract invoke --id <CONTRACT_ID> --source <ADMIN> --network mainnet \
     -- <METHOD> <ARGS>
   ```
3. Verify contract WASM hash matches deployment manifest:
   ```bash
   node scripts/verify-deployment-manifest.mjs --network mainnet --check-wasm --strict
   ```
4. If contract is corrupted, propose upgrade via multisig.
5. If network congestion, retry with higher fee.

### P1: RPC Failures

1. Verify alternative RPC endpoints:
   - Check `VITE_STELLAR_RPC_FALLBACK_URLS` configuration
   - Test each fallback:
     ```bash
     curl -X POST <FALLBACK_URL> -H "Content-Type: application/json" \
       -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
     ```
2. Update RPC provider priority.
3. If all RPC endpoints fail, declare Stellar network outage.

### P1: Proof Verification Failures

1. Check Groth16 verifier contract state.
2. Verify circuit artifacts match deployment manifest:
   ```bash
   sha256sum circuits/v2/*.zkey
   ```
3. Confirm verification key matches on-chain verifier.
4. If verifier key mismatch, redeploy verifier contract.

---

## Recovery Procedures

### Contract Upgrade

1. Build new contract WASM:
   ```bash
   stellar contract build
   ```
2. Compute WASM hash:
   ```bash
   sha256sum target/wasm32-unknown-unknown/release/<contract>.wasm
   ```
3. Update deployment manifest:
   ```bash
   node scripts/update-manifest-wasm-hashes.mjs
   ```
4. Deploy via multisig:
   ```bash
   stellar contract deploy --wasm <WASM_PATH> --source <ADMIN> --network mainnet
   ```
5. Verify:
   ```bash
   npm run verify:deployment:strict
   ```

### Frontend Rollback

1. Identify last known good build commit from deployment manifest.
2. Rebuild from that commit:
   ```bash
   git checkout <LAST_GOOD_COMMIT>
   cd frontend && npm ci && npm run build
   ```
3. Publish to CDN/IPFS.
4. Update deployment manifest with new frontend artifact hash.

---

## Owner & Escalation

| Role | Name | Contact |
|---|---|---|
| Primary On-Call | Opaque Team | #ops-channel (Discord) |
| Contract Admin | Protocol DAO | Multisig |
| RPC Provider | Soroban RPC | #stellar-network (Discord) |

---

## Maintenance Windows

Scheduled contract upgrades or RPC migrations must be announced 48h in advance
via the Opaque status page and Discord #announcements channel.
