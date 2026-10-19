/**
 * End-to-end witness construction from an attestation and a publisher-built tree.
 */
import { describe, it, expect } from "vitest";
import { buildReputationWitnessV2 } from "../../src/prove/reputation";
import { getPoseidon } from "../../src/crypto/notes";
import { bytesToBigInt } from "../../src/crypto/bytes";
import { BN254_R } from "../../src/crypto/notes";
import { buildProof } from "../../../publisher/src/merkle";
import { bigintToHex32 } from "../../../publisher/src/bytes";

const STEALTH_PRIV = new Uint8Array(32).fill(9);

async function publisherInput(externalNullifier: bigint) {
  const attestationWitness = {
    issuerPkX: 12n,
    traitDataHash: 34n,
    nonce: 56n,
  };
  const poseidon = await getPoseidon() as unknown as ((inputs: bigint[]) => unknown) & {
    F: { e(value: bigint): unknown; toObject(value: unknown): bigint };
  };
  const stealthPk = poseidon.F.toObject(poseidon.F.e(bytesToBigInt(STEALTH_PRIV)));
  const leaf = poseidon.F.toObject(poseidon([
    stealthPk,
    7n,
    attestationWitness.issuerPkX,
    attestationWitness.traitDataHash,
    attestationWitness.nonce,
  ]));
  const publisherProof = await buildProof(
    [bigintToHex32(1n), bigintToHex32(leaf), bigintToHex32(2n)],
    bigintToHex32(leaf),
  );
  return {
    attestationId: 7,
    stealthPrivKey: STEALTH_PRIV,
    externalNullifier,
    attestationWitness,
    publisherProof,
  };
}

describe("reputation V2 witness (end to end)", () => {
  it("is deterministic and well-formed", async () => {
    const input = await publisherInput(123n);
    const w1 = await buildReputationWitnessV2(input);
    const w2 = await buildReputationWitnessV2(input);

    expect(w1).toEqual(w2);
    expect(w1.attestation_id).toBe("7");
    expect(w1.external_nullifier).toBe("123");
    expect(w1.merkle_path.length).toBe(20);
    expect(w1.merkle_path_indices).toEqual(input.publisherProof.pathIndices);
    expect(w1.merkle_root).toBe(BigInt(input.publisherProof.root).toString());
    expect(w1.merkle_path_indices[0]).toBe(1);
    // field elements are < r
    expect(BigInt(w1.merkle_root)).toBeLessThan(BN254_R);
    expect(BigInt(w1.nullifier_hash)).toBeLessThan(BN254_R);
  });

  it("changes the nullifier hash when the external nullifier changes", async () => {
    const a = await buildReputationWitnessV2(await publisherInput(1n));
    const b = await buildReputationWitnessV2(await publisherInput(2n));
    expect(a.nullifier_hash).not.toBe(b.nullifier_hash);
    // same attestation + key -> same leaf/root regardless of external nullifier
    expect(a.merkle_root).toBe(b.merkle_root);
  });
});
