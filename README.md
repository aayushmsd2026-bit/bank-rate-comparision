# Nepal Bank Rates

Compare base, loan and deposit rates, plus Nepal Rastra Bank's monthly bank financials, across Nepal's commercial (Class A) banks, against any bank you choose.

An independent project, not endorsed by any bank or by BankByaj. Rates come from the publicly available data on [bankbyaj.com](https://bankbyaj.com); figures are for information only.

## Choosing the comparison bank

Every page compares the banks against one **comparison bank**, picked in the bar under the navigation. It is **NMB Bank by default** on every visit; switching applies to the current visit only. A link with `?bank=SYMBOL` (any NEPSE symbol, e.g. `…/?bank=NABIL`; `RBB` for Rastriya Banijya Bank) opens on that bank instead.

**Live site:** https://aayushmsd2026-bit.github.io/bank-rate-comparision/

## How it stays in sync

- The page reads [BankByaj](https://bankbyaj.com)'s data feed (`admin.bankbyaj.com/api/v1`) **live in the browser** every time it opens, and again every 15 minutes while it stays open. The **Refresh** button reloads it on demand.
- `.github/workflows/sync.yml` runs hourly and saves a backup copy to `data/snapshot.json`, committing it only when rates change. If the live feed is unreachable, the page uses this backup and shows a red "Backup copy" badge.

## What it shows

| Tab | Content |
|---|---|
| Overview | "Latest from BankByaj" update notices, the comparison bank's base rate and NPL ratio with ranks, then a **Deposit scorecard** and a **Lending scorecard**: the comparison bank's rate, rank, a position bar from market best to worst (with the market average marked) and the gap to the average. Products the comparison bank doesn't offer are listed under each card. An **In summary** row at the bottom gives deposits where the comparison bank pays more than the average bank, loans where the comparison bank is cheaper, and products where the comparison bank has the best rate of all banks |
| Base rate | Headline figures (the comparison bank's base rate and rank, market average and median, lowest, highest, how many banks have published this period's rate), a ranked bar chart with the market average marked, and a bank × bank **base rate matrix** (each cell = row bank's base rate − column bank's, shaded blue for lower and amber for higher, the comparison bank's row and column highlighted) |
| Deposits | Grid of every deposit product (rows) against every commercial bank (columns), with the same pinned columns as Lending: Fixed Deposit and Institutional FD by tenure (3 months – 10 years), then other term deposits, savings, foreign currency and call accounts |
| Lending | Grid of every loan product (rows) against every commercial bank (columns), grouped into Home & property, Vehicle, Personal, Asset-backed, Business & priority sector. Each product's fixed-rate row sits under its variable-rate row. Product, the comparison bank and Rank/market-best columns stay pinned; bank headers show each base rate and its gap to the comparison bank. Shown by default as **premium over base rate** (re-ranked on the premium), with switches for the actual rate range or lowest rate. Bank columns (on Lending and Deposits) use NEPSE symbols (RBB is not listed) and each header states the bank's base rate gap to the comparison bank in words, e.g. "0.46 pp below the comparison bank" |
| Banks | One row per bank: base rate (marked **new** if published this period), NPL ratio, 1-year FD, best FD at any tenure, top savings rate, lowest home loan, home loan premium over base, and deposit / loan lines offered. the comparison bank first; click a column to rank banks best first; market average at the bottom. Under each figure the gap to the comparison bank is written out, e.g. "4.42 pp below the comparison bank" (a comparison with the comparison bank, not a change over time) |
| Financials | Nepal Rastra Bank's monthly figures, in three sections. **Deposits**: current, savings, fixed, call and other deposits shown separately. **Loans**: all 12 loan products (plus credit-card lending as a memo line) or all 15 lending sectors. **Profit & efficiency**: year-to-date profit, net interest income, fees, cost to income, annualised returns, approximate cost of deposits, loan yield and spread. Each section has headline cards for the comparison bank; a breakdown table (amount, % of the bank's total, market share, rank among the 20 banks, one-year growth against the market); a month-by-month table for the selected line; and a ranked list of all 20 banks (by amount or by % of their own book). A fourth section, **All banks side by side**, puts every line item (deposit types, loan products, loan sectors, profitability measures) against all 20 banks in one matrix, switchable between amount, market share, % of own book, rank and one-year growth; each row is shaded by rank, names the leader and shows the market total. The Overview shows the latest financial position and the loan products where the comparison bank ranks highest and lowest |

In both grids each cell shows the rate (range or single rate, switchable) with an arrow and the gap to the comparison bank in percentage points: green when the comparison bank is the better deal for the customer, red when the other bank is. ★ marks the best rate in the market. Banks can be ordered A–Z or by base rate, and the buttons above each grid jump to a section. **Download Excel** (on every tab) creates a formatted workbook in the browser: Overview, Base rate, Deposits, Lending, Banks, Fin deposits, Fin loan products, Fin loan sectors, Fin side by side (Rs arba and share %), Fin profitability, Fin trend, All rates (one row per bank × product, for filters and pivots) and Notes. Every table has filters and frozen panes, rates are real percentages, gaps are ▲/▼ numbers (green = the comparison bank ahead, red = behind), and the workbook opens on the sheet for the tab you were viewing. Built with [ExcelJS](https://github.com/exceljs/exceljs) 4.4.0 (MIT), bundled in `assets/vendor/` so no external CDN is needed.

## Bank financials from Nepal Rastra Bank (automatic)

`scripts/nrb_sync.py` reads NRB's monthly "Banking & Financial Statistics" ([list](https://www.nrb.org.np/category/monthly-statistics/?department=bfr)). Each entry redirects to a PDF; the same workbook is published next to it as `.xlsx` (sometimes with a different version suffix, which the script tries). From sheets C8 (assets and liabilities), C9 (profit and loss, fiscal year to date) and C10 (loans by sector, product and collateral) it reads the 20 commercial banks by column name and each item by row label (loan products and sectors by pattern, since NRB tweaks their wording), and stores them in `data/nrb/financials.json` (Rs million, last 24 months).

Before a month is kept it must pass checks: all 20 banks present, assets equal liabilities (within 0.5%), loans by sector and by product add up to total loans (and every product and sector row is recognised), and deposits and loans within range. Month-on-month moves over 25% are noted. `.github/workflows/nrb.yml` runs it daily; if NRB's newest month can't be read or fails a check, the run fails (GitHub emails the owner) and nothing for that month is published. A few months were published by NRB as PDF only (Mangsir 2081, Shrawan 2082); they appear as gaps.

To run it by hand: `pip install openpyxl==3.1.5 && python scripts/nrb_sync.py --months 24` (add `--rebuild` to re-read every month after adding fields).

Notes: figures follow NRB's regulatory reporting, so they differ slightly from banks' published (NFRS) accounts. Per-bank NPL and capital adequacy aren't in this release (only industry totals). Rates marked "approx." (cost of deposits, loan yield, spread, returns) are estimated from year-to-date interest and profit, annualised by 12 ÷ months elapsed in the fiscal year.

## Colours

The palette is built from traditional Japanese colours (the tradition catalogued in Sanzo Wada's *A Dictionary of Color Combinations*), and each colour has one job:

| Role | Colour | Hex |
|---|---|---|
| Page background | Kinari 生成り | `#FBFAF5` |
| Text | Sumi 墨 / Nibi 鈍色 | `#2B2B2B` / `#6E6E6B` |
| Comparison bank, links, controls | Ai 藍 | `#165E83` |
| Depth (featured card, footer) | Kon 紺 | `#1B2D4F` |
| Call to action, accent rule | Shu 朱 | `#D9541E` |
| Ahead / better | Tokiwa 常磐 | `#1E7A4C` |
| Behind / worse | Enji 臙脂 | `#B03A48` |
| Best in market | Yamabuki 山吹 | `#C68C00` |
| Lines, tints | Shironezumi 白鼠, Kamenozoki 瓶覗 | `#DCDDDD`, `#EAF3F6` |

Heat maps use one ordered scale (kinari → kamenozoki → ai → kon), so darker always means more; the base-rate matrix diverges to ōdo 黄土 (ochre) for "higher". All shades are solid colours, so pinned columns stay readable when the table scrolls beneath them. Up/down gaps always carry ▲/▼ as well as colour. The Excel export uses the same palette.

## Rules used

- **Commercial banks** = institutions BankByaj lists as Class A.
- **Fixed vs variable**: products with "Fixed" in their name are fixed rate; all others are variable.
- **Fixed deposit periods**: read from the product name, e.g. `Fixed Deposit-3Mto<6M`, `FD->1Yto2Y`, `Fixed Deposit-5Y&above`. A range includes its lower end unless it starts with `>`/`Above`, and its upper end unless it has `<`. Where a bank's ranges overlap at a boundary, the higher rate is used.
- **NPL ratio** (non-performing loans) is BankByaj's `risk_rate` for each bank. BankByaj flags base rates and NPL figures that are still from the previous period; banks that have published a new base rate this period are marked **new**.
- **Offer rates**: where a bank lists a special offer rate, that rate is used.
- **Ranking**: loans are ranked by each bank's lowest rate (1 = cheapest); deposits by each bank's highest rate (1 = pays the most). Tied banks share a rank.
- **Colours**: green = the comparison bank is more attractive to customers (cheaper loan, higher deposit rate); red = the other bank is.

## Files

`index.html`, `style.css` and `app.js` are the whole site (no build step). When changing `style.css` or `app.js`, bump the `?v=` number on their links in `index.html` so browsers don't mix a new page with old cached files. `scripts/sync.mjs` writes the backup.
