# Nepal Bank Rates

Compare base, loan and deposit rates and quarterly results across Nepal's commercial (Class A) banks, against any bank you choose.

An independent project, not endorsed by any bank or by BankByaj. Rates come from the publicly available data on [bankbyaj.com](https://bankbyaj.com); figures are for information only.

## Choosing the comparison bank

Every page compares the banks against one **comparison bank**, picked in the bar under the navigation. The choice is remembered in the browser and added to the page link, so `…/?bank=NABIL` (any NEPSE symbol; `RBB` for Rastriya Banijya Bank) opens with that bank selected. With no choice made, the first bank A–Z is used.

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
| Performance | Quarterly results for every bank, with a bank search, sort-by and best/worst-first controls, frozen headings, rank badges (green top third, grey middle, red bottom third) and a head-to-head view (click any bank) comparing it with the comparison bank on every measure. Covers net profit and growth, deposits, loans, capital, reserves, net interest income, ROE/ROA, NPL, capital adequacy, impairment, cost of funds, spread, base rate, CD ratio, EPS, distributable profit and net worth per share and P/E. The comparison bank's headline figures, switchable groups of measures, gap to the comparison bank under every figure, click a column to rank and chart it, data notes. Profit growth uses the median as its "average" because a few banks grow from a tiny base |

In both grids each cell shows the rate (range or single rate, switchable) with an arrow and the gap to the comparison bank in percentage points: green when the comparison bank is the better deal for the customer, red when the other bank is. ★ marks the best rate in the market. Banks can be ordered A–Z or by base rate, and the buttons above each grid jump to a section. **Download Excel** (on every tab) creates a formatted workbook in the browser: Overview, Base rate, Deposits, Lending, Banks, Performance, All rates (one row per bank × product, for filters and pivots) and Notes. Every table has filters and frozen panes, rates are real percentages, gaps are ▲/▼ numbers (green = the comparison bank ahead, red = behind), and the workbook opens on the sheet for the tab you were viewing. Built with [ExcelJS](https://github.com/exceljs/exceljs) 4.4.0 (MIT), bundled in `assets/vendor/` so no external CDN is needed.

## Adding a new quarter (Performance tab)

Quarterly results aren't available as a live feed, so each quarter is added by hand to `data/performance.json` (about 30 days after quarter end, once all banks have published):

1. Add a new object at the **start** of `quarters` (the first one is shown by default), with the same fields as the existing quarter: `id` (e.g. `2083-84-Q2`), `label`, `period`, `source` (name, title, url, published date, basis) and `banks`, keyed by NEPSE symbol (RBB as `RBBL`).
2. Amounts are in Rs arba (billion); ratios in %. `net_profit_prev` is the same quarter last year.
3. Put anything that looks wrong in the source under `notes` as `"SYMBOL.field": "explanation"` — the site shows a ⚠ next to that figure.
4. Check the totals and averages against those stated in the source before publishing.

Q1 FY 2083/84 comes from ShareSansar's [Q1 analysis](https://www.sharesansar.com/newsdetail/unveiling-q1-208384-a-comprehensive-analysis-of-leading-commercial-banks-and-key-financial-insights-2026-11-03) (3 Nov 2026), compiled from the banks' unaudited reports; its totals and averages were cross-checked against the article text.

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
