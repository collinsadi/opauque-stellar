import type { Tab } from "../components/Layout";

export type DeepLinkTarget =
  | { tab: Extract<Tab, "receive">; receiveMode?: "payment_link" }
  | {
      tab: Extract<Tab, "send">;
      sendPrefill: {
        recipient: string;
        amount?: string;
      };
    };

export type DeepLinkParseResult =
  | { ok: true; target: DeepLinkTarget }
  | { ok: false; reason: string };

function isMetaAddress(value: string): boolean {
  const normalized = value.trim().startsWith("0x") ? value.trim() : `0x${value.trim()}`;
  return (
    normalized.length === 2 + 66 * 2 &&
    (normalized.startsWith("0x02") || normalized.startsWith("0x03"))
  );
}

function normalizeMetaAddress(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

function isAmount(value: string): boolean {
  return /^(?:0|[1-9]\d*)(?:\.\d{1,7})?$/.test(value.trim()) && Number(value) > 0;
}

export function parseOpaqueDeepLink(raw: string): DeepLinkParseResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "Deep link is not a valid URL." };
  }

  if (url.protocol !== "opaque:") {
    return { ok: false, reason: "Deep link must use the opaque:// scheme." };
  }

  const action = url.hostname.toLowerCase();
  const pathValue = decodeURIComponent(url.pathname.replace(/^\/+/, ""));

  if (action === "receive") {
    return { ok: true, target: { tab: "receive", receiveMode: "payment_link" } };
  }

  if (action !== "pay" && action !== "payment" && action !== "send") {
    return { ok: false, reason: "Unsupported opaque link action." };
  }

  const recipient =
    url.searchParams.get("recipient") ??
    url.searchParams.get("to") ??
    url.searchParams.get("meta") ??
    pathValue;

  if (!recipient || !isMetaAddress(recipient)) {
    return { ok: false, reason: "Payment link is missing a valid stealth meta-address." };
  }

  const amount = url.searchParams.get("amount") ?? undefined;
  if (amount && !isAmount(amount)) {
    return { ok: false, reason: "Payment amount must be a positive XLM value with up to 7 decimals." };
  }

  return {
    ok: true,
    target: {
      tab: "send",
      sendPrefill: {
        recipient: normalizeMetaAddress(recipient),
        amount,
      },
    },
  };
}

export function getDeepLinkFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  return params.get("uri") ?? params.get("deeplink") ?? params.get("deep_link");
}

export function makeOpaquePaymentLink(metaAddress: string): string {
  return `opaque://pay/${encodeURIComponent(metaAddress)}`;
}
