/**
 * Headless end-to-end test for the V2 reputation flow: generate a Groth16 proof
 * for circuits/v2/stealth_reputation.circom and verify it ON-CHAIN via
 * reputation-verifier.verify_reputation -> groth16-verifier.verify_proof_v2 on testnet.
 *
 * Phase 2 uses a contrived single-leaf tree-of-zeros root (published via
 * update_merkle_root); Phase 3 replaces it with a real indexed attestation set.
 *
 * Requires the admin (deployer) secret to publish the root and submit:
 *   npm run fetch:circuits   # from the repo root
 *   DEPLOYER_SECRET=$(stellar keys show opaque-deployer) \
 *     npx tsx scripts/smoke-reputation-v2.ts
 *
 * The verification key is derived from the fetched proving key (as in
 * smoke-reputation-realset.ts) because the circuit build directory is not
 * available in CI checkouts.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  Keypair,
  Contract,
  TransactionBuilder,
  Address,
  nativeToScVal,
  rpc,
  xdr,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import * as snarkjs from "snarkjs";
// @ts-expect-error circomlibjs has no bundled types
import { buildPoseidon } from "circomlibjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const FE = join(__dirname, "..");

const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const TREE = 20;

const manifest = JSON.parse(readFileSync(join(REPO, "deployments", "v1", "testnet.json"), "utf8"));
const REP_ID = manifest.contracts.reputationVerifier.id;
const GROTH_ID = manifest.contracts.groth16Verifier.id;
const WASM = join(FE, "public", "circuits", "v2", "stealth_reputation.wasm");
const ZKEY = join(FE, "public", "circuits", "v2", "stealth_reputation_final.zkey");

const secret = process.env.DEPLOYER_SECRET?.trim();
if (!secret) throw new Error("set DEPLOYER_SECRET (stellar keys show opaque-deployer)");
const admin = Keypair.fromSecret(secret);

const server = new rpc.Server(RPC_URL);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let step = 0;
const log = (m) => console.log(`\n[${++step}] ${m}`);
const detail = (m) => console.log(`    ${m}`);

function requireArtifact(path, label) {
  if (!existsSync(path)) {
    throw new Error(
      `${label} not found at ${path}. Run "npm run fetch:circuits" from the repo root ` +
        "before running smoke:reputation.",
    );
  }
  return path;
}

function be32(v) {
  const out = new Uint8Array(32);
  let n = BigInt(v);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}
const bytesScVal = (u8) => xdr.ScVal.scvBytes(Buffer.from(u8));
const u64 = (v) => nativeToScVal(BigInt(v), { type: "u64" });
const addr = (pub) => new Address(pub).toScVal();

async function submit(tx, label) {
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") {
    throw new Error(`${label}: send rejected: ${JSON.stringify(sent.errorResult ?? sent)}`);
  }
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const r = await server.getTransaction(sent.hash);
    if (r.status === "SUCCESS") return { ledger: r.ledger, hash: sent.hash };
    if (r.status === "FAILED") throw new Error(`${label}: tx FAILED ${sent.hash}`);
  }
  throw new Error(`${label}: not confirmed`);
}

async function invoke(method, args, label) {
  const acct = await server.getAccount(admin.publicKey());
  let tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(REP_ID).call(method, ...args))
    .setTimeout(120)
    .build();
  // prepareTransaction simulates first and throws if the contract reverts
  // (e.g. NullifierUsed), which is how the replay check below detects rejection.
  tx = await server.prepareTransaction(tx);
  tx.sign(admin);
  const res = await submit(tx, label);
  detail(`${label} ✓ ${res.hash} (ledger ${res.ledger})`);
  return res;
}

async function buildProof(poseidon, verificationKey) {
  const F = poseidon.F;
  const stealth_pk = 12345678901234567890n;
  const schema_id = 42n; // == attestation_id
  const issuer_pk_x = 99n;
  const trait_data_hash = 7n;
  const nonce = 555n;
  const external_nullifier = 1001n; // must fit in u64

  const leaf = F.toObject(poseidon([stealth_pk, schema_id, issuer_pk_x, trait_data_hash, nonce]));
  let current = leaf;
  const merkle_path = [];
  const merkle_path_indices = [];
  for (let i = 0; i < TREE; i++) {
    merkle_path.push("0");
    merkle_path_indices.push(0);
    current = F.toObject(poseidon([current, 0n]));
  }
  const merkle_root = current;
  const nullifier_hash = F.toObject(poseidon([stealth_pk, external_nullifier]));

  const input = {
    stealth_pk: stealth_pk.toString(),
    schema_id: schema_id.toString(),
    issuer_pk_x: issuer_pk_x.toString(),
    trait_data_hash: trait_data_hash.toString(),
    nonce: nonce.toString(),
    merkle_path,
    merkle_path_indices,
    merkle_root: merkle_root.toString(),
    attestation_id: schema_id.toString(),
    external_nullifier: external_nullifier.toString(),
    nullifier_hash: nullifier_hash.toString(),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
  const ok = await snarkjs.groth16.verify(verificationKey, publicSignals, proof);
  if (!ok) throw new Error("local snarkjs verify failed — witness/zkey mismatch");

  // Serialize proof to the contract's BN254 byte layout (G2 = c1||c0).
  const proofA = new Uint8Array(64);
  proofA.set(be32(proof.pi_a[0]), 0);
  proofA.set(be32(proof.pi_a[1]), 32);
  const bFlat = proof.pi_b.flatMap((pair) => [pair[1], pair[0]]); // [x_c1,x_c0,y_c1,y_c0]
  const proofB = new Uint8Array(128);
  for (let i = 0; i < 4; i++) proofB.set(be32(bFlat[i]), i * 32);
  const proofC = new Uint8Array(64);
  proofC.set(be32(proof.pi_c[0]), 0);
  proofC.set(be32(proof.pi_c[1]), 32);

  return {
    proofA,
    proofB,
    proofC,
    merkle_root,
    attestation_id: schema_id,
    external_nullifier,
    nullifier_hash,
    publicSignals,
  };
}

async function main() {
  console.log("Opaque Stellar — V2 reputation proof on-chain smoke test (testnet)");
  console.log(`  reputation-verifier: ${REP_ID}`);
  console.log(`  groth16-verifier:    ${GROTH_ID}`);

  requireArtifact(WASM, "V2 witness WASM");
  requireArtifact(ZKEY, "V2 proving key");
  const VKEY = await snarkjs.zKey.exportVerificationKey(ZKEY);

  log("Generating V2 Groth16 proof (snarkjs) + local verify…");
  const poseidon = await buildPoseidon();
  const p = await buildProof(poseidon, VKEY);
  detail(`local snarkjs verify ✓  publicSignals=[root, attId, extNull, nullHash]`);
  detail(`attestation_id=${p.attestation_id}  external_nullifier=${p.external_nullifier}`);

  const root = be32(p.merkle_root);
  const datasetHash = be32(123456789n);

  log("Publishing the contrived Merkle root on reputation-verifier (admin)…");
  await invoke("update_merkle_root", [addr(admin.publicKey()), bytesScVal(root), bytesScVal(datasetHash)], "update_merkle_root");

  log("Submitting verify_reputation -> verify_proof_v2 on-chain…");
  const verifyArgs = [
    addr(admin.publicKey()),
    addr(GROTH_ID),
    bytesScVal(p.proofA),
    bytesScVal(p.proofB),
    bytesScVal(p.proofC),
    bytesScVal(root),
    bytesScVal(be32(p.attestation_id)),
    u64(p.external_nullifier),
    bytesScVal(be32(p.nullifier_hash)),
    nativeToScVal(0, { type: "u32" }),
  ];
  await invoke("verify_reputation", verifyArgs, "verify_reputation");
  detail("✓ on-chain Groth16 V2 verification returned success");

  log("Re-submitting the same proof — nullifier replay must be rejected…");
  let replayRejected = false;
  try {
    await invoke("verify_reputation", verifyArgs, "verify_reputation(replay)");
  } catch (e) {
    replayRejected = true;
    detail(`✓ nullifier replay rejected: ${String(e?.message ?? e).split("\n")[0]}`);
  }
  if (!replayRejected) throw new Error("REPLAY NOT REJECTED: nullifier reuse should fail");

  console.log("\n✅ V2 REPUTATION SMOKE TEST PASSED — Groth16 proof verified on-chain via verify_proof_v2.");
}

main().catch((err) => {
  console.error(`\n❌ V2 REPUTATION SMOKE TEST FAILED: ${err?.message ?? err}`);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
