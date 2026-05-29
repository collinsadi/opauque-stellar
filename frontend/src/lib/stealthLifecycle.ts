/**
 * Opaque Protocol: Stealth fund discovery and spending lifecycle (Stellar).
 */

import { nativeToScVal } from "@stellar/stellar-sdk";
import { secp256k1 } from "@noble/curves/secp256k1";
import { useVaultStore } from "../store/vaultStore";
import {
  useGhostAddressStore,
  type GhostEntry,
} from "../store/ghostAddressStore";
import { ANNOUNCER_CONTRACT_ID, SCHEME_ID_SECP256K1 } from "./contracts";
import {
  buildGhostAnnouncementPayload,
  deriveAnnouncerEphemeralKey,
  deriveStealthStellarKeypairFromStealthPrivKey,
  formatXlm,
  type Hex,
  bytesToHex,
  hexToBytes,
} from "./stealth";
import {
  bytesToScVal,
  getHorizonServer,
  getNativeWithdrawalQuote,
  getSorobanServer,
  invokeContractWithKeypair,
  sendNativePayment,
  u64ToScVal,
} from "./stellar";
import { deployedAddresses } from "../contracts/deployedAddresses";
import {
  recordContractCall,
  recordScannerSync,
  recordRpcError,
} from "./monitoring";
import { parseHorizonBalanceToStroops } from "./decimalParser";

export interface StealthLifecycleWasm {
  check_announcement_view_tag_wasm: (
    view_tag: number,
    view_privkey_bytes: Uint8Array,
    ephemeral_pubkey_bytes: Uint8Array,
  ) => string;
  check_announcement_wasm: (
    announcement_stealth_address: string,
    view_tag: number,
    view_privkey_bytes: Uint8Array,
    spend_pubkey_bytes: Uint8Array,
    ephemeral_pubkey_bytes: Uint8Array,
  ) => boolean;
  reconstruct_signing_key_wasm: (
    master_spend_priv_bytes: Uint8Array,
    master_view_priv_bytes: Uint8Array,
    ephemeral_pubkey_bytes: Uint8Array,
  ) => Uint8Array;
}

export type ScanStatus = "idle" | "syncing" | "watching" | "error";

export type ScanningProgress = {
  status: ScanStatus;
  fromLedger: number | null;
  toLedger: number | null;
  lastProcessedLedger: number | null;
  error: string | null;
};

type ProgressListener = (progress: ScanningProgress) => void;

export type MasterKeys = {
  viewPrivKey: Uint8Array;
  spendPrivKey: Uint8Array;
  spendPubKey: Uint8Array;
};

const POLL_MS = 12_000;
const EVENT_PAGE = 200;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class StealthScanner {
  private readonly announcerContractId: string;
  private readonly wasm: StealthLifecycleWasm;
  private readonly getKeys: () => MasterKeys;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastLedger = 0;
  private progress: ScanningProgress = {
    status: "idle",
    fromLedger: null,
    toLedger: null,
    lastProcessedLedger: null,
    error: null,
  };
  private listeners = new Set<ProgressListener>();

  constructor(opts: {
    announcerContractId?: string;
    wasm: StealthLifecycleWasm;
    getKeys: () => MasterKeys;
  }) {
    this.announcerContractId =
      opts.announcerContractId ?? ANNOUNCER_CONTRACT_ID;
    this.wasm = opts.wasm;
    this.getKeys = opts.getKeys;
    console.log("👁️ [Opaque] StealthScanner created (Stellar)", {
      announcer: this.announcerContractId,
    });
  }

  onProgress(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    listener(this.progress);
    return () => this.listeners.delete(listener);
  }

  private setProgress(update: Partial<ScanningProgress>) {
    this.progress = { ...this.progress, ...update };
    this.listeners.forEach((l) => l(this.progress));
  }

  async updateVault(): Promise<void> {
    const startTime = Date.now();
    this.setProgress({ status: "syncing", error: null });
    const keys = this.getKeys();
    try {
      const server = getSorobanServer();
      const latest = await server.getLatestLedger();
      const start = Math.max(1, latest.sequence - 17_280);
      await this.fetchEvents(
        start,
        latest.sequence,
        keys.viewPrivKey,
        keys.spendPubKey,
      );
      this.lastLedger = latest.sequence;
      this.setProgress({
        status: "watching",
        lastProcessedLedger: latest.sequence,
        error: null,
      });
      recordScannerSync({
        success: true,
        durationMs: Date.now() - startTime,
        fromLedger: start,
        toLedger: latest.sequence,
        announcementsFound: 0,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordScannerSync({
        success: false,
        durationMs: Date.now() - startTime,
        fromLedger: 0,
        toLedger: 0,
        announcementsFound: 0,
        error: msg,
      });
      this.setProgress({ status: "error", error: msg });
      throw err;
    }
  }

  startWatching(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, POLL_MS);
    this.setProgress({ status: "watching", error: null });
  }

  stopWatching(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.setProgress({ status: "idle" });
  }

  private async pollOnce(): Promise<void> {
    const keys = this.getKeys();
    try {
      const server = getSorobanServer();
      const latest = await server.getLatestLedger();
      if (latest.sequence > this.lastLedger) {
        const eventsStart = this.lastLedger + 1;
        await this.fetchEvents(
          eventsStart,
          latest.sequence,
          keys.viewPrivKey,
          keys.spendPubKey,
        );
        this.lastLedger = latest.sequence;
        this.setProgress({ lastProcessedLedger: latest.sequence });
        recordScannerSync({
          success: true,
          durationMs: Date.now(),
          fromLedger: eventsStart,
          toLedger: latest.sequence,
          announcementsFound: 0,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordRpcError({
        provider: "Soroban RPC",
        method: "pollOnce",
        error: msg,
      });
      this.setProgress({ status: "error", error: msg });
    }
  }

  private async fetchEvents(
    startLedger: number,
    endLedger: number,
    viewPrivKey: Uint8Array,
    spendPubKey: Uint8Array,
  ): Promise<void> {
    const server = getSorobanServer();
    let cursor: string | undefined;
    let pages = 0;
    while (pages < 20) {
      const page = await server.getEvents({
        startLedger,
        endLedger,
        filters: [
          { type: "contract", contractIds: [this.announcerContractId] },
        ],
        limit: EVENT_PAGE,
        cursor,
      });
      for (const ev of page.events ?? []) {
        this.tryParseEvent(ev, viewPrivKey, spendPubKey);
      }
      if (!page.cursor || page.events.length < EVENT_PAGE) break;
      cursor = page.cursor;
      pages += 1;
      await delay(200);
    }
  }

  private tryParseEvent(
    ev: {
      txHash?: string;
      ledger?: number;
      value?: unknown;
      contractId?: unknown;
    },
    viewPrivKey: Uint8Array,
    spendPubKey: Uint8Array,
  ): void {
    try {
      const raw = ev.value;
      if (!raw || typeof raw !== "object") return;
      const v = raw as Record<string, unknown>;
      const schemeId = BigInt(String(v.scheme_id ?? v.schemeId ?? 0));
      if (schemeId !== SCHEME_ID_SECP256K1) return;

      const stealthBytes = decodeEventBytes(
        v.stealth_address ?? v.stealthAddress,
      );
      const ephemeralPubKey = decodeEventBytes(
        v.ephemeral_pub_key ?? v.ephemeralPubKey,
      );
      const metadata = decodeEventBytes(v.metadata);
      if (!stealthBytes || !ephemeralPubKey || ephemeralPubKey.length !== 33)
        return;

      const viewTag = metadata && metadata.length > 0 ? metadata[0] : 0;
      const stealthAddress = "0x" + bytesToHex(stealthBytes);

      if (
        this.wasm.check_announcement_view_tag_wasm(
          viewTag,
          viewPrivKey,
          ephemeralPubKey,
        ) === "NoMatch"
      ) {
        return;
      }
      if (
        !this.wasm.check_announcement_wasm(
          stealthAddress,
          viewTag,
          viewPrivKey,
          spendPubKey,
          ephemeralPubKey,
        )
      ) {
        return;
      }

      const spendPriv = this.getKeys().spendPrivKey;
      const stealthPriv = this.wasm.reconstruct_signing_key_wasm(
        spendPriv,
        viewPrivKey,
        ephemeralPubKey,
      );
      const stellarAddress =
        deriveStealthStellarKeypairFromStealthPrivKey(stealthPriv).publicKey();

      useVaultStore.getState().upsertEntry({
        stealthAddress,
        stellarAddress,
        ephemeralPubKeyHex: ("0x" + bytesToHex(ephemeralPubKey)) as Hex,
        blockNumber: BigInt(ev.ledger ?? 0),
        txHash: ev.txHash ?? "",
        amountStroops: 0n,
        isSpent: false,
      });
    } catch {
      // skip malformed events
    }
  }
}

function decodeEventBytes(val: unknown): Uint8Array | null {
  if (val instanceof Uint8Array) return val;
  if (typeof val === "string") {
    try {
      return Uint8Array.from(Buffer.from(val, "base64"));
    } catch {
      return hexToBytes(val.startsWith("0x") ? val.slice(2) : val);
    }
  }
  if (Array.isArray(val)) return Uint8Array.from(val);
  return null;
}

export async function refreshBalances(): Promise<void> {
  const entries = useVaultStore.getState().entries;
  const horizon = getHorizonServer();
  for (const entry of entries) {
    const stellarAddr = entry.stellarAddress;
    if (!stellarAddr) continue;
    try {
      const account = await horizon.loadAccount(stellarAddr);
      const native = account.balances.find((b) => b.asset_type === "native");
      const stroops = parseHorizonBalanceToStroops(
        (native as { balance: string })?.balance,
      );
      useVaultStore
        .getState()
        .upsertEntry({ ...entry, amountStroops: stroops });
    } catch {
      // account may not exist yet
    }
  }
}

export type WithdrawalStepTag = "CALC" | "SIGN" | "SEND" | "DONE";
export type WithdrawalStatus = {
  tag: WithdrawalStepTag;
  label: string;
  detail?: string;
};
export type WithdrawalStatusCallback = (status: WithdrawalStatus) => void;

export function deriveStealthPrivateKeyFromGhostEntry(
  ghostEntry: GhostEntry,
  masterKeys: MasterKeys,
  wasm: StealthLifecycleWasm,
): Hex {
  if (!ghostEntry.ephemeralPrivKeyHex) {
    throw new Error("Ghost entry has no ephemeral private key.");
  }
  const ephemeralPrivBytes = hexToBytes(ghostEntry.ephemeralPrivKeyHex);
  const ephemeralPubKey = secp256k1.getPublicKey(ephemeralPrivBytes, true);
  const stealthPrivKeyBytes = wasm.reconstruct_signing_key_wasm(
    masterKeys.spendPrivKey,
    masterKeys.viewPrivKey,
    ephemeralPubKey,
  );
  return ("0x" + bytesToHex(stealthPrivKeyBytes)) as Hex;
}

export function getAnnouncerAccount(
  wasm: StealthLifecycleWasm,
  masterKeys: MasterKeys,
  metaAddressHex: Hex | string,
): { address: string; privateKey: Hex } {
  const ephemeralPriv = deriveAnnouncerEphemeralKey(metaAddressHex);
  const ephemeralPubKey = secp256k1.getPublicKey(ephemeralPriv, true);
  const announcerPrivKeyBytes = wasm.reconstruct_signing_key_wasm(
    masterKeys.spendPrivKey,
    masterKeys.viewPrivKey,
    ephemeralPubKey,
  );
  const hexKey = ("0x" + bytesToHex(announcerPrivKeyBytes)) as Hex;
  const keypair = deriveStealthStellarKeypairFromStealthPrivKey(
    announcerPrivKeyBytes,
  );
  return { address: keypair.publicKey(), privateKey: hexKey };
}

export type GhostAnnouncementProgress = {
  id: string;
  label: string;
  status: "wait" | "ok" | "done" | "error";
  detail?: string;
};

export async function executeGhostOnchainAnnouncement(
  wasm: StealthLifecycleWasm,
  getMasterKeys: () => MasterKeys,
  metaAddressHex: Hex | string,
  ghostStealthAddress: string,
  ephemeralPrivKeyHex: Hex | string,
  onProgress?: (e: GhostAnnouncementProgress) => void,
): Promise<{ announceSignature: string }> {
  const report = (
    id: string,
    label: string,
    status: GhostAnnouncementProgress["status"],
    detail?: string,
  ) => onProgress?.({ id, label, status, detail });

  report("verify", "Verifying ghost address and ephemeral key…", "wait");
  const payload = buildGhostAnnouncementPayload(
    metaAddressHex,
    ephemeralPrivKeyHex,
  );
  report("verify", "Ghost address matches stored ephemeral key.", "ok");

  const announcerAcc = getAnnouncerAccount(
    wasm,
    getMasterKeys(),
    metaAddressHex,
  );
  const announcerKeypair = deriveStealthStellarKeypairFromStealthPrivKey(
    hexToBytes(announcerAcc.privateKey.slice(2)),
  );

  const stealthAddrBytes = hexToBytes(
    ghostStealthAddress.startsWith("0x")
      ? ghostStealthAddress.slice(2)
      : ghostStealthAddress,
  );

  report("announce", "Publishing on-chain announcement…", "wait");
  const hash = await invokeContractWithKeypair({
    keypair: announcerKeypair,
    contractId: deployedAddresses.stealthAnnouncer,
    method: "announce",
    args: [
      nativeToScVal(announcerKeypair.publicKey(), { type: "address" }),
      u64ToScVal(SCHEME_ID_SECP256K1),
      bytesToScVal(stealthAddrBytes),
      bytesToScVal(payload.ephemeralPubKey),
      bytesToScVal(payload.metadata),
    ],
  });

  report("announce", "Announcement published.", "done", hash);
  return { announceSignature: hash };
}

type NativeOrToken =
  | { type: "native" }
  | { type: "token"; tokenAddress: string };

export async function withdrawFromGhostAddress(
  ghostAddress: string,
  network: string,
  destination: string,
  asset: NativeOrToken,
  getMasterKeys: () => MasterKeys,
  wasm: StealthLifecycleWasm,
  onStatus: WithdrawalStatusCallback,
): Promise<string> {
  if (asset.type !== "native") {
    throw new Error("Only native XLM ghost withdrawals are supported.");
  }
  const ghostEntry = useGhostAddressStore
    .getState()
    .entries.find(
      (e) =>
        e.cluster === network &&
        e.stealthAddress.toLowerCase() === ghostAddress.toLowerCase(),
    );
  if (!ghostEntry?.ephemeralPrivKeyHex) {
    throw new Error("Ghost address not found or missing ephemeral key.");
  }
  const stealthPrivKeyHex = deriveStealthPrivateKeyFromGhostEntry(
    ghostEntry,
    getMasterKeys(),
    wasm,
  );
  return executeStealthWithdrawal(stealthPrivKeyHex, destination, onStatus);
}

export async function executeStealthWithdrawal(
  stealthPrivKeyHex: string,
  destination: string,
  onStatus: WithdrawalStatusCallback,
): Promise<string> {
  const stealthPrivBytes = hexToBytes(
    stealthPrivKeyHex.startsWith("0x")
      ? stealthPrivKeyHex.slice(2)
      : stealthPrivKeyHex,
  );
  const stealthKeypair =
    deriveStealthStellarKeypairFromStealthPrivKey(stealthPrivBytes);
  const from = stealthKeypair.publicKey();

  onStatus({
    tag: "CALC",
    label: "Checking stealth balance",
    detail: from.slice(0, 8) + "…",
  });

  let quote: Awaited<ReturnType<typeof getNativeWithdrawalQuote>>;
  try {
    quote = await getNativeWithdrawalQuote({
      sourcePublicKey: from,
      destination: destination.trim(),
    });
  } catch {
    throw new Error("Stealth account has zero balance or does not exist.");
  }

  if (quote.spendableStroops <= 0n) {
    throw new Error(
      `Insufficient balance. Retained ${formatXlm(
        quote.minimumBalanceStroops,
      )} XLM reserve and ${formatXlm(quote.feeStroops)} XLM fee.`,
    );
  }

  onStatus({
    tag: "SIGN",
    label: "Sweeping XLM",
    detail: `${formatXlm(quote.spendableStroops)} XLM via ${
      quote.destinationExists ? "payment" : "create-account"
    }; retained ${formatXlm(quote.minimumBalanceStroops)} reserve + ${formatXlm(quote.feeStroops)} fee`,
  });

  onStatus({ tag: "SEND", label: "Broadcasting payment" });
  const hash = await sendNativePayment({
    sourceKeypair: stealthKeypair,
    destination: destination.trim(),
    amountStroops: quote.spendableStroops,
    destinationExists: quote.destinationExists,
    feeStroops: quote.feeStroops,
  });

  onStatus({ tag: "DONE", label: "Sweep complete", detail: hash });
  return hash;
}

export { formatXlm };
