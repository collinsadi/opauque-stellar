import { useCallback, useEffect, useMemo, useState } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import type { Tab } from "./Layout";
import { useWallet } from "../hooks/useWallet";
import { useToast } from "../context/ToastContext";
import { usePoolNoteStore } from "../store/poolNoteStore";
import { usePendingDepositStore } from "../store/pendingDepositStore";
import { getPoolConfig } from "../contracts/poolConfig";
import { getRelayerConfig } from "../contracts/relayerConfig";
import {
  buildEncryptedPoolNoteBackup,
  downloadBlob,
  poolNoteBackupFilename,
} from "../lib/poolNoteBackup";
import { getDocUrl } from "../lib/docsLinks";
import { deriveDeposit, newNoteSecrets, toHex32, unspentTotal, type PoolNote } from "../lib/poolNotes";
import {
  invokePoolDeposit,
  invokePoolWithdraw,
  invokeRelayerCancelJob,
  invokeRelayerCreateJob,
  invokeRelayerSlashJob,
} from "../lib/programs";
import {
  fetchNextLeafIndex,
  fetchPoolBalance,
  fetchPoolRoots,
  generateWithdrawProof,
} from "../lib/poolProver";
import {
  buildRelayedWithdrawPayload,
  buildRelayerJobDraft,
  defaultDeadlineLedger,
  deliverPayloadToRelayer,
  fetchRelayerBids,
  fetchRelayerJobStatus,
  pickStakeWeightedBid,
  publishAdvert,
  relayerGatewayUrl,
  type RelayerJobDraft,
  type VerifiedBid,
} from "../lib/relayerMarket";
import { fetchRelayerDirectory, type RelayerListing } from "../lib/relayerDirectory";
import {
  preferNonStalledBids,
  recordStalledRelayer,
  STALL_THRESHOLD_MS,
} from "../lib/censorshipDetection";
import { RelayerComparison } from "./RelayerComparison";
import { WithdrawFlowModal, type WithdrawStep, type WithdrawStepStatus } from "./WithdrawFlowModal";
import { ModalShell } from "./ModalShell";
import { DepositBackupGateModal } from "./DepositBackupGateModal";
import {
  createDepositBackupSession,
  loadDepositBackupSession,
  clearDepositBackupSession,
  type DepositBackupSession,
} from "../lib/depositBackupGate";

const STROOPS_PER_XLM = 10_000_000n;
const RELAYER_SUBMISSION_POLL_MS = 2_000;

/** Fallback denomination presets when the deployment manifest doesn't specify any. */
const DEFAULT_DEPOSIT_PRESETS_XLM = [10, 100, 1000, 10000];

function parseXlm(input: string): bigint | null {
  const s = input.trim();
  if (!/^\d+(\.\d{1,7})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const padded = (frac + "0000000").slice(0, 7);
  const v = BigInt(whole) * STROOPS_PER_XLM + BigInt(padded || "0");
  return v > 0n ? v : null;
}

function formatXlm(stroops: bigint): string {
  const neg = stroops < 0n;
  const abs = neg ? -stroops : stroops;
  const whole = abs / STROOPS_PER_XLM;
  const frac = (abs % STROOPS_PER_XLM).toString().padStart(7, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

function be32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let n = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PROOF_STEPS: WithdrawStep[] = [
  {
    id: "read-chain",
    title: "Rebuild the pool's Merkle trees",
    detail:
      "Replaying every on-chain Deposit and Withdraw to reconstruct the commitment tree and the ASP approval tree locally, in your browser.",
    status: "pending",
  },
  {
    id: "check-roots",
    title: "Match the published roots",
    detail:
      "Confirming the locally rebuilt roots equal the roots the contract published, so it will accept the proof.",
    status: "pending",
  },
];

function walletSteps(): WithdrawStep[] {
  return [
    ...PROOF_STEPS.map((s) => ({ ...s })),
    {
      id: "prove",
      title: "Generate the zero-knowledge proof",
      detail:
        "Proving in your browser that you own one ASP-approved deposit — without revealing which deposit, the amount link, or your identity.",
      status: "pending",
    },
    {
      id: "submit",
      title: "Submit & verify on-chain",
      detail:
        "Your wallet sends the Groth16 proof; the pool contract verifies it on-chain and releases the funds to the recipient.",
      status: "pending",
    },
  ];
}

function relayerSteps(): WithdrawStep[] {
  return [
    ...PROOF_STEPS.map((s) => ({ ...s })),
    {
      id: "prove",
      title: "Generate the zero-knowledge proof",
      detail:
        "Proving in your browser that you own one ASP-approved deposit. The proof is bound to the relayer registry, not to your wallet.",
      status: "pending",
    },
    {
      id: "create-job",
      title: "Escrow the relayer fee",
      detail:
        "Posting a job to the relayer registry and locking the fee in escrow. This transaction is public but reveals nothing about the recipient or amount.",
      status: "pending",
    },
    {
      id: "advert",
      title: "Advertise to the relayer market",
      detail: "Broadcasting the job so staked relayers can compete to submit it for you.",
      status: "pending",
    },
    {
      id: "bids",
      title: "Collect relayer bids",
      detail: "Fetching signed bids and verifying each relayer's stake and key on-chain.",
      status: "pending",
    },
    {
      id: "pick",
      title: "Pick a relayer",
      detail:
        "Choose who submits your withdrawal. They only ever receive an encrypted payload and cannot change the recipient, amount, or proof.",
      status: "pending",
    },
    {
      id: "deliver",
      title: "Hand off & submit",
      detail:
        "The payload is sealed to the relayer's key. They submit it on-chain, so your wallet is never linked to the withdrawal.",
      status: "pending",
    },
  ];
}

const card = "rounded-2xl border border-ink-700 bg-ink-900/60 p-5";

export function PoolView({ readOnly = false }: { onNavigate?: (tab: Tab) => void; readOnly?: boolean }) {
  const wallet = useWallet();
  const { publicKey, signTransaction, connected } = wallet;
  const cluster = wallet.cluster ?? "testnet";
  const { showToast } = useToast();
  const cfg = useMemo(() => {
    void cluster;
    return getPoolConfig();
  }, [cluster]);
  const relayerCfg = useMemo(() => {
    void cluster;
    return getRelayerConfig();
  }, [cluster]);

  const notes = usePoolNoteStore((s) => s.notes);
  const addNote = usePoolNoteStore((s) => s.addNote);
  const markSpent = usePoolNoteStore((s) => s.markSpent);
  const pendingDeposits = usePendingDepositStore((s) => s.deposits);
  const addOptimistic = usePendingDepositStore((s) => s.addOptimistic);
  const confirmDeposit = usePendingDepositStore((s) => s.confirmDeposit);
  const failDeposit = usePendingDepositStore((s) => s.failDeposit);
  const removePendingDeposit = usePendingDepositStore((s) => s.remove);

  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [depositGateSession, setDepositGateSession] = useState<DepositBackupSession | null>(() => loadDepositBackupSession());
  const [isDepositSigning, setIsDepositSigning] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupPin, setBackupPin] = useState("");
  const [backupConfirm, setBackupConfirm] = useState("");
  const [backupAcknowledged, setBackupAcknowledged] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [poolBalance, setPoolBalance] = useState<bigint | null>(null);
  const [roots, setRoots] = useState<{ stateRoot: string | null; aspRoot: string | null } | null>(null);
  const [submitMode, setSubmitMode] = useState<"wallet" | "relayer">("wallet");
  const [relayerFee, setRelayerFee] = useState("0.1");
  const gateway = useMemo(() => {
    void cluster;
    return relayerGatewayUrl();
  }, [cluster]);
  const [relayerDraft, setRelayerDraft] = useState<RelayerJobDraft | null>(null);
  const [relayerBids, setRelayerBids] = useState<VerifiedBid[]>([]);
  const [selectedRelayer, setSelectedRelayer] = useState<string | null>(null);

  // #559: relayer registry comparison. `preferredRelayer` is chosen BEFORE proving so
  // it can be bound into the proof context; leaving it null keeps the open-bid flow.
  const [directory, setDirectory] = useState<RelayerListing[]>([]);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [preferredRelayer, setPreferredRelayer] = useState<string | null>(null);

  // Step-by-step withdrawal modal (wallet + relayer flows).
  const [flowOpen, setFlowOpen] = useState(false);
  const [flowMode, setFlowMode] = useState<"wallet" | "relayer">("wallet");
  const [flowSteps, setFlowSteps] = useState<WithdrawStep[]>([]);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [flowDone, setFlowDone] = useState(false);
  const [flowSuccessHash, setFlowSuccessHash] = useState<string | null>(null);
  const [flowSuccessText, setFlowSuccessText] = useState<string | null>(null);
  const [awaitingPick, setAwaitingPick] = useState(false);
  // #616: set once the currently-assigned relayer blows past the stall threshold —
  // drives the "possible censorship" banner and the one-click fallback resubmission.
  const [stalledJob, setStalledJob] = useState<{ operator: string; jobId: string } | null>(null);

  const clusterNotes = notes.filter((n) => n.cluster === cluster && (!n.poolId || n.poolId === cfg?.poolId));
  const unspent = clusterNotes.filter((n) => !n.spent);
  const selectedRelayerBid = relayerBids.find((bid) => bid.operator === selectedRelayer) ?? null;

  const depositPresets = cfg?.depositPresetsXlm.length ? cfg.depositPresetsXlm : DEFAULT_DEPOSIT_PRESETS_XLM;
  const isNonPresetAmount = useMemo(() => {
    const trimmed = amount.trim();
    if (!trimmed) return false;
    const parsed = parseFloat(trimmed);
    if (Number.isNaN(parsed) || parsed <= 0) return false;
    return !depositPresets.some((p) => p === parsed);
  }, [amount, depositPresets]);

  const refreshChain = useCallback(async () => {
    if (!cfg || !publicKey) return;
    try {
      const [bal, r] = await Promise.all([fetchPoolBalance(publicKey), fetchPoolRoots(publicKey)]);
      setPoolBalance(bal);
      setRoots(r);
    } catch {
      /* non-fatal: leave prior values */
    }
  }, [cfg, publicKey]);

  useEffect(() => {
    void refreshChain();
  }, [refreshChain]);

  useEffect(() => {
    if (submitMode === "relayer" && !relayerCfg) setSubmitMode("wallet");
  }, [relayerCfg, submitMode]);

  const refreshDirectory = useCallback(async () => {
    if (!relayerCfg || !publicKey) return;
    setDirectoryLoading(true);
    setDirectoryError(null);
    try {
      setDirectory(await fetchRelayerDirectory({ caller: publicKey }));
    } catch (e) {
      setDirectoryError((e as Error).message || "Could not read the relayer registry.");
    } finally {
      setDirectoryLoading(false);
    }
  }, [publicKey, relayerCfg]);

  // Load the registry when the user switches into relayer mode, and drop a stale
  // selection if that operator is no longer registered or has fallen below the bond.
  useEffect(() => {
    if (submitMode !== "relayer") return;
    void refreshDirectory();
  }, [submitMode, refreshDirectory]);

  useEffect(() => {
    if (!preferredRelayer) return;
    if (directory.length === 0) return;
    const still = directory.find((r) => r.operator === preferredRelayer);
    if (!still || !still.eligible) setPreferredRelayer(null);
  }, [directory, preferredRelayer]);

  useEffect(() => {
    setRelayerDraft(null);
    setRelayerBids([]);
    setSelectedRelayer(null);
    setAwaitingPick(false);
    setStalledJob(null);
  }, [recipient, selected]);

  const updateStep = useCallback(
    (id: string, status: WithdrawStepStatus, note?: string) => {
      setFlowSteps((prev) =>
        prev.map((s) =>
          s.id === id ? { ...s, status, ...(note !== undefined ? { note } : {}) } : s,
        ),
      );
    },
    [],
  );

  // Map the prover's progress callbacks onto the shared first three steps.
  const onProveProgress = useCallback(
    (stage: string) => {
      if (stage === "reading-chain") {
        updateStep("read-chain", "active");
      } else if (stage === "checking-roots") {
        updateStep("read-chain", "done");
        updateStep("check-roots", "active");
      } else if (stage === "proving") {
        updateStep("check-roots", "done");
        updateStep("prove", "active");
      }
    },
    [updateStep],
  );

  const failActiveStep = useCallback((message: string) => {
    setFlowError(message);
    setFlowSteps((prev) =>
      prev.map((s) => (s.status === "active" ? { ...s, status: "error" } : s)),
    );
  }, []);

  const closeFlow = useCallback(() => {
    if (busy) return;
    setFlowOpen(false);
    // Fully reset once the flow is finished, or when no relayer job is left
    // escrowed on-chain. An unresolved relayer draft is kept so it can be resumed.
    if (flowDone || !relayerDraft) {
      setFlowSteps([]);
      setFlowError(null);
      setFlowDone(false);
      setFlowSuccessHash(null);
      setFlowSuccessText(null);
      setAwaitingPick(false);
      if (flowDone) {
        setRelayerDraft(null);
        setRelayerBids([]);
        setSelectedRelayer(null);
      }
    }
  }, [busy, flowDone, relayerDraft]);

  const closeBackupDialog = useCallback(() => {
    if (backupBusy) return;
    setBackupOpen(false);
    setBackupPin("");
    setBackupConfirm("");
    setBackupAcknowledged(false);
    setBackupError(null);
  }, [backupBusy]);

  useEffect(() => {
    if (!backupOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeBackupDialog();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [backupOpen, closeBackupDialog]);

  const handleDeposit = useCallback(async () => {
    if (!cfg || !publicKey || !signTransaction) return;
    const value = parseXlm(amount);
    if (!value) {
      showToast("Enter a valid XLM amount.");
      return;
    }

    // Generate secrets and derive commitment upfront
    let leafIndex: number;
    let nullifier: string;
    let secret: string;
    let derived: Awaited<ReturnType<typeof deriveDeposit>>;
    try {
      leafIndex = await fetchNextLeafIndex(publicKey);
      ({ nullifier, secret } = newNoteSecrets());
      derived = await deriveDeposit({
        value,
        scope: cfg.scope,
        leafIndex,
        nullifier: BigInt(nullifier),
        secret: BigInt(secret),
      });
    } catch (e) {
      showToast(`Failed to prepare deposit: ${(e as Error).message}`);
      return;
    }

    // Require note backup confirmation before on-chain signing (#552)
    const session = createDepositBackupSession({
      cluster,
      depositor: publicKey,
      amountXlm: formatXlm(value),
      valueStroops: value.toString(),
      commitmentHex: toHex32(derived.commitment),
      nullifierHex: nullifier,
      secretHex: secret,
    });
    setDepositGateSession(session);
  }, [cfg, publicKey, signTransaction, amount, cluster, showToast]);

  const executeDepositAfterBackup = useCallback(async () => {
    if (!depositGateSession || !depositGateSession.verified) {
      showToast("Please verify your note backup before signing.");
      return;
    }
    if (!cfg || !publicKey || !signTransaction) return;

    const value = BigInt(depositGateSession.valueStroops);
    let leafIndex: number;
    let derived: Awaited<ReturnType<typeof deriveDeposit>>;
    try {
      leafIndex = await fetchNextLeafIndex(publicKey);
      derived = await deriveDeposit({
        value,
        scope: cfg.scope,
        leafIndex,
        nullifier: BigInt(depositGateSession.nullifierHex),
        secret: BigInt(depositGateSession.secretHex),
      });
    } catch (e) {
      showToast(`Failed to initialize deposit proof: ${(e as Error).message}`);
      return;
    }

    // Add optimistic deposit state
    const optimisticId = addOptimistic({
      value: value.toString(),
      poolId: cfg.poolId,
      cluster,
      expectedLeafIndex: leafIndex,
    });

    setIsDepositSigning(true);
    setBusy("Depositing…");
    try {
      const hash = await invokePoolDeposit({
        depositor: publicKey,
        value,
        commitment: be32(derived.commitment),
        expectedIndex: leafIndex,
        signTransaction,
      });

      // Confirm the optimistic deposit
      confirmDeposit(optimisticId, hash);

      // Persist the verified note
      const note: PoolNote = {
        cluster,
        poolId: cfg.poolId,
        account: publicKey,
        value: value.toString(),
        scope: cfg.scope,
        leafIndex,
        nullifier: depositGateSession.nullifierHex,
        secret: depositGateSession.secretHex,
        commitment: toHex32(derived.commitment),
        spent: false,
        createdAt: Date.now(),
      };
      addNote(note);

      // Remove from pending deposits after successful persistence
      removePendingDeposit(optimisticId);
      clearDepositBackupSession();
      setDepositGateSession(null);

      setAmount("");
      showToast(`Deposited ${formatXlm(value)} XLM into the pool.`, { explorerTx: { txSig: hash } });
      void refreshChain();
    } catch (e) {
      // Roll back optimistic state on failure
      failDeposit(optimisticId, (e as Error).message);
      showToast(`Deposit failed: ${(e as Error).message}`);
    } finally {
      setIsDepositSigning(false);
      setBusy(null);
    }
  }, [depositGateSession, cfg, publicKey, signTransaction, cluster, addOptimistic, confirmDeposit, addNote, removePendingDeposit, refreshChain, failDeposit, showToast]);

  const selectedNote = useCallback(() => {
    return unspent.find((n) => n.leafIndex === selected) ?? null;
  }, [selected, unspent]);

  const validateWithdrawInputs = useCallback((): PoolNote | null => {
    const note = selectedNote();
    if (!note) {
      showToast("Select a note to withdraw.");
      return null;
    }
    if (!StrKey.isValidEd25519PublicKey(recipient)) {
      showToast("Enter a valid recipient address (G…).");
      return null;
    }
    return note;
  }, [recipient, selectedNote, showToast]);

  const handleWalletWithdraw = useCallback(async () => {
    if (!cfg || !publicKey || !signTransaction) return;
    const note = validateWithdrawInputs();
    if (!note) return;
    setFlowMode("wallet");
    setFlowSteps(walletSteps());
    setFlowError(null);
    setFlowDone(false);
    setFlowSuccessHash(null);
    setFlowSuccessText(null);
    setAwaitingPick(false);
    setFlowOpen(true);
    setBusy("withdraw");
    try {
      updateStep("read-chain", "active");
      const proof = await generateWithdrawProof({
        note,
        recipient,
        fee: 0n,
        relayer: publicKey,
        caller: publicKey,
        onProgress: onProveProgress,
      });
      updateStep("prove", "done");
      updateStep("submit", "active");
      const hash = await invokePoolWithdraw({
        caller: publicKey,
        proofA: proof.proofA,
        proofB: proof.proofB,
        proofC: proof.proofC,
        withdrawnValue: proof.withdrawnValue,
        stateRoot: proof.stateRoot,
        aspRoot: proof.aspRoot,
        nullifierHash: proof.nullifierHash,
        newCommitment: proof.newCommitment,
        recipient,
        fee: 0n,
        relayer: publicKey,
        signTransaction,
      });
      updateStep("submit", "done", `tx ${hash.slice(0, 10)}…`);
      markSpent(cluster, note.poolId, note.leafIndex);
      setSelected(null);
      setFlowDone(true);
      setFlowSuccessHash(hash);
      setFlowSuccessText(`Withdrew ${formatXlm(proof.withdrawnValue)} XLM to ${recipient.slice(0, 6)}…`);
      showToast(`Withdrew ${formatXlm(proof.withdrawnValue)} XLM to ${recipient.slice(0, 6)}…`, {
        explorerTx: { txSig: hash },
      });
      void refreshChain();
    } catch (e) {
      const message = (e as Error).message;
      failActiveStep(message);
      showToast(`Withdraw failed: ${message}`);
    } finally {
      setBusy(null);
    }
  }, [
    cfg,
    publicKey,
    signTransaction,
    recipient,
    cluster,
    markSpent,
    showToast,
    refreshChain,
    validateWithdrawInputs,
    updateStep,
    onProveProgress,
    failActiveStep,
  ]);

  const refreshRelayerBids = useCallback(async () => {
    if (!relayerDraft) return;
    setBusy("refresh");
    updateStep("bids", "active");
    try {
      const allBids = await fetchRelayerBids(relayerDraft.jobIdHex, gateway);
      const bids = preferredRelayer
        ? allBids.filter((bid) => bid.operator === preferredRelayer)
        : allBids;
      setRelayerBids(bids);
      const picked = pickStakeWeightedBid(preferNonStalledBids(bids));
      setSelectedRelayer((prev) => prev ?? preferredRelayer ?? picked?.operator ?? null);
      updateStep("bids", "done", bids.length > 0 ? `${bids.length} verified bid(s)` : "no bids yet");
      updateStep("pick", "active");
      setAwaitingPick(true);
    } catch (e) {
      showToast(`Bid refresh failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [gateway, preferredRelayer, relayerDraft, showToast, updateStep]);

  const startRelayerWithdraw = useCallback(async () => {
    if (!cfg || !relayerCfg || !publicKey || !signTransaction) return;
    const note = validateWithdrawInputs();
    if (!note) return;
    const fee = parseXlm(relayerFee);
    if (!fee) {
      showToast("Enter a valid relayer fee.");
      return;
    }
    setFlowMode("relayer");
    setFlowSteps(relayerSteps());
    setFlowError(null);
    setFlowDone(false);
    setFlowSuccessHash(null);
    setFlowSuccessText(null);
    setAwaitingPick(false);
    setRelayerDraft(null);
    setRelayerBids([]);
    setSelectedRelayer(null);
    setFlowOpen(true);
    setBusy("relayer");
    try {
      updateStep("read-chain", "active");
      // #559: when the user picked a relayer from the registry comparison, that
      // operator — not the registry — is the address hashed into the proof context,
      // so the proof is only usable by them.
      const boundRelayer = preferredRelayer ?? relayerCfg.registryId;
      const proof = await generateWithdrawProof({
        note,
        recipient,
        fee: 0n,
        relayer: boundRelayer,
        caller: publicKey,
        onProgress: onProveProgress,
      });
      updateStep("prove", "done");
      updateStep("create-job", "active");
      const deadlineLedger = await defaultDeadlineLedger(
        Math.min(relayerCfg.maxDeadlineLedgers, 720),
      );
      const payload = buildRelayedWithdrawPayload({
        poolId: cfg.poolId,
        registryId: relayerCfg.registryId,
        proof,
        recipient,
        boundRelayer,
      });
      const draft = buildRelayerJobDraft({ payload, fee, deadlineLedger });
      const tx = await invokeRelayerCreateJob({
        creator: publicKey,
        jobId: draft.jobId,
        payloadHash: draft.payloadHash,
        deadlineLedger: draft.deadlineLedger,
        fee,
        signTransaction,
      });
      setRelayerDraft(draft);
      updateStep("create-job", "done", `escrow tx ${tx.slice(0, 10)}…`);
      updateStep("advert", "active");
      await publishAdvert(draft.advert, gateway);
      updateStep("advert", "done");
      updateStep("bids", "active");
      const allBids = await fetchRelayerBids(draft.jobIdHex, gateway);
      // A bound proof is only submittable by the operator it names, so bids from
      // anyone else are unusable and must not be offered as a choice.
      const bids = preferredRelayer
        ? allBids.filter((bid) => bid.operator === preferredRelayer)
        : allBids;
      setRelayerBids(bids);
      setSelectedRelayer(
        preferredRelayer ?? pickStakeWeightedBid(preferNonStalledBids(bids))?.operator ?? null,
      );
      updateStep(
        "bids",
        "done",
        bids.length > 0
          ? `${bids.length} verified bid(s)${preferredRelayer ? " from your chosen relayer" : ""}`
          : preferredRelayer
            ? "your chosen relayer has not bid yet"
            : "no bids yet",
      );
      updateStep("pick", "active");
      setAwaitingPick(true);
    } catch (e) {
      const message = (e as Error).message;
      failActiveStep(message);
      showToast(`Relayer setup failed: ${message}`);
    } finally {
      setBusy(null);
    }
  }, [
    cfg,
    gateway,
    publicKey,
    preferredRelayer,
    recipient,
    relayerCfg,
    relayerFee,
    signTransaction,
    showToast,
    validateWithdrawInputs,
    updateStep,
    onProveProgress,
    failActiveStep,
  ]);

  const finishRelayer = useCallback(
    (note: PoolNote, submittedTx: string | null) => {
      markSpent(cluster, note.poolId, note.leafIndex);
      setSelected(null);
      updateStep("deliver", "done", submittedTx ? `tx ${submittedTx.slice(0, 10)}…` : "submitted on-chain");
      setRelayerDraft(null);
      setRelayerBids([]);
      setSelectedRelayer(null);
      setAwaitingPick(false);
      setFlowDone(true);
      setFlowSuccessHash(submittedTx);
      setFlowSuccessText(`A relayer submitted your withdrawal to ${recipient.slice(0, 6)}… — never linked to your wallet.`);
      showToast(
        `Relayer submitted withdrawal to ${recipient.slice(0, 6)}…`,
        submittedTx ? { explorerTx: { txSig: submittedTx } } : undefined,
      );
      void refreshChain();
    },
    [cluster, markSpent, recipient, refreshChain, showToast, updateStep],
  );

  // #616: shared by the initial assignment and by fallback resubmission after a stall.
  // Delivers the sealed payload, then polls on-chain status until it's submitted or the
  // stall threshold passes — at which point the relayer is flagged as possibly censoring.
  const deliverAndWaitForSubmission = useCallback(
    async (draft: RelayerJobDraft, bid: VerifiedBid, note: PoolNote) => {
      const result = await deliverPayloadToRelayer({ draft, bid, gateway });
      if (result?.submittedTx) {
        finishRelayer(note, result.submittedTx);
        return;
      }
      updateStep("deliver", "active", "payload delivered — waiting for the relayer to submit");
      const started = Date.now();
      while (Date.now() - started < STALL_THRESHOLD_MS) {
        await sleep(RELAYER_SUBMISSION_POLL_MS);
        const status = await fetchRelayerJobStatus(draft.jobIdHex, publicKey ?? bid.operator);
        if (status === "submitted") {
          finishRelayer(note, null);
          return;
        }
        if (status === "accepted") {
          updateStep("deliver", "active", "relayer accepted — waiting for on-chain submission");
        } else if (status === "open") {
          updateStep("deliver", "active", "waiting for the relayer to accept");
        } else if (status === "slashed" || status === "canceled") {
          throw new Error(`Relayer job was ${status}.`);
        }
      }
      // Timed out: record the stall locally so future auto-picks avoid this operator,
      // surface a visible alert, and let the user resubmit through another relayer.
      recordStalledRelayer({ operator: bid.operator, jobId: draft.jobIdHex, at: Date.now() });
      setStalledJob({ operator: bid.operator, jobId: draft.jobIdHex });
      failActiveStep(
        `${bid.operator.slice(0, 8)}… has not submitted after ${Math.round(STALL_THRESHOLD_MS / 1000)}s — this relayer may be censoring your withdrawal.`,
      );
      setAwaitingPick(true);
    },
    [gateway, publicKey, updateStep, finishRelayer, failActiveStep],
  );

  const assignRelayer = useCallback(async () => {
    if (!relayerDraft || !selectedRelayerBid) {
      showToast("Select a relayer bid first.");
      return;
    }
    const note = selectedNote();
    if (!note) {
      showToast("Select a note to withdraw.");
      return;
    }
    setBusy("assign");
    setAwaitingPick(false);
    setFlowError(null);
    setStalledJob(null);
    updateStep("pick", "done", `relayer ${selectedRelayerBid.operator.slice(0, 8)}…`);
    updateStep("deliver", "active");
    try {
      await deliverAndWaitForSubmission(relayerDraft, selectedRelayerBid, note);
    } catch (e) {
      const message = (e as Error).message;
      failActiveStep(message);
      setAwaitingPick(true);
      showToast(`Relayer assignment failed: ${message}`);
    } finally {
      setBusy(null);
    }
  }, [
    deliverAndWaitForSubmission,
    relayerDraft,
    selectedNote,
    selectedRelayerBid,
    showToast,
    updateStep,
    failActiveStep,
  ]);

  const resubmitViaAlternateRelayer = useCallback(async () => {
    if (!cfg || !relayerCfg || !publicKey || !signTransaction || !relayerDraft || !stalledJob) return;
    const note = selectedNote();
    if (!note) {
      showToast("Select a note to withdraw.");
      return;
    }
    const alt = relayerBids.find((bid) => bid.operator !== stalledJob.operator) ?? null;
    if (!alt) {
      showToast("No alternate relayer available yet. Refresh bids and try again.");
      return;
    }
    setBusy("resubmit");
    setFlowError(null);
    setStalledJob(null);
    try {
      // A payload is bound to the specific relayer address named in the proof context
      // (#559), so switching relayers means re-proving that binding, not just re-sending.
      updateStep("prove", "active");
      const proof = await generateWithdrawProof({
        note,
        recipient,
        fee: 0n,
        relayer: alt.operator,
        caller: publicKey,
        onProgress: onProveProgress,
      });
      updateStep("prove", "done", "re-proved fee binding for the new relayer");
      updateStep("create-job", "active");
      const deadlineLedger = await defaultDeadlineLedger(Math.min(relayerCfg.maxDeadlineLedgers, 720));
      const payload = buildRelayedWithdrawPayload({
        poolId: cfg.poolId,
        registryId: relayerCfg.registryId,
        proof,
        recipient,
        boundRelayer: alt.operator,
      });
      const draft = buildRelayerJobDraft({ payload, fee: relayerDraft.fee, deadlineLedger });
      const tx = await invokeRelayerCreateJob({
        creator: publicKey,
        jobId: draft.jobId,
        payloadHash: draft.payloadHash,
        deadlineLedger: draft.deadlineLedger,
        fee: relayerDraft.fee,
        signTransaction,
      });
      setRelayerDraft(draft);
      updateStep("create-job", "done", `escrow tx ${tx.slice(0, 10)}…`);
      updateStep("advert", "active");
      await publishAdvert(draft.advert, gateway);
      updateStep("advert", "done");
      updateStep("bids", "done", "reusing the previously verified relayer");
      updateStep("pick", "done", `relayer ${alt.operator.slice(0, 8)}…`);
      setSelectedRelayer(alt.operator);
      setRelayerBids([alt]);
      updateStep("deliver", "active");
      await deliverAndWaitForSubmission(draft, alt, note);
    } catch (e) {
      const message = (e as Error).message;
      failActiveStep(message);
      setAwaitingPick(true);
      showToast(`Resubmission failed: ${message}`);
    } finally {
      setBusy(null);
    }
  }, [
    cfg,
    relayerCfg,
    publicKey,
    signTransaction,
    relayerDraft,
    stalledJob,
    relayerBids,
    recipient,
    selectedNote,
    gateway,
    onProveProgress,
    updateStep,
    failActiveStep,
    showToast,
    deliverAndWaitForSubmission,
  ]);

  const recoverRelayerJob = useCallback(
    async (kind: "cancel" | "slash") => {
      if (!publicKey || !signTransaction || !relayerDraft) {
        showToast("No relayer job to recover.");
        return;
      }
      setBusy(kind === "cancel" ? "cancel" : "slash");
      try {
        const hash =
          kind === "cancel"
            ? await invokeRelayerCancelJob({
                creator: publicKey,
                jobId: relayerDraft.jobId,
                signTransaction,
              })
            : await invokeRelayerSlashJob({
                creator: publicKey,
                jobId: relayerDraft.jobId,
                signTransaction,
              });
        setRelayerDraft(null);
        setRelayerBids([]);
        setSelectedRelayer(null);
        setAwaitingPick(false);
        setFlowError(null);
        setFlowDone(true);
        setFlowSuccessHash(hash);
        setFlowSuccessText(
          kind === "cancel"
            ? "Expired job canceled — your escrow was refunded."
            : "Failed relayer slashed — your escrow was refunded.",
        );
        showToast(kind === "cancel" ? "Relayer job canceled." : "Relayer job slashed.", {
          explorerTx: { txSig: hash },
        });
      } catch (e) {
        showToast(`Relayer recovery failed: ${(e as Error).message}`);
      } finally {
        setBusy(null);
      }
    },
    [publicKey, relayerDraft, showToast, signTransaction],
  );

  const handleBackupSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setBackupError(null);
      if (!cfg) return;
      if (clusterNotes.length === 0) {
        setBackupError("There are no pool notes to back up.");
        return;
      }
      if (!backupAcknowledged) {
        setBackupError("Acknowledge the privacy risk before downloading a backup.");
        return;
      }
      if (!/^\d{6,12}$/.test(backupPin)) {
        setBackupError("Use a 6-12 digit PIN.");
        return;
      }
      if (backupPin !== backupConfirm) {
        setBackupError("PINs do not match.");
        return;
      }
      setBackupBusy(true);
      try {
        const blob = await buildEncryptedPoolNoteBackup({
          notes: clusterNotes,
          pin: backupPin,
          cluster,
          poolId: cfg.poolId,
        });
        downloadBlob(blob, poolNoteBackupFilename());
        showToast(`Encrypted backup downloaded with ${clusterNotes.length} note(s).`);
        closeBackupDialog();
      } catch (e) {
        setBackupError((e as Error).message || "Could not create backup.");
      } finally {
        setBackupBusy(false);
      }
    },
    [
      backupAcknowledged,
      backupConfirm,
      backupPin,
      cfg,
      closeBackupDialog,
      cluster,
      clusterNotes,
      showToast,
    ],
  );

  if (!cfg) {
    return (
      <div className="max-w-lg mx-auto py-10 text-center">
        <h1 className="font-display text-xl font-bold text-white">Privacy Pool</h1>
        <p className="mt-3 text-sm text-mist">The privacy pool is not deployed on this network.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-display text-2xl font-bold text-white">Privacy Pool</h1>
        <p className="mt-1 text-sm text-mist">
          Shield XLM behind a commitment, then withdraw to any address with a zero-knowledge proof
          of a clean (ASP-approved) deposit.
        </p>
      </header>

      {/* Balances + ASP status */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className={card}>
          <div className="text-xs uppercase tracking-wide text-mist/70">Your shielded balance</div>
          <div className="mt-1 text-2xl font-bold text-white">{formatXlm(unspentTotal(unspent))} XLM</div>
          <div className="mt-1 text-xs text-mist/60">{unspent.length} unspent note(s)</div>
          <button
            type="button"
            onClick={() => {
              setBackupError(null);
              setBackupOpen(true);
            }}
            disabled={clusterNotes.length === 0 || backupBusy}
            className="mt-4 min-h-10 rounded-xl border border-ink-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:border-glow hover:text-glow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-glow disabled:cursor-not-allowed disabled:opacity-40"
          >
            Download backup
          </button>
        </div>
        <div className={card} data-tour="pool-balance">
          <div className="text-xs uppercase tracking-wide text-mist/70">Pool TVL (on-chain)</div>
          <div className="mt-1 text-2xl font-bold text-white">
            {poolBalance == null ? "…" : `${formatXlm(poolBalance)} XLM`}
          </div>
        </div>
        <div className={card}>
          <div className="text-xs uppercase tracking-wide text-mist/70">ASP status</div>
          <div className="mt-1 text-sm font-medium text-white">
            {roots?.aspRoot ? "Root published" : "No root yet"}
          </div>
          <div className="mt-1 break-all font-mono text-[10px] text-mist/50">
            {roots?.aspRoot ? `${roots.aspRoot.slice(0, 18)}…` : "—"}
          </div>
        </div>
      </div>

      {/* Deposit */}
      <div className={card} data-tour="pool-deposit">
        <h2 className="text-sm font-semibold text-white">Deposit</h2>
        <p className="mt-1 text-xs text-mist/60">
          Pick a common denomination so your deposit blends in with others.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {depositPresets.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setAmount(String(preset))}
              disabled={readOnly || !!busy}
              aria-pressed={amount === String(preset)}
              className={`rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                amount === String(preset)
                  ? "border-glow bg-black/30 text-white"
                  : "border-ink-700 text-mist hover:border-white/30"
              }`}
            >
              {preset.toLocaleString()} XLM
            </button>
          ))}
        </div>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row">
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Amount in XLM"
            disabled={readOnly || !!busy}
            className="flex-1 rounded-xl border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-white placeholder:text-mist/40 focus:border-glow focus:outline-none disabled:opacity-50"
          />
          <button
            type="button"
            onClick={handleDeposit}
            disabled={readOnly || !connected || !!busy}
            className="rounded-xl bg-glow px-5 py-2 text-sm font-semibold text-ink-950 transition-colors hover:bg-[#ffe24f] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy === "Depositing…" ? "Depositing…" : "Deposit"}
          </button>
        </div>
        {isNonPresetAmount && (
          <div className="mt-3 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">
            <strong>Linkability warning:</strong> This amount does not match a common pool
            denomination. A unique deposit amount makes the deposit–withdrawal pair trivially
            linkable, undermining your privacy.{" "}
            <a
              href={getDocUrl("pool-linkability")}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:no-underline"
            >
              Learn more about the threat model.
            </a>
          </div>
        )}
        <p className="mt-2 text-xs text-mist/60">
          A secret note is generated and saved locally. Keep your backup — losing notes loses the
          funds.
        </p>
      </div>

      {/* Pending Deposits */}
      {Object.values(pendingDeposits).filter((d) => d.cluster === cluster && d.status !== "confirmed").length > 0 && (
        <div className={card}>
          <h2 className="text-sm font-semibold text-white">Pending Deposits</h2>
          <div className="mt-3 space-y-2">
            {Object.values(pendingDeposits)
              .filter((d) => d.cluster === cluster && d.status !== "confirmed")
              .map((deposit) => (
                <div
                  key={deposit.id}
                  className={`flex items-center justify-between rounded-xl border px-3 py-2 text-sm ${
                    deposit.status === "pending"
                      ? "border-amber-400/30 bg-amber-400/10 text-amber-100"
                      : "border-red-400/30 bg-red-400/10 text-red-100"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    {deposit.status === "pending" && (
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-amber-400 border-t-transparent" />
                    )}
                    {deposit.status === "failed" && (
                      <div className="h-4 w-4 rounded-full bg-red-400/20" />
                    )}
                    <div>
                      <span className="font-medium">{formatXlm(BigInt(deposit.value))} XLM</span>
                      {deposit.status === "pending" && (
                        <span className="ml-2 text-xs opacity-70">Confirming on-chain…</span>
                      )}
                      {deposit.status === "failed" && (
                        <span className="ml-2 text-xs opacity-70">Failed</span>
                      )}
                    </div>
                  </div>
                  {deposit.status === "failed" && deposit.error && (
                    <button
                      type="button"
                      onClick={() => removePendingDeposit(deposit.id)}
                      className="text-xs underline hover:no-underline"
                    >
                      Dismiss
                    </button>
                  )}
                </div>
              ))}
          </div>
          {Object.values(pendingDeposits).some((d) => d.cluster === cluster && d.status === "failed") && (
            <div className="mt-3 rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-100">
              <p className="font-medium">One or more deposits failed.</p>
              <p className="mt-1 text-xs opacity-70">
                Failed deposits are automatically rolled back. Your funds remain in your wallet.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Withdraw */}
      <div className={card} data-tour="pool-withdraw">
        <h2 className="text-sm font-semibold text-white">Withdraw</h2>
        {unspent.length === 0 ? (
          <p className="mt-3 text-sm text-mist/60">No unspent notes. Deposit first.</p>
        ) : (
          <div className="mt-3 space-y-3">
            <div className="space-y-2">
              {unspent.map((n) => (
                <label
                  key={n.leafIndex}
                  className={`flex cursor-pointer items-center justify-between rounded-xl border px-3 py-2 text-sm transition-colors ${
                    selected === n.leafIndex
                      ? "border-glow bg-black/30 text-white"
                      : "border-ink-700 text-mist hover:border-white/30"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="note"
                      checked={selected === n.leafIndex}
                      onChange={() => setSelected(n.leafIndex)}
                      className="accent-glow"
                    />
                    {formatXlm(BigInt(n.value))} XLM
                  </span>
                  <span className="font-mono text-[10px] text-mist/50">leaf #{n.leafIndex}</span>
                </label>
              ))}
            </div>
            <input
              type="text"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="Recipient address (G…)"
              disabled={readOnly || !!busy}
              className="w-full rounded-xl border border-ink-700 bg-ink-950 px-3 py-2 font-mono text-xs text-white placeholder:text-mist/40 focus:border-glow focus:outline-none disabled:opacity-50"
            />
            <div className="grid grid-cols-2 gap-2 rounded-xl border border-ink-700 bg-ink-950 p-1">
              <button
                type="button"
                onClick={() => setSubmitMode("wallet")}
                className={`min-h-10 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-glow ${
                  submitMode === "wallet"
                    ? "bg-glow text-ink-950"
                    : "text-mist hover:bg-ink-800 hover:text-white"
                }`}
              >
                Connected wallet
              </button>
              <button
                type="button"
                onClick={() => setSubmitMode("relayer")}
                disabled={!relayerCfg}
                className={`min-h-10 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-glow disabled:cursor-not-allowed disabled:opacity-40 ${
                  submitMode === "relayer"
                    ? "bg-glow text-ink-950"
                    : "text-mist hover:bg-ink-800 hover:text-white"
                }`}
              >
                Relayer market
              </button>
            </div>

            {submitMode === "wallet" ? (
              <button
                type="button"
                onClick={handleWalletWithdraw}
                disabled={readOnly || !connected || !!busy || selected == null}
                className="w-full rounded-xl bg-glow px-5 py-2 text-sm font-semibold text-ink-950 transition-colors hover:bg-[#ffe24f] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Withdraw with connected wallet
              </button>
            ) : (
              <div className="space-y-3 rounded-xl border border-ink-700 bg-ink-950 p-3">
                {!relayerCfg ? (
                  <p className="text-sm text-mist/70">
                    Relayer market is not deployed on this network yet.
                  </p>
                ) : (
                  <>
                    <div className="grid gap-3">
                      <label className="space-y-1.5 text-sm">
                        <span className="font-medium text-white">Relayer fee (XLM)</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={relayerFee}
                          onChange={(e) => setRelayerFee(e.target.value)}
                          disabled={readOnly || !!busy}
                          className="w-full rounded-xl border border-ink-700 bg-ink-900 px-3 py-2 text-xs text-white placeholder:text-mist/40 focus:border-glow focus:outline-none disabled:opacity-50"
                        />
                      </label>
                    </div>

                    <RelayerComparison
                      listings={directory}
                      selected={preferredRelayer}
                      onSelect={setPreferredRelayer}
                      onRefresh={() => void refreshDirectory()}
                      loading={directoryLoading}
                      error={directoryError}
                      withdrawnStroops={
                        selected != null
                          ? BigInt(unspent.find((n) => n.leafIndex === selected)?.value ?? 0)
                          : 0n
                      }
                    />

                    <p className="text-xs leading-relaxed text-mist/60">
                      The job-funding transaction is public. The selected relayer cannot alter the
                      recipient, amount, or proof; it only learns the payload when it submits.
                      {preferredRelayer
                        ? " Your chosen relayer is bound into the proof, so no one else can submit it."
                        : " With no relayer chosen, the proof is bound to the registry and any staked relayer may bid."}
                    </p>
                    <button
                      type="button"
                      onClick={startRelayerWithdraw}
                      disabled={readOnly || !connected || !!busy || selected == null}
                      className="min-h-10 w-full rounded-xl bg-glow px-4 py-2 text-sm font-semibold text-ink-950 transition-colors hover:bg-[#ffe24f] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Withdraw via relayer
                    </button>
                    {relayerDraft && !flowOpen && (
                      <button
                        type="button"
                        onClick={() => setFlowOpen(true)}
                        disabled={readOnly || !!busy}
                        className="min-h-10 w-full rounded-xl border border-glow/40 px-4 py-2 text-sm font-medium text-glow transition-colors hover:bg-glow/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-glow disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Resume pending relayer job
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
            <p className="text-xs text-mist/60">
              v1 withdraws the full note to a fresh address. The proof attests your deposit is in the
              pool and ASP-approved, without revealing which one.
            </p>
          </div>
        )}
      </div>

      <WithdrawFlowModal
        open={flowOpen}
        mode={flowMode}
        steps={flowSteps}
        busy={!!busy}
        error={flowError}
        done={flowDone}
        successHash={flowSuccessHash}
        successText={flowSuccessText}
        cluster={cluster}
        awaitingRelayerPick={awaitingPick}
        bids={relayerBids}
        selectedRelayer={selectedRelayer}
        onSelectRelayer={setSelectedRelayer}
        onPickForMe={() => {
          const picked = pickStakeWeightedBid(preferNonStalledBids(relayerBids));
          if (picked) setSelectedRelayer(picked.operator);
        }}
        onRefreshBids={() => void refreshRelayerBids()}
        onAssign={() => void assignRelayer()}
        draftActive={!!relayerDraft}
        onCancelJob={() => void recoverRelayerJob("cancel")}
        onSlashJob={() => void recoverRelayerJob("slash")}
        stalledRelayer={stalledJob}
        canResubmitElsewhere={relayerBids.some((bid) => bid.operator !== stalledJob?.operator)}
        onResubmitElsewhere={() => void resubmitViaAlternateRelayer()}
        onClose={closeFlow}
      />

      {backupOpen && (
        <ModalShell
          open={backupOpen}
          title="Back up pool notes"
          description={`This backup contains encrypted spending material for ${clusterNotes.length} note(s).`}
          onClose={closeBackupDialog}
          maxWidthClassName="max-w-lg"
          closeOnBackdrop={!backupBusy}
        >
          <form onSubmit={handleBackupSubmit} className="space-y-4">
            <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">
              Anyone with the decrypted notes can withdraw the matching pool funds. Store the ZIP and
              PIN separately. If you lose the PIN, this backup cannot be recovered.
            </div>

            <div className="space-y-4">
              <label className="flex items-start gap-3 rounded-xl border border-ink-700 bg-ink-900/60 p-3 text-sm text-mist">
                <input
                  type="checkbox"
                  checked={backupAcknowledged}
                  onChange={(e) => setBackupAcknowledged(e.target.checked)}
                  className="mt-1 accent-glow"
                />
                <span>I understand this backup protects funds and must be kept private.</span>
              </label>

              <div className="space-y-1.5">
                <label htmlFor="pool-backup-pin" className="block text-sm font-medium text-white">
                  Backup PIN
                </label>
                <input
                  id="pool-backup-pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  value={backupPin}
                  onChange={(e) => setBackupPin(e.target.value)}
                  disabled={backupBusy}
                  aria-invalid={backupError ? "true" : undefined}
                  aria-describedby={backupError ? "pool-backup-error" : "pool-backup-pin-help"}
                  className="w-full rounded-xl border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-white placeholder:text-mist/40 focus:border-glow focus:outline-none focus-visible:ring-2 focus-visible:ring-glow disabled:opacity-50"
                />
                <p id="pool-backup-pin-help" className="text-xs text-mist/60">
                  Use 6-12 digits. This PIN encrypts the note JSON inside the ZIP.
                </p>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="pool-backup-pin-confirm" className="block text-sm font-medium text-white">
                  Confirm PIN
                </label>
                <input
                  id="pool-backup-pin-confirm"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  value={backupConfirm}
                  onChange={(e) => setBackupConfirm(e.target.value)}
                  disabled={backupBusy}
                  aria-invalid={backupError ? "true" : undefined}
                  aria-describedby={backupError ? "pool-backup-error" : undefined}
                  className="w-full rounded-xl border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-white placeholder:text-mist/40 focus:border-glow focus:outline-none focus-visible:ring-2 focus-visible:ring-glow disabled:opacity-50"
                />
              </div>

              {backupError && (
                <p id="pool-backup-error" className="rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-100">
                  {backupError}
                </p>
              )}
            </div>

            <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={closeBackupDialog}
                disabled={backupBusy}
                className="min-h-10 rounded-xl border border-ink-700 px-4 py-2 text-sm font-medium text-mist transition-colors hover:border-white/40 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-glow disabled:cursor-not-allowed disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={backupBusy}
                aria-busy={backupBusy ? "true" : undefined}
                className="min-h-10 rounded-xl bg-glow px-4 py-2 text-sm font-semibold text-ink-950 transition-colors hover:bg-[#ffe24f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-glow disabled:cursor-not-allowed disabled:opacity-40"
              >
                {backupBusy ? "Encrypting…" : "Download encrypted ZIP"}
              </button>
            </div>
          </form>
        </ModalShell>
      )}

      {depositGateSession && (
        <DepositBackupGateModal
          session={depositGateSession}
          isOpen={!!depositGateSession}
          isSigning={isDepositSigning}
          onConfirmAndSign={executeDepositAfterBackup}
          onCancel={() => {
            clearDepositBackupSession();
            setDepositGateSession(null);
          }}
        />
      )}
    </div>
  );
}
