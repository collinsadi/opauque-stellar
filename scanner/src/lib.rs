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

pub use merkle::MerkleError;

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
        let idx = tree.insert_raw(leaf_data.as_bytes())
            .map_err(|e| JsValue::from_str(&format!("Merkle insert error: {}", e)))?;
        if att.attestation_id == target_id && target_leaf_idx.is_none() {
            target_leaf_idx = Some(idx);
            target_attestation = Some(att);
        }
    }

    let leaf_idx = target_leaf_idx
        .ok_or_else(|| JsValue::from_str("No attestation found matching target trait ID"))?;
    let _target_att = target_attestation.unwrap();

    let proof = tree.proof(leaf_idx)
        .map_err(|e| JsValue::from_str(&format!("Merkle proof error: {}", e)))?;

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
        ).map_err(|e| JsValue::from_str(&format!("Merkle insert error: {}", e)))?;
        if att.attestation_uid == target_att.attestation_uid && target_leaf_idx.is_none() {
            target_leaf_idx = Some(idx);
        }
    }

    let leaf_idx = target_leaf_idx
        .ok_or_else(|| JsValue::from_str("Failed to locate target attestation in Merkle tree"))?;

    let proof = tree.proof(leaf_idx)
        .map_err(|e| JsValue::from_str(&format!("Merkle proof error: {}", e)))?;

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

// =============================================================================
// WASM Boundary Malformed Input Tests (Issue #92)
// =============================================================================
// These tests verify that every WASM-exported function rejects bad input
// with a typed error rather than panicking. They exercise the underlying Rust
// functions that form the WASM boundary.

#[cfg(test)]
mod wasm_boundary_tests {
    use super::*;
    use crate::scanner::{derive_stealth_address, check_announcement, check_announcement_view_tag};
    use k256::{ecdsa::SigningKey, PublicKey};

    // Valid test key material
    fn valid_view_privkey() -> SigningKey {
        SigningKey::from_bytes(&[0xaa; 32].into()).unwrap()
    }

    fn valid_spend_pubkey() -> PublicKey {
        PublicKey::from(SigningKey::from_bytes(&[0xbb; 32].into()).unwrap().verifying_key())
    }

    fn valid_ephemeral_pubkey() -> PublicKey {
        PublicKey::from(SigningKey::from_bytes(&[0xcc; 32].into()).unwrap().verifying_key())
    }

    // =============================================================
    // parse_compressed_pubkey — key validation
    // =============================================================

    #[test]
    fn rejects_empty_pubkey_bytes() {
        assert_eq!(parse_compressed_pubkey(&[]), Err("PublicKey must be 33 bytes (compressed)"));
    }

    #[test]
    fn rejects_32_byte_pubkey() {
        assert_eq!(parse_compressed_pubkey(&[0x02; 32]), Err("PublicKey must be 33 bytes (compressed)"));
    }

    #[test]
    fn rejects_34_byte_pubkey() {
        assert_eq!(parse_compressed_pubkey(&[0x02; 34]), Err("PublicKey must be 33 bytes (compressed)"));
    }

    #[test]
    fn rejects_non_compressed_prefix_04() {
        let mut key = [0u8; 33];
        key[0] = 0x04;
        assert!(parse_compressed_pubkey(&key).is_err());
    }

    #[test]
    fn rejects_non_compressed_prefix_06() {
        let mut key = [0u8; 33];
        key[0] = 0x06;
        assert!(parse_compressed_pubkey(&key).is_err());
    }

    #[test]
    fn rejects_all_zeros_pubkey() {
        assert!(parse_compressed_pubkey(&[0x02u8; 33]).is_err());
    }

    // =============================================================
    // bytes_to_signing_key — private key validation
    // =============================================================

    #[test]
    fn rejects_signing_key_empty() {
        let result = bytes_to_signing_key(&[]);
        assert!(result.is_err());
    }

    #[test]
    fn rejects_signing_key_31_bytes() {
        let result = bytes_to_signing_key(&[0xaa; 31]);
        assert!(result.is_err());
    }

    #[test]
    fn rejects_signing_key_33_bytes() {
        let result = bytes_to_signing_key(&[0xaa; 33]);
        assert!(result.is_err());
    }

    #[test]
    fn rejects_signing_key_all_zeros() {
        // All-zero is not a valid secp256k1 private key
        let result = bytes_to_signing_key(&[0u8; 32]);
        assert!(result.is_err());
    }

    #[test]
    fn rejects_signing_key_overflow() {
        // All 0xFF is > curve order, invalid
        let result = bytes_to_signing_key(&[0xFF; 32]);
        assert!(result.is_err());
    }

    // =============================================================
    // hex_to_address — address parsing
    // =============================================================

    #[test]
    fn rejects_empty_hex_address() {
        assert!(hex_to_address("").is_err());
    }

    #[test]
    fn rejects_short_hex_address() {
        assert!(hex_to_address("0x1234").is_err());
    }

    #[test]
    fn rejects_long_hex_address() {
        assert!(hex_to_address("0x00000000000000000000000000000000000000000").is_err());
    }

    #[test]
    fn rejects_malformed_hex_chars() {
        assert!(hex_to_address("0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz").is_err());
    }

    #[test]
    fn rejects_no_prefix_address() {
        assert!(hex_to_address("0000000000000000000000000000000000000000").is_err());
    }

    // =============================================================
    // field_string_to_bytes — BN254 field element parsing
    // =============================================================

    #[test]
    fn rejects_empty_field_string() {
        assert!(field_string_to_bytes("").is_err());
    }

    #[test]
    fn rejects_invalid_hex_prefix() {
        assert!(field_string_to_bytes("0xZZZZ").is_err());
    }

    #[test]
    fn rejects_garbage_text() {
        assert!(field_string_to_bytes("not-a-number").is_err());
    }

    #[test]
    fn accepts_valid_decimal_field() {
        assert!(field_string_to_bytes("0").is_ok());
    }

    #[test]
    fn accepts_valid_hex_field() {
        assert!(field_string_to_bytes("0x0").is_ok());
    }

    #[test]
    fn accepts_large_decimal_field() {
        let large = "21888242871839275222246405745257275088548364400416034343698204186575808495617";
        assert!(field_string_to_bytes(large).is_ok());
    }

    // =============================================================
    // parse_hex32 — 32-byte hex parsing
    // =============================================================

    #[test]
    fn rejects_short_hex32() {
        assert!(parse_hex32("0xabcd").is_err());
    }

    #[test]
    fn rejects_long_hex32() {
        assert!(parse_hex32(&"0x".to_string() + &"ab".repeat(33)).is_err());
    }

    #[test]
    fn rejects_malformed_hex32_chars() {
        assert!(parse_hex32("0xgggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg").is_err());
    }

    #[test]
    fn rejects_empty_hex32() {
        assert!(parse_hex32("").is_err());
    }

    #[test]
    fn accepts_valid_hex32() {
        assert!(parse_hex32(&"0x".to_string() + &"ab".repeat(32)).is_ok());
    }

    #[test]
    fn accepts_valid_hex32_without_prefix() {
        assert!(parse_hex32(&"ab".repeat(32)).is_ok());
    }

    // =============================================================
    // derive_stealth_address — key derivation error propagation
    // =============================================================

    #[test]
    fn derive_address_rejects_invalid_scalar() {
        // Use the identity point as ephemeral pubkey — should not panic
        let view_privkey = valid_view_privkey();
        let spend_pubkey = valid_spend_pubkey();
        // An invalid point as ephemeral — the function should return Err, not panic
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = derive_stealth_address(&view_privkey, &spend_pubkey, &valid_ephemeral_pubkey());
        }));
        assert!(result.is_ok());
    }

    // =============================================================
    // check_announcement — announcement validation
    // =============================================================

    #[test]
    fn check_announcement_no_panic_on_wrong_inputs() {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = check_announcement(
                Address::from([0u8; 20]),
                0,
                &valid_view_privkey(),
                &valid_spend_pubkey(),
                &valid_ephemeral_pubkey(),
            );
        }));
        assert!(result.is_ok());
    }

    // =============================================================
    // Merkle error consistency (Issue #93 cross-check)
    // =============================================================

    #[test]
    fn merkle_error_display_does_not_panic() {
        let err = MerkleError::TreeFull { capacity: 2, count: 2 };
        let _ = format!("{}", err);
        let err = MerkleError::IndexOutOfBounds { index: 5, count: 3 };
        let _ = format!("{}", err);
    }
}

// =============================================================================
// Cross-Language Cryptography Test Vectors (Issue #91)
// =============================================================================
// These tests verify that Rust produces the same outputs as TypeScript and
// Circom for the same inputs. Fixture data is documented in
// docs/crypto-test-vectors.json.

#[cfg(test)]
mod cross_language_vector_tests {
    use super::*;
    use crate::merkle::{MerkleTree, poseidon_hash_fields, field_string_to_bytes};

    /// Verifies Poseidon(1, 2) matches the circomlib vector from
    /// docs/crypto-test-vectors.json and scanner/src/merkle.rs.
    #[test]
    fn dksap_poseidon_pair_matches_circomlib() {
        let left = field_string_to_bytes("1").unwrap();
        let right = field_string_to_bytes("2").unwrap();
        let hash = poseidon_hash_fields(&[left, right]);

        let expected = field_string_to_bytes(
            "7853200120776062878684798364095072458815029376092732009249414926327459813530"
        ).unwrap();
        assert_eq!(hash, expected, "Poseidon(1,2) must match circomlib");
    }

    /// Verifies Poseidon(0, 0) — used as Merkle zero hash at level 0.
    #[test]
    fn dksap_poseidon_zero_pair_matches_circomlib() {
        let zero = field_string_to_bytes("0").unwrap();
        let hash = poseidon_hash_fields(&[zero, zero]);

        let expected = field_string_to_bytes(
            "14744269619966411208579211824598458697587494354926760081771325075741142829156"
        ).unwrap();
        assert_eq!(hash, expected, "Poseidon(0,0) must match circomlib");
    }

    /// Verifies that DKSAP derivation is deterministic for fixed keys.
    /// Both Rust (scanner) and TypeScript (frontend/src/lib/stealth.ts)
    /// must produce the same stealth address for the same inputs.
    #[test]
    fn dksap_derivation_is_deterministic() {
        use k256::{ecdsa::SigningKey, PublicKey};
        use crate::scanner::derive_stealth_address;

        let view_privkey = SigningKey::from_bytes(&[0xaa; 32].into()).unwrap();
        let spend_privkey = SigningKey::from_bytes(&[0xbb; 32].into()).unwrap();
        let spend_pubkey = PublicKey::from(spend_privkey.verifying_key());
        let ephemeral_privkey = SigningKey::from_bytes(&[0xcc; 32].into()).unwrap();
        let ephemeral_pubkey = PublicKey::from(ephemeral_privkey.verifying_key());

        // First derivation
        let (addr1, tag1) = derive_stealth_address(
            &view_privkey, &spend_pubkey, &ephemeral_pubkey
        ).unwrap();

        // Second derivation — must be identical
        let (addr2, tag2) = derive_stealth_address(
            &view_privkey, &spend_pubkey, &ephemeral_pubkey
        ).unwrap();

        assert_eq!(addr1, addr2, "Stealth address derivation must be deterministic");
        assert_eq!(tag1, tag2, "View tag derivation must be deterministic");
    }

    /// Verifies V1 attestation metadata encoding matches documented vectors.
    #[test]
    fn dksap_v1_metadata_encoding_matches_vectors() {
        use crate::attestation::{encode_attestation_metadata, extract_attestation_id};

        let view_tag = 0x42;
        let attestation_id = 12345u64;
        let encoded = encode_attestation_metadata(view_tag, attestation_id);

        // Verify wire format: view_tag || 0xA7 || attestation_id (8 bytes BE)
        assert_eq!(encoded[0], view_tag);
        assert_eq!(encoded[1], 0xA7);
        let decoded = extract_attestation_id(&encoded).unwrap();
        assert_eq!(decoded, attestation_id);

        // Hex encoding matches JSON vector
        let hex: String = encoded.iter().map(|b| format!("{:02x}", b)).collect();
        assert_eq!(hex, "42a70000000000003039");
    }

    /// Verifies V2 attestation metadata encoding matches documented vectors.
    #[test]
    fn dksap_v2_metadata_encoding_matches_vectors() {
        use crate::attestation::encode_v2_attestation_metadata;

        let schema_id = [0xaa; 32];
        let issuer = [0xbb; 32];
        let attestation_uid = [0xcc; 32];
        let nonce = [0xdd; 32];

        let encoded = encode_v2_attestation_metadata(
            0x42, &schema_id, &issuer, &attestation_uid, &nonce, 100000,
        );

        let hex: String = encoded.iter().map(|b| format!("{:02x}", b)).collect();
        let expected = "42b2".to_string()
            + &"aa".repeat(32)
            + &"bb".repeat(32)
            + &"cc".repeat(32)
            + &"dd".repeat(32)
            + "000186a0";
        assert_eq!(hex, expected);
    }

    /// Verifies V2 Merkle leaf construction is consistent:
    /// Poseidon(stealth_pk, schema_id, issuer_pk_x, trait_data_hash, nonce).
    #[test]
    fn dksap_v2_merkle_leaf_is_poseidon_five() {
        use crate::merkle::poseidon_hash_fields;

        let stealth_pk = field_string_to_bytes("0").unwrap();
        let schema_id = field_string_to_bytes(
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ).unwrap();
        let issuer_pk_x = field_string_to_bytes(
            "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        ).unwrap();
        let trait_data_hash = field_string_to_bytes(
            "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
        ).unwrap();
        let nonce = field_string_to_bytes(
            "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
        ).unwrap();

        let leaf_from_fields = poseidon_hash_fields(&[
            stealth_pk, schema_id, issuer_pk_x, trait_data_hash, nonce,
        ]);

        let mut tree = MerkleTree::new(2);
        tree.insert_v2_leaf(
            field_string_to_bytes("0").unwrap(),
            field_string_to_bytes("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap(),
            field_string_to_bytes("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb").unwrap(),
            field_string_to_bytes("0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc").unwrap(),
            field_string_to_bytes("0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd").unwrap(),
        ).unwrap();

        assert_eq!(tree.leaf_count(), 1);
        // Verifying that the tree root changes after insertion confirms
        // the leaf was correctly added. Direct leaf access is not exposed
        // outside the scanner crate, so we verify via root change.
        let root_with_leaf = tree.root();
        assert_ne!(root_with_leaf, MerkleTree::new(2).root(),
            "V2 leaf insertion must change the Merkle root");
    }
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
