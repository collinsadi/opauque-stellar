/**
 * Minimal transaction types for legacy UI components pending full Soroban port.
 *
 * NOTE: Stellar contract IDs are plain strings (C… Strkey). Do NOT call
 * .toBase58() on them — use the string value directly.
 */

const G_NULL = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export class PublicKey {
  private readonly key: string;
  constructor(key: string) {
    this.key = key;
  }
  /** @deprecated Stellar contract IDs are plain strings. Use the string value directly. */
  toString(): string {
    return this.key;
  }
  toBuffer(): Buffer {
    return Buffer.alloc(32);
  }
  toBytes(): Uint8Array {
    return new Uint8Array(32);
  }
  equals(other: PublicKey): boolean {
    return this.key === other.key;
  }
  static get default(): PublicKey {
    return new PublicKey(G_NULL);
  }
  static findProgramAddressSync(
    _seeds: (Buffer | Uint8Array)[],
    _programId: PublicKey,
  ): [PublicKey, number] {
    return [new PublicKey(G_NULL), 0];
  }
}

export class Connection {
  constructor(_url?: string, _commitment?: string) {}
  async getBalance(_pk: PublicKey): Promise<number> {
    return 0;
  }
  async getSlot(): Promise<number> {
    return 0;
  }
  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    return { blockhash: "0".repeat(32), lastValidBlockHeight: 0 };
  }
  async getAccountInfo(): Promise<null> {
    return null;
  }
  async simulateTransaction(): Promise<{ value: { err: null } }> {
    return { value: { err: null } };
  }
  async confirmTransaction(): Promise<void> {}
  async getSignaturesForAddress(): Promise<{ signature: string; slot: number }[]> {
    return [];
  }
  async getTransaction(): Promise<{ meta?: { logMessages?: string[] } } | null> {
    return null;
  }
  onLogs(): number {
    return 0;
  }
  removeOnLogsListener(): void {}
}

export class Transaction {
  feePayer?: PublicKey;
  recentBlockhash?: string;
  lastValidBlockHeight?: number;
  add(_ix: unknown): this {
    return this;
  }
  compileMessage(): unknown {
    return {};
  }
}

export class TransactionInstruction {
  constructor(_opts: unknown) {}
}

export const SystemProgram = {
  programId: new PublicKey(G_NULL),
  transfer(_opts: unknown): TransactionInstruction {
    return new TransactionInstruction({});
  },
};

export class Keypair {
  publicKey = new PublicKey(G_NULL);
  static fromSeed(_seed: Uint8Array): Keypair {
    return new Keypair();
  }
}
