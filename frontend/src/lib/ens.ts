/**
 * Stellar Federation (SEP-0005) resolver for human-readable identifiers.
 * Resolves addresses in format: name*domain.com → Stellar account ID
 */

/**
 * Check if an identifier looks like a Stellar federation address (name*domain).
 */
export function isDomainName(input: string): boolean {
  const trimmed = input.trim().toLowerCase();
  // Check for federation format: name*domain
  return trimmed.includes("*") && trimmed.split("*").length === 2;
}

/**
 * Stellar TOML configuration.
 */
interface StellarToml {
  FEDERATION_SERVER?: string;
  [key: string]: any;
}

/**
 * Parse Stellar TOML format (simple key=value parser).
 */
function parseStellarToml(content: string): StellarToml {
  const result: StellarToml = {};
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith("#")) continue;

    const [key, ...valueParts] = trimmed.split("=");
    if (!key || !valueParts.length) continue;

    const value = valueParts.join("=").trim();
    // Remove quotes if present
    const cleanValue = value.replace(/^["']|["']$/g, "");
    result[key.trim()] = cleanValue;
  }

  return result;
}

/**
 * Fetch and parse stellar.toml from a domain.
 */
async function fetchStellarToml(domain: string): Promise<StellarToml> {
  const tomlUrl = `https://${domain}/.well-known/stellar.toml`;

  try {
    const response = await fetch(tomlUrl, {
      headers: {
        Accept: "application/toml",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch stellar.toml: HTTP ${response.status}`
      );
    }

    const text = await response.text();
    return parseStellarToml(text);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot resolve domain: ${domain}. ${message}`);
  }
}

/**
 * Query the federation server for an account ID.
 */
async function queryFederationServer(
  serverUrl: string,
  name: string,
  domain: string
): Promise<string> {
  const url = new URL(serverUrl);
  url.searchParams.append("type", "name");
  url.searchParams.append("q", `${name}*${domain}`);

  try {
    const response = await fetch(url.toString());

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error("Federation record not found");
      }
      throw new Error(`Federation server error: HTTP ${response.status}`);
    }

    const data = (await response.json()) as { account_id?: string };

    if (!data.account_id) {
      throw new Error("No account_id returned from federation server");
    }

    return data.account_id;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Federation lookup failed: ${message}`);
  }
}

/**
 * Resolve a Stellar federation address (name*domain) to an account ID.
 * Returns null if the address is not a valid federation format.
 * Throws an error with user-friendly message if resolution fails.
 */
export async function resolveDomain(address: string): Promise<string | null> {
  const trimmed = address.trim().toLowerCase();

  // Not a federation address
  if (!isDomainName(trimmed)) {
    return null;
  }

  const parts = trimmed.split("*");
  const [name, domain] = parts;

  if (!name || !domain) {
    throw new Error("Invalid federation address format");
  }

  // Fetch stellar.toml
  const toml = await fetchStellarToml(domain);

  const federationServer = toml.FEDERATION_SERVER;
  if (!federationServer) {
    throw new Error(
      `${domain} does not support Stellar federation (missing FEDERATION_SERVER in stellar.toml)`
    );
  }

  // Query federation server
  const accountId = await queryFederationServer(
    federationServer,
    name,
    domain
  );

  return accountId;
}

/** @deprecated use isDomainName */
export const isEnsName = isDomainName;

/** @deprecated use resolveDomain */
export const resolveEnsToAddress = resolveDomain;
