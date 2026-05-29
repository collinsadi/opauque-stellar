/**
 * Generate deterministic circuit regression fixtures (V1 + V2).
 * Run: node circuits/scripts/generate-fixtures.mjs
 */

import { buildPoseidon, buildBabyjub } from "circomlibjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "..", "fixtures");
const TREE_DEPTH = 20;

// Fixed BN254 field elements for reproducible tests
const V1_STEALTH_PRIVATE = 987654321012345678901234567890123456789012345678901234567890n;
const V1_ATTESTATION_ID = 42n;
const V1_EXTERNAL_NULLIFIER = 1001n;
const V1_EPHEMERAL_PRIV = 555555555555555555555555555555555555555555555555555555555n;

const V2_STEALTH_PK = 123456789012345678901234567890123456789012345678901234567890n;
const V2_SCHEMA_ID = 7n;
const V2_ISSUER_PK_X = 5299619240641551281634865583518297030282874472190772894086521144482721001553n;
const V2_TRAIT_HASH = 3141592653589793238462643383279502884197169399375105820974944592n;
const V2_NONCE = 271828182845904523536028747135266249775724709669995956908817475n;
const V2_ATTESTATION_ID = V2_SCHEMA_ID;
const V2_EXTERNAL_NULLIFIER = 9001n;

function buildZeroHashes(poseidon, depth) {
  const F = poseidon.F;
  const zeroHashes = [F.toObject(poseidon([0n, 0n]))];
  for (let i = 1; i < depth; i++) {
    zeroHashes.push(F.toObject(poseidon([zeroHashes[i - 1], zeroHashes[i - 1]])));
  }
  return zeroHashes;
}

function merklePathFromLeaf(poseidon, leaf, depth) {
  const F = poseidon.F;
  const zeroHashes = buildZeroHashes(poseidon, depth);
  const pathElements = [];
  const pathIndices = [];
  let current = leaf;
  for (let i = 0; i < depth; i++) {
    pathElements.push(zeroHashes[i].toString());
    pathIndices.push(0);
    current = F.toObject(poseidon([current, zeroHashes[i]]));
  }
  return { merkleRoot: current, pathElements, pathIndices };
}

async function generateV1() {
  const poseidon = await buildPoseidon();
  const babyjub = await buildBabyjub();
  const F = poseidon.F;

  const stealthPriv = F.toObject(F.e(V1_STEALTH_PRIVATE));
  const ephemeralPriv = F.toObject(F.e(V1_EPHEMERAL_PRIV));
  const attestationId = V1_ATTESTATION_ID;
  const externalNullifier = V1_EXTERNAL_NULLIFIER;

  const stealthPub = babyjub.mulPointEscalar(babyjub.Base8, stealthPriv);
  const ephemeralPub = babyjub.mulPointEscalar(babyjub.Base8, ephemeralPriv);
  const sharedSecret = babyjub.mulPointEscalar(ephemeralPub, stealthPriv);

  const stealthPubX = F.toObject(stealthPub[0]);
  const stealthPubY = F.toObject(stealthPub[1]);
  const ephemeralPubX = F.toObject(ephemeralPub[0]);
  const ephemeralPubY = F.toObject(ephemeralPub[1]);
  const sharedX = F.toObject(sharedSecret[0]);
  const sharedY = F.toObject(sharedSecret[1]);

  const addressCommitment = F.toObject(poseidon([sharedX, sharedY, stealthPubX, stealthPubY]));
  const leaf = F.toObject(poseidon([addressCommitment, attestationId]));
  const { merkleRoot, pathElements, pathIndices } = merklePathFromLeaf(poseidon, leaf, TREE_DEPTH);
  const nullifier = F.toObject(poseidon([stealthPriv, externalNullifier]));

  const validInput = {
    merkle_root: merkleRoot.toString(),
    attestation_id: attestationId.toString(),
    external_nullifier: externalNullifier.toString(),
    stealth_private_key: stealthPriv.toString(),
    ephemeral_pubkey: [ephemeralPubX.toString(), ephemeralPubY.toString()],
    announcement_attestation_id: attestationId.toString(),
    merkle_path_elements: pathElements,
    merkle_path_indices: pathIndices,
  };

  const expectedPublic = {
    nullifier: nullifier.toString(),
    is_valid: "1",
    merkle_root: merkleRoot.toString(),
    attestation_id: attestationId.toString(),
    external_nullifier: externalNullifier.toString(),
  };

  const invalidInput = structuredClone(validInput);
  invalidInput.announcement_attestation_id = (attestationId + 1n).toString();

  return { validInput, expectedPublic, invalidInput };
}

async function generateV2() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  const stealthPk = F.toObject(F.e(V2_STEALTH_PK));
  const schemaId = V2_SCHEMA_ID;
  const leaf = F.toObject(
    poseidon([stealthPk, schemaId, V2_ISSUER_PK_X, V2_TRAIT_HASH, V2_NONCE]),
  );
  const { merkleRoot, pathElements, pathIndices } = merklePathFromLeaf(poseidon, leaf, TREE_DEPTH);
  const nullifierHash = F.toObject(poseidon([stealthPk, V2_EXTERNAL_NULLIFIER]));

  const validInput = {
    merkle_root: merkleRoot.toString(),
    attestation_id: V2_ATTESTATION_ID.toString(),
    external_nullifier: V2_EXTERNAL_NULLIFIER.toString(),
    nullifier_hash: nullifierHash.toString(),
    stealth_pk: stealthPk.toString(),
    schema_id: schemaId.toString(),
    issuer_pk_x: V2_ISSUER_PK_X.toString(),
    trait_data_hash: V2_TRAIT_HASH.toString(),
    nonce: V2_NONCE.toString(),
    merkle_path: pathElements,
    merkle_path_indices: pathIndices,
  };

  const expectedPublic = {
    merkle_root: merkleRoot.toString(),
    attestation_id: V2_ATTESTATION_ID.toString(),
    external_nullifier: V2_EXTERNAL_NULLIFIER.toString(),
    nullifier_hash: nullifierHash.toString(),
  };

  const invalidInput = structuredClone(validInput);
  invalidInput.nullifier_hash = (nullifierHash + 1n).toString();

  return { validInput, expectedPublic, invalidInput };
}

function writeFixture(version, files) {
  const dir = join(FIXTURES, version);
  mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    writeFileSync(join(dir, name), `${JSON.stringify(data, null, 2)}\n`);
    console.log(`Wrote fixtures/${version}/${name}`);
  }
}

async function main() {
  const v1 = await generateV1();
  writeFixture("v1", {
    "valid-input.json": v1.validInput,
    "expected-public.json": v1.expectedPublic,
    "invalid-input.json": v1.invalidInput,
  });

  const v2 = await generateV2();
  writeFixture("v2", {
    "valid-input.json": v2.validInput,
    "expected-public.json": v2.expectedPublic,
    "invalid-input.json": v2.invalidInput,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
