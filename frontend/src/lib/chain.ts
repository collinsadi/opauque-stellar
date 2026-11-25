/**
 * Stellar network config.
 *
 * RPC resolution:
 * - VITE_STELLAR_RPC_URL / VITE_STELLAR_RPC_FALLBACK_URLS
 * - VITE_STELLAR_HORIZON_URL / VITE_STELLAR_HORIZON_FALLBACK_URLS
 * - non-mainnet public defaults
 *
 * All RPC URLs are validated against a hostname allowlist in production to prevent
 * misconfiguration from pointing the wallet at attacker-controlled endpoints.
 */

import { validateRpcHostname } from "./rpcAllowlist";

export type StellarNetwork = "testnet" | "futurenet" | "mainnet" | "local";
export const STELLAR_NETWORKS: readonly StellarNetwork[] = [
  "testnet",
  "futurenet",
  "mainnet",
  "local",
];

export const NETWORK_PASSPHRASES: Record<StellarNetwork, string> = {
  testnet: "Test SDF Network ; September 2015",
  futurenet: "Test SDF Future Network ; October 2022",
  mainnet: "Public Global Stellar Network ; September 2015",
  local: "Standalone Network ; February 2017",
};

export const RPC_ENDPOINTS: Record<StellarNetwork, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  futurenet: "https://rpc-futurenet.stellar.org",
  mainnet: "https://mainnet.sorobanrpc.com",
  local: "http://localhost:8000/soroban/rpc",
};

export const HORIZON_ENDPOINTS: Record<StellarNetwork, string> = {
  testnet: "https://horizon-testnet.stellar.org",
  futurenet: "https://horizon-futurenet.stellar.org",
  mainnet: "https://horizon.stellar.org",
  local: "http://localhost:8000",
};

const PUBLIC_MAINNET_RPC = new Set(["https://mainnet.sorobanrpc.com"]);
const PUBLIC_MAINNET_HORIZON = new Set(["https://horizon.stellar.org"]);

let rpcWarnLogged = false;
let horizonWarnLogged = false;

function isProductionBuild(): boolean {
  return import.meta.env.MODE === "production" || import.meta.env.PROD === true;
}

function splitUrls(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
}

function validateProductionUrl(kind: "RPC" | "Horizon", url: string, publicDefaults: Set<string>) {
  if (!url.startsWith("https://")) {
    throw new Error(`Mainnet requires VITE_STELLAR_${kind.toUpperCase()}_URL to be HTTPS.`);
  }
  if (publicDefaults.has(url.replace(/\/$/, ""))) {
    throw new Error(`Mainnet requires an explicit production ${kind} provider, not the public default.`);
  }
}

export function getConfiguredNetwork(): StellarNetwork | null {
  const raw = (import.meta.env.VITE_STELLAR_NETWORK as string | undefined)?.trim();
  if (!raw) return "testnet";
  if (raw === "testnet" || raw === "futurenet" || raw === "mainnet" || raw === "local") {
    return raw;
  }
  return null;
}

export function getNetworkEnvValue(): string {
  return (import.meta.env.VITE_STELLAR_NETWORK as string | undefined)?.trim() || "testnet";
}

export function getNetwork(): StellarNetwork {
  return getConfiguredNetwork() ?? "testnet";
}

export function getRpcUrl(): string {
  return getRpcUrls()[0];
}

export function getRpcUrls(): string[] {
  const override = (import.meta.env.VITE_STELLAR_RPC_URL as string | undefined)?.trim();
  const fallbacks = splitUrls(import.meta.env.VITE_STELLAR_RPC_FALLBACK_URLS as string | undefined);
  const network = getNetwork();
  const isProduction = isProductionBuild();

  if (override) {
    const urls = [override, ...fallbacks];
    if (network === "mainnet") {
      urls.forEach((url) => validateProductionUrl("RPC", url, PUBLIC_MAINNET_RPC));
    }
    // Validate hostnames against allowlist in production
    if (isProduction) {
      urls.forEach((url) => validateRpcHostname(url, network, true));
    }
    return urls;
  }
  if (network === "mainnet") {
    throw new Error("Mainnet requires VITE_STELLAR_RPC_URL and may set VITE_STELLAR_RPC_FALLBACK_URLS.");
  }
  const url = RPC_ENDPOINTS[network];
  if (!rpcWarnLogged) {
    rpcWarnLogged = true;
    console.warn(
      "[Opaque] Using public Stellar RPC for",
      network,
      ", set VITE_STELLAR_RPC_URL for production.",
    );
  }
  return [url, ...fallbacks];
}

export function getHorizonUrl(): string {
  return getHorizonUrls()[0];
}

export function getHorizonUrls(): string[] {
  const override = (import.meta.env.VITE_STELLAR_HORIZON_URL as string | undefined)?.trim();
  const fallbacks = splitUrls(import.meta.env.VITE_STELLAR_HORIZON_FALLBACK_URLS as string | undefined);
  const network = getNetwork();
  const isProduction = isProductionBuild();

  if (override) {
    const urls = [override, ...fallbacks];
    if (network === "mainnet") {
      urls.forEach((url) => validateProductionUrl("Horizon", url, PUBLIC_MAINNET_HORIZON));
    }
    // Validate hostnames against allowlist in production
    if (isProduction) {
      urls.forEach((url) => validateRpcHostname(url, network, true));
    }
    return urls;
  }
  if (network === "mainnet") {
    throw new Error("Mainnet requires VITE_STELLAR_HORIZON_URL and may set VITE_STELLAR_HORIZON_FALLBACK_URLS.");
  }
  if (!horizonWarnLogged) {
    horizonWarnLogged = true;
    console.warn(
      "[Opaque] Using public Stellar Horizon for",
      network,
      ", set VITE_STELLAR_HORIZON_URL for production.",
    );
  }
  return [HORIZON_ENDPOINTS[network], ...fallbacks];
}

export function getNetworkPassphrase(): string {
  return NETWORK_PASSPHRASES[getNetwork()];
}

/** @deprecated alias */
export const getCluster = getNetwork;
