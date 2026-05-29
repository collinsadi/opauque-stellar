//! # Light-Client Poseidon Merkle Tree
//!
//! In-memory Merkle tree using Poseidon hashing for generating inclusion proofs
//! locally. Designed for the browser extension: fixed-depth, lazy allocation,
//! low memory footprint.
//!
//! The tree indexes stealth attestation announcements so the user can produce
//! a Merkle path for the ZK-attestation circuit without contacting a server.

use num_bigint::BigUint;
use scalarff::{Bn128FieldElement, FieldElement};
use serde::{Deserialize, Serialize};

// =============================================================================
// Circomlib-compatible Poseidon hash over the BN254 scalar field.
// =============================================================================

fn poseidon_hash_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    poseidon_hash_fields(&[*left, *right])
}

fn poseidon_hash_leaf(data: &[u8]) -> [u8; 32] {
    poseidon_hash_fields(&[bytes_to_field(data)])
}

pub fn poseidon_hash_fields(inputs: &[[u8; 32]]) -> [u8; 32] {
    let fields = inputs.iter().map(field_from_be_bytes).collect::<Vec<_>>();
    let hash = poseidon_bn128::poseidon(inputs.len() as u8, &fields)
        .expect("Poseidon input arity must be supported by circomlib");
    field_to_be_bytes(hash)
}

pub fn field_string_to_bytes(input: &str) -> Result<[u8; 32], String> {
    let trimmed = input.trim();
    let value = if let Some(hex) = trimmed.strip_prefix("0x") {
        BigUint::parse_bytes(hex.as_bytes(), 16)
    } else {
        BigUint::parse_bytes(trimmed.as_bytes(), 10)
    }
    .ok_or_else(|| format!("invalid BN254 field element: {input}"))?;

    Ok(field_to_be_bytes(Bn128FieldElement::from_biguint(&value)))
}

fn bytes_to_field(data: &[u8]) -> [u8; 32] {
    field_to_be_bytes(Bn128FieldElement::from_biguint(&BigUint::from_bytes_be(
        data,
    )))
}

fn field_from_be_bytes(bytes: &[u8; 32]) -> Bn128FieldElement {
    Bn128FieldElement::from_biguint(&BigUint::from_bytes_be(bytes))
}

fn field_to_be_bytes(field: Bn128FieldElement) -> [u8; 32] {
    let bytes = field.to_biguint().to_bytes_be();
    let mut out = [0u8; 32];
    let start = 32usize.saturating_sub(bytes.len());
    out[start..].copy_from_slice(&bytes[bytes.len().saturating_sub(32)..]);
    out
}

// =============================================================================
// Merkle tree
// =============================================================================

const ZERO_LEAF: [u8; 32] = [0u8; 32];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MerkleError {
    TreeFull { capacity: usize, count: usize },
    IndexOutOfBounds { index: usize, count: usize },
}

impl std::fmt::Display for MerkleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MerkleError::TreeFull { capacity, count } => {
                write!(f, "Merkle tree is full: capacity={capacity}, count={count}")
            }
            MerkleError::IndexOutOfBounds { index, count } => {
                write!(f, "Merkle proof index {index} out of bounds (leaf count={count})")
            }
        }
    }
}

impl std::error::Error for MerkleError {}

/// Merkle inclusion proof for the ZK circuit.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MerkleProof {
    pub leaf: [u8; 32],
    pub path_elements: Vec<[u8; 32]>,
    pub path_indices: Vec<u8>,
    pub root: [u8; 32],
}

/// Fixed-depth Poseidon Merkle tree. Leaves are inserted sequentially.
/// Capacity = 2^depth.
pub struct MerkleTree {
    depth: usize,
    leaves: Vec<[u8; 32]>,
    /// Pre-computed zero hashes for each level (hash of empty subtrees).
    zero_hashes: Vec<[u8; 32]>,
}

impl MerkleTree {
    pub fn new(depth: usize) -> Self {
        let mut zero_hashes = Vec::with_capacity(depth + 1);
        zero_hashes.push(ZERO_LEAF);
        for i in 0..depth {
            let prev = zero_hashes[i];
            zero_hashes.push(poseidon_hash_pair(&prev, &prev));
        }
        MerkleTree {
            depth,
            leaves: Vec::new(),
            zero_hashes,
        }
    }

    pub fn capacity(&self) -> usize {
        1 << self.depth
    }

    pub fn leaf_count(&self) -> usize {
        self.leaves.len()
    }

    /// Insert a raw leaf (will be hashed internally).
    pub fn insert_raw(&mut self, data: &[u8]) -> Result<usize, MerkleError> {
        let leaf = poseidon_hash_leaf(data);
        self.insert(leaf)
    }

    /// Insert a pre-hashed leaf.
    pub fn insert(&mut self, leaf: [u8; 32]) -> Result<usize, MerkleError> {
        if self.leaves.len() >= self.capacity() {
            return Err(MerkleError::TreeFull {
                capacity: self.capacity(),
                count: self.leaves.len(),
            });
        }
        let idx = self.leaves.len();
        self.leaves.push(leaf);
        Ok(idx)
    }

    pub fn insert_v2_leaf(
        &mut self,
        stealth_pk: [u8; 32],
        schema_id: [u8; 32],
        issuer_pk_x: [u8; 32],
        trait_data_hash: [u8; 32],
        nonce: [u8; 32],
    ) -> Result<usize, MerkleError> {
        self.insert(poseidon_hash_fields(&[
            stealth_pk,
            schema_id,
            issuer_pk_x,
            trait_data_hash,
            nonce,
        ]))
    }

    /// Compute the Merkle root. Recomputes from scratch (acceptable for < 1M leaves in WASM).
    pub fn root(&self) -> [u8; 32] {
        self.compute_root_from(0, self.depth)
    }

    fn compute_root_from(&self, start_leaf_idx: usize, level: usize) -> [u8; 32] {
        if level == 0 {
            return if start_leaf_idx < self.leaves.len() {
                self.leaves[start_leaf_idx]
            } else {
                self.zero_hashes[0]
            };
        }
        let half = 1 << (level - 1);
        let left = self.compute_root_from(start_leaf_idx, level - 1);
        let right = self.compute_root_from(start_leaf_idx + half, level - 1);
        poseidon_hash_pair(&left, &right)
    }

    /// Generate an inclusion proof for the leaf at `index`.
    pub fn proof(&self, index: usize) -> Result<MerkleProof, MerkleError> {
        if index >= self.leaves.len() {
            return Err(MerkleError::IndexOutOfBounds {
                index,
                count: self.leaves.len(),
            });
        }

        let mut path_elements = Vec::with_capacity(self.depth);
        let mut path_indices = Vec::with_capacity(self.depth);

        let mut current_idx = index;
        for level in 0..self.depth {
            let sibling_idx = current_idx ^ 1;
            let sibling = self.get_node(sibling_idx, level);
            path_elements.push(sibling);
            path_indices.push((current_idx & 1) as u8);
            current_idx >>= 1;
        }

        Ok(MerkleProof {
            leaf: self.leaves[index],
            path_elements,
            path_indices,
            root: self.root(),
        })
    }

    fn get_node(&self, index: usize, level: usize) -> [u8; 32] {
        if level == 0 {
            return if index < self.leaves.len() {
                self.leaves[index]
            } else {
                self.zero_hashes[0]
            };
        }
        let half = 1 << (level - 1);
        let start = index * (1 << level);
        let left = self.get_node(start, 0);
        let _ = half;
        self.compute_root_from(start, level)
    }

    /// Verify a proof against a given root.
    pub fn verify_proof(proof: &MerkleProof) -> bool {
        let mut current = proof.leaf;
        for i in 0..proof.path_elements.len() {
            if proof.path_indices[i] == 0 {
                current = poseidon_hash_pair(&current, &proof.path_elements[i]);
            } else {
                current = poseidon_hash_pair(&proof.path_elements[i], &current);
            }
        }
        current == proof.root
    }
}

// =============================================================================
// Witness data for the Circom circuit
// =============================================================================

/// Complete witness for the StealthAttestation circuit.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CircuitWitness {
    pub merkle_root: String,
    pub attestation_id: String,
    pub external_nullifier: String,
    pub stealth_private_key: String,
    pub ephemeral_pubkey: [String; 2],
    pub announcement_attestation_id: String,
    pub merkle_path_elements: Vec<String>,
    pub merkle_path_indices: Vec<u8>,
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn decimal_bytes(value: &str) -> [u8; 32] {
        field_string_to_bytes(value).unwrap()
    }

    #[test]
    fn poseidon_pair_matches_circomlib_vector() {
        let actual = poseidon_hash_fields(&[decimal_bytes("1"), decimal_bytes("2")]);
        let expected = decimal_bytes(
            "7853200120776062878684798364095072458815029376092732009249414926327459813530",
        );
        assert_eq!(actual, expected);
    }

    #[test]
    fn zero_hash_level_one_matches_circomlib_vector() {
        let actual = poseidon_hash_fields(&[decimal_bytes("0"), decimal_bytes("0")]);
        let expected = decimal_bytes(
            "14744269619966411208579211824598458697587494354926760081771325075741142829156",
        );
        assert_eq!(actual, expected);
    }

    #[test]
    fn v2_leaf_hash_is_poseidon_five() {
        let leaf = poseidon_hash_fields(&[
            decimal_bytes("1"),
            decimal_bytes("2"),
            decimal_bytes("3"),
            decimal_bytes("4"),
            decimal_bytes("5"),
        ]);
        let mut tree = MerkleTree::new(2);
        let idx = tree.insert_v2_leaf(
            decimal_bytes("1"),
            decimal_bytes("2"),
            decimal_bytes("3"),
            decimal_bytes("4"),
            decimal_bytes("5"),
        ).unwrap();
        assert_eq!(idx, 0);
        assert_eq!(tree.leaves[0], leaf);
    }

    #[test]
    fn empty_tree_root_is_deterministic() {
        let t1 = MerkleTree::new(4);
        let t2 = MerkleTree::new(4);
        assert_eq!(t1.root(), t2.root());
    }

    #[test]
    fn insert_changes_root() {
        let mut tree = MerkleTree::new(4);
        let root_empty = tree.root();
        tree.insert_raw(b"hello").unwrap();
        assert_ne!(root_empty, tree.root());
    }

    #[test]
    fn proof_verifies() {
        let mut tree = MerkleTree::new(4);
        tree.insert_raw(b"leaf_0").unwrap();
        tree.insert_raw(b"leaf_1").unwrap();
        tree.insert_raw(b"leaf_2").unwrap();

        let proof = tree.proof(1).unwrap();
        assert!(MerkleTree::verify_proof(&proof));
    }

    #[test]
    fn full_path_recomputes_circom_ordered_root() {
        let mut tree = MerkleTree::new(2);
        tree.insert(decimal_bytes("1")).unwrap();
        tree.insert(decimal_bytes("2")).unwrap();
        tree.insert(decimal_bytes("3")).unwrap();

        let proof = tree.proof(2).unwrap();
        let mut current = proof.leaf;
        for (sibling, index) in proof.path_elements.iter().zip(proof.path_indices.iter()) {
            current = if *index == 0 {
                poseidon_hash_fields(&[current, *sibling])
            } else {
                poseidon_hash_fields(&[*sibling, current])
            };
        }

        assert_eq!(current, tree.root());
        assert_eq!(current, proof.root);
    }

    #[test]
    fn tampered_proof_fails() {
        let mut tree = MerkleTree::new(4);
        tree.insert_raw(b"leaf_0").unwrap();
        tree.insert_raw(b"leaf_1").unwrap();

        let mut proof = tree.proof(0).unwrap();
        proof.leaf = [0xFF; 32];
        assert!(!MerkleTree::verify_proof(&proof));
    }

    #[test]
    fn single_leaf_tree() {
        let mut tree = MerkleTree::new(2);
        tree.insert_raw(b"only").unwrap();
        let proof = tree.proof(0).unwrap();
        assert!(MerkleTree::verify_proof(&proof));
    }

    #[test]
    fn insert_full_tree_returns_error() {
        let mut tree = MerkleTree::new(1);
        tree.insert([1u8; 32]).unwrap();
        let result = tree.insert([2u8; 32]);
        assert!(matches!(result, Err(MerkleError::TreeFull { capacity: 2, count: 2 })));
    }

    #[test]
    fn proof_out_of_bounds_returns_error() {
        let tree = MerkleTree::new(2);
        let result = tree.proof(0);
        assert!(matches!(result, Err(MerkleError::IndexOutOfBounds { index: 0, count: 0 })));
    }
}
