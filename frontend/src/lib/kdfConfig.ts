/**
 * Shared PBKDF2 key-derivation parameters for every wallet-encryption path.
 *
 * A single configuration keeps secrets of similar sensitivity behind the
 * same work factor. Older encrypted payloads store their own iteration
 * count and continue to decrypt with the value they were written with.
 */

export const KDF_ITERATIONS = 600_000;
export const KDF_HASH = "SHA-256" as const;
export const KDF_SALT_BYTES = 16;
export const KDF_IV_BYTES = 12;
export const KDF_KEY_LENGTH_BITS = 256;

/** PBKDF2 parameters recorded into backup manifests so they stay self-describing. */
export const KDF_PARAMS = {
  name: "PBKDF2-SHA256" as const,
  iterations: KDF_ITERATIONS,
  hash: KDF_HASH,
  saltBytes: KDF_SALT_BYTES,
  keyLengthBits: KDF_KEY_LENGTH_BITS,
};
