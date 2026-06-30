/**
 * BabyJubJub / BN254 curve test vectors.
 *
 * Validates the TypeScript side against the known-good vectors in
 * circuits/fixtures/babyjubjub-vectors.json.
 *
 * Source attribution: circomlib BabyJubJub (https://github.com/iden3/circomlib)
 *
 * Implements the twisted Edwards addition formula directly in bigint arithmetic
 * so the test has zero external dependencies and runs entirely in Vitest.
 *
 * Curve: ax² + y² = 1 + dx²y²  over BN254 scalar field
 *   p = 21888242871839275222246405745257275088548364400416034343698204186575808495617
 *   a = 168700
 *   d = 168696
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Load vectors
// ---------------------------------------------------------------------------

const VECTORS_PATH = join(
  __dirname,
  "../../../../circuits/fixtures/babyjubjub-vectors.json",
);

interface Point {
  x: string;
  y: string;
}

interface AdditionVector {
  id: string;
  description: string;
  inputA: Point;
  inputB: Point;
  expected: Point;
}

interface ScalarVector {
  id: string;
  description: string;
  scalar: string;
  point: Point;
  expected: Point;
}

interface Vectors {
  source: string;
  curve: string;
  description: string;
  basePoint: Point;
  pointAddition: AdditionVector[];
  scalarMultiplication: ScalarVector[];
}

const vectors: Vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf-8"));

// ---------------------------------------------------------------------------
// BabyJubJub curve parameters (BN254 twisted Edwards)
// ---------------------------------------------------------------------------

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const A = 168700n;
const D = 168696n;

// ---------------------------------------------------------------------------
// Bigint modular arithmetic
// ---------------------------------------------------------------------------

function mod(n: bigint, m: bigint = P): bigint {
  return ((n % m) + m) % m;
}

/** Extended Euclidean algorithm — returns [gcd, x, y] with ax+by=gcd. */
function extGcd(a: bigint, b: bigint): [bigint, bigint, bigint] {
  if (b === 0n) return [a, 1n, 0n];
  const [g, x1, y1] = extGcd(b, mod(a, b));
  return [g, y1, x1 - (a / b) * y1];
}

/** Modular inverse of `n` mod `P` (P is prime so inverse always exists for n≠0). */
function modInv(n: bigint): bigint {
  const [, x] = extGcd(mod(n), P);
  return mod(x);
}

// ---------------------------------------------------------------------------
// Twisted Edwards point addition
//
// Given P1 = (x1, y1) and P2 = (x2, y2):
//   x3 = (x1*y2 + y1*x2) / (1 + d*x1*x2*y1*y2)   (mod P)
//   y3 = (y1*y2 - a*x1*x2) / (1 - d*x1*x2*y1*y2)  (mod P)
// ---------------------------------------------------------------------------

function pointAdd(
  p1: { x: bigint; y: bigint },
  p2: { x: bigint; y: bigint },
): { x: bigint; y: bigint } {
  const { x: x1, y: y1 } = p1;
  const { x: x2, y: y2 } = p2;

  const x1y2 = mod(x1 * y2);
  const y1x2 = mod(y1 * x2);
  const y1y2 = mod(y1 * y2);
  const ax1x2 = mod(A * x1 * x2);
  const dx1x2y1y2 = mod(D * x1 * x2 * y1 * y2);

  const x3Num = mod(x1y2 + y1x2);
  const x3Den = mod(1n + dx1x2y1y2);
  const y3Num = mod(y1y2 - ax1x2);
  const y3Den = mod(1n - dx1x2y1y2);

  return {
    x: mod(x3Num * modInv(x3Den)),
    y: mod(y3Num * modInv(y3Den)),
  };
}

/**
 * Scalar multiplication via double-and-add.
 *
 * Identity element on twisted Edwards is (0, 1).
 */
function scalarMul(
  scalar: bigint,
  point: { x: bigint; y: bigint },
): { x: bigint; y: bigint } {
  let result = { x: 0n, y: 1n }; // additive identity
  let current = { ...point };
  let k = scalar;

  while (k > 0n) {
    if (k & 1n) {
      result = pointAdd(result, current);
    }
    current = pointAdd(current, current);
    k >>= 1n;
  }
  return result;
}

function ptFromJson(p: Point): { x: bigint; y: bigint } {
  return { x: BigInt(p.x), y: BigInt(p.y) };
}

// ---------------------------------------------------------------------------
// Tests — attributed to circomlib source
// ---------------------------------------------------------------------------

describe(`BabyJubJub test vectors — ${vectors.source}`, () => {
  describe("pointAddition", () => {
    for (const vec of vectors.pointAddition) {
      it(`${vec.id}: ${vec.description}`, () => {
        const a = ptFromJson(vec.inputA);
        const b = ptFromJson(vec.inputB);
        const got = pointAdd(a, b);
        const exp = ptFromJson(vec.expected);
        expect(got.x).toBe(exp.x);
        expect(got.y).toBe(exp.y);
      });
    }
  });

  describe("scalarMultiplication", () => {
    for (const vec of vectors.scalarMultiplication) {
      it(`${vec.id}: ${vec.description}`, () => {
        const scalar = BigInt(vec.scalar);
        const point = ptFromJson(vec.point);
        const got = scalarMul(scalar, point);
        const exp = ptFromJson(vec.expected);
        expect(got.x).toBe(exp.x);
        expect(got.y).toBe(exp.y);
      });
    }
  });

  describe("curve parameters sanity", () => {
    it("base point is on the curve (a*x^2 + y^2 === 1 + d*x^2*y^2 mod P)", () => {
      const G = ptFromJson(vectors.basePoint);
      const lhs = mod(mod(A * G.x * G.x) + mod(G.y * G.y));
      const rhs = mod(1n + mod(D * G.x * G.x * G.y * G.y));
      expect(lhs).toBe(rhs);
    });

    it("2*G from scalarMul matches pointAdd(G, G)", () => {
      const G = ptFromJson(vectors.basePoint);
      const doubled = pointAdd(G, G);
      const scalar2 = scalarMul(2n, G);
      expect(doubled.x).toBe(scalar2.x);
      expect(doubled.y).toBe(scalar2.y);
    });
  });
});
