"""Sync Nepal Rastra Bank's monthly "Banking & Financial Statistics" into data/nrb/financials.json.

NRB lists each month at https://www.nrb.org.np/category/monthly-statistics/?department=bfr .
Each entry redirects to a PDF; the same file is published as .xlsx next to it. From the
workbook we read, for the 20 commercial banks:
  C8  statement of assets and liabilities
  C9  profit and loss (fiscal year to date)
  C10 loans by sector, product and collateral
Banks are found by column name and items by row label, so added or removed institutions
don't shift anything. Every month is checked before it is kept (see validate()).

Usage:
  python scripts/nrb_sync.py                 # add any new months (keeps the last --months)
  python scripts/nrb_sync.py --months 24     # how many months of history to keep (default 24)
  python scripts/nrb_sync.py --rebuild       # re-read every month, e.g. after adding fields

Exit status 1 when the newest month NRB lists cannot be read or fails a check, so a
scheduled run is reported as failed and nothing wrong is published.
"""
import argparse
import io
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from html import unescape
from pathlib import Path

import openpyxl

LIST_URL = "https://www.nrb.org.np/category/monthly-statistics/{page}?department=bfr"
OUT = Path(__file__).resolve().parent.parent / "data" / "nrb" / "financials.json"
UA = "bank-tulana-sync/1.0 (+https://github.com/aayushmsd2026-bit/bank-rate-comparision)"

# NRB column name -> BankByaj institute_code used by the site.
BANKS = {
    "NBL": "Nepal Bank", "RBB": "RBB", "NABIL": "Nabil Bank", "NIMB": "NIMB", "SCBNL": "SCB",
    "HBL": "Himalayan", "NSBI": "Nepal SBI", "EBL": "Everest Bank", "NIC": "NIC Asia",
    "MBL": "Machhapuchhre", "Kumari": "Kumari Bank", "Laxmi": "Laxmi Sunrise", "SBL": "Siddhartha",
    "ADBNL": "Krishi Bikas", "Global": "Global IME", "Citizen": "Citizens Bank", "Prime": "Prime Bank",
    "NMB": "NMB Bank", "Prabhu": "Prabhu Bank", "Sanima": "Sanima Bank",
}

# field -> (sheet, row label). Amounts are Rs million in the source.
FIELDS = {
    "total_assets": ("C8", "TOTAL ASSETS"),
    "total_liabilities": ("C8", "TOTAL Liabilities"),
    "capital_fund": ("C8", "CAPITAL FUND"),
    "paid_up_capital": ("C8", "a. Paid-up Capital"),
    "borrowings": ("C8", "BORROWINGS"),
    "deposits": ("C8", "DEPOSITS"),
    "dep_current": ("C8", "a. Current"),
    "dep_savings": ("C8", "b. Savings"),
    "dep_fixed": ("C8", "c. Fixed"),
    "dep_call": ("C8", "d. Call Deposits"),
    "loan_loss_provision": ("C8", "2. Loan Loss Provision"),
    "liquid_funds": ("C8", "LIQUID FUNDS"),
    "investments": ("C8", "INVESTMENT IN SECURITIES"),
    "loans": ("C8", "LOANS & ADVANCES (Including Bills Purchased)"),
    "interest_expense": ("C9", "1.   Interest Expense"),
    "interest_exp_deposits": ("C9", "1.1  On Deposit Liabilities"),
    "staff_expense": ("C9", "3.   Staff Expense"),
    "office_expense": ("C9", "4.   Office Operating Expenses"),
    "provision_for_risk": ("C9", "7.   Provision for Risk"),
    "staff_bonus": ("C9", "9.   Provision for Staff Bonus"),
    "income_tax": ("C9", "10.  Provision for Income Tax"),
    "net_profit": ("C9", "12.  Net Profit"),
    "net_loss": ("C9", "9.   Net Loss"),
    "interest_income": ("C9", "1.   Interest Income"),
    "interest_inc_loans": ("C9", "1.1  On Loans and Advances"),
    "commission_income": ("C9", "2.   Commission and Discount"),
    "fx_income": ("C9", "3.   Exchange Flactuation Income"),
    "other_op_income": ("C9", "4.   Other Operating Income"),
    "dep_others": ("C8", "e. Others"),
    "loans_total_sector": ("C10", "TOTAL sectorwise"),
    "loans_total_product": ("C10", "Total Product wise Loan"),
    "credit_card": ("C10", "Credit Card"),
}
# Loan rows in C10 are matched by pattern (NRB tweaks wording, e.g. the home-loan cap
# "Up to Rs. 20 million" became "Up to Rs. 30 million"). Stored as prod_<key> / sec_<key>.
# Other labels NRB has used for a FIELDS row (matched after normalising spaces/case).
ALIASES = {}
PRODUCTS = [
    ("term", r"^term loan"), ("overdraft", r"^overdraft"), ("cash_credit", r"^cash credit"),
    ("trust_receipt", r"^trust receipt|^import loan"), ("working_capital", r"^short term working capital|^demand loan"),
    ("home", r"home loan"), ("real_estate", r"^real estate"), ("margin", r"^margin"),
    ("hire_purchase", r"^hire purchase"), ("deprived", r"^deprived"), ("bills", r"^bills purchased"),
    ("other", r"^other product"),
]
SECTORS = [
    ("agriculture", r"^agricultur\w* and forest"), ("fishery", r"^fishery"), ("mining", r"^mining"),
    ("production", r"^agriculture, forestry|production related"), ("construction", r"^construction"),
    ("energy", r"^electricity"), ("metal", r"^metal"), ("transport", r"^tra\w*s?\.?,? com"),
    ("trade", r"^wholesale"), ("finance", r"^finance, insurance"), ("tourism", r"^tourism|^hotel"),
    ("services", r"^other services"), ("consumption", r"^consumption"), ("local_govt", r"^local government"),
    ("others", r"^others$"),
]
REQUIRED = {"total_assets", "total_liabilities", "deposits", "loans", "net_profit", "interest_income", "interest_expense"}

NEPALI_MONTHS = ["Baisakh", "Jestha", "Asar", "Shrawan", "Bhadau", "Asoj", "Kartik", "Mangsir", "Poush", "Magh", "Falgun", "Chaitra"]


def fetch(url, tries=6, binary=False):
    """GET with retries; NRB's server drops connections now and then."""
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=90) as r:
                data = r.read()
                return (data, r.geturl()) if binary else (data.decode("utf-8", "ignore"), r.geturl())
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError) as e:
            last = e
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"could not fetch {url}: {last}")


def list_entries(pages):
    """Monthly entries, newest first: [{id: '2083-05', label, url}]."""
    out, seen = [], set()
    for p in range(1, pages + 1):
        html, _ = fetch(LIST_URL.format(page="" if p == 1 else f"page/{p}/"))
        for href, text in re.findall(r'<a[^>]+href="(https://www\.nrb\.org\.np/bfr/[^"]+)"[^>]*>(.*?)</a>', html, re.S):
            text = " ".join(unescape(re.sub(r"<[^>]+>", " ", text)).split())
            # the visible title is reliable ("2082-05(Mid Sep, 2025)"); some URLs are mislabelled
            m = re.match(r"(\d{4})-(\d{2})\s*\((Mid [A-Za-z]+,? \d{4})\)", text)
            if not m:
                continue
            mid = f"{m.group(1)}-{m.group(2)}"
            if mid in seen:
                continue
            seen.add(mid)
            out.append({"id": mid, "label": m.group(3).replace(",", ""), "url": href})
    out.sort(key=lambda e: e["id"], reverse=True)
    return out


def xlsx_candidates(pdf_url):
    """The workbook usually sits next to the PDF with .xlsx, but the two can carry different
    version suffixes (Publish-V2.pdf next to Publish.xlsx or Publish-1.xlsx). Highest version first."""
    stem = pdf_url[:-4]
    base = re.sub(r"-(?:V)?\d+$", "", stem, flags=re.I)
    out = [stem + ".xlsx"]
    out += [f"{base}-{n}.xlsx" for n in range(5, 0, -1)] + [f"{base}-V{n}.xlsx" for n in range(5, 0, -1)] + [base + ".xlsx"]
    return list(dict.fromkeys(out))


def fetch_workbook(entry_url):
    """Follow the entry to its PDF, then fetch the matching workbook. Returns (url, bytes)."""
    _, final = fetch(entry_url, binary=True)
    if not final.lower().endswith(".pdf"):
        raise RuntimeError(f"{entry_url} did not lead to a PDF ({final})")
    for url in xlsx_candidates(final):
        try:
            req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60):
                pass
        except urllib.error.HTTPError as e:
            if e.code == 404:
                continue
        except (urllib.error.URLError, OSError):
            pass  # flaky connection: let the full download below retry it
        try:
            blob, _ = fetch(url, binary=True, tries=3)
            if blob[:2] == b"PK":   # .xlsx files are zip archives
                return url, blob
        except RuntimeError:
            continue
    raise RuntimeError(f"no Excel file published next to {final} (PDF only)")


def norm(s):
    return " ".join(str(s).split()).lower()


def read_sheet(wb, name):
    rows = list(wb[name].iter_rows(values_only=True))
    hi = next(i for i, r in enumerate(rows) if r and any(norm(c) == "bfi name" for c in r if c is not None))
    header = [str(c).strip() if c is not None else "" for c in rows[hi]]
    label_col = [norm(c) for c in header].index("bfi name")
    table = {}
    for r in rows[hi + 1:]:
        if not r:
            continue
        # most labels sit in the "BFI Name" column; totals ("TOTAL ASSETS") sit in the S.N. column
        label = next((c for c in r[: label_col + 1][::-1] if isinstance(c, str) and c.strip()), None)
        if label is None:
            continue
        table.setdefault(norm(label), r)   # first occurrence wins (e.g. "Domestic" repeats)
    return header, table


def parse_workbook(blob):
    wb = openpyxl.load_workbook(io.BytesIO(blob), read_only=True, data_only=True)
    sheets = {n: read_sheet(wb, n) for n in ("C8", "C9", "C10")}
    banks = {}
    for nrb_name, code in BANKS.items():
        rec = {}
        for field, (sheet, label) in FIELDS.items():
            header, table = sheets[sheet]
            if nrb_name not in header:
                continue
            col = header.index(nrb_name)
            row = next((table[norm(l)] for l in [label, *ALIASES.get(field, [])] if norm(l) in table), None)
            if row is None or col >= len(row):
                continue
            v = row[col]
            if isinstance(v, (int, float)):
                rec[field] = round(float(v), 2)
        rec.update(read_loan_breakdown(sheets["C10"], nrb_name))
        if rec:
            banks[code] = rec
    return banks


UNMATCHED = set()


def read_loan_breakdown(c10, nrb_name):
    """Every product and sector row for one bank, keyed by PRODUCTS / SECTORS."""
    header, table = c10
    if nrb_name not in header:
        return {}
    col = header.index(nrb_name)
    out, section = {}, None
    for label, row in table.items():   # insertion order = sheet order
        clean = re.sub(r"[#*]+", "", label).strip()
        if clean.startswith("sector wise"):
            section = ("sec", SECTORS); continue
        if clean.startswith("product wise"):
            section = ("prod", PRODUCTS); continue
        if clean.startswith("total") or clean.startswith("collateral"):
            section = None; continue
        if section is None:
            continue
        key = next((k for k, pat in section[1] if re.search(pat, clean)), None)
        if key is None:
            UNMATCHED.add(clean); continue
        v = row[col] if col < len(row) else None
        if isinstance(v, (int, float)):
            out[f"{section[0]}_{key}"] = round(float(v), 2)
    return out


def validate(banks):
    """Problems that would make the month unsafe to publish."""
    problems = []
    missing = [c for c in BANKS.values() if c not in banks]
    if missing:
        problems.append(f"banks missing: {', '.join(missing)}")
    for code, b in banks.items():
        gaps = REQUIRED - b.keys()
        if gaps:
            problems.append(f"{code}: missing {', '.join(sorted(gaps))}")
            continue
        ta, tl = b["total_assets"], b["total_liabilities"]
        if ta <= 0 or abs(ta - tl) / ta > 0.005:
            problems.append(f"{code}: assets {ta:,.0f} vs liabilities {tl:,.0f}")
        for k in ("loans_total_sector", "loans_total_product"):
            if k in b and b["loans"] > 0 and abs(b[k] - b["loans"]) / b["loans"] > 0.01:
                problems.append(f"{code}: {k} {b[k]:,.0f} vs loans {b['loans']:,.0f}")
        for prefix, total in (("prod_", "loans_total_product"), ("sec_", "loans_total_sector")):
            parts = sum(v for k, v in b.items() if k.startswith(prefix))
            if total in b and b[total] > 0 and abs(parts - b[total]) / b[total] > 0.01:
                problems.append(f"{code}: {prefix}* rows add to {parts:,.0f}, total says {b[total]:,.0f}")
        if not (0 < b["deposits"] < ta) or not (0 < b["loans"] < ta):
            problems.append(f"{code}: deposits/loans out of range")
    return problems


def jumps(prev, cur):
    """Month-on-month moves too large to be ordinary (flagged, not fatal)."""
    notes = []
    for code, b in cur.items():
        p = prev.get(code)
        if not p:
            continue
        for k in ("deposits", "loans", "total_assets"):
            if p.get(k) and abs(b[k] / p[k] - 1) > 0.25:
                notes.append(f"{code}: {k} moved {100 * (b[k] / p[k] - 1):+.0f}% in a month")
    return notes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--months", type=int, default=24)
    ap.add_argument("--rebuild", action="store_true", help="re-read every month (after adding fields)")
    args = ap.parse_args()

    data = json.loads(OUT.read_text()) if OUT.exists() and not args.rebuild else {"months": []}
    have = {m["id"] for m in data["months"]}
    entries = list_entries(pages=max(1, -(-args.months // 10) + 1))[: args.months]
    if not entries:
        print("No entries found on NRB's list page", file=sys.stderr)
        return 1
    newest = entries[0]["id"]
    failed_newest = False
    added = []

    for e in sorted(entries, key=lambda x: x["id"]):
        if e["id"] in have:
            continue
        try:
            url, blob = fetch_workbook(e["url"])
            banks = parse_workbook(blob)
        except Exception as ex:  # noqa: BLE001 - report and carry on with other months
            print(f"[{e['id']}] could not read: {ex}", file=sys.stderr)
            failed_newest |= e["id"] == newest
            continue
        problems = validate(banks)
        if problems:
            print(f"[{e['id']}] failed checks, not published:\n  " + "\n  ".join(problems[:12]), file=sys.stderr)
            failed_newest |= e["id"] == newest
            continue
        y, mo = map(int, e["id"].split("-"))
        month = {
            "id": e["id"],
            "bs": f"{NEPALI_MONTHS[mo - 1]} {y}",
            "label": e["label"],
            # Nepal's fiscal year starts in Shrawan (month 4); profit and loss figures are year to date.
            "fy_month": (mo - 4) % 12 + 1,
            "source": url,
            "banks": banks,
        }
        data["months"].append(month)
        have.add(e["id"])
        added.append(e["id"])
        print(f"[{e['id']}] {month['bs']}: {len(banks)} banks ok")

    if UNMATCHED:
        print("Loan rows not recognised (add a pattern): " + "; ".join(sorted(UNMATCHED)), file=sys.stderr)
    data["months"].sort(key=lambda m: m["id"])
    data["months"] = data["months"][-args.months:]
    for prev, cur in zip(data["months"], data["months"][1:]):
        cur["notes"] = jumps(prev["banks"], cur["banks"])
    data["updated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    data["units"] = "Rs million; profit and loss items are fiscal year to date"
    data["source"] = "Nepal Rastra Bank, Banking & Financial Statistics (monthly)"

    if added:
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False))
        print(f"Added {len(added)} month(s): {', '.join(added)}")
    else:
        print("No new months")
    if failed_newest:
        print(f"Newest month {newest} was not published; see messages above.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
