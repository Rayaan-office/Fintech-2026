"""Creates tables, row-level security policies and grants. Safe to run repeatedly.

Run with the owner account:  uv run python -m app.bootstrap
"""

from sqlalchemy import create_engine, text

from .config import get_settings
from .db import Base
from . import models  # noqa: F401  (registers tables)
from .models import TENANT_TABLES

VAULT_SQL = """
CREATE SCHEMA IF NOT EXISTS vault;
CREATE TABLE IF NOT EXISTS vault.pii_values (
    id uuid PRIMARY KEY,
    business_id uuid NOT NULL,
    kind varchar(40) NOT NULL,
    ciphertext text NOT NULL,
    fingerprint varchar(64) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_pii_business_fp ON vault.pii_values (business_id, fingerprint);
ALTER TABLE vault.pii_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault.pii_values FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant ON vault.pii_values;
CREATE POLICY tenant ON vault.pii_values
    USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
    WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
"""


# Columns added after a table was first created (create_all never alters existing tables)
MIGRATIONS = [
    "ALTER TABLE documents ADD COLUMN IF NOT EXISTS timeline jsonb NOT NULL DEFAULT '[]'",
    "ALTER TABLE documents ADD COLUMN IF NOT EXISTS fields jsonb NOT NULL DEFAULT '{}'",
    # Getting paid
    "ALTER TABLE records ADD COLUMN IF NOT EXISTS method varchar(30)",
]


def _engine_for(dbname: str | None = None):
    s = get_settings()
    dsn = s.admin_dsn if not dbname else s.admin_dsn.rsplit("/", 1)[0] + f"/{dbname}"
    return create_engine(dsn, isolation_level="AUTOCOMMIT")


def run() -> None:
    s = get_settings()
    app, vault_user = s.app_db_user, s.vault_db_user
    engine = _engine_for()
    Base.metadata.create_all(engine)
    with engine.connect() as c:
        for m in MIGRATIONS:
            c.execute(text(m))
        c.execute(text(VAULT_SQL))
        c.execute(text(f"GRANT USAGE ON SCHEMA public TO {app}"))
        c.execute(text(f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {app}"))
        c.execute(text(f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {app}"))
        # The activity log is append-only for the app
        c.execute(text(f"REVOKE UPDATE, DELETE ON audit_log FROM {app}"))
        # Only the vault account can touch personal details
        c.execute(text(f"REVOKE ALL ON SCHEMA vault FROM {app}"))
        c.execute(text(f"GRANT USAGE ON SCHEMA vault TO {vault_user}"))
        c.execute(text(f"GRANT SELECT, INSERT ON vault.pii_values TO {vault_user}"))
        for t in TENANT_TABLES:
            c.execute(text(f"ALTER TABLE {t} ENABLE ROW LEVEL SECURITY"))
            c.execute(text(f"ALTER TABLE {t} FORCE ROW LEVEL SECURITY"))
            c.execute(text(f"DROP POLICY IF EXISTS tenant ON {t}"))
            c.execute(text(
                f"CREATE POLICY tenant ON {t} "
                "USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid) "
                "WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid)"
            ))
    print(f"database ready: {len(Base.metadata.tables)} tables, row-level security on {len(TENANT_TABLES)}")


def ensure_database(name: str) -> None:
    """Create a separate database (used by the test suite) with the same roles and schema."""
    s = get_settings()
    with _engine_for("postgres").connect() as c:
        exists = c.execute(text("SELECT 1 FROM pg_database WHERE datname = :n"), {"n": name}).scalar()
        if not exists:
            c.execute(text(f'CREATE DATABASE "{name}" OWNER {s.postgres_user}'))
            c.execute(text(f'REVOKE ALL ON DATABASE "{name}" FROM PUBLIC'))
            c.execute(text(f'GRANT CONNECT ON DATABASE "{name}" TO {s.app_db_user}, {s.vault_db_user}'))
    with _engine_for(name).connect() as c:
        c.execute(text("REVOKE CREATE ON SCHEMA public FROM PUBLIC"))


if __name__ == "__main__":
    run()
