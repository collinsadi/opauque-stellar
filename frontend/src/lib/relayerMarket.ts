import {
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  type xdr,
} from "@stellar/stellar-sdk";
import { getRelayerConfig } from "../contracts/relayerConfig";
import { getNetworkPassphrase } from "./chain";
import {
  makeAdvert,
  validateBid,
  verifyBid,
  type JobAdvert,
  type RelayerBid,
  sealBox,
  assertLength,
  bytesToHex,
  hexToBytes,
  encodePoolWithdrawPayload,
  hashPoolWithdrawPayload,
  RELAY_CHAIN_STELLAR,
  type PoolWithdrawPayload,
} from "@opaquecash/stellar/relayer-protocol";
import { bytesToScVal, getSorobanServer } from "./stellar";
import { RelayerGatewayError } from "./errors";
import type { WithdrawProof } from "./poolProver";

const DEFAULT_GATEWAYS = ["http://127.0.0.1:8787"];
const DEFAULT_JOB_DEADLINE_LEDGERS = 720;

export type RelayerJobDraft = {
  jobId: Uint8Array;
  jobIdHex: string;
  payload: PoolWithdrawPayload;
  payloadHash: Uint8Array;
  payloadHashHex: string;
  advert: JobAdvert;
  deadlineLedger: number;
  fee: bigint;
};

export type VerifiedBid = RelayerBid & {
  freeStakeValue: bigint;
};

export type RelayerJobStatus =
  | "open"
  | "accepted"
  | "submitted"
  | "slashed"
  | "canceled"
  | "unknown";

const REGISTRY_JOB_STATUS: Record<number, RelayerJobStatus> = {
  0: "open",
  1: "accepted",
  2: "submitted",
  3: "slashed",
  4: "canceled",
};

type NativeRegistryJob = {
  status: number | bigint;
  fee: bigint | number | string;
  deadline_ledger?: number | bigint;
};

type NativeRegistryRelayer = {
  endpoint?: string;
  free_stake: bigint | number | string;
  x25519_pubkey: Uint8Array | number[];
};

function splitGatewayUrls(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
}

export function relayerGatewayUrls(): string[] {
  const envUrls = splitGatewayUrls(import.meta.env.VITE_RELAYER_GATEWAY_URL as string | undefined);
  if (envUrls.length > 0) return envUrls;
  const manifestUrls = getRelayerConfig()?.gatewayUrls ?? [];
  return manifestUrls.length > 0 ? manifestUrls : DEFAULT_GATEWAYS;
}

export function relayerGatewayUrl(): string {
  return relayerGatewayUrls()[0];
}

export function randomJobId(): Uint8Array {
  const out = new Uint8Array(32);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export async function defaultDeadlineLedger(
  ledgers = DEFAULT_JOB_DEADLINE_LEDGERS,
): Promise<number> {
  const latest = await getSorobanServer().getLatestLedger();
  return latest.sequence + ledgers;
}

export function buildRelayedWithdrawPayload(args: {
  poolId: string;
  registryId: string;
  proof: WithdrawProof;
  recipient: string;
  /**
   * Address bound into the proof's context hash. When the user picked a specific
   * relayer up front (#559) this is that operator's address, and only they can
   * submit the payload. Falls back to the registry address for the
   * pick-after-bidding flow, where the relayer is not known at proving time.
   */
  boundRelayer?: string;
}): PoolWithdrawPayload {
  return {
    poolId: args.poolId,
    proofA: args.proof.proofA,
    proofB: args.proof.proofB,
    proofC: args.proof.proofC,
    withdrawnValue: args.proof.withdrawnValue,
    stateRoot: args.proof.stateRoot,
    aspRoot: args.proof.aspRoot,
    nullifierHash: args.proof.nullifierHash,
    newCommitment: args.proof.newCommitment,
    recipient: args.recipient,
    poolFee: 0n,
    // The pool fee is zero in Phase 6 MVP; registry escrow pays the selected relayer.
    // `poolRelayer` MUST equal the address the proof's context was computed over,
    // or the pool contract rejects the withdrawal.
    poolRelayer: args.boundRelayer ?? args.registryId,
  };
}

export function buildRelayerJobDraft(args: {
  payload: PoolWithdrawPayload;
  fee: bigint;
  deadlineLedger: number;
  jobId?: Uint8Array;
}): RelayerJobDraft {
  const jobId = assertLength(args.jobId ?? randomJobId(), 32, "jobId");
  const payloadHash = hashPoolWithdrawPayload(args.payload);
  const advert = makeAdvert({
    jobId,
    fee: args.fee,
    deadline: args.deadlineLedger,
    payloadHash,
  });
  return {
    jobId,
    jobIdHex: bytesToHex(jobId),
    payload: args.payload,
    payloadHash,
    payloadHashHex: bytesToHex(payloadHash),
    advert,
    deadlineLedger: args.deadlineLedger,
    fee: args.fee,
  };
}

function gatewayUrl(path: string, base = relayerGatewayUrl()): string {
  const url = new URL(path, base.endsWith("/") ? base : `${base}/`);
  return url.toString();
}

export async function publishAdvert(advert: JobAdvert, gateway = relayerGatewayUrl()): Promise<void> {
  const res = await fetch(gatewayUrl("v1/jobs", gateway), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(advert),
  });
  if (!res.ok) {
    throw new RelayerGatewayError({
      message: `Relayer gateway rejected advert (${res.status}).`,
      gateway,
      operation: "advert",
      status: res.status,
    });
  }
}

export async function fetchRelayerBids(
  jobIdHex: string,
  gateway = relayerGatewayUrl(),
): Promise<VerifiedBid[]> {
  const res = await fetch(
    gatewayUrl(`v1/jobs/${encodeURIComponent(jobIdHex)}/bids`, gateway),
  );
  if (!res.ok) {
    throw new RelayerGatewayError({
      message: `Could not fetch relayer bids (${res.status}).`,
      gateway,
      operation: "bids",
      status: res.status,
    });
  }
  const body = (await res.json()) as { bids?: unknown[] };
  const signed = (body.bids ?? [])
    .map((raw) => validateBid(raw))
    .filter((bid) => verifyBid(bid))
    .filter((bid) => bid.jobId.toLowerCase() === jobIdHex.toLowerCase())
    .filter((bid) => bid.chain === RELAY_CHAIN_STELLAR);
  const checked = await Promise.all(
    signed.map((bid) => verifyBidRegistryState(jobIdHex, bid)),
  );
  return checked.filter((bid): bid is VerifiedBid => bid !== null);
}

export async function deliverPayloadToRelayer(args: {
  draft: RelayerJobDraft;
  bid: RelayerBid;
  gateway?: string;
}): Promise<{ acceptedTx?: string; submittedTx?: string } | null> {
  const box = await sealBox(
    encodePoolWithdrawPayload(args.draft.payload),
    hexToBytes(args.bid.x25519Pk),
  );
  const res = await fetch(
    gatewayUrl(
      `v1/jobs/${encodeURIComponent(args.draft.jobIdHex)}/payload`,
      args.gateway ?? relayerGatewayUrl(),
    ),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        t: "payload",
        v: 1,
        jobId: args.draft.jobIdHex,
        to: args.bid.x25519Pk,
        box,
      }),
    },
  );
  if (!res.ok) {
    throw new RelayerGatewayError({
      message: `Relayer gateway rejected payload (${res.status}).`,
      gateway: args.gateway ?? relayerGatewayUrl(),
      operation: "payload",
      status: res.status,
    });
  }
  const body = (await res.json()) as {
    result?: { acceptedTx?: string; submittedTx?: string } | null;
  };
  return body.result ?? null;
}

export async function fetchRelayerJobStatus(
  jobIdHex: string,
  sourcePublicKey: string,
): Promise<RelayerJobStatus> {
  const job = await simulateRegistryView<NativeRegistryJob>(sourcePublicKey, "get_job", [
    bytesToScVal(hexToBytes(jobIdHex)),
  ]);
  if (!job) return "unknown";
  return REGISTRY_JOB_STATUS[Number(job.status)] ?? "unknown";
}

async function verifyBidRegistryState(
  jobIdHex: string,
  bid: RelayerBid,
): Promise<VerifiedBid | null> {
  try {
    const cfg = getRelayerConfig();
    if (!cfg) return null;
    const [job, relayer] = await Promise.all([
      simulateRegistryView<NativeRegistryJob>(bid.operator, "get_job", [
        bytesToScVal(hexToBytes(jobIdHex)),
      ]),
      simulateRegistryView<NativeRegistryRelayer>(bid.operator, "get_relayer", [
        nativeToScVal(bid.operator, { type: "address" }),
      ]),
    ]);
    if (!job || !relayer) return null;
    const fee = BigInt(job.fee);
    const freeStakeValue = BigInt(relayer.free_stake);
    if (Number(job.status) !== 0 || freeStakeValue < fee) return null;
    const registeredPk = bytesToHex(Uint8Array.from(relayer.x25519_pubkey));
    if (registeredPk.toLowerCase() !== bid.x25519Pk.toLowerCase()) return null;
    const endpoint = relayer.endpoint?.trim() || bid.endpoint;
    return {
      ...bid,
      endpoint,
      freeStake: freeStakeValue.toString(),
      freeStakeValue,
    };
  } catch {
    return null;
  }
}

async function simulateRegistryView<T>(
  sourcePublicKey: string,
  method: string,
  args: xdr.ScVal[],
): Promise<T | null> {
  const cfg = getRelayerConfig();
  if (!cfg) return null;
  const server = getSorobanServer();
  const account = await server.getAccount(sourcePublicKey);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(new Contract(cfg.registryId).call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim) || !sim.result?.retval) return null;
  return scValToNative(sim.result.retval) as T;
}

export function pickStakeWeightedBid(bids: VerifiedBid[]): VerifiedBid | null {
  if (bids.length === 0) return null;
  const total = bids.reduce((sum, bid) => sum + bid.freeStakeValue, 0n);
  if (total <= 0n) return bids[0];
  const rand = new Uint32Array(2);
  globalThis.crypto.getRandomValues(rand);
  const r = (BigInt(rand[0]) << 32n) + BigInt(rand[1]);
  let target = r % total;
  for (const bid of bids) {
    if (target < bid.freeStakeValue) return bid;
    target -= bid.freeStakeValue;
  }
  return bids[bids.length - 1];
}
