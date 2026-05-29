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
import { deployedAddresses } from "../contracts/deployedAddresses";

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

type ResolveStatus = "idle" | "resolving" | "found" | "not_found";

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
    let cancelled = false;
    (async () => {
      try {
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
  }, [identifier]);

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

  const feeBuffer = 100_000n;
  const maxSendableBalance = useMemo(() => {
    if (activeBalance == null) return null;
    return activeBalance > feeBuffer ? activeBalance - feeBuffer : 0n;
  }, [activeBalance, feeBuffer]);

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
      })
        .addOperation(transferOp)
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
        .setTimeout(180)
        .build();
      const soroban = getSorobanServer();
      tx = await soroban.prepareTransaction(tx);
      const signedXdr = await signTransaction(tx.toXDR());
      const signed = TransactionBuilder.fromXDR(signedXdr, passphrase);
      const send = await soroban.sendTransaction(signed);
      if (send.status === "ERROR") throw new Error(JSON.stringify(send));
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
            className="text-indigo-400 underline"
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
                className="w-full py-2 rounded-lg bg-indigo-600"
              >
                {connecting ? "Connecting…" : "Connect Freighter"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleSendPrivately()}
                disabled={sending}
                className="w-full py-2 rounded-lg bg-indigo-600 disabled:opacity-50"
              >
                {sending ? "Sending…" : "Send XLM"}
              </button>
            )}
            {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
            {txHash && (
              <p className="text-emerald-400 text-sm mt-2">
                <a
                  href={getExplorerTxUrl(txHash)}
                  target="_blank"
                  rel="noreferrer"
                >
                  View transaction
                </a>
              </p>
            )}
            {maxSendableBalance != null && connected && (
              <p className="text-xs text-mist mt-2">
                Balance: {formatSol(maxSendableBalance)} XLM
              </p>
            )}
          </>
        )}
      </div>
    </motion.div>
  );
}
