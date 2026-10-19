export interface LeafCommitment {
  /** Stable id for dedupe. Usually attestation UID; falls back to the leaf hex. */
  id: string;
  /** V2 Merkle leaf commitment as 0x-prefixed 32-byte hex. */
  leaf: string;
  /** Schema id recorded by attestation-engine-v2. */
  schemaId: string;
  /** Attestation UID recorded by attestation-engine-v2. */
  attestationUid: string;
  /** Recoverable secp256k1 signature over the UID, schema id, and leaf. */
  holderSignature: string;
  /** Source transaction hash or event id, if available. */
  txHash?: string;
  /** Ledger containing the related announcement/attestation. */
  ledger?: number;
  /** ISO timestamp when the publisher accepted this leaf. */
  submittedAt: string;
}

export interface PublisherState {
  verifierId: string;
  leaves: LeafCommitment[];
  lastPublishedRoot: string | null;
  lastPublishedLedger: number | null;
  lastDatasetHash: string | null;
  updatedAt: string;
}

export interface RootManifest {
  version: 1;
  verifierId: string;
  root: string;
  datasetHash: string;
  leafCount: number;
  leaves: string[];
  generatedAt: string;
}

export interface ChainAdapter {
  currentRoot(): Promise<string | null>;
  postRoot(root: string, datasetHash: string): Promise<{ hash: string; ledger?: number }>;
  getAttestation(uid: string): Promise<OnChainAttestation | null>;
  currentLedger(): Promise<number>;
}

export interface OnChainAttestation {
  schemaId: string;
  stealthAddressHash: string;
  expirationLedger: number;
  revocationLedger: number;
}

export interface PublisherMetrics {
  totalSubmitted: number;
  totalAccepted: number;
  totalRejected: number;
  totalPublished: number;
  currentInboxDepth: number;
  currentLeafCount: number;
  lastPublishAt: string | null;
  lastPublishLatencyMs: number | null;
  startedAt: string;
  totalDuplicateResubmissions: number;
  totalIdentityCollisions: number;
  /** Background publish-tick failures (the tick loop retries on the next interval). */
  totalTickFailures: number;
}

export interface QuarantinedFile {
  filename: string;
  originalContent: unknown;
  errors: string[];
  quarantinedAt: string;
}
