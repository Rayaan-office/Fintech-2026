"""Realistic sample bills and receipts for the demo and the tests (all details are fictional)."""

import io
from dataclasses import dataclass, field
from datetime import date, timedelta

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas


@dataclass
class Supplier:
    name: str
    address: list[str]
    email: str
    phone: str
    sort_code: str
    account: str
    vat: str
    company_no: str
    contact: str


@dataclass
class Bill:
    supplier: Supplier
    number: str
    issue: date
    due: date
    lines: list[tuple[str, int, int]]  # description, quantity, unit price in pence
    vat_rate: int = 20
    note: str = ""
    bill_to: list[str] = field(default_factory=lambda: ["Demo Business Ltd", "1 Market Street", "Leeds LS2 7HY"])

    @property
    def subtotal(self) -> int:
        return sum(q * p for _, q, p in self.lines)

    @property
    def vat(self) -> int:
        return round(self.subtotal * self.vat_rate / 100)

    @property
    def total(self) -> int:
        return self.subtotal + self.vat


ACME = Supplier("Acme Supplies Ltd", ["Unit 4, Mill Lane", "Leeds LS9 8AB"], "accounts@acme-supplies.co.uk",
                "0113 496 0123", "20-45-77", "41236587", "GB 980 7806 84", "08123456", "Jane Smith")
ACME_NEW_BANK = Supplier("Acme Supplies Ltd", ["22 High Street", "Leeds LS1 4AB"], "accounts@acme-suppl1es.co.uk",
                         "0113 496 0999", "30-90-12", "77881234", "GB 980 7806 84", "08123456", "Jane Smith")
BRIGHTSPARK = Supplier("BrightSpark Energy Ltd", ["Energy House, 9 Station Road", "Manchester M1 2AB"],
                       "billing@brightspark-energy.co.uk", "0161 496 0456", "40-11-62", "90817263",
                       "GB 123 4567 89", "09876543", "Tom Baker")
CLOUDDESK = Supplier("CloudDesk Software Ltd", ["5 Silicon Way", "London EC2A 4NE"], "invoices@clouddesk.io",
                     "020 7946 0321", "60-16-13", "31926819", "GB 246 8024 68", "11223344", "Priya Shah")


def _money(p: int) -> str:
    return f"£{p / 100:,.2f}"


def render(b: Bill) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    w, h = A4
    s = b.supplier
    c.setFont("Helvetica-Bold", 18)
    c.drawString(20 * mm, h - 25 * mm, s.name)
    c.setFont("Helvetica", 9)
    y = h - 31 * mm
    for line in [*s.address, f"{s.email}  ·  {s.phone}", f"VAT reg: {s.vat}  ·  Company No. {s.company_no}"]:
        c.drawString(20 * mm, y, line)
        y -= 4.5 * mm
    c.setFont("Helvetica-Bold", 22)
    c.setFillColor(colors.HexColor("#333333"))
    c.drawRightString(w - 20 * mm, h - 25 * mm, "INVOICE")
    c.setFont("Helvetica", 10)
    c.drawRightString(w - 20 * mm, h - 32 * mm, f"Invoice no: {b.number}")
    c.drawRightString(w - 20 * mm, h - 37 * mm, f"Date: {b.issue:%d/%m/%Y}")
    c.drawRightString(w - 20 * mm, h - 42 * mm, f"Due date: {b.due:%d/%m/%Y}")
    y = h - 62 * mm
    c.setFont("Helvetica-Bold", 10)
    c.drawString(20 * mm, y, "Bill to")
    c.setFont("Helvetica", 10)
    for line in b.bill_to:
        y -= 5 * mm
        c.drawString(20 * mm, y, line)
    y -= 14 * mm
    c.setFont("Helvetica-Bold", 10)
    for x, t in ((20, "Description"), (120, "Qty"), (140, "Unit price"), (170, "Amount")):
        c.drawString(x * mm, y, t)
    c.line(20 * mm, y - 2 * mm, w - 20 * mm, y - 2 * mm)
    c.setFont("Helvetica", 10)
    for desc, q, price in b.lines:
        y -= 7 * mm
        c.drawString(20 * mm, y, desc)
        c.drawString(120 * mm, y, str(q))
        c.drawString(140 * mm, y, _money(price))
        c.drawString(170 * mm, y, _money(q * price))
    y -= 12 * mm
    for label, val in (("Subtotal", b.subtotal), (f"VAT ({b.vat_rate}%)", b.vat), ("Total due", b.total)):
        c.setFont("Helvetica-Bold" if label == "Total due" else "Helvetica", 10)
        c.drawString(140 * mm, y, label)
        c.drawString(170 * mm, y, _money(val))
        y -= 6 * mm
    y -= 10 * mm
    c.setFont("Helvetica-Bold", 10)
    c.drawString(20 * mm, y, "Payment details")
    c.setFont("Helvetica", 10)
    for line in (f"Bank transfer to {s.name}", f"Sort code: {s.sort_code}   Account number: {s.account}",
                 f"Please quote {b.number} as the reference.", f"Questions? Contact {s.contact} on {s.phone}."):
        y -= 5 * mm
        c.drawString(20 * mm, y, line)
    if b.note:
        y -= 10 * mm
        c.setFont("Helvetica-Bold", 10)
        c.setFillColor(colors.HexColor("#B42318"))
        c.drawString(20 * mm, y, b.note)
    c.showPage()
    c.save()
    return buf.getvalue()


def acme_bill(number: str = "INV-1043", issue: date | None = None, flour_price: int = 4500) -> Bill:
    issue = issue or date.today() - timedelta(days=3)
    return Bill(ACME, number, issue, issue + timedelta(days=30),
                [("Strong white flour 25kg", 8, flour_price), ("Free-range eggs (tray of 30)", 6, 750),
                 ("Delivery", 1, 1500)])


def acme_fraud_bill(issue: date | None = None) -> Bill:
    issue = issue or date.today() - timedelta(days=1)
    return Bill(ACME_NEW_BANK, "INV-1051", issue, issue + timedelta(days=7),
                [("Strong white flour 25kg", 8, 4500), ("Free-range eggs (tray of 30)", 6, 750), ("Delivery", 1, 1500)],
                note="URGENT: we have changed our bank details. Please pay the new account immediately.")
