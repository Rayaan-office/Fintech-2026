"""The approval rules the AI and the people using Cocent cannot get around: actions outside the
fixed list are refused, the person who prepared a two-person change cannot approve it, and
nothing is approved automatically while AI is paused."""

import pytest
from sqlalchemy import func, select, text
from tests.backend import story_books

import app.handlers  # noqa: F401  (registers approval handlers)
from app import actions
from app.db import tenant_session
from app.models import Action
from app.security.rbac import ACTIONS, AI_FORBIDDEN


@pytest.fixture
def biz(businesses):
    bid, tag = story_books.new_business()
    return {"id": bid, "tag": tag}


def _events(bid, action_id) -> list[str]:
    with tenant_session(bid) as db:
        return list(db.execute(text("SELECT event FROM audit_log WHERE subject = :s ORDER BY seq"),
                               {"s": f"action:{action_id}"}).scalars())


@pytest.mark.parametrize("action_type", sorted(AI_FORBIDDEN) + ["delete_everything", "Schedule_Payment"])
def test_the_ai_cannot_create_a_forbidden_or_unknown_action(biz, action_type):
    assert action_type not in ACTIONS
    with pytest.raises(ValueError, match="unknown or forbidden"), tenant_session(biz["id"]) as db:
        actions.propose(db, biz["id"], action_type, requested_by="ai:assistant", summary="Do it",
                        payload={}, auto_ok=True)
    with tenant_session(biz["id"]) as db:
        assert db.execute(select(func.count()).select_from(Action)).scalar() == 0


def test_the_preparer_cannot_approve_their_own_two_person_change(biz, sign_in):
    finance, owner = sign_in(f"finance@{biz['tag']}.test"), sign_in(f"owner@{biz['tag']}.test")
    uid = finance.get("/api/auth/me").json()["user"]["id"]
    with tenant_session(biz["id"]) as db:
        aid = actions.propose(db, biz["id"], "change_supplier_bank", requested_by=f"user:{uid}",
                              summary="New bank details for Acme", payload={}).id
    seen = finance.get(f"/api/actions/{aid}").json()
    assert seen["level"] == 4 and seen["can_approve"] is False and "You prepared this" in seen["why_not"]

    r = finance.post(f"/api/actions/{aid}/approve")
    assert r.status_code == 403 and "You prepared this" in r.json()["detail"]
    assert "approval_refused" in _events(biz["id"], aid)  # the refusal is kept in the activity log

    # One other person is still not enough: it waits for a second
    assert owner.post(f"/api/actions/{aid}/approve").json()["status"] == "pending"
    with tenant_session(biz["id"]) as db:
        assert db.get(Action, aid).status == "pending"


def test_nothing_is_approved_automatically_while_ai_is_paused(biz, sign_in, monkeypatch):
    ran = []
    monkeypatch.setitem(actions._handlers, "accept_match", lambda db, a, actor: ran.append(actor) or {})

    def small_confident_match(summary):
        with tenant_session(biz["id"]) as db:
            a = actions.propose(db, biz["id"], "accept_match", requested_by="ai:matching", summary=summary,
                                payload={}, auto_ok=True)
            return a.id, a.status, list(a.reasons)

    _, status, _ = small_confident_match("Before the pause")
    assert status == "executed" and ran == ["ai:auto"]  # the same proposal runs on its own normally

    owner = sign_in(f"owner@{biz['tag']}.test")
    assert owner.post("/api/settings/ai-pause", json={"paused": True}).json() == {"ai_paused": True}
    aid, status, reasons = small_confident_match("During the pause")
    assert status == "pending" and ran == ["ai:auto"]
    assert "AI is paused, so a person must approve." in reasons
    assert [i["id"] for i in owner.get("/api/inbox").json()["items"]] == [str(aid)]
