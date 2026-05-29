import { describe, expect, it } from "vitest";
import {
  ARTIFACT_MANIFEST,
  getCircuitArtifactHashes,
  SCANNER_ARTIFACT_HASHES,
} from "./artifactHashes";

describe("artifactHashes", () => {
  it("exposes pinned scanner WASM hash", () => {
    expect(SCANNER_ARTIFACT_HASHES.cryptography_bg_wasm).toMatch(/^[a-f0-9]{64}$/);
  });

  it("ties contract VK hash binding to zkey hash for v2", () => {
    const v2 = getCircuitArtifactHashes("v2");
    expect(v2.zkeyHashBinding).toBe(v2.zkey.sha256);
    expect(v2.contractVkHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("loads manifest release tag", () => {
    expect(ARTIFACT_MANIFEST.releaseAssets.tag).toBe("v1-circuit-artifacts");
  });
});
