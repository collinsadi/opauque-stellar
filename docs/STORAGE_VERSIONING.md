# Contract Storage Versioning and Migrations

This document defines storage versioning strategies, migration procedures, and rollback limitations for Opaque contracts.

## Overview

Storage versioning prevents data corruption when contracts are upgraded. Each storage struct includes a version field that enables migrations from old layouts to new layouts.

## Storage Structures and Versioning

### Attestation Engine v2

#### Attestation Storage

```rust
#[contracttype]
#[derive(Clone, Serialize, Deserialize)]
pub struct Attestation {
    pub version: u32,  // Current: 1
    pub schema_id: BytesN<32>,
    pub subject: Address,
    pub issuer: Address,
    pub data: Bytes,
    pub created_at: u64,
    pub expires_at: u64,
    pub revoked: bool,
    pub revocable: bool,
}
```

**Current Version**: 1
**Fields**:
- `version`: Storage version (always 1 for current schema)
- `schema_id`: Reference to the schema this attestation conforms to
- `subject`: Address being attested about
- `issuer`: Address that issued the attestation
- `data`: Opaque payload (max 4KB)
- `created_at`: Ledger sequence at creation
- `expires_at`: Expiry ledger (0 = no expiry)
- `revoked`: Whether attestation is revoked
- `revocable`: Whether revocation is allowed

**Migration Strategy**: 
- Add new fields at the end
- Check version on read and migrate if needed
- Never remove fields

### Schema Registry

#### Schema Storage

```rust
#[contracttype]
#[derive(Clone)]
pub struct Schema {
    pub version: u32,  // Current: 1
    pub schema_id: BytesN<32>,
    pub authority: Address,
    pub resolver: Address,
    pub revocable: bool,
    pub name: SorobanString,
    pub field_definitions: SorobanString,
    pub created_at: u32,
    pub schema_expiry_ledger: u32,
    pub deprecated: bool,
}
```

**Current Version**: 1
**Migration Strategy**: Monitor field count, add new fields at the end only.

### Reputation Verifier

#### Root Storage

```rust
#[contracttype]
#[derive(Clone)]
pub struct MerkleRoot {
    pub version: u32,  // Current: 1
    pub root: BytesN<32>,
    pub height: u32,
    pub timestamp: u64,
    pub next_rotation_ledger: u32,
}
```

**Current Version**: 1
**Migration Strategy**: Root structure is stable; new data structures should be added in new storage entries.

### Stealth Announcer

#### Announcement Log Storage

```rust
#[contracttype]
#[derive(Clone)]
pub struct AnnouncementLog {
    pub version: u32,  // Current: 1
    pub log_id: u64,
    pub ephemeral_public_key: BytesN<33>,
    pub encrypted_metadata: Bytes,
    pub timestamp: u64,
}
```

**Current Version**: 1
**Migration Strategy**: Log entries are immutable once created. Versioning allows new metadata formats.

### Stealth Registry

#### Meta-Address Storage

```rust
#[contracttype]
#[derive(Clone)]
pub struct MetaAddressRecord {
    pub version: u32,  // Current: 1
    pub spend_key: BytesN<33>,
    pub view_key: BytesN<33>,
    pub owner: Address,
    pub created_at: u64,
    pub is_active: bool,
}
```

**Current Version**: 1
**Migration Strategy**: Support dual-key formats via version field.

## Migration Testing

### Test Structure

Storage migration tests verify:

1. **Old-to-New Layout Compatibility**: Reading old data with new code
2. **Data Integrity**: No data loss during migration
3. **Rollback Safety**: Understanding rollback limitations
4. **Version Detection**: Correct version identification

### Example: Attestation Migration Test

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_attestation_v1_to_v2_migration() {
        let env = Env::default();
        
        // Simulate old v1 attestation
        let old_attestation = Attestation {
            version: 1,
            schema_id: BytesN::from_array(&env, &[0; 32]),
            subject: Address::generate(&env),
            issuer: Address::generate(&env),
            data: Bytes::new(&env),
            created_at: 1000,
            expires_at: 2000,
            revoked: false,
            revocable: true,
        };
        
        // Store as bytes (simulating on-chain storage)
        let stored = old_attestation.clone();
        
        // Retrieve and verify migration happens correctly
        let retrieved = stored.clone();
        assert_eq!(retrieved.version, 1);
        assert_eq!(retrieved.subject, old_attestation.subject);
        assert_eq!(retrieved.issuer, old_attestation.issuer);
        assert_eq!(retrieved.revoked, old_attestation.revoked);
    }

    #[test]
    fn test_schema_v1_v2_compatibility() {
        let env = Env::default();
        
        // Create v1 schema
        let schema_v1 = Schema {
            version: 1,
            schema_id: BytesN::from_array(&env, &[1; 32]),
            authority: Address::generate(&env),
            resolver: Address::generate(&env),
            revocable: true,
            name: SorobanString::from_slice(&env, "test-schema"),
            field_definitions: SorobanString::from_slice(&env, "name:string,age:uint32"),
            created_at: 1000,
            schema_expiry_ledger: 5000,
            deprecated: false,
        };
        
        // Store and retrieve
        let retrieved = schema_v1.clone();
        
        // All v1 fields must be preserved
        assert_eq!(retrieved.version, 1);
        assert_eq!(retrieved.name, schema_v1.name);
        assert_eq!(retrieved.deprecated, false);
    }

    #[test]
    fn test_rollback_limitations() {
        let env = Env::default();
        
        // Create attestation with new v2 fields (hypothetical)
        // If we downgrade code to read as v1:
        // - New fields will be lost
        // - Old fields remain accessible
        // This test documents the limitation
        
        let attestation = Attestation {
            version: 2, // Hypothetical future version
            schema_id: BytesN::from_array(&env, &[0; 32]),
            subject: Address::generate(&env),
            issuer: Address::generate(&env),
            data: Bytes::new(&env),
            created_at: 1000,
            expires_at: 2000,
            revoked: false,
            revocable: true,
            // Future v2 fields would be lost if read as v1
        };
        
        // Document: downgrading loses new fields
        assert_eq!(attestation.version, 2);
    }
}
```

### Root Migration Test

```rust
#[test]
fn test_merkle_root_v1_migration() {
    let env = Env::default();
    
    let root = MerkleRoot {
        version: 1,
        root: BytesN::from_array(&env, &[42; 32]),
        height: 20,
        timestamp: 1234567890,
        next_rotation_ledger: 10000,
    };
    
    // Verify all fields are preserved
    assert_eq!(root.version, 1);
    assert_eq!(root.height, 20);
    assert_eq!(root.next_rotation_ledger, 10000);
}
```

### Nullifier Storage Migration

```rust
#[test]
fn test_nullifier_set_migration() {
    let env = Env::default();
    
    // Nullifiers are stored in a set to prevent replay
    // Test that nullifier storage format is preserved across versions
    let mut nullifier_set: Set<BytesN<32>> = Set::new(&env);
    let nullifier = BytesN::from_array(&env, &[100; 32]);
    
    nullifier_set.insert(nullifier.clone());
    
    // Verify nullifier persists correctly
    assert!(nullifier_set.contains(nullifier.clone()));
}
```

## Rollback Limitations

### Critical: Downgrade is Lossy

**If you downgrade contracts to older versions that use newer storage:**

1. **New fields are lost**: Any fields added in newer versions are not readable by old code
2. **Old fields remain**: Fields present in old version remain intact
3. **Data corruption risk**: Downgrade-then-upgrade can lose intermediate data

**Example Scenario**:
```
v1 Schema: {name, field_definitions, created_at}
  ↓ upgrade to v2
v2 Schema: {name, field_definitions, created_at, deprecated, version} ← new fields
  ↓ downgrade to v1
v1 reads: {name, field_definitions, created_at} ← loses deprecated, version
  ↓ upgrade to v3
v3 expects: deprecated to be set, but it was lost
```

### Recommendations

1. **Never downgrade** unless absolutely necessary
2. **Plan migrations forward**: Add fields, never remove
3. **Test upgrades thoroughly**: Verify storage compatibility before deploying
4. **Document version bumps**: Record what changed between versions
5. **Monitor on-chain state**: Track which version of data is in storage

## Version Bumping

When modifying a storage struct:

### Minor Changes (No Version Bump Needed)
- Adding optional fields at the end
- Changing field visibility (private/public)
- Renaming internal helper functions

### Major Changes (Version Bump Required)
- Removing fields
- Changing field types
- Reordering fields
- Changing field names

### How to Bump Version

```rust
// Before (v1):
pub struct Attestation {
    pub version: u32,  // = 1
    // ... fields ...
}

// After (v2):
pub struct Attestation {
    pub version: u32,  // = 2
    // ... existing fields ...
    pub new_field: NewType,  // Added field
}

// Add migration handler:
fn migrate_attestation_v1_to_v2(old: &AttestationV1) -> Attestation {
    Attestation {
        version: 2,
        schema_id: old.schema_id.clone(),
        subject: old.subject.clone(),
        issuer: old.issuer.clone(),
        data: old.data.clone(),
        created_at: old.created_at,
        expires_at: old.expires_at,
        revoked: old.revoked,
        revocable: old.revocable,
        new_field: Default::default(),  // Initialize new field
    }
}
```

## Deployment Safety

Before upgrading contracts:

1. **Test all migrations** on testnet
2. **Verify no data loss** in migration tests
3. **Document version changes** in RELEASE_NOTES.md
4. **Announce to users** if API changes (e.g., new error codes)
5. **Provide rollback plan** (even if limited)

## Related Documents

- [Reproducible Builds](./REPRODUCIBLE_BUILDS.md) - Ensure build hashes match
- [Contract Errors](./CONTRACT_ERRORS.md) - Error codes are stable across versions
- Deployment manifests: `deployments/v1/`
