import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CashPosition, HomeSummary, Me, Recommendation } from "@/api/types";
import { bankDetailsRec, cashPosition, homeSummary, owner, recommendation } from "./fixtures";
import { mockApi, renderApp } from "./utils";

function setup({
  me = owner,
  home = homeSummary(),
  cash = cashPosition(),
  recs = [recommendation(), bankDetailsRec],
}: { me?: Me; home?: HomeSummary; cash?: CashPosition; recs?: Recommendation[] } = {}) {
  const api = mockApi({
    "GET /api/auth/me": () => ({ status: 200, body: me }),
    "GET /api/inbox": () => ({ status: 200, body: { items: [], counts: { to_review: 0, needs_approval: 2 } } }),
    "GET /api/home": () => ({ status: 200, body: home }),
    "GET /api/cash": () => ({ status: 200, body: cash }),
    "GET /api/recommendations": () => ({ status: 200, body: { items: recs } }),
  });
  vi.stubGlobal("fetch", api.fetchMock);
  return { ...api, ...renderApp("/") };
}

const briefing = async () => within((await screen.findByRole("heading", { name: "Today" })).closest("section")!);

describe("Home", () => {
  it("greets the person and has the quick buttons", async () => {
    setup();
    expect(await screen.findByRole("heading", { level: 1, name: /, Maya$/ })).toBeInTheDocument();
    const main = within(screen.getByRole("main"));
    expect(main.getByRole("link", { name: /Upload/ })).toHaveAttribute("href", "/documents?upload=1");
    expect(main.getByRole("link", { name: /^Ask$/ })).toHaveAttribute("href", "/ask");
    expect(main.getByRole("link", { name: /Plan a cost/ })).toHaveAttribute("href", "/cash-flow?plan=1");
  });

  it("puts the most pressing items first in the Today briefing, each with its next step", async () => {
    setup();
    const today = await briefing();
    const items = today.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("At the current rate, cash lasts about 2.4 months.");
    expect(items[0]).toHaveTextContent("Urgent");
    expect(within(items[0]!).getByRole("link", { name: "See business health" })).toHaveAttribute("href", "/health");
    expect(within(items[1]!).getByRole("link", { name: "See cash flow" })).toHaveAttribute("href", "/cash-flow");
    expect(within(items[2]!).getByRole("link", { name: "Open inbox" })).toHaveAttribute("href", "/inbox");
  });

  it("folds a long briefing behind Show more", async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`, sentence: `Check ${i + 1}`, action_label: "See business health", href: "/health", level: 0 as const, severity: "attention" as const,
    }));
    setup({ home: homeSummary({ today: many }) });
    const today = await briefing();
    expect(today.getAllByRole("listitem")).toHaveLength(4);
    await userEvent.click(today.getByRole("button", { name: "Show 2 more" }));
    expect(today.getAllByRole("listitem")).toHaveLength(6);
  });

  it("says so when nothing needs the person today", async () => {
    setup({ home: homeSummary({ today: [] }) });
    expect((await briefing()).getByText("Nothing needs you today.")).toBeInTheDocument();
  });

  it("shows cash today across the accounts, with the next 30 days and the lowest point", async () => {
    setup({ cash: cashPosition({ left_out: [{ id: "acc3", name: "Euro account", source: "plaid", mask: "9087", currency: "EUR", balance_minor: 50000, counted: false }] }) });
    const headline = (await screen.findByText("Cash today")).parentElement!;
    expect(headline).toHaveTextContent("£15,000.00");
    expect(await within(headline).findByText(/Across 2 accounts · updated 2 hours ago/)).toBeInTheDocument();
    expect(headline).toHaveTextContent("Not counted (another currency): Euro account (EUR)");

    // Regression: the card said "Next 90 days" over the 31 days the home endpoint sends
    const chart = screen.getByRole("heading", { name: "Next 30 days" }).closest("section")!;
    expect(screen.queryByRole("heading", { name: "Next 90 days" })).not.toBeInTheDocument();
    expect(chart).toHaveTextContent(/In 30 days£10,003\.33/);
    expect(chart).toHaveTextContent(/Lowest in 90 days.*£7,505\.00 on 2 Dec/);
    expect(within(chart).getByRole("link", { name: /View cash flow/ })).toHaveAttribute("href", "/cash-flow");
    await userEvent.click(within(chart).getByRole("button", { name: "Table" }));
    expect(within(chart).getAllByRole("row")).toHaveLength(32);
  });

  it("shows the three cards: bills due, who owes you and the top recommendation", async () => {
    setup();
    const bills = (await screen.findByText("Bills due this week")).closest("div.flex-col")!;
    expect(bills).toHaveTextContent("£1,078.56");
    expect(bills).toHaveTextContent("2 bills due in the next 7 days");

    const owed = screen.getByText("Who owes you").closest("div.flex-col")!;
    expect(owed).toHaveTextContent("£2,520.00");
    expect(owed).toHaveTextContent("£860.00 overdue");
    expect(within(owed as HTMLElement).getByRole("link", { name: /See who owes you/ })).toHaveAttribute("href", "/health?view=owed");

    const recs = screen.getByText("Recommendations", { selector: "div" }).closest("div.flex-col")!;
    // The urgent one first
    expect(await within(recs as HTMLElement).findByText("Northern Packaging's bank details changed")).toBeInTheDocument();
    expect(recs).toHaveTextContent("£1,476.00 at stake");
    expect(within(recs as HTMLElement).getByRole("link", { name: /See recommendations/ })).toHaveAttribute("href", "/recommendations?open=r2");
  });

  it("says when the next bill is, when nothing is due this week", async () => {
    setup({ home: homeSummary({ bills_due: { count: 0, total_minor: 0, next_due_date: "2026-11-01" }, who_owes_you: { count: 2, total_minor: 166000, overdue_minor: 0 } }) });
    expect(await screen.findByText("Nothing due in the next 7 days · next on 1 Nov")).toBeInTheDocument();
    expect(screen.getByText("2 unpaid invoices, none overdue")).toBeInTheDocument();
  });

  it("starts with connecting a source when nothing is connected yet", async () => {
    setup({
      home: homeSummary({
        today: [], cash: { ...homeSummary().cash, balance_minor: 0 }, bills_due: { count: 0, total_minor: 0, next_due_date: null },
        who_owes_you: { count: 0, total_minor: 0, overdue_minor: 0 }, recommendations: { count: 0, at_stake_minor: 0 },
      }),
      cash: cashPosition({ balance_minor: 0, accounts: [], platform_minor: 0 }),
      recs: [],
    });
    expect(await screen.findByText("Your money picture starts here")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect a source" })).toHaveAttribute("href", "/connections");
  });
});
