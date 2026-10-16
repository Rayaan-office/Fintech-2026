"""Personal details are replaced before text reaches the AI, and ordinary figures are kept."""

import pytest

from app.privacy.redact import PrivacyBlock, final_scan, mask, redact, restore

SENSITIVE = [
    ("Card 4242 4242 4242 4242", "CARD"),
    ("Card 4000-0566-5566-5556", "CARD"),
    ("IBAN GB29NWBK60161331926819", "BANK_ACCOUNT"),
    ("IBAN DE89 3704 0044 0532 0130 00", "BANK_ACCOUNT"),
    ("sort code 20-00-00", "SORT_CODE"),
    ("Account number: 55779911", "BANK_ACCOUNT"),
    ("Sort 40 47 84 Acc 70872490", "BANK_ACCOUNT"),
    ("routing 021000021", "ROUTING_NUMBER"),
    ("VAT reg GB 980 7806 84", "TAX_ID"),
    ("NI number QQ 12 34 56 C", "NI_NUMBER"),
    ("UTR 12345 67890", "TAX_ID"),
    ("Company No. 08123456", "COMPANY_ID"),
    ("email jane.smith@acme.co.uk", "EMAIL"),
    ("call +44 7700 900123", "PHONE"),
    ("call 0113 496 0000", "PHONE"),
    ("see https://pay.acme-invoices.com/x?id=1", "WEB_LINK"),
    ("from 10.0.0.12", "IP_ADDRESS"),
    ("Leeds LS1 4AB", "POSTCODE"),
    ("22 High Street", "ADDRESS"),
    ("Contact Jane Smith today", "PERSON"),
]


@pytest.mark.parametrize("text,kind", SENSITIVE)
def test_sensitive_detail_is_replaced(text, kind):
    r = redact(text)
    assert f"[{kind}_1]" in r.text, r.text
    final_scan(r.text)


KEPT = [
    "Total £1,240.00",
    "Due 30/10/2026",
    "Issued 2026-10-01",
    "Invoice INV-1043",
    "Order 12345678",
    "Qty 10 x £45.00 = £450.00",
    "VAT (20%) £98.00",
    "Acme Supplies Ltd",
    "Bill to: Demo Business Ltd",
]


@pytest.mark.parametrize("text", KEPT)
def test_ordinary_figures_are_kept(text):
    assert redact(text).text == text


def test_non_checksum_numbers_are_not_cards():
    assert "[CARD" not in redact("Ref 1234 5678 9012 3456").text


def test_same_value_gets_same_placeholder():
    r = redact("Pay GB29NWBK60161331926819 (IBAN GB29 NWBK 6016 1331 9268 19)")
    assert r.text.count("[BANK_ACCOUNT_1]") == 2


def test_final_scan_blocks_leftovers():
    with pytest.raises(PrivacyBlock) as e:
        final_scan("Send to IBAN GB29NWBK60161331926819")
    assert e.value.kinds == ["BANK_ACCOUNT"]


def test_restore_puts_values_back():
    r = redact("Supplier contact jane@acme.co.uk")
    real = {ph: v for ph, (_, v) in r.values.items()}
    assert restore({"email": "[EMAIL_1]"}, real) == {"email": "jane@acme.co.uk"}


def test_mask_shows_last_four():
    assert mask("BANK_ACCOUNT", "GB29NWBK60161331926819") == "••••6819"
