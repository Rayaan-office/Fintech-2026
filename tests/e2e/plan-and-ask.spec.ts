import { expect, test } from "@playwright/test";
import { OWNER, signIn } from "./helpers";

test.describe.configure({ mode: "serial" });

test("what-if: moving a bill shows the new lowest point and changes nothing", async ({ page }) => {
  await signIn(page, OWNER);
  await page.goto("/cash-flow");
  await expect(page.getByRole("heading", { name: "Cash flow", level: 1 })).toBeVisible();

  // Move the first bill a fortnight later with the keyboard, as someone could with a drag
  const name = (await page.getByRole("slider", { name: /^Move / }).first().getAttribute("aria-label"))!;
  const bill = page.getByRole("slider", { name, exact: true });
  await bill.focus();
  const before = Number(await bill.getAttribute("aria-valuenow"));
  await page.keyboard.press("PageUp");
  await page.keyboard.press("PageUp");
  await expect(bill).toHaveAttribute("aria-valuenow", String(before + 14));

  const status = page.getByRole("status").filter({ hasText: "What-if" });
  await expect(status).toContainText(/Lowest point £[\d,]+\.\d\d on .+, instead of £[\d,]+\.\d\d/, { timeout: 30_000 });
  await expect(status).toContainText("Nothing is saved and your records don't change.");

  await status.getByRole("button", { name: "Reset" }).click();
  await expect(status).toHaveCount(0);
  await expect(bill).toHaveAttribute("aria-valuenow", String(before));
});

test("ask: an answer from the records, and the AI saw placeholders, not names", async ({ page }) => {
  await signIn(page, OWNER);
  await page.goto("/ask");
  await page.getByPlaceholder("Ask about your business…").fill("Which customers owe us the most right now?");
  await page.getByRole("button", { name: "Send question" }).click();

  const conversation = page.getByRole("list", { name: "Conversation" });
  const answer = conversation.getByRole("listitem").nth(1);
  await expect(answer).toContainText("£", { timeout: 90_000 });
  // Station Coffee Co and Bright Cafe are the story's biggest customers
  await expect(answer).toContainText(/Station Coffee|Bright Cafe/);

  await answer.getByRole("button", { name: "What the AI saw" }).first().click();
  const saw = answer.getByTestId("ai-saw").first();
  await expect(saw).toBeVisible();
  await expect(saw).toContainText(/\[CUSTOMER_\d+\]/);
  await expect(saw).not.toContainText(/Station Coffee|Bright Cafe/);
});
