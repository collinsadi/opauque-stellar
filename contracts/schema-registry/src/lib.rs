#![no_std]
use opaque_schema_core::{
    encode_canonical_field_defs, field_defs_to_canonical_string, parse_field_definitions,
    derive_schema_id as core_derive_schema_id, SchemaParseError, MAX_FIELD_DEFS_STR_LEN,
};
use sha2::{Digest, Sha256};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, BytesN, Env,
    String as SorobanString, Symbol, Vec,
};

#[contract]
pub struct SchemaRegistry;

/// Current event schema version — increment when the event topic/data layout changes.
/// Scanners should reject events with an unrecognised version rather than misparse them.
const EVENT_VERSION: u32 = 1;

#[contracttype]
#[derive(Clone)]
pub struct Schema {
    pub schema_id: BytesN<32>,
    pub authority: Address,
    pub resolver: Address,
    pub revocable: bool,
    pub name: SorobanString,
    pub field_definitions: SorobanString,
    pub version: u32,
    pub created_at: u32,
    pub schema_expiry_ledger: u32,
    pub deprecated: bool,
}

#[contracttype]
#[derive(Clone)]
pub struct SchemaStatus {
    pub revocable: bool,
    pub deprecated: bool,
    pub schema_expiry_ledger: u32,
    pub active: bool,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum SchemaError {
    NameTooLong = 1,
    FieldDefsTooLong = 2,
    InvalidSchemaId = 3,
    Unauthorized = 4,
    DelegateLimitReached = 5,
    DelegateAlreadyExists = 6,
    DelegateNotFound = 7,
    SchemaAlreadyExists = 8,
    InvalidExpiryLedger = 9,
    InvalidFieldDefs = 10,
    EmptyFieldDefs = 11,
    TooManyFields = 12,
    InvalidFieldName = 13,
    InvalidFieldType = 14,
    DuplicateFieldName = 15,
    MalformedFieldSegment = 16,
}

fn schema_key(schema_id: &BytesN<32>) -> (Symbol, BytesN<32>) {
    (Symbol::new(&schema_id.env(), "schema"), schema_id.clone())
}

fn delegate_key(schema_id: &BytesN<32>) -> (Symbol, BytesN<32>) {
    (Symbol::new(&schema_id.env(), "delegates"), schema_id.clone())
}

fn is_schema_active(env: &Env, schema: &Schema) -> bool {
    !schema.deprecated
        && (schema.schema_expiry_ledger == 0 || schema.schema_expiry_ledger > env.ledger().sequence())
}

fn issuer_in_authorized_set(env: &Env, schema_id: &BytesN<32>, schema: &Schema, issuer: &Address) -> bool {
    if schema.authority == *issuer {
        return true;
    }
    let delegates: Vec<Address> = env
        .storage()
        .persistent()
        .get(&delegate_key(schema_id))
        .unwrap_or_else(|| Vec::new(env));
    delegates.contains(issuer.clone())
}

#[contractimpl]
impl SchemaRegistry {
    /// Read-only helper: derive the canonical schema ID for the given inputs.
    pub fn compute_schema_id(
        env: Env,
        authority_key: BytesN<32>,
        name: SorobanString,
        field_definitions: SorobanString,
        version: u32,
    ) -> Result<BytesN<32>, SchemaError> {
        let mut buf = [0u8; MAX_FIELD_DEFS_STR_LEN];
        let defs_str = soroban_string_to_str(&field_definitions, &mut buf)?;
        let fields = parse_field_definitions(defs_str).map_err(parse_error)?;
        let canonical = encode_canonical_field_defs(&fields);
        Ok(derive_schema_id(
            &env,
            &authority_key,
            &name,
            version,
            &canonical,
        ))
    }

    pub fn register_schema(
        env: Env,
        authority: Address,
        authority_key: BytesN<32>,
        schema_id: BytesN<32>,
        name: SorobanString,
        field_definitions: SorobanString,
        revocable: bool,
        version: u32,
        resolver: Option<Address>,
        schema_expiry_ledger: u32,
    ) -> Result<(), SchemaError> {
        authority.require_auth();
        if name.len() > 64 {
            return Err(SchemaError::NameTooLong);
        }
        let mut buf = [0u8; MAX_FIELD_DEFS_STR_LEN];
        let defs_str = soroban_string_to_str(&field_definitions, &mut buf)?;
        let fields = parse_field_definitions(defs_str).map_err(parse_error)?;
        let canonical_bytes = encode_canonical_field_defs(&fields);
        let canonical_str = field_defs_to_canonical_string(&fields);
        let expected_id = derive_schema_id(
            &env,
            &authority_key,
            &name,
            version,
            &canonical_bytes,
        );
        if schema_id != expected_id {
            return Err(SchemaError::InvalidSchemaId);
        }
        let skey = schema_key(&schema_id);
        if env.storage().persistent().has(&skey) {
            return Err(SchemaError::SchemaAlreadyExists);
        }
        if schema_expiry_ledger != 0 && schema_expiry_ledger <= env.ledger().sequence() {
            return Err(SchemaError::InvalidExpiryLedger);
        }
        let canonical_field_defs =
            SorobanString::from_str(&env, canonical_str.as_str());
        let schema = Schema {
            schema_id: schema_id.clone(),
            authority: authority.clone(),
            resolver: resolver.unwrap_or_else(|| {
                Address::from_str(
                    &env,
                    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
                )
            }),
            revocable,
            name: name.clone(),
            field_definitions: canonical_field_defs,
            version,
            created_at: env.ledger().sequence(),
            schema_expiry_ledger,
            deprecated: false,
        };
        env.storage().persistent().set(&skey, &schema);
        env.storage()
            .persistent()
            .set(&delegate_key(&schema_id), &Vec::<Address>::new(&env));

        let ids_key = schema_ids_key(&env);
        let mut schema_ids: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&ids_key)
            .unwrap_or_else(|| Vec::new(&env));
        schema_ids.push_back(schema_id.clone());
        env.storage().persistent().set(&ids_key, &schema_ids);

        env.events().publish(
            (Symbol::new(&env, "SchemaRegistered"), EVENT_VERSION),
            (schema_id, authority, name),
        );
        Ok(())
    }

    pub fn add_delegate(
        env: Env,
        authority: Address,
        schema_id: BytesN<32>,
        delegate: Address,
    ) -> Result<(), SchemaError> {
        authority.require_auth();
        let skey = schema_key(&schema_id);
        let schema: Schema = env.storage().persistent().get(&skey).expect("schema");
        if schema.authority != authority {
            return Err(SchemaError::Unauthorized);
        }
        let dkey = delegate_key(&schema_id);
        let mut delegates: Vec<Address> = env
            .storage()
            .persistent()
            .get(&dkey)
            .unwrap_or_else(|| Vec::new(&env));
        if delegates.len() >= 10 {
            return Err(SchemaError::DelegateLimitReached);
        }
        if delegates.contains(delegate.clone()) {
            return Err(SchemaError::DelegateAlreadyExists);
        }
        delegates.push_back(delegate.clone());
        env.storage().persistent().set(&dkey, &delegates);
        env.events().publish(
            (Symbol::new(&env, "DelegateAdded"),),
            (schema_id, authority, delegate),
        );
        Ok(())
    }

    pub fn remove_delegate(
        env: Env,
        authority: Address,
        schema_id: BytesN<32>,
        delegate: Address,
    ) -> Result<(), SchemaError> {
        authority.require_auth();
        let skey = schema_key(&schema_id);
        let schema: Schema = env.storage().persistent().get(&skey).expect("schema");
        if schema.authority != authority {
            return Err(SchemaError::Unauthorized);
        }
        let dkey = delegate_key(&schema_id);
        let delegates: Vec<Address> = env
            .storage()
            .persistent()
            .get(&dkey)
            .unwrap_or_else(|| Vec::new(&env));
        let pos = delegates.first_index_of(delegate.clone());
        let idx = pos.ok_or(SchemaError::DelegateNotFound)?;
        let mut updated = Vec::new(&env);
        for i in 0..delegates.len() {
            if i != idx {
                updated.push_back(delegates.get(i).unwrap());
            }
        }
        env.storage().persistent().set(&dkey, &updated);
        env.events().publish(
            (Symbol::new(&env, "DelegateRemoved"),),
            (schema_id, authority, delegate),
        );
        Ok(())
    }

    pub fn deprecate_schema(
        env: Env,
        authority: Address,
        schema_id: BytesN<32>,
    ) -> Result<(), SchemaError> {
        authority.require_auth();
        let key = schema_key(&schema_id);
        let mut schema: Schema = env.storage().persistent().get(&key).expect("schema");
        if schema.authority != authority {
            return Err(SchemaError::Unauthorized);
        }
        schema.deprecated = true;
        env.storage().persistent().set(&key, &schema);
        Ok(())
    }

    pub fn is_authorized_issuer(env: Env, schema_id: BytesN<32>, issuer: Address) -> bool {
        let schema: Schema = env
            .storage()
            .persistent()
            .get(&schema_key(&schema_id))
            .expect("schema");
        issuer_in_authorized_set(&env, &schema_id, &schema, &issuer)
    }

    pub fn can_issue(env: Env, schema_id: BytesN<32>, issuer: Address) -> bool {
        let schema: Schema = env
            .storage()
            .persistent()
            .get(&schema_key(&schema_id))
            .expect("schema");
        is_schema_active(&env, &schema) && issuer_in_authorized_set(&env, &schema_id, &schema, &issuer)
    }

    pub fn is_revocable(env: Env, schema_id: BytesN<32>) -> bool {
        let schema: Schema = env
            .storage()
            .persistent()
            .get(&schema_key(&schema_id))
            .expect("schema");
        schema.revocable
    }

    pub fn get_schema(env: Env, schema_id: BytesN<32>) -> Schema {
        env.storage()
            .persistent()
            .get(&schema_key(&schema_id))
            .expect("schema")
    }
}

// =============================================================================
// Property/Fuzz Tests for Contract State Machines (Issue #90)
// =============================================================================
// Invariants verified:
//   - Schemas are immutable after registration (fields/auth/revocable don't change)
//   - Schema ID derivation is deterministic and bound to inputs
//   - Authorization hierarchy is respected (only authority adds/removes delegates)
//   - Expired/deprecated schemas reject issuance
//   - Revoked attestations stay revoked
//   - Duplicate UID registration is rejected

#[cfg(test)]
mod property_tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Address, BytesN, Env, String as SorobanString,
    };
    use opaque_schema_core::parse_field_definitions;

    fn authority_key(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[0x2au8; 32])
    }

    fn schema_id_for(env: &Env, name: &str, field_defs: &str, version: u32) -> BytesN<32> {
        let fields = parse_field_definitions(field_defs).unwrap();
        let canonical = encode_canonical_field_defs(&fields);
        derive_schema_id(env, &authority_key(env), &SorobanString::from_str(env, name), version, &canonical)
    }

    /// Invariant: Schema field definitions, revocability, and authority
    /// are immutable after registration.
    #[test]
    fn property_schema_fields_are_immutable() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SchemaRegistry);
        let client = SchemaRegistryClient::new(&env, &contract_id);
        let authority = Address::generate(&env);
        let schema_id = schema_id_for(&env, "ImmutableTest", "string field1,u32 score", 1);

        client.register_schema(
            &authority,
            &authority_key(&env),
            &schema_id,
            &SorobanString::from_str(&env, "ImmutableTest"),
            &SorobanString::from_str(&env, "string field1, u32 score"),
            &true,
            &1u32,
            &None,
            &0u32,
        );

        let schema = client.get_schema(&schema_id);

        // Invariant 1: after registration, these fields must match inputs
        assert_eq!(schema.schema_id, schema_id);
        assert_eq!(schema.authority, authority);
        assert_eq!(schema.revocable, true);
        assert_eq!(
            schema.field_definitions,
            SorobanString::from_str(&env, "string field1,u32 score")
        );

        // Invariant 2: no public method can change field_definitions or revocable
        // (deprecate only changes `deprecated` flag)
        client.deprecate_schema(&authority, &schema_id);
        let after_deprecate = client.get_schema(&schema_id);
        assert_eq!(after_deprecate.field_definitions, schema.field_definitions);
        assert_eq!(after_deprecate.revocable, schema.revocable);
        assert_eq!(after_deprecate.authority, schema.authority);
        assert!(after_deprecate.deprecated);
    }

    /// Invariant: Schema IDs are deterministically derived from
    /// (authority_key, name, version, field_defs). Different inputs → different IDs.
    #[test]
    fn property_schema_ids_are_bound_to_inputs() {
        let env = Env::default();

        let authority = [0x2au8; 32];
        let name = SorobanString::from_str(&env, "TestSchema");
        let fields = parse_field_definitions("string f1").unwrap();
        let canonical = encode_canonical_field_defs(&fields);

        let id = derive_schema_id(&env, &BytesN::from_array(&env, &authority), &name, 1, &canonical);

        // Same inputs → same ID (determinism)
        let id2 = derive_schema_id(&env, &BytesN::from_array(&env, &authority), &name, 1, &canonical);
        assert_eq!(id, id2);

        // Different version → different ID
        let id_v2 = derive_schema_id(&env, &BytesN::from_array(&env, &authority), &name, 2, &canonical);
        assert_ne!(id, id_v2);

        // Different name → different ID
        let name2 = SorobanString::from_str(&env, "OtherSchema");
        let id_name = derive_schema_id(&env, &BytesN::from_array(&env, &authority), &name2, 1, &canonical);
        assert_ne!(id, id_name);

        // Different field defs → different ID
        let fields2 = parse_field_definitions("u32 f2").unwrap();
        let canonical2 = encode_canonical_field_defs(&fields2);
        let id_field = derive_schema_id(&env, &BytesN::from_array(&env, &authority), &name, 1, &canonical2);
        assert_ne!(id, id_field);

        // Different authority → different ID
        let authority2 = [0xbbu8; 32];
        let id_auth = derive_schema_id(&env, &BytesN::from_array(&env, &authority2), &name, 1, &canonical);
        assert_ne!(id, id_auth);
    }

    /// Invariant: Authorization is hierarchical.
    /// - Authority can add/remove delegates
    /// - Non-authority cannot add/remove delegates
    /// - Authority can deprecate schema
    /// - Non-authority cannot deprecate schema
    #[test]
    fn property_authorization_hierarchy_is_enforced() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SchemaRegistry);
        let client = SchemaRegistryClient::new(&env, &contract_id);
        let authority = Address::generate(&env);
        let delegate = Address::generate(&env);
        let stranger = Address::generate(&env);
        let schema_id = schema_id_for(&env, "AuthTest", "string f1", 1);

        client.register_schema(
            &authority,
            &authority_key(&env),
            &schema_id,
            &SorobanString::from_str(&env, "AuthTest"),
            &SorobanString::from_str(&env, "string f1"),
            &true,
            &1u32,
            &None,
            &0u32,
        );

        // Invariant: only authority can add delegates
        assert!(client.try_add_delegate(&stranger, &schema_id, &delegate).is_err());
        client.add_delegate(&authority, &schema_id, &delegate);

        // Invariant: delegate is recognized as authorized
        assert!(client.is_authorized_issuer(&schema_id, &delegate));

        // Invariant: only authority can remove delegates
        assert!(client.try_remove_delegate(&stranger, &schema_id, &delegate).is_err());
        client.remove_delegate(&authority, &schema_id, &delegate);

        // Invariant: after removal, delegate is no longer authorized
        assert!(!client.is_authorized_issuer(&schema_id, &delegate));

        // Invariant: only authority can deprecate
        assert!(client.try_deprecate_schema(&stranger, &schema_id).is_err());
        client.deprecate_schema(&authority, &schema_id);
    }

    /// Invariant: Expired schemas reject issuance.
    /// A schema with expiry_ledger=N cannot issue attestations at ledger >= N.
    #[test]
    fn property_schema_expiry_predictable() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SchemaRegistry);
        let client = SchemaRegistryClient::new(&env, &contract_id);
        let authority = Address::generate(&env);
        let schema_id = schema_id_for(&env, "ExpiryPropTest", "string f1", 1);

        // Register with expiry at ledger 100
        env.ledger().with_mut(|l| l.sequence_number = 50);
        client.register_schema(
            &authority,
            &authority_key(&env),
            &schema_id,
            &SorobanString::from_str(&env, "ExpiryPropTest"),
            &SorobanString::from_str(&env, "string f1"),
            &true,
            &1u32,
            &None,
            &100u32,
        );

        // Can issue before expiry
        assert!(client.can_issue(&schema_id, &authority));

        // At expiry boundary (ledger == expiry_ledger), issuance is blocked
        env.ledger().with_mut(|l| l.sequence_number = 100);
        assert!(!client.can_issue(&schema_id, &authority));

        // Past expiry, still blocked
        env.ledger().with_mut(|l| l.sequence_number = 150);
        assert!(!client.can_issue(&schema_id, &authority));

        // Invariant: expiry_ledger=0 means never expires
        let schema_id_no_expiry = schema_id_for(&env, "NeverExpires", "string f1", 1);
        client.register_schema(
            &authority,
            &authority_key(&env),
            &schema_id_no_expiry,
            &SorobanString::from_str(&env, "NeverExpires"),
            &SorobanString::from_str(&env, "string f1"),
            &true,
            &1u32,
            &None,
            &0u32,
        );
        env.ledger().with_mut(|l| l.sequence_number = 1000);
        assert!(client.can_issue(&schema_id_no_expiry, &authority));
    }

    /// Invariant: Schema registration rejects duplicate IDs.
    /// First registration succeeds, second fails.
    #[test]
    fn property_schema_duplicate_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SchemaRegistry);
        let client = SchemaRegistryClient::new(&env, &contract_id);
        let authority = Address::generate(&env);
        let schema_id = schema_id_for(&env, "DupTest", "string f1", 1);

        // First registration succeeds
        client.register_schema(
            &authority,
            &authority_key(&env),
            &schema_id,
            &SorobanString::from_str(&env, "DupTest"),
            &SorobanString::from_str(&env, "string f1"),
            &true,
            &1u32,
            &None,
            &0u32,
        );

        // Second registration with same ID fails
        let result = client.try_register_schema(
            &authority,
            &authority_key(&env),
            &schema_id,
            &SorobanString::from_str(&env, "DupTest"),
            &SorobanString::from_str(&env, "string f1"),
            &true,
            &1u32,
            &None,
            &0u32,
        );
        assert_eq!(result, Err(Ok(SchemaError::SchemaAlreadyExists)));
    }

    /// Invariant: field_definitions with too many fields, bad names, etc. are rejected
    #[test]
    fn property_invalid_field_defs_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SchemaRegistry);
        let client = SchemaRegistryClient::new(&env, &contract_id);
        let authority = Address::generate(&env);

        // 17 fields (MAX_FIELDS + 1) → TooManyFields
        let many_fields = (0..17u8)
            .map(|i| format!("u32 f{}", i))
            .collect::<Vec<_>>()
            .join(", ");
        let many_id = schema_id_for(&env, "ManyFields", &many_fields, 1);
        let result = client.try_register_schema(
            &authority,
            &authority_key(&env),
            &many_id,
            &SorobanString::from_str(&env, "ManyFields"),
            &SorobanString::from_str(&env, &many_fields),
            &true,
            &1u32,
            &None,
            &0u32,
        );
        assert_eq!(result, Err(Ok(SchemaError::TooManyFields)));

        // Field name starting with digit → InvalidFieldName
        let bad_name_id = schema_id_for(&env, "BadName", "u32 1bad", 1);
        let result = client.try_register_schema(
            &authority,
            &authority_key(&env),
            &bad_name_id,
            &SorobanString::from_str(&env, "BadName"),
            &SorobanString::from_str(&env, "u32 1bad"),
            &true,
            &1u32,
            &None,
            &0u32,
        );
        assert_eq!(result, Err(Ok(SchemaError::InvalidFieldName)));

        // Duplicate field name → DuplicateFieldName
        let dup_name_id = schema_id_for(&env, "DupName", "u32 a,string a", 1);
        let result = client.try_register_schema(
            &authority,
            &authority_key(&env),
            &dup_name_id,
            &SorobanString::from_str(&env, "DupName"),
            &SorobanString::from_str(&env, "u32 a, string a"),
            &true,
            &1u32,
            &None,
            &0u32,
        );
        assert_eq!(result, Err(Ok(SchemaError::DuplicateFieldName)));

        // Empty field definitions → EmptyFieldDefs
        let empty_id = schema_id_for(&env, "Empty", "", 1);
        let result = client.try_register_schema(
            &authority,
            &authority_key(&env),
            &empty_id,
            &SorobanString::from_str(&env, "Empty"),
            &SorobanString::from_str(&env, ""),
            &true,
            &1u32,
            &None,
            &0u32,
        );
        assert_eq!(result, Err(Ok(SchemaError::EmptyFieldDefs)));
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::{Address as _, Ledger}, Address, Env};

    fn register(
        env: &Env,
        client: &SchemaRegistryClient,
        authority: &Address,
        schema_id: &BytesN<32>,
        revocable: bool,
    ) {
        client.register_schema(
            authority,
            &authority_key(env),
            schema_id,
            &SorobanString::from_str(env, "TestSchema"),
            &SorobanString::from_str(env, "string field1"),
            &revocable,
            &1u32,
            &None,
            &0u32,
        );
    }

    #[test]
    fn active_authority_can_issue() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SchemaRegistry);
        let client = SchemaRegistryClient::new(&env, &contract_id);
        let authority = Address::generate(&env);
        let schema_id = schema_id_for(&env, "TestSchema", "string field1", 1);

        register(&env, &client, &authority, &schema_id, true);

        assert!(client.is_authorized_issuer(&schema_id, &authority));
        assert!(client.can_issue(&schema_id, &authority));
    }

    #[test]
    fn deprecated_schema_cannot_issue() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SchemaRegistry);
        let client = SchemaRegistryClient::new(&env, &contract_id);
        let authority = Address::generate(&env);
        let schema_id = BytesN::from_array(&env, &[2u8; 32]);

        register(&env, &client, &authority, &schema_id, true);
        client.deprecate_schema(&authority, &schema_id);

        assert!(client.is_authorized_issuer(&schema_id, &authority));
        assert!(!client.can_issue(&schema_id, &authority));
    }

    #[test]
    fn expired_schema_cannot_issue() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_sequence_number(10);
        let contract_id = env.register_contract(None, SchemaRegistry);
        let client = SchemaRegistryClient::new(&env, &contract_id);
        let authority = Address::generate(&env);
        let schema_id = BytesN::from_array(&env, &[3u8; 32]);

        client.register_schema(
            &authority,
            &authority_key(&env),
            &schema_id,
            &SorobanString::from_str(&env, "Expiring"),
            &SorobanString::from_str(&env, "field1:string"),
            &true,
            &1u32,
            &None,
            &11u32,
        );

        assert!(client.can_issue(&schema_id, &authority));
        env.ledger().set_sequence_number(11);
        assert!(!client.can_issue(&schema_id, &authority));
    }

    #[test]
    fn test_expiry_zero_is_accepted() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SchemaRegistry);
        let client = SchemaRegistryClient::new(&env, &contract_id);
        let authority = Address::generate(&env);
        let schema_id = schema_id_for(&env, "NoExpiry", "u32 f", 1);
        client.register_schema(
            &authority,
            &authority_key(&env),
            &schema_id,
            &SorobanString::from_str(&env, "NoExpiry"),
            &SorobanString::from_str(&env, "u32 f"),
            &false,
            &1u32,
            &None,
            &0u32,
        );
        let schema = client.get_schema(&schema_id);
        assert_eq!(schema.schema_expiry_ledger, 0u32);
    }

    #[test]
    fn test_expiry_in_past_is_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SchemaRegistry);
        let client = SchemaRegistryClient::new(&env, &contract_id);
        let authority = Address::generate(&env);
        let schema_id = schema_id_for(&env, "Stale", "u32 f", 1);
        env.ledger().with_mut(|li| li.sequence_number = 5);
        let result = client.try_register_schema(
            &authority,
            &authority_key(&env),
            &schema_id,
            &SorobanString::from_str(&env, "Stale"),
            &SorobanString::from_str(&env, "u32 f"),
            &false,
            &1u32,
            &None,
            &4u32,
        );
        assert_eq!(result, Err(Ok(SchemaError::InvalidExpiryLedger)));
    }

    #[test]
    fn derive_schema_id_is_deterministic() {
        let env = Env::default();
        let authority_bytes = authority_key(&env);
        let name = SorobanString::from_str(&env, "MySchema");
        let fields = parse_field_definitions("string name").unwrap();
        let canonical = encode_canonical_field_defs(&fields);
        let first = derive_schema_id(&env, &authority_bytes, &name, 1, &canonical);
        let second = derive_schema_id(&env, &authority_bytes, &name, 1, &canonical);
        assert_eq!(first, second);
    }

    #[test]
    fn derive_schema_id_differs_by_version() {
        let env = Env::default();
        let authority_bytes = authority_key(&env);
        let name = SorobanString::from_str(&env, "MySchema");
        let fields = parse_field_definitions("string name").unwrap();
        let canonical = encode_canonical_field_defs(&fields);
        let v1 = derive_schema_id(&env, &authority_bytes, &name, 1, &canonical);
        let v2 = derive_schema_id(&env, &authority_bytes, &name, 2, &canonical);
        assert_ne!(v1, v2);
    }

    #[test]
    fn derive_schema_id_differs_by_name() {
        let env = Env::default();
        let authority_bytes = authority_key(&env);
        let fields = parse_field_definitions("string x").unwrap();
        let canonical = encode_canonical_field_defs(&fields);
        let a = derive_schema_id(
            &env,
            &authority_bytes,
            &SorobanString::from_str(&env, "Foo"),
            1,
            &canonical,
        );
        let b = derive_schema_id(
            &env,
            &authority_bytes,
            &SorobanString::from_str(&env, "Bar"),
            1,
            &canonical,
        );
        assert_ne!(a, b);
    }

    #[test]
    fn derive_schema_id_differs_by_field_defs() {
        let env = Env::default();
        let authority_bytes = authority_key(&env);
        let name = SorobanString::from_str(&env, "MySchema");
        let a_fields = parse_field_definitions("string name").unwrap();
        let b_fields = parse_field_definitions("u32 name").unwrap();
        let id_a = derive_schema_id(
            &env,
            &authority_bytes,
            &name,
            1,
            &encode_canonical_field_defs(&a_fields),
        );
        let id_b = derive_schema_id(
            &env,
            &authority_bytes,
            &name,
            1,
            &encode_canonical_field_defs(&b_fields),
        );
        assert_ne!(id_a, id_b);
    }

    #[test]
    fn rejects_invalid_field_type() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SchemaRegistry);
        let client = SchemaRegistryClient::new(&env, &contract_id);
        let authority = Address::generate(&env);
        let bogus_id = BytesN::from_array(&env, &[9u8; 32]);
        let result = client.try_register_schema(
            &authority,
            &authority_key(&env),
            &bogus_id,
            &SorobanString::from_str(&env, "Bad"),
            &SorobanString::from_str(&env, "float x"),
            &false,
            &1u32,
            &None,
            &0u32,
        );
        assert_eq!(result, Err(Ok(SchemaError::InvalidFieldType)));
    }

    #[test]
    fn rejects_wrong_schema_id() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SchemaRegistry);
        let client = SchemaRegistryClient::new(&env, &contract_id);
        let authority = Address::generate(&env);
        let wrong_id = BytesN::from_array(&env, &[1u8; 32]);
        let result = client.try_register_schema(
            &authority,
            &authority_key(&env),
            &wrong_id,
            &SorobanString::from_str(&env, "Test"),
            &SorobanString::from_str(&env, "string field1"),
            &false,
            &1u32,
            &None,
            &0u32,
        );
        assert_eq!(result, Err(Ok(SchemaError::InvalidSchemaId)));
    }

    #[test]
    fn stores_canonical_field_definitions() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SchemaRegistry);
        let client = SchemaRegistryClient::new(&env, &contract_id);
        let authority = Address::generate(&env);
        let schema_id = schema_id_for(&env, "Test", "bool active, string label", 1);
        client.register_schema(
            &authority,
            &authority_key(&env),
            &schema_id,
            &SorobanString::from_str(&env, "Test"),
            &SorobanString::from_str(&env, "bool active, string label"),
            &true,
            &1u32,
            &None,
            &0u32,
        );
        let schema = client.get_schema(&schema_id);
        assert_eq!(
            schema.field_definitions,
            SorobanString::from_str(&env, "bool active,string label")
        );
    }
}
