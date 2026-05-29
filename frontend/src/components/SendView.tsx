import { useState, useEffect, useMemo } from "react";
import { motion } from "framer-motion";
import {
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import {
  computeStealthAddressAndViewTag,
  formatXlm,
  hexToBytes,
} from "../lib/stealth";
import { getNetworkPassphrase, getNetwork } from "../lib/chain";
import { getExplorerTxUrl } from "../lib/explorer";
import { useKeys } from "../context/KeysContext";
import { useWallet } from "../hooks/useWallet";
import { getConfigForCluster } from "../contracts/contract-config";
import { SCHEME_ID_SECP256K1 } from "../lib/contracts";
import {
  bytesToScVal,
  buildNativeTransferOperation,
  getHorizonServer,
  getSorobanServer,
  parseXlmToStroops,
  u64ToScVal,
} from "../lib/stellar";
import { deployedAddresses } from "../contracts/deployedAddresses";
import { ProtocolStepper } from "./ProtocolStepper";
import type { ProtocolStep } from "./ProtocolStepper";
import { useProtocolLog } from "../context/ProtocolLogContext";
import { useTxHistoryStore } from "../store/txHistoryStore";

const STROOP_FEE_BUFFER = 100_000n;
const isMetaAddress = (value: string): boolean => {
  const normalized = value.startsWith("0x") ? value : `0x${value}`;
  return (
    normalized.length === 2 + 66 * 2 &&
    (normalized.startsWith("0x02") || normalized.startsWith("0x03"))
  );
};

export function SendView() {
  const { isSetup } = useKeys();
  const { publicKey, signTransaction, connected } = useWallet();
  const { push: logPush } = useProtocolLog();
  const pushTx = useTxHistoryStore((s) => s.push);
  const network = getNetwork();
  const currentConfig = getConfigForCluster(network);
  const address = publicKey;

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [steps, setSteps] = useState<ProtocolStep[]>([]);
  const [activeBalance, setActiveBalance] = useState<bigint | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);

  useEffect(() => {
    if (!address) {
      setActiveBalance(null);
      return;
    }
    let cancelled = false;
    setBalanceLoading(true);
    (async () => {
      try {
        const account = await getHorizonServer().loadAccount(address);
        const native = account.balances.find((b) => b.asset_type === "native");
        const stroops = BigInt(
          Math.round(
            parseFloat((native as { balance: string })?.balance ?? "0") * 1e7,
          ),
        );
        if (!cancelled) setActiveBalance(stroops);
      } catch {
        if (!cancelled) setActiveBalance(null);
      } finally {
        if (!cancelled) setBalanceLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address]);

  const maxSendableBalance = useMemo(() => {
    if (activeBalance == null) return null;
    return activeBalance > STROOP_FEE_BUFFER
      ? activeBalance - STROOP_FEE_BUFFER
      : 0n;
  }, [activeBalance]);

  const inputStroops = useMemo(() => {
    const raw = amount.trim();
    if (!raw) return null;
    try {
      return parseXlmToStroops(raw);
    } catch {
      return null;
    }
  }, [amount]);

  const isInsufficientBalance = Boolean(
    maxSendableBalance != null &&
    inputStroops != null &&
    inputStroops > 0n &&
    inputStroops > maxSendableBalance,
  );

  const formattedMaxBalance =
    maxSendableBalance != null ? formatXlm(maxSendableBalance) : null;

  const handleMaxAmount = () => {
    if (maxSendableBalance == null || maxSendableBalance === 0n) return;
    setAmount(formattedMaxBalance ?? "0");
  };

  const handleSend = async () => {
    setError(null);
    setTxHash(null);
    if (!currentConfig || !publicKey || !signTransaction || !connected) {
      setError("Connect Freighter on a supported network.");
      return;
    }
    const recipientMeta = recipient.trim();
    if (!recipientMeta || !amount) {
      setError("Enter recipient and amount.");
      return;
    }
    if (!isMetaAddress(recipientMeta)) {
      setError("Enter a valid stealth meta-address (0x + 132 hex chars).");
      return;
    }

    let value: bigint;
    try {
      value = parseXlmToStroops(amount);
    } catch {
      setError("Invalid amount.");
      return;
    }
    if (value === 0n) {
      setError("Amount must be greater than 0.");
      return;
    }

    setSending(true);
    setSteps([]);

    const addStep = (
      status: ProtocolStep["status"],
      label: string,
      detail?: string,
    ) => {
      const id = `step-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setSteps((prev) => prev.concat([{ id, status, label, detail }]));
    };

    try {
      addStep("wait", "Deriving stealth destination…");
      const {
        stealthAddress,
        stealthStellarAddress,
        ephemeralPubKey,
        metadata,
      } = computeStealthAddressAndViewTag(recipientMeta as `0x${string}`);
      addStep(
        "ok",
        "Derived one-time stealth Stellar account.",
        stealthStellarAddress,
      );

      addStep("wait", "Building payment + announcement…");
      const passphrase = getNetworkPassphrase();
      const horizon = getHorizonServer();
      const soroban = getSorobanServer();
      const source = await horizon.loadAccount(publicKey);
      const announcer = new Contract(deployedAddresses.stealthAnnouncer);

      // Fresh stealth accounts don't exist yet, so create them on first send
      // instead of issuing a plain payment that would fail.
      const transferOp = await buildNativeTransferOperation({
        destination: stealthStellarAddress,
        amountStroops: value,
      });

      let tx = new TransactionBuilder(source, {
        fee: BASE_FEE,
        networkPassphrase: passphrase,
      })
        .addOperation(transferOp)
        .addOperation(
          announcer.call(
            "announce",
            nativeToScVal(publicKey, { type: "address" }),
            u64ToScVal(SCHEME_ID_SECP256K1),
            bytesToScVal(hexToBytes(stealthAddress)),
            bytesToScVal(ephemeralPubKey),
            bytesToScVal(metadata),
          ),
        )
        .setTimeout(180)
        .build();

      tx = await soroban.prepareTransaction(tx);
      addStep("wait", "Awaiting Freighter signature…");
      const signedXdr = await signTransaction(tx.toXDR());
      const signed = TransactionBuilder.fromXDR(signedXdr, passphrase);
      const send = await soroban.sendTransaction(signed);
      if (send.status === "ERROR") throw new Error(JSON.stringify(send));
      let txResponse = await soroban.getTransaction(send.hash);
      while (txResponse.status === "NOT_FOUND") {
        await new Promise((r) => setTimeout(r, 1000));
        txResponse = await soroban.getTransaction(send.hash);
      }
      if (txResponse.status !== "SUCCESS") {
        throw new Error(`Transaction failed: ${txResponse.status}`);
      }

      setTxHash(send.hash);
      addStep("done", "Transfer confirmed.", send.hash);
      logPush("blockchain", `Tx: ${send.hash.slice(0, 18)}…`);

      pushTx({
        cluster: network,
        kind: "sent",
        counterparty:
          stealthStellarAddress.slice(0, 6) +
          "…" +
          stealthStellarAddress.slice(-4),
        amountStroops: value.toString(),
        tokenSymbol: "XLM",
        tokenAddress: null,
        amount: formatXlm(value),
        txHash: send.hash,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Send failed";
      setError(msg);
      setSteps((prev) => {
        if (prev.length === 0) return prev;
        const last = prev[prev.length - 1];
        return prev
          .slice(0, -1)
          .concat([{ ...last, status: "error" as const, detail: msg }]);
      });
      logPush("ui", `Send failed: ${msg}`);
    } finally {
      setSending(false);
    }
  };

  if (!isSetup) {
    return (
      <motion.div className="card max-w-lg mx-auto text-center text-neutral-500">
        Complete key setup first so you can receive as well.
      </motion.div>
    );
  }

  return (
    <motion.div className="card max-w-lg mx-auto">
      <h2 className="text-lg font-semibold text-white mb-1">Send XLM</h2>
      <p className="text-sm text-neutral-500 mb-6">
        Send XLM to a stealth meta-address. The app derives a one-time Stellar
        account and publishes a Soroban announcement.
      </p>

      <motion.div className="space-y-4">
        <div>
          <label className="block text-sm text-neutral-400 mb-1">
            Recipient meta-address
          </label>
          <input
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="0x02…"
            className="w-full rounded-lg bg-neutral-900 border border-neutral-700 px-3 py-2 text-sm text-white"
          />
        </div>
        <div>
          <label className="block text-sm text-neutral-400 mb-1">
            Amount (XLM)
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.0"
              className="flex-1 rounded-lg bg-neutral-900 border border-neutral-700 px-3 py-2 text-sm text-white"
            />
            <button
              type="button"
              onClick={handleMaxAmount}
              disabled={!formattedMaxBalance}
              className="px-3 py-2 text-sm rounded-lg border border-neutral-600 text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
            >
              Max
            </button>
          </div>
          {balanceLoading ? (
            <p className="text-xs text-neutral-500 mt-1">Loading balance…</p>
          ) : formattedMaxBalance != null ? (
            <p className="text-xs text-neutral-500 mt-1">
              Available: {formattedMaxBalance} XLM
            </p>
          ) : null}
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}
        {txHash && (
          <p className="text-sm text-emerald-400">
            Sent —{" "}
            <a
              href={getExplorerTxUrl(txHash)}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              view transaction
            </a>
          </p>
        )}

        <ProtocolStepper steps={steps} />

        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={sending || isInsufficientBalance || !connected}
          className="w-full py-2.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          {sending ? "Sending…" : "Send privately"}
        </button>
      </motion.div>
    </motion.div>
  );
}
