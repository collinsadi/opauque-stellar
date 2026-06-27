# Telemetry Privacy Review

## Overview

This document reviews the privacy implications of the view-tag collision rate telemetry added in issue #398.

## Purpose

The telemetry system tracks the performance of the view-tag filter in the scanner engine to measure false positive rates. This data is used for protocol analytics and optimization.

## Data Collected

The telemetry system collects only aggregate counters:

1. **`view_tag_matches`**: Number of announcements that passed the view-tag filter
2. **`full_derivation_confirms`**: Number of view-tag matches confirmed as true positives
3. **`view_tag_false_positives`**: Number of view-tag matches that were false positives
4. **`false_positive_rate`**: Calculated percentage (derived from the above counters)

## Privacy Guarantees

### No PII or Cryptographic Material

The telemetry system explicitly does NOT collect or expose:

- Private keys (viewing or spending keys)
- Public keys or addresses
- Stealth addresses
- Ephemeral keys
- Transaction hashes or identifiers
- Timing information
- User identity information
- Network metadata

### Aggregate-Only Data

All telemetry is aggregate count data that cannot be used to:

- Identify individual transactions
- Link stealth addresses to recipients
- Determine which announcements belong to which users
- Reconstruct any part of the scanning process beyond statistical rates

### Expected False Positive Rate

The theoretical false positive rate for view-tag filtering is approximately 1/256 (0.39%). Telemetry measures the actual rate observed in production, which should align with this theoretical expectation.

### Local-Only Storage

Telemetry data is:

- Stored only in the browser's WASM memory space
- Never transmitted to external servers by the scanner
- Accessible only through the explicit `telemetry_export()` API
- Destroyed when the telemetry handle is released

## Use Cases

### Legitimate Uses

1. **Performance optimization**: Measure scanner efficiency across different devices
2. **Protocol validation**: Confirm view-tag filter behaves as specified (1/256 FP rate)
3. **Debugging**: Identify unexpected behavior in production environments
4. **Research**: Understand real-world DKSAP scanning performance

### Prohibited Uses

The telemetry system must NOT be used to:

- Track individual users
- Correlate scanning behavior with identity
- Deanonymize stealth addresses
- Monitor specific transaction patterns

## Implementation Review

### Rust Scanner (scanner.rs)

```rust
pub struct ScanTelemetry {
    pub view_tag_matches: u64,
    pub full_derivation_confirms: u64,
    pub view_tag_false_positives: u64,
}
```

The structure contains only integer counters with no reference to keys or addresses.

### WASM API (lib.rs)

The exported functions maintain privacy:

- `telemetry_create()`: Creates an opaque handle, no data collected yet
- `telemetry_record_view_tag_match(handle)`: Increments a counter
- `telemetry_record_derivation_result(handle, confirmed)`: Increments a counter
- `telemetry_export(handle)`: Returns JSON with aggregate counts only
- `telemetry_destroy(handle)`: Frees resources

### JSON Export Format

```json
{
  "view_tag_matches": 1000,
  "full_derivation_confirms": 996,
  "view_tag_false_positives": 4,
  "false_positive_rate": "0.40"
}
```

No sensitive data is included in the export.

## Recommendations

1. **Optional telemetry**: Frontend should make telemetry opt-in or allow users to disable it
2. **Clear disclosure**: Users should be informed that aggregate performance metrics are collected
3. **No remote transmission**: Telemetry should remain local unless explicitly exported by user action
4. **Audit logging**: If telemetry is transmitted, log what was sent and when

## Conclusion

The view-tag collision rate telemetry implementation satisfies privacy requirements:

- ✅ No PII exposed
- ✅ No cryptographic keys or material logged
- ✅ Aggregate-only statistics
- ✅ Local storage with explicit export
- ✅ Cannot be used to deanonymize users

This telemetry is safe for production use and provides valuable protocol analytics without compromising user privacy.

## Approval

**Privacy Review Date**: 2026-06-26  
**Reviewed By**: Scanner Team  
**Status**: APPROVED
