import { expect, test } from "@playwright/test";
import { BOOKS, signIn } from "./helpers";

test("keyboard: ? lists the shortcuts, and search finds a supplier's bill and opens it", async ({ page }) => {
  await signIn(page, BOOKS);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.getByRole("heading", { level: 1 }).click(); // the page has focus, as after any click
  await page.keyboard.press("?");
  const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(shortcuts).toBeVisible();
  for (const label of ["Search everything", "Next item", "Approve", "Select for bulk approval"]) {
    await expect(shortcuts.getByText(label, { exact: true })).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(shortcuts).toHaveCount(0);

  // Search everything: names are typed, never put in the address. ⌘ on a Mac, Ctrl elsewhere (by the browser
  // it says it is, which the test device sets)
  const mod = (await page.evaluate(() => /Mac/.test(navigator.userAgent))) ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+k`);
  const search = page.getByRole("dialog").filter({ has: page.getByPlaceholder(/Search bills, customers/) });
  await expect(search).toBeVisible();
  await page.keyboard.type("AS-1005");
  const result = search.getByRole("option", { name: /AS-1005/ }).first();
  await expect(result).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(search).toHaveCount(0);
  expect(page.url()).not.toContain("AS-1005");

  // Pages are reachable from search too
  await page.keyboard.press(`${mod}+k`);
  await page.keyboard.type("cash flow");
  await expect(page.getByRole("option", { name: "Cash flow", exact: true })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/cash-flow$/);
});
