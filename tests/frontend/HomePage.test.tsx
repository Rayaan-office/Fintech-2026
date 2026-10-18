import { screen, waitFor, within } from "@testing-library/react";
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

const briefing = async () => within((await screen.findByRole("heading", { name: /^Today/ })).closest("section")!);

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
    expect(today.getAllByRole("listitem")).toHaveLength(3);
    await userEvent.click(today.getByRole("button", { name: "Show 3 more" }));
    expect(today.getAllByRole("listitem")).toHaveLength(6);
  });

  it("says so when nothing needs the person today", async () => {
    setup({ home: homeSummary({ today: [] }) });
    expect((await briefing()).getByText("Nothing needs you today.")).toBeInTheDocument();
  });

  it("shows cash today across the accounts, with the next 30 days", async () => {
    setup({ cash: cashPosition({ left_out: [{ id: "acc3", name: "Euro account", source: "plaid", mask: "9087", currency: "EUR", balance_minor: 50000, counted: false }] }) });
    const region = await screen.findByRole("region", { name: "Cash today" });
    const tile = within(region);
    await waitFor(() => expect(region).toHaveTextContent("£15,000.00"));
    expect(await tile.findByText("2 accounts")).toBeInTheDocument();
    expect(tile.getByText("Updated 2 hours ago")).toBeInTheDocument();
    // Accounts in another currency are left out of the total, and the tile says which on hover or focus
    expect(tile.getByText("1 not counted")).toBeInTheDocument();
    expect(tile.getByLabelText("Not counted (another currency): Euro account (EUR)")).toBeInTheDocument();

    // Regression: the card said "Next 90 days" over the 31 days the home endpoint sends
    expect(tile.getByText("Next 30 days")).toBeInTheDocument();
    expect(screen.queryByText("Next 90 days")).not.toBeInTheDocument();
    expect(tile.getByText(/In 30 days/).closest("span")).toHaveTextContent("In 30 days £10,003.33");
    expect(tile.getByRole("link", { name: /View cash flow/ })).toHaveAttribute("href", "/cash-flow");
    await userEvent.click(tile.getByRole("button", { name: "Table" }));
    expect(tile.getAllByRole("row")).toHaveLength(32);
  });

  it("shows the side tiles: bills due, who owes you and the top recommendation", async () => {
    setup();
    const billsTile = await screen.findByRole("group", { name: "Bills due" });
    const bills = within(billsTile);
    expect(billsTile).toHaveTextContent("£1,078.56next 7 days");
    expect(bills.getByText("2 bills")).toBeInTheDocument();
    expect(bills.getByRole("link", { name: "See them in cash flow" })).toHaveAttribute("href", "/cash-flow");

    const owed = screen.getByRole("group", { name: "Who owes you" });
    expect(owed).toHaveTextContent("£2,520.00");
    expect(owed).toHaveTextContent("£860.00 overdue");
    expect(owed).toHaveTextContent("3 invoices");
    expect(within(owed).getByRole("meter", { name: "Overdue share of what customers owe" })).toHaveAttribute("aria-valuenow", "86000");
    expect(within(owed).getByRole("link", { name: "See who owes you" })).toHaveAttribute("href", "/health?view=owed");

    const recs = within(screen.getByRole("group", { name: "Recommendations" }));
    // The urgent one first, one click from opening it
    expect(await recs.findByRole("link", { name: /Northern Packaging's bank details changed/ })).toHaveAttribute("href", "/recommendations?open=r2");
    expect(recs.getByText(/at stake/)).toHaveTextContent("£1,476.00 at stake");
    expect(recs.getByRole("link", { name: "See recommendations" })).toHaveAttribute("href", "/recommendations");
  });

  it("flags an overdue bill, and says when the next bill is when nothing is due this week", async () => {
    const { unmount } = setup({ home: homeSummary({ bills_due: { count: 1, total_minor: 24000, next_due_date: "2026-01-14" } }) });
    expect(await within(await screen.findByRole("group", { name: "Bills due" })).findByText("Oldest due 14 Jan")).toBeInTheDocument();
    unmount();

    setup({ home: homeSummary({ bills_due: { count: 0, total_minor: 0, next_due_date: "2026-11-01" }, who_owes_you: { count: 2, total_minor: 166000, overdue_minor: 0 } }) });
    expect(await screen.findByText("Next on 1 Nov")).toBeInTheDocument();
    const owed = screen.getByRole("group", { name: "Who owes you" });
    expect(owed).toHaveTextContent("None overdue");
    expect(owed).toHaveTextContent("2 invoices");
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
