import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AskReply, AskThread } from "@/api/types";
import { action, askReply, owner } from "./fixtures";
import { mockApi, renderApp } from "./utils";

const reminder = action({
  id: "a30",
  type: "send_payment_reminder",
  type_label: "Email a customer",
  level: 3,
  level_label: "Outside action",
  summary: "Email Bright Cafe: Invoice INV-1042",
  effects: ["Send this email to accounts@brightcafe.example"],
  reasons: ["Emails to suppliers and customers go out only after a person approves them."],
  amount_minor: null,
});

const forecastReply = askReply({
  id: "m4",
  answer: { text: "Your cash stays above £10,000.00 next month, lowest £12,400.00 on 2 December.", redacted_input: "", ai_written: true },
  blocks: [
    {
      type: "chart", kind: "forecast", title: "Cash forecast, next 90 days", safety_level_minor: 1000000,
      points: [
        { date: "2026-10-18", expected_minor: 1500000, best_minor: 1600000, worst_minor: 1400000 },
        { date: "2026-10-25", expected_minor: 1240000, best_minor: 1300000, worst_minor: 1100000 },
      ],
    },
  ],
  sources: [{ id: "cash-flow", kind: "page", label: "Cash flow", href: "/cash-flow" }],
  follow_ups: [],
  suggestion: null,
});

const earlier: AskThread = {
  id: "t0",
  title: "Has Acme raised its prices?",
  messages: [
    { id: "m0", role: "user", created_at: new Date().toISOString(), text: "Has Acme raised its prices?" },
    {
      id: "m1", role: "assistant", created_at: new Date().toISOString(), checked: false,
      answer: { text: "I couldn't word an answer I could check, so here are the figures from our records:", redacted_input: "", ai_written: false },
      blocks: [], sources: [], follow_ups: ["Who owes me the most?"], suggestion: null,
    },
  ],
};

function setup({ replies = [askReply(), forecastReply] as (AskReply | { status: number; detail: string })[] } = {}) {
  let n = 0;
  let deleted = false;
  const api = mockApi({
    "GET /api/auth/me": () => ({ status: 200, body: owner }),
    "GET /api/inbox": () => ({ status: 200, body: { items: [], counts: { to_review: 0, needs_approval: 0 } } }),
    "GET /api/ask/threads": () => ({
      status: 200,
      body: { items: deleted ? [] : [{ id: "t0", title: earlier.title, created_at: new Date().toISOString() }] },
    }),
    "DELETE /api/ask/threads/t0": () => {
      deleted = true;
      return { status: 200, body: { ok: true } };
    },
    "GET /api/ask/threads/t0": () => ({ status: 200, body: earlier }),
    "POST /api/ask": () => {
      const r = replies[Math.min(n++, replies.length - 1)]!;
      return "detail" in r ? { status: r.status, body: { detail: r.detail } } : { status: 200, body: r };
    },
    "POST /api/ask/messages/m2/act": () => ({ status: 200, body: { action: reminder } }),
  });
  vi.stubGlobal("fetch", api.fetchMock);
  return { ...api, ...renderApp("/ask") };
}

const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body ?? "null"));
const conversation = () => screen.getByRole("list", { name: "Conversation" });

/** Example questions sit under topic tabs, as short chips that put the full question in the box; the person sends it. */
async function askExample(topic: string, chip: string) {
  await userEvent.click(await screen.findByRole("tab", { name: topic }));
  await userEvent.click(await screen.findByRole("button", { name: chip }));
  await userEvent.click(screen.getByRole("button", { name: "Send question" }));
}

describe("Ask", () => {
  it("answers with the AI label, a table from our records and its sources", async () => {
    const { calls } = setup();
    await askExample("Customers", "Who owes the most");
    expect(await screen.findByText(/Bright Cafe owes you the most/)).toBeInTheDocument();
    expect(bodyOf(calls.find((c) => c.path === "/api/ask")!.init)).toEqual({ question: "Who owes me the most?" });

    const chat = within(conversation());
    expect(chat.getByText("Checked against your records")).toBeInTheDocument();
    await userEvent.click(chat.getByRole("button", { name: "What the AI saw" }));
    expect(chat.getByTestId("ai-saw")).toHaveTextContent("[CUSTOMER_1] owes £1,240.00");

    const table = within(chat.getByRole("figure", { name: "Who owes you" }));
    expect(table.getByRole("row", { name: /Bright Cafe/ })).toHaveTextContent("Bright Cafe£1,240.00£860.00");
    expect(chat.getByRole("link", { name: "Cash flow" })).toHaveAttribute("href", "/cash-flow");
    expect(chat.getByText("Invoice INV-1042")).toBeInTheDocument();
  });

  it("asks a follow-up in the same conversation and shows a small chart", async () => {
    const { calls } = setup();
    await askExample("Customers", "Who owes the most");
    await userEvent.click(await screen.findByRole("button", { name: "What does my cash look like next month?" }));
    // A follow-up fills the box but doesn't send by itself
    expect(screen.getByLabelText("Ask a question")).toHaveValue("What does my cash look like next month?");
    expect(calls.filter((c) => c.path === "/api/ask")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Send question" }));
    expect(await screen.findByText(/Your cash stays above/)).toBeInTheDocument();
    const asks = calls.filter((c) => c.path === "/api/ask").map((c) => bodyOf(c.init));
    expect(asks[1]).toEqual({ question: "What does my cash look like next month?", thread_id: "t1" });
    expect(screen.getByRole("heading", { name: "Cash forecast, next 90 days" })).toBeInTheDocument();
    // Follow-up chips only on the latest answer
    expect(screen.queryByRole("button", { name: "When did Bright Cafe last pay?" })).not.toBeInTheDocument();
  });

  it("drafts the suggested reminder only when clicked, and shows its approval card in the chat", async () => {
    const { calls } = setup();
    await askExample("Customers", "Who owes the most");
    expect(calls.some((c) => c.path.endsWith("/act"))).toBe(false);
    await userEvent.click(await screen.findByRole("button", { name: "Draft a payment reminder to Bright Cafe" }));
    const card = await screen.findByRole("region", { name: "Confirm: Email Bright Cafe: Invoice INV-1042" });
    expect(card).toHaveTextContent("Send this email to accounts@brightcafe.example");
    expect(screen.queryByRole("button", { name: "Draft a payment reminder to Bright Cafe" })).not.toBeInTheDocument();
  });

  it("opens an earlier conversation and continues it", async () => {
    const { calls } = setup({ replies: [askReply({ thread_id: "t0" })] });
    // Earlier conversations wait behind the History button, so the page starts with just the question box
    expect(screen.queryByRole("navigation", { name: "Earlier conversations" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "History" }));
    const history = await screen.findByRole("navigation", { name: "Earlier conversations" });
    await userEvent.click(await within(history).findByRole("button", { name: /^Has Acme raised its prices\?/ }));
    expect(await screen.findByText(/I couldn't word an answer I could check/)).toBeInTheDocument();
    // Our own figures, not the AI's words: no AI label
    expect(within(conversation()).queryByText("Checked against your records")).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Ask a question"), "And Northern Packaging?{Enter}");
    await waitFor(() => expect(calls.some((c) => c.path === "/api/ask")).toBe(true));
    expect(bodyOf(calls.find((c) => c.path === "/api/ask")!.init)).toEqual({ question: "And Northern Packaging?", thread_id: "t0" });
    expect(await screen.findByText(/Bright Cafe owes you the most/)).toBeInTheDocument();
    expect(within(conversation()).getByText("Has Acme raised its prices?")).toBeInTheDocument();
  });

  it("deletes an earlier conversation after a check", async () => {
    const { calls } = setup();
    await userEvent.click(await screen.findByRole("button", { name: "History" }));
    const history = await screen.findByRole("navigation", { name: "Earlier conversations" });
    await userEvent.click(await within(history).findByRole("button", { name: "Delete conversation: Has Acme raised its prices?" }));
    expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false); // nothing gone until confirmed
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/ask/threads/t0" && c.init?.method === "DELETE")).toBe(true));
    expect(await within(history).findByText(/No conversations yet/)).toBeInTheDocument();
  });

  // Found by the browser journeys: when the AI's answer failed our check we showed our own figures,
  // but hid what had been sent to the AI, though it had been sent
  it("still shows what the AI saw when we fall back to our own figures", async () => {
    setup({
      replies: [askReply({ answer: { text: "Here are the figures from our records:", redacted_input: "Question: Who owes me the most?\n[CUSTOMER_1] owes £1,240.00", ai_written: false } })],
    });
    await askExample("Customers", "Who owes the most");
    const chat = within(await screen.findByRole("list", { name: "Conversation" }));
    await userEvent.click(await chat.findByRole("button", { name: "What the AI saw" }));
    expect(chat.getByTestId("ai-saw")).toHaveTextContent("[CUSTOMER_1] owes £1,240.00");
    expect(chat.queryByText("Checked against your records")).not.toBeInTheDocument();
  });

  it("explains a failure and tries again", async () => {
    setup({ replies: [{ status: 429, detail: "Too many requests. Please wait a moment and try again." }, askReply()] });
    await askExample("Customers", "Who owes the most");
    expect(await screen.findByText("Too many requests. Please wait a moment and try again.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(await screen.findByText(/Bright Cafe owes you the most/)).toBeInTheDocument();
  });
});
