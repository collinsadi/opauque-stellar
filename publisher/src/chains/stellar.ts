/**
 * Soroban adapter for reputation-verifier roots.
 *
 * It reads get_latest_root and posts update_merkle_root signed by the configured
 * publisher/admin key. The engine is tested with an in-memory fake adapter; this
 * adapter talks to live testnet/mainnet RPC.
 */
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { hex32ToBytes } from "../bytes.ts";
import type { ChainAdapter, OnChainAttestation } from "../types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface StellarPublisherConfig {
  rpcUrl: string;
  networkPassphrase: string;
  verifierId: string;
  attestationEngineId: string;
  publisher: Keypair;
}

export class StellarReputationAdapter implements ChainAdapter {
  private readonly server: rpc.Server;

  constructor(private readonly cfg: StellarPublisherConfig) {
    this.server = new rpc.Server(cfg.rpcUrl);
  }

  async currentRoot(): Promise<string | null> {
    try {
      const acct = await this.server.getAccount(this.cfg.publisher.publicKey());
      const tx = new TransactionBuilder(acct, {
        fee: BASE_FEE,
        networkPassphrase: this.cfg.networkPassphrase,
      })
        .addOperation(new Contract(this.cfg.verifierId).call("get_latest_root"))
        .setTimeout(30)
        .build();
      const sim = await this.server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim) || !sim.result?.retval) return null;
      const native = scValToNative(sim.result.retval);
      return `0x${Buffer.from(native).toString("hex")}`;
    } catch {
      return null;
    }
  }

  async currentLedger(): Promise<number> {
    return (await this.server.getLatestLedger()).sequence;
  }

  async getAttestation(uid: string): Promise<OnChainAttestation | null> {
    const account = await this.server.getAccount(this.cfg.publisher.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(new Contract(this.cfg.attestationEngineId).call(
        "get_attestation",
        xdr.ScVal.scvBytes(Buffer.from(hex32ToBytes(uid))),
      ))
      .setTimeout(30)
      .build();
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim) || !sim.result?.retval) return null;
    const value = scValToNative(sim.result.retval) as Record<string, unknown>;
    const bytesHex = (field: unknown): string => {
      if (field instanceof Uint8Array) return `0x${Buffer.from(field).toString("hex")}`;
      if (Array.isArray(field)) return `0x${Buffer.from(field as number[]).toString("hex")}`;
      throw new Error("unexpected attestation bytes field");
    };
    return {
      schemaId: bytesHex(value.schema_id ?? value.schemaId),
      stealthAddressHash: bytesHex(value.stealth_address_hash ?? value.stealthAddressHash),
      expirationLedger: Number(value.expiration_ledger ?? value.expirationLedger),
      revocationLedger: Number(value.revocation_ledger ?? value.revocationLedger),
    };
  }

  async postRoot(root: string, datasetHash: string): Promise<{ hash: string; ledger?: number }> {
    const kp = this.cfg.publisher;
    const acct = await this.server.getAccount(kp.publicKey());
    const bytesScVal = (hex: string) => xdr.ScVal.scvBytes(Buffer.from(hex32ToBytes(hex)));
    let tx = new TransactionBuilder(acct, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(
        new Contract(this.cfg.verifierId).call(
          "update_merkle_root",
          new Address(kp.publicKey()).toScVal(),
          bytesScVal(root),
          bytesScVal(datasetHash),
        ),
      )
      .setTimeout(120)
      .build();
    tx = await this.server.prepareTransaction(tx);
    tx.sign(kp);
    const sent = await this.server.sendTransaction(tx);
    if (sent.status === "ERROR") {
      throw new Error(`update_merkle_root rejected: ${JSON.stringify(sent.errorResult ?? sent)}`);
    }
    for (let i = 0; i < 60; i += 1) {
      await sleep(2000);
      const res = await this.server.getTransaction(sent.hash);
      if (res.status === "SUCCESS") return { hash: sent.hash, ledger: res.ledger };
      if (res.status === "FAILED") throw new Error(`update_merkle_root FAILED ${sent.hash}`);
    }
    throw new Error(`update_merkle_root not confirmed: ${sent.hash}`);
  }
}
