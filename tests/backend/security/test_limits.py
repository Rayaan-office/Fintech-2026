"""Limits that hold whatever arrives: upload size and pages, the fixed list of outside addresses
our server may call, and the AI's daily budget and hourly limit."""

import io
import json
from datetime import date, timedelta

import httpx
import pytest
from pydantic import BaseModel
from reportlab.pdfgen import canvas
from sqlalchemy import text
from tests.backend import story_books

from app.ai import gateway
from app.connectors import outbound
from app.db import tenant_session
from app.demo import documents as demo
from app.models import AICall, Document
from app.pipeline import ingest, reader


@pytest.fixture
def biz(businesses):
    bid, tag = story_books.new_business()
    return {"id": bid, "tag": tag}


def _refusals(bid) -> list[str]:
    with tenant_session(bid) as db:
        return list(db.execute(text("SELECT details->>'reason' FROM audit_log WHERE event = 'document_refused'"))
                    .scalars())


# ── Uploads ────────────────────────────────────────────────────────────────


def test_a_file_over_the_size_limit_is_refused_and_logged(biz, sign_in, settings):
    c = sign_in(f"books@{biz['tag']}.test")
    small_enough = demo.render(demo.Bill(demo.ACME, "S-1", date.today(), date.today() + timedelta(days=30),
                                         [("Flour", 1, 4500)]))
    too_big = small_enough + b"\n%" + b"0" * (settings.upload_max_bytes - len(small_enough))
    assert len(too_big) == settings.upload_max_bytes + 2

    r = c.post("/api/documents", files={"file": ("big.pdf", too_big, "application/pdf")})
    assert r.status_code == 400 and "larger than" in r.json()["detail"]
    assert _refusals(biz["id"]) == [r.json()["detail"]]
    with tenant_session(biz["id"]) as db:
        assert db.execute(text("SELECT count(*) FROM documents")).scalar() == 0  # nothing archived


def test_a_pdf_with_too_many_pages_goes_to_a_person_unread(biz, settings, fake_ai):
    buf = io.BytesIO()
    pdf = canvas.Canvas(buf)
    for n in range(settings.upload_max_pages + 1):
        pdf.drawString(100, 700, f"Page {n + 1} of a very long statement with enough words to read")
        pdf.showPage()
    pdf.save()

    did = ingest.receive(biz["id"], buf.getvalue(), "long.pdf", "upload")
    with tenant_session(biz["id"]) as db:
        d = db.get(Document, did)
        assert d.status == "review"
        too_long = f"The document has {settings.upload_max_pages + 1} pages, more than we read automatically."
        assert d.review_reasons == [too_long]
    assert fake_ai.calls == []  # the AI never saw it


def test_a_read_that_runs_past_the_time_limit_is_stopped(biz, fake_ai, monkeypatch):
    monkeypatch.setattr(reader, "READ_TIMEOUT_SECONDS", 0)  # no read can finish in time
    b = demo.Bill(demo.ACME, "S-2", date.today(), date.today() + timedelta(days=30), [("Flour", 1, 4500)])
    did = ingest.receive(biz["id"], demo.render(b), "slow.pdf", "upload")
    with tenant_session(biz["id"]) as db:
        d = db.get(Document, did)
        assert d.status == "review" and d.review_reasons == ["Reading the document took too long."]
    assert fake_ai.calls == [] and reader._pool is None  # the stuck worker was let go


# ── Outside calls ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("url", ["https://evil.example/steal", "https://api.stripe.com.evil.example/v1",
                                 "http://api.stripe.com/v1/charges", "ftp://api.stripe.com/x"])
def test_an_address_off_the_list_is_never_called(url):
    sent = []
    http = outbound.client(transport=httpx.MockTransport(lambda req: sent.append(req) or httpx.Response(200)))
    with pytest.raises(outbound.OutboundRefused):
        http.get(url)
    assert sent == []


def test_every_outside_call_has_a_time_limit(settings):
    with outbound.client() as http:
        assert http.timeout == httpx.Timeout(settings.outbound_timeout_seconds)


def test_a_redirect_is_not_followed():
    sent = []

    def stripe(req):
        sent.append(str(req.url))
        return httpx.Response(302, headers={"location": "https://evil.example/collect"})

    with outbound.client(transport=httpx.MockTransport(stripe)) as http:
        r = http.get("https://api.stripe.com/v1/balance")
    assert r.status_code == 302 and sent == ["https://api.stripe.com/v1/balance"]
    with pytest.raises(outbound.OutboundRefused):  # even asked to follow it, the guard stops the next hop
        outbound.client(transport=httpx.MockTransport(stripe)).get("https://api.stripe.com/v1/balance",
                                                                   follow_redirects=True)
    assert sent == ["https://api.stripe.com/v1/balance"] * 2


# ── AI spending ────────────────────────────────────────────────────────────


class _Answer(BaseModel):
    ok: bool


def _spent(bid, calls: int, cost_each: float) -> None:
    with tenant_session(bid) as db:
        db.add_all(AICall(business_id=bid, purpose="test", model="m", status="ok", cost_usd=cost_each)
                   for _ in range(calls))


@pytest.fixture
def provider(monkeypatch):
    """Counts requests that would have reached the AI provider, and answers none of them."""
    tries = []

    def unreachable(**kw):
        tries.append(kw)
        raise httpx.ConnectError("no network in tests")

    monkeypatch.setattr(gateway.outbound, "client", unreachable)
    return tries


@pytest.mark.parametrize("limit", ["daily_budget", "hourly_requests"])
def test_the_ai_budget_and_hourly_limit_refuse_a_request(biz, settings, provider, limit):
    if limit == "daily_budget":
        _spent(biz["id"], 2, settings.ai_daily_budget_usd / 2)
        expected = gateway.BudgetExceeded
    else:
        _spent(biz["id"], settings.ai_requests_per_business_per_hour, 0.0)
        expected = gateway.RateLimited
    with pytest.raises(expected):
        gateway.complete_json(biz["id"], "test", "Answer.", "Is this fine?", _Answer)
    assert provider == []

    other, _ = story_books.new_business()  # another business's spending is its own
    with pytest.raises(gateway.AIError, match="unreachable"):
        gateway.complete_json(other, "test", "Answer.", "Is this fine?", _Answer)
    assert len(provider) == 1


def test_an_answer_cannot_ask_for_more_than_the_length_cap(biz, settings, monkeypatch):
    asked = []

    def reply(request):
        asked.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"ok": true}'}}], "usage": {}})

    real = outbound.client
    monkeypatch.setattr(gateway.outbound, "client", lambda **kw: real(transport=httpx.MockTransport(reply), **kw))
    gateway.complete_json(biz["id"], "test", "Answer.", "Is this fine?", _Answer, max_tokens=1_000_000)
    assert asked[0]["max_tokens"] == settings.ai_max_output_tokens
