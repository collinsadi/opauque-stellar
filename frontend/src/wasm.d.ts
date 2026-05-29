/**
 * Type declaration for the WASM module loaded via Vite alias @wasm/cryptography.js
 */
declare module '@wasm/cryptography.js' {
  /** Async init (loads .wasm); call this before using any other exports */
  export default function init(module_or_path?: unknown): Promise<unknown>;
  export function initSync(module: unknown): unknown;

  // Stealth address derivation
  export function derive_stealth_address_wasm(
    view_privkey_bytes: Uint8Array,
    spend_pubkey_bytes: Uint8Array,
    ephemeral_pubkey_bytes: Uint8Array
  ): { stealthAddress: string; viewTag: number };

  // Announcement checking
  export function check_announcement_wasm(
    announcement_stealth_address: string,
    view_tag: number,
    view_privkey_bytes: Uint8Array,
    spend_pubkey_bytes: Uint8Array,
    ephemeral_pubkey_bytes: Uint8Array
  ): boolean;
  export function check_announcement_view_tag_wasm(
    view_tag: number,
    view_privkey_bytes: Uint8Array,
    ephemeral_pubkey_bytes: Uint8Array
  ): "NoMatch" | "PossibleMatch";

  // Signing key reconstruction
  export function reconstruct_signing_key_wasm(
    master_spend_priv_bytes: Uint8Array,
    master_view_priv_bytes: Uint8Array,
    ephemeral_pubkey_bytes: Uint8Array
  ): Uint8Array;

  // Attestation scanning
  export function scan_attestations_wasm(
    announcements_json: string,
    view_privkey_bytes: Uint8Array,
    spend_pubkey_bytes: Uint8Array,
  ): string;

  // ZK witness generation (V1)
  export function generate_reputation_witness(
    attestations_json: string,
    target_trait_id: string,
    stealth_privkey_bytes: Uint8Array,
    external_nullifier: string,
  ): string;

  // V2 attestation metadata encoding
  export function encode_v2_attestation_metadata_wasm(
    view_tag: number,
    schema_id_hex: string,
    issuer_hex: string,
    attestation_uid_hex: string,
    nonce_hex: string,
    expiration_ledger: number,
  ): string;

  // V2 attestation scanning
  export function scan_attestations_v2_wasm(
    announcements_json: string,
    schemas_json: string,
    view_privkey_bytes: Uint8Array,
    spend_pubkey_bytes: Uint8Array,
    current_slot: number,
    trusted_issuers_json: string,
  ): string;

  // V2 ZK witness generation
  export function generate_reputation_witness_v2(
    attestations_v2_json: string,
    target_schema_id_hex: string,
    stealth_privkey_bytes: Uint8Array,
    trait_data_hash_hex: string,
    external_nullifier: string,
  ): string;

  // V1 metadata encoding
  export function encode_attestation_metadata_wasm(
    view_tag: number,
    attestation_id: number,
  ): string;
}
