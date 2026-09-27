import { useState, useEffect, useMemo } from "react";
import { motion } from "framer-motion";
import {
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  StrKey,
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
import { resolveMetaAddress } from "../lib/registry";
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
import { markPendingTx, resolvePendingTx, trackSubmission } from "../lib/txTracking";
import { PrivacyWarningCallout } from "./PrivacyWarningCallout";
import { SEND_PRIVACY_WARNING } from "../lib/privacyThreatModel";
import { QrScanner } from "./QrScanner";
import {
  decodePaymentLink,
  isOpaquePaymentLink,
  decodeWebPaymentLink,
  type Network,
} from "../lib/paymentLink";

const STROOP_FEE_BUFFER = 100_000n;

const isMetaAddress = (value: string): boolean => {
  const normalized = value.startsWith("0x") ? value : `0x${value}`;
  return (
    normalized.length === 2 + 66 * 2 &&
    (normalized.startsWith("0x02") || normalized.startsWith("0x03"))
  );
};

const isGAddress = (value: string): boolean => {
  try {
    return StrKey.isValidEd25519PublicKey(value.trim());
  } catch {
    return false;
  }
};

/** Try to extract a meta-address from an opaque:// or web payment link. */
function extractMetaFromPaymentLink(
  value: string,
  currentNetwork: string,
): { metaAddress: string; amount?: string } | null {
  const trimmed = value.trim();
  // opaque:// URI
  if (isOpaquePaymentLink(trimmed)) {
    const result = decodePaymentLink(trimmed, currentNetwork as Network);
    if ("link" in result) return { metaAddress: result.link.metaAddress, amount: result.link.params.amount };
    return null;
  }
  // https web link
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const result = decodeWebPaymentLink(trimmed, currentNetwork as Network);
    if (result && "link" in result) return { metaAddress: result.link.metaAddress, amount: result.link.params.amount };
  }
  return null;
}

export function SendView() {
  const { isSetup } = useKeys();
  const { publicKey, signTransaction, connected } = useWallet();
  const { push: logPush } = useProtocolLog();
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
  const [showQrScanner, setShowQrScanner] = useState(false);

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

  const handleQrScan = (scanned: string) => {
    setShowQrScanner(false);
    const trimmed = scanned.trim();
    if (isMetaAddress(trimmed)) {
      setRecipient(trimmed);
      setError(null);
    } else if (isGAddress(trimmed)) {
      setRecipient(trimmed);
      setError(null);
    } else {
      setError("Scanned value is not a valid Stellar address or stealth meta-address.");
    }
  };

  const handleSend = async () => {
    setError(null);
    setTxHash(null);
    if (!currentConfig || !publicKey || !signTransaction || !connected) {
      setError("Connect Freighter on a supported network.");
      return;
    }
    let recipientMeta = recipient.trim();
    if (!recipientMeta || !amount) {
      setError("Enter recipient and amount.");
      return;
    }

    // Try to extract meta-address from a pasted payment link
    const linkMeta = extractMetaFromPaymentLink(recipientMeta, network);
    if (linkMeta) {
      recipientMeta = linkMeta.metaAddress;
      if (linkMeta.amount && !amount) {
        setAmount(linkMeta.amount);
      }
    }

    // If a G-address is entered, resolve it to a meta-address via the registry.
    if (!linkMeta && isGAddress(recipientMeta)) {
      setSending(true);
      setSteps([]);
      addStep("wait", "Resolving stealth meta-address from registry…");
      const resolved = await resolveMetaAddress(recipientMeta);
      if (!resolved) {
        setError("Stellar address is not registered in the stealth registry.");
        setSteps((prev) => {
          const last = prev[prev.length - 1];
          return prev.slice(0, -1).concat([{ ...last, status: "error" as const }]);
        });
        setSending(false);
        return;
      }
      addStep("ok", "Meta-address resolved from registry.", resolved);
      recipientMeta = resolved;
    } else if (!linkMeta && !isMetaAddress(recipientMeta)) {
      setError(
        "Enter a valid Stellar address (G…), stealth meta-address (0x + 132 hex chars), or a payment link.",
      );
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

    function addStep(
      status: ProtocolStep["status"],
      label: string,
      detail?: string,
    ) {
      const id = `step-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setSteps((prev) => prev.concat([{ id, status, label, detail }]));
    }

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

      addStep("wait", "Building transfer + announcement…");
      const passphrase = getNetworkPassphrase();
      const horizon = getHorizonServer();
      const soroban = getSorobanServer();
      const announcer = new Contract(deployedAddresses.stealthAnnouncer);

      // A Soroban host-function op (the announcement) cannot share a
      // transaction with a classic op (the payment / account creation), so the
      // two are submitted as separate, sequential transactions. The same
      // in-memory source account is reused so its sequence number advances
      // correctly across both builds.
      const source = await horizon.loadAccount(publicKey);

      // 1) Fund / pay the one-time stealth account. Fresh stealth accounts do
      //    not exist on-ledger, so this is a createAccount; an existing
      //    destination falls back to a plain payment. Submitted via Horizon.
      const transferOp = await buildNativeTransferOperation({
        destination: stealthStellarAddress,
        amountStroops: value,
      });
      const transferTx = new TransactionBuilder(source, {
        fee: BASE_FEE,
        networkPassphrase: passphrase,
      })
        .addOperation(transferOp)
        .setTimeout(180)
        .build();
      addStep("wait", "Awaiting Freighter signature for the transfer…");
      const signedTransferXdr = await signTransaction(transferTx.toXDR());
      const signedTransfer = TransactionBuilder.fromXDR(
        signedTransferXdr,
        passphrase,
      );
      // Track the transfer under its precomputed hash before submitting, so
      // a reload mid-submission still resolves it and records the payment
      // (#114). The history row is recorded now even if the announcement
      // below fails: funds have moved and the announcement can be retried.
      const transferHash = signedTransfer.hash().toString("hex");
      await trackSubmission(
        {
          txHash: transferHash,
          cluster: network,
          kind: "send",
          history: {
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
            txHash: transferHash,
          },
        },
        () => horizon.submitTransaction(signedTransfer),
      );
      setTxHash(transferHash);
      addStep("ok", "Transfer confirmed.", transferHash);
      logPush("blockchain", `Transfer: ${transferHash.slice(0, 18)}…`);

      // 2) Publish the stealth announcement so the recipient can discover the
      //    payment by scanning. Submitted as its own Soroban transaction.
      addStep("wait", "Publishing announcement…");
      let announceTx = new TransactionBuilder(source, {
        fee: BASE_FEE,
        networkPassphrase: passphrase,
      })
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
      announceTx = await soroban.prepareTransaction(announceTx);
      addStep("wait", "Awaiting Freighter signature for the announcement…");
      const signedAnnounceXdr = await signTransaction(announceTx.toXDR());
      const signedAnnounce = TransactionBuilder.fromXDR(
        signedAnnounceXdr,
        passphrase,
      );
      const announceSend = await soroban.sendTransaction(signedAnnounce);
      if (announceSend.status === "ERROR")
        throw new Error(JSON.stringify(announceSend));
      markPendingTx({ txHash: announceSend.hash, cluster: network, kind: "send" });
      let announceResp = await soroban.getTransaction(announceSend.hash);
      while (announceResp.status === "NOT_FOUND") {
        await new Promise((r) => setTimeout(r, 1000));
        announceResp = await soroban.getTransaction(announceSend.hash);
      }
      if (announceResp.status !== "SUCCESS") {
        resolvePendingTx(announceSend.hash, "failed", announceResp.status);
        throw new Error(`Announcement failed: ${announceResp.status}`);
      }
      resolvePendingTx(announceSend.hash, "confirmed");
      addStep("done", "Announcement published.", announceSend.hash);
      logPush("blockchain", `Announce: ${announceSend.hash.slice(0, 18)}…`);
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
      <p className="text-sm text-neutral-500 mb-4">
        Send XLM to a stealth meta-address. The app derives a one-time Stellar
        account and publishes a Soroban announcement.
      </p>

      <PrivacyWarningCallout message={SEND_PRIVACY_WARNING} className="mb-6" />

      <motion.div className="space-y-4">
        <div>
          <label className="block text-sm text-neutral-400 mb-1">
            Recipient address or meta-address
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="G… Stellar address or 0x02… meta-address"
              className="flex-1 rounded-lg bg-neutral-900 border border-neutral-700 px-3 py-2 text-sm text-white"
            />
            <button
              type="button"
              onClick={() => setShowQrScanner(true)}
              className="px-3 py-2 text-sm rounded-lg border border-neutral-600 text-neutral-300 hover:bg-neutral-800"
              title="Scan QR code"
            >
              QR
            </button>
          </div>
          {recipient && !isGAddress(recipient) && !isMetaAddress(recipient) && (
            <p className="text-xs text-neutral-400 mt-1">
              Enter a registered Stellar address (G…) or a stealth meta-address (0x + 132 hex chars).
            </p>
          )}
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

        {error && <p className="text-sm text-neutral-400">{error}</p>}
        {txHash && (
          <p className="text-sm text-neutral-300">
            Sent.{" "}
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
          className="w-full py-2.5 rounded-lg bg-neutral-600 text-white font-medium hover:bg-black hover:text-white disabled:opacity-50"
        >
          {sending ? "Sending…" : "Send privately"}
        </button>
      </motion.div>

      {showQrScanner && (
        <QrScanner
          onScan={handleQrScan}
          onClose={() => setShowQrScanner(false)}
        />
      )}
    </motion.div>
  );
}
