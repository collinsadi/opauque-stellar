import { useState, useEffect, useCallback, useMemo } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import {
  deriveStealthStellarAddressFromStealthPrivKey,
  formatXlm,
  hexToBytes,
} from "../lib/stealth";
import { getCluster, type StellarNetwork } from "../lib/chain";
import { getConfigForCluster } from "../contracts/contract-config";

function isAddress(a: string): boolean {
  const t = a.trim();
  if (t.startsWith("0x") && t.length === 42)
    return /^0x[0-9a-fA-F]{40}$/i.test(t);
  return StrKey.isValidEd25519PublicKey(t);
}
import { useOpaqueWasm } from "../hooks/useOpaqueWasm";
import { useScanner } from "../hooks/useScanner";
import type { CachedAnnouncement } from "../lib/opaqueCache";
import { useKeys } from "../context/KeysContext";
import { useWallet } from "../hooks/useWallet";
import {
  executeStealthWithdrawal,
  withdrawFromGhostAddress,
} from "../lib/stealthLifecycle";
import type { MasterKeys } from "../lib/stealthLifecycle";
import {
  getNativeWithdrawalQuote,
  type NativeWithdrawalQuote,
} from "../lib/stellar";
import type { ProtocolStep } from "./ProtocolStepper";
import type { OpaqueWasmModule } from "../hooks/useOpaqueWasm";
import { useReputationStore } from "../store/reputationStore";
import {
  getTraitByAttestationId,
  StealthAttestationArraySchema,
  type DiscoveredTrait,
} from "../lib/reputation";
import { ClaimModal } from "./ClaimModal";
import { useProtocolLog } from "../context/ProtocolLogContext";
import { useTxHistoryStore } from "../store/txHistoryStore";
import { useGhostAddressStore } from "../store/ghostAddressStore";
import { useWatchlist, useWatchlistStore } from "../hooks/useWatchlist";
import { useVaultStore } from "../store/vaultStore";
import { useToast } from "../context/ToastContext";
import { secp256k1 } from "@noble/curves/secp256k1";
import { getNativeToken } from "../lib/tokens";
import type { TokenInfo } from "../lib/tokens";
import { ExplorerLink } from "./ExplorerLink";
import {
  ghostAnnouncementEntryKey,
  useGhostAnnouncementStore,
} from "../store/ghostAnnouncementStore";
import { GhostAnnounceModal } from "./GhostAnnounceModal";
import { ModalShell } from "./ModalShell";

export type FoundTx = {
  id: string;
  address: string;
  stealthStellarAddress?: string;
  balance: bigint;
  privateKey: string | undefined;
  txHash: string;
  blockNumber: number;
  timestamp?: number;
  isSpent?: boolean;
  source?: "announcement" | "manual";
};

function viewTagFromMetadata(metadata: string | undefined): number {
  if (!metadata || metadata.length < 2) return 0;
  return parseInt(metadata.slice(2, 4), 16);
}

function toHexBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith("0x") ? hex : `0x${hex}`;
  return hexToBytes(normalized as `0x${string}`);
}

function cachedToLogWithArgs(c: CachedAnnouncement): LogWithArgs {
  return {
    args: c.args,
    transactionHash: c.transactionSignature,
    logIndex: c.logIndex,
    blockNumber: BigInt(c.slot),
  };
}

type LogWithArgs = {
  args?: {
    stealthAddress?: string;
    ephemeralPubKey?: string;
    metadata?: string;
  };
  transactionHash?: string | null;
  logIndex?: number | null;
  blockNumber?: bigint | null;
};
type StellarBalanceClient = {
  getBalance: (address: string) => Promise<bigint>;
};
type LogRow = {
  id: string;
  stealthAddress: string;
  ephemeralPubKeyHex: string | undefined;
  viewTag: number;
  blockNumber: number;
  txHash: string;
};

async function processRawLogsToFoundTxs(
  connection: StellarBalanceClient,
  rawLogs: LogWithArgs[],
  wasm: OpaqueWasmModule | null,
  getMasterKeys: (() => MasterKeys) | null,
  _cluster: StellarNetwork,
): Promise<FoundTx[]> {
  const rows: LogRow[] = rawLogs.map((log, i) => {
    const args = log.args;
    return {
      id: `${log.transactionHash ?? ""}-${log.logIndex ?? i}`,
      stealthAddress: args?.stealthAddress ?? "",
      ephemeralPubKeyHex:
        typeof args?.ephemeralPubKey === "string"
          ? args.ephemeralPubKey
          : undefined,
      viewTag: viewTagFromMetadata(
        typeof args?.metadata === "string" ? args.metadata : undefined,
      ),
      blockNumber: Number(log.blockNumber ?? 0),
      txHash: log.transactionHash ?? "",
    };
  });

  if (!wasm || !getMasterKeys) {
    return [];
  }
  let masterKeys: MasterKeys;
  try {
    masterKeys = getMasterKeys();
  } catch {
    return [];
  }

  const { viewPrivKey, spendPubKey } = masterKeys;
  const matched: LogRow[] = [];

  for (const row of rows) {
    try {
      if (!row.stealthAddress || !row.ephemeralPubKeyHex) continue;
      const ephemeralPubKey = toHexBytes(row.ephemeralPubKeyHex);
      if (ephemeralPubKey.length !== 33) continue;

      const viewTagResult = wasm.check_announcement_view_tag_wasm(
        row.viewTag,
        viewPrivKey,
        ephemeralPubKey,
      );
      if (viewTagResult === "NoMatch") continue;

      let isOurs: boolean;
      try {
        isOurs = wasm.check_announcement_wasm(
          row.stealthAddress,
          row.viewTag,
          viewPrivKey,
          spendPubKey,
          ephemeralPubKey,
        );
      } catch {
        isOurs = false;
      }
      if (!isOurs) continue;

      console.log("🎯 [Opaque] Match found for address:", row.stealthAddress);
      matched.push(row);
    } catch (err) {
      console.warn("🔑 [Opaque] Skipping malformed log:", row.id, err);
    }
  }

  const foundWithAddresses = matched.map((row) => {
    let privateKey: string | undefined;
    let stealthStellarAddress: string | undefined;
    if (wasm && masterKeys && row.ephemeralPubKeyHex) {
      try {
        const ephemeralPubKey = toHexBytes(row.ephemeralPubKeyHex);
        if (ephemeralPubKey.length === 33) {
          const stealthPrivKeyBytes = wasm.reconstruct_signing_key_wasm(
            masterKeys.spendPrivKey,
            masterKeys.viewPrivKey,
            ephemeralPubKey,
          );
          privateKey =
            "0x" +
            Array.from(stealthPrivKeyBytes)
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("");
          stealthStellarAddress =
            deriveStealthStellarAddressFromStealthPrivKey(stealthPrivKeyBytes);
        }
      } catch (err) {
        console.warn(
          "🔑 [Opaque] Key reconstruction failed for",
          row.stealthAddress,
          err,
        );
      }
    }
    return { row, privateKey, stealthStellarAddress };
  });

  const balances = await Promise.all(
    foundWithAddresses.map(async ({ stealthStellarAddress }) => {
      if (!stealthStellarAddress) return 0n;
      try {
        return await connection.getBalance(stealthStellarAddress);
      } catch {
        return 0n;
      }
    }),
  );

  const found: FoundTx[] = foundWithAddresses.map(
    ({ row, privateKey, stealthStellarAddress }, i) => {
      const balance = balances[i] ?? 0n;
      return {
        id: row.id,
        address: row.stealthAddress,
        stealthStellarAddress,
        balance,
        privateKey,
        txHash: row.txHash,
        blockNumber: row.blockNumber,
        isSpent: false,
        source: "announcement",
      };
    },
  );

  const totalBalance = found.reduce((sum, tx) => sum + tx.balance, 0n);
  console.log("📥 [Opaque] PrivateBalance: fetchFoundTxs done", {
    count: found.length,
    totalBalanceStroops: totalBalance.toString(),
    totalBalanceXlm: formatXlm(totalBalance),
  });

  return found;
}

function scanForAttestations(
  wasm: OpaqueWasmModule,
  getMasterKeys: (() => MasterKeys) | null,
  announcements: CachedAnnouncement[],
  addDiscoveredTrait: (trait: DiscoveredTrait) => void,
) {
  if (!getMasterKeys || announcements.length === 0) return;

  let masterKeys: MasterKeys;
  try {
    masterKeys = getMasterKeys();
  } catch {
    return;
  }

  const jsonPayload = JSON.stringify(
    announcements.map((a) => ({
      stealthAddress: a.args?.stealthAddress ?? "",
      viewTag: parseInt((a.args?.metadata ?? "0x00").slice(2, 4), 16),
      ephemeralPubKey: a.args?.ephemeralPubKey ?? "0x",
      metadata: a.args?.metadata ?? "0x",
      txHash: a.transactionSignature,
      blockNumber: a.slot,
    })),
  );

  try {
    const resultJson = wasm.scan_attestations_wasm(
      jsonPayload,
      masterKeys.viewPrivKey,
      masterKeys.spendPubKey,
    );
    const parsed = StealthAttestationArraySchema.safeParse(
      JSON.parse(resultJson),
    );
    if (!parsed.success) {
      console.warn(
        "📥 [Opaque] Attestation scan: validation failed",
        parsed.error,
      );
      return;
    }

    for (const att of parsed.data) {
      const traitDef = getTraitByAttestationId(att.attestation_id) ?? {
        id: `custom-${att.attestation_id}`,
        attestationId: att.attestation_id,
        label: `Trait #${att.attestation_id}`,
        description: "Custom attestation",
        icon: "layers",
        category: "custom" as const,
      };

      addDiscoveredTrait({
        traitDef,
        attestationId: att.attestation_id,
        stealthAddress: att.stealth_address,
        txHash: att.tx_hash,
        blockNumber: att.block_number,
        discoveredAt: Date.now(),
        ephemeralPubkey: att.ephemeral_pubkey,
      });
    }

    if (parsed.data.length > 0) {
      console.log(
        `📥 [Opaque] Discovered ${parsed.data.length} attestation trait(s)`,
      );
    }
  } catch (err) {
    console.warn("📥 [Opaque] Attestation scan error (non-fatal):", err);
  }
}

export type PortfolioEntry = { tx: FoundTx; balanceRaw: bigint };

export function PrivateBalanceView() {
  const [found, setFound] = useState<FoundTx[]>([]);
  const [loading, setLoading] = useState(true);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [withdrawalSteps, setWithdrawalSteps] = useState<ProtocolStep[]>([]);
  const [destinationByTxId, setDestinationByTxId] = useState<
    Record<string, string>
  >({});
  const [newlyDetectedIds, setNewlyDetectedIds] = useState<string[]>([]);
  const [claimModalTx, setClaimModalTx] = useState<FoundTx | null>(null);
  const [withdrawalPreview, setWithdrawalPreview] = useState<{
    txId: string;
    loading: boolean;
    quote?: NativeWithdrawalQuote;
    error?: string;
  } | null>(null);
  const [ghostTxs, setGhostTxs] = useState<FoundTx[]>([]);
  const [syncingPaused, setSyncingPaused] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const { wasm, isReady: wasmReady } = useOpaqueWasm();
  const keysContext = useKeys();
  const { address: mainWalletAddress, connection } = useWallet();
  const cluster = getCluster();
  const currentConfig = getConfigForCluster(cluster);
  const { push: logPush } = useProtocolLog();
  const pushTx = useTxHistoryStore((s) => s.push);
  const ghostStoreEntries = useGhostAddressStore((s) => s.entries);
  const ghostAnnouncementKeys = useGhostAnnouncementStore((s) => s.keys);
  const ghostEntries = useMemo(
    () =>
      ghostStoreEntries.filter(
        (e) => e.cluster === cluster && !!e.ephemeralPrivKeyHex,
      ),
    [ghostStoreEntries, cluster],
  );
  const watchlistAdd = useWatchlistStore((s) => s.add);
  const watchlistArchive = useWatchlistStore((s) => s.archive);
  const { showToast } = useToast();
  const [manualImportOpen, setManualImportOpen] = useState(false);
  const [manualImportAddress, setManualImportAddress] = useState("");
  const [manualImportError, setManualImportError] = useState<string | null>(
    null,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [ghostAnnounceTarget, setGhostAnnounceTarget] = useState<{
    stealthAddress: `0x${string}`;
    ephemeralPrivKeyHex: `0x${string}`;
  } | null>(null);

  const ghostAddresses = useMemo(
    () => ghostEntries.map((g) => g.stealthAddress as `0x${string}`),
    [ghostEntries],
  );
  const watchlistAddresses = useWatchlist(cluster);

  useEffect(() => {
    if (cluster == null) return;
    const add = useWatchlistStore.getState().add;
    ghostEntries.forEach((g) => add(cluster, g.stealthAddress));
  }, [cluster, ghostEntries]);

  const scanner = useScanner({
    cluster,
    publicClient: connection,
    announcerAddress: currentConfig?.announcerProgram ?? null,
    enabled: Boolean(wasmReady && cluster && currentConfig),
    ghostAddresses,
    watchlistAddresses:
      watchlistAddresses.length > 0 ? watchlistAddresses : undefined,
  });

  const nativeAsset: TokenInfo = getNativeToken();

  const portfolio = useMemo(() => {
    const activeTxs = [...found.filter((tx) => !tx.isSpent), ...ghostTxs];
    let totalRaw = 0n;
    const entries: PortfolioEntry[] = [];
    for (const tx of activeTxs) {
      const balanceRaw = tx.balance;
      if (balanceRaw > 0n) {
        totalRaw += balanceRaw;
        entries.push({ tx, balanceRaw });
      }
    }
    return { asset: nativeAsset, totalRaw, entries };
  }, [found, ghostTxs, nativeAsset]);

  const setDestination = useCallback((txId: string, value: string) => {
    setDestinationByTxId((prev) => ({ ...prev, [txId]: value }));
  }, []);

  const handleClaim = useCallback(
    async (tx: FoundTx, destination: string) => {
      const trimmed = destination.trim();
      const isGhost = tx.id.startsWith("ghost-");
      if (!isGhost && !tx.privateKey) return;
      if (isGhost && (!keysContext.isSetup || !wasm)) {
        setClaimError("Keys or WASM not ready for ghost withdrawal.");
        return;
      }
      if (cluster == null) {
        setClaimError("Unsupported network.");
        return;
      }
      const amountRaw = tx.balance;
      if (amountRaw <= 0n) return;
      if (!trimmed) {
        setClaimError("Please enter a destination address.");
        return;
      }
      if (!isAddress(trimmed)) {
        setClaimError("Invalid destination address.");
        return;
      }
      setClaimingId(tx.id);
      setClaimError(null);
      setWithdrawalSteps([]);
      logPush("wasm", "Reconstructing stealth key and signing claim tx…");
      const amountStr = formatXlm(amountRaw);
      logPush(
        "blockchain",
        `Claim: ${amountStr} XLM → ${trimmed.slice(0, 10)}…`,
      );
      let step3Label = `[Step 3] Sweeping to Destination`;
      const onStatus = (s: { tag: string; label: string; detail?: string }) => {
        if (s.detail?.includes("Sending ")) {
          const m = s.detail.match(/Sending ([\d.]+)/);
          if (m) step3Label = `[Step 3] Sweeping ${m[1]} XLM to Destination`;
        }
        setWithdrawalSteps((prev) => {
          const steps: ProtocolStep[] =
            prev.length >= 3
              ? [...prev]
              : [
                  {
                    id: "wd-1",
                    status: "wait",
                    label: "[Step 1] Reconstructing key…",
                  },
                  {
                    id: "wd-2",
                    status: "wait",
                    label: "[Step 2] Estimating fees…",
                  },
                  {
                    id: "wd-3",
                    status: "wait",
                    label: "[Step 3] Sweeping … to Destination",
                  },
                ];
          if (s.label.includes("Reconstructing"))
            steps[0] = { ...steps[0], status: "ok" };
          if (s.label.includes("Estimating") || s.label.includes("fee")) {
            steps[0] = { ...steps[0], status: "ok" };
            steps[1] = { ...steps[1], status: "ok" };
          }
          if (s.tag === "SIGN" || s.tag === "SEND") {
            steps[0] = { ...steps[0], status: "ok" };
            steps[1] = { ...steps[1], status: "ok" };
            steps[2] = { ...steps[2], label: step3Label };
          }
          if (s.tag === "DONE") {
            steps[0] = { ...steps[0], status: "ok" };
            steps[1] = { ...steps[1], status: "ok" };
            steps[2] = { ...steps[2], status: "done", label: step3Label };
          }
          return steps;
        });
      };
      let withdrawalHash: string | undefined;
      try {
        if (isGhost) {
          withdrawalHash = await withdrawFromGhostAddress(
            tx.address as `0x${string}`,
            cluster,
            trimmed,
            { type: "native" },
            keysContext.getMasterKeys!,
            wasm!,
            onStatus,
          );
        } else {
          withdrawalHash = await executeStealthWithdrawal(
            tx.privateKey as `0x${string}`,
            trimmed,
            onStatus,
          );
        }
        const amountFormatted = formatXlm(amountRaw);
        pushTx({
          cluster,
          kind: isGhost ? "ghost" : "received",
          counterparty: isGhost
            ? "Manual Ghost"
            : tx.address.slice(0, 10) + "…",
          amountStroops: amountRaw.toString(),
          tokenSymbol: "XLM",
          tokenAddress: null,
          amount: amountFormatted,
          txHash: withdrawalHash,
          stealthAddress: tx.address,
        });
        if (withdrawalHash && cluster != null) {
          showToast("Withdrawal successful", {
            explorerTx: { cluster, txSig: withdrawalHash },
          });
        }
        if (isGhost) {
          setGhostTxs((prev) => prev.filter((t) => t.id !== tx.id));
        } else {
          setFound((prev) =>
            prev.map((t) => (t.id === tx.id ? { ...t, isSpent: true } : t)),
          );
        }
        setClaimModalTx((prev) => (prev?.id === tx.id ? null : prev));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setClaimError(msg);
        setWithdrawalSteps((prev) => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1];
          return prev
            .slice(0, -1)
            .concat([{ ...last, status: "error" as const, detail: msg }]);
        });
      } finally {
        setClaimingId(null);
      }
    },
    [
      cluster,
      pushTx,
      showToast,
      keysContext.isSetup,
      keysContext.getMasterKeys,
      wasm,
      logPush,
    ],
  );

  useEffect(() => {
    if (!claimModalTx) {
      setWithdrawalPreview(null);
      return;
    }
    const destination = (destinationByTxId[claimModalTx.id] ?? "").trim();
    if (!destination || !isAddress(destination)) {
      setWithdrawalPreview(null);
      return;
    }
    let sourcePublicKey = claimModalTx.stealthStellarAddress;
    if (!sourcePublicKey && claimModalTx.privateKey) {
      try {
        sourcePublicKey = deriveStealthStellarAddressFromStealthPrivKey(
          hexToBytes(claimModalTx.privateKey as `0x${string}`),
        );
      } catch {
        sourcePublicKey = undefined;
      }
    }
    if (!sourcePublicKey || !StrKey.isValidEd25519PublicKey(sourcePublicKey)) {
      setWithdrawalPreview({
        txId: claimModalTx.id,
        loading: false,
        error: "Cannot estimate withdrawal from this stealth address.",
      });
      return;
    }
    let cancelled = false;
    setWithdrawalPreview({ txId: claimModalTx.id, loading: true });
    getNativeWithdrawalQuote({ sourcePublicKey, destination })
      .then((quote) => {
        if (!cancelled)
          setWithdrawalPreview({
            txId: claimModalTx.id,
            loading: false,
            quote,
          });
      })
      .catch((err) => {
        if (!cancelled) {
          setWithdrawalPreview({
            txId: claimModalTx.id,
            loading: false,
            error:
              err instanceof Error
                ? err.message
                : "Could not estimate withdrawal.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [claimModalTx, destinationByTxId]);

  const handleRetrySync = useCallback(async () => {
    if (cluster == null) return;
    useVaultStore.getState().setLastSyncedBlock(null);
    setSyncingPaused(false);
    setSyncError(null);
    await scanner.retrySync();
  }, [cluster, scanner]);

  const handleRefreshBalances = useCallback(async () => {
    setSyncingPaused(false);
    setSyncError(null);
    setRefreshing(true);
    try {
      await scanner.refresh();
    } finally {
      setRefreshing(false);
    }
  }, [scanner]);

  useEffect(() => {
    if (!wasmReady || wasm === null || cluster == null || !connection) {
      if (cluster == null) setLoading(false);
      return;
    }
    if (scanner.announcements.length === 0) {
      if (scanner.progress.phase === "done") {
        setFound([]);
        setLoading(false);
      }
      return;
    }

    setLoading(true);
    const getMasterKeys = keysContext.isSetup
      ? keysContext.getMasterKeys
      : null;
    const addDiscoveredTrait = useReputationStore.getState().addDiscoveredTrait;
    const runMatch = () => {
      const rawLogs = scanner.announcements.map(cachedToLogWithArgs);
      processRawLogsToFoundTxs(
        connection,
        rawLogs,
        wasm,
        getMasterKeys,
        cluster,
      )
        .then((txs) => {
          setFound((prev) => {
            const prevIds = new Set(prev.map((t) => t.id));
            const newIds = txs
              .filter((t) => !prevIds.has(t.id))
              .map((t) => t.id);
            if (newIds.length > 0)
              setNewlyDetectedIds((old) => [...old, ...newIds]);
            return txs;
          });
          logPush(
            "wasm",
            `Matched ${txs.length} owned announcement(s) from cache`,
          );

          scanForAttestations(
            wasm,
            getMasterKeys,
            scanner.announcements,
            addDiscoveredTrait,
          );
        })
        .catch((err) => console.warn("📥 [Opaque] Match error", err))
        .finally(() => {
          setLoading(false);
          scanner.markSyncComplete();
        });
    };

    if (typeof requestIdleCallback !== "undefined") {
      requestIdleCallback(runMatch, { timeout: 500 });
    } else {
      setTimeout(runMatch, 0);
    }
  }, [
    scanner.announcements,
    scanner.progress.phase,
    wasmReady,
    wasm,
    cluster,
    connection,
    keysContext.isSetup,
    keysContext.getMasterKeys,
    logPush,
    scanner,
  ]);

  useEffect(() => {
    if (scanner.progress.phase === "error" && scanner.progress.error) {
      setSyncingPaused(true);
      setSyncError(scanner.progress.error);
    }
  }, [scanner.progress.phase, scanner.progress.error]);

  useEffect(() => {
    if (cluster == null || !wasm) return;
    const { ghostBalances } = scanner;
    const addressesWithBalance = Object.keys(ghostBalances).filter((key) => {
      return (ghostBalances[key] ?? 0n) > 0n;
    });
    if (addressesWithBalance.length === 0) {
      setGhostTxs([]);
      return;
    }
    const getMasterKeys = keysContext.isSetup
      ? keysContext.getMasterKeys
      : null;
    const ghostFound: FoundTx[] = [];
    for (const key of addressesWithBalance) {
      const addr = key as `0x${string}`;
      const balance = ghostBalances[key] ?? 0n;
      const g = ghostEntries.find(
        (e) => e.stealthAddress.toLowerCase() === key,
      );
      let privateKey: string | undefined;
      if (g?.ephemeralPrivKeyHex && getMasterKeys && wasm) {
        try {
          const masterKeys = getMasterKeys();
          const ephemeralPubKey = secp256k1.getPublicKey(
            toHexBytes(g.ephemeralPrivKeyHex),
            true,
          );
          const stealthPrivKeyBytes = wasm.reconstruct_signing_key_wasm(
            masterKeys.spendPrivKey,
            masterKeys.viewPrivKey,
            ephemeralPubKey,
          );
          privateKey =
            "0x" +
            Array.from(stealthPrivKeyBytes)
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("");
        } catch {
          /* omit key if reconstruction fails */
        }
      }
      const ghostTx: FoundTx = {
        id: `ghost-${addr}`,
        address: addr,
        balance,
        privateKey,
        txHash: "",
        blockNumber: 0,
        isSpent: false,
        source: "manual",
      };
      ghostFound.push(ghostTx);
    }
    setGhostTxs(ghostFound);
  }, [
    cluster,
    wasm,
    keysContext.isSetup,
    keysContext.getMasterKeys,
    ghostEntries,
    scanner,
  ]);

  useEffect(() => {
    if (newlyDetectedIds.length === 0) return;
    const t = setTimeout(() => setNewlyDetectedIds([]), 2200);
    return () => clearTimeout(t);
  }, [newlyDetectedIds]);

  const allEntries = portfolio.entries;
  const totalSol = portfolio.totalRaw;

  return (
    <div className="w-full flex flex-col">
      <div className="mb-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-display text-2xl font-bold text-white">
              Private balance
            </h2>
            <p className="mt-1 text-sm text-mist">
              XLM across your stealth addresses. Withdraw to any Stellar
              address.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleRefreshBalances}
              disabled={
                refreshing ||
                scanner.progress.phase === "syncing" ||
                scanner.progress.phase === "backfilling" ||
                scanner.progress.phase === "indexer-fetch"
              }
              className="rounded-xl border border-ink-600 bg-ink-950/30 px-3.5 py-2 text-sm font-medium text-mist transition-colors hover:border-sol-purple/30 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
            <button
              type="button"
              onClick={() => {
                setManualImportOpen(true);
                setManualImportAddress("");
                setManualImportError(null);
              }}
              className="rounded-xl border border-ink-600 bg-ink-950/30 px-3.5 py-2 text-sm font-medium text-mist transition-colors hover:border-sol-purple/30 hover:text-white"
            >
              Import ghost
            </button>
          </div>
        </div>

        {/* Scanning status */}
        <div
          className={`mt-5 p-4 rounded-2xl bg-ink-900/35 border border-ink-700/60 ${
            scanner.progress.phase === "syncing" ||
            scanner.progress.phase === "backfilling" ||
            scanner.progress.phase === "indexer-fetch"
              ? "scanner-pulse"
              : ""
          } ${syncingPaused ? "border-amber-500/40" : ""}`}
        >
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="text-sm text-mist font-mono">
              {syncingPaused
                ? "Syncing Paused"
                : scanner.progress.phase === "indexer-fetch"
                  ? "Syncing with Indexer…"
                  : scanner.progress.phase === "indexer-fetched"
                    ? "Scanning Vault…"
                    : scanner.progress.phase === "backfilling"
                      ? "Optimizing Vault…"
                      : scanner.progress.phase === "syncing" ||
                          scanner.progress.phase === "loading-cache"
                        ? "Scanning"
                        : scanner.progress.phase === "done"
                          ? "Idle"
                          : scanner.progress.phase === "error"
                            ? "Error"
                            : "Idle"}
            </span>
            <span className="text-slate-200 text-sm font-mono">
              {scanner.progress.currentBlock > 0n
                ? `Slot ${Number(scanner.progress.currentBlock).toLocaleString()}`
                : scanner.progress.phase === "syncing" ||
                    scanner.progress.phase === "backfilling"
                  ? "…"
                  : "—"}
            </span>
          </div>
          <div className="h-1 rounded-full bg-ink-800 overflow-hidden">
            <div
              className="h-full bg-sol-purple/40 rounded-full transition-all duration-500"
              style={{ width: `${scanner.progress.percent}%` }}
            />
          </div>
          {(scanner.progress.message || scanner.isBackfilling) &&
            !syncingPaused && (
              <p className="text-mist/70 text-xs mt-2 font-mono">
                {scanner.progress.phase === "indexer-fetched"
                  ? "Scanning Vault…"
                  : scanner.isBackfilling
                    ? `Optimizing Vault… [${scanner.progress.percent}%]`
                    : scanner.progress.message}
              </p>
            )}
          {syncingPaused && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <p
                className="text-amber-500/90 text-xs font-mono flex-1 min-w-0 truncate"
                title={syncError ?? undefined}
              >
                {syncError ?? "RPC error"}
              </p>
              <button
                type="button"
                onClick={handleRetrySync}
                className="px-2 py-1 text-xs font-medium rounded-lg bg-amber-500/20 text-amber-200 hover:bg-amber-500/30 border border-amber-500/40"
              >
                Retry Sync
              </button>
            </div>
          )}
        </div>
      </div>

      {claimError && (
        <div className="mb-4 p-3 rounded-xl bg-error/10 border border-error/30 text-error text-sm">
          {claimError}
        </div>
      )}

      {!wasmReady ? (
        <div className="rounded-2xl border border-ink-700 bg-ink-900/25 p-6">
          <p className="text-mist text-sm">Initializing cryptography…</p>
        </div>
      ) : loading ? (
        <div className="rounded-2xl border border-ink-700 bg-ink-900/25 p-6">
          <p className="text-mist text-sm">Deciphering payments…</p>
        </div>
      ) : totalSol === 0n && allEntries.length === 0 ? (
        <div className="rounded-2xl border border-ink-700 bg-ink-900/25 p-6">
          <p className="text-mist text-sm">No incoming payments found yet.</p>
          <p className="text-mist/70 text-xs mt-1">
            Payments sent to your stealth address will appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Total balance */}
          <div className="rounded-2xl border border-ink-700 bg-ink-900/30 p-6">
            <p className="text-mist text-sm">Total XLM</p>
            <p className="font-display text-2xl font-bold text-white mt-1">
              {formatXlm(totalSol)}
            </p>
            <p className="text-mist/70 text-xs mt-1">
              {allEntries.length} address{allEntries.length !== 1 ? "es" : ""}
            </p>
          </div>

          {/* List of stealth addresses */}
          <h3 className="font-display text-xl font-bold text-white">
            XLM — Stealth addresses
          </h3>
          <div className="space-y-3">
            {allEntries
              .filter((e) => e.balanceRaw > 0n)
              .map(({ tx, balanceRaw }) => {
                const amountStr = formatXlm(balanceRaw);
                const ghostEntry = ghostEntries.find(
                  (e) =>
                    e.stealthAddress.toLowerCase() === tx.address.toLowerCase(),
                );
                const ghostEntryAny = ghostStoreEntries.find(
                  (e) =>
                    e.cluster === cluster &&
                    e.stealthAddress.toLowerCase() === tx.address.toLowerCase(),
                );
                const canReconstructKey = !!(
                  ghostEntry?.ephemeralPrivKeyHex && ghostEntry?.stealthAddress
                );
                const announcerConfigured = !!currentConfig?.announcerProgram;
                const ghostAnnouncedOnChain =
                  cluster != null &&
                  !!ghostAnnouncementKeys[
                    ghostAnnouncementEntryKey(cluster, tx.address)
                  ];
                const canAnnounceGhostOnchain =
                  tx.source === "manual" &&
                  cluster != null &&
                  announcerConfigured &&
                  !!ghostEntryAny?.ephemeralPrivKeyHex &&
                  !!keysContext.stealthMetaAddressHex &&
                  !!wasm &&
                  !ghostAnnouncedOnChain;
                const isGhostWithoutKey =
                  tx.source === "manual" &&
                  !tx.privateKey &&
                  !canReconstructKey;
                if (isGhostWithoutKey) {
                  return (
                    <div
                      key={tx.id}
                      className="rounded-2xl border border-amber-500/40 bg-amber-500/5 p-5 flex flex-wrap items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/40">
                            Manual/Ghost Funds
                          </span>
                          <ExplorerLink
                            cluster={cluster}
                            value={tx.address}
                            type="address"
                            className="text-mist text-xs"
                          />
                        </div>
                        <p className="text-success font-semibold mt-0.5">
                          {amountStr} XLM
                        </p>
                        <p className="text-amber-500/90 text-xs mt-1">
                          This address was generated incorrectly and cannot be
                          spent.
                        </p>
                      </div>
                      {cluster != null && (
                        <button
                          type="button"
                          onClick={() => {
                            watchlistArchive(cluster, tx.address);
                            showToast(
                              "Address archived. It will no longer be polled for balances.",
                            );
                          }}
                          className="px-2 py-1 text-xs rounded-lg border border-ink-600 text-mist hover:border-sol-purple/30 hover:text-white transition-colors"
                        >
                          Archive
                        </button>
                      )}
                    </div>
                  );
                }
                return (
                  <div
                    key={tx.id}
                    className="rounded-2xl border border-ink-700 bg-ink-900/25 p-5 flex flex-wrap items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        {tx.source === "manual" && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/40">
                            Manual/Ghost Funds
                          </span>
                        )}
                        <ExplorerLink
                          cluster={cluster}
                          value={tx.address}
                          type="address"
                          className="text-mist text-xs"
                        />
                        {tx.txHash && (
                          <ExplorerLink
                            cluster={cluster}
                            value={tx.txHash}
                            type="tx"
                            className="text-mist/70 text-xs"
                            startChars={8}
                            endChars={6}
                          />
                        )}
                      </div>
                      <p className="text-success font-semibold mt-0.5">
                        {amountStr} XLM
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {tx.source === "manual" && cluster != null && (
                        <button
                          type="button"
                          onClick={() => {
                            watchlistArchive(cluster, tx.address);
                            showToast(
                              "Address archived. It will no longer be polled for balances.",
                            );
                          }}
                          className="px-2 py-1 text-xs rounded-md border border-neutral-600 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-300"
                        >
                          Archive
                        </button>
                      )}
                      {canAnnounceGhostOnchain &&
                        ghostEntryAny?.ephemeralPrivKeyHex && (
                          <button
                            type="button"
                            onClick={() =>
                              setGhostAnnounceTarget({
                                stealthAddress: tx.address as `0x${string}`,
                                ephemeralPrivKeyHex:
                                  ghostEntryAny.ephemeralPrivKeyHex as `0x${string}`,
                              })
                            }
                            className="px-2 py-1 text-xs rounded-md border border-cyan-500/50 text-cyan-300 hover:bg-cyan-500/10"
                          >
                            Announce on-chain
                          </button>
                        )}
                      <button
                        type="button"
                        disabled={
                          !(destinationByTxId[tx.id] ?? "").trim() ||
                          !isAddress((destinationByTxId[tx.id] ?? "").trim()) ||
                          claimingId !== null
                        }
                        onClick={() => {
                          setClaimModalTx(tx);
                        }}
                        className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-sol-gradient text-white disabled:opacity-40 disabled:cursor-not-allowed hover:enabled:opacity-90"
                      >
                        {claimingId === tx.id ? "Withdrawing…" : "Withdraw"}
                      </button>
                    </div>
                    <div className="w-full mt-2">
                      <input
                        type="text"
                        value={destinationByTxId[tx.id] ?? ""}
                        onChange={(e) => setDestination(tx.id, e.target.value)}
                        placeholder="Destination Stellar address (G…)…"
                        className="input-field text-sm"
                      />
                      {mainWalletAddress && (
                        <button
                          type="button"
                          onClick={() =>
                            setDestination(tx.id, mainWalletAddress)
                          }
                          className="mt-1.5 px-2 py-1 text-xs rounded-md btn-secondary"
                        >
                          Use connected wallet
                        </button>
                      )}
                    </div>
                  </div>
                );
              }) ?? null}
          </div>
        </div>
      )}

      {claimModalTx &&
        ((() => {
          const entry = ghostEntries.find(
            (e) =>
              e.stealthAddress.toLowerCase() ===
              claimModalTx.address.toLowerCase(),
          );
          const hasKey = !!(
            entry?.ephemeralPrivKeyHex && entry?.stealthAddress
          );
          const showIncorrectlyGenerated =
            claimModalTx.source === "manual" &&
            !claimModalTx.privateKey &&
            !hasKey;
          return showIncorrectlyGenerated;
        })() ? (
          <ModalShell
            open
            title="Cannot withdraw"
            description="This manual ghost address was generated incorrectly and cannot be spent."
            onClose={() => {
              setClaimModalTx(null);
              setClaimError(null);
            }}
            maxWidthClassName="max-w-md"
          >
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setClaimModalTx(null);
                  setClaimError(null);
                }}
                className="rounded-xl border border-ink-600 bg-ink-950/30 px-4 py-2 text-sm font-medium text-mist hover:border-sol-purple/30 hover:text-white transition-colors"
              >
                Close
              </button>
            </div>
          </ModalShell>
        ) : (
          <ClaimModal
            tx={claimModalTx}
            asset={nativeAsset}
            destination={destinationByTxId[claimModalTx.id] ?? ""}
            mainWalletAddress={mainWalletAddress ?? undefined}
            cluster={cluster}
            claiming={claimingId === claimModalTx.id}
            error={claimError}
            withdrawalPreview={
              withdrawalPreview?.txId === claimModalTx.id
                ? withdrawalPreview
                : null
            }
            onDestinationChange={(value: string) =>
              setDestination(claimModalTx.id, value)
            }
            onConfirm={() =>
              handleClaim(
                claimModalTx,
                destinationByTxId[claimModalTx.id] ?? "",
              )
            }
            onClose={() => {
              setClaimModalTx(null);
              setClaimError(null);
              setWithdrawalSteps([]);
            }}
            withdrawalSteps={withdrawalSteps}
          />
        ))}

      {ghostAnnounceTarget &&
        cluster != null &&
        keysContext.stealthMetaAddressHex &&
        wasm &&
        currentConfig?.announcerProgram && (
          <GhostAnnounceModal
            open
            onClose={() => setGhostAnnounceTarget(null)}
            cluster={cluster}
            ghostStealthAddress={ghostAnnounceTarget.stealthAddress}
            ephemeralPrivKeyHex={ghostAnnounceTarget.ephemeralPrivKeyHex}
            stealthMetaAddressHex={keysContext.stealthMetaAddressHex}
            wasm={wasm}
            getMasterKeys={keysContext.getMasterKeys}
            announcerContract={currentConfig.announcerProgram}
            onAnnounced={() => {
              setGhostAnnounceTarget(null);
              showToast(
                "Announced on-chain. Removed from manual ghost tracking.",
              );
            }}
          />
        )}

      {manualImportOpen && (
        <ModalShell
          open
          title="Import ghost address"
          description="Add a previously generated stealth address to tracking. Without its ephemeral key, you can view balance but cannot withdraw."
          onClose={() => setManualImportOpen(false)}
          maxWidthClassName="max-w-md"
        >
          <input
            type="text"
            value={manualImportAddress}
            onChange={(e) => {
              setManualImportAddress(e.target.value);
              setManualImportError(null);
            }}
            placeholder="0x… or Stellar address (G…)"
            className="input-field w-full mb-2 font-mono text-sm"
          />
          {manualImportError && (
            <p className="text-error text-xs mb-3">{manualImportError}</p>
          )}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => setManualImportOpen(false)}
              className="rounded-xl border border-ink-600 bg-ink-950/30 px-4 py-2 text-sm font-medium text-mist hover:border-sol-purple/30 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                const trimmed = manualImportAddress.trim();
                if (!trimmed) {
                  setManualImportError("Enter an address.");
                  return;
                }
                if (!isAddress(trimmed)) {
                  setManualImportError("Invalid address.");
                  return;
                }
                if (cluster == null) {
                  setManualImportError("Connect to a network first.");
                  return;
                }
                const allEntries = useGhostAddressStore.getState().entries;
                const storedEntry = allEntries.find(
                  (e) =>
                    e.stealthAddress.toLowerCase() === trimmed.toLowerCase(),
                );
                const existsInGhost = ghostEntries.some(
                  (e) =>
                    e.stealthAddress.toLowerCase() === trimmed.toLowerCase(),
                );
                const existsInWatchlist = watchlistAddresses.some(
                  (a) => a.toLowerCase() === trimmed.toLowerCase(),
                );
                if (existsInGhost || existsInWatchlist) {
                  setManualImportError(
                    "Address is already in the tracking list.",
                  );
                  return;
                }
                if (storedEntry?.ephemeralPrivKeyHex) {
                  useGhostAddressStore.getState().add({
                    cluster,
                    stealthAddress: trimmed,
                    ephemeralPrivKeyHex: storedEntry.ephemeralPrivKeyHex,
                  });
                }
                watchlistAdd(cluster, trimmed);
                setManualImportOpen(false);
                showToast("Ghost address added. Checking for funds…");
              }}
              className="rounded-xl bg-sol-gradient px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
            >
              Add & check
            </button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}
