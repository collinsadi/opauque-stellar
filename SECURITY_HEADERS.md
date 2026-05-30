# Security headers for the hosted frontend (#116)

Both `frontend/public/_headers` (Cloudflare Pages / Netlify
convention) and `frontend/vercel.json` (Vercel) carry the same
policy so the deploy target is irrelevant.

## Policy summary

| Header | Value | Why |
|---|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; …` | Blocks inline script injection; explicitly allows the WASM the prover + scanner need. |
| `X-Content-Type-Options` | `nosniff` | Prevents MIME-sniffing on a script asset. |
| `X-Frame-Options` | `DENY` | We aren't embedded anywhere — clickjacking defence. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Don't leak full URLs to upstream Stellar APIs. |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=(), usb=()` | Denies every powerful API we don't use. |
| `Cross-Origin-Opener-Policy` | `same-origin` | Required for cross-origin isolated APIs (SharedArrayBuffer, perf timers). |
| `Cross-Origin-Resource-Policy` | `same-origin` | Stops cross-origin reads of bundled assets. |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` | Mandatory HTTPS. |

## CSP design choices

- **`script-src 'self' 'wasm-unsafe-eval'`** — production Vite emits
  hashed scripts, so no `'unsafe-inline'` for script. WASM streaming
  instantiation needs `'wasm-unsafe-eval'`; the broader
  `'unsafe-eval'` is intentionally NOT enabled.
- **`style-src 'self' https://fonts.googleapis.com 'unsafe-inline'`**
  — Tailwind / Vite inline base styles. `unsafe-inline` for style
  is the standard Vite trade-off; it doesn't widen script attack
  surface.
- **`connect-src`** lists the public Stellar Horizon + Soroban RPC
  endpoints. When deploying with a private RPC, add the URL here
  AND in the `network-config.ts` env vars.
- **`frame-ancestors 'none'`** — duplicates `X-Frame-Options` for
  modern browsers; both are kept for legacy coverage.
- **`upgrade-insecure-requests`** — pairs with HSTS.

## How to test

```sh
# 1. Build the frontend.
pnpm --filter opaque-stellar-frontend build

# 2. Serve `dist/` behind a static host that honours `_headers`
#    (e.g. Cloudflare's `wrangler pages dev dist`).

# 3. Run an automated scan:
curl -I https://your-preview.example.com
# Then drop the URL into https://securityheaders.com — target an A grade.
```

## Adding a new third-party connect target

1. Add the origin to **both** `frontend/public/_headers`
   (the `connect-src` clause) **and** `frontend/vercel.json`.
2. If it's a WASM source, append it to `script-src` too.
3. Re-run the header scan + the smoke e2e to confirm nothing else
   regressed.
