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

fn parse_error(e: SchemaParseError) -> SchemaError {
    match e {
        SchemaParseError::Empty => SchemaError::EmptyFieldDefs,
        SchemaParseError::TooManyFields => SchemaError::TooManyFields,
        SchemaParseError::FieldNameEmpty | SchemaParseError::FieldNameTooLong => {
            SchemaError::InvalidFieldName
        }
        SchemaParseError::InvalidFieldName => SchemaError::InvalidFieldName,
        SchemaParseError::DuplicateFieldName => SchemaError::DuplicateFieldName,
        SchemaParseError::InvalidFieldType => SchemaError::InvalidFieldType,
        SchemaParseError::DefsTooLong => SchemaError::FieldDefsTooLong,
        SchemaParseError::MalformedSegment => SchemaError::MalformedFieldSegment,
    }
}

fn soroban_string_to_str<'a>(s: &SorobanString, buf: &'a mut [u8; MAX_FIELD_DEFS_STR_LEN]) -> Result<&'a str, SchemaError> {
    let len = s.len() as usize;
    if len > MAX_FIELD_DEFS_STR_LEN {
        return Err(SchemaError::FieldDefsTooLong);
    }
    s.copy_into_slice(&mut buf[..len]);
    core::str::from_utf8(&buf[..len]).map_err(|_| SchemaError::InvalidFieldDefs)
}

/// Canonical schema ID (#44):
/// `SHA-256(authority_bytes || name_utf8 || version_be_u32 || canonical_field_defs_bytes)`.
pub fn derive_schema_id(
    env: &Env,
    authority_bytes: &BytesN<32>,
    name: &SorobanString,
    version: u32,
    canonical_field_defs: &[u8],
) -> BytesN<32> {
    let name_len = name.len() as usize;
    let mut name_buf = [0u8; 64];
    name.copy_into_slice(&mut name_buf[..name_len]);
    let id = core_derive_schema_id(
        &authority_bytes.to_array(),
        core::str::from_utf8(&name_buf[..name_len]).unwrap_or(""),
        version,
        canonical_field_defs,
    );
    BytesN::from_array(env, &id)
}

/// Legacy schema ID (pre-#44): `SHA-256(authority_bytes || name_utf8 || version_be_u32)`.
pub fn derive_schema_id_legacy(
    env: &Env,
    authority_bytes: &BytesN<32>,
    name: &SorobanString,
    version: u32,
) -> BytesN<32> {
    let mut hasher = Sha256::new();
    hasher.update(authority_bytes.to_array());
    let name_len = name.len() as usize;
    let mut name_buf = [0u8; 64];
    name.copy_into_slice(&mut name_buf[..name_len]);
    hasher.update(&name_buf[..name_len]);
    hasher.update(version.to_be_bytes());
    BytesN::from_array(env, &hasher.finalize().into())
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
        delegates.push_back(delegate);
        env.storage().persistent().set(&dkey, &delegates);
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
        let pos = delegates.first_index_of(delegate);
        let idx = pos.ok_or(SchemaError::DelegateNotFound)?;
        let mut updated = Vec::new(&env);
        for i in 0..delegates.len() {
            if i != idx {
                updated.push_back(delegates.get(i).unwrap());
            }
        }
        env.storage().persistent().set(&dkey, &updated);
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
        if schema.authority == issuer {
            return true;
        }
        let delegates: Vec<Address> = env
            .storage()
            .persistent()
            .get(&delegate_key(&schema_id))
            .unwrap_or_else(|| Vec::new(&env));
        delegates.contains(issuer)
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

#[cfg(test)]
mod test {
    use super::*;
    use opaque_schema_core::encode_canonical_field_defs;
    use soroban_sdk::{testutils::{Address as _, Ledger as _}, Address, Env};

    const AUTHORITY_KEY: [u8; 32] = [0x2au8; 32];

    fn authority_key(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &AUTHORITY_KEY)
    }

    fn schema_id_for(
        env: &Env,
        name: &str,
        field_defs: &str,
        version: u32,
    ) -> BytesN<32> {
        let fields = parse_field_definitions(field_defs).unwrap();
        let canonical = encode_canonical_field_defs(&fields);
        derive_schema_id(
            env,
            &authority_key(env),
            &SorobanString::from_str(env, name),
            version,
            &canonical,
        )
    }

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
    fn test_zero_delegates() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SchemaRegistry);
        let client = SchemaRegistryClient::new(&env, &contract_id);
        let authority = Address::generate(&env);
        let schema_id = schema_id_for(&env, "TestSchema", "string field1", 1);

        register(&env, &client, &authority, &schema_id, true);

        assert!(client.is_authorized_issuer(&schema_id, &authority));
        let stranger = Address::generate(&env);
        assert!(!client.is_authorized_issuer(&schema_id, &stranger));
    }

    #[test]
    fn test_one_delegate() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SchemaRegistry);
        let client = SchemaRegistryClient::new(&env, &contract_id);
        let authority = Address::generate(&env);
        let delegate = Address::generate(&env);
        let schema_id = schema_id_for(&env, "TestSchema", "string field1", 1);

        register(&env, &client, &authority, &schema_id, false);
        client.add_delegate(&authority, &schema_id, &delegate);

        assert!(client.is_authorized_issuer(&schema_id, &delegate));

        client.remove_delegate(&authority, &schema_id, &delegate);
        assert!(!client.is_authorized_issuer(&schema_id, &delegate));
    }

    #[test]
    fn test_max_delegates() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SchemaRegistry);
        let client = SchemaRegistryClient::new(&env, &contract_id);
        let authority = Address::generate(&env);
        let schema_id = schema_id_for(&env, "TestSchema", "string field1", 1);

        register(&env, &client, &authority, &schema_id, true);

        for _ in 0..10u32 {
            let d = Address::generate(&env);
            client.add_delegate(&authority, &schema_id, &d);
        }

        let extra = Address::generate(&env);
        let result = client.try_add_delegate(&authority, &schema_id, &extra);
        assert!(result.is_err());
    }

    #[test]
    fn test_schema_already_exists() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SchemaRegistry);
        let client = SchemaRegistryClient::new(&env, &contract_id);
        let authority = Address::generate(&env);
        let schema_id = schema_id_for(&env, "TestSchema", "string field1", 1);

        register(&env, &client, &authority, &schema_id, false);
        let result = client.try_register_schema(
            &authority,
            &authority_key(&env),
            &schema_id,
            &SorobanString::from_str(&env, "Dup"),
            &SorobanString::from_str(&env, "u32 x"),
            &false,
            &1u32,
            &None,
            &0u32,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_is_revocable() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SchemaRegistry);
        let client = SchemaRegistryClient::new(&env, &contract_id);
        let authority = Address::generate(&env);
        let schema_id = schema_id_for(&env, "TestSchema", "string field1", 1);

        register(&env, &client, &authority, &schema_id, true);
        assert!(client.is_revocable(&schema_id));
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
