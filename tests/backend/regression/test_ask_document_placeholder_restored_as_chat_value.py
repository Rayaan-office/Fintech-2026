"""A document's own placeholders would be restored as the chat's.

The text kept for each document numbers its hidden details from 1 ([PERSON_1] is whoever the
document named). The chat numbers them from 1 too, so a passage quoting the document's
[PERSON_1] would have been shown with the name from the question instead. Passages now carry
neutral tags such as [hidden person], which are never restored.
"""

from tests.backend import story_books
from tests.backend.integration.test_ask_anything import add_document
from tests.backend.integration.test_assistant import copy_answer, plan


def test_a_document_person_is_never_shown_as_the_question_person(businesses, sign_in, fake_ai):
    bid, tag = story_books.new_business()
    story_books.load(bid)
    add_document(bid, "Reminder: a reminder fee of £15.00 is added, says [PERSON_1] ([EMAIL_1]).")
    fake_ai.push(plan({"name": "search_documents", "search": "reminder fee"}), copy_answer())
    out = sign_in(f"owner@{tag}.test").post(
        "/api/ask", json={"question": "Did Tom Baker mention a reminder fee?"}).json()
    assert "[PERSON_1]" in fake_ai.calls[0]["sent"]  # Tom Baker, in the question
    assert "says [hidden person] ([hidden email])" in out["answer"]["text"]
    assert "Tom Baker" not in out["answer"]["text"]
