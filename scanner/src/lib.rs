//! # Opaque Cash — WASM Bindings
//!
//! WebAssembly bindings for the stealth address scanner engine (EIP-5564 / DKSAP).

use wasm_bindgen::prelude::*;
use js_sys;
use k256::{ecdsa::SigningKey, PublicKey};
use alloy_primitives::Address;
use log::{info, warn};
use std::str::FromStr;

/// The only event schema version this scanner understands.
/// Announcements carrying a different version are skipped with a console warning.
const SUPPORTED_EVENT_VERSION: u32 = 1;

mod scanner;
mod attestation;
mod merkle;

use scanner::{
    derive_stealth_address, derive_stealth_signing_key, check_announcement,
    check_announcement_view_tag, ViewTagCheck,
};

// Initialize panic hook for better error messages in browser console
#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
    env_logger::init();
}

// =============================================================================
// Type conversions: Rust <-> JavaScript
// =============================================================================

/// Converts a 32-byte Uint8Array to a SigningKey
fn bytes_to_signing_key(bytes: &[u8]) -> Result<SigningKey, JsValue> {
    if bytes.len() != 32 {
        return Err(JsValue::from_str("SigningKey must be 32 bytes"));
    }
    let mut key_bytes = [0u8; 32];
    key_bytes.copy_from_slice(bytes);
    SigningKey::from_bytes(&key_bytes.into())
        .map_err(|e| JsValue::from_str(&format!("Invalid signing key: {}", e)))
}

/// Converts a compressed public key (33 bytes) to PublicKey
/// Validates and decodes a 33-byte compressed secp256k1 public key.
///
/// Issue #53: rejects the wrong length, a non-compressed prefix (anything other
/// than `0x02`/`0x03`), and encodings that do not correspond to an on-curve point.
/// Returns a stable `&str` error so the logic is unit-testable off-wasm (the
/// `JsValue` wrapper below is the only wasm-specific part).
fn parse_compressed_pubkey(bytes: &[u8]) -> Result<PublicKey, &'static str> {
    if bytes.len() != 33 {
        return Err("PublicKey must be 33 bytes (compressed)");
    }
    // Compressed secp256k1 points must start with 0x02 (even Y) or 0x03 (odd Y).
    match bytes[0] {
        0x02 | 0x03 => {}
        _ => return Err("compressed PublicKey must start with 0x02 or 0x03"),
    }
    PublicKey::from_sec1_bytes(bytes)
        .map_err(|_| "Invalid public key: not a canonical secp256k1 point")
}

fn bytes_to_public_key(bytes: &[u8]) -> Result<PublicKey, JsValue> {
    parse_compressed_pubkey(bytes).map_err(JsValue::from_str)
}

/// Converts an Address to a hex string
fn address_to_hex(address: &Address) -> String {
    format!("{:#x}", address)
}

/// Converts a hex string to an Address
fn hex_to_address(hex: &str) -> Result<Address, JsValue> {
    Address::from_str(hex)
        .map_err(|e| JsValue::from_str(&format!("Invalid address hex: {}", e)))
}

// =============================================================================
// WASM Exports
// =============================================================================

/// Derives a stealth address and view tag from the given keys.
///
/// # Arguments
/// * `view_privkey_bytes` - 32-byte viewing private key (Uint8Array)
/// * `spend_pubkey_bytes` - 33-byte spending public key, compressed (Uint8Array)
/// * `ephemeral_pubkey_bytes` - 33-byte ephemeral public key, compressed (Uint8Array)
///
/// # Returns
/// A JavaScript object with:
/// * `stealthAddress` - Ethereum address as hex string (0x...)
/// * `viewTag` - View tag as number (0-255)
#[wasm_bindgen]
pub fn derive_stealth_address_wasm(
    view_privkey_bytes: &[u8],
    spend_pubkey_bytes: &[u8],
    ephemeral_pubkey_bytes: &[u8],
) -> Result<JsValue, JsValue> {
    let view_privkey = bytes_to_signing_key(view_privkey_bytes)?;
    let spend_pubkey = bytes_to_public_key(spend_pubkey_bytes)?;
    let ephemeral_pubkey = bytes_to_public_key(ephemeral_pubkey_bytes)?;

    match derive_stealth_address(&view_privkey, &spend_pubkey, &ephemeral_pubkey) {
        Ok((address, view_tag)) => {
            let result = js_sys::Object::new();
            js_sys::Reflect::set(
                &result,
                &"stealthAddress".into(),
                &address_to_hex(&address).into(),
            )?;
            js_sys::Reflect::set(
                &result,
                &"viewTag".into(),
                &JsValue::from(view_tag as u32),
            )?;
            Ok(result.into())
        }
        Err(e) => Err(JsValue::from_str(&format!("Stealth address error: {}", e))),
    }
}

/// Checks if an announcement matches this recipient's keys.
///
/// # Arguments
/// * `announcement_stealth_address` - Stealth address from announcement (hex string)
/// * `view_tag` - View tag from announcement (number 0-255)
/// * `view_privkey_bytes` - 32-byte viewing private key (Uint8Array)
/// * `spend_pubkey_bytes` - 33-byte spending public key, compressed (Uint8Array)
/// * `ephemeral_pubkey_bytes` - 33-byte ephemeral public key, compressed (Uint8Array)
///
/// # Returns
/// `true` if the announcement is for this recipient, `false` otherwise.
#[wasm_bindgen]
pub fn check_announcement_wasm(
    announcement_stealth_address: &str,
    view_tag: u8,
    view_privkey_bytes: &[u8],
    spend_pubkey_bytes: &[u8],
    ephemeral_pubkey_bytes: &[u8],
) -> Result<bool, JsValue> {
    let address = hex_to_address(announcement_stealth_address)?;
    let view_privkey = bytes_to_signing_key(view_privkey_bytes)?;
    let spend_pubkey = bytes_to_public_key(spend_pubkey_bytes)?;
    let ephemeral_pubkey = bytes_to_public_key(ephemeral_pubkey_bytes)?;

    check_announcement(
        address,
        view_tag,
        &view_privkey,
        &spend_pubkey,
        &ephemeral_pubkey,
    )
    .map_err(|e| JsValue::from_str(&format!("Check announcement error: {}", e)))
}

/// Quick view-tag check before expensive EC operations.
///
/// # Arguments
/// * `view_tag` - View tag from announcement (number 0-255)
/// * `view_privkey_bytes` - 32-byte viewing private key (Uint8Array)
/// * `ephemeral_pubkey_bytes` - 33-byte ephemeral public key, compressed (Uint8Array)
///
/// # Returns
/// `"NoMatch"` if view tag doesn't match (skip this announcement),
/// `"PossibleMatch"` if view tag matches (proceed with full check).
#[wasm_bindgen]
pub fn check_announcement_view_tag_wasm(
    view_tag: u8,
    view_privkey_bytes: &[u8],
    ephemeral_pubkey_bytes: &[u8],
) -> Result<String, JsValue> {
    let view_privkey = bytes_to_signing_key(view_privkey_bytes)?;
    let ephemeral_pubkey = bytes_to_public_key(ephemeral_pubkey_bytes)?;

    match check_announcement_view_tag(view_tag, &view_privkey, &ephemeral_pubkey) {
        ViewTagCheck::NoMatch => Ok("NoMatch".to_string()),
        ViewTagCheck::PossibleMatch => Ok("PossibleMatch".to_string()),
    }
}

/// Reconstructs the one-time signing key (private key) for a stealth address.
///
/// # Arguments
/// * `master_spend_priv_bytes` - 32-byte spending private key (Uint8Array)
/// * `master_view_priv_bytes` - 32-byte viewing private key (Uint8Array)
/// * `ephemeral_pubkey_bytes` - 33-byte ephemeral public key, compressed (Uint8Array)
///
/// # Returns
/// 32-byte stealth private key as Uint8Array (for use with ethers.Wallet or viem privateKeyToAccount).
#[wasm_bindgen]
pub fn reconstruct_signing_key_wasm(
    master_spend_priv_bytes: &[u8],
    master_view_priv_bytes: &[u8],
    ephemeral_pubkey_bytes: &[u8],
) -> Result<Vec<u8>, JsValue> {
    let spend_privkey = bytes_to_signing_key(master_spend_priv_bytes)?;
    let view_privkey = bytes_to_signing_key(master_view_priv_bytes)?;
    let ephemeral_pubkey = bytes_to_public_key(ephemeral_pubkey_bytes)?;

    derive_stealth_signing_key(&view_privkey, &spend_privkey, &ephemeral_pubkey)
        .map(|bytes| bytes.to_vec())
        .map_err(|e| JsValue::from_str(&format!("Reconstruct signing key error: {}", e)))
}

// =============================================================================
// Stealth Attestation — WASM Exports
// =============================================================================

use attestation::{
    scan_for_attestations,
    scan_for_attestations_v2,
    RawAnnouncement, StealthAttestation as AttestationRecord,
    SchemaInfo, V2StealthAttestation,
};
use merkle::{field_string_to_bytes, MerkleTree, CircuitWitness};

/// Scans announcement metadata for attestation markers.
///
/// # Arguments
/// * `announcements_json` - JSON array of announcements, each with:
///   `{ stealthAddress, viewTag, ephemeralPubKey, metadata, txHash, blockNumber }`
/// * `view_privkey_bytes` - 32-byte viewing private key
/// * `spend_pubkey_bytes` - 33-byte spending public key (compressed)
///
/// # Returns
/// JSON array of `StealthAttestation` objects found for this recipient.
#[wasm_bindgen]
pub fn scan_attestations_wasm(
    announcements_json: &str,
    view_privkey_bytes: &[u8],
    spend_pubkey_bytes: &[u8],
) -> Result<String, JsValue> {
    let view_privkey = bytes_to_signing_key(view_privkey_bytes)?;
    let spend_pubkey = bytes_to_public_key(spend_pubkey_bytes)?;

    let raw_anns: Vec<serde_json::Value> = serde_json::from_str(announcements_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid JSON: {}", e)))?;

    let mut announcements = Vec::with_capacity(raw_anns.len());
    for ann in &raw_anns {
        // Issue #50: skip announcements whose event_version is present but unsupported.
        if let Some(ver) = ann["eventVersion"].as_u64().map(|v| v as u32) {
            if ver != SUPPORTED_EVENT_VERSION {
                #[cfg(target_arch = "wasm32")]
                web_sys::console::warn_1(
                    &format!("Skipping announcement with unsupported event_version {ver}; expected {SUPPORTED_EVENT_VERSION}").into(),
                );
                #[cfg(not(target_arch = "wasm32"))]
                eprintln!("Skipping announcement with unsupported event_version {ver}; expected {SUPPORTED_EVENT_VERSION}");
                continue;
            }
        }

        let stealth_addr_str = ann["stealthAddress"].as_str().unwrap_or_default();
        let stealth_address = hex_to_address(stealth_addr_str)?;
        let view_tag = ann["viewTag"].as_u64().unwrap_or(0) as u8;

        let eph_hex = ann["ephemeralPubKey"].as_str().unwrap_or_default();
        let eph_clean = if eph_hex.starts_with("0x") { &eph_hex[2..] } else { eph_hex };
        let eph_bytes = hex::decode(eph_clean)
            .map_err(|e| JsValue::from_str(&format!("Invalid ephemeral pubkey hex: {}", e)))?;

        // Issue #53: skip announcements with an invalid/non-compressed public key
        // non-fatally so one bad event does not abort the entire scan.
        let ephemeral_pubkey = match bytes_to_public_key(&eph_bytes) {
            Ok(pk) => pk,
            Err(_) => {
                #[cfg(target_arch = "wasm32")]
                web_sys::console::warn_1(
                    &format!("Skipping announcement with invalid ephemeral public key (bad prefix or non-canonical point)").into(),
                );
                #[cfg(not(target_arch = "wasm32"))]
                eprintln!("Skipping announcement with invalid ephemeral public key (bad prefix or non-canonical point)");
                continue;
            }
        };

        let meta_hex = ann["metadata"].as_str().unwrap_or_default();
        let meta_clean = if meta_hex.starts_with("0x") { &meta_hex[2..] } else { meta_hex };
        let metadata = hex::decode(meta_clean).unwrap_or_default();

        let tx_hash = ann["txHash"].as_str().unwrap_or_default().to_string();
        let block_number = ann["blockNumber"].as_u64().unwrap_or(0);

        announcements.push(RawAnnouncement {
            stealth_address,
            view_tag,
            ephemeral_pubkey,
            metadata,
            tx_hash,
            block_number,
        });
    }

    let results = scan_for_attestations(&announcements, &view_privkey, &spend_pubkey)
        .map_err(|e| JsValue::from_str(&format!("Scan error: {}", e)))?;

    serde_json::to_string(&results)
        .map_err(|e| JsValue::from_str(&format!("Serialize error: {}", e)))
}

/// Generates the full ZK-circuit witness for a specific trait.
///
/// Builds a local Merkle tree from the given attestations, finds the first
/// attestation matching `target_trait_id`, generates an inclusion proof,
/// and returns a JSON witness compatible with the Circom circuit.
///
/// # Arguments
/// * `attestations_json` - JSON array of `StealthAttestation` (from `scan_attestations_wasm`)
/// * `target_trait_id` - The attestation_id to prove (as string decimal)
/// * `stealth_privkey_bytes` - 32-byte stealth private key for the matching address
/// * `external_nullifier` - Action-scoped nonce (as string decimal)
///
/// # Returns
/// JSON `CircuitWitness` for the Circom prover.
#[wasm_bindgen]
pub fn generate_reputation_witness(
    attestations_json: &str,
    target_trait_id: &str,
    stealth_privkey_bytes: &[u8],
    external_nullifier: &str,
) -> Result<String, JsValue> {
    let attestations: Vec<AttestationRecord> = serde_json::from_str(attestations_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid attestations JSON: {}", e)))?;

    let target_id: u64 = target_trait_id.parse()
        .map_err(|e| JsValue::from_str(&format!("Invalid trait ID: {}", e)))?;

    let ext_null: u64 = external_nullifier.parse()
        .map_err(|e| JsValue::from_str(&format!("Invalid external nullifier: {}", e)))?;

    // Build Merkle tree from all attestations (depth 20 = ~1M capacity)
    let mut tree = MerkleTree::new(20);
    let mut target_leaf_idx: Option<usize> = None;
    let mut target_attestation: Option<&AttestationRecord> = None;

    for att in &attestations {
        let leaf_data = format!("{}:{}", att.stealth_address, att.attestation_id);
        let idx = tree.insert_raw(leaf_data.as_bytes());
        if att.attestation_id == target_id && target_leaf_idx.is_none() {
            target_leaf_idx = Some(idx);
            target_attestation = Some(att);
        }
    }

    let leaf_idx = target_leaf_idx
        .ok_or_else(|| JsValue::from_str("No attestation found matching target trait ID"))?;
    let _target_att = target_attestation.unwrap();

    let proof = tree.proof(leaf_idx);

    if stealth_privkey_bytes.len() != 32 {
        return Err(JsValue::from_str("Stealth private key must be 32 bytes"));
    }

    let privkey_hex = stealth_privkey_bytes
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>();
    let privkey_decimal = u128::from_str_radix(&privkey_hex[..32], 16)
        .map(|v| v.to_string())
        .unwrap_or_else(|_| "0".to_string());

    let witness = CircuitWitness {
        merkle_root: bytes_to_decimal_string(&proof.root),
        attestation_id: target_id.to_string(),
        external_nullifier: ext_null.to_string(),
        stealth_private_key: privkey_decimal,
        ephemeral_pubkey: ["0".to_string(), "0".to_string()],
        announcement_attestation_id: target_id.to_string(),
        merkle_path_elements: proof.path_elements.iter().map(|e| bytes_to_decimal_string(e)).collect(),
        merkle_path_indices: proof.path_indices,
    };

    serde_json::to_string(&witness)
        .map_err(|e| JsValue::from_str(&format!("Serialize witness error: {}", e)))
}

/// Encodes attestation metadata for use in announcements.
///
/// # Arguments
/// * `view_tag` - View tag byte (0-255)
/// * `attestation_id` - Attestation/badge ID
///
/// # Returns
/// Hex-encoded metadata bytes.
#[wasm_bindgen]
pub fn encode_attestation_metadata_wasm(view_tag: u8, attestation_id: u64) -> String {
    let metadata = attestation::encode_attestation_metadata(view_tag, attestation_id);
    format!("0x{}", metadata.iter().map(|b| format!("{:02x}", b)).collect::<String>())
}

// =============================================================================
// V2 WASM Exports
// =============================================================================

/// Encodes V2 attestation metadata for use in stealth announcements.
///
/// Layout: view_tag(1) || 0xB2(1) || schema_id(32) || issuer(32) || attestation_uid(32) || nonce(32) || expiration_ledger(4)
///
/// # Arguments
/// * `view_tag` - View tag byte (0-255)
/// * `schema_id_hex` - Schema identifier as 64-char hex string (32 bytes)
/// * `issuer_hex` - Issuer pubkey as 64-char hex string (32 bytes)
/// * `attestation_uid_hex` - Attestation UID as 64-char hex string (32 bytes)
/// * `nonce_hex` - Random nonce as 64-char hex string (32 bytes)
/// * `expiration_ledger` - Ledger number at which this attestation expires (0 = never expires)
///
/// # Returns
/// Hex-encoded metadata bytes (0x-prefixed).
#[wasm_bindgen]
pub fn encode_v2_attestation_metadata_wasm(
    view_tag: u8,
    schema_id_hex: &str,
    issuer_hex: &str,
    attestation_uid_hex: &str,
    nonce_hex: &str,
    expiration_ledger: u32,
) -> Result<String, JsValue> {
    let schema_id = parse_hex32(schema_id_hex)?;
    let issuer = parse_hex32(issuer_hex)?;
    let attestation_uid = parse_hex32(attestation_uid_hex)?;
    let nonce = parse_hex32(nonce_hex)?;

    let metadata = attestation::encode_v2_attestation_metadata(
        view_tag,
        &schema_id,
        &issuer,
        &attestation_uid,
        &nonce,
        expiration_ledger,
    );
    Ok(format!("0x{}", metadata.iter().map(|b| format!("{:02x}", b)).collect::<String>()))
}

/// Scans V2 announcements for schema-bound attestations belonging to this recipient.
///
/// Unlike V1, V2 requires a schema registry snapshot to validate issuer authorization.
/// Rogue traits (issued by non-delegates) are filtered out before results are returned.
///
/// # Arguments
/// * `announcements_json` - JSON array of announcement objects (same format as V1)
/// * `schemas_json` - JSON array of SchemaInfo objects fetched from schema_registry program
/// * `view_privkey_bytes` - 32-byte viewing private key (Uint8Array)
/// * `spend_pubkey_bytes` - 33-byte spending public key (compressed, Uint8Array)
/// * `current_slot` - Current ledger sequence for expiry checks
/// * `trusted_issuers_json` - Optional JSON array of trusted issuer hex strings; pass "" to skip
///
/// # Returns
/// JSON array of V2StealthAttestation objects.
#[wasm_bindgen]
pub fn scan_attestations_v2_wasm(
    announcements_json: &str,
    schemas_json: &str,
    view_privkey_bytes: &[u8],
    spend_pubkey_bytes: &[u8],
    current_slot: u64,
    trusted_issuers_json: &str,
) -> Result<String, JsValue> {
    let view_privkey = bytes_to_signing_key(view_privkey_bytes)?;
    let spend_pubkey = bytes_to_public_key(spend_pubkey_bytes)?;

    // Parse announcements (reuse V1 parser)
    let raw_anns: Vec<serde_json::Value> = serde_json::from_str(announcements_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid announcements JSON: {}", e)))?;

    let mut announcements = Vec::with_capacity(raw_anns.len());
    for ann in &raw_anns {
        // Issue #50: skip unsupported event schema versions with telemetry.
        if let Some(ver) = ann["eventVersion"].as_u64().map(|v| v as u32) {
            if ver != SUPPORTED_EVENT_VERSION {
                #[cfg(target_arch = "wasm32")]
                web_sys::console::warn_1(
                    &format!("Skipping V2 announcement with unsupported event_version {ver}; expected {SUPPORTED_EVENT_VERSION}").into(),
                );
                #[cfg(not(target_arch = "wasm32"))]
                eprintln!("Skipping V2 announcement with unsupported event_version {ver}; expected {SUPPORTED_EVENT_VERSION}");
                continue;
            }
        }

        let stealth_addr_str = ann["stealthAddress"].as_str().unwrap_or_default();
        let stealth_address = hex_to_address(stealth_addr_str)?;
        let view_tag = ann["viewTag"].as_u64().unwrap_or(0) as u8;
        let eph_hex = ann["ephemeralPubKey"].as_str().unwrap_or_default();
        let eph_clean = if eph_hex.starts_with("0x") { &eph_hex[2..] } else { eph_hex };
        let eph_bytes = hex::decode(eph_clean)
            .map_err(|e| JsValue::from_str(&format!("Invalid ephemeral pubkey: {}", e)))?;

        // Issue #53: skip announcements with invalid compressed key non-fatally.
        let ephemeral_pubkey = match bytes_to_public_key(&eph_bytes) {
            Ok(pk) => pk,
            Err(_) => {
                #[cfg(target_arch = "wasm32")]
                web_sys::console::warn_1(
                    &format!("Skipping V2 announcement with invalid ephemeral public key").into(),
                );
                #[cfg(not(target_arch = "wasm32"))]
                eprintln!("Skipping V2 announcement with invalid ephemeral public key");
                continue;
            }
        };

        let meta_hex = ann["metadata"].as_str().unwrap_or_default();
        let meta_clean = if meta_hex.starts_with("0x") { &meta_hex[2..] } else { meta_hex };
        let metadata = hex::decode(meta_clean).unwrap_or_default();
        let tx_hash = ann["txHash"].as_str().unwrap_or_default().to_string();
        let block_number = ann["blockNumber"].as_u64().unwrap_or(0);
        announcements.push(RawAnnouncement {
            stealth_address,
            view_tag,
            ephemeral_pubkey,
            metadata,
            tx_hash,
            block_number,
        });
    }

    // Parse schema registry snapshot
    let schemas: Vec<SchemaInfo> = serde_json::from_str(schemas_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid schemas JSON: {}", e)))?;

    // Parse optional trusted issuer allowlist
    let trusted_set: Option<std::collections::HashSet<String>> =
        if trusted_issuers_json.is_empty() || trusted_issuers_json == "[]" {
            None
        } else {
            let list: Vec<String> = serde_json::from_str(trusted_issuers_json)
                .map_err(|e| JsValue::from_str(&format!("Invalid trusted_issuers JSON: {}", e)))?;
            Some(list.into_iter().collect())
        };

    let results = scan_for_attestations_v2(
        &announcements,
        &view_privkey,
        &spend_pubkey,
        &schemas,
        current_slot,
        trusted_set.as_ref(),
    )
    .map_err(|e| JsValue::from_str(&format!("V2 scan error: {}", e)))?;

    serde_json::to_string(&results)
        .map_err(|e| JsValue::from_str(&format!("Serialize error: {}", e)))
}

/// Generates a V2 ZK-circuit witness for a specific schema-bound trait.
///
/// The V2 witness uses the new 5-input leaf:
///   Poseidon(stealth_pk, schema_id, issuer_pk_x, trait_data_hash, nonce)
///
/// # Arguments
/// * `attestations_v2_json` - JSON array of V2StealthAttestation (from scan_attestations_v2_wasm)
/// * `target_schema_id_hex` - The schema_id to prove (64-char hex)
/// * `stealth_privkey_bytes` - 32-byte stealth private key (Uint8Array)
/// * `trait_data_hash_hex` - Poseidon hash of the decoded data fields (64-char hex string)
/// * `external_nullifier` - Action-scoped nonce as decimal string
///
/// # Returns
/// JSON object with all circuit inputs (private + public) for snarkjs.fullProve.
#[wasm_bindgen]
pub fn generate_reputation_witness_v2(
    attestations_v2_json: &str,
    target_schema_id_hex: &str,
    stealth_privkey_bytes: &[u8],
    trait_data_hash_hex: &str,
    external_nullifier: &str,
) -> Result<String, JsValue> {
    let attestations: Vec<V2StealthAttestation> = serde_json::from_str(attestations_v2_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid attestations JSON: {}", e)))?;

    let target_id = target_schema_id_hex.trim_start_matches("0x").to_lowercase();

    // Find the first attestation matching the target schema
    let target_att = attestations
        .iter()
        .find(|a| a.schema_id.trim_start_matches("0x").to_lowercase() == target_id)
        .ok_or_else(|| JsValue::from_str("No attestation found for target schema_id"))?;

    if stealth_privkey_bytes.len() != 32 {
        return Err(JsValue::from_str("Stealth private key must be 32 bytes"));
    }

    // Encode private key as hex field string for the circuit
    let privkey_hex: String = stealth_privkey_bytes
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    let stealth_pk_field = format!("0x{}", privkey_hex);

    let stealth_pk_bytes = field_string_to_bytes(&stealth_pk_field)
        .map_err(|e| JsValue::from_str(&e))?;
    let trait_data_hash_bytes = field_string_to_bytes(trait_data_hash_hex)
        .map_err(|e| JsValue::from_str(&e))?;

    // Build Merkle tree from the same V2 leaf preimage used by the circuit.
    let mut tree = MerkleTree::new(20);
    let mut target_leaf_idx: Option<usize> = None;

    for att in &attestations {
        let schema_id = field_string_to_bytes(&att.merkle_leaf_preimage.schema_id_field)
            .map_err(|e| JsValue::from_str(&e))?;
        let issuer_pk_x = field_string_to_bytes(&att.merkle_leaf_preimage.issuer_pk_x)
            .map_err(|e| JsValue::from_str(&e))?;
        let nonce = field_string_to_bytes(&att.merkle_leaf_preimage.nonce_field)
            .map_err(|e| JsValue::from_str(&e))?;
        let leaf_trait_data_hash = if att.attestation_uid == target_att.attestation_uid {
            trait_data_hash_bytes
        } else {
            field_string_to_bytes(&att.merkle_leaf_preimage.trait_data_hash)
                .map_err(|e| JsValue::from_str(&e))?
        };
        let idx = tree.insert_v2_leaf(
            stealth_pk_bytes,
            schema_id,
            issuer_pk_x,
            leaf_trait_data_hash,
            nonce,
        );
        if att.attestation_uid == target_att.attestation_uid && target_leaf_idx.is_none() {
            target_leaf_idx = Some(idx);
        }
    }

    let leaf_idx = target_leaf_idx
        .ok_or_else(|| JsValue::from_str("Failed to locate target attestation in Merkle tree"))?;

    let proof = tree.proof(leaf_idx);

    // Build the V2 circuit witness JSON (matches circuit signal names exactly)
    let witness = serde_json::json!({
        // Private inputs
        "stealth_pk": stealth_pk_field,
        "schema_id": target_att.merkle_leaf_preimage.schema_id_field,
        "issuer_pk_x": target_att.merkle_leaf_preimage.issuer_pk_x,
        "trait_data_hash": format!("0x{}", trait_data_hash_hex.trim_start_matches("0x")),
        "nonce": target_att.merkle_leaf_preimage.nonce_field,
        "merkle_path": proof.path_elements.iter().map(|e| bytes_to_decimal_string(e)).collect::<Vec<_>>(),
        "merkle_path_indices": proof.path_indices,
        // Public inputs
        "merkle_root": bytes_to_decimal_string(&proof.root),
        "attestation_id": target_att.merkle_leaf_preimage.schema_id_field,
        "external_nullifier": external_nullifier,
        // nullifier_hash must match Poseidon(stealth_pk, external_nullifier).
        "nullifier_hash": "__COMPUTE_IN_BROWSER__"
    });

    serde_json::to_string(&witness)
        .map_err(|e| JsValue::from_str(&format!("Serialize witness error: {}", e)))
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn parse_hex32(hex: &str) -> Result<[u8; 32], JsValue> {
    let clean = hex.trim_start_matches("0x");
    let bytes = hex::decode(clean)
        .map_err(|e| JsValue::from_str(&format!("Invalid hex: {}", e)))?;
    if bytes.len() != 32 {
        return Err(JsValue::from_str("Expected exactly 32 bytes"));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

fn bytes_to_decimal_string(bytes: &[u8; 32]) -> String {
    let mut val = [0u64; 4];
    for i in 0..4 {
        let offset = i * 8;
        for j in 0..8 {
            val[3 - i] = (val[3 - i] << 8) | bytes[offset + j] as u64;
        }
    }
    // Simple big-endian to decimal: treat as u256
    let mut hex_str = String::with_capacity(64);
    for b in bytes {
        hex_str.push_str(&format!("{:02x}", b));
    }
    // Convert hex to decimal string using u128 pairs
    let hex_str = hex_str.trim_start_matches('0');
    if hex_str.is_empty() {
        return "0".to_string();
    }
    // For field elements, use the hex representation as-is for the circuit
    // (circom accepts both hex and decimal)
    format!("0x{}", bytes.iter().map(|b| format!("{:02x}", b)).collect::<String>())
}

#[cfg(test)]
mod pubkey_validation_tests {
    use super::parse_compressed_pubkey;

    // secp256k1 generator point in compressed form (prefix 0x02 = even Y).
    const GENERATOR_COMPRESSED: [u8; 33] = [
        0x02, 0x79, 0xBE, 0x66, 0x7E, 0xF9, 0xDC, 0xBB, 0xAC, 0x55, 0xA0, 0x62, 0x95, 0xCE, 0x87,
        0x0B, 0x07, 0x02, 0x9B, 0xFC, 0xDB, 0x2D, 0xCE, 0x28, 0xD9, 0x59, 0xF2, 0x81, 0x5B, 0x16,
        0xF8, 0x17, 0x98,
    ];

    #[test]
    fn accepts_valid_compressed_key() {
        assert!(parse_compressed_pubkey(&GENERATOR_COMPRESSED).is_ok());
    }

    #[test]
    fn rejects_uncompressed_prefix() {
        // 0x04 is the uncompressed-point marker — invalid for a 33-byte buffer.
        let mut key = GENERATOR_COMPRESSED;
        key[0] = 0x04;
        assert!(parse_compressed_pubkey(&key).is_err());
    }

    #[test]
    fn rejects_unknown_prefix() {
        let mut key = GENERATOR_COMPRESSED;
        key[0] = 0x00;
        assert!(parse_compressed_pubkey(&key).is_err());
    }

    #[test]
    fn rejects_invalid_point_bytes() {
        // Valid compressed prefix (0x02) but an x-coordinate (all 0xFF) that is
        // not a canonical point on the curve — must be rejected, not skipped silently.
        let mut key = [0xFFu8; 33];
        key[0] = 0x02;
        assert!(parse_compressed_pubkey(&key).is_err());
    }

    #[test]
    fn rejects_wrong_length() {
        assert!(parse_compressed_pubkey(&GENERATOR_COMPRESSED[..32]).is_err());
    }
}
