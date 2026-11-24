/**
 * Cross-verify a published ASP manifest against the ASP's public key (#1081).
 *
 *   npm run verify:manifest -- --key G... --manifest data/sets/<poolId>/latest.json
 *   npm run verify:manifest -- --key G... --url https://asp.example.com/manifest/0x...
 *
 * Checks, needing only public data:
 *   1. the Ed25519 signature over the canonical encoding verifies for --key;
 *   2. `datasetHash` matches the manifest's own root + labels (the value posted on-chain);
 *   3. the Poseidon Merkle root recomputed from `labels` equals `root`;
 *   4. `levels` matches the withdraw circuit's ASP tree depth.
 * Compare the printed root and dataset hash with the on-chain `aspRoot` to close the loop.
 */
import { readFileSync } from "node:fs";
import { StrKey } from "@stellar/stellar-sdk";
import { MerkleTree, TREE_DEPTH, getPoseidon, toHex32 } from "../src/merkle.ts";
import { computeDatasetHash, verifyManifestSignature } from "../src/publish.ts";
import type { SetManifest } from "../src/types.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function loadManifest(): Promise<SetManifest> {
  const file = arg("--manifest");
  const url = arg("--url");
  if ((file ? 1 : 0) + (url ? 1 : 0) !== 1) throw new Error("pass exactly one of --manifest <file> or --url <url>");
  if (file) return JSON.parse(readFileSync(file, "utf8")) as SetManifest;
  const res = await fetch(url!, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} returned ${res.status}`);
  return (await res.json()) as SetManifest;
}

async function main(): Promise<void> {
  const key = arg("--key") ?? process.env.ASP_MANIFEST_PUBLIC_KEY;
  if (!key || !StrKey.isValidEd25519PublicKey(key)) {
    throw new Error("pass the ASP's published public key with --key G... (or ASP_MANIFEST_PUBLIC_KEY)");
  }
  const manifest = await loadManifest();
  const failures: string[] = [];

  if (!verifyManifestSignature(manifest, key)) failures.push("signature does not verify for the given key");
  if (computeDatasetHash(manifest.root, manifest.labels) !== manifest.datasetHash?.toLowerCase()) {
    failures.push("datasetHash does not match root + labels");
  }
  if (manifest.levels !== TREE_DEPTH) failures.push(`levels ${manifest.levels} != circuit depth ${TREE_DEPTH}`);

  const tree = new MerkleTree(await getPoseidon(), TREE_DEPTH);
  for (const label of manifest.labels) tree.insert(BigInt(label));
  const computedRoot = toHex32(tree.root());
  if (computedRoot !== manifest.root.toLowerCase()) failures.push(`labels hash to ${computedRoot}, not ${manifest.root}`);

  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL: ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `PASS: pool ${manifest.poolId} root ${manifest.root} (${manifest.labels.length} labels, ledger ${manifest.ledger}, policy ${manifest.policy})`,
  );
  console.log(`      datasetHash ${manifest.datasetHash} signed by ${key}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `FAIL: ${error.message}` : error);
  process.exitCode = 1;
});
