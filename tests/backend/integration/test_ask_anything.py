"""Ask anything on the demo story: our own query over an allowlist of record kinds (totals match the
database), search over document text (passages linked to the document), only for roles that may
review documents, one business at a time, and the fact check still in charge."""

import hashlib
import uuid
from collections import defaultdict
from datetime import date

import pytest
from pydantic import ValidationError
from sqlalchemy import select, text
from tests.backend import story_books
from tests.backend.integration.test_assistant import NONE, copy_answer, plan

from app import bootstrap
from app.copilot import assistant, tools, wording
from app.db import global_session, read_only_session, tenant_session
from app.models import Counterparty, Document, Record, User
from app.security.rbac import Perm, perms_for

FEES = ("Payment terms: 30 days. A late payment fee of £40.00 applies to any invoice paid after the due "
        "date, and interest at 8% a year on top.")


@pytest.fixture(scope="module")
def books(businesses):
    bid, tag, s, _ = story_books.story_business()
    return {"id": bid, "tag": tag, "story": s}


def add_document(bid, redacted_text: str, supplier: str | None = None, doc_type="bill") -> uuid.UUID:
    """A document as the pipeline leaves it: redacted_text is what the AI was shown when it was read."""
    with tenant_session(bid) as db:
        cp = db.execute(select(Counterparty).where(Counterparty.display_name == supplier)).scalar_one() \
            if supplier else None
        d = Document(business_id=bid, source="email", status="approved", stage="done", filename="terms.pdf",
                     mime="application/pdf", size_bytes=100, sha256=hashlib.sha256(redacted_text.encode()).hexdigest(),
                     object_key=f"test/{uuid.uuid4()}", doc_type=doc_type, redacted_text=redacted_text,
                     counterparty_id=cp.id if cp else None)
        db.add(d)
        db.flush()
        return d.id


def run(bid, fn, **kw):
    with read_only_session(bid) as db:
        return fn(db, date.today(), names=wording.Names(db), **kw)


def expected(bid, kind: str, start: date, end: date, key) -> dict:
    """The same totals worked out the plain way, record by record."""
    out: dict = defaultdict(lambda: [0, 0])
    with tenant_session(bid) as db:
        for r in db.execute(select(Record).where(Record.kind == kind)).scalars():
            if r.status != "void" and r.currency == "GBP" and start <= r.date <= end:
                out[key(r)][0] += r.amount_minor
                out[key(r)][1] += 1
    return dict(out)


def _ask(c, question):
    r = c.post("/api/ask", json={"question": question})
    assert r.status_code == 200, r.text
    return r.json()


# ── Our own query ─────────────────────────────────────────────────────────


def test_totals_by_month_match_the_records(books):
    start, end = date(date.today().year, 1, 1), date.today()
    res = run(books["id"], tools.query_records, kind="bills", group_by="month", from_date=start, to_date=end)
    want = expected(books["id"], "bill", start, end, lambda r: r.date.replace(day=1))
    rows = res.blocks[0]["rows"]
    assert [[row[0], *row[1:3]] for row in rows] == [[f"{m:%B %Y}", *want[m]] for m in sorted(want)]  # in month order
    total = sum(v[0] for v in want.values())
    assert res.facts["all together"] == f"all together: {wording.money(total)} from {sum(v[1] for v in want.values())} bills"
    assert res.facts["from"] == wording.day(start) and res.facts["to"] == wording.day(end)


def test_totals_by_category_match_the_records(books):
    start, end = date(date.today().year - 1, date.today().month, 1), date.today()
    res = run(books["id"], tools.query_records, kind="bills", group_by="category", from_date=start, to_date=end)
    want = expected(books["id"], "bill", start, end, lambda r: r.category or "uncategorised")
    assert {row[0]: row[1:3] for row in res.blocks[0]["rows"]} == want
    amounts = [row[1] for row in res.blocks[0]["rows"]]
    assert amounts == sorted(amounts, reverse=True)  # largest first
    one = run(books["id"], tools.query_records, kind="bills", category="UTILITIES", from_date=start, to_date=end)
    assert one.blocks[0]["rows"][0][1:3] == want["utilities"]


def test_counts_and_averages(books):
    start, end = date(date.today().year, 1, 1), date.today()
    want = expected(books["id"], "invoice", start, end, lambda r: "all")["all"]
    count = run(books["id"], tools.query_records, kind="sales_invoices", measure="count", from_date=start, to_date=end)
    assert count.facts["all together"] == f"all together: {want[1]} invoices"
    avg = run(books["id"], tools.query_records, kind="sales_invoices", measure="average", from_date=start, to_date=end)
    assert avg.facts["all together"] == f"all together: average {wording.money(round(want[0] / want[1]))} over {want[1]} invoices"
    assert avg.blocks[0]["rows"] == [["All", want[0], want[1], round(want[0] / want[1])]]


def test_money_in_and_out_are_the_bank_lines(books):
    start, end = date(date.today().year, 1, 1), date.today()
    res = run(books["id"], tools.query_records, kind="money_out", from_date=start, to_date=end)
    with tenant_session(books["id"]) as db:
        out = [r.amount_minor for r in db.execute(select(Record).where(Record.kind == "bank_txn", Record.direction == "out",
                                                                        Record.date >= start, Record.date <= end)).scalars()]
    assert res.blocks[0]["rows"][0][1:3] == [sum(out), len(out)]


def test_dates_are_limited_to_24_months(books):
    res = run(books["id"], tools.query_records, kind="bills", from_date=date(2015, 1, 1), to_date=date.today())
    assert res.facts["limited to"] == "the last 24 months"
    assert res.facts["from"] != wording.day(date(2015, 1, 1))


def test_at_most_24_rows(books):
    with tenant_session(books["id"]) as db:
        for i in range(30):
            story_books.record(db, books["id"], "fee", 100 + i, date.today(), source="stripe", category=f"fee kind {chr(97 + i % 26)}{i}")
    res = run(books["id"], tools.query_records, kind="fees", group_by="category")
    assert len(res.blocks[0]["rows"]) == 24 and len(res.facts["by category"]) == 24
    assert res.facts["note"] == "only the first 24 groups are listed"


def test_the_ai_only_picks_from_our_choices(books):
    with pytest.raises(ValidationError):
        assistant.Plan.model_validate(plan({"name": "query_records", "kind": "users"}))
    with pytest.raises(ValidationError):
        assistant.Plan.model_validate(plan({"name": "query_records", "group_by": "password_hash"}))
    # Free text such as a category is only ever a bound value, never part of the query
    res = run(books["id"], tools.query_records, kind="bills", category="x' OR 1=1; DROP TABLE records; --")
    assert res.blocks[0]["rows"] == [["All", 0, 0, 0]]


def test_an_unknown_party_counts_nothing(books, sign_in, fake_ai):
    fake_ai.push(plan({"name": "query_records", "kind": "bills", "party": "[SUPPLIER_99]"}),
                 {"text": "I don't know that supplier.", "follow_ups": [], "suggest": "none", "suggest_party": None})
    out = _ask(sign_in(f"owner@{books['tag']}.test"), "What did we spend with them?")
    assert "not one we know, so nothing was counted" in fake_ai.calls[-1]["sent"]
    assert out["blocks"] == []


def test_grouping_by_party_hides_names_from_the_ai(books, sign_in, fake_ai):
    fake_ai.push(plan({"name": "query_records", "kind": "bills", "group_by": "party"}), copy_answer())
    out = _ask(sign_in(f"owner@{books['tag']}.test"), "Which suppliers did we spend most with this year?")
    sent = fake_ai.calls[-1]["sent"]
    for s in ("Acme Supplies", "BrightSpark", "CloudDesk", "Packaging Direct", "Oven Doctors", "Yorkshire"):
        assert s not in sent and s not in fake_ai.calls[0]["sent"]
    assert "[SUPPLIER_1]: £" in sent
    table = out["blocks"][0]
    assert table["columns"][0] == "Supplier or customer" and "Acme Supplies Ltd" in [r[0] for r in table["rows"]]
    assert "[SUPPLIER_" not in out["answer"]["text"]  # names are put back for the person asking


def test_the_plan_lists_the_known_categories(books, sign_in, fake_ai):
    fake_ai.push(plan({"name": "query_records", "kind": "bills", "group_by": "month", "category": "utilities"}),
                 copy_answer())
    _ask(sign_in(f"owner@{books['tag']}.test"), "Energy spending by month this year?")
    first = fake_ai.calls[-2]["sent"]
    assert "Known categories: " in first and "utilities" in first and "cost of sales" in first
    assert "category: utilities" in fake_ai.calls[-1]["sent"]


# ── Document search ───────────────────────────────────────────────────────


def test_search_finds_the_passage_and_links_the_document(books, sign_in, fake_ai):
    did = add_document(books["id"], "Packaging Direct Ltd\nTerms of trade\n" + FEES, supplier="Packaging Direct Ltd")
    add_document(books["id"], "Oven Doctors Ltd\nCall-out charge £85.00. Parts extra.", supplier="Oven Doctors Ltd")
    fake_ai.push(plan({"name": "search_documents", "search": "late payment fee"}), copy_answer())
    out = _ask(sign_in(f"owner@{books['tag']}.test"), "Which supplier mentions late payment fees?")
    sent = fake_ai.calls[-1]["sent"]
    assert "searched documents for: late payment fee" in sent and "A late payment fee of £40.00" in sent
    assert "bill from [SUPPLIER_" in sent and "Packaging Direct" not in sent
    block = out["blocks"][0]
    assert block["type"] == "passages" and block["items"][0]["document_id"] == str(did)
    assert block["items"][0]["href"] == f"/documents?open={did}" and "Packaging Direct Ltd" in block["items"][0]["text"]
    assert {"id": str(did), "kind": "document", "label": "terms.pdf", "href": f"/documents?open={did}"} in out["sources"]
    assert out["answer"]["ai_written"] and "Call-out" not in sent


def test_search_can_be_limited_to_one_supplier(books):
    add_document(books["id"], "Acme Supplies Ltd. Late payment fee: £25.00 after 30 days.", supplier="Acme Supplies Ltd")
    add_document(books["id"], "Packaging Direct Ltd. Late payment fee: £30.00 after 30 days.", supplier="Packaging Direct Ltd")
    with read_only_session(books["id"]) as db:
        names = wording.Names(db)
        acme = db.execute(select(Counterparty).where(Counterparty.display_name == "Acme Supplies Ltd")).scalar_one()
        res = tools.search_documents(db, date.today(), search="late payment fee", party_id=acme.id, names=names)
    assert res.facts["documents found"] == 1 and "£25.00" in res.facts["passages (personal details are shown as [hidden ...])"][0]


def test_any_word_is_tried_when_no_document_has_them_all(books):
    add_document(books["id"], "Insurance renewal: the excess is £250.00 per claim.")
    res = run(books["id"], tools.search_documents, search="insurance excess penalty")
    assert res.facts["documents found"] == 1
    none = run(books["id"], tools.search_documents, search="[SUPPLIER_1]")
    assert none.facts == {"document search": "The question did not give any words to look for."}


def test_the_fact_check_still_holds_for_passages(books, sign_in, fake_ai):
    add_document(books["id"], "Yorkshire Business Insurance Ltd. Cancellation fee £60.00.",
                 supplier="Yorkshire Business Insurance Ltd")
    wrong = {"text": "The cancellation fee is £600.00.", "follow_ups": [], "suggest": "none", "suggest_party": None}
    fake_ai.push(plan({"name": "search_documents", "search": "cancellation fee"}), wrong, wrong)
    out = _ask(sign_in(f"owner@{books['tag']}.test"), "What is the cancellation fee?")
    assert not out["answer"]["ai_written"] and "600" not in out["answer"]["text"]
    assert "£600.00 does not appear in the facts" in fake_ai.calls[-1]["context"]
    assert "Cancellation fee £60.00" in out["answer"]["text"]  # our plain facts instead


def test_roles_without_document_review_cannot_search(books, sign_in, fake_ai):
    assert sign_in(f"staff@{books['tag']}.test").post("/api/ask", json={"question": "late fees?"}).status_code == 403
    with global_session() as db:
        uid = db.execute(select(User.id).where(User.email == f"books@{books['tag']}.test")).scalar_one()
    fake_ai.push(plan({"name": "search_documents", "search": "late payment fee"}))
    perms = perms_for(["bookkeeper"]) - {Perm.REVIEW_DOCUMENTS}
    out = assistant.ask(books["id"], uid, perms, "Which supplier mentions late fees?")
    assert "role doesn't include search documents" in out["text"] and out["blocks"] == []
    assert len(fake_ai.calls) == 1  # nothing was searched or sent


def test_search_and_query_see_one_business(books, businesses):
    other = businesses["b"]
    add_document(other, "Zanzibar Freight Ltd. Demurrage surcharge £900.00 per day.")
    assert run(other, tools.search_documents, search="demurrage surcharge").facts["documents found"] == 1
    assert run(books["id"], tools.search_documents, search="demurrage surcharge").facts["documents found"] == "none"
    with tenant_session(other) as db:
        story_books.record(db, other, "bill", 123_456_00, date.today(), category="freight")
    res = run(books["id"], tools.query_records, kind="bills", category="freight")
    assert res.blocks[0]["rows"] == [["All", 0, 0, 0]]


# ── Measurable numbers and the index ──────────────────────────────────────


def test_stats_count_answers_from_records_and_first_time_checks(books, sign_in, fake_ai):
    c = sign_in(f"finance@{books['tag']}.test")
    before = c.get("/api/ask/stats").json()
    wrong = {"text": "You spent £1.23.", "follow_ups": [], "suggest": "none", "suggest_party": None}
    fake_ai.push(plan({"name": "query_records", "kind": "bills"}), copy_answer())
    _ask(c, "How much did we spend on bills?")
    fake_ai.push(plan({"name": "query_records", "kind": "fees"}), wrong, copy_answer())
    _ask(c, "And on fees?")
    fake_ai.push(plan(about=False))
    _ask(c, "Write me a poem")
    s = c.get("/api/ask/stats").json()
    assert s["questions"] - before["questions"] == 3
    assert s["answered_from_data"] - before["answered_from_data"] == 2
    assert s["checked_first_try"] - before["checked_first_try"] == 1
    assert s["by_tool"]["query_records"] >= 2 and s["first_try_pct"] is not None
    assert sign_in(f"staff@{books['tag']}.test").get("/api/ask/stats").status_code == 403


def test_search_index_is_added_once_and_kept(books):
    bootstrap.run()  # a second run changes nothing
    with bootstrap._engine_for().connect() as c:
        col = c.execute(text("SELECT generation_expression FROM information_schema.columns "
                             "WHERE table_name = 'documents' AND column_name = 'search_tsv'")).scalar()
        idx = c.execute(text("SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_documents_search'")).scalar()
    assert "to_tsvector" in col and "redacted_text" in col
    assert "gin" in idx.lower()


def test_none_fields_cover_every_input():
    assert set(NONE) | {"name"} == set(assistant.ToolCall.model_fields)
