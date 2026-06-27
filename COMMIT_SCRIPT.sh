#!/bin/bash
# Script to commit all scanner improvement changes
# Run this after reviewing the changes

set -e

echo "Committing scanner improvements (Issues #395-#398)..."

# Issue #398: Telemetry
git add scanner/src/scanner.rs scanner/src/lib.rs docs/TELEMETRY_PRIVACY_REVIEW.md
git commit -m "Add view-tag collision rate telemetry

Implements telemetry counters to track view-tag filter performance without
exposing PII or cryptographic material. Records view-tag matches, full
derivation confirms, and false positive rates for protocol analytics.

- Add ScanTelemetry struct to scanner.rs with aggregate counters
- Export WASM telemetry API: create, record, export, destroy
- Add privacy review documentation
- Telemetry contains no stealth keys, addresses, or transaction data
- False positive rate tracking validates 1/256 theoretical expectation

Resolves #398"

# Issue #397: Rate limit backoff
git add frontend/src/hooks/useScanner.ts docs/RPC_RATE_LIMIT_POLICY.md
git commit -m "Add scanner RPC rate-limit backoff

Implements exponential backoff for Horizon/RPC rate limit responses to ensure
graceful degradation and eventual sync completion under rate-limited conditions.

- Detect 429 responses via status code and error message patterns
- Exponential backoff delays: 1s, 2s, 4s, 8s, 16s, 32s max
- Max 5 retries per request with per-request counters
- Add retryStatus to ScanProgress with user-visible countdown
- Non-blocking implementation using setTimeout
- Document backoff strategy and max retry policy

Resolves #397"

# Issue #396: Checkpoint persistence
git add frontend/src/lib/opaqueCache.ts docs/CHECKPOINT_PERSISTENCE.md
git commit -m "Add incremental scan checkpoint persistence

Enables resume capability after page reloads or browser crashes during long
scans. Prevents wasting RPC quota and user time by restarting from scratch.

- Add scanCheckpoints IndexedDB store (schema v3)
- Save checkpoint after each RPC chunk with network passphrase
- Validate checkpoints: network match, timestamp, ledger range, result count
- Resume from last processed ledger on reload
- Trigger full rescan on corrupt checkpoint or network change
- Max checkpoint age: 7 days

Resolves #396"

# Issue #395: SIMD evaluation
git add scanner/benches/scanner_perf.rs scanner/Cargo.toml scanner/README.md \
       package.json README.md docs/WASM_SIMD_EVALUATION.md
git commit -m "Add scanner WASM SIMD performance evaluation

Provides infrastructure and documentation for evaluating SIMD performance gains
in the scanner engine. Includes benchmarks, build profiles, and comprehensive
browser compatibility documentation.

- Add batch and bulk operation benchmarks to scanner_perf.rs
- Configure SIMD build profiles in Cargo.toml (release-simd, wasm-simd)
- Add npm scripts: build:scanner:simd, bench:scanner, bench:scanner:simd
- Document browser SIMD requirements (Chrome 91+, Firefox 89+, Safari 16.4+)
- Provide deployment strategies and expected 1.5-3x performance gains
- Create scanner/README.md with full SIMD documentation

Resolves #395"

# Add implementation summary
git add IMPLEMENTATION_SUMMARY.md
git commit -m "Add implementation summary for scanner improvements

Comprehensive documentation of all four scanner improvement issues with
acceptance criteria verification, testing recommendations, and deployment
checklist.

Issues: #395, #396, #397, #398"

echo "✅ All commits created successfully!"
echo ""
echo "Review with: git log --oneline -5"
echo "Push with: git push origin fix/scanner-improvements"
