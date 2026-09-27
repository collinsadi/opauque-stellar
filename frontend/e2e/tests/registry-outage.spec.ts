import { test, expect, E2E_PUBLIC_KEY } from "../fixtures/wallet";
import { mockHorizonAccount, mockSorobanRpcUnavailable } from "../fixtures/network";

test("keeps onboarding paused when registry status is unknown and allows retry", async ({ walletPage: page }) => {
  await mockHorizonAccount(page, E2E_PUBLIC_KEY);
  await mockSorobanRpcUnavailable(page);
  await page.goto("/app");
  await page.getByRole("button", { name: /connect wallet & initialize/i }).click();
  await expect(page.getByRole("heading", { name: "Registration status unavailable" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: /retry registry check/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Registration required" })).not.toBeVisible();
});
