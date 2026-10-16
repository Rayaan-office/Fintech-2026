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
    expect(list).toHaveTextContent("Done · suggested by AI");
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

  it("says why a stale suggestion was cancelled", async () => {
    setup({ done: [action({ id: "a9", status: "cancelled", result: { reason: "The payment was already matched." }, decided_at: new Date().toISOString() })] });
    await userEvent.click(await screen.findByRole("tab", { name: "Done" }));
    expect(await screen.findByRole("list", { name: "Done" })).toHaveTextContent("Cancelled: The payment was already matched.");
  });
});
