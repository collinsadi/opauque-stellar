/**
 * Relayer-registry bindings and operator lifecycle (issue #1006).
 *
 * The registry is a contract, not an off-chain process, so running a relayer
 * needs nothing but an operator key: register, stake, unstake, accept, submit.
 * These tests pin the exact wire shape of those calls (method name + decoded
 * ScVal arguments) and check that the read-only surface works with no signer
 * at all, which is what a relayer node or a watcher needs.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import {
  OpaqueClient,
  RelayerRegistry,
  SignerError,
  keypairSigner,
  fromScVal,
  type ContractInvoker,
  type InvokeOptions,
  type ReadOptions,
} from "../../src/index";
import { slashableOffenseToScVal } from "../../src/contracts/relayer";

const REGISTRY = "CRELAYERREGISTRYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SAC = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";
const POOL = "CPOOLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const NEW_ADMIN = "GCMPINZMMQVQ7MWIJLB34F5JRAHLQQTWCP6XB5HEZR353PPPWRUWHLPU";
const OTHER = "GD4EUV5F2V5P2J5F2ZPHOKMPMWC6C4LTHJDBL2KQ2XW4QZ5S6XWQ3MJ4K";

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
const ONE_XLM = 10_000_000n;

class StubInvoker implements ContractInvoker {
  last?: InvokeOptions;
  calls: InvokeOptions[] = [];
  reads: Record<string, unknown> = {};
  readMethods: string[] = [];

  async invoke(opts: InvokeOptions): Promise<string> {
    this.last = opts;
    this.calls.push(opts);
    return "TXHASH";
  }
  async readNative<T>(opts: ReadOptions): Promise<T> {
    this.readMethods.push(opts.method);
    if (opts.method in this.reads) return this.reads[opts.method] as T;
    throw new Error(`unstubbed read: ${opts.method}`);
  }
  async simulateRead(): Promise<xdr.ScVal | undefined> {
    return undefined;
  }
  async getEvents(): Promise<never> {
    throw new Error("not used");
  }
  async getLatestLedger(): Promise<number> {
    return 1_000;
  }
}

let inv: StubInvoker;
let signer: ReturnType<typeof keypairSigner>;
let PK: string;
beforeEach(() => {
  inv = new StubInvoker();
  const keypair = Keypair.random();
  signer = keypairSigner(keypair);
  PK = keypair.publicKey();
});

const decoded = () => inv.last!.args.map(fromScVal);

describe("relayer-registry operator lifecycle", () => {
  it("register encodes [operator, x25519 pubkey, endpoint, stake]", async () => {
    await new RelayerRegistry(inv, REGISTRY).register({
      x25519Pubkey: bytes(32, 3),
      endpoint: "https://relayer.example",
      stake: 100n * ONE_XLM,
      signer,
    });
    expect(inv.last!.method).toBe("register");
    expect(inv.last!.contractPackage).toBe("relayer-registry");
    expect(inv.last!.source).toBe(PK);
    const a = decoded();
    expect(a[0]).toBe(PK);
    expect((a[1] as Uint8Array).length).toBe(32);
    expect(a[2]).toBe("https://relayer.example");
    expect(a[3]).toBe(100n * ONE_XLM);
  });

  it("addStake encodes [operator, amount]", async () => {
    await new RelayerRegistry(inv, REGISTRY).addStake({ amount: 5n * ONE_XLM, signer });
    expect(inv.last!.method).toBe("add_stake");
    const a = decoded();
    expect(a[0]).toBe(PK);
    expect(a[1]).toBe(5n * ONE_XLM);
  });

  it("requestUnstake encodes [operator, amount] and withdrawStake encodes [operator]", async () => {
    const registry = new RelayerRegistry(inv, REGISTRY);
    await registry.requestUnstake({ amount: 2n * ONE_XLM, signer });
    expect(inv.last!.method).toBe("request_unstake");
    expect(decoded()[1]).toBe(2n * ONE_XLM);

    await registry.withdrawStake({ signer });
    expect(inv.last!.method).toBe("withdraw_stake");
    expect(decoded()[0]).toBe(PK);
  });

  it("acceptJob encodes [operator, job id]", async () => {
    await new RelayerRegistry(inv, REGISTRY).acceptJob({ jobId: bytes(32, 9), signer });
    expect(inv.last!.method).toBe("accept_job");
    const a = decoded();
    expect(a[0]).toBe(PK);
    expect((a[1] as Uint8Array).length).toBe(32);
  });

  it("submitPoolWithdraw passes the full withdrawal payload in contract order", async () => {
    await new RelayerRegistry(inv, REGISTRY).submitPoolWithdraw({
      jobId: bytes(32, 9),
      proofA: bytes(64, 1),
      proofB: bytes(128, 2),
      proofC: bytes(64, 3),
      withdrawnValue: ONE_XLM,
      stateRoot: bytes(32, 4),
      aspRoot: bytes(32, 5),
      nullifierHash: bytes(32, 6),
      newCommitment: bytes(32, 8),
      recipient: OTHER,
      poolFee: 1000n,
      poolRelayer: OTHER,
      signer,
    });
    expect(inv.last!.method).toBe("submit_pool_withdraw");
    const a = decoded();
    expect(a[0]).toBe(PK); // operator
    expect((a[1] as Uint8Array).length).toBe(32); // job id
    expect((a[2] as Uint8Array).length).toBe(64); // proof a
    expect((a[3] as Uint8Array).length).toBe(128); // proof b
    expect((a[4] as Uint8Array).length).toBe(64); // proof c
    expect(a[5]).toBe(ONE_XLM); // withdrawn value
    expect((a[6] as Uint8Array).length).toBe(32); // state root
    expect((a[7] as Uint8Array).length).toBe(32); // asp root
    expect((a[8] as Uint8Array).length).toBe(32); // nullifier hash
    expect((a[9] as Uint8Array).length).toBe(32); // new commitment
    expect(a[10]).toBe(OTHER); // recipient
    expect(a[11]).toBe(1000n); // pool fee
    expect(a[12]).toBe(OTHER); // pool relayer
  });

  it("reportSlash passes SlashingProof as a map and the slash amount beside it", async () => {
    await new RelayerRegistry(inv, REGISTRY).reportSlash({
      proof: {
        relayer: OTHER,
        offense: "DoubleSign",
        evidence: bytes(128, 4),
        timestamp: 1_700_000_000n,
        reporter: PK,
      },
      slashAmount: ONE_XLM,
      signer,
    });
    expect(inv.last!.method).toBe("report_slash");
    const a = decoded();
    // arg 0: SlashingProof crosses as an ScVal::Map keyed by field name...
    expect(a[0]).toMatchObject({ relayer: OTHER, timestamp: 1_700_000_000n, reporter: PK });
    // ...and arg 1 is the slash amount.
    expect(a[1]).toBe(ONE_XLM);
  });

  it("reportSlash encodes SlashingProof as a Symbol-keyed sorted map with a u32 offense", async () => {
    await new RelayerRegistry(inv, REGISTRY).reportSlash({
      proof: {
        relayer: OTHER,
        offense: "InvalidSignature",
        evidence: bytes(64, 4),
        timestamp: 1_700_000_000n,
        reporter: PK,
      },
      slashAmount: ONE_XLM,
      signer,
    });
    const map = inv.last!.args[0]!.map()!;
    expect(map.map((e) => e.key().switch().name)).toEqual(Array(5).fill("scvSymbol"));
    const keys = map.map((e) => e.key().sym().toString());
    expect(keys).toEqual(["evidence", "offense", "relayer", "reporter", "timestamp"]);
    const offense = map[1]!.val();
    expect(offense.switch().name).toBe("scvU32");
    expect(offense.u32()).toBe(1);
  });

  it("encodes every SlashableOffense as its integer discriminant", () => {
    expect(slashableOffenseToScVal("DoubleSign").u32()).toBe(0);
    expect(slashableOffenseToScVal("InvalidSignature").u32()).toBe(1);
  });

  it("initialize / setConfig / transferAdmin are admin-gated and encode their arguments", async () => {
    const registry = new RelayerRegistry(inv, REGISTRY);
    await registry.initialize({
      admin: PK,
      nativeSac: SAC,
      privacyPool: POOL,
      minimumStake: 100n * ONE_XLM,
      unstakeCooldownLedgers: 100,
      maxDeadlineLedgers: 5_000,
      signer,
    });
    expect(inv.last!.method).toBe("initialize");
    expect(decoded()[1]).toBe(SAC);
    expect(decoded()[3]).toBe(100n * ONE_XLM);

    await registry.setConfig({
      minimumStake: 200n * ONE_XLM,
      unstakeCooldownLedgers: 200,
      maxDeadlineLedgers: 10_000,
      signer,
    });
    expect(inv.last!.method).toBe("set_config");
    expect(decoded()[1]).toBe(200n * ONE_XLM);

    await registry.transferAdmin({ newAdmin: NEW_ADMIN, signer });
    expect(inv.last!.method).toBe("transfer_admin");
    expect(decoded()[1]).toBe(NEW_ADMIN);
  });
});

describe("relayer-registry reads", () => {
  it("getConfig decodes the registry configuration", async () => {
    inv.reads.get_config = {
      admin: PK,
      native_sac: SAC,
      privacy_pool: POOL,
      minimum_stake: 100n * ONE_XLM,
      unstake_cooldown_ledgers: 100,
      max_deadline_ledgers: 5_000,
    };
    const config = await new RelayerRegistry(inv, REGISTRY).getConfig(PK);
    expect(config.nativeSac).toBe(SAC);
    expect(config.privacyPool).toBe(POOL);
    expect(config.minimumStake).toBe(100n * ONE_XLM);
    expect(config.unstakeCooldownLedgers).toBe(100);
  });

  it("getRelayer decodes free/bonded/pending stake and the unlock ledger", async () => {
    inv.reads.get_relayer = {
      operator: PK,
      x25519_pubkey: bytes(32, 3),
      endpoint: "https://relayer.example",
      free_stake: 3n * ONE_XLM,
      bonded_stake: 1n * ONE_XLM,
      pending_unstake: 2n * ONE_XLM,
      unstake_unlock_ledger: 4_242,
    };
    const record = await new RelayerRegistry(inv, REGISTRY).getRelayer({
      source: PK,
      operator: PK,
    });
    expect(record.freeStake).toBe(3n * ONE_XLM);
    expect(record.bondedStake).toBe(1n * ONE_XLM);
    expect(record.pendingUnstake).toBe(2n * ONE_XLM);
    expect(record.unstakeUnlockLedger).toBe(4_242);
  });

  it("getUnbondingStatus reports when the cooldown has elapsed", async () => {
    const registry = new RelayerRegistry(inv, REGISTRY);
    inv.reads.get_unbonding_status = [2n * ONE_XLM, 4_242, false];
    const locked = await registry.getUnbondingStatus({ source: PK, operator: PK });
    expect(locked.isUnlockable).toBe(false);
    expect(locked.unstakeUnlockLedger).toBe(4_242);

    inv.reads.get_unbonding_status = [2n * ONE_XLM, 4_242, true];
    const ready = await registry.getUnbondingStatus({ source: PK, operator: PK });
    expect(ready.isUnlockable).toBe(true);
  });

  it("getJob decodes an open job with no accepted relayer", async () => {
    const openJob = {
      creator: PK,
      payload_hash: bytes(32, 5),
      fee: ONE_XLM,
      deadline_ledger: 5_000,
      accepted_relayer: null as unknown,
      status: 0,
      created_ledger: 1_000,
      submitted_ledger: 0,
    };
    inv.reads.get_job = openJob;
    const registry = new RelayerRegistry(inv, REGISTRY);
    const job = await registry.getJob({ source: PK, jobId: bytes(32, 9) });
    expect(job.acceptedRelayer).toBeNull();
    expect(job.status).toBe(0);
    expect(job.fee).toBe(ONE_XLM);

    // A contract `Option<Address>` decodes as a one-element vec, not a bare string.
    inv.reads.get_job = { ...openJob, accepted_relayer: [PK] };
    const accepted = await registry.getJob({ source: PK, jobId: bytes(32, 9) });
    expect(accepted.acceptedRelayer).toBe(PK);
  });

  it("jobStatuses reads the codes from the contract rather than hardcoding them", async () => {
    inv.reads.status_open = 10;
    inv.reads.status_accepted = 11;
    inv.reads.status_submitted = 12;
    inv.reads.status_slashed = 13;
    inv.reads.status_canceled = 14;
    const statuses = await new RelayerRegistry(inv, REGISTRY).jobStatuses(PK);
    expect(statuses).toEqual({ open: 10, accepted: 11, submitted: 12, slashed: 13, canceled: 14 });
  });

  it("getSlashingRecord returns null for a clean relayer and decodes a dirty one", async () => {
    const registry = new RelayerRegistry(inv, REGISTRY);
    inv.reads.get_slashing_record = null;
    expect(await registry.getSlashingRecord({ source: PK, relayer: OTHER })).toBeNull();

    const slashed = {
      relayer: OTHER,
      total_slashed: ONE_XLM,
      slash_count: 1,
      last_slash_time: 1_700_000_000n,
    };
    inv.reads.get_slashing_record = slashed;
    const record = await registry.getSlashingRecord({ source: PK, relayer: OTHER });
    expect(record!.slashCount).toBe(1);
    expect(record!.totalSlashed).toBe(ONE_XLM);

    // `Some(record)` crosses the wire as a one-element vec; unwrap it.
    inv.reads.get_slashing_record = [slashed];
    const boxed = await registry.getSlashingRecord({ source: PK, relayer: OTHER });
    expect(boxed!.relayer).toBe(OTHER);
    expect(boxed!.slashCount).toBe(1);
  });

  it("getSlashingPercentage is read in basis points", async () => {
    inv.reads.get_slashing_percentage = 250;
    const bps = await new RelayerRegistry(inv, REGISTRY).getSlashingPercentage({
      source: PK,
      relayer: OTHER,
    });
    expect(bps).toBe(250);
  });
});

describe("RelayerService", () => {
  it("reads registry state on a client with no signer, given an explicit source", async () => {
    const readonly = new OpaqueClient({ network: "testnet", invoker: inv });
    inv.reads.get_config = {
      admin: PK,
      native_sac: SAC,
      privacy_pool: POOL,
      minimum_stake: 100n * ONE_XLM,
      unstake_cooldown_ledgers: 100,
      max_deadline_ledgers: 5_000,
    };
    const config = await readonly.relayer.getRegistryConfig({ source: PK });
    expect(config.minimumStake).toBe(100n * ONE_XLM);
  });

  it("a read with neither signer nor source fails with a SignerError", async () => {
    const readonly = new OpaqueClient({ network: "testnet", invoker: inv });
    inv.reads.get_config = {
      admin: PK,
      native_sac: SAC,
      privacy_pool: POOL,
      minimum_stake: 1n,
      unstake_cooldown_ledgers: 1,
      max_deadline_ledgers: 1,
    };
    await expect(readonly.relayer.getRegistryConfig()).rejects.toBeInstanceOf(SignerError);
  });

  it("operator lifecycle calls require a signer", async () => {
    const readonly = new OpaqueClient({ network: "testnet", invoker: inv });
    await expect(
      readonly.relayer.register({ x25519Pubkey: bytes(32), endpoint: "x", stake: ONE_XLM }),
    ).rejects.toBeInstanceOf(SignerError);
  });

  it("register routes the operator account's stake through the service", async () => {
    const client = new OpaqueClient({ network: "testnet", signer, invoker: inv });
    await client.relayer.register({
      x25519Pubkey: bytes(32, 3),
      endpoint: "https://relayer.example",
      stake: 100n * ONE_XLM,
    });
    expect(inv.last!.method).toBe("register");
    expect(inv.last!.source).toBe(PK);
  });

  it("getUnbondingStatus and getSlashingPercentage read without touching a signer", async () => {
    const readonly = new OpaqueClient({ network: "testnet", invoker: inv });
    inv.reads.get_unbonding_status = [ONE_XLM, 1_000, true];
    const status = await readonly.relayer.getUnbondingStatus({ source: PK, operator: OTHER });
    expect(status.isUnlockable).toBe(true);

    inv.reads.get_slashing_percentage = 100;
    expect(await readonly.relayer.getSlashingPercentage({ relayer: OTHER, source: PK })).toBe(100);
  });
});
