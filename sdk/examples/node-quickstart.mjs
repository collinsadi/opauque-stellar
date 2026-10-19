/**
 * Runnable Node quickstart for @opaquecash/stellar.
 *
 *   node examples/node-quickstart.mjs
 *
 * Demonstrates (offline, no network or wallet needed):
 *   - deriving a stealth identity + meta-address,
 *   - preparing a stealth transfer (one-time address + announcement),
 *   - scanning announcements and reconstructing the recipient's account.
 *
 * Set OPAQUE_CIRCUITS_DIR to a directory containing circuits/v2/* to also
 * generate a real Groth16 reputation proof.
 *
 * Published consumers import from "@opaquecash/stellar"; this in-repo example
 * imports the built dist directly.
 */
import {
  OpaqueClient,
  fileArtifactResolver,
} from "../dist/index.js";

const opaque = new OpaqueClient({ network: "testnet" });

// 1. Recipient derives a stealth identity from a wallet signature (any hex here).
const recipient = opaque.payments.deriveIdentity("0x" + "a1".repeat(64));
console.log("recipient meta-address:", recipient.metaHex.slice(0, 22) + "...");

// 2. Sender prepares a stealth transfer to that meta-address.
const transfer = opaque.payments.prepareTransfer(recipient.metaHex);
console.log("one-time stealth account:", transfer.stealthStellarAddress);

// 3. Recipient scans the announcement and recovers the account.
const matches = opaque.payments.scan({
  announcements: [
    {
      stealthAddress: transfer.stealthAddress,
      ephemeralPubKey: transfer.ephemeralPubKey,
      viewTag: transfer.viewTag,
    },
  ],
  identity: recipient,
});
console.log("scan found", matches.length, "transfer(s)");
console.log(
  "recovered account matches:",
  matches[0]?.stealthStellarAddress === transfer.stealthStellarAddress,
);

// 4. Optional: generate a real reputation proof if circuit artifacts are present.
const circuitsDir = process.env.OPAQUE_CIRCUITS_DIR;
if (circuitsDir) {
  const proving = new OpaqueClient({
    network: "testnet",
    artifacts: fileArtifactResolver({ baseDir: circuitsDir }),
  });
  console.log("generating reputation proof...");
  const proof = await proving.reputation.prove({
    attestationId: 7,
    stealthPrivKey: recipient.spendingKey,
    externalNullifier: 42n,
    attestationWitness,
    publisherProof,
  });
  console.log("proof generated:", {
    proofA: proof.proofA.length + " bytes",
    proofB: proof.proofB.length + " bytes",
    proofC: proof.proofC.length + " bytes",
    publicSignals: proof.publicSignals.length,
  });
} else {
  console.log("(set OPAQUE_CIRCUITS_DIR to also generate a real ZK proof)");
}

// Release snarkjs proving workers so the script ends naturally.
await opaque.dispose();
