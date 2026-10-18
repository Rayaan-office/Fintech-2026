"""A plain-figures answer kept personal details as the AI's view of the turn.

When the AI's answer failed the fact check twice we showed the figures plainly, and kept that
text, with only supplier and customer names hidden, as what the AI saw. It went back to the AI
as history with the next question, so a detail in the facts (such as a phone number in a
recommendation) made the final scan refuse the follow-up. It is now hidden the same way as the
facts were, with the same numbering.
"""

from sqlalchemy import select
from tests.backend import story_books
from tests.backend.integration.test_assistant import copy_answer, plan

from app.copilot import tools
from app.db import tenant_session
from app.models import ChatMessage
from app.security.rbac import Perm


def test_the_follow_up_to_a_plain_answer_is_still_answered(businesses, sign_in, fake_ai, monkeypatch):
    def recs(db, today, **_):
        return tools.Result({"open recommendations": ["Call Sarah Johnson on 07700 900123 about £50.00 owed"]})

    monkeypatch.setitem(tools.TOOLS, "recommendations", tools.Tool("recommendations", "", Perm.VIEW_ALL, recs))
    bid, tag = story_books.new_business()
    c = sign_in(f"owner@{tag}.test")
    wrong = {"text": "You are owed £9.99.", "follow_ups": [], "suggest": "none", "suggest_party": None}
    fake_ai.push(plan({"name": "recommendations"}), wrong, wrong)
    first = c.post("/api/ask", json={"question": "Anything to look at?"}).json()
    assert not first["answer"]["ai_written"]
    assert "Sarah Johnson on 07700 900123" in first["answer"]["text"]  # the person asking sees it all
    with tenant_session(bid) as db:
        saw = db.execute(select(ChatMessage.ai_saw).where(ChatMessage.id == first["id"])).scalar_one()
    assert "Sarah" not in saw and "07700" not in saw and "[PERSON_1]" in saw

    fake_ai.push(plan({"name": "recommendations"}), copy_answer())
    second = c.post("/api/ask", json={"question": "And what should I do first?", "thread_id": first["thread_id"]}).json()
    assert "Earlier in this conversation" in fake_ai.calls[3]["sent"]
    assert second["answer"]["ai_written"]
