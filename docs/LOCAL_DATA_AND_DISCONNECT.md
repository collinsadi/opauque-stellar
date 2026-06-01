# Local data, disconnect, and privacy wipe

Opaque stores sensitive metadata in the browser. This document defines what **wallet disconnect** clears versus what **Clear all local data** removes.

## Wallet disconnect

Triggered from **Profile → Disconnect Wallet**.

| Cleared | Persists |
|---------|----------|
| Master stealth keys (memory) | Ghost addresses (`opaque-ghost-addresses`) |
| Encrypted signature session (`sessionStorage`) | Transaction history |
| Vault entries (in-memory + `opaque-vault-entries`) | Schema / trait cache |
| In-memory ghost encryption password | IndexedDB `OpaqueCache` (announcements) |
| | Watchlist, pending txs, security flags |

Disconnect is a **session reset**, not a full privacy wipe. Ghost manual receives and cached announcements remain so you can resume scanning without re-importing.

Implementation: `disconnectWalletSession()` in `frontend/src/lib/localDataManager.ts` (called from `handleDisconnect` in `App.tsx`) clears master keys, vault, signature session, and in-memory ghost encryption password, then Freighter `disconnect()`.

## Clear all local data (privacy wipe)

Triggered from **Security & Recovery Settings → Clear all local data**.

Removes:

- All `opaque-*` `localStorage` keys (ghost, history, schema, reputation, watchlist, etc.)
- IndexedDB database `OpaqueCache`
- Session signature cache
- In-memory ghost encryption password
- Resets Zustand stores to empty defaults

Also disconnects the wallet and clears in-memory master keys. **Irreversible** — export ghost backups first.

Implementation: `clearAllLocalSensitiveData()` in `frontend/src/lib/localDataManager.ts`.

## Storage health

If `localStorage` or IndexedDB is unavailable (private mode, quota exceeded), the app:

- Shows a top banner (`StorageHealthBanner`)
- Toasts when ghost or reputation writes fail
- Does **not** claim ghost recovery data was saved when persist failed

See `frontend/src/lib/storageHealth.ts`.

## Related docs

- [USER_RECOVERY.md](./USER_RECOVERY.md) — what to back up
- [GHOST_THREAT_MODEL.md](./GHOST_THREAT_MODEL.md) — ghost key risks
- [BROWSER_SUPPORT.md](./BROWSER_SUPPORT.md) — mobile limitations
