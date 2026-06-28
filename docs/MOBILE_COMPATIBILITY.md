# Mobile Wallet Browser Compatibility Matrix

> Last updated: 2026-06-28 · Next review: 2026-09-28

## Supported browsers

| Browser | Freighter | WASM scanner | ZK proofs (snarkjs) | Notes |
|:--------|:----------|:-------------|:--------------------|:------|
| **Safari iOS** | ✅ | ✅ (16.4+) | ✅ | WASM requires 16.4+. SIMD unsupported on iOS. |
| **Chrome Android** | ✅ (Freighter APK) | ✅ (91+) | ✅ | Full desktop-class WASM + SIMD support. |
| **Firefox Android** | ⚠️ (experimental) | ✅ (89+) | ✅ | Freighter add-on is beta; WASM works. |
| **Samsung Internet** | ❌ | ✅ (91+ Chromium) | ✅ | No Freighter extension. Can view wallet via dApp browser. |
| **Brave Android** | ✅ | ✅ (91+ Chromium) | ✅ | Freighter installs from Chrome Web Store. |

## Known WASM limitations

| Limitation | Affected browsers | Mitigation |
|:-----------|:-----------------|:-----------|
| No SIMD on iOS Safari | iOS 16.4+ | Falls back to scalar WASM path (~2x slower). |
| No bulk-memory on iOS <16.4 | iOS | Requires 16.4+; older versions show `WasmUnsupportedNotice`. |
| Large WASM (5 MB+) load time | All mobile | First scan may take 3–8 s on slow connections. |
| snarkjs proving (≥500 MB heap) | iOS Safari | May fail on devices with <4 GB RAM. |

## Retest schedule

- **Automated:** E2E tests on BrowserStack (Safari iOS, Chrome Android) — run on each PR.
- **Manual:** Full matrix pass every quarter (next: 2026-09-28).
- **Ad-hoc:** When Freighter or WASM build toolchain versions change.

## How to add a new browser

1. Run the WASM scanner self-test (`useScanner` hook).
2. Run a full ZK proof cycle (`snarkjs.groth16.fullProve`).
3. Install and connect Freighter (if available).
4. Update matrix above and the retest schedule.
