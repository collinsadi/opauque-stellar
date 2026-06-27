/**
 * SEP-10 Web Authentication client.
 *
 * Implements the Stellar SEP-10 challenge/sign/verify flow for establishing
 * authenticated sessions with Stellar anchor servers without replacing Freighter
 * for transaction signing.
 *
 * Flow:
 *   1. GET <serverUrl>/auth?account=<publicKey>  → challenge XDR
 *   2. Wallet signs the challenge transaction
 *   3. POST <serverUrl>/auth  { transaction: <signedXdr> }  → JWT token
 *   4. Token stored in sessionStorage; presented in Authorization header for
 *      subsequent anchor API calls.
 *
 * Reference: https://stellar.org/protocol/sep-10
 */

export interface Sep10Challenge {
  transaction: string;
  networkPassphrase: string;
}

export interface Sep10Session {
  token: string;
  /** Unix epoch seconds; absent if the server did not return an expiry. */
  expiresAt?: number;
  serverUrl: string;
  publicKey: string;
}

const SESSION_STORAGE_PREFIX = "opaque:sep10:";

/** Derive a stable sessionStorage key from a server URL. */
function sessionKey(serverUrl: string): string {
  return SESSION_STORAGE_PREFIX + serverUrl.replace(/[^a-z0-9]/gi, "_");
}

/**
 * Fetches a SEP-10 challenge (XDR transaction) from the anchor server.
 * @throws if the request fails or the response is malformed.
 */
export async function fetchSep10Challenge(
  serverUrl: string,
  publicKey: string,
): Promise<Sep10Challenge> {
  const base = serverUrl.replace(/\/$/, "");
  const url = new URL(`${base}/auth`);
  url.searchParams.set("account", publicKey);

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SEP-10 challenge fetch failed (${res.status}): ${text || res.statusText}`);
  }

  const body = (await res.json()) as {
    transaction?: string;
    network_passphrase?: string;
    error?: string;
  };

  if (body.error) throw new Error(`SEP-10 server error: ${body.error}`);
  if (!body.transaction) throw new Error("SEP-10 response missing 'transaction' field.");

  return {
    transaction: body.transaction,
    networkPassphrase: body.network_passphrase ?? "",
  };
}

/**
 * Submits a signed SEP-10 challenge to the anchor server.
 * @returns A session containing the JWT token and optional expiry.
 * @throws if the server rejects the signed transaction.
 */
export async function verifySep10Challenge(
  serverUrl: string,
  signedXdr: string,
  publicKey: string,
): Promise<Sep10Session> {
  const base = serverUrl.replace(/\/$/, "");

  const res = await fetch(`${base}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: signedXdr }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SEP-10 verification failed (${res.status}): ${text || res.statusText}`);
  }

  const body = (await res.json()) as {
    token?: string;
    error?: string;
  };

  if (body.error) throw new Error(`SEP-10 server error: ${body.error}`);
  if (!body.token) throw new Error("SEP-10 response missing 'token' field.");

  const session: Sep10Session = {
    token: body.token,
    serverUrl,
    publicKey,
  };

  // Attempt to decode the JWT expiry without a library.
  try {
    const payload = JSON.parse(atob(body.token.split(".")[1])) as { exp?: number };
    if (typeof payload.exp === "number") session.expiresAt = payload.exp;
  } catch {
    // non-JWT or malformed — expiry unknown, session stored without expiry
  }

  return session;
}

/** Persists a SEP-10 session to sessionStorage for the tab lifetime. */
export function storeSep10Session(session: Sep10Session): void {
  try {
    sessionStorage.setItem(sessionKey(session.serverUrl), JSON.stringify(session));
  } catch {
    // ignore quota / private-browsing errors
  }
}

/** Retrieves a previously stored SEP-10 session, or null if absent / expired. */
export function getSep10Session(serverUrl: string): Sep10Session | null {
  try {
    const raw = sessionStorage.getItem(sessionKey(serverUrl));
    if (!raw) return null;
    const session = JSON.parse(raw) as Sep10Session;
    if (!isSep10SessionValid(session)) {
      clearSep10Session(serverUrl);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

/** Removes a stored SEP-10 session. */
export function clearSep10Session(serverUrl: string): void {
  try {
    sessionStorage.removeItem(sessionKey(serverUrl));
  } catch {
    // ignore
  }
}

/** Returns false if the session is expired; true otherwise (including unknown expiry). */
export function isSep10SessionValid(session: Sep10Session): boolean {
  if (session.expiresAt == null) return true;
  return session.expiresAt > Math.floor(Date.now() / 1000);
}
