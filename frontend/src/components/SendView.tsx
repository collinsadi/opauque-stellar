import { useState, useEffect, useMemo } from "react";
import { motion } from "framer-motion";
import {
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  StrKey,
  Asset,
} from "@stellar/stellar-sdk";

const USDC_ISSUER: Record<string, string> = {
  mainnet: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  futurenet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  local: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
};
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
import { useTxHistoryStore } from "../store/txHistoryStore";
import { PrivacyWarningCallout } from "./PrivacyWarningCallout";
import { SEND_PRIVACY_WARNING } from "../lib/privacyThreatModel";

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
  const [selectedAsset, setSelectedAsset] = useState<"XLM" | "USDC">("XLM");
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
        if (selectedAsset === "XLM") {
          const native = account.balances.find((b) => b.asset_type === "native");
          const stroops = BigInt(
            Math.round(
              parseFloat((native as { balance: string })?.balance ?? "0") * 1e7,
            ),
          );
          if (!cancelled) setActiveBalance(stroops);
        } else {
          const network = getNetwork();
          const issuer = USDC_ISSUER[network] || USDC_ISSUER.testnet;
          const token = account.balances.find(
            (b) =>
              b.asset_code === "USDC" &&
              (b as { asset_issuer?: string })?.asset_issuer === issuer,
          );
          const stroops = BigInt(
            Math.round(
              parseFloat((token as { balance: string })?.balance ?? "0") * 1e7,
            ),
          );
          if (!cancelled) setActiveBalance(stroops);
        }
      } catch {
        if (!cancelled) setActiveBalance(null);
      } finally {
        if (!cancelled) setBalanceLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, selectedAsset]);

  const maxSendableBalance = useMemo(() => {
    if (activeBalance == null) return null;
    if (selectedAsset === "XLM") {
      return activeBalance > STROOP_FEE_BUFFER
        ? activeBalance - STROOP_FEE_BUFFER
        : 0n;
    }
    return activeBalance;
  }, [activeBalance, selectedAsset]);

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
    let recipientMeta = recipient.trim();
    if (!recipientMeta || !amount) {
      setError("Enter recipient and amount.");
      return;
    }

    // If a G-address is entered, resolve it to a meta-address via the registry.
    if (isGAddress(recipientMeta)) {
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
    } else if (!isMetaAddress(recipientMeta)) {
      setError(
        "Enter a valid Stellar address (G…) or stealth meta-address (0x + 132 hex chars).",
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

      addStep("wait", "Building payment + announcement…");
      const passphrase = getNetworkPassphrase();
      const horizon = getHorizonServer();
      const soroban = getSorobanServer();
      const source = await horizon.loadAccount(publicKey);
      const announcer = new Contract(deployedAddresses.stealthAnnouncer);

      const usdcIssuer = USDC_ISSUER[network] || USDC_ISSUER.testnet;
      const usdcAsset = new Asset("USDC", usdcIssuer);

      let transferOp;
      if (selectedAsset === "XLM") {
        transferOp = await buildNativeTransferOperation({
          destination: stealthStellarAddress,
          amountStroops: value,
        });
      } else {
        // USDC trustline check
        addStep("wait", "Checking recipient USDC trustline…");
        try {
          const destAccount = await horizon.loadAccount(stealthStellarAddress);
          const hasTrustline = destAccount.balances.some(
            (b) =>
              b.asset_code === "USDC" &&
              (b as { asset_issuer?: string })?.asset_issuer === usdcIssuer,
          );
          if (!hasTrustline) {
            throw new Error("Recipient account lacks USDC trustline.");
          }
          addStep("ok", "Recipient USDC trustline verified.");
        } catch {
          throw new Error(
            "Recipient account does not exist or lacks USDC trustline. " +
            "A recipient must have a USDC trustline established before receiving USDC."
          );
        }

        transferOp = Operation.payment({
          destination: stealthStellarAddress,
          asset: usdcAsset,
          amount: (Number(value) / 1e7).toFixed(7),
        });
      }

      // Encode asset encoding in metadata: metadataEncoded[0] = viewTag, metadataEncoded[1] = asset type (0 for XLM, 1 for USDC)
      const metadataEncoded = new Uint8Array(2);
      metadataEncoded[0] = metadata[0];
      metadataEncoded[1] = selectedAsset === "USDC" ? 0x01 : 0x00;

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
            bytesToScVal(metadataEncoded),
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
        tokenSymbol: selectedAsset,
        tokenAddress: selectedAsset === "USDC" ? usdcAsset.contractId(passphrase) : null,
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
      <h2 className="text-lg font-semibold text-white mb-1">Send Privately</h2>
      <p className="text-sm text-neutral-500 mb-4">
        Send XLM or USDC to a stealth meta-address. The app derives a one-time Stellar
        account and publishes a Soroban announcement.
      </p>

      <PrivacyWarningCallout message={SEND_PRIVACY_WARNING} className="mb-6" />

      <motion.div className="space-y-4">
        <div>
          <label className="block text-sm text-neutral-400 mb-1">
            Asset
          </label>
          <select
            value={selectedAsset}
            onChange={(e) => setSelectedAsset(e.target.value as "XLM" | "USDC")}
            className="w-full rounded-lg bg-neutral-900 border border-neutral-700 px-3 py-2 text-sm text-white focus:outline-none"
          >
            <option value="XLM">XLM (Stellar Lumens)</option>
            <option value="USDC">USDC (USD Coin)</option>
          </select>
        </div>
        <div>
          <label className="block text-sm text-neutral-400 mb-1">
            Recipient address or meta-address
          </label>
          <input
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="G… Stellar address or 0x02… meta-address"
            className="w-full rounded-lg bg-neutral-900 border border-neutral-700 px-3 py-2 text-sm text-white"
          />
          {recipient && !isGAddress(recipient) && !isMetaAddress(recipient) && (
            <p className="text-xs text-neutral-400 mt-1">
              Enter a registered Stellar address (G…) or a stealth meta-address (0x + 132 hex chars).
            </p>
          )}
        </div>
        <div>
          <label className="block text-sm text-neutral-400 mb-1">
            Amount ({selectedAsset})
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
              Available: {formattedMaxBalance} {selectedAsset}
            </p>
          ) : null}
        </div>

        {error && <p className="text-sm text-neutral-400">{error}</p>}
        {txHash && (
          <p className="text-sm text-neutral-300">
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
          className="w-full py-2.5 rounded-lg bg-neutral-600 text-white font-medium hover:bg-black hover:text-white disabled:opacity-50"
        >
          {sending ? "Sending…" : "Send privately"}
        </button>
      </motion.div>
    </motion.div>
  );
}
