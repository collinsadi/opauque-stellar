/**
 * Expected artifact hashes for runtime inspection and release documentation.
 * Source of truth: artifacts/manifest.json (verified at build time).
 */

import manifest from "../../../artifacts/manifest.json";

export type ArtifactRecord = {
  path: string;
  sha256: string | null;
};

export type CircuitArtifactBundle = {
  witnessWasm: ArtifactRecord;
  zkey: ArtifactRecord;
  contractVkHash: string | null;
  zkeyHashBinding: string | null;
};

export const ARTIFACT_MANIFEST = manifest;

export const SCANNER_ARTIFACT_HASHES = {
  cryptography_bg_wasm: manifest.scanner.files["cryptography_bg.wasm"].sha256,
  cryptography_js: manifest.scanner.files["cryptography.js"].sha256,
} as const;

export function getCircuitArtifactHashes(version: "v1" | "v2"): CircuitArtifactBundle {
  const circuit = manifest.circuits[version];
  return {
    witnessWasm: circuit.frontend.witnessWasm,
    zkey: circuit.frontend.zkey,
    contractVkHash: circuit.contractVk.embeddedVkHash,
    zkeyHashBinding: circuit.contractVk.zkeyHash,
  };
}

/** Log pinned hashes in devtools for manual verification against release notes. */
export function logExpectedArtifactHashes(): void {
  if (import.meta.env.PROD) return;
  console.info("[opaque] Expected artifact hashes", {
    scanner: SCANNER_ARTIFACT_HASHES,
    circuits: {
      v1: getCircuitArtifactHashes("v1"),
      v2: getCircuitArtifactHashes("v2"),
    },
  });
}
