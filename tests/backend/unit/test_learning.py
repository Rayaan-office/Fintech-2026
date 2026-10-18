"""The ranking that learns: Thompson-sampling draws, what may move, and what is folded away."""

import uuid
from dataclasses import dataclass
from datetime import date, timedelta

from app.copilot import learning

BID = uuid.UUID("00000000-0000-0000-0000-00000000000a")
TODAY = date(2026, 10, 18)


@dataclass
class Rec:
    kind: str
    severity: str
    money_at_stake_minor: int = 0
    id: str = ""


@dataclass
class Stat:
    wins: int
    losses: int


def _ids(recs):
    return [r.id for r in recs]


def test_a_kind_with_no_decisions_uses_the_middle_value():
    assert learning._draw(BID, "price_rise", TODAY, 0, 0) == learning.PRIOR_MEAN


def test_the_draw_is_the_same_all_day_and_changes_between_days():
    same = {learning._draw(BID, "price_rise", TODAY, 3, 2) for _ in range(5)}
    assert len(same) == 1
    days = {learning._draw(BID, "price_rise", TODAY + timedelta(days=i), 3, 2) for i in range(10)}
    assert len(days) > 1


def test_the_draw_differs_between_businesses():
    other = uuid.UUID("00000000-0000-0000-0000-00000000000b")
    draws = {(b, i): learning._draw(b, "price_rise", TODAY + timedelta(days=i), 3, 2) for b in (BID, other) for i in range(5)}
    assert any(draws[(BID, i)] != draws[(other, i)] for i in range(5))


def test_draws_follow_the_decisions():
    days = [TODAY + timedelta(days=i) for i in range(200)]
    liked = sum(learning._draw(BID, "a", d, 18, 2) for d in days) / len(days)
    disliked = sum(learning._draw(BID, "b", d, 2, 18) for d in days) / len(days)
    assert liked > 0.8 and disliked < 0.2


def test_with_no_decisions_the_order_stays_by_money():
    recs = [Rec("price_rise", "watch", 500, "a"), Rec("spending_creep", "watch", 900, "b"),
            Rec("slow_payer", "warning", 10, "c")]
    out = learning.rank(recs, {}, BID, TODAY)
    assert _ids(out) == ["c", "b", "a"]


def test_a_useful_kind_moves_up_within_its_severity_only():
    recs = [Rec("slow_payer", "warning", 100, "w"), Rec("spending_creep", "watch", 1000, "x"),
            Rec("price_rise", "watch", 900, "y"), Rec("customer_concentration", "info", 5000, "z")]
    st = {"price_rise": Stat(30, 0), "spending_creep": Stat(0, 30), "customer_concentration": Stat(50, 0)}
    out = learning.rank(recs, st, BID, TODAY)
    assert _ids(out) == ["w", "y", "x", "z"]  # the info item never jumps above a watch item


def test_urgent_items_are_never_moved_down():
    recs = [Rec("bank_details_changed", "urgent", 0, "bank"), Rec("supplier_details_changed", "urgent", 0, "sup"),
            Rec("price_rise", "warning", 10**9, "big")]
    st = {"bank_details_changed": Stat(0, 100), "supplier_details_changed": Stat(0, 100), "price_rise": Stat(100, 0)}
    for i in range(30):
        out = learning.rank(recs, st, BID, TODAY + timedelta(days=i))
        assert _ids(out)[:2] == ["bank", "sup"]


def test_changed_bank_details_stay_first_in_their_group():
    recs = [Rec("price_rise", "warning", 10**9, "p"), Rec("bank_details_changed", "warning", 0, "bank")]
    st = {"bank_details_changed": Stat(0, 100), "price_rise": Stat(100, 0)}
    assert _ids(learning.rank(recs, st, BID, TODAY)) == ["bank", "p"]


def test_order_is_stable_within_a_day():
    recs = [Rec(k, "watch", m, k) for k, m in (("a", 100), ("b", 110), ("c", 95), ("d", 105))]
    st = {k: Stat(w, lo) for k, w, lo in (("a", 2, 2), ("b", 1, 3), ("c", 3, 1), ("d", 2, 1))}
    first = _ids(learning.rank(recs, st, BID, TODAY))
    for _ in range(10):
        assert _ids(learning.rank(list(reversed(recs)), st, BID, TODAY)) == first


def test_rarely_useful_minor_kinds_are_folded_but_never_urgent_or_bank_ones():
    s = Stat(wins=0, losses=5)
    assert learning.less_useful(s, Rec("spending_creep", "watch"))
    assert learning.less_useful(s, Rec("customer_concentration", "info"))
    assert not learning.less_useful(s, Rec("price_rise", "warning"))
    assert not learning.less_useful(s, Rec("supplier_details_changed", "urgent"))
    assert not learning.less_useful(s, Rec("bank_details_changed", "info"))


def test_folding_needs_enough_decisions_and_a_low_share():
    assert not learning.less_useful(Stat(0, 4), Rec("spending_creep", "watch"))  # only 4 decisions
    assert not learning.less_useful(Stat(1, 4), Rec("spending_creep", "watch"))  # 20% is not below 20%
    assert learning.less_useful(Stat(1, 5), Rec("spending_creep", "watch"))
    assert not learning.less_useful(None, Rec("spending_creep", "watch"))


def test_only_safe_fields_can_be_learned():
    learnable = set(learning.LEARNABLE) | {learning.TERMS, learning.NAME}
    for never in ("payment_bank_account", "payment_sort_code", "contact_email", "contact_phone", "address",
                  "total", "subtotal", "tax", "line_items"):
        assert never not in learnable


def test_terms_are_days_from_issue_to_due():
    assert learning._terms({"issue_date": "2026-10-01", "due_date": "2026-10-31"}) == 30
    assert learning._terms({"issue_date": "2026-10-01", "due_date": ""}) is None
    assert learning._terms({"issue_date": "2026-10-31", "due_date": "2026-10-01"}) is None


def test_a_learned_category_alone_may_still_be_recorded_automatically():
    filled = {"category_hint": {"learned_as": "category_hint"}}
    assert learning.needs_check(filled) == []
    filled["due_date"] = {"learned_as": "payment_terms"}
    assert learning.needs_check(filled) == ["payment terms"]
