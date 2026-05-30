# Feature Flags

Production feature flags gate incomplete or risky UI so they cannot ship enabled on mainnet by accident (issue #128).

Implementation: `frontend/src/lib/featureFlags.ts`

---

## Flags

| Flag key | Env variable | What it gates |
|----------|--------------|---------------|
| `manualGhostAddresses` | `VITE_FEATURE_MANUAL_GHOST` | Manual ghost receive flow, import ghost, on-chain ghost announce |
| `reputationProofs` | `VITE_FEATURE_REPUTATION_PROOFS` | V2 ZK proof generation (`MyTraitsView`, `ProofGeneratorModal`) |
| `schemaManagement` | `VITE_FEATURE_SCHEMA_MANAGEMENT` | Schema Studio, attestation issuance, manage write actions |
| `demoVerifierLinks` | `VITE_FEATURE_DEMO_VERIFIER_LINKS` | Links to the standalone demo verifier app |
| `debugLogs` | `VITE_FEATURE_DEBUG_LOGS` | Protocol log panel and verbose `debugLog()` output |

Related URL (when demo links enabled): `VITE_DEMO_VERIFIER_URL`

---

## Build-time configuration (primary)

Flags are resolved at **frontend build time** from Vite env vars (`import.meta.env.VITE_*`).

### Default behavior

| Network | Default when env unset |
|---------|------------------------|
| **mainnet** | All flags **off** (explicit opt-in required) |
| testnet / futurenet / local | All flags **on**, except `debugLogs` follows dev mode |
| `debugLogs` (non-mainnet) | `true` in `vite dev`, `false` in production builds unless set |

### Mainnet production example

Set every flag explicitly in CI or `.env.production`:

```env
VITE_STELLAR_NETWORK=mainnet
VITE_STELLAR_RPC_URL=https://your-rpc.example.com
VITE_STELLAR_HORIZON_URL=https://your-horizon.example.com

# Explicit mainnet feature flags — opt in per feature after review
VITE_FEATURE_MANUAL_GHOST=false
VITE_FEATURE_REPUTATION_PROOFS=false
VITE_FEATURE_SCHEMA_MANAGEMENT=false
VITE_FEATURE_DEMO_VERIFIER_LINKS=false
VITE_FEATURE_DEBUG_LOGS=false
```

To enable a reviewed feature on mainnet:

```env
VITE_FEATURE_REPUTATION_PROOFS=true
```

### Testnet development example

```env
VITE_STELLAR_NETWORK=testnet
# Flags default to enabled; override to test disabled states:
# VITE_FEATURE_MANUAL_GHOST=false
VITE_FEATURE_DEMO_VERIFIER_LINKS=true
VITE_DEMO_VERIFIER_URL=http://localhost:5174
VITE_FEATURE_DEBUG_LOGS=true
```

---

## Runtime override (secondary)

For staging smoke tests or local debugging without rebuilding, set a partial override **before** the app bundle executes:

```html
<script>
  window.__OPAQUE_FEATURE_FLAGS__ = {
    reputationProofs: true,
    debugLogs: true,
  };
</script>
```

Runtime overrides merge on top of build-time values. They are intended for non-production use; mainnet deployments should rely on explicit `VITE_FEATURE_*` build args.

---

## UI behavior when disabled

| Feature | Disabled behavior |
|---------|-------------------|
| Manual ghost | Hidden from Receive; import/announce hidden in Private balance |
| Reputation proofs | My Traits visible **read-only** (no proof button) |
| Schema management | Schema Studio / Issue attestation hidden; Manage **read-only** |
| Demo verifier links | No external demo verifier links in proof UI |
| Debug logs | Protocol log panel hidden; `debugLog()` is a no-op |

---

## Debugging

Use `getFeatureFlags()` from `featureFlags.ts` in the browser console after import, or log at startup in dev:

```typescript
import { getFeatureFlags } from "./lib/featureFlags";
console.table(getFeatureFlags());
```

Verbose logging in application code should use `debugLog()` / `debugWarn()` from `frontend/src/lib/debugLog.ts` rather than raw `console.log`.

---

## Related docs

- [USER_RECOVERY.md](./USER_RECOVERY.md) — manual ghost backup (when flag enabled)
- [frontend/.env.example](../frontend/.env.example) — env template
- [TOKEN_SUPPORT_V1.md](../TOKEN_SUPPORT_V1.md) — future asset-scope flags
