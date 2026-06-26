/**
 * Circuit artifact CDN fallback loader.
 *
 * Tries each configured origin in order, verifies SHA-256 integrity, and
 * returns the first successful result together with the origin URL that
 * served it.
 *
 * Origins are configured via VITE_CIRCUIT_CDN_ORIGINS (comma-separated list
 * of base URLs). If the env var is absent, two built-in origins are used:
 *   1. The manifest's releaseAssets.baseUrl (GitHub Releases)
 *   2. jsDelivr CDN mirror of the same tag
 */

import manifest from "../../../artifacts/manifest.json";

const MANIFEST_BASE_URL = manifest.releaseAssets.baseUrl;
const JSDELIVR_FALLBACK =
  "https://cdn.jsdelivr.net/gh/collinsadi/opauque-stellar@v1-circuit-artifacts";

/** Typed error thrown when a fetched artifact's hash does not match. */
export class ArtifactIntegrityError extends Error {
  constructor(
    public readonly filename: string,
    public readonly origin: string,
    public readonly expectedSha256: string,
    public readonly actualSha256: string,
  ) {
    super(
      `Integrity check failed for "${filename}" from "${origin}": ` +
        `expected ${expectedSha256} got ${actualSha256}`,
    );
    this.name = "ArtifactIntegrityError";
  }
}

/** Typed error thrown when every origin has been tried and all failed. */
export class ArtifactFetchError extends Error {
  constructor(
    public readonly filename: string,
    public readonly origins: string[],
    public readonly causes: string[],
  ) {
    super(
      `Failed to fetch artifact "${filename}" from all ${origins.length} origin(s). ` +
        `Causes: ${causes.join(" | ")}`,
    );
    this.name = "ArtifactFetchError";
  }
}

/**
 * Returns the ordered list of CDN origins that will be tried for every
 * artifact fetch.
 *
 * Priority:
 * 1. VITE_CIRCUIT_CDN_ORIGINS env var (comma-separated, in declaration order)
 * 2. Manifest base URL followed by jsDelivr mirror
 */
export function getConfiguredOrigins(): string[] {
  const envVar =
    typeof import.meta !== "undefined" &&
    typeof (import.meta as Record<string, unknown>).env !== "undefined"
      ? ((import.meta as { env: Record<string, string | undefined> }).env
          .VITE_CIRCUIT_CDN_ORIGINS ?? "")
      : "";

  if (envVar.trim()) {
    return envVar
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
  }

  return [MANIFEST_BASE_URL, JSDELIVR_FALLBACK];
}

/** Convert an ArrayBuffer to a lowercase hex string. */
function bufferToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Fetch a circuit artifact, verifying its SHA-256 hash.
 *
 * Iterates through the configured origins in order. For each origin:
 *   - Fetches `${origin}/${filename}`
 *   - Computes SHA-256 of the response bytes
 *   - Compares against `expectedSha256` (hex string)
 *
 * Returns `{ data, origin }` from the first origin that passes the integrity
 * check.
 *
 * @throws {ArtifactIntegrityError} if a fetch succeeds but the hash is wrong
 *   (raised immediately — does NOT fall through to the next origin, because a
 *   hash mismatch signals a tampered or corrupted file that should never be
 *   used regardless of source).
 * @throws {ArtifactFetchError} if every origin fails with a network error.
 */
export async function fetchArtifact(
  filename: string,
  expectedSha256: string,
): Promise<{ data: ArrayBuffer; origin: string }> {
  const origins = getConfiguredOrigins();
  const causes: string[] = [];

  for (const origin of origins) {
    const url = `${origin}/${filename}`;
    let response: Response;
    try {
      response = await fetch(url);
    } catch (err) {
      causes.push(`${origin}: network error — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (!response.ok) {
      causes.push(`${origin}: HTTP ${response.status} ${response.statusText}`);
      continue;
    }

    const data = await response.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const actualSha256 = bufferToHex(hashBuffer);

    if (actualSha256 !== expectedSha256.toLowerCase()) {
      // Hash mismatch: abort immediately — do not fall through.
      throw new ArtifactIntegrityError(filename, origin, expectedSha256, actualSha256);
    }

    return { data, origin };
  }

  throw new ArtifactFetchError(filename, origins, causes);
}
