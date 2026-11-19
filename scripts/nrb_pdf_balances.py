"""Fill NRB months that were published as PDF only (no Excel file) with balance-sheet figures.

NRB released Mangsir 2081 and Shrawan 2082 only as PDF. Without them, the site can't show the
net change during the following month (e.g. Bhadau 2082 = Bhadau minus Shrawan). This script reads
just the balances the site needs for monthly changes (total deposits by type, total loans) from
sheet C8 of the PDF and writes them to data/nrb/pdf_balances.json, separate from financials.json.

Columns are matched to banks by the bank codes printed above them. Every figure is checked:
deposit types must add up to total deposits, and each balance must lie close to the months on
either side; if anything fails, nothing is written.

Usage: python scripts/nrb_pdf_balances.py 2081-08 2082-04   (needs pdftotext, from poppler-utils)
"""
import json, re, subprocess, sys, tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import nrb_sync as n  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "data" / "nrb" / "pdf_balances.json"
FIN = Path(__file__).resolve().parent.parent / "data" / "nrb" / "financials.json"
ROWS = {  # field -> regex for the row label in C8 (first match after the deposits line for the types)
    "deposits": r"^\s*3 DEPOSITS\b",
    "dep_current": r"^\s*a\. Current\b",
    "dep_savings": r"^\s*b\. Savings\b",
    "dep_fixed": r"^\s*c\. Fixed\b",
    "dep_call": r"^\s*d\. Call Deposits\b",
    "dep_others": r"^\s*e\. Others\b",
    "loans": r"^\s*4 Purchased\)",
}
NUM = re.compile(r"\(?-?[\d,]+\.\d+\)?|(?<=\s)-(?=\s|$)")


def num(tok):
    if tok == "-":
        return 0.0
    neg = tok.startswith("(")
    v = float(tok.strip("()").replace(",", ""))
    return -v if neg else v


def parse_page(page):
    lines = page.splitlines()
    hdr_end = next(i for i, l in enumerate(lines) if "BFI Name" in l)
    # bank codes printed (rotated) above the table: take each word and its centre position
    # every word in the header area (development banks and finance companies share these pages),
    # so a number is only given to a commercial bank when that bank's code is the nearest one
    codes = []
    for l in lines[:hdr_end]:
        for m in re.finditer(r"[A-Za-z][\w.&-]*", l):
            if not re.match(r"(?i)statement|assets|liabilit|as|on|end|mid|of|and|saun|shrawan", m.group()):
                codes.append(((m.start() + m.end()) / 2, m.group()))
    out = {}
    body = lines[hdr_end:]
    dep_i = next(i for i, l in enumerate(body) if re.match(ROWS["deposits"], l))
    for field, pat in ROWS.items():
        start = 0 if field in ("deposits", "loans") else dep_i
        line = next((l for l in body[start:] if re.match(pat, l)), None)
        if line is None:
            continue
        toks = [(m.end(), num(m.group())) for m in NUM.finditer(line)]
        best = {}
        for end, v in toks:
            # numbers are right-aligned; give each to the nearest header code, closest number wins
            x, code = min(codes, key=lambda c: abs(c[0] - (end - 6)))
            d = abs(x - (end - 6))
            if code in n.BANKS and (code not in best or d < best[code][0]):
                best[code] = (d, v)
        for code, (_, v) in best.items():
            out.setdefault(n.BANKS[code], {})[field] = v
    return out


def read_pdf(blob):
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "m.pdf"
        p.write_bytes(blob)
        txt = subprocess.run(["pdftotext", "-layout", str(p), "-"], capture_output=True, text=True, check=True).stdout
    banks = {}
    for page in txt.split("\f"):
        if "BFI Name" in page and re.search(ROWS["deposits"], page, re.M) and "Statement of Assets and Liabilities" in page:
            for code, vals in parse_page(page).items():
                banks.setdefault(code, {}).update(vals)
    return {c: v for c, v in banks.items() if c in n.BANKS.values()}


def check(mid, banks, fin):
    ids = [m["id"] for m in fin["months"]]
    near = [m for m in fin["months"] if m["id"] in (prev_id(mid), next_id(mid))]
    problems = []
    if len(banks) != 20:
        problems.append(f"{len(banks)} banks found, expected 20")
    for code, b in banks.items():
        parts = sum(b.get(k, 0) for k in ("dep_current", "dep_savings", "dep_fixed", "dep_call", "dep_others"))
        if abs(parts - b.get("deposits", 0)) > 0.005 * max(b.get("deposits", 1), 1):
            problems.append(f"{code}: deposit types {parts:.0f} != total {b.get('deposits')}")
        for k in ("deposits", "loans"):
            for m in near:
                o = m["banks"].get(code, {}).get(k)
                if o and abs(b.get(k, 0) - o) > 0.12 * o:
                    problems.append(f"{code} {k}: {b.get(k)} vs {o} in {m['id']}")
    return problems


def prev_id(i):
    y, m = map(int, i.split("-"))
    return f"{y - 1}-12" if m == 1 else f"{y}-{m - 1:02d}"


def next_id(i):
    y, m = map(int, i.split("-"))
    return f"{y + 1}-01" if m == 12 else f"{y}-{m + 1:02d}"


def main(ids):
    fin = json.loads(FIN.read_text())
    data = json.loads(OUT.read_text()) if OUT.exists() else {"months": {}}
    entries = {e["id"]: e for e in n.list_entries(4)}
    for mid in ids:
        e = entries.get(mid)
        if not e:
            sys.exit(f"{mid}: not in NRB's list")
        blob, final = n.fetch(e["url"], binary=True)
        banks = read_pdf(blob)
        problems = check(mid, banks, fin)
        if problems:
            sys.exit(f"{mid}: not written\n  " + "\n  ".join(problems[:20]))
        data["months"][mid] = {"label": e["label"], "source": final, "banks": banks}
        print(f"[{mid}] {len(banks)} banks ok from {final}")
    data["note"] = "Balances (Rs million) for months NRB published as PDF only; used for monthly changes"
    OUT.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1:] or ["2081-08", "2082-04"])
