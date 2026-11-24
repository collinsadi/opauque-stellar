/**
 * `@opaquecash/stellar/freighter` — an {@link OpaqueSigner} backed by the
 * Freighter browser extension.
 *
 * `@stellar/freighter-api` is an optional peer dependency, imported lazily on
 * first use. It is kept off the main entry so bundlers never try to resolve it
 * for apps that do not use Freighter.
 *
 * Freighter v2+ returns `{ ..., error? }` instead of throwing, so a rejection
 * would otherwise surface as an `undefined` signed XDR. Both returned and thrown
 * errors are mapped to typed SDK errors; bare-string results are also accepted.
 */
import { MissingPeerDependencyError, SignerError } from "../errors/index";
import type { OpaqueSigner, SignerContext } from "./index";
import { toSignerError, unwrapWalletResult, type WalletApiError } from "./adapters";

/** The subset of `@stellar/freighter-api` the adapter uses. */
export interface FreighterApiLike {
  isAllowed(): Promise<boolean | { isAllowed: boolean; error?: WalletApiError }>;
  requestAccess(): Promise<string | { address: string; error?: WalletApiError }>;
  getAddress(): Promise<string | { address: string; error?: WalletApiError }>;
  signTransaction(
    xdr: string,
    opts?: { networkPassphrase?: string; address?: string },
  ): Promise<string | { signedTxXdr: string; signerAddress?: string; error?: WalletApiError }>;
}

export interface FreighterSignerOptions {
  /**
   * Freighter API implementation. Defaults to a lazy `import("@stellar/freighter-api")`.
   * Pass one to reuse an instance your app already loaded, or in tests.
   */
  api?: FreighterApiLike;
}

const NAME = "Freighter";

let defaultApi: Promise<FreighterApiLike> | null = null;

function loadFreighter(): Promise<FreighterApiLike> {
  defaultApi ??= import("@stellar/freighter-api").then(
    (mod) => {
      const m = mod as unknown as FreighterApiLike & { default?: FreighterApiLike };
      return typeof m.signTransaction === "function" ? m : m.default!;
    },
    (cause: unknown) => {
      defaultApi = null;
      throw new MissingPeerDependencyError("@stellar/freighter-api", "the Freighter signer", { cause });
    },
  );
  return defaultApi;
}

/**
 * Build an {@link OpaqueSigner} backed by the Freighter browser extension.
 *
 * - `publicKey()` asks Freighter for the active account on every call (no stale
 *   cache), prompting the connection dialog first if the site is not allowed.
 * - `signTransaction()` fails with {@link SignerError} `reason: "account-changed"`
 *   if Freighter signs with a different account than the last `publicKey()`
 *   returned — the transaction was built for that account.
 * - A user rejection maps to {@link SignerRejectedError}; a missing
 *   `@stellar/freighter-api` to {@link MissingPeerDependencyError}.
 */
export function freighterSigner(options: FreighterSignerOptions = {}): OpaqueSigner {
  const api = (): Promise<FreighterApiLike> =>
    options.api ? Promise.resolve(options.api) : loadFreighter();
  let lastAddress: string | null = null;

  async function readAllowed(f: FreighterApiLike): Promise<boolean> {
    const res = await f.isAllowed();
    if (typeof res === "boolean") return res;
    if (res?.error) throw toSignerError(NAME, "check access", res.error);
    return Boolean(res?.isAllowed);
  }

  return {
    async publicKey() {
      const f = await api();
      let address: string;
      try {
        if (!(await readAllowed(f))) {
          address = unwrapWalletResult(NAME, "connect", await f.requestAccess(), "address");
        } else {
          const res = await f.getAddress();
          // v2 returns an empty address when locked/disconnected: fall back to requesting access.
          const empty = typeof res === "object" && res !== null && !res.error && !res.address;
          address = empty
            ? unwrapWalletResult(NAME, "connect", await f.requestAccess(), "address")
            : unwrapWalletResult(NAME, "get address", res, "address");
        }
      } catch (err) {
        throw toSignerError(NAME, "connect", err);
      }
      lastAddress = address;
      return address;
    },

    async signTransaction(xdr: string, ctx: SignerContext) {
      const f = await api();
      let res: Awaited<ReturnType<FreighterApiLike["signTransaction"]>>;
      try {
        res = await f.signTransaction(xdr, { networkPassphrase: ctx.networkPassphrase });
      } catch (err) {
        throw toSignerError(NAME, "sign transaction", err);
      }
      const signed = unwrapWalletResult(NAME, "sign transaction", res, "signedTxXdr");
      const signerAddress = typeof res === "object" ? res.signerAddress : undefined;
      if (lastAddress && signerAddress && signerAddress !== lastAddress) {
        const expected = lastAddress;
        lastAddress = signerAddress;
        throw new SignerError(
          `${NAME}: transaction was signed by ${signerAddress}, but it was built for ${expected}; the active account changed. Rebuild the transaction and retry.`,
          { reason: "account-changed" },
        );
      }
      return signed;
    },
  };
}

export { SignerError, SignerRejectedError, MissingPeerDependencyError } from "../errors/index";
