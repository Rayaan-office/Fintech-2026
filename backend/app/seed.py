"""Creates the demo business and one sign-in per role. Safe to run repeatedly.

Passwords are generated once and saved to demo-credentials.local.json (git-ignored).
Run:  uv run python -m app.seed
"""

import json
import secrets

from sqlalchemy import select

from .config import ROOT, get_settings
from .db import global_session, tenant_session
from .models import Business, BusinessProfile, Connection, ConnectionRoute, Membership, User
from .security import audit
from .security.passwords import hash_password
from .security.rbac import Role

CRED_FILE = ROOT / "demo-credentials.local.json"
BUSINESS_NAME = "Demo Business Ltd"

PEOPLE = [
    ("owner@demo-business.test", "Alex Morgan", [Role.OWNER], None, False),
    ("finance@demo-business.test", "Sam Patel", [Role.FINANCE_MANAGER], 1_000_000, False),
    ("books@demo-business.test", "Jordan Lee", [Role.BOOKKEEPER], None, False),
    ("staff@demo-business.test", "Riley Chen", [Role.EMPLOYEE], None, False),
]


def _passwords() -> dict:
    creds = json.loads(CRED_FILE.read_text()) if CRED_FILE.exists() else {}
    for email, *_ in PEOPLE:
        creds.setdefault(email, secrets.token_urlsafe(12))
    CRED_FILE.write_text(json.dumps(creds, indent=2))
    CRED_FILE.chmod(0o600)
    return creds


def create_business(name: str, people, passwords: dict, inbox: str | None = None) -> Business:
    with global_session() as db:
        biz = db.execute(select(Business).where(Business.name == name)).scalar_one_or_none()
        if not biz:
            biz = Business(name=name, country="GB", currency="GBP")
            db.add(biz)
            db.flush()
        for email, full_name, roles, limit, second in people:
            user = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
            if not user:
                user = User(email=email, name=full_name, password_hash=hash_password(passwords[email]))
                db.add(user)
                db.flush()
            m = db.execute(select(Membership).where(Membership.user_id == user.id)).scalar_one_or_none()
            if not m:
                db.add(Membership(user_id=user.id, business_id=biz.id, roles=roles,
                                  approval_limit_minor=limit, second_approver=second))
        if inbox and not db.execute(select(ConnectionRoute).where(ConnectionRoute.kind == "email",
                                                                   ConnectionRoute.external_id == inbox)).first():
            db.add(ConnectionRoute(kind="email", external_id=inbox, business_id=biz.id))
        bid = biz.id
    with tenant_session(bid) as db:
        if not db.get(BusinessProfile, bid):
            db.add(BusinessProfile(business_id=bid, owner_fields={
                "country": "GB", "industry": "Food and drink", "business_type": "limited_company",
                "assets": "Delivery van", "credit_band": "good", "purpose": "",
            }))
            db.add(Connection(business_id=bid, kind="email", provider="mailpit", status="connected",
                              meta={"address": inbox}))
            audit.record(db, bid, "system", "business_created", details={"name": name})
    return biz


def run() -> None:
    s = get_settings()
    create_business(BUSINESS_NAME, PEOPLE, _passwords(), inbox=s.bills_inbox_address)
    print(f"demo business ready; sign-ins saved to {CRED_FILE.name}")


if __name__ == "__main__":
    run()
