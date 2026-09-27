import type { Page } from "@playwright/test";

/**
 * Mocks Horizon and Soroban RPC (testnet, the default `VITE_STELLAR_NETWORK`)
 * so E2E tests never hit real Stellar infrastructure. Responses are
 * intentionally minimal — just enough shape for `@stellar/stellar-sdk` to
 * parse them without throwing — not a faithful ledger simulation.
 *
 * Keeping this centralized means every test that needs a funded-looking
 * account or a "not registered yet" registry lookup gets the same shape.
 */

const HORIZON_HOST = "horizon-testnet.stellar.org";
const SOROBAN_HOST = "soroban-testnet.stellar.org";

function horizonAccountBody(publicKey: string, balanceXlm: string) {
  return {
    _links: {
      self: { href: `https://${HORIZON_HOST}/accounts/${publicKey}` },
      transactions: { href: "", templated: true },
      operations: { href: "", templated: true },
      payments: { href: "", templated: true },
      effects: { href: "", templated: true },
      offers: { href: "", templated: true },
      trades: { href: "", templated: true },
      data: { href: "" },
    },
    id: publicKey,
    account_id: publicKey,
    sequence: "1",
    subentry_count: 0,
    last_modified_ledger: 100,
    last_modified_time: new Date().toISOString(),
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: {
      auth_required: false,
      auth_revocable: false,
      auth_immutable: false,
      auth_clawback_enabled: false,
    },
    balances: [
      {
        balance: balanceXlm,
        buying_liabilities: "0",
        selling_liabilities: "0",
        asset_type: "native",
      },
    ],
    signers: [{ weight: 1, key: publicKey, type: "ed25519_public_key" }],
    data: {},
    num_sponsoring: 0,
    num_sponsored: 0,
    paging_token: publicKey,
  };
}

/**
 * Registers a `page.route` handler for Horizon that funds `publicKey` with
 * `balanceXlm` (default "100"). Call before navigation.
 */
export async function mockHorizonAccount(
  page: Page,
  publicKey: string,
  balanceXlm = "100.0000000",
): Promise<void> {
  await page.route(`https://${HORIZON_HOST}/accounts/${publicKey}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(horizonAccountBody(publicKey, balanceXlm)),
    });
  });

  await page.route(`https://${HORIZON_HOST}/ledgers**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        _embedded: {
          records: [{ sequence: 1000, hash: "a".repeat(64), closed_at: new Date().toISOString() }],
        },
      }),
    });
  });
}

/**
 * Mocks the Soroban JSON-RPC endpoint so registry lookups resolve to
 * "not registered" (empty/failing simulation, which `resolveMetaAddress`
 * treats as `null` — see `frontend/src/lib/registry.ts`) without ever
 * reaching real testnet RPC. Also enough for downstream calls in the
 * registration/send flows to fail cleanly rather than hang.
 */
export async function mockSorobanRpcNotRegistered(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __OPAQUE_E2E_REGISTRY_STATE__: string }).__OPAQUE_E2E_REGISTRY_STATE__ = "unregistered";
  });
  await page.route(`https://${SOROBAN_HOST}/`, async (route) => {
    const body = route.request().postDataJSON() as { method?: string; id?: number | string };
    const id = body?.id ?? 1;
    if (body?.method === "getHealth") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id, result: { status: "healthy" } }),
      });
      return;
    }
    // For getAccount / simulateTransaction / anything else: return a JSON-RPC
    // error. `resolveMetaAddress` (frontend/src/lib/registry.ts) treats any
    // failure as "no meta-address registered", which is the state we want
    // for a fresh E2E test account.
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "account not found (mocked, E2E fixture)" },
      }),
    });
  });
}

/** E2E state for a temporary registry RPC outage, kept separate from a real empty registry result. */
export async function mockSorobanRpcUnavailable(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __OPAQUE_E2E_REGISTRY_STATE__: string }).__OPAQUE_E2E_REGISTRY_STATE__ = "error";
  });
}
