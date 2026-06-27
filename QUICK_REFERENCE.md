# Quick Reference: Scanner Improvements

## For Developers

### New npm Scripts

```bash
# SIMD builds
npm run build:scanner:simd    # Build with SIMD optimization

# Benchmarks
npm run bench:scanner          # Standard benchmark
npm run bench:scanner:simd     # SIMD benchmark
```

### Telemetry API (WASM)

```javascript
// Create telemetry tracker
const handle = telemetry_create();

// During scanning
telemetry_record_view_tag_match(handle);
telemetry_record_derivation_result(handle, true); // or false

// Get diagnostics
const json = telemetry_export(handle);
console.log(JSON.parse(json));
// { view_tag_matches: 1000, full_derivation_confirms: 996, 
//   view_tag_false_positives: 4, false_positive_rate: "0.40" }

// Cleanup
telemetry_destroy(handle);
```

### Checkpoint Persistence

Automatic - no code changes needed. Checkpoints are:
- Saved after each RPC chunk
- Validated on page reload
- Cleared on network change
- Max age: 7 days

### Rate Limit Backoff

Automatic - handles 429 responses with:
- Delays: 1s → 2s → 4s → 8s → 16s → 32s
- Max 5 retries
- User sees countdown in progress message

## For Users

### Resume After Reload

Long scans now resume automatically:
1. Scan interrupted (page reload, browser crash)
2. Reload page
3. Scanner resumes from last checkpoint
4. **Time saved**: ~80% of rescan time

### Rate Limit Handling

Scans now complete even with rate limits:
- Progress shows: "Rate limited. Retrying in 4s (attempt 3/5)…"
- Automatic exponential backoff
- No manual intervention needed

### SIMD Performance

For modern browsers (Chrome 91+, Firefox 89+, Safari 16.4+):
- **Expected speedup**: 1.5-3x faster scanning
- Use SIMD build for production
- Fallback to standard build for older browsers

## For Ops/DevOps

### Build Commands

```bash
# Standard build (max compatibility)
cd scanner
wasm-pack build --release --target web --out-dir ../frontend/public/pkg

# SIMD build (modern browsers only)
cd scanner
RUSTFLAGS="-C target-feature=+simd128,+bulk-memory" \
  wasm-pack build --release --target web --profile wasm-simd \
  --out-dir ../frontend/public/pkg
```

### Monitoring

Check telemetry in browser console:
```javascript
// In browser DevTools
const telemetry = telemetry_export(scannerHandle);
console.log('View-tag false positive rate:', JSON.parse(telemetry).false_positive_rate);
```

Expected: ~0.39% (1/256 theoretical rate)

### Storage Usage

- **Checkpoint**: ~150 bytes per network
- **Announcements**: ~500 bytes each
- **Total overhead**: < 0.1%

Auto-cleanup:
- Stale checkpoints (>7 days) discarded
- Network change clears checkpoints

## For QA/Testing

### Test Checkpoint Resume

1. Start long scan (testnet)
2. Reload page mid-scan
3. Verify: "Resuming from checkpoint…" message
4. Confirm: Scan continues from last ledger

### Test Rate Limit Handling

1. Use local Horizon with aggressive rate limits
2. Start scan
3. Observe retry messages with countdown
4. Confirm: Scan completes after retries

### Test SIMD Build

1. Build with SIMD: `npm run build:scanner:simd`
2. Load in Chrome 91+
3. Run benchmark: `npm run bench:scanner:simd`
4. Compare with standard build
5. Expected: 1.5-3x faster

### Browser Compatibility

| Feature | Chrome | Firefox | Safari |
|---------|--------|---------|--------|
| Telemetry | ✅ All | ✅ All | ✅ All |
| Checkpoints | ✅ All | ✅ All | ✅ All |
| Rate Limit | ✅ All | ✅ All | ✅ All |
| SIMD | ✅ 91+ | ✅ 89+ | ✅ 16.4+ |

## Troubleshooting

### Checkpoint not resuming

**Cause**: Network changed or checkpoint expired
**Fix**: Full rescan triggers automatically

### Rate limit exhausted

**Cause**: 5 retries failed
**Fix**: Wait 30s, then refresh and retry

### SIMD build not loading

**Cause**: Browser too old
**Fix**: Use standard build or update browser

## Documentation

- `docs/TELEMETRY_PRIVACY_REVIEW.md` - Privacy guarantees
- `docs/RPC_RATE_LIMIT_POLICY.md` - Rate limit details
- `docs/CHECKPOINT_PERSISTENCE.md` - Checkpoint architecture
- `docs/WASM_SIMD_EVALUATION.md` - SIMD performance
- `IMPLEMENTATION_SUMMARY.md` - Full implementation details

## Support

Issues resolved:
- #398 - View-tag collision telemetry ✅
- #397 - RPC rate-limit backoff ✅
- #396 - Checkpoint persistence ✅
- #395 - WASM SIMD evaluation ✅

For questions, refer to documentation or open new issue.
