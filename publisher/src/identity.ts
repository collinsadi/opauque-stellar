import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { hex32ToBytes, normalizeHex32 } from "./bytes.ts";

export function verifyHolderSignature(input: {
  attestationUid: string;
  schemaId: string;
  leaf: string;
  signature: string;
  stealthAddressHash: string;
}): boolean {
  try {
    const signatureHex = input.signature.trim().replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{130}$/.test(signatureHex)) return false;
    const signatureBytes = Uint8Array.from(Buffer.from(signatureHex, "hex"));
    const recovery = signatureBytes[64] >= 27 ? signatureBytes[64] - 27 : signatureBytes[64];
    if (recovery !== 0 && recovery !== 1) return false;

    const uid = normalizeHex32(input.attestationUid, "attestationUid");
    const schemaId = normalizeHex32(input.schemaId, "schemaId");
    const leaf = normalizeHex32(input.leaf, "leaf");
    const message = new TextEncoder().encode(
      `OPAQUE_REPUTATION_SUBMISSION_V1\n${uid}\n${schemaId}\n${leaf}`,
    );
    const digest = keccak_256(message);
    const publicKey = secp256k1.Signature
      .fromCompact(signatureBytes.subarray(0, 64))
      .addRecoveryBit(recovery)
      .recoverPublicKey(digest)
      .toRawBytes(false);
    const address = keccak_256(publicKey.subarray(1)).subarray(12);
    return Buffer.from(keccak_256(address)).equals(Buffer.from(hex32ToBytes(input.stealthAddressHash)));
  } catch {
    return false;
  }
}