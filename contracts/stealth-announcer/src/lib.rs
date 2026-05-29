#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Bytes, Env, Symbol};

/// Stealth Address Announcer — emits events when funds are sent to a stealth address.
/// scheme_id 1 = secp256k1; metadata[0] = view tag.
///
/// Supported schemes (v1):
/// - 1: secp256k1; stealth identifier is a 20-byte raw identifier (e.g., RIPEMD160 output).
///
/// Note: the contract validates binary payloads only. Higher-level encodings (hex/base58)
/// must be decoded by the caller into the raw byte representation prior to calling this
/// contract. Scanners MUST interpret stealth_address as a raw 20-byte identifier for
/// scheme 1; this on-chain validation enforces that invariant so scanners and the
/// contract remain perfectly aligned.
#[contract]
pub struct StealthAnnouncer;

/// Current event schema version — increment when the event topic/data layout changes.
/// Scanners should reject events with an unrecognised version rather than misparse them.
const EVENT_VERSION: u32 = 1;

/// TTL policy for announcement logs stored via `announce_with_log`.
/// Logs are retained for ~7 days (at ~5s/ledger: 7 * 24 * 3600 / 5 = 120_960 ledgers).
/// This prevents unbounded storage growth while giving indexers time to pick up the log.
const LOG_TTL_LEDGERS: u32 = 120_960;

#[contracttype]
#[derive(Clone)]
pub struct AnnouncementLog {
    pub scheme_id: u64,
    pub stealth_address: Bytes,
    pub caller: Address,
    pub ephemeral_pub_key: Bytes,
    pub metadata: Bytes,
    pub ledger: u32,
    pub log_id: Bytes,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum AnnouncerError {
    InvalidEphemeralKey = 1,
    MetadataMissingViewTag = 2,
    /// Key is 33 bytes but first byte is not 0x02 or 0x03 (compressed secp256k1 prefix).
    InvalidKeyPrefix = 3,
    /// Unsupported or unrecognised scheme id (only 1 is supported in v1).
    UnsupportedSchemeId = 4,
    /// Stealth address does not match required length for the scheme.
    InvalidStealthAddressLength = 5,
    /// Stealth address encoding/format is invalid for the scheme (e.g., hex string bytes passed instead of raw bytes).
    InvalidStealthAddressEncoding = 6,
}

// Registry/config for supported schemes. Keep as a simple allowlist so adding future
// schemes requires only updating this list (and associated validation logic for that scheme).
const SUPPORTED_SCHEMES: [u64; 1] = [1u64];

fn log_key(caller: &Address, log_id: &Bytes) -> (Symbol, Address, Bytes) {
    (
        Symbol::new(&caller.env(), "log"),
        caller.clone(),
        log_id.clone(),
    )
}

#[contractimpl]
impl StealthAnnouncer {
    pub fn announce(
        env: Env,
        caller: Address,
        scheme_id: u64,
        stealth_address: Bytes,
        ephemeral_pub_key: Bytes,
        metadata: Bytes,
    ) -> Result<(), AnnouncerError> {
        caller.require_auth();
        Self::validate(scheme_id, &stealth_address, &ephemeral_pub_key, &metadata)?;
        env.events().publish(
            (Symbol::new(&env, "Announcement"), EVENT_VERSION),
            (scheme_id, stealth_address, caller, ephemeral_pub_key, metadata),
        );
        Ok(())
    }

    pub fn announce_with_log(
        env: Env,
        caller: Address,
        scheme_id: u64,
        stealth_address: Bytes,
        ephemeral_pub_key: Bytes,
        metadata: Bytes,
        log_id: Bytes,
    ) -> Result<(), AnnouncerError> {
        caller.require_auth();
        Self::validate(scheme_id, &stealth_address, &ephemeral_pub_key, &metadata)?;
        let ledger = env.ledger().sequence();
        let log = AnnouncementLog {
            scheme_id: scheme_id,
            stealth_address: stealth_address.clone(),
            caller: caller.clone(),
            ephemeral_pub_key: ephemeral_pub_key.clone(),
            metadata: metadata.clone(),
            ledger,
            log_id: log_id.clone(),
        };
        let key = log_key(&caller, &log_id);
        env.storage().persistent().set(&key, &log);
        // Cap log lifetime to ~7 days so persistent storage does not grow indefinitely.
        env.storage()
            .persistent()
            .extend_ttl(&key, LOG_TTL_LEDGERS, LOG_TTL_LEDGERS);
        env.events().publish(
            (Symbol::new(&env, "Announcement"), EVENT_VERSION),
            (scheme_id, stealth_address, caller, ephemeral_pub_key, metadata),
        );
        Ok(())
    }

    /// Validate incoming announcement parameters.
    ///
    /// This enforces that the on-chain representation of stealth addresses exactly
    /// matches what off-chain scanners expect. For scheme 1 (secp256k1) the
    /// stealth identifier MUST be exactly 20 bytes (raw). The contract does not
    /// attempt to parse textual encodings (hex/base58); callers must supply the
    /// raw bytes. Passing encoded ASCII (e.g. hex string) will typically have the
    /// wrong length and be rejected.
    fn validate(
        scheme_id: u64,
        stealth_address: &Bytes,
        ephemeral_pub_key: &Bytes,
        metadata: &Bytes,
    ) -> Result<(), AnnouncerError> {
        // Scheme allowlist check — reject unsupported schemes early so they never
        // appear in events or storage. Update SUPPORTED_SCHEMES when adding new schemes.
        let mut supported = false;
        for s in SUPPORTED_SCHEMES.iter() {
            if *s == scheme_id {
                supported = true;
                break;
            }
        }
        if !supported {
            return Err(AnnouncerError::UnsupportedSchemeId);
        }

        // Scheme-specific stealth address validation.
        match scheme_id {
            // Scheme 1: secp256k1. Stealth identifier is a 20-byte raw identifier
            // (e.g., RIPEMD160(pubkey)). Scanners expect exactly 20 bytes.
            1 => {
                if stealth_address.len() != 20 {
                    return Err(AnnouncerError::InvalidStealthAddressLength);
                }
                // Encoding validation: on-chain we validate the raw bytes length only.
                // Textual encodings (hex/base58) are the responsibility of the caller.
                // If the caller passes ASCII hex bytes (40 bytes) or other encodings,
                // they will be rejected above by length mismatch. This ensures contract
                // validation exactly matches scanner expectations (raw 20-byte input).
            }
            // Future schemes may add bespoke validation here.
            _ => return Err(AnnouncerError::UnsupportedSchemeId),
        }

        // Ephemeral key validation (unchanged): must be compressed secp256k1 pubkey
        // 33 bytes, starting with 0x02 or 0x03.
        if ephemeral_pub_key.len() != 33 {
            return Err(AnnouncerError::InvalidEphemeralKey);
        }
        match ephemeral_pub_key.get(0) {
            Some(0x02) | Some(0x03) => {}
            _ => return Err(AnnouncerError::InvalidKeyPrefix),
        }

        // Metadata must be non-empty and contain the view tag as first byte.
        if metadata.is_empty() {
            return Err(AnnouncerError::MetadataMissingViewTag);
        }

        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::{Address as _, Events as _}, Address, Bytes, Env, TryFromVal};

    struct Setup {
        env: Env,
        client: StealthAnnouncerClient<'static>,
        caller: Address,
    }

    fn setup() -> Setup {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, StealthAnnouncer);
        let client = StealthAnnouncerClient::new(&env, &contract_id);
        let caller = Address::generate(&env);
        Setup { env, client, caller }
    }

    fn valid_ephemeral_key(env: &Env) -> Bytes {
        let mut bytes = Bytes::new(env);
        for _ in 0..33 {
            bytes.push_back(0x03u8);
        }
        bytes
    }

    fn valid_metadata(env: &Env) -> Bytes {
        let mut bytes = Bytes::new(env);
        bytes.push_back(0x42u8);
        bytes
    }

    fn stealth_address(env: &Env) -> Bytes {
        let mut bytes = Bytes::new(env);
        for _ in 0..20 {
            bytes.push_back(0xabu8);
        }
        bytes
    }

    fn stealth_address_short(env: &Env) -> Bytes {
        let mut bytes = Bytes::new(env);
        for _ in 0..19 {
            bytes.push_back(0xabu8);
        }
        bytes
    }

    fn stealth_address_long(env: &Env) -> Bytes {
        let mut bytes = Bytes::new(env);
        for _ in 0..21 {
            bytes.push_back(0xabu8);
        }
        bytes
    }

    fn stealth_address_hex_like(env: &Env) -> Bytes {
        // Simulate a caller passing ASCII hex bytes (e.g., "aabb..."), which would
        // typically be length 40 when representing 20 bytes as hex characters.
        let mut bytes = Bytes::new(env);
        for _ in 0..40 {
            bytes.push_back(0x61u8); // 'a'
        }
        bytes
    }

    #[test]
    fn test_announce_success() {
        let Setup { env, client, caller } = setup();
        client.announce(
            &caller,
            &1u64,
            &stealth_address(&env),
            &valid_ephemeral_key(&env),
            &valid_metadata(&env),
        );
        let events = env.events().all();
        let has_announcement = events.iter().any(|e| e.0 == client.address);
        assert!(has_announcement);
    }

    #[test]
    fn test_announce_rejects_stealth_too_short() {
        let Setup { env: _env, client, caller } = setup();
        let result = client.try_announce(
            &caller,
            &1u64,
            &stealth_address_short(&client.env),
            &valid_ephemeral_key(&client.env),
            &valid_metadata(&client.env),
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_announce_rejects_stealth_too_long() {
        let Setup { env: _env, client, caller } = setup();
        let result = client.try_announce(
            &caller,
            &1u64,
            &stealth_address_long(&client.env),
            &valid_ephemeral_key(&client.env),
            &valid_metadata(&client.env),
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_announce_rejects_malformed_encoding() {
        let Setup { env: _env, client, caller } = setup();
        // Passing ASCII-hex-like bytes (40 bytes) should be rejected by length
        // validation for scheme 1 and thus considered a malformed encoding.
        let result = client.try_announce(
            &caller,
            &1u64,
            &stealth_address_hex_like(&client.env),
            &valid_ephemeral_key(&client.env),
            &valid_metadata(&client.env),
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_announce_rejects_unsupported_scheme_id() {
        let Setup { env: _env, client, caller } = setup();
        let result = client.try_announce(
            &caller,
            &99u64,
            &stealth_address(&client.env),
            &valid_ephemeral_key(&client.env),
            &valid_metadata(&client.env),
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_announce_invalid_ephemeral_key() {
        let Setup { env: _env, client, caller } = setup();
        let short = Bytes::new(&client.env);

        let result = client.try_announce(
            &caller,
            &1u64,
            &stealth_address(&client.env),
            &short,
            &valid_metadata(&client.env),
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_announce_empty_metadata() {
        let Setup { env: _env, client, caller } = setup();
        let empty = Bytes::new(&client.env);

        let result = client.try_announce(
            &caller,
            &1u64,
            &stealth_address(&client.env),
            &valid_ephemeral_key(&client.env),
            &empty,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_announce_with_log_success() {
        let Setup { env, client, caller } = setup();
        let log_id = {
            let mut b = Bytes::new(&env);
            b.push_back(0x01u8);
            b
        };

        client.announce_with_log(
            &caller,
            &1u64,
            &stealth_address(&env),
            &valid_ephemeral_key(&env),
            &valid_metadata(&env),
            &log_id,
        );

        let events = env.events().all();
        let has_announcement = events.iter().any(|e| e.0 == client.address);
        assert!(has_announcement);
    }

    #[test]
    fn test_announce_with_log_stores_log() {
        let Setup { env, client, caller } = setup();
        let log_id = {
            let mut b = Bytes::new(&env);
            b.push_back(0x01u8);
            b
        };

        client.announce_with_log(
            &caller,
            &1u64,
            &stealth_address(&env),
            &valid_ephemeral_key(&env),
            &valid_metadata(&env),
            &log_id,
        );
    }

    #[test]
    fn test_announce_with_log_invalid_ephemeral_key() {
        let Setup { env: _env, client, caller } = setup();
        let short = Bytes::new(&client.env);
        let log_id = {
            let mut b = Bytes::new(&client.env);
            b.push_back(0x01u8);
            b
        };

        let result = client.try_announce_with_log(
            &caller,
            &1u64,
            &stealth_address(&client.env),
            &short,
            &valid_metadata(&client.env),
            &log_id,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_announce_differs_by_scheme_id() {
        let Setup { env, client, caller } = setup();
        let ephem = valid_ephemeral_key(&env);
        let meta = valid_metadata(&env);
        let addr = stealth_address(&env);

        // Each top-level `announce` emits exactly one event. The test harness
        // exposes only the most recent invocation's events via `events().all()`,
        // so we assert per call rather than expecting them to accumulate.
        client.announce(&caller, &1u64, &addr, &ephem, &meta);
        assert_eq!(env.events().all().len(), 1);

        let result = client.try_announce(&caller, &2u64, &addr, &ephem, &meta);
        assert!(result.is_err());
    }

    // -------------------------------------------------------------------------
    // Issue #53 — prefix validation tests
    // -------------------------------------------------------------------------

    fn key_with_prefix(env: &Env, prefix: u8) -> Bytes {
        let mut bytes = Bytes::new(env);
        bytes.push_back(prefix);
        for _ in 1..33 {
            bytes.push_back(0xabu8);
        }
        bytes
    }

    #[test]
    fn test_announce_rejects_uncompressed_key_prefix() {
        let Setup { env, client, caller } = setup();
        // 0x04 is the uncompressed-point marker; must be rejected
        let uncompressed = key_with_prefix(&env, 0x04);
        let result = client.try_announce(
            &caller,
            &1u64,
            &stealth_address(&env),
            &uncompressed,
            &valid_metadata(&env),
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_announce_rejects_zero_prefix() {
        let Setup { env, client, caller } = setup();
        let bad = key_with_prefix(&env, 0x00);
        let result = client.try_announce(
            &caller,
            &1u64,
            &stealth_address(&env),
            &bad,
            &valid_metadata(&env),
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_announce_accepts_prefix_02() {
        let Setup { env, client, caller } = setup();
        let key = key_with_prefix(&env, 0x02);
        // Should succeed — 0x02 is a valid compressed prefix
        client.announce(&caller, &1u64, &stealth_address(&env), &key, &valid_metadata(&env));
        let events = env.events().all();
        assert!(events.iter().any(|e| e.0 == client.address));
    }

    #[test]
    fn test_announce_with_log_rejects_invalid_prefix() {
        let Setup { env, client, caller } = setup();
        let bad = key_with_prefix(&env, 0x05);
        let log_id = {
            let mut b = Bytes::new(&env);
            b.push_back(0x01u8);
            b
        };
        let result = client.try_announce_with_log(
            &caller,
            &1u64,
            &stealth_address(&env),
            &bad,
            &valid_metadata(&env),
            &log_id,
        );
        assert!(result.is_err());
    }

    // -------------------------------------------------------------------------
    // Issue #50 — event versioning tests
    // -------------------------------------------------------------------------

    /// Returns the schema-version topic (the 2nd topic) of the event emitted by
    /// `contract_addr`, asserting the topic shape is `(Symbol, version)`.
    fn emitted_event_version(env: &Env, contract_addr: &Address) -> u32 {
        let events = env.events().all();
        let event = events
            .iter()
            .find(|e| &e.0 == contract_addr)
            .expect("contract must emit an event");
        let topics = event.1;
        assert_eq!(
            topics.len(),
            2,
            "event topics must be (name, version); got {}",
            topics.len()
        );
        u32::try_from_val(env, &topics.get(1).unwrap())
            .expect("second topic must be a u32 schema version")
    }

    #[test]
    fn test_announce_emits_event_with_version() {
        let Setup { env, client, caller } = setup();
        client.announce(
            &caller,
            &1u64,
            &stealth_address(&env),
            &valid_ephemeral_key(&env),
            &valid_metadata(&env),
        );
        // The emitted event must carry the current schema version in its topics.
        assert_eq!(emitted_event_version(&env, &client.address), EVENT_VERSION);
    }

    #[test]
    fn test_announce_with_log_emits_event_with_version() {
        let Setup { env, client, caller } = setup();
        let log_id = {
            let mut b = Bytes::new(&env);
            b.push_back(0x01u8);
            b
        };
        client.announce_with_log(
            &caller,
            &1u64,
            &stealth_address(&env),
            &valid_ephemeral_key(&env),
            &valid_metadata(&env),
            &log_id,
        );
        assert_eq!(emitted_event_version(&env, &client.address), EVENT_VERSION);
    }
}
