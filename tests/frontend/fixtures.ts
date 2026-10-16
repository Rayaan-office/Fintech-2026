import type { Action, DocumentDetail, DocumentSummary, Me } from "@/api/types";

/* Shapes copied from what the API returns (backend/app/api), so the screens are tested against the real contract. */

const levels = { "0": "Read", "1": "Suggest", "2": "Small change", "3": "Outside action", "4": "Two people" };

export const owner: Me = {
  user: { id: "u-owner", name: "Maya Patel", email: "owner@example.test", roles: ["owner"] },
  business: { id: "b1", name: "Demo Bakery", currency: "GBP", country: "GB", ai_paused: false },
  permissions: [
    "approve_high_risk", "approve_match", "approve_payment", "connect_tools", "edit_profile", "manage_users", "pause_ai",
    "prepare_payment", "reconcile", "record_bill", "review_documents", "send_reminder", "set_limits", "share_lender_pack",
    "submit_receipt", "use_assistant", "use_financing", "view_activity", "view_all", "view_own_submissions",
  ],
  approval_limit_minor: null,
  levels,
  unread_notifications: 0,
};

export const bookkeeper: Me = {
  ...owner,
  user: { id: "u-books", name: "Sam Taylor", email: "books@example.test", roles: ["bookkeeper"] },
  permissions: [
    "approve_match", "prepare_payment", "reconcile", "record_bill", "review_documents", "send_reminder", "submit_receipt",
    "use_assistant", "view_activity", "view_all", "view_own_submissions",
  ],
};

export const employee: Me = {
  ...owner,
  user: { id: "u-emp", name: "Alex Kim", email: "alex@example.test", roles: ["employee"] },
  permissions: ["submit_receipt", "view_own_submissions"],
};

const now = new Date().toISOString();

export function action(over: Partial<Action> = {}): Action {
  return {
    id: "a1",
    type: "approve_document",
    type_label: "Approve an extracted document",
    level: 2,
    level_label: "Small change",
    status: "pending",
    summary: "Record bill: £658.56 from Acme Supplies",
    effects: ["Add a bill to the ledger"],
    reasons: [],
    amount_minor: 65856,
    requested_by: "suggested by AI",
    approvals: [],
    required_approvals: 1,
    approvers: "One person (or automatic when small and confident)",
    can_approve: true,
    why_not: null,
    can_undo: false,
    document_id: null,
    result: null,
    created_at: now,
    decided_at: null,
    ...over,
  };
}

export function docSummary(over: Partial<DocumentSummary> = {}): DocumentSummary {
  return {
    id: "d1",
    filename: "acme-AS-1005.pdf",
    source: "email",
    status: "review",
    stage: "second_opinion",
    stage_label: "Second opinion",
    doc_type: "bill",
    counterparty: "Acme Supplies",
    total_minor: 65856,
    currency: "GBP",
    due_date: "2026-11-01",
    warnings: [],
    created_at: now,
    ...over,
  };
}

export function docDetail(over: Partial<DocumentDetail> = {}): DocumentDetail {
  return {
    ...docSummary(),
    fields: {
      doc_type: "bill", counterparty_name: "Acme Supplies", issue_date: "2026-10-02", due_date: "2026-11-01", currency: "GBP",
      reference: "AS-1005", subtotal: "548.80", tax: "109.76", total: "658.56", category_hint: "stock", line_items: [],
    },
    timeline: [
      { stage: "received", label: "Received", at: now, ok: true },
      { stage: "safety_check", label: "Safety check", at: now, ok: true, note: "pdf, 20480 bytes" },
      { stage: "archived", label: "Locked archive", at: now, ok: true },
      { stage: "reading", label: "Reading the text", at: now, ok: true, note: "1 page(s), text layer" },
      { stage: "hiding_details", label: "Hiding personal details", at: now, ok: true },
      { stage: "privacy_check", label: "Final privacy check", at: now, ok: true },
      { stage: "ai_form", label: "AI fills in the form", at: now, ok: true },
      { stage: "checks", label: "Do the numbers add up?", at: now, ok: true },
      { stage: "second_opinion", label: "Second opinion", at: now, ok: false, note: "Two independent readings disagree on: due date." },
    ],
    review_reasons: ["Two independent readings disagree on: due date."],
    warnings: [],
    pages: 1,
    mime: "application/pdf",
    sha256: "ab".repeat(32),
    sender_domain: "acme-supplies.example",
    sender_checks: { spf: "pass", dkim: "pass", dmarc: "pass" },
    ai_saw: "Invoice AS-1005 from Acme Supplies. Pay to [BANK_ACCOUNT_1] sort code [SORT_CODE_1]. Total £658.56",
    highlights: [{ field: "total", page: 0, box: [0.7, 0.8, 0.85, 0.83] }],
    attempts: [
      { attempt: 1, role: "primary", model: "model-a", passed: true, problems: [], provider: "p1" },
      { attempt: 2, role: "second_opinion", model: "model-b", passed: false, problems: ["Due date differs."], provider: "p2" },
    ],
    actions: [],
    record_id: null,
    ...over,
  };
}
