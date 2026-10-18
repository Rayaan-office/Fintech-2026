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
const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body ?? "null"));

describe("Recommendations", () => {
  it("shows each card with its severity, money at stake and the AI label with what the AI saw", async () => {
    setup();
    const price = await cardFor("Acme Supplies is charging 18% more");
    expect(price).toHaveTextContent("Price rise");
    expect(price).toHaveTextContent("Worth a look");
    expect(price).toHaveTextContent("£972.00");
    expect(within(price).getByText("Checked against your records")).toBeInTheDocument();
    await userEvent.click(within(price).getByRole("button", { name: "What the AI saw" }));
    expect(within(price).getByTestId("ai-saw")).toHaveTextContent("supplier: [SUPPLIER_1]");

    // Our own template, not the AI's words: no AI label
    const bank = await cardFor("Northern Packaging's bank details changed");
    expect(bank).toHaveTextContent("Urgent");
    expect(within(bank).queryByText("Checked against your records")).not.toBeInTheDocument();
  });

  it("shows the evidence before and after in the side panel", async () => {
    setup();
    await userEvent.click(within(await cardFor("Acme Supplies is charging 18% more")).getByRole("button", { name: "See before and after" }));
    const panel = await screen.findByRole("dialog", { name: "Acme Supplies is charging 18% more" });
    const table = within(panel).getByRole("region", { name: "Before and after" });
    const flour = within(table).getByRole("row", { name: /Flour 25kg/ });
    expect(flour).toHaveTextContent("£45.00");
    expect(flour).toHaveTextContent("£53.10");
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
    await userEvent.click(within(await cardFor("Northern Packaging's bank details changed")).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/api/recommendations/r2/dismiss")).toBeTruthy());
    expect(bodyOf(calls.find((c) => c.path === "/api/recommendations/r2/dismiss")!.init)).toEqual({ mute: false });
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
  });

  it("can stop a kind of recommendation for one supplier", async () => {
    const { calls } = setup();
    await userEvent.click(within(await cardFor("Acme Supplies is charging 18% more")).getByRole("button", { name: /Dismiss/ }));
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
