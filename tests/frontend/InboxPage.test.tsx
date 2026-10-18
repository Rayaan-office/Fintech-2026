import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Action, Me } from "@/api/types";
import { action, bookkeeper, docDetail, owner } from "./fixtures";
import { mockApi, renderApp } from "./utils";

const bankChange = action({
  id: "a4",
  type: "change_supplier_bank",
  type_label: "Change supplier bank details",
  level: 4,
  level_label: "Two people",
  summary: "Change bank details for Acme Supplies",
  effects: ["Future payments to Acme Supplies go to the new account"],
  reasons: ["The bank details differ from last time."],
  amount_minor: null,
  approvals: [{ name: "Priya Shah", decision: "approve", at: new Date().toISOString() }],
  required_approvals: 2,
  approvers: "Two people: business owners or finance managers",
});

function setup({ me = owner, pending = [action(), bankChange], done = [] as Action[], approve = (a: Action) => ({ ...a, status: "executed" as const, can_undo: true }) }: { me?: Me; pending?: Action[]; done?: Action[]; approve?: (a: Action) => Action } = {}) {
  const api = mockApi({
    "GET /api/auth/me": () => ({ status: 200, body: me }),
    "GET /api/inbox": (_init, url) => {
      const tab = url.searchParams.get("tab");
      const counts = { to_review: 1, needs_approval: pending.length };
      if (tab === "to_review") {
        return {
          status: 200,
          body: {
            counts,
            items: [{ kind: "document", id: "d1", summary: "Check acme-AS-1005.pdf", reasons: ["Two independent readings disagree on: due date."], warnings: [{ kind: "lookalike_sender", label: "Look-alike sender" }], created_at: new Date().toISOString(), level: 1, level_label: "Suggest" }],
          },
        };
      }
      return { status: 200, body: { counts, items: tab === "done" ? done : pending } };
    },
    "POST /api/actions/a1/approve": () => ({ status: 200, body: approve(pending[0]!) }),
    "POST /api/actions/a1/undo": () => ({ status: 200, body: { ...pending[0]!, status: "undone" } }),
    "GET /api/documents/d1": () => ({ status: 200, body: docDetail() }),
  });
  vi.stubGlobal("fetch", api.fetchMock);
  return { ...api, ...renderApp("/inbox") };
}

describe("Inbox", () => {
  it("lists what needs approval, highest risk first, with tab counts and second-approval progress", async () => {
    setup();
    const list = await screen.findByRole("list", { name: "Needs approval" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[1]!).getByText("1 of 2 approvals")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Needs approval\s*2/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /To review\s*1/ })).toBeInTheDocument();
  });

  it("approves a small change from its card and offers Undo", async () => {
    const { calls } = setup();
    await userEvent.click(await screen.findByRole("button", { name: /Record bill: £658.56 from Acme Supplies/ }));
    const card = await screen.findByRole("region", { name: "Confirm: Record bill: £658.56 from Acme Supplies" });
    expect(within(card).getByText("Add a bill to the ledger")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Approve" }));
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/actions/a1/approve")).toBe(true);

    const toast = (await screen.findByText(/Done: Record bill: £658.56 from Acme Supplies/)).closest<HTMLElement>("[data-sonner-toast]")!;
    await userEvent.click(within(toast).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/actions/a1/undo")).toBe(true));
    expect(await screen.findByText("Undone. Your records are back as they were.")).toBeInTheDocument();
  });

  it("says when an approval still needs a second person", async () => {
    setup({ approve: (a) => ({ ...a, approvals: [{ name: "Maya Patel", decision: "approve", at: new Date().toISOString() }], required_approvals: 2 }) });
    await userEvent.click(await screen.findByRole("button", { name: /Record bill/ }));
    const card = await screen.findByRole("region", { name: /Confirm: Record bill/ });
    await userEvent.click(within(card).getByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/Your approval is in \(1 of 2\)\. A different person must approve it too\./)).toBeInTheDocument();
    expect(within(card).getByText("1 of 2 approvals")).toBeInTheDocument();
  });

  it("explains why someone can't approve, in the server's words", async () => {
    setup({
      me: bookkeeper,
      pending: [{ ...bankChange, can_approve: false, why_not: "Only business owners, finance managers or the named second approver can approve this." }],
    });
    await userEvent.click(await screen.findByRole("button", { name: /Change bank details for Acme Supplies/ }));
    const card = await screen.findByRole("region", { name: /Confirm: Change bank details/ });
    expect(within(card).getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(within(card).getByText("Only business owners, finance managers or the named second approver can approve this.")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
    expect(within(card).getByText("First approval by Priya Shah, just now")).toBeInTheDocument();
  });

  it("shows documents to review with their warnings, and opens the review screen", async () => {
    setup();
    await userEvent.click(await screen.findByRole("tab", { name: /To review/ }));
    const row = await screen.findByRole("button", { name: /Check acme-AS-1005.pdf/ });
    expect(row).toHaveTextContent("Look-alike sender");
    await userEvent.click(row);
    expect(await screen.findByRole("region", { name: "What we found" })).toBeInTheDocument();
  });

  it("lists handled items on the Done tab with Undo where it's allowed", async () => {
    const { calls } = setup({ done: [action({ id: "a1", status: "executed", can_undo: true, decided_at: new Date().toISOString(), requested_by: "suggested by AI" })] });
    await userEvent.click(await screen.findByRole("tab", { name: "Done" }));
    const list = await screen.findByRole("list", { name: "Done" });
    expect(within(list).getByRole("listitem")).toHaveTextContent(/^Record bill: £658\.56 from Acme Supplies\s*Done/);
    await userEvent.click(within(list).getByRole("button", { name: /Undo: Record bill/ }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/actions/a1/undo")).toBe(true));
  });

  it("puts the card being decided above the document it is about", async () => {
    const linked = action({ id: "a7", document_id: "d1", summary: "Record bill: £658.56 from Acme Supplies" });
    const { fetchMock } = mockApi({
      "GET /api/auth/me": () => ({ status: 200, body: owner }),
      "GET /api/inbox": () => ({ status: 200, body: { counts: { to_review: 0, needs_approval: 1 }, items: [linked] } }),
      "GET /api/documents/d1": () => ({ status: 200, body: docDetail({ status: "awaiting_approval", actions: [linked] }) }),
    });
    vi.stubGlobal("fetch", fetchMock);
    renderApp("/inbox");
    await userEvent.click(await screen.findByRole("button", { name: /Record bill: £658.56/ }));
    const card = await screen.findByRole("region", { name: "Confirm: Record bill: £658.56 from Acme Supplies" });
    const original = screen.getByRole("region", { name: "Original document" });
    expect(card.compareDocumentPosition(original) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole("region", { name: /^Confirm:/ })).toHaveLength(1);
  });

  it("keeps the decision tidy: no repeated warnings, other approvals folded away", async () => {
    const warning = { kind: "bank_details_changed", label: "Changed bank details", detail: "The bank details differ from the ones on record." };
    const bank = action({
      id: "a8",
      document_id: "d1",
      type_label: "Change supplier bank details",
      level: 4,
      required_approvals: 2,
      summary: "Confirm new bank details for Acme Supplies",
      effects: ["bank account: ••••6587 → ••••1234"],
      reasons: ["Changed bank details: The bank details differ from the ones on record.", "Call the supplier on the number you already have."],
    });
    const bill = action({ id: "a9", document_id: "d1" });
    const { fetchMock } = mockApi({
      "GET /api/auth/me": () => ({ status: 200, body: owner }),
      "GET /api/inbox": () => ({ status: 200, body: { counts: { to_review: 0, needs_approval: 2 }, items: [bank, bill] } }),
      "GET /api/documents/d1": () => ({ status: 200, body: docDetail({ status: "awaiting_approval", warnings: [warning], actions: [bank, bill] }) }),
    });
    vi.stubGlobal("fetch", fetchMock);
    renderApp("/inbox");
    await userEvent.click(await screen.findByRole("button", { name: /Confirm new bank details/ }));
    const card = await screen.findByRole("region", { name: "Confirm: Confirm new bank details for Acme Supplies" });
    expect(within(card).getByLabelText("changes to")).toBeInTheDocument();
    expect(within(card).getByText("••••1234")).toBeInTheDocument();
    // The warning is shown once, above the card; the card keeps only the advice
    expect(within(card).queryByText(/Changed bank details/)).not.toBeInTheDocument();
    expect(within(card).getByText("Call the supplier on the number you already have.")).toBeInTheDocument();
    expect(screen.getByRole("alert", { name: "Warnings" })).toHaveTextContent("Changed bank details");

    const also = screen.getByRole("button", { name: /Also waiting on this document/ });
    expect(screen.queryByRole("region", { name: "Confirm: Record bill: £658.56 from Acme Supplies" })).not.toBeInTheDocument();
    await userEvent.click(also);
    expect(screen.getByRole("region", { name: "Confirm: Record bill: £658.56 from Acme Supplies" })).toBeInTheDocument();
  });

  it("flags fraud warnings on the row in a few words, with the full reasons on hover", async () => {
    const fraud = action({ id: "a5", reasons: ["Changed bank details: The bank details on this bill differ from the ones on record.", "Look-alike sender: The email address looks like Acme's."] });
    const { calls } = setup({ pending: [fraud] });
    const row = await screen.findByRole("button", { name: /^Record bill: £658\.56 from Acme Supplies/ });
    expect(row).toHaveTextContent("Changed bank details");
    expect(row).toHaveTextContent("Look-alike sender");
    expect(row).not.toHaveTextContent("differ from the ones on record");
    expect(row).toHaveAttribute("title", expect.stringContaining("The bank details on this bill differ from the ones on record."));
    // A warning is always read in the card: no bulk selection, and A opens the card instead of approving
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await userEvent.keyboard("a");
    expect(await screen.findByRole("region", { name: /^Confirm: Record bill/ })).toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith("/approve"))).toBe(false);
  });

  it("opens on a short queue, and J past it shows the rest", async () => {
    const many = Array.from({ length: 7 }, (_, i) => action({ id: `q${i}`, summary: `Record bill: £${i + 1}.00 from Supplier ${i + 1}` }));
    setup({ pending: many });
    const list = await screen.findByRole("list", { name: "Needs approval" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Show all 7" })).toHaveAttribute("aria-expanded", "false");
    for (let i = 0; i < 5; i++) await userEvent.keyboard("j");
    expect(within(list).getAllByRole("listitem")).toHaveLength(7);
    expect(within(list).getAllByRole("listitem")[5]).toHaveAttribute("aria-current", "true");
  });

  it("approves several small changes together from a bar that appears on selection", async () => {
    const { calls } = setup({ pending: [action(), bankChange] });
    await userEvent.click(await screen.findByRole("checkbox", { name: /Select: Record bill/ }));
    // The two-person change can't be bulk-approved
    expect(screen.queryByRole("checkbox", { name: /Select: Change bank details/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Approve 1 selected" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/actions/a1/approve")).toBe(true));
  });

  it("says why a stale suggestion was cancelled", async () => {
    setup({ done: [action({ id: "a9", status: "cancelled", result: { reason: "The payment was already matched." }, decided_at: new Date().toISOString() })] });
    await userEvent.click(await screen.findByRole("tab", { name: "Done" }));
    expect(await screen.findByRole("list", { name: "Done" })).toHaveTextContent("Cancelled: The payment was already matched.");
  });
});
