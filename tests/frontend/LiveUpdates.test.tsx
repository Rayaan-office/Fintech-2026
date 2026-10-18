import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { businessHealth, cashFlow, owner, whyCash } from "./fixtures";
import { mockApi, renderApp } from "./utils";

/** Stands in for the browser's EventSource so a test can push the server's short events. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  private listeners = new Map<string, ((e: MessageEvent<string>) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {}
  push(event: string) {
    for (const fn of this.listeners.get("update") ?? []) fn(new MessageEvent("update", { data: JSON.stringify({ event }) }));
  }
}

function setup(path: string) {
  const api = mockApi({
    "GET /api/auth/me": () => ({ status: 200, body: owner }),
    "GET /api/inbox": () => ({ status: 200, body: { items: [], counts: { to_review: 0, needs_approval: 0 } } }),
    "GET /api/cash-flow": () => ({ status: 200, body: cashFlow() }),
    "GET /api/cash-flow/why": () => ({ status: 200, body: whyCash() }),
    "GET /api/business-health": () => ({ status: 200, body: businessHealth() }),
  });
  vi.stubGlobal("fetch", api.fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
  return { ...api, ...renderApp(path) };
}

describe("Live updates", () => {
  // Regression: a bank or accounting sync only refreshed the connections screen, so cash flow and
  // business health kept showing the numbers from before the sync until the page was reloaded
  it("refreshes the forecast after a sync", async () => {
    const { calls } = setup("/cash-flow");
    await screen.findByText("Lowest point in the next 90 days");
    const before = calls.filter((c) => c.path === "/api/cash-flow").length;
    act(() => FakeEventSource.last!.push("connection"));
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/cash-flow").length).toBeGreaterThan(before));
  });

  it("refreshes business health after a sync, a match or an approval", async () => {
    const { calls } = setup("/health");
    await screen.findByText("Health checks");
    for (const event of ["connection", "matches", "action"]) {
      const before = calls.filter((c) => c.path === "/api/business-health").length;
      act(() => FakeEventSource.last!.push(event));
      await waitFor(() => expect(calls.filter((c) => c.path === "/api/business-health").length).toBeGreaterThan(before));
    }
  });
});
