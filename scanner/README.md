# Opaque Scanner — WASM Cryptography Engine

Rust-based DKSAP scanner engine compiled to WebAssembly for browser-native stealth address scanning.

## Features

- EIP-5564 DKSAP stealth address derivation
- View-tag filtering (1/256 false positive rate)
- Ed25519 support for Stellar-native scheme
- Groth16 circuit witness generation
- Zero server dependency (runs entirely in browser)

## Building

### Standard Build

Maximum browser compatibility:

```bash
wasm-pack build --release --target web
```

Output: `pkg/` directory with WASM module and JS bindings.

### SIMD-Optimized Build

For modern browsers (Chrome 91+, Firefox 89+, Safari 16.4+):

```bash
RUSTFLAGS="-C target-feature=+simd128,+bulk-memory" \
  wasm-pack build --release --target web --profile wasm-simd
```

Expected performance gain: 1.5-3x faster scanning operations.

See [WASM_SIMD_EVALUATION.md](../docs/WASM_SIMD_EVALUATION.md) for detailed benchmarks.

### Development Build

With debug symbols:

```bash
wasm-pack build --dev --target web
```

## Benchmarking

### Run Performance Tests

```bash
# Standard build
cargo bench --bench scanner_perf

# SIMD build (compare performance)
RUSTFLAGS="-C target-feature=+simd128" cargo bench --bench scanner_perf
```

Benchmarks cover:
- View-tag filtering (10K announcements)
- Full stealth address derivation (5K addresses)
- Batch processing operations
- WASM initialization overhead

### npm Scripts

From project root:

```bash
# Standard benchmark
npm run bench:scanner

# SIMD benchmark
npm run bench:scanner:simd
```

## Browser SIMD Support

| Browser | SIMD Support | Minimum Version |
|---------|--------------|----------------|
| Chrome  | ✅ Yes | 91+ (May 2021) |
| Firefox | ✅ Yes | 89+ (June 2021) |
| Safari  | ✅ Yes | 16.4+ (March 2023) |
| Edge    | ✅ Yes | 91+ (May 2021) |

Check support at runtime:

```javascript
const simdSupported = WebAssembly.validate(
  new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])
);
```

## Build Profiles

### Release Profile

Production-ready with full optimizations:

```toml
[profile.release]
opt-level = 3
lto = true
codegen-units = 1
panic = "abort"
```

### WASM-SIMD Profile

Inherits release settings, intended for SIMD builds:

```toml
[profile.wasm-simd]
inherits = "release"
opt-level = 3
lto = true
```

Usage:

```bash
wasm-pack build --release --profile wasm-simd
```

## Testing

### Unit Tests

```bash
cargo test
```

Tests include:
- DKSAP round-trip validation
- View-tag correctness
- Ed25519 stealth account derivation
- Public key validation (issue #53)

### Integration Tests

From project root:

```bash
npm test  # Runs frontend tests that exercise WASM bindings
```

## API Overview

### Core Functions

```rust
// Derive stealth address and view tag
pub fn derive_stealth_address_wasm(
    view_privkey_bytes: &[u8],
    spend_pubkey_bytes: &[u8],
    ephemeral_pubkey_bytes: &[u8],
) -> Result<JsValue, JsValue>;

// Check announcement ownership
pub fn check_announcement_wasm(
    announcement_stealth_address: &str,
    view_tag: u8,
    view_privkey_bytes: &[u8],
    spend_pubkey_bytes: &[u8],
    ephemeral_pubkey_bytes: &[u8],
) -> Result<bool, JsValue>;

// Quick view-tag filter
pub fn check_announcement_view_tag_wasm(
    view_tag: u8,
    view_privkey_bytes: &[u8],
    ephemeral_pubkey_bytes: &[u8],
) -> Result<String, JsValue>;
```

### Telemetry Functions

```rust
// Create telemetry instance
pub fn telemetry_create() -> u32;

// Record view-tag match
pub fn telemetry_record_view_tag_match(handle: u32) -> Result<(), JsValue>;

// Record derivation result
pub fn telemetry_record_derivation_result(handle: u32, confirmed: bool) -> Result<(), JsValue>;

// Export diagnostics
pub fn telemetry_export(handle: u32) -> Result<String, JsValue>;

// Cleanup
pub fn telemetry_destroy(handle: u32) -> Result<(), JsValue>;
```

See [TELEMETRY_PRIVACY_REVIEW.md](../docs/TELEMETRY_PRIVACY_REVIEW.md) for privacy guarantees.

## Size Optimization

### Standard Build Size

Typical WASM module size: ~250-350 KB (before gzip).

### Optimization Tips

1. **Strip debug info**: Automatically done in release mode
2. **Enable LTO**: Set `lto = true` in Cargo.toml
3. **Single codegen unit**: `codegen-units = 1` for better optimization
4. **wasm-opt**: Post-process with binaryen:

```bash
wasm-opt pkg/cryptography_bg.wasm -O3 -o pkg/cryptography_bg.wasm
```

5. **Compression**: Serve with gzip/brotli (typically 60-70% reduction)

## Performance Targets

### Desktop (x86_64, Chromium)

- View-tag filter: < 5ms per 1000 announcements
- Full derivation: < 40ms per 1000 addresses
- WASM init: < 10ms

### Mobile (ARM64, Safari iOS)

- View-tag filter: < 15ms per 1000 announcements
- Full derivation: < 100ms per 1000 addresses
- WASM init: < 30ms

SIMD builds improve these targets by 1.5-3x on supported devices.

## Troubleshooting

### Build Failures

**Error**: `wasm-pack` not found

```bash
cargo install wasm-pack
```

**Error**: Linking issues on macOS

```bash
xcode-select --install
```

### Runtime Errors

**Error**: WASM validation failed

Check browser version supports WASM 1.0 (all modern browsers).

**Error**: Memory allocation failed

Increase WASM memory limit (default 16MB may be too low for large scans):

```javascript
const memory = new WebAssembly.Memory({ initial: 256, maximum: 512 });
```

## Contributing

Run tests and benchmarks before submitting PRs:

```bash
cargo test
cargo clippy -- -D warnings
cargo bench --bench scanner_perf
```

## Documentation

- [WASM_SIMD_EVALUATION.md](../docs/WASM_SIMD_EVALUATION.md) — SIMD performance analysis
- [TELEMETRY_PRIVACY_REVIEW.md](../docs/TELEMETRY_PRIVACY_REVIEW.md) — Privacy guarantees
- [EIP-5564](https://eips.ethereum.org/EIPS/eip-5564) — DKSAP specification

## License

MIT — see [../LICENSE](../LICENSE)
