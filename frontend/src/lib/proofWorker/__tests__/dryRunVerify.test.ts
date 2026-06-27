import { describe, it, expect } from 'vitest';
import { dryRunVerify } from '../dryRunVerify';

const BN254_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

describe('dryRunVerify (Issue #416)', () => {
  describe('pass case', () => {
    it('returns pass:true when all signals are valid', () => {
      const inputs = {
        stealth_pk: '1',
        schema_id: '2',
        nonce: '3',
        merkle_root: '4',
        nullifier_hash: '5',
      };
      const required = ['stealth_pk', 'schema_id', 'nonce', 'merkle_root', 'nullifier_hash'];
      const result = dryRunVerify(inputs, required);
      expect(result.pass).toBe(true);
      expect(result.failedSignal).toBeUndefined();
      expect(result.message).toContain('safe to submit');
    });

    it('returns pass:true for empty required signals list', () => {
      const result = dryRunVerify({}, []);
      expect(result.pass).toBe(true);
    });

    it('returns pass:true for array signals all in range', () => {
      const inputs = {
        merkle_path: ['0', '1', '2'],
        merkle_path_indices: [0, 1, 0],
      };
      const result = dryRunVerify(inputs, ['merkle_path', 'merkle_path_indices']);
      expect(result.pass).toBe(true);
    });

    it('accepts BigInt field boundary value (field - 1)', () => {
      const max = (BN254_FIELD - 1n).toString();
      const result = dryRunVerify({ x: max }, ['x']);
      expect(result.pass).toBe(true);
    });

    it('accepts 0 as a valid scalar', () => {
      const result = dryRunVerify({ x: '0' }, ['x']);
      expect(result.pass).toBe(true);
    });
  });

  describe('missing signal', () => {
    it('returns pass:false when a scalar signal is undefined', () => {
      const result = dryRunVerify({}, ['stealth_pk']);
      expect(result.pass).toBe(false);
      expect(result.failedSignal).toBe('stealth_pk');
      expect(result.message).toMatch(/Missing required signal: stealth_pk/);
    });

    it('returns pass:false when a signal is null', () => {
      const result = dryRunVerify({ x: null }, ['x']);
      expect(result.pass).toBe(false);
      expect(result.failedSignal).toBe('x');
    });

    it('fails on the first missing signal in order', () => {
      const inputs = { b: '5' };
      const result = dryRunVerify(inputs, ['a', 'b']);
      expect(result.failedSignal).toBe('a');
    });
  });

  describe('out-of-range scalar', () => {
    it('returns pass:false for a scalar equal to BN254_FIELD', () => {
      const result = dryRunVerify({ x: BN254_FIELD.toString() }, ['x']);
      expect(result.pass).toBe(false);
      expect(result.failedSignal).toBe('x');
      expect(result.message).toContain('out of BN254 field range');
    });

    it('returns pass:false for a scalar greater than BN254_FIELD', () => {
      const overField = (BN254_FIELD + 1n).toString();
      const result = dryRunVerify({ x: overField }, ['x']);
      expect(result.pass).toBe(false);
    });

    it('returns pass:false for a negative scalar', () => {
      const result = dryRunVerify({ x: '-1' }, ['x']);
      expect(result.pass).toBe(false);
      expect(result.message).toContain('out of BN254 field range');
    });
  });

  describe('out-of-range array element', () => {
    it('returns pass:false when an array element equals BN254_FIELD', () => {
      const inputs = { merkle_path: ['1', BN254_FIELD.toString(), '2'] };
      const result = dryRunVerify(inputs, ['merkle_path']);
      expect(result.pass).toBe(false);
      expect(result.failedSignal).toBe('merkle_path[1]');
      expect(result.message).toContain('out of BN254 field range');
    });

    it('returns pass:false for a negative array element', () => {
      const inputs = { merkle_path: ['-1'] };
      const result = dryRunVerify(inputs, ['merkle_path']);
      expect(result.pass).toBe(false);
      expect(result.failedSignal).toBe('merkle_path[0]');
    });

    it('reports the correct index in failedSignal', () => {
      const bad = (BN254_FIELD + 100n).toString();
      const inputs = { path: ['0', '0', bad, '0'] };
      const result = dryRunVerify(inputs, ['path']);
      expect(result.failedSignal).toBe('path[2]');
    });
  });

  describe('invalid non-numeric value', () => {
    it('returns pass:false for a non-numeric string scalar', () => {
      const result = dryRunVerify({ x: 'not-a-number' }, ['x']);
      expect(result.pass).toBe(false);
      expect(result.failedSignal).toBe('x');
      expect(result.message).toContain('not a valid integer');
    });

    it('returns pass:false for an object scalar', () => {
      const result = dryRunVerify({ x: {} }, ['x']);
      expect(result.pass).toBe(false);
      expect(result.failedSignal).toBe('x');
    });

    it('includes the problematic value in the message', () => {
      const result = dryRunVerify({ sig: 'hello' }, ['sig']);
      expect(result.message).toContain('hello');
    });
  });
});
