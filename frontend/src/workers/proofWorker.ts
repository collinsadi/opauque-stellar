/**
 * Pool withdrawal proof Web Worker (#1131).
 *
 * Runs the snarkjs Groth16 `fullProve` off the main thread so a pool withdrawal
 * no longer freezes the UI for the whole proving window. Cancelling is done by the
 * caller terminating this worker (see `lib/proofWorkerClient.ts`), which stops the
 * proof immediately and discards any partial work.
 *
 * Loaded via `new Worker(new URL("./proofWorker.ts", import.meta.url),
 * { type: "module" })` — see `lib/proofWorkerClient.ts` for the calling side.
 */

/// <reference lib="webworker" />

// @ts-expect-error snarkjs has no bundled types
import * as snarkjs from "snarkjs";

export type ProofWorkerRequest = {
  type: "prove";
  requestId: string;
  input: Record<string, unknown>;
  /** Absolute URLs; a worker resolves relative paths against its own script URL. */
  wasmUrl: string;
  zkeyUrl: string;
};

export type Groth16ProofJson = {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
};

export type ProofWorkerOutbound =
  | { type: "stage"; requestId: string; stage: "proving" }
  | { type: "done"; requestId: string; proof: Groth16ProofJson; publicSignals: string[] }
  | { type: "error"; requestId: string; message: string };

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.addEventListener("message", async (event: MessageEvent<ProofWorkerRequest>) => {
  const request = event.data;
  if (request.type !== "prove") return;
  const { requestId } = request;

  try {
    workerScope.postMessage({ type: "stage", requestId, stage: "proving" } satisfies ProofWorkerOutbound);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      request.input,
      request.wasmUrl,
      request.zkeyUrl,
    );
    workerScope.postMessage({
      type: "done",
      requestId,
      proof: { pi_a: proof.pi_a, pi_b: proof.pi_b, pi_c: proof.pi_c },
      publicSignals,
    } satisfies ProofWorkerOutbound);
  } catch (err) {
    // Message text is preserved so the caller can still classify artifact vs. proving failures.
    const message = err instanceof Error ? err.message : String(err);
    workerScope.postMessage({ type: "error", requestId, message } satisfies ProofWorkerOutbound);
  }
});
