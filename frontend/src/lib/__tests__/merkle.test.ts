/**
 * Unit tests for the Poseidon Merkle tree utilities (Issue #94).
 *
 * Uses a deterministic mock hash (a*3 + b*7 + 1) so expected values can be
 * derived by hand. Real Poseidon cross-language vectors live in
 * cryptoTestVectors.test.ts.
 */

import { describe, it, expect } from "vitest";
import { buildZeroHashes, buildSingleLeafMerkleTree } from "../merkle";

/** Simple mock: ph([a, b]) = a*3n + b*7n + 1n */
const ph = (inputs: bigint[]): bigint =>
  inputs[0] * 3n + inputs[1] * 7n + 1n;

describe("buildZeroHashes", () => {
  it("zeroHashes[0] is always 0n (empty leaf)", () => {
    const z = buildZeroHashes(5, ph);
    expect(z[0]).toBe(0n);
  });

  it("zeroHashes[i] = ph([zeroHashes[i-1], zeroHashes[i-1]])", () => {
    const z = buildZeroHashes(4, ph);
    for (let i = 1; i <= 4; i++) {
      expect(z[i]).toBe(ph([z[i - 1], z[i - 1]]));
    }
  });

  it("returns depth+1 entries", () => {
    expect(buildZeroHashes(3, ph)).toHaveLength(4);
    expect(buildZeroHashes(20, ph)).toHaveLength(21);
  });

  it("each level is strictly derived from the previous (non-trivial at depth 3)", () => {
    const z = buildZeroHashes(3, ph);
    // z[0] = 0
    // z[1] = ph([0,0]) = 1
    // z[2] = ph([1,1]) = 3 + 7 + 1 = 11
    // z[3] = ph([11,11]) = 33 + 77 + 1 = 111
    expect(z[0]).toBe(0n);
    expect(z[1]).toBe(1n);
    expect(z[2]).toBe(11n);
    expect(z[3]).toBe(111n);
  });
});

describe("buildSingleLeafMerkleTree", () => {
  it("path and pathIndices have length = depth", () => {
    const { path, pathIndices } = buildSingleLeafMerkleTree(42n, 5, ph);
    expect(path).toHaveLength(5);
    expect(pathIndices).toHaveLength(5);
  });

  it("all path indices are 0 (leaf always at left)", () => {
    const { pathIndices } = buildSingleLeafMerkleTree(99n, 4, ph);
    expect(pathIndices.every((i) => i === 0)).toBe(true);
  });

  it("path siblings equal zero hashes at each level", () => {
    const depth = 4;
    const leaf = 5n;
    const z = buildZeroHashes(depth, ph);
    const { path } = buildSingleLeafMerkleTree(leaf, depth, ph);
    for (let i = 0; i < depth; i++) {
      expect(path[i]).toBe(z[i]);
    }
  });

  it("root is deterministic for the same leaf and depth", () => {
    const r1 = buildSingleLeafMerkleTree(7n, 3, ph).root;
    const r2 = buildSingleLeafMerkleTree(7n, 3, ph).root;
    expect(r1).toBe(r2);
  });

  it("different leaves produce different roots (non-trivial at depth 3)", () => {
    const { root: r1 } = buildSingleLeafMerkleTree(1n, 3, ph);
    const { root: r2 } = buildSingleLeafMerkleTree(2n, 3, ph);
    expect(r1).not.toBe(r2);
  });

  it("manual root derivation matches for leaf=5, depth=3", () => {
    // z = [0, 1, 11, 111]
    // level 0: sibling=0, current = ph([5,0]) = 15+0+1 = 16
    // level 1: sibling=1, current = ph([16,1]) = 48+7+1 = 56
    // level 2: sibling=11, current = ph([56,11]) = 168+77+1 = 246
    const { root, path, pathIndices } = buildSingleLeafMerkleTree(5n, 3, ph);
    expect(path).toEqual([0n, 1n, 11n]);
    expect(pathIndices).toEqual([0, 0, 0]);
    expect(root).toBe(246n);
  });

  it("zero leaf produces the all-zero tree root", () => {
    // When leaf=0, every node is a zero-hash, so root = zeroHashes[depth]
    const depth = 4;
    const z = buildZeroHashes(depth, ph);
    const { root } = buildSingleLeafMerkleTree(0n, depth, ph);
    expect(root).toBe(z[depth]);
  });
});
