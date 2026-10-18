import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AskReply, AskStats } from "@/api/types";
import { askReply, owner } from "./fixtures";
import { mockApi, renderApp } from "./utils";

const searchReply = askReply({
  id: "m5",
  answer: { text: "Packaging Direct Ltd charges a late payment fee of £40.00 after 30 days.", redacted_input: "", ai_written: true },
  blocks: [
    {
      type: "passages",
      title: "From your documents",
      items: [
        {
          document_id: "d1", label: "terms.pdf", kind: "bill", date: "2026-10-02", href: "/documents?open=d1",
          text: "Contact [hidden person] on [hidden phone]. A late payment fee of £40.00 applies after 30 days. Pay to account [hidden bank account].",
        },
      ],
    },
  ],
  sources: [{ id: "d1", kind: "document", label: "terms.pdf", href: "/documents?open=d1" }],
  follow_ups: [],
  suggestion: null,
});

const byMonthReply = askReply({
  id: "m6",
  answer: { text: "You spent most in March: £2,400.00.", redacted_input: "", ai_written: true },
  blocks: [
    {
      type: "table", title: "Bills by month, 1 Jan 2026 to 18 Oct 2026", columns: ["Month", "Total", "Number", "Average"],
      rows: [["January 2026", 180000, 3, 60000], ["March 2026", 240000, 4, 60000]], money_columns: [1, 3],
    },
  ],
  sources: [],
  follow_ups: [],
  suggestion: null,
});

function setup({ reply = searchReply, stats = null }: { reply?: AskReply; stats?: AskStats | null } = {}) {
  const api = mockApi({
    "GET /api/auth/me": () => ({ status: 200, body: owner }),
    "GET /api/inbox": () => ({ status: 200, body: { items: [], counts: { to_review: 0, needs_approval: 0 } } }),
    "GET /api/ask/threads": () => ({ status: 200, body: { items: [] } }),
    "GET /api/ask/stats": () => (stats ? { status: 200, body: stats } : { status: 404, body: { detail: "Not Found" } }),
    "POST /api/ask": () => ({ status: 200, body: reply }),
  });
  vi.stubGlobal("fetch", api.fetchMock);
  return { ...api, ...renderApp("/ask") };
}

const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body ?? "null"));

describe("Ask anything", () => {
  it("offers example questions about records and documents", async () => {
    const { calls } = setup();
    const chips = within(await screen.findByRole("group", { name: "Or ask anything about your records and documents" }));
    expect(chips.getByRole("button", { name: "How much did we spend by category each month this year?" })).toBeInTheDocument();
    await userEvent.click(chips.getByRole("button", { name: "Which supplier mentions late payment fees?" }));
    expect(await screen.findByText(/charges a late payment fee/)).toBeInTheDocument();
    expect(bodyOf(calls.find((c) => c.path === "/api/ask")!.init)).toEqual({ question: "Which supplier mentions late payment fees?" });
    // The examples give way to the conversation
    expect(screen.queryByRole("group", { name: "Try one of these" })).not.toBeInTheDocument();
  });

  it("shows passages from the documents, linked to each document, with details still hidden", async () => {
    setup();
    await userEvent.click(await screen.findByRole("button", { name: "Which supplier mentions late payment fees?" }));
    const passages = within(await screen.findByRole("figure", { name: "From your documents" }));
    const item = passages.getByRole("listitem");
    expect(item).toHaveTextContent("A late payment fee of £40.00 applies after 30 days.");
    expect(within(item).getByText("hidden bank account")).toBeInTheDocument();
    expect(within(item).getByText("hidden person")).toBeInTheDocument();
    expect(item).not.toHaveTextContent("[hidden");
    expect(passages.getByRole("link", { name: /terms\.pdf, bill received 2 Oct 2026/ })).toHaveAttribute("href", "/documents?open=d1");
    expect(passages.getByText(/personal and bank details stay hidden/)).toBeInTheDocument();
  });

  it("shows grouped totals in the usual table", async () => {
    setup({ reply: byMonthReply });
    await userEvent.click(await screen.findByRole("button", { name: "How much did we spend by category each month this year?" }));
    const table = within(await screen.findByRole("figure", { name: "Bills by month, 1 Jan 2026 to 18 Oct 2026" }));
    expect(table.getByRole("row", { name: /March 2026/ })).toHaveTextContent("March 2026£2,400.004£600.00");
  });

  it("says how questions were answered so far", async () => {
    setup({ stats: { questions: 14, answered_from_data: 12, checked_first_try: 11, first_try_pct: 91.7, by_tool: {} } });
    expect(await screen.findByText(/answered 12 of your 14 questions from your records, and 11 passed our fact check first time/)).toBeInTheDocument();
  });

  it("says nothing about answers before there are any", async () => {
    setup({ stats: { questions: 0, answered_from_data: 0, checked_first_try: 0, first_try_pct: null, by_tool: {} } });
    await screen.findByRole("group", { name: "Try one of these" });
    expect(screen.queryByText(/So far we've answered/)).not.toBeInTheDocument();
  });
});
