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
  scValToNative,
  xdr,
  Address,
} from "@stellar/stellar-sdk";
import { getHorizonUrls, getNetworkPassphrase, getRpcUrls } from "./chain";
import { recordContractCall, recordRpcError } from "./monitoring";
import { parseHorizonBalanceToStroops } from "./decimalParser";
import { simulateAndDecode } from "./sorobanErrors";
import {
  RpcRequestError,
  RpcRetriesExhaustedError,
  SimulationFailedError,
  TransactionFailedError,
  TransactionRejectedError,
  TransactionTimeoutError,
} from "./errors";
import { NetworkValidationService } from "../services/networkValidation";
import {
  getDefaultRetryPolicy,
  extractStatus,
  isNotFoundError,
  isRetryableRpcError,
  resolveRetryPolicy,
  runWithRetryPolicy,
  underlyingError,
  type RetryPolicy,
  type RetryPolicyOptions,
} from "./retryPolicy";

/** Per-client options. `retryPolicy` overrides the process-wide default (#561). */
export type RpcClientOptions = {
  retryPolicy?: RetryPolicyOptions;
};

export function getSorobanServer(options?: RpcClientOptions): rpc.Server {
  const urls = getRpcUrls();
  const servers = urls.map(
    (url) => new rpc.Server(url, { allowHttp: url.startsWith("http://") }),
  );
  return withReadFallback(
    servers,
    "Soroban RPC",
    // `sendTransaction` bypasses the retry wrapper entirely: a resubmitted
    // transaction is a new ledger entry, never a free retry.
    new Set(["sendTransaction"]),
    undefined,
    resolveRetryPolicy(options?.retryPolicy, getDefaultRetryPolicy()),
  ) as rpc.Server;
}

export function getHorizonServer(options?: RpcClientOptions): Horizon.Server {
  const servers = getHorizonUrls().map((url) => new Horizon.Server(url));
  return withReadFallback(
    servers,
    "Horizon",
    new Set(["submitTransaction"]),
    new Set(["loadAccount"]),
    resolveRetryPolicy(options?.retryPolicy, getDefaultRetryPolicy()),
  ) as Horizon.Server;
}

export async function loadAccount(publicKey: string) {
  return getHorizonServer().loadAccount(publicKey);
}

export async function accountExists(publicKey: string): Promise<boolean> {
  try {
    await loadAccount(publicKey);
    return true;
  } catch (err) {
    // Only a definitive 404 means "no such account". Every other failure (429,
    // 5xx, timeout, DNS) is an *unknown*, and reporting `false` for those makes
    // callers build a `createAccount` for an account that already exists — which
    // burns the fee and then fails on-ledger with `ALREADY_EXIST`. Propagate
    // instead so the UI can offer a retry.
    if (!isNotFoundError(err)) {
      const cause = underlyingError(err);
      throw new RpcRequestError({
        message: "Horizon.loadAccount failed",
        cause: err,
        provider: "Horizon",
        method: "loadAccount",
        status: extractStatus(cause),
        retryable: isRetryableRpcError(cause),
      });
    }
    return false;
  }
}

export type SignTxFn = (xdr: string) => Promise<string>;

const TX_POLL_TIMEOUT_MS = 60_000; // 60 seconds max polling
const TX_POLL_INTERVAL_MS = 1_000; // 1 second between polls

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Proxy that runs read methods through the configured retry policy (#561) and
 * falls through to the next configured provider once a provider is exhausted.
 *
 * Methods in `noRetryMethods` — transaction submission — bypass the wrapper
 * completely and are invoked exactly once against the primary provider.
 */
function withReadFallback<T extends object>(
  providers: T[],
  label: string,
  noRetryMethods: Set<string>,
  retryMethods: Set<string> | undefined,
  policy: RetryPolicy,
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
          const startedAt = Date.now();
          let lastError: unknown;
          let providersTried = 0;
          for (const provider of providers) {
            const fn = Reflect.get(provider, prop);
            if (typeof fn !== "function") continue;
            providersTried += 1;
            try {
              return await runWithRetryPolicy(
                () => Promise.resolve(fn.apply(provider, args)),
                {
                  label: `${label}.${prop}`,
                  method: prop,
                  policy,
                  providersTried,
                  onRetry: ({ error }) =>
                    recordRpcError({
                      provider: label,
                      method: prop,
                      error: errorMessage(error),
                    }),
                },
              );
            } catch (err) {
              lastError = err;
              // A non-transient failure is a real answer from the network —
              // failing over to another provider would only repeat it.
              if (!(err instanceof RpcRetriesExhaustedError)) throw err;
            }
          }
          const cause = underlyingError(lastError);
          throw new RpcRetriesExhaustedError({
            message:
              `${label}.${prop} failed across ${providersTried} provider(s): ` +
              `${errorMessage(cause) || "unknown error"}`,
            cause,
            method: prop,
            attempts: policy.attempts * Math.max(providersTried, 1),
            providersTried,
            elapsedMs: Date.now() - startedAt,
          });
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

  throw new TransactionTimeoutError({
    message:
      `Transaction polling timed out after ${timeoutMs}ms. Hash: ${txHash}. ` +
      `Check status manually or retry later.`,
    txHash,
    waitedMs: Date.now() - startTime,
  });
}

/** Render a Soroban ScError into a short, human-readable token. */
function describeScError(e: xdr.ScError): string {
  const type = e.switch().name; // sceContract, sceStorage, sceAuth, sceBudget, ...
  if (type === "sceContract") {
    try {
      return `ContractError#${e.contractCode()}`;
    } catch {
      return "ContractError";
    }
  }
  try {
    return `${type}/${e.code().name}`;
  } catch {
    return type;
  }
}

function scValToReadable(v: xdr.ScVal): unknown {
  try {
    if (v.switch().name === "scvError") return describeScError(v.error());
    return scValToNative(v);
  } catch {
    try {
      return v.switch().name;
    } catch {
      return "?";
    }
  }
}

/**
 * Decode the diagnostic events from a failed Soroban transaction into a short,
 * readable string so the actual contract error / host trap is visible instead
 * of "[object Object]".
 */
function decodeDiagnostics(events: unknown[]): string {
  const parts: string[] = [];
  for (const raw of events) {
    try {
      const de = raw as xdr.DiagnosticEvent;
      const v0 = de.event().body().v0();
      const topics = v0.topics().map(scValToReadable);
      const data = scValToReadable(v0.data());
      parts.push(JSON.stringify({ topics, data }));
    } catch {
      /* skip events that cannot be decoded */
    }
  }
  return Array.from(new Set(parts)).join(" | ").slice(0, 1500);
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
        throw new SimulationFailedError({
          message: `Simulation failed: ${simResult.error}`,
          contractId: opts.contractId,
          method: opts.method,
          contractError: simResult.errorCode ?? null,
        });
      }
    }

    // Pre-sign network validation (threat model M8)
    await NetworkValidationService.requireValidNetwork();

    const signedXdr = await opts.signTransaction(tx.toXDR());
    const signed = TransactionBuilder.fromXDR(signedXdr, passphrase);
    const send = await server.sendTransaction(signed);
    if (send.status === "ERROR") {
      throw new TransactionRejectedError({
        message: `Transaction rejected by the RPC node: ${JSON.stringify(send)}`,
        status: send.status,
        txHash: send.hash ?? null,
        context: { contractId: opts.contractId, method: opts.method },
      });
    }

    const txResponse = await pollTransactionStatus(server, send.hash);

    if (txResponse.status !== "SUCCESS") {
      const failed = txResponse as unknown as {
        resultXdr?: { toXDR?: (format: string) => string };
        diagnosticEventsXdr?: unknown[];
      };
      let reason = "";
      try {
        if (
          Array.isArray(failed.diagnosticEventsXdr) &&
          failed.diagnosticEventsXdr.length
        ) {
          reason = decodeDiagnostics(failed.diagnosticEventsXdr);
        }
      } catch {
        /* fall through */
      }
      if (!reason) {
        try {
          reason = failed.resultXdr?.toXDR
            ? `resultXdr ${failed.resultXdr.toXDR("base64")}`
            : "";
        } catch {
          /* fall through to the raw response */
        }
      }
      throw new TransactionFailedError({
        message:
          `Transaction ${txResponse.status} (${send.hash})` +
          (reason ? `: ${reason}` : `: ${JSON.stringify(txResponse)}`),
        txHash: send.hash,
        status: txResponse.status,
        diagnostics: reason || null,
        context: { contractId: opts.contractId, method: opts.method },
      });
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
  const policy = getDefaultRetryPolicy();
  for (const url of getHorizonUrls()) {
    const server = new Horizon.Server(url);
    try {
      const latest = await runWithRetryPolicy(
        () => server.ledgers().order("desc").limit(1).call(),
        { label: "Horizon.ledgers", method: "ledgers", policy },
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
      // A hard (non-transient) failure means the next provider will say the
      // same thing; fall back to protocol defaults rather than stalling.
      if (!isRetryableRpcError(underlyingError(err), policy)) break;
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
    // Pre-sign network validation (threat model M8)
    await NetworkValidationService.requireValidNetwork();
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
        throw new SimulationFailedError({
          message: `Simulation failed: ${simResult.error}`,
          contractId: opts.contractId,
          method: opts.method,
          contractError: simResult.errorCode ?? null,
        });
      }
    }

    tx.sign(opts.keypair);
    const send = await server.sendTransaction(tx);
    if (send.status === "ERROR") {
      throw new TransactionRejectedError({
        message: `Transaction rejected by the RPC node: ${JSON.stringify(send)}`,
        status: send.status,
        txHash: send.hash ?? null,
        context: { contractId: opts.contractId, method: opts.method },
      });
    }

    const txResponse = await pollTransactionStatus(server, send.hash);

    if (txResponse.status !== "SUCCESS") {
      throw new TransactionFailedError({
        message: `Transaction ${txResponse.status} (${send.hash})`,
        txHash: send.hash,
        status: txResponse.status,
        context: { contractId: opts.contractId, method: opts.method },
      });
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
