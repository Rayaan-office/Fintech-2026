"""The lender pack: one PDF with the business profile, 12 months of profit and loss, unpaid
invoices, the cash forecast and the readiness checklist. Every figure comes from our records.

Sharing it is an outside action that needs the owner's approval (see handlers.py).
"""

import io
from datetime import date

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from sqlalchemy.orm import Session

from . import financing, forecast, health, ledger

INK = colors.HexColor("#1f2937")
RULE = colors.HexColor("#d1d5db")
SOFT = colors.HexColor("#f3f4f6")


def _m(minor) -> str:
    if minor is None:
        return "–"
    return ("-" if minor < 0 else "") + f"£{abs(minor) / 100:,.2f}"


def _table(rows: list[list], widths: list[float], money_cols: tuple = ()) -> Table:
    t = Table(rows, colWidths=[w * mm for w in widths], repeatRows=1)
    style = [("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9), ("FONT", (0, 1), (-1, -1), "Helvetica", 9),
             ("TEXTCOLOR", (0, 0), (-1, -1), INK), ("LINEBELOW", (0, 0), (-1, 0), 0.6, RULE),
             ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, SOFT]),
             ("VALIGN", (0, 0), (-1, -1), "TOP"), ("TOPPADDING", (0, 0), (-1, -1), 3),
             ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]
    style += [("ALIGN", (c, 0), (c, -1), "RIGHT") for c in money_cols]
    t.setStyle(TableStyle(style))
    return t


def facts(db: Session, today: date | None = None) -> dict:
    """Everything the pack shows, as data (also used for the confirmation card)."""
    today = today or date.today()
    biz = ledger.business(db)
    prof = financing.profile(db, today)
    pnl = health.profit_and_loss(db, today, count=12)
    invoices, _ = ledger.open_items(db, "invoice")
    names, terms = ledger.names(db), ledger.terms(db)
    fc = forecast.build(db, today)
    return {"business": biz.name, "currency": biz.currency, "today": today, "profile": prof,
            "pnl": pnl,
            "invoices": sorted(({"customer": names.get(r.counterparty_id) or "Customer", "reference": r.reference or "",
                                 "due": ledger.due(r, terms), "open_minor": r.open_minor,
                                 "days_overdue": max(0, (today - ledger.due(r, terms)).days)} for r in invoices),
                               key=lambda x: x["due"]),
            "forecast": {"balance_minor": fc["balance_minor"], "horizons": fc["horizons"], "lowest": fc["lowest"],
                         "safety_level_minor": fc["safety_level_minor"]},
            "readiness": financing.readiness(db, prof["values"])}


def build_pdf(db: Session, today: date | None = None) -> tuple[bytes, dict]:
    f = facts(db, today)
    styles = getSampleStyleSheet()
    h1, h2, body = styles["Title"], styles["Heading2"], styles["BodyText"]
    small = styles["BodyText"].clone("small", fontSize=8, textColor=colors.HexColor("#6b7280"))
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=16 * mm, rightMargin=16 * mm, topMargin=16 * mm,
                            bottomMargin=16 * mm, title=f"Lender pack: {f['business']}", author=f["business"])
    out = [Paragraph(f"Lender pack: {f['business']}", h1),
           Paragraph(f"Prepared on {f['today']:%-d %B %Y} from the business's own records. Amounts in "
                     f"{f['currency']}.", body), Spacer(1, 4 * mm)]

    v = f["profile"]["values"]
    out.append(Paragraph("Business profile", h2))
    rows = [["Detail", "Value"]]
    for fld in f["profile"]["fields"]:
        val = fld["value"]
        if fld["field"].endswith("_minor"):
            val = _m(val)
        elif fld["field"] in ("card_share", "overdue_share"):
            val = f"{(val or 0) * 100:.0f}%"
        elif fld["field"] == "sales_trend_pct":
            val = "Not enough history yet" if val is None else f"{val:+.1f}%"
        elif val is None:
            val = "–"
        rows.append([fld["label"] + (" (corrected by the owner)" if fld["corrected"] else ""), str(val)])
    for k in ("country", "industry", "business_type", "purpose"):
        if v.get(k):
            rows.append([k.replace("_", " ").capitalize(), str(v[k]).replace("_", " ")])
    out += [_table(rows, [110, 68]), Spacer(1, 4 * mm)]

    out.append(Paragraph("Profit and loss by month (before VAT)", h2))
    rows = [["Month", "Sales", "Costs", "Profit", "Margin"]]
    for m in f["pnl"]:
        rows.append([m["label"], _m(m["sales_minor"]), _m(m["costs_minor"]), _m(m["profit_minor"]),
                     "–" if m["margin_pct"] is None else f"{m['margin_pct']:.1f}%"])
    out += [_table(rows, [46, 34, 34, 34, 30], money_cols=(1, 2, 3, 4)),
            Paragraph("Months marked “part” are only partly covered by our records.", small), Spacer(1, 4 * mm)]

    out.append(Paragraph("Unpaid invoices", h2))
    rows = [["Customer", "Invoice", "Due", "Days overdue", "Unpaid"]]
    for i in f["invoices"][:60]:
        rows.append([i["customer"][:40], i["reference"][:20], f"{i['due']:%-d %b %Y}", str(i["days_overdue"] or "–"),
                     _m(i["open_minor"])])
    rows.append(["Total", "", "", "", _m(sum(i["open_minor"] for i in f["invoices"]))])
    out += [_table(rows, [62, 30, 30, 24, 32], money_cols=(3, 4)), Spacer(1, 4 * mm)]

    fc = f["forecast"]
    out.append(Paragraph("Cash forecast", h2))
    low = date.fromisoformat(fc["lowest"]["date"])
    rows = [["", "Expected cash"], ["Today", _m(fc["balance_minor"])]]
    rows += [[f"In {n} days", _m(fc["horizons"][n])] for n in ("30", "60", "90")]
    rows += [[f"Lowest point ({low:%-d %b %Y})", _m(fc["lowest"]["balance_minor"])],
             ["Safety level", _m(fc["safety_level_minor"])]]
    out += [_table(rows, [110, 68], money_cols=(1,)), Spacer(1, 4 * mm)]

    out.append(Paragraph("What a lender usually looks at", h2))
    rows = [["Check", "Now", ""]] + [[r["label"], r["value"], "Good" if r["ok"] else "Could improve"]
                                     for r in f["readiness"]]
    out += [_table(rows, [74, 74, 30]), Spacer(1, 6 * mm),
            Paragraph("This pack is information prepared from the business's records. It is not a credit "
                      "assessment or financial advice.", small)]
    doc.build(out)
    return buf.getvalue(), f
