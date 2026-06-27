import { describe, it, expect } from 'vitest';
import {
  attestationToWitnessInputs,
  type AttestationInput,
  type SchemaField,
} from '../attestationToWitness';

/** Build a minimal valid attestation with the supplied dataHex. */
function makeAttestation(dataHex: string): AttestationInput {
  return {
    uid: 'uid-abc123',
    schemaId: '42',
    issuer: '0',
    dataHex,
    stealthAddressHash: 'hash-xyz',
    nonce: '7',
  };
}

/** Encode a list of 32-byte big-endian BigInt values into a hex string. */
function encodeWords(...values: bigint[]): string {
  const buf = new Uint8Array(values.length * 32);
  for (let i = 0; i < values.length; i++) {
    let v = values[i];
    for (let j = 31; j >= 0; j--) {
      buf[i * 32 + j] = Number(v & 0xffn);
      v >>= 8n;
    }
  }
  return (
    '0x' +
    Array.from(buf)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  );
}

/** Encode a UTF-8 string into a 32-byte word (left-padded). */
function encodeStringWord(s: string): bigint {
  const bytes = new TextEncoder().encode(s);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

describe('attestationToWitnessInputs (Issue #417)', () => {
  describe('numeric field decoding', () => {
    it('decodes a numeric field as BigInt', () => {
      const schema: SchemaField[] = [{ name: 'score', type: 'numeric' }];
      const dataHex = encodeWords(999n);
      const result = attestationToWitnessInputs(makeAttestation(dataHex), schema);
      expect(result.decodedFields['score']).toBe(999n);
    });

    it('decodes zero numeric field', () => {
      const schema: SchemaField[] = [{ name: 'count', type: 'numeric' }];
      const dataHex = encodeWords(0n);
      const result = attestationToWitnessInputs(makeAttestation(dataHex), schema);
      expect(result.decodedFields['count']).toBe(0n);
    });

    it('decodes multiple numeric fields in order', () => {
      const schema: SchemaField[] = [
        { name: 'a', type: 'numeric' },
        { name: 'b', type: 'numeric' },
      ];
      const dataHex = encodeWords(100n, 200n);
      const result = attestationToWitnessInputs(makeAttestation(dataHex), schema);
      expect(result.decodedFields['a']).toBe(100n);
      expect(result.decodedFields['b']).toBe(200n);
    });
  });

  describe('string field decoding', () => {
    it('decodes a string field via stringToBigInt', () => {
      // stringToBigInt("0x...") interprets as hex; "123" as decimal.
      // We store decimal "123" as UTF-8 bytes packed into a 32-byte word.
      const schema: SchemaField[] = [{ name: 'label', type: 'string' }];
      // Encode "123" as UTF-8 → 0x31 0x32 0x33
      const strBigInt = encodeStringWord('123');
      const dataHex = encodeWords(strBigInt);
      const result = attestationToWitnessInputs(makeAttestation(dataHex), schema);
      // stringToBigInt("...decimal...") should produce the same value
      expect(typeof result.decodedFields['label']).toBe('bigint');
    });

    it('decodes a plain decimal string field', () => {
      const schema: SchemaField[] = [{ name: 'val', type: 'string' }];
      // Store the number 42 directly in the word
      const dataHex = encodeWords(42n);
      const result = attestationToWitnessInputs(makeAttestation(dataHex), schema);
      // stringToBigInt("42") === 42n
      expect(result.decodedFields['val']).toBe(42n);
    });
  });

  describe('enum field decoding', () => {
    const enumSchema: SchemaField[] = [
      {
        name: 'tier',
        type: 'enum',
        enumValues: ['bronze', 'silver', 'gold'],
      },
    ];

    it('decodes enum index 0 → 0n', () => {
      const dataHex = encodeWords(0n); // index 0 = "bronze"
      const result = attestationToWitnessInputs(makeAttestation(dataHex), enumSchema);
      expect(result.decodedFields['tier']).toBe(0n);
    });

    it('decodes enum index 1 → 1n', () => {
      const dataHex = encodeWords(1n); // index 1 = "silver"
      const result = attestationToWitnessInputs(makeAttestation(dataHex), enumSchema);
      expect(result.decodedFields['tier']).toBe(1n);
    });

    it('decodes enum index 2 → 2n', () => {
      const dataHex = encodeWords(2n); // index 2 = "gold"
      const result = attestationToWitnessInputs(makeAttestation(dataHex), enumSchema);
      expect(result.decodedFields['tier']).toBe(2n);
    });
  });

  describe('enum value not found → TypeError', () => {
    it('throws TypeError when enum index is out of bounds', () => {
      const schema: SchemaField[] = [
        {
          name: 'tier',
          type: 'enum',
          enumValues: ['bronze', 'silver', 'gold'],
        },
      ];
      const dataHex = encodeWords(99n); // index 99 is out of bounds
      expect(() =>
        attestationToWitnessInputs(makeAttestation(dataHex), schema),
      ).toThrow(TypeError);
    });

    it('TypeError message mentions the field name', () => {
      const schema: SchemaField[] = [
        { name: 'tier', type: 'enum', enumValues: ['a', 'b'] },
      ];
      const dataHex = encodeWords(5n);
      expect(() =>
        attestationToWitnessInputs(makeAttestation(dataHex), schema),
      ).toThrow(/tier/);
    });
  });

  describe('unknown field type → TypeError', () => {
    it('throws TypeError for an unrecognised field type', () => {
      const schema = [
        { name: 'x', type: 'boolean' as unknown as 'numeric' },
      ];
      const dataHex = encodeWords(1n);
      expect(() =>
        attestationToWitnessInputs(makeAttestation(dataHex), schema),
      ).toThrow(TypeError);
    });
  });

  describe('missing attestation field → TypeError', () => {
    it('throws TypeError when uid is missing', () => {
      const schema: SchemaField[] = [];
      const attestation = { ...makeAttestation('0x'), uid: '' };
      expect(() =>
        attestationToWitnessInputs(attestation, schema),
      ).toThrow(TypeError);
    });

    it('throws TypeError when schemaId is missing', () => {
      const schema: SchemaField[] = [];
      const attestation = { ...makeAttestation('0x'), schemaId: '' };
      expect(() =>
        attestationToWitnessInputs(attestation, schema),
      ).toThrow(TypeError);
    });

    it('throws TypeError when issuer is missing', () => {
      const schema: SchemaField[] = [];
      const attestation = { ...makeAttestation('0x'), issuer: '' };
      expect(() =>
        attestationToWitnessInputs(attestation, schema),
      ).toThrow(TypeError);
    });

    it('throws TypeError when nonce is missing', () => {
      const schema: SchemaField[] = [];
      const attestation = { ...makeAttestation('0x'), nonce: '' };
      expect(() =>
        attestationToWitnessInputs(attestation, schema),
      ).toThrow(TypeError);
    });

    it('TypeError message names the missing field', () => {
      const schema: SchemaField[] = [];
      const attestation = { ...makeAttestation('0x'), uid: '' };
      expect(() =>
        attestationToWitnessInputs(attestation, schema),
      ).toThrow(/uid/);
    });
  });

  describe('invalid hex in dataHex → TypeError', () => {
    it('throws TypeError for non-hex characters in dataHex', () => {
      const schema: SchemaField[] = [];
      const attestation = { ...makeAttestation('0xZZZZ') };
      expect(() =>
        attestationToWitnessInputs(attestation, schema),
      ).toThrow(TypeError);
    });

    it('throws TypeError for odd-length hex string', () => {
      const schema: SchemaField[] = [];
      const attestation = { ...makeAttestation('0xAB1') };
      expect(() =>
        attestationToWitnessInputs(attestation, schema),
      ).toThrow(TypeError);
    });
  });

  describe('return value shape', () => {
    it('maps attestation fields to V2WitnessParams fields', () => {
      const schema: SchemaField[] = [];
      const attestation = makeAttestation('0x');
      const result = attestationToWitnessInputs(attestation, schema);
      expect(result.schemaIdField).toBe(attestation.schemaId);
      expect(result.issuerPkX).toBe(attestation.issuer);
      expect(result.nonceField).toBe(attestation.nonce);
      expect(result.traitDataHex).toBe(attestation.dataHex);
    });

    it('returns empty decodedFields for empty schema', () => {
      const schema: SchemaField[] = [];
      const result = attestationToWitnessInputs(makeAttestation('0x'), schema);
      expect(result.decodedFields).toEqual({});
    });
  });
});
