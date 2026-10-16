"""An Intuit sign-in link could be finished in a different browser.

The link's state was signed but not tied to the browser that started it, so a captured link
could be completed elsewhere while it was valid. The browser now keeps a one-time value in a
cookie that must match, and the cookie is cleared after use.
"""

from urllib.parse import parse_qs, urlparse

from tests.backend.integration.test_accounting_software import _records, biz, fake_qbo  # noqa: F401


def test_link_needs_the_browser_that_started_it(biz, fake_qbo):  # noqa: F811
    url = biz.finance.get("/api/connections/quickbooks/start").json()["url"]
    state = parse_qs(urlparse(url).query)["state"][0]
    realm = fake_qbo.company()
    elsewhere = biz.sign_in(f"finance@{biz.tag}.test")
    r = elsewhere.get("/connect/quickbooks/callback", params={"code": fake_qbo.code_for(realm), "state": state,
                                                               "realmId": realm}, follow_redirects=False)
    assert r.headers["location"].endswith("qbo=failed") and _records(biz.id) == {}
    r = biz.finance.get("/connect/quickbooks/callback", params={"code": fake_qbo.code_for(realm), "state": state,
                                                                 "realmId": realm}, follow_redirects=False)
    assert r.headers["location"].endswith("qbo=connected")
    r = biz.finance.get("/connect/quickbooks/callback", params={"code": fake_qbo.code_for(realm), "state": state,
                                                                 "realmId": realm}, follow_redirects=False)
    assert r.headers["location"].endswith("qbo=failed")  # used once
