#![no_std]
use opaque_schema_core::{
    parse_field_definitions, validate_attestation_data, AttestationDataError,
    MAX_ATTESTATION_DATA_LEN, MAX_FIELD_DEFS_STR_LEN,
};
use sha2::{Digest, Sha256};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Bytes, BytesN, Env, IntoVal,
    String as SorobanString, Symbol,
};

#[contract]
pub struct AttestationEngineV2;

/// Current event schema version — increment when the event topic/data layout changes.
/// Scanners should reject events with an unrecognised version rather than misparse them.
const EVENT_VERSION: u32 = 1;

#[contracttype]
#[derive(Clone)]
pub struct Attestation {
    pub uid: BytesN<32>,
    pub schema_id: BytesN<32>,
    pub issuer: Address,
    pub stealth_address_hash: BytesN<32>,
    pub data: Bytes,
    pub created_at: u32,
    pub expiration_ledger: u32,
    pub revocation_ledger: u32,
    pub ref_uid: BytesN<32>,
    pub issuance_sequence: u64,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum AttestationError {
    DataTooLarge = 1,
    UnauthorizedIssuer = 2,
    ExpirationInPast = 3,
    AttestationNotFound = 4,
    AlreadyRevoked = 5,
    NotRevocable = 6,
    Unauthorized = 7,
    AttestationAlreadyExists = 8,
    NotInitialized = 9,
    AlreadyInitialized = 10,
    Paused = 11,
    InvalidAttestationData = 12,
    SchemaDeprecated = 13,
    SchemaExpired = 14,
    SchemaNotFound = 15,
}

fn attestation_key(uid: &BytesN<32>) -> (Symbol, BytesN<32>) {
    (Symbol::new(&uid.env(), "attest"), uid.clone())
}

fn registry_key(env: &Env) -> Symbol {
    Symbol::new(env, "config")
}

fn save_config(env: &Env, cfg: &GovernanceConfig) {
    env.storage().instance().set(&registry_key(env), cfg);
}

fn emit_pause_event(env: &Env, action: &str, scope: &str) {
    env.events().publish(
        (Symbol::new(env, action),),
        Symbol::new(env, scope),
    );
}

#[contracttype]
#[derive(Clone)]
pub struct GovernanceConfig {
    pub admin: Address,
    pub governance: Address,
    pub schema_registry: Address,
    pub version: u32,
    pub paused_attestation: bool,
    pub paused_merkle_updates: bool,
    pub paused_proof_verification: bool,
    pub upgrade_info: Option<Bytes>,
}

fn load_config(env: &Env) -> Result<GovernanceConfig, AttestationError> {
    env.storage()
        .instance()
        .get(&registry_key(env))
        .ok_or(AttestationError::NotInitialized)
}

fn load_registry(env: &Env) -> Result<Address, AttestationError> {
    Ok(load_config(env)?.schema_registry)
}

fn issuance_sequence_key(
    schema_id: &BytesN<32>,
    stealth_hash: &BytesN<32>,
) -> (Symbol, BytesN<32>, BytesN<32>) {
    (
        Symbol::new(&schema_id.env(), "attseq"),
        schema_id.clone(),
        stealth_hash.clone(),
    )
}

fn compute_attestation_uid(
    env: &Env,
    schema_id: &BytesN<32>,
    stealth_hash: &BytesN<32>,
    ledger: u32,
    issuance_sequence: u64,
) -> BytesN<32> {
    // Deterministic UID preimage:
    // schema_id || stealth_address_hash || ledger_sequence || issuance_sequence.
    // The contract-managed sequence prevents same-ledger attestations for the
    // same schema and stealth hash from deriving the same storage key.
    let mut hasher = Sha256::new();
    hasher.update(schema_id.to_array());
    hasher.update(stealth_hash.to_array());
    hasher.update(ledger.to_be_bytes());
    hasher.update(issuance_sequence.to_be_bytes());
    BytesN::from_array(env, &hasher.finalize().into())
}

fn soroban_string_to_str<'a>(
    s: &SorobanString,
    buf: &'a mut [u8; MAX_FIELD_DEFS_STR_LEN],
) -> Option<&'a str> {
    let len = s.len() as usize;
    if len > MAX_FIELD_DEFS_STR_LEN {
        return None;
    }
    s.copy_into_slice(&mut buf[..len]);
    core::str::from_utf8(&buf[..len]).ok()
}

fn data_error(e: AttestationDataError) -> AttestationError {
    match e {
        AttestationDataError::TooLarge => AttestationError::DataTooLarge,
        _ => AttestationError::InvalidAttestationData,
    }
}

fn validate_attestation_against_schema(
    env: &Env,
    schema_registry: &Address,
    schema_id: &BytesN<32>,
    data: &Bytes,
) -> Result<(), AttestationError> {
    let schema: schema_registry::Schema = env.invoke_contract(
        schema_registry,
        &Symbol::new(env, "get_schema"),
        (schema_id.clone(),).into_val(env),
    );
    if schema.deprecated {
        return Err(AttestationError::SchemaDeprecated);
    }
    let ledger = env.ledger().sequence();
    if schema.schema_expiry_ledger != 0 && schema.schema_expiry_ledger <= ledger {
        return Err(AttestationError::SchemaExpired);
    }
    let mut buf = [0u8; MAX_FIELD_DEFS_STR_LEN];
    let defs_str = soroban_string_to_str(&schema.field_definitions, &mut buf)
        .ok_or(AttestationError::InvalidAttestationData)?;
    let fields = parse_field_definitions(defs_str).map_err(|_| {
        AttestationError::InvalidAttestationData
    })?;
    let len = data.len() as usize;
    if len > MAX_ATTESTATION_DATA_LEN {
        return Err(AttestationError::DataTooLarge);
    }
    let mut data_buf = [0u8; MAX_ATTESTATION_DATA_LEN];
    data.copy_into_slice(&mut data_buf[..len]);
    validate_attestation_data(&fields, &data_buf[..len]).map_err(data_error)
}

fn next_issuance_sequence(env: &Env, schema_id: &BytesN<32>, stealth_hash: &BytesN<32>) -> u64 {
    let key = issuance_sequence_key(schema_id, stealth_hash);
    let current: u64 = env.storage().persistent().get(&key).unwrap_or(0);
    let next = current.saturating_add(1);
    env.storage().persistent().set(&key, &next);
    next
}

#[contractimpl]
impl AttestationEngineV2 {
    /// Update mutable governance fields. Requires admin or governance auth.
    pub fn update_config(
        env: Env,
        caller: Address,
        schema_registry: Option<Address>,
        version: Option<u32>,
        upgrade_info: Option<Bytes>,
    ) -> Result<(), AttestationError> {
        caller.require_auth();
        let mut cfg = load_config(&env)?;
        Self::require_governance(&cfg, &caller)?;
        if let Some(sr) = schema_registry {
            cfg.schema_registry = sr;
        }
        if let Some(v) = version {
            cfg.version = v;
        }
        cfg.upgrade_info = upgrade_info;
        save_config(&env, &cfg);
        Ok(())
    }

    /// One-time initialiser. Stores the trusted schema registry address.
    /// Must be called before `attest` or `revoke_attestation`.
    pub fn initialize(
        env: Env,
        admin: Address,
        governance: Address,
        schema_registry: Address,
        version: u32,
    ) -> Result<(), AttestationError> {
        admin.require_auth();
        let key = registry_key(&env);
        if env.storage().instance().has(&key) {
            return Err(AttestationError::AlreadyInitialized);
        }
        let cfg = GovernanceConfig {
            admin: admin.clone(),
            governance: governance.clone(),
            schema_registry: schema_registry.clone(),
            version,
            paused_attestation: false,
            paused_merkle_updates: false,
            paused_proof_verification: false,
            upgrade_info: None,
        };
        save_config(&env, &cfg);
        Ok(())
    }

    /// Issues an attestation binding a stealth address to a schema-bound trait.
    ///
    /// # Issuer Encoding (see ISSUER_ENCODING.md)
    /// The `issuer` parameter is a Soroban Address representing a Stellar Ed25519 public key.
    /// The contract stores issuer as-is (Address type) and validates authorization by comparing
    /// against the schema authority and registered delegates.
    ///
    /// # Arguments
    /// * `issuer` - Stellar Ed25519 address (must be authorized for this schema)
    /// * `schema_id` - Schema identifier [u8; 32]
    /// * `stealth_address_hash` - Hash of the stealth address receiving the attestation
    /// * `data` - ABI-encoded attestation data (validated against schema field definitions)
    /// * `expiration_ledger` - Ledger number at which this attestation expires (0 = never)
    /// * `ref_uid` - Reference UID for linking related attestations
    ///
    /// # Returns
    /// The attestation UID (deterministic hash of schema_id, stealth_hash, ledger, sequence)
    pub fn attest(
        env: Env,
        issuer: Address,
        schema_id: BytesN<32>,
        stealth_address_hash: BytesN<32>,
        data: Bytes,
        expiration_ledger: u32,
        ref_uid: BytesN<32>,
    ) -> Result<BytesN<32>, AttestationError> {
        issuer.require_auth();
        // Check pause for attestation issuance
        let cfg = load_config(&env)?;
        if cfg.paused_attestation {
            return Err(AttestationError::Paused);
        }
        if data.len() > 512 {
            return Err(AttestationError::DataTooLarge);
        }
        let ledger = env.ledger().sequence();
        if expiration_ledger != 0 && expiration_ledger <= ledger {
            return Err(AttestationError::ExpirationInPast);
        }
        let schema_registry = load_registry(&env)?;
        let authorized: bool = env.invoke_contract(
            &schema_registry,
            &Symbol::new(&env, "is_authorized_issuer"),
            (schema_id.clone(), issuer.clone()).into_val(&env),
        );
        if !authorized {
            return Err(AttestationError::UnauthorizedIssuer);
        }
        validate_attestation_against_schema(&env, &schema_registry, &schema_id, &data)?;
        let issuance_sequence = next_issuance_sequence(&env, &schema_id, &stealth_address_hash);
        let uid = compute_attestation_uid(
            &env,
            &schema_id,
            &stealth_address_hash,
            ledger,
            issuance_sequence,
        );
        let key = attestation_key(&uid);
        if env.storage().persistent().has(&key) {
            return Err(AttestationError::AttestationAlreadyExists);
        }
        let attestation = Attestation {
            uid: uid.clone(),
            schema_id: schema_id.clone(),
            issuer: issuer.clone(),
            stealth_address_hash: stealth_address_hash.clone(),
            data,
            created_at: ledger,
            expiration_ledger,
            revocation_ledger: 0,
            ref_uid,
            issuance_sequence,
        };
        env.storage().persistent().set(&key, &attestation);
        env.events().publish(
            (Symbol::new(&env, "AttestationCreated"), EVENT_VERSION),
            (uid.clone(), schema_id, issuer, stealth_address_hash),
        );
        Ok(uid)
    }

    pub fn revoke_attestation(
        env: Env,
        revoker: Address,
        uid: BytesN<32>,
    ) -> Result<(), AttestationError> {
        revoker.require_auth();
        // revocation not paused by default; if needed governance can extend
        let schema_registry = load_registry(&env)?;
        let key = attestation_key(&uid);
        let mut attestation: Attestation = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(AttestationError::AttestationNotFound)?;
        if attestation.revocation_ledger != 0 {
            return Err(AttestationError::AlreadyRevoked);
        }
        let revocable: bool = env.invoke_contract(
            &schema_registry,
            &Symbol::new(&env, "is_revocable"),
            (attestation.schema_id.clone(),).into_val(&env),
        );
        if !revocable {
            return Err(AttestationError::NotRevocable);
        }
        let authorized: bool = env.invoke_contract(
            &schema_registry,
            &Symbol::new(&env, "is_authorized_issuer"),
            (attestation.schema_id.clone(), revoker.clone()).into_val(&env),
        );
        if !authorized && revoker != attestation.issuer {
            return Err(AttestationError::Unauthorized);
        }
        attestation.revocation_ledger = env.ledger().sequence();
        env.storage().persistent().set(&key, &attestation);
        env.events().publish(
            (Symbol::new(&env, "AttestationRevoked"), EVENT_VERSION),
            (uid, revoker),
        );
        Ok(())
    }

    /// Returns the stored attestation for the given UID (#46).
    pub fn get_attestation(
        env: Env,
        uid: BytesN<32>,
    ) -> Result<Attestation, AttestationError> {
        env.storage()
            .persistent()
            .get(&attestation_key(&uid))
            .ok_or(AttestationError::AttestationNotFound)
    }

    /// Read-only accessor for the governance/config state
    pub fn get_config(env: Env) -> Result<GovernanceConfig, AttestationError> {
        load_config(&env)
    }

    fn require_governance(cfg: &GovernanceConfig, caller: &Address) -> Result<(), AttestationError> {
        if caller == &cfg.admin || caller == &cfg.governance {
            Ok(())
        } else {
            Err(AttestationError::Unauthorized)
        }
    }

    pub fn pause_attestation(env: Env, caller: Address) -> Result<(), AttestationError> {
        caller.require_auth();
        let mut cfg = load_config(&env)?;
        Self::require_governance(&cfg, &caller)?;
        cfg.paused_attestation = true;
        save_config(&env, &cfg);
        emit_pause_event(&env, "Paused", "attestation");
        Ok(())
    }

    pub fn unpause_attestation(env: Env, caller: Address) -> Result<(), AttestationError> {
        caller.require_auth();
        let mut cfg = load_config(&env)?;
        Self::require_governance(&cfg, &caller)?;
        cfg.paused_attestation = false;
        save_config(&env, &cfg);
        emit_pause_event(&env, "Unpaused", "attestation");
        Ok(())
    }

    /// Guard for callers: returns `Paused` when `paused_merkle_updates` is set.
    /// Invoke at the top of any future Merkle-root-update entry point.
    pub fn check_merkle_updates_active(env: Env) -> Result<(), AttestationError> {
        if load_config(&env)?.paused_merkle_updates {
            return Err(AttestationError::Paused);
        }
        Ok(())
    }

    pub fn pause_merkle_updates(env: Env, caller: Address) -> Result<(), AttestationError> {
        caller.require_auth();
        let mut cfg = load_config(&env)?;
        Self::require_governance(&cfg, &caller)?;
        cfg.paused_merkle_updates = true;
        save_config(&env, &cfg);
        emit_pause_event(&env, "Paused", "merkle_upd");
        Ok(())
    }

    pub fn unpause_merkle_updates(env: Env, caller: Address) -> Result<(), AttestationError> {
        caller.require_auth();
        let mut cfg = load_config(&env)?;
        Self::require_governance(&cfg, &caller)?;
        cfg.paused_merkle_updates = false;
        save_config(&env, &cfg);
        emit_pause_event(&env, "Unpaused", "merkle_upd");
        Ok(())
    }

    /// Guard for callers: returns `Paused` when `paused_proof_verification` is set.
    /// Invoke at the top of any future proof-verification entry point.
    pub fn check_proof_verification_active(env: Env) -> Result<(), AttestationError> {
        if load_config(&env)?.paused_proof_verification {
            return Err(AttestationError::Paused);
        }
        Ok(())
    }

    pub fn pause_proof_verification(env: Env, caller: Address) -> Result<(), AttestationError> {
        caller.require_auth();
        let mut cfg = load_config(&env)?;
        Self::require_governance(&cfg, &caller)?;
        cfg.paused_proof_verification = true;
        save_config(&env, &cfg);
        emit_pause_event(&env, "Paused", "proof_verif");
        Ok(())
    }

    pub fn unpause_proof_verification(env: Env, caller: Address) -> Result<(), AttestationError> {
        caller.require_auth();
        let mut cfg = load_config(&env)?;
        Self::require_governance(&cfg, &caller)?;
        cfg.paused_proof_verification = false;
        save_config(&env, &cfg);
        emit_pause_event(&env, "Unpaused", "proof_verif");
        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    extern crate schema_registry;
    use soroban_sdk::{
        testutils::{Address as _, Ledger as _},
        Address, Bytes, Env, String as SorobanString,
    };

    // Mock registry that always denies — used by the unauthorized-registry security test (#47).
    #[contract]
    struct UnauthorizedRegistry;

    #[contractimpl]
    impl UnauthorizedRegistry {
        pub fn is_authorized_issuer(_env: Env, _schema_id: BytesN<32>, _issuer: Address) -> bool {
            false
        }

        pub fn is_revocable(_env: Env, _schema_id: BytesN<32>) -> bool {
            false
        }
    }

    // Returns (env, authority/admin, engine_contract_id, schema_client, engine_client).
    // Engine is pre-initialized against the real schema registry (#47).
    fn setup() -> (
        Env,
        Address,
        Address,
        schema_registry::SchemaRegistryClient<'static>,
        AttestationEngineV2Client<'static>,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let schema_contract_id = env.register_contract(None, schema_registry::SchemaRegistry);
        let schema_client =
            schema_registry::SchemaRegistryClient::new(&env, &schema_contract_id);
        let engine_contract_id = env.register_contract(None, AttestationEngineV2);
        let engine_client = AttestationEngineV2Client::new(&env, &engine_contract_id);
        let authority = Address::generate(&env);
        // initialize(admin, governance, schema_registry, version)
        engine_client.initialize(&authority, &authority, &schema_contract_id, &1u32);
        (env, authority, engine_contract_id, schema_client, engine_client)
    }

    const AUTHORITY_KEY: [u8; 32] = [0x2au8; 32];

    fn authority_key(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &AUTHORITY_KEY)
    }

    fn schema_id_for(env: &Env, name: &str, field_defs: &str) -> BytesN<32> {
        let fields = parse_field_definitions(field_defs).unwrap();
        let canonical = opaque_schema_core::encode_canonical_field_defs(&fields);
        schema_registry::derive_schema_id(
            env,
            &authority_key(env),
            &SorobanString::from_str(env, name),
            1,
            &canonical,
        )
    }

    fn register_schema(
        env: &Env,
        schema_client: &schema_registry::SchemaRegistryClient,
        authority: &Address,
        schema_id: &BytesN<32>,
        name: &str,
        field_defs: &str,
        revocable: bool,
    ) {
        schema_client.register_schema(
            authority,
            &authority_key(env),
            schema_id,
            &SorobanString::from_str(env, name),
            &SorobanString::from_str(env, field_defs),
            &revocable,
            &1u32,
            &None,
            &0u32,
        );
    }

    fn encode_data(env: &Env, field_defs: &str, values: &[(&str, &str)]) -> Bytes {
        let fields = parse_field_definitions(field_defs).unwrap();
        let encoded =
            opaque_schema_core::encode_attestation_data_from_strings(&fields, values).unwrap();
        Bytes::from_slice(env, &encoded)
    }

    fn setup_schema(
        env: &Env,
        schema_client: &schema_registry::SchemaRegistryClient,
        authority: &Address,
        name: &str,
        field_defs: &str,
        revocable: bool,
    ) -> BytesN<32> {
        let schema_id = schema_id_for(env, name, field_defs);
        register_schema(
            env,
            schema_client,
            authority,
            &schema_id,
            name,
            field_defs,
            revocable,
        );
        schema_id
    }

    // --- integration tests (schema_registry param removed from attest/revoke per #47) ---

    const DEFAULT_DEFS: &str = "string field1";

    #[test]
    fn test_attest_valid() {
        let (env, authority, _engine_id, schema_client, engine_client) = setup();
        let schema_id = setup_schema(&env, &schema_client, &authority, "TestSchema", DEFAULT_DEFS, true);
        let stealth_hash = BytesN::from_array(&env, &[0xAAu8; 32]);
        let data = encode_data(&env, DEFAULT_DEFS, &[("field1", "hello")]);
        let ref_uid = BytesN::from_array(&env, &[0u8; 32]);
        let uid = engine_client.attest(&authority, &schema_id, &stealth_hash, &data, &0u32, &ref_uid);
        assert!(uid.to_array() != [0u8; 32]);
    }

    #[test]
    fn test_attest_unauthorized_issuer() {
        let (env, authority, _engine_id, schema_client, engine_client) = setup();
        let schema_id = setup_schema(&env, &schema_client, &authority, "TestSchema2", DEFAULT_DEFS, true);
        let stranger = Address::generate(&env);
        let stealth_hash = BytesN::from_array(&env, &[0xAAu8; 32]);
        let data = encode_data(&env, DEFAULT_DEFS, &[("field1", "x")]);
        let ref_uid = BytesN::from_array(&env, &[0u8; 32]);
        let result = engine_client.try_attest(&stranger, &schema_id, &stealth_hash, &data, &0u32, &ref_uid);
        assert_eq!(result, Err(Ok(AttestationError::UnauthorizedIssuer)));
    }

    #[test]
    fn test_attest_delegate_authorized() {
        let (env, authority, _engine_id, schema_client, engine_client) = setup();
        let delegate = Address::generate(&env);
        let schema_id = setup_schema(&env, &schema_client, &authority, "TestSchema3", DEFAULT_DEFS, true);
        schema_client.add_delegate(&authority, &schema_id, &delegate);
        let stealth_hash = BytesN::from_array(&env, &[0xBBu8; 32]);
        let data = encode_data(&env, DEFAULT_DEFS, &[("field1", "delegated")]);
        let ref_uid = BytesN::from_array(&env, &[0u8; 32]);
        let uid = engine_client.attest(&delegate, &schema_id, &stealth_hash, &data, &0u32, &ref_uid);
        assert!(uid.to_array() != [0u8; 32]);
    }

    #[test]
    fn test_attest_data_too_large() {
        let (env, authority, _engine_id, schema_client, engine_client) = setup();
        let schema_id = setup_schema(&env, &schema_client, &authority, "TestSchema4", DEFAULT_DEFS, true);
        let stealth_hash = BytesN::from_array(&env, &[0xAAu8; 32]);
        let big_data = Bytes::from_array(&env, &[0u8; 513]);
        let ref_uid = BytesN::from_array(&env, &[0u8; 32]);
        let result = engine_client.try_attest(&authority, &schema_id, &stealth_hash, &big_data, &0u32, &ref_uid);
        assert_eq!(result, Err(Ok(AttestationError::DataTooLarge)));
    }

    #[test]
    fn test_revoke_attestation() {
        let (env, authority, _engine_id, schema_client, engine_client) = setup();
        let schema_id = setup_schema(&env, &schema_client, &authority, "TestSchema5", DEFAULT_DEFS, true);
        let stealth_hash = BytesN::from_array(&env, &[0xCCu8; 32]);
        let data = encode_data(&env, DEFAULT_DEFS, &[("field1", "revoke-me")]);
        let ref_uid = BytesN::from_array(&env, &[0u8; 32]);
        let uid = engine_client.attest(&authority, &schema_id, &stealth_hash, &data, &0u32, &ref_uid);
        engine_client.revoke_attestation(&authority, &uid);
    }

    #[test]
    fn test_revoke_not_found() {
        let (env, authority, _engine_id, _schema_client, engine_client) = setup();
        let fake_uid = BytesN::from_array(&env, &[0xFFu8; 32]);
        let result = engine_client.try_revoke_attestation(&authority, &fake_uid);
        assert_eq!(result, Err(Ok(AttestationError::AttestationNotFound)));
    }

    #[test]
    fn test_revoke_not_revocable_schema() {
        let (env, authority, _engine_id, schema_client, engine_client) = setup();
        let schema_id = setup_schema(&env, &schema_client, &authority, "TestSchema7", DEFAULT_DEFS, false);
        let stealth_hash = BytesN::from_array(&env, &[0xEEu8; 32]);
        let data = encode_data(&env, DEFAULT_DEFS, &[("field1", "x")]);
        let ref_uid = BytesN::from_array(&env, &[0u8; 32]);
        let uid = engine_client.attest(&authority, &schema_id, &stealth_hash, &data, &0u32, &ref_uid);
        let result = engine_client.try_revoke_attestation(&authority, &uid);
        assert_eq!(result, Err(Ok(AttestationError::NotRevocable)));
    }

    #[test]
    fn test_revoke_by_delegate() {
        let (env, authority, _engine_id, schema_client, engine_client) = setup();
        let delegate = Address::generate(&env);
        let schema_id = setup_schema(&env, &schema_client, &authority, "TestSchema8", DEFAULT_DEFS, true);
        schema_client.add_delegate(&authority, &schema_id, &delegate);
        let stealth_hash = BytesN::from_array(&env, &[0xFFu8; 32]);
        let data = encode_data(&env, DEFAULT_DEFS, &[("field1", "x")]);
        let ref_uid = BytesN::from_array(&env, &[0u8; 32]);
        let uid = engine_client.attest(&authority, &schema_id, &stealth_hash, &data, &0u32, &ref_uid);
        engine_client.revoke_attestation(&delegate, &uid);
    }

    #[test]
    fn test_revoke_by_unauthorized_stranger() {
        let (env, authority, _engine_id, schema_client, engine_client) = setup();
        let schema_id = setup_schema(&env, &schema_client, &authority, "TestSchema9", DEFAULT_DEFS, true);
        let stealth_hash = BytesN::from_array(&env, &[0x11u8; 32]);
        let data = encode_data(&env, DEFAULT_DEFS, &[("field1", "x")]);
        let ref_uid = BytesN::from_array(&env, &[0u8; 32]);
        let uid = engine_client.attest(&authority, &schema_id, &stealth_hash, &data, &0u32, &ref_uid);
        let stranger = Address::generate(&env);
        let result = engine_client.try_revoke_attestation(&stranger, &uid);
        assert_eq!(result, Err(Ok(AttestationError::Unauthorized)));
    }

    // --- UID derivation tests ---

    #[test]
    fn uid_derivation_is_deterministic_for_same_inputs() {
        let env = Env::default();
        let schema_id = BytesN::from_array(&env, &[1u8; 32]);
        let stealth_hash = BytesN::from_array(&env, &[2u8; 32]);
        let first = compute_attestation_uid(&env, &schema_id, &stealth_hash, 7, 1);
        let second = compute_attestation_uid(&env, &schema_id, &stealth_hash, 7, 1);
        assert_eq!(first, second);
    }

    #[test]
    fn same_ledger_attestations_receive_distinct_uids() {
        let (env, authority, _engine_id, schema_client, engine_client) = setup();
        let stealth_hash = BytesN::from_array(&env, &[4u8; 32]);
        let schema_id = setup_schema(&env, &schema_client, &authority, "UidSchema", DEFAULT_DEFS, true);
        let data = encode_data(&env, DEFAULT_DEFS, &[("field1", "")]);
        let ref_uid = BytesN::from_array(&env, &[0u8; 32]);
        let first = engine_client.attest(&authority, &schema_id, &stealth_hash, &data.clone(), &0u32, &ref_uid);
        let second = engine_client.attest(&authority, &schema_id, &stealth_hash, &data, &0u32, &ref_uid);
        assert_ne!(first, second);
    }

    #[test]
    fn duplicate_uid_is_rejected_before_storage() {
        let (env, authority, engine_id, schema_client, client) = setup();
        let schema_id = setup_schema(&env, &schema_client, &authority, "DupUidSchema", DEFAULT_DEFS, true);
        let stealth_hash = BytesN::from_array(&env, &[6u8; 32]);
        let data = encode_data(&env, DEFAULT_DEFS, &[("field1", "")]);
        let ref_uid = BytesN::from_array(&env, &[0u8; 32]);
        // Pre-seed the storage with the uid that the first attest call would produce
        // (issuance_sequence=1, ledger=0), so the engine hits AlreadyExists instead of
        // writing a new entry.
        let uid = compute_attestation_uid(&env, &schema_id, &stealth_hash, env.ledger().sequence(), 1);
        let key = attestation_key(&uid);
        let existing = Attestation {
            uid: uid.clone(),
            schema_id: schema_id.clone(),
            issuer: authority.clone(),
            stealth_address_hash: stealth_hash.clone(),
            data: encode_data(&env, DEFAULT_DEFS, &[("field1", "")]),
            created_at: env.ledger().sequence(),
            expiration_ledger: 0,
            revocation_ledger: 0,
            ref_uid: ref_uid.clone(),
            issuance_sequence: 1,
        };
        env.as_contract(&engine_id, || {
            env.storage().persistent().set(&key, &existing);
        });
        let result = client.try_attest(&authority, &schema_id, &stealth_hash, &data, &0, &ref_uid);
        assert_eq!(result, Err(Ok(AttestationError::AttestationAlreadyExists)));
    }

    // --- issue #45: schema-aware attestation data validation ---

    #[test]
    fn test_attest_all_field_types() {
        let (env, authority, _engine_id, schema_client, engine_client) = setup();
        let defs = "bool b,u8 n,u16 w,u32 x,u64 y,string s,pubkey p";
        let schema_id = setup_schema(&env, &schema_client, &authority, "AllTypes", defs, true);
        let pk = "0x2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a";
        let data = encode_data(
            &env,
            defs,
            &[
                ("b", "true"),
                ("n", "42"),
                ("w", "1000"),
                ("x", "99999"),
                ("y", "100"),
                ("s", "hello"),
                ("p", pk),
            ],
        );
        let stealth_hash = BytesN::from_array(&env, &[0x22u8; 32]);
        let ref_uid = BytesN::from_array(&env, &[0u8; 32]);
        let uid = engine_client.attest(&authority, &schema_id, &stealth_hash, &data, &0u32, &ref_uid);
        assert!(uid.to_array() != [0u8; 32]);
    }

    #[test]
    fn test_attest_rejects_malformed_data() {
        let (env, authority, _engine_id, schema_client, engine_client) = setup();
        let schema_id = setup_schema(&env, &schema_client, &authority, "Malformed", DEFAULT_DEFS, true);
        let stealth_hash = BytesN::from_array(&env, &[0x33u8; 32]);
        let bad_data = Bytes::from_array(&env, &[0xFFu8; 4]);
        let ref_uid = BytesN::from_array(&env, &[0u8; 32]);
        let result =
            engine_client.try_attest(&authority, &schema_id, &stealth_hash, &bad_data, &0u32, &ref_uid);
        assert_eq!(result, Err(Ok(AttestationError::InvalidAttestationData)));
    }

    #[test]
    fn test_attest_rejects_deprecated_schema() {
        let (env, authority, _engine_id, schema_client, engine_client) = setup();
        let schema_id = setup_schema(&env, &schema_client, &authority, "Deprecated", DEFAULT_DEFS, true);
        schema_client.deprecate_schema(&authority, &schema_id);
        let data = encode_data(&env, DEFAULT_DEFS, &[("field1", "x")]);
        let stealth_hash = BytesN::from_array(&env, &[0x44u8; 32]);
        let ref_uid = BytesN::from_array(&env, &[0u8; 32]);
        let result =
            engine_client.try_attest(&authority, &schema_id, &stealth_hash, &data, &0u32, &ref_uid);
        assert_eq!(result, Err(Ok(AttestationError::SchemaDeprecated)));
    }

    #[test]
    fn test_attest_rejects_expired_schema() {
        let (env, authority, _engine_id, schema_client, engine_client) = setup();
        let schema_id = schema_id_for(&env, "Expired", DEFAULT_DEFS);
        env.ledger().with_mut(|li| li.sequence_number = 10);
        schema_client.register_schema(
            &authority,
            &authority_key(&env),
            &schema_id,
            &SorobanString::from_str(&env, "Expired"),
            &SorobanString::from_str(&env, DEFAULT_DEFS),
            &true,
            &1u32,
            &None,
            &11u32,
        );
        env.ledger().with_mut(|li| li.sequence_number = 12);
        let data = encode_data(&env, DEFAULT_DEFS, &[("field1", "x")]);
        let stealth_hash = BytesN::from_array(&env, &[0x55u8; 32]);
        let ref_uid = BytesN::from_array(&env, &[0u8; 32]);
        let result =
            engine_client.try_attest(&authority, &schema_id, &stealth_hash, &data, &0u32, &ref_uid);
        assert_eq!(result, Err(Ok(AttestationError::SchemaExpired)));
    }

    // --- issue #46: get_attestation read API ---

    #[test]
    fn get_attestation_returns_stored_record() {
        let (env, authority, _engine_id, schema_client, client) = setup();
        let stealth_hash = BytesN::from_array(&env, &[8u8; 32]);
        let data = encode_data(&env, DEFAULT_DEFS, &[("field1", "")]);
        let ref_uid = BytesN::from_array(&env, &[0u8; 32]);
        let schema_id = setup_schema(&env, &schema_client, &authority, "GetAttest", DEFAULT_DEFS, true);
        let uid = client.attest(&authority, &schema_id, &stealth_hash, &data, &0, &ref_uid);
        let att = client.get_attestation(&uid);
        assert_eq!(att.uid, uid);
        assert_eq!(att.issuer, authority);
        assert_eq!(att.schema_id, schema_id);
        assert_eq!(att.revocation_ledger, 0u32);
    }

    #[test]
    fn get_attestation_returns_not_found_for_unknown_uid() {
        let (env, _authority, _engine_id, _schema_client, client) = setup();
        let unknown_uid = BytesN::from_array(&env, &[99u8; 32]);
        match client.try_get_attestation(&unknown_uid) {
            Err(Ok(AttestationError::AttestationNotFound)) => {}
            _ => panic!("expected AttestationNotFound"),
        }
    }

    // --- issue #47: registry binding security ---

    #[test]
    fn attest_fails_before_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let engine_id = env.register_contract(None, AttestationEngineV2);
        let client = AttestationEngineV2Client::new(&env, &engine_id);
        let issuer = Address::generate(&env);
        let schema_id = BytesN::from_array(&env, &[20u8; 32]);
        let stealth_hash = BytesN::from_array(&env, &[21u8; 32]);
        let ref_uid = BytesN::from_array(&env, &[0u8; 32]);
        let result = client.try_attest(&issuer, &schema_id, &stealth_hash, &Bytes::new(&env), &0, &ref_uid);
        assert_eq!(result, Err(Ok(AttestationError::NotInitialized)));
    }

    #[test]
    fn initialize_twice_is_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let schema_contract_id = env.register_contract(None, schema_registry::SchemaRegistry);
        let engine_id = env.register_contract(None, AttestationEngineV2);
        let client = AttestationEngineV2Client::new(&env, &engine_id);
        let admin = Address::generate(&env);
        client.initialize(&admin, &admin, &schema_contract_id, &1u32);
        let result = client.try_initialize(&admin, &admin, &schema_contract_id, &1u32);
        assert_eq!(result, Err(Ok(AttestationError::AlreadyInitialized)));
    }

    #[test]
    fn unauthorized_issuer_is_rejected_via_stored_registry() {
        let env = Env::default();
        env.mock_all_auths();
        let bad_registry_id = env.register_contract(None, UnauthorizedRegistry);
        let engine_id = env.register_contract(None, AttestationEngineV2);
        let admin = Address::generate(&env);
        let client = AttestationEngineV2Client::new(&env, &engine_id);
        client.initialize(&admin, &admin, &bad_registry_id, &1u32);
        let issuer = Address::generate(&env);
        let schema_id = BytesN::from_array(&env, &[30u8; 32]);
        let stealth_hash = BytesN::from_array(&env, &[31u8; 32]);
        let ref_uid = BytesN::from_array(&env, &[0u8; 32]);
        let result = client.try_attest(&issuer, &schema_id, &stealth_hash, &Bytes::new(&env), &0, &ref_uid);
        assert_eq!(result, Err(Ok(AttestationError::UnauthorizedIssuer)));
    }

    #[test]
    fn test_attest_paused_blocks_issuance_but_allows_reads_and_gov() {
        let (env, authority, _engine_id, schema_client, engine_client) = setup();
        let schema_id = setup_schema(&env, &schema_client, &authority, "PausedSchema", DEFAULT_DEFS, true);
        engine_client.pause_attestation(&authority);
        let stealth_hash = BytesN::from_array(&env, &[0xAAu8; 32]);
        let data = encode_data(&env, DEFAULT_DEFS, &[("field1", "x")]);
        let ref_uid = BytesN::from_array(&env, &[0u8; 32]);
        let result = engine_client.try_attest(&authority, &schema_id, &stealth_hash, &data, &0u32, &ref_uid);
        assert_eq!(result, Err(Ok(AttestationError::Paused)));
        let cfg = engine_client.get_config();
        assert!(cfg.paused_attestation);
        engine_client.unpause_attestation(&authority);
        let uid = engine_client.attest(&authority, &schema_id, &stealth_hash, &data, &0u32, &ref_uid);
        assert!(uid.to_array() != [0u8; 32]);
    }

    #[test]
    fn test_pause_requires_governance_authority() {
        let (env, authority, _engine_id, schema_client, engine_client) = setup();
        let schema_id = setup_schema(&env, &schema_client, &authority, "PauseAuth", DEFAULT_DEFS, true);
        let stranger = Address::generate(&env);
        let result = engine_client.try_pause_attestation(&stranger);
        assert_eq!(result, Err(Ok(AttestationError::Unauthorized)));
    }

    #[test]
    fn test_unpause_requires_governance_authority() {
        let (env, authority, _engine_id, _schema_client, engine_client) = setup();
        engine_client.pause_attestation(&authority);
        let stranger = Address::generate(&env);
        let result = engine_client.try_unpause_attestation(&stranger);
        assert_eq!(result, Err(Ok(AttestationError::Unauthorized)));
        // confirm still paused
        assert!(engine_client.get_config().paused_attestation);
    }

    #[test]
    fn test_merkle_updates_pause_round_trip() {
        let (env, authority, _engine_id, _schema_client, engine_client) = setup();
        // initially not paused
        assert!(!engine_client.get_config().paused_merkle_updates);
        // guard passes when unpaused
        engine_client.check_merkle_updates_active();
        // pause
        engine_client.pause_merkle_updates(&authority);
        assert!(engine_client.get_config().paused_merkle_updates);
        // guard fails when paused
        let result = engine_client.try_check_merkle_updates_active();
        assert_eq!(result, Err(Ok(AttestationError::Paused)));
        // stranger cannot unpause
        let stranger = Address::generate(&env);
        assert_eq!(
            engine_client.try_unpause_merkle_updates(&stranger),
            Err(Ok(AttestationError::Unauthorized))
        );
        // governance unpauses
        engine_client.unpause_merkle_updates(&authority);
        assert!(!engine_client.get_config().paused_merkle_updates);
        engine_client.check_merkle_updates_active();
    }

    #[test]
    fn test_proof_verification_pause_round_trip() {
        let (env, authority, _engine_id, _schema_client, engine_client) = setup();
        assert!(!engine_client.get_config().paused_proof_verification);
        engine_client.check_proof_verification_active();
        engine_client.pause_proof_verification(&authority);
        assert!(engine_client.get_config().paused_proof_verification);
        let result = engine_client.try_check_proof_verification_active();
        assert_eq!(result, Err(Ok(AttestationError::Paused)));
        let stranger = Address::generate(&env);
        assert_eq!(
            engine_client.try_unpause_proof_verification(&stranger),
            Err(Ok(AttestationError::Unauthorized))
        );
        engine_client.unpause_proof_verification(&authority);
        assert!(!engine_client.get_config().paused_proof_verification);
        engine_client.check_proof_verification_active();
    }

    #[test]
    fn test_update_config_requires_governance() {
        let (env, authority, _engine_id, schema_client, engine_client) = setup();
        let new_registry_id = env.register_contract(None, schema_registry::SchemaRegistry);
        // governance can update
        engine_client.update_config(&authority, &Some(new_registry_id.clone()), &Some(2u32), &None);
        let cfg = engine_client.get_config();
        assert_eq!(cfg.version, 2u32);
        assert_eq!(cfg.schema_registry, new_registry_id);
        // stranger cannot update
        let stranger = Address::generate(&env);
        let result = engine_client.try_update_config(&stranger, &None, &None, &None);
        assert_eq!(result, Err(Ok(AttestationError::Unauthorized)));
        // upgrade_info round-trip
        let info = soroban_sdk::Bytes::from_array(&env, &[0xABu8; 4]);
        engine_client.update_config(&authority, &None, &None, &Some(info.clone()));
        assert_eq!(engine_client.get_config().upgrade_info, Some(info));
        // clear upgrade_info
        engine_client.update_config(&authority, &None, &None, &None);
        assert_eq!(engine_client.get_config().upgrade_info, None);
        // suppress unused warning
        let _ = schema_client;
    }
}
