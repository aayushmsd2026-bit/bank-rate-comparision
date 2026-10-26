// NMB Bank rate comparison. Reads the BankByaj API live in the browser and
// falls back to data/snapshot.json (refreshed hourly by GitHub Actions).
"use strict";

const API = "https://admin.bankbyaj.com/api/v1/";
const NMB = "NMB Bank";             // institute_code used by BankByaj
const AUTO_REFRESH_MS = 15 * 60 * 1000;

// NEPSE share symbols, keyed by BankByaj institute_code. Rastriya Banijya Bank
// is not listed on NEPSE, so it keeps its usual short name.
const SCRIP = {
  "Krishi Bikas": "ADBL", "Citizens Bank": "CZBIL", "Everest Bank": "EBL", "Global IME": "GBIME",
  "Himalayan": "HBL", "Kumari Bank": "KBL", "Laxmi Sunrise": "LSL", "Machhapuchhre": "MBL",
  "Nabil Bank": "NABIL", "Nepal Bank": "NBL", "NIMB": "NIMB", "Nepal SBI": "SBI", "NIC Asia": "NICA",
  "NMB Bank": "NMB", "Prabhu Bank": "PRVU", "Prime Bank": "PCBL", "RBB": "RBB", "Sanima Bank": "SANIMA",
  "Siddhartha": "SBL", "SCB": "SCB",
};

const state = { data: null, source: null, tab: "summary" };
const $ = (id) => document.getElementById(id);

// ---------- loading ----------

async function getJson(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.success === false) throw new Error(json.message || "API error");
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// Same shape as scripts/sync.mjs writes.
async function loadLive() {
  const [loanCats, depositCats, baseRates, blogs] = await Promise.all([
    getJson(API + "categories/loan"),
    getJson(API + "categories/deposit"),
    getJson(API + "baserates"),
    getJson(API + "blogs/latest").catch(() => ({ blogs: [] })),
  ]);
  const all = [...loanCats.categories, ...depositCats.categories];
  const responses = await Promise.all(all.map((c) => getJson(API + "category/" + encodeURIComponent(c.url_key))));
  const categories = {};
  let institutes = [];
  all.forEach((c, i) => {
    const d = responses[i];
    if (d.institutes?.length) institutes = d.institutes;
    categories[c.url_key] = { last_modified_date: d.last_modified_date, products: d.products };
  });
  return {
    fetched_at: new Date().toISOString(),
    loanCategories: loanCats.categories,
    depositCategories: depositCats.categories,
    baseRates: baseRates.base_rates,
    updates: (blogs.blogs || []).map(({ title, summary, updated_at }) => ({ title, summary, updated_at })),
    institutes,
    categories,
  };
}

async function load() {
  setBadge("Updating…", "");
  $("error").hidden = true;
  try {
    state.data = await loadLive();
    state.source = "live";
  } catch (liveErr) {
    try {
      state.data = await getJson("data/snapshot.json?t=" + Date.now());
      state.source = "snapshot";
    } catch (snapErr) {
      $("error").textContent = `Could not load rates (live: ${liveErr.message}; backup: ${snapErr.message}).`;
      $("error").hidden = false;
      setBadge("Unavailable", "snap");
      return;
    }
  }
  prepare();
  render();
}

function setBadge(text, cls) {
  const b = $("source-badge");
  b.textContent = text;
  b.className = "pill " + cls;
}

// ---------- model ----------

const num = (s) => {
  const n = parseFloat(String(s).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

function parseRate(p) {
  if (p.offer_interest_rate) {
    const r = num(p.offer_interest_rate);
    if (r !== null) return { lo: r, hi: r, offer: true };
  }
  const parts = String(p.interest || "").split("-").map(num).filter((n) => n !== null);
  if (!parts.length) return null;
  return { lo: Math.min(...parts), hi: Math.max(...parts), offer: false };
}

const isFixed = (name) => /fixed/i.test(name);

// Fixed deposit names carry their period, e.g. "Fixed Deposit-3Mto<6M",
// "FD->1Yto2Y", "Fixed Deposit-5Y&above", "FD-Above10Y". Returns the span in
// months as { lo, loInc, hi, hiInc }, or null when the name has no period.
const UNIT = { M: 1, Y: 12 };
function parseTenure(name) {
  const tail = (name.includes("-") ? name.slice(name.indexOf("-") + 1) : name).replace(/\s+/g, "");
  const m = tail.match(/^(>|Above)?(\d+(?:\.\d+)?)([MY])(?:(&above)|to(<)?(\d+(?:\.\d+)?)([MY])|upto(\d+(?:\.\d+)?)([MY]))?$/i);
  if (!m) return null;
  const [, gt, a, au, andAbove, lt, b, bu, c, cu] = m;
  const lo = +a * UNIT[au.toUpperCase()];
  if (andAbove) return { lo, loInc: true, hi: Infinity, hiInc: false };
  if (b) return { lo, loInc: !gt, hi: +b * UNIT[bu.toUpperCase()], hiInc: !lt };
  if (c) return { lo, loInc: !gt, hi: +c * UNIT[cu.toUpperCase()], hiInc: true };
  if (gt) return { lo, loInc: false, hi: Infinity, hiInc: false };
  return { lo, loInc: true, hi: lo, hiInc: true };
}
const covers = (t, m) => (m > t.lo || (t.loInc && m === t.lo)) && (m < t.hi || (t.hiInc && m === t.hi));

const PERIODS = [
  [3, "3 months"], [6, "6 months"], [12, "1 year"], [24, "2 years"],
  [36, "3 years"], [60, "5 years"], [120, "10 years"],
];

// For deposit categories whose products are named by period, work out each
// bank's rate for every standard period. Where a bank's ranges overlap at a
// boundary, the higher rate wins (rates rise with tenure, so this picks the
// band that starts at that period).
function buildPeriods(cat) {
  const all = Object.values(cat.rows).flatMap((r) => r.products);
  const parsed = all.filter((p) => (p.tenure = parseTenure(p.name)));
  if (!all.length || parsed.length < all.length * 0.8) return null;
  return PERIODS.map(([months, label]) => {
    const rows = {};
    for (const r of Object.values(cat.rows)) {
      const hits = r.products.filter((p) => p.tenure && covers(p.tenure, months));
      if (!hits.length) continue;
      const top = Math.max(...hits.map((p) => p.rate.hi));
      const used = hits.filter((p) => p.rate.hi === top);
      rows[r.code] = { code: r.code, all: { lo: top, hi: top, count: 1 }, products: used };
    }
    return { months, label, rows };
  }).filter((p) => Object.keys(p.rows).length);
}

function emptyRange() { return { lo: Infinity, hi: -Infinity, count: 0 }; }
function addRange(r, rate) { r.lo = Math.min(r.lo, rate.lo); r.hi = Math.max(r.hi, rate.hi); r.count++; }
const hasRange = (r) => r && r.count > 0;

function prepare() {
  const d = state.data;
  const banks = d.institutes
    .filter((i) => i.class === "A" || /commercial/i.test(i.type || ""))
    .map((i) => ({ code: i.code, name: i.name }));
  const codes = new Set(banks.map((b) => b.code));

  // base_rate and risk_rate (NPL ratio) come with flags saying whether the figure
  // is still last period's (the bank hasn't published this period's yet).
  const base = {}, npa = {}, baseOld = {}, npaOld = {};
  for (const b of d.baseRates) {
    if (!codes.has(b.code)) continue;
    base[b.code] = num(b.base_rate);
    npa[b.code] = num(b.risk_rate);
    baseOld[b.code] = !!b.is_old_base_rate;
    npaOld[b.code] = !!b.is_old_npa;
  }

  const build = (cats, type) => cats.map((c) => {
    const cat = d.categories[c.url_key];
    const rows = {};
    for (const p of cat?.products || []) {
      if (!codes.has(p.institute_code)) continue;
      const rate = parseRate(p);
      if (!rate) continue;
      const row = rows[p.institute_code] ||= { code: p.institute_code, all: emptyRange(), variable: emptyRange(), fixed: emptyRange(), products: [] };
      const fixed = type === "loan" && isFixed(p.name);
      addRange(row.all, rate);
      if (type === "loan") addRange(fixed ? row.fixed : row.variable, rate);
      row.products.push({ ...p, rate, fixed });
    }
    for (const r of Object.values(rows)) r.products.sort((a, b) => a.rate.lo - b.rate.lo);
    return { key: c.url_key, title: c.title.replace(/^\w/, (ch) => ch.toUpperCase()), type, rows, modified: cat?.last_modified_date };
  }).filter((c) => Object.keys(c.rows).length);

  const model = {
    banks,
    nameOf: Object.fromEntries(banks.map((b) => [b.code, b.name])),
    base, npa, baseOld, npaOld,
    updates: (d.updates || []).filter((u) => !/advertis/i.test(u.title)),
    loans: build(d.loanCategories, "loan"),
    deposits: build(d.depositCategories, "deposit").map((c) => ({ ...c, periods: buildPeriods(c) })),
  };
  const mods = Object.values(d.categories).map((c) => c.last_modified_date).filter(Boolean).sort();
  model.modified = mods[mods.length - 1];
  state.model = model;
}

// Ranks NMB among banks that have a value. ascending=true → 1 is lowest.
function standing(values, ascending) {
  const entries = Object.entries(values).filter(([, v]) => v !== null && Number.isFinite(v));
  if (!entries.length) return null;
  const vals = entries.map(([, v]) => v);
  const min = Math.min(...vals), max = Math.max(...vals);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const nmb = values[NMB];
  const has = nmb !== undefined && nmb !== null && Number.isFinite(nmb);
  const rank = has ? 1 + vals.filter((v) => (ascending ? v < nmb : v > nmb)).length : null;
  return {
    n: vals.length, min, max, avg, nmb: has ? nmb : null, rank,
    minBanks: entries.filter(([, v]) => v === min).map(([c]) => c),
    maxBanks: entries.filter(([, v]) => v === max).map(([c]) => c),
  };
}

// ---------- structure ----------

// Products are grouped the way a bank's ALCO / pricing committee reads them.
// Keys are BankByaj category url_keys; anything unlisted falls into the last group.
const LOAN_SEGMENTS = [
  ["Home & property", ["home-loan-nepali-banks", "flexi-mortgage"]],
  ["Vehicle", ["auto-loan", "hire_purchase", "bike"]],
  ["Personal", ["personal-loan", "education-loan", "professional_loan", "pension-loan", "foreignworkers"]],
  ["Asset-backed", ["share-margin-loan", "gold-silver"]],
  ["Business & priority sector", ["business-loan", "term-loan", "agro loan", "deprived-dector"]],
  ["Other lending", null],
];
const DEPOSIT_SEGMENTS = [
  ["Other term deposits", ["remitfd", "recurring-deposit"]],
  ["Savings", ["current-savings", "salary SAVINGS", "women-savings", "senior-citizens", "pensioner",
    "student savings", "bal-bachat", "remittance-saving", "socialsecurity", "shreholder-savings"]],
  ["Foreign currency", ["foreign-currency", "dollar_savings"]],
  ["Call & other", null],
];

function bySegment(cats, segments) {
  const used = new Set();
  const out = [];
  for (const [name, keys] of segments) {
    const list = keys ? keys.map((k) => cats.find((c) => c.key === k)).filter(Boolean) : cats.filter((c) => !used.has(c.key));
    list.forEach((c) => used.add(c.key));
    if (list.length) out.push([name, list]);
  }
  return out;
}

// Every comparable line (a product × variant) with its per-bank cells and NMB's standing.
// Loans compare on each bank's lowest rate; deposits on each bank's highest rate.
function buildRows() {
  const m = state.model;
  const rows = [];
  const add = (section, segment, product, variant, cellList, key) => {
    const cells = {};
    for (const c of cellList) cells[c.code] = c;
    if (!cellList.length) return;
    const lowerIsBetter = section === "loan";
    const values = Object.fromEntries(cellList.map((c) => [c.code, c.value]));
    rows.push({ key, section, segment, product, variant, cells, lowerIsBetter, s: standing(values, lowerIsBetter) });
  };

  for (const [segment, cats] of bySegment(m.loans, LOAN_SEGMENTS)) {
    for (const c of cats) {
      for (const kind of ["variable", "fixed"]) {
        add("loan", segment, c.title, kind === "fixed" ? "Fixed" : "Variable",
          Object.values(c.rows).filter((r) => hasRange(r[kind])).map((r) => ({
            code: r.code, range: r[kind], value: r[kind].lo, products: r.products.filter((p) => p.fixed === (kind === "fixed")),
          })), c.key);
      }
    }
  }

  const depCell = (r) => ({ code: r.code, range: r.all, value: r.all.hi, products: r.products });
  for (const c of m.deposits.filter((c) => c.periods)) {
    for (const p of c.periods) add("deposit", `${c.title} by tenure`, p.label, null, Object.values(p.rows).map(depCell), c.key);
  }
  for (const [segment, cats] of bySegment(m.deposits.filter((c) => !c.periods), DEPOSIT_SEGMENTS)) {
    for (const c of cats) add("deposit", segment, c.title, null, Object.values(c.rows).map(depCell), c.key);
  }
  return rows;
}

// ---------- formatting ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (v) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(2) + "%");
const fmtDate = (s) => (s ? new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");
const bankLabel = (code) => esc(state.model.nameOf[code] || code);
const rowLabel = (r) => r.segment.endsWith(" by tenure") ? `${r.segment.replace(" by tenure", "")} ${r.product}`
  : r.product + (r.variant === "Fixed" ? " (fixed)" : "");

function rateHtml(r, mode) {
  if (mode === "premium") return r.lo === r.hi ? `+${r.lo.toFixed(2)}` : `+${r.lo.toFixed(2)}<span class="to">–</span>${r.hi.toFixed(2)}`;
  if (mode === "single" || r.lo === r.hi) return pct(mode === "single" ? r.single : r.lo);
  return `${r.lo.toFixed(2)}<span class="to">–</span>${pct(r.hi)}`;
}

// Bank's base rate vs NMB's, in words: "0.46 pp below NMB".
function baseVsNmb(v, nmbBase) {
  if (v === null || v === undefined || nmbBase === null || nmbBase === undefined) return "";
  const d = v - nmbBase;
  if (Math.abs(d) < 0.005) return `<div class="b-vs">same as NMB</div>`;
  return `<div class="b-vs" title="This bank's base rate is ${Math.abs(d).toFixed(2)} percentage points ${d < 0 ? "lower" : "higher"} than NMB's (${pct(nmbBase)})">${Math.abs(d).toFixed(2)} pp ${d < 0 ? "below" : "above"} NMB</div>`;
}

// "new" marker for banks that have already published this period's base rate.
const freshTag = (code) => (state.model.baseOld[code] === false ? `<span class="fresh" title="New base rate published this period">new</span>` : "");

// One rule everywhere: ▲ green = NMB ahead, ▼ red = NMB behind, by the gap in pp.
// diff = other − NMB (other = a competitor's rate, or the market average).
// lowerIsBetter: true for loans and base rate, false for deposits.
function arrow(diff, lowerIsBetter, vs = "this bank") {
  if (diff === null || diff === undefined || !Number.isFinite(diff)) return "";
  const gap = Math.abs(diff).toFixed(2);
  if (Math.abs(diff) < 0.005) return `<span class="chg even" title="NMB level with ${vs}">=</span>`;
  const ahead = lowerIsBetter ? diff > 0 : diff < 0;
  return `<span class="chg ${ahead ? "good" : "bad"}" title="NMB ${ahead ? "ahead of" : "behind"} ${vs} by ${gap} pp">${ahead ? "▲" : "▼"}${gap}</span>`;
}

// ---------- rendering ----------

function render() {
  const m = state.model;
  document.querySelectorAll(".bank-count").forEach((el) => (el.textContent = m.banks.length));
  setBadge(state.source === "live" ? "Live" : "Backup copy", state.source === "live" ? "live" : "snap");
  const stamp = state.source === "live" ? `Live · fetched ${fmtDate(state.data.fetched_at)}` : `Backup copy from ${fmtDate(state.data.fetched_at)}`;
  document.querySelectorAll(".stamp").forEach((el) => (el.textContent = `${stamp}${m.modified ? ` · BankByaj updated ${fmtDate(m.modified)}` : ""}`));

  state.rows = buildRows();
  renderKpis();
  renderScorecard("loan");
  renderScorecard("deposit");
  renderGrid("loan");
  renderGrid("deposit");
  renderBanks();
  renderUpdates();
  fitGrids();
}

function renderUpdates() {
  const m = state.model;
  const fresh = m.banks.filter((b) => m.baseOld[b.code] === false).length;
  const items = m.updates.slice(0, 3).map((u) =>
    `<span class="upd"><b>${esc(u.title)}</b> <span class="dim">${esc(u.updated_at || "")}</span></span>`);
  if (fresh && fresh < m.banks.length) items.push(`<span class="upd"><b>${fresh} of ${m.banks.length}</b> banks have published this period's base rate <span class="dim">(marked <span class="fresh">new</span>)</span></span>`);
  $("updates").innerHTML = items.length ? `<span class="upd-label">Latest from BankByaj</span>${items.join("")}` : "";
  $("updates").hidden = !items.length;
}

const ordinal = (n) => n + (["th", "st", "nd", "rd"][((n % 100) - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");

function nplKpi() {
  const s = standing({ ...state.model.npa }, true);
  if (!s || s.nmb === null) return "";
  return `<div class="kpi"><div class="k-label">NPL ratio (bad loans)</div><div class="k-value">${pct(s.nmb)}</div>
    <div class="k-note">${ordinal(s.rank)} lowest of ${s.n} banks · market average ${pct(s.avg)}</div></div>`;
}

function renderKpis() {
  const m = state.model;
  const base = standing({ ...m.base }, true);
  const offered = (sec) => state.rows.filter((r) => r.section === sec && r.s.nmb !== null);
  const loans = offered("loan"), deps = offered("deposit");
  const loanWins = loans.filter((r) => r.s.nmb <= r.s.avg + 0.005).length;
  const depWins = deps.filter((r) => r.s.nmb >= r.s.avg - 0.005).length;
  const leads = state.rows.filter((r) => r.s.rank === 1).sort((a, b) => (a.section === "deposit" ? 0 : 1) - (b.section === "deposit" ? 0 : 1));
  const leadText = leads.map(rowLabel);

  const kpi = (label, value, note, cls = "") =>
    `<div class="kpi ${cls}"><div class="k-label">${label}</div><div class="k-value">${value}</div><div class="k-note">${note}</div></div>`;
  $("kpis").innerHTML = [
    kpi("Base rate", pct(base.nmb), `${ordinal(base.rank)} lowest of ${base.n} banks · market average ${pct(base.avg)}`, "featured"),
    nplKpi(),
    kpi("Deposits where we pay more", `${depWins}<small> of ${deps.length}</small>`,
      `In ${depWins} of our ${deps.length} deposit products, NMB pays more than the average bank`),
    kpi("Loans where we're cheaper", `${loanWins}<small> of ${loans.length}</small>`,
      `In ${loanWins} of our ${loans.length} loan products, NMB charges less than the average bank`),
    kpi("Where NMB is No. 1", `${leads.length}<small> products</small>`, leads.length
      ? `Best rate of all ${m.banks.length} banks: ${esc(leadText.slice(0, 4).join(", ") + (leads.length > 4 ? ` and ${leads.length - 4} more` : ""))}`
      : "NMB doesn't have the best rate in any product today"),
  ].join("");
}

// Position bar: left = best rate in market, right = worst. Dot = NMB, tick = market average.
function positionBar(r) {
  const s = r.s;
  if (s.nmb === null) return "";
  const best = r.lowerIsBetter ? s.min : s.max, worst = r.lowerIsBetter ? s.max : s.min;
  const span = Math.abs(worst - best) || 1;
  const at = (v) => (Math.abs(v - best) / span) * 100;
  const better = r.lowerIsBetter ? s.nmb <= s.avg + 0.005 : s.nmb >= s.avg - 0.005;
  return `<div class="pos" title="Best ${pct(best)} · average ${pct(s.avg)} · worst ${pct(worst)}">
    <div class="pos-track"><i class="pos-avg" style="left:${at(s.avg).toFixed(1)}%"></i><i class="pos-dot ${better ? "good" : "bad"}" style="left:${at(s.nmb).toFixed(1)}%"></i></div>
    <div class="pos-scale"><span>${pct(best)}</span><span>${pct(worst)}</span></div>
  </div>`;
}

function renderScorecard(section) {
  const m = state.model;
  const rows = state.rows.filter((r) => r.section === section);
  const shown = rows.filter((r) => r.s.nmb !== null);
  const missing = rows.filter((r) => r.s.nmb === null);
  let body = "", seg = null;

  if (section === "loan") {
    const base = standing({ ...m.base }, true);
    const r = { s: base, lowerIsBetter: true };
    body += `<tr class="seg"><td colspan="5">Funding</td></tr>
      <tr><td class="p-name">Base rate</td><td class="p-nmb">${pct(base.nmb)}</td><td class="p-rank">${base.rank}<span>/${base.n}</span></td>
      <td class="p-pos">${positionBar(r)}</td><td class="p-chg">${arrow(base.avg - base.nmb, true, "the market average")}</td></tr>`;
  }
  for (const r of shown) {
    if (r.segment !== seg) { seg = r.segment; body += `<tr class="seg"><td colspan="5">${esc(seg)}</td></tr>`; }
    const nmbCell = r.cells[NMB];
    body += `<tr>
      <td class="p-name">${esc(r.product)}${r.variant === "Fixed" ? '<span class="tag">Fixed</span>' : ""}</td>
      <td class="p-nmb">${rateHtml(nmbCell.range)}</td>
      <td class="p-rank">${r.s.rank}<span>/${r.s.n}</span></td>
      <td class="p-pos">${positionBar(r)}</td>
      <td class="p-chg">${arrow(r.s.avg - r.s.nmb, r.lowerIsBetter, "the market average")}</td>
    </tr>`;
  }
  $(`${section}-score`).innerHTML = `<thead><tr><th>Product</th><th>NMB</th><th>Rank</th><th>Position: best → worst</th><th class="num">vs avg</th></tr></thead><tbody>${body}</tbody>`;
  $(`${section}-missing`).innerHTML = missing.length
    ? `<b>Not offered by NMB (${missing.length}):</b> ${missing.map((r) => esc(rowLabel(r))).join(", ")}` : "";

}

function orderedBanks() {
  const m = state.model;
  const others = m.banks.filter((b) => b.code !== NMB);
  if (state.order === "base") others.sort((a, b) => (m.base[a.code] ?? 99) - (m.base[b.code] ?? 99) || a.name.localeCompare(b.name));
  else others.sort((a, b) => a.name.localeCompare(b.name));
  return [m.banks.find((b) => b.code === NMB), ...others].filter(Boolean);
}

// Grid: product lines down, banks across. Product, NMB and Rank columns are pinned;
// bank headers (with base rate) are pinned on top.
// Premium view: every loan rate minus that bank's base rate, re-ranked on the premium.
function toPremium(r) {
  const base = state.model.base;
  const cells = {};
  for (const [code, c] of Object.entries(r.cells)) {
    const b = base[code];
    if (b === undefined || b === null) continue;
    cells[code] = { ...c, range: { lo: c.range.lo - b, hi: c.range.hi - b, count: c.range.count }, value: c.value - b };
  }
  return { ...r, cells, s: standing(Object.fromEntries(Object.entries(cells).map(([k, c]) => [k, c.value])), true) };
}

function renderGrid(section) {
  const m = state.model;
  const mode = state.show[section];
  const rows = state.rows.filter((r) => r.section === section).map((r) => (mode === "premium" ? toPremium(r) : r));
  const cols = orderedBanks();
  const others = cols.slice(1);
  const nmbBase = m.base[NMB];
  const unit = (v) => (mode === "premium" ? `+${v.toFixed(2)}` : pct(v));

  let head = `<thead><tr>
    <th class="pin c1">Product</th>
    <th class="pin c2 nmb"><img src="assets/nmb-logo-white.png" alt="NMB Bank" class="nmb-logo"><div class="b-base">Base <b>${pct(nmbBase)}</b>${freshTag(NMB)}</div></th>
    <th class="pin c3">Rank<div class="b-base">best in market</div></th>`;
  for (const b of others) {
    const name = section === "loan" ? `<div class="b-name scrip" title="${bankLabel(b.code)}">${esc(SCRIP[b.code] || m.nameOf[b.code])}</div>` : `<div class="b-name">${bankLabel(b.code)}</div>`;
    head += `<th class="${section === "loan" ? "narrow" : ""}">${name}<div class="b-base">Base <b>${pct(m.base[b.code])}</b>${freshTag(b.code)}</div>${baseVsNmb(m.base[b.code], nmbBase)}</th>`;
  }
  head += `</tr></thead>`;

  const segments = [];
  let body = "", seg = null;
  for (const r of rows) {
    if (r.segment !== seg) {
      seg = r.segment;
      const id = `${section}-seg-${segments.length}`;
      segments.push([seg, id]);
      body += `<tr class="seg" id="${id}"><td class="pin c1">${esc(seg)}</td><td class="pin c2 nmb"></td><td class="pin c3"></td><td colspan="${others.length}"></td></tr>`;
    }
    const s = r.s;
    const best = r.lowerIsBetter ? s.min : s.max;
    const nmb = r.cells[NMB];
    const tip = (c) => esc(c.products.map((p) => {
      const extra = [p.processing_fee && `fee ${p.processing_fee}`, p.minimum_balance && p.minimum_balance !== "0" && `min. balance ${p.minimum_balance}`,
        p.max_tenure && p.max_tenure !== "-" && `tenure ${p.max_tenure}`].filter(Boolean).join(", ");
      return `${p.name}: ${p.rate.lo === p.rate.hi ? pct(p.rate.lo) : pct(p.rate.lo) + " – " + pct(p.rate.hi)}${extra ? ` (${extra})` : ""}`;
    }).join("\n"));
    const cellRange = (c) => ({ ...c.range, single: c.value });
    const star = (c) => (Math.abs(c.value - best) < 0.005 ? `<span class="star" title="Best in market">★</span>` : "");

    body += `<tr class="${r.variant === "Fixed" ? "sub" : ""}">
      <td class="pin c1">${r.variant === "Fixed" ? `<span class="tag">Fixed</span>` : esc(r.product)}${r.variant === "Variable" ? `<span class="var">variable</span>` : ""}</td>
      <td class="pin c2 nmb" ${nmb ? `title="${tip(nmb)}"` : ""}>${nmb ? `<div class="rate">${rateHtml(cellRange(nmb), mode)}${star(nmb)}</div>` : '<span class="na">Not offered</span>'}</td>
      <td class="pin c3"><div class="rank">${s.rank ? `${s.rank}<span>/${s.n}</span>` : '<span class="na">—</span>'}</div><div class="best">${unit(best)}</div></td>`;
    for (const b of others) {
      const c = r.cells[b.code];
      if (!c) { body += `<td><span class="na">—</span></td>`; continue; }
      body += `<td title="${tip(c)}"><div class="rate">${rateHtml(cellRange(c), mode)}${star(c)}</div>${nmb ? arrow(c.value - nmb.value, r.lowerIsBetter) : ""}</td>`;
    }
    body += `</tr>`;
  }
  $(`${section}-table`).innerHTML = head + `<tbody>${body}</tbody>`;
  $(`${section}-jump`).innerHTML = segments.map(([name, id]) => `<button type="button" data-jump="${id}">${esc(name)}</button>`).join("");
}

// Bank profiles: one row per bank, key metrics as columns. NMB first, then the
// others A–Z or sorted best-first on a chosen metric.
function bankMetrics() {
  const m = state.model;
  const row = (key, product, variant) => state.rows.find((r) => r.key === key && r.product === product && (!variant || r.variant === variant));
  const valueOf = (r) => (r ? (code) => r.cells[code]?.value ?? null : () => null);
  const fd1 = valueOf(row("fd-individual", "1 year"));
  const fdRows = state.rows.filter((r) => r.key === "fd-individual");
  const sav = valueOf(state.rows.find((r) => r.key === "current-savings"));
  const homeRow = state.rows.find((r) => r.key === "home-loan-nepali-banks" && r.variant === "Variable");
  const home = valueOf(homeRow);
  const count = (section) => (code) => state.rows.filter((r) => r.section === section && r.cells[code]).length;
  return [
    { key: "base", label: "Base rate", note: "lower is better", lower: true, get: (c) => m.base[c] ?? null, tag: freshTag },
    { key: "npa", label: "NPL ratio", note: "bad loans, % of total", lower: true, get: (c) => m.npa[c] ?? null },
    { key: "fd1", label: "Fixed deposit 1 yr", note: "rate", lower: false, get: fd1 },
    { key: "fdtop", label: "Best fixed deposit", note: "any tenure", lower: false, get: (c) => { const v = fdRows.map((r) => r.cells[c]?.value).filter((x) => x !== undefined); return v.length ? Math.max(...v) : null; } },
    { key: "sav", label: "Savings top rate", note: "saving account", lower: false, get: sav },
    { key: "home", label: "Home loan from", note: "lowest variable", lower: true, get: home },
    { key: "prem", label: "Home loan premium", note: "over base rate", lower: true, unit: "pp", get: (c) => { const h = home(c), b = m.base[c]; return h === null || b === undefined ? null : h - b; } },
    { key: "lines", label: "Products", note: "deposit / loan lines", count: true,
      get: (c) => count("deposit")(c) + count("loan")(c), show: (c) => `${count("deposit")(c)} / ${count("loan")(c)}` },
  ];
}

function renderBanks() {
  const m = state.model;
  const metrics = bankMetrics();
  const fmt = (mt, v, code) => (v === null || v === undefined ? '<span class="na">—</span>' : mt.show && code ? mt.show(code) : mt.count ? String(v) : mt.unit === "pp" ? `+${v.toFixed(2)}` : pct(v));
  const stats = Object.fromEntries(metrics.filter((mt) => !mt.count).map((mt) =>
    [mt.key, standing(Object.fromEntries(m.banks.map((b) => [b.code, mt.get(b.code)])), mt.lower)]));

  const others = m.banks.filter((b) => b.code !== NMB);
  const sortMt = metrics.find((mt) => mt.key === state.bankSort);
  if (sortMt) {
    const dir = sortMt.count ? -1 : sortMt.lower ? 1 : -1;
    others.sort((a, b) => {
      const va = sortMt.get(a.code), vb = sortMt.get(b.code);
      if (va === null) return 1;
      if (vb === null) return -1;
      return (va - vb) * dir || a.name.localeCompare(b.name);
    });
  } else others.sort((a, b) => a.name.localeCompare(b.name));
  const list = [m.banks.find((b) => b.code === NMB), ...others].filter(Boolean);

  let head = `<thead><tr><th class="sortable ${state.bankSort ? "" : "on"}"><button type="button" data-bsort="">Bank</button></th>`;
  for (const mt of metrics) {
    const s = stats[mt.key];
    head += `<th class="num sortable ${state.bankSort === mt.key ? "on" : ""}"><button type="button" data-bsort="${mt.key}" title="Sort best first">${esc(mt.label)}${state.bankSort === mt.key ? " ↓" : ""}</button>
      <div class="th-note">${esc(mt.note)}</div>${s && s.rank ? `<div class="th-rank">NMB ${s.rank}/${s.n}</div>` : ""}</th>`;
  }
  head += `</tr></thead>`;

  let body = "";
  for (const b of list) {
    const me = b.code === NMB;
    body += `<tr class="${me ? "nmb-row" : ""}"><td class="bank">${me ? `<img src="assets/nmb-logo.png" alt="" class="row-logo">` : ""}${bankLabel(b.code)}</td>`;
    for (const mt of metrics) {
      const v = mt.get(b.code), nv = mt.get(NMB), s = stats[mt.key];
      const best = s && v !== null && Math.abs(v - (mt.lower ? s.min : s.max)) < 0.005 ? `<span class="star" title="Best in market">★</span>` : "";
      const cmp = me || mt.count || v === null || nv === null ? "" : arrow(v - nv, mt.lower);
      body += `<td class="num"><span class="val">${fmt(mt, v, b.code)}</span>${mt.tag ? mt.tag(b.code) : ""}${best}${cmp ? `<div>${cmp}</div>` : ""}</td>`;
    }
    body += `</tr>`;
  }
  const avg = metrics.map((mt) => (stats[mt.key] ? `<td class="num">${fmt(mt, stats[mt.key].avg)}</td>` : `<td></td>`)).join("");
  body += `<tr class="avg-row"><td class="bank">Market average</td>${avg}</tr>`;
  $("banks-table").innerHTML = head + `<tbody>${body}</tbody>`;
}

// Grids fill the window from their top edge down.
function fitGrids() {
  document.querySelectorAll(".grid-wrap").forEach((el) => {
    if (el.offsetParent === null) return;
    const top = el.getBoundingClientRect().top + window.scrollY;
    const legend = el.nextElementSibling?.offsetHeight || 0;
    el.style.height = Math.max(440, window.innerHeight - top - legend - 36) + "px";
  });
}

// ---------- Excel export ----------

// Builds a formatted .xlsx in the browser with ExcelJS (bundled in assets/vendor,
// loaded on first download). Rates are stored as real percentages and gaps as
// numbers, so filters, sorting and pivots work. Gap format: ▲ green = NMB ahead,
// ▼ red = NMB behind, matching the website.
const XL = {
  teal: "FF008EB0", tealInk: "FF00728E", tint: "FFE8F5F9", ink: "FF1E242A", muted: "FF64748B",
  good: "FF15803D", goodBg: "FFE7F6EC", bad: "FFC81E1E", badBg: "FFFDECEC", band: "FFF8FAFC",
  hair: "FFE2E8F0", gold: "FFA16207", white: "FFFFFFFF",
};
const PCT = "0.00%";
const PP = '+0.00" pp";-0.00" pp";0.00" pp"';
const GAP = '"▲ "0.00;"▼ "0.00;"="';
const SHEET_FOR_TAB = { summary: "Overview", deposit: "Deposits", loan: "Lending", banks: "Banks" };

let excelLib = null;
function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  return (excelLib ||= new Promise((resolve, reject) => {
    const sc = document.createElement("script");
    sc.src = "assets/vendor/exceljs-4.4.0.min.js";
    sc.onload = () => resolve(window.ExcelJS);
    sc.onerror = () => { excelLib = null; reject(new Error("Could not load the Excel library")); };
    document.head.appendChild(sc);
  }));
}

const fill = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
// Gap cells get explicit green/red fonts (number-format colours render differently across apps).
function gapCell(cell, v) {
  cell.value = v;
  cell.numFmt = GAP;
  if (v === null || v === undefined) return;
  cell.font = { bold: true, size: 10, color: { argb: v > 0.005 ? XL.good : v < -0.005 ? XL.bad : XL.muted } };
}
const hairBorder = { bottom: { style: "thin", color: { argb: XL.hair } } };
const asPct = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 10000);
const asNum = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
// Positive = NMB ahead. diff = other − NMB, as in arrow().
const advantage = (diff, lowerIsBetter) => (diff === null || !Number.isFinite(diff) ? null : asNum(lowerIsBetter ? diff : -diff));

function sheetTitle(ws, title, lastCol) {
  const m = state.model;
  ws.mergeCells(1, 1, 1, lastCol);
  ws.getCell(1, 1).value = title;
  ws.getCell(1, 1).font = { name: "Calibri", size: 16, bold: true, color: { argb: XL.ink } };
  ws.getRow(1).height = 26;
  ws.mergeCells(2, 1, 2, lastCol);
  const src = state.source === "live" ? "Live data" : "Backup copy";
  ws.getCell(2, 1).value = `NMB Bank vs ${m.banks.length} commercial banks · ${src} as of ${fmtDate(state.data.fetched_at)}${m.modified ? ` · rates last updated ${fmtDate(m.modified)}` : ""}`;
  ws.getCell(2, 1).font = { size: 10, color: { argb: XL.muted } };
}

function headerRow(ws, rowNo, labels, opts = {}) {
  const row = ws.getRow(rowNo);
  labels.forEach((label, i) => {
    const c = row.getCell(i + 1);
    c.value = label;
    const nmb = opts.nmbCol && i + 1 === opts.nmbCol;
    c.fill = fill(nmb ? XL.tealInk : XL.teal);
    c.font = { bold: true, color: { argb: XL.white }, size: 10 };
    c.alignment = { vertical: "middle", horizontal: i < (opts.textCols ?? 1) ? "left" : "center", wrapText: true };
    c.border = { bottom: { style: "medium", color: { argb: XL.tealInk } } };
  });
  row.height = opts.height || 32;
}

function styleBody(ws, fromRow, toRow, ncol, opts = {}) {
  for (let r = fromRow; r <= toRow; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= ncol; c++) {
      const cell = row.getCell(c);
      cell.border = hairBorder;
      cell.font = { size: 10, color: { argb: XL.ink }, ...(cell.font || {}) };
      if (!cell.alignment) cell.alignment = { vertical: "middle", horizontal: c <= (opts.textCols ?? 1) ? "left" : "center" };
      if (!cell.fill && opts.band && (r - fromRow) % 2 === 1) cell.fill = fill(XL.band);
    }
  }
}

function finishSheet(ws, { headerRowNo, lastRow, ncol, xSplit = 1, widths }) {
  ws.views = [{ state: "frozen", xSplit, ySplit: headerRowNo, showGridLines: false, zoomScale: 100 }];
  if (lastRow > headerRowNo) ws.autoFilter = { from: { row: headerRowNo, column: 1 }, to: { row: lastRow, column: ncol } };
  if (widths) widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9, printTitlesRow: `${headerRowNo}:${headerRowNo}` };
}

function addOverviewSheet(wb) {
  const m = state.model;
  const ws = wb.addWorksheet("Overview", { properties: { tabColor: { argb: XL.teal } } });
  const cols = ["Section", "Segment", "Product", "Variant", "NMB rate", "NMB rank", "Banks", "Market best", "Best bank(s)", "Market average", "Market worst", "NMB vs average"];
  sheetTitle(ws, "Market position — scorecard", cols.length);

  // Headline figures
  const base = standing({ ...m.base }, true), npa = standing({ ...m.npa }, true);
  const offered = (sec) => state.rows.filter((r) => r.section === sec && r.s.nmb !== null);
  const deps = offered("deposit"), loans = offered("loan");
  const kpis = [
    ["Base rate", asPct(base.nmb), PCT, `${ordinal(base.rank)} lowest of ${base.n} banks · market average ${pct(base.avg)}`],
    ["NPL ratio (bad loans)", asPct(npa?.nmb), PCT, npa ? `${ordinal(npa.rank)} lowest of ${npa.n} banks · market average ${pct(npa.avg)}` : ""],
    ["Deposits where we pay more", `${deps.filter((r) => r.s.nmb >= r.s.avg - 0.005).length} of ${deps.length}`, null, "deposit products where NMB pays more than the average bank"],
    ["Loans where we're cheaper", `${loans.filter((r) => r.s.nmb <= r.s.avg + 0.005).length} of ${loans.length}`, null, "loan products where NMB charges less than the average bank"],
    ["Where NMB is No. 1", state.rows.filter((r) => r.s.rank === 1).length, null, "best rate of all banks: " + state.rows.filter((r) => r.s.rank === 1).map(rowLabel).join(", ")],
  ];
  kpis.forEach(([label, value, fmt, note], i) => {
    const r = ws.getRow(4 + i);
    r.getCell(1).value = label; r.getCell(1).font = { bold: true, size: 10, color: { argb: XL.ink } };
    ws.mergeCells(4 + i, 1, 4 + i, 2);
    r.getCell(3).value = value; r.getCell(3).font = { bold: true, size: 12, color: { argb: XL.tealInk } };
    r.getCell(3).alignment = { horizontal: "left" };
    if (fmt) r.getCell(3).numFmt = fmt;
    ws.mergeCells(4 + i, 4, 4 + i, cols.length);
    r.getCell(4).value = note; r.getCell(4).font = { size: 10, color: { argb: XL.muted } };
  });

  const H = 4 + kpis.length + 1;
  headerRow(ws, H, cols, { textCols: 4 });
  let r = H + 1;
  const line = (section, segment, product, variant, s, lowerIsBetter, nmbText) => {
    const best = lowerIsBetter ? s.min : s.max, worst = lowerIsBetter ? s.max : s.min;
    const bestBanks = (lowerIsBetter ? s.minBanks : s.maxBanks).map((c) => m.nameOf[c]).join(", ");
    const row = ws.getRow(r++);
    row.values = [section, segment, product, variant || "", nmbText ?? "Not offered", s.rank ?? "", s.n, asPct(best), bestBanks, asPct(s.avg), asPct(worst)];
    [8, 10, 11].forEach((c) => (row.getCell(c).numFmt = PCT));
    gapCell(row.getCell(12), s.nmb === null ? null : advantage(s.avg - s.nmb, lowerIsBetter));
    row.getCell(9).alignment = { horizontal: "left", vertical: "middle" };
    row.getCell(5).font = { bold: true, color: { argb: s.nmb === null ? XL.muted : XL.tealInk }, size: 10 };
  };
  line("Lending", "Funding", "Base rate", "", base, true, pct(base.nmb));
  for (const sec of ["deposit", "loan"]) {
    for (const row of state.rows.filter((x) => x.section === sec)) {
      const c = row.cells[NMB];
      const txt = c ? (c.range.lo === c.range.hi ? pct(c.range.lo) : `${pct(c.range.lo)} – ${pct(c.range.hi)}`) : null;
      line(sec === "deposit" ? "Deposits" : "Lending", row.segment, row.product, row.variant, row.s, row.lowerIsBetter, txt);
    }
  }
  styleBody(ws, H + 1, r - 1, cols.length, { textCols: 4, band: true });
  finishSheet(ws, { headerRowNo: H, lastRow: r - 1, ncol: cols.length, xSplit: 3, widths: [11, 26, 22, 10, 16, 10, 8, 12, 46, 13, 12, 14] });
}

function addGridSheet(wb, section) {
  const m = state.model;
  const isLoan = section === "loan";
  const ws = wb.addWorksheet(isLoan ? "Lending" : "Deposits", { properties: { tabColor: { argb: isLoan ? XL.ink : XL.teal } } });
  const banks = orderedBanks();
  const lead = isLoan ? ["Segment", "Product", "Variant"] : ["Segment", "Product"];
  const fixedCols = [...lead, "NMB rank", "Banks", "Market best", "Market average"];
  const cols = [...fixedCols, ...banks.map((b) => (b.code === NMB ? "NMB Bank" : b.name))];
  const nmbCol = fixedCols.length + 1;
  sheetTitle(ws, isLoan ? "Lending rates — each bank's lowest rate per product" : "Deposit rates — each bank's highest rate per product", cols.length);

  // Legend + base rates sit above the filter header, frozen in view.
  ws.mergeCells(3, 1, 3, cols.length);
  ws.getCell(3, 1).value = isLoan ? "Green cell = NMB cheaper than that bank · Red = that bank cheaper · Bold gold = best in market · ranges per product on the 'All rates' sheet"
    : "Green cell = NMB pays more than that bank · Red = that bank pays more · Bold gold = best in market · ranges per product on the 'All rates' sheet";
  ws.getCell(3, 1).font = { size: 9, italic: true, color: { argb: XL.muted } };
  const baseRow = ws.getRow(4);
  baseRow.getCell(fixedCols.length).value = "Base rate";
  baseRow.getCell(fixedCols.length).font = { bold: true, size: 10, color: { argb: XL.ink } };
  baseRow.getCell(fixedCols.length).alignment = { horizontal: "right" };
  banks.forEach((b, i) => {
    const c = baseRow.getCell(nmbCol + i);
    c.value = asPct(m.base[b.code]); c.numFmt = PCT;
    c.font = { bold: true, size: 10, color: { argb: b.code === NMB ? XL.white : XL.ink } };
    c.fill = fill(b.code === NMB ? XL.teal : XL.tint);
    c.alignment = { horizontal: "center" };
  });

  const H = 5;
  headerRow(ws, H, cols, { textCols: lead.length, nmbCol, height: 44 });
  let r = H + 1;
  for (const row of state.rows.filter((x) => x.section === section)) {
    const s = row.s, best = row.lowerIsBetter ? s.min : s.max, nmb = row.cells[NMB];
    const x = ws.getRow(r++);
    x.values = [...(isLoan ? [row.segment, row.product, row.variant] : [row.segment, row.product]),
      s.rank ? s.rank : "—", s.n, asPct(best), asPct(s.avg), ...banks.map((b) => asPct(row.cells[b.code]?.value))];
    for (let c = lead.length + 3; c <= cols.length; c++) x.getCell(c).numFmt = PCT;
    banks.forEach((b, i) => {
      const cell = x.getCell(nmbCol + i), c = row.cells[b.code];
      if (!c) return;
      const isBest = Math.abs(c.value - best) < 0.005;
      if (b.code === NMB) {
        cell.fill = fill(XL.tint);
        cell.font = { bold: true, size: 10, color: { argb: isBest ? XL.gold : XL.tealInk } };
        return;
      }
      if (nmb) {
        const adv = advantage(c.value - nmb.value, row.lowerIsBetter);
        if (adv > 0.005) cell.fill = fill(XL.goodBg);
        else if (adv < -0.005) cell.fill = fill(XL.badBg);
      }
      if (isBest) cell.font = { bold: true, size: 10, color: { argb: XL.gold } };
    });
    if (!nmb) { x.getCell(nmbCol).value = "Not offered"; x.getCell(nmbCol).fill = fill(XL.tint); x.getCell(nmbCol).font = { italic: true, size: 9, color: { argb: XL.muted } }; }
  }
  styleBody(ws, H + 1, r - 1, cols.length, { textCols: lead.length });
  finishSheet(ws, { headerRowNo: H, lastRow: r - 1, ncol: cols.length, xSplit: nmbCol,
    widths: [...(isLoan ? [24, 20, 10] : [26, 20]), 9, 7, 11, 11, 13, ...banks.slice(1).map(() => 13)] });
}

function addBanksSheet(wb) {
  const m = state.model;
  const ws = wb.addWorksheet("Banks", { properties: { tabColor: { argb: XL.teal } } });
  const metrics = bankMetrics().filter((mt) => !mt.count);
  const count = (sec, code) => state.rows.filter((r) => r.section === sec && r.cells[code]).length;
  const cols = ["Bank", ...metrics.flatMap((mt) => [`${mt.label} (${mt.note})`, `${mt.label} vs NMB`]), "New base rate this period", "Deposit lines", "Loan lines"];
  sheetTitle(ws, "Bank profiles", cols.length);
  ws.mergeCells(3, 1, 3, cols.length);
  ws.getCell(3, 1).value = "'vs NMB' columns: ▲ green = NMB ahead of that bank, ▼ red = NMB behind (percentage points). NPL = non-performing (bad) loans as a share of total loans.";
  ws.getCell(3, 1).font = { size: 9, italic: true, color: { argb: XL.muted } };
  const H = 5;
  headerRow(ws, H, cols, { height: 44 });
  const list = [m.banks.find((b) => b.code === NMB), ...m.banks.filter((b) => b.code !== NMB).sort((a, b) => a.name.localeCompare(b.name))];
  let r = H + 1;
  for (const b of list) {
    const me = b.code === NMB;
    const x = ws.getRow(r++);
    x.values = [b.name, ...metrics.flatMap((mt) => {
      const v = mt.get(b.code), nv = mt.get(NMB);
      return [mt.unit === "pp" ? asNum(v) : asPct(v), null];
    }), m.baseOld[b.code] === false ? "Yes" : "No", count("deposit", b.code), count("loan", b.code)];
    metrics.forEach((mt, i) => {
      x.getCell(2 + i * 2).numFmt = mt.unit === "pp" ? PP : PCT;
      const v = mt.get(b.code), nv = mt.get(NMB);
      gapCell(x.getCell(3 + i * 2), me || v === null || nv === null ? null : advantage(v - nv, mt.lower));
    });
    if (me) for (let c = 1; c <= cols.length; c++) { x.getCell(c).fill = fill(XL.tint); x.getCell(c).font = { bold: true, size: 10, color: { argb: XL.tealInk } }; }
  }
  styleBody(ws, H + 1, r - 1, cols.length, { band: true });
  // Market average below the filtered range
  const avgRow = ws.getRow(r + 1);
  avgRow.getCell(1).value = "Market average";
  metrics.forEach((mt, i) => {
    const s = standing(Object.fromEntries(m.banks.map((b) => [b.code, mt.get(b.code)])), mt.lower);
    const c = avgRow.getCell(2 + i * 2);
    c.value = s ? (mt.unit === "pp" ? asNum(s.avg) : asPct(s.avg)) : null;
    c.numFmt = mt.unit === "pp" ? PP : PCT;
  });
  for (let c = 1; c <= cols.length; c++) { avgRow.getCell(c).font = { bold: true, size: 10, color: { argb: XL.muted } }; avgRow.getCell(c).border = { top: { style: "thin", color: { argb: XL.muted } } }; avgRow.getCell(c).alignment = { horizontal: c === 1 ? "left" : "center" }; }
  finishSheet(ws, { headerRowNo: H, lastRow: r - 1, ncol: cols.length, xSplit: 1, widths: [28, ...metrics.flatMap(() => [13, 11]), 12, 10, 10] });
}

function addDetailSheet(wb) {
  const m = state.model;
  const ws = wb.addWorksheet("All rates", { properties: { tabColor: { argb: XL.muted } } });
  const cols = ["Section", "Segment", "Product", "Variant", "Bank", "Rate from", "Rate to", "Compared rate", "Premium over base", "NMB compared rate", "Vs NMB", "Bank rank", "Banks", "Best in market", "Product names"];
  sheetTitle(ws, "All rates — one row per bank and product (use the filters or a pivot table)", cols.length);
  const H = 4;
  headerRow(ws, H, cols, { textCols: 5 });
  let r = H + 1;
  for (const row of state.rows) {
    const vals = Object.values(row.cells).map((c) => c.value);
    const best = row.lowerIsBetter ? Math.min(...vals) : Math.max(...vals);
    const nmb = row.cells[NMB];
    const ordered = Object.values(row.cells).sort((a, b) => (row.lowerIsBetter ? a.value - b.value : b.value - a.value));
    for (const c of ordered) {
      const me = c.code === NMB;
      const rank = 1 + vals.filter((v) => (row.lowerIsBetter ? v < c.value : v > c.value)).length;
      const b = m.base[c.code];
      const x = ws.getRow(r++);
      x.values = [row.section === "loan" ? "Lending" : "Deposits", row.segment, row.product, row.variant || "", m.nameOf[c.code],
        asPct(c.range.lo), asPct(c.range.hi), asPct(c.value),
        row.section === "loan" && b !== undefined ? asNum(c.value - b) : null,
        asPct(nmb?.value), null,
        rank, vals.length, Math.abs(c.value - best) < 0.005 ? "Yes" : "",
        c.products.map((p) => p.name).join("; ")];
      [6, 7, 8, 10].forEach((k) => (x.getCell(k).numFmt = PCT));
      x.getCell(9).numFmt = PP;
      gapCell(x.getCell(11), me || !nmb ? null : advantage(c.value - nmb.value, row.lowerIsBetter));
      if (me) for (let k = 1; k <= cols.length; k++) { x.getCell(k).fill = fill(XL.tint); x.getCell(k).font = { bold: true, size: 10, color: { argb: XL.tealInk } }; }
    }
  }
  styleBody(ws, H + 1, r - 1, cols.length, { textCols: 5 });
  for (let k = H + 1; k < r; k++) ws.getRow(k).getCell(15).alignment = { horizontal: "left", vertical: "middle" };
  finishSheet(ws, { headerRowNo: H, lastRow: r - 1, ncol: cols.length, xSplit: 5, widths: [10, 26, 20, 10, 28, 10, 10, 11, 11, 12, 11, 9, 8, 10, 60] });
}

function addNotesSheet(wb) {
  const ws = wb.addWorksheet("Notes", { properties: { tabColor: { argb: XL.muted } } });
  sheetTitle(ws, "How to read this workbook", 2);
  const notes = [
    ["Sheets", "Overview: headline figures and NMB's rank, market best/average/worst for every product.\nDeposits / Lending: every bank's rate per product, NMB first, base rates above the header.\nBanks: base rate, NPL and key rates per bank.\nAll rates: one row per bank and product, with ranges and premiums, for filtering and pivot tables."],
    ["Compared rate", "Loans: each bank's lowest rate for the product (1 = cheapest). Deposits: each bank's highest rate (1 = pays most)."],
    ["Vs NMB / NMB vs average", "▲ green = NMB ahead (cheaper loan or higher deposit rate), ▼ red = NMB behind, in percentage points. = means level."],
    ["Fixed vs variable", "Loan products with \"Fixed\" in the name are fixed rate; all others variable. Special offer rates are used where listed."],
    ["Fixed deposit tenures", "Read from each product name (e.g. 3Mto<6M, >1Yto2Y, 5Y&above); where a bank's bands overlap at a boundary, the higher rate is used."],
    ["Premium over base", "Loan rate minus that bank's base rate."],
    ["New base rate this period", "Banks that have published this period's base rate; others still show last period's figure."],
    ["Commercial banks", "Class A institutions."],
    ["Filters", "Every table has filter buttons on its header row. Panes are frozen so headers and NMB stay in view."],
  ];
  notes.forEach(([k, v], i) => {
    const row = ws.getRow(4 + i);
    row.getCell(1).value = k; row.getCell(1).font = { bold: true, size: 10, color: { argb: XL.tealInk } };
    row.getCell(2).value = v; row.getCell(2).font = { size: 10, color: { argb: XL.ink } };
    row.getCell(1).alignment = { vertical: "top" }; row.getCell(2).alignment = { vertical: "top", wrapText: true };
    row.getCell(1).border = hairBorder; row.getCell(2).border = hairBorder;
  });
  ws.getColumn(1).width = 26; ws.getColumn(2).width = 110;
  ws.views = [{ showGridLines: false }];
}

async function downloadExcel(btn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Preparing…";
  try {
    const ExcelJS = await loadExcelJS();
    const wb = new ExcelJS.Workbook();
    wb.creator = "NMB Bank Rate Comparison";
    wb.created = new Date();
    addOverviewSheet(wb);
    addGridSheet(wb, "deposit");
    addGridSheet(wb, "loan");
    addBanksSheet(wb);
    addDetailSheet(wb);
    addNotesSheet(wb);
    const active = wb.worksheets.findIndex((w) => w.name === SHEET_FOR_TAB[state.tab]);
    wb.views = [{ activeTab: Math.max(0, active), firstSheet: 0 }];
    const buf = await wb.xlsx.writeBuffer();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    a.download = `NMB-Rate-Comparison-${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (err) {
    alert("Sorry, the Excel file could not be created: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ---------- events ----------

function showTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.id !== "tab-" + tab));
  history.replaceState(null, "", "#" + tab);
  fitGrids();
}

function setToggle(group, value) {
  document.querySelectorAll(`[data-${group}]`).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset[group] === value)));
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("button, a[data-tab]");
  if (!t) return;
  if (t.dataset.tab) { e.preventDefault(); return showTab(t.dataset.tab); }
  if (t.dataset.xlsx !== undefined) return downloadExcel(t);
  if (t.dataset.order) { state.order = t.dataset.order; setToggle("order", state.order); renderGrid("loan"); renderGrid("deposit"); return; }
  if (t.dataset.show) {
    const section = t.closest(".panel").id.replace("tab-", "");
    state.show[section] = t.dataset.show;
    t.parentElement.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === t)));
    return renderGrid(section);
  }
  if (t.dataset.bsort) {
    state.bankSort = state.bankSort === t.dataset.bsort ? null : t.dataset.bsort;
    return renderBanks();
  }
  if (t.dataset.jump) {
    const row = $(t.dataset.jump), wrap = row.closest(".grid-wrap");
    wrap.scrollTo({ top: row.offsetTop - wrap.querySelector("thead").offsetHeight, behavior: "smooth" });
  }
});
$("refresh").addEventListener("click", load);
window.addEventListener("resize", fitGrids);

state.order = "az";
state.show = { loan: "premium", deposit: "range" };
const initial = location.hash.slice(1);
if (["summary", "loan", "deposit", "banks"].includes(initial)) showTab(initial);
load();
setInterval(() => { if (!document.hidden) load(); }, AUTO_REFRESH_MS);
