import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DocumentDetail } from "@/api/types";
import { journeySteps, toMinor } from "@/components/DocumentReview";
import { action, bookkeeper, docDetail, docSummary } from "./fixtures";
import { mockApi, renderApp } from "./utils";

function setup(detail: DocumentDetail = docDetail(), path = "/documents") {
  let current = detail;
  const api = mockApi({
    "GET /api/auth/me": () => ({ status: 200, body: bookkeeper }),
    "GET /api/inbox": () => ({ status: 200, body: { items: [], counts: { to_review: 0, needs_approval: 0 } } }),
    "GET /api/documents": () => ({
      status: 200,
      body: {
        items: [
          docSummary(),
          docSummary({ id: "d2", filename: "receipt.jpg", source: "photo", status: "processing", stage: "hiding_details", counterparty: null, total_minor: null, doc_type: null }),
          docSummary({ id: "d3", filename: "brightspark.pdf", counterparty: "BrightSpark Energy", status: "approved", warnings: [{ kind: "duplicate", label: "Duplicate invoice" }] }),
        ],
      },
    }),
    "GET /api/documents/d1": () => ({ status: 200, body: current }),
    "POST /api/documents/d1/fields": (init) => {
      const { fields } = JSON.parse(String(init?.body)) as { fields: Record<string, string> };
      current = { ...current, status: "awaiting_approval", fields: { ...current.fields, ...fields } };
      return { status: 200, body: current };
    },
    "POST /api/documents/d1/reprocess": () => ({ status: 200, body: { ok: true } }),
    "POST /api/documents": () => ({ status: 200, body: { id: "d9" } }),
  });
  vi.stubGlobal("fetch", api.fetchMock);
  return { ...api, ...renderApp(path) };
}

describe("Documents", () => {
  it("lists documents with what was found, the live step and warnings", async () => {
    setup();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Acme Supplies")).toBeInTheDocument();
    expect(within(table).getByText("Needs a check")).toBeInTheDocument();
    expect(within(table).getByText("Hiding personal details")).toBeInTheDocument();
    // Warnings are one small count; their names are in its tip and read out to screen readers
    expect(within(table).getByText(/Duplicate invoice/)).toBeInTheDocument();
    // The file name stays in the row (and so in its name), but the party leads
    expect(within(table).getByRole("row", { name: /acme-AS-1005\.pdf/ })).toHaveTextContent("Acme Supplies");

    expect(screen.getByRole("radio", { name: /Reading/ })).toHaveTextContent("1");
    await userEvent.click(screen.getByRole("radio", { name: /Reading/ }));
    expect(within(table).queryByText("Acme Supplies")).not.toBeInTheDocument();
    expect(within(table).getByText("receipt.jpg")).toBeInTheDocument();
  });

  it("uploads a file as an upload, and says it's being read", async () => {
    const { calls } = setup();
    await userEvent.click(await screen.findByRole("button", { name: "Upload" }));
    const file = new File(["%PDF-1.7"], "bill.pdf", { type: "application/pdf" });
    await userEvent.upload(screen.getByTestId("file-input"), file);
    const post = await waitFor(() => calls.find((c) => c.method === "POST" && c.path === "/api/documents")!);
    const form = post.init?.body as FormData;
    expect((form.get("file") as File).name).toBe("bill.pdf");
    expect(form.get("source")).toBe("upload");
    expect(await screen.findByText("bill.pdf received. We're reading it now.")).toBeInTheDocument();
  });

  it("refuses files over the size limit before sending them", async () => {
    const { calls } = setup();
    await userEvent.click(await screen.findByRole("button", { name: "Upload" }));
    const big = new File(["x"], "scan.pdf", { type: "application/pdf" });
    Object.defineProperty(big, "size", { value: 16 * 1024 * 1024 });
    await userEvent.upload(screen.getByTestId("file-input"), big);
    expect(screen.getByRole("alert")).toHaveTextContent("scan.pdf is larger than 15 MB");
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/documents")).toBe(false);
  });
});

describe("Document review", () => {
  it("shows the original page with highlights beside what was read, and why it needs a person", async () => {
    setup(docDetail(), "/documents?open=d1");
    const original = await screen.findByRole("region", { name: "Original document" });
    const page = within(original).getByRole("img", { name: "Page 1 of acme-AS-1005.pdf" });
    expect(page).toHaveAttribute("src", "/api/documents/d1/pages/0");
    expect(original.querySelector('[data-field="total"]')).not.toBeNull();
    expect(within(original).getByRole("link", { name: "Open the original" })).toHaveAttribute("href", "/api/documents/d1/original");

    const found = screen.getByRole("region", { name: "What we found" });
    expect(within(found).getByText("AS-1005")).toBeInTheDocument();
    expect(within(found).getByText("SPF passed")).toBeInTheDocument();
    const why = screen.getByRole("region", { name: "Why this needs a person" });
    expect(within(why).getByText("Two independent readings disagree on: due date.")).toBeInTheDocument();
  });

  it("falls back to a link when page pictures aren't available", async () => {
    setup(docDetail(), "/documents?open=d1");
    const page = await screen.findByRole("img", { name: "Page 1 of acme-AS-1005.pdf" });
    fireEvent.error(page);
    expect(await screen.findByText("A picture of each page isn't available yet. Open the original to see it.")).toBeInTheDocument();
  });

  it("shows a photo as it is", async () => {
    setup(docDetail({ mime: "image/jpeg" }), "/documents?open=d1");
    expect(await screen.findByRole("img", { name: "Page 1 of acme-AS-1005.pdf" })).toHaveAttribute("src", "/api/documents/d1/original");
  });

  it("shows the live processing journey", async () => {
    setup(docDetail(), "/documents?open=d1");
    const steps = await screen.findByRole("list", { name: "Processing steps" });
    expect(within(steps).getByText("Second opinion")).toBeInTheDocument();
    expect(within(steps).getByText("stopped here")).toBeInTheDocument();
  });

  it("shows exactly what the AI saw, with personal details as placeholders", async () => {
    setup(docDetail(), "/documents?open=d1");
    await userEvent.click(await screen.findByRole("button", { name: "What the AI saw" }));
    const saw = screen.getByTestId("ai-saw");
    expect(within(saw).getByText("[BANK_ACCOUNT_1]")).toHaveAttribute("data-placeholder");
    expect(screen.getByText(/Second opinion: Due date differs\./)).toBeInTheDocument();
  });

  it("sends only the corrected fields, then it waits for approval", async () => {
    const { calls } = setup(docDetail(), "/documents?open=d1");
    await userEvent.click(await screen.findByRole("button", { name: "Check and correct" }));
    const form = screen.getByRole("form", { name: "Correct what we read" });
    const due = within(form).getByLabelText("Due");
    await userEvent.clear(due);
    await userEvent.type(due, "2026-11-15");
    await userEvent.click(within(form).getByRole("button", { name: "Save and send for approval" }));
    const post = await waitFor(() => calls.find((c) => c.path === "/api/documents/d1/fields")!);
    expect(JSON.parse(String(post.init?.body))).toEqual({ fields: { due_date: "2026-11-15" } });
    expect(await screen.findByText("Saved. It now waits for approval.")).toBeInTheDocument();
  });

  it("shows fraud warnings and the pending approval for the document", async () => {
    setup(
      docDetail({
        status: "awaiting_approval",
        warnings: [{ kind: "bank_details_changed", label: "Changed bank details", detail: "The bank details differ from the ones we have for Acme Supplies." }],
        actions: [action({ document_id: "d1" })],
      }),
      "/documents?open=d1",
    );
    expect(within(await screen.findByRole("alert", { name: "Warnings" })).getByText("Changed bank details")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Confirm: Record bill: £658.56 from Acme Supplies" })).toBeInTheDocument();
  });

  it("can ask for a document to be read again", async () => {
    const { calls } = setup(docDetail(), "/documents?open=d1");
    await userEvent.click(await screen.findByRole("button", { name: "Read it again" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/documents/d1/reprocess")).toBe(true));
  });
});

describe("journey and amounts", () => {
  it("lights the first missing step while reading", () => {
    const steps = journeySteps(docDetail().timeline.slice(0, 4), "processing");
    expect(steps.find((s) => s.key === "reading")?.state).toBe("done");
    expect(steps.find((s) => s.key === "hiding_details")?.state).toBe("active");
    expect(steps.find((s) => s.key === "done")?.state).toBe("pending");
    expect(steps.some((s) => s.key === "retry")).toBe(false);
  });

  it("reads amounts the way people type them", () => {
    expect(toMinor("1,234.50")).toBe(123450);
    expect(toMinor("£658.56")).toBe(65856);
    expect(toMinor("abc")).toBeNull();
  });
});
