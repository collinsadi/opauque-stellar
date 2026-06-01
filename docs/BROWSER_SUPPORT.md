# Browser support matrix

Opaque runs entirely in the browser (WASM scanner, IndexedDB cache, in-browser Groth16 proofs, Freighter signing). Capabilities vary by platform.

## Supported (desktop)

| Browser | Connect (Freighter) | Send | Scan (WASM) | ZK proof | Withdraw | Notes |
|---------|-------------------|------|-------------|----------|----------|-------|
| Chrome 120+ (desktop) | Yes | Yes | Yes | Yes | Yes | Primary target |
| Firefox 120+ (desktop) | Yes | Yes | Yes | Yes | Yes | Requires Freighter extension |
| Edge 120+ (desktop) | Yes | Yes | Yes | Yes | Yes | Chromium-based |

**Requirements:** Freighter extension installed, WebAssembly, IndexedDB, Web Crypto, and ~500MB RAM for proof generation.

## Limited (mobile / in-app browsers)

| Environment | Connect | Send | Scan | ZK proof | Withdraw | Notes |
|-------------|---------|------|------|----------|----------|-------|
| Safari iOS | Partial | Partial | Partial | Slow / OOM risk | Partial | No Freighter on iOS; wallet in-app browsers vary |
| Chrome Android | Partial | Partial | Partial | Slow / OOM risk | Partial | Freighter mobile support evolving |
| Private / incognito | Partial | Partial | Partial | Partial | Partial | Storage may be blocked or cleared on exit |

The app shows a banner when storage or Freighter is missing. Unsupported browsers see a blocking screen at startup.

## Unsupported

- Internet Explorer
- Browsers without WebAssembly or `crypto.subtle`
- Server-side / headless environments (no wallet)

## Manual test checklist (mobile-critical flows)

Run on each target device before release:

1. Connect Freighter wallet
2. Sign stealth key setup
3. Send private payment
4. Scan announcements (WASM)
5. Generate reputation proof (snarkjs)
6. Withdraw stealth balance
7. Receive via payment link (QR + link copy)

Record pass/fail in your release notes. Automated CI runs Vitest in Node; browser capability logic is covered by `frontend/src/lib/__tests__/browserSupport.test.ts`.

## Runtime detection

On load, `assessBrowserSupport()` in `frontend/src/lib/browserSupport.ts` checks WebAssembly, IndexedDB, localStorage, Web Crypto, and Freighter injection. See `BrowserGuard` and `BrowserSupportBanner` in the frontend.
