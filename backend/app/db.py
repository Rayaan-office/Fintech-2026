"""Database access.

Every request that touches business data runs inside `tenant_session(business_id)`.
It sets `app.business_id` for the transaction, and Postgres row-level security
then hides every row that belongs to another business. If the setting is
missing, the policies match nothing, so a forgotten call fails closed.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from uuid import UUID

from sqlalchemy import create_engine, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import get_settings

settings = get_settings()

app_engine = create_engine(settings.app_dsn, pool_pre_ping=True, pool_size=10, max_overflow=10)
vault_engine = create_engine(settings.vault_dsn, pool_pre_ping=True, pool_size=3)

AppSession = sessionmaker(app_engine, expire_on_commit=False)
VaultSession = sessionmaker(vault_engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def _set_tenant(db: Session, business_id: UUID | str | None) -> None:
    db.execute(
        text("SELECT set_config('app.business_id', :bid, true)"),
        {"bid": str(business_id) if business_id else ""},
    )


@contextmanager
def tenant_session(business_id: UUID | str) -> Iterator[Session]:
    """A transaction that can see only one business's rows."""
    with AppSession() as db:
        with db.begin():
            _set_tenant(db, business_id)
            yield db


@contextmanager
def global_session() -> Iterator[Session]:
    """A transaction for tables that are not tied to one business (users, sign-in sessions)."""
    with AppSession() as db:
        with db.begin():
            _set_tenant(db, None)
            yield db


@contextmanager
def vault_session(business_id: UUID | str) -> Iterator[Session]:
    with VaultSession() as db:
        with db.begin():
            _set_tenant(db, business_id)
            yield db
