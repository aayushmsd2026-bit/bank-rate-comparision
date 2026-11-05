// Nepal Bank Rates: compares Nepal's commercial banks with the reference bank as the
// reference bank. Reads the BankByaj API live in the browser and
// falls back to data/snapshot.json (refreshed hourly by GitHub Actions).
"use strict";

const API = "https://admin.bankbyaj.com/api/v1/";
let REF = null;                   // reference bank (BankByaj institute_code), chosen with the "Compare against" selector
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

let ratesReady;
state.ratesReady = new Promise((resolve) => (ratesReady = resolve));

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
  ratesReady();
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

// Ranks the reference bank among banks that have a value. ascending=true → 1 is lowest.
function standing(values, ascending) {
  const entries = Object.entries(values).filter(([, v]) => v !== null && Number.isFinite(v));
  if (!entries.length) return null;
  const vals = entries.map(([, v]) => v);
  const min = Math.min(...vals), max = Math.max(...vals);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const refv = values[REF];
  const has = refv !== undefined && refv !== null && Number.isFinite(refv);
  const rank = has ? 1 + vals.filter((v) => (ascending ? v < refv : v > refv)).length : null;
  return {
    n: vals.length, min, max, avg, refv: has ? refv : null, rank,
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

// Every comparable line (a product × variant) with its per-bank cells and the reference bank's standing.
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

// Bank's base rate vs the reference bank's, in words: "0.46 pp below the reference bank".
function baseVsRef(v, refBase) {
  if (v === null || v === undefined || refBase === null || refBase === undefined) return "";
  const d = v - refBase;
  if (Math.abs(d) < 0.005) return `<div class="b-vs">same as ${R()}</div>`;
  return `<div class="b-vs" title="This bank's base rate is ${Math.abs(d).toFixed(2)} percentage points ${d < 0 ? "lower" : "higher"} than ${R()}'s (${pct(refBase)})">${Math.abs(d).toFixed(2)} pp ${d < 0 ? "below" : "above"} ${R()}</div>`;
}

// "new" marker for banks that have already published this period's base rate.
const freshTag = (code) => (state.model.baseOld[code] === false ? `<span class="fresh" title="New base rate published this period">new</span>` : "");

// One rule everywhere: ▲ green = the reference bank ahead, ▼ red = the reference bank behind, by the gap in pp.
// diff = other − the reference bank (other = a competitor's rate, or the market average).
// lowerIsBetter: true for loans and base rate, false for deposits.
function arrow(diff, lowerIsBetter, vs = "this bank") {
  if (diff === null || diff === undefined || !Number.isFinite(diff)) return "";
  const gap = Math.abs(diff).toFixed(2);
  if (Math.abs(diff) < 0.005) return `<span class="chg even" title="${R()} level with ${vs}">=</span>`;
  const ahead = lowerIsBetter ? diff > 0 : diff < 0;
  return `<span class="chg ${ahead ? "good" : "bad"}" title="${R()} ${ahead ? "ahead of" : "behind"} ${vs} by ${gap} pp">${ahead ? "▲" : "▼"}${gap}</span>`;
}

// ---------- rendering ----------

// Reference bank: ?bank=SYMBOL in the link, else the viewer's last choice, else the first bank A–Z.
function pickRef() {
  const m = state.model;
  const bySymbol = (sym) => {
    const up = String(sym || "").toUpperCase();
    return m.banks.find((b) => (SCRIP[b.code] || "").toUpperCase() === up || (up === "RBBL" && b.code === "RBB"))?.code;
  };
  let saved = null;
  try { saved = localStorage.getItem("nbr.ref"); } catch {}
  const fromUrl = bySymbol(new URLSearchParams(location.search).get("bank"));
  const valid = (c) => c && m.banks.some((b) => b.code === c);
  REF = fromUrl || (valid(REF) ? REF : valid(saved) ? saved : [...m.banks].sort((a, b) => a.name.localeCompare(b.name))[0]?.code);
}

function setRef(code) {
  REF = code;
  try { localStorage.setItem("nbr.ref", code); } catch {}
  const url = new URL(location.href);
  url.searchParams.set("bank", SCRIP[code] || code);
  history.replaceState(null, "", url);
  render();
}

function renderRefSelect() {
  const m = state.model;
  $("ref-select").innerHTML = [...m.banks].sort((a, b) => (SCRIP[a.code] || a.name).localeCompare(SCRIP[b.code] || b.name))
    .map((b) => `<option value="${esc(b.code)}" ${b.code === REF ? "selected" : ""}>${esc(SCRIP[b.code] || b.code)} · ${esc(b.name)}</option>`).join("");
  document.querySelectorAll(".ref-label").forEach((el) => (el.textContent = R()));
  document.querySelectorAll(".ref-full").forEach((el) => (el.textContent = RN()));
}

function render() {
  const m = state.model;
  pickRef();
  renderRefSelect();
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
  renderBaseTab();
  renderBanks();
  renderUpdates();
  if (state.perf) renderPerformance();
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
  if (!s || s.refv === null) return "";
  return `<div class="kpi"><div class="k-label">NPL ratio (bad loans)</div><div class="k-value">${pct(s.refv)}</div>
    <div class="k-note">${ordinal(s.rank)} lowest of ${s.n} banks · market average ${pct(s.avg)}</div></div>`;
}

function renderKpis() {
  const m = state.model;
  const base = standing({ ...m.base }, true);
  const offered = (sec) => state.rows.filter((r) => r.section === sec && r.s.refv !== null);
  const loans = offered("loan"), deps = offered("deposit");
  const loanWins = loans.filter((r) => r.s.refv <= r.s.avg + 0.005).length;
  const depWins = deps.filter((r) => r.s.refv >= r.s.avg - 0.005).length;
  const leads = state.rows.filter((r) => r.s.rank === 1).sort((a, b) => (a.section === "deposit" ? 0 : 1) - (b.section === "deposit" ? 0 : 1));
  const leadText = leads.map(rowLabel);

  const kpi = (label, value, note, cls = "") =>
    `<div class="kpi ${cls}"><div class="k-label">${label}</div><div class="k-value">${value}</div><div class="k-note">${note}</div></div>`;
  $("kpis").innerHTML = [
    kpi("Base rate", pct(base.refv), `${ordinal(base.rank)} lowest of ${base.n} banks · market average ${pct(base.avg)}`, "featured"),
    nplKpi(),
  ].join("");
  $("kpis-summary").innerHTML = [
    kpi(`Deposits where ${R()} pays more`, `${depWins}<small> of ${deps.length}</small>`,
      `In ${depWins} of ${R()}'s ${deps.length} deposit products, ${R()} pays more than the average bank`),
    kpi(`Loans where ${R()} is cheaper`, `${loanWins}<small> of ${loans.length}</small>`,
      `In ${loanWins} of ${R()}'s ${loans.length} loan products, ${R()} charges less than the average bank`),
    kpi(`Where ${R()} is No. 1`, `${leads.length}<small> products</small>`, leads.length
      ? `Best rate of all ${m.banks.length} banks: ${esc(leadText.slice(0, 4).join(", ") + (leads.length > 4 ? ` and ${leads.length - 4} more` : ""))}`
      : `${R()} doesn't have the best rate in any product today`),
  ].join("");
}

// Position bar: left = best rate in market, right = worst. Dot = the reference bank, tick = market average.
function positionBar(r) {
  const s = r.s;
  if (s.refv === null) return "";
  const best = r.lowerIsBetter ? s.min : s.max, worst = r.lowerIsBetter ? s.max : s.min;
  const span = Math.abs(worst - best) || 1;
  const at = (v) => (Math.abs(v - best) / span) * 100;
  const better = r.lowerIsBetter ? s.refv <= s.avg + 0.005 : s.refv >= s.avg - 0.005;
  return `<div class="pos" title="Best ${pct(best)} · average ${pct(s.avg)} · worst ${pct(worst)}">
    <div class="pos-track"><i class="pos-avg" style="left:${at(s.avg).toFixed(1)}%"></i><i class="pos-dot ${better ? "good" : "bad"}" style="left:${at(s.refv).toFixed(1)}%"></i></div>
    <div class="pos-scale"><span>${pct(best)}</span><span>${pct(worst)}</span></div>
  </div>`;
}

function renderScorecard(section) {
  const m = state.model;
  const rows = state.rows.filter((r) => r.section === section);
  const shown = rows.filter((r) => r.s.refv !== null);
  const missing = rows.filter((r) => r.s.refv === null);
  let body = "", seg = null;

  if (section === "loan") {
    const base = standing({ ...m.base }, true);
    const r = { s: base, lowerIsBetter: true };
    body += `<tr class="seg"><td colspan="5">Funding</td></tr>
      <tr><td class="p-name">Base rate</td><td class="p-ref">${pct(base.refv)}</td><td class="p-rank">${base.rank}<span>/${base.n}</span></td>
      <td class="p-pos">${positionBar(r)}</td><td class="p-chg">${arrow(base.avg - base.refv, true, "the market average")}</td></tr>`;
  }
  for (const r of shown) {
    if (r.segment !== seg) { seg = r.segment; body += `<tr class="seg"><td colspan="5">${esc(seg)}</td></tr>`; }
    const refCell = r.cells[REF];
    body += `<tr>
      <td class="p-name">${esc(r.product)}${r.variant === "Fixed" ? '<span class="tag">Fixed</span>' : ""}</td>
      <td class="p-ref">${rateHtml(refCell.range)}</td>
      <td class="p-rank">${r.s.rank}<span>/${r.s.n}</span></td>
      <td class="p-pos">${positionBar(r)}</td>
      <td class="p-chg">${arrow(r.s.avg - r.s.refv, r.lowerIsBetter, "the market average")}</td>
    </tr>`;
  }
  $(`${section}-score`).innerHTML = `<thead><tr><th>Product</th><th>${R()}</th><th>Rank</th><th>Position: best → worst</th><th class="num">vs avg</th></tr></thead><tbody>${body}</tbody>`;
  $(`${section}-missing`).innerHTML = missing.length
    ? `<b>Not offered by ${R()} (${missing.length}):</b> ${missing.map((r) => esc(rowLabel(r))).join(", ")}` : "";

}

function orderedBanks() {
  const m = state.model;
  const others = m.banks.filter((b) => b.code !== REF);
  if (state.order === "base") others.sort((a, b) => (m.base[a.code] ?? 99) - (m.base[b.code] ?? 99) || a.name.localeCompare(b.name));
  else others.sort((a, b) => a.name.localeCompare(b.name));
  return [m.banks.find((b) => b.code === REF), ...others].filter(Boolean);
}

// Grid: product lines down, banks across. Product, the reference bank and Rank columns are pinned;
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
  const refBase = m.base[REF];
  const unit = (v) => (mode === "premium" ? `+${v.toFixed(2)}` : pct(v));

  let head = `<thead><tr>
    <th class="pin c1">Product</th>
    <th class="pin c2 ref"><div class="ref-name" title="${RN()} (reference bank)">${R()}</div><div class="b-base">Base <b>${pct(refBase)}</b>${freshTag(REF)}</div></th>
    <th class="pin c3">Rank<div class="b-base">best in market</div></th>`;
  for (const b of others) {
    const name = `<div class="b-name scrip" title="${bankLabel(b.code)}">${esc(SCRIP[b.code] || m.nameOf[b.code])}</div>`;
    head += `<th class="narrow">${name}<div class="b-base">Base <b>${pct(m.base[b.code])}</b>${freshTag(b.code)}</div>${baseVsRef(m.base[b.code], refBase)}</th>`;
  }
  head += `</tr></thead>`;

  const segments = [];
  let body = "", seg = null;
  for (const r of rows) {
    if (r.segment !== seg) {
      seg = r.segment;
      const id = `${section}-seg-${segments.length}`;
      segments.push([seg, id]);
      body += `<tr class="seg" id="${id}"><td class="pin c1">${esc(seg)}</td><td class="pin c2 ref"></td><td class="pin c3"></td><td colspan="${others.length}"></td></tr>`;
    }
    const s = r.s;
    const best = r.lowerIsBetter ? s.min : s.max;
    const refv = r.cells[REF];
    const tip = (c) => esc(c.products.map((p) => {
      const extra = [p.processing_fee && `fee ${p.processing_fee}`, p.minimum_balance && p.minimum_balance !== "0" && `min. balance ${p.minimum_balance}`,
        p.max_tenure && p.max_tenure !== "-" && `tenure ${p.max_tenure}`].filter(Boolean).join(", ");
      return `${p.name}: ${p.rate.lo === p.rate.hi ? pct(p.rate.lo) : pct(p.rate.lo) + " – " + pct(p.rate.hi)}${extra ? ` (${extra})` : ""}`;
    }).join("\n"));
    const cellRange = (c) => ({ ...c.range, single: c.value });
    const star = (c) => (Math.abs(c.value - best) < 0.005 ? `<span class="star" title="Best in market">★</span>` : "");

    body += `<tr class="${r.variant === "Fixed" ? "sub" : ""}">
      <td class="pin c1">${r.variant === "Fixed" ? `<span class="tag">Fixed</span>` : esc(r.product)}${r.variant === "Variable" ? `<span class="var">variable</span>` : ""}</td>
      <td class="pin c2 ref" ${refv ? `title="${tip(refv)}"` : ""}>${refv ? `<div class="rate">${rateHtml(cellRange(refv), mode)}${star(refv)}</div>` : '<span class="na">Not offered</span>'}</td>
      <td class="pin c3"><div class="rank">${s.rank ? `${s.rank}<span>/${s.n}</span>` : '<span class="na">—</span>'}</div><div class="best">${unit(best)}</div></td>`;
    for (const b of others) {
      const c = r.cells[b.code];
      if (!c) { body += `<td><span class="na">—</span></td>`; continue; }
      body += `<td title="${tip(c)}"><div class="rate">${rateHtml(cellRange(c), mode)}${star(c)}</div>${refv ? arrow(c.value - refv.value, r.lowerIsBetter) : ""}</td>`;
    }
    body += `</tr>`;
  }
  $(`${section}-table`).innerHTML = head + `<tbody>${body}</tbody>`;
  $(`${section}-jump`).innerHTML = segments.map(([name, id]) => `<button type="button" data-jump="${id}">${esc(name)}</button>`).join("");
}

// "0.46 pp below the reference bank" — a plain statement of a bank's figure relative to the reference bank's.
function vsRefWords(d, what = "figure") {
  if (d === null || d === undefined || !Number.isFinite(d)) return "";
  if (Math.abs(d) < 0.005) return `<div class="b-vs">same as ${R()}</div>`;
  const gap = Math.abs(d).toFixed(2);
  return `<div class="b-vs" title="This bank's ${what} is ${gap} percentage points ${d < 0 ? "lower" : "higher"} than ${R()}'s">${gap} pp ${d < 0 ? "below" : "above"} ${R()}</div>`;
}

const scripOf = (code) => SCRIP[code] || state.model.nameOf[code];

// Base rate analysis: headline figures, a ranked bar chart and a bank × bank matrix.
function renderBaseTab() {
  const m = state.model;
  const list = m.banks.filter((b) => m.base[b.code] !== undefined && m.base[b.code] !== null)
    .map((b) => ({ ...b, v: m.base[b.code] })).sort((a, b) => a.v - b.v || a.name.localeCompare(b.name));
  if (!list.length) return;
  const vals = list.map((b) => b.v);
  const s = standing({ ...m.base }, true);
  const sorted = [...vals].sort((a, b) => a - b);
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const refv = m.base[REF];
  const lowest = list[0], highest = list[list.length - 1];
  const fresh = list.filter((b) => m.baseOld[b.code] === false);

  const kpi = (label, value, note, cls = "") =>
    `<div class="kpi ${cls}"><div class="k-label">${label}</div><div class="k-value">${value}</div><div class="k-note">${note}</div></div>`;
  $("base-kpis").innerHTML = [
    kpi(`${R()} base rate`, pct(refv), `${ordinal(s.rank)} lowest of ${s.n} banks`, "featured"),
    kpi("Market average", pct(s.avg), `${R()} is ${Math.abs(refv - s.avg).toFixed(2)} pp ${refv >= s.avg ? "above" : "below"} the average · median ${pct(median)}`),
    kpi("Lowest", pct(lowest.v), `${esc(lowest.name)} · ${Math.abs(refv - lowest.v).toFixed(2)} pp below ${R()}`),
    kpi("Highest", pct(highest.v), `${esc(highest.name)} · ${Math.abs(highest.v - refv).toFixed(2)} pp ${highest.v >= refv ? "above" : "below"} ${R()}`),
    kpi("Published this period", `${fresh.length}<small> of ${list.length}</small>`, fresh.length ? `New base rate from ${esc(fresh.map((b) => b.name).join(", "))}; others show last period's` : "All banks still show last period's base rate"),
  ].join("");

  // Ranked bars: the scale starts just below the lowest rate so differences are visible.
  const lo = Math.floor((sorted[0] - 0.3) * 10) / 10, hi = sorted[sorted.length - 1];
  const at = (v) => (((v - lo) / (hi - lo)) * 100).toFixed(1);
  $("base-bars").innerHTML = list.map((b, i) => {
    const me = b.code === REF;
    return `<div class="bar-row ${me ? "me" : ""}">
      <span class="bar-rank">${i + 1}</span>
      <span class="bar-name" title="${esc(b.name)}">${esc(b.name)}${freshTag(b.code)}</span>
      <span class="bar-track"><i class="bar-fill" style="width:${at(b.v)}%"></i><i class="bar-avg" style="left:${at(s.avg)}%" title="Market average ${pct(s.avg)}"></i></span>
      <span class="bar-val">${pct(b.v)}</span>
      <span class="bar-vs">${me ? `${R()}` : vsRefWords(b.v - refv, "base rate").replace(/<\/?div[^>]*>/g, "")}</span>
    </div>`;
  }).join("") + `<div class="bar-axis"><span></span><span></span><span class="bar-track"><i class="bar-avg-key" style="left:${at(s.avg)}%">avg ${pct(s.avg)}</i></span><span></span><span></span></div>`;

  // Matrix: cell = row bank's base rate − column bank's base rate.
  const maxAbs = Math.max(...vals) - Math.min(...vals) || 1;
  const shade = (d) => {
    if (Math.abs(d) < 0.005) return "";
    const a = (0.12 + 0.6 * Math.min(1, Math.abs(d) / maxAbs)).toFixed(2);
    return d < 0 ? `background: rgba(52,81,178,${a})` : `background: rgba(217,154,6,${a})`;
  };
  let head = `<thead><tr><th class="mx-corner">Row − column<br><span>(pp)</span></th>`;
  for (const c of list) head += `<th class="${c.code === REF ? "me" : ""}" title="${esc(c.name)} · ${pct(c.v)}"><div>${esc(scripOf(c.code))}</div><span>${pct(c.v)}</span></th>`;
  head += `</tr></thead>`;
  let body = "";
  for (const r of list) {
    body += `<tr class="${r.code === REF ? "me" : ""}"><th title="${esc(r.name)}"><div>${esc(scripOf(r.code))}</div><span>${pct(r.v)}</span></th>`;
    for (const c of list) {
      const d = r.v - c.v;
      const cls = [r.code === c.code ? "diag" : "", c.code === REF ? "me-col" : ""].join(" ");
      const tip = r.code === c.code ? esc(r.name) : `${esc(r.name)} (${pct(r.v)}) is ${Math.abs(d).toFixed(2)} pp ${d < 0 ? "below" : d > 0 ? "above" : "level with"} ${esc(c.name)} (${pct(c.v)})`;
      body += `<td class="${cls}" style="${r.code === c.code ? "" : shade(d)}" title="${tip}">${r.code === c.code ? "" : Math.abs(d) < 0.005 ? "0" : (d > 0 ? "+" : "−") + Math.abs(d).toFixed(2)}</td>`;
    }
    body += `</tr>`;
  }
  $("base-matrix").innerHTML = head + `<tbody>${body}</tbody>`;
}

// Bank profiles: one row per bank, key metrics as columns. the reference bank first, then the
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

  const others = m.banks.filter((b) => b.code !== REF);
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
  const list = [m.banks.find((b) => b.code === REF), ...others].filter(Boolean);

  let head = `<thead><tr><th class="sortable ${state.bankSort ? "" : "on"}"><button type="button" data-bsort="">Bank</button></th>`;
  for (const mt of metrics) {
    const s = stats[mt.key];
    head += `<th class="num sortable ${state.bankSort === mt.key ? "on" : ""}"><button type="button" data-bsort="${mt.key}" title="Sort best first">${esc(mt.label)}${state.bankSort === mt.key ? " ↓" : ""}</button>
      <div class="th-note">${esc(mt.note)}</div>${s && s.rank ? `<div class="th-rank">${R()} ${s.rank}/${s.n}</div>` : ""}</th>`;
  }
  head += `</tr></thead>`;

  let body = "";
  for (const b of list) {
    const me = b.code === REF;
    body += `<tr class="${me ? "ref-row" : ""}"><td class="bank">${bankLabel(b.code)}</td>`;
    for (const mt of metrics) {
      const v = mt.get(b.code), nv = mt.get(REF), s = stats[mt.key];
      const best = s && v !== null && Math.abs(v - (mt.lower ? s.min : s.max)) < 0.005 ? `<span class="star" title="Best in market">★</span>` : "";
      const cmp = me || mt.count || v === null || nv === null ? "" : vsRefWords(v - nv, mt.label);
      body += `<td class="num"><span class="val">${fmt(mt, v, b.code)}</span>${mt.tag ? mt.tag(b.code) : ""}${best}${cmp}</td>`;
    }
    body += `</tr>`;
  }
  const avg = metrics.map((mt) => (stats[mt.key] ? `<td class="num">${fmt(mt, stats[mt.key].avg)}</td>` : `<td></td>`)).join("");
  body += `<tr class="avg-row"><td class="bank">Market average</td>${avg}</tr>`;
  $("banks-table").innerHTML = head + `<tbody>${body}</tbody>`;
}

// ---------- quarterly performance ----------
// data/performance.json holds one entry per quarter, keyed by NEPSE symbol.
// Each quarter is added by hand from published quarterly figures (see README).

// unit: arba = Rs arba (billion), pct = %, rs = Rs per share, x = times.
// better: which direction ranks first; null = no better/worse (shown, not ranked).
const PERF_METRICS = [
  { key: "net_profit", label: "Net profit", unit: "arba", better: "high", groups: ["key", "profit"] },
  { key: "net_profit_growth", label: "Profit growth", note: "vs same quarter last year", unit: "pct", better: "high", groups: ["key", "profit"], median: true },
  { key: "deposits", label: "Deposits", unit: "arba", better: "high", groups: ["key", "size"] },
  { key: "loans", label: "Loans", unit: "arba", better: "high", groups: ["key", "size"] },
  { key: "paid_up_capital", label: "Paid-up capital", unit: "arba", better: "high", groups: ["size"] },
  { key: "reserves", label: "Reserves", unit: "arba", better: "high", groups: ["size"] },
  { key: "net_interest_income", label: "Net interest income", unit: "arba", better: "high", groups: ["profit"] },
  { key: "roe", label: "Return on equity", unit: "pct", better: "high", groups: ["key", "profit"] },
  { key: "roa", label: "Return on assets", unit: "pct", better: "high", groups: ["profit"] },
  { key: "npl", label: "NPL ratio", note: "bad loans", unit: "pct", better: "low", groups: ["key", "quality"] },
  { key: "car", label: "Capital adequacy", unit: "pct", better: "high", groups: ["key", "quality"] },
  { key: "impairment", label: "Impairment charge", note: "loan-loss provisions", unit: "arba", better: "low", groups: ["quality"] },
  { key: "cost_of_funds", label: "Cost of funds", unit: "pct", better: "low", groups: ["pricing"] },
  { key: "interest_spread", label: "Interest spread", unit: "pct", better: "high", groups: ["pricing"] },
  { key: "base_rate", label: "Base rate", unit: "pct", better: "low", groups: ["pricing"] },
  { key: "cd_ratio", label: "CD ratio", note: "loans ÷ deposits", unit: "pct", better: null, groups: ["key", "pricing"] },
  { key: "eps", label: "EPS", note: "annualised", unit: "rs", better: "high", groups: ["share"] },
  { key: "distributable_profit_per_share", label: "Distributable profit / share", unit: "rs", better: "high", groups: ["share"] },
  { key: "net_worth_per_share", label: "Net worth / share", unit: "rs", better: "high", groups: ["share"] },
  { key: "pe_ratio", label: "P/E ratio", note: "at quarter end", unit: "x", better: null, groups: ["share"] },
];
const PERF_GROUPS = [["key", "Key figures"], ["profit", "Profitability"], ["size", "Size"], ["quality", "Asset quality & capital"], ["pricing", "Pricing & liquidity"], ["share", "Per share"], ["all", "All"]];
// Short label (NEPSE symbol) and full name of the reference bank, for display.
// Bank names are plain text (letters, spaces, dots, apostrophes), safe in HTML and Excel alike.
const R = () => SCRIP[REF] || REF;
const RN = () => state.model?.nameOf[REF] || state.perf?.names?.[refSym()] || REF;
// The reference bank's symbol in performance.json (RBB is published as RBBL).
const refSym = () => (REF === "RBB" ? "RBBL" : SCRIP[REF] || REF);

async function loadPerformance() {
  try {
    state.perf = await getJson("data/performance.json?t=" + Date.now());
    state.perfQ ||= state.perf.quarters[0]?.id;
    renderPerformance();
  } catch (err) {
    $("perf-body").innerHTML = `<p class="notice">Could not load quarterly figures (${esc(err.message)}).</p>`;
  }
}

const perfQuarter = () => state.perf?.quarters.find((q) => q.id === state.perfQ);
const perfName = (sym) => state.perf?.names?.[sym] || sym;
const perfVal = (q, sym, mt) => {
  const v = q.banks[sym]?.[mt.key];
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  if (mt.key === "pe_ratio" && v <= 0) return null;   // unlisted (RBB) or loss-making: no meaningful P/E
  return v;
};
function perfFmt(mt, v) {
  if (v === null) return '<span class="na">—</span>';
  if (mt.unit === "arba") return `Rs ${v.toFixed(2)}<small> arba</small>`;
  if (mt.unit === "pct") return pct(v);
  if (mt.unit === "rs") return `Rs ${v.toFixed(2)}`;
  return `${v.toFixed(2)}×`;
}
function perfVsWords(mt, d) {
  if (d === null || !Number.isFinite(d)) return "";
  if (Math.abs(d) < 0.005) return `<div class="b-vs">same as ${R()}</div>`;
  const g = Math.abs(d).toFixed(2);
  const amt = mt.unit === "arba" ? `Rs ${g} arba` : mt.unit === "rs" ? `Rs ${g}` : mt.unit === "pct" ? `${g} pp` : g;
  return `<div class="b-vs">${amt} ${d < 0 ? "below" : "above"} ${R()}</div>`;
}
// standing() finds the reference bank under its BankByaj code, so the reference bank's symbol is swapped for it here and back after.
function perfStanding(q, mt) {
  const toKey = (sym) => (sym === refSym() ? REF : sym);
  const s = standing(Object.fromEntries(Object.keys(q.banks).map((sym) => [toKey(sym), perfVal(q, sym, mt)])), mt.better !== "high");
  if (!s) return null;
  const toSym = (k) => (k === REF ? refSym() : k);
  // A few banks grow from a tiny base (e.g. +2,524%), so growth uses the median as its "average".
  const vals = Object.keys(q.banks).map((sym) => perfVal(q, sym, mt)).filter((v) => v !== null).sort((a, b) => a - b);
  const mid = vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
  return { ...s, avg: mt.median ? mid : s.avg, avgLabel: mt.median ? "median" : "avg", minBanks: s.minBanks.map(toSym), maxBanks: s.maxBanks.map(toSym) };
}

// Rank of one bank on one measure (1 = best), or null when the measure isn't ranked.
function perfRank(q, mt, sym) {
  const v = perfVal(q, sym, mt);
  if (!mt.better || v === null) return null;
  const vals = Object.keys(q.banks).map((s) => perfVal(q, s, mt)).filter((x) => x !== null);
  return { rank: 1 + vals.filter((x) => (mt.better === "high" ? x > v : x < v)).length, n: vals.length };
}
// Rank badge, coloured by third: top third green, middle grey, bottom third red.
function rankChip(r) {
  if (!r) return "";
  const t = r.rank <= r.n / 3 ? "t1" : r.rank > (2 * r.n) / 3 ? "t3" : "t2";
  return `<span class="rk ${t}" title="Rank ${r.rank} of ${r.n}">#${r.rank}</span>`;
}

function renderPerformance() {
  const q = perfQuarter();
  if (!q) return;
  $("perf-quarter").innerHTML = state.perf.quarters.map((x) => `<option value="${esc(x.id)}" ${x.id === q.id ? "selected" : ""}>${esc(x.label)}</option>`).join("");
  $("perf-source").innerHTML = `${esc(q.period)} · figures as compiled by <a href="${esc(q.source.url)}" target="_blank" rel="noopener">${esc(q.source.name)}</a> (${esc(q.source.published)}) from the banks' unaudited quarterly reports`;

  // Headline figures for the reference bank
  const rb = q.banks[refSym()] || {};
  const card = (key, cls = "") => {
    const mt = PERF_METRICS.find((m) => m.key === key);
    const s = perfStanding(q, mt), v = perfVal(q, refSym(), mt);
    const rank = s && s.rank && mt.better ? `${ordinal(s.rank)} ${mt.better === "high" ? "highest" : "lowest"} of ${s.n}` : "";
    const extra = key === "net_profit" && rb.net_profit_growth !== undefined ? ` · ${rb.net_profit_growth >= 0 ? "+" : ""}${rb.net_profit_growth.toFixed(2)}% vs last year` : "";
    return `<div class="kpi ${cls}"><div class="k-label">${esc(R())} · ${esc(mt.label)}${mt.note ? ` <span class="k-sub">(${esc(mt.note)})</span>` : ""}</div>
      <div class="k-value">${perfFmt(mt, v)}</div><div class="k-note">${rank}${extra}${s ? ` · market ${s.avgLabel} ${perfFmt(mt, s.avg).replace(/<[^>]+>/g, "")}` : ""}</div></div>`;
  };
  $("perf-kpis").innerHTML = card("net_profit", "featured") + card("npl") + card("car") + card("roe") + card("cd_ratio");

  // Controls
  const group = state.perfGroup || "key";
  $("perf-groups").innerHTML = PERF_GROUPS.map(([g, label]) => `<button type="button" data-pgroup="${g}" aria-pressed="${g === group}">${esc(label)}</button>`).join("");
  const metrics = PERF_METRICS.filter((mt) => group === "all" || mt.groups.includes(group));
  if (state.perfSort && !metrics.some((mt) => mt.key === state.perfSort)) state.perfSort = null;
  const sortMt = PERF_METRICS.find((mt) => mt.key === state.perfSort);
  $("perf-sort").innerHTML = `<option value="">Bank name (A–Z)</option>` + metrics.map((mt) => `<option value="${mt.key}" ${mt.key === state.perfSort ? "selected" : ""}>${esc(mt.label)}</option>`).join("");
  $("perf-dir").hidden = !sortMt;
  document.querySelectorAll("[data-pdir]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.pdir === (state.perfDir || "best"))));
  if (sortMt && !sortMt.better) $("perf-dir").querySelector('[data-pdir="best"]').textContent = "High to low", $("perf-dir").querySelector('[data-pdir="worst"]').textContent = "Low to high";
  else $("perf-dir").querySelector('[data-pdir="best"]').textContent = "Best first", $("perf-dir").querySelector('[data-pdir="worst"]').textContent = "Worst first";

  renderPerfTable(q, metrics, sortMt);
  renderHeadToHead(q);
  const chartMt = PERF_METRICS.find((mt) => mt.key === (state.perfChart || sortMt?.key)) || PERF_METRICS[0];
  $("perf-chart-metric").innerHTML = PERF_METRICS.map((mt) => `<option value="${mt.key}" ${mt.key === chartMt.key ? "selected" : ""}>${esc(mt.label)}</option>`).join("");
  renderPerfChart(q, chartMt);

  const notes = Object.entries(q.notes || {}).map(([k, v]) => {
    const [sym, key] = k.includes(".") ? k.split(".") : [null, k];
    const mt = PERF_METRICS.find((m) => m.key === key);
    return `<li><b>${esc(sym ? `${sym} · ${mt?.label || key}` : mt?.label || key)}:</b> ${esc(v)}</li>`;
  });
  $("perf-notes").innerHTML = notes.length ? `<h3>Notes on the data</h3><ul>${notes.join("")}</ul>` : "";
}

function renderPerfTable(q, metrics, sortMt) {
  const ref = refSym();
  const term = (state.perfSearch || "").trim().toLowerCase();
  let syms = Object.keys(q.banks).filter((s) => s !== ref && (!term || s.toLowerCase().includes(term) || perfName(s).toLowerCase().includes(term)));
  if (sortMt) {
    // "best first" follows the measure's direction; for unranked measures it means high to low.
    let dir = sortMt.better === "low" ? 1 : -1;
    if ((state.perfDir || "best") === "worst") dir = -dir;
    syms.sort((a, b) => {
      const va = perfVal(q, a, sortMt), vb = perfVal(q, b, sortMt);
      if (va === null) return 1;
      if (vb === null) return -1;
      return (va - vb) * dir || a.localeCompare(b);
    });
  } else syms.sort((a, b) => perfName(a).localeCompare(perfName(b)));
  const list = q.banks[ref] ? [ref, ...syms] : syms;
  const stats = Object.fromEntries(metrics.map((mt) => [mt.key, perfStanding(q, mt)]));

  let head = `<thead><tr><th class="rank-col">${sortMt ? "#" : ""}</th><th class="bank-col"><button type="button" data-psort="">Bank</button></th>`;
  for (const mt of metrics) {
    const s = stats[mt.key], on = state.perfSort === mt.key;
    head += `<th class="num ${on ? "on" : ""}"><button type="button" data-psort="${mt.key}" title="Sort by ${esc(mt.label)}">${esc(mt.label)}${on ? ((state.perfDir || "best") === "best" ? " ↓" : " ↑") : ""}</button>
      <div class="th-note">${mt.better ? (mt.better === "high" ? "higher is better" : "lower is better") : esc(mt.note || "not ranked")}</div>
      ${s && s.rank && mt.better ? `<div class="th-rank">${esc(R())} ${s.rank}/${s.n}</div>` : ""}</th>`;
  }
  head += `</tr></thead>`;

  let body = "", pos = 0;
  for (const sym of list) {
    const me = sym === ref;
    if (!me) pos++;
    const pr = sortMt ? perfRank(q, sortMt, sym) : null;
    body += `<tr class="${me ? "ref-row" : "pick"}" ${me ? "" : `data-sym="${esc(sym)}" title="Compare ${esc(sym)} with ${esc(R())}"`}>
      <td class="rank-col">${sortMt ? (pr ? pr.rank : "—") : ""}</td>
      <td class="bank-col"><b>${esc(sym)}</b><span class="bank-full">${esc(perfName(sym))}${me ? " · your comparison bank" : ""}</span></td>`;
    for (const mt of metrics) {
      const v = perfVal(q, sym, mt), nv = perfVal(q, ref, mt), s = stats[mt.key];
      const best = mt.better && s && v !== null && Math.abs(v - (mt.better === "high" ? s.max : s.min)) < 0.005 ? `<span class="star" title="Best of all banks">★</span>` : "";
      const flag = q.notes?.[`${sym}.${mt.key}`] ? `<span class="flag" title="${esc(q.notes[`${sym}.${mt.key}`])}">⚠</span>` : "";
      body += `<td class="num"><div class="cell-top"><span class="val">${perfFmt(mt, v)}</span>${best}${flag}${rankChip(perfRank(q, mt, sym))}</div>${me || v === null || nv === null ? "" : perfVsWords(mt, v - nv)}</td>`;
    }
    body += `</tr>`;
  }
  if (!syms.length) body += `<tr><td></td><td colspan="${metrics.length + 1}" class="empty-row">No bank matches “${esc(state.perfSearch)}”</td></tr>`;
  const avg = metrics.map((mt) => `<td class="num">${stats[mt.key] ? perfFmt(mt, stats[mt.key].avg) + (mt.median ? '<div class="b-vs">median</div>' : "") : ""}</td>`).join("");
  body += `<tr class="avg-row"><td></td><td class="bank-col">Average of ${Object.keys(q.banks).length} banks</td>${avg}</tr>`;
  $("perf-table").innerHTML = head + `<tbody>${body}</tbody>`;
  // the comparison bank's row sticks just under the column headings
  const h = $("perf-table").tHead?.offsetHeight;
  if (h) $("perf-table").style.setProperty("--perf-head-h", h + "px");
  $("perf-count").textContent = term ? `${syms.length} of ${Object.keys(q.banks).length - 1} banks shown` : "";
}

// Side-by-side: the comparison bank vs one other bank, across every measure.
function renderHeadToHead(q) {
  const ref = refSym(), other = state.perfH2H;
  const box = $("perf-h2h");
  if (!other || other === ref || !q.banks[other]) { box.hidden = true; box.innerHTML = ""; return; }
  let wins = 0, losses = 0, rows = "";
  for (const [g, gl] of PERF_GROUPS.filter(([g]) => !["key", "all"].includes(g))) {
    rows += `<tr class="h2h-seg"><td colspan="4">${esc(gl)}</td></tr>`;
    for (const mt of PERF_METRICS.filter((m) => m.groups.includes(g))) {
      const a = perfVal(q, ref, mt), b = perfVal(q, other, mt);
      let verdict = "";
      if (mt.better && a !== null && b !== null && Math.abs(a - b) >= 0.005) {
        const refBetter = mt.better === "high" ? a > b : a < b;
        refBetter ? wins++ : losses++;
        verdict = `<span class="h2h-win ${refBetter ? "a" : "b"}">${esc(refBetter ? ref : other)}</span>`;
      } else if (mt.better && a !== null && b !== null) verdict = `<span class="h2h-tie">level</span>`;
      else verdict = `<span class="dim">${mt.better ? "—" : "not ranked"}</span>`;
      rows += `<tr><td>${esc(mt.label)}</td>
        <td class="num ${verdict.includes('class="h2h-win a"') ? "won" : ""}">${perfFmt(mt, a)} ${rankChip(perfRank(q, mt, ref))}</td>
        <td class="num ${verdict.includes('class="h2h-win b"') ? "won" : ""}">${perfFmt(mt, b)} ${rankChip(perfRank(q, mt, other))}</td>
        <td>${verdict}</td></tr>`;
    }
  }
  const others = Object.keys(q.banks).filter((s) => s !== ref).sort();
  box.hidden = false;
  box.innerHTML = `<header class="card-head h2h-head">
      <div><h2>Head to head: ${esc(ref)} vs <select id="perf-h2h-pick" aria-label="Bank to compare">${others.map((s) => `<option value="${esc(s)}" ${s === other ? "selected" : ""}>${esc(s)} · ${esc(perfName(s))}</option>`).join("")}</select></h2>
      <p><b>${esc(ref)}</b> is better on <b>${wins}</b> of ${wins + losses} ranked measures; <b>${esc(other)}</b> on <b>${losses}</b>. Badges show each bank's rank among all ${Object.keys(q.banks).length}.</p></div>
      <button type="button" class="btn-ghost dark" data-h2h-close title="Close">✕ Close</button>
    </header>
    <div class="h2h-wrap"><table class="h2h"><thead><tr><th>Measure</th><th class="num">${esc(ref)}</th><th class="num">${esc(other)}</th><th>Better</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// Ranked bars for one measure; bars grow from zero so negatives point left.
function renderPerfChart(q, mt) {
  const rows = Object.keys(q.banks).map((s) => ({ s, v: perfVal(q, s, mt) })).filter((r) => r.v !== null);
  rows.sort((a, b) => (mt.better === "low" ? a.v - b.v : b.v - a.v));
  const lo = Math.min(0, ...rows.map((r) => r.v)), hi = Math.max(0, ...rows.map((r) => r.v));
  const span = hi - lo || 1;
  const x = (v) => ((v - lo) / span) * 100;
  const avg = perfStanding(q, mt)?.avg ?? 0;
  $("perf-chart-title").textContent = `${mt.label}: all banks ranked${mt.better ? (mt.better === "high" ? ", highest first" : ", lowest first") : ""}`;
  $("perf-chart").innerHTML = rows.map((r, i) => {
    const me = r.s === refSym();
    const left = Math.min(x(0), x(r.v)), width = Math.abs(x(r.v) - x(0));
    return `<div class="bar-row ${me ? "me" : ""}">
      <span class="bar-rank">${mt.better ? i + 1 : ""}</span>
      <span class="bar-name" title="${esc(perfName(r.s))}"><b>${esc(r.s)}</b> <span class="bank-full">${esc(perfName(r.s))}</span></span>
      <span class="bar-track">${lo < 0 ? `<i class="bar-zero" style="left:${x(0).toFixed(1)}%"></i>` : ""}<i class="bar-fill ${r.v < 0 ? "neg" : ""}" style="left:${left.toFixed(1)}%;width:${Math.max(width, 0.4).toFixed(1)}%"></i><i class="bar-avg" style="left:${x(avg).toFixed(1)}%" title="${mt.median ? "Median" : "Average"} ${perfFmt(mt, avg).replace(/<[^>]+>/g, "")}"></i></span>
      <span class="bar-val">${perfFmt(mt, r.v).replace(/<small>.*?<\/small>/, "")}</span>
      <span class="bar-vs">${me ? `${R()}` : perfVsWords(mt, r.v - perfVal(q, refSym(), mt)).replace(/<\/?div[^>]*>/g, "")}</span>
    </div>`;
  }).join("");
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
// numbers, so filters, sorting and pivots work. Gap format: ▲ green = the reference bank ahead,
// ▼ red = the reference bank behind, matching the website.
const XL = {
  brand: "FF3451B2", brandInk: "FF2A4196", tint: "FFEEF2FC", ink: "FF1E242A", muted: "FF64748B",
  good: "FF15803D", goodBg: "FFE7F6EC", bad: "FFC81E1E", badBg: "FFFDECEC", band: "FFF8FAFC",
  hair: "FFE2E8F0", gold: "FFA16207", white: "FFFFFFFF",
};
const PCT = "0.00%";
const PP = '+0.00" pp";-0.00" pp";0.00" pp"';
const GAP = '"▲ "0.00;"▼ "0.00;"="';
const DIFF = () => `0.00" pp above ${R()}";0.00" pp below ${R()}";"same as ${R()}"`;
const SHEET_FOR_TAB = { summary: "Overview", deposit: "Deposits", loan: "Lending", base: "Base rate", banks: "Banks", perf: "Performance" };

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
// Positive = the reference bank ahead. diff = other − the reference bank, as in arrow().
const advantage = (diff, lowerIsBetter) => (diff === null || !Number.isFinite(diff) ? null : asNum(lowerIsBetter ? diff : -diff));

function sheetTitle(ws, title, lastCol) {
  const m = state.model;
  ws.mergeCells(1, 1, 1, lastCol);
  ws.getCell(1, 1).value = title;
  ws.getCell(1, 1).font = { name: "Calibri", size: 16, bold: true, color: { argb: XL.ink } };
  ws.getRow(1).height = 26;
  ws.mergeCells(2, 1, 2, lastCol);
  const src = state.source === "live" ? "Live data" : "Backup copy";
  ws.getCell(2, 1).value = `${RN()} vs ${m.banks.length} commercial banks · ${src} as of ${fmtDate(state.data.fetched_at)}${m.modified ? ` · rates last updated ${fmtDate(m.modified)}` : ""}`;
  ws.getCell(2, 1).font = { size: 10, color: { argb: XL.muted } };
}

function headerRow(ws, rowNo, labels, opts = {}) {
  const row = ws.getRow(rowNo);
  labels.forEach((label, i) => {
    const c = row.getCell(i + 1);
    c.value = label;
    const refv = opts.refCol && i + 1 === opts.refCol;
    c.fill = fill(refv ? XL.brandInk : XL.brand);
    c.font = { bold: true, color: { argb: XL.white }, size: 10 };
    c.alignment = { vertical: "middle", horizontal: i < (opts.textCols ?? 1) ? "left" : "center", wrapText: true };
    c.border = { bottom: { style: "medium", color: { argb: XL.brandInk } } };
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
  const ws = wb.addWorksheet("Overview", { properties: { tabColor: { argb: XL.brand } } });
  const cols = ["Section", "Segment", "Product", "Variant", `${R()} rate`, `${R()} rank`, "Banks", "Market best", "Best bank(s)", "Market average", "Market worst", `${R()} vs average`];
  sheetTitle(ws, "Market position — scorecard", cols.length);

  // Headline figures
  const base = standing({ ...m.base }, true), npa = standing({ ...m.npa }, true);
  const offered = (sec) => state.rows.filter((r) => r.section === sec && r.s.refv !== null);
  const deps = offered("deposit"), loans = offered("loan");
  const kpis = [
    ["Base rate", asPct(base.refv), PCT, `${ordinal(base.rank)} lowest of ${base.n} banks · market average ${pct(base.avg)}`],
    ["NPL ratio (bad loans)", asPct(npa?.refv), PCT, npa ? `${ordinal(npa.rank)} lowest of ${npa.n} banks · market average ${pct(npa.avg)}` : ""],
    [`Deposits where ${R()} pays more`, `${deps.filter((r) => r.s.refv >= r.s.avg - 0.005).length} of ${deps.length}`, null, `deposit products where ${R()} pays more than the average bank`],
    [`Loans where ${R()} is cheaper`, `${loans.filter((r) => r.s.refv <= r.s.avg + 0.005).length} of ${loans.length}`, null, `loan products where ${R()} charges less than the average bank`],
    [`Where ${R()} is No. 1`, state.rows.filter((r) => r.s.rank === 1).length, null, "best rate of all banks: " + state.rows.filter((r) => r.s.rank === 1).map(rowLabel).join(", ")],
  ];
  kpis.forEach(([label, value, fmt, note], i) => {
    const r = ws.getRow(4 + i);
    r.getCell(1).value = label; r.getCell(1).font = { bold: true, size: 10, color: { argb: XL.ink } };
    ws.mergeCells(4 + i, 1, 4 + i, 2);
    r.getCell(3).value = value; r.getCell(3).font = { bold: true, size: 12, color: { argb: XL.brandInk } };
    r.getCell(3).alignment = { horizontal: "left" };
    if (fmt) r.getCell(3).numFmt = fmt;
    ws.mergeCells(4 + i, 4, 4 + i, cols.length);
    r.getCell(4).value = note; r.getCell(4).font = { size: 10, color: { argb: XL.muted } };
  });

  const H = 4 + kpis.length + 1;
  headerRow(ws, H, cols, { textCols: 4 });
  let r = H + 1;
  const line = (section, segment, product, variant, s, lowerIsBetter, refText) => {
    const best = lowerIsBetter ? s.min : s.max, worst = lowerIsBetter ? s.max : s.min;
    const bestBanks = (lowerIsBetter ? s.minBanks : s.maxBanks).map((c) => m.nameOf[c]).join(", ");
    const row = ws.getRow(r++);
    row.values = [section, segment, product, variant || "", refText ?? "Not offered", s.rank ?? "", s.n, asPct(best), bestBanks, asPct(s.avg), asPct(worst)];
    [8, 10, 11].forEach((c) => (row.getCell(c).numFmt = PCT));
    gapCell(row.getCell(12), s.refv === null ? null : advantage(s.avg - s.refv, lowerIsBetter));
    row.getCell(9).alignment = { horizontal: "left", vertical: "middle" };
    row.getCell(5).font = { bold: true, color: { argb: s.refv === null ? XL.muted : XL.brandInk }, size: 10 };
  };
  line("Lending", "Funding", "Base rate", "", base, true, pct(base.refv));
  for (const sec of ["deposit", "loan"]) {
    for (const row of state.rows.filter((x) => x.section === sec)) {
      const c = row.cells[REF];
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
  const ws = wb.addWorksheet(isLoan ? "Lending" : "Deposits", { properties: { tabColor: { argb: isLoan ? XL.ink : XL.brand } } });
  const banks = orderedBanks();
  const lead = isLoan ? ["Segment", "Product", "Variant"] : ["Segment", "Product"];
  const fixedCols = [...lead, `${R()} rank`, "Banks", "Market best", "Market average"];
  const cols = [...fixedCols, ...banks.map((b) => (b.code === REF ? `${RN()}` : b.name))];
  const refCol = fixedCols.length + 1;
  sheetTitle(ws, isLoan ? "Lending rates — each bank's lowest rate per product" : "Deposit rates — each bank's highest rate per product", cols.length);

  // Legend + base rates sit above the filter header, frozen in view.
  ws.mergeCells(3, 1, 3, cols.length);
  ws.getCell(3, 1).value = isLoan ? `Green cell = ${R()} cheaper than that bank · Red = that bank cheaper · Bold gold = best in market · ranges per product on the 'All rates' sheet`
    : `Green cell = ${R()} pays more than that bank · Red = that bank pays more · Bold gold = best in market · ranges per product on the 'All rates' sheet`;
  ws.getCell(3, 1).font = { size: 9, italic: true, color: { argb: XL.muted } };
  const baseRow = ws.getRow(4);
  baseRow.getCell(fixedCols.length).value = "Base rate";
  baseRow.getCell(fixedCols.length).font = { bold: true, size: 10, color: { argb: XL.ink } };
  baseRow.getCell(fixedCols.length).alignment = { horizontal: "right" };
  banks.forEach((b, i) => {
    const c = baseRow.getCell(refCol + i);
    c.value = asPct(m.base[b.code]); c.numFmt = PCT;
    c.font = { bold: true, size: 10, color: { argb: b.code === REF ? XL.white : XL.ink } };
    c.fill = fill(b.code === REF ? XL.brand : XL.tint);
    c.alignment = { horizontal: "center" };
  });

  const H = 5;
  headerRow(ws, H, cols, { textCols: lead.length, refCol, height: 44 });
  let r = H + 1;
  for (const row of state.rows.filter((x) => x.section === section)) {
    const s = row.s, best = row.lowerIsBetter ? s.min : s.max, refv = row.cells[REF];
    const x = ws.getRow(r++);
    x.values = [...(isLoan ? [row.segment, row.product, row.variant] : [row.segment, row.product]),
      s.rank ? s.rank : "—", s.n, asPct(best), asPct(s.avg), ...banks.map((b) => asPct(row.cells[b.code]?.value))];
    for (let c = lead.length + 3; c <= cols.length; c++) x.getCell(c).numFmt = PCT;
    banks.forEach((b, i) => {
      const cell = x.getCell(refCol + i), c = row.cells[b.code];
      if (!c) return;
      const isBest = Math.abs(c.value - best) < 0.005;
      if (b.code === REF) {
        cell.fill = fill(XL.tint);
        cell.font = { bold: true, size: 10, color: { argb: isBest ? XL.gold : XL.brandInk } };
        return;
      }
      if (refv) {
        const adv = advantage(c.value - refv.value, row.lowerIsBetter);
        if (adv > 0.005) cell.fill = fill(XL.goodBg);
        else if (adv < -0.005) cell.fill = fill(XL.badBg);
      }
      if (isBest) cell.font = { bold: true, size: 10, color: { argb: XL.gold } };
    });
    if (!refv) { x.getCell(refCol).value = "Not offered"; x.getCell(refCol).fill = fill(XL.tint); x.getCell(refCol).font = { italic: true, size: 9, color: { argb: XL.muted } }; }
  }
  styleBody(ws, H + 1, r - 1, cols.length, { textCols: lead.length });
  finishSheet(ws, { headerRowNo: H, lastRow: r - 1, ncol: cols.length, xSplit: refCol,
    widths: [...(isLoan ? [24, 20, 10] : [26, 20]), 9, 7, 11, 11, 13, ...banks.slice(1).map(() => 13)] });
}

function addBaseSheet(wb) {
  const m = state.model;
  const ws = wb.addWorksheet("Base rate", { properties: { tabColor: { argb: XL.brand } } });
  const list = m.banks.filter((b) => m.base[b.code] !== undefined && m.base[b.code] !== null)
    .map((b) => ({ ...b, v: m.base[b.code] })).sort((a, b) => a.v - b.v || a.name.localeCompare(b.name));
  const refv = m.base[REF];
  const s = standing({ ...m.base }, true);
  const n = list.length;
  const lastCol = Math.max(7, n + 1);
  sheetTitle(ws, "Base rate analysis", lastCol);

  // Ranking
  const cols = ["Rank", "Bank", "Symbol", "Base rate", `Difference vs ${R()}`, "Difference vs market average", "Published this period"];
  const H = 4;
  headerRow(ws, H, cols, { textCols: 3 });
  list.forEach((b, i) => {
    const x = ws.getRow(H + 1 + i);
    x.values = [i + 1, b.name, scripOf(b.code), asPct(b.v), b.code === REF ? null : asNum(b.v - refv), asNum(b.v - s.avg), m.baseOld[b.code] === false ? "Yes" : "No"];
    x.getCell(4).numFmt = PCT;
    x.getCell(5).numFmt = DIFF();
    x.getCell(6).numFmt = '0.00" pp above avg";0.00" pp below avg";"at average"';
    if (b.code === REF) for (let c = 1; c <= cols.length; c++) { x.getCell(c).fill = fill(XL.tint); x.getCell(c).font = { bold: true, size: 10, color: { argb: XL.brandInk } }; }
  });
  const end = H + n;
  styleBody(ws, H + 1, end, cols.length, { textCols: 3, band: true });
  const stats = [["Market average", s.avg], ["Lowest", s.min], ["Highest", s.max]];
  stats.forEach(([label, v], i) => {
    const x = ws.getRow(end + 2 + i);
    x.getCell(2).value = label; x.getCell(2).font = { bold: true, size: 10, color: { argb: XL.muted } };
    x.getCell(4).value = asPct(v); x.getCell(4).numFmt = PCT; x.getCell(4).font = { bold: true, size: 10, color: { argb: XL.muted } };
    x.getCell(4).alignment = { horizontal: "center" };
  });

  // Matrix: row bank's base rate − column bank's base rate
  const M = end + 7;
  ws.mergeCells(M - 2, 1, M - 2, lastCol);
  ws.getCell(M - 2, 1).value = "Base rate matrix — each cell = row bank's base rate − column bank's base rate, in percentage points (blue = row bank lower, amber = row bank higher)";
  ws.getCell(M - 2, 1).font = { bold: true, size: 11, color: { argb: XL.ink } };
  const hdr = ws.getRow(M);
  hdr.getCell(1).value = "Row − column";
  list.forEach((c, j) => { hdr.getCell(2 + j).value = scripOf(c.code); });
  for (let j = 1; j <= n + 1; j++) {
    const cell = hdr.getCell(j);
    const me = j > 1 && list[j - 2].code === REF;
    cell.fill = fill(me ? XL.brandInk : XL.brand);
    cell.font = { bold: true, size: 9, color: { argb: XL.white } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  }
  hdr.height = 28;
  const maxAbs = (s.max - s.min) || 1;
  const tint = (d) => {
    const t = Math.min(1, Math.abs(d) / maxAbs);
    const mix = (a, b) => Math.round(a + (b - a) * (0.15 + 0.6 * t)).toString(16).padStart(2, "0");
    return d < 0 ? `FF${mix(255, 52)}${mix(255, 81)}${mix(255, 178)}` : `FF${mix(255, 217)}${mix(255, 154)}${mix(255, 6)}`;
  };
  list.forEach((r, i) => {
    const x = ws.getRow(M + 1 + i);
    const rowMe = r.code === REF;
    x.getCell(1).value = `${scripOf(r.code)} (${pct(r.v)})`;
    x.getCell(1).font = { bold: true, size: 9, color: { argb: rowMe ? XL.white : XL.ink } };
    x.getCell(1).fill = fill(rowMe ? XL.brandInk : XL.tint);
    list.forEach((c, j) => {
      const cell = x.getCell(2 + j);
      cell.alignment = { horizontal: "center" };
      cell.border = { top: { style: "hair", color: { argb: XL.hair } }, left: { style: "hair", color: { argb: XL.hair } } };
      if (r.code === c.code) { cell.fill = fill("FFE2E8F0"); return; }
      const d = r.v - c.v;
      cell.value = asNum(d);
      cell.numFmt = '+0.00;-0.00;0';
      if (Math.abs(d) >= 0.005) cell.fill = fill(tint(d));
      cell.font = { size: 9, bold: rowMe || c.code === REF, color: { argb: XL.ink } };
    });
  });
  ws.getColumn(1).width = 16;
  ws.getColumn(2).width = 26;
  for (let j = 3; j <= n + 1; j++) ws.getColumn(j).width = Math.max(ws.getColumn(j).width || 0, j <= 7 ? 14 : 8.5);
  ws.views = [{ state: "frozen", ySplit: H, showGridLines: false }];
  ws.autoFilter = { from: { row: H, column: 1 }, to: { row: end, column: cols.length } };
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
}

function addBanksSheet(wb) {
  const m = state.model;
  const ws = wb.addWorksheet("Banks", { properties: { tabColor: { argb: XL.brand } } });
  const metrics = bankMetrics().filter((mt) => !mt.count);
  const count = (sec, code) => state.rows.filter((r) => r.section === sec && r.cells[code]).length;
  const cols = ["Bank", ...metrics.flatMap((mt) => [`${mt.label} (${mt.note})`, `${mt.label}: bank − ${R()}`]), "New base rate this period", "Deposit lines", "Loan lines"];
  sheetTitle(ws, "Bank profiles", cols.length);
  ws.mergeCells(3, 1, 3, cols.length);
  ws.getCell(3, 1).value = `'bank − ${R()}' columns compare each bank's figure with ${R()}'s (e.g. '4.42 pp below ${R()}' = that bank's figure is 4.42 percentage points lower than ${R()}'s). NPL = non-performing (bad) loans as a share of total loans.`;
  ws.getCell(3, 1).font = { size: 9, italic: true, color: { argb: XL.muted } };
  const H = 5;
  headerRow(ws, H, cols, { height: 44 });
  const list = [m.banks.find((b) => b.code === REF), ...m.banks.filter((b) => b.code !== REF).sort((a, b) => a.name.localeCompare(b.name))];
  let r = H + 1;
  for (const b of list) {
    const me = b.code === REF;
    const x = ws.getRow(r++);
    x.values = [b.name, ...metrics.flatMap((mt) => {
      const v = mt.get(b.code), nv = mt.get(REF);
      return [mt.unit === "pp" ? asNum(v) : asPct(v), null];
    }), m.baseOld[b.code] === false ? "Yes" : "No", count("deposit", b.code), count("loan", b.code)];
    metrics.forEach((mt, i) => {
      x.getCell(2 + i * 2).numFmt = mt.unit === "pp" ? PP : PCT;
      const v = mt.get(b.code), nv = mt.get(REF);
      const dc = x.getCell(3 + i * 2);
      dc.value = me || v === null || nv === null ? null : asNum(v - nv);
      dc.numFmt = DIFF();
      dc.font = { size: 10, color: { argb: XL.muted } };
    });
    if (me) for (let c = 1; c <= cols.length; c++) { x.getCell(c).fill = fill(XL.tint); x.getCell(c).font = { bold: true, size: 10, color: { argb: XL.brandInk } }; }
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

function addPerformanceSheet(wb) {
  const q = perfQuarter();
  if (!q) return;
  const ws = wb.addWorksheet("Performance", { properties: { tabColor: { argb: XL.brand } } });
  const fmtFor = (mt) => (mt.unit === "pct" ? '0.00"%"' : mt.unit === "x" ? '0.00"×"' : "#,##0.00");
  const unitLabel = (mt) => (mt.unit === "arba" ? " (Rs arba)" : mt.unit === "pct" ? " (%)" : mt.unit === "rs" ? " (Rs)" : " (times)");
  const cols = ["Symbol", "Bank", ...PERF_METRICS.map((mt) => mt.label + unitLabel(mt))];
  sheetTitle(ws, `Quarterly performance — ${q.label}`, cols.length);
  ws.getCell(2, 1).value = `${q.period} · figures as compiled by ${q.source.name} (${q.source.published}) from the banks' unaudited quarterly reports · ${q.source.url}`;
  const H = 4;
  headerRow(ws, H, cols, { textCols: 2, height: 44 });
  const syms = [refSym(), ...Object.keys(q.banks).filter((s) => s !== refSym()).sort()];
  syms.forEach((sym, i) => {
    const x = ws.getRow(H + 1 + i);
    x.values = [sym, perfName(sym), ...PERF_METRICS.map((mt) => perfVal(q, sym, mt))];
    PERF_METRICS.forEach((mt, j) => (x.getCell(3 + j).numFmt = fmtFor(mt)));
    if (sym === refSym()) for (let c = 1; c <= cols.length; c++) { x.getCell(c).fill = fill(XL.tint); x.getCell(c).font = { bold: true, size: 10, color: { argb: XL.brandInk } }; }
  });
  const end = H + syms.length;
  styleBody(ws, H + 1, end, cols.length, { textCols: 2, band: true });
  const rankRow = ws.getRow(end + 2), avgRow = ws.getRow(end + 3);
  rankRow.getCell(2).value = `${R()} rank (1 = best)`; avgRow.getCell(2).value = "Average of all banks (profit growth: median)";
  PERF_METRICS.forEach((mt, j) => {
    const s = perfStanding(q, mt);
    rankRow.getCell(3 + j).value = s && s.rank && mt.better ? `${s.rank} of ${s.n}` : "not ranked";
    avgRow.getCell(3 + j).value = s ? asNum(s.avg) : null;
    avgRow.getCell(3 + j).numFmt = fmtFor(mt);
  });
  for (const r of [rankRow, avgRow]) for (let c = 2; c <= cols.length; c++) { r.getCell(c).font = { bold: true, size: 10, color: { argb: XL.muted } }; r.getCell(c).alignment = { horizontal: c === 2 ? "left" : "center" }; }
  let n = end + 5;
  for (const [k, v] of Object.entries(q.notes || {})) {
    ws.mergeCells(n, 1, n, cols.length);
    ws.getCell(n, 1).value = `Note — ${k.replace(".", " · ")}: ${v}`;
    ws.getCell(n, 1).font = { size: 9, italic: true, color: { argb: XL.muted } };
    n++;
  }
  finishSheet(ws, { headerRowNo: H, lastRow: end, ncol: cols.length, xSplit: 2, widths: [9, 30, ...PERF_METRICS.map(() => 13)] });
}

function addDetailSheet(wb) {
  const m = state.model;
  const ws = wb.addWorksheet("All rates", { properties: { tabColor: { argb: XL.muted } } });
  const cols = ["Section", "Segment", "Product", "Variant", "Bank", "Rate from", "Rate to", "Compared rate", "Premium over base", `${R()} compared rate`, `Vs ${R()}`, "Bank rank", "Banks", "Best in market", "Product names"];
  sheetTitle(ws, "All rates — one row per bank and product (use the filters or a pivot table)", cols.length);
  const H = 4;
  headerRow(ws, H, cols, { textCols: 5 });
  let r = H + 1;
  for (const row of state.rows) {
    const vals = Object.values(row.cells).map((c) => c.value);
    const best = row.lowerIsBetter ? Math.min(...vals) : Math.max(...vals);
    const refv = row.cells[REF];
    const ordered = Object.values(row.cells).sort((a, b) => (row.lowerIsBetter ? a.value - b.value : b.value - a.value));
    for (const c of ordered) {
      const me = c.code === REF;
      const rank = 1 + vals.filter((v) => (row.lowerIsBetter ? v < c.value : v > c.value)).length;
      const b = m.base[c.code];
      const x = ws.getRow(r++);
      x.values = [row.section === "loan" ? "Lending" : "Deposits", row.segment, row.product, row.variant || "", m.nameOf[c.code],
        asPct(c.range.lo), asPct(c.range.hi), asPct(c.value),
        row.section === "loan" && b !== undefined ? asNum(c.value - b) : null,
        asPct(refv?.value), null,
        rank, vals.length, Math.abs(c.value - best) < 0.005 ? "Yes" : "",
        c.products.map((p) => p.name).join("; ")];
      [6, 7, 8, 10].forEach((k) => (x.getCell(k).numFmt = PCT));
      x.getCell(9).numFmt = PP;
      gapCell(x.getCell(11), me || !refv ? null : advantage(c.value - refv.value, row.lowerIsBetter));
      if (me) for (let k = 1; k <= cols.length; k++) { x.getCell(k).fill = fill(XL.tint); x.getCell(k).font = { bold: true, size: 10, color: { argb: XL.brandInk } }; }
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
    ["Sheets", `Overview: headline figures and ${R()}'s rank, market best/average/worst for every product.\nDeposits / Lending: every bank's rate per product, ${R()} first, base rates above the header.\nBase rate: ranking and a bank-by-bank base rate matrix.\nBanks: base rate, NPL and key rates per bank.\nAll rates: one row per bank and product, with ranges and premiums, for filtering and pivot tables.`],
    ["Compared rate", "Loans: each bank's lowest rate for the product (1 = cheapest). Deposits: each bank's highest rate (1 = pays most)."],
    [`Vs ${R()} / ${R()} vs average`, `▲ green = ${R()} ahead (cheaper loan or higher deposit rate), ▼ red = ${R()} behind, in percentage points. = means level.`],
    ["Fixed vs variable", "Loan products with \"Fixed\" in the name are fixed rate; all others variable. Special offer rates are used where listed."],
    ["Fixed deposit tenures", "Read from each product name (e.g. 3Mto<6M, >1Yto2Y, 5Y&above); where a bank's bands overlap at a boundary, the higher rate is used."],
    ["Premium over base", "Loan rate minus that bank's base rate."],
    ["New base rate this period", "Banks that have published this period's base rate; others still show last period's figure."],
    ["Commercial banks", "Class A institutions."],
    ["Filters", `Every table has filter buttons on its header row. Panes are frozen so headers and ${R()} stay in view.`],
  ];
  notes.forEach(([k, v], i) => {
    const row = ws.getRow(4 + i);
    row.getCell(1).value = k; row.getCell(1).font = { bold: true, size: 10, color: { argb: XL.brandInk } };
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
  btn.textContent = state.model ? "Preparing…" : "Waiting for rates…";
  try {
    await state.ratesReady;
    btn.textContent = "Preparing…";
    const ExcelJS = await loadExcelJS();
    const wb = new ExcelJS.Workbook();
    wb.creator = "Nepal Bank Rates (personal project)";
    wb.created = new Date();
    addOverviewSheet(wb);
    addBaseSheet(wb);
    addGridSheet(wb, "deposit");
    addGridSheet(wb, "loan");
    addBanksSheet(wb);
    addPerformanceSheet(wb);
    addDetailSheet(wb);
    addNotesSheet(wb);
    const active = wb.worksheets.findIndex((w) => w.name === SHEET_FOR_TAB[state.tab]);
    wb.views = [{ activeTab: Math.max(0, active), firstSheet: 0 }];
    const buf = await wb.xlsx.writeBuffer();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    a.download = `Nepal-Bank-Rates-${new Date().toISOString().slice(0, 10)}.xlsx`;
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
  history.replaceState(null, "", location.search + "#" + tab);
  if (tab === "perf" && state.perf) renderPerformance();
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
  if (t.dataset.pgroup) { state.perfGroup = t.dataset.pgroup; return renderPerformance(); }
  if (t.dataset.psort !== undefined) {
    const k = t.dataset.psort || null;
    // clicking the sorted column again flips best/worst first
    if (k && state.perfSort === k) state.perfDir = (state.perfDir || "best") === "best" ? "worst" : "best";
    else { state.perfSort = k; state.perfDir = "best"; state.perfChart = k || state.perfChart; }
    return renderPerformance();
  }
  if (t.dataset.pdir) { state.perfDir = t.dataset.pdir; return renderPerformance(); }
  if (t.dataset.h2hClose !== undefined) { state.perfH2H = null; return renderPerformance(); }
  if (t.dataset.bsort) {
    state.bankSort = state.bankSort === t.dataset.bsort ? null : t.dataset.bsort;
    return renderBanks();
  }
  if (t.dataset.jump) {
    const row = $(t.dataset.jump), wrap = row.closest(".grid-wrap");
    wrap.scrollTo({ top: row.offsetTop - wrap.querySelector("thead").offsetHeight, behavior: "smooth" });
  }
});
$("refresh").addEventListener("click", () => { load(); loadPerformance(); });
$("ref-select").addEventListener("change", (e) => setRef(e.target.value));
$("perf-quarter").addEventListener("change", (e) => { state.perfQ = e.target.value; renderPerformance(); });
$("perf-sort").addEventListener("change", (e) => { state.perfSort = e.target.value || null; state.perfDir = "best"; if (e.target.value) state.perfChart = e.target.value; renderPerformance(); });
$("perf-search").addEventListener("input", (e) => { state.perfSearch = e.target.value; const q = perfQuarter(); if (q) renderPerformance(); });
$("perf-chart-metric").addEventListener("change", (e) => { state.perfChart = e.target.value; renderPerfChart(perfQuarter(), PERF_METRICS.find((m) => m.key === e.target.value)); });
// Clicking a bank row opens the head-to-head comparison with the comparison bank.
$("perf-table").addEventListener("click", (e) => {
  if (e.target.closest("button")) return;
  const tr = e.target.closest("tr[data-sym]");
  if (!tr) return;
  state.perfH2H = tr.dataset.sym;
  renderPerformance();
  $("perf-h2h").scrollIntoView({ behavior: "smooth", block: "start" });
});
document.addEventListener("change", (e) => { if (e.target.id === "perf-h2h-pick") { state.perfH2H = e.target.value; renderPerformance(); } });
window.addEventListener("resize", fitGrids);

state.order = "az";
state.show = { loan: "premium", deposit: "range" };
const initial = location.hash.slice(1);
if (["summary", "loan", "deposit", "base", "banks", "perf"].includes(initial)) showTab(initial);
load();
loadPerformance();
setInterval(() => { if (!document.hidden) load(); }, AUTO_REFRESH_MS);
