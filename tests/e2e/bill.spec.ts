import { expect, test } from "@playwright/test";
import { BOOKS, file, OWNER, signIn, signOut } from "./helpers";

// The journeys share one fresh business and run in order: the bill approved here gives Acme's bank
// details on record, which the fraud drill then changes.
test.describe.configure({ mode: "serial" });

test("a bookkeeper uploads a bill and an owner approves it", async ({ page }) => {
  await signIn(page, BOOKS);
  await page.goto("/documents?upload=1");
  await page.getByTestId("file-input").setInputFiles(file("acme-bill.pdf"));
  await expect(page.getByText("acme-bill.pdf received")).toBeVisible();

  // Read by the AI in the background, then waiting for a person
  const row = page.getByRole("row", { name: /acme-bill\.pdf/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText(/Acme Supplies/, { timeout: 90_000 });
  await signOut(page);

  await signIn(page, OWNER);
  await page.goto("/inbox");
  // £420.00 of flour, eggs and delivery plus 20% VAT
  const item = page.getByRole("button", { name: /^Record bill: £504\.00 from Acme Supplies Ltd/ });
  await expect(item).toBeVisible({ timeout: 30_000 });
  await item.click();
  const panel = page.getByRole("dialog");
  await expect(panel).toContainText("Acme Supplies");
  await expect(panel).toContainText("£");
  await panel.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText(/approved/i).first()).toBeVisible();

  // Every step is in the log, including that personal details were hidden before the AI read the bill
  await page.goto("/activity");
  await expect(page.getByText("Log intact")).toBeVisible();
  const log = page.getByRole("list", { name: "Activity log" });
  for (const step of ["Done: record a checked document", "Approved: record a checked document",
    "The AI filled in the form from the hidden-details text", "Personal details were hidden before the AI read anything",
    "Document received"]) {
    await expect(log.getByText(step, { exact: true })).toBeVisible();
  }
});

test("fraud drill: a bill with new bank details is stopped and flagged", async ({ page }) => {
  await signIn(page, BOOKS);
  await page.goto("/documents?upload=1");
  await page.getByTestId("file-input").setInputFiles(file("acme-new-bank.pdf"));
  await expect(page.getByText("acme-new-bank.pdf received")).toBeVisible();
  await expect(page.getByRole("row", { name: /acme-new-bank\.pdf/ })).toContainText(/Acme Supplies/, { timeout: 90_000 });
  await signOut(page);

  await signIn(page, OWNER);
  await page.goto("/inbox");
  const item = page.getByRole("button", { name: /^Record bill: £504\.00 from Acme Supplies Ltd/ });
  await expect(item).toBeVisible({ timeout: 30_000 });
  await expect(item).toContainText(/bank details/i);
  await item.click();
  const panel = page.getByRole("dialog");
  await expect(panel).toContainText(/Changed bank details/i);

  // It also leads the recommendations, marked urgent
  await page.keyboard.press("Escape");
  await page.goto("/recommendations");
  await page.getByRole("button", { name: /Check now/ }).click();
  // Matched by its fixed label: the title is worded by the AI
  const first = page.getByRole("main").getByRole("listitem").first();
  await expect(first).toContainText("Bank details changed", { timeout: 90_000 });
  await expect(first).toContainText("Urgent");
  await expect(first).toContainText("£504.00");
  await expect(first.getByRole("button", { name: /using the email on record/ })).toBeVisible();
});
