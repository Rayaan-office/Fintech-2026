"""Bug: the fact check accepted "£1.00" in an explanation because a 1 appeared in a date in the
facts. Money must now match money in the facts, and a percentage a percentage."""

from app.copilot import wording


def test_a_date_is_not_money():
    allowed = wording.allowed_numbers("this period: 2026-10-01 to 2026-10-16\nchange: £2,450.10")
    assert wording.problems("Cash fell by £1.00.", allowed, set()) == ["£1.00 does not appear in the facts"]
    assert wording.problems("Cash fell by 16%.", allowed, set()) == ["16% does not appear in the facts"]
    assert wording.problems("Cash changed by £2,450.10 since 1 October.", allowed, set()) == []
