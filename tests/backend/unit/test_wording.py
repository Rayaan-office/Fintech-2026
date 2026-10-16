"""The fact check on AI wording, and hiding supplier and customer names."""

from types import SimpleNamespace

from app.copilot import wording


def test_money_must_be_money_from_the_facts():
    a = wording.allowed_numbers("usual: £45.00\nnow: £53.10\nrise: 18%\non: 11 October 2026\nbills: 3")
    assert wording.problems("Flour went from £45.00 to £53.10 (18%) on 11 October 2026.", a, set()) == []
    assert wording.problems("Flour went from £45 to £53 over 3 bills.", a, set()) == []  # rounded to the pound
    assert wording.problems("It costs £11 more.", a, set()) == ["£11 does not appear in the facts"]  # a day, not money
    assert wording.problems("Up 3%.", a, set()) == ["3% does not appear in the facts"]
    assert wording.problems("About £8.10 more.", a, set()) == ["£8.10 does not appear in the facts"]  # worked out


def test_placeholders_must_be_ones_we_sent():
    a = wording.allowed_numbers("supplier: [SUPPLIER_1]")
    assert wording.problems("[SUPPLIER_1] raised prices", a, {"[SUPPLIER_1]"}) == []
    assert wording.problems("[SUPPLIER_2] raised prices", a, {"[SUPPLIER_1]"}) == [
        "[SUPPLIER_2] is not one of the names given"]
    assert wording.problems("[SUPPLIER_12]", a, {"[SUPPLIER_1]"})  # placeholder digits are not figures


def test_names_are_hidden_longest_first_and_without_ltd():
    names = wording.Names.__new__(wording.Names)
    names.real = {"[SUPPLIER_1]": "Acme Supplies Ltd", "[SUPPLIER_2]": "Acme"}
    names._find = sorted([("Acme Supplies Ltd", "[SUPPLIER_1]"), ("Acme", "[SUPPLIER_2]")], key=lambda x: -len(x[0]))
    assert names.hide("Has acme supplies ltd put prices up?") == "Has [SUPPLIER_1] put prices up?"
    assert names.hide("Is Acme Supplies late?") == "Is [SUPPLIER_1] late?"
    assert names.hide("And Acme?") == "And [SUPPLIER_2]?"
    assert names.hide("Acmeville") == "Acmeville"


def test_a_unique_first_name_word_is_hidden_too():
    names = wording.Names.__new__(wording.Names)
    names._find = [("Acme Supplies Ltd", "[SUPPLIER_1]"), ("Bright Cafe", "[CUSTOMER_1]")]
    names._first = [("Acme", "[SUPPLIER_1]")]  # "Bright" is a common word, so it is not used alone
    assert names.hide("Has Acme put its prices up? ACME again.") == "Has [SUPPLIER_1] put its prices up? [SUPPLIER_1] again."
    assert names.hide("Is Bright paying?") == "Is Bright paying?"
    assert names.hide("an acme of design") == "an acme of design"  # lower case is an ordinary word
    names._first = [("Acme", "[SUPPLIER_1] or [SUPPLIER_2]")]
    assert names.hide("Is Acme dearer?") == "Is [SUPPLIER_1] or [SUPPLIER_2] dearer?"


def test_facts_are_labelled_lines():
    text = wording.facts_text({"supplier": "Acme", "lines": [{"line": "Flour", "now": "£53.10"}], "empty": None})
    assert text == "supplier: Acme\nlines:\n  1:\n    line: Flour\n    now: £53.10"


def test_paused_ai_is_not_called(monkeypatch):
    from app.ai import gateway

    monkeypatch.setattr(gateway, "complete_json", lambda *a, **k: (_ for _ in ()).throw(AssertionError("called")))
    w = wording.write("b", "x", "x", {"a": "£1.00"}, SimpleNamespace(), fallback=("T", "B"), paused=True)
    assert (w.title, w.body, w.ai_written) == ("T", "B", False)
