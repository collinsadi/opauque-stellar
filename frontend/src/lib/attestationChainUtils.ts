export type AttestationCreatedEvent = {
  topic: string;
  txHash: string;
  data: unknown[];
};

export function selectAttestationUidForTransaction(
  events: readonly AttestationCreatedEvent[],
  txHash: string,
): Uint8Array | null {
  const created = events.find(
    (event) => event.topic === "AttestationCreated" && event.txHash.toLowerCase() === txHash.toLowerCase(),
  );
  if (!created || created.data[0] == null) return null;
  const raw = created.data[0];
  const uid = raw instanceof Uint8Array
    ? raw
    : Array.isArray(raw)
      ? Uint8Array.from(raw as number[])
      : raw && typeof raw === "object" && Array.isArray((raw as { data?: unknown }).data)
        ? Uint8Array.from((raw as { data: number[] }).data)
        : new Uint8Array();
  return uid.length === 32 ? uid : null;
}

export interface AttestationChainRecord {
  uidHex: string;
  issuer: string;
  schemaIdHex: string;
  stealthAddressHashHex: string;
  revocationLedger: number;
}

export function isVerifiedAttestationRevocationTarget(
  chain: AttestationChainRecord,
  expected: {
    uidHex: string;
    schemaIdHex: string;
    stealthAddressHashHex: string;
  },
  issuer: string,
): boolean {
  const normalize = (value: string) => value.replace(/^0x/, "").toLowerCase();
  return normalize(chain.uidHex) === normalize(expected.uidHex) &&
    normalize(chain.schemaIdHex) === normalize(expected.schemaIdHex) &&
    normalize(chain.stealthAddressHashHex) === normalize(expected.stealthAddressHashHex) &&
    chain.issuer === issuer &&
    chain.revocationLedger === 0;
}
