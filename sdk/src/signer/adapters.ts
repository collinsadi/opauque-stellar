/**
 * Browser wallet signer adapters.
 *
 * These adapters wrap browser wallet APIs behind the {@link OpaqueSigner}
 * interface so the SDK can use them without knowing the underlying wallet.
 * The Freighter adapter lives behind the `@opaquecash/stellar/freighter`
 * subpath so `@stellar/freighter-api` stays an optional peer dependency.
 */
import { SignerError, SignerRejectedError } from "../errors/index";
import type { OpaqueSigner, SignerContext } from "./index";

/** Error shape returned (not thrown) by wallet APIs such as Freighter v2+. */
export interface WalletApiError {
  code?: number;
  message?: string;
}

/** Freighter's "user declined" error code. */
const USER_REJECTED_CODE = -4;
const REJECTED_RE = /reject|declin|denied|cancel/i;

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && typeof (err as WalletApiError).message === "string") {
    return (err as WalletApiError).message!;
  }
  return String(err);
}

/** True if a wallet error (returned or thrown) means the user declined. */
export function isWalletRejection(err: unknown): boolean {
  if (err && typeof err === "object" && (err as WalletApiError).code === USER_REJECTED_CODE) {
    return true;
  }
  return REJECTED_RE.test(errorMessage(err));
}

/** Map a wallet error (returned or thrown) to a typed SDK signer error. */
export function toSignerError(wallet: string, action: string, err: unknown): SignerError {
  if (err instanceof SignerError) return err;
  const detail = errorMessage(err);
  if (isWalletRejection(err)) {
    return new SignerRejectedError(`${wallet}: user rejected ${action}`, { cause: err });
  }
  return new SignerError(`${wallet}: ${action} failed: ${detail}`, { cause: err });
}

/**
 * Pull a non-empty string field out of a wallet result that may be a bare
 * string (Freighter v1) or `{ [field], error? }` (Freighter v2+, Wallets Kit).
 * A returned `error` or a missing value becomes a typed {@link SignerError}.
 */
export function unwrapWalletResult(
  wallet: string,
  action: string,
  result: unknown,
  field: string,
): string {
  if (typeof result === "string") {
    if (result) return result;
    throw new SignerError(`${wallet}: ${action} returned an empty result`);
  }
  if (result && typeof result === "object") {
    const error = (result as { error?: unknown }).error;
    if (error) throw toSignerError(wallet, action, error);
    const value = (result as Record<string, unknown>)[field];
    if (typeof value === "string" && value) return value;
  }
  throw new SignerError(`${wallet}: ${action} returned no ${field}`);
}

/**
 * Build an {@link OpaqueSigner} from a Stellar Wallets Kit-compatible wallet.
 *
 * The `wallet` parameter must expose `requestAccess()`, `signTransaction()`,
 * and `getAddress()` methods matching the Stellar Wallets Kit interface.
 * Rejections map to {@link SignerRejectedError}; other failures to
 * {@link SignerError}.
 */
export function stellarWalletsKitSigner(wallet: {
  requestAccess: () => Promise<string | { address: string; error?: unknown }>;
  signTransaction: (
    xdr: string,
    opts: { networkPassphrase: string },
  ) => Promise<string | { signedTxXdr: string; error?: unknown }>;
  getAddress: () => Promise<string | { address: string; error?: unknown }>;
}): OpaqueSigner {
  const name = "Stellar Wallets Kit";
  let connected = false;

  return {
    async publicKey() {
      try {
        // Re-read the address every time so an account switch is picked up.
        if (!connected) {
          const res = await wallet.requestAccess();
          connected = true;
          return unwrapWalletResult(name, "connect", res, "address");
        }
        return unwrapWalletResult(name, "get address", await wallet.getAddress(), "address");
      } catch (err) {
        throw toSignerError(name, "connect", err);
      }
    },

    async signTransaction(xdr: string, ctx: SignerContext) {
      try {
        const signed = await wallet.signTransaction(xdr, {
          networkPassphrase: ctx.networkPassphrase,
        });
        return unwrapWalletResult(name, "sign transaction", signed, "signedTxXdr");
      } catch (err) {
        throw toSignerError(name, "sign transaction", err);
      }
    },
  };
}
