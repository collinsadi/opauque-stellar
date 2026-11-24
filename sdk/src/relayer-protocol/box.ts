/**
 * NaCl `crypto_box` sealing for relayer payloads, shared between the relayer node
 * and the SDK so encryption and decryption stay byte-identical.
 *
 * `tweetnacl` is an optional peer dependency. It is loaded lazily on first use,
 * so `@opaquecash/stellar` (which re-exports this module) imports fine without
 * it; only the box functions fail, with a {@link MissingPeerDependencyError}.
 *
 * The public functions are async (the published 0.x API). Code that already
 * holds a `tweetnacl` instance and needs synchronous calls — the relayer node —
 * builds them with {@link createNaclBox}.
 */
import { MissingPeerDependencyError } from "../errors/index";
import { assertLength, base64ToBytes, bytesToBase64, concatBytes } from "./bytes";

const PUBLIC_KEY_BYTES = 32;
const SECRET_KEY_BYTES = 32;
const NONCE_BYTES = 24;

function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len);
  globalThis.crypto.getRandomValues(out);
  return out;
}

type NaclKeyPair = { publicKey: Uint8Array; secretKey: Uint8Array };

/** The subset of `tweetnacl` the box functions use. */
export interface NaclLike {
  box: {
    (msg: Uint8Array, nonce: Uint8Array, theirPk: Uint8Array, mySk: Uint8Array): Uint8Array;
    open(
      box: Uint8Array,
      nonce: Uint8Array,
      theirPk: Uint8Array,
      mySk: Uint8Array,
    ): Uint8Array | null;
    keyPair: { (): NaclKeyPair; fromSecretKey(sk: Uint8Array): NaclKeyPair };
    overheadLength: number;
  };
}

export type X25519Keypair = {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
};

/** Synchronous box functions bound to a caller-supplied `tweetnacl` instance. */
export interface NaclBox {
  generateX25519Keypair(seed?: Uint8Array): X25519Keypair;
  sealBox(plaintext: Uint8Array, recipientPublicKey: Uint8Array): string;
  openBox(box: string, recipientSecretKey: Uint8Array): Uint8Array;
}

/**
 * Bind the box functions to an already-loaded `tweetnacl` (e.g.
 * `createNaclBox(nacl)` after `import nacl from "tweetnacl"`). The returned
 * functions are synchronous and produce the same wire format as
 * {@link sealBox} / {@link openBox}.
 */
export function createNaclBox(nacl: NaclLike): NaclBox {
  return {
    generateX25519Keypair(seed) {
      if (seed) {
        const secretKey = assertLength(seed, SECRET_KEY_BYTES, "x25519 seed");
        const pair = nacl.box.keyPair.fromSecretKey(secretKey);
        return { publicKey: pair.publicKey, secretKey: pair.secretKey };
      }
      const pair = nacl.box.keyPair();
      return { publicKey: pair.publicKey, secretKey: pair.secretKey };
    },

    sealBox(plaintext, recipientPublicKey) {
      const to = assertLength(recipientPublicKey, PUBLIC_KEY_BYTES, "recipient x25519 public key");
      const eph = nacl.box.keyPair();
      const nonce = randomBytes(NONCE_BYTES);
      const ciphertext = nacl.box(plaintext, nonce, to, eph.secretKey);
      return bytesToBase64(concatBytes(eph.publicKey, nonce, ciphertext));
    },

    openBox(box, recipientSecretKey) {
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
    },
  };
}

let naclBox: Promise<NaclBox> | null = null;

/** Lazily import `tweetnacl` once; a failed import is not cached, so installing it later works. */
function loadNaclBox(): Promise<NaclBox> {
  naclBox ??= import("tweetnacl").then(
    (mod) => {
      const nacl = ((mod as { default?: NaclLike }).default ?? mod) as NaclLike;
      return createNaclBox(nacl);
    },
    (cause: unknown) => {
      naclBox = null;
      throw new MissingPeerDependencyError("tweetnacl", "relayer payload encryption", { cause });
    },
  );
  return naclBox;
}

/**
 * Generate an X25519 keypair (random, or derived from a 32-byte `seed`).
 * @throws {MissingPeerDependencyError} if `tweetnacl` is not installed.
 */
export async function generateX25519Keypair(seed?: Uint8Array): Promise<X25519Keypair> {
  return (await loadNaclBox()).generateX25519Keypair(seed);
}

/**
 * Seal `plaintext` to `recipientPublicKey` with an ephemeral sender key.
 * Output is base64(`ephemeralPk || nonce || ciphertext`).
 * @throws {MissingPeerDependencyError} if `tweetnacl` is not installed.
 */
export async function sealBox(
  plaintext: Uint8Array,
  recipientPublicKey: Uint8Array,
): Promise<string> {
  return (await loadNaclBox()).sealBox(plaintext, recipientPublicKey);
}

/**
 * Open a box produced by {@link sealBox}.
 * @throws {MissingPeerDependencyError} if `tweetnacl` is not installed.
 */
export async function openBox(box: string, recipientSecretKey: Uint8Array): Promise<Uint8Array> {
  return (await loadNaclBox()).openBox(box, recipientSecretKey);
}
