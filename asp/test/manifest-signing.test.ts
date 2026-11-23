/**
 * #1081 — manifests carry their declared fields and an Ed25519 signature over a
 * canonical, delimited encoding, and the engine signs every manifest it publishes.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import {
  MANIFEST_SIGNATURE_DOMAIN,
  canonicalManifestBytes,
  computeDatasetHash,
  signManifest,
  verifyManifestSignature,
} from "../src/publish.ts";
import { runPoolTick } from "../src/engine.ts";
import { approveAll } from "../src/policy.ts";
import { MemoryStore } from "../src/store.ts";
import type { ChainAdapter, SetManifest } from "../src/types.ts";

/** Test vector shared with the SDK (sdk/tests/unit/asp-manifest-signature.test.ts). */
const VECTOR = JSON.parse(
  readFileSync(new URL("../../sdk/tests/fixtures/asp-signed-manifest.json", import.meta.url), "utf8"),
) as { seedHex: string; publicKey: string; manifest: SetManifest };

const vectorKey = Keypair.fromRawEd25519Seed(Buffer.from(VECTOR.seedHex, "hex"));

function unsigned(m: SetManifest) {
  const { signer: _signer, signature: _signature, ...rest } = m;
  return rest;
}

describe("manifest signing (#1081)", () => {
  it("reproduces the shared test vector byte-for-byte", () => {
    expect(vectorKey.publicKey()).toBe(VECTOR.publicKey);
    const signed = signManifest(unsigned(VECTOR.manifest), vectorKey);
    expect(signed.signature).toBe(VECTOR.manifest.signature);
    expect(signed.signer).toBe(VECTOR.publicKey);
  });

  it("verifies with only the public key", () => {
    expect(verifyManifestSignature(VECTOR.manifest, VECTOR.publicKey)).toBe(true);
  });

  it("carries the declared fields", () => {
    const m = VECTOR.manifest;
    expect(m.datasetHash).toBe(computeDatasetHash(m.root, m.labels));
    expect(typeof m.policy).toBe("string");
    expect(Number.isInteger(m.ledger)).toBe(true);
  });

  it("rejects a different key", () => {
    expect(verifyManifestSignature(VECTOR.manifest, Keypair.random().publicKey())).toBe(false);
  });

  it.each([
    ["poolId", { poolId: "other" }],
    ["root", { root: "0x" + "11".repeat(32) }],
    ["policy", { policy: "allowlist" }],
    ["ledger", { ledger: VECTOR.manifest.ledger + 1 }],
    ["generatedAt", { generatedAt: "2030-01-01T00:00:00.000Z" }],
    ["indices", { indices: [...VECTOR.manifest.indices].reverse() }],
  ])("rejects a tampered %s", (_field, patch) => {
    expect(verifyManifestSignature({ ...VECTOR.manifest, ...patch }, VECTOR.publicKey)).toBe(false);
  });

  it("rejects tampered labels (bound through datasetHash)", () => {
    const labels = [...VECTOR.manifest.labels];
    labels[0] = "12345";
    expect(verifyManifestSignature({ ...VECTOR.manifest, labels }, VECTOR.publicKey)).toBe(false);
  });

  it("rejects an unsigned manifest", () => {
    expect(verifyManifestSignature(unsigned(VECTOR.manifest) as SetManifest, VECTOR.publicKey)).toBe(false);
  });

  it("uses a delimited encoding: moving bytes between fields changes the message", () => {
    const base = unsigned(VECTOR.manifest);
    const a = canonicalManifestBytes({ ...base, poolId: "ab", policy: "c" });
    const b = canonicalManifestBytes({ ...base, poolId: "a", policy: "bc" });
    expect(a.equals(b)).toBe(false);
    // Starts with the length-prefixed, versioned domain separator.
    expect(a.readUInt32BE(0)).toBe(MANIFEST_SIGNATURE_DOMAIN.length);
    expect(a.subarray(4, 4 + MANIFEST_SIGNATURE_DOMAIN.length).toString()).toBe(MANIFEST_SIGNATURE_DOMAIN);
  });
});

describe("engine signs every published manifest (#1081)", () => {
  function adapter(): ChainAdapter & { posted: Array<[string, string]> } {
    let onChain: string | null = null;
    const posted: Array<[string, string]> = [];
    return {
      posted,
      async readDeposits(afterIndex) {
        return [0, 1, 2]
          .filter((i) => i > afterIndex)
          .map((index) => ({ index, commitment: `0x${index}`, value: "1", scope: 1, ledger: 50 + index }));
      },
      async currentAspRoot() {
        return onChain;
      },
      async postAspRoot(root, datasetHash) {
        onChain = root;
        posted.push([root, datasetHash]);
      },
      async latestLedger() {
        return 100;
      },
    };
  }

  it("writes a signed manifest whose datasetHash matches the on-chain post", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "asp-signing-"));
    try {
      const signer = Keypair.random();
      const chain = adapter();
      const res = await runPoolTick({
        poolId: "pool",
        scope: 1,
        adapter: chain,
        store: new MemoryStore(),
        policy: approveAll,
        dataDir,
        manifestSigner: signer,
        now: () => "2026-11-23T00:00:00.000Z",
      });
      expect(res.published).toBe(true);
      const latest = JSON.parse(
        readFileSync(join(dataDir, "sets", "pool", "latest.json"), "utf8"),
      ) as SetManifest;
      expect(verifyManifestSignature(latest, signer.publicKey())).toBe(true);
      expect(latest.policy).toBe(approveAll.name);
      expect(latest.ledger).toBe(52);
      expect(chain.posted).toEqual([[latest.root, latest.datasetHash]]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("refuses to publish manifests without a signing key", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "asp-signing-"));
    try {
      await expect(
        runPoolTick({
          poolId: "pool",
          scope: 1,
          adapter: adapter(),
          store: new MemoryStore(),
          policy: approveAll,
          dataDir,
        }),
      ).rejects.toThrow(/manifestSigner/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
