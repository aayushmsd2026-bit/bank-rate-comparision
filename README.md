# Bank Tulana (बैंक तुलना)

Compare Nepal's 20 commercial (Class A) banks: live deposit and lending rates, base rates, and Nepal Rastra Bank's monthly balance-sheet figures — all measured against one comparison bank you choose.

**Live site:** https://aayushmsd2026-bit.github.io/bank-rate-comparision/

An independent project, not endorsed by any bank, BankByaj or Nepal Rastra Bank. Figures are for information only; check them with the bank before relying on them.

## Using it

- **Comparison bank.** Every page compares the banks against one bank, picked in the bar under the navigation. It is **NMB Bank** by default on every visit; switching applies to the current visit. A link with `?bank=SYMBOL` (any NEPSE symbol, e.g. `?bank=NABIL`; `RBB` for Rastriya Banijya Bank) opens on that bank.
- **Links to a view.** The address keeps the tab and Financials section, e.g. `…/?bank=NMB#fin/loan` or `#fin/matrix`, so a view can be shared.
- **Excel.** *Download Excel* on any tab builds a formatted workbook (filters, frozen panes, real numbers) and opens it on the sheet for that tab.
- **Print.** Printing hides the controls and prints the current view in landscape.
- **Deposit and lending views.** *All banks* is the full grid (default on computers). *Head to head* puts the comparison bank next to one bank you pick, product by product, with a tally of where it is ahead (default on phones). *Ranking* shows one product at a time with every bank listed best first; ‹ › step through products.
- **Phones.** On a phone the tabs move to a bar at the bottom of the screen, wide tables scroll sideways (a shadow shows there is more), tapping a cell shows what hovering shows on a computer, and it can be installed as an app.
- **Install as an app.** In Chrome, Edge and on Android an **Install app** button appears in the header (only when the browser can install it); on iPhone and iPad it shows the Share → *Add to Home Screen* steps. The installed app opens in its own window and still opens without a connection, showing the last figures it saw.

## Tabs

| Tab | What it shows | Source |
|---|---|---|
| **Overview** | Latest BankByaj notices; the comparison bank's base rate and NPL with ranks; its financial position (deposits, current and savings deposits, loans, profit, with share, rank and one-year growth) and the loan products where it ranks highest and lowest; deposit-rate and lending-rate scorecards (rank and position between the market's best and worst); a summary of where it pays more, lends cheaper or leads the market | BankByaj (live) + NRB (monthly) |
| **Base rate** | Headline figures, all banks ranked, and a bank × bank base-rate matrix (row minus column) | BankByaj |
| **Deposit rates** | Every bank against every deposit product: fixed deposits by tenure (3 months – 10 years), other term deposits, savings, foreign currency, call | BankByaj |
| **Lending rates** | Every bank against every loan product, variable and fixed, shown as premium over base rate by default (or rate range / lowest rate) | BankByaj |
| **Banks** | One row per bank: base rate, NPL, 1-year and best FD, top savings rate, lowest home loan, home-loan premium, product count | BankByaj |
| **Bank financials** | Four sections. **Deposits** (current, savings, fixed, call, other — separately) and **Loans** (12 products incl. a credit-card memo line, or 15 sectors): headline cards, a breakdown table (amount, % of the bank's book, market share, rank, one-year growth vs market), a month-by-month table and all banks ranked. **Profit & efficiency**: profit, net interest income, fees, cost to income, annualised returns, approximate cost of deposits, loan yield and spread. **All banks side by side**: every line item × every bank, switchable between amount, market share, % of own book, rank and growth, shaded by rank, with the leader and market total | NRB |

Conventions used throughout: gaps to the comparison bank are written out ("0.46 pp below NMB") or shown as ▲ (comparison bank ahead) / ▼ (behind); ★ marks the best in market; rank badges are green for the top third, grey for the middle, red for the bottom third.

## Data and automation

**Rates — BankByaj, live.** The page reads BankByaj's public data feed (`admin.bankbyaj.com/api/v1`) in the browser. On a visit it first draws the hourly backup copy (`data/snapshot.json`, about half a second), then replaces it with live data a few seconds later (badge: *Live*). While open it checks again every 30 minutes and only redraws when rates actually changed, keeping scroll positions. If BankByaj is unreachable the backup copy is used (badge: *Backup copy*). `.github/workflows/sync.yml` refreshes the backup hourly via `scripts/sync.mjs`, committing only when rates change.

**Bank financials — Nepal Rastra Bank, monthly, automatic.** `.github/workflows/nrb.yml` runs `scripts/nrb_sync.py` daily. It reads NRB's [monthly statistics list](https://www.nrb.org.np/category/monthly-statistics/?department=bfr); each entry leads to a PDF, and the same workbook is published next to it as `.xlsx` (the script tries the version-suffix variants NRB uses). From sheets C8 (assets & liabilities), C9 (profit & loss, fiscal year to date) and C10 (loans by sector, product, collateral) it reads the 20 commercial banks by column name and items by row label (loan products and sectors by pattern), keeping the last 24 months in `data/nrb/financials.json` (Rs million).

A month is published only if it passes the checks: all 20 banks present; assets equal liabilities (within 0.5%); loans by product and by sector add up to total loans with every row recognised; deposits and loans in range. If NRB's newest month can't be read or fails a check, nothing for it is published and the run fails, so GitHub emails the repository owner. Mangsir 2081 and Shrawan 2082 were published by NRB as PDF only and show as gaps. To run by hand: `pip install openpyxl==3.1.5 && python scripts/nrb_sync.py` (`--rebuild` re-reads every month after adding fields).

NRB figures follow its regulatory reporting, so they differ slightly from banks' published (NFRS) accounts. Per-bank NPL and capital adequacy aren't in NRB's monthly release. "Approx." rates are estimated from year-to-date interest and profit, annualised by 12 ÷ months elapsed in the fiscal year (which starts in Shrawan).

## Rules

- **Commercial banks** = institutions BankByaj lists as Class A; NRB's columns are mapped to the same 20 banks.
- **Fixed vs variable loans**: products with "Fixed" in their name are fixed rate; all others variable. Special offer rates are used where listed.
- **Fixed-deposit tenures** are read from product names (e.g. `3Mto<6M`, `>1Yto2Y`, `5Y&above`). A range includes its lower end unless it starts with `>`/`Above`, and its upper end unless it has `<`; where a bank's ranges overlap at a boundary, the higher rate is used.
- **NPL** is BankByaj's `risk_rate`. Banks that have published this period's base rate are marked **new**.
- **Ranking**: loans by each bank's lowest rate (1 = cheapest), deposits by highest rate (1 = pays most), balance-sheet items by amount (1 = largest). Ties share a rank. Profit growth uses the median as its "average", because a few banks grow from a tiny base.

## Colours

Built from traditional Japanese colours (the tradition catalogued in Sanzo Wada's *A Dictionary of Color Combinations*); each colour has one job, and the Excel export uses the same palette.

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

Heat maps use one ordered scale (kinari → kamenozoki → ai → kon), so darker always means more; the base-rate matrix diverges to ōdo 黄土 (ochre) for "higher". Shades are solid colours so pinned columns stay readable while tables scroll. ▲/▼ always accompany green/red.

## Files

| Path | Purpose |
|---|---|
| `manifest.webmanifest`, `assets/icon-*.png`, `sw.js` | App name, icons and the service worker that makes it installable and usable offline (network first, so it never serves stale files while online) |
| `index.html`, `style.css`, `app.js` | The whole site (no build step). After changing `style.css` or `app.js`, bump the `?v=` number on their links in `index.html` so browsers don't mix new and cached files |
| `assets/vendor/exceljs-4.4.0.min.js` | [ExcelJS](https://github.com/exceljs/exceljs) 4.4.0 (MIT), loaded only when Excel is downloaded |
| `data/snapshot.json` | Hourly backup of BankByaj data (`scripts/sync.mjs`, `.github/workflows/sync.yml`) |
| `data/nrb/financials.json` | NRB monthly bank figures (`scripts/nrb_sync.py`, `.github/workflows/nrb.yml`) |
