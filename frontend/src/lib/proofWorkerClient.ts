/**
 * Main-thread client for the pool proof worker (#1131).
 *
 * Each proof gets its own worker. Aborting the signal terminates that worker, so a
 * cancelled proof stops right away and can never resolve later with a stale result.
 */
import type {
  Groth16ProofJson,
  ProofWorkerOutbound,
  ProofWorkerRequest,
} from "../workers/proofWorker";

export type ProvedCircuit = {
  proof: Groth16ProofJson;
  publicSignals: string[];
};

/** Standard abort error: callers can detect it with `err.name === "AbortError"`. */
export function proofCancelledError(): DOMException {
  return new DOMException("Pool proof was cancelled. Nothing was submitted.", "AbortError");
}

function absoluteUrl(path: string): string {
  return new URL(path, globalThis.location.href).href;
}

export function proveInWorker(opts: {
  input: Record<string, unknown>;
  wasmPath: string;
  zkeyPath: string;
  signal?: AbortSignal;
  onStage?: (stage: "proving") => void;
}): Promise<ProvedCircuit> {
  const { signal } = opts;
  if (signal?.aborted) return Promise.reject(proofCancelledError());

  return new Promise<ProvedCircuit>((resolve, reject) => {
    const worker = new Worker(new URL("../workers/proofWorker.ts", import.meta.url), {
      type: "module",
    });
    const requestId = globalThis.crypto.randomUUID();

    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      finish();
      reject(proofCancelledError());
    };

    worker.addEventListener("message", (event: MessageEvent<ProofWorkerOutbound>) => {
      const msg = event.data;
      if (msg.requestId !== requestId) return;
      if (msg.type === "stage") {
        opts.onStage?.(msg.stage);
        return;
      }
      finish();
      if (msg.type === "done") {
        resolve({ proof: msg.proof, publicSignals: msg.publicSignals });
      } else {
        reject(new Error(msg.message));
      }
    });
    worker.addEventListener("error", (event: ErrorEvent) => {
      finish();
      reject(new Error(event.message || "Pool proof worker failed."));
    });

    signal?.addEventListener("abort", onAbort, { once: true });

    const request: ProofWorkerRequest = {
      type: "prove",
      requestId,
      input: opts.input,
      wasmUrl: absoluteUrl(opts.wasmPath),
      zkeyUrl: absoluteUrl(opts.zkeyPath),
    };
    worker.postMessage(request);
  });
}
