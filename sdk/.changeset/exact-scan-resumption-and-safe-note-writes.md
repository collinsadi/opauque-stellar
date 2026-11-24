---
"@opaquecash/stellar": minor
---

Make event scans exact across page boundaries and retention gaps, keep the viewing key out of scan cursor keys, and make encrypted note writes safe under concurrency.

- **Retention gaps are reported, not skipped.** A scan whose start ledger the RPC has pruned now exposes the pruned range as `retentionGap` on its pages. `scanIterator` throws `RetentionGapError` unless `allowRetentionGap` is set, and `onRetentionGap` reports the range when it is. `reconstructState` raises it too, instead of silently starting from a fixed 16,000-ledger lookback. Pass the pool's `startLedger` (its deployment ledger) to read only the pool's own history.
- **Exact resumption across page boundaries.** A page that ends partway through a ledger no longer marks that ledger as done. `scanIterator` holds matches from the newest ledger until the scan moves past it, and persists the ledger before it, so a resumed run re-reads that ledger in full. An event the RPC repeats is counted once. `EventTruncationError.lastScannedLedger` now means the last ledger read in full.
- **Scan cursor keys are one-way.** `scanCursorKey` derives from the public viewing key with a domain-separated SHA-256, so no private key material reaches a `ScanStore`. A cursor saved under the previous key migrates on first scan. `ScanStore` gains an optional `deleteCursor`, which the migration uses to retire the old entry.
- **Encrypted stores are safe to write concurrently.** Read-modify-write cycles are serialized per storage key, PBKDF2 runs once per unlock rather than once per write, and `fileBackend` writes atomically (temp file, fsync, rename).
