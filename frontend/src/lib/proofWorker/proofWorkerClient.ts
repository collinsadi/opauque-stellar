import {
  formatProofWorkerError,
  ProofGenerationCancelledError,
  ProofGenerationTimeoutError,
} from "./errors";
import type {
  Groth16ProofResult,
  ProofWorkerStage,
  ProofWorkerTimeoutConfig,
  V1WitnessParams,
  V2WitnessParams,
  WorkerRequest,
  WorkerResponse,
} from "./types";

export type { ProofWorkerStage, ProofWorkerTimeoutConfig };

export {
  ProofGenerationCancelledError,
  ProofGenerationTimeoutError,
  formatProofWorkerError,
};

export type ProofProgressCallback = (stage: ProofWorkerStage, percent: number) => void;

export interface ProofWorkerRunOptions {
  onProgress?: ProofProgressCallback;
  signal?: AbortSignal;
  timeout?: ProofWorkerTimeoutConfig;
}

function createJobId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `proof-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function spawnProofWorker(): Worker {
  return new Worker(new URL("./proofWorker.ts", import.meta.url), { type: "module" });
}

function runProofJob(
  request: Exclude<WorkerRequest, { type: "cancel" }>,
  options: ProofWorkerRunOptions = {},
): Promise<Groth16ProofResult> {
  const { onProgress, signal, timeout } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProofGenerationCancelledError());
      return;
    }

    const worker = spawnProofWorker();
    const jobId = request.id;

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };

    const onAbort = () => {
      worker.postMessage({ id: jobId, type: "cancel" } satisfies WorkerRequest);
      cleanup();
      reject(new ProofGenerationCancelledError());
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      if (msg.id !== jobId) return;

      if (msg.type === "progress") {
        onProgress?.(msg.stage, msg.percent);
        return;
      }

      if (msg.type === "timeout") {
        cleanup();
        reject(
          new ProofGenerationTimeoutError(msg.stage, msg.timeoutMs),
        );
        return;
      }

      cleanup();

      if (msg.type === "success") {
        resolve(msg.result);
        return;
      }

      reject(new Error(formatProofWorkerError(msg.message)));
    };

    worker.onerror = (event) => {
      cleanup();
      const detail = event.message || "Proof worker failed unexpectedly.";
      reject(new Error(formatProofWorkerError(detail)));
    };

    const requestWithTimeout = timeout ? { ...request, timeout } : request;
    worker.postMessage(requestWithTimeout);
  });
}

export function generateV1ProofInWorker(
  params: V1WitnessParams,
  options?: ProofWorkerRunOptions,
): Promise<Groth16ProofResult> {
  return runProofJob(
    { id: createJobId(), type: "generate-v1", payload: params },
    options,
  );
}

export function generateV2ProofInWorker(
  params: V2WitnessParams,
  options?: ProofWorkerRunOptions,
): Promise<Groth16ProofResult> {
  return runProofJob(
    { id: createJobId(), type: "generate-v2", payload: params },
    options,
  );
}
