import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GettingPaid, Me, PaymentCostsDetail, Recommendation, ReminderDetail } from "@/api/types";
import { describeEntry } from "@/pages/ActivityPage";
import { action, bookkeeper, owner, recommendation } from "./fixtures";
import { mockApi, renderApp } from "./utils";

const at = new Date().toISOString();

const reminder = (stage: 1 | 2 | 3, over: Partial<ReminderDetail["reminder"]> = {}): Recommendation =>
  recommendation({
    id: `rem${stage}`,
    type: "chase_overdue",
    title: stage === 3 ? "Bright Cafe still hasn't paid £893.64: send a final notice" : "Bright Cafe still owes £893.64: send a firmer reminder",
    summary: { text: "Bright Cafe hasn't paid £893.64 since our first reminder.", redacted_input: "", ai_written: false },
    severity: "attention",
    at_stake_minor: 89364,
    counterparty: "Bright Cafe",
    evidence: [],
    next_step: {
      label: stage === 3 ? "Draft the final notice to Bright Cafe" : `Draft reminder ${stage} of 3 to Bright Cafe`,
      kind: "send_payment_reminder",
      href: null,
      can_draft: true,
      action: null,
      related_action_ids: [],
    },
    getting_paid: {
      reminder: {
        stage,
        of: 3,
        tone: stage === 1 ? "friendly" : stage === 2 ? "firm" : "final notice",
        invoices: [
          { record_id: "i1", reference: "INV-2049", open_minor: 43380, due: "2026-10-07", days_overdue: 11, link: "card_link" },
          { record_id: "i2", reference: "INV-2050", open_minor: 45984, due: "2026-10-14", days_overdue: 4, link: "card_link" },
        ],
        owner_only: stage === 3,
        previous: [{ stage: 1, sent_on: "2026-10-01" }],
        link: "all",
        links_configured: true,
        ...over,
      },
    },
  });

const costsDetail: PaymentCostsDetail = {
  methods: [
    { method: "international_transfer", label: "International transfer", payments: 10, amount_minor: 393072, short_minor: 17522, short_payments: 10, card_fee_minor: 12973, card_fee_is_estimate: true, days_to_pay: 33.4 },
  ],
  card_rate: { rate: 0.0325, fixed_minor: 20, source: "typical", label: "3.25% + 20p (a typical rate for a card from abroad)", payments: 0 },
  main_method: "international_transfer",
  short_minor: 17522,
  short_payments: 10,
  card_fee_minor: 12973,
  saving_minor: 4549,
  days_sooner_by_card: null,
  leftovers: [
    { record_id: "i7", reference: "INV-2118", short_minor: 1860 },
    { record_id: "i8", reference: "INV-2119", short_minor: 1912 },
  ],
  leftover_minor: 3772,
  links_configured: false,
  tip: "Send a card payment link with the next reminder",
};

const costs = (over: Partial<Recommendation> = {}): Recommendation =>
  recommendation({
    id: "cost1",
    type: "payment_costs",
    title: "Amsterdam Bakehouse BV's payments arrived £175.22 short",
    summary: { text: "10 of Amsterdam Bakehouse BV's payments by international transfer arrived £175.22 short.", redacted_input: "", ai_written: false },
    severity: "attention",
    at_stake_minor: 17522,
    counterparty: "Amsterdam Bakehouse BV",
    evidence: [{ label: "Invoice INV-2118", before: "£400.32 due", after: "£381.72 arrived on 30 May 2026", record_id: "i7" }],
    next_step: { label: "Record £37.72 as bank charges", kind: "record_bank_charge", href: null, can_draft: true, action: null, related_action_ids: [] },
    getting_paid: costsDetail,
    ...over,
  });

const numbers: GettingPaid = {
  since: "2026-04-21",
  days: 180,
  lost_to_short_minor: 17522,
  short_payments: 10,
  could_save_minor: 4549,
  days_to_pay_by_card: null,
  days_to_pay_by_transfer: 21.1,
  days_sooner_by_card: null,
  left_to_record_minor: 17522,
  left_to_record_count: 10,
  methods: costsDetail.methods,
  card_rate: { rate: 0.015, fixed_minor: 20, source: "typical", label: "1.5% + 20p (a typical rate for a UK card)", payments: 0 },
  card_rate_abroad: costsDetail.card_rate,
  paid_after_reminder: [{ stage: 0, invoices: 116, amount_minor: 6639456, days_to_pay: 21.1 }],
  links_configured: false,
  links_problem: null,
};

const bankCharge = action({
  id: "bc1",
  type: "record_bank_charge",
  type_label: "Record a bank charge",
  level: 2,
  level_label: "Small change",
  summary: "Record £37.72 as bank charges on 2 invoices from Amsterdam Bakehouse BV",
  effects: ["Record £18.60 as a bank charge on invoice INV-2118, which arrived short on 30 May 2026", "Mark those invoices as paid on the day their payment arrived"],
  reasons: ["Recording a cost needs a finance manager or a business owner."],
  amount_minor: 3772,
  can_approve: false,
  why_not: "Your role does not allow approving this.",
  approvers: "One person (or automatic when small and confident)",
});

function setup({ me = owner, items, summary = numbers }: { me?: Me; items: Recommendation[]; summary?: GettingPaid | null }) {
  const api = mockApi({
    "GET /api/auth/me": () => ({ status: 200, body: me }),
    "GET /api/inbox": () => ({ status: 200, body: { items: [], counts: { to_review: 0, needs_approval: 0 } } }),
    "GET /api/recommendations": () => ({ status: 200, body: { items } }),
    "GET /api/getting-paid": () => (summary ? { status: 200, body: summary } : { status: 404, body: { detail: "Not Found" } }),
    "POST /api/recommendations/cost1/bank-charge": () => ({ status: 200, body: { action: bankCharge } }),
    "POST /api/recommendations/rem2/next-step": () => ({ status: 200, body: { action: action({ id: "a2", type: "send_payment_reminder" }) } }),
  });
  vi.stubGlobal("fetch", api.fetchMock);
  return { ...api, ...renderApp("/recommendations") };
}

const cardFor = async (title: string) => (await screen.findByRole("listitem", { name: title })) as HTMLElement;
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
async function openCard(title: string) {
  await userEvent.click(within(await cardFor(title)).getByRole("button", { name: new RegExp(`^${escapeRe(title)}`) }));
  return screen.findByRole("dialog", { name: title });
}

describe("Getting paid", () => {
  it("shows the reminder step on the row, and the track, invoices and payment link in the panel", async () => {
    const { calls } = setup({ items: [reminder(2)] });
    const card = await cardFor("Bright Cafe still owes £893.64: send a firmer reminder");
    expect(card).toHaveTextContent("Payment reminder");
    expect(card).toHaveTextContent("Reminder 2 of 3");
    const panel = await openCard("Bright Cafe still owes £893.64: send a firmer reminder");
    const invoices = within(panel).getByRole("region", { name: "Invoices in this reminder" });
    const track = within(invoices).getByRole("list", { name: "Reminder 2 of 3" });
    const steps = within(track).getAllByRole("listitem");
    expect(steps.map((step) => step.textContent)).toEqual([expect.stringContaining("Friendly"), expect.stringContaining("Firm"), expect.stringContaining("Final notice")]);
    expect(within(track).getByText("Firm").closest("li")).toHaveAttribute("aria-current", "step");
    expect(track).toHaveTextContent("Sent 1 Oct 2026");
    expect(invoices).toHaveTextContent("INV-2049");
    expect(invoices).toHaveTextContent("£433.80");
    expect(invoices).toHaveTextContent("11 days overdue");
    expect(invoices).toHaveTextContent("Includes a link to pay online by card, made only once the reminder is approved.");
    expect(panel).not.toHaveTextContent("A business owner approves");
    await userEvent.click(within(card).getByRole("button", { name: "Draft reminder 2 of 3 to Bright Cafe" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/recommendations/rem2/next-step")).toBe(true));
  });

  it("says a business owner approves a final notice, and when there is no payment link", async () => {
    setup({ items: [reminder(3, { link: "none", links_configured: false })] });
    const card = await cardFor("Bright Cafe still hasn't paid £893.64: send a final notice");
    expect(card).toHaveTextContent("Reminder 3 of 3");
    const panel = await openCard("Bright Cafe still hasn't paid £893.64: send a final notice");
    expect(panel).toHaveTextContent("A business owner approves");
    expect(panel).toHaveTextContent("No card payment link: payment links aren't set up yet. Add a payment link key to include one.");
  });

  it("prepares the bank charge and shows what will change, for a finance manager or owner to approve", async () => {
    const { calls } = setup({ me: bookkeeper, items: [costs()] });
    const card = await cardFor("Amsterdam Bakehouse BV's payments arrived £175.22 short");
    expect(card).toHaveTextContent("Cost of getting paid");
    await userEvent.click(within(card).getByRole("button", { name: "Record £37.72 as bank charges" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/recommendations/cost1/bank-charge")).toBe(true));
    const panel = await screen.findByRole("dialog", { name: "Amsterdam Bakehouse BV's payments arrived £175.22 short" });
    const charge = within(panel).getByRole("region", { name: "Bank charge to record" });
    expect(charge).toHaveTextContent("Mark those invoices as paid on the day their payment arrived");
    expect(charge).toHaveTextContent("Your role does not allow approving this.");
  });

  it("compares the ways of paying in the side panel", async () => {
    setup({ items: [costs()] });
    const panel = await openCard("Amsterdam Bakehouse BV's payments arrived £175.22 short");
    const table = within(panel).getByRole("region", { name: "How this customer pays" });
    const row = within(table).getByRole("row", { name: /International transfer/ });
    expect(row).toHaveTextContent("10");
    expect(row).toHaveTextContent("£175.22");
    expect(row).toHaveTextContent("£129.73");
    expect(row).toHaveTextContent("33");
    expect(table).toHaveTextContent("Card fees are an estimate at 3.25% + 20p");
    const left = within(panel).getByRole("region", { name: "Left over after short payments" });
    expect(left).toHaveTextContent("INV-2118");
    expect(left).toHaveTextContent("£18.60");
    expect(panel).toHaveTextContent("Send a card payment link with the next reminder.");
  });

  it("says when the bank charge was recorded", async () => {
    setup({ items: [costs({ next_step: { ...costs().next_step!, can_draft: false, action: { id: "bc1", status: "executed" } } })] });
    expect(await cardFor("Amsterdam Bakehouse BV's payments arrived £175.22 short")).toHaveTextContent("Bank charge recorded");
  });

  it("folds what getting paid cost over the last 180 days behind one click", async () => {
    setup({ items: [costs()] });
    const summary = await screen.findByRole("region", { name: "Getting paid, last 180 days" });
    const toggle = within(summary).getByRole("button", { name: "Getting paid, last 180 days" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(summary).not.toHaveTextContent("Lost to short payments");
    await userEvent.click(toggle);
    expect(summary).toHaveTextContent("Lost to short payments£175.22");
    expect(summary).toHaveTextContent("10 payments");
    expect(summary).toHaveTextContent("To record as bank charges£175.22");
    expect(summary).toHaveTextContent("Could save by card£45.49");
    expect(summary).toHaveTextContent("Not enough card payments yet");
    expect(summary).toHaveTextContent("Card payment links aren't set up yet");
    await userEvent.click(within(summary).getByRole("button", { name: "How we work these out" }));
    expect(await screen.findByText("After card fees at 1.5% + 20p (a typical rate for a UK card), or 3.25% + 20p (a typical rate for a card from abroad).")).toBeInTheDocument();
    expect(screen.getByText("Bank transfers take 21 days on average.")).toBeInTheDocument();
  });

  it("leaves the summary out when there is nothing to show", async () => {
    setup({ items: [costs()], summary: null });
    await cardFor("Amsterdam Bakehouse BV's payments arrived £175.22 short");
    expect(screen.queryByRole("region", { name: "Getting paid, last 180 days" })).not.toBeInTheDocument();
  });

  it("names the bank charge in the activity log", () => {
    const e = { seq: 1, at, actor: "user:u1", event: "approval_approve", subject: "action:bc1", details: { type: "record_bank_charge", level: 2 }, hash: "h" };
    expect(describeEntry(e)).toBe("Approved: record a bank charge");
  });
});
