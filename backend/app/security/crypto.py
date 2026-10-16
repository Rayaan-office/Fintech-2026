"""Encryption helpers (AES-256-GCM) and keyed fingerprints (HMAC-SHA256).

Each purpose has its own key from the environment, so one leaked key does not open everything.
"""

import base64
import hashlib
import hmac
import os
import secrets

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from ..config import get_settings

_s = get_settings()


def _key(secret: str) -> bytes:
    raw = base64.b64decode(secret)
    if len(raw) != 32:
        raise ValueError("encryption keys must be 32 bytes")
    return raw


class Box:
    """Encrypts small values and files. Output is versioned: b'v1' + nonce + ciphertext."""

    def __init__(self, secret: str, purpose: bytes):
        self._aes = AESGCM(_key(secret))
        self._aad = purpose

    def seal(self, data: bytes) -> bytes:
        nonce = os.urandom(12)
        return b"v1" + nonce + self._aes.encrypt(nonce, data, self._aad)

    def open(self, blob: bytes) -> bytes:
        if blob[:2] != b"v1":
            raise ValueError("unknown ciphertext version")
        return self._aes.decrypt(blob[2:14], blob[14:], self._aad)

    def seal_str(self, value: str) -> str:
        return base64.urlsafe_b64encode(self.seal(value.encode())).decode()

    def open_str(self, value: str) -> str:
        return self.open(base64.urlsafe_b64decode(value)).decode()


tokens = Box(_s.token_encryption_key.get_secret_value(), b"connection-token")
vault = Box(_s.pii_vault_key.get_secret_value(), b"pii-vault")
archive = Box(_s.archive_encryption_key.get_secret_value(), b"evidence-archive")
layout = Box(_s.pii_vault_key.get_secret_value(), b"document-layout")


def fingerprint(value: str, purpose: str = "pii") -> str:
    """Keyed fingerprint, used to compare sensitive values without storing them."""
    key = _s.audit_log_hmac_key.get_secret_value().encode()
    return hmac.new(key, f"{purpose}:{value}".encode(), hashlib.sha256).hexdigest()


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def new_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()
