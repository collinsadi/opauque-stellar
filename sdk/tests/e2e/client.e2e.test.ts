/**
 * End-to-end facade test: drive the real OpaqueClient and its services through a
 * stub invoker that captures contract calls and feeds read results. Verifies the
 * full path config -> service -> binding -> invoke without a network, and that
 * not-wired capabilities fail explicitly.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Keypair, rpc, xdr } from "@stellar/stellar-sdk";
import {
  OpaqueClient,
  keypairSigner,
  fromScVal,
  hexToBytes,
  addressToScVal,
  bytesToScVal,
  u64ToScVal,
  computeStealthAddressAndViewTag,
  NotWiredError,
  SignerError,
  scanCursorKey,
  RpcError,
  TESTNET_DEPLOYMENT,
  type ContractInvoker,
  type InvokeOptions,
  type ReadOptions,
} from "../../src/index";

class StubInvoker implements ContractInvoker {
  last?: InvokeOptions;
  calls: InvokeOptions[] = [];
  reads: unknown[] = [];
  /** Canned `getEvents` pages, consumed in order (one per call). */
  eventPages: rpc.Api.GetEventsResponse[] = [];
  eventsCallCount = 0;
  eventsRequests: rpc.Server.GetEventsRequest[] = [];
  latestLedgerValue = 0;
  async invoke(opts: InvokeOptions): Promise<string> {
    this.last = opts;
    this.calls.push(opts);
    return "TXHASH";
  }
  async readNative<T>(_opts: ReadOptions): Promise<T> {
    return this.reads.shift() as T;
  }
  async simulateRead(): Promise<xdr.ScVal | undefined> {
    return undefined;
  }
  async getEvents(request: rpc.Server.GetEventsRequest): Promise<rpc.Api.GetEventsResponse> {
    this.eventsCallCount++;
    this.eventsRequests.push(request);
    return (
      this.eventPages.shift() ??
      ({ events: [], latestLedger: 0, cursor: "" } as unknown as rpc.Api.GetEventsResponse)
    );
  }
  async getLatestLedger(): Promise<number> {
    return this.latestLedgerValue;
  }
}

/** Build a fake `Announcement` event matching the on-chain (scheme, stealth_address, caller, ephemeral_pub_key, metadata) tuple. */
function announcementEvent(opts: {
  stealthAddress: string;
  ephemeralPubKey: Uint8Array;
  viewTag: number;
  ledger: number;
  caller: string;
}): rpc.Api.EventResponse {
  const value = xdr.ScVal.scvVec([
    u64ToScVal(1n),
    bytesToScVal(hexToBytes(opts.stealthAddress)),
    addressToScVal(opts.caller),
    bytesToScVal(opts.ephemeralPubKey),
    bytesToScVal(new Uint8Array([opts.viewTag])),
  ]);
  return { value, ledger: opts.ledger } as unknown as rpc.Api.EventResponse;
}

const keypair = Keypair.random();
const signer = keypairSigner(keypair);
const PK = keypair.publicKey();
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

let inv: StubInvoker;
let client: OpaqueClient;
beforeEach(() => {
  inv = new StubInvoker();
  client = new OpaqueClient({ network: "testnet", signer, invoker: inv });
});

describe("OpaqueClient wiring", () => {
  it("resolves testnet config and exposes services + bindings", () => {
    expect(client.config.network).toBe("testnet");
    expect(client.contracts.privacyPool.contractId).toBe(
      TESTNET_DEPLOYMENT.contracts.privacyPool,
    );
    expect(client.payments).toBeDefined();
    expect(client.pool).toBeDefined();
    expect(client.reputation).toBeDefined();
    expect(client.schemas).toBeDefined();
    expect(client.relayer).toBeDefined();
  });

  it("throws SignerError when an operation needs a signer but none is set", () => {
    const readonly = new OpaqueClient({ network: "testnet", invoker: inv });
    expect(() => readonly.requireSigner()).toThrow(SignerError);
  });

  it("native transfers require the built-in RpcClient", () => {
    expect(() =>
      client.sendNativeTransfer({ destination: "G", amountStroops: 1n, signer }),
    ).toThrow(RpcError);
  });
});

describe("schemas service", () => {
  it("computes the schema id and registers it", async () => {
    const { schemaId, txHash } = await client.schemas.register({
      name: "credit",
      fieldDefinitions: "u64 score, bool verified",
      revocable: true,
      schemaExpiryLedger: 5_000_000,
    });
    expect(schemaId.length).toBe(32);
    expect(txHash).toBe("TXHASH");
    expect(inv.last!.method).toBe("register_schema");
    // schemaId arg (index 2) matches the computed id
    expect(Array.from(fromScVal(inv.last!.args[2]) as Uint8Array)).toEqual(
      Array.from(schemaId),
    );
  });
});

describe("payments service", () => {
  it("derives an identity and meta-address", () => {
    const id = client.payments.deriveIdentity("0x" + "ab".repeat(64));
    expect(id.metaHex).toMatch(/^0x[0-9a-f]{132}$/);
    expect(id.metaAddress.length).toBe(66);
  });

  it("registers a meta-address", async () => {
    const id = client.payments.deriveIdentity("0x" + "cd".repeat(64));
    await client.payments.register({ metaAddress: id.metaAddress });
    expect(inv.last!.method).toBe("register_keys");
  });

  it("scan returns no matches for empty announcements", () => {
    const identity = client.payments.deriveIdentity("0x" + "ab".repeat(64));
    expect(client.payments.scan({ announcements: [], identity })).toEqual([]);
  });

  it("scanIterator streams matches page-by-page and persists a resumable cursor", async () => {
    const identity = client.payments.deriveIdentity("0x" + "11".repeat(64));
    const other = client.payments.deriveIdentity("0x" + "22".repeat(64));
    const mine1 = computeStealthAddressAndViewTag(identity.metaHex);
    const notMine = computeStealthAddressAndViewTag(other.metaHex);
    const mine2 = computeStealthAddressAndViewTag(identity.metaHex);

    inv.eventPages = [
      {
        events: [
          announcementEvent({ ...mine1, ledger: 100, caller: PK }),
          announcementEvent({ ...notMine, ledger: 100, caller: PK }),
        ],
        latestLedger: 100,
        cursor: "page1",
      } as unknown as rpc.Api.GetEventsResponse,
      {
        events: [announcementEvent({ ...mine2, ledger: 200, caller: PK })],
        latestLedger: 200,
        cursor: "",
      } as unknown as rpc.Api.GetEventsResponse,
    ];

    const matches = [];
    for await (const match of client.payments.scanIterator({ identity })) {
      matches.push(match);
    }
    expect(matches.length).toBe(2);
    expect(matches[0].stealthStellarAddress).toBe(mine1.stealthStellarAddress);
    expect(matches[0].ledger).toBe(100);
    expect(matches[1].stealthStellarAddress).toBe(mine2.stealthStellarAddress);
    expect(matches[1].ledger).toBe(200);
    // Cursor persisted per identity, so a later scan of *this* identity can
    // resume from here (and another identity's scan stays independent).
    expect(await client.scanStore.getCursor(scanCursorKey(identity))).toBe(200);
    expect(await client.scanStore.getCursor(scanCursorKey(other))).toBeNull();
  });

  it("scanIterator resumes from the persisted cursor without re-yielding the same page", async () => {
    const identity = client.payments.deriveIdentity("0x" + "44".repeat(64));
    const mine1 = computeStealthAddressAndViewTag(identity.metaHex);
    const mine2 = computeStealthAddressAndViewTag(identity.metaHex);

    inv.eventPages = [
      {
        events: [announcementEvent({ ...mine1, ledger: 100, caller: PK })],
        latestLedger: 100,
        cursor: "",
      } as unknown as rpc.Api.GetEventsResponse,
    ];
    const firstRun = [];
    for await (const match of client.payments.scanIterator({ identity })) firstRun.push(match);
    expect(firstRun.length).toBe(1);
    expect(await client.scanStore.getCursor(scanCursorKey(identity))).toBe(100);

    // Resuming should request events starting after ledger 100, not at it —
    // otherwise ledger 100's announcement would be re-fetched and re-yielded.
    inv.eventPages = [
      {
        events: [announcementEvent({ ...mine2, ledger: 200, caller: PK })],
        latestLedger: 200,
        cursor: "",
      } as unknown as rpc.Api.GetEventsResponse,
    ];
    const secondRun = [];
    for await (const match of client.payments.scanIterator({ identity })) secondRun.push(match);
    expect(secondRun.length).toBe(1);
    expect(secondRun[0].stealthStellarAddress).toBe(mine2.stealthStellarAddress);
    expect(await client.scanStore.getCursor(scanCursorKey(identity))).toBe(200);
    const secondRequest = inv.eventsRequests[inv.eventsRequests.length - 1] as { startLedger?: number };
    expect(secondRequest.startLedger).toBe(101);
  });

  it("scanIterator stops reading further pages once the consumer breaks early", async () => {
    const identity = client.payments.deriveIdentity("0x" + "33".repeat(64));
    const mine1 = computeStealthAddressAndViewTag(identity.metaHex);
    const mine2 = computeStealthAddressAndViewTag(identity.metaHex);

    inv.eventPages = [
      {
        events: [announcementEvent({ ...mine1, ledger: 100, caller: PK })],
        latestLedger: 100,
        cursor: "page1",
      } as unknown as rpc.Api.GetEventsResponse,
      {
        events: [announcementEvent({ ...mine2, ledger: 200, caller: PK })],
        latestLedger: 200,
        cursor: "",
      } as unknown as rpc.Api.GetEventsResponse,
    ];

    for await (const _match of client.payments.scanIterator({ identity })) {
      break;
    }
    // Only the first page was fetched; breaking early released the scan
    // before a second `getEvents` call was made.
    expect(inv.eventsCallCount).toBe(1);
  });
});

describe("reputation service", () => {
  it("submits a proof to verify_reputation with the configured groth16 verifier", async () => {
    await client.reputation.verifyOnChain({
      proofA: bytes(64),
      proofB: bytes(128),
      proofC: bytes(64),
      merkleRoot: bytes(32, 1),
      attestationId: bytes(32, 2),
      externalNullifier: 42n,
      nullifierHash: bytes(32, 3),
    });
    expect(inv.last!.method).toBe("verify_reputation");
    // arg[1] is the groth16 verifier address from config
    expect(fromScVal(inv.last!.args[1])).toBe(
      TESTNET_DEPLOYMENT.contracts.groth16Verifier,
    );
    expect(fromScVal(inv.last!.args[7])).toBe(42n); // external nullifier u64
  });

  it("prove() rejects when no artifact resolver is configured", async () => {
    await expect(
      client.reputation.prove({
        attestationId: 1,
        stealthPrivKey: bytes(32),
        externalNullifier: 1n,
        attestationWitness: { issuerPkX: 1n, traitDataHash: 2n, nonce: 3n },
        publisherProof: { root: "0x01", pathElements: [], pathIndices: [] },
      }),
    ).rejects.toBeInstanceOf(NotWiredError);
  });
});

describe("pool service", () => {
  it("deposits: reads the index, derives the commitment, persists the note", async () => {
    inv.reads.push(5); // get_deposit_count
    const { note, txHash } = await client.pool.deposit({ amountXlm: "5" });
    expect(txHash).toBe("TXHASH");
    expect(inv.last!.method).toBe("deposit");
    expect(note.leafIndex).toBe(5);
    expect(note.value).toBe("50000000"); // 5 XLM in stroops
    expect(note.commitment).toMatch(/^0x[0-9a-f]{64}$/);
    // deposit arg[3] is the u64 expected index
    expect(fromScVal(inv.last!.args[3])).toBe(5n);
    // note persisted
    expect((await client.notes.list()).length).toBe(1);
  });

  it("withdraws with a precomputed proof and marks the note spent", async () => {
    await client.notes.add({
      cluster: "testnet",
      value: "50000000",
      scope: 1,
      leafIndex: 0,
      nullifier: "1",
      secret: "2",
      commitment: "0xabc",
      spent: false,
      createdAt: 0,
    });
    await client.pool.withdraw({
      proof: {
        proofA: bytes(64),
        proofB: bytes(128),
        proofC: bytes(64),
        withdrawnValue: 50_000_000n,
        stateRoot: bytes(32),
        aspRoot: bytes(32),
        nullifierHash: bytes(32),
        newCommitment: bytes(32),
      },
      recipient: "GCMPINZMMQVQ7MWIJLB34F5JRAHLQQTWCP6XB5HEZR353PPPWRUWHLPU",
      noteCommitment: "0xabc",
    });
    expect(inv.last!.method).toBe("withdraw");
    const spent = (await client.notes.list()).find((n) => n.commitment === "0xabc");
    expect(spent?.spent).toBe(true);
  });

  it("proveWithdraw() rejects when no artifact resolver is configured", async () => {
    await expect(
      client.pool.proveWithdraw({
        note: {
          cluster: "testnet",
          value: "1000000",
          scope: 1,
          leafIndex: 0,
          nullifier: "1",
          secret: "2",
          commitment: "0x00",
          spent: false,
          createdAt: 0,
        },
        recipient: "GCMPINZMMQVQ7MWIJLB34F5JRAHLQQTWCP6XB5HEZR353PPPWRUWHLPU",
        stateLeaves: [],
        depositIndices: [],
      }),
    ).rejects.toBeInstanceOf(NotWiredError);
  });

  it("withdrawBatch() rejects when no artifact resolver is configured", async () => {
    await expect(
      client.pool.withdrawBatch({
        notes: [
          {
            cluster: "testnet",
            value: "1000000",
            scope: 1,
            leafIndex: 0,
            nullifier: "1",
            secret: "2",
            commitment: "0x00",
            spent: false,
            createdAt: 0,
          },
        ],
        recipient: "GCMPINZMMQVQ7MWIJLB34F5JRAHLQQTWCP6XB5HEZR353PPPWRUWHLPU",
      }),
    ).rejects.toBeInstanceOf(NotWiredError);
  });

  it("withdrawBatch() is a no-op for an empty note list, even without artifacts", async () => {
    const result = await client.pool.withdrawBatch({
      notes: [],
      recipient: "GCMPINZMMQVQ7MWIJLB34F5JRAHLQQTWCP6XB5HEZR353PPPWRUWHLPU",
    });
    expect(result).toEqual({ succeeded: [], failed: [] });
  });

  it("withdrawBatch() reports each failing note individually and leaves them unspent", async () => {
    const withArtifacts = new OpaqueClient({
      network: "testnet",
      signer,
      invoker: inv,
      artifacts: {
        resolve: async () => {
          throw new Error("must not be reached: proving fails before artifact resolution");
        },
      },
    });
    // No Deposit events reconstructed -> every note's leafIndex lookup fails
    // fast in provePoolWithdraw, before it ever touches artifacts/snarkjs.
    const notes = [
      {
        cluster: "testnet" as const,
        value: "1000000",
        scope: 1,
        leafIndex: 0,
        nullifier: "1",
        secret: "2",
        commitment: "0x00",
        spent: false,
        createdAt: 0,
      },
      {
        cluster: "testnet" as const,
        value: "2000000",
        scope: 1,
        leafIndex: 1,
        nullifier: "3",
        secret: "4",
        commitment: "0x01",
        spent: false,
        createdAt: 0,
      },
    ];

    const result = await withArtifacts.pool.withdrawBatch({
      notes,
      recipient: "GCMPINZMMQVQ7MWIJLB34F5JRAHLQQTWCP6XB5HEZR353PPPWRUWHLPU",
    });

    expect(result.succeeded).toEqual([]);
    expect(result.failed.map((f) => f.note.commitment).sort()).toEqual(["0x00", "0x01"]);
    for (const f of result.failed) expect(f.error).toBeInstanceOf(Error);
  });
});

describe("relayer service", () => {
  it("creates a job", async () => {
    await client.relayer.createJob({
      jobId: bytes(32),
      payloadHash: bytes(32),
      deadlineLedger: 3_200_000,
      fee: 1_000_000n,
    });
    expect(inv.last!.method).toBe("create_job");
  });

  it("builds a blind withdrawal payload and job draft", () => {
    const proof = {
      proofA: bytes(64),
      proofB: bytes(128),
      proofC: bytes(64),
      withdrawnValue: 1_000_000n,
      stateRoot: bytes(32),
      aspRoot: bytes(32),
      nullifierHash: bytes(32),
      newCommitment: bytes(32),
    };
    const payload = client.relayer.buildWithdrawPayload({
      proof,
      recipient: "GCMPINZMMQVQ7MWIJLB34F5JRAHLQQTWCP6XB5HEZR353PPPWRUWHLPU",
    });
    expect(payload.poolId).toBe(client.config.contracts.privacyPool);
    expect(payload.poolFee).toBe(0n);
    expect(payload.poolRelayer).toBe(client.config.contracts.relayerRegistry);

    const draft = client.relayer.buildJobDraft({
      payload,
      fee: 1_000_000n,
      deadlineLedger: 3_200_000,
    });
    expect(draft.jobId.length).toBe(32);
    expect(draft.payloadHash.length).toBe(32);
    expect(draft.advert.t).toBe("advert");
    expect(draft.advert.payloadHash).toBe(draft.payloadHashHex);
  });
});
