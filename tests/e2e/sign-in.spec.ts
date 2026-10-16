import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const EMAIL = "books@demo-business.test";

// Written by the backend seed script; never committed and never printed
function password(email: string): string {
  const file = path.resolve(here, "../../demo-credentials.local.json");
  const creds = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  const value = creds[email];
  if (!value) throw new Error(`No demo password for ${email} in demo-credentials.local.json. Run the seed script.`);
  return value;
}

test.beforeAll(async ({ request }) => {
  const health = await request.get("/api/health").catch(() => null);
  test.skip(!health?.ok(), "The backend isn't running on :8000, so there is nothing to sign in to.");
});

test("a bookkeeper signs in without two-step and sees the app shell", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(password(EMAIL));
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/$/);
  const menu = page.getByRole("navigation", { name: "Main" }).first();
  for (const label of ["Home", "Inbox", "Ask", "Cash flow", "Business health", "Documents", "Activity"]) {
    await expect(menu.getByRole("link", { name: label })).toBeVisible();
  }
  // Financing tools are for owners and finance managers
  await expect(menu.getByRole("link", { name: "Financing" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Search everything" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Hide amounts|Show amounts/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Account menu for / })).toBeVisible();

  // Signing out ends the session on the server too
  await page.getByRole("button", { name: /^Account menu for / }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto("/inbox");
  await expect(page).toHaveURL(/\/sign-in$/);
});
