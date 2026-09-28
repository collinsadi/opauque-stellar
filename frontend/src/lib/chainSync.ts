/**
 * Chain-backed reconstruction of schemas and issued attestations.
 *
 * Schemas and issued attestations used to live only in localStorage, so
 * clearing browser storage (or opening the app on another device) left the
 * Manage page empty and the My Traits scanner with no schemas to match
 * received attestations against, even though the records exist on chain.
 *
 * These helpers rebuild that state from contract events plus read-only
 * `get_schema` / `get_attestation` simulations. Events are scanned by contract
 * id only (no topic filter) and routed by their decoded topic symbol, because
 * the registry publishes a mix of one- and two-segment topics and Soroban
 * getEvents matches topic filters by exact length.
 */

import {
  Account,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  StrKey,
} from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { deployedAddresses } from "../contracts/deployedAddresses";
import { getManifestForNetwork } from "../contracts/deploymentManifest";
import { getNetworkPassphrase, type StellarNetwork } from "./chain";
import { getSorobanServer } from "./stellar";
import { isSimulationSuccess } from "./sorobanErrors";
import type { SchemaV2 } from "./schema";
import type { IssuedAttestation } from "../store/issuedAttestationStore";
import {
  selectAttestationUidForTransaction,
  type AttestationChainRecord,
} from "./attestationChainUtils";
export { isVerifiedAttestationRevocationTarget, selectAttestationUidForTransaction } from "./attestationChainUtils";
export type { AttestationChainRecord } from "./attestationChainUtils";

// =============================================================================
// Byte / hex helpers
// =============================================================================

function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  if (v && typeof v === "object" && Array.isArray((v as { data?: unknown }).data)) {
    return Uint8Array.from((v as { data: number[] }).data);
  }
  return new Uint8Array();
}

/** Raw lowercase hex, no 0x (matches schema store keys / bytesToHex). */
function hexNo0x(v: unknown): string {
  return Buffer.from(toBytes(v)).toString("hex");
}

/** 0x-prefixed lowercase hex (matches AttestationManager uid/stealth-hash). */
function hex0x(v: unknown): string {
  return "0x" + hexNo0x(v);
}

function toNum(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  return Number(v ?? 0) || 0;
}

/**
 * Parse the oldest retained ledger from a getEvents -32600 range error, e.g.
 * "startLedger must be within the ledger range: 1884103 - 3093702".
 */
function parseOldestLedgerFromRangeError(err: unknown): number | null {
  let msg = "";
  if (err instanceof Error) msg = err.message;
  else if (typeof err === "string") msg = err;
  else if (err && typeof err === "object") {
    const o = err as { message?: unknown };
    msg = typeof o.message === "string" ? o.message : "";
  }
  const m = /ledger range:\s*(\d+)\s*-\s*(\d+)/.exec(msg);
  return m ? Number(m[1]) : null;
}

// =============================================================================
// Event scanning (by contract, routed client-side by topic symbol)
// =============================================================================

type DecodedEvent = {
  ledger: number;
  txHash: string;
  topic: string;
  data: unknown[];
};

function startLedgerFor(cluster: StellarNetwork): number {
  const dep = getManifestForNetwork(cluster)?.deploymentLedger ?? null;
  return dep != null && dep > 0 ? dep : 1;
}

async function scanContractEvents(
  cluster: StellarNetwork,
  contractId: string,
  fromLedger?: number,
): Promise<DecodedEvent[]> {
  if (!contractId) return [];
  const server = getSorobanServer();
  let from = fromLedger ?? startLedgerFor(cluster);

  // Clamp to the RPC retention window so a startLedger below it does not 400.
  try {
    const health = await server.getHealth();
    const oldest = Number(health.oldestLedger);
    if (from < oldest) from = oldest;
  } catch {
    /* health unavailable; proceed with requested start */
  }

  const filters = [{ type: "contract" as const, contractIds: [contractId] }];
  const out: DecodedEvent[] = [];
  let cursor: string | undefined;
  let first = true;

  // Hard page cap: a backstop against an unexpected non-terminating cursor.
  for (let page = 0; page < 200; page++) {
    let resp;
    try {
      if (first) {
        resp = await server.getEvents({ startLedger: from, filters, limit: 200 });
      } else if (cursor) {
        resp = await server.getEvents({ cursor, filters, limit: 200 });
      } else {
        break;
      }
    } catch (err) {
      const oldest = parseOldestLedgerFromRangeError(err);
      if (first && oldest != null && from < oldest) {
        from = oldest;
        continue;
      }
      throw err;
    }

    for (const ev of resp.events) {
      let topic = "";
      try {
        topic = String(scValToNative(ev.topic[0]));
      } catch {
        /* skip unrecognized topic */
      }
      let data: unknown[] = [];
      try {
        const native = scValToNative(ev.value);
        data = Array.isArray(native) ? native : [native];
      } catch {
        /* skip undecodable payload */
      }
      out.push({ ledger: ev.ledger, txHash: ev.txHash, topic, data });
    }

    if (resp.events.length < 200) break;
    cursor = resp.cursor || resp.events[resp.events.length - 1]?.id;
    first = false;
    if (!cursor) break;
  }

  return out;
}

// =============================================================================
// Read-only contract calls (get_schema / get_attestation)
// =============================================================================

function readSourceKey(
  cluster: StellarNetwork,
  sourcePublicKey?: string | null,
): string | null {
  if (sourcePublicKey && StrKey.isValidEd25519PublicKey(sourcePublicKey)) {
    return sourcePublicKey;
  }
  // Simulation only needs a syntactically valid, existing account as the
  // invoker. The manifest deployer is always funded on the target network.
  const deployer = getManifestForNetwork(cluster)?.deployer ?? null;
  if (deployer && StrKey.isValidEd25519PublicKey(deployer)) return deployer;
  return null;
}

async function readContract(
  contractId: string,
  method: string,
  argBytes: Uint8Array,
  sourceKey: string,
): Promise<unknown | null> {
  try {
    const server = getSorobanServer();
    const passphrase = getNetworkPassphrase();
    const account = new Account(sourceKey, "0");
    const contract = new Contract(contractId);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: passphrase,
    })
      .addOperation(
        contract.call(method, nativeToScVal(Buffer.from(argBytes), { type: "bytes" })),
      )
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (!isSimulationSuccess(sim) || !sim.result) return null;
    return scValToNative(sim.result.retval);
  } catch {
    return null;
  }
}

// =============================================================================
// Public API
// =============================================================================

const ZERO_RESOLVER =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/**
 * Rebuild the full set of registered schemas from chain. Returns every schema
 * (not just the caller's) so the My Traits scanner can authorize issuers of
 * received attestations. The Manage page filters to the connected wallet.
 */
export async function fetchSchemasFromChain(
  cluster: StellarNetwork,
  sourcePublicKey?: string | null,
): Promise<SchemaV2[]> {
  if (!getManifestForNetwork(cluster)) return [];
  const registryId = deployedAddresses.schemaRegistry;
  const events = await scanContractEvents(cluster, registryId);
  const sourceKey = readSourceKey(cluster, sourcePublicKey);

  // Reconstruct current delegate sets from DelegateAdded / DelegateRemoved.
  const delegates = new Map<string, Set<string>>();
  const ensure = (id: string) => {
    let set = delegates.get(id);
    if (!set) {
      set = new Set();
      delegates.set(id, set);
    }
    return set;
  };
  for (const ev of events) {
    if (ev.topic === "DelegateAdded") {
      const [sid, , delegate] = ev.data;
      if (sid != null && typeof delegate === "string") {
        ensure(hexNo0x(sid)).add(delegate);
      }
    } else if (ev.topic === "DelegateRemoved") {
      const [sid, , delegate] = ev.data;
      if (sid != null && typeof delegate === "string") {
        ensure(hexNo0x(sid)).delete(delegate);
      }
    }
  }

  // SchemaRegistered events enumerate schema ids (there is no list getter).
  const registered = new Map<
    string,
    { idBytes: Uint8Array; authority: string; name: string; createdLedger: number }
  >();
  for (const ev of events) {
    if (ev.topic !== "SchemaRegistered") continue;
    const [sid, authority, name] = ev.data;
    if (sid == null) continue;
    registered.set(hexNo0x(sid), {
      idBytes: toBytes(sid),
      authority: typeof authority === "string" ? authority : "",
      name: typeof name === "string" ? name : "",
      createdLedger: ev.ledger,
    });
  }

  const schemas: SchemaV2[] = [];
  for (const [schemaId, evt] of registered) {
    const dels = Array.from(ensure(schemaId));
    const full = sourceKey
      ? ((await readContract(registryId, "get_schema", evt.idBytes, sourceKey)) as
          | Record<string, unknown>
          | null)
      : null;

    if (full) {
      const resolver = String(full.resolver ?? "");
      schemas.push({
        address: schemaId,
        schemaId,
        authority: String(full.authority ?? evt.authority),
        resolver: resolver === ZERO_RESOLVER ? "" : resolver,
        revocable: Boolean(full.revocable),
        name: String(full.name ?? evt.name),
        fieldDefinitions: String(full.field_definitions ?? ""),
        version: toNum(full.version) || 1,
        delegates: dels,
        createdAt: toNum(full.created_at) || evt.createdLedger,
        schemaExpiryLedger: toNum(full.schema_expiry_ledger),
        schemaExpirySlot: toNum(full.schema_expiry_ledger),
        deprecated: Boolean(full.deprecated),
      });
    } else {
      // Read failed: still surface the schema from event data so it is visible.
      schemas.push({
        address: schemaId,
        schemaId,
        authority: evt.authority,
        resolver: "",
        revocable: false,
        name: evt.name,
        fieldDefinitions: "",
        version: 1,
        delegates: dels,
        createdAt: evt.createdLedger,
        schemaExpiryLedger: 0,
        schemaExpirySlot: 0,
        deprecated: false,
      });
    }
  }

  return schemas;
}

/**
 * Rebuild the attestations issued by `issuer` from chain. Names and revocable
 * flags are taken from `schemaLookup` (keyed by raw-hex schema id, no 0x).
 */
export async function fetchIssuedAttestationsFromChain(
  cluster: StellarNetwork,
  issuer: string,
  schemaLookup: Map<string, { name: string; revocable: boolean }>,
  sourcePublicKey?: string | null,
): Promise<IssuedAttestation[]> {
  if (!getManifestForNetwork(cluster)) return [];
  if (!issuer) return [];
  const engineId = deployedAddresses.attestationEngineV2;
  const events = await scanContractEvents(cluster, engineId);
  const sourceKey = readSourceKey(cluster, sourcePublicKey);

  const created = events.filter(
    (ev) => ev.topic === "AttestationCreated" && ev.data[2] === issuer,
  );

  const out: IssuedAttestation[] = [];
  for (const ev of created) {
    const [uid, sid, , stealthHash] = ev.data;
    if (uid == null || sid == null) continue;
    const uidBytes = toBytes(uid);
    const schemaIdHex = hexNo0x(sid);
    const schemaInfo = schemaLookup.get(schemaIdHex);

    const full = sourceKey
      ? ((await readContract(engineId, "get_attestation", uidBytes, sourceKey)) as
          | Record<string, unknown>
          | null)
      : null;

    const expirationSlot = toNum(full?.expiration_ledger);
    const revocationLedger = toNum(full?.revocation_ledger);
    const createdAtSlot = toNum(full?.created_at) || ev.ledger;

    out.push({
      cluster,
      uidHex: hex0x(uid),
      schemaIdHex,
      schemaName: schemaInfo?.name ?? "Unknown Schema",
      stealthAddressHashHex: hex0x(stealthHash),
      createdAtSlot,
      expirationSlot,
      isRevocable: schemaInfo?.revocable ?? false,
      revoked: revocationLedger !== 0,
      txHash: ev.txHash,
    });
  }

  return out;
}

/** Resolve the UID emitted by the confirmed AttestationCreated event for a transaction. */
export async function fetchAttestationUidForTransaction(
  cluster: StellarNetwork,
  txHash: string,
): Promise<Uint8Array | null> {
  if (!getManifestForNetwork(cluster) || !txHash) return null;
  const server = getSorobanServer();
  let transactionLedger: number | undefined;
  try {
    const transaction = await server.getTransaction(txHash);
    if (transaction.status === "SUCCESS") transactionLedger = Number(transaction.ledger);
  } catch {
    // Fall back to the manifest start ledger if the RPC cannot load the receipt.
  }
  const events = await scanContractEvents(cluster, deployedAddresses.attestationEngineV2, transactionLedger);
  return selectAttestationUidForTransaction(events, txHash);
}

/** Read an attestation directly from chain before performing a privileged action. */
export async function fetchAttestationFromChain(
  cluster: StellarNetwork,
  uid: Uint8Array,
  sourcePublicKey?: string | null,
): Promise<AttestationChainRecord | null> {
  if (!getManifestForNetwork(cluster) || uid.length !== 32) return null;
  const sourceKey = readSourceKey(cluster, sourcePublicKey);
  if (!sourceKey) return null;
  const raw = (await readContract(
    deployedAddresses.attestationEngineV2,
    "get_attestation",
    uid,
    sourceKey,
  )) as Record<string, unknown> | null;
  if (!raw) return null;
  const onChainUid = toBytes(raw.uid);
  const schemaId = toBytes(raw.schema_id);
  const stealthHash = toBytes(raw.stealth_address_hash);
  const issuer = raw.issuer;
  if (
    onChainUid.length !== 32 ||
    schemaId.length !== 32 ||
    stealthHash.length !== 32 ||
    typeof issuer !== "string"
  ) {
    return null;
  }
  return {
    uidHex: hex0x(onChainUid),
    issuer,
    schemaIdHex: hex0x(schemaId),
    stealthAddressHashHex: hex0x(stealthHash),
    revocationLedger: toNum(raw.revocation_ledger),
  };
}
