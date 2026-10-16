"""The only way our server calls outside services.

A fixed allowlist of hosts (no web addresses from documents or emails are ever opened),
a time limit on every call, and no automatic redirects to other hosts.
"""

from urllib.parse import urlparse

import httpx

from ..config import get_settings

_s = get_settings()


def _host(url: str) -> str:
    return (urlparse(url).hostname or "").lower()


ALLOWED_HOSTS = {
    "openrouter.ai",
    "api.stripe.com",
    "sandbox.plaid.com",
    "production.plaid.com",
    "appcenter.intuit.com",
    "oauth.platform.intuit.com",
    "developer.api.intuit.com",
    "sandbox-quickbooks.api.intuit.com",
    "quickbooks.api.intuit.com",
    _host(_s.mailpit_api_url),
}


class OutboundRefused(Exception):
    pass


def check_url(url: str) -> None:
    if urlparse(url).scheme not in ("https", "http") or _host(url) not in ALLOWED_HOSTS:
        raise OutboundRefused(f"outbound call to {_host(url)!r} is not on the allowlist")
    if urlparse(url).scheme == "http" and _host(url) not in {"localhost", "127.0.0.1"}:
        raise OutboundRefused("plain http is only allowed for local services")


def _guard(request: httpx.Request) -> None:
    check_url(str(request.url))


def client(**kwargs) -> httpx.Client:
    return httpx.Client(
        timeout=kwargs.pop("timeout", _s.outbound_timeout_seconds),
        follow_redirects=False,
        event_hooks={"request": [_guard]},
        **kwargs,
    )
