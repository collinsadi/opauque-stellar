export class ProofGenerationCancelledError extends Error {
  constructor(message = "Proof generation was cancelled.") {
    super(message);
    this.name = "ProofGenerationCancelledError";
  }
}

export class ProofGenerationTimeoutError extends Error {
  public readonly stage: string;
  public readonly timeoutMs: number;

  constructor(stage: string, timeoutMs: number) {
    const stageLabel = stage === "preparing-witness" ? "witness generation" : "proof generation";
    super(
      `Proof ${stageLabel} timed out after ${Math.round(timeoutMs / 1000)}s. ` +
      "Try again with fewer attestations or use a device with more processing power.",
    );
    this.name = "ProofGenerationTimeoutError";
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

const MEMORY_ERROR_PATTERN =
  /out of memory|allocation failed|cannot enlarge memory|memory access out of bounds|array buffer allocation failed|reached wasm memory limit/i;

const ARTIFACT_ERROR_PATTERN =
  /fetch|404|networkerror|failed to load/i;

/**
 * Map raw worker / snarkjs errors to user-facing messages.
 */
export function formatProofWorkerError(raw: string): string {
  if (MEMORY_ERROR_PATTERN.test(raw)) {
    return (
      "Proof generation ran out of memory. Close other browser tabs and try again, " +
      "or use a device with more available RAM."
    );
  }
  if (ARTIFACT_ERROR_PATTERN.test(raw)) {
    return (
      "Circuit files could not be loaded. Ensure circuit artifacts are present in " +
      "frontend/public/circuits/ and refresh the page."
    );
  }
  return raw || "An unknown error occurred during proof generation.";
}
