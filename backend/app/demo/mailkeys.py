"""Email signing keys for the fictional domains in our demo and tests (never used in production).

Real domains publish their DKIM key in DNS. Our demo domains don't exist, so outside
production our sender check answers those lookups from keys kept in backend/.local
(git-ignored, created on first use). A domain without a key file behaves like a domain
that doesn't sign its email.
"""

import base64
import os
import re
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

KEY_DIR = Path(__file__).resolve().parents[2] / ".local" / "demo-dkim"
SELECTOR = "demo"
_DOMAIN = re.compile(r"^[a-z0-9-]+(\.[a-z0-9-]+)+$")
_NAME = re.compile(rb"^([a-z0-9-]+)\._domainkey\.([a-z0-9.-]+?)\.?$", re.I)


def _path(domain: str) -> Path:
    domain = domain.lower()
    if not _DOMAIN.match(domain):
        raise ValueError("not a domain name")
    return KEY_DIR / f"{domain}.pem"


def private_key(domain: str) -> bytes:
    """The domain's signing key (PEM), created the first time it is needed."""
    path = _path(domain)
    if path.exists():
        return path.read_bytes()
    KEY_DIR.mkdir(parents=True, exist_ok=True)
    pem = rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption())
    tmp = path.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_bytes(pem)
    tmp.chmod(0o600)
    try:
        os.link(tmp, path)  # fails if another process created it first; theirs wins
    except FileExistsError:
        pass
    finally:
        tmp.unlink(missing_ok=True)
    return path.read_bytes()


def txt_record(name: bytes, timeout: int = 5) -> bytes | None:
    """Answers a DKIM key lookup (selector._domainkey.domain) for demo domains only."""
    m = _NAME.match(name)
    if not m or m.group(1).decode().lower() != SELECTOR:
        return None
    try:
        path = _path(m.group(2).decode())
    except ValueError:
        return None
    if not path.exists():
        return None
    key = serialization.load_pem_private_key(path.read_bytes(), password=None)
    der = key.public_key().public_bytes(serialization.Encoding.DER,
                                        serialization.PublicFormat.SubjectPublicKeyInfo)
    return b"v=DKIM1; k=rsa; p=" + base64.b64encode(der)
