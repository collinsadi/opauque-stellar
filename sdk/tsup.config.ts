import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as {
  version: string;
};

export default defineConfig({
  entry: {
    index: "src/index.ts",
    node: "src/node.ts",
    "crypto/index": "src/crypto/index.ts",
    "relayer-protocol/index": "src/relayer-protocol/index.ts",
    // Freighter signer: its own entry so the optional `@stellar/freighter-api`
    // peer is never referenced from the main bundle (#1079).
    freighter: "src/signer/freighter.ts",
    // Standalone Node worker_threads / browser Worker entry point for the
    // proof worker pool (src/prove/worker-pool.ts loads it by URL at runtime,
    // so it must build to its own chunk rather than get inlined elsewhere).
    "prove-worker-runtime": "src/prove/worker-runtime.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  target: "es2022",
  // Inject the package version so `VERSION` always matches package.json (single
  // source of truth; Changesets bumps only package.json).
  define: {
    __SDK_VERSION__: JSON.stringify(version),
  },
});
