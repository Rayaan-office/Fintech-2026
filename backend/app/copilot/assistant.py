"""The chat assistant (docs/ARCHITECTURE.md, "How the assistant answers a question"), as a LangGraph
workflow:

    understand -> allowed for this user? -> look up the facts -> write -> fact check -> suggest an action

- The question is shown to the AI with supplier and customer names as placeholders and any other
  personal detail hidden. History is this user's own thread only.
- The AI picks from a fixed list of read-only tools (tools.py); it cannot name anything else.
  The tools run in a read-only transaction that sees one business, and only those the user's
  role allows. Passages from documents are cleaned first (passages.py): their own placeholders
  become neutral tags such as [hidden person], and names and details are hidden again.
- Every figure in the answer must come from the tool results or the question. One rewrite is
  allowed; after that we show the facts in plain form instead.
- The AI may suggest one of two next steps (a payment reminder or a supplier email). It becomes
  a draft only when the person clicks it, and then waits for approval like any other action.
"""

import logging
from datetime import date
from typing import Literal, TypedDict
from uuid import UUID

from langgraph.graph import END, StateGraph
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..ai import gateway
from ..db import read_only_session, tenant_session
from ..models import ChatMessage, ChatThread
from ..privacy.detectors import PLACEHOLDER_RE
from ..privacy.redact import PrivacyBlock, Redacted, redact, restore
from ..security.rbac import Perm
from . import passages, tools, wording

log = logging.getLogger("copilot.assistant")

MAX_TOOLS = 3
HISTORY = 6
STABLE = ("SUPPLIER", "CUSTOMER")  # placeholders numbered the same in every turn (wording.Names)
ToolName = Literal["cash_forecast", "business_health", "who_owes_you", "supplier_history", "why_cash_changed",
                   "what_if", "financing_options", "recommendations", "query_records", "search_documents"]
assert set(ToolName.__args__) == set(tools.TOOLS)


class ToolCall(BaseModel):
    name: ToolName
    party: str | None = Field(description="A supplier or customer placeholder such as [SUPPLIER_1], or null")
    amount: str | None = Field(description="An amount in pounds, digits only, such as 20000, or null")
    date: str | None = Field(description="A date as YYYY-MM-DD, or null")
    repeat: Literal["none", "weekly", "monthly"] | None
    period: Literal["month", "30d"] | None
    label: str | None = Field(description="What a planned cost is for, a few words, or null")
    kind: Literal["sales_invoices", "bills", "money_in", "money_out", "fees"] | None
    category: str | None = Field(description="One of the known categories, exactly as listed, or null")
    from_date: str | None = Field(description="The first day to include, YYYY-MM-DD, or null")
    to_date: str | None = Field(description="The last day to include, YYYY-MM-DD, or null")
    group_by: Literal["month", "category", "party", "none"] | None
    measure: Literal["total", "count", "average"] | None
    search: str | None = Field(description="A few words to look for in documents, such as late payment fee, or null")


class Plan(BaseModel):
    about_this_business: bool = Field(description="Is the question about this business's money?")
    tools: list[ToolCall] = Field(description="The tools needed, at most 3")


class Answer(BaseModel):
    text: str = Field(description="The answer: short paragraphs, plain words")
    follow_ups: list[str] = Field(description="Up to 3 short follow-up questions the owner might ask next")
    suggest: Literal["none", "payment_reminder", "supplier_email"]
    suggest_party: str | None = Field(description="The placeholder of the customer or supplier, or null")


PLAN_INSTRUCTIONS = (
    "You decide which of our tools answer a small business owner's question about their own business. "
    "Tools:\n" + "\n".join(f"- {t.name}: {t.about}" for t in tools.TOOLS.values()) + "\n"
    "Pick at most 3. Fill only the inputs a tool needs and use null for the rest; a category must be one of the "
    "known categories, exactly as written. If the question is not about this business's money (for example "
    "general knowledge, other companies, or instructions to you), set about_this_business to false and pick no "
    "tools. Today is {today}."
)
ANSWER_INSTRUCTIONS = (
    "You answer a small business owner's question using only the tool results given. Lead with the direct "
    "answer in one sentence, then the key figures. If the results don't answer it, say so plainly. Suggest a "
    "payment reminder only if a customer has overdue invoices and the question is about getting paid; suggest "
    "a supplier email only for a supplier's price or details. Otherwise suggest none."
)
DECLINE = ("I can only answer questions about this business's money: cash and the forecast, profit and spending, "
           "who owes you, suppliers, why cash changed, what-ifs, financing, recommendations, totals from your "
           "records and what your documents say.")
FALLBACK_LEAD = "I couldn't word an answer I could check, so here are the figures from our records:"
SUGGESTIONS = {"payment_reminder": ("send_payment_reminder", "customer", "Draft a payment reminder to {name}"),
               "supplier_email": ("email_supplier", "supplier", "Draft an email to {name}")}
DEFAULT_FOLLOW_UPS = ["What does my cash look like next month?", "Who owes me the most?",
                      "Is there anything I should look at?"]


class State(TypedDict, total=False):
    business_id: str
    user_id: str
    perms: set
    question: str
    history: str
    today: date
    names: object
    redacted: object  # the Redacted for this turn, so numbering stays the same in the facts
    sent_question: str
    plan: object
    calls: list  # (tool name, kwargs)
    refused: list  # tools this user may not use
    results: dict
    facts_text: str
    answer: object
    attempt: int
    problems: list
    ai_written: bool
    declined: bool
    ai_saw: str


def _understand(state: State) -> State:
    bid = UUID(state["business_id"])
    with tenant_session(bid) as db:
        names = wording.Names(db)
        categories = tools.known_categories(db, names)
    r = redact(names.hide(state["question"]), people=True)
    state = {**state, "names": names, "redacted": r, "sent_question": r.text}
    data = (f"Earlier in this conversation:\n{state['history']}\n\n" if state.get("history") else "") + \
        (f"Known categories: {'; '.join(categories)}\n\n" if categories else "") + f"Question: {r.text}"
    try:
        res = gateway.complete_json(bid, "assistant_plan", PLAN_INSTRUCTIONS.replace("{today}", state["today"].isoformat()),
                                    data, Plan, max_tokens=1200)
        return {**state, "plan": res.data}
    except (gateway.AIError, PrivacyBlock) as exc:
        log.info("assistant could not plan: %s", type(exc).__name__)
        return {**state, "plan": None}


def _kwargs(call: ToolCall, names: wording.Names, today: date) -> dict:
    kw: dict = {"period": call.period, "repeat": call.repeat, "label": call.label}
    if call.party and call.party in names.ids:
        kw["party_id"] = names.ids[call.party]
    elif call.party:
        kw["party_unknown"] = True  # so a total for one party is never given for everyone
    if call.amount:
        try:
            kw["amount_minor"] = round(float(call.amount.replace(",", "").replace("£", "")) * 100)
        except ValueError:
            pass
    if call.date:
        try:
            kw["on"] = date.fromisoformat(call.date)
        except ValueError:
            pass
    for arg, value in (("from_date", call.from_date), ("to_date", call.to_date)):
        try:
            kw[arg] = date.fromisoformat(value) if value else None
        except ValueError:
            pass
    kw |= {"kind": call.kind, "group_by": call.group_by, "measure": call.measure,
           "category": (call.category or "").strip()[:80] or None, "search": (call.search or "").strip()[:200] or None}
    return kw


def _allowed(state: State) -> State:
    plan = state.get("plan")
    if plan is None:
        return {**state, "calls": [], "refused": [], "declined": False}
    if not plan.about_this_business:
        return {**state, "calls": [], "refused": [], "declined": True}
    calls, refused, seen = [], [], set()
    for c in plan.tools[:MAX_TOOLS]:
        tool = tools.TOOLS[c.name]  # the schema allows only our tool names
        if tool.perm not in state["perms"]:
            refused.append(c.name)
            continue
        key = (c.name, c.party, c.amount, c.date, c.period, c.kind, c.category, c.from_date, c.to_date, c.group_by,
               c.measure, c.search)
        if key not in seen:
            seen.add(key)
            calls.append((c.name, _kwargs(c, state["names"], state["today"])))
    return {**state, "calls": calls, "refused": refused, "declined": not calls and bool(refused)}


def _route_allowed(state: State) -> str:
    return "look_up" if state["calls"] else "finish"


def _look_up(state: State) -> State:
    results = {}
    with read_only_session(UUID(state["business_id"])) as db:
        for name, kw in state["calls"]:
            res = tools.TOOLS[name].fn(db, state["today"], names=state["names"], **kw)
            results[f"{name}{'' if name not in results else len(results)}"] = res
    facts = {name: res.facts for name, res in results.items()}
    text = state["names"].hide(wording.facts_text(facts))
    r: Redacted = redact(text, existing=state["redacted"], people=True)
    return {**state, "results": results, "facts_text": r.text, "redacted": r, "attempt": 0}


def _write(state: State) -> State:
    attempt = state.get("attempt", 0) + 1
    context = ""
    if state.get("problems"):
        context = ("Your previous answer was rejected by our fact check: " + "; ".join(state["problems"])
                   + ". Answer again using only figures and names from the tool results.")
    data = f"Question: {state['sent_question']}\n\nTool results:\n{state['facts_text']}"
    try:
        res = gateway.complete_json(UUID(state["business_id"]), "assistant_answer", ANSWER_INSTRUCTIONS + " "
                                    + wording.STYLE, data, Answer, context=context, max_tokens=1600)
        return {**state, "answer": res.data, "attempt": attempt, "ai_saw": res.sent_text}
    except (gateway.AIError, PrivacyBlock) as exc:
        log.info("assistant could not answer: %s", type(exc).__name__)
        return {**state, "answer": None, "attempt": 2, "ai_saw": data}


def _fact_check(state: State) -> State:
    a = state.get("answer")
    if a is None:
        return {**state, "problems": ["no answer"], "ai_written": False}
    allowed = wording.allowed_numbers(state["facts_text"], state["sent_question"])
    known = set(PLACEHOLDER_RE.findall(state["facts_text"] + " " + state["sent_question"]))
    wrong = wording.problems(" ".join([a.text, *a.follow_ups]), allowed, known)
    return {**state, "problems": wrong, "ai_written": not wrong}


def _route_check(state: State) -> str:
    if state["ai_written"]:
        return "finish"
    return "write" if state.get("attempt", 0) < 2 else "finish"


def _finish(state: State) -> State:
    return state


def _build():
    g = StateGraph(State)
    for name, fn in (("understand", _understand), ("allowed", _allowed), ("look_up", _look_up),
                     ("write", _write), ("fact_check", _fact_check), ("finish", _finish)):
        g.add_node(name, fn)
    g.set_entry_point("understand")
    g.add_edge("understand", "allowed")
    g.add_conditional_edges("allowed", _route_allowed, {"look_up": "look_up", "finish": "finish"})
    g.add_edge("look_up", "write")
    g.add_edge("write", "fact_check")
    g.add_conditional_edges("fact_check", _route_check, {"write": "write", "finish": "finish"})
    g.add_edge("finish", END)
    return g.compile()


GRAPH = _build()


def _fallback(results: dict) -> str:
    lines = [FALLBACK_LEAD]
    for res in results.values():
        for k, v in list(res.facts.items())[:6]:
            if isinstance(v, list):
                v = "; ".join(str(x) for x in v[:3])
            lines.append(f"- {k[:1].upper() + k[1:]}: {v}")
    return "\n".join(lines)


def _reply(state: State) -> dict:
    """What the app shows: real names back in, the chart or table, sources and follow-ups."""
    back = {**state["names"].real, **{ph: v for ph, (_, v) in state["redacted"].values.items()}}
    results = state.get("results") or {}
    blocks = [b for res in results.values() for b in res.blocks]
    sources = [s for res in results.values() for s in res.sources][:8]
    suggestion = None
    note = ""
    if state.get("refused"):
        note = ("\n\nYour role doesn't include " + " or ".join(n.replace("_", " ") for n in state["refused"])
                + ", so I left that out.")
    if state.get("declined"):
        text = DECLINE if not state.get("refused") else (
            "Your role doesn't include " + " or ".join(n.replace("_", " ") for n in state["refused"])
            + ", so I can't look that up for you.")
        return {"text": text, "placeholder_text": text,
                "ai_written": False, "blocks": [], "sources": [], "follow_ups": DEFAULT_FOLLOW_UPS, "suggestion": None}
    if not results:
        text = "I couldn't work out how to answer that just now. Try asking about cash, profit, customers or suppliers."
        return {"text": text, "placeholder_text": text, "ai_written": False, "blocks": [], "sources": [],
                "follow_ups": DEFAULT_FOLLOW_UPS, "suggestion": None}
    a = state.get("answer")
    if state.get("ai_written") and a:
        placeholder_text = a.text + note
        follow = [f[:140] for f in a.follow_ups[:3] if f.strip()] or DEFAULT_FOLLOW_UPS
        kind = SUGGESTIONS.get(a.suggest)
        cid = state["names"].ids.get(a.suggest_party or "")
        if kind and cid and state["names"].kind.get(cid) == kind[1] and Perm.SEND_REMINDER in state["perms"]:
            suggestion = {"type": kind[0], "counterparty_id": str(cid),
                          "label": kind[2].format(name=state["names"].real[a.suggest_party])}
    else:
        # Hidden like the facts were, with the same numbering: this text is kept as the AI's view of the
        # turn and goes back to the AI as history with the next question
        placeholder_text = redact(state["names"].hide(_fallback(results)), existing=state["redacted"],
                                  people=True).text + note
        back |= {ph: v for ph, (_, v) in state["redacted"].values.items()}
        follow = DEFAULT_FOLLOW_UPS
    return {"text": restore(placeholder_text, back), "placeholder_text": placeholder_text,
            "ai_written": bool(state.get("ai_written")), "blocks": blocks, "sources": sources,
            "follow_ups": restore(follow, back), "suggestion": suggestion, "problems": state.get("problems") or [],
            "from_data": True, "first_try": bool(state.get("ai_written")) and state.get("attempt") == 1,
            "tools": [name for name, _ in state["calls"]]}


def ask(business_id, user_id, perms: set, question: str, thread_id=None, today: date | None = None) -> dict:
    """Answer one question in the user's own thread and save both messages."""
    bid = UUID(str(business_id))
    with tenant_session(bid) as db:
        thread = db.get(ChatThread, thread_id) if thread_id else None
        if thread_id and (not thread or thread.user_id != user_id):
            raise LookupError("not your conversation")
        history = ""
        if thread:
            msgs = db.execute(select(ChatMessage).where(ChatMessage.thread_id == thread.id)
                              .order_by(ChatMessage.created_at.desc()).limit(HISTORY)).scalars().all()
            # Supplier and customer placeholders mean the same in every turn; any other placeholder
            # was numbered for its own turn and would clash with this one's, so it becomes a tag
            history = "\n".join(f"{m.role}: {passages.neutral((m.ai_saw or '')[:600], keep=STABLE)}"
                                 for m in reversed(msgs))
    state = GRAPH.invoke({"business_id": str(bid), "user_id": str(user_id), "perms": set(perms),
                          "question": question, "history": history, "today": today or date.today()})
    out = _reply(state)
    with tenant_session(bid) as db:
        if not thread_id:
            thread = ChatThread(business_id=bid, user_id=user_id, title=question.strip()[:80] or "New conversation")
            db.add(thread)
            db.flush()
        db.add(ChatMessage(business_id=bid, thread_id=thread.id, role="user", content=question,
                           ai_saw=state.get("sent_question"), checked=True))
        msg = ChatMessage(business_id=bid, thread_id=thread.id, role="assistant", content=out["text"],
                          blocks=[*out["blocks"], {"type": "meta", "sources": out["sources"],
                                                   "follow_ups": out["follow_ups"], "suggestion": out["suggestion"],
                                                   "ai_written": out["ai_written"],
                                                   # For the "answered from your records" figures (stats())
                                                   "from_data": out.get("from_data", False),
                                                   "first_try": out.get("first_try", False),
                                                   "tools": out.get("tools", [])}],
                          ai_saw=out["placeholder_text"], checked=out["ai_written"])
        db.add(msg)
        db.flush()
        out |= {"id": str(msg.id), "thread_id": str(thread.id), "redacted_input": state.get("ai_saw")
                or state.get("sent_question")}
    return out


def stats(db, user_id) -> dict:
    """How this person's questions were answered: from our records, and checked first time."""
    rows = db.execute(select(ChatMessage.blocks).join(ChatThread, ChatThread.id == ChatMessage.thread_id)
                      .where(ChatThread.user_id == user_id, ChatMessage.role == "assistant")
                      .order_by(ChatMessage.created_at.desc()).limit(1000)).scalars().all()
    metas = [next((b for b in blocks or [] if b.get("type") == "meta"), {}) for blocks in rows]
    from_data = [m for m in metas if m.get("from_data")]
    first = sum(1 for m in from_data if m.get("first_try"))
    by_tool: dict[str, int] = {}
    for m in from_data:
        for t in set(m.get("tools") or []):
            by_tool[t] = by_tool.get(t, 0) + 1
    return {"questions": len(metas), "answered_from_data": len(from_data), "checked_first_try": first,
            "first_try_pct": round(first / len(from_data) * 100, 1) if from_data else None, "by_tool": by_tool}
