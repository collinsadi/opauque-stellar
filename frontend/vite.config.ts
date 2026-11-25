import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'
import { visualizer } from 'rollup-plugin-visualizer'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Per-chunk bundle size budgets in bytes (minified, not gzipped). The original
// mobile-first targets were never met: this gate first ran once `tsc -b` passed
// again (#1088). Budgets are ratcheted to the measured sizes plus ~5% headroom so
// any further growth fails the build; lower them as chunks are slimmed down.
const BUNDLE_BUDGETS: Record<string, number> = {
  'vendor': 450 * 1024,      // React, React DOM, routing (measured 430KB)
  'stellar': 1060 * 1024,    // Stellar SDK and Freighter (measured 1012KB)
  'crypto': 150 * 1024,      // Elliptic curve crypto
  'state': 50 * 1024,        // State management (Zustand, IDB)
  'animation': 125 * 1024,   // Framer Motion (measured 120KB)
  'prover': 3200 * 1024,     // Snarkjs and Circomlib, lazy-loaded (measured 3067KB)
  'index': 80 * 1024,        // App entry point and main logic
  'polyfills': 30 * 1024,    // Buffer and other polyfills
  'styles': 20 * 1024,       // CSS (including Tailwind)
}

const chunkGroups: Array<[string, string[]]> = [
  [
    'polyfills',
    [
      '/node_modules/buffer/',
      '/node_modules/base64-js/',
      '/node_modules/ieee754/',
      '/node_modules/process/',
    ],
  ],
  [
    'vendor',
    [
      '/node_modules/react/',
      '/node_modules/react-dom/',
      '/node_modules/react-router/',
      '/node_modules/react-router-dom/',
    ],
  ],
  ['stellar', ['/node_modules/@stellar/stellar-sdk/', '/node_modules/@stellar/freighter-api/']],
  ['crypto', ['/node_modules/@noble/curves/', '/node_modules/@noble/hashes/']],
  ['state', ['/node_modules/zustand/', '/node_modules/idb/']],
  ['animation', ['/node_modules/framer-motion/']],
  ['prover', ['/node_modules/snarkjs/', '/node_modules/circomlibjs/']],
]

function manualChunks(id: string) {
  const normalizedId = id.replaceAll('\\', '/')
  const match = chunkGroups.find(([, modulePaths]) =>
    modulePaths.some((modulePath) => normalizedId.includes(modulePath)),
  )
  return match?.[0]
}

function checkBundleSizes() {
  return {
    name: 'check-bundle-sizes',
    writeBundle: async (_options: any, bundle: Record<string, any>) => {
      const violations: Array<{ file: string; size: number; budget: number; exceeded: number }> = []

      for (const [fileName, file] of Object.entries(bundle)) {
        if (typeof file === 'object' && file.type === 'asset') {
          const code = file.source as string | Uint8Array
          const size = typeof code === 'string' ? Buffer.byteLength(code) : code.length

          for (const [chunkName, budget] of Object.entries(BUNDLE_BUDGETS)) {
            if (fileName.includes(chunkName) && size > budget) {
              violations.push({
                file: fileName,
                size,
                budget,
                exceeded: size - budget,
              })
            }
          }
        } else if (typeof file === 'object' && file.code) {
          const size = Buffer.byteLength(file.code)

          for (const [chunkName, budget] of Object.entries(BUNDLE_BUDGETS)) {
            if (fileName.includes(chunkName) && size > budget) {
              violations.push({
                file: fileName,
                size,
                budget,
                exceeded: size - budget,
              })
            }
          }
        }
      }

      if (violations.length > 0) {
        console.error('\n❌ Bundle size violations detected:')
        for (const violation of violations) {
          const sizeKb = (violation.size / 1024).toFixed(2)
          const budgetKb = (violation.budget / 1024).toFixed(2)
          console.error(
            `  ${violation.file}: ${sizeKb}KB (budget: ${budgetKb}KB, exceeded by ${(violation.exceeded / 1024).toFixed(2)}KB)`
          )
        }
        console.error(
          '\n💡 To waive a budget increase, add a comment in the PR explaining the reason and update BUNDLE_BUDGETS in vite.config.ts.'
        )
        throw new Error(`Bundle size budgets exceeded for ${violations.length} chunk(s)`)
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), wasm(), topLevelAwait(), checkBundleSizes(),
    visualizer({
      open: false,
      filename: 'dist/stats.html',
      brotliSize: true,
    })
  ],
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
  resolve: {
    alias: [
      { find: '@wasm', replacement: path.resolve(__dirname, 'public/pkg') },
      { find: '@deployments', replacement: path.resolve(__dirname, '../deployments') },
      { find: '@relayer', replacement: path.resolve(__dirname, '../relayer/src') },
      { find: '@opaquecash/stellar', replacement: path.resolve(__dirname, '../sdk/src') },
      {
        find: '@stellar/stellar-sdk',
        replacement: path.resolve(__dirname, 'node_modules/@stellar/stellar-sdk'),
      },
      { find: '@noble/hashes', replacement: path.resolve(__dirname, 'node_modules/@noble/hashes') },
      { find: 'tweetnacl', replacement: path.resolve(__dirname, 'node_modules/tweetnacl') },
      { find: /^buffer$/, replacement: path.resolve(__dirname, 'node_modules/buffer/index.js') },
      { find: /^process$/, replacement: path.resolve(__dirname, 'node_modules/process/browser.js') },
      {
        find: /^process\/browser$/,
        replacement: path.resolve(__dirname, 'node_modules/process/browser.js'),
      },
    ],
  },
  server: {
    fs: {
      allow: [path.resolve(__dirname, '..')],
    },
  },
  optimizeDeps: {
    // Prevent Vite from pre-bundling/corrupting the WASM binary
    exclude: ['opauque-scanner', '@wasm/opauque_scanner.js', '/pkg/opauque_scanner.js'],
  },
})
