import type { Page } from "@playwright/test";
import { test, expect, E2E_PUBLIC_KEY } from "../fixtures/wallet";
import { mockHorizonAccount, mockSorobanRpcNotRegistered, mockSorobanRpcUnavailable } from "../fixtures/network";

/**
 * Disconnect must open the confirmation dialog from every screen, not only the
 * dashboard (#1116). The modal is mounted once at the App root.
 */

async function openDisconnectDialog(page: Page) {
  await page.locator('[data-tour="meta"]').click();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Disconnect wallet" })).toBeVisible();
}

test.describe("Disconnect from every screen", () => {
  test("disconnects from the registration wizard", async ({ walletPage: page }) => {
    await mockHorizonAccount(page, E2E_PUBLIC_KEY, "100.0000000");
    await mockSorobanRpcNotRegistered(page);
    await page.goto("/app");

    await page.getByRole("button", { name: /connect wallet & initialize/i }).click();
    await expect(page.getByRole("heading", { name: "Registration required" })).toBeVisible({ timeout: 15_000 });

    await openDisconnectDialog(page);
    await page.getByRole("button", { name: "Disconnect only" }).click();

    await expect(page.getByRole("dialog", { name: "Disconnect wallet" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Registration required" })).toHaveCount(0);
  });

  test("disconnects from the registry outage screen", async ({ walletPage: page }) => {
    await mockHorizonAccount(page, E2E_PUBLIC_KEY, "100.0000000");
    await mockSorobanRpcUnavailable(page);
    await page.goto("/app");

    await page.getByRole("button", { name: /connect wallet & initialize/i }).click();
    await expect(page.getByRole("heading", { name: "Registration status unavailable" })).toBeVisible({ timeout: 15_000 });

    await openDisconnectDialog(page);
    await page.getByRole("button", { name: "Disconnect only" }).click();

    await expect(page.getByRole("dialog", { name: "Disconnect wallet" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Registration status unavailable" })).toHaveCount(0);
  });
});
