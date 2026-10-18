import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Financing, Me, QuoteResult } from "@/api/types";
import { action, financeManager, financing, owner, quote } from "./fixtures";
import { mockApi, renderApp } from "./utils";

const share = action({
  id: "a20",
  type: "share_lender_pack",
  type_label: "Share a lender pack",
  level: 3,
  level_label: "Outside action",
  summary: "Share the lender pack with Northgate Bank (loans@northgate.example)",
  effects: ["Email the lender pack PDF to loans@northgate.example"],
  reasons: ["Sharing your figures with a lender is an outside action: a business owner must approve it."],
  amount_minor: null,
  approvers: "One person: a business owner",
});

function quoteResult(body: { option_id: string; amount_minor: number; months: number }): QuoteResult {
  const { covers_need: _, ...q } = quote({ amount_minor: body.amount_minor, months: body.months, total_cost_minor: Math.round(body.amount_minor * 0.01 * body.months), monthly_repayment_minor: 2000 });
  return {
    ...q,
    option_id: body.option_id,
    eligible: true,
    reasons: [],
    forecast_effect: `With ${body.months} months, cash stays above your safety level for the next 90 days.`,
    series: [
      { date: "2026-10-18", expected_minor: 1500000 },
      { date: "2026-10-25", expected_minor: 1400000 },
    ],
  };
}

function setup({ me = owner, data = financing() }: { me?: Me; data?: Financing } = {}) {
  const api = mockApi({
    "GET /api/auth/me": () => ({ status: 200, body: me }),
    "GET /api/inbox": () => ({ status: 200, body: { items: [], counts: { to_review: 0, needs_approval: 0 } } }),
    "GET /api/financing": (_init, url) =>
      url.searchParams.get("amount_minor")
        ? { status: 200, body: { ...data, need: { amount_minor: Number(url.searchParams.get("amount_minor")), months: null, source: "you" } } }
        : { status: 200, body: data },
    "GET /api/cash-flow": () => ({ status: 200, body: { series: [{ date: "2026-10-18", expected_minor: 1200000 }], safety_level_minor: 1000000 } }),
    "POST /api/financing/quote": (init) => ({ status: 200, body: quoteResult(JSON.parse(String(init?.body))) }),
    "PUT /api/business-profile": () => ({ status: 200, body: data.profile }),
    "POST /api/lender-pack/share": () => ({ status: 200, body: { action: me === owner ? share : { ...share, can_approve: false, why_not: "Only a business owner can approve this." } } }),
  });
  vi.stubGlobal("fetch", api.fetchMock);
  return { ...api, ...renderApp("/financing") };
}

const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body ?? "null"));

describe("Financing", () => {
  it("leads with the gap and the checked summary", async () => {
    setup();
    // The safety level minus the lowest point, not the amount with the 5% margin
    expect((await screen.findByText("Cash gap to cover")).parentElement).toHaveTextContent(/Cash gap to cover£2,495\.00Below/);
    expect(screen.getByText(/the gap plus 5% for what borrowing costs/)).toHaveTextContent("£2,620.00");
    expect(screen.getByText(/Asking suppliers for longer terms would cover it for free/)).toBeInTheDocument();
    expect(screen.getByText("Checked against your records")).toBeInTheDocument();
    expect(screen.getByText(/not financial advice/)).toBeInTheDocument();
  });

  it("shows options that fit first, and near misses with what would change", async () => {
    setup();
    const fits = within((await screen.findByRole("heading", { name: /Options you can use/ })).closest("section")!);
    const cards = fits.getAllByRole("article");
    expect(cards.map((c) => within(c).getByRole("heading").textContent)).toEqual(["Ask suppliers for longer payment terms", "Business overdraft"]);
    expect(cards[0]).toHaveTextContent("Free");
    expect(cards[1]).toHaveTextContent("£25.84");
    expect(cards[1]).toHaveTextContent("Keeps cash above your safety level");

    const near = within(screen.getByRole("heading", { name: "Not available yet" }).closest("section")!);
    expect(near.getByText("Small business loan")).toBeInTheDocument();
    expect(near.getByText("Available after 18 more months of trading.")).toBeInTheDocument();
  });

  it("costs an option at the amount and length on the sliders, with the effect on the forecast", async () => {
    const { calls } = setup();
    const overdraft = (await screen.findAllByRole("article"))[1]!;
    await userEvent.click(within(overdraft).getByRole("button", { name: "Try amounts and lengths" }));
    const panel = await screen.findByRole("dialog", { name: "Business overdraft" });
    expect(await within(panel).findByText("With 1 months, cash stays above your safety level for the next 90 days.")).toBeInTheDocument();

    const length = within(panel).getByRole("slider", { name: "Length in months" });
    length.focus();
    fireEvent.keyDown(length, { key: "ArrowRight" });
    fireEvent.keyDown(length, { key: "ArrowRight" });
    expect(await within(panel).findByText("With 3 months, cash stays above your safety level for the next 90 days.")).toBeInTheDocument();
    const quotes = calls.filter((c) => c.path === "/api/financing/quote").map((c) => bodyOf(c.init));
    expect(quotes.at(-1)).toEqual({ option_id: "overdraft", amount_minor: 262000, months: 3 });
    // Debounced: the in-between length was never asked for
    expect(quotes.some((q) => q.months === 2)).toBe(false);
    expect(within(panel).getByText("Cash with this option")).toBeInTheDocument();
  });

  it("compares for an amount the owner types in", async () => {
    const { calls } = setup();
    await userEvent.type(await screen.findByLabelText("Amount (£)"), "18000");
    await userEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(await screen.findByText("You're looking for")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/financing" && c.url.searchParams.get("amount_minor") === "1800000")).toBe(true);
  });

  it("shows the readiness checklist with tips for what isn't ready", async () => {
    setup();
    const list = within((await screen.findByRole("heading", { name: "What a lender looks at" })).closest("section")!);
    expect(list.getByText("1 of 2 ready")).toBeInTheDocument();
    expect(list.getByText(/Many lenders want 2 years of trading/)).toBeInTheDocument();
  });

  it("shows a correction next to the automatic value, and lets the owner edit the profile", async () => {
    const { calls } = setup();
    const profile = within((await screen.findByRole("heading", { name: "Business profile" })).closest("section")!);
    const sales = profile.getByText("Average monthly sales (6 months, before VAT)").parentElement!;
    expect(sales).toHaveTextContent("£20,000.00");
    expect(sales).toHaveTextContent(/Corrected by you.*Automatic: £18,500.00/);

    await userEvent.click(profile.getByRole("button", { name: "Edit profile" }));
    const panel = await screen.findByRole("dialog", { name: "Edit business profile" });
    await userEvent.selectOptions(within(panel).getByLabelText("Type of business"), "limited_company");
    await userEvent.click(within(panel).getByRole("button", { name: "Correct Months trading" }));
    const months = within(panel).getByLabelText(/Months trading/);
    await userEvent.clear(months);
    await userEvent.type(months, "30");
    await userEvent.click(within(panel).getByRole("button", { name: /Use the automatic average monthly sales/ }));
    await userEvent.click(within(panel).getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT")!.init)).toEqual({
      owner_fields: { business_type: "limited_company" },
      overrides: { months_trading: 30, monthly_sales_minor: null },
    });
  });

  it("downloads the lender pack and asks an owner to approve sharing it", async () => {
    const { calls } = setup();
    expect(await screen.findByRole("link", { name: /Download PDF/ })).toHaveAttribute("href", "/api/lender-pack.pdf");
    await userEvent.click(screen.getByRole("button", { name: /Share with a lender/ }));
    const panel = await screen.findByRole("dialog", { name: "Share the lender pack" });
    await userEvent.type(within(panel).getByLabelText("Lender"), "Northgate Bank");
    await userEvent.type(within(panel).getByLabelText("Their email"), "loans@northgate.example");
    await userEvent.click(within(panel).getByRole("button", { name: "Prepare and ask for approval" }));
    const card = await within(panel).findByRole("region", { name: /Confirm: Share the lender pack with Northgate Bank/ });
    expect(bodyOf(calls.find((c) => c.path === "/api/lender-pack/share")!.init)).toEqual({ lender_name: "Northgate Bank", email: "loans@northgate.example" });
    expect(within(card).getByRole("button", { name: /Approve/ })).toBeEnabled();
  });

  it("lets a finance manager prepare the pack but not approve it or edit the profile", async () => {
    setup({ me: financeManager });
    expect(await screen.findByText("Only a business owner can change the profile.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit profile" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Share with a lender/ }));
    const panel = await screen.findByRole("dialog", { name: "Share the lender pack" });
    await userEvent.type(within(panel).getByLabelText("Lender"), "Northgate Bank");
    await userEvent.type(within(panel).getByLabelText("Their email"), "loans@northgate.example");
    await userEvent.click(within(panel).getByRole("button", { name: "Prepare and ask for approval" }));
    const card = await within(panel).findByRole("region", { name: /Confirm: Share the lender pack/ });
    expect(card).toHaveTextContent("Only a business owner can approve this.");
  });
});
