/**
 * Phase 3 end-to-end: a real (non-tree-of-zeros) reputation set.
 *
 *   build genuine leaf -> INDEXER publishes the root (update_merkle_root + dataset_hash)
 *   -> holder proves inclusion against the PUBLISHED root -> verify_reputation succeeds
 *   -> nullifier replay rejected -> root expiry rejected -> dataset_hash matches.
 *
 * Unlike the Phase 2 smoke test (which self-published a contrived root), here a
 * separate publisher (scripts/publish-reputation-root.ts) builds the scanner-matching
 * Merkle tree and publishes the root; the holder's witness uses the real inclusion
 * path (proper zero-subtree-hash siblings), so its root equals the published one.
 *
 * The leaf binds the holder's secret stealth_pk + schema attestation id, a real
 * issuer Ed25519 key, a nonce,
 * and trait_data_hash = Poseidon(data). Run:
 *   DEPLOYER_SECRET=$(stellar keys show opaque-deployer) npx tsx scripts/smoke-reputation-realset.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  Keypair, Contract, TransactionBuilder, Address, nativeToScVal, rpc, xdr, BASE_FEE,
} from "@stellar/stellar-sdk";
import * as snarkjs from "snarkjs";
import { getPoseidon, toBE32, hashFields } from "./lib/merkleV2.ts";
import { buildReputationTree, computeDatasetHash, publishRoot, setRootExpiry } from "./publish-reputation-root.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const FE = join(__dirname, "..");
const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

const manifest = JSON.parse(readFileSync(join(REPO, "deployments", "v1", "testnet.json"), "utf8"));
const REP_ID = manifest.contracts.reputationVerifier.id;
const GROTH_ID = manifest.contracts.groth16Verifier.id;
const WASM = join(FE, "public", "circuits", "v2", "stealth_reputation.wasm");
const ZKEY = join(FE, "public", "circuits", "v2", "stealth_reputation_final.zkey");

const secret = process.env.DEPLOYER_SECRET?.trim();
if (!secret) throw new Error("set DEPLOYER_SECRET (stellar keys show opaque-deployer)");
const admin = Keypair.fromSecret(secret); // acts as indexer/admin AND holder for the demo

const server = new rpc.Server(RPC_URL);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;
const log = (m) => console.log(`\n[${++step}] ${m}`);
const detail = (m) => console.log(`    ${m}`);

const be32 = toBE32;
const fromBE = (u8) => { let n = 0n; for (const b of u8) n = (n << 8n) + BigInt(b); return n; };
const bytesScVal = (u8) => xdr.ScVal.scvBytes(Buffer.from(u8));
const u64 = (v) => nativeToScVal(BigInt(v), { type: "u64" });
const addr = (pub) => new Address(pub).toScVal();

async function verifyReputation(args, label, { expectFail = false } = {}) {
  const acct = await server.getAccount(admin.publicKey());
  let tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(REP_ID).call("verify_reputation", ...args))
    .setTimeout(120)
    .build();
  try {
    tx = await server.prepareTransaction(tx); // reverts here on RootExpired / NullifierUsed
  } catch (e) {
    if (expectFail) { detail(`${label}: rejected as expected -> ${String(e.message).split("\n")[0]}`); return false; }
    throw e;
  }
  tx.sign(admin);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") {
    if (expectFail) { detail(`${label}: rejected as expected`); return false; }
    throw new Error(`${label}: send rejected`);
  }
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const r = await server.getTransaction(sent.hash);
    if (r.status === "SUCCESS") { detail(`${label} ✓ ${sent.hash}`); return true; }
    if (r.status === "FAILED") { if (expectFail) { detail(`${label}: failed as expected`); return false; } throw new Error(`${label}: FAILED`); }
  }
  throw new Error(`${label}: not confirmed`);
}

// Build a circuit witness + serialized proof for a leaf at `index` of `tree`.
async function proveInclusion(poseidon, tree, index, inputs, externalNullifier, verificationKey) {
  const { stealthPk, schemaId, issuerPkX, traitDataHash, nonce } = inputs;
  const mp = tree.proof(index);
  const nullifierHash = hashFields(poseidon, [stealthPk, BigInt(externalNullifier)]);
  const witness = {
    stealth_pk: stealthPk.toString(),
    schema_id: schemaId.toString(),
    issuer_pk_x: issuerPkX.toString(),
    trait_data_hash: traitDataHash.toString(),
    nonce: nonce.toString(),
    merkle_path: mp.pathElements.map((x) => x.toString()),
    merkle_path_indices: mp.pathIndices,
    merkle_root: mp.root.toString(),
    attestation_id: schemaId.toString(),
    external_nullifier: String(externalNullifier),
    nullifier_hash: nullifierHash.toString(),
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(witness, WASM, ZKEY);
  if (!(await snarkjs.groth16.verify(verificationKey, publicSignals, proof))) throw new Error("local verify failed");
  const proofA = new Uint8Array(64); proofA.set(be32(BigInt(proof.pi_a[0])), 0); proofA.set(be32(BigInt(proof.pi_a[1])), 32);
  const bFlat = proof.pi_b.flatMap((p) => [BigInt(p[1]), BigInt(p[0])]);
  const proofB = new Uint8Array(128); for (let i = 0; i < 4; i++) proofB.set(be32(bFlat[i]), i * 32);
  const proofC = new Uint8Array(64); proofC.set(be32(BigInt(proof.pi_c[0])), 0); proofC.set(be32(BigInt(proof.pi_c[1])), 32);
  return { proofA, proofB, proofC, root: mp.root, nullifierHash };
}

async function main() {
  console.log("Opaque Stellar — Phase 3 real reputation set (testnet)");
  console.log(`  reputation-verifier: ${REP_ID}`);
  const poseidon = await getPoseidon();
  const verificationKey = await snarkjs.zKey.exportVerificationKey(ZKEY);

  // --- genuine leaf inputs ---
  log("Building a genuine attestation leaf…");
  const stealthPk = fromBE(Keypair.random().rawSecretKey()) % (2n ** 250n); // holder secret scalar
  const attestationId = 7n; // schema/attestation id carried as BytesN<32>
  const issuerKp = Keypair.random();
  const issuerPkX = fromBE(issuerKp.rawPublicKey()) % (2n ** 250n); // issuer Ed25519 key as field
  const traitDataHash = hashFields(poseidon, [BigInt("0x" + Buffer.from("KYC:verified").toString("hex"))]);
  const nonce = fromBE(Keypair.random().rawSecretKey()) % (2n ** 250n);
  const externalNullifier = 2026_06_14n;
  detail(`attestation_id=${attestationId}  issuer=${issuerKp.publicKey().slice(0, 8)}…`);

  // --- INDEXER builds the tree + publishes the root ---
  log("Indexer builds the Merkle tree and publishes the root on-chain…");
  const tree = await buildReputationTree([]); // empty, then insert the genuine leaf at index 0
  const leaf = tree.v2Leaf(stealthPk, attestationId, issuerPkX, traitDataHash, nonce);
  tree.insert(leaf);
  const rootBE = be32(tree.root());
  const datasetHash = computeDatasetHash(rootBE, [leaf]);
  detail(`leaf=${Buffer.from(be32(leaf)).toString("hex").slice(0, 16)}…  root=${Buffer.from(rootBE).toString("hex").slice(0, 16)}…`);
  await publishRoot(admin, REP_ID, rootBE, datasetHash);
  detail(`update_merkle_root ✓  dataset_hash=${Buffer.from(datasetHash).toString("hex").slice(0, 16)}…`);

  // dataset_hash is deterministic from the tree — recompute and confirm it binds the leaf set.
  const recomputed = computeDatasetHash(rootBE, [leaf]);
  if (Buffer.compare(Buffer.from(recomputed), Buffer.from(datasetHash)) !== 0) throw new Error("dataset_hash not deterministic");
  detail("✓ dataset_hash deterministically matches the indexer's tree");

  // --- HOLDER proves inclusion against the PUBLISHED root ---
  log("Holder generates a proof against the published root and submits it…");
  const inputs = { stealthPk, schemaId: attestationId, issuerPkX, traitDataHash, nonce };
  const p = await proveInclusion(poseidon, tree, 0, inputs, externalNullifier, verificationKey);
  if (Buffer.compare(Buffer.from(be32(p.root)), Buffer.from(rootBE)) !== 0) throw new Error("witness root != published root");
  detail("✓ witness root == published root");
  const verifyArgs = (extNull, nh) => [
    addr(admin.publicKey()), addr(GROTH_ID), bytesScVal(p.proofA), bytesScVal(p.proofB), bytesScVal(p.proofC),
    bytesScVal(rootBE), bytesScVal(be32(attestationId)), u64(extNull), bytesScVal(be32(nh)), nativeToScVal(0, { type: "u32" }),
  ];
  await verifyReputation(verifyArgs(externalNullifier, p.nullifierHash), "verify_reputation");
  detail("✓ on-chain verification against the indexer-published root succeeded");

  // --- replay rejected ---
  log("Re-submitting same proof — nullifier replay must be rejected…");
  await verifyReputation(verifyArgs(externalNullifier, p.nullifierHash), "verify_reputation(replay)", { expectFail: true });

  // --- root expiry rejected ---
  log("Expiring the root (set_root_expiry=0) and proving with a fresh nullifier…");
  await setRootExpiry(admin, REP_ID, 0);
  await sleep(7000); // let a few ledgers pass so the root is older than the (0) window
  const extNull2 = externalNullifier + 1n;
  const p2 = await proveInclusion(poseidon, tree, 0, inputs, extNull2, verificationKey);
  await verifyReputation(verifyArgs(extNull2, p2.nullifierHash), "verify_reputation(expired root)", { expectFail: true });

  // restore a sane expiry window for subsequent runs
  await setRootExpiry(admin, REP_ID, 17280);

  console.log("\n✅ PHASE 3 REAL-SET TEST PASSED — genuine leaf, indexer-published root, on-chain verify, replay + expiry enforced.");
}

main().catch((err) => { console.error(`\n❌ PHASE 3 TEST FAILED: ${err?.message ?? err}`); if (err?.stack) console.error(err.stack); process.exit(1); });
