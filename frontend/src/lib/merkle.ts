/**
 * Poseidon Merkle tree utilities.
 *
 * Complexity: O(depth) time and space — 1 hash per level for zero-hashes,
 * plus 1 hash per level along the proof path.
 */

export type PoseidonFn = (inputs: bigint[]) => bigint;

export type MerkleProof = {
  root: bigint;
  /** Siblings from leaf level (i=0) up to root-1 (i=depth-1). */
  path: bigint[];
  /** 0 = current node is left child, 1 = right child at each level. */
  pathIndices: number[];
};

/**
 * Precompute empty-subtree hashes for a Poseidon Merkle tree.
 *
 *   zeroHashes[0] = 0n                              (empty leaf)
 *   zeroHashes[i] = ph([zeroHashes[i-1], zeroHashes[i-1]])  (empty subtree at height i)
 *
 * Returns depth+1 entries so zeroHashes[depth] is the root of an all-zero tree.
 */
export function buildZeroHashes(depth: number, ph: PoseidonFn): bigint[] {
  const z: bigint[] = [0n];
  for (let i = 0; i < depth; i++) z.push(ph([z[i], z[i]]));
  return z;
}

/**
 * Build a membership proof for a single leaf at index 0 in a sparse
 * Poseidon Merkle tree of the given depth.
 *
 * All siblings are zero-hashes (empty subtrees). The leaf is always a left
 * child at every level (index = 0b00…0). O(depth) time and space.
 */
export function buildSingleLeafMerkleTree(
  leaf: bigint,
  depth: number,
  ph: PoseidonFn
): MerkleProof {
  const zeroHashes = buildZeroHashes(depth, ph);
  const path: bigint[] = [];
  const pathIndices: number[] = [];
  let current = leaf;
  for (let i = 0; i < depth; i++) {
    path.push(zeroHashes[i]);  // sibling = empty subtree at height i
    pathIndices.push(0);       // leaf is always the left child
    current = ph([current, zeroHashes[i]]);
  }
  return { root: current, path, pathIndices };
}
