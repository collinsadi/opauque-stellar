/**
 * Depth-20 Poseidon(2) Merkle tree for V2 reputation leaf commitments.
 *
 * Leaves are already field elements. They are produced client-side as:
 * Poseidon(stealth_pk, schema_id, issuer_pk_x, trait_data_hash, nonce).
 */
import { buildPoseidon } from "circomlibjs";
import { bigintToHex32 } from "./bytes.js";

export const TREE_DEPTH = 20;

let cachedPoseidon: any = null;
export async function getPoseidon(): Promise<any> {
  if (!cachedPoseidon) cachedPoseidon = await buildPoseidon();
  return cachedPoseidon;
}

export function hashFields(poseidon: any, inputs: bigint[]): bigint {
  return poseidon.F.toObject(poseidon(inputs));
}

export class MerkleTree {
  private readonly zero: bigint[];
  readonly leaves: bigint[] = [];

  constructor(private readonly poseidon: any, private readonly depth = TREE_DEPTH) {
    this.zero = [0n];
    for (let i = 0; i < depth; i += 1) {
      this.zero.push(hashFields(poseidon, [this.zero[i], this.zero[i]]));
    }
  }

  insert(leaf: bigint): number {
    if (this.leaves.length >= 1 << this.depth) throw new Error("reputation tree is full");
    this.leaves.push(leaf);
    return this.leaves.length - 1;
  }

  private rootFrom(start: number, level: number): bigint {
    if (start >= this.leaves.length) return this.zero[level];
    if (level === 0) return this.leaves[start];
    const half = 1 << (level - 1);
    const left = this.rootFrom(start, level - 1);
    const right = this.rootFrom(start + half, level - 1);
    return hashFields(this.poseidon, [left, right]);
  }

  root(): bigint {
    return this.rootFrom(0, this.depth);
  }

  rootHex(): string {
    return bigintToHex32(this.root());
  }

  private node(index: number, level: number): bigint {
    return this.rootFrom(index * (1 << level), level);
  }

  proof(index: number): { root: string; pathElements: string[]; pathIndices: number[] } {
    if (index < 0 || index >= this.leaves.length) {
      throw new Error(`leaf index ${index} out of bounds`);
    }
    const pathElements: string[] = [];
    const pathIndices: number[] = [];
    let cur = index;
    for (let level = 0; level < this.depth; level += 1) {
      pathElements.push(bigintToHex32(this.node(cur ^ 1, level)));
      pathIndices.push(cur & 1);
      cur >>= 1;
    }
    return { root: this.rootHex(), pathElements, pathIndices };
  }
}

export async function buildRoot(leaves: string[]): Promise<string> {
  const poseidon = await getPoseidon();
  const tree = new MerkleTree(poseidon);
  for (const leaf of leaves) tree.insert(BigInt(leaf));
  return tree.rootHex();
}

export async function buildProof(
  leaves: string[],
  leaf: string,
): Promise<{ root: string; leafIndex: number; pathElements: string[]; pathIndices: number[] }> {
  const poseidon = await getPoseidon();
  const tree = new MerkleTree(poseidon);
  const target = leaf.toLowerCase();
  let leafIndex = -1;
  for (const [idx, value] of leaves.entries()) {
    const normalized = value.toLowerCase();
    tree.insert(BigInt(normalized));
    if (normalized === target && leafIndex === -1) leafIndex = idx;
  }
  if (leafIndex === -1) throw new Error("leaf not found");
  return { leafIndex, ...tree.proof(leafIndex) };
}
