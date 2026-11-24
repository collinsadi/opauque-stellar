/**
 * Bundle size budget gate for browser SDK builds.
 *
 * Gzips each entry point's ESM output (what a bundler ships to the browser)
 * and fails if it exceeds its budget, so a dependency bump can't silently
 * double what integrators download. Runs as part of `npm run build`; CJS
 * output is not budgeted here since it targets Node, not the browser.
 *
 *   node scripts/check-bundle-size.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const KIB = 1024;

// Budgets are gzipped KiB, per ESM entry point. Raise deliberately (with a
// note why) rather than silently when a change grows the bundle.
const BUDGETS_KIB = {
  // Raised 52 -> 62 KiB in #1004-#1007: the full relayer-registry binding
  // (operator lifecycle, job/relayer reads, slashing) and the pool state reads
  // behind `isDepositCovered`. This entry point ships unminified, so its doc
  // comments are counted against the budget too.
  "dist/index.js": 62,
  "dist/crypto/index.js": 26,
  "dist/relayer-protocol/index.js": 6,
  "dist/freighter.js": 4,
};

function formatKib(bytes) {
  return `${(bytes / KIB).toFixed(2)} KiB`;
}

let failed = false;
const rows = [];

for (const [file, budgetKib] of Object.entries(BUDGETS_KIB)) {
  const path = join(process.cwd(), file);
  if (!existsSync(path)) {
    console.error(`[bundle-size] missing build output: ${file} (run the build first)`);
    failed = true;
    continue;
  }
  const gzipBytes = gzipSync(readFileSync(path)).length;
  const budgetBytes = budgetKib * KIB;
  const deltaBytes = gzipBytes - budgetBytes;
  const over = deltaBytes > 0;
  if (over) failed = true;
  rows.push({ file, gzipBytes, budgetBytes, deltaBytes, over });
}

console.log("\nBundle size budget (gzip, ESM):\n");
for (const r of rows) {
  const status = r.over ? "FAIL" : "ok";
  const sign = r.deltaBytes >= 0 ? "+" : "";
  console.log(
    `  [${status}] ${r.file.padEnd(32)} ${formatKib(r.gzipBytes).padStart(11)} / ${formatKib(r.budgetBytes).padStart(11)} budget (${sign}${formatKib(r.deltaBytes)})`,
  );
}
console.log("");

if (failed) {
  console.error(
    "Bundle size budget exceeded. Reduce the bundle, or raise the budget in scripts/check-bundle-size.mjs with a note why.\n",
  );
  process.exit(1);
}
