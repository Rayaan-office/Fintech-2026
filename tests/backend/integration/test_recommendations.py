"""Recommendations on the demo story: our rules find the story's built-in patterns (and nothing
else), the AI only words them and is fact-checked, repeats are removed, dismissing mutes, and
the suggested email waits for approval and goes to the address on record."""

import re
import statistics
import uuid
from datetime import UTC, date, datetime, timedelta

import pytest
from sqlalchemy import select
from tests.backend import story_books

from app import actions
from app.analytics import rules
from app.copilot import insights
from app.db import tenant_session
from app.demo import story
from app.models import Action, AICall, Business, Counterparty, Recommendation
from app.pipeline import counterparties
from app.privacy.redact import mask, store_value, value_fingerprint

TODAY = date.today()
PLACEHOLDER = re.compile(r"\[[A-Z_]+_\d+\]")


@pytest.fixture(scope="module")
def books(businesses):
    bid, tag, s, _ = story_books.story_business()
    return {"id": bid, "tag": tag, "story": s}


def _findings(bid):
    with tenant_session(bid) as db:
        names = {c.id: c.display_name for c in db.execute(select(Counterparty)).scalars()}
        return [(f, names.get(f.counterparty_id)) for f in rules.find_all(db, TODAY)]


def honest_writer(data_text: str) -> dict:
    """A well-behaved AI: copies a figure line from the facts, keeping the placeholder."""
    ph = (PLACEHOLDER.findall(data_text) or [""])[0]
    line = next((ln.strip() for ln in data_text.splitlines() if "£" in ln or "%" in ln), "")
    return {"title": f"Worth a look: {ph}".strip(), "body": f"{ph} {line}".strip()}


def _email_on_record(db, bid, cp, address: str, when=None):
    vid = store_value(bid, "EMAIL", address)
    counterparties.add_version(db, bid, cp.id, {"email": {"fp": value_fingerprint("EMAIL", address), "vault": vid,
                                                          "display": mask("EMAIL", address)}}, "test")
    db.flush()


# ── The rules find exactly the story's patterns ────────────────────────────


def test_story_patterns_are_found_and_nothing_else(books):
    found = {(f.kind, name) for f, name in _findings(books["id"])}
    assert found == {
        ("price_rise", "Acme Supplies Ltd"),
        ("slow_payer", "Bright Cafe"),
        ("spending_creep", "CloudDesk Software Ltd"),  # the subscription creeping up
        ("spending_creep", "BrightSpark Energy Ltd"),  # the energy bill rises every month too
        ("customer_concentration", "Station Coffee Co"),
    }


def test_flour_price_rise_is_18_percent(books):
    f = next(f for f, _ in _findings(books["id"]) if f.kind == "price_rise")
    flour = next(x for x in f.facts["price changes on lines"] if "flour" in x["line"].lower())
    assert (flour["usual price"], flour["now"], flour["rise"]) == ("£45.00", "£53.10", "18%")
    assert any(e["before"] == "£45.00" and e["after"] == "£53.10" for e in f.evidence)
    assert f.next_step["action"] == "email_supplier"


def test_slow_payer_matches_the_story(books):
    s, terms = books["story"], {c.name: c.terms for c in story.CUSTOMERS}
    paid = [i for i in s.invoices if i.customer == "Bright Cafe" and i.paid_on
            and i.issue >= TODAY - timedelta(days=365)]
    expected = statistics.fmean((i.paid_on - i.due).days for i in paid)
    f = next(f for f, _ in _findings(books["id"]) if f.kind == "slow_payer")
    assert f.facts["average days paid after the due date"] == f"{expected:.0f}"
    recent = [i for i in paid if i.issue >= TODAY - timedelta(days=60)]
    before = [i for i in paid if i.issue < TODAY - timedelta(days=60)]
    slower = statistics.fmean((i.paid_on - i.due).days for i in recent) - statistics.fmean(
        (i.paid_on - i.due).days for i in before)
    assert slower >= 3  # the story makes Bright Cafe 4 days slower lately
    assert f.facts["average days late on invoices of the last 60 days"] == \
        f"{statistics.fmean((i.paid_on - i.due).days for i in recent):.0f}"
    assert terms["Bright Cafe"] == 14 and f.facts["payment terms"] == "14 days"
    overdue = sum(i.total for i in s.invoices if i.customer == "Bright Cafe" and not i.paid_on and i.due < TODAY)
    assert f.facts.get("of which overdue") == (f"£{overdue / 100:,.2f}" if overdue else None)
    assert f.next_step["action"] == ("send_payment_reminder" if overdue else None)


def test_reliance_on_one_customer_is_station_coffee(books):
    s = books["story"]
    recent = [i for i in s.invoices if TODAY - timedelta(days=90) < i.issue <= TODAY]
    share = sum(i.total for i in recent if i.customer == "Station Coffee Co") / sum(i.total for i in recent)
    f = next(f for f, _ in _findings(books["id"]) if f.kind == "customer_concentration")
    assert f.facts["their share"] == f"{share * 100:.0f}%" and share > 0.3


def test_creeping_subscription_is_creep_not_a_price_rise(books):
    s = books["story"]
    months = [rules.forecast.add_months(TODAY.replace(day=1), -i) for i in (4, 3, 2, 1)]
    nets = [sum(b.subtotal for b in s.bills if b.supplier_key == "software" and b.issue.replace(day=1) == m)
            for m in months]
    f = next(f for f, name in _findings(books["id"]) if f.kind == "spending_creep" and name == "CloudDesk Software Ltd")
    assert f.facts["spent each month (before VAT)"] == ", ".join(f"£{x / 100:,.2f}" for x in nets)
    assert not any(f.kind == "price_rise" and name.startswith("CloudDesk") for f, name in _findings(books["id"]))


# ── Supplier details changed ───────────────────────────────────────────────


@pytest.fixture
def supplier(businesses):
    bid, tag = story_books.new_business()
    with tenant_session(bid) as db:
        cp = story_books.party(db, bid, "supplier", "Acme Supplies Ltd")
        vid = store_value(bid, "EMAIL", "accounts@acme-supplies.co.uk")
        old = {"email": {"fp": value_fingerprint("EMAIL", "accounts@acme-supplies.co.uk"), "vault": vid,
                         "display": mask("EMAIL", "accounts@acme-supplies.co.uk")},
               "address": {"fp": value_fingerprint("ADDRESS", "4, Mill Lane, Leeds LS9 8AB"), "vault": None,
                           "display": "4, Mill Lane, Leeds LS9 8AB"},
               "bank_account": {"fp": value_fingerprint("BANK_ACCOUNT", "41926587"), "vault": None,
                                "display": "••••6587"}}
        counterparties.add_version(db, bid, cp.id, old, "document")
        db.flush()
        cid = cp.id
    return {"id": bid, "tag": tag, "cp": cid}


def _waiting_bill(bid, cp, details: dict, amount=65856):
    with tenant_session(bid) as db:
        a = actions.propose(db, bid, "approve_document", requested_by="ai:ingestion", amount_minor=amount,
                            payload={"document_id": str(uuid.uuid4()), "counterparty_id": str(cp), "details": details},
                            summary="Record bill", reasons=["test"])
        return a.id


def _detail(kind, value, display):
    return {"fp": value_fingerprint(kind, value), "vault": None, "display": display}


def test_a_waiting_bill_with_new_bank_details_is_one_urgent_finding(supplier):
    new_bank = {"bank_account": _detail("BANK_ACCOUNT", "55779911", "••••9911"),
                "email": _detail("EMAIL", "accounts@acme-suppl1es.co.uk", "a•••@acme-suppl1es.co.uk")}
    _waiting_bill(supplier["id"], supplier["cp"], new_bank)
    _waiting_bill(supplier["id"], supplier["cp"], new_bank, amount=50400)  # the fraud tried twice
    found = [f for f, _ in _findings(supplier["id"])]
    assert [f.kind for f in found] == ["bank_details_changed"]
    f = found[0]
    assert f.severity == "urgent" and not f.mutable
    assert f.money_at_stake_minor == 65856 + 50400 and f.facts["bills waiting with these details"] == 2
    assert {e["label"]: (e["before"], e["after"]) for e in f.evidence} == {
        "Bank account": ("••••6587", "••••9911"), "Email address": ("a•••@acme-supplies.co.uk", "a•••@acme-suppl1es.co.uk")}
    assert f.next_step["action"] == "email_supplier" and f.next_step["contact_before"]  # the address before the change


def test_a_changed_email_on_an_approved_bill_is_raised(supplier):
    with tenant_session(supplier["id"]) as db:
        counterparties.add_version(db, supplier["id"], supplier["cp"], {
            "email": _detail("EMAIL", "billing@acme-supplies.co.uk", "b•••@acme-supplies.co.uk")}, "document")
    found = [f for f, _ in _findings(supplier["id"])]
    assert [(f.kind, f.severity, f.mutable) for f in found] == [("supplier_details_changed", "warning", True)]
    assert found[0].facts["changed"] == "email address"


# ── The agent: words, fact check, repeats, mutes ──────────────────────────


def _run(bid, fake_ai, writer=honest_writer, n=10):
    fake_ai.push(*[writer] * n)
    return insights.run(bid, TODAY)


def _recs(bid):
    with tenant_session(bid) as db:
        return {r.fingerprint: r for r in db.execute(select(Recommendation)).scalars()}


def test_run_saves_ai_words_with_names_put_back(books, fake_ai):
    out = _run(books["id"], fake_ai)
    assert out["new"] == 5
    recs = _recs(books["id"])
    acme = recs[next(fp for fp in recs if fp.startswith("price:"))]
    assert acme.ai_written and "Acme Supplies Ltd" in acme.title  # the placeholder was put back
    saw = acme.facts["ai_saw"]
    assert "Acme" not in saw and "Bright Cafe" not in saw and "[SUPPLIER_" in saw  # the AI saw placeholders only
    assert all(c["purpose"] == "recommendation" for c in fake_ai.calls)


def test_second_run_shows_nothing_twice(books, fake_ai):
    before = {fp: r.updated_at for fp, r in _recs(books["id"]).items()}
    out = _run(books["id"], fake_ai)
    assert out["new"] == 0 and out["updated"] == 0 and out["kept"] == 5
    assert fake_ai.calls == []  # unchanged findings are not worded again
    assert {fp: r.updated_at for fp, r in _recs(books["id"]).items()} == before


def test_wrong_figure_is_rejected_then_the_template_is_used(businesses, fake_ai):
    bid, _ = story_books.new_business()
    story_books.load(bid)

    def liar(data_text):
        return {"title": "Acme up 99%", "body": "Prices rose by £1,234.56."}

    out = _run(bid, fake_ai, writer=liar, n=20)
    assert out["new"] == 5
    for r in _recs(bid).values():
        assert not r.ai_written and r.facts["fact_check"]  # what was wrong is kept
        assert "99%" not in r.title and "1,234.56" not in r.body
    assert "rejected by our fact check" in fake_ai.calls[1]["context"]  # the rewrite was told why


def test_paused_ai_uses_the_template_without_calling_it(businesses, fake_ai):
    bid, _ = story_books.new_business()
    story_books.load(bid)
    with tenant_session(bid) as db:
        db.get(Business, bid).ai_paused = True
    out = _run(bid, fake_ai, n=0)
    assert out["new"] == 5 and fake_ai.calls == []
    assert not any(r.ai_written for r in _recs(bid).values())


def test_dismissing_mutes_that_kind_for_that_party(books, fake_ai, sign_in):
    c = sign_in(f"books@{books['tag']}.test")
    items = c.get("/api/recommendations").json()["items"]
    slow = next(i for i in items if i["type"] == "slow_payer")
    assert c.post(f"/api/recommendations/{slow['id']}/dismiss").json() == {"ok": True, "muted": True}
    _run(books["id"], fake_ai)
    statuses = {i["type"]: i["status"] for i in c.get("/api/recommendations?status=all").json()["items"]}
    assert statuses["slow_payer"] == "dismissed"
    assert all(i["type"] != "slow_payer" for i in c.get("/api/recommendations").json()["items"])


def test_bank_detail_changes_are_never_muted(supplier, fake_ai, sign_in):
    _waiting_bill(supplier["id"], supplier["cp"], {"bank_account": _detail("BANK_ACCOUNT", "55779911", "••••9911")})
    _run(supplier["id"], fake_ai)
    c = sign_in(f"owner@{supplier['tag']}.test")
    rec = c.get("/api/recommendations").json()["items"][0]
    assert rec["type"] == "bank_details_changed" and rec["can_mute"] is False and rec["severity"] == "urgent"
    assert c.post(f"/api/recommendations/{rec['id']}/dismiss").json()["muted"] is False
    _waiting_bill(supplier["id"], supplier["cp"], {"bank_account": _detail("BANK_ACCOUNT", "22113344", "••••3344")})
    _run(supplier["id"], fake_ai)
    assert [i["evidence"][0]["after"] for i in c.get("/api/recommendations").json()["items"]] == ["••••3344"]


def test_a_finding_that_no_longer_holds_is_resolved(supplier, fake_ai):
    a = _waiting_bill(supplier["id"], supplier["cp"], {"bank_account": _detail("BANK_ACCOUNT", "55779911", "••••9911")})
    _run(supplier["id"], fake_ai)
    with tenant_session(supplier["id"]) as db:
        db.get(Action, a).status = "rejected"  # the fraudulent bill was turned down
    out = _run(supplier["id"], fake_ai)
    assert out["resolved"] == 1
    assert [r.status for r in _recs(supplier["id"]).values()] == ["resolved"]


# ── The next step: a drafted email that waits for approval ────────────────


def test_reminder_is_drafted_approved_and_sent_to_the_address_on_record(books, fake_ai, sign_in, monkeypatch):
    from app.connectors import email_out

    sent = []
    monkeypatch.setattr(email_out, "send", lambda to, subject, body, **kw: sent.append((to, subject, body)) or "<id@x>")
    with tenant_session(books["id"]) as db:
        cafe = db.execute(select(Counterparty).where(Counterparty.display_name == "Bright Cafe")).scalar_one()
        _email_on_record(db, books["id"], cafe, "hello@brightcafe.example")
        rec = db.execute(select(Recommendation).where(Recommendation.kind == "slow_payer")).scalar_one()
        rec.status = "new"  # dismissed by an earlier test
        overdue = bool(rec.next_step.get("action"))
    if not overdue:
        pytest.skip("Bright Cafe has nothing overdue today")
    fake_ai.push(lambda d: {"title": "Payment reminder", "body": f"Hello {PLACEHOLDER.findall(d)[0]}, "
                            "could you let us know when we can expect payment? Thank you."})
    books_c = sign_in(f"books@{books['tag']}.test")
    staff = sign_in(f"staff@{books['tag']}.test")
    assert staff.post(f"/api/recommendations/{rec.id}/next-step").status_code == 403
    a = books_c.post(f"/api/recommendations/{rec.id}/next-step").json()["action"]
    assert a["type"] == "send_payment_reminder" and a["status"] == "pending" and a["level"] == 3
    assert "h•••@brightcafe.example" in a["effects"][0] and "Hello Bright Cafe" in a["effects"][2]
    assert sent == []  # nothing goes out before approval
    assert books_c.post(f"/api/actions/{a['id']}/approve").json()["status"] == "executed"
    assert sent and sent[0][0] == "hello@brightcafe.example" and "[" not in sent[0][2]
    with tenant_session(books["id"]) as db:
        assert db.get(Recommendation, rec.id).status == "done"


def test_checking_changed_details_writes_to_the_old_address(supplier, fake_ai, sign_in, monkeypatch):
    from app.connectors import email_out

    sent = []
    monkeypatch.setattr(email_out, "send", lambda to, subject, body, **kw: sent.append(to) or "<id@x>")
    with tenant_session(supplier["id"]) as db:
        counterparties.add_version(db, supplier["id"], supplier["cp"], {
            "email": {"fp": value_fingerprint("EMAIL", "pay@acme-new.example"),
                      "vault": store_value(supplier["id"], "EMAIL", "pay@acme-new.example"),
                      "display": "p•••@acme-new.example"}}, "document")
    _run(supplier["id"], fake_ai)
    c = sign_in(f"owner@{supplier['tag']}.test")
    rec = c.get("/api/recommendations").json()["items"][0]
    assert rec["type"] == "supplier_details_changed"
    fake_ai.push(honest_writer)
    a = c.post(f"/api/recommendations/{rec['id']}/next-step").json()["action"]
    assert "a•••@acme-supplies.co.uk" in a["effects"][0]
    c.post(f"/api/actions/{a['id']}/approve")
    assert sent == ["accounts@acme-supplies.co.uk"]  # never the new address on the bill


def test_ai_calls_are_logged_per_business(books):
    with tenant_session(books["id"]) as db:
        assert db.execute(select(AICall)).first() is None  # the fake AI never reached the gateway's log


def test_recommendations_need_the_right_role(books, sign_in):
    assert sign_in(f"staff@{books['tag']}.test").get("/api/recommendations").status_code == 403
    assert sign_in(f"books@{books['tag']}.test").get("/api/recommendations").status_code == 200


def test_old_changes_are_not_raised(supplier):
    with tenant_session(supplier["id"]) as db:
        counterparties.add_version(db, supplier["id"], supplier["cp"], {
            "phone": _detail("PHONE", "01130000000", "•••• 000")}, "document")
        counterparties.add_version(db, supplier["id"], supplier["cp"], {
            "phone": _detail("PHONE", "01139999999", "•••• 999")}, "document")
        for v in db.execute(select(rules.CounterpartyVersion)).scalars():
            v.seen_at = datetime.now(UTC) - timedelta(days=200)
    assert _findings(supplier["id"]) == []
