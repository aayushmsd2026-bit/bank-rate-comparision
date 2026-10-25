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
| Base rate | All commercial banks' base rates, ranked, with the difference vs NMB |
| Loans | Choose a loan type. Each bank's lowest–highest rate across all its products, split into **variable** and **fixed**, with the gap vs NMB. Click a bank to see each product and its premium over base rate |
| Deposits | Choose a deposit type. Each bank's lowest–highest rate, with the gap vs NMB. Click a bank to see each product |

Every table can be downloaded as CSV.

## Rules used

- **Commercial banks** = institutions BankByaj lists as Class A.
- **Fixed vs variable**: products with "Fixed" in their name are fixed rate; all others are variable.
- **Offer rates**: where a bank lists a special offer rate, that rate is used.
- **Ranking**: loans are ranked by each bank's lowest rate (1 = cheapest); deposits by each bank's highest rate (1 = pays the most). Tied banks share a rank.
- **Colours**: green = NMB is more attractive to customers (cheaper loan, higher deposit rate); red = the other bank is.

## Files

`index.html`, `style.css` and `app.js` are the whole site (no build step). `scripts/sync.mjs` writes the backup.
