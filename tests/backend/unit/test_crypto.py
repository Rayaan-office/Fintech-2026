import pytest

from app.security.crypto import archive, fingerprint, tokens, vault
from app.security.http import csv_safe
from app.security.passwords import hash_password, verify_password


def test_box_round_trip_and_purpose_separation():
    sealed = tokens.seal_str("access-sandbox-123")
    assert tokens.open_str(sealed) == "access-sandbox-123"
    with pytest.raises(Exception):
        vault.open_str(sealed)  # a different purpose cannot open it


def test_archive_encrypts_files():
    blob = archive.seal(b"%PDF-1.7 hello")
    assert b"hello" not in blob and archive.open(blob) == b"%PDF-1.7 hello"


def test_fingerprint_is_stable_and_keyed():
    assert fingerprint("GB29NWBK60161331926819") == fingerprint("GB29NWBK60161331926819")
    assert fingerprint("a", "bank") != fingerprint("a", "email")


def test_passwords_use_argon2_and_need_length():
    h = hash_password("a-long-enough-password")
    assert h.startswith("$argon2id$") and verify_password(h, "a-long-enough-password")
    assert not verify_password(h, "wrong")
    with pytest.raises(ValueError):
        hash_password("short")


@pytest.mark.parametrize("cell", ["=1+1", "+cmd", "-2+3", "@SUM(A1)"])
def test_spreadsheet_formulas_are_neutralised(cell):
    assert csv_safe(cell).startswith("'")
