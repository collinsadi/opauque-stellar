import { Address, xdr } from "@stellar/stellar-sdk";
import { keccak_256 } from "@noble/hashes/sha3";
import { assertLength, bytesToHex, concatBytes, hexToBytes, i128ToBytes } from "../../../sdk/src/relayer-protocol/bytes.ts";

export const RELAY_PAYLOAD_DOMAIN = "opaque-stellar-relay-v1";
export const RELAY_CHAIN_STELLAR = 3000;

export type PoolWithdrawPayload = {
  poolId: string;
  proofA: Uint8Array;
  proofB: Uint8Array;
  proofC: Uint8Array;
  withdrawnValue: bigint;
  stateRoot: Uint8Array;
  aspRoot: Uint8Array;
  nullifierHash: Uint8Array;
  newCommitment: Uint8Array;
  recipient: string;
  poolFee: bigint;
  poolRelayer: string;
};

export type SerializablePoolWithdrawPayload = {
  poolId: string;
  proofA: string;
  proofB: string;
  proofC: string;
  withdrawnValue: string;
  stateRoot: string;
  aspRoot: string;
  nullifierHash: string;
  newCommitment: string;
  recipient: string;
  poolFee: string;
  poolRelayer: string;
};

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function addressXdr(address: string): Uint8Array {
  return new Uint8Array(new Address(address).toScVal().toXDR());
}

function symbolXdr(symbol: string): Uint8Array {
  return new Uint8Array(xdr.ScVal.scvSymbol(symbol).toXDR());
}

export function poolWithdrawPayloadPreimage(payload: PoolWithdrawPayload): Uint8Array {
  return concatBytes(
    utf8(RELAY_PAYLOAD_DOMAIN),
    addressXdr(payload.poolId),
    symbolXdr("withdraw"),
    assertLength(payload.proofA, 64, "proofA"),
    assertLength(payload.proofB, 128, "proofB"),
    assertLength(payload.proofC, 64, "proofC"),
    i128ToBytes(payload.withdrawnValue),
    assertLength(payload.stateRoot, 32, "stateRoot"),
    assertLength(payload.aspRoot, 32, "aspRoot"),
    assertLength(payload.nullifierHash, 32, "nullifierHash"),
    assertLength(payload.newCommitment, 32, "newCommitment"),
    addressXdr(payload.recipient),
    i128ToBytes(payload.poolFee),
    addressXdr(payload.poolRelayer),
  );
}

export function hashPoolWithdrawPayload(payload: PoolWithdrawPayload): Uint8Array {
  return keccak_256(poolWithdrawPayloadPreimage(payload));
}

export function hashPoolWithdrawPayloadHex(payload: PoolWithdrawPayload): string {
  return bytesToHex(hashPoolWithdrawPayload(payload));
}

export function serializePoolWithdrawPayload(payload: PoolWithdrawPayload): SerializablePoolWithdrawPayload {
  return {
    poolId: payload.poolId,
    proofA: bytesToHex(payload.proofA),
    proofB: bytesToHex(payload.proofB),
    proofC: bytesToHex(payload.proofC),
    withdrawnValue: payload.withdrawnValue.toString(),
    stateRoot: bytesToHex(payload.stateRoot),
    aspRoot: bytesToHex(payload.aspRoot),
    nullifierHash: bytesToHex(payload.nullifierHash),
    newCommitment: bytesToHex(payload.newCommitment),
    recipient: payload.recipient,
    poolFee: payload.poolFee.toString(),
    poolRelayer: payload.poolRelayer,
  };
}

export function parsePoolWithdrawPayload(payload: SerializablePoolWithdrawPayload): PoolWithdrawPayload {
  return {
    poolId: payload.poolId,
    proofA: assertLength(hexToBytes(payload.proofA), 64, "proofA"),
    proofB: assertLength(hexToBytes(payload.proofB), 128, "proofB"),
    proofC: assertLength(hexToBytes(payload.proofC), 64, "proofC"),
    withdrawnValue: BigInt(payload.withdrawnValue),
    stateRoot: assertLength(hexToBytes(payload.stateRoot), 32, "stateRoot"),
    aspRoot: assertLength(hexToBytes(payload.aspRoot), 32, "aspRoot"),
    nullifierHash: assertLength(hexToBytes(payload.nullifierHash), 32, "nullifierHash"),
    newCommitment: assertLength(hexToBytes(payload.newCommitment), 32, "newCommitment"),
    recipient: payload.recipient,
    poolFee: BigInt(payload.poolFee),
    poolRelayer: payload.poolRelayer,
  };
}

export function encodePoolWithdrawPayload(payload: PoolWithdrawPayload): Uint8Array {
  return utf8(JSON.stringify({ t: "pool-withdraw", v: 1, payload: serializePoolWithdrawPayload(payload) }));
}

export function decodePoolWithdrawPayload(bytes: Uint8Array): PoolWithdrawPayload {
  const decoded = JSON.parse(new TextDecoder().decode(bytes)) as {
    t?: string;
    v?: number;
    payload?: SerializablePoolWithdrawPayload;
  };
  if (decoded.t !== "pool-withdraw" || decoded.v !== 1 || !decoded.payload) {
    throw new Error("Unsupported relayer payload.");
  }
  return parsePoolWithdrawPayload(decoded.payload);
}
