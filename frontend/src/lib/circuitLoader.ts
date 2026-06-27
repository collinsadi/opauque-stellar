// Loads circuit WASM/zkey from multiple CDN origins with integrity check.
// Origins come from VITE_CIRCUIT_CDN_ORIGINS (comma-separated) with the
// local /circuits/ path as final fallback.

const MANIFEST_PATH = '/artifacts/manifest.json';

type ManifestEntry = { sha256: string; path: string };

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function fetchWithIntegrity(url: string, expectedHash: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const buf = await res.arrayBuffer();
  const actual = await sha256Hex(buf);
  if (actual !== expectedHash) {
    throw new Error(`Hash mismatch for ${url}: expected ${expectedHash}, got ${actual}`);
  }
  return buf;
}

export interface LoadResult {
  data: ArrayBuffer;
  origin: string;
}

export async function loadCircuitArtifact(
  artifactKey: string, // e.g. 'circuits.v1.frontend.witnessWasm'
): Promise<LoadResult> {
  // Fetch manifest
  const manifestRes = await fetch(MANIFEST_PATH);
  if (!manifestRes.ok) throw new Error('Failed to load artifact manifest');
  const manifest = await manifestRes.json();

  // Resolve entry by dot-path key
  const entry: ManifestEntry = artifactKey.split('.').reduce((o: any, k) => o?.[k], manifest);
  if (!entry?.sha256 || !entry?.path) throw new Error(`Unknown artifact key: ${artifactKey}`);

  const origins: string[] = [
    ...(import.meta.env.VITE_CIRCUIT_CDN_ORIGINS ?? '').split(',').filter(Boolean),
    '', // empty string = relative (local fallback)
  ];

  const errors: string[] = [];
  for (const origin of origins) {
    const url = origin ? `${origin.replace(/\/$/, '')}/${entry.path.replace(/^\//, '')}` : `/${entry.path.replace(/^\//, '')}`;
    try {
      const data = await fetchWithIntegrity(url, entry.sha256);
      return { data, origin: origin || '(local)' };
    } catch (err) {
      errors.push(`${origin || '(local)'}: ${(err as Error).message}`);
    }
  }
  throw new Error(`All origins failed for ${artifactKey}:\n${errors.join('\n')}`);
}
