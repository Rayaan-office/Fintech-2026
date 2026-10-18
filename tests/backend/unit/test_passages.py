"""Cleaning document passages for the assistant: neutral tags in place of placeholders, windows that
never cut a placeholder in half, and search words without placeholders."""

from app.copilot import passages
from app.privacy.detectors import PLACEHOLDER_RE


def test_placeholders_become_neutral_tags():
    out = passages.neutral("Pay [PERSON_1] at [BANK_ACCOUNT_2], [SORT_CODE_1]; see [CUSTOMER_4] and [SOMETHING_9].")
    assert out == ("Pay [hidden person] at [hidden bank account], [hidden sort code]; see [hidden detail] "
                   "and [hidden detail].")
    assert not PLACEHOLDER_RE.search(out)


def test_supplier_and_customer_placeholders_can_be_kept():
    out = passages.neutral("[CUSTOMER_1] paid [PERSON_2] via [SUPPLIER_3]", keep=("SUPPLIER", "CUSTOMER"))
    assert out == "[CUSTOMER_1] paid [hidden person] via [SUPPLIER_3]"


def test_details_still_found_become_neutral_tags():
    out = passages.hide_left("Email ap@example.com or call 07700 900123 about account 55779911.", people=False)
    assert out == "Email [hidden email] or call [hidden phone] about account [hidden bank account]."


def test_windows_never_cut_a_placeholder_or_tag():
    filler = "word " * 60
    text = f"{filler}[SUPPLIER_12] said the <mark>fee</mark> rises; [hidden bank account] {filler}"
    out = passages._excerpt(text)
    assert "[SUPPLIER_12] said the fee rises; [hidden bank account]" in out
    assert len(out) <= passages.PASSAGE_CHARS + 30
    for cut in range(len(text)):
        a, b = passages._cut(text, cut, cut + 40)
        piece = text[a:b]
        assert piece.count("[") == piece.count("]"), piece


def test_two_far_apart_matches_give_two_windows():
    text = "<mark>late</mark> fee " + "filler " * 80 + "a second <mark>late</mark> charge"
    out = passages._excerpt(text)
    assert out.count(" … ") == 1 and out.startswith("late fee") and out.endswith("second late charge")


def test_search_words_drop_placeholders_and_symbols():
    assert passages.search_words("[SUPPLIER_1] late-payment fee!; DROP TABLE") == "late-payment fee DROP TABLE"
    assert passages.search_words("[SUPPLIER_1] [CUSTOMER_2]") == ""
    assert len(passages.search_words("fee " * 100)) <= 200
