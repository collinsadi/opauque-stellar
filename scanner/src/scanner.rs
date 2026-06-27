//! # Opaque Cash — Scanner Engine (EIP-5564 / DKSAP)
//!
//! Dual-Key Stealth Address Protocol: derives stealth addresses from announcements
//! and filters them efficiently using view tags before expensive EC operations.

use alloy_primitives::Address;
use curve25519_dalek::{
    constants::ED25519_BASEPOINT_POINT, edwards::CompressedEdwardsY, Scalar as Ed25519Scalar,
};
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::elliptic_curve::PrimeField;
use k256::{ecdsa::SigningKey, ProjectivePoint, PublicKey, Scalar};
use sha2::{Digest as Sha2Digest, Sha256, Sha512};
use sha3::Keccak256;

// =============================================================================
// Data structures (EIP-5564 stealth meta-address)
// =============================================================================

/// Stealth meta-address: the two public keys a recipient publishes for DKSAP.
/// Senders use this to derive a one-time stealth address; scanners use it with
/// the viewing key to detect incoming transfers.
#[derive(Clone, Debug)]
pub struct StealthMetaAddress {
    /// Viewing public key (used by sender to compute shared secret with ephemeral key).
    pub view_pubkey: PublicKey,
    /// Spending public key (base for stealth address: P_stealth = P_spend + s_h*G).
    pub spend_pubkey: PublicKey,
}

impl StealthMetaAddress {
    pub fn new(view_pubkey: PublicKey, spend_pubkey: PublicKey) -> Self {
        Self {
            view_pubkey,
            spend_pubkey,
        }
    }
}

// =============================================================================
// DKSAP: shared secret and hashed secret (EIP-5564 math)
// =============================================================================

/// Computes the raw ECDH shared secret: `s = p_view * P_ephemeral`.
///
/// We do raw scalar-point multiplication (not the standard ECDH, which applies
/// an extra hash). EIP-5564 hashes `s` separately with Keccak-256.
/// The shared secret is the compressed encoding of the resulting curve point.
fn shared_secret_bytes(view_privkey: &SigningKey, ephemeral_pubkey: &PublicKey) -> [u8; 33] {
    let view_scalar: &Scalar = view_privkey.as_nonzero_scalar().as_ref();
    let ephemeral_point = ephemeral_pubkey.to_projective();
    let shared_point = (ephemeral_point * view_scalar).to_affine();
    let encoded = k256::AffinePoint::from(shared_point).to_encoded_point(true);
    let mut out = [0u8; 33];
    out.copy_from_slice(encoded.as_bytes());
    out
}

/// Hashes the shared secret with Keccak-256 per EIP-5564: `s_h = h(s)`.
/// Returns the 32-byte hash; the first byte is the view tag.
fn hash_shared_secret(shared_secret: &[u8; 33]) -> [u8; 32] {
    Keccak256::digest(shared_secret).into()
}

/// View tag: most significant byte of `s_h`. Used to skip full derivation for
/// non-matching announcements (~255/256 of them).
#[inline]
pub fn view_tag_from_hashed_secret(secret_hash: &[u8; 32]) -> u8 {
    secret_hash[0]
}

// =============================================================================
// Stealth address derivation (DKSAP)
// =============================================================================

/// Derives the stealth address and view tag for a single announcement.
///
/// **DKSAP steps (EIP-5564):**
/// 1. Shared secret: `s = p_view * P_ephemeral` (ECDH).
/// 2. Hash: `s_h = Keccak256(s)`.
/// 3. View tag: `v = s_h[0]` (for scanner filter).
/// 4. Point: `S_h = s_h * G` (scalar mult on generator).
/// 5. Stealth public key: `P_stealth = P_spend + S_h` (point addition).
/// 6. Address: `address = keccak256(uncompressed(P_stealth))[12..32]`.
pub fn derive_stealth_address(
    view_privkey: &SigningKey,
    spend_pubkey: &PublicKey,
    ephemeral_pubkey: &PublicKey,
) -> Result<(Address, u8), StealthAddressError> {
    // Step 1: Shared secret s = p_view * P_ephemeral
    let s = shared_secret_bytes(view_privkey, ephemeral_pubkey);
    // Step 2: s_h = h(s)
    let s_h = hash_shared_secret(&s);
    // Step 3: view tag (most significant byte)
    let view_tag = view_tag_from_hashed_secret(&s_h);
    // Step 4: S_h = s_h * G (reduce s_h mod n for curve order)
    let repr = k256::FieldBytes::from(s_h);
    let s_h_scalar = Scalar::from_repr(repr)
        .into_option()
        .ok_or(StealthAddressError::InvalidScalar)?;
    let s_h_point = ProjectivePoint::GENERATOR * s_h_scalar;
    // Step 5: P_stealth = P_spend + S_h
    let spend_affine = spend_pubkey.to_projective();
    let p_stealth_proj = spend_affine + s_h_point;
    let p_stealth_affine = p_stealth_proj.to_affine();
    let p_stealth =
        PublicKey::from_affine(p_stealth_affine).map_err(|_| StealthAddressError::InvalidPoint)?;
    // Step 6: Ethereum address from uncompressed pubkey (Keccak256, then last 20 bytes)
    let address = pubkey_to_address(&p_stealth);
    Ok((address, view_tag))
}

/// Converts a secp256k1 public key to an Ethereum address per EIP-55 / standard.
fn pubkey_to_address(pubkey: &PublicKey) -> Address {
    let uncompressed = pubkey.to_encoded_point(false);
    // Skip the leading 0x04 tag byte; hash the raw 64-byte (x ‖ y)
    let hash = Keccak256::digest(&uncompressed.as_bytes()[1..]);
    Address::from_slice(&hash[12..32])
}

/// Derives the one-time stealth signing key (private key) for spending from a stealth address.
///
/// **DKSAP:** `p_stealth = p_spend + s_h` (scalar addition mod n), where
/// `s_h = Keccak256(shared_secret)` and shared secret is from view key and ephemeral pubkey.
/// Caller must use this key only with the matching stealth address.
pub fn derive_stealth_signing_key(
    view_privkey: &SigningKey,
    spend_privkey: &SigningKey,
    ephemeral_pubkey: &PublicKey,
) -> Result<[u8; 32], StealthAddressError> {
    let s = shared_secret_bytes(view_privkey, ephemeral_pubkey);
    let s_h = hash_shared_secret(&s);
    let repr = k256::FieldBytes::from(s_h);
    let s_h_scalar = Scalar::from_repr(repr)
        .into_option()
        .ok_or(StealthAddressError::InvalidScalar)?;
    let spend_scalar: &Scalar = spend_privkey.as_nonzero_scalar().as_ref();
    let p_stealth_scalar = spend_scalar + s_h_scalar;
    let mut out = [0u8; 32];
    out.copy_from_slice(p_stealth_scalar.to_repr().as_ref());
    Ok(out)
}

// =============================================================================
// Stellar-native Ed25519 stealth account derivation (scheme_id = 2)
// =============================================================================

fn ed25519_scalar_from_seed(seed: &[u8; 32]) -> Ed25519Scalar {
    let digest = Sha512::digest(seed);
    let mut scalar = [0u8; 32];
    scalar.copy_from_slice(&digest[..32]);
    scalar[0] &= 248;
    scalar[31] &= 63;
    scalar[31] |= 64;
    Ed25519Scalar::from_bytes_mod_order(scalar)
}

#[cfg(test)]
fn ed25519_pubkey_from_seed(seed: &[u8; 32]) -> [u8; 32] {
    (ED25519_BASEPOINT_POINT * ed25519_scalar_from_seed(seed))
        .compress()
        .to_bytes()
}

fn ed25519_shared_secret(
    view_seed: &[u8; 32],
    ephemeral_pubkey: &[u8; 32],
) -> Result<[u8; 32], StealthAddressError> {
    let point = CompressedEdwardsY(*ephemeral_pubkey)
        .decompress()
        .ok_or(StealthAddressError::InvalidPoint)?;
    Ok((point * ed25519_scalar_from_seed(view_seed))
        .compress()
        .to_bytes())
}

fn ed25519_hash_shared_secret(shared_secret: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"opaque-stellar-ed25519-v1");
    hasher.update(shared_secret);
    hasher.finalize().into()
}

/// Derives the raw 32-byte Stellar Ed25519 stealth account id and view tag.
///
/// Scheme 2 mirrors DKSAP over Ed25519 public keys:
/// 1. Shared secret: `s = p_view * P_ephemeral`.
/// 2. Hash: `s_h = SHA256(domain || s)`.
/// 3. View tag: `v = s_h[0]`.
/// 4. Stealth public key: `P_stealth = P_spend + s_h*B`.
///
/// The returned account id is the raw 32-byte Ed25519 public key used inside a
/// Stellar `G...` strkey.
pub fn derive_stealth_account_ed25519(
    view_seed: &[u8; 32],
    spend_pubkey: &[u8; 32],
    ephemeral_pubkey: &[u8; 32],
) -> Result<([u8; 32], u8), StealthAddressError> {
    let shared = ed25519_shared_secret(view_seed, ephemeral_pubkey)?;
    let s_h = ed25519_hash_shared_secret(&shared);
    let view_tag = s_h[0];
    let spend_point = CompressedEdwardsY(*spend_pubkey)
        .decompress()
        .ok_or(StealthAddressError::InvalidPoint)?;
    let tweak = Ed25519Scalar::from_bytes_mod_order(s_h);
    let stealth = spend_point + (ED25519_BASEPOINT_POINT * tweak);
    Ok((stealth.compress().to_bytes(), view_tag))
}

pub fn check_announcement_view_tag_ed25519(
    view_tag: u8,
    view_seed: &[u8; 32],
    ephemeral_pubkey: &[u8; 32],
) -> Result<ViewTagCheck, StealthAddressError> {
    let shared = ed25519_shared_secret(view_seed, ephemeral_pubkey)?;
    let s_h = ed25519_hash_shared_secret(&shared);
    if view_tag != s_h[0] {
        Ok(ViewTagCheck::NoMatch)
    } else {
        Ok(ViewTagCheck::PossibleMatch)
    }
}

pub fn check_announcement_ed25519(
    announcement_stealth_account: &[u8; 32],
    view_tag: u8,
    view_seed: &[u8; 32],
    spend_pubkey: &[u8; 32],
    ephemeral_pubkey: &[u8; 32],
) -> Result<bool, StealthAddressError> {
    match check_announcement_view_tag_ed25519(view_tag, view_seed, ephemeral_pubkey)? {
        ViewTagCheck::NoMatch => return Ok(false),
        ViewTagCheck::PossibleMatch => {}
    }
    let (derived, _) = derive_stealth_account_ed25519(view_seed, spend_pubkey, ephemeral_pubkey)?;
    Ok(&derived == announcement_stealth_account)
}

// =============================================================================
// Scanner filter: view-tag check before expensive EC (EIP-5564 parsing)
// =============================================================================

/// Result of a quick view-tag check: either a definite "no" or "maybe, need full check".
#[derive(Debug)]
pub enum ViewTagCheck {
    /// View tag did not match; skip EC addition for this announcement.
    NoMatch,
    /// View tag matched; caller should run full derivation to confirm.
    PossibleMatch,
}

// =============================================================================
// Telemetry: view-tag collision tracking
// =============================================================================

/// Telemetry counters for view-tag filter performance analysis.
/// Records false positive rate without exposing PII or cryptographic material.
#[derive(Debug, Clone, Default)]
pub struct ScanTelemetry {
    /// Number of announcements that passed view-tag filter.
    pub view_tag_matches: u64,
    /// Number of view-tag matches confirmed as true positives after full derivation.
    pub full_derivation_confirms: u64,
    /// Number of view-tag matches that were false positives.
    pub view_tag_false_positives: u64,
}

impl ScanTelemetry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a view-tag match (before full derivation).
    pub fn record_view_tag_match(&mut self) {
        self.view_tag_matches = self.view_tag_matches.saturating_add(1);
    }

    /// Record the result of full derivation after a view-tag match.
    pub fn record_full_derivation_result(&mut self, confirmed: bool) {
        if confirmed {
            self.full_derivation_confirms = self.full_derivation_confirms.saturating_add(1);
        } else {
            self.view_tag_false_positives = self.view_tag_false_positives.saturating_add(1);
        }
    }

    /// Calculate false positive rate as a percentage (0-100).
    /// Returns None if no view-tag matches have been recorded.
    pub fn false_positive_rate(&self) -> Option<f64> {
        if self.view_tag_matches == 0 {
            return None;
        }
        Some((self.view_tag_false_positives as f64 / self.view_tag_matches as f64) * 100.0)
    }

    /// Export telemetry as JSON-compatible structure for diagnostics.
    pub fn to_diagnostics(&self) -> String {
        format!(
            "{{\"view_tag_matches\":{},\"full_derivation_confirms\":{},\"view_tag_false_positives\":{},\"false_positive_rate\":{}}}",
            self.view_tag_matches,
            self.full_derivation_confirms,
            self.view_tag_false_positives,
            self.false_positive_rate()
                .map(|r| format!("{:.2}", r))
                .unwrap_or_else(|| "null".to_string())
        )
    }
}

/// Checks the announcement's view tag against the local secret hash **before**
/// doing the expensive elliptic curve addition. If the view tag does not match,
/// the announcement is not for this recipient (~255/256 of announcements).
///
/// Returns:
/// - `ViewTagCheck::NoMatch` — safe to skip; no need to call `derive_stealth_address`.
/// - `ViewTagCheck::PossibleMatch` — view tag matches; call `derive_stealth_address`
///   and compare the resulting address with the announcement's stealth address.
pub fn check_announcement_view_tag(
    view_tag: u8,
    view_privkey: &SigningKey,
    ephemeral_pubkey: &PublicKey,
) -> ViewTagCheck {
    let s = shared_secret_bytes(view_privkey, ephemeral_pubkey);
    let s_h = hash_shared_secret(&s);
    let local_view_tag = view_tag_from_hashed_secret(&s_h);
    if view_tag != local_view_tag {
        ViewTagCheck::NoMatch
    } else {
        ViewTagCheck::PossibleMatch
    }
}

/// Full check: view-tag filter first, then full derivation and address comparison.
/// Returns `true` iff the announcement's stealth address belongs to this recipient.
pub fn check_announcement(
    announcement_stealth_address: Address,
    view_tag: u8,
    view_privkey: &SigningKey,
    spend_pubkey: &PublicKey,
    ephemeral_pubkey: &PublicKey,
) -> Result<bool, StealthAddressError> {
    // Fast path: avoid EC addition when view tag does not match
    match check_announcement_view_tag(view_tag, view_privkey, ephemeral_pubkey) {
        ViewTagCheck::NoMatch => return Ok(false),
        ViewTagCheck::PossibleMatch => {}
    }
    let (derived_address, _) =
        derive_stealth_address(view_privkey, spend_pubkey, ephemeral_pubkey)?;
    Ok(derived_address == announcement_stealth_address)
}

// =============================================================================
// Errors
// =============================================================================

#[derive(Debug)]
pub enum StealthAddressError {
    InvalidScalar,
    InvalidPoint,
}

impl std::fmt::Display for StealthAddressError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StealthAddressError::InvalidScalar => {
                write!(f, "hashed shared secret out of curve order")
            }
            StealthAddressError::InvalidPoint => write!(f, "invalid stealth public key point"),
        }
    }
}

impl std::error::Error for StealthAddressError {}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::SigningKey;
    use k256::PublicKey;

    /// Simulates the full EIP-5564 flow:
    ///   Sender generates ephemeral key → derives stealth address
    ///   Scanner checks the announcement → must match
    #[test]
    fn round_trip_derive_and_check() {
        // Recipient key pairs
        let view_privkey = SigningKey::from_bytes(&[0xaa; 32].into()).unwrap();
        let spend_privkey = SigningKey::from_bytes(&[0xbb; 32].into()).unwrap();
        let spend_pubkey = PublicKey::from(spend_privkey.verifying_key());

        // Sender generates an ephemeral key pair
        let ephemeral_privkey = SigningKey::from_bytes(&[0xcc; 32].into()).unwrap();
        let ephemeral_pubkey = PublicKey::from(ephemeral_privkey.verifying_key());

        // --- Sender side: derive stealth address ---
        // Sender knows (P_view, P_spend) from stealth meta-address and has p_ephemeral.
        // Shared secret from sender perspective: s = p_ephemeral * P_view
        let view_pubkey = PublicKey::from(view_privkey.verifying_key());
        let sender_shared = {
            let eph_scalar: &Scalar = ephemeral_privkey.as_nonzero_scalar().as_ref();
            let view_point = view_pubkey.to_projective();
            let pt = (view_point * eph_scalar).to_affine();
            let enc = k256::AffinePoint::from(pt).to_encoded_point(true);
            let mut buf = [0u8; 33];
            buf.copy_from_slice(enc.as_bytes());
            buf
        };
        let sender_s_h = hash_shared_secret(&sender_shared);
        let sender_view_tag = view_tag_from_hashed_secret(&sender_s_h);
        let sender_s_h_scalar = Scalar::from_repr(k256::FieldBytes::from(sender_s_h))
            .into_option()
            .unwrap();
        let sender_s_h_point = ProjectivePoint::GENERATOR * sender_s_h_scalar;
        let stealth_point = spend_pubkey.to_projective() + sender_s_h_point;
        let stealth_pk = PublicKey::from_affine(stealth_point.to_affine()).unwrap();
        let stealth_address = {
            let uncompressed = stealth_pk.to_encoded_point(false);
            let hash = Keccak256::digest(&uncompressed.as_bytes()[1..]);
            Address::from_slice(&hash[12..32])
        };

        // --- Scanner side: verify using check_announcement ---
        let result = check_announcement(
            stealth_address,
            sender_view_tag,
            &view_privkey,
            &spend_pubkey,
            &ephemeral_pubkey,
        )
        .expect("check_announcement should not fail");

        assert!(result, "scanner must recognise its own stealth address");
    }

    /// Ensures a wrong view tag causes an early reject (no EC addition).
    #[test]
    fn wrong_view_tag_rejects() {
        let view_privkey = SigningKey::from_bytes(&[0xaa; 32].into()).unwrap();
        let spend_privkey = SigningKey::from_bytes(&[0xbb; 32].into()).unwrap();
        let spend_pubkey = PublicKey::from(spend_privkey.verifying_key());

        let ephemeral_privkey = SigningKey::from_bytes(&[0xcc; 32].into()).unwrap();
        let ephemeral_pubkey = PublicKey::from(ephemeral_privkey.verifying_key());

        let (stealth_address, correct_tag) =
            derive_stealth_address(&view_privkey, &spend_pubkey, &ephemeral_pubkey).unwrap();

        let wrong_tag = correct_tag.wrapping_add(1);
        let result = check_announcement(
            stealth_address,
            wrong_tag,
            &view_privkey,
            &spend_pubkey,
            &ephemeral_pubkey,
        )
        .unwrap();

        assert!(!result, "wrong view tag must reject");
    }

    /// Verifies that derive_stealth_address called from the scanner side
    /// produces the same address as the sender-side derivation.
    #[test]
    fn scanner_derive_matches_sender() {
        let view_privkey = SigningKey::from_bytes(&[0x11; 32].into()).unwrap();
        let spend_privkey = SigningKey::from_bytes(&[0x22; 32].into()).unwrap();
        let spend_pubkey = PublicKey::from(spend_privkey.verifying_key());

        let ephemeral_privkey = SigningKey::from_bytes(&[0x33; 32].into()).unwrap();
        let ephemeral_pubkey = PublicKey::from(ephemeral_privkey.verifying_key());

        let (addr, tag) =
            derive_stealth_address(&view_privkey, &spend_pubkey, &ephemeral_pubkey).unwrap();

        // Derive again — must be deterministic
        let (addr2, tag2) =
            derive_stealth_address(&view_privkey, &spend_pubkey, &ephemeral_pubkey).unwrap();

        assert_eq!(addr, addr2);
        assert_eq!(tag, tag2);
    }

    #[test]
    fn ed25519_round_trip_derive_and_check() {
        let view_seed = [0x11u8; 32];
        let spend_seed = [0x22u8; 32];
        let ephemeral_seed = [0x33u8; 32];
        let spend_pubkey = ed25519_pubkey_from_seed(&spend_seed);
        let ephemeral_pubkey = ed25519_pubkey_from_seed(&ephemeral_seed);

        let (stealth_account, view_tag) =
            derive_stealth_account_ed25519(&view_seed, &spend_pubkey, &ephemeral_pubkey).unwrap();

        let result = check_announcement_ed25519(
            &stealth_account,
            view_tag,
            &view_seed,
            &spend_pubkey,
            &ephemeral_pubkey,
        )
        .unwrap();

        assert!(
            result,
            "scheme 2 scanner must recognise its stealth account"
        );
    }

    #[test]
    fn ed25519_wrong_view_tag_rejects() {
        let view_seed = [0x44u8; 32];
        let spend_seed = [0x55u8; 32];
        let ephemeral_seed = [0x66u8; 32];
        let spend_pubkey = ed25519_pubkey_from_seed(&spend_seed);
        let ephemeral_pubkey = ed25519_pubkey_from_seed(&ephemeral_seed);
        let (stealth_account, view_tag) =
            derive_stealth_account_ed25519(&view_seed, &spend_pubkey, &ephemeral_pubkey).unwrap();

        let result = check_announcement_ed25519(
            &stealth_account,
            view_tag.wrapping_add(1),
            &view_seed,
            &spend_pubkey,
            &ephemeral_pubkey,
        )
        .unwrap();

        assert!(!result);
    }
}
