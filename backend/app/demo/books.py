"""Fill the QuickBooks sandbox company with the story's books, so they line up with the bank feed
and the emailed bills.

    uv run python -m app.demo.books          # adds whatever is missing; safe to run again

Connect the demo business to a UK QuickBooks sandbox company first (Connections page, Accounting
software). Invoices, bills and payments are backdated to their story dates. The bills the demo
sends by email are left out: they reach QuickBooks only after someone approves them.
"""

import sys
from datetime import date

from sqlalchemy import select

from ..connectors import quickbooks
from ..connectors.quickbooks import Books, QBOError, _pounds, _q, tax_code
from ..db import global_session, tenant_session
from ..models import ConnectionRoute
from . import emails, story

BATCH = 30  # QuickBooks takes at most 30 operations per batch
# Supplier -> the expense account its bills go to (found by name, made if missing)
EXPENSE = {"acme": ("Cost of sales", "Cost of Goods Sold", "SuppliesMaterialsCogs"),
           "energy": ("Utilities", "Expense", "Utilities"),
           "software": ("Software subscriptions", "Expense", "OfficeGeneralAdministrativeExpenses"),
           "packaging": ("Packaging", "Cost of Goods Sold", "SuppliesMaterialsCogs"),
           "insurance": ("Insurance", "Expense", "Insurance"),
           "repairs": ("Repair and maintenance", "Expense", "RepairMaintenance")}


def _find_or_make(books: Books, entity: str, name: str, body: dict, field: str = "Name") -> str:
    found = books.query(entity, f" where {field} = '{_q(name)}'")
    if found:
        return found[0]["Id"]
    return books.call("POST", entity.lower(), json_body={field: name, **body})[entity]["Id"]


def _account(books: Books, name: str, kind: str, subtype: str) -> str:
    """The account with this name (or, failing that, one whose name contains it), made if missing."""
    same_type = [a for a in books.query("Account") if a.get("AccountType") == kind]
    for exact in (True, False):
        for a in same_type:
            have = str(a.get("Name", "")).lower()
            if have == name.lower() if exact else name.lower() in have:
                return a["Id"]
    return books.call("POST", "account", json_body={"Name": name, "AccountType": kind,
                                                     "AccountSubType": subtype})["Account"]["Id"]


def _term(books: Books, days: int) -> str:
    for t in books.query("Term"):
        if t.get("DueDays") == days and t.get("Active", True):
            return t["Id"]
    name = f"Net {days}" if days else "Due on receipt"
    return books.call("POST", "term", json_body={"Name": name, "DueDays": days})["Term"]["Id"]


def _batch(books: Books, entity: str, bodies: list[dict]) -> list[dict]:
    """Create many at once. Returns what QuickBooks made; stops on the first refusal."""
    made = []
    for i in range(0, len(bodies), BATCH):
        items = [{"bId": str(n), "operation": "create", entity: b} for n, b in enumerate(bodies[i:i + BATCH])]
        resp = books.call("POST", "batch", json_body={"BatchItemRequest": items})
        for item in resp.get("BatchItemResponse", []):
            if "Fault" in item:
                err = (item["Fault"].get("Error") or [{}])[0]
                raise QBOError(str(err.get("code")), f"{entity}: {err.get('Detail') or err.get('Message')}")
            made.append(item[entity])
    return made


def _iso(d: date) -> str:
    return d.isoformat()


def fill(books: Books) -> dict:
    co = books.company()
    if co["country"] not in ("GB", "UK") or co["currency"] != "GBP":
        raise QBOError("NOT_UK", f"company is {co['country'] or 'unknown'} / {co['currency']}")
    s = story.build()
    emailed = {b.number for b in emails.emailed_bills(s).values()}
    vat = 20  # every story line is standard rate
    sales_code = tax_code(books, 100, vat, side="Sales")
    buy_code = tax_code(books, 100, vat)

    income = _account(books, "Sales", "Income", "SalesOfProductIncome")
    bank = _account(books, "Business Current Account", "Bank", "Checking")
    expense = {k: _account(books, *v) for k, v in EXPENSE.items()}

    customers = {}
    for c in story.CUSTOMERS:
        customers[c.name] = _find_or_make(books, "Customer", c.name, {
            "PrimaryEmailAddr": {"Address": c.email}, "SalesTermRef": {"value": _term(books, c.terms)}},
            field="DisplayName")
    vendors = {}
    for key, v in story.SUPPLIERS.items():
        vendors[key] = _find_or_make(books, "Vendor", v.name, {
            "PrimaryEmailAddr": {"Address": v.email}, "TermRef": {"value": _term(books, v.terms)}},
            field="DisplayName")
    items = {name: _find_or_make(books, "Item", name, {"Type": "Service", "IncomeAccountRef": {"value": income},
                                                       "UnitPrice": _pounds(price)})
             for name, price in story.PRODUCTS}

    have_inv = {r.get("DocNumber"): r["Id"] for r in books.query("Invoice")}
    new = [inv for inv in s.invoices if inv.number not in have_inv]
    made = _batch(books, "Invoice", [{
        "DocNumber": inv.number, "TxnDate": _iso(inv.issue), "DueDate": _iso(inv.due),
        "CustomerRef": {"value": customers[inv.customer]}, "GlobalTaxCalculation": "TaxExcluded",
        "Line": [{"DetailType": "SalesItemLineDetail", "Amount": _pounds(q * p), "Description": name,
                  "SalesItemLineDetail": {"ItemRef": {"value": items[name]}, "Qty": q, "UnitPrice": _pounds(p),
                                          "TaxCodeRef": {"value": sales_code}}} for name, q, p in inv.lines],
        "TxnTaxDetail": {"TotalTax": _pounds(inv.total - sum(q * p for _, q, p in inv.lines))},
    } for inv in new])
    have_inv.update({m["DocNumber"]: m["Id"] for m in made})
    totals_off = [m["DocNumber"] for m, inv in zip(made, new, strict=True)
                  if quickbooks._pence(m.get("TotalAmt")) != inv.total]

    have_bill = {r.get("DocNumber"): r["Id"] for r in books.query("Bill")}
    new_bills = [b for b in s.bills if b.number not in have_bill and b.number not in emailed]
    made_bills = _batch(books, "Bill", [{
        "DocNumber": b.number, "TxnDate": _iso(b.issue), "DueDate": _iso(b.due),
        "VendorRef": {"value": vendors[b.supplier_key]}, "GlobalTaxCalculation": "TaxExcluded",
        "Line": [{"DetailType": "AccountBasedExpenseLineDetail", "Amount": _pounds(q * p), "Description": name,
                  "AccountBasedExpenseLineDetail": {"AccountRef": {"value": expense[b.supplier_key]},
                                                    "TaxCodeRef": {"value": buy_code}}} for name, q, p in b.lines],
        "TxnTaxDetail": {"TotalTax": _pounds(b.total - b.subtotal)},
    } for b in new_bills])
    have_bill.update({m["DocNumber"]: m["Id"] for m in made_bills})
    totals_off += [m["DocNumber"] for m, b in zip(made_bills, new_bills, strict=True)
                   if quickbooks._pence(m.get("TotalAmt")) != b.total]

    paid_in = {r.get("PaymentRefNum") for r in books.query("Payment")}
    payments = _batch(books, "Payment", [{
        "CustomerRef": {"value": customers[inv.customer]}, "TotalAmt": _pounds(inv.total), "TxnDate": _iso(inv.paid_on),
        "PaymentRefNum": inv.number, "DepositToAccountRef": {"value": bank},
        "Line": [{"Amount": _pounds(inv.total), "LinkedTxn": [{"TxnId": have_inv[inv.number], "TxnType": "Invoice"}]}],
    } for inv in s.invoices if inv.paid_on and inv.number not in paid_in])

    paid_out = {r.get("DocNumber") for r in books.query("BillPayment")}
    bill_payments = _batch(books, "BillPayment", [{
        "VendorRef": {"value": vendors[b.supplier_key]}, "PayType": "Check", "TotalAmt": _pounds(b.total),
        "TxnDate": _iso(b.paid_on), "DocNumber": f"P-{b.number}"[:21], "CheckPayment": {"BankAccountRef": {"value": bank}},
        "Line": [{"Amount": _pounds(b.total), "LinkedTxn": [{"TxnId": have_bill[b.number], "TxnType": "Bill"}]}],
    } for b in s.bills if b.paid_on and b.number in have_bill and f"P-{b.number}"[:21] not in paid_out])

    return {"invoices": len(made), "bills": len(made_bills), "payments_in": len(payments),
            "payments_out": len(bill_payments), "left_for_email": sorted(emailed), "totals_off": totals_off}


def main() -> None:
    with global_session() as db:
        bids = sorted({r for r in db.execute(select(ConnectionRoute.business_id)
                                             .where(ConnectionRoute.kind == "quickbooks")).scalars()}, key=str)
    if len(bids) != 1:
        sys.exit("Connect exactly one business to a QuickBooks sandbox company first.")
    try:
        with tenant_session(bids[0]) as db:
            out = fill(Books(db, bids[0]))
    except QBOError as e:
        sys.exit(f"QuickBooks refused: {e.for_person()} ({e})")
    print(out)


if __name__ == "__main__":
    main()
