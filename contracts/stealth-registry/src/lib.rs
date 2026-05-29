#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Bytes, Env, Symbol, Vec};

/// Stealth Meta-Address Registry — maps Stellar accounts to stealth meta-addresses.
/// Equivalent to ERC-6538. scheme_id 1 = secp256k1 with view tags.
///
/// Meta-address layout (66 bytes): view_pub_key (33 bytes) || spend_pub_key (33 bytes).
/// Both keys must be valid compressed secp256k1 public keys (prefix 0x02 or 0x03).
///
/// Key rotation semantics:
/// - Each call to `register_keys` increments the nonce atomically and stores the
///   new entry under the current nonce, so the full history is preserved.
/// - `resolve` returns the latest (highest-nonce) entry.
/// - `resolve_at_nonce` returns the entry at a specific nonce for recovery/audit.
/// - Senders should always use `resolve` to get the current meta-address.
#[contract]
pub struct StealthRegistry;

/// Current event schema version — increment when the event topic/data layout changes.
/// Scanners should reject events with an unrecognised version rather than misparse them.
const EVENT_VERSION: u32 = 1;

#[contracttype]
#[derive(Clone)]
pub struct RegistryEntry {
    pub registrant: Address,
    pub scheme_id: u64,
    pub stealth_meta_address: Bytes,
    pub nonce: u64,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RegistryError {
    InvalidMetaAddress = 1,
    InvalidPrefix = 2,
    SameKeys = 3,
}

fn registry_key(registrant: &Address, scheme_id: u64) -> (Symbol, Address, u64) {
    (Symbol::new(&registrant.env(), "latest"), registrant.clone(), scheme_id)
}

fn history_key(registrant: &Address, scheme_id: u64, nonce: u64) -> (Symbol, Address, u64, u64) {
    (Symbol::new(&registrant.env(), "hist"), registrant.clone(), scheme_id, nonce)
}

/// Validate that a 33-byte compressed secp256k1 public key has a valid prefix (0x02 or 0x03).
fn validate_compressed_pubkey_prefix(key: &[u8]) -> bool {
    key.len() == 33 && (key[0] == PREFIX_EVEN || key[0] == PREFIX_ODD)
}

fn is_valid_secp256k1_pubkey(bytes: &Bytes) -> bool {
    if bytes.len() != 33 {
        return false;
    }
    let prefix = bytes.get(0).unwrap_or(0);
    prefix == 0x02 || prefix == 0x03
}

#[contractimpl]
impl StealthRegistry {
    /// Register or rotate a stealth meta-address.
    ///
    /// Validates:
    /// - Total length == 66 bytes (two 33-byte compressed secp256k1 keys).
    /// - Both keys have valid compressed-point prefixes (0x02 or 0x03).
    /// - View key and spend key are not identical.
    ///
    /// Each call atomically increments the per-(registrant, scheme_id) nonce and
    /// stores the entry at that nonce, preserving full rotation history.
    pub fn register_keys(
        env: Env,
        registrant: Address,
        scheme_id: u64,
        stealth_meta_address: Bytes,
    ) -> Result<(), RegistryError> {
        registrant.require_auth();

        // Length check: two 33-byte compressed secp256k1 public keys.
        if stealth_meta_address.len() != 66 {
            return Err(RegistryError::InvalidMetaAddress);
        }

        // Validate prefixes for both keys (DHKP: view and spend keys)
        let view_key = stealth_meta_address.slice(0..33);
        let spend_key = stealth_meta_address.slice(33..66);

        if !is_valid_secp256k1_pubkey(&view_key) || !is_valid_secp256k1_pubkey(&spend_key) {
            return Err(RegistryError::InvalidPrefix);
        }

        if view_key == spend_key {
            return Err(RegistryError::SameKeys);
        }

        // Increment nonce and store
        let n_key = nonce_key(&registrant);
        let nonce: u64 = env.storage().persistent().get(&n_key).unwrap_or(0);
        let new_nonce = nonce.saturating_add(1);
        env.storage().persistent().set(&n_key, &new_nonce);

        let entry = RegistryEntry {
            registrant: registrant.clone(),
            scheme_id,
            stealth_meta_address: stealth_meta_address.clone(),
            nonce: new_nonce,
        };

        // Update latest and historical
        env.storage()
            .persistent()
            .set(&registry_key(&registrant, scheme_id), &entry);
        
        env.storage()
            .persistent()
            .set(&history_key(&registrant, scheme_id, new_nonce), &entry);

        env.events().publish(
            (Symbol::new(&env, "StealthMetaAddressSet"), EVENT_VERSION),
            (registrant, scheme_id, stealth_meta_address),
        );
        Ok(())
    }

    pub fn increment_nonce(env: Env, registrant: Address) -> u64 {
        registrant.require_auth();
        let key = nonce_key(&registrant);
        let nonce: u64 = env.storage().persistent().get(&key).unwrap_or(0);
        let new_nonce = nonce.saturating_add(1);
        env.storage().persistent().set(&key, &new_nonce);
        env.events().publish(
            (Symbol::new(&env, "NonceIncremented"), EVENT_VERSION),
            (registrant.clone(), new_nonce),
        );
        new_nonce
    }

    /// Returns the stealth meta-address registered at a specific nonce.
    /// Useful for recovery and auditing historical rotations.
    pub fn resolve_at_nonce(
        env: Env,
        registrant: Address,
        scheme_id: u64,
        nonce: u64,
    ) -> Option<Bytes> {
        env.storage()
            .persistent()
            .get::<_, RegistryEntry>(&registry_key(&registrant, scheme_id, nonce))
            .map(|e| e.stealth_meta_address)
    }

    pub fn resolve_historical(env: Env, registrant: Address, scheme_id: u64, nonce: u64) -> Option<Bytes> {
        env.storage()
            .persistent()
            .get::<_, RegistryEntry>(&history_key(&registrant, scheme_id, nonce))
            .map(|e| e.stealth_meta_address)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::{Address as _, Events as _}, Address, Bytes, Env};

    struct Setup {
        env: Env,
        client: StealthRegistryClient<'static>,
        registrant: Address,
    }

    fn setup() -> Setup {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, StealthRegistry);
        let client = StealthRegistryClient::new(&env, &contract_id);
        let registrant = Address::generate(&env);
        Setup { env, client, registrant }
    }

    /// Build a valid 66-byte meta-address with the given prefixes.
    fn meta_address_with_prefixes(env: &Env, view_prefix: u8, spend_prefix: u8) -> Bytes {
        let mut bytes = Bytes::new(env);
        // Compressed keys with 0x02 prefix
        bytes.push_back(0x02u8);
        for _ in 0..32 { bytes.push_back(0x01u8); }
        bytes.push_back(0x02u8);
        for _ in 0..32 { bytes.push_back(0x02u8); }
        bytes
    }

    fn valid_meta_address(env: &Env) -> Bytes {
        meta_address_with_prefixes(env, 0x02, 0x03)
    }

    // ── #54: Prefix validation ────────────────────────────────────────────────

    #[test]
    fn test_register_keys_success_even_odd_prefixes() {
        let Setup { env, client, registrant } = setup();
        let meta = meta_address_with_prefixes(&env, 0x02, 0x03);
        client.register_keys(&registrant, &1u64, &meta);
        assert_eq!(client.resolve(&registrant, &1u64), Some(meta));
    }

    #[test]
    fn test_register_keys_success_odd_even_prefixes() {
        let Setup { env, client, registrant } = setup();
        let meta = meta_address_with_prefixes(&env, 0x03, 0x02);
        client.register_keys(&registrant, &1u64, &meta);
        assert_eq!(client.resolve(&registrant, &1u64), Some(meta));
    }

    #[test]
    fn test_register_keys_rejects_bad_view_prefix() {
        let Setup { env, client, registrant } = setup();
        let meta = meta_address_with_prefixes(&env, 0x04, 0x02);
        let result = client.try_register_keys(&registrant, &1u64, &meta);
        assert_eq!(result, Err(Ok(RegistryError::InvalidKeyPrefix)));
    }

    #[test]
    fn test_register_keys_rejects_bad_spend_prefix() {
        let Setup { env, client, registrant } = setup();
        let meta = meta_address_with_prefixes(&env, 0x02, 0x00);
        let result = client.try_register_keys(&registrant, &1u64, &meta);
        assert_eq!(result, Err(Ok(RegistryError::InvalidKeyPrefix)));
    }

    #[test]
    fn test_register_keys_rejects_uncompressed_prefix() {
        let Setup { env, client, registrant } = setup();
        let meta = meta_address_with_prefixes(&env, 0x04, 0x04);
        let result = client.try_register_keys(&registrant, &1u64, &meta);
        assert_eq!(result, Err(Ok(RegistryError::InvalidKeyPrefix)));
    }

    #[test]
    fn test_register_keys_rejects_identical_view_spend_keys() {
        let Setup { env, client, registrant } = setup();
        // Both keys identical: same prefix and same body bytes.
        let mut bytes = Bytes::new(&env);
        bytes.push_back(0x02u8);
        for _ in 1..33 {
            bytes.push_back(0xabu8);
        }
        bytes.push_back(0x02u8);
        for _ in 1..33 {
            bytes.push_back(0xabu8);
        }
        let result = client.try_register_keys(&registrant, &1u64, &bytes);
        assert_eq!(result, Err(Ok(RegistryError::IdenticalViewSpendKeys)));
    }

    #[test]
    fn test_register_keys_invalid_prefix() {
        let Setup { env, client, registrant } = setup();
        let scheme_id: u64 = 1;
        let mut bad_meta = Bytes::new(&env);
        for _ in 0..66 { bad_meta.push_back(0x04u8); } // 0x04 is invalid for compressed keys

        let result = client.try_register_keys(&registrant, &scheme_id, &bad_meta);
        assert!(result.is_err());
    }

    #[test]
    fn test_register_keys_same_keys_fails() {
        let Setup { env, client, registrant } = setup();
        let scheme_id: u64 = 1;
        let mut same_meta = Bytes::new(&env);
        same_meta.push_back(0x02u8);
        for _ in 0..32 { same_meta.push_back(0x01u8); }
        same_meta.push_back(0x02u8);
        for _ in 0..32 { same_meta.push_back(0x01u8); }

        let result = client.try_register_keys(&registrant, &scheme_id, &same_meta);
        assert!(result.is_err());
    }

    #[test]
    fn test_register_keys_history() {
        let Setup { env, client, registrant } = setup();
        let scheme_id: u64 = 1;
        
        let meta1 = valid_meta_address(&env);
        client.register_keys(&registrant, &scheme_id, &meta1);

        let mut meta2 = Bytes::new(&env);
        meta2.push_back(0x03u8);
        for _ in 0..32 { meta2.push_back(0x09u8); }
        meta2.push_back(0x03u8);
        for _ in 0..32 { meta2.push_back(0x08u8); }
        client.register_keys(&registrant, &scheme_id, &meta2);

        // Resolve current
        assert_eq!(client.resolve(&registrant, &scheme_id), Some(meta2.clone()));

        // Resolve historical
        assert_eq!(client.resolve_historical(&registrant, &scheme_id, &1), Some(meta1));
        assert_eq!(client.resolve_historical(&registrant, &scheme_id, &2), Some(meta2));
    }

    #[test]
    fn test_increment_nonce_manual() {
        let Setup { client, registrant, .. } = setup();

        let nonce = client.increment_nonce(&registrant);
        assert_eq!(nonce, 1);
    }

    #[test]
    fn test_resolve_not_found() {
        let Setup { client, .. } = setup();
        let stranger = Address::generate(&client.env);
        assert_eq!(client.resolve(&stranger, &1u64), None);
    }

    #[test]
    fn test_resolve_different_scheme_ids() {
        let Setup { env, client, registrant } = setup();
        let meta = valid_meta_address(&env);
        client.register_keys(&registrant, &1u64, &meta);
        assert_eq!(client.resolve(&registrant, &2u64), None);
        assert_eq!(client.resolve(&registrant, &1u64), Some(meta));
    }

    #[test]
    fn test_register_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, StealthRegistry);
        let client = StealthRegistryClient::new(&env, &contract_id);
        let registrant = Address::generate(&env);
        let meta = meta_address_with_prefixes(&env, 0x02, 0x03);

        client.register_keys(&registrant, &1u64, &meta);

        let events = env.events().all();
        assert!(!events.events().is_empty());
    }
}
