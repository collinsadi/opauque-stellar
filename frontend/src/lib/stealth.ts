/**
 * Opaque Protocol — Client-side stealth address crypto (DKSAP)
 *
 * Implements the Dual-Key Stealth Address Protocol: senders derive a one-time
 * stealth address from the recipient's meta-address (viewing + spending public keys);
 * recipients use their viewing key to detect transfers and spending key to sweep.
 * Uses @noble/curves secp256k1; compatible with the Rust WASM scanner.
 *
 * Stellar adaptation: the scanner uses the 20-byte Keccak stealth id; funds are held
 * on a deterministic Ed25519 Stellar account derived from the stealth secp256k1 point.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { Keypair } from "@stellar/stellar-sdk";
import { formatStroopsToXlm } from "./decimalParser";

const CURVE = secp256k1;
const DOMAIN = "opaque-cash-v1";
const PROTOCOL_VERSION = "1";

// Hex string type for compatibility
export type Hex = `0x${string}`;

export type DomainSeparationOpts = {
  origin: string;
  networkPassphrase: string;
  walletPublicKey: string;
  purpose: string;
};

export function buildDomainSeparatedMessage(
  opts: DomainSeparationOpts,
): string {
  return [
    `--- Opaque Protocol Key Derivation ---`,
    `App: Opaque Stellar`,
    `Origin: ${opts.origin}`,
    `Network: ${opts.networkPassphrase}`,
    `Wallet: ${opts.walletPublicKey}`,
    `Version: ${PROTOCOL_VERSION}`,
    `Purpose: ${opts.purpose}`,
    ``,
    `Warning: Signing this message authorizes key derivation for the Opaque protocol.`,
    `This is not a transaction and does not move funds.`,
    `Do not sign this message on untrusted sites or applications.`,
  ].join("\n");
}

export const LEGACY_SETUP_MESSAGE =
  "Sign this message to derive your Opaque Cash stealth keys on Stellar. This is not a transaction and does not move funds.";

// -----------------------------------------------------------------------------
// Key derivation from wallet signature (entropy)
// -----------------------------------------------------------------------------

/**
 * Derive viewing key (v) and spending key (s) from a wallet signature used as entropy.
 * Uses HKDF-SHA256 to expand the signature into 64 bytes, then splits into two
 * 32-byte private keys. Domain string is "opaque-cash-v1".
 */
export function deriveKeysFromSignature(signatureHex: Hex | string): {
  viewingKey: Uint8Array;
  spendingKey: Uint8Array;
} {
  console.log("🔐 [Opaque] deriveKeysFromSignature");
  const sigBytes =
    typeof signatureHex === "string"
      ? signatureHex.startsWith("0x")
        ? signatureHex.slice(2)
        : signatureHex
      : signatureHex;
  const sig = typeof sigBytes === "string" ? hexToBytes(sigBytes) : sigBytes;
  const okm = hkdf(sha256, sig, undefined, DOMAIN, 64);
  const viewingKey = okm.slice(0, 32);
  const spendingKey = okm.slice(32, 64);
  console.log("🔐 [Opaque] Keys derived from signature ✅");
  return { viewingKey, spendingKey };
}

/**
 * Build the stealth meta-address from viewing and spending private keys.
 * Meta-address = compressed(V) || compressed(S) (66 bytes total).
 */
export function keysToStealthMetaAddress(
  viewingKey: Uint8Array,
  spendingKey: Uint8Array,
): { V: Uint8Array; S: Uint8Array; metaAddress: Uint8Array } {
  const V = CURVE.getPublicKey(viewingKey, true);
  const S = CURVE.getPublicKey(spendingKey, true);
  const metaAddress = new Uint8Array(V.length + S.length);
  metaAddress.set(V, 0);
  metaAddress.set(S, V.length);
  return { V, S, metaAddress };
}

/**
 * Encode the 66-byte stealth meta-address as 0x-prefixed hex.
 */
export function stealthMetaAddressToHex(metaAddress: Uint8Array): Hex {
  return ("0x" + bytesToHex(metaAddress)) as Hex;
}

/**
 * Parse a recipient stealth meta-address into viewing and spending public keys.
 * Format: first 33 bytes = compressed viewing public key V, next 33 = compressed S.
 */
export function parseStealthMetaAddress(metaHex: Hex | string): {
  viewPubKey: Uint8Array;
  spendPubKey: Uint8Array;
} {
  const raw =
    typeof metaHex === "string" && metaHex.startsWith("0x")
      ? metaHex.slice(2)
      : metaHex;
  const bytes = hexToBytes(raw as string);
  if (bytes.length < 66)
    throw new Error("Invalid stealth meta-address: expected 66 bytes");
  return {
    viewPubKey: bytes.slice(0, 33),
    spendPubKey: bytes.slice(33, 66),
  };
}

// -----------------------------------------------------------------------------
// Sender: derive stealth address and view tag (DKSAP)
// -----------------------------------------------------------------------------

function sharedSecretSender(
  ephemeralPriv: Uint8Array,
  viewPubKey: Uint8Array,
): Uint8Array {
  const P = CURVE.ProjectivePoint.fromHex(viewPubKey);
  const scalar = bytesToBigInt(ephemeralPriv) % CURVE.CURVE.n;
  if (scalar === 0n) throw new Error("Invalid ephemeral key");
  const sharedPoint = P.multiply(scalar);
  return sharedPoint.toRawBytes(true);
}

function hashSharedSecret(sharedSecret: Uint8Array): {
  sH: Uint8Array;
  viewTag: number;
} {
  const sH = keccak_256(sharedSecret);
  const viewTag = sH[0];
  return { sH, viewTag };
}

/**
 * Derive the stealth public key and address bytes from spending public key and hashed secret.
 * Returns the 20-byte stealth "address" (Keccak hash of uncompressed pubkey, EVM-compatible)
 * for scanner matching, plus the full stealth public key for Stellar account derivation.
 */
function stealthPointAndAddress(
  spendPubKey: Uint8Array,
  sH: Uint8Array,
): { stealthAddress: string; stealthPubKeyUncompressed: Uint8Array } {
  const n = CURVE.CURVE.n;
  const sHBig = bytesToBigInt(sH);
  const sHMod = sHBig % n;
  if (sHMod === 0n) throw new Error("Invalid scalar from hash");
  const S_h = CURVE.ProjectivePoint.BASE.multiply(sHMod);
  const P_spend = CURVE.ProjectivePoint.fromHex(spendPubKey);
  const P_stealth = P_spend.add(S_h);
  const uncompressed = P_stealth.toRawBytes(false);
  const hash = keccak_256(uncompressed.slice(1));
  const addrBytes = hash.slice(12);
  const addr = "0x" + bytesToHex(addrBytes);
  return { stealthAddress: addr, stealthPubKeyUncompressed: uncompressed };
}

/**
 * Sender-side: compute a one-time stealth address and view tag for a recipient.
 * The stealth address is returned as a hex string for scanner compatibility.
 */
export function computeStealthAddressAndViewTag(
  recipientMetaAddressHex: Hex | string,
): {
  ephemeralPriv: Uint8Array;
  ephemeralPubKey: Uint8Array;
  stealthAddress: string;
  stealthStellarAddress: string;
  viewTag: number;
  metadata: Uint8Array;
} {
  console.log("🔐 [Opaque] computeStealthAddressAndViewTag");
  const { viewPubKey, spendPubKey } = parseStealthMetaAddress(
    recipientMetaAddressHex as Hex,
  );
  const ephemeralPriv = CURVE.utils.randomPrivateKey();
  const ephemeralPubKey = CURVE.getPublicKey(ephemeralPriv, true);

  const shared = sharedSecretSender(ephemeralPriv, viewPubKey);
  const { sH, viewTag } = hashSharedSecret(shared);
  const { stealthAddress, stealthPubKeyUncompressed } = stealthPointAndAddress(
    spendPubKey,
    sH,
  );
  const stealthStellarAddress = deriveStealthStellarAddress(
    stealthPubKeyUncompressed,
  );

  const metadata = new Uint8Array(1);
  metadata[0] = viewTag;

  console.log("🔐 [Opaque] Stealth address computed ✅", {
    stealth: stealthAddress.slice(0, 14) + "…",
    viewTag,
  });
  return {
    ephemeralPriv,
    ephemeralPubKey,
    stealthAddress,
    stealthStellarAddress,
    viewTag,
    metadata,
  };
}

/**
 * Rebuild announce() parameters for a manual ghost receive using the stored
 * ephemeral private key.
 */
export function buildGhostAnnouncementPayload(
  recipientMetaAddressHex: Hex | string,
  ephemeralPrivKeyHex: Hex | string,
): {
  stealthAddress: string;
  ephemeralPubKey: Uint8Array;
  metadata: Uint8Array;
  viewTag: number;
} {
  const { viewPubKey, spendPubKey } = parseStealthMetaAddress(
    recipientMetaAddressHex as Hex,
  );
  const h = (ephemeralPrivKeyHex as string).startsWith("0x")
    ? (ephemeralPrivKeyHex as string).slice(2)
    : ephemeralPrivKeyHex;
  const ephemeralPriv = hexToBytes(h as string);
  if (ephemeralPriv.length !== 32) {
    throw new Error("Ephemeral private key must be 32 bytes.");
  }
  const ephemeralPubKey = CURVE.getPublicKey(ephemeralPriv, true);
  const shared = sharedSecretSender(ephemeralPriv, viewPubKey);
  const { sH, viewTag } = hashSharedSecret(shared);
  const { stealthAddress } = stealthPointAndAddress(spendPubKey, sH);
  const metadata = new Uint8Array(1);
  metadata[0] = viewTag;
  return { stealthAddress, ephemeralPubKey, metadata, viewTag };
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2) throw new Error("Invalid hex length");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBigInt(b: Uint8Array): bigint {
  let x = 0n;
  for (let i = 0; i < b.length; i++) x = (x << 8n) | BigInt(b[i]);
  return x;
}

// -----------------------------------------------------------------------------
// Deterministic ephemeral key for the "Announcer" stealth signer
// -----------------------------------------------------------------------------

const ANNOUNCER_SALT = "opaque-announcer-v1";

/**
 * Deterministic ephemeral scalar for the "Announcer" stealth signer.
 */
export function deriveAnnouncerEphemeralKey(
  metaAddressHex: Hex | string,
): Uint8Array {
  const raw =
    typeof metaAddressHex === "string" && metaAddressHex.startsWith("0x")
      ? metaAddressHex.slice(2)
      : metaAddressHex;
  const seed = new TextEncoder().encode(raw + ANNOUNCER_SALT);
  const okm = hkdf(sha256, seed, undefined, "opaque-announcer-ephemeral", 32);
  const n = CURVE.CURVE.n;
  let scalar = bytesToBigInt(okm) % n;
  if (scalar === 0n) scalar = 1n;
  const out = new Uint8Array(32);
  let x = scalar;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** Format stroops as XLM. */
export function formatXlm(stroops: bigint): string {
  return formatStroopsToXlm(stroops);
}

/** @deprecated Use formatXlm instead */
export const formatSol = formatXlm;

function deriveStealthStellarKeypair(
  stealthPubKeyUncompressed: Uint8Array,
): Keypair {
  const domain = new TextEncoder().encode("opaque-stellar-stealth-v1");
  const input = new Uint8Array(
    domain.length + stealthPubKeyUncompressed.length,
  );
  input.set(domain, 0);
  input.set(stealthPubKeyUncompressed, domain.length);
  const seed = sha256(input);
  return Keypair.fromRawEd25519Seed(Buffer.from(seed.slice(0, 32)));
}

export function deriveStealthStellarAddress(
  stealthPubKeyUncompressed: Uint8Array,
): string {
  return deriveStealthStellarKeypair(stealthPubKeyUncompressed).publicKey();
}

export function deriveStealthStellarAddressFromStealthPrivKey(
  stealthPrivKey: Uint8Array,
): string {
  const stealthPubKeyUncompressed = CURVE.getPublicKey(stealthPrivKey, false);
  return deriveStealthStellarAddress(stealthPubKeyUncompressed);
}

export function deriveStealthStellarKeypairFromStealthPrivKey(
  stealthPrivKey: Uint8Array,
): Keypair {
  const stealthPubKeyUncompressed = CURVE.getPublicKey(stealthPrivKey, false);
  return deriveStealthStellarKeypair(stealthPubKeyUncompressed);
}
