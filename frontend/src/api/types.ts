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

export type Approval = { user_id: string; name: string; at: string };

/** Everything a confirmation card needs; produced by the server for each pending action. */
export type Confirmation = {
  action_id: string;
  action_type: string;
  title: string;
  level: ApprovalLevel;
  effects: string[];
  records: RecordRef[];
  who_must_approve: string;
  approvals_required: number;
  approvals: Approval[];
  approve_permission: string;
  amount_minor?: number | null;
};

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

export type InboxItem = {
  id: string;
  tab: InboxTab;
  sentence: string;
  level: ApprovalLevel;
  why: string;
  created_at: string;
  counterparty: string | null;
  document_id: string | null;
  confirmation: Confirmation | null;
};

export type Inbox = { items: InboxItem[]; counts: Record<InboxTab, number> };

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

export type DocumentStatus = "processing" | "needs_review" | "done" | "failed";
export type DocumentStep = { key: string; label: string; state: "pending" | "active" | "done" | "retry" | "failed" };

export type DocumentSummary = {
  id: string;
  filename: string;
  kind: "bill" | "invoice" | "receipt" | "statement" | "other";
  source: string;
  received_at: string;
  status: DocumentStatus;
  counterparty: string | null;
  total_minor: number | null;
  steps: DocumentStep[];
};

export type ExtractedField = {
  key: string;
  label: string;
  value: string;
  confidence: number;
  /** Where the value was found on the page, as fractions of the page size. */
  box: { page: number; x: number; y: number; w: number; h: number } | null;
};

export type DocumentDetail = DocumentSummary & {
  mime_type: string;
  /** Download link for the untouched original. */
  original_url: string;
  /** Each page rendered as an image, so values can be highlighted where they were found. */
  pages: { url: string; width: number; height: number }[];
  fields: ExtractedField[];
  confirmation: Confirmation | null;
};

// Activity

export type ActivityEntry = { id: string; at: string; actor: string; action: string; summary: string; level: ApprovalLevel | null };
export type Activity = { entries: ActivityEntry[]; chain_ok: boolean };

// Connections

export type ConnectionKind = "email" | "payments" | "bank" | "accounting";
export type Connection = {
  id: string;
  kind: ConnectionKind;
  name: string;
  status: "ok" | "attention" | "error" | "not_connected";
  last_synced_at: string | null;
  message: string | null;
};

// Ask

export type AskReply = {
  id: string;
  answer: AiAnswer;
  sources: RecordRef[];
  follow_ups: string[];
  confirmation: Confirmation | null;
};

// Receipts and phone handoff

export type Receipt = { id: string; filename: string; submitted_at: string; status: DocumentStatus; total_minor: number | null; merchant: string | null };
export type Handoff = { url: string; expires_at: string };

// Notifications and search

export type Notification = { id: string; kind: string; title: string; link: string | null; created_at: string; read: boolean };
export type SearchResult = { id: string; kind: string; label: string; href: string };

// Settings

export type TeamMember = { id: string; name: string; email: string; roles: Role[]; approval_limit_minor: number | null; second_approver: boolean };
