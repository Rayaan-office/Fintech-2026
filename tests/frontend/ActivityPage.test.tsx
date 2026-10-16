import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityCheck, ActivityEntry } from "@/api/types";
import { describeEntry } from "@/pages/ActivityPage";
import { owner } from "./fixtures";
import { mockApi, renderApp } from "./utils";

const at = new Date().toISOString();
const entry = (seq: number, actor: string, event: string, extra: Partial<ActivityEntry> = {}): ActivityEntry => ({
  seq, at, actor, event, subject: null, details: null, hash: `h${seq}`.padEnd(12, "0"), ...extra,
});

const ENTRIES = [
  entry(5, "user:u-owner", "approval_approve", { subject: "action:a1", details: { type: "approve_document", level: 2 } }),
  entry(4, "ai:ingestion", "ai_form_filled", { subject: "document:d1" }),
  entry(3, "system", "connection_synced", { subject: "plaid" }),
  entry(2, "user:u-other", "fields_corrected", { details: { fields: ["due_date", "total"] } }),
  entry(1, "system", "document_received", { details: { source: "email" } }),
];

function setup(check: ActivityCheck = { intact: true, entries: 5, broken_at: null }) {
  const api = mockApi({
    "GET /api/auth/me": () => ({ status: 200, body: owner }),
    "GET /api/inbox": () => ({ status: 200, body: { items: [], counts: { to_review: 0, needs_approval: 0 } } }),
    "GET /api/activity": (_init, url) => {
      const actor = url.searchParams.get("actor");
      return { status: 200, body: { items: actor ? ENTRIES.filter((e) => e.actor.startsWith(actor)) : ENTRIES, total: ENTRIES.length } };
    },
    "GET /api/activity/verify": () => ({ status: 200, body: check }),
  });
  vi.stubGlobal("fetch", api.fetchMock);
  return { ...api, ...renderApp("/activity") };
}

describe("Activity", () => {
  // The timeline only draws rows that fit its box; jsdom has no layout, so give it one
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  });

  it("shows every step in plain words, newest first, with who did it", async () => {
    setup();
    const log = await screen.findByRole("list", { name: "Activity log" });
    const rows = within(log).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Approved: record a checked document");
    expect(rows[0]).toHaveTextContent("You");
    expect(within(rows[0]!).getByLabelText("Approval level 2: Small change")).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent("The AI filled in the form");
    expect(rows[2]).toHaveTextContent("Bank account brought up to date");
    expect(rows[3]).toHaveTextContent("Corrected due date, total");
    expect(rows[3]).toHaveTextContent("A team member");
    expect(rows[4]).toHaveTextContent("Document received by email");
  });

  it("shows Log intact when every fingerprint checks out", async () => {
    setup();
    expect(await screen.findByText("Log intact")).toBeInTheDocument();
  });

  it("says where the log check failed", async () => {
    setup({ intact: false, entries: 3, broken_at: 3 });
    expect(await screen.findByText("Log check failed at entry 3")).toBeInTheDocument();
  });

  it("filters by who acted (on the server) and by topic and words (on screen)", async () => {
    const { calls } = setup();
    await screen.findByRole("list", { name: "Activity log" });

    await userEvent.click(screen.getByRole("tab", { name: "People" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/activity" && c.url.searchParams.get("actor") === "user:")).toBe(true));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Activity log" })).getAllByRole("listitem")).toHaveLength(2));

    await userEvent.click(screen.getByRole("tab", { name: "System" }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Activity log" })).getAllByRole("listitem")).toHaveLength(2));

    await userEvent.click(screen.getByRole("tab", { name: "All" }));
    await userEvent.selectOptions(await screen.findByLabelText("Show"), "connections");
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Activity log" })).getAllByRole("listitem")).toHaveLength(1));

    await userEvent.selectOptions(screen.getByLabelText("Show"), "all");
    await userEvent.type(screen.getByLabelText("Filter activity"), "corrected");
    expect(within(screen.getByRole("list", { name: "Activity log" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("offers the whole log as a CSV download", async () => {
    setup();
    expect(await screen.findByRole("link", { name: "Download CSV" })).toHaveAttribute("href", "/api/activity/export.csv");
  });

  it("falls back to readable words for events it doesn't know", () => {
    expect(describeEntry(entry(9, "system", "something_new_happened"))).toBe("Something new happened");
  });
});
