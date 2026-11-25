/**
 * Reinstate an appealed deposit in the next ASP association set.
 *
 * Safe to run while the indexer is running: it waits for the pool's state lock
 * (held by the indexer for the duration of each tick), applies the change, and
 * records an audit decision. The next tick republishes the root.
 */
import { resolve } from "node:path";
import { FileStore } from "../src/store.ts";
import { reinstateDeposit } from "../src/reinstate.ts";

const USAGE =
  "usage: npm run asp:reinstate -- --pool-id POOL --index N [--operator NAME] [--reason TEXT] [--data-dir DIR] [--lock-timeout-ms MS]";

function optional(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function required(name: string): string {
  const value = optional(name);
  if (!value) throw new Error(USAGE);
  return value;
}

const poolId = required("--pool-id");
const index = Number(required("--index"));
const dataDir = resolve(optional("--data-dir") ?? "data");
const timeoutRaw = optional("--lock-timeout-ms");
const timeoutMs = timeoutRaw === undefined ? undefined : Number(timeoutRaw);
if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
  throw new Error("--lock-timeout-ms must be a positive number");
}

const result = await reinstateDeposit(new FileStore(dataDir), poolId, index, {
  operator: optional("--operator") ?? process.env.USER,
  reason: optional("--reason"),
  lock: { timeoutMs },
});
console.log(JSON.stringify({ ...result, nextSet: true }));
