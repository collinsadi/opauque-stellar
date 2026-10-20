/**
 * NaCl `crypto_box` sealing for relayer payloads. Shared between the relayer node
 * and the SDK to ensure identical encryption/decryption.
 */
import nacl from "tweetnacl";
import { assertLength, base64ToBytes, bytesToBase64, concatBytes } from "./bytes.js";

const PUBLIC_KEY_BYTES = 32;
const SECRET_KEY_BYTES = 32;
const NONCE_BYTES = 24;

function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export type X25519Keypair = {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
};

export function generateX25519Keypair(seed?: Uint8Array): X25519Keypair {
  if (seed) {
    const secretKey = assertLength(seed, SECRET_KEY_BYTES, "x25519 seed");
    const pair = nacl.box.keyPair.fromSecretKey(secretKey);
    return { publicKey: pair.publicKey, secretKey: pair.secretKey };
  }
  const pair = nacl.box.keyPair();
  return { publicKey: pair.publicKey, secretKey: pair.secretKey };
}

export function sealBox(plaintext: Uint8Array, recipientPublicKey: Uint8Array): string {
  const to = assertLength(recipientPublicKey, PUBLIC_KEY_BYTES, "recipient x25519 public key");
  const eph = nacl.box.keyPair();
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = nacl.box(plaintext, nonce, to, eph.secretKey);
  return bytesToBase64(concatBytes(eph.publicKey, nonce, ciphertext));
}

export function openBox(box: string, recipientSecretKey: Uint8Array): Uint8Array {
  const secret = assertLength(recipientSecretKey, SECRET_KEY_BYTES, "recipient x25519 secret key");
  const raw = base64ToBytes(box);
  if (raw.length < PUBLIC_KEY_BYTES + NONCE_BYTES + nacl.box.overheadLength) {
    throw new Error("Encrypted payload is too short.");
  }
  const epk = raw.slice(0, PUBLIC_KEY_BYTES);
  const nonce = raw.slice(PUBLIC_KEY_BYTES, PUBLIC_KEY_BYTES + NONCE_BYTES);
  const ciphertext = raw.slice(PUBLIC_KEY_BYTES + NONCE_BYTES);
  const opened = nacl.box.open(ciphertext, nonce, epk, secret);
  if (!opened) throw new Error("Could not decrypt relayer payload.");
  return opened;
}
