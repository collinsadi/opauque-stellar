/**
 * Relayer-side NaCl box. The relayer depends on `tweetnacl` directly, so it binds
 * the SDK's shared implementation (single source of truth for the wire format)
 * to its own instance and keeps synchronous call sites. The SDK's public
 * `sealBox` / `openBox` / `generateX25519Keypair` stay async and lazy-load
 * `tweetnacl` as an optional peer dependency (#1078).
 */
import nacl from "tweetnacl";
import { createNaclBox } from "../../../sdk/src/relayer-protocol/box.ts";

export type { X25519Keypair } from "../../../sdk/src/relayer-protocol/box.ts";

export const { generateX25519Keypair, sealBox, openBox } = createNaclBox(nacl);
