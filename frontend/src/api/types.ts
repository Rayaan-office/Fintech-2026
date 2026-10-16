/*
 * Shapes the app expects from the API. Money is always integer minor units (pence) with
 * a `_minor` suffix; dates are ISO 8601 strings.
 */

export type ApprovalLevel = 0 | 1 | 2 | 3 | 4;
export type Severity = "info" | "attention" | "urgent";

// Auth

export type Role = "owner" | "finance_manager" | "bookkeeper" | "employee";

export type Permission =
  | "view_all"
  | "view_own_submissions"
  | "submit_receipt"
  | "review_documents"
  | "approve_match"
  | "record_bill"
  | "reconcile"
  | "prepare_payment"
  | "send_reminder"
  | "approve_payment"
  | "approve_high_risk"
  | "connect_tools"
  | "use_financing"
  | "share_lender_pack"
  | "edit_profile"
  | "manage_users"
  | "set_limits"
  | "pause_ai"
  | "use_assistant"
  | "view_activity";

export type Me = {
  user: { id: string; name: string; email: string; roles: Role[] };
  business: { id: string; name: string; currency: string; country: string; ai_paused: boolean };
  permissions: Permission[];
  approval_limit_minor: number | null;
  levels: Record<string, string>;
  unread_notifications: number;
};

export type LoginResult = { totp_required: boolean; totp_setup_required: boolean };
export type TotpSetup = { otpauth_uri: string; secret: string };

// Shared pieces

export type RecordRef = { id: string; kind: string; label: string; href?: string };

export type Approval = { user_id?: string; name: string; at: string };

export type ActionStatus = "pending" | "executed" | "rejected" | "cancelled" | "failed" | "undone";

/** A change waiting for (or past) its approvals, exactly as the server describes it. */
export type Action = {
  id: string;
  type: string;
  type_label: string;
  level: ApprovalLevel;
  level_label: string;
  status: ActionStatus;
  summary: string;
  effects: string[];
  reasons: string[];
  amount_minor: number | null;
  /** "suggested by AI" or "prepared by <name>". */
  requested_by: string;
  approvals: { name: string; decision: string; at: string }[];
  required_approvals: number;
  /** Who must approve, in plain words. */
  approvers: string;
  can_approve: boolean;
  /** Why this person can't approve, when they can't. */
  why_not: string | null;
  can_undo: boolean;
  document_id: string | null;
  result: Record<string, unknown> | null;
  created_at: string;
  decided_at: string | null;
};

/** Everything a confirmation card needs: the server's pending action. */
export type Confirmation = Action;

export type AiAnswer = { text: string; redacted_input: string };

export type ForecastPoint = { date: string; expected_minor: number; best_minor: number; worst_minor: number };

// Home

export type TodayItem = { id: string; sentence: string; action_label: string; href: string; level: ApprovalLevel; severity: Severity };

export type HomeSummary = {
  today: TodayItem[];
  cash: { balance_minor: number; as_of: string; forecast: ForecastPoint[] };
  bills_due: { count: number; total_minor: number; next_due_date: string | null };
  who_owes_you: { count: number; total_minor: number; overdue_minor: number };
  recommendations: { count: number; at_stake_minor: number };
};

// Inbox

export type InboxTab = "to_review" | "needs_approval" | "done";

/** A document the pipeline couldn't finish on its own. */
export type InboxDocument = {
  kind: "document";
  id: string;
  summary: string;
  reasons: string[];
  warnings: DocumentWarning[];
  created_at: string;
  level: ApprovalLevel;
  level_label: string;
};

export type InboxItem = InboxDocument | (Action & { kind?: undefined });

export type Inbox = { items: InboxItem[]; counts: { to_review: number; needs_approval: number } };

// Cash flow

export type ForecastBill = { id: string; date: string; label: string; amount_minor: number; movable: boolean };
export type CashWarning = { id: string; severity: Severity; sentence: string; why: string };

export type CashFlow = {
  lowest: { balance_minor: number; date: string };
  safety_level_minor: number;
  balance_minor: number;
  series: ForecastPoint[];
  bills: ForecastBill[];
  warnings: CashWarning[];
};

// Business health

export type HealthCheck = { id: string; severity: Severity; sentence: string; why: string };

export type BusinessHealth = {
  period_label: string;
  profit_minor: number;
  margin_pct: number;
  days_to_get_paid: number;
  runway_months: number | null;
  profit_and_loss: { month: string; sales_minor: number; costs_minor: number; profit_minor: number }[];
  spending: { category: string; amount_minor: number }[];
  who_owes_you: { bucket: string; amount_minor: number }[];
  checks: HealthCheck[];
};

// Recommendations

export type RecommendationType =
  | "supplier_details_changed"
  | "bank_details_changed"
  | "price_rise"
  | "slow_payer"
  | "spending_creep"
  | "customer_concentration";

export type Recommendation = {
  id: string;
  type: RecommendationType;
  title: string;
  summary: AiAnswer;
  at_stake_minor: number | null;
  counterparty: string | null;
  created_at: string;
  why: string;
  evidence: { label: string; before: string; after: string; record?: RecordRef }[];
  next_step: { label: string; confirmation: Confirmation } | null;
};

// Financing

export type FinancingOption = {
  id: string;
  provider: string;
  product: string;
  free: boolean;
  min_minor: number;
  max_minor: number;
  min_months: number;
  max_months: number;
  eligible: boolean;
  eligibility_note: string | null;
};

export type FinancingQuote = {
  total_cost_minor: number;
  monthly_repayment_minor: number;
  /** Plain-words effect on the forecast, e.g. "Cash stays above your safety level until March." */
  forecast_effect: string;
};

export type Financing = {
  gap: { amount_minor: number; days: number; starts_on: string } | null;
  options: FinancingOption[];
  readiness: { id: string; label: string; ok: boolean; tip: string | null }[];
  lender_pack: { available: boolean; confirmation: Confirmation | null };
};

// Documents

export type DocumentStatus = "received" | "queued" | "processing" | "review" | "awaiting_approval" | "approved" | "rejected";

export type DocumentWarning = { kind: string; label: string; detail?: string };

export type DocumentSummary = {
  id: string;
  filename: string;
  source: "email" | "upload" | "photo" | "statement";
  status: DocumentStatus;
  stage: string;
  stage_label: string;
  doc_type: string | null;
  counterparty: string | null;
  total_minor: number | null;
  currency: string;
  due_date: string | null;
  warnings: DocumentWarning[];
  created_at: string;
};

/** One processing step; a step can appear twice (started, then finished with a note). */
export type TimelineStep = { stage: string; label: string; at: string; ok: boolean; note?: string | null };

/** Where an extracted value sits on the original, as fractions of the page: [x0, y0, x1, y1]. */
export type Highlight = { field: string; page: number; box: [number, number, number, number] };

export type DocumentDetail = DocumentSummary & {
  /** The accepted form: plain strings, plus line items. */
  fields: Record<string, unknown>;
  timeline: TimelineStep[];
  review_reasons: string[];
  warnings: DocumentWarning[];
  /** Page count, once the text has been read. */
  pages: number | null;
  mime: string;
  sha256: string;
  sender_domain: string | null;
  sender_checks: Record<string, string>;
  /** Exactly what was sent to the AI, with personal details replaced by placeholders. */
  ai_saw: string | null;
  highlights: Highlight[];
  attempts: { attempt: number; role: string; model: string; passed: boolean; problems: string[]; provider: string | null }[];
  actions: Action[];
  record_id: string | null;
};

// Activity

export type ActivityEntry = {
  seq: number;
  at: string;
  /** "user:<id>", "ai:<step>", "system", "scheduler" or "webhooks". */
  actor: string;
  event: string;
  subject: string | null;
  details: Record<string, unknown> | null;
  /** Start of this entry's fingerprint. */
  hash: string;
};
export type Activity = { items: ActivityEntry[]; total: number };
export type ActivityCheck = { intact: boolean; entries: number; broken_at: number | null };

// Connections

export type ConnectionKind = "email" | "payments" | "bank" | "accounting";
export type ConnectionProvider = "mailpit" | "stripe" | "plaid" | "quickbooks";
export type Connection = {
  kind: ConnectionKind;
  provider: ConnectionProvider;
  provider_label: string;
  title: string;
  what: string;
  required: boolean;
  status: "connected" | "disconnected" | "expired" | "error";
  last_sync_at: string | null;
  /** Why the last sync failed, written for the person. */
  error: string | null;
  counts: Record<string, number> | null;
  /** The bills inbox address, for the email card. */
  address: string | null;
};
export type ConnectedAccount = { id: string; source: string; name: string; mask: string | null; currency: string; balance_minor: number; as_of: string };
export type Connections = { items: Connection[]; accounts: ConnectedAccount[] };
export type SyncResult = { ok: true; counts: Record<string, number>; matched: Record<string, number> };

// Ask

export type AskReply = {
  id: string;
  answer: AiAnswer;
  sources: RecordRef[];
  follow_ups: string[];
  confirmation: Confirmation | null;
};

// Phone handoff

export type Handoff = { url: string; expires_at: string };

// Notifications and search

export type Notification = { id: string; kind: string; title: string; link: string | null; created_at: string; read: boolean };
export type SearchResult = { id: string; kind: string; label: string; href: string };

// Settings

export type TeamMember = { id: string; name: string; email: string; roles: Role[]; approval_limit_minor: number | null; second_approver: boolean };
