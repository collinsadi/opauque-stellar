/**
 * Stellar / Soroban RPC helpers.
 */

import {
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
  Address,
} from "@stellar/stellar-sdk";
import { getHorizonUrls, getNetworkPassphrase, getRpcUrls } from "./chain";
import { recordContractCall, recordRpcError } from "./monitoring";
import { parseHorizonBalanceToStroops } from "./decimalParser";
import { simulateAndDecode, type SimulationResult } from "./sorobanErrors";

export function getSorobanServer(): rpc.Server {
  const urls = getRpcUrls();
  const servers = urls.map(
    (url) => new rpc.Server(url, { allowHttp: url.startsWith("http://") }),
  );
  return withReadFallback(
    servers,
    "Soroban RPC",
    new Set(["sendTransaction"]),
  ) as rpc.Server;
}

export function getHorizonServer(): Horizon.Server {
  const servers = getHorizonUrls().map((url) => new Horizon.Server(url));
  return withReadFallback(
    servers,
    "Horizon",
    new Set(["submitTransaction"]),
    new Set(["loadAccount"]),
  ) as Horizon.Server;
}

export async function loadAccount(publicKey: string) {
  return getHorizonServer().loadAccount(publicKey);
}

export async function accountExists(publicKey: string): Promise<boolean> {
  try {
    await loadAccount(publicKey);
    return true;
  } catch {
    return false;
  }
}

export type SignTxFn = (xdr: string) => Promise<string>;

const READ_TIMEOUT_MS = 12_000;
const READ_RETRIES_PER_PROVIDER = 2;
const TX_POLL_TIMEOUT_MS = 60_000; // 60 seconds max polling
const TX_POLL_INTERVAL_MS = 1_000; // 1 second between polls

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableReadError(err: unknown): boolean {
  const status =
    typeof err === "object" && err !== null && "response" in err
      ? (err as { response?: { status?: number } }).response?.status
      : undefined;
  if (
    status === 429 ||
    status === 408 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  ) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /timeout|timed out|rate.?limit|too many requests|network|fetch/i.test(
    message,
  );
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${READ_TIMEOUT_MS}ms`)),
      READ_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function withReadFallback<T extends object>(
  providers: T[],
  label: string,
  noRetryMethods: Set<string>,
  retryMethods?: Set<string>,
): T {
  const primary = providers[0];
  if (!primary) throw new Error(`No ${label} providers configured.`);
  return new Proxy(primary, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (
          noRetryMethods.has(prop) ||
          (retryMethods && !retryMethods.has(prop))
        ) {
          return value.apply(target, args);
        }
        return (async () => {
          let lastError: unknown;
          for (const provider of providers) {
            const fn = Reflect.get(provider, prop);
            if (typeof fn !== "function") continue;
            for (
              let attempt = 0;
              attempt < READ_RETRIES_PER_PROVIDER;
              attempt += 1
            ) {
              try {
                return await withTimeout(
                  Promise.resolve(fn.apply(provider, args)),
                  `${label}.${prop}`,
                );
              } catch (err) {
                lastError = err;
                if (!isRetryableReadError(err)) throw err;
                if (attempt + 1 < READ_RETRIES_PER_PROVIDER) {
                  await sleep(350 * (attempt + 1));
                }
              }
            }
          }
          throw lastError instanceof Error
            ? lastError
            : new Error(`${label}.${prop} failed`);
        })();
      };
    },
  });
}

/**
 * Poll for transaction status with bounded timeout.
 * @returns Transaction response when status is no longer NOT_FOUND
 * @throws Error if polling times out or transaction fails
 */
async function pollTransactionStatus(
  server: rpc.Server,
  txHash: string,
  timeoutMs: number = TX_POLL_TIMEOUT_MS,
): Promise<rpc.Api.GetTransactionResponse> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const txResponse = await server.getTransaction(txHash);

    if (txResponse.status !== "NOT_FOUND") {
      return txResponse;
    }

    await new Promise((r) => setTimeout(r, TX_POLL_INTERVAL_MS));
  }

  throw new Error(
    `Transaction polling timed out after ${timeoutMs}ms. Hash: ${txHash}. ` +
      `Check status manually or retry later.`,
  );
}

export async function invokeContractMethod(opts: {
  sourcePublicKey: string;
  contractId: string;
  method: string;
  args: xdr.ScVal[];
  signTransaction: SignTxFn;
  simulate?: boolean;
}): Promise<string> {
  const startTime = Date.now();
  const server = getSorobanServer();
  const passphrase = getNetworkPassphrase();
  try {
    const source = await server.getAccount(opts.sourcePublicKey);
    const contract = new Contract(opts.contractId);
    let tx = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: passphrase,
    })
      .addOperation(contract.call(opts.method, ...opts.args))
      .setTimeout(180)
      .build();
    tx = await server.prepareTransaction(tx);

    // Simulate if requested
    if (opts.simulate !== false) {
      const simResult = await simulateAndDecode(server, tx);
      if (!simResult.success) {
        throw new Error(`Simulation failed: ${simResult.error}`);
      }
    }

    const signedXdr = await opts.signTransaction(tx.toXDR());
    const signed = TransactionBuilder.fromXDR(signedXdr, passphrase);
    const send = await server.sendTransaction(signed);
    if (send.status === "ERROR") {
      throw new Error(`Transaction failed: ${JSON.stringify(send)}`);
    }

    const txResponse = await pollTransactionStatus(server, send.hash);

    if (txResponse.status !== "SUCCESS") {
      throw new Error(
        `Transaction ${send.status}: ${JSON.stringify(txResponse)}`,
      );
    }
    recordContractCall({
      contractId: opts.contractId,
      method: opts.method,
      success: true,
      durationMs: Date.now() - startTime,
    });
    return send.hash;
  } catch (err) {
    recordContractCall({
      contractId: opts.contractId,
      method: opts.method,
      success: false,
      durationMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export function addressToScVal(addr: string): xdr.ScVal {
  return new Address(addr).toScVal();
}

export function bytesToScVal(bytes: Uint8Array): xdr.ScVal {
  return xdr.ScVal.scvBytes(Buffer.from(bytes));
}

export function u64ToScVal(n: bigint | number): xdr.ScVal {
  return nativeToScVal(n, { type: "u64" });
}

/** Minimum starting balance (in stroops) for a freshly created Stellar account. */
export const NEW_ACCOUNT_MIN_RESERVE_STROOPS = 10_000_000n; // 1 XLM

export type NativeWithdrawalQuote = {
  balanceStroops: bigint;
  feeStroops: bigint;
  minimumBalanceStroops: bigint;
  spendableStroops: bigint;
  destinationExists: boolean;
  operation: "payment" | "createAccount";
};

type HorizonAccountLike = Awaited<ReturnType<Horizon.Server["loadAccount"]>>;

function balanceToStroops(balance: string | undefined): bigint {
  return parseHorizonBalanceToStroops(balance);
}

function horizonInt(value: unknown): bigint {
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string" && value.trim()) return BigInt(value);
  return 0n;
}

async function getLatestLedgerRules(): Promise<{
  baseFeeStroops: bigint;
  baseReserveStroops: bigint;
}> {
  for (const url of getHorizonUrls()) {
    const server = new Horizon.Server(url);
    for (let attempt = 0; attempt < READ_RETRIES_PER_PROVIDER; attempt += 1) {
      try {
        const latest = await withTimeout(
          server.ledgers().order("desc").limit(1).call(),
          "Horizon.ledgers",
        );
        const record = latest.records[0] as
          | {
              base_fee_in_stroops?: number | string;
              base_reserve_in_stroops?: number | string;
            }
          | undefined;
        return {
          baseFeeStroops:
            horizonInt(record?.base_fee_in_stroops) || BigInt(BASE_FEE),
          baseReserveStroops:
            horizonInt(record?.base_reserve_in_stroops) || 5_000_000n,
        };
      } catch (err) {
        if (!isRetryableReadError(err)) break;
        if (attempt + 1 < READ_RETRIES_PER_PROVIDER)
          await sleep(350 * (attempt + 1));
      }
    }
  }
  return { baseFeeStroops: BigInt(BASE_FEE), baseReserveStroops: 5_000_000n };
}

function minimumBalanceForAccount(
  account: HorizonAccountLike,
  baseReserveStroops: bigint,
): bigint {
  const raw = account as unknown as {
    subentry_count?: number | string;
    num_sponsoring?: number | string;
    num_sponsored?: number | string;
  };
  const reserveUnits =
    2n +
    horizonInt(raw.subentry_count) +
    horizonInt(raw.num_sponsoring) -
    horizonInt(raw.num_sponsored);
  return (reserveUnits > 0n ? reserveUnits : 0n) * baseReserveStroops;
}

export async function getNativeWithdrawalQuote(opts: {
  sourcePublicKey: string;
  destination: string;
}): Promise<NativeWithdrawalQuote> {
  const horizon = getHorizonServer();
  const [sourceAccount, ledgerRules] = await Promise.all([
    horizon.loadAccount(opts.sourcePublicKey),
    getLatestLedgerRules(),
  ]);
  const native = sourceAccount.balances.find((b) => b.asset_type === "native");
  const balanceStroops = balanceToStroops(
    (native as { balance?: string } | undefined)?.balance,
  );
  const destinationExists = await accountExists(opts.destination);
  const minimumBalanceStroops = minimumBalanceForAccount(
    sourceAccount,
    ledgerRules.baseReserveStroops,
  );
  const feeStroops = ledgerRules.baseFeeStroops;
  const retainedStroops = minimumBalanceStroops + feeStroops;
  const availableStroops =
    balanceStroops > retainedStroops ? balanceStroops - retainedStroops : 0n;
  const spendableStroops =
    !destinationExists && availableStroops < NEW_ACCOUNT_MIN_RESERVE_STROOPS
      ? 0n
      : availableStroops;
  return {
    balanceStroops,
    feeStroops,
    minimumBalanceStroops,
    spendableStroops,
    destinationExists,
    operation: destinationExists ? "payment" : "createAccount",
  };
}

/**
 * Build a native-XLM transfer operation that is safe for both existing and
 * brand-new destination accounts.
 *
 * Fresh stealth accounts do not exist on-ledger yet, so a plain
 * `Operation.payment` would fail with `op_no_destination`. When the
 * destination is unfunded we use `Operation.createAccount` with at least the
 * minimum account reserve; otherwise we use a normal payment.
 */
export async function buildNativeTransferOperation(opts: {
  destination: string;
  amountStroops: bigint;
  destinationExists?: boolean;
}): Promise<xdr.Operation> {
  const destExists =
    opts.destinationExists ?? (await accountExists(opts.destination));

  if (!destExists) {
    if (opts.amountStroops < NEW_ACCOUNT_MIN_RESERVE_STROOPS) {
      throw new Error(
        "Destination account does not exist; create-account requires at least 1 XLM.",
      );
    }
    return Operation.createAccount({
      destination: opts.destination,
      startingBalance: (Number(opts.amountStroops) / 1e7).toFixed(7),
    });
  }

  return Operation.payment({
    destination: opts.destination,
    asset: Asset.native(),
    amount: (Number(opts.amountStroops) / 1e7).toFixed(7),
  });
}

export async function sendNativePayment(opts: {
  sourceKeypair: Keypair;
  destination: string;
  amountStroops: bigint;
  destinationExists?: boolean;
  feeStroops?: bigint;
  signTransaction?: SignTxFn;
}): Promise<string> {
  const horizon = getHorizonServer();
  const passphrase = getNetworkPassphrase();
  const sourceAccount = await horizon.loadAccount(
    opts.sourceKeypair.publicKey(),
  );

  const builder = new TransactionBuilder(sourceAccount, {
    fee: (opts.feeStroops ?? BigInt(BASE_FEE)).toString(),
    networkPassphrase: passphrase,
  });

  builder.addOperation(
    await buildNativeTransferOperation({
      destination: opts.destination,
      amountStroops: opts.amountStroops,
      destinationExists: opts.destinationExists,
    }),
  );

  let tx = builder.setTimeout(180).build();

  if (opts.signTransaction) {
    const server = getSorobanServer();
    const prepared = await server.prepareTransaction(tx);
    const signedXdr = await opts.signTransaction(prepared.toXDR());
    tx = TransactionBuilder.fromXDR(signedXdr, passphrase) as typeof tx;
  }

  tx.sign(opts.sourceKeypair);
  const result = await horizon.submitTransaction(tx);
  return result.hash;
}

export async function invokeContractWithKeypair(opts: {
  keypair: Keypair;
  contractId: string;
  method: string;
  args: xdr.ScVal[];
  simulate?: boolean;
}): Promise<string> {
  const startTime = Date.now();
  const server = getSorobanServer();
  const passphrase = getNetworkPassphrase();
  try {
    const source = await server.getAccount(opts.keypair.publicKey());
    const contract = new Contract(opts.contractId);
    let tx = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: passphrase,
    })
      .addOperation(contract.call(opts.method, ...opts.args))
      .setTimeout(180)
      .build();
    tx = await server.prepareTransaction(tx);

    // Simulate if requested
    if (opts.simulate !== false) {
      const simResult = await simulateAndDecode(server, tx);
      if (!simResult.success) {
        throw new Error(`Simulation failed: ${simResult.error}`);
      }
    }

    tx.sign(opts.keypair);
    const send = await server.sendTransaction(tx);
    if (send.status === "ERROR") {
      throw new Error(`Transaction failed: ${JSON.stringify(send)}`);
    }

    const txResponse = await pollTransactionStatus(server, send.hash);

    if (txResponse.status !== "SUCCESS") {
      throw new Error(`Transaction failed: ${JSON.stringify(txResponse)}`);
    }
    recordContractCall({
      contractId: opts.contractId,
      method: opts.method,
      success: true,
      durationMs: Date.now() - startTime,
    });
    return send.hash;
  } catch (err) {
    recordContractCall({
      contractId: opts.contractId,
      method: opts.method,
      success: false,
      durationMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export {
  formatStroopsToXlm as formatXlm,
  parseXlmToStroops,
} from "./decimalParser";
