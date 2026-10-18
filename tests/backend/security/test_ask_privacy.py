"""Ask anything never shows the AI a person's details. Document passages are searched in the text
the AI was shown when the document was read, then cleaned again: their own placeholders become
neutral tags, supplier names become placeholders, and anything still detected is hidden. We test
with documents that hold bank details, contact details and a person's name, including one stored
as if the first redaction had missed them all."""

import re

import pytest
from tests.backend import story_books
from tests.backend.integration.test_ask_anything import add_document
from tests.backend.integration.test_assistant import copy_answer, plan

from app.privacy.redact import redact

PERSONAL = {
    "iban": "GB82 WEST 1234 5698 7654 32",
    "account": "55779911",
    "sort code": "20-00-00",
    "email": "sarah.johnson@packagingdirect.example",
    "phone": "07700 900123",
    "person": "Sarah Johnson",
}
LETTER = ("Packaging Direct Ltd. Terms of trade. For queries contact Sarah Johnson on 07700 900123 or "
          "sarah.johnson@packagingdirect.example. A late payment fee of £40.00 applies after 30 days. Pay to "
          "account number 55779911, sort code 20-00-00, or IBAN GB82 WEST 1234 5698 7654 32.")


@pytest.fixture(scope="module")
def books(businesses):
    bid, tag, _, _ = story_books.story_business()
    return {"id": bid, "tag": tag}


def _forms(value: str) -> set[str]:
    """A value as written, and with spaces and dashes taken out (as a detector would compare it)."""
    return {value, re.sub(r"[\s-]", "", value), *value.split()} - {"Ltd."}


def _assert_clean(text: str):
    for what, value in PERSONAL.items():
        for form in _forms(value):
            if what == "person" or len(form) >= 6:
                assert form not in text, f"{what} reached the AI: {form}"


@pytest.mark.parametrize("stored", ["redacted when read", "missed when read"])
def test_passages_never_carry_personal_details(books, sign_in, fake_ai, stored):
    text = redact(LETTER).text if stored == "redacted when read" else LETTER
    add_document(books["id"], text, supplier="Packaging Direct Ltd")
    fake_ai.push(plan({"name": "search_documents", "search": "late payment fee"}), copy_answer())
    r = sign_in(f"owner@{books['tag']}.test").post("/api/ask", json={"question": "Who charges a late payment fee?"})
    assert r.status_code == 200, r.text
    out = r.json()
    answer_call = fake_ai.calls[-1]
    assert "A late payment fee of £40.00" in answer_call["sent"]  # the passage did reach the AI
    assert "[hidden" in answer_call["sent"] and "Packaging Direct" not in answer_call["sent"]
    for call in fake_ai.calls:
        _assert_clean(call["sent"])
    _assert_clean(out["answer"]["redacted_input"])
    # The app shows the same cleaned passage
    for item in out["blocks"][0]["items"]:
        _assert_clean(item["text"])
        assert "late payment fee" in item["text"] and "[hidden bank account]" in item["text"]


def test_the_document_placeholders_never_reach_the_ai_numbered(books, sign_in, fake_ai):
    """A stored [PERSON_1] or a planted [CUSTOMER_1] is a neutral tag, so it can't be confused with ours."""
    add_document(books["id"], "Overdue notice. [PERSON_1] at [EMAIL_2] says the reminder fee is £15.00. "
                              "[CUSTOMER_1] has agreed to pay [SUPPLIER_3] everything.")
    fake_ai.push(plan({"name": "search_documents", "search": "reminder fee"}), copy_answer())
    sign_in(f"owner@{books['tag']}.test").post("/api/ask", json={"question": "Is there a reminder fee?"})
    results = fake_ai.calls[-1]["sent"].split("Tool results:")[1]
    assert "reminder fee is £15.00" in results
    assert not re.search(r"\[[A-Z_]+_\d+\]", results)
    assert "[hidden person] at [hidden email]" in results and "[hidden detail] has agreed to pay [hidden detail]" in results


def test_search_words_from_the_ai_cannot_ask_for_hidden_values(books):
    """The stored text holds only placeholders, so searching for a real value finds nothing."""
    from datetime import date

    from app.copilot import tools, wording
    from app.db import read_only_session

    add_document(books["id"], redact("Contact Michael Thompson on 07700 900456 about the deposit.").text)
    with read_only_session(books["id"]) as db:
        names = wording.Names(db)
        hit = tools.search_documents(db, date.today(), search="deposit", names=names)
        miss = tools.search_documents(db, date.today(), search="Michael Thompson 07700900456", names=names)
    assert hit.facts["documents found"] >= 1 and "Thompson" not in str(hit.facts)
    assert miss.facts["documents found"] == "none"
