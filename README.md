# NMB Bank rate comparison

A website comparing NMB Bank's base, loan and deposit rates with every commercial (Class A) bank in Nepal.

**Live site:** https://aayushmsd2026-bit.github.io/bank-rate-comparision/

## How it stays in sync

- The page reads [BankByaj](https://bankbyaj.com)'s data feed (`admin.bankbyaj.com/api/v1`) **live in the browser** every time it opens, and again every 15 minutes while it stays open. The **Refresh** button reloads it on demand.
- `.github/workflows/sync.yml` runs hourly and saves a backup copy to `data/snapshot.json`, committing it only when rates change. If the live feed is unreachable, the page uses this backup and shows a red "Backup copy" badge.

## What it shows

| Tab | Content |
|---|---|
| Overview | Four headline figures (base rate and rank, lending lines below market average, deposit lines above market average, market-leading rates), then a **Lending scorecard** and a **Deposit scorecard**: NMB's rate, rank, a position bar from market best to worst (with the market average marked) and the gap to the average. Products NMB doesn't offer are listed under each card |
| Lending | Grid of every loan product (rows) against every commercial bank (columns), grouped into Home & property, Vehicle, Personal, Asset-backed, Business & priority sector. Each product's fixed-rate row sits under its variable-rate row. Product, NMB and Rank/market-best columns stay pinned; bank headers show each base rate and its gap to NMB |
| Deposits | Same grid: Fixed Deposit and Institutional FD by tenure (3 months – 10 years), then other term deposits, savings, foreign currency and call accounts |

In both grids each cell shows the rate (range or single rate, switchable) with an arrow and the gap to NMB in percentage points: green when NMB is the better deal for the customer, red when the other bank is. ★ marks the best rate in the market. Banks can be ordered A–Z or by base rate, and the buttons above each grid jump to a section. Every view downloads as CSV.

Branding (colours, fonts, logo) follows [nmb.com.np](https://www.nmb.com.np/en); the logo files are in `assets/`.

## Rules used

- **Commercial banks** = institutions BankByaj lists as Class A.
- **Fixed vs variable**: products with "Fixed" in their name are fixed rate; all others are variable.
- **Fixed deposit periods**: read from the product name, e.g. `Fixed Deposit-3Mto<6M`, `FD->1Yto2Y`, `Fixed Deposit-5Y&above`. A range includes its lower end unless it starts with `>`/`Above`, and its upper end unless it has `<`. Where a bank's ranges overlap at a boundary, the higher rate is used.
- **Offer rates**: where a bank lists a special offer rate, that rate is used.
- **Ranking**: loans are ranked by each bank's lowest rate (1 = cheapest); deposits by each bank's highest rate (1 = pays the most). Tied banks share a rank.
- **Colours**: green = NMB is more attractive to customers (cheaper loan, higher deposit rate); red = the other bank is.

## Files

`index.html`, `style.css` and `app.js` are the whole site (no build step). When changing `style.css` or `app.js`, bump the `?v=` number on their links in `index.html` so browsers don't mix a new page with old cached files. `scripts/sync.mjs` writes the backup.
