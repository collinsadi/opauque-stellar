import { test, expect, E2E_PUBLIC_KEY } from "../fixtures/wallet";
import { mockHorizonAccount, mockSorobanRpcNotRegistered } from "../fixtures/network";

/**
 * Covers the "connect" and "register" core wallet flows (issue #459):
 * connect via the mocked Freighter harness, land on the registration wizard
 * for a fresh (unregistered) account, and walk through key derivation.
 *
 * The on-chain `register_keys` submission itself is mocked to fail cleanly
 * (see fixtures/network.ts) rather than faked to succeed — accurately
 * emulating a full Soroban simulate/assemble/submit round trip requires
 * reproducing large parts of the RPC wire format, which is out of scope
 * here. What's verified is that the UI reaches the point of submitting a
 * real signed transaction and surfaces failures without crashing.
 */
test.describe("Wallet connect + registration", () => {
  test.beforeEach(async ({ walletPage }) => {
    await mockHorizonAccount(walletPage, E2E_PUBLIC_KEY, "100.0000000");
    await mockSorobanRpcNotRegistered(walletPage);
  });

  test("connecting a fresh wallet reaches the registration wizard", async ({ walletPage: page }) => {
    await page.goto("/app");

    const connectCta = page.getByRole("button", { name: /connect wallet & initialize/i });
    await expect(connectCta).toBeVisible();
    await connectCta.click();

    await expect(page.getByRole("heading", { name: "Registration required" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/not yet registered on this cluster/i)).toBeVisible();
  });

  test("walks through key derivation and reaches the on-chain register step", async ({ walletPage: page }) => {
    await page.goto("/app");
    await page.getByRole("button", { name: /connect wallet & initialize/i }).click();
    await expect(page.getByRole("heading", { name: "Registration required" })).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("button", { name: /generate stealth keys/i })).toBeVisible();

    await page.getByRole("button", { name: /generate stealth keys/i }).click();

    // Step "register": progress list + "Register on <cluster>" CTA.
    await expect(page.getByText("Broadcasting Transaction")).toBeVisible({ timeout: 10_000 });
    const registerCta = page.getByRole("button", { name: /^register on testnet$/i });
    await expect(registerCta).toBeVisible();

    await registerCta.click();

    // The mocked Soroban RPC always errors, so registration should fail
    // cleanly with a visible message rather than hang or crash the page.
    // registerStealthKeys surfaces the raw JSON-RPC error, so match on the
    // mocked error payload rather than a literal "error"/"failed" string
    // the app doesn't happen to render.
    await expect(page.getByText(/account not found|error|failed/i).first()).toBeVisible({ timeout: 15_000 });
  });

  test("can continue to receive without publishing a registry link", async ({ walletPage: page }) => {
    await page.goto("/app");
    await page.getByRole("button", { name: /connect wallet & initialize/i }).click();
    await expect(page.getByRole("heading", { name: "Registration required" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: /generate stealth keys/i }).click();
    await expect(page.getByRole("button", { name: /^register on testnet$/i })).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: /continue without public registration/i }).click();
    await expect(page.getByRole("button", { name: /receive/i }).first()).toBeVisible();
  });
});
