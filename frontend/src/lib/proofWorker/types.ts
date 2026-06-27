/** Serializable V1 witness inputs sent to the proof worker. */
export interface V1WitnessParams {
  traitAttestationId: number;
  stealthPrivKeyBytes: number[];
  externalNullifier: string;
}

/** Serializable V2 circuit inputs sent to the proof worker. */
export interface V2WitnessParams {
  stealthPrivKeyBytes: number[];
  schemaIdField: string;
  issuerPkX: string;
  nonceField: string;
  externalNullifierStr: string;
  /** Hex-encoded attestation payload (0x-prefixed or bare). When provided, the
   *  witness builder computes traitDataHash = Poseidon(packed_bytes) to bind the
   *  proof to on-chain attestation data instead of using the zero placeholder. */
  traitDataHex?: string;
}

export interface Groth16ProofResult {
  proof: {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
  };
  publicSignals: string[];
}

export type ProofWorkerStage = "preparing-witness" | "generating-proof";

/** Timeout configuration for proof generation. */
export interface ProofWorkerTimeoutConfig {
  /** Maximum time in milliseconds for witness preparation. Default: 30000 (30s). */
  witnessTimeoutMs?: number;
  /** Maximum time in milliseconds for proof generation. Default: 120000 (2min). */
  proofTimeoutMs?: number;
}

export type WorkerRequest =
  | {
      id: string;
      type: "generate-v1";
      payload: V1WitnessParams;
      timeout?: ProofWorkerTimeoutConfig;
    }
  | {
      id: string;
      type: "generate-v2";
      payload: V2WitnessParams;
      timeout?: ProofWorkerTimeoutConfig;
    }
  | {
      id: string;
      type: "cancel";
    };

export type WorkerResponse =
  | {
      id: string;
      type: "progress";
      stage: ProofWorkerStage;
      percent: number;
    }
  | {
      id: string;
      type: "success";
      result: Groth16ProofResult;
    }
  | {
      id: string;
      type: "error";
      message: string;
    }
  | {
      id: string;
      type: "timeout";
      stage: ProofWorkerStage;
      timeoutMs: number;
    };
