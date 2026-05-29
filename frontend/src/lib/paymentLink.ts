/**
 * Opaque Payment Link Format
 * 
 * Implements the opaque:// payment link format with versioning, 
 * chain/network binding, and optional SEP compatibility.
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
  type: "INVALID_FORMAT" | "UNSUPPORTED_VERSION" | "NETWORK_MISMATCH" | "INVALID_META_ADDRESS" | "INVALID_PARAMETER";
  message: string;
  details?: unknown;
}

/**
 * Validates a meta-address format
 */
export function isValidMetaAddress(metaAddress: string): boolean {
  // Must be exactly 66 characters: 0x + 64 hex chars
  if (metaAddress.length !== 66) return false;
  if (!metaAddress.startsWith("0x")) return false;
  const hexPart = metaAddress.slice(2);
  return /^[0-9a-fA-F]{64}$/.test(hexPart);
}

/**
 * Validates a network identifier
 */
export function isValidNetwork(network: string): network is Network {
  return ["testnet", "mainnet", "futurenet", "local"].includes(network);
}

/**
 * Validates a Stellar public key (issuer address)
 */
export function isValidStellarPublicKey(publicKey: string): boolean {
  // Stellar public keys are 56 characters, base32 encoded (G...)
  if (publicKey.length !== 56) return false;
  if (!publicKey.startsWith("G")) return false;
  return /^[A-Z2-7]{55}$/.test(publicKey);
}

/**
 * Validates an asset code (1-12 alphanumeric characters)
 */
export function isValidAssetCode(assetCode: string): boolean {
  if (assetCode.length < 1 || assetCode.length > 12) return false;
  return /^[a-zA-Z0-9]+$/.test(assetCode);
}

/**
 * Validates an amount string (positive decimal)
 */
export function isValidAmount(amount: string): boolean {
  if (!amount) return false;
  const num = parseFloat(amount);
  if (isNaN(num) || num <= 0) return false;
  return /^[0-9]+(\.[0-9]+)?$/.test(amount);
}

/**
 * Validates an ISO 8601 timestamp
 */
export function isValidIso8601(timestamp: string): boolean {
  try {
    const date = new Date(timestamp);
    return !isNaN(date.getTime());
  } catch {
    return false;
  }
}

/**
 * Validates a URL (for callback)
 */
export function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Encodes a payment link from components
 */
export function encodePaymentLink(link: PaymentLink): string {
  // Validate components
  if (!isValidMetaAddress(link.metaAddress)) {
    throw new Error("Invalid meta-address format");
  }
  if (!isValidNetwork(link.network)) {
    throw new Error("Invalid network identifier");
  }

  // Build base URI
  const uri = `opaque://v${link.version}/${link.network}/${link.metaAddress}`;

  // Build query parameters
  const params = new URLSearchParams();
  
  if (link.params.amount) {
    if (!isValidAmount(link.params.amount)) {
      throw new Error("Invalid amount format");
    }
    params.set("amount", link.params.amount);
  }
  
  if (link.params.asset) {
    if (!isValidAssetCode(link.params.asset)) {
      throw new Error("Invalid asset code");
    }
    params.set("asset", link.params.asset);
  }
  
  if (link.params.issuer) {
    if (!isValidStellarPublicKey(link.params.issuer)) {
      throw new Error("Invalid issuer address");
    }
    params.set("issuer", link.params.issuer);
  }
  
  if (link.params.memo) {
    params.set("memo", link.params.memo);
  }
  
  if (link.params.sep) {
    params.set("sep", link.params.sep);
  }
  
  if (link.params.callback) {
    if (!isValidUrl(link.params.callback)) {
      throw new Error("Invalid callback URL");
    }
    params.set("callback", link.params.callback);
  }
  
  if (link.params.label) {
    params.set("label", link.params.label);
  }
  
  if (link.params.expires) {
    if (!isValidIso8601(link.params.expires)) {
      throw new Error("Invalid expiration timestamp");
    }
    params.set("expires", link.params.expires);
  }

  // Append query string if parameters exist
  const queryString = params.toString();
  return queryString ? `${uri}?${queryString}` : uri;
}

/**
 * Decodes a payment link string into components
 */
export function decodePaymentLink(
  linkString: string,
  configuredNetwork?: Network
): { link: PaymentLink } | { error: PaymentLinkError } {
  try {
    // Parse URI
    const url = new URL(linkString);

    // Validate protocol
    if (url.protocol !== "opaque:") {
      return {
        error: {
          type: "INVALID_FORMAT",
          message: "Invalid protocol: must be opaque://",
        },
      };
    }

    // Extract path components
    const pathParts = url.pathname.split("/").filter(Boolean);
    
    if (pathParts.length < 3) {
      return {
        error: {
          type: "INVALID_FORMAT",
          message: "Invalid path format: expected opaque://v{version}/{network}/{meta-address}",
        },
      };
    }

    // Parse version
    const versionMatch = pathParts[0].match(/^v(\d+)$/);
    if (!versionMatch) {
      return {
        error: {
          type: "INVALID_FORMAT",
          message: "Invalid version format: expected v{number}",
        },
      };
    }
    const version = parseInt(versionMatch[1], 10);
    
    // Validate version (currently only v1 is supported)
    if (version !== 1) {
      return {
        error: {
          type: "UNSUPPORTED_VERSION",
          message: `Unsupported version: v${version}. Only v1 is currently supported.`,
        },
      };
    }

    // Parse network
    const network = pathParts[1];
    if (!isValidNetwork(network)) {
      return {
        error: {
          type: "INVALID_FORMAT",
          message: `Invalid network: ${network}. Must be one of: testnet, mainnet, futurenet, local`,
        },
      };
    }

    // Check network mismatch if configured network is provided
    if (configuredNetwork && network !== configuredNetwork) {
      return {
        error: {
          type: "NETWORK_MISMATCH",
          message: `Network mismatch: link is for ${network}, but app is configured for ${configuredNetwork}`,
          details: { linkNetwork: network, configuredNetwork },
        },
      };
    }

    // Parse meta-address
    const metaAddress = pathParts[2];
    if (!isValidMetaAddress(metaAddress)) {
      return {
        error: {
          type: "INVALID_META_ADDRESS",
          message: `Invalid meta-address format: ${metaAddress}. Expected 66-character hex string (0x + 64 hex chars)`,
        },
      };
    }

    // Parse query parameters
    const params: PaymentLinkParams = {};
    const searchParams = url.searchParams;

    if (searchParams.has("amount")) {
      const amount = searchParams.get("amount")!;
      if (!isValidAmount(amount)) {
        return {
          error: {
            type: "INVALID_PARAMETER",
            message: `Invalid amount parameter: ${amount}`,
            details: { parameter: "amount", value: amount },
          },
        };
      }
      params.amount = amount;
    }

    if (searchParams.has("asset")) {
      const asset = searchParams.get("asset")!;
      if (!isValidAssetCode(asset)) {
        return {
          error: {
            type: "INVALID_PARAMETER",
            message: `Invalid asset code: ${asset}`,
            details: { parameter: "asset", value: asset },
          },
        };
      }
      params.asset = asset;
    }

    if (searchParams.has("issuer")) {
      const issuer = searchParams.get("issuer")!;
      if (!isValidStellarPublicKey(issuer)) {
        return {
          error: {
            type: "INVALID_PARAMETER",
            message: `Invalid issuer address: ${issuer}`,
            details: { parameter: "issuer", value: issuer },
          },
        };
      }
      params.issuer = issuer;
    }

    if (searchParams.has("memo")) {
      params.memo = searchParams.get("memo")!;
    }

    if (searchParams.has("sep")) {
      params.sep = searchParams.get("sep")!;
    }

    if (searchParams.has("callback")) {
      const callback = searchParams.get("callback")!;
      if (!isValidUrl(callback)) {
        return {
          error: {
            type: "INVALID_PARAMETER",
            message: `Invalid callback URL: ${callback}`,
            details: { parameter: "callback", value: callback },
          },
        };
      }
      params.callback = callback;
    }

    if (searchParams.has("label")) {
      params.label = searchParams.get("label")!;
    }

    if (searchParams.has("expires")) {
      const expires = searchParams.get("expires")!;
      if (!isValidIso8601(expires)) {
        return {
          error: {
            type: "INVALID_PARAMETER",
            message: `Invalid expiration timestamp: ${expires}`,
            details: { parameter: "expires", value: expires },
          },
        };
      }
      params.expires = expires;
    }

    // Check expiration
    if (params.expires) {
      const expirationDate = new Date(params.expires);
      if (expirationDate < new Date()) {
        return {
          error: {
            type: "INVALID_PARAMETER",
            message: `Payment link has expired: ${params.expires}`,
            details: { parameter: "expires", value: params.expires },
          },
        };
      }
    }

    return {
      link: {
        version,
        network,
        metaAddress,
        params,
      },
    };
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

/**
 * Creates a payment link from meta-address and network
 */
export function createPaymentLink(
  metaAddress: string,
  network: Network,
  params: PaymentLinkParams = {}
): string {
  return encodePaymentLink({
    version: 1,
    network,
    metaAddress,
    params,
  });
}

/**
 * Checks if a string is a valid opaque payment link
 */
export function isOpaquePaymentLink(linkString: string): boolean {
  try {
    const result = decodePaymentLink(linkString);
    return "link" in result;
  } catch {
    return false;
  }
}

/**
 * Converts legacy payment link format to opaque format
 * Legacy format: https://example.com/pay/{meta-address}
 */
export function convertLegacyLink(
  legacyLink: string,
  network: Network,
  params: PaymentLinkParams = {}
): string | null {
  try {
    const url = new URL(legacyLink);
    const pathParts = url.pathname.split("/").filter(Boolean);
    
    // Extract meta-address from legacy format
    const metaAddress = pathParts[pathParts.length - 1];
    
    if (!isValidMetaAddress(metaAddress)) {
      return null;
    }

    return createPaymentLink(metaAddress, network, params);
  } catch {
    return null;
  }
}
