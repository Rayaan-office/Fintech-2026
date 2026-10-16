"""Recommendations, chats and financing stay inside one business, and the assistant's tools see
only the asking person's business."""

from datetime import date

from sqlalchemy import select

from app.copilot import tools
from app.db import global_session, read_only_session, tenant_session
from app.models import ChatThread, Recommendation, Record, User


def _rec(bid, fp):
    with tenant_session(bid) as db:
        r = Recommendation(business_id=bid, kind="price_rise", fingerprint=fp, severity="watch", facts={},
                           title=f"Rec {fp}", body="x", next_step={"label": "Draft", "action": "email_supplier"})
        db.add(r)
        db.flush()
        return r.id


def test_another_business_cannot_see_or_act_on_a_recommendation(businesses, sign_in):
    rid = _rec(businesses["b"], "iso-b-rec")
    c = sign_in("books@a.test")  # owners set up two-step sign-in, which other tests expect fresh
    assert "iso-b-rec" not in str(c.get("/api/recommendations?status=all").json())
    assert c.post(f"/api/recommendations/{rid}/dismiss").status_code == 404
    assert c.post(f"/api/recommendations/{rid}/next-step").status_code == 404


def test_another_business_cannot_read_a_chat(businesses, sign_in):
    with global_session() as g:
        uid = g.execute(select(User.id).where(User.email == "books@b.test")).scalar_one()
    with tenant_session(businesses["b"]) as db:
        t = ChatThread(business_id=businesses["b"], user_id=uid, title="private")
        db.add(t)
        db.flush()
        tid = t.id
    c = sign_in("books@a.test")  # owners set up two-step sign-in, which other tests expect fresh
    assert c.get(f"/api/ask/threads/{tid}").status_code == 404
    assert c.post("/api/ask", json={"question": "Hi", "thread_id": str(tid)}).status_code == 404


def test_assistant_tools_see_only_one_business(businesses):
    with tenant_session(businesses["b"]) as db:
        db.add(Record(business_id=businesses["b"], source="manual", source_ref="iso-b-inv", kind="invoice",
                      direction="in", amount_minor=987_654_00, open_minor=987_654_00, date=date.today(),
                      status="open", reference="SECRET-B"))
    with read_only_session(businesses["a"]) as db:
        res = tools.who_owes_you(db, date.today())
    assert "9,876,540" not in str(res.facts) and "SECRET-B" not in str(res.sources)
