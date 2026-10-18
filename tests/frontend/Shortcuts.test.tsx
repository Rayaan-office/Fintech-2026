import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { owner } from "./fixtures";
import { mockApi, renderApp } from "./utils";

function setup() {
  const api = mockApi({
    "GET /api/auth/me": () => ({ status: 200, body: owner }),
    "GET /api/inbox": () => ({ status: 200, body: { items: [], counts: { to_review: 0, needs_approval: 0 } } }),
  });
  vi.stubGlobal("fetch", api.fetchMock);
  return renderApp("/activity");
}

describe("Keyboard shortcuts", () => {
  // Bug, found by the browser journeys: "?" is typed with Shift, and the shortcut only listened for "?"
  // without Shift, so it never opened
  it("opens on ? typed with Shift, and lists the inbox keys", async () => {
    setup();
    await screen.findByRole("button", { name: "Search everything" });
    fireEvent.keyDown(document.body, { key: "?", code: "Slash", shiftKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    for (const label of ["Search everything", "Next item", "Previous item", "Approve", "Select for bulk approval"]) {
      expect(within(dialog).getByText(label)).toBeInTheDocument();
    }
  });

  it("does not open while typing in a box", async () => {
    setup();
    await screen.findByRole("button", { name: "Search everything" });
    const box = document.createElement("input");
    document.body.appendChild(box);
    box.focus();
    await userEvent.keyboard("?");
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
    box.remove();
  });
});
