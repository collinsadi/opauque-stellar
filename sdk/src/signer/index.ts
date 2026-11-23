/**
 * Signer abstraction. The SDK never holds or asks for a private key directly: it
 * hands a transaction XDR to an {@link OpaqueSigner} and gets a signed XDR back.
 * This unifies browser wallets (Freighter), raw server keypairs, and any custom
 * signing backend behind one interface.
 */
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { SignerError } from "../errors/index";

export interface SignerContext {
  /** Network passphrase the transaction is bound to. */
  networkPassphrase: string;
}

/** Low-level callback form: sign a transaction XDR, return the signed XDR. */
export type SignTxFn = (xdr: string, ctx: SignerContext) => Promise<string>;

export interface OpaqueSigner {
  /** Stellar public key (G-address) this signer controls. */
  publicKey(): string | Promise<string>;
  /** Sign a base64 transaction XDR and return the signed base64 XDR. */
  signTransaction(xdr: string, ctx: SignerContext): Promise<string>;
  /** Optional: sign an arbitrary message (used for one-time key derivation). */
  signMessage?(message: string): Promise<string>;
}

/**
 * Build a signer from a raw Ed25519 keypair (server / non-browser use). Accepts a
 * Stellar secret seed (`S...`) or a `Keypair` instance.
 */
export function keypairSigner(secretOrKeypair: string | Keypair): OpaqueSigner {
  const keypair =
    typeof secretOrKeypair === "string"
      ? Keypair.fromSecret(secretOrKeypair)
      : secretOrKeypair;

  return {
    publicKey: () => keypair.publicKey(),
    async signTransaction(xdr, ctx) {
      try {
        const tx = TransactionBuilder.fromXDR(xdr, ctx.networkPassphrase);
        tx.sign(keypair);
        return tx.toXDR();
      } catch (cause) {
        throw new SignerError("Keypair failed to sign transaction", { cause });
      }
    },
  };
}

/**
 * Build a signer from caller-supplied callbacks. Use this to adapt Freighter or
 * any external signing service.
 */
export function callbackSigner(opts: {
  publicKey: string | (() => string | Promise<string>);
  signTransaction: SignTxFn;
  signMessage?: (message: string) => Promise<string>;
}): OpaqueSigner {
  return {
    publicKey: () =>
      typeof opts.publicKey === "function" ? opts.publicKey() : opts.publicKey,
    async signTransaction(xdr, ctx) {
      try {
        return await opts.signTransaction(xdr, ctx);
      } catch (cause) {
        throw new SignerError("Callback signer failed", { cause });
      }
    },
    signMessage: opts.signMessage,
  };
}

export { stellarWalletsKitSigner, isWalletRejection, type WalletApiError } from "./adapters";
// The Freighter adapter is exported from `@opaquecash/stellar/freighter` so that
// `@stellar/freighter-api` stays an optional peer dependency (#1079).
