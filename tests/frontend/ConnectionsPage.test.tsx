import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Connection, Me } from "@/api/types";
import { countsSummary } from "@/pages/ConnectionsPage";
import { bookkeeper, owner } from "./fixtures";
import { mockApi, renderApp } from "./utils";

const card = (over: Partial<Connection>): Connection => ({
  kind: "email", provider: "mailpit", provider_label: "Mailpit test inbox", title: "Email inbox", what: "Bills, receipts and payment notices",
  required: true, status: "connected", last_sync_at: new Date(Date.now() - 5 * 60_000).toISOString(), error: null, counts: null,
  address: "bills@demo-bakery.example", ...over,
});

const CARDS: Connection[] = [
  card({}),
  card({ kind: "payments", provider: "stripe", provider_label: "Stripe sandbox (UK)", title: "Payment platform", what: "Money customers paid", required: false, status: "disconnected", last_sync_at: null, address: null }),
  card({
    kind: "bank", provider: "plaid", provider_label: "Plaid sandbox (UK)", title: "Bank account", what: "Money in and out of the bank", required: false,
    status: "expired", error: "The bank connection has expired. Reconnect.", address: null, counts: { transactions: 266, accounts: 1 },
  }),
  card({ kind: "accounting", provider: "quickbooks", provider_label: "QuickBooks sandbox (UK)", title: "Accounting software", what: "The official books", required: false, status: "connected", address: null, counts: { invoices: 117, bills: 44 } }),
];

function setup({ me = owner, path = "/connections", cards = CARDS }: { me?: Me; path?: string; cards?: Connection[] } = {}) {
  const api = mockApi({
    "GET /api/auth/me": () => ({ status: 200, body: me }),
    "GET /api/inbox": () => ({ status: 200, body: { items: [], counts: { to_review: 0, needs_approval: 0 } } }),
    "GET /api/connections": () => ({
      status: 200,
      body: { items: cards, accounts: [{ id: "acc1", source: "plaid", name: "Business Current", mask: "4421", currency: "GBP", balance_minor: 2024779, as_of: new Date().toISOString() }] },
    }),
    "POST /api/connections/stripe/connect": () => ({ status: 200, body: { ok: true, counts: { customers: 5, payments: 33 }, matched: {} } }),
    "POST /api/connections/plaid/connect": () => ({ status: 200, body: { ok: true, counts: { transactions: 266 }, matched: {} } }),
    "POST /api/connections/mailpit/sync": () => ({ status: 200, body: { ok: true, counts: { emails: 2 }, matched: {} } }),
    "POST /api/connections/quickbooks/sync": () => ({ status: 502, body: { detail: "We couldn't reach QuickBooks sandbox (UK). Try again in a minute." } }),
    "POST /api/connections/quickbooks/disconnect": () => ({ status: 200, body: { ok: true } }),
  });
  vi.stubGlobal("fetch", api.fetchMock);
  return { ...api, ...renderApp(path) };
}

const cardFor = async (title: string) => (await screen.findByRole("heading", { name: title })).closest<HTMLElement>("li")!;

describe("Connections", () => {
  it("shows each tool's status, last sync and the API's last error", async () => {
    setup();
    const email = await cardFor("Email inbox");
    expect(email).toHaveTextContent("Connected");
    expect(email).toHaveTextContent("Synced 5 minutes ago");
    expect(email).toHaveTextContent("bills@demo-bakery.example");
    expect(within(email).queryByRole("button", { name: /Disconnect/ })).not.toBeInTheDocument();

    const bank = await cardFor("Bank account");
    expect(bank).toHaveTextContent("Needs reconnecting");
    expect(within(bank).getByRole("alert")).toHaveTextContent("The bank connection has expired. Reconnect.");
    expect(within(bank).getByRole("button", { name: "Reconnect" })).toBeInTheDocument();

    expect(await cardFor("Payment platform")).toHaveTextContent("Never connected");
    expect(screen.getByText("Business Current")).toBeInTheDocument();
  });

  it("connects Stripe and reconnects the bank with one click each", async () => {
    const { calls } = setup();
    await userEvent.click(within(await cardFor("Payment platform")).getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("Payment platform connected. Found 5 customers, 33 payments.")).toBeInTheDocument();
    await userEvent.click(within(await cardFor("Bank account")).getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/connections/plaid/connect")).toBe(true));
  });

  it("connects QuickBooks with a plain link to Intuit's sign-in", async () => {
    setup({ cards: CARDS.map((c) => (c.provider === "quickbooks" ? { ...c, status: "disconnected" as const } : c)) });
    const connect = within(await cardFor("Accounting software")).getByRole("link", { name: "Connect" });
    expect(connect).toHaveAttribute("href", "/connect/quickbooks/start");
  });

  it("syncs, and shows the server's message when a sync fails", async () => {
    setup();
    await userEvent.click(within(await cardFor("Email inbox")).getByRole("button", { name: "Check for new emails" }));
    expect(await screen.findByText("Email inbox checked for new emails. Found 2 emails.")).toBeInTheDocument();
    await userEvent.click(within(await cardFor("Accounting software")).getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText("We couldn't reach QuickBooks sandbox (UK). Try again in a minute.")).toBeInTheDocument();
  });

  it("keeps the details and Disconnect in a side panel", async () => {
    setup();
    const accounting = await cardFor("Accounting software");
    expect(within(accounting).queryByRole("button", { name: /Disconnect/ })).not.toBeInTheDocument();
    await userEvent.click(within(accounting).getByRole("button", { name: "Accounting software details" }));
    const panel = await screen.findByRole("dialog", { name: "Accounting software" });
    expect(panel).toHaveTextContent("The official books");
    expect(panel).toHaveTextContent("117");
    expect(within(panel).getByRole("button", { name: /Disconnect/ })).toBeInTheDocument();
  });

  it("asks before disconnecting", async () => {
    const { calls } = setup();
    await userEvent.click(within(await cardFor("Accounting software")).getByRole("button", { name: "Accounting software details" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Accounting software" })).getByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("dialog", { name: "Disconnect accounting software?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/connections/quickbooks/disconnect")).toBe(true));
    expect(await screen.findByText("Accounting software disconnected.")).toBeInTheDocument();
  });

  it.each([
    ["connected", "QuickBooks is connected, and we've read your books."],
    ["connected_sync_failed", "QuickBooks is connected, but the first read didn't finish. Try Sync in a minute."],
    ["cancelled", "QuickBooks sign-in was cancelled. Nothing was changed."],
    ["failed", "We couldn't connect QuickBooks. Please try again."],
    ["taken", "That QuickBooks company is already connected to another business."],
  ])("explains the QuickBooks sign-in result %s, then tidies the address", async (outcome, message) => {
    const { router } = setup({ path: `/connections?qbo=${outcome}` });
    expect(await screen.findByText(message)).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toBe(""));
  });

  it("tells people who can't change connections why", async () => {
    setup({ me: bookkeeper });
    const stripe = await cardFor("Payment platform");
    expect(within(stripe).getByRole("button", { name: "Connect" })).toBeDisabled();
    expect(stripe).toHaveTextContent("Only a business owner or finance manager can connect or disconnect.");
    // Anyone who can see the books can still bring them up to date
    expect(within(await cardFor("Accounting software")).getByRole("button", { name: "Sync now" })).toBeEnabled();
  });

  // Regression: a sync that found one account said "Found 1 accounts"
  it("says one of something in the singular", () => {
    expect(countsSummary({ accounts: 1, added: 266 })).toBe("1 account, 266 added");
    expect(countsSummary({ customers: 5, invoices: 1, carried_over: 2 })).toBe("5 customers, 1 invoice, 2 carried over");
  });
});
