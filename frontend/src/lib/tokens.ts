/**
 * Token configuration for Stellar — native XLM and SAC-based assets (e.g. USDC).
 */

import type { StellarNetwork } from "./chain";

export interface TokenInfo {
  symbol: string;
  name: string;
  decimals: number;
  /** null for native XLM; issuer G-address for non-native assets */
  issuer: string | null;
}

export const NATIVE_TOKEN: TokenInfo = {
  symbol: "XLM",
  name: "Stellar Lumens",
  decimals: 7,
  issuer: null,
};

/**
 * USDC issuer addresses per network.
 * Testnet issuer is the Circle USDC testnet anchor.
 * Mainnet issuer is Circle's production USDC issuer.
 */
export const USDC_ISSUERS: Partial<Record<StellarNetwork, string>> = {
  testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  mainnet: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
};

export function getNativeToken(): TokenInfo {
  return NATIVE_TOKEN;
}

/** Returns the list of sendable tokens for the given network. */
export function getSupportedAssets(network: StellarNetwork): TokenInfo[] {
  const assets: TokenInfo[] = [NATIVE_TOKEN];
  const usdcIssuer = USDC_ISSUERS[network];
  if (usdcIssuer) {
    assets.push({
      symbol: "USDC",
      name: "USD Coin",
      decimals: 7,
      issuer: usdcIssuer,
    });
  }
  return assets;
}

/** Checks whether an account has a trustline for the given non-native asset. */
export async function hasTrustline(
  address: string,
  assetCode: string,
  issuer: string,
  loadAccount: (addr: string) => Promise<{ balances: Array<{ asset_type?: string; asset_code?: string; asset_issuer?: string }> }>,
): Promise<boolean> {
  try {
    const account = await loadAccount(address);
    return account.balances.some(
      (b) => b.asset_code === assetCode && b.asset_issuer === issuer,
    );
  } catch {
    return false;
  }
}
