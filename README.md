# NMB Bank rate comparison

A website comparing NMB Bank's base, loan and deposit rates with every commercial (Class A) bank in Nepal.

**Live site:** https://aayushmsd2026-bit.github.io/bank-rate-comparision/

## How it stays in sync

- The page reads [BankByaj](https://bankbyaj.com)'s data feed (`admin.bankbyaj.com/api/v1`) **live in the browser** every time it opens, and again every 15 minutes while it stays open. The **Refresh** button reloads it on demand.
- `.github/workflows/sync.yml` runs hourly and saves a backup copy to `data/snapshot.json`, committing it only when rates change. If the live feed is unreachable, the page uses this backup and shows a red "Backup copy" badge.

## What it shows

| Tab | Content |
|---|---|
| Summary | One row per product type: NMB's rate, NMB's rank, market lowest/highest (and which bank), market average, and NMB's gap to the average |
| Loans | One grid: product types down the side (variable and fixed listed separately), banks across the top, base rates in the first row. NMB stays pinned on the left; scroll sideways for the other banks. Each cell shows the bank's lowest–highest rate and, underneath, how much higher or lower its lowest rate is than NMB's (green/red). ★ marks the best rate in the market. Hover a cell for product names |
| Deposits | Same grid for deposits. **Fixed Deposit** and **Institutional FD** are shown period by period (3 months, 6 months, 1 year, 2, 3, 5 and 10 years). Other deposit types compare each bank's highest rate with NMB's |

Every table can be downloaded as CSV.

## Rules used

- **Commercial banks** = institutions BankByaj lists as Class A.
- **Fixed vs variable**: products with "Fixed" in their name are fixed rate; all others are variable.
- **Fixed deposit periods**: read from the product name, e.g. `Fixed Deposit-3Mto<6M`, `FD->1Yto2Y`, `Fixed Deposit-5Y&above`. A range includes its lower end unless it starts with `>`/`Above`, and its upper end unless it has `<`. Where a bank's ranges overlap at a boundary, the higher rate is used.
- **Offer rates**: where a bank lists a special offer rate, that rate is used.
- **Ranking**: loans are ranked by each bank's lowest rate (1 = cheapest); deposits by each bank's highest rate (1 = pays the most). Tied banks share a rank.
- **Colours**: green = NMB is more attractive to customers (cheaper loan, higher deposit rate); red = the other bank is.

## Files

`index.html`, `style.css` and `app.js` are the whole site (no build step). `scripts/sync.mjs` writes the backup.
