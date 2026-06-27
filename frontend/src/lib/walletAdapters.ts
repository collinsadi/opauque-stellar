/**
 * Multi-wallet adapter layer for Stellar wallets.
 *
 * Each adapter implements a minimal interface — connect, signTransaction,
 * signMessage — so the rest of the app stays unaware of which wallet is active.
 * Freighter is the default and fully implemented; Lobstr, Rabet, and xBull are
 * detected via their injected window extensions.
 */

export interface WalletAdapter {
  id: string;
  name: string;
  /** URL to the wallet's install page, shown when extension is not detected. */
  installUrl: string;
  /** Returns true when the extension / app is present in the browser. */
  isAvailable(): boolean;
  /** Connects and returns the user's public key. */
  connect(): Promise<string>;
  /** Signs an XDR-encoded transaction and returns the signed XDR. */
  signTransaction(xdr: string, opts: { networkPassphrase: string; accountToSign?: string }): Promise<string>;
  /** Signs an arbitrary message blob and returns the signature bytes. */
  signMessage(message: Uint8Array, opts: { accountToSign?: string }): Promise<Uint8Array>;
}

// ─── Freighter ───────────────────────────────────────────────────────────────

export const FreighterAdapter: WalletAdapter = {
  id: "freighter",
  name: "Freighter",
  installUrl: "https://www.freighter.app/",

  isAvailable() {
    return typeof window !== "undefined" && Boolean(
      (window as Record<string, unknown>).freighterApi ||
      (window as Record<string, unknown>).freighter
    );
  },

  async connect() {
    const {
      isConnected,
      requestAccess,
      getPublicKey,
    } = await import("@stellar/freighter-api");
    const alreadyAuthorized = await isConnected();
    if (!alreadyAuthorized) await requestAccess();
    return getPublicKey();
  },

  async signTransaction(xdr, opts) {
    const { signTransaction } = await import("@stellar/freighter-api");
    return signTransaction(xdr, {
      networkPassphrase: opts.networkPassphrase,
      accountToSign: opts.accountToSign,
    });
  },

  async signMessage(message, opts) {
    const { signBlob } = await import("@stellar/freighter-api");
    const b64 = Buffer.from(message).toString("base64");
    const signed = await signBlob(b64, { accountToSign: opts.accountToSign });
    return Uint8Array.from(Buffer.from(signed, "base64"));
  },
};

// ─── LOBSTR ──────────────────────────────────────────────────────────────────

interface LobstrExtension {
  getPublicKey(): Promise<string>;
  signTransaction(xdr: string, opts: { network: string }): Promise<string>;
}

export const LobstrAdapter: WalletAdapter = {
  id: "lobstr",
  name: "LOBSTR",
  installUrl: "https://lobstr.co/",

  isAvailable() {
    return typeof window !== "undefined" && Boolean(
      (window as Record<string, unknown>).lobstr
    );
  },

  async connect() {
    const lobstr = (window as Record<string, unknown>).lobstr as LobstrExtension;
    return lobstr.getPublicKey();
  },

  async signTransaction(xdr, opts) {
    const lobstr = (window as Record<string, unknown>).lobstr as LobstrExtension;
    return lobstr.signTransaction(xdr, { network: opts.networkPassphrase });
  },

  async signMessage(_message, _opts) {
    throw new Error("LOBSTR does not support arbitrary message signing.");
  },
};

// ─── Rabet ───────────────────────────────────────────────────────────────────

interface RabetExtension {
  connect(): Promise<{ publicKey: string }>;
  sign(xdr: string, network: string): Promise<{ xdr: string }>;
}

export const RabetAdapter: WalletAdapter = {
  id: "rabet",
  name: "Rabet",
  installUrl: "https://rabet.io/",

  isAvailable() {
    return typeof window !== "undefined" && Boolean(
      (window as Record<string, unknown>).rabet
    );
  },

  async connect() {
    const rabet = (window as Record<string, unknown>).rabet as RabetExtension;
    const result = await rabet.connect();
    return result.publicKey;
  },

  async signTransaction(xdr, opts) {
    const rabet = (window as Record<string, unknown>).rabet as RabetExtension;
    const result = await rabet.sign(xdr, opts.networkPassphrase);
    return result.xdr;
  },

  async signMessage(_message, _opts) {
    throw new Error("Rabet does not support arbitrary message signing.");
  },
};

// ─── xBull ───────────────────────────────────────────────────────────────────

interface XBullExtension {
  connect(): Promise<{ publicKey: string }>;
  signXDR(params: { xdr: string; publicKey?: string; network?: string }): Promise<string>;
}

export const XBullAdapter: WalletAdapter = {
  id: "xbull",
  name: "xBull",
  installUrl: "https://xbull.app/",

  isAvailable() {
    return typeof window !== "undefined" && Boolean(
      (window as Record<string, unknown>).xBullSDK ||
      (window as Record<string, unknown>).xbull
    );
  },

  async connect() {
    const sdk = (
      (window as Record<string, unknown>).xBullSDK ??
      (window as Record<string, unknown>).xbull
    ) as XBullExtension;
    const result = await sdk.connect();
    return result.publicKey;
  },

  async signTransaction(xdr, opts) {
    const sdk = (
      (window as Record<string, unknown>).xBullSDK ??
      (window as Record<string, unknown>).xbull
    ) as XBullExtension;
    return sdk.signXDR({ xdr, publicKey: opts.accountToSign, network: opts.networkPassphrase });
  },

  async signMessage(_message, _opts) {
    throw new Error("xBull does not support arbitrary message signing.");
  },
};

// ─── Registry ─────────────────────────────────────────────────────────────────

export const ALL_WALLET_ADAPTERS: WalletAdapter[] = [
  FreighterAdapter,
  LobstrAdapter,
  RabetAdapter,
  XBullAdapter,
];

export function getWalletAdapter(id: string): WalletAdapter | undefined {
  return ALL_WALLET_ADAPTERS.find((a) => a.id === id);
}
