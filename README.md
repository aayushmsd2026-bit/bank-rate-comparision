# NMB Bank rate comparison

A website comparing NMB Bank's base, loan and deposit rates with every commercial (Class A) bank in Nepal.

**Live site:** https://aayushmsd2026-bit.github.io/bank-rate-comparision/

## How it stays in sync

- The page reads [BankByaj](https://bankbyaj.com)'s data feed (`admin.bankbyaj.com/api/v1`) **live in the browser** every time it opens, and again every 15 minutes while it stays open. The **Refresh** button reloads it on demand.
- `.github/workflows/sync.yml` runs hourly and saves a backup copy to `data/snapshot.json`, committing it only when rates change. If the live feed is unreachable, the page uses this backup and shows a red "Backup copy" badge.

## What it shows

| Tab | Content |
|---|---|
| Overview | "Latest from BankByaj" update notices (e.g. which month's rates are live, how many banks have published this period's base rate), five headline figures (base rate and rank, NPL ratio and rank, deposit lines above market average, lending lines below market average, market-leading rates), then a **Deposit scorecard** and a **Lending scorecard**: NMB's rate, rank, a position bar from market best to worst (with the market average marked) and the gap to the average. Products NMB doesn't offer are listed under each card |
| Deposits | Grid of every deposit product (rows) against every commercial bank (columns), with the same pinned columns as Lending: Fixed Deposit and Institutional FD by tenure (3 months – 10 years), then other term deposits, savings, foreign currency and call accounts |
| Lending | Grid of every loan product (rows) against every commercial bank (columns), grouped into Home & property, Vehicle, Personal, Asset-backed, Business & priority sector. Each product's fixed-rate row sits under its variable-rate row. Product, NMB and Rank/market-best columns stay pinned; bank headers show each base rate and its gap to NMB. Shown by default as **premium over base rate** (re-ranked on the premium), with switches for the actual rate range or lowest rate. Bank columns use NEPSE symbols (RBB is not listed) and each header states the bank's base rate gap to NMB in words, e.g. "0.46 pp below NMB" |
| Banks | One row per bank: base rate (marked **new** if published this period), NPL ratio, 1-year FD, best FD at any tenure, top savings rate, lowest home loan, home loan premium over base, and deposit / loan lines offered. NMB first; click a column to rank banks best first; market average at the bottom |

In both grids each cell shows the rate (range or single rate, switchable) with an arrow and the gap to NMB in percentage points: green when NMB is the better deal for the customer, red when the other bank is. ★ marks the best rate in the market. Banks can be ordered A–Z or by base rate, and the buttons above each grid jump to a section. **Download Excel** (on every tab) creates a formatted workbook in the browser: Overview, Deposits, Lending, Banks, All rates (one row per bank × product, for filters and pivots) and Notes. Every table has filters and frozen panes, rates are real percentages, gaps are ▲/▼ numbers (green = NMB ahead, red = behind), and the workbook opens on the sheet for the tab you were viewing. Built with [ExcelJS](https://github.com/exceljs/exceljs) 4.4.0 (MIT), bundled in `assets/vendor/` so no external CDN is needed.

Branding (colours, fonts, logo) follows [nmb.com.np](https://www.nmb.com.np/en); the logo files are in `assets/`.

## Rules used

- **Commercial banks** = institutions BankByaj lists as Class A.
- **Fixed vs variable**: products with "Fixed" in their name are fixed rate; all others are variable.
- **Fixed deposit periods**: read from the product name, e.g. `Fixed Deposit-3Mto<6M`, `FD->1Yto2Y`, `Fixed Deposit-5Y&above`. A range includes its lower end unless it starts with `>`/`Above`, and its upper end unless it has `<`. Where a bank's ranges overlap at a boundary, the higher rate is used.
- **NPL ratio** (non-performing loans) is BankByaj's `risk_rate` for each bank. BankByaj flags base rates and NPL figures that are still from the previous period; banks that have published a new base rate this period are marked **new**.
- **Offer rates**: where a bank lists a special offer rate, that rate is used.
- **Ranking**: loans are ranked by each bank's lowest rate (1 = cheapest); deposits by each bank's highest rate (1 = pays the most). Tied banks share a rank.
- **Colours**: green = NMB is more attractive to customers (cheaper loan, higher deposit rate); red = the other bank is.

## Files

`index.html`, `style.css` and `app.js` are the whole site (no build step). When changing `style.css` or `app.js`, bump the `?v=` number on their links in `index.html` so browsers don't mix a new page with old cached files. `scripts/sync.mjs` writes the backup.
