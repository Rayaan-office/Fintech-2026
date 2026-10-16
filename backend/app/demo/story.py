"""One consistent, fictional six-month history for the demo business (a small Leeds bakery
that supplies cafés). The bank feed, the QuickBooks company and the emailed bills are all
generated from this story, so every number lines up and can be matched.

Built-in patterns the app should find:
- Bright Cafe pays about 12 days late (slow payer).
- Station Coffee Co is about 35% of sales (reliance on one customer).
- Acme Supplies' flour price rose 18% this month (price rise), and its newest bill has
  changed bank details (fraud drill, sent separately).
- CloudDesk's subscription keeps creeping up (spending creep).
- VAT, payroll and rent land close together next month (forecast shortfall -> financing).
"""

import random
from dataclasses import dataclass, field
from datetime import date, timedelta

TODAY = date.today()
START = TODAY - timedelta(days=182)
OPENING_BALANCE = 6_000_00


@dataclass
class Party:
    name: str
    terms: int = 14
    late_days: int = 0
    jitter: int = 2
    email: str = ""


CUSTOMERS = [
    Party("Station Coffee Co", 14, 1, 2, "accounts@stationcoffee.example"),
    Party("Bright Cafe", 14, 12, 4, "hello@brightcafe.example"),
    Party("Corner Deli", 14, 0, 1, "orders@cornerdeli.example"),
    Party("Green Leaf Bistro", 14, 3, 3, "finance@greenleaf.example"),
    Party("Harrogate Grand Hotel", 30, 5, 5, "ap@harrogategrand.example"),
]
SUPPLIERS = {
    "acme": Party("Acme Supplies Ltd", 30, 0, 0, "accounts@acme-supplies.co.uk"),
    "energy": Party("BrightSpark Energy Ltd", 14, 0, 0, "billing@brightspark-energy.co.uk"),
    "software": Party("CloudDesk Software Ltd", 0, 0, 0, "invoices@clouddesk.io"),
    "packaging": Party("Packaging Direct Ltd", 30, 0, 0, "sales@packagingdirect.example"),
    "insurance": Party("Yorkshire Business Insurance Ltd", 21, 0, 0, "renewals@yorkshire-insure.example"),
    "repairs": Party("Oven Doctors Ltd", 14, 0, 0, "jobs@ovendoctors.example"),
}


@dataclass
class Invoice:
    customer: str
    number: str
    issue: date
    due: date
    lines: list[tuple[str, int, int]]
    paid_on: date | None = None

    @property
    def total(self) -> int:
        net = sum(q * p for _, q, p in self.lines)
        return net + round(net * 0.2)


@dataclass
class Bill:
    supplier_key: str
    number: str
    issue: date
    due: date
    lines: list[tuple[str, int, int]]
    paid_on: date | None = None

    @property
    def supplier(self) -> str:
        return SUPPLIERS[self.supplier_key].name

    @property
    def subtotal(self) -> int:
        return sum(q * p for _, q, p in self.lines)

    @property
    def total(self) -> int:
        return self.subtotal + round(self.subtotal * 0.2)


@dataclass
class BankLine:
    day: date
    amount: int  # positive = money in, pence
    description: str


@dataclass
class Story:
    invoices: list[Invoice] = field(default_factory=list)
    bills: list[Bill] = field(default_factory=list)
    bank: list[BankLine] = field(default_factory=list)
    upcoming: list[BankLine] = field(default_factory=list)  # known future payments (for reference only)


# Typical order value before VAT, in pounds
ORDER_SIZES = {
    "Station Coffee Co": (820, 980), "Bright Cafe": (300, 400), "Corner Deli": (210, 280),
    "Green Leaf Bistro": (260, 340), "Harrogate Grand Hotel": (700, 900),
}
PRODUCTS = [("Sourdough loaves", 420), ("Croissants (box of 12)", 1450), ("Seeded rye loaves", 460),
            ("Cinnamon buns (box of 12)", 1650)]


def build(seed: int = 2026) -> Story:
    rnd = random.Random(seed)
    s = Story()
    inv_no = 2001
    # ── Customer invoices: weekly for most, fortnightly for the hotel
    for cust in CUSTOMERS:
        step = 14 if cust.terms == 30 else 7
        d = START + timedelta(days=rnd.randint(0, 4))
        while d <= TODAY - timedelta(days=1):
            lo, hi = ORDER_SIZES[cust.name]
            target = rnd.randint(lo, hi) * 100
            (n1, p1), (n2, p2) = rnd.sample(PRODUCTS, 2)
            lines = [(n1, max(1, round(target * 0.6 / p1)), p1), (n2, max(1, round(target * 0.4 / p2)), p2)]
            inv = Invoice(cust.name, f"INV-{inv_no}", d, d + timedelta(days=cust.terms), lines)
            inv_no += 1
            # Bright Cafe is getting slower over time
            late = cust.late_days + (4 if cust.name == "Bright Cafe" and d > TODAY - timedelta(days=60) else 0)
            pay = inv.due + timedelta(days=late + rnd.randint(-cust.jitter, cust.jitter))
            if pay < TODAY:
                inv.paid_on = pay
                s.bank.append(BankLine(pay, inv.total, f"{cust.name.upper()} REF {inv.number}"))
            s.invoices.append(inv)
            d += timedelta(days=step)

    # ── Payments in the first weeks for invoices issued before the story starts
    old_no = 1960
    for week in range(3):
        for cust in CUSTOMERS[:4]:
            lo, hi = ORDER_SIZES[cust.name]
            day = START + timedelta(days=2 + week * 7 + rnd.randint(0, 3))
            s.bank.append(BankLine(day, round(rnd.randint(lo, hi) * 120), f"{cust.name.upper()} REF INV-{old_no}"))
            old_no += 1

    # ── Acme: weekly stock bills, price rise this month
    bill_no = 980
    d = START + timedelta(days=2)
    while d <= TODAY - timedelta(days=4):
        recent = d >= TODAY.replace(day=1)
        flour = 5310 if recent else 4500  # +18%
        b = Bill("acme", f"AS-{bill_no}", d, d + timedelta(days=30),
                 [("Strong white flour 25kg", rnd.randint(7, 9), flour), ("Free-range eggs (tray of 30)", 6, 750),
                  ("Unsalted butter 10kg", 1, 6400), ("Delivery", 1, 1500)])
        bill_no += 1
        if b.due < TODAY:
            b.paid_on = b.due
            s.bank.append(BankLine(b.due, -b.total, f"ACME SUPPLIES LTD {b.number}"))
        s.bills.append(b)
        d += timedelta(days=7)

    # ── Monthly: energy bill (creeping), software subscription (creeping), packaging
    month = date(START.year, START.month, 1)
    i = 0
    while month <= TODAY:
        issue = month + timedelta(days=4)
        if issue < TODAY:
            energy = Bill("energy", f"BSE-{5100 + i}", issue, issue + timedelta(days=14),
                          [("Electricity and gas", 1, 48000 + i * 2600)])
            s.bills.append(energy)
            if energy.due < TODAY:
                energy.paid_on = energy.due
                s.bank.append(BankLine(energy.due, -energy.total, "BRIGHTSPARK ENERGY DD"))
            soft = Bill("software", f"CD-{7700 + i}", month + timedelta(days=9), month + timedelta(days=9),
                        [("CloudDesk Business plan", 1, 4900 + i * 500)])
            if soft.issue < TODAY:
                soft.paid_on = soft.issue
                s.bills.append(soft)
                s.bank.append(BankLine(soft.issue, -soft.total, "CLOUDDESK SOFTWARE CARD"))
            pack = Bill("packaging", f"PD-{330 + i}", month + timedelta(days=12), month + timedelta(days=42),
                        [("Bread bags (1000)", 2, 6800), ("Pastry boxes (500)", 1, 9200)])
            if pack.issue < TODAY:
                s.bills.append(pack)
                if pack.due < TODAY:
                    pack.paid_on = pack.due
                    s.bank.append(BankLine(pack.due, -pack.total, f"PACKAGING DIRECT {pack.number}"))
        # Fixed outgoings straight from the bank
        for day, amount, desc in ((1, -2_200_00, "MILL PROPERTIES RENT"), (28, -6_850_00, "PAYROLL BACS"),
                                  (15, -420_00, "NORTHERN ASSET FINANCE VAN LOAN")):
            dd = month.replace(day=day)
            (s.bank if dd < TODAY else s.upcoming).append(BankLine(dd, amount, desc))
        month = (month + timedelta(days=32)).replace(day=1)
        i += 1

    # ── Two one-off bills that arrived this month and fall due soon
    s.bills.append(Bill("insurance", "YBI-2026-118", TODAY - timedelta(days=9), TODAY + timedelta(days=12),
                        [("Annual business insurance renewal", 1, 2_650_00)]))
    s.bills.append(Bill("repairs", "OD-4471", TODAY - timedelta(days=5), TODAY + timedelta(days=9),
                        [("Deck oven repair: heating element", 1, 1_240_00), ("Call-out and labour", 1, 310_00)]))

    # ── Quarterly VAT (7th of the month after each quarter end)
    for vat_day, amount in ((date(TODAY.year, 8, 7), -3_180_00), (date(TODAY.year, 11, 7), -4_980_00)):
        (s.bank if vat_day < TODAY else s.upcoming).append(BankLine(vat_day, amount, "HMRC VAT"))

    # ── Card sales: weekly payouts from the payment platform
    d = START + timedelta(days=3)
    n = 0
    while d < TODAY:
        s.bank.append(BankLine(d, rnd.randint(780_00, 1_380_00), f"STRIPE PAYMENTS UK PAYOUT {n:04d}"))
        d += timedelta(days=7)
        n += 1

    # ── Small everyday spending
    d = START
    while d < TODAY:
        if rnd.random() < 0.35:
            what = rnd.choice(["TESCO STORES", "SCREWFIX", "SHELL FUEL", "ROYAL MAIL", "AMAZON MKTPL"])
            s.bank.append(BankLine(d, -rnd.randint(8_00, 65_00), what))
        d += timedelta(days=1)

    s.bank.sort(key=lambda b: b.day)
    return s


def current_balance(story: Story) -> int:
    return OPENING_BALANCE + sum(b.amount for b in story.bank)
