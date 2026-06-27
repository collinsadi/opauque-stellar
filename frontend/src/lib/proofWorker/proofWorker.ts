/**
 * Web Worker entry — runs Poseidon/circomlib witness prep and Groth16 proving
 * off the main UI thread.
 */
import "../../polyfills";
import { formatProofWorkerError } from "./errors";
import { buildV1Witness } from "./witnessV1";
import { buildV2Witness } from "./witnessV2";
import type { ProofWorkerStage, ProofWorkerTimeoutConfig, WorkerRequest, WorkerResponse } from "./types";

// @ts-expect-error snarkjs has no bundled types
import * as snarkjs from "snarkjs";

const V1_CIRCUIT_WASM_PATH = "/circuits/stealth_attestation_js/stealth_attestation.wasm";
const V1_ZKEY_PATH = "/circuits/sa_final.zkey";
const V2_CIRCUIT_WASM_PATH = "/circuits/v2/stealth_reputation.wasm";
const V2_ZKEY_PATH = "/circuits/v2/stealth_reputation_final.zkey";

const DEFAULT_TIMEOUT: ProofWorkerTimeoutConfig = {
  witnessTimeoutMs: 30000,
  proofTimeoutMs: 120000,
};

const cancelledJobs = new Set<string>();

function post(msg: WorkerResponse): void {
  self.postMessage(msg);
}

function postProgress(id: string, stage: ProofWorkerStage, percent: number): void {
  post({ id, type: "progress", stage, percent });
}

function postTimeout(id: string, stage: ProofWorkerStage, timeoutMs: number): void {
  post({ id, type: "timeout", stage, timeoutMs });
}

function isCancelled(id: string): boolean {
  return cancelledJobs.has(id);
}

function assertNotCancelled(id: string): void {
  if (isCancelled(id)) {
    throw new Error("cancelled");
  }
}

function toUserError(err: unknown): string {
  if (err instanceof Error && err.message === "cancelled") {
    return "cancelled";
  }
  const raw = err instanceof Error ? err.message : String(err);
  return formatProofWorkerError(raw);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function runGroth16Prove(
  id: string,
  witness: Record<string, unknown>,
  wasmPath: string,
  zkeyPath: string,
  timeoutConfig: ProofWorkerTimeoutConfig,
): Promise<{ proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }; publicSignals: string[] }> {
  postProgress(id, "generating-proof", 75);

  const logger = {
    info: () => {
      postProgress(id, "generating-proof", 85);
    },
    debug: () => {
      postProgress(id, "generating-proof", 90);
    },
    error: () => {},
    warn: () => {},
    trace: () => {},
  };

  const proofTimeoutMs = timeoutConfig.proofTimeoutMs ?? DEFAULT_TIMEOUT.proofTimeoutMs!;

  const { proof, publicSignals } = await withTimeout(
    snarkjs.groth16.fullProve(witness, wasmPath, zkeyPath, logger),
    proofTimeoutMs,
    () => postTimeout(id, "generating-proof", proofTimeoutMs),
  );

  postProgress(id, "generating-proof", 95);

  return {
    proof: {
      pi_a: proof.pi_a.slice(0, 2),
      pi_b: proof.pi_b.slice(0, 2),
      pi_c: proof.pi_c.slice(0, 2),
    },
    publicSignals,
  };
}

async function handleGenerateV1(id: string, payload: WorkerRequest & { type: "generate-v1" }): Promise<void> {
  const timeoutConfig = { ...DEFAULT_TIMEOUT, ...payload.timeout };
  const witnessTimeoutMs = timeoutConfig.witnessTimeoutMs!;

  postProgress(id, "preparing-witness", 10);
  assertNotCancelled(id);

  const witness = await withTimeout(
    buildV1Witness(payload.payload),
    witnessTimeoutMs,
    () => postTimeout(id, "preparing-witness", witnessTimeoutMs),
  );
  postProgress(id, "preparing-witness", 70);
  assertNotCancelled(id);

  const result = await runGroth16Prove(id, witness, V1_CIRCUIT_WASM_PATH, V1_ZKEY_PATH, timeoutConfig);
  assertNotCancelled(id);
  post({ id, type: "success", result });
}

async function handleGenerateV2(id: string, payload: WorkerRequest & { type: "generate-v2" }): Promise<void> {
  const timeoutConfig = { ...DEFAULT_TIMEOUT, ...payload.timeout };
  const witnessTimeoutMs = timeoutConfig.witnessTimeoutMs!;

  postProgress(id, "preparing-witness", 10);
  assertNotCancelled(id);

  const witness = await withTimeout(
    buildV2Witness(payload.payload),
    witnessTimeoutMs,
    () => postTimeout(id, "preparing-witness", witnessTimeoutMs),
  );
  postProgress(id, "preparing-witness", 70);
  assertNotCancelled(id);

  const result = await runGroth16Prove(id, witness, V2_CIRCUIT_WASM_PATH, V2_ZKEY_PATH, timeoutConfig);
  assertNotCancelled(id);
  post({ id, type: "success", result });
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;

  if (msg.type === "cancel") {
    cancelledJobs.add(msg.id);
    return;
  }

  const run = async () => {
    try {
      if (msg.type === "generate-v1") {
        await handleGenerateV1(msg.id, msg);
      } else if (msg.type === "generate-v2") {
        await handleGenerateV2(msg.id, msg);
      }
    } catch (err) {
      const message = toUserError(err);
      if (message === "cancelled") {
        return;
      }
      post({ id: msg.id, type: "error", message });
    } finally {
      cancelledJobs.delete(msg.id);
    }
  };

  void run();
};
