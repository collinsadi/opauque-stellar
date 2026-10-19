/**
 * Local development helper for inserting holder-submitted leaf commitments into
 * the publisher inbox.
 *
 * Usage:
 *   npm run submit:leaf -- --leaf 0x... --schema-id 0x... --attestation-uid 0x... --holder-signature 0x...
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FileStore } from "../src/store.ts";
import { normalizeCommitment } from "../src/store.ts";
import { validateLeafCommitment } from "../src/validate.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function main() {
  const validateOnly = process.argv.includes("--validate");

  const leaf = arg("leaf");
  if (!leaf) throw new Error("usage: npm run submit:leaf -- --leaf 0x... [--id id] [--validate]");

  const raw = {
    id: arg("id"),
    leaf,
    schemaId: arg("schema-id"),
    attestationUid: arg("attestation-uid"),
    holderSignature: arg("holder-signature"),
    txHash: arg("tx-hash"),
    ledger: arg("ledger") ? Number(arg("ledger")) : undefined,
  };

  const result = validateLeafCommitment(raw);
  if (!result.ok) {
    console.error(`validation failed:\n${result.errors.map((e) => `  - ${e}`).join("\n")}`);
    process.exit(1);
  }

  if (validateOnly) {
    console.log("validation passed:");
    console.log(JSON.stringify(result.commitment, null, 2));
    return;
  }

  const commitment = normalizeCommitment(raw, () => new Date().toISOString());
  const dataDir = process.env.PUBLISHER_DATA_DIR
    ? resolve(process.env.PUBLISHER_DATA_DIR)
    : join(__dirname, "..", "data");
  const store = new FileStore(dataDir);
  store.writeInbox(commitment);
  console.log(`queued leaf ${commitment.leaf} in ${join(dataDir, "inbox")}`);
}

main();
