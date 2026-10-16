"""Database tables.

Money is stored as whole pence (`*_minor` columns) so sums are exact.
Record IDs are random UUIDs, so they cannot be guessed.
Tables listed in TENANT_TABLES carry `business_id` and are protected by row-level security.
"""

import uuid
import datetime as dt
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def _id() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


def _bid() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), ForeignKey("businesses.id"), index=True)


def _created() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now())


# ── Businesses, people and sign-in ─────────────────────────────────────────


class Business(Base):
    __tablename__ = "businesses"
    id: Mapped[uuid.UUID] = _id()
    name: Mapped[str] = mapped_column(String(200))
    country: Mapped[str] = mapped_column(String(2), default="GB")
    currency: Mapped[str] = mapped_column(String(3), default="GBP")
    safety_level_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    ai_paused: Mapped[bool] = mapped_column(Boolean, default=False)
    auto_approve_limit_minor: Mapped[int] = mapped_column(BigInteger, default=50_000)
    large_payment_minor: Mapped[int] = mapped_column(BigInteger, default=500_000)
    created_at: Mapped[datetime] = _created()


class User(Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = _id()
    email: Mapped[str] = mapped_column(String(320), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    password_hash: Mapped[str] = mapped_column(String(200))
    totp_secret_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    totp_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    failed_logins: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = _created()


class Membership(Base):
    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("user_id", "business_id"),)
    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), index=True)
    business_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("businesses.id"))
    roles: Mapped[list[str]] = mapped_column(ARRAY(String(40)))
    # Payment approval limit for finance managers; owners are unlimited
    approval_limit_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # A trusted second approver may approve level-4 actions only
    second_approver: Mapped[bool] = mapped_column(Boolean, default=False)


class AuthSession(Base):
    __tablename__ = "auth_sessions"
    id: Mapped[uuid.UUID] = _id()
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), index=True)
    business_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("businesses.id"))
    totp_passed: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = _created()
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)


class ConnectionRoute(Base):
    """Maps an outside account (Stripe account, QuickBooks company, inbox address)
    to a business, so incoming notifications can be routed before a tenant is known."""

    __tablename__ = "connection_routes"
    __table_args__ = (UniqueConstraint("kind", "external_id"),)
    id: Mapped[uuid.UUID] = _id()
    kind: Mapped[str] = mapped_column(String(30))
    external_id: Mapped[str] = mapped_column(String(200))
    business_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("businesses.id"))


class LoginAttempt(Base):
    __tablename__ = "login_attempts"
    id: Mapped[uuid.UUID] = _id()
    email_hash: Mapped[str] = mapped_column(String(64), index=True)
    ip: Mapped[str] = mapped_column(String(64))
    success: Mapped[bool] = mapped_column(Boolean)
    at: Mapped[datetime] = _created()


# ── Business data (row-level security) ─────────────────────────────────────


class Connection(Base):
    __tablename__ = "connections"
    __table_args__ = (UniqueConstraint("business_id", "kind"),)
    id: Mapped[uuid.UUID] = _id()
    business_id: Mapped[uuid.UUID] = _bid()
    kind: Mapped[str] = mapped_column(String(30))  # email | payments | bank | accounting
    provider: Mapped[str] = mapped_column(String(30))  # mailpit | stripe | plaid | quickbooks
    status: Mapped[str] = mapped_column(String(20), default="disconnected")
    token_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    cursor: Mapped[str | None] = mapped_column(Text, nullable=True)
    meta: Mapped[dict] = mapped_column(JSONB, default=dict)
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = _created()


class Account(Base):
    """A place money sits: a bank account or a payment-platform balance."""

    __tablename__ = "accounts"
    __table_args__ = (UniqueConstraint("business_id", "source", "external_id"),)
    id: Mapped[uuid.UUID] = _id()
    business_id: Mapped[uuid.UUID] = _bid()
    source: Mapped[str] = mapped_column(String(30))
    external_id: Mapped[str] = mapped_column(String(200))
    name: Mapped[str] = mapped_column(String(200))
    mask: Mapped[str | None] = mapped_column(String(10), nullable=True)
    currency: Mapped[str] = mapped_column(String(3), default="GBP")
    balance_minor: Mapped[int] = mapped_column(BigInteger, default=0)
    available_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    as_of: Mapped[datetime] = _created()


class Counterparty(Base):
    """A supplier or customer."""

    __tablename__ = "counterparties"
    __table_args__ = (UniqueConstraint("business_id", "kind", "normalized_name"),)
    id: Mapped[uuid.UUID] = _id()
    business_id: Mapped[uuid.UUID] = _bid()
    kind: Mapped[str] = mapped_column(String(20))  # supplier | customer
    display_name: Mapped[str] = mapped_column(String(300))
    normalized_name: Mapped[str] = mapped_column(String(300))
    email_domain: Mapped[str | None] = mapped_column(String(253), nullable=True)
    category: Mapped[str | None] = mapped_column(String(80), nullable=True)
    external_ids: Mapped[dict] = mapped_column(JSONB, default=dict)
    payment_terms_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = _created()


class CounterpartyVersion(Base):
    """Every version of a supplier's or customer's details, so changes can be shown before and after.
    Sensitive values are stored as vault references plus a fingerprint for comparison."""

    __tablename__ = "counterparty_versions"
    id: Mapped[uuid.UUID] = _id()
    business_id: Mapped[uuid.UUID] = _bid()
    counterparty_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("counterparties.id"))
    details: Mapped[dict] = mapped_column(JSONB)  # {field: {"fp": hmac, "vault": id, "display": masked}}
    source_document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    source: Mapped[str] = mapped_column(String(30))
    seen_at: Mapped[datetime] = _created()


class Document(Base):
    __tablename__ = "documents"
    __table_args__ = (Index("ix_documents_business_sha", "business_id", "sha256"),)
    id: Mapped[uuid.UUID] = _id()
    business_id: Mapped[uuid.UUID] = _bid()
    source: Mapped[str] = mapped_column(String(20))  # email | upload | photo | statement
    status: Mapped[str] = mapped_column(String(30), default="received")
    stage: Mapped[str] = mapped_column(String(30), default="received")
    filename: Mapped[str] = mapped_column(String(300))
    mime: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(Integer)
    pages: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sha256: Mapped[str] = mapped_column(String(64))
    object_key: Mapped[str] = mapped_column(String(300))
    email_message_id: Mapped[str | None] = mapped_column(String(500), nullable=True)
    sender_domain: Mapped[str | None] = mapped_column(String(253), nullable=True)
    sender_checks: Mapped[dict] = mapped_column(JSONB, default=dict)  # spf/dkim/dmarc results
    submitted_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    doc_type: Mapped[str | None] = mapped_column(String(30), nullable=True)
    counterparty_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    record_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    review_reasons: Mapped[list] = mapped_column(JSONB, default=list)
    warnings: Mapped[list] = mapped_column(JSONB, default=list)
    # Each processing step with its time and outcome, for the live "journey" view
    timeline: Mapped[list] = mapped_column(JSONB, default=list)
    fields: Mapped[dict] = mapped_column(JSONB, default=dict)  # accepted form, placeholders restored for display
    # Encrypted OCR words with positions, used only to highlight values on the original
    layout_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Text exactly as sent to the AI (placeholders only) — the "What the AI saw" view
    redacted_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    placeholder_map: Mapped[dict] = mapped_column(JSONB, default=dict)  # placeholder -> vault id
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Extraction(Base):
    __tablename__ = "extractions"
    id: Mapped[uuid.UUID] = _id()
    business_id: Mapped[uuid.UUID] = _bid()
    document_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("documents.id"), index=True)
    attempt: Mapped[int] = mapped_column(Integer)
    role: Mapped[str] = mapped_column(String(20))  # primary | retry | second_opinion | human
    model: Mapped[str | None] = mapped_column(String(120), nullable=True)
    fields: Mapped[dict] = mapped_column(JSONB)
    checks: Mapped[dict] = mapped_column(JSONB, default=dict)
    passed: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = _created()


class Correction(Base):
    __tablename__ = "corrections"
    id: Mapped[uuid.UUID] = _id()
    business_id: Mapped[uuid.UUID] = _bid()
    document_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("documents.id"))
    field: Mapped[str] = mapped_column(String(80))
    ai_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    human_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = _created()


class Record(Base):
    """Our single record of money in and out (the ledger).

    kind: invoice (customer owes us), bill (we owe a supplier), payment_in, payment_out,
          payout (payment platform -> bank), bank_txn, fee, refund, credit_note.
    """

    __tablename__ = "records"
    __table_args__ = (
        UniqueConstraint("business_id", "source", "source_ref"),
        Index("ix_records_business_kind_date", "business_id", "kind", "date"),
    )
    id: Mapped[uuid.UUID] = _id()
    business_id: Mapped[uuid.UUID] = _bid()
    source: Mapped[str] = mapped_column(String(30))  # stripe | plaid | quickbooks | document | statement | manual
    source_ref: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(20))
    direction: Mapped[str] = mapped_column(String(3))  # in | out
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    open_minor: Mapped[int] = mapped_column(BigInteger, default=0)  # still unpaid (invoices and bills)
    currency: Mapped[str] = mapped_column(String(3), default="GBP")
    date: Mapped[dt.date] = mapped_column(Date)
    due_date: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    paid_date: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="posted")  # open | paid | void | posted | pending
    counterparty_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("counterparties.id"), nullable=True)
    account_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("accounts.id"), nullable=True)
    reference: Mapped[str | None] = mapped_column(String(200), nullable=True)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    category: Mapped[str | None] = mapped_column(String(80), nullable=True)
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    lines: Mapped[list] = mapped_column(JSONB, default=list)
    tax_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    external: Mapped[dict] = mapped_column(JSONB, default=dict)  # ids in the source system
    created_at: Mapped[datetime] = _created()


class Match(Base):
    __tablename__ = "matches"
    __table_args__ = (UniqueConstraint("business_id", "left_id", "right_id"),)
    id: Mapped[uuid.UUID] = _id()
    business_id: Mapped[uuid.UUID] = _bid()
    left_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("records.id"))
    right_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("records.id"))
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    score: Mapped[int] = mapped_column(Integer)
    rule: Mapped[str] = mapped_column(String(40))
    signals: Mapped[dict] = mapped_column(JSONB, default=dict)
    status: Mapped[str] = mapped_column(String(20))  # suggested | accepted | rejected
    decided_by: Mapped[str | None] = mapped_column(String(60), nullable=True)
    created_at: Mapped[datetime] = _created()


class Action(Base):
    """Anything that changes data or reaches outside. Each has a fixed approval level set in server code."""

    __tablename__ = "actions"
    id: Mapped[uuid.UUID] = _id()
    business_id: Mapped[uuid.UUID] = _bid()
    type: Mapped[str] = mapped_column(String(50))
    level: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    # pending | approved | executed | rejected | cancelled | failed | undone
    summary: Mapped[str] = mapped_column(String(500))
    payload: Mapped[dict] = mapped_column(JSONB)
    effects: Mapped[list] = mapped_column(JSONB, default=list)  # what will change, for the confirmation card
    reasons: Mapped[list] = mapped_column(JSONB, default=list)  # why it needs a person
    amount_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    requested_by: Mapped[str] = mapped_column(String(60))  # user id, or "ai:<workflow>"
    required_approvals: Mapped[int] = mapped_column(Integer, default=1)
    result: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = _created()
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Approval(Base):
    __tablename__ = "approvals"
    __table_args__ = (UniqueConstraint("action_id", "user_id"),)
    id: Mapped[uuid.UUID] = _id()
    business_id: Mapped[uuid.UUID] = _bid()
    action_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("actions.id"))
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    decision: Mapped[str] = mapped_column(String(10))  # approve | reject
    at: Mapped[datetime] = _created()


class Recommendation(Base):
    __tablename__ = "recommendations"
    __table_args__ = (UniqueConstraint("business_id", "fingerprint"),)
    id: Mapped[uuid.UUID] = _id()
    business_id: Mapped[uuid.UUID] = _bid()
    kind: Mapped[str] = mapped_column(String(40))
    fingerprint: Mapped[str] = mapped_column(String(120))
    counterparty_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    severity: Mapped[str] = mapped_column(String(10))  # info | watch | warning | urgent
    money_at_stake_minor: Mapped[int] = mapped_column(BigInteger, default=0)
    score: Mapped[float] = mapped_column(Float, default=0)
    facts: Mapped[dict] = mapped_column(JSONB)
    title: Mapped[str] = mapped_column(String(300))
    body: Mapped[str] = mapped_column(Text)
    ai_written: Mapped[bool] = mapped_column(Boolean, default=False)
    next_step: Mapped[dict] = mapped_column(JSONB, default=dict)
    status: Mapped[str] = mapped_column(String(20), default="new")  # new | dismissed | done
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Mute(Base):
    __tablename__ = "mutes"
    __table_args__ = (UniqueConstraint("business_id", "kind", "counterparty_id"),)
    id: Mapped[uuid.UUID] = _id()
    business_id: Mapped[uuid.UUID] = _bid()
    kind: Mapped[str] = mapped_column(String(40))
    counterparty_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = _created()


class PlannedItem(Base):
    """A what-if cost or income the owner is planning. Never changes real records."""

    __tablename__ = "planned_items"
    id: Mapped[uuid.UUID] = _id()
    business_id: Mapped[uuid.UUID] = _bid()
    name: Mapped[str] = mapped_column(String(200))
    direction: Mapped[str] = mapped_column(String(3), default="out")
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    date: Mapped[dt.date] = mapped_column(Date)
    repeat: Mapped[str] = mapped_column(String(10), default="none")  # none | weekly | monthly
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = _created()


class BusinessProfile(Base):
    __tablename__ = "business_profiles"
    business_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("businesses.id"), primary_key=True)
    owner_fields: Mapped[dict] = mapped_column(JSONB, default=dict)
    # {field: {"auto": value, "value": corrected, "by": user id, "at": iso}}
    overrides: Mapped[dict] = mapped_column(JSONB, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class ChatThread(Base):
    __tablename__ = "chat_threads"
    id: Mapped[uuid.UUID] = _id()
    business_id: Mapped[uuid.UUID] = _bid()
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    title: Mapped[str] = mapped_column(String(200), default="New conversation")
    created_at: Mapped[datetime] = _created()


class ChatMessage(Base):
    __tablename__ = "chat_messages"
    id: Mapped[uuid.UUID] = _id()
    business_id: Mapped[uuid.UUID] = _bid()
    thread_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("chat_threads.id"), index=True)
    role: Mapped[str] = mapped_column(String(10))  # user | assistant
    content: Mapped[str] = mapped_column(Text)
    blocks: Mapped[list] = mapped_column(JSONB, default=list)  # charts, tables, buttons, sources, follow-ups
    ai_saw: Mapped[str | None] = mapped_column(Text, nullable=True)
    checked: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = _created()


class AICall(Base):
    __tablename__ = "ai_calls"
    id: Mapped[uuid.UUID] = _id()
    business_id: Mapped[uuid.UUID] = _bid()
    purpose: Mapped[str] = mapped_column(String(40))
    model: Mapped[str] = mapped_column(String(120))
    provider: Mapped[str | None] = mapped_column(String(80), nullable=True)
    status: Mapped[str] = mapped_column(String(20))  # ok | blocked | error | refused
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float] = mapped_column(Float, default=0)
    detail: Mapped[str | None] = mapped_column(String(300), nullable=True)
    at: Mapped[datetime] = _created()


class Notification(Base):
    __tablename__ = "notifications"
    id: Mapped[uuid.UUID] = _id()
    business_id: Mapped[uuid.UUID] = _bid()
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    kind: Mapped[str] = mapped_column(String(40))
    title: Mapped[str] = mapped_column(String(300))
    link: Mapped[str | None] = mapped_column(String(300), nullable=True)
    read: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = _created()


class HandoffToken(Base):
    """Short-lived token behind the phone-handoff QR code. Lets a phone upload one receipt."""

    __tablename__ = "handoff_tokens"
    id: Mapped[uuid.UUID] = _id()
    business_id: Mapped[uuid.UUID] = _bid()
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = _created()


class AuditEntry(Base):
    """Tamper-evident activity log. Each entry's hash covers the previous entry's hash."""

    __tablename__ = "audit_log"
    seq: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    business_id: Mapped[uuid.UUID] = _bid()
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    actor: Mapped[str] = mapped_column(String(80))
    event: Mapped[str] = mapped_column(String(60))
    subject: Mapped[str | None] = mapped_column(String(120), nullable=True)
    details: Mapped[dict] = mapped_column(JSONB, default=dict)
    prev_hash: Mapped[str] = mapped_column(String(64))
    hash: Mapped[str] = mapped_column(String(64))


class ProcessedEvent(Base):
    """Notifications and emails already handled, so replays are ignored."""

    __tablename__ = "processed_events"
    __table_args__ = (UniqueConstraint("business_id", "source", "event_id"),)
    id: Mapped[uuid.UUID] = _id()
    business_id: Mapped[uuid.UUID] = _bid()
    source: Mapped[str] = mapped_column(String(30))
    event_id: Mapped[str] = mapped_column(String(500))
    at: Mapped[datetime] = _created()


TENANT_TABLES = [
    "connections", "accounts", "counterparties", "counterparty_versions", "documents", "extractions",
    "corrections", "records", "matches", "actions", "approvals", "recommendations", "mutes",
    "planned_items", "business_profiles", "chat_threads", "chat_messages", "ai_calls", "notifications",
    "handoff_tokens", "audit_log", "processed_events",
]
