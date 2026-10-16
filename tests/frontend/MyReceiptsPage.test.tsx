import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { docSummary, employee } from "./fixtures";
import { mockApi, renderApp } from "./utils";

function setup() {
  const api = mockApi({
    "GET /api/auth/me": () => ({ status: 200, body: employee }),
    // The server returns only this person's own documents
    "GET /api/documents": () => ({
      status: 200,
      body: {
        items: [
          docSummary({ id: "r1", filename: "train-ticket.jpg", source: "photo", status: "approved", counterparty: "Northern Rail", total_minor: 2340, doc_type: "receipt" }),
          docSummary({ id: "r2", filename: "lunch.pdf", source: "upload", status: "processing", counterparty: null, total_minor: null, doc_type: null }),
        ],
      },
    }),
    "POST /api/documents": () => ({ status: 200, body: { id: "r3" } }),
  });
  vi.stubGlobal("fetch", api.fetchMock);
  return { ...api, ...renderApp("/") };
}

describe("My receipts", () => {
  it("lands an employee on their receipts, with each one's progress in plain words", async () => {
    const { router } = setup();
    expect(await screen.findByRole("heading", { name: "My receipts" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/my-receipts");
    const list = await screen.findByRole("list", { name: "Sent so far" });
    const [first, second] = within(list).getAllByRole("listitem");
    expect(first).toHaveTextContent("Northern Rail");
    expect(first).toHaveTextContent("£23.40");
    expect(first).toHaveTextContent("Accepted");
    expect(second).toHaveTextContent("lunch.pdf");
    expect(second).toHaveTextContent("Reading");
  });

  it("sends a receipt and confirms it arrived", async () => {
    const { calls } = setup();
    await screen.findByRole("heading", { name: "My receipts" });
    await userEvent.upload(screen.getByTestId("file-input"), new File(["img"], "taxi.jpg", { type: "image/jpeg" }));
    const post = await waitFor(() => calls.find((c) => c.method === "POST" && c.path === "/api/documents")!);
    expect(((post.init?.body as FormData).get("file") as File).name).toBe("taxi.jpg");
    expect(await screen.findByText("Receipt sent. You'll see it below once it's read.")).toBeInTheDocument();
  });
});
