"""Password storage (Argon2id) and two-step sign-in (TOTP authenticator apps)."""

import pyotp
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from .crypto import tokens

_ph = PasswordHasher()  # Argon2id with the library's recommended parameters

# A real hash of a random value, so unknown emails take as long as known ones
_DUMMY_HASH = _ph.hash("not-a-real-password-placeholder")

MIN_PASSWORD_LENGTH = 12


def hash_password(password: str) -> str:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"Passwords need at least {MIN_PASSWORD_LENGTH} characters.")
    return _ph.hash(password)


def verify_password(stored_hash: str | None, password: str) -> bool:
    try:
        return _ph.verify(stored_hash or _DUMMY_HASH, password) and stored_hash is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(stored_hash: str) -> bool:
    return _ph.check_needs_rehash(stored_hash)


def new_totp_secret() -> tuple[str, str]:
    """Returns (plain secret for the QR code, encrypted secret for storage)."""
    secret = pyotp.random_base32()
    return secret, tokens.seal_str(secret)


def totp_uri(secret: str, email: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name="SME Finance Copilot")


def verify_totp(secret_enc: str | None, code: str) -> bool:
    if not secret_enc or not code or not code.isdigit():
        return False
    try:
        return pyotp.TOTP(tokens.open_str(secret_enc)).verify(code, valid_window=1)
    except Exception:  # fail closed
        return False
