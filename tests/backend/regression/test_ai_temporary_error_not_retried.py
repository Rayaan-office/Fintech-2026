"""A single temporary error from the AI provider sent a bill straight to a person.

During the live fraud-drill test, OpenRouter answered "Provider returned error" once.
The gateway treated it as final, so the document went to review without its fraud checks.
Busy or briefly failing providers (429, 5xx) now get exactly one more try after a short
wait. Refusals (blocked, out of credit) are never retried.
"""

import httpx
import pytest
from pydantic import BaseModel

from app.ai import gateway
from app.db import tenant_session
from app.models import AICall

URL = "https://openrouter.ai/api/v1/chat/completions"


class Tiny(BaseModel):
    total: str


def _ok():
    return httpx.Response(200, json={"choices": [{"message": {"content": '{"total": "5.00"}'}}],
                                     "provider": "TestProvider", "usage": {"cost": 0.0001}},
                          request=httpx.Request("POST", URL))


def _err(status, message="Provider returned error", headers=None, code=None):
    error = {"message": message, **({"code": code} if code else {})}
    return httpx.Response(status, json={"error": error}, headers=headers, request=httpx.Request("POST", URL))


@pytest.fixture
def provider(monkeypatch):
    """Scripted provider replies, in order. Records each request and each wait."""
    replies: list[httpx.Response] = []
    posts, waits = [], []

    class Client:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, headers=None, json=None):
            posts.append(json)
            return replies.pop(0)

    monkeypatch.setattr(gateway.outbound, "client", lambda **kw: Client())
    monkeypatch.setattr(gateway.time, "sleep", waits.append)
    return type("P", (), {"replies": replies, "posts": posts, "waits": waits})


def _call(bid):
    return gateway.complete_json(bid, "regression_retry", "Read the total.", "Total due: £5.00", Tiny)


def _logged(bid) -> list[tuple[str, str]]:
    with tenant_session(bid) as db:
        rows = db.query(AICall).filter(AICall.purpose == "regression_retry").order_by(AICall.at).all()
        out = [(r.status, r.detail or "") for r in rows]
        for r in rows:
            db.delete(r)
        return out


@pytest.mark.parametrize("first", [
    _err(502), _err(503, "Service unavailable"), _err(429, "Rate limited"),
    _err(200, code=502),  # error inside a 200 reply
    _err(200, "Provider returned error"),
])
def test_one_temporary_error_is_retried(businesses, provider, first):
    bid = businesses["a"]
    provider.replies.extend([first, _ok()])
    assert _call(bid).data.total == "5.00"
    assert len(provider.posts) == 2 and provider.posts[0] == provider.posts[1]  # the same redacted request
    assert provider.waits == [gateway.RETRY_WAIT_SECONDS]
    logged = _logged(bid)
    assert [s for s, _ in logged] == ["error", "ok"] and "trying once more" in logged[0][1]


def test_only_one_retry(businesses, provider):
    provider.replies.extend([_err(502), _err(502), _ok()])
    with pytest.raises(gateway.AIError):
        _call(businesses["a"])
    assert len(provider.posts) == 2
    _logged(businesses["a"])


def test_wait_follows_retry_after_but_is_capped(businesses, provider):
    provider.replies.extend([_err(429, headers={"Retry-After": "120"}), _ok()])
    _call(businesses["a"])
    assert provider.waits == [gateway.MAX_RETRY_WAIT_SECONDS]
    _logged(businesses["a"])


@pytest.mark.parametrize("reply,error", [
    (_err(400, "Blocked by guardrail: possible prompt injection"), gateway.GatewayBlocked),
    (_err(402, "Insufficient credits"), gateway.BudgetExceeded),
    (_err(400, "Invalid request"), gateway.AIError),
])
def test_refusals_are_never_retried(businesses, provider, reply, error):
    provider.replies.extend([reply, _ok()])
    with pytest.raises(error):
        _call(businesses["a"])
    assert len(provider.posts) == 1 and provider.waits == []
    _logged(businesses["a"])
