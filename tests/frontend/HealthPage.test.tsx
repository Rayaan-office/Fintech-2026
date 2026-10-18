import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BusinessHealth } from "@/api/types";
import { businessHealth, owner } from "./fixtures";
import { mockApi, renderApp } from "./utils";

function setup({ data = businessHealth(), path = "/health" }: { data?: BusinessHealth; path?: string } = {}) {
  const api = mockApi({
    "GET /api/auth/me": () => ({ status: 200, body: owner }),
    "GET /api/inbox": () => ({ status: 200, body: { items: [], counts: { to_review: 0, needs_approval: 0 } } }),
    "GET /api/business-health": () => ({ status: 200, body: data }),
  });
  vi.stubGlobal("fetch", api.fetchMock);
  return { ...api, ...renderApp(path) };
}

const stat = (term: string) => screen.getByRole("button", { name: `What is “${term}”?` }).closest("div.bg-card")!;

describe("Business health", () => {
  it("shows the four headline numbers for the last three full months", async () => {
    setup();
    expect(await screen.findByRole("region", { name: "Headline numbers, Jul 2026 to Sep 2026" })).toBeInTheDocument();
    expect(stat("Profit")).toHaveTextContent(/Profit£7,500\.00Jul 2026 to Sep 2026/);
    expect(stat("Margin")).toHaveTextContent(/13%On £58,400\.00 of sales/);
    expect(stat("Days to get paid")).toHaveTextContent("35 days");
    expect(stat("Runway")).toHaveTextContent(/2\.4 months£6,200\.00 a month more going out than coming in/);
  });

  it("doesn't show 0 days to get paid or a 0% margin when there is nothing to measure", async () => {
    // Regression: the draft rounded a missing value to "0 days", which reads as "paid at once"
    setup({ data: businessHealth({ days_to_get_paid: null, period_label: "", sales_minor: 0, profit_minor: 0, margin_pct: 0, runway_months: null, monthly_net_minor: 45000 }) });
    expect(await screen.findByRole("region", { name: "Headline numbers" })).toBeInTheDocument();
    expect(stat("Days to get paid")).toHaveTextContent(/–No invoices paid in the last 90 days/);
    expect(stat("Days to get paid")).not.toHaveTextContent(/\b0 days/);
    expect(stat("Profit")).toHaveTextContent("We need a full month of records");
    expect(stat("Margin")).toHaveTextContent(/–No sales in a full month yet/);
    expect(stat("Runway")).toHaveTextContent(/Cash is growing\+£450\.00 a month on average/);
  });

  it("switches the one chart between profit, spending, suppliers and who owes you, each with a table", async () => {
    setup();
    const tabs = await screen.findByRole("tablist", { name: "Choose a chart" });
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Profit", "Spending", "Suppliers", "Who owes you"]);
    expect(screen.getByRole("heading", { name: "Profit by month" })).toBeInTheDocument();

    const card = () => screen.getByRole("heading", { level: 2, name: /Profit by month|Where the money goes|Biggest suppliers|Who owes you/ }).closest("section")!;
    await userEvent.click(within(card()).getByRole("button", { name: "Table" }));
    const rows = within(card()).getAllByRole("row");
    expect(rows[0]).toHaveTextContent("MonthSalesCostsProfitMargin");
    // Partial months say so in the table
    expect(rows[1]).toHaveTextContent(/Apr 2026 \(part\)£9,800\.00£7,600\.00£2,200\.00/);
    expect(rows[7]).toHaveTextContent("Oct 2026 (so far)");

    await userEvent.click(within(tabs).getByRole("tab", { name: "Spending" }));
    expect(screen.getByRole("heading", { name: "Where the money goes" })).toBeInTheDocument();
    await userEvent.click(within(tabs).getByRole("tab", { name: "Suppliers" }));
    expect(screen.getByRole("heading", { name: "Biggest suppliers" })).toBeInTheDocument();
    await userEvent.click(within(card()).getByRole("button", { name: "Table" }));
    expect(within(card()).getAllByRole("row")[1]).toHaveTextContent(/Acme Supplies£16,400\.00/);
  });

  it("opens straight on who owes you from the home card's link", async () => {
    setup({ path: "/health?view=owed" });
    expect(await screen.findByRole("heading", { name: "Who owes you, by how overdue" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Who owes you" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/across 3 unpaid invoices/)).toHaveTextContent("£2,520.00 across 3 unpaid invoices, £1,280.00 of it overdue.");
  });

  it("says when a view has nothing to show", async () => {
    setup({ data: businessHealth({ spending: [] }), path: "/health?view=spending" });
    expect(await screen.findByText("No spending in the last 90 days.")).toBeInTheDocument();
  });

  it("lists the health checks with why each one shows", async () => {
    setup();
    const checks = within((await screen.findByRole("heading", { name: "Health checks" })).closest("section")!);
    const items = checks.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("34% of what customers owe is over 30 days overdue.");
    expect(within(items[1]!).getByLabelText("Urgent")).toBeInTheDocument();
    await userEvent.click(within(items[0]!).getByRole("button", { name: "Why am I seeing this?" }));
    expect(items[0]).toHaveTextContent("We flag this when more than 20% of unpaid invoices");
  });

  it("says nothing stands out when every check passes", async () => {
    setup({ data: businessHealth({ checks: [] }) });
    expect(await screen.findByText(/Nothing stands out right now/)).toBeInTheDocument();
  });

  it("shows the empty state before there are any sales, costs or invoices", async () => {
    const h = businessHealth();
    setup({
      data: businessHealth({
        period_label: "", profit_and_loss: h.profit_and_loss.map((m) => ({ ...m, sales_minor: 0, costs_minor: 0, profit_minor: 0, margin_pct: null })),
        owed: { ...h.owed, count: 0, total_minor: 0, overdue_minor: 0 },
      }),
    });
    expect(await screen.findByText("Not enough history yet")).toBeInTheDocument();
  });
});
