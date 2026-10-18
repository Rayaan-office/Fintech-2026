import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Me, Recommendation } from "@/api/types";
import { action, bankDetailsRec, owner, recommendation } from "./fixtures";
import { mockApi, renderApp } from "./utils";

const draft = action({
  id: "a9",
  type: "email_supplier",
  type_label: "Email a supplier",
  level: 3,
  level_label: "Outside action",
  summary: "Email Acme Supplies: Your recent price change",
  effects: ["Send this email to accounts@acme.example", "Subject: Your recent price change", "Hello, we noticed the price of flour went up."],
  reasons: ["Emails to suppliers and customers go out only after a person approves them.", "The AI drafted this email; check the wording."],
  amount_minor: null,
  approvers: "One person: a business owner or finance manager",
});

function setup({ me = owner, items = [recommendation(), bankDetailsRec], path = "/recommendations" }: { me?: Me; items?: Recommendation[]; path?: string } = {}) {
  const api = mockApi({
    "GET /api/auth/me": () => ({ status: 200, body: me }),
    "GET /api/inbox": () => ({ status: 200, body: { items: [], counts: { to_review: 0, needs_approval: 0 } } }),
    "GET /api/recommendations": () => ({ status: 200, body: { items } }),
    "POST /api/recommendations/r1/dismiss": () => ({ status: 200, body: { ok: true, muted: true } }),
    "POST /api/recommendations/r2/dismiss": () => ({ status: 200, body: { ok: true, muted: false } }),
    "POST /api/recommendations/r1/next-step": () => ({ status: 200, body: { action: draft } }),
    "POST /api/recommendations/refresh": () => ({ status: 200, body: { new: 1, updated: 0, resolved: 2, kept: 3 } }),
    "POST /api/actions/a9/approve": () => ({ status: 200, body: { ...draft, status: "executed" } }),
  });
  vi.stubGlobal("fetch", api.fetchMock);
  return { ...api, ...renderApp(path) };
}

const cardFor = async (title: string) => (await screen.findByRole("listitem", { name: title })) as HTMLElement;
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Rows open the side panel; the row's own button is named after its title. */
async function openCard(title: string) {
  await userEvent.click(within(await cardFor(title)).getByRole("button", { name: new RegExp(`^${escapeRe(title)}`) }));
  return screen.findByRole("dialog", { name: title });
}
const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body ?? "null"));

describe("Recommendations", () => {
  it("leads with the money at stake, split by severity", async () => {
    setup();
    const overview = await screen.findByRole("region", { name: "Overview" });
    expect(overview).toHaveTextContent("At stake£1,476.00");
    expect(overview).toHaveTextContent("Across 2 recommendations");
    expect(within(overview).getByRole("img", { name: "At stake by severity: Urgent £504.00, Worth a look £972.00" })).toBeInTheDocument();
    expect(overview).toHaveTextContent("Urgent1£504.00");
  });

  it("shows each row with its kind, severity and money at stake, and the AI's words in the panel", async () => {
    setup();
    const price = await cardFor("Acme Supplies is charging 18% more");
    expect(price).toHaveTextContent("Price rise");
    expect(price).toHaveTextContent("Worth a look");
    expect(price).toHaveTextContent("£972.00");
    // The paragraph and what the AI saw sit behind the row, not on the page
    expect(within(price).queryByText("Checked against your records")).not.toBeInTheDocument();
    const panel = await openCard("Acme Supplies is charging 18% more");
    expect(within(panel).getByText("Checked against your records")).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "What the AI saw" }));
    expect(within(panel).getByTestId("ai-saw")).toHaveTextContent("supplier: [SUPPLIER_1]");
    expect(within(panel).getByRole("button", { name: "Why am I seeing this?" })).toBeInTheDocument();
  });

  it("keeps the urgent row's next step on the row, and says it with no AI label when it is our own wording", async () => {
    setup();
    const bank = await cardFor("Northern Packaging's bank details changed");
    expect(bank).toHaveTextContent("Urgent");
    expect(bank).toHaveTextContent("Bank details changed");
    expect(within(bank).getByRole("button", { name: /using the email on record/ })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")[0]).toBe(bank);
    const panel = await openCard("Northern Packaging's bank details changed");
    expect(within(panel).queryByText("Checked against your records")).not.toBeInTheDocument();
  });

  it("shows the evidence before and after in the side panel, with the change", async () => {
    setup();
    const panel = await openCard("Acme Supplies is charging 18% more");
    const table = within(panel).getByRole("region", { name: "Before and after" });
    const flour = within(table).getByRole("row", { name: /Flour 25kg/ });
    expect(flour).toHaveTextContent("£45.00");
    expect(flour).toHaveTextContent("£53.10");
    expect(flour).toHaveTextContent("+18%");
  });

  it("shows the first five rows and the rest on request", async () => {
    const many = Array.from({ length: 7 }, (_, i) => recommendation({ id: `m${i}`, title: `Recommendation number ${i + 1}` }));
    setup({ items: many });
    await cardFor("Recommendation number 1");
    expect(screen.queryByRole("listitem", { name: "Recommendation number 6" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show all 7" }));
    expect(await screen.findByRole("listitem", { name: "Recommendation number 7" })).toBeInTheDocument();
  });

  it("drafts the email and opens its confirmation card, which can be approved there", async () => {
    const { calls } = setup();
    await userEvent.click(within(await cardFor("Acme Supplies is charging 18% more")).getByRole("button", { name: "Draft an email to Acme Supplies about the increase" }));
    const card = await screen.findByRole("region", { name: "Confirm: Email Acme Supplies: Your recent price change" });
    expect(card).toHaveTextContent("Send this email to accounts@acme.example");
    expect(card).toHaveTextContent("The AI drafted this email; check the wording.");
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/recommendations/r1/next-step")).toBe(true);
    await userEvent.click(within(card).getByRole("button", { name: /Approve/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/actions/a9/approve")).toBe(true));
  });

  it("opens a draft already waiting, and says when the email was sent", async () => {
    setup({
      items: [
        recommendation({ next_step: { ...recommendation().next_step!, can_draft: false, action: { id: "a9", status: "pending" } } }),
        recommendation({ id: "r3", title: "Hill Farm Shop pays late", type: "slow_payer", next_step: { label: "Draft a payment reminder", kind: "send_payment_reminder", href: null, can_draft: false, action: { id: "a8", status: "executed" }, related_action_ids: [] } }),
      ],
    });
    expect(within(await cardFor("Acme Supplies is charging 18% more")).getByRole("button", { name: /Open the draft email/ })).toBeInTheDocument();
    expect(await cardFor("Hill Farm Shop pays late")).toHaveTextContent("Email sent");
  });

  it("dismisses changed bank details without muting, with no option to mute", async () => {
    const { calls } = setup();
    const panel = await openCard("Northern Packaging's bank details changed");
    await userEvent.click(within(panel).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/api/recommendations/r2/dismiss")).toBeTruthy());
    expect(bodyOf(calls.find((c) => c.path === "/api/recommendations/r2/dismiss")!.init)).toEqual({ mute: false });
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
  });

  it("can stop a kind of recommendation for one supplier", async () => {
    const { calls } = setup();
    const panel = await openCard("Acme Supplies is charging 18% more");
    await userEvent.click(within(panel).getByRole("button", { name: /Dismiss/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Don't show this kind again for Acme Supplies/ }));
    await waitFor(() => expect(calls.find((c) => c.path === "/api/recommendations/r1/dismiss")).toBeTruthy());
    expect(bodyOf(calls.find((c) => c.path === "/api/recommendations/r1/dismiss")!.init)).toEqual({ mute: true });
    expect(await screen.findByText("Dismissed. We won't raise this again for Acme Supplies.")).toBeInTheDocument();
  });

  it("links to the approval waiting about changed bank details", async () => {
    setup({ path: "/recommendations?open=r2" });
    const panel = await screen.findByRole("dialog", { name: "Northern Packaging's bank details changed" });
    expect(within(panel).getByRole("link", { name: "Review it in the inbox" })).toHaveAttribute("href", "/inbox?action=a4");
  });

  it("checks again on request", async () => {
    setup();
    await userEvent.click(await screen.findByRole("button", { name: "Check now" }));
    expect(await screen.findByText("Checked your records: 1 new, 2 no longer apply.")).toBeInTheDocument();
  });

  it("says when there is nothing to look at", async () => {
    setup({ items: [] });
    expect(await screen.findByText("No recommendations right now")).toBeInTheDocument();
  });
});
