# Incremental Scan Checkpoint Persistence

## Overview

The scanner implements incremental checkpoint persistence to enable resume capability after page reloads or browser crashes during long scans. This prevents wasting RPC quota and user time by restarting from scratch.

## Architecture

### Storage Layer

Checkpoints are stored in IndexedDB alongside cached announcements:

```typescript
interface ScanCheckpoint {
  cluster: string;              // Network identifier
  lastProcessedLedger: number;  // Last successfully scanned ledger
  targetLedger: number;         // Target ledger for this scan
  timestamp: number;            // When checkpoint was created
  networkPassphrase: string;    // Network passphrase for validation
  partialResultsCount: number;  // Expected announcement count
}
```

### Database Schema

- **Database**: `OpaqueCache` version 3
- **Store**: `scanCheckpoints` (keyed by cluster)
- **Related stores**: `announcements`, `syncState`

## Checkpoint Lifecycle

### 1. Creation

Checkpoints are saved automatically:
- After each successful RPC chunk fetch
- Before rate limit backoff retry
- During long scan progress updates

```typescript
await saveScanCheckpoint(
  cluster,
  lastProcessedLedger,
  targetLedger,
  networkPassphrase
);
```

### 2. Validation

On page load, checkpoints are validated before resume:

#### Validation Checks

1. **Network passphrase match**: Ensures user hasn't switched networks
2. **Timestamp freshness**: Rejects checkpoints older than 7 days
3. **Ledger range sanity**: Ensures `lastProcessed <= target`
4. **Result count integrity**: Validates cached announcements match expected count

#### Validation Logic

```typescript
const isValid = await validateCheckpoint(cluster, currentNetworkPassphrase);

if (!isValid) {
  // Checkpoint corrupt or stale, trigger full rescan
  await clearScanCheckpoint(cluster);
  await clearClusterCache(cluster);
}
```

### 3. Resume

When a valid checkpoint exists:

```typescript
const checkpoint = await getScanCheckpoint(cluster);
if (checkpoint && isValid) {
  // Resume from checkpoint.lastProcessedLedger + 1
  fromBlock = BigInt(checkpoint.lastProcessedLedger + 1);
  console.log("Resuming from checkpoint at ledger", fromBlock);
}
```

The scanner:
- Loads cached announcements from IndexedDB
- Resumes RPC sync from `lastProcessedLedger + 1`
- Displays progress based on `(current - lastProcessed) / (target - lastProcessed)`

### 4. Completion

After successful scan completion:

```typescript
await clearScanCheckpoint(cluster);
```

Checkpoints are cleared to prevent stale data on next session.

## Corrupt Checkpoint Handling

### Detection

Checkpoints become corrupt when:
- Network passphrase changes (user switched networks)
- IndexedDB data is partially cleared
- Checkpoint is older than 7 days
- Result count doesn't match cached announcements

### Recovery

When corruption is detected:

1. Log warning with diagnostic info
2. Clear corrupt checkpoint from IndexedDB
3. Clear associated cluster cache
4. Trigger full rescan from deployment ledger

User sees: `"Checkpoint invalid, starting full scan…"`

### Safety

Corrupt checkpoint recovery is safe because:
- Full rescan fetches all data from chain again
- No partial/incomplete data is used
- No risk of missing announcements
- RPC quota cost is bounded by deployment ledger

## Network Change Detection

### Trigger Conditions

Network changes detected when:
- User switches from testnet → mainnet
- Environment variable `VITE_STELLAR_NETWORK` changes
- Network passphrase in checkpoint doesn't match current

### Automatic Cleanup

On network change:

```typescript
if (checkpoint.networkPassphrase !== currentNetworkPassphrase) {
  await clearScanCheckpoint(cluster);
  await clearClusterCache(cluster);
}
```

Ensures announcements from one network aren't mixed with another.

## Performance Impact

### Without Checkpoints

Long scan interrupted:
- User reloads page
- Scanner restarts from deployment ledger
- Re-fetches 50,000 ledgers (example)
- Takes 5+ minutes

### With Checkpoints

Long scan interrupted:
- User reloads page
- Scanner finds checkpoint at ledger 40,000
- Resumes from ledger 40,001
- Only fetches remaining 10,000 ledgers
- Takes ~1 minute

**Time saved**: ~80% reduction in sync time after interruption.

## Storage Overhead

### Per-Cluster Overhead

- Checkpoint record: ~150 bytes
- Negligible compared to cached announcements (~500 bytes each)

### Total Storage

Testnet example with 1000 announcements:
- Announcements: ~500 KB
- Checkpoint: ~150 bytes (0.03% overhead)

## Edge Cases

### Case 1: Checkpoint Ahead of Chain Head

If `checkpoint.targetLedger > currentLedger`:
- Checkpoint is stale (chain reorganization or time travel)
- Trigger full rescan
- Log warning

### Case 2: Multiple Concurrent Tabs

- Each tab maintains its own checkpoint
- Last tab to save checkpoint wins
- Safe because checkpoints are idempotent

### Case 3: Browser Storage Quota Exceeded

- IndexedDB write fails gracefully
- Scanner continues without checkpoint
- Next interruption triggers full rescan
- No data loss, only performance impact

### Case 4: Rapid Network Switching

- Each network change clears its checkpoint
- User may experience multiple full rescans
- Acceptable tradeoff for data integrity

## Testing Recommendations

### Manual Tests

1. **Happy path**: Start scan, reload mid-scan, verify resume
2. **Network change**: Start scan on testnet, switch to mainnet, verify full rescan
3. **Stale checkpoint**: Create checkpoint, wait 8 days, verify rejection
4. **Corrupt count**: Modify cached announcements, verify full rescan

### Automated Tests

```typescript
describe("Checkpoint persistence", () => {
  it("saves checkpoint after each chunk");
  it("resumes from checkpoint on reload");
  it("clears checkpoint on network change");
  it("triggers full rescan on corrupt checkpoint");
  it("clears checkpoint after successful completion");
});
```

## Future Enhancements

1. **Compression**: Compress checkpoint data for large scans
2. **Multi-checkpoint**: Save checkpoints for multiple concurrent scans
3. **Checkpoint versioning**: Migrate old checkpoint formats automatically
4. **Cloud backup**: Sync checkpoints across devices (opt-in)

## Acceptance Criteria

- ✅ Reload resumes from last checkpoint
- ✅ Corrupt checkpoint triggers safe full rescan
- ✅ Checkpoint cleared on network change
- ✅ Validation prevents stale/corrupt data
- ✅ Storage overhead is minimal
- ✅ Performance improvement is measurable

## Conclusion

Checkpoint persistence significantly improves user experience for long scans by enabling resume capability with automatic corruption detection and safe fallback to full rescan.
