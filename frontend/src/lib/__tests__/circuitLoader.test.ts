import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ArtifactFetchError,
  ArtifactIntegrityError,
  fetchArtifact,
  getConfiguredOrigins,
} from "../circuitLoader";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute SHA-256 of a byte array and return a lowercase hex string. */
async function sha256Hex(data: Uint8Array): Promise<string> {
  const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Build a minimal fake Response whose body is `data`. */
function makeOkResponse(data: Uint8Array): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: async () => data.buffer as ArrayBuffer,
  } as unknown as Response;
}

function makeErrorResponse(status = 404): Response {
  return {
    ok: false,
    status,
    statusText: "Not Found",
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getConfiguredOrigins", () => {
  it("returns at least two built-in origins when env var is absent", () => {
    const origins = getConfiguredOrigins();
    expect(origins.length).toBeGreaterThanOrEqual(2);
    // Both must be valid URLs
    for (const o of origins) {
      expect(o).toMatch(/^https?:\/\//);
    }
  });
});

describe("fetchArtifact", () => {
  const FILENAME = "sa_final.zkey";
  const DATA = new Uint8Array([1, 2, 3, 4, 5]);

  let savedFetch: typeof globalThis.fetch;
  let savedDigest: typeof globalThis.crypto.subtle.digest;

  beforeEach(() => {
    savedFetch = globalThis.fetch;
    savedDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    // Restore crypto.subtle.digest
    Object.defineProperty(globalThis.crypto.subtle, "digest", {
      value: savedDigest,
      writable: true,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Success cases
  // -------------------------------------------------------------------------

  it("returns data and origin from the first successful origin", async () => {
    const hash = await sha256Hex(DATA);

    let callCount = 0;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request) => {
      callCount++;
      return makeOkResponse(DATA);
    });

    const result = await fetchArtifact(FILENAME, hash);
    expect(result.data).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(result.data)).toEqual(DATA);
    // Should only hit one origin
    expect(callCount).toBe(1);
    // Origin should be a URL string
    expect(result.origin).toMatch(/^https?:\/\//);
  });

  it("falls back to the second origin when the first fetch throws a network error", async () => {
    const hash = await sha256Hex(DATA);

    let callCount = 0;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request) => {
      callCount++;
      if (callCount === 1) {
        throw new TypeError("Failed to fetch");
      }
      return makeOkResponse(DATA);
    });

    const result = await fetchArtifact(FILENAME, hash);
    expect(callCount).toBe(2);
    expect(new Uint8Array(result.data)).toEqual(DATA);
  });

  it("falls back to the second origin when the first returns a non-OK HTTP status", async () => {
    const hash = await sha256Hex(DATA);

    let callCount = 0;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request) => {
      callCount++;
      if (callCount === 1) return makeErrorResponse(404);
      return makeOkResponse(DATA);
    });

    const result = await fetchArtifact(FILENAME, hash);
    expect(callCount).toBe(2);
    expect(new Uint8Array(result.data)).toEqual(DATA);
  });

  // -------------------------------------------------------------------------
  // Integrity failure
  // -------------------------------------------------------------------------

  it("throws ArtifactIntegrityError (not ArtifactFetchError) when fetch succeeds but hash is wrong", async () => {
    const wrongHash = "0".repeat(64); // all-zero hash — definitely wrong

    globalThis.fetch = vi.fn(async () => makeOkResponse(DATA));

    await expect(fetchArtifact(FILENAME, wrongHash)).rejects.toThrow(
      ArtifactIntegrityError,
    );
    // Must NOT be wrapped as ArtifactFetchError
    await expect(fetchArtifact(FILENAME, wrongHash)).rejects.not.toThrow(
      ArtifactFetchError,
    );
  });

  it("ArtifactIntegrityError carries expected and actual hashes", async () => {
    const expectedHash = "0".repeat(64);

    globalThis.fetch = vi.fn(async () => makeOkResponse(DATA));

    let caught: ArtifactIntegrityError | undefined;
    try {
      await fetchArtifact(FILENAME, expectedHash);
    } catch (err) {
      caught = err as ArtifactIntegrityError;
    }

    expect(caught).toBeInstanceOf(ArtifactIntegrityError);
    expect(caught!.filename).toBe(FILENAME);
    expect(caught!.expectedSha256).toBe(expectedHash);
    expect(caught!.actualSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(caught!.actualSha256).not.toBe(expectedHash);
  });

  // -------------------------------------------------------------------------
  // All-origins failure
  // -------------------------------------------------------------------------

  it("throws ArtifactFetchError when all origins fail", async () => {
    const hash = await sha256Hex(DATA);

    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Network unreachable");
    });

    await expect(fetchArtifact(FILENAME, hash)).rejects.toThrow(
      ArtifactFetchError,
    );
  });

  it("ArtifactFetchError lists all tried origins in its message", async () => {
    const hash = await sha256Hex(DATA);

    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Network unreachable");
    });

    let caught: ArtifactFetchError | undefined;
    try {
      await fetchArtifact(FILENAME, hash);
    } catch (err) {
      caught = err as ArtifactFetchError;
    }

    expect(caught).toBeInstanceOf(ArtifactFetchError);
    expect(caught!.origins.length).toBeGreaterThanOrEqual(2);
    expect(caught!.causes.length).toBeGreaterThanOrEqual(2);
  });
});
