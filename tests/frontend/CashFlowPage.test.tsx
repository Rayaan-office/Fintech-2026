import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CashFlow, Me, PlannedCost, SavedPlan, WhatIfInput, WhyCashChanged } from "@/api/types";
import { bookkeeper, cashFlow, owner, whatIfResult, whyCash } from "./fixtures";
import { mockApi, renderApp } from "./utils";

const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body ?? "null"));

function setup({
  me = owner,
  data = cashFlow(),
  why = whyCash(),
  path = "/cash-flow",
  whatIfStatus = 200,
}: { me?: Me; data?: CashFlow; why?: WhyCashChanged; path?: string; whatIfStatus?: number } = {}) {
  const kept: SavedPlan[] = [];
  const api = mockApi({
    "GET /api/auth/me": () => ({ status: 200, body: me }),
    "GET /api/inbox": () => ({ status: 200, body: { items: [], counts: { to_review: 0, needs_approval: 0 } } }),
    "GET /api/cash-flow": () => ({ status: 200, body: data }),
    "GET /api/cash-flow/why": (_init, url) => ({ status: 200, body: { ...why, period: url.searchParams.get("period") } }),
    "POST /api/cash-flow/what-if": (init) =>
      whatIfStatus === 200
        ? { status: 200, body: whatIfResult(bodyOf(init) as WhatIfInput, data) }
        : { status: whatIfStatus, body: { detail: "Pick a date within the next year." } },
    "GET /api/planned-items": () => ({ status: 200, body: { items: kept } }),
    "POST /api/planned-items": (init) => {
      const p = bodyOf(init) as Required<PlannedCost>;
      kept.push({ ...p, id: `p${kept.length + 1}` });
      return { status: 200, body: kept.at(-1) };
    },
  });
  vi.stubGlobal("fetch", api.fetchMock);
  return { ...api, ...renderApp(path) };
}

const whatIfBodies = (calls: ReturnType<typeof setup>["calls"]) =>
  calls.filter((c) => c.path === "/api/cash-flow/what-if").map((c) => bodyOf(c.init) as WhatIfInput);

describe("Cash flow", () => {
  it("leads with the lowest point, the days ahead, the warnings and the safety level", async () => {
    setup();
    const headline = (await screen.findByText("Lowest point in the next 90 days")).closest("div")!.parentElement!;
    expect(headline).toHaveTextContent("£7,505.00");
    expect(headline).toHaveTextContent("on 2 Dec 2026");
    expect(headline).toHaveTextContent("Below your safety level");
    expect(screen.getByText("In 30 days").nextElementSibling).toHaveTextContent("£10,003.33");

    const warnings = within(screen.getByRole("heading", { name: "Warnings" }).closest("section")!);
    expect(warnings.getByText(/VAT \(estimated\) on 7 November will take you below your safety level/)).toBeInTheDocument();
    await userEvent.click(warnings.getByRole("button", { name: "Why am I seeing this?" }));
    expect(warnings.getByText(/against a safety level of £10,000.00/)).toBeInTheDocument();
    expect(warnings.getByRole("link", { name: "Ways to cover it" })).toHaveAttribute("href", "/financing");

    expect(screen.getByText(/Two weeks of your usual spending/)).toBeInTheDocument();
  });

  it("moves a bill with the arrow keys and shows the new lowest point next to the old one", async () => {
    const { calls } = setup();
    const acme = await screen.findByRole("slider", { name: "Move Acme Supplies bill AS-1005" });
    expect(acme).toHaveAttribute("aria-valuetext", "1 Nov 2026");
    // Only unpaid bills can be moved, not payroll or VAT
    expect(screen.queryByRole("slider", { name: /Payroll|VAT/ })).not.toBeInTheDocument();

    fireEvent.keyDown(acme, { key: "ArrowRight" });
    fireEvent.keyDown(acme, { key: "ArrowRight" });
    expect(acme).toHaveAttribute("aria-valuetext", "3 Nov 2026");

    const bar = await screen.findByRole("status");
    await waitFor(() => expect(bar).toHaveTextContent("Lowest point £8,163.56 on 2 Dec, instead of £7,505.00 (£658.56 higher)."));
    expect(bar).toHaveTextContent("Nothing is saved and your records don't change.");
    // Asked once the keys stopped, not for the day in between
    expect(whatIfBodies(calls)).toEqual([{ planned: [], excluded_bill_ids: [], moved_bills: [{ id: "bill:b1", date: "2026-11-03" }] }]);

    const row = screen.getByText("Acme Supplies bill AS-1005", { selector: "span" }).closest("li")!;
    expect(row).toHaveTextContent("Moved from 1 Nov");
    await userEvent.click(within(row).getByRole("button", { name: /Put back/ }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(acme).toHaveAttribute("aria-valuetext", "1 Nov 2026");
  });

  it("moves a bill by dragging it along the strip", async () => {
    const { calls } = setup();
    const energy = await screen.findByRole("slider", { name: "Move BrightSpark Energy bill BS-77" });
    const track = energy.parentElement!;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ left: 0, width: 900, top: 0, height: 40, right: 900, bottom: 40, x: 0, y: 0, toJSON: () => ({}) });

    fireEvent.pointerDown(energy, { pointerId: 1, clientX: 180 });
    fireEvent.pointerMove(energy, { pointerId: 1, clientX: 300 });
    // While dragging, only the strip moves; nothing is asked yet
    expect(energy).toHaveAttribute("aria-valuetext", "17 Nov 2026");
    fireEvent.pointerUp(energy, { pointerId: 1, clientX: 300 });

    await waitFor(() => expect(whatIfBodies(calls).at(-1)).toEqual({ planned: [], excluded_bill_ids: [], moved_bills: [{ id: "bill:b2", date: "2026-11-17" }] }));
    expect(await screen.findByText("Moved from 5 Nov")).toBeInTheDocument();
  });

  it("leaves a payment out when it is switched off", async () => {
    const { calls } = setup();
    await userEvent.click(await screen.findByRole("switch", { name: "Include VAT (estimated) in the forecast" }));
    await waitFor(() => expect(whatIfBodies(calls).at(-1)).toEqual({ planned: [], excluded_bill_ids: ["vat:2026-11-07"], moved_bills: [] }));
    expect(await screen.findByRole("status")).toHaveTextContent("instead of £7,505.00 (£3,100.00 higher)");
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Include VAT (estimated) in the forecast" })).toBeChecked();
  });

  it("tries a planned cost, then keeps it in the forecast", async () => {
    const { calls } = setup();
    await userEvent.click(await screen.findByRole("button", { name: /Plan a cost/ }));
    const panel = await screen.findByRole("dialog", { name: "Plan a cost" });
    await userEvent.type(within(panel).getByLabelText("What is it?"), "New van");
    await userEvent.type(within(panel).getByLabelText("Amount"), "12,000");
    fireEvent.change(within(panel).getByLabelText("When"), { target: { value: "2026-11-20" } });
    await userEvent.selectOptions(within(panel).getByLabelText("How often"), "monthly");
    await userEvent.click(within(panel).getByRole("button", { name: "Try it in the forecast" }));

    const van = { label: "New van", amount_minor: 1200000, date: "2026-11-20", repeat: "monthly", direction: "out" };
    await waitFor(() => expect(whatIfBodies(calls).at(-1)).toEqual({ planned: [van], excluded_bill_ids: [], moved_bills: [] }));
    expect(await screen.findByRole("status")).toHaveTextContent("Lowest point −£4,495.00");

    const tried = within(within(panel).getByRole("heading", { name: /Trying out/ }).closest("section")!);
    expect(tried.getByText(/New van · 20 Nov/)).toHaveTextContent("every month");
    await userEvent.click(tried.getByRole("button", { name: "Keep in forecast" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/planned-items")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "POST" && c.path === "/api/planned-items")!.init)).toEqual(van);
    expect(await screen.findByText("New van is now in the forecast for everyone in the business.")).toBeInTheDocument();
    const kept = within((await within(panel).findByRole("heading", { name: "Kept in the forecast" })).closest("section")!);
    expect(kept.getByText(/New van · 20 Nov/)).toBeInTheDocument();
    expect(within(panel).queryByRole("heading", { name: /Trying out/ })).not.toBeInTheDocument();
  });

  it("explains what's wrong with a planned cost before trying it", async () => {
    setup({ path: "/cash-flow?plan=1" });
    const panel = await screen.findByRole("dialog", { name: "Plan a cost" });
    await userEvent.type(within(panel).getByLabelText("What is it?"), "Van");
    await userEvent.type(within(panel).getByLabelText("Amount"), "twelve");
    expect(within(panel).getByRole("alert")).toHaveTextContent("Enter the amount as a number, such as 12,000.");
    await userEvent.clear(within(panel).getByLabelText("Amount"));
    await userEvent.type(within(panel).getByLabelText("Amount"), "12000");
    fireEvent.change(within(panel).getByLabelText("When"), { target: { value: "2028-01-01" } });
    expect(within(panel).getByRole("alert")).toHaveTextContent("Pick a date between 19 Oct 2026 and 18 Oct 2027.");
    expect(within(panel).getByRole("button", { name: "Try it in the forecast" })).toBeDisabled();
  });

  it("shows the server's message when a what-if can't be worked out", async () => {
    setup({ whatIfStatus: 422 });
    fireEvent.keyDown(await screen.findByRole("slider", { name: "Move Acme Supplies bill AS-1005" }), { key: "End" });
    expect(await screen.findByText("Pick a date within the next year.")).toBeInTheDocument();
    // The forecast itself still shows
    expect(screen.getByText("Lowest point in the next 90 days")).toBeInTheDocument();
  });

  it("explains why cash changed, with the AI label and what the AI saw", async () => {
    const { calls } = setup();
    const why = within((await screen.findByRole("heading", { name: "Why cash changed" })).closest("section")!);
    expect(await why.findByText(/Customers paid £2,100.00 less/)).toBeInTheDocument();
    expect(why.getByText("Checked against your records")).toBeInTheDocument();
    await userEvent.click(why.getByRole("button", { name: "What the AI saw" }));
    expect(why.getByTestId("ai-saw")).toHaveTextContent("[CUSTOMER_1] £1,240.00");
    const reasons = why.getByRole("list", { name: "Reasons, largest first" });
    expect(within(reasons).getAllByRole("listitem")[0]).toHaveTextContent(/Customer payments.*Bright Cafe, Hill Farm Shop.*−£2,100.00less cash/);
    expect(within(reasons).getAllByRole("listitem")[2]).toHaveTextContent(/Card sales.*\+£300.00more cash/);

    await userEvent.click(why.getByRole("tab", { name: "Last 30 days" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/cash-flow/why" && c.url.searchParams.get("period") === "30d")).toBe(true));
  });

  it("shows our own wording without the AI label when the AI didn't write it", async () => {
    const own = whyCash();
    setup({ why: { ...own, explanation: { text: own.sentence, redacted_input: "", ai_written: false } } });
    const why = within((await screen.findByRole("heading", { name: "Why cash changed" })).closest("section")!);
    expect(await why.findByText(/The main reasons: customer payments/)).toBeInTheDocument();
    expect(why.queryByText("Checked against your records")).not.toBeInTheDocument();
  });

  it("lets a bookkeeper try costs but not keep them, and doesn't offer financing", async () => {
    setup({ me: bookkeeper, path: "/cash-flow?plan=1" });
    const panel = await screen.findByRole("dialog", { name: "Plan a cost" });
    await userEvent.type(within(panel).getByLabelText("What is it?"), "Oven");
    await userEvent.type(within(panel).getByLabelText("Amount"), "3000");
    fireEvent.change(within(panel).getByLabelText("When"), { target: { value: "2026-11-02" } });
    await userEvent.click(within(panel).getByRole("button", { name: "Try it in the forecast" }));
    expect(within(panel).getByText(/Oven · 2 Nov/)).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Keep in forecast" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Ways to cover it" })).not.toBeInTheDocument();
  });

  it("shows the empty state when there is nothing to forecast yet", async () => {
    setup({ data: cashFlow({ balance_minor: 0, items: [], bills: [], warnings: [] }) });
    expect(await screen.findByText("No forecast yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Connect your bank/ })).toHaveAttribute("href", "/connections");
  });
});
