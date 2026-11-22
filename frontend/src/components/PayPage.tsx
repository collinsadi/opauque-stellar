/**
 * Universal payment page: /pay/:identifier
 */

import { useState, useEffect, useMemo } from "react";
import { motion } from "framer-motion";
import { useParams, useNavigate } from "react-router-dom";
import {
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  Memo,
} from "@stellar/stellar-sdk";
import {
  hexToBytes,
  formatXlm,
  computeStealthAddressAndViewTag,
  type Hex,
} from "../lib/stealth";
import { getCluster, getNetworkPassphrase } from "../lib/chain";
import { getConfigForCluster } from "../contracts/contract-config";
import { SCHEME_ID_SECP256K1 } from "../lib/contracts";
import { useWallet } from "../hooks/useWallet";
import {
  bytesToScVal,
  buildNativeTransferOperation,
  getHorizonServer,
  getSorobanServer,
  parseXlmToStroops,
  u64ToScVal,
} from "../lib/stellar";
import { deployedAddresses } from "../contracts/deployedAddresses";
import { getMaxSendableQuote } from "../lib/maxSendable";
import {
  decodePaymentLink,
  paymentLinkValidationError,
  type PaymentLink,
} from "../lib/paymentLink";
import { usePendingTxStore } from "../store/pendingTxStore";

import type { PaymentLinkError } from "../lib/paymentLink";

/**
 * Try to decode an identifier as a base64url-encoded `opaque://` URI.
 * Returns null if the identifier is not valid base64url or doesn't decode to
 * an opaque:// URI (callers should fall through to other resolution paths).
 */
function tryDecodeBase64UrlOpaqueUri(
  identifier: string,
  configuredNetwork: string,
): { link: PaymentLink } | { error: PaymentLinkError } | null {
  try {
    let b64 = identifier.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const decoded = new TextDecoder().decode(bytes);
    if (!decoded.startsWith("opaque://")) return null;
    return decodePaymentLink(decoded, configuredNetwork as import("../lib/paymentLink").Network);
  } catch {
    return null;
  }
}

function isDirectMetaAddress(s: string): boolean {
  const t = s.trim().startsWith("0x") ? s.trim() : "0x" + s.trim();
  return (
    t.length === 2 + 66 * 2 && (t.startsWith("0x02") || t.startsWith("0x03"))
  );
}

function formatRecipientDisplay(id: string): string {
  if (!id) return "";
  const trimmed = id.trim();
  const with0x = trimmed.startsWith("0x") ? trimmed : "0x" + trimmed;
  if (isDirectMetaAddress(with0x)) {
    return with0x.slice(0, 5) + "…" + with0x.slice(-4);
  }
  return trimmed;
}

type ResolveStatus = "idle" | "resolving" | "found" | "not_found" | "network_mismatch" | "invalid_link";

export function PayPage() {
  const { identifier } = useParams<{ identifier: string }>();
  const navigate = useNavigate();
  const { publicKey, connect, connecting, signTransaction, connected } =
    useWallet();
  const cluster = getCluster();
  const config = getConfigForCluster(cluster);
  const [resolveStatus, setResolveStatus] = useState<ResolveStatus>("idle");
  const [resolvedMeta, setResolvedMeta] = useState<Hex | null>(null);
  const [displayName, setDisplayName] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [linkValidationError, setLinkValidationError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [maxSendableStroops, setMaxSendableStroops] = useState<bigint | null>(null);
  const [_balanceLoading, setBalanceLoading] = useState(false);
  const [decodedPaymentLink, setDecodedPaymentLink] = useState<PaymentLink | null>(null);
  const [linkLabel, setLinkLabel] = useState<string | null>(null);
  const [linkMemo, setLinkMemo] = useState<string | null>(null);
  const pendingTxStore = usePendingTxStore();
  const address = publicKey;

  useEffect(() => {
    const id = identifier?.trim();
    if (!id) {
      setResolveStatus("not_found");
      setResolvedMeta(null);
      return;
    }
    setDisplayName(id);
    setResolveStatus("resolving");
    setResolvedMeta(null);
    setDecodedPaymentLink(null);
    setLinkLabel(null);
    setLinkMemo(null);
    setLinkValidationError(null);
    setError(null);
    let cancelled = false;
    (async () => {
      try {
        // Try decoding as a base64url-encoded opaque:// URI (web payment link).
        // Decode raw opaque links too even when invalid, so expired/malformed
        // links surface their specific error instead of "User Not Found".
        const webLinkResult = tryDecodeBase64UrlOpaqueUri(id, cluster);
        const linkResult =
          webLinkResult ??
          (id.startsWith("opaque://") ? decodePaymentLink(id, cluster) : null);

        if (linkResult) {
          if ("error" in linkResult) {
            if (!cancelled) {
              setError(linkResult.error.message);
              setLinkValidationError(linkResult.error.message);
              setResolveStatus(
                linkResult.error.type === "NETWORK_MISMATCH"
                  ? "network_mismatch"
                  : "invalid_link",
              );
            }
            return;
          }
          const link = linkResult.link;
          setDecodedPaymentLink(link);
          setDisplayName(link.metaAddress);
          if (link.params.label) setLinkLabel(link.params.label);
          if (link.params.memo) setLinkMemo(link.params.memo);
          if (link.params.amount) setAmount((prev) => prev || link.params.amount!);

          // Asset, issuer, expiry and memo validation gates sending below.
          const validationError = paymentLinkValidationError(link.params);
          if (validationError) {
            if (!cancelled) {
              setLinkValidationError(validationError);
              setResolveStatus("found");
            }
            return;
          }
          if (!cancelled) {
            setResolvedMeta(link.metaAddress as Hex);
            setResolveStatus("found");
          }
          return;
        }

        // Handle direct meta-address
        const with0x = id.startsWith("0x") ? id : "0x" + id;
        if (isDirectMetaAddress(with0x)) {
          setResolvedMeta(with0x as Hex);
          setResolveStatus("found");
        } else setResolveStatus("not_found");
      } catch {
        if (!cancelled) setResolveStatus("not_found");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [identifier, cluster]);

  useEffect(() => {
    if (!txHash) return;
    let cancelled = false;
    const checkConfirmation = () => {
      const tx = pendingTxStore.byHash[txHash];
      if (!tx) return;
      if (tx.status === "confirmed") {
        if (!cancelled) {
          navigate(`/pay/success?tx=${txHash}`);
        }
      } else if (tx.status === "failed" || tx.status === "timed_out") {
        if (!cancelled) {
          setError(tx.message || "Transaction failed. Please try again.");
          setTxHash(null);
        }
      }
    };
    const timer = setInterval(checkConfirmation, 500);
    checkConfirmation();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [txHash, navigate, pendingTxStore]);

  useEffect(() => {
    if (!address) {
      setMaxSendableStroops(null);
      return;
    }
    let cancelled = false;
    setBalanceLoading(true);
    (async () => {
      try {
        const quote = await getMaxSendableQuote({ sourcePublicKey: address });
        if (!cancelled) setMaxSendableStroops(quote.maxSendableStroops);
      } catch {
        if (!cancelled) setMaxSendableStroops(null);
      } finally {
        if (!cancelled) setBalanceLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address]);

  const inputStroops = useMemo(() => {
    const raw = amount.trim();
    if (!raw) return null;
    try {
      return parseXlmToStroops(raw);
    } catch {
      return null;
    }
  }, [amount]);

  const handleSendPrivately = async () => {
    setError(null);
    setTxHash(null);
    // Re-check validation here as well: an invalid link must never be payable,
    // even if a stale render left the button enabled.
    const validationError = decodedPaymentLink
      ? paymentLinkValidationError(decodedPaymentLink.params)
      : null;
    if (
      linkValidationError ||
      validationError ||
      !config ||
      !resolvedMeta ||
      !address ||
      !signTransaction ||
      !connected
    )
      return;
    if (inputStroops == null || inputStroops <= 0n) {
      setError("Enter a valid amount.");
      return;
    }
    if (maxSendableStroops != null && inputStroops > maxSendableStroops) {
      setError("Insufficient balance to cover the reserve and both transaction fees.");
      return;
    }
    setSending(true);
    try {
      const {
        stealthAddress,
        stealthStellarAddress,
        ephemeralPubKey,
        metadata,
      } = computeStealthAddressAndViewTag(resolvedMeta);
      const passphrase = getNetworkPassphrase();
      const source = await getHorizonServer().loadAccount(address);
      const announcer = new Contract(deployedAddresses.stealthAnnouncer);
      // Create the stealth account on first send; fall back to payment when
      // it already exists (a plain payment to an unfunded account would fail).
      const transferOp = await buildNativeTransferOperation({
        destination: stealthStellarAddress,
        amountStroops: inputStroops,
      });

      const tx = new TransactionBuilder(source, {
        fee: BASE_FEE,
        networkPassphrase: passphrase,
      });

      // Add memo from payment link if present
      if (linkMemo) {
        tx.addMemo(Memo.text(linkMemo));
      }

      tx.addOperation(transferOp)
        .addOperation(
          announcer.call(
            "announce",
            nativeToScVal(address, { type: "address" }),
            u64ToScVal(SCHEME_ID_SECP256K1),
            bytesToScVal(hexToBytes(stealthAddress)),
            bytesToScVal(ephemeralPubKey),
            bytesToScVal(metadata),
          ),
        )
        .setTimeout(180);

      const builtTx = tx.build();
      const soroban = getSorobanServer();
      const preparedTx = await soroban.prepareTransaction(builtTx);
      const signedXdr = await signTransaction(preparedTx.toXDR());
      const signed = TransactionBuilder.fromXDR(signedXdr, passphrase);
      // Record the pending entry under its precomputed hash before submitting,
      // so the poller tracks it even if submission errors or drops mid-flight.
      const sentHash = signed.hash().toString("hex");
      pendingTxStore.add({
        txHash: sentHash,
        cluster,
        kind: "send",
      });

      const send = await soroban.sendTransaction(signed);
      if (send.status === "ERROR") {
        pendingTxStore.setStatus(sentHash, "failed", "Rejected by the RPC node");
        throw new Error(JSON.stringify(send));
      }

      setTxHash(sentHash);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
    }
  };

  if (resolveStatus === "not_found") {
    return (
      <motion.div className="min-h-screen bg-ink-950 text-white flex flex-col items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl border border-ink-700 bg-ink-900/30 p-6 text-center">
          <h1 className="font-display text-2xl font-bold text-white mb-2">
            User Not Found
          </h1>
          <p className="text-mist text-sm mb-6">
            Could not resolve a registered stealth meta-address for this
            identifier.
          </p>
          <button
            type="button"
            onClick={() => navigate("/")}
            className="text-neutral-300 underline"
          >
            Back home
          </button>
        </div>
      </motion.div>
    );
  }

  if (resolveStatus === "network_mismatch") {
    return (
      <motion.div className="min-h-screen bg-ink-950 text-white flex flex-col items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl border border-neutral-500/40 bg-neutral-500/10 p-6 text-center">
          <h1 className="font-display text-2xl font-bold text-neutral-300 mb-2">
            Network Mismatch
          </h1>
          <p className="text-neutral-300/80 text-sm mb-6">
            {error || "This payment link is for a different Stellar network."}
          </p>
          <button
            type="button"
            onClick={() => navigate("/")}
            className="text-neutral-300 underline"
          >
            Back home
          </button>
        </div>
      </motion.div>
    );
  }

  if (resolveStatus === "invalid_link") {
    return (
      <motion.div className="min-h-screen bg-ink-950 text-white flex flex-col items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl border border-neutral-500/40 bg-neutral-500/10 p-6 text-center">
          <h1 className="font-display text-2xl font-bold text-neutral-300 mb-2">
            Invalid Payment Link
          </h1>
          <p className="text-neutral-300/80 text-sm mb-6">
            {error || "This payment link is not valid."}
          </p>
          <button
            type="button"
            onClick={() => navigate("/")}
            className="text-neutral-300 underline"
          >
            Back home
          </button>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div className="min-h-screen bg-ink-950 text-white flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-ink-700 bg-ink-900/30 p-6 shadow-2xl">
        <h1 className="font-display text-xl font-bold mb-1">Pay privately</h1>
        <p className="text-sm text-mist mb-4">
          To {formatRecipientDisplay(displayName)}
          {linkLabel && <span className="block text-xs text-mist/70 mt-1">"{linkLabel}"</span>}
        </p>
        {resolveStatus === "resolving" && (
          <p className="text-sm text-mist">Resolving…</p>
        )}
        {resolveStatus === "found" && linkValidationError && (
          <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-4">
            <p className="text-sm text-red-300">{linkValidationError}</p>
          </div>
        )}
        {resolveStatus === "found" && !linkValidationError && (
          <>
            <input
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Amount in XLM"
              className="w-full mb-4 rounded-lg bg-ink-900 border border-ink-600 px-3 py-2"
            />
            {linkMemo && (
              <p className="mb-3 text-xs text-amber-300">
                Memos are public: this memo will be permanently visible on-chain.
              </p>
            )}
            {!connected ? (
              <button
                type="button"
                onClick={() => void connect()}
                disabled={connecting}
                className="w-full py-2 rounded-lg bg-neutral-600"
              >
                {connecting ? "Connecting…" : "Connect Freighter"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleSendPrivately()}
                disabled={sending}
                className="w-full py-2 rounded-lg bg-neutral-600 disabled:opacity-50"
              >
                {sending ? "Sending…" : "Send XLM"}
              </button>
            )}
            {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
            {txHash && (
              <p className="text-neutral-300 text-sm mt-2">
                Transaction submitted. Confirming...
              </p>
            )}
            {maxSendableStroops != null && connected && (
              <>
                <p className="text-xs text-mist mt-2">
                  Available to send: {formatXlm(maxSendableStroops)} XLM
                </p>
                <p className="text-xs text-mist/70 mt-1">
                  Reserve and both transaction fees are already deducted. New stealth accounts require at least 1 XLM.
                </p>
              </>
            )}
          </>
        )}
      </div>
    </motion.div>
  );
}
