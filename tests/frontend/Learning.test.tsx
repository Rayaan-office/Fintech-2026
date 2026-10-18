import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DocumentWithLearning, LearningSummary, Me, RankedRecommendation } from "@/api/types";
import { timeSaved } from "@/pages/LearningPage";
import { bankDetailsRec, bookkeeper, docDetail, docSummary, owner, recommendation } from "./fixtures";
import { mockApi, renderApp } from "./utils";

// Learning from decisions (backend/app/api/learning.py and copilot/learning.py)

function summary(over: Partial<LearningSummary> = {}): LearningSummary {
  return {
    suppliers: [
      {
        counterparty_id: "c1",
        name: "Acme Supplies",
        kind: "supplier",
        items: [
          { field: "category_hint", label: "What it's for", value: "packaging", value_label: "packaging", corrections: 2, sentence: "We fill in what it's for as “packaging”: you corrected it on 2 documents." },
          { field: "payment_terms", label: "Payment terms", value: 30, value_label: "30 days", corrections: 3, sentence: "We fill in payment terms as “30 days”: you corrected it on 3 documents." },
        ],
      },
    ],
    recommendations: [
      { kind: "price_rise", label: "Price rise", acted_on: 4, turned_down: 1, decisions: 5, acted_share: 0.8, less_useful: false, sentence: "You acted on 4 of 5. We show them higher." },
      { kind: "spending_creep", label: "Spending creep", acted_on: 0, turned_down: 6, decisions: 6, acted_share: 0, less_useful: true, sentence: "You acted on 0 of 6. We show minor ones folded under “Less useful to you”." },
    ],
    numbers: {
      fields_filled: 9, fields_kept: 8, fields_undone: 1, documents_helped: 6, seconds_per_field: 30, minutes_saved: 4,
      decisions: 11, acted_on: 4, acted_share: 0.36, top_decisions: 5, top_acted_on: 3, top_acted_share: 0.6,
    },
    rules: { learn_after: 2, fold_after: 5, fold_below: 0.2 },
    assumptions: ["We count about 30 seconds for each value a person would otherwise find on the document and type in."],
    never_learned: ["bank details", "contact details", "amounts"],
    can_reset: true,
    ...over,
  };
}

const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body ?? "null"));

function setupPage({ me = owner, data = summary() }: { me?: Me; data?: LearningSummary } = {}) {
  let current = data;
  const api = mockApi({
    "GET /api/auth/me": () => ({ status: 200, body: me }),
    "GET /api/inbox": () => ({ status: 200, body: { items: [], counts: { to_review: 0, needs_approval: 0 } } }),
    "GET /api/learning": () => ({ status: 200, body: current }),
    "POST /api/learning/reset": (init) => {
      const what = bodyOf(init) as { scope: string; field?: string };
      current = what.scope === "field" ? { ...current, suppliers: [{ ...current.suppliers[0]!, items: current.suppliers[0]!.items.filter((i) => i.field !== what.field) }] } : summary({ suppliers: [], recommendations: [] });
      return { status: 200, body: current };
    },
  });
  vi.stubGlobal("fetch", api.fetchMock);
  return { ...api, ...renderApp("/learning") };
}

describe("What we've learned", () => {
  it("leads with the time saved and states the assumption behind it", async () => {
    setupPage();
    expect(await screen.findByRole("heading", { name: "What we've learned" })).toBeInTheDocument();
    expect(screen.getByText("4 min")).toBeInTheDocument();
    // The assumption is one click away, not a paragraph on the page
    expect(screen.queryByText(/We count about 30 seconds/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "How we count time saved" }));
    expect(await screen.findByText(/8 values filled in from your past corrections and kept\. We count about 30 seconds/)).toBeInTheDocument();
    expect(screen.getByText(/We never learn bank details, contact details, amounts/)).toBeInTheDocument();
    expect(screen.getByText("60%")).toBeInTheDocument();
    expect(screen.getByText("3 of 5 times it was first in the list")).toBeInTheDocument();
  });

  it("explains each learned value per supplier, and each kind of recommendation", async () => {
    setupPage();
    const acme = await screen.findByRole("listitem", { name: "Acme Supplies" });
    expect(acme).toHaveTextContent("We fill in what it's for as “packaging”: you corrected it on 2 documents.");
    expect(acme).toHaveTextContent("30 days");
    const creep = screen.getByRole("listitem", { name: "Spending creep" });
    expect(creep).toHaveTextContent("Less useful to you");
    expect(within(creep).getByRole("img", { name: "Acted on 0%" })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "Price rise" })).not.toHaveTextContent("Less useful to you");
  });

  it("lets the owner forget one learned value", async () => {
    const { calls } = setupPage();
    const acme = await screen.findByRole("listitem", { name: "Acme Supplies" });
    await userEvent.click(within(acme).getByRole("button", { name: "Forget What it's for" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/learning/reset")).toBe(true));
    expect(bodyOf(calls.find((c) => c.path === "/api/learning/reset")!.init)).toEqual({ scope: "field", counterparty_id: "c1", field: "category_hint" });
    await waitFor(() => expect(screen.getByRole("listitem", { name: "Acme Supplies" })).not.toHaveTextContent("packaging"));
  });

  it("asks before forgetting everything", async () => {
    const { calls } = setupPage();
    await userEvent.click(await screen.findByRole("button", { name: "Reset everything" }));
    const dialog = await screen.findByRole("dialog", { name: "Forget everything we've learned?" });
    expect(calls.some((c) => c.path === "/api/learning/reset")).toBe(false);
    await userEvent.click(within(dialog).getByRole("button", { name: /Forget it/ }));
    await waitFor(() => expect(bodyOf(calls.find((c) => c.path === "/api/learning/reset")!.init)).toEqual({ scope: "all" }));
    expect(await screen.findByText("No corrections learned yet")).toBeInTheDocument();
  });

  it("shows no reset buttons to people who aren't the owner", async () => {
    setupPage({ me: bookkeeper, data: summary({ can_reset: false }) });
    await screen.findByRole("listitem", { name: "Acme Supplies" });
    expect(screen.queryByRole("button", { name: /Forget|Reset/ })).not.toBeInTheDocument();
  });

  it("is in the navigation", async () => {
    setupPage();
    expect(await screen.findByRole("link", { name: /What we've learned/ })).toHaveAttribute("href", "/learning");
  });

  it("writes short times in seconds", () => {
    expect(timeSaved(0.5)).toBe("30 sec");
    expect(timeSaved(12.5)).toBe("12.5 min");
  });
});

describe("Filled from your past corrections", () => {
  function setupDoc(detail: DocumentWithLearning) {
    let current = detail;
    const api = mockApi({
      "GET /api/auth/me": () => ({ status: 200, body: bookkeeper }),
      "GET /api/inbox": () => ({ status: 200, body: { items: [], counts: { to_review: 0, needs_approval: 0 } } }),
      "GET /api/documents": () => ({ status: 200, body: { items: [docSummary({ status: current.status })] } }),
      "GET /api/documents/d1": () => ({ status: 200, body: current }),
      "POST /api/documents/d1/fields": (init) => {
        const { fields } = bodyOf(init) as { fields: Record<string, string> };
        current = { ...current, fields: { ...current.fields, ...fields }, learned: { category_hint: { ...current.learned!.category_hint!, undone: true } } };
        return { status: 200, body: current };
      },
    });
    vi.stubGlobal("fetch", api.fetchMock);
    return { ...api, ...renderApp("/documents?open=d1") };
  }

  const learnedDoc = (): DocumentWithLearning => ({
    ...docDetail({ status: "awaiting_approval", review_reasons: [] }),
    fields: { ...docDetail().fields, category_hint: "packaging" },
    learned: { category_hint: { value: "packaging", ai_value: "stock", corrections: 2, learned_as: "category_hint", undone: false } },
  });

  it("marks a learned value and puts back what the AI read on Undo", async () => {
    const { calls } = setupDoc(learnedDoc());
    const chip = await screen.findByText("Filled from your past corrections");
    expect(chip).toHaveAttribute("title", "You corrected this on 2 approved documents from this supplier. The AI read “stock”.");
    await userEvent.click(screen.getByRole("button", { name: "Undo “What for”: put back what the AI read" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/documents/d1/fields")).toBe(true));
    expect(bodyOf(calls.find((c) => c.path === "/api/documents/d1/fields")!.init)).toEqual({ fields: { category_hint: "stock" } });
    await waitFor(() => expect(screen.queryByText("Filled from your past corrections")).not.toBeInTheDocument());
  });

  it("shows the chip without Undo once the document is decided", async () => {
    setupDoc({ ...learnedDoc(), status: "approved" });
    expect(await screen.findByText("Filled from your past corrections")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Undo/ })).not.toBeInTheDocument();
  });
});

describe("Less useful to you", () => {
  function setupRecs(items: RankedRecommendation[]) {
    const api = mockApi({
      "GET /api/auth/me": () => ({ status: 200, body: owner }),
      "GET /api/inbox": () => ({ status: 200, body: { items: [], counts: { to_review: 0, needs_approval: 0 } } }),
      "GET /api/recommendations": () => ({ status: 200, body: { items } }),
      "POST /api/recommendations/r5/followed": () => ({ status: 200, body: { ok: true } }),
    });
    vi.stubGlobal("fetch", api.fetchMock);
    return { ...api, ...renderApp("/recommendations") };
  }

  const creep = recommendation({
    id: "r5", type: "spending_creep", title: "Software costs crept up", severity: "info",
    next_step: { label: "Review this cost", kind: null, href: "/health", can_draft: false, action: null, related_action_ids: [] },
    less_useful: true,
  } as Partial<RankedRecommendation>);

  it("folds rarely useful kinds at the end, never hidden, and keeps urgent ones on top", async () => {
    setupRecs([{ ...bankDetailsRec, less_useful: false }, { ...recommendation(), less_useful: false }, creep]);
    expect(await screen.findByRole("listitem", { name: "Northern Packaging's bank details changed" })).toBeInTheDocument();
    expect(screen.queryByRole("listitem", { name: "Software costs crept up" })).not.toBeInTheDocument();
    const fold = screen.getByRole("button", { name: /Less useful to you \(1\)/ });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(fold);
    expect(await screen.findByRole("listitem", { name: "Software costs crept up" })).toBeInTheDocument();
  });

  it("opens the fold for a link to a folded recommendation", async () => {
    const api = mockApi({
      "GET /api/auth/me": () => ({ status: 200, body: owner }),
      "GET /api/inbox": () => ({ status: 200, body: { items: [], counts: { to_review: 0, needs_approval: 0 } } }),
      "GET /api/recommendations": () => ({ status: 200, body: { items: [{ ...recommendation(), less_useful: false }, creep] } }),
    });
    vi.stubGlobal("fetch", api.fetchMock);
    renderApp("/recommendations?open=r5");
    expect(await screen.findByRole("dialog", { name: "Software costs crept up" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Less useful to you \(1\)/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("listitem", { name: "Software costs crept up" })).toBeInTheDocument();
  });

  it("counts opening the suggested page as acting on it", async () => {
    const { calls } = setupRecs([{ ...creep, less_useful: false }]);
    const card = await screen.findByRole("listitem", { name: "Software costs crept up" });
    await userEvent.click(within(card).getByRole("link", { name: "Review this cost" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/recommendations/r5/followed")).toBe(true));
  });

  it("shows no fold when nothing is folded", async () => {
    setupRecs([recommendation()]);
    await screen.findByRole("listitem", { name: "Acme Supplies is charging 18% more" });
    expect(screen.queryByRole("button", { name: /Less useful to you/ })).not.toBeInTheDocument();
  });
});
