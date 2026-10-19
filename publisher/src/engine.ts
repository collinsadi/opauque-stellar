import { buildRoot } from "./merkle.ts";
import { verifyHolderSignature } from "./identity.ts";
import { createLogger } from "./logger.ts";
import { computeDatasetHash, rootManifest, writeRootManifest } from "./publish.ts";
import type { Store } from "./store.ts";
import type { ChainAdapter, LeafCommitment, PublisherMetrics, PublisherState } from "./types.ts";

const log = createLogger("publisher-engine");

export interface PublisherTickConfig {
  verifierId: string;
  adapter: ChainAdapter;
  store: Store;
  dataDir?: string;
  now?: () => string;
  minLeavesToPublish?: number;
}

export interface PublisherTickResult {
  verifierId: string;
  leafCount: number;
  newlyAccepted: number;
  localRoot: string | null;
  onChainRoot: string | null;
  datasetHash: string | null;
  published: boolean;
  txHash?: string;
  latencyMs: number;
}

function initState(verifierId: string, now: string): PublisherState {
  return {
    verifierId,
    leaves: [],
    lastPublishedRoot: null,
    lastPublishedLedger: null,
    lastDatasetHash: null,
    updatedAt: now,
  };
}

function mergeLeaves(existing: LeafCommitment[], incoming: LeafCommitment[]): {
  leaves: LeafCommitment[];
  acceptedIds: string[];
  duplicateResubmissions: number;
  identityCollisions: LeafCommitment[];
} {
  const byId = new Map<string, LeafCommitment>();
  const byLeaf = new Set<string>();
  for (const leaf of existing) {
    byId.set(leaf.id, leaf);
    byLeaf.add(leaf.leaf);
  }
  const acceptedIds: string[] = [];
  const acceptedLeaves: LeafCommitment[] = [];
  let duplicateResubmissions = 0;
  const identityCollisions: LeafCommitment[] = [];
  for (const leaf of incoming) {
    const existingById = byId.get(leaf.id);
    const existingByLeaf = byLeaf.has(leaf.leaf);
    if (existingById && existingById.leaf === leaf.leaf) {
      duplicateResubmissions++;
      continue;
    }
    if (existingById || existingByLeaf) {
      identityCollisions.push(leaf);
      const reason = existingById ? `id "${leaf.id}" already in tree` : `leaf "${leaf.leaf.slice(0, 14)}..." already in tree`;
      log.warn("identity collision", { reason, leafId: leaf.id, leaf: leaf.leaf });
      continue;
    }
    byId.set(leaf.id, leaf);
    byLeaf.add(leaf.leaf);
    acceptedIds.push(leaf.id);
    acceptedLeaves.push(leaf);
  }
  // Append-only ordering: existing leaves keep their positions; new leaves
  // are appended in submission order so prior inclusion paths remain valid.
  const leaves = [...existing, ...acceptedLeaves];
  return { leaves, acceptedIds, duplicateResubmissions, identityCollisions };
}

export function createMetrics(): PublisherMetrics {
  return {
    totalSubmitted: 0,
    totalAccepted: 0,
    totalRejected: 0,
    totalPublished: 0,
    currentInboxDepth: 0,
    currentLeafCount: 0,
    lastPublishAt: null,
    lastPublishLatencyMs: null,
    startedAt: new Date().toISOString(),
    totalDuplicateResubmissions: 0,
    totalIdentityCollisions: 0,
    totalTickFailures: 0,
  };
}

export async function runPublisherTick(cfg: PublisherTickConfig, metrics?: PublisherMetrics): Promise<PublisherTickResult> {
  const tickStart = Date.now();
  const now = cfg.now ?? (() => new Date().toISOString());
  const at = now();
  const state = cfg.store.load(cfg.verifierId) ?? initState(cfg.verifierId, at);
  const inbox = cfg.store.readInbox(now);
  const processedIds = inbox.map((leaf) => leaf.id);
  let priorLeaves = state.leaves;
  let prunedLeaves = false;
  let eligibleInbox = inbox;
  {
    const ledger = await cfg.adapter.currentLedger();
    const isValidLeaf = async (leaf: LeafCommitment): Promise<boolean> => {
      const attestation = await cfg.adapter.getAttestation(leaf.attestationUid);
      return Boolean(
        attestation &&
        attestation.revocationLedger === 0 &&
        (attestation.expirationLedger === 0 || attestation.expirationLedger > ledger) &&
        attestation.schemaId.toLowerCase() === leaf.schemaId.toLowerCase() &&
        verifyHolderSignature({
          attestationUid: leaf.attestationUid,
          schemaId: leaf.schemaId,
          leaf: leaf.leaf,
          signature: leaf.holderSignature,
          stealthAddressHash: attestation.stealthAddressHash,
        })
      );
    };
    const activeLeaves: LeafCommitment[] = [];
    for (const leaf of priorLeaves) if (await isValidLeaf(leaf)) activeLeaves.push(leaf);
    prunedLeaves = activeLeaves.length < priorLeaves.length;
    priorLeaves = activeLeaves;
    const validInbox: LeafCommitment[] = [];
    for (const leaf of inbox) if (await isValidLeaf(leaf)) validInbox.push(leaf);
    eligibleInbox = validInbox;
  }
  const { leaves, acceptedIds, duplicateResubmissions, identityCollisions } = mergeLeaves(priorLeaves, eligibleInbox);
  state.leaves = leaves;
  state.updatedAt = at;

  if (metrics) {
    metrics.currentInboxDepth = cfg.store.inboxSize();
    metrics.currentLeafCount = leaves.length;
    metrics.totalDuplicateResubmissions += duplicateResubmissions;
    metrics.totalIdentityCollisions += identityCollisions.length;
    if (identityCollisions.length > 0) {
      log.warn("identity collisions flagged", { count: identityCollisions.length });
    }
  }

  const minLeaves = cfg.minLeavesToPublish ?? 1;
  if (leaves.length < minLeaves && !prunedLeaves) {
    cfg.store.save(state);
    cfg.store.archiveInbox(processedIds);
    const latencyMs = Date.now() - tickStart;
    return {
      verifierId: cfg.verifierId,
      leafCount: leaves.length,
      newlyAccepted: acceptedIds.length,
      localRoot: null,
      onChainRoot: await cfg.adapter.currentRoot(),
      datasetHash: null,
      published: false,
      latencyMs,
    };
  }

  const leafValues = leaves.map((x) => x.leaf);
  const localRoot = await buildRoot(leafValues);
  const datasetHash = computeDatasetHash(localRoot, leafValues);
  const onChainRoot = await cfg.adapter.currentRoot();

  let published = false;
  let txHash: string | undefined;
  if (localRoot !== onChainRoot) {
    if (cfg.dataDir) {
      writeRootManifest(
        cfg.dataDir,
        rootManifest({
          verifierId: cfg.verifierId,
          root: localRoot,
          datasetHash,
          leaves: leafValues,
          generatedAt: at,
        }),
      );
    }
    const res = await cfg.adapter.postRoot(localRoot, datasetHash);
    published = true;
    txHash = res.hash;
    state.lastPublishedRoot = localRoot;
    state.lastPublishedLedger = res.ledger ?? null;
    state.lastDatasetHash = datasetHash;
    if (metrics) {
      metrics.totalPublished += 1;
      metrics.lastPublishAt = at;
    }
  }

  cfg.store.save(state);
  cfg.store.archiveInbox(processedIds);
  const latencyMs = Date.now() - tickStart;
  if (metrics) {
    metrics.lastPublishLatencyMs = latencyMs;
  }
  return {
    verifierId: cfg.verifierId,
    leafCount: leaves.length,
    newlyAccepted: acceptedIds.length,
    localRoot,
    onChainRoot,
    datasetHash,
    published,
    txHash,
    latencyMs,
  };
}
