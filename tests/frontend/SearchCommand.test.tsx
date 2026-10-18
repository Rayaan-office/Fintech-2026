import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "@/api/types";
import { owner } from "./fixtures";
import { mockApi, renderApp } from "./utils";

const results: SearchResult[] = [
  { id: "s1", kind: "supplier", label: "Acme Supplies Ltd", href: "/recommendations?open=r1" },
  { id: "b1", kind: "bill", label: "Bill AS-1005 · Acme Supplies Ltd · £658.56", href: "/documents?open=d1" },
];

function setup() {
  const api = mockApi({
    "GET /api/auth/me": () => ({ status: 200, body: owner }),
    "POST /api/search": () => ({ status: 200, body: { results } }),
  });
  vi.stubGlobal("fetch", api.fetchMock);
  return { ...api, ...renderApp("/") };
}

describe("Search", () => {
  // The command list scrolls the highlighted result into view; the test browser has no layout
  beforeAll(() => {
    Element.prototype.scrollIntoView ??= () => {};
  });

  it("shows results from the server and opens the one chosen", async () => {
    const user = userEvent.setup();
    const { calls, router } = setup();
    await user.click(await screen.findByRole("button", { name: "Search everything" }));
    await user.type(screen.getByPlaceholderText(/Search bills, customers, suppliers/), "acme");

    const bill = await screen.findByRole("option", { name: /Bill AS-1005 · Acme Supplies Ltd · £658.56/ });
    expect(screen.getByRole("option", { name: /Acme Supplies Ltd\s*supplier/i })).toBeInTheDocument();

    // The search goes in the request body, never in the address
    const sent = calls.filter((c) => c.path === "/api/search");
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((c) => c.method === "POST" && c.url.search === "")).toBe(true);
    expect(JSON.parse(String(sent.at(-1)!.init?.body))).toEqual({ q: "acme" });

    await user.click(bill);
    await waitFor(() => expect(router.state.location.pathname).toBe("/documents"));
    expect(router.state.location.search).toBe("?open=d1");
    expect(screen.queryByPlaceholderText(/Search bills, customers, suppliers/)).not.toBeInTheDocument();
  });

  it("waits for two characters before searching", async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    await user.click(await screen.findByRole("button", { name: "Search everything" }));
    await user.type(screen.getByPlaceholderText(/Search bills, customers, suppliers/), "a");
    expect(await screen.findByRole("option", { name: /Upload a document/ })).toBeInTheDocument(); // pages still match
    expect(screen.queryByRole("option", { name: /Acme/ })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/search")).toBe(false);
  });
});
