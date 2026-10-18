import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BusinessHealth } from "@/api/types";
import { businessHealth, owner } from "./fixtures";
import { mockApi, renderApp } from "./utils";

function setup({ data = businessHealth(), path = "/health", cashFlow }: { data?: BusinessHealth; path?: string; cashFlow?: object } = {}) {
  const api = mockApi({
    "GET /api/auth/me": () => ({ status: 200, body: owner }),
    "GET /api/inbox": () => ({ status: 200, body: { items: [], counts: { to_review: 0, needs_approval: 0 } } }),
    "GET /api/business-health": () => ({ status: 200, body: data }),
    ...(cashFlow ? { "GET /api/cash-flow": () => ({ status: 200, body: cashFlow }) } : {}),
  });
  vi.stubGlobal("fetch", api.fetchMock);
  return { ...api, ...renderApp(path) };
}

const stat = (term: string) => screen.getByRole("button", { name: `What is “${term}”?` }).closest("[data-stat]")!;

describe("Business health", () => {
  it("shows the four headline numbers for the last three full months", async () => {
    setup();
    expect(await screen.findByRole("region", { name: "Headline numbers, Jul 2026 to Sep 2026" })).toBeInTheDocument();
    expect(stat("Profit")).toHaveTextContent(/Profit£7,500\.00Jul 2026 to Sep 2026/);
    expect(stat("Margin")).toHaveTextContent(/13%On £58,400\.00 of sales/);
    expect(stat("Days to get paid")).toHaveTextContent("35 days");
    expect(stat("Runway")).toHaveTextContent(/2\.4 monthsDown £6,200\.00 a month/);
    // A sparkline of monthly profit and a margin meter sit beside the numbers
    expect(within(stat("Profit") as HTMLElement).getByRole("img", { name: "Profit for each of the last 5 full months" })).toBeInTheDocument();
    expect(within(stat("Margin") as HTMLElement).getByRole("meter", { name: "Margin 13%" })).toBeInTheDocument();
  });

  it("doesn't show 0 days to get paid or a 0% margin when there is nothing to measure", async () => {
    // Regression: the draft rounded a missing value to "0 days", which reads as "paid at once"
    setup({ data: businessHealth({ days_to_get_paid: null, period_label: "", sales_minor: 0, profit_minor: 0, margin_pct: 0, runway_months: null, monthly_net_minor: 45000 }) });
    expect(await screen.findByRole("region", { name: "Headline numbers" })).toBeInTheDocument();
    expect(stat("Days to get paid")).toHaveTextContent(/–No invoices paid in 90 days/);
    expect(stat("Days to get paid")).not.toHaveTextContent(/\b0 days/);
    expect(stat("Profit")).toHaveTextContent("We need a full month of records");
    expect(stat("Margin")).toHaveTextContent(/–No sales in a full month yet/);
    expect(stat("Runway")).toHaveTextContent(/Cash is growing\+£450\.00 a month/);
  });

  it("switches the one view between profit, spending, suppliers and who owes you", async () => {
    setup();
    const tabs = await screen.findByRole("tablist", { name: "Choose a chart" });
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Profit", "Spending", "Suppliers", "Who owes you"]);
    expect(screen.getByRole("heading", { name: "Profit by month" })).toBeInTheDocument();

    // The profit chart keeps its table view
    const card = () => screen.getByRole("heading", { level: 2, name: "Profit by month" }).closest("section")!;
    await userEvent.click(within(card()).getByRole("button", { name: "Table" }));
    const rows = within(card()).getAllByRole("row");
    expect(rows[0]).toHaveTextContent("MonthSalesCostsProfitMargin");
    // Partial months say so in the table
    expect(rows[1]).toHaveTextContent(/Apr 2026 \(part\)£9,800\.00£7,600\.00£2,200\.00/);
    expect(rows[7]).toHaveTextContent("Oct 2026 (so far)");

    // Spending is a donut with its legend and amounts
    await userEvent.click(within(tabs).getByRole("tab", { name: "Spending" }));
    const spending = screen.getByRole("region", { name: "Where the money goes" });
    expect(within(spending).getByRole("img", { name: /Spending by category/ })).toBeInTheDocument();
    expect(within(spending).getByText("Stock").closest("li")).toHaveTextContent(/Stock47%£23,100\.00/);

    // Suppliers is a table with a share of the total per row
    await userEvent.click(within(tabs).getByRole("tab", { name: "Suppliers" }));
    const suppliers = screen.getByRole("region", { name: "Biggest suppliers" });
    const first = within(suppliers).getAllByRole("row")[1]!;
    expect(within(first).getAllByRole("cell").map((c) => c.textContent)).toEqual(["ASAcme Supplies", "75%", "£16,400.00"]);
  });

  it("opens straight on who owes you from the home card's link", async () => {
    setup({ path: "/health?view=owed" });
    const owed = await screen.findByRole("region", { name: "Unpaid invoices" });
    expect(screen.getByRole("tab", { name: "Who owes you" })).toHaveAttribute("aria-selected", "true");
    expect(within(owed).getByText("Owed").parentElement).toHaveTextContent(/Owed£2,520\.003 invoices/);
    expect(within(owed).getByText("Overdue").parentElement).toHaveTextContent(/Overdue£1,280\.0034% over 30 days/);
    // The ageing bar is described in words, and its legend carries the amounts
    expect(within(owed).getByRole("img", { name: /Not yet due 49%, 1–30 days overdue 17%, 31–60 days overdue 34%/ })).toBeInTheDocument();
    expect(within(owed).getByText("31–60 days overdue").closest("li")).toHaveTextContent("£860.00");
  });

  it("lists who owes the most, from the unpaid invoices in the forecast", async () => {
    const items = [
      { id: "i1", label: "Bright Cafe invoice INV-1", kind: "invoice", amount_minor: 30000 },
      { id: "i2", label: "Hill Farm Shop invoice INV-2", kind: "invoice", amount_minor: 42000 },
      { id: "i3", label: "Bright Cafe invoice INV-3", kind: "invoice", amount_minor: 20000 },
      { id: "b1", label: "Rent", kind: "bill", amount_minor: -90000 },
    ];
    setup({ path: "/health?view=owed", cashFlow: { items, series: [] } });
    const owed = await screen.findByRole("region", { name: "Unpaid invoices" });
    const table = await within(owed).findByRole("table");
    const names = within(table).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0]!.textContent);
    expect(names).toEqual(["BCBright Cafe", "HSHill Farm Shop"]);
  });

  it("says when a view has nothing to show", async () => {
    setup({ data: businessHealth({ spending: [] }), path: "/health?view=spending" });
    expect(await screen.findByText("No spending in the last 90 days.")).toBeInTheDocument();
  });

  it("lists the health checks with why each one shows, one click away", async () => {
    setup();
    const checks = within((await screen.findByRole("heading", { name: /Health checks/ })).closest("section")!);
    const items = checks.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("34% of what customers owe is over 30 days overdue.");
    expect(within(items[0]!).getByText("Needs attention")).toBeInTheDocument();
    expect(within(items[1]!).getByText("Urgent")).toBeInTheDocument();
    expect(screen.queryByText(/We flag this when more than 20%/)).not.toBeInTheDocument();
    await userEvent.click(within(items[0]!).getByRole("button", { name: "Why am I seeing this?" }));
    expect(await screen.findByText(/We flag this when more than 20% of unpaid invoices/)).toBeInTheDocument();
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
