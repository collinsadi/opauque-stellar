/**
 * ZK proof verification dry-run.
 *
 * Validates a Groth16 proof structure and optionally checks it against a set
 * of expected public signals before the proof is submitted on-chain. Catching
 * common encoding errors early avoids wasted gas and gives the user
 * actionable feedback about which signal failed.
 */

import type { Groth16ProofResult } from "./proofWorker/types";

// Re-export for consumers who want the full type.
export type { Groth16ProofResult };

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface DryRunResult {
  /** Whether the dry-run passed all checks. */
  passed: boolean;
  /** The signal value that failed (from expectedPublicSignals), if applicable. */
  failedSignal?: string;
  /** Index of the failed signal in publicSignals. */
  failedSignalIndex?: number;
  /** Human-readable description of the failure reason. */
  error?: string;
}

export interface ProofDryRunOptions {
  proof: Groth16ProofResult;
  /** If provided, each element is compared to proof.publicSignals[i]. */
  expectedPublicSignals?: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Return true if `value` is a non-empty string that represents a valid bigint. */
function isValidCoordinate(value: unknown): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    BigInt(value.trim());
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Perform a dry-run check on a Groth16 proof.
 *
 * Checks in order:
 *   1. Structural validity of pi_a, pi_b, pi_c (lengths and coordinate types)
 *   2. Optional public-signal equality check
 *
 * Returns a `DryRunResult` — never throws.
 */
export function verifyProofDryRun(options: ProofDryRunOptions): DryRunResult {
  const { proof, expectedPublicSignals } = options;

  // ------------------------------------------------------------------
  // 1. pi_a: must have exactly 3 elements, all valid bigint strings
  // ------------------------------------------------------------------
  if (!Array.isArray(proof.proof.pi_a) || proof.proof.pi_a.length !== 3) {
    return {
      passed: false,
      error: `Malformed proof structure: pi_a must have 3 elements, got ${
        Array.isArray(proof.proof.pi_a) ? proof.proof.pi_a.length : "non-array"
      }`,
    };
  }
  for (let i = 0; i < proof.proof.pi_a.length; i++) {
    if (!isValidCoordinate(proof.proof.pi_a[i])) {
      return {
        passed: false,
        error: `Malformed proof structure: pi_a[${i}] is not a valid bigint string ("${proof.proof.pi_a[i]}")`,
      };
    }
  }

  // ------------------------------------------------------------------
  // 2. pi_b: must have exactly 3 elements, each an array of 2 bigint strings
  // ------------------------------------------------------------------
  if (!Array.isArray(proof.proof.pi_b) || proof.proof.pi_b.length !== 3) {
    return {
      passed: false,
      error: `Malformed proof structure: pi_b must have 3 elements, got ${
        Array.isArray(proof.proof.pi_b) ? proof.proof.pi_b.length : "non-array"
      }`,
    };
  }
  for (let i = 0; i < proof.proof.pi_b.length; i++) {
    const inner = proof.proof.pi_b[i];
    if (!Array.isArray(inner) || inner.length !== 2) {
      return {
        passed: false,
        error: `Malformed proof structure: pi_b[${i}] must be an array of 2 elements, got ${
          Array.isArray(inner) ? inner.length : "non-array"
        }`,
      };
    }
    for (let j = 0; j < 2; j++) {
      if (!isValidCoordinate(inner[j])) {
        return {
          passed: false,
          error: `Malformed proof structure: pi_b[${i}][${j}] is not a valid bigint string ("${inner[j]}")`,
        };
      }
    }
  }

  // ------------------------------------------------------------------
  // 3. pi_c: must have exactly 3 elements, all valid bigint strings
  // ------------------------------------------------------------------
  if (!Array.isArray(proof.proof.pi_c) || proof.proof.pi_c.length !== 3) {
    return {
      passed: false,
      error: `Malformed proof structure: pi_c must have 3 elements, got ${
        Array.isArray(proof.proof.pi_c) ? proof.proof.pi_c.length : "non-array"
      }`,
    };
  }
  for (let i = 0; i < proof.proof.pi_c.length; i++) {
    if (!isValidCoordinate(proof.proof.pi_c[i])) {
      return {
        passed: false,
        error: `Malformed proof structure: pi_c[${i}] is not a valid bigint string ("${proof.proof.pi_c[i]}")`,
      };
    }
  }

  // ------------------------------------------------------------------
  // 4. Optional: public signal equality
  // ------------------------------------------------------------------
  if (expectedPublicSignals !== undefined) {
    for (let i = 0; i < expectedPublicSignals.length; i++) {
      const expected = expectedPublicSignals[i];
      const actual = proof.publicSignals[i];
      if (expected !== actual) {
        return {
          passed: false,
          failedSignal: expected,
          failedSignalIndex: i,
          error: `Signal mismatch at index ${i}: expected ${expected} got ${actual ?? "<missing>"}`,
        };
      }
    }
  }

  return { passed: true };
}

/**
 * Format a failed `DryRunResult` into a human-readable string.
 *
 * Returns an empty string for passing results.
 */
export function formatDryRunError(result: DryRunResult): string {
  if (result.passed) return "";

  const parts: string[] = ["Proof dry-run failed."];

  if (result.error) {
    parts.push(result.error);
  }

  if (result.failedSignalIndex !== undefined) {
    parts.push(`Failed at public signal index ${result.failedSignalIndex}.`);
  }

  if (result.failedSignal !== undefined) {
    parts.push(`Expected signal value: ${result.failedSignal}.`);
  }

  return parts.join(" ");
}
