"""Settings, read from the project's .env file. Secrets never appear in code."""

from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")

    app_env: str = "development"
    app_base_url: str = "http://localhost:5173"
    api_base_url: str = "http://localhost:8000"
    # Where a phone opens the upload page from the QR code. Empty: the app's address, or in
    # development this computer's address on the Wi-Fi, since a phone can't reach "localhost"
    handoff_base_url: str | None = None

    session_secret: SecretStr
    pii_vault_key: SecretStr
    token_encryption_key: SecretStr
    audit_log_hmac_key: SecretStr
    archive_encryption_key: SecretStr

    # AI gateway
    openrouter_api_key: SecretStr
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    ai_model_primary: str
    ai_model_second_opinion: str
    ai_daily_budget_usd: float = 10.0
    ai_max_output_tokens: int = 2000
    ai_requests_per_business_per_hour: int = 300

    # Payment platform
    stripe_api_key: SecretStr
    stripe_seed_key: SecretStr | None = None
    stripe_webhook_secret: SecretStr
    # Optional second restricted key, only for card payment links in approved reminders
    stripe_links_key: SecretStr | None = None

    # Bank
    plaid_client_id: str
    plaid_secret: SecretStr
    plaid_env: str = "sandbox"
    plaid_products: str = "transactions"
    plaid_country_codes: str = "GB"
    # How often the background poller reads each connected bank (Plaid can't notify us without a public address)
    bank_poll_minutes: int = 15
    books_poll_minutes: int = 10
    scheduler_enabled: bool = True

    # Accounting software
    qbo_client_id: str
    qbo_client_secret: SecretStr
    qbo_environment: str = "sandbox"
    qbo_scopes: str = "com.intuit.quickbooks.accounting"
    qbo_redirect_uri: str = "http://localhost:8000/connect/quickbooks/callback"
    qbo_webhook_verifier_token: SecretStr | None = None

    # Email inbox
    mailpit_api_url: str = "http://localhost:8025"
    mailpit_smtp_host: str = "localhost"
    mailpit_smtp_port: int = 1025
    bills_inbox_address: str = "bills@demo-business.test"
    # We trust only the Authentication-Results header our own receiving server adds
    mail_authserv_id: str = "mx.copilot.test"
    email_max_bytes: int = 25 * 1024 * 1024
    emails_per_business_per_hour: int = 200

    # Database
    postgres_db: str = "copilot"
    postgres_user: str = "copilot"
    postgres_password: SecretStr
    app_db_user: str = "copilot_app"
    app_db_password: SecretStr
    vault_db_user: str = "pii_vault"
    vault_db_password: SecretStr
    db_host: str = "localhost"
    db_port: int = 5432

    # File archive
    archive_s3_endpoint: str = "http://localhost:8333"
    archive_s3_access_key: str
    archive_s3_secret_key: SecretStr
    archive_bucket: str = "evidence"

    # Limits
    upload_max_bytes: int = 15 * 1024 * 1024
    upload_max_pages: int = 20
    session_idle_minutes: int = 30
    session_absolute_hours: int = 12
    outbound_timeout_seconds: float = 20.0

    @property
    def is_dev(self) -> bool:
        return self.app_env == "development"

    def _dsn(self, user: str, password: SecretStr) -> str:
        return (
            f"postgresql+psycopg://{user}:{password.get_secret_value()}"
            f"@{self.db_host}:{self.db_port}/{self.postgres_db}"
        )

    @property
    def admin_dsn(self) -> str:
        """Owner account, used only for setting up tables."""
        return self._dsn(self.postgres_user, self.postgres_password)

    @property
    def app_dsn(self) -> str:
        """Runtime account; row-level security always applies."""
        return self._dsn(self.app_db_user, self.app_db_password)

    @property
    def vault_dsn(self) -> str:
        """The only account that can read the personal-detail store."""
        return self._dsn(self.vault_db_user, self.vault_db_password)


@lru_cache
def get_settings() -> Settings:
    return Settings()
