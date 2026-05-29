//! Canonical schema field definitions and attestation payload encoding.
//!
//! Shared by Soroban contracts and off-chain tooling (frontend, tests).
//! See `docs/canonical-schema-encoding.md` for the wire format.

#![no_std]

extern crate alloc;

use alloc::string::String;
use alloc::vec::Vec;
use sha2::{Digest, Sha256};

pub const MAX_FIELDS: usize = 16;
pub const MAX_FIELD_NAME_LEN: usize = 32;
pub const MAX_FIELD_DEFS_STR_LEN: usize = 256;
pub const MAX_STRING_VALUE_LEN: usize = 128;
pub const MAX_ATTESTATION_DATA_LEN: usize = 512;

/// Supported field types (wire enum values match `type` byte in canonical encoding).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum FieldType {
    Bool = 0,
    U8 = 1,
    U16 = 2,
    U32 = 3,
    U64 = 4,
    String = 5,
    Pubkey = 6,
}

impl FieldType {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "bool" => Some(Self::Bool),
            "u8" => Some(Self::U8),
            "u16" => Some(Self::U16),
            "u32" => Some(Self::U32),
            "u64" => Some(Self::U64),
            "string" => Some(Self::String),
            "pubkey" => Some(Self::Pubkey),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bool => "bool",
            Self::U8 => "u8",
            Self::U16 => "u16",
            Self::U32 => "u32",
            Self::U64 => "u64",
            Self::String => "string",
            Self::Pubkey => "pubkey",
        }
    }

    pub fn fixed_width(self) -> Option<usize> {
        match self {
            Self::Bool => Some(1),
            Self::U8 => Some(1),
            Self::U16 => Some(2),
            Self::U32 => Some(4),
            Self::U64 => Some(8),
            Self::Pubkey => Some(32),
            Self::String => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FieldDef {
    pub name: String,
    pub ty: FieldType,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SchemaParseError {
    Empty,
    TooManyFields,
    FieldNameEmpty,
    FieldNameTooLong,
    InvalidFieldName,
    DuplicateFieldName,
    InvalidFieldType,
    DefsTooLong,
    MalformedSegment,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttestationDataError {
    TooShort,
    TooLarge,
    TrailingBytes,
    StringTooLong,
    InvalidBool,
    InvalidInteger,
    InvalidPubkey,
}

/// Returns true if `c` is allowed in a field name (ASCII letter, digit, underscore).
fn is_name_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

/// Field names must be 1..=32 chars, start with letter or `_`, and use [a-zA-Z0-9_].
pub fn validate_field_name(name: &str) -> Result<(), SchemaParseError> {
    if name.is_empty() {
        return Err(SchemaParseError::FieldNameEmpty);
    }
    if name.len() > MAX_FIELD_NAME_LEN {
        return Err(SchemaParseError::FieldNameTooLong);
    }
    let bytes = name.as_bytes();
    let first = bytes[0];
    if !(first.is_ascii_alphabetic() || first == b'_') {
        return Err(SchemaParseError::InvalidFieldName);
    }
    if !bytes.iter().all(|&b| is_name_char(b)) {
        return Err(SchemaParseError::InvalidFieldName);
    }
    Ok(())
}

/// Parses comma-separated `"type name"` segments (canonical human form).
pub fn parse_field_definitions(input: &str) -> Result<Vec<FieldDef>, SchemaParseError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(SchemaParseError::Empty);
    }
    let mut fields = Vec::new();
    for segment in trimmed.split(',') {
        let seg = segment.trim();
        if seg.is_empty() {
            return Err(SchemaParseError::MalformedSegment);
        }
        let space_idx = seg.find(' ').ok_or(SchemaParseError::MalformedSegment)?;
        let type_str = seg[..space_idx].trim();
        let name = seg[space_idx + 1..].trim();
        if name.contains(' ') {
            return Err(SchemaParseError::MalformedSegment);
        }
        let ty = FieldType::from_str(type_str).ok_or(SchemaParseError::InvalidFieldType)?;
        validate_field_name(name)?;
        if fields.iter().any(|f: &FieldDef| f.name == name) {
            return Err(SchemaParseError::DuplicateFieldName);
        }
        fields.push(FieldDef {
            name: String::from(name),
            ty,
        });
        if fields.len() > MAX_FIELDS {
            return Err(SchemaParseError::TooManyFields);
        }
    }
    let canonical = field_defs_to_canonical_string(&fields);
    if canonical.len() > MAX_FIELD_DEFS_STR_LEN {
        return Err(SchemaParseError::DefsTooLong);
    }
    Ok(fields)
}

/// Canonical human-readable form: `"type name"` comma-separated, no extra spaces.
pub fn field_defs_to_canonical_string(fields: &[FieldDef]) -> String {
    let mut parts = Vec::with_capacity(fields.len());
    for f in fields {
        parts.push(alloc::format!("{} {}", f.ty.as_str(), f.name));
    }
    parts.join(",")
}

/// Canonical binary encoding of field definitions (hashed into schema ID).
///
/// Layout: `field_count: u8` then for each field: `type: u8`, `name_len: u8`, `name: [name_len]`.
pub fn encode_canonical_field_defs(fields: &[FieldDef]) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(fields.len() as u8);
    for f in fields {
        out.push(f.ty as u8);
        let name_bytes = f.name.as_bytes();
        out.push(name_bytes.len() as u8);
        out.extend_from_slice(name_bytes);
    }
    out
}

/// `SHA-256(authority_bytes || name_utf8 || version_be_u32 || canonical_field_defs_bytes)`.
pub fn derive_schema_id(
    authority_bytes: &[u8; 32],
    name: &str,
    version: u32,
    canonical_field_defs: &[u8],
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(authority_bytes);
    hasher.update(name.as_bytes());
    hasher.update(version.to_be_bytes());
    hasher.update(canonical_field_defs);
    hasher.finalize().into()
}

/// Encodes attestation payload from UTF-8 string values (frontend / tooling).
pub fn encode_attestation_data_from_strings(
    fields: &[FieldDef],
    values: &[(&str, &str)],
) -> Result<Vec<u8>, AttestationDataError> {
    let mut out = Vec::new();
    for field in fields {
        let value = values
            .iter()
            .find(|(n, _)| *n == field.name.as_str())
            .map(|(_, v)| *v)
            .unwrap_or("");
        encode_field_value(&mut out, field.ty, value)?;
    }
    if out.len() > MAX_ATTESTATION_DATA_LEN {
        return Err(AttestationDataError::TooLarge);
    }
    Ok(out)
}

fn encode_field_value(
    out: &mut Vec<u8>,
    ty: FieldType,
    value: &str,
) -> Result<(), AttestationDataError> {
    match ty {
        FieldType::Bool => {
            let b = parse_bool(value)?;
            out.push(if b { 1 } else { 0 });
        }
        FieldType::U8 => out.push(parse_u64(value, 0, u8::MAX as u64)? as u8),
        FieldType::U16 => {
            let v = parse_u64(value, 0, u16::MAX as u64)? as u16;
            out.extend_from_slice(&v.to_be_bytes());
        }
        FieldType::U32 => {
            let v = parse_u64(value, 0, u32::MAX as u64)? as u32;
            out.extend_from_slice(&v.to_be_bytes());
        }
        FieldType::U64 => {
            let v = parse_u64(value, 0, u64::MAX)?;
            out.extend_from_slice(&v.to_be_bytes());
        }
        FieldType::String => {
            let bytes = value.as_bytes();
            if bytes.len() > MAX_STRING_VALUE_LEN {
                return Err(AttestationDataError::StringTooLong);
            }
            let len = bytes.len() as u16;
            out.extend_from_slice(&len.to_be_bytes());
            out.extend_from_slice(bytes);
        }
        FieldType::Pubkey => {
            let pk = parse_pubkey_hex(value)?;
            out.extend_from_slice(&pk);
        }
    }
    Ok(())
}

/// Validates that `data` is a well-formed payload for `fields` (on-chain check).
pub fn validate_attestation_data(fields: &[FieldDef], data: &[u8]) -> Result<(), AttestationDataError> {
    if data.len() > MAX_ATTESTATION_DATA_LEN {
        return Err(AttestationDataError::TooLarge);
    }
    let mut offset = 0usize;
    for field in fields {
        offset = read_field_value(field.ty, data, offset)?;
    }
    if offset != data.len() {
        return Err(AttestationDataError::TrailingBytes);
    }
    Ok(())
}

fn read_field_value(ty: FieldType, data: &[u8], mut offset: usize) -> Result<usize, AttestationDataError> {
    match ty {
        FieldType::Bool => {
            if offset >= data.len() {
                return Err(AttestationDataError::TooShort);
            }
            let b = data[offset];
            if b > 1 {
                return Err(AttestationDataError::InvalidBool);
            }
            Ok(offset + 1)
        }
        FieldType::U8 => {
            if offset >= data.len() {
                return Err(AttestationDataError::TooShort);
            }
            Ok(offset + 1)
        }
        FieldType::U16 => read_fixed(data, offset, 2),
        FieldType::U32 => read_fixed(data, offset, 4),
        FieldType::U64 => read_fixed(data, offset, 8),
        FieldType::String => {
            if offset + 2 > data.len() {
                return Err(AttestationDataError::TooShort);
            }
            let len = u16::from_be_bytes([data[offset], data[offset + 1]]) as usize;
            offset += 2;
            if offset + len > data.len() {
                return Err(AttestationDataError::TooShort);
            }
            if len > MAX_STRING_VALUE_LEN {
                return Err(AttestationDataError::StringTooLong);
            }
            Ok(offset + len)
        }
        FieldType::Pubkey => read_fixed(data, offset, 32),
    }
}

fn read_fixed(data: &[u8], offset: usize, len: usize) -> Result<usize, AttestationDataError> {
    if offset + len > data.len() {
        return Err(AttestationDataError::TooShort);
    }
    Ok(offset + len)
}

fn parse_bool(s: &str) -> Result<bool, AttestationDataError> {
    match s.trim() {
        "true" | "1" => Ok(true),
        "false" | "0" | "" => Ok(false),
        _ => Err(AttestationDataError::InvalidBool),
    }
}

fn parse_u64(s: &str, min: u64, max: u64) -> Result<u64, AttestationDataError> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return Ok(0);
    }
    let mut n: u64 = 0;
    for c in trimmed.bytes() {
        if !c.is_ascii_digit() {
            return Err(AttestationDataError::InvalidInteger);
        }
        n = n
            .checked_mul(10)
            .and_then(|v| v.checked_add((c - b'0') as u64))
            .ok_or(AttestationDataError::InvalidInteger)?;
    }
    if n < min || n > max {
        return Err(AttestationDataError::InvalidInteger);
    }
    Ok(n)
}

fn parse_pubkey_hex(s: &str) -> Result<[u8; 32], AttestationDataError> {
    let hex_str = s.trim().strip_prefix("0x").unwrap_or(s.trim());
    if hex_str.len() != 64 {
        return Err(AttestationDataError::InvalidPubkey);
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        let hi = hex_char(hex_str.as_bytes()[i * 2])?;
        let lo = hex_char(hex_str.as_bytes()[i * 2 + 1])?;
        out[i] = (hi << 4) | lo;
    }
    Ok(out)
}

fn hex_char(c: u8) -> Result<u8, AttestationDataError> {
    match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        b'A'..=b'F' => Ok(c - b'A' + 10),
        _ => Err(AttestationDataError::InvalidPubkey),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_and_canonical_roundtrip() {
        let fields = parse_field_definitions("bool active, u32 score, string label").unwrap();
        assert_eq!(fields.len(), 3);
        assert_eq!(
            field_defs_to_canonical_string(&fields),
            "bool active,u32 score,string label"
        );
    }

    #[test]
    fn rejects_legacy_name_colon_type() {
        assert_eq!(
            parse_field_definitions("field1:string"),
            Err(SchemaParseError::MalformedSegment)
        );
    }

    #[test]
    fn rejects_invalid_type() {
        assert_eq!(
            parse_field_definitions("float x"),
            Err(SchemaParseError::InvalidFieldType)
        );
    }

    #[test]
    fn encode_validate_all_types() {
        let fields = parse_field_definitions("bool b,u8 n,u16 w,u32 x,u64 y,string s,pubkey p")
            .unwrap();
        let pk = "0x2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a";
        let data = encode_attestation_data_from_strings(
            &fields,
            &[
                ("b", "true"),
                ("n", "42"),
                ("w", "1000"),
                ("x", "99999"),
                ("y", "18446744073709551615"),
                ("s", "hello"),
                ("p", pk),
            ],
        )
        .unwrap();
        validate_attestation_data(&fields, &data).unwrap();
    }

    #[test]
    fn schema_id_includes_field_defs() {
        let authority = [0x2au8; 32];
        let fields = parse_field_definitions("string name").unwrap();
        let canon = encode_canonical_field_defs(&fields);
        let id_a = derive_schema_id(&authority, "MySchema", 1, &canon);
        let fields_b = parse_field_definitions("u32 name").unwrap();
        let canon_b = encode_canonical_field_defs(&fields_b);
        let id_b = derive_schema_id(&authority, "MySchema", 1, &canon_b);
        assert_ne!(id_a, id_b);
    }
}
