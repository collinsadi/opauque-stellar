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
import { resolveMetaAddress } from "../lib/registry";
import { isEnsName, resolveEnsToAddress } from "../lib/ens";
import { getConfigForCluster } from "../contracts/contract-config";
import { SCHEME_ID_SECP256K1 } from "../lib/contracts";
import { getExplorerTxUrl } from "../lib/explorer";
import { useWallet } from "../hooks/useWallet";
import {
  bytesToScVal,
  buildNativeTransferOperation,
  getHorizonServer,
  getSorobanServer,
  parseXlmToStroops,
  u64ToScVal,
} from "../lib/stellar";
import { parseHorizonBalanceToStroops } from "../lib/decimalParser";
import { deployedAddresses } from "../contracts/deployedAddresses";
import {
  decodePaymentLink,
  isOpaquePaymentLink,
  decodeWebPaymentLink,
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
  const [txHash, setTxHash] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [activeBalance, setActiveBalance] = useState<bigint | null>(null);
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
    let cancelled = false;
    (async () => {
      try {
        // Try decoding as a base64url-encoded opaque:// URI (web payment link)
        const webLinkResult = tryDecodeBase64UrlOpaqueUri(id, cluster);
        const linkResult = webLinkResult ?? (isOpaquePaymentLink(id) ? decodePaymentLink(id, cluster) : null);

        if (linkResult) {
          if ("error" in linkResult) {
            if (!cancelled) {
              if (linkResult.error.type === "NETWORK_MISMATCH") {
                setResolveStatus("network_mismatch");
                setError(linkResult.error.message);
              } else {
                setResolveStatus("invalid_link");
                setError(linkResult.error.message);
              }
            }
            return;
          }
          const link = linkResult.link;
          setDecodedPaymentLink(link);
          setDisplayName(link.metaAddress);
          setResolvedMeta(link.metaAddress as Hex);

          // Extract and validate link parameters
          if (link.params.label) {
            setLinkLabel(link.params.label);
          }
          if (link.params.memo) {
            setLinkMemo(link.params.memo);
          }

          // Check if link has expired
          if (link.params.expires) {
            const expirationTime = new Date(link.params.expires).getTime();
            if (expirationTime < Date.now()) {
              if (!cancelled) {
                setResolveStatus("found");
                setError("This payment link has expired. Contact the recipient for a new link.");
              }
              return;
            }
          }

          // Check for unsupported asset/issuer (only XLM native is supported currently)
          if ((link.params.asset && link.params.asset !== "XLM") || link.params.issuer) {
            if (!cancelled) {
              setResolveStatus("found");
              setError("This payment link requests a non-native asset. Only XLM payments are supported currently.");
            }
            return;
          }

          // Pre-fill amount if specified in the link
          if (link.params.amount && !amount) {
            setAmount(link.params.amount);
          }
          if (!cancelled) setResolveStatus("found");
          return;
        }

        // Handle ENS names
        if (isEnsName(id)) {
          const controller = await resolveEnsToAddress(id);
          if (cancelled || !controller) {
            if (!cancelled) setResolveStatus("not_found");
            return;
          }
          const meta = await resolveMetaAddress(controller);
          if (cancelled) return;
          if (!meta) setResolveStatus("not_found");
          else {
            setResolvedMeta(meta);
            setResolveStatus("found");
          }
        } else {
          // Handle direct meta-address
          const with0x = id.startsWith("0x") ? id : "0x" + id;
          if (isDirectMetaAddress(with0x)) {
            setResolvedMeta(with0x as Hex);
            setResolveStatus("found");
          } else setResolveStatus("not_found");
        }
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
      setActiveBalance(null);
      return;
    }
    let cancelled = false;
    setBalanceLoading(true);
    (async () => {
      try {
        const account = await getHorizonServer().loadAccount(address);
        const native = account.balances.find((b) => b.asset_type === "native");
        const stroops = parseHorizonBalanceToStroops((native as { balance: string })?.balance);
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

  const BASE_RESERVE_STROOPS = 5_000_000n; // 0.5 XLM
  const SUBENTRY_RESERVE_STROOPS = 5_000_000n; // 0.5 XLM per subentry
  const MIN_TRANSACTION_FEE = 100n; // BASE_FEE in stroops

  const maxSendableBalance = useMemo(() => {
    if (activeBalance == null) return null;
    // Assume 2 subentries as a conservative estimate (account + 1 trustline/signer)
    // Real calculation would need to query the account's actual subentries
    const estimatedSubentries = 2n;
    const totalReserve = BASE_RESERVE_STROOPS + (estimatedSubentries * SUBENTRY_RESERVE_STROOPS) + MIN_TRANSACTION_FEE;
    return activeBalance > totalReserve ? activeBalance - totalReserve : 0n;
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

  const handleSendPrivately = async () => {
    setError(null);
    setTxHash(null);
    if (!config || !resolvedMeta || !address || !signTransaction || !connected)
      return;
    if (inputStroops == null || inputStroops <= 0n) {
      setError("Enter a valid amount.");
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

      let tx = new TransactionBuilder(source, {
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
      const send = await soroban.sendTransaction(signed);
      if (send.status === "ERROR") throw new Error(JSON.stringify(send));

      // Add to pending tx store for confirmation polling
      pendingTxStore.add({
        txHash: send.hash,
        cluster,
        kind: "send",
      });

      setTxHash(send.hash);
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
        {resolveStatus === "found" && (
          <>
            <input
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Amount in XLM"
              className="w-full mb-4 rounded-lg bg-ink-900 border border-ink-600 px-3 py-2"
            />
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
            {maxSendableBalance != null && connected && (
              <>
                <p className="text-xs text-mist mt-2">
                  Available to send: {formatXlm(maxSendableBalance)} XLM
                </p>
                <p className="text-xs text-mist/70 mt-1">
                  New stealth accounts require at least 1 XLM to be created.
                </p>
              </>
            )}
          </>
        )}
      </div>
    </motion.div>
  );
}
