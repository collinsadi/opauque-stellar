import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { debugLog } from "../lib/debugLog";
import { StrKey } from "@stellar/stellar-sdk";
import {
  bytesToHex,
  deriveStealthStellarAddressFromStealthPrivKey,
  formatXlm,
  hexToBytes,
} from "../lib/stealth";
import type { ScanWorkerAnnouncement, ScanWorkerMatch } from "../workers/scannerWorker";
import { getCluster, type StellarNetwork } from "../lib/chain";
import { getConfigForCluster } from "../contracts/contract-config";
import { getPoolConfig } from "../contracts/poolConfig";

function isAddress(a: string): boolean {
  const t = a.trim();
  if (t.startsWith("0x") && t.length === 42)
    return /^0x[0-9a-fA-F]{40}$/i.test(t);
  return StrKey.isValidEd25519PublicKey(t);
}
import { useOpaqueWasm } from "../hooks/useOpaqueWasm";
import { useScanner } from "../hooks/useScanner";
import { useScannerWorker } from "../hooks/useScannerWorker";
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
import { GhostPersistenceWarning } from "./GhostPersistenceWarning";
import { useWatchlist, useWatchlistStore } from "../hooks/useWatchlist";
import { useVaultStore } from "../store/vaultStore";
import { useToast } from "../context/ToastContext";
import { secp256k1 } from "@noble/curves/secp256k1";
import { getNativeToken } from "../lib/tokens";
import type { TokenInfo } from "../lib/tokens";
import { ExplorerLink } from "./ExplorerLink";
import { PrivacyWarningCallout } from "./PrivacyWarningCallout";
import { UnscannedRangeNotice } from "./UnscannedRangeNotice";
import { SCANNER_PRIVACY_WARNING } from "../lib/privacyThreatModel";
import {
  ghostAnnouncementEntryKey,
  useGhostAnnouncementStore,
} from "../store/ghostAnnouncementStore";
import { GhostAnnounceModal } from "./GhostAnnounceModal";
import { PoolSweepModal } from "./PoolSweepModal";
import type { PoolSweepResult } from "../lib/poolSweep";
import { ModalShell } from "./ModalShell";
import { RecoveryDocLink } from "./RecoveryDocLink";
import { getFeatureFlags } from "../lib/featureFlags";
import {
  notifyScanComplete,
  requestScanNotificationPermission,
} from "../lib/scanNotifications";

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

/**
 * The Stellar G-address that actually holds a stealth receive, for display.
 * Prefer the stored address; otherwise derive it from the reconstructed private
 * key. Falls back to undefined when neither is available (e.g. a watched-only
 * ghost), so callers can show the raw identifier instead.
 */
function stellarAddressForTx(tx: FoundTx): string | undefined {
  if (tx.stealthStellarAddress) return tx.stealthStellarAddress;
  if (tx.privateKey) {
    try {
      return deriveStealthStellarAddressFromStealthPrivKey(
        hexToBytes(tx.privateKey as `0x${string}`),
      );
    } catch {
      return undefined;
    }
  }
  return undefined;
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

/**
 * Optional off-main-thread trial-decryption backend (#606). When supplied,
 * the view-tag + full match loop below runs in a Web Worker instead of on
 * the main thread, keeping the UI responsive during a full scan. Falls back
 * to the original in-line loop when omitted (e.g. worker unsupported/not wired
 * in a given call site), so this stays a strictly additive, opt-in change.
 */
export type ScanBatchFn = (
  items: ScanWorkerAnnouncement[],
  viewPrivKeyHex: string,
  spendPubKeyHex: string,
) => Promise<ScanWorkerMatch[]>;

async function processRawLogsToFoundTxs(
  connection: StellarBalanceClient,
  rawLogs: LogWithArgs[],
  wasm: OpaqueWasmModule | null,
  getMasterKeys: (() => MasterKeys) | null,
  _cluster: StellarNetwork,
  scanBatch?: ScanBatchFn,
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
  let matched: LogRow[];

  if (scanBatch) {
    // Off-main-thread path (#606): delegate trial decryption to the scanner
    // worker. A memory-pressure abort (#605) still resolves here with
    // whatever matched before the abort — the worker's resumable cursor is
    // surfaced to the UI via the `useScannerWorker` hook state, not here.
    const byId = new Map(rows.map((row) => [row.id, row]));
    const items: ScanWorkerAnnouncement[] = rows.map((row, index) => ({
      index,
      id: row.id,
      stealthAddress: row.stealthAddress,
      viewTag: row.viewTag,
      ephemeralPubKeyHex: row.ephemeralPubKeyHex ?? "",
    }));
    const workerMatches = await scanBatch(
      items,
      bytesToHex(viewPrivKey),
      bytesToHex(spendPubKey),
    );
    matched = [];
    for (const m of workerMatches) {
      const row = byId.get(m.id);
      if (row) {
        debugLog("🎯 [Opaque] Match found for address:", row.stealthAddress);
        matched.push(row);
      }
    }
  } else {
    matched = [];
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

        debugLog("🎯 [Opaque] Match found for address:", row.stealthAddress);
        matched.push(row);
      } catch (err) {
        console.warn("🔑 [Opaque] Skipping malformed log:", row.id, err);
      }
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
  debugLog("📥 [Opaque] PrivateBalance: fetchFoundTxs done", {
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
      debugLog(
        `📥 [Opaque] Discovered ${parsed.data.length} attestation trait(s)`,
      );
    }
  } catch (err) {
    console.warn("📥 [Opaque] Attestation scan error (non-fatal):", err);
  }
}

export type PortfolioEntry = { tx: FoundTx; balanceRaw: bigint };

// A stealth address is always a bare account (no subentries), so Stellar locks
// 2 x base reserve = 1 XLM as its minimum balance and a sweep costs one base
// fee. At or below that, spendable would be <= 0: the receive is real but
// cannot be withdrawn (a payment can never drop an account below its reserve).
// We treat these as dust and hide them by default behind a toggle.
const DUST_CEILING_STROOPS = 10_000_000n + 100n; // 1 XLM reserve + 0.00001 fee

const SHOW_DUST_STORAGE_KEY = "opaque-show-dust";
const SCAN_NOTIFICATIONS_STORAGE_KEY = "opaque-scan-notifications";

// Initial render is capped to one page; "Load more" grows it incrementally
// instead of rendering the full (potentially thousands-long) history at once.
const ANNOUNCEMENT_PAGE_SIZE = 20;

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
  const [poolSweepTx, setPoolSweepTx] = useState<FoundTx | null>(null);
  const [syncingPaused, setSyncingPaused] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const { wasm, isReady: wasmReady } = useOpaqueWasm();
  const scannerWorker = useScannerWorker();
  const lastScanInputsRef = useRef<{
    items: ScanWorkerAnnouncement[];
    viewPrivKeyHex: string;
    spendPubKeyHex: string;
  } | null>(null);
  const scanBatch = useCallback<ScanBatchFn>(
    (items, viewPrivKeyHex, spendPubKeyHex) => {
      lastScanInputsRef.current = { items, viewPrivKeyHex, spendPubKeyHex };
      return scannerWorker.scan(items, viewPrivKeyHex, spendPubKeyHex);
    },
    [scannerWorker.scan],
  );
  const handleResumeScan = useCallback(() => {
    const inputs = lastScanInputsRef.current;
    if (!inputs) return;
    void scannerWorker.resume(inputs.items, inputs.viewPrivKeyHex, inputs.spendPubKeyHex);
  }, [scannerWorker.resume]);
  const keysContext = useKeys();
  const { address: mainWalletAddress, connection } = useWallet();
  const cluster = getCluster();
  const manualGhostEnabled = getFeatureFlags().manualGhostAddresses;
  const currentConfig = getConfigForCluster(cluster);
  const poolEnabled = useMemo(() => {
    void cluster;
    return !!getPoolConfig();
  }, [cluster]);
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
  const [searchQuery, setSearchQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(ANNOUNCEMENT_PAGE_SIZE);
  const [showDust, setShowDust] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SHOW_DUST_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [scanNotificationsEnabled, setScanNotificationsEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SCAN_NOTIFICATIONS_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleShowDust = useCallback(() => {
    setShowDust((v) => {
      const next = !v;
      try {
        localStorage.setItem(SHOW_DUST_STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* localStorage unavailable; keep in-memory only */
      }
      return next;
    });
  }, []);
  const toggleScanNotifications = useCallback(async () => {
    if (!scanNotificationsEnabled) {
      const granted = await requestScanNotificationPermission();
      if (!granted) {
        showToast("Browser notifications were not enabled.");
        return;
      }
    }
    setScanNotificationsEnabled((v) => {
      const next = !v;
      try {
        localStorage.setItem(SCAN_NOTIFICATIONS_STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* localStorage unavailable; keep in-memory only */
      }
      return next;
    });
  }, [scanNotificationsEnabled, showToast]);
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

  // Resolve each stealth identifier (0x) to the Stellar G-address that holds
  // its funds, so balance polling queries the right account. New ghost entries
  // store the G-address; older ones are reconstructed from the ephemeral key.
  const ghostAddressResolver = useMemo(() => {
    const map: Record<string, string> = {};
    const getMasterKeys = keysContext.isSetup ? keysContext.getMasterKeys : null;
    for (const g of ghostEntries) {
      const key = g.stealthAddress.toLowerCase();
      if (g.stealthStellarAddress) {
        map[key] = g.stealthStellarAddress;
        continue;
      }
      if (g.ephemeralPrivKeyHex && getMasterKeys && wasm) {
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
          map[key] =
            deriveStealthStellarAddressFromStealthPrivKey(stealthPrivKeyBytes);
        } catch {
          /* skip entries we cannot resolve */
        }
      }
    }
    return map;
  }, [ghostEntries, wasm, keysContext.isSetup, keysContext.getMasterKeys]);

  const scanner = useScanner({
    cluster,
    publicClient: connection,
    announcerAddress: currentConfig?.announcerProgram ?? null,
    enabled: Boolean(wasmReady && cluster && currentConfig),
    ghostAddresses,
    watchlistAddresses:
      watchlistAddresses.length > 0 ? watchlistAddresses : undefined,
    addressResolver: ghostAddressResolver,
  });

  const nativeAsset: TokenInfo = getNativeToken();

  const portfolio = useMemo(() => {
    const activeTxs = [...found.filter((tx) => !tx.isSpent), ...ghostTxs];
    let claimableTotalRaw = 0n;
    let dustTotalRaw = 0n;
    const claimable: PortfolioEntry[] = [];
    const dust: PortfolioEntry[] = [];
    for (const tx of activeTxs) {
      const balanceRaw = tx.balance;
      if (balanceRaw <= 0n) continue;
      if (balanceRaw <= DUST_CEILING_STROOPS) {
        dustTotalRaw += balanceRaw;
        dust.push({ tx, balanceRaw });
      } else {
        claimableTotalRaw += balanceRaw;
        claimable.push({ tx, balanceRaw });
      }
    }
    return { asset: nativeAsset, claimable, dust, claimableTotalRaw, dustTotalRaw };
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
        // Return the same reference when already empty so React bails out of
        // the re-render instead of looping (a fresh [] would re-trigger this).
        setFound((prev) => (prev.length === 0 ? prev : []));
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
        scanBatch,
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
    scanBatch,
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
    // Depend on the stable balances slice, not the whole `scanner` object.
    // useScanner returns a fresh object every render, so depending on it here
    // (while the effect also calls setGhostTxs) caused an infinite render loop.
    scanner.ghostBalances,
  ]);

  useEffect(() => {
    if (newlyDetectedIds.length === 0) return;
    const t = setTimeout(() => setNewlyDetectedIds([]), 2200);
    return () => clearTimeout(t);
  }, [newlyDetectedIds]);

  useEffect(() => {
    if (!scanNotificationsEnabled || scanner.progress.phase !== "done") return;
    void notifyScanComplete({
      foundCount: found.filter((tx) => !tx.isSpent && tx.balance > 0n).length,
      newGhostCount: ghostTxs.filter((tx) => tx.balance > 0n).length,
    });
  }, [scanNotificationsEnabled, scanner.progress.phase, found, ghostTxs]);

  const claimableEntries = portfolio.claimable;
  const dustEntries = portfolio.dust;
  const allEntries = useMemo(
    () => (showDust ? [...claimableEntries, ...dustEntries] : claimableEntries),
    [showDust, claimableEntries, dustEntries],
  );
  // Headline reflects what is actually withdrawable; dust sits below the reserve.
  const totalSol = portfolio.claimableTotalRaw;

  // Search runs over the full in-memory list before pagination slices it, so
  // matches outside the currently loaded page are still found.
  const filteredEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return allEntries;
    return allEntries.filter(({ tx, balanceRaw }) => {
      const address = (stellarAddressForTx(tx) ?? tx.address).toLowerCase();
      return address.includes(q) || formatXlm(balanceRaw).toLowerCase().includes(q);
    });
  }, [allEntries, searchQuery]);

  useEffect(() => {
    setVisibleCount(ANNOUNCEMENT_PAGE_SIZE);
  }, [searchQuery, showDust]);

  const visibleEntries = filteredEntries.slice(0, visibleCount);
  const hasMoreEntries = filteredEntries.length > visibleEntries.length;

  return (
    <div className="w-full flex flex-col">
      <div className="mb-8">
        <GhostPersistenceWarning />
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
              className="rounded-xl border border-ink-600 bg-ink-950/30 px-3.5 py-2 text-sm font-medium text-mist transition-colors hover:border-white/30 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
            {manualGhostEnabled && (
            <button
              type="button"
              onClick={() => {
                setManualImportOpen(true);
                setManualImportAddress("");
                setManualImportError(null);
              }}
              className="rounded-xl border border-ink-600 bg-ink-950/30 px-3.5 py-2 text-sm font-medium text-mist transition-colors hover:border-white/30 hover:text-white"
            >
              Import ghost
            </button>
            )}
          </div>
        </div>

        <PrivacyWarningCallout message={SCANNER_PRIVACY_WARNING} className="mt-4" />

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-ink-700/60 bg-ink-900/25 p-4">
          <div>
            <p className="text-sm font-semibold text-white">Scan completion notifications</p>
            <p className="text-xs text-mist/70">
              Optional browser alerts announce completed scans without showing balances.
            </p>
          </div>
          <button
            type="button"
            onClick={toggleScanNotifications}
            className="rounded-xl border border-ink-600 bg-ink-950/30 px-3.5 py-2 text-sm font-medium text-mist transition-colors hover:border-white/30 hover:text-white"
          >
            {scanNotificationsEnabled ? "Disable" : "Enable"}
          </button>
        </div>

        {/* Scanning status */}
        <div
          className={`mt-5 p-4 rounded-2xl bg-ink-900/35 border border-ink-700/60 ${
            scanner.progress.phase === "syncing" ||
            scanner.progress.phase === "backfilling" ||
            scanner.progress.phase === "indexer-fetch"
              ? "scanner-pulse"
              : ""
          } ${syncingPaused ? "border-neutral-500/40" : ""}`}
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
                  : "-"}
            </span>
          </div>
          <div className="h-1 rounded-full bg-ink-800 overflow-hidden">
            <div
              className="h-full bg-white rounded-full transition-all duration-500"
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
                className="text-neutral-400/90 text-xs font-mono flex-1 min-w-0 truncate"
                title={syncError ?? undefined}
              >
                {syncError ?? "RPC error"}
              </p>
              <button
                type="button"
                onClick={handleRetrySync}
                className="px-2 py-1 text-xs font-medium rounded-lg bg-neutral-500/20 text-neutral-300 hover:bg-neutral-500/30 border border-neutral-500/40"
              >
                Retry Sync
              </button>
            </div>
          )}
          {scannerWorker.status === "aborted" && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <p className="text-neutral-400/90 text-xs font-mono flex-1 min-w-0">
                Scan paused near a memory limit at {scannerWorker.processed.toLocaleString()} of{" "}
                {scannerWorker.total.toLocaleString()} announcements.
              </p>
              <button
                type="button"
                onClick={handleResumeScan}
                className="px-2 py-1 text-xs font-medium rounded-lg bg-neutral-500/20 text-neutral-300 hover:bg-neutral-500/30 border border-neutral-500/40"
              >
                Resume Scan
              </button>
            </div>
          )}
        </div>
        <UnscannedRangeNotice range={scanner.progress.unscannedRange} className="mt-3" />
      </div>

      {claimError && (
        <div className="mb-4 p-3 rounded-xl bg-error/10 border border-error/30 text-error text-sm">
          {claimError}
        </div>
      )}

      {!wasmReady ? (
        <div className="rounded-2xl border border-ink-700 bg-ink-900/25 p-6">
          <p className="text-mist text-sm">Initializing scanner…</p>
        </div>
      ) : loading ? (
        <div className="rounded-2xl border border-ink-700 bg-ink-900/25 p-6">
          <p className="text-mist text-sm">Deciphering payments…</p>
        </div>
      ) : claimableEntries.length === 0 && dustEntries.length === 0 ? (
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
              {claimableEntries.length} address
              {claimableEntries.length !== 1 ? "es" : ""}
            </p>
          </div>

          {/* Dust toggle: receives at or below the 1 XLM reserve cannot be
              withdrawn, so they are hidden by default but always surfaced. */}
          {dustEntries.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ink-800 bg-ink-900/20 px-4 py-2.5">
              <p className="text-xs text-mist/80">
                {dustEntries.length} small receive
                {dustEntries.length !== 1 ? "s" : ""} below the 1 XLM reserve
                {" "}({formatXlm(portfolio.dustTotalRaw)} XLM, not withdrawable)
              </p>
              <button
                type="button"
                onClick={toggleShowDust}
                className="shrink-0 text-xs font-medium text-white hover:underline"
              >
                {showDust ? "Hide" : "Show"}
              </button>
            </div>
          )}

          {/* List of stealth addresses */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-display text-xl font-bold text-white">
              XLM Stealth addresses
            </h3>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by address or amount"
              className="w-full max-w-xs rounded-xl border border-ink-700 bg-ink-950 px-3 py-1.5 text-xs text-white placeholder:text-mist/40 focus:border-glow focus:outline-none sm:w-auto"
            />
          </div>
          {searchQuery.trim() && (
            <p className="text-xs text-mist/60">
              {filteredEntries.length} match{filteredEntries.length !== 1 ? "es" : ""} across all
              loaded payments
            </p>
          )}
          <div className="space-y-3">
            {visibleEntries
              .filter((e) => e.balanceRaw > 0n)
              .map(({ tx, balanceRaw }) => {
                const amountStr = formatXlm(balanceRaw);
                // Receives at or below the reserve+fee cannot be swept; render
                // them as informational-only cards (revealed via the toggle).
                if (balanceRaw <= DUST_CEILING_STROOPS) {
                  return (
                    <div
                      key={tx.id}
                      className="rounded-2xl border border-ink-800 bg-ink-900/20 p-5 flex flex-wrap items-center justify-between gap-3 opacity-80"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="text-xs px-1.5 py-0.5 rounded bg-ink-800 text-mist/70 border border-ink-700">
                            Below reserve
                          </span>
                          <ExplorerLink
                            cluster={cluster}
                            value={stellarAddressForTx(tx) ?? tx.address}
                            type="address"
                            className="text-mist text-xs"
                          />
                        </div>
                        <p className="text-mist font-semibold mt-0.5">
                          {amountStr} XLM
                        </p>
                        <p className="text-mist/60 text-xs mt-1">
                          Stellar locks 1 XLM as the account reserve, so this
                          receive cannot be withdrawn.
                        </p>
                      </div>
                    </div>
                  );
                }
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
                  manualGhostEnabled &&
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
                      className="rounded-2xl border border-neutral-500/40 bg-neutral-500/5 p-5 flex flex-wrap items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="text-xs px-1.5 py-0.5 rounded bg-neutral-500/20 text-neutral-400 border border-neutral-500/40">
                            Manual/Ghost Funds
                          </span>
                          <ExplorerLink
                            cluster={cluster}
                            value={stellarAddressForTx(tx) ?? tx.address}
                            type="address"
                            className="text-mist text-xs"
                          />
                        </div>
                        <p className="text-success font-semibold mt-0.5">
                          {amountStr} XLM
                        </p>
                        <p className="text-neutral-400/90 text-xs mt-1">
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
                          className="px-2 py-1 text-xs rounded-lg border border-ink-600 text-mist hover:border-white/30 hover:text-white transition-colors"
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
                          <span className="text-xs px-1.5 py-0.5 rounded bg-neutral-500/20 text-neutral-400 border border-neutral-500/40">
                            Manual/Ghost Funds
                          </span>
                        )}
                        <ExplorerLink
                          cluster={cluster}
                          value={stellarAddressForTx(tx) ?? tx.address}
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
                            className="px-2 py-1 text-xs rounded-md border border-neutral-400/50 text-neutral-300 hover:bg-neutral-400/10"
                          >
                            Announce on-chain
                          </button>
                        )}
                      {poolEnabled && tx.privateKey && (
                        <button
                          type="button"
                          disabled={claimingId !== null}
                          onClick={() => setPoolSweepTx(tx)}
                          className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-glow text-glow bg-transparent disabled:opacity-40 disabled:cursor-not-allowed hover:bg-glow hover:text-ink-950 transition-colors"
                        >
                          To privacy pool
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
                        className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-white border border-white text-black disabled:opacity-40 disabled:cursor-not-allowed hover:bg-black hover:text-white"
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

          {hasMoreEntries && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => setVisibleCount((n) => n + ANNOUNCEMENT_PAGE_SIZE)}
                className="rounded-xl border border-ink-600 bg-ink-950/30 px-4 py-2 text-sm font-medium text-mist transition-colors hover:border-white/30 hover:text-white"
              >
                Load more ({filteredEntries.length - visibleEntries.length} remaining)
              </button>
            </div>
          )}
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
                className="rounded-xl border border-ink-600 bg-ink-950/30 px-4 py-2 text-sm font-medium text-mist hover:border-white/30 hover:text-white transition-colors"
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

      {poolSweepTx && (
        <PoolSweepModal
          tx={poolSweepTx}
          cluster={cluster}
          onClose={() => setPoolSweepTx(null)}
          onSwept={(result: PoolSweepResult) => {
            setPoolSweepTx(null);
            if (cluster != null && result.hashes[0]) {
              showToast(
                `Moved ${formatXlm(result.totalDepositStroops)} XLM into the privacy pool as ${result.notesAdded} note(s).`,
                { explorerTx: { cluster, txSig: result.hashes[0] } },
              );
            } else {
              showToast(
                `Moved ${formatXlm(result.totalDepositStroops)} XLM into the privacy pool.`,
              );
            }
            void handleRefreshBalances();
          }}
        />
      )}

      {manualImportOpen && (
        <ModalShell
          open
          title="Import ghost address"
          description={
            <>
              Add a previously generated stealth address to tracking. Without its ephemeral key, you can view balance but cannot withdraw.{" "}
              <RecoveryDocLink section="manual-ghost">Ghost recovery guide</RecoveryDocLink>
            </>
          }
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
              className="rounded-xl border border-ink-600 bg-ink-950/30 px-4 py-2 text-sm font-medium text-mist hover:border-white/30 hover:text-white transition-colors"
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
              className="rounded-xl bg-white border border-white px-4 py-2 text-sm font-semibold text-black hover:bg-black hover:text-white"
            >
              Add & check
            </button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}
