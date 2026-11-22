/**
 * Opaque payment-link format: `opaque://v{version}/{network}/{metaAddress}?{params}`
 * with versioning, network binding, and optional SEP-compatible parameters.
 */

export type Network = "testnet" | "mainnet" | "futurenet" | "local";

export interface PaymentLinkParams {
  amount?: string;
  asset?: string;
  issuer?: string;
  memo?: string;
  sep?: string;
  callback?: string;
  label?: string;
  expires?: string;
}

export interface PaymentLink {
  version: number;
  network: Network;
  metaAddress: string;
  params: PaymentLinkParams;
}

export interface PaymentLinkError {
  type:
    | "INVALID_FORMAT"
    | "UNSUPPORTED_VERSION"
    | "NETWORK_MISMATCH"
    | "INVALID_META_ADDRESS"
    | "INVALID_PARAMETER";
  message: string;
  details?: unknown;
}

/** Validate a DKSAP meta-address: `0x` + 132 hex chars (66 bytes). */
export function isValidMetaAddress(metaAddress: string): boolean {
  if (metaAddress.length !== 134) return false;
  if (!metaAddress.startsWith("0x")) return false;
  return /^[0-9a-fA-F]{132}$/.test(metaAddress.slice(2));
}

export function isValidNetwork(network: string): network is Network {
  return ["testnet", "mainnet", "futurenet", "local"].includes(network);
}

/** Validate a Stellar public key (G..., 56 chars, base32). */
export function isValidStellarPublicKey(publicKey: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(publicKey);
}

export function isValidAssetCode(assetCode: string): boolean {
  if (assetCode.length < 1 || assetCode.length > 12) return false;
  return /^[a-zA-Z0-9]+$/.test(assetCode);
}

export function isValidAmount(amount: string): boolean {
  if (!amount) return false;
  const num = parseFloat(amount);
  if (isNaN(num) || num <= 0) return false;
  return /^[0-9]+(\.[0-9]+)?$/.test(amount);
}

export function isValidIso8601(timestamp: string): boolean {
  try {
    return !isNaN(new Date(timestamp).getTime());
  } catch {
    return false;
  }
}

export function isValidUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** Stellar text memos carry at most 28 UTF-8 bytes (not characters). */
export function isValidMemo(memo: string): boolean {
  return new TextEncoder().encode(memo).byteLength <= 28;
}

/** Encode a payment link from components. Throws on invalid input. */
export function encodePaymentLink(link: PaymentLink): string {
  if (!isValidMetaAddress(link.metaAddress)) {
    throw new Error("Invalid meta-address format");
  }
  if (!isValidNetwork(link.network)) {
    throw new Error("Invalid network identifier");
  }

  const uri = `opaque://v${link.version}/${link.network}/${link.metaAddress}`;
  const params = new URLSearchParams();

  if (link.params.amount) {
    if (!isValidAmount(link.params.amount)) throw new Error("Invalid amount format");
    params.set("amount", link.params.amount);
  }
  if (link.params.asset) {
    if (!isValidAssetCode(link.params.asset)) throw new Error("Invalid asset code");
    params.set("asset", link.params.asset);
  }
  if (link.params.issuer) {
    if (!isValidStellarPublicKey(link.params.issuer)) {
      throw new Error("Invalid issuer address");
    }
    params.set("issuer", link.params.issuer);
  }
  if (link.params.memo) {
    if (!isValidMemo(link.params.memo)) {
      throw new Error("Payment link memo must be 28 UTF-8 bytes or fewer");
    }
    params.set("memo", link.params.memo);
  }
  if (link.params.sep) params.set("sep", link.params.sep);
  if (link.params.callback) {
    if (!isValidUrl(link.params.callback)) throw new Error("Invalid callback URL");
    params.set("callback", link.params.callback);
  }
  if (link.params.label) params.set("label", link.params.label);
  if (link.params.expires) {
    if (!isValidIso8601(link.params.expires)) {
      throw new Error("Invalid expiration timestamp");
    }
    params.set("expires", link.params.expires);
  }

  const queryString = params.toString();
  return queryString ? `${uri}?${queryString}` : uri;
}

/** Decode a payment-link string into components, or a structured error. */
export function decodePaymentLink(
  linkString: string,
  configuredNetwork?: Network,
): { link: PaymentLink } | { error: PaymentLinkError } {
  try {
    const url = new URL(linkString);
    if (url.protocol !== "opaque:") {
      return { error: { type: "INVALID_FORMAT", message: "Invalid protocol: must be opaque://" } };
    }

    // `opaque:` is a non-special scheme, so a strict WHATWG URL parser (Node and
    // browsers) treats the first segment after `//` as the host. Reconstruct the
    // logical path as [version, network, metaAddress] from hostname + pathname so
    // decoding is environment-independent.
    const pathParts = [
      url.hostname,
      ...url.pathname.split("/").filter(Boolean),
    ].filter(Boolean);
    if (pathParts.length < 3) {
      return {
        error: {
          type: "INVALID_FORMAT",
          message: "Invalid path format: expected opaque://v{version}/{network}/{meta-address}",
        },
      };
    }

    const versionMatch = pathParts[0].match(/^v(\d+)$/);
    if (!versionMatch) {
      return { error: { type: "INVALID_FORMAT", message: "Invalid version format: expected v{number}" } };
    }
    const version = parseInt(versionMatch[1], 10);
    if (version !== 1) {
      return {
        error: {
          type: "UNSUPPORTED_VERSION",
          message: `Unsupported version: v${version}. Only v1 is currently supported.`,
        },
      };
    }

    const network = pathParts[1];
    if (!isValidNetwork(network)) {
      return {
        error: {
          type: "INVALID_FORMAT",
          message: `Invalid network: ${network}. Must be one of: testnet, mainnet, futurenet, local`,
        },
      };
    }
    if (configuredNetwork && network !== configuredNetwork) {
      return {
        error: {
          type: "NETWORK_MISMATCH",
          message: `Network mismatch: link is for ${network}, but app is configured for ${configuredNetwork}`,
          details: { linkNetwork: network, configuredNetwork },
        },
      };
    }

    const metaAddress = pathParts[2];
    if (!isValidMetaAddress(metaAddress)) {
      return {
        error: {
          type: "INVALID_META_ADDRESS",
          message: `Invalid meta-address format: ${metaAddress}. Expected 0x + 132 hex chars.`,
        },
      };
    }

    const params: PaymentLinkParams = {};
    const searchParams = url.searchParams;

    if (searchParams.has("amount")) {
      const amount = searchParams.get("amount")!;
      if (!isValidAmount(amount)) {
        return { error: { type: "INVALID_PARAMETER", message: `Invalid amount parameter: ${amount}`, details: { parameter: "amount", value: amount } } };
      }
      params.amount = amount;
    }
    if (searchParams.has("asset")) {
      const asset = searchParams.get("asset")!;
      if (!isValidAssetCode(asset)) {
        return { error: { type: "INVALID_PARAMETER", message: `Invalid asset code: ${asset}`, details: { parameter: "asset", value: asset } } };
      }
      params.asset = asset;
    }
    if (searchParams.has("issuer")) {
      const issuer = searchParams.get("issuer")!;
      if (!isValidStellarPublicKey(issuer)) {
        return { error: { type: "INVALID_PARAMETER", message: `Invalid issuer address: ${issuer}`, details: { parameter: "issuer", value: issuer } } };
      }
      params.issuer = issuer;
    }
    if (searchParams.has("memo")) {
      const memo = searchParams.get("memo")!;
      if (!isValidMemo(memo)) {
        return {
          error: {
            type: "INVALID_PARAMETER",
            message: "Payment link memo must be 28 UTF-8 bytes or fewer",
            details: { parameter: "memo", value: memo },
          },
        };
      }
      params.memo = memo;
    }
    if (searchParams.has("sep")) params.sep = searchParams.get("sep")!;
    if (searchParams.has("callback")) {
      const callback = searchParams.get("callback")!;
      if (!isValidUrl(callback)) {
        return { error: { type: "INVALID_PARAMETER", message: `Invalid callback URL: ${callback}`, details: { parameter: "callback", value: callback } } };
      }
      params.callback = callback;
    }
    if (searchParams.has("label")) params.label = searchParams.get("label")!;
    if (searchParams.has("expires")) {
      const expires = searchParams.get("expires")!;
      if (!isValidIso8601(expires)) {
        return { error: { type: "INVALID_PARAMETER", message: `Invalid expiration timestamp: ${expires}`, details: { parameter: "expires", value: expires } } };
      }
      params.expires = expires;
    }

    if (params.expires && new Date(params.expires) < new Date()) {
      return { error: { type: "INVALID_PARAMETER", message: `Payment link has expired: ${params.expires}`, details: { parameter: "expires", value: params.expires } } };
    }

    return { link: { version, network, metaAddress, params } };
  } catch (error) {
    return {
      error: {
        type: "INVALID_FORMAT",
        message: `Failed to parse payment link: ${error instanceof Error ? error.message : String(error)}`,
        details: error,
      },
    };
  }
}

/** Create a v1 payment link from a meta-address and network. */
export function createPaymentLink(
  metaAddress: string,
  network: Network,
  params: PaymentLinkParams = {},
): string {
  return encodePaymentLink({ version: 1, network, metaAddress, params });
}

/** True when the string parses as a valid opaque payment link. */
export function isOpaquePaymentLink(linkString: string): boolean {
  try {
    return "link" in decodePaymentLink(linkString);
  } catch {
    return false;
  }
}

/** Convert a legacy `https://host/pay/{metaAddress}` link into opaque format. */
export function convertLegacyLink(
  legacyLink: string,
  network: Network,
  params: PaymentLinkParams = {},
): string | null {
  try {
    const url = new URL(legacyLink);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const metaAddress = pathParts[pathParts.length - 1];
    if (!isValidMetaAddress(metaAddress)) return null;
    return createPaymentLink(metaAddress, network, params);
  } catch {
    return null;
  }
}
