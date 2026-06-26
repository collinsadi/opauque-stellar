import { describe, expect, it } from "vitest";
import {
  formatDryRunError,
  verifyProofDryRun,
} from "../proofDryRun";
import type { Groth16ProofResult } from "../proofDryRun";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeValidProof(overrides?: Partial<Groth16ProofResult["proof"]>): Groth16ProofResult {
  return {
    proof: {
      pi_a: ["1", "2", "3"],
      pi_b: [
        ["4", "5"],
        ["6", "7"],
        ["8", "9"],
      ],
      pi_c: ["10", "11", "12"],
      ...overrides,
    },
    publicSignals: ["100", "200", "300"],
  };
}

// ---------------------------------------------------------------------------
// Basic pass cases
// ---------------------------------------------------------------------------

describe("verifyProofDryRun — valid proofs", () => {
  it("passes a valid proof with no expectedPublicSignals", () => {
    const result = verifyProofDryRun({ proof: makeValidProof() });
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("passes a valid proof with matching expectedPublicSignals", () => {
    const proof = makeValidProof();
    const result = verifyProofDryRun({
      proof,
      expectedPublicSignals: ["100", "200", "300"],
    });
    expect(result.passed).toBe(true);
  });

  it("passes when expectedPublicSignals is a subset of publicSignals", () => {
    const proof = makeValidProof();
    const result = verifyProofDryRun({
      proof,
      expectedPublicSignals: ["100"],
    });
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Structural failure — pi_a
// ---------------------------------------------------------------------------

describe("verifyProofDryRun — malformed pi_a", () => {
  it("fails when pi_a has wrong length", () => {
    const proof = makeValidProof({ pi_a: ["1", "2"] });
    const result = verifyProofDryRun({ proof });
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/pi_a/);
  });

  it("fails when pi_a has too many elements", () => {
    const proof = makeValidProof({ pi_a: ["1", "2", "3", "4"] });
    const result = verifyProofDryRun({ proof });
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/pi_a/);
  });

  it("fails when pi_a contains an empty string coordinate", () => {
    const proof = makeValidProof({ pi_a: ["1", "", "3"] });
    const result = verifyProofDryRun({ proof });
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/pi_a\[1\]/);
  });

  it("fails when pi_a contains a non-numeric string", () => {
    const proof = makeValidProof({ pi_a: ["1", "abc", "3"] });
    const result = verifyProofDryRun({ proof });
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/pi_a\[1\]/);
  });
});

// ---------------------------------------------------------------------------
// Structural failure — pi_b
// ---------------------------------------------------------------------------

describe("verifyProofDryRun — malformed pi_b", () => {
  it("fails when pi_b has wrong outer length", () => {
    const proof = makeValidProof({
      pi_b: [["1", "2"], ["3", "4"]],
    });
    const result = verifyProofDryRun({ proof });
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/pi_b/);
  });

  it("fails when a pi_b inner array has wrong length", () => {
    const proof = makeValidProof({
      pi_b: [
        ["1", "2", "3"], // inner too long
        ["4", "5"],
        ["6", "7"],
      ],
    });
    const result = verifyProofDryRun({ proof });
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/pi_b\[0\]/);
  });

  it("fails when pi_b inner element is empty string", () => {
    const proof = makeValidProof({
      pi_b: [
        ["1", ""],
        ["4", "5"],
        ["6", "7"],
      ],
    });
    const result = verifyProofDryRun({ proof });
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/pi_b\[0\]\[1\]/);
  });
});

// ---------------------------------------------------------------------------
// Structural failure — pi_c
// ---------------------------------------------------------------------------

describe("verifyProofDryRun — malformed pi_c", () => {
  it("fails when pi_c has wrong length", () => {
    const proof = makeValidProof({ pi_c: ["1", "2"] });
    const result = verifyProofDryRun({ proof });
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/pi_c/);
  });

  it("fails when pi_c contains an empty string coordinate", () => {
    const proof = makeValidProof({ pi_c: ["1", "2", ""] });
    const result = verifyProofDryRun({ proof });
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/pi_c\[2\]/);
  });
});

// ---------------------------------------------------------------------------
// Signal mismatch
// ---------------------------------------------------------------------------

describe("verifyProofDryRun — signal mismatches", () => {
  it("returns failedSignalIndex=0 and the mismatched values on index-0 mismatch", () => {
    const proof = makeValidProof();
    const result = verifyProofDryRun({
      proof,
      expectedPublicSignals: ["999", "200", "300"],
    });
    expect(result.passed).toBe(false);
    expect(result.failedSignalIndex).toBe(0);
    expect(result.failedSignal).toBe("999");
    expect(result.error).toMatch(/index 0/);
    expect(result.error).toMatch(/999/);
    expect(result.error).toMatch(/100/);
  });

  it("catches a mismatch at index 2 (not just index 0)", () => {
    const proof = makeValidProof();
    const result = verifyProofDryRun({
      proof,
      expectedPublicSignals: ["100", "200", "777"],
    });
    expect(result.passed).toBe(false);
    expect(result.failedSignalIndex).toBe(2);
    expect(result.failedSignal).toBe("777");
    expect(result.error).toMatch(/index 2/);
  });
});

// ---------------------------------------------------------------------------
// formatDryRunError
// ---------------------------------------------------------------------------

describe("formatDryRunError", () => {
  it("returns empty string for a passing result", () => {
    expect(formatDryRunError({ passed: true })).toBe("");
  });

  it("returns a non-empty string containing the error for a failure", () => {
    const result = verifyProofDryRun({
      proof: makeValidProof({ pi_a: ["1", "2"] }),
    });
    const message = formatDryRunError(result);
    expect(typeof message).toBe("string");
    expect(message.length).toBeGreaterThan(0);
    expect(message).toMatch(/pi_a/);
  });

  it("includes signal index information when signal mismatch occurs", () => {
    const proof = makeValidProof();
    const result = verifyProofDryRun({
      proof,
      expectedPublicSignals: ["100", "999"],
    });
    const message = formatDryRunError(result);
    expect(message).toMatch(/index 1/);
    expect(message).toMatch(/999/);
  });
});
