"""An earlier turn's hidden details clashed with this turn's numbering.

Each turn numbers hidden details from 1, but earlier turns went back to the AI as history with
their own numbers. "Did John Smith pay?" then "And Jane Doe?" showed the AI [PERSON_1] for both
people, and an answer naming [PERSON_1] was shown with the wrong name. In the history, only
supplier and customer placeholders (numbered the same in every turn) are kept now; any other
placeholder becomes a neutral tag such as [hidden person].
"""

from tests.backend import story_books
from tests.backend.integration.test_assistant import copy_answer, plan


def test_earlier_turns_keep_no_numbered_personal_details(businesses, sign_in, fake_ai):
    bid, tag = story_books.new_business()
    story_books.load(bid)
    c = sign_in(f"owner@{tag}.test")
    fake_ai.push(plan({"name": "who_owes_you"}), copy_answer())
    first = c.post("/api/ask", json={"question": "Did John Smith from Bright Cafe pay us?"}).json()
    assert "[PERSON_1]" in fake_ai.calls[0]["sent"]
    fake_ai.push(plan({"name": "who_owes_you"}), copy_answer())
    c.post("/api/ask", json={"question": "And did Jane Doe pay?", "thread_id": first["thread_id"]})
    sent = fake_ai.calls[2]["sent"]
    history, question = sent.split("Question:")
    assert "Earlier in this conversation" in history and "[hidden person]" in history
    assert "[PERSON_" not in history and "[CUSTOMER_" in history  # customers keep their placeholder
    assert "[PERSON_1]" in question
