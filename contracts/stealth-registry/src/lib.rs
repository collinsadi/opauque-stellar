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

#[contracttype]
#[derive(Clone)]
pub struct RegistryEntry {
    pub registrant: Address,
    pub scheme_id: u64,
    pub stealth_meta_address: Bytes,
    /// Nonce at which this entry was registered (1-based).
    pub nonce: u64,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RegistryError {
    InvalidMetaAddress = 1,
    InvalidKeyPrefix = 2,
    IdenticalViewSpendKeys = 3,
}

/// Compressed secp256k1 public key prefixes.
const PREFIX_EVEN: u8 = 0x02;
const PREFIX_ODD: u8 = 0x03;

fn registry_key(registrant: &Address, scheme_id: u64, nonce: u64) -> (Symbol, Address, u64, u64) {
    (Symbol::new(&registrant.env(), "entry"), registrant.clone(), scheme_id, nonce)
}

fn nonce_key(registrant: &Address, scheme_id: u64) -> (Symbol, Address, u64) {
    (Symbol::new(&registrant.env(), "nonce"), registrant.clone(), scheme_id)
}

/// Validate that a 33-byte compressed secp256k1 public key has a valid prefix (0x02 or 0x03).
fn validate_compressed_pubkey_prefix(key: &[u8]) -> bool {
    key.len() == 33 && (key[0] == PREFIX_EVEN || key[0] == PREFIX_ODD)
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

        // Copy into a fixed-size array for prefix validation.
        let mut buf = [0u8; 66];
        stealth_meta_address.copy_into_slice(&mut buf);

        let view_key = &buf[..33];
        let spend_key = &buf[33..];

        // Validate compressed secp256k1 prefixes.
        if !validate_compressed_pubkey_prefix(view_key) {
            return Err(RegistryError::InvalidKeyPrefix);
        }
        if !validate_compressed_pubkey_prefix(spend_key) {
            return Err(RegistryError::InvalidKeyPrefix);
        }

        // Reject identical view and spend keys (would break DKSAP security).
        if view_key == spend_key {
            return Err(RegistryError::IdenticalViewSpendKeys);
        }

        // Atomically increment nonce and store entry at new nonce.
        let nonce_k = nonce_key(&registrant, scheme_id);
        let prev_nonce: u64 = env.storage().persistent().get(&nonce_k).unwrap_or(0);
        let new_nonce = prev_nonce.saturating_add(1);
        env.storage().persistent().set(&nonce_k, &new_nonce);

        let entry = RegistryEntry {
            registrant: registrant.clone(),
            scheme_id,
            stealth_meta_address: stealth_meta_address.clone(),
            nonce: new_nonce,
        };
        env.storage()
            .persistent()
            .set(&registry_key(&registrant, scheme_id, new_nonce), &entry);

        env.events().publish(
            (Symbol::new(&env, "StealthMetaAddressSet"),),
            (registrant, scheme_id, new_nonce, stealth_meta_address),
        );
        Ok(())
    }

    /// Returns the current (latest) stealth meta-address for a registrant.
    /// Senders should always call this to get the active meta-address.
    pub fn resolve(env: Env, registrant: Address, scheme_id: u64) -> Option<Bytes> {
        let nonce_k = nonce_key(&registrant, scheme_id);
        let nonce: u64 = env.storage().persistent().get(&nonce_k).unwrap_or(0);
        if nonce == 0 {
            return None;
        }
        env.storage()
            .persistent()
            .get::<_, RegistryEntry>(&registry_key(&registrant, scheme_id, nonce))
            .map(|e| e.stealth_meta_address)
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

    /// Returns the current nonce for a (registrant, scheme_id) pair.
    /// Equals the number of times `register_keys` has been called successfully.
    pub fn get_nonce(env: Env, registrant: Address, scheme_id: u64) -> u64 {
        let nonce_k = nonce_key(&registrant, scheme_id);
        env.storage().persistent().get(&nonce_k).unwrap_or(0)
    }

    /// Returns all historical entries for a (registrant, scheme_id) pair.
    /// Entries are ordered from nonce 1 to current nonce.
    pub fn get_history(env: Env, registrant: Address, scheme_id: u64) -> Vec<RegistryEntry> {
        let nonce_k = nonce_key(&registrant, scheme_id);
        let current_nonce: u64 = env.storage().persistent().get(&nonce_k).unwrap_or(0);
        let mut history = Vec::new(&env);
        for n in 1..=current_nonce {
            if let Some(entry) = env
                .storage()
                .persistent()
                .get::<_, RegistryEntry>(&registry_key(&registrant, scheme_id, n))
            {
                history.push_back(entry);
            }
        }
        history
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
        bytes.push_back(view_prefix);
        for _ in 1..33 {
            bytes.push_back(0x01u8);
        }
        bytes.push_back(spend_prefix);
        for _ in 1..33 {
            bytes.push_back(0x02u8);
        }
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
    fn test_register_keys_invalid_meta_address_length() {
        let Setup { env: _env, client, registrant } = setup();
        let short = Bytes::new(&client.env);
        let result = client.try_register_keys(&registrant, &1u64, &short);
        assert_eq!(result, Err(Ok(RegistryError::InvalidMetaAddress)));
    }

    // ── #55: Nonce / history semantics ────────────────────────────────────────

    #[test]
    fn test_register_increments_nonce() {
        let Setup { env, client, registrant } = setup();
        assert_eq!(client.get_nonce(&registrant, &1u64), 0);
        client.register_keys(&registrant, &1u64, &valid_meta_address(&env));
        assert_eq!(client.get_nonce(&registrant, &1u64), 1);
        client.register_keys(&registrant, &1u64, &meta_address_with_prefixes(&env, 0x03, 0x02));
        assert_eq!(client.get_nonce(&registrant, &1u64), 2);
    }

    #[test]
    fn test_resolve_returns_latest_entry() {
        let Setup { env, client, registrant } = setup();
        let meta_a = valid_meta_address(&env);
        let meta_b = meta_address_with_prefixes(&env, 0x03, 0x02);

        client.register_keys(&registrant, &1u64, &meta_a);
        client.register_keys(&registrant, &1u64, &meta_b);

        assert_eq!(client.resolve(&registrant, &1u64), Some(meta_b));
    }

    #[test]
    fn test_resolve_at_nonce_returns_historical_entry() {
        let Setup { env, client, registrant } = setup();
        let meta_a = valid_meta_address(&env);
        let meta_b = meta_address_with_prefixes(&env, 0x03, 0x02);

        client.register_keys(&registrant, &1u64, &meta_a);
        client.register_keys(&registrant, &1u64, &meta_b);

        assert_eq!(client.resolve_at_nonce(&registrant, &1u64, &1u64), Some(meta_a));
        assert_eq!(client.resolve_at_nonce(&registrant, &1u64, &2u64), Some(meta_b));
    }

    #[test]
    fn test_get_history_returns_all_entries() {
        let Setup { env, client, registrant } = setup();
        let meta_a = valid_meta_address(&env);
        let meta_b = meta_address_with_prefixes(&env, 0x03, 0x02);

        client.register_keys(&registrant, &1u64, &meta_a);
        client.register_keys(&registrant, &1u64, &meta_b);

        let history = client.get_history(&registrant, &1u64);
        assert_eq!(history.len(), 2);
        assert_eq!(history.get(0).unwrap().stealth_meta_address, meta_a);
        assert_eq!(history.get(1).unwrap().stealth_meta_address, meta_b);
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
