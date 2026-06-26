#!/usr/bin/env tsx
/**
 * CI validation script for BabyJubJub / BN254 test vectors.
 *
 * Reads circuits/fixtures/babyjubjub-vectors.json, implements the twisted
 * Edwards curve math in bigint, and validates every point-addition and
 * scalar-multiplication vector.
 *
 * Exit 0 on all-pass. Exit 1 with a descriptive error on any mismatch.
 *
 * Source: circomlib BabyJubJub (https://github.com/iden3/circomlib)
 *
 * Usage:
 *   npx tsx circuits/scripts/verify-babyjubjub-vectors.ts
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = join(__dirname, "..", "fixtures", "babyjubjub-vectors.json");

// ---------------------------------------------------------------------------
// Vector types
// ---------------------------------------------------------------------------

interface JsonPoint {
  x: string;
  y: string;
}

interface AdditionVector {
  id: string;
  description: string;
  inputA: JsonPoint;
  inputB: JsonPoint;
  expected: JsonPoint;
}

interface ScalarVector {
  id: string;
  description: string;
  scalar: string;
  point: JsonPoint;
  expected: JsonPoint;
}

interface VectorsFile {
  source: string;
  curve: string;
  description: string;
  basePoint: JsonPoint;
  pointAddition: AdditionVector[];
  scalarMultiplication: ScalarVector[];
}

// ---------------------------------------------------------------------------
// BabyJubJub curve parameters
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

function extGcd(a: bigint, b: bigint): [bigint, bigint, bigint] {
  if (b === 0n) return [a, 1n, 0n];
  const [g, x1, y1] = extGcd(b, mod(a, b));
  return [g, y1, x1 - (a / b) * y1];
}

function modInv(n: bigint): bigint {
  const [, x] = extGcd(mod(n), P);
  return mod(x);
}

// ---------------------------------------------------------------------------
// Twisted Edwards point addition
// ---------------------------------------------------------------------------

interface Point {
  x: bigint;
  y: bigint;
}

function pointAdd(p1: Point, p2: Point): Point {
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

function scalarMul(scalar: bigint, point: Point): Point {
  let result: Point = { x: 0n, y: 1n }; // identity
  let current: Point = { ...point };
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

function ptFromJson(p: JsonPoint): Point {
  return { x: BigInt(p.x), y: BigInt(p.y) };
}

// ---------------------------------------------------------------------------
// Main validation
// ---------------------------------------------------------------------------

let vectors: VectorsFile;
try {
  vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf-8")) as VectorsFile;
} catch (err) {
  console.error(`[FAIL] Could not read vectors file at ${VECTORS_PATH}: ${err}`);
  process.exit(1);
}

console.log(`\nValidating BabyJubJub vectors`);
console.log(`Source: ${vectors.source}`);
console.log(`Curve:  ${vectors.curve}\n`);

let failures = 0;

// ---------------------------------------------------------------------------
// Point addition vectors
// ---------------------------------------------------------------------------

console.log("--- Point Addition ---");
for (const vec of vectors.pointAddition) {
  const a = ptFromJson(vec.inputA);
  const b = ptFromJson(vec.inputB);
  const got = pointAdd(a, b);
  const exp = ptFromJson(vec.expected);

  if (got.x === exp.x && got.y === exp.y) {
    console.log(`  PASS  ${vec.id}: ${vec.description}`);
  } else {
    console.error(`  FAIL  ${vec.id}: ${vec.description}`);
    console.error(`         expected x=${exp.x}`);
    console.error(`              got x=${got.x}`);
    console.error(`         expected y=${exp.y}`);
    console.error(`              got y=${got.y}`);
    failures++;
  }
}

// ---------------------------------------------------------------------------
// Scalar multiplication vectors
// ---------------------------------------------------------------------------

console.log("\n--- Scalar Multiplication ---");
for (const vec of vectors.scalarMultiplication) {
  const scalar = BigInt(vec.scalar);
  const point = ptFromJson(vec.point);
  const got = scalarMul(scalar, point);
  const exp = ptFromJson(vec.expected);

  if (got.x === exp.x && got.y === exp.y) {
    console.log(`  PASS  ${vec.id}: ${vec.description}`);
  } else {
    console.error(`  FAIL  ${vec.id}: ${vec.description}`);
    console.error(`         expected x=${exp.x}`);
    console.error(`              got x=${got.x}`);
    console.error(`         expected y=${exp.y}`);
    console.error(`              got y=${got.y}`);
    failures++;
  }
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

console.log();
if (failures > 0) {
  console.error(`[FAIL] ${failures} vector(s) did not match. Build aborted.`);
  process.exit(1);
} else {
  const total =
    vectors.pointAddition.length + vectors.scalarMultiplication.length;
  console.log(`[PASS] All ${total} BabyJubJub vectors validated successfully.`);
  process.exit(0);
}
