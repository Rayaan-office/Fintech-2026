import { expect, test } from "@playwright/test";
import { BOOKS, OWNER, signIn, signOut } from "./helpers";

test("a bookkeeper signs in without two-step and sees the app shell", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  await signIn(page, BOOKS);

  await expect(page).toHaveURL(/\/$/);
  const menu = page.getByRole("navigation", { name: "Main" }).first();
  for (const label of ["Home", "Inbox", "Recommendations", "Ask", "Cash flow", "Business health", "Documents", "Activity"]) {
    await expect(menu.getByRole("link", { name: label })).toBeVisible();
  }
  // Financing tools are for owners and finance managers
  await expect(menu.getByRole("link", { name: "Financing" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Search everything" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Hide amounts|Show amounts/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Account menu for / })).toBeVisible();

  // Signing out ends the session on the server too
  await signOut(page);
  await page.goto("/inbox");
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("an owner signs in with two-step, set up on their first sign-in", async ({ page }) => {
  await signIn(page, OWNER);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("navigation", { name: "Main" }).first().getByRole("link", { name: "Financing" })).toBeVisible();
});
