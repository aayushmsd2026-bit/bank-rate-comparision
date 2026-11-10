// Bank Tulana: compares Nepal's commercial banks with the reference bank as the
// reference bank. Reads the BankByaj API live in the browser and
// falls back to data/snapshot.json (refreshed hourly by GitHub Actions).
"use strict";

const API = "https://admin.bankbyaj.com/api/v1/";
let REF = null;                   // reference bank (BankByaj institute_code), chosen with the "Compare against" selector
// Rates change a few times a month; refresh while the page stays open, but only redraw on a real change.
const AUTO_REFRESH_MS = 30 * 60 * 1000;

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

// Colour scales from the site's Japanese palette. Solid colours only: pinned (sticky) cells
// must be opaque or the cells scrolling beneath them show through.
const RAMP_AI = [[0, [246, 249, 249]], [0.35, [205, 227, 235]], [0.7, [104, 158, 186]], [0.88, [22, 94, 131]], [1, [27, 45, 79]]];   // kinari → kamenozoki → ai → kon
const RAMP_ODO = [[0, [251, 248, 240]], [0.5, [236, 210, 150]], [1, [176, 124, 40]]];   // kinari → 黄土 ōdo, the "higher" side of diverging scales
function rampHex(ramp, t) {
  t = Math.max(0, Math.min(1, t));
  const i = ramp.findIndex(([p]) => p >= t);
  const [p1, c1] = ramp[Math.max(0, i - 1)], [p2, c2] = ramp[i];
  const k = p2 === p1 ? 0 : (t - p1) / (p2 - p1);
  return "#" + c1.map((v, j) => Math.round(v + (c2[j] - v) * k).toString(16).padStart(2, "0")).join("");
}
// background + readable text colour for a 0..1 intensity
const heatStyle = (t, ramp = RAMP_AI) => `background:${rampHex(ramp, t)};${t > 0.62 ? "color:#fff;" : ""}`;

// Short label (NEPSE symbol) and full name of the comparison bank, for display.
// Bank names are plain text (letters, spaces, dots, apostrophes), safe in HTML and Excel alike.
const R = () => SCRIP[REF] || REF;
const RN = () => state.model?.nameOf[REF] || REF;

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

// The hourly backup copy is drawn at once on the first visit (one small file), then replaced by
// live BankByaj data, which takes several seconds and dozens of requests.
async function load() {
  $("error").hidden = true;
  if (!state.data) {
    try { applyData(await getJson("data/snapshot.json?t=" + Date.now()), "snapshot"); } catch { /* live data below */ }
  }
  setBadge("Updating…", "");
  try {
    applyData(await loadLive(), "live");
  } catch (liveErr) {
    if (state.data) return renderStatus();
    $("error").textContent = `Could not load rates (${liveErr.message}).`;
    $("error").hidden = false;
    setBadge("Unavailable", "snap");
  }
}

// Redraw only when the rates themselves changed, and keep every table's scroll position.
function applyData(d, source) {
  const fp = JSON.stringify([d.baseRates, d.categories, d.updates]);
  state.data = d;
  state.source = source;
  if (fp === state.fp) return renderStatus();
  state.fp = fp;
  prepare();
  keepScroll(render);
  ratesReady();
}

function keepScroll(fn) {
  const sel = ".grid-wrap, .mx2-wrap, .bd-wrap, .sheet, .mx-wrap";
  const key = (el) => `${el.closest("[id]")?.id}|${el.className}`;
  const saved = new Map([...document.querySelectorAll(sel)].map((el) => [key(el), [el.scrollTop, el.scrollLeft]]));
  const y = window.scrollY;
  fn();
  document.querySelectorAll(sel).forEach((el) => { const v = saved.get(key(el)); if (v) [el.scrollTop, el.scrollLeft] = v; });
  window.scrollTo(0, y);
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

// Comparison bank: NMB by default on every visit. A link with ?bank=SYMBOL opens on that bank;
// switching in the page applies to this visit only.
const DEFAULT_REF = "NMB Bank";
function pickRef() {
  const m = state.model;
  const valid = (c) => c && m.banks.some((b) => b.code === c);
  if (valid(REF)) return;
  const up = String(new URLSearchParams(location.search).get("bank") || "").toUpperCase();
  const fromUrl = up && m.banks.find((b) => (SCRIP[b.code] || "").toUpperCase() === up || (up === "RBBL" && b.code === "RBB"))?.code;
  REF = fromUrl || (valid(DEFAULT_REF) ? DEFAULT_REF : [...m.banks].sort((a, b) => a.name.localeCompare(b.name))[0]?.code);
}

function setRef(code) {
  REF = code;
  render();
}

function renderRefSelect() {
  const m = state.model;
  $("ref-select").innerHTML = [...m.banks].sort((a, b) => (SCRIP[a.code] || a.name).localeCompare(SCRIP[b.code] || b.name))
    .map((b) => `<option value="${esc(b.code)}" ${b.code === REF ? "selected" : ""}>${esc(SCRIP[b.code] || b.code)} · ${esc(b.name)}</option>`).join("");
  document.querySelectorAll(".ref-label").forEach((el) => (el.textContent = R()));
  document.querySelectorAll(".ref-full").forEach((el) => (el.textContent = RN()));
}

function renderStatus() {
  const m = state.model;
  if (!m) return;
  setBadge(state.source === "live" ? "Live" : "Backup copy", state.source === "live" ? "live" : "snap");
  const stamp = state.source === "live" ? `Live · fetched ${fmtDate(state.data.fetched_at)}` : `Backup copy from ${fmtDate(state.data.fetched_at)}`;
  document.querySelectorAll(".stamp").forEach((el) => (el.textContent = `${stamp}${m.modified ? ` · BankByaj updated ${fmtDate(m.modified)}` : ""}`));
}

function render() {
  const m = state.model;
  pickRef();
  renderRefSelect();
  document.querySelectorAll(".bank-count").forEach((el) => (el.textContent = m.banks.length));
  renderStatus();

  state.rows = buildRows();
  renderKpis();
  renderScorecard("loan");
  renderScorecard("deposit");
  renderGrid("loan");
  renderGrid("deposit");
  renderBaseTab();
  renderBanks();
  if (state.fin) { renderFinancials(); renderOverviewFinancials(); }
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
  // diverging: ai (indigo) where the row bank is lower, ōdo (ochre) where it is higher
  const shade = (d) => (Math.abs(d) < 0.005 ? "" : heatStyle(0.15 + 0.7 * Math.min(1, Math.abs(d) / maxAbs), d < 0 ? RAMP_AI : RAMP_ODO));
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

// ---------- bank financials (Nepal Rastra Bank, monthly) ----------
// data/nrb/financials.json is refreshed by .github/workflows/nrb.yml from NRB's monthly
// "Banking & Financial Statistics". Amounts are Rs million; profit and loss items are
// fiscal year to date, so rates built from them are annualised with 12 / fy_month.

const pctOf = (a, b) => (a === undefined || a === null || b === undefined || !b ? null : (100 * a) / b);
const ann = (x, m) => (x === undefined ? undefined : (x * 12) / m.fy_month);
const sumOf = (m, k) => Object.values(m.banks).reduce((t, b) => t + (b[k] || 0), 0);
const profitOf = (b) => (b.net_profit || 0) - (b.net_loss || 0);
const monthById = (id) => state.fin.months.find((x) => x.id === id);
const shiftId = (id, n) => { let [y, mo] = id.split("-").map(Number); mo += n; while (mo < 1) { mo += 12; y--; } while (mo > 12) { mo -= 12; y++; } return `${y}-${String(mo).padStart(2, "0")}`; };
const yearAgo = (m) => monthById(shiftId(m.id, -12));
const arba = (mn) => (mn === null || mn === undefined || !Number.isFinite(mn) ? null : mn / 1e3);
const fmtArba = (mn) => { const v = arba(mn); return v === null ? "—" : `Rs ${Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2)} arba`; };
const fmtPct = (v, dp = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v.toFixed(dp)}%`);
const fmtSigned = (v, unit = "%", dp = 1) => (v === null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(dp)}${unit}`);
const bankName = (c) => state.model?.nameOf[c] || c;

// Line items a bank's deposits or loans break into. Stored as Rs million per bank.
const FIN_ITEMS = {
  deposit: { base: "deposits", baseLabel: "deposits", items: [
    { key: "dep_current", label: "Current deposits" },
    { key: "dep_savings", label: "Savings deposits" },
    { key: "dep_fixed", label: "Fixed deposits" },
    { key: "dep_call", label: "Call deposits" },
    { key: "dep_others", label: "Other deposits" },
  ] },
  product: { base: "loans", baseLabel: "loans", items: [
    { key: "prod_term", label: "Term loans" },
    { key: "prod_working_capital", label: "Short-term working capital / demand loans" },
    { key: "prod_cash_credit", label: "Cash credit" },
    { key: "prod_home", label: "Home loans (personal residential)" },
    { key: "prod_deprived", label: "Deprived sector loans" },
    { key: "prod_trust_receipt", label: "Trust receipt / import loans" },
    { key: "prod_hire_purchase", label: "Hire purchase" },
    { key: "prod_real_estate", label: "Real estate loans" },
    { key: "prod_margin", label: "Margin lending" },
    { key: "prod_overdraft", label: "Overdraft" },
    { key: "prod_bills", label: "Bills purchased" },
    { key: "prod_other", label: "Other products" },
    { key: "credit_card", label: "Credit card lending", memo: true },
  ] },
  sector: { base: "loans", baseLabel: "loans", items: [
    { key: "sec_trade", label: "Wholesale & retail trade" },
    { key: "sec_consumption", label: "Consumption" },
    { key: "sec_production", label: "Production (agro, beverage & non-food manufacturing)" },
    { key: "sec_energy", label: "Electricity, gas & water" },
    { key: "sec_finance", label: "Finance, insurance & real estate" },
    { key: "sec_agriculture", label: "Agriculture & forestry" },
    { key: "sec_tourism", label: "Tourism" },
    { key: "sec_services", label: "Other services" },
    { key: "sec_construction", label: "Construction" },
    { key: "sec_transport", label: "Transport, communication & utilities" },
    { key: "sec_metal", label: "Metal products & machinery" },
    { key: "sec_mining", label: "Mining" },
    { key: "sec_fishery", label: "Fishery" },
    { key: "sec_local_govt", label: "Local government" },
    { key: "sec_others", label: "Others" },
  ] },
};
const FIN_TOTALS = { deposit: { key: "deposits", label: "Total deposits" }, product: { key: "loans", label: "Total loans" }, sector: { key: "loans", label: "Total loans" } };
const allItems = () => Object.entries(FIN_ITEMS).flatMap(([kind, g]) => g.items.map((it) => ({ ...it, kind, base: g.base, baseLabel: g.baseLabel })));
const itemByKey = (k) => allItems().find((it) => it.key === k) || (k === "deposits" ? { key: "deposits", label: "Total deposits", kind: "deposit", base: "deposits", total: true } : k === "loans" ? { key: "loans", label: "Total loans", kind: "product", base: "loans", total: true } : null);

// Figures for one line item at one bank in one month.
function itemFacts(m, code, it) {
  const b = m?.banks[code];
  if (!b || b[it.key] === undefined) return null;
  const amt = b[it.key];
  const amts = Object.entries(m.banks).map(([c, x]) => [c, x[it.key]]).filter(([, v]) => v !== undefined);
  const mix = Object.entries(m.banks).map(([c, x]) => [c, pctOf(x[it.key], x[it.base])]).filter(([, v]) => v !== null);
  const prev = yearAgo(m)?.banks[code]?.[it.key];
  const mktNow = amts.reduce((t, [, v]) => t + v, 0);
  const ya = yearAgo(m);
  const mktPrev = ya ? Object.values(ya.banks).reduce((t, x) => t + (x[it.key] || 0), 0) : null;
  return {
    amt, mix: pctOf(amt, b[it.base]), share: pctOf(amt, mktNow), n: amts.length, market: mktNow,
    rank: 1 + amts.filter(([, v]) => v > amt).length,
    mixRank: 1 + mix.filter(([, v]) => v > pctOf(amt, b[it.base])).length,
    growth: prev ? pctOf(amt - prev, prev) : null,
    mktGrowth: mktPrev ? pctOf(mktNow - mktPrev, mktPrev) : null,
    mktMix: pctOf(mktNow, sumOf(m, it.base)),
  };
}

// Ratios for the Profit & efficiency section (value per bank; better = ranking direction).
const FIN_METRICS = [
  { key: "net_profit", label: "Net profit", note: "year to date", unit: "arba", better: "high", get: (b) => profitOf(b) },
  { key: "profit_growth", label: "Net profit growth", note: "vs same month last year", unit: "pct", better: "high", median: true,
    get: (b, m, c) => { const p = yearAgo(m)?.banks[c]; return p && profitOf(p) ? pctOf(profitOf(b) - profitOf(p), Math.abs(profitOf(p))) : null; } },
  { key: "nii", label: "Net interest income", note: "year to date", unit: "arba", better: "high", get: (b) => b.interest_income - b.interest_expense },
  { key: "interest_income", label: "Interest income", note: "year to date", unit: "arba", better: "high", get: (b) => b.interest_income },
  { key: "interest_expense", label: "Interest expense", note: "year to date", unit: "arba", better: null, get: (b) => b.interest_expense },
  { key: "fee_income", label: "Fee & commission income", note: "year to date", unit: "arba", better: "high", get: (b) => b.commission_income || 0 },
  { key: "cost_income", label: "Cost to income", note: "staff + office costs ÷ operating income", unit: "pct", better: "low",
    get: (b) => pctOf((b.staff_expense || 0) + (b.office_expense || 0), b.interest_income - b.interest_expense + (b.commission_income || 0) + (b.fx_income || 0) + (b.other_op_income || 0)) },
  { key: "roa", label: "Return on assets", note: "annualised", unit: "pct", better: "high", get: (b, m) => pctOf(ann(profitOf(b), m), b.total_assets) },
  { key: "roe", label: "Return on capital fund", note: "annualised", unit: "pct", better: "high", get: (b, m) => pctOf(ann(profitOf(b), m), b.capital_fund) },
  { key: "cost_of_deposits", label: "Cost of deposits", note: "annualised, approx.", unit: "pct", better: "low", get: (b, m) => pctOf(ann(b.interest_exp_deposits, m), b.deposits) },
  { key: "yield_on_loans", label: "Yield on loans", note: "annualised, approx.", unit: "pct", better: null, get: (b, m) => pctOf(ann(b.interest_inc_loans, m), b.loans) },
  { key: "spread", label: "Spread", note: "loan yield − deposit cost, approx.", unit: "pp", better: "high",
    get: (b, m) => { const y = pctOf(ann(b.interest_inc_loans, m), b.loans), c = pctOf(ann(b.interest_exp_deposits, m), b.deposits); return y === null || c === null ? null : y - c; } },
  { key: "cd_ratio", label: "Loans ÷ deposits", unit: "pct", better: null, get: (b) => pctOf(b.loans, b.deposits) },
  { key: "provision_cover", label: "Loan-loss provisions", note: "% of loans", unit: "pct", better: null, get: (b) => pctOf(b.loan_loss_provision, b.loans) },
  { key: "total_assets", label: "Total assets", unit: "arba", better: "high", get: (b) => b.total_assets },
  { key: "capital_fund", label: "Capital fund", unit: "arba", better: "high", get: (b) => b.capital_fund },
];
function finVal(m, code, mt) {
  const b = m?.banks[code];
  if (!b) return null;
  const v = mt.get(b, m, code);
  return v === null || v === undefined || !Number.isFinite(v) ? null : v;
}
const finFmt = (mt, v) => (v === null ? "—" : mt.unit === "arba" ? fmtArba(v) : mt.unit === "pp" ? `${v.toFixed(2)} pp` : fmtPct(v, 2));
function finStats(m, mt) {
  const pairs = Object.keys(m.banks).map((c) => [c, finVal(m, c, mt)]).filter(([, v]) => v !== null);
  if (!pairs.length) return null;
  const vals = pairs.map(([, v]) => v).sort((a, b) => a - b);
  const median = vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
  const ref = finVal(m, REF, mt);
  const best = mt.better ? pairs.reduce((a, p) => ((mt.better === "high" ? p[1] > a[1] : p[1] < a[1]) ? p : a)) : null;
  return {
    n: vals.length, avg: mt.median ? median : vals.reduce((a, b) => a + b, 0) / vals.length, avgLabel: mt.median ? "median" : "average",
    ref, best, rank: mt.better && ref !== null ? 1 + vals.filter((v) => (mt.better === "high" ? v > ref : v < ref)).length : null,
  };
}
function rankChip(rank, n) {
  if (!rank) return "";
  const t = rank <= n / 3 ? "t1" : rank > (2 * n) / 3 ? "t3" : "t2";
  return `<span class="rk ${t}" title="Rank ${rank} of ${n}">#${rank}</span>`;
}

async function loadFinancials() {
  try {
    state.fin = await getJson("data/nrb/financials.json?t=" + Date.now());
    state.finMonth ||= state.fin.months.at(-1)?.id;
    if (state.model) { renderFinancials(); renderOverviewFinancials(); }
  } catch (err) {
    $("fin-body").innerHTML = `<p class="notice">Could not load the NRB figures (${esc(err.message)}).</p>`;
  }
}
const finMonth = () => state.fin?.months.find((m) => m.id === state.finMonth) || state.fin?.months.at(-1);
const FIN_SECTIONS = [["deposit", "Deposits"], ["loan", "Loans"], ["profit", "Profit & efficiency"], ["matrix", "All banks side by side"]];

function renderFinancials() {
  const m = finMonth();
  if (!m || !state.model) return;
  state.finSection ||= "deposit";
  state.finLoanView ||= "product";
  $("fin-month").innerHTML = [...state.fin.months].reverse().map((x) => `<option value="${esc(x.id)}" ${x.id === m.id ? "selected" : ""}>${esc(x.bs)} (${esc(x.label)})</option>`).join("");
  $("fin-source").innerHTML = `Nepal Rastra Bank monthly statistics · position at <b>${esc(m.bs)}</b> (${esc(m.label)}) · profit figures are this fiscal year to date (${m.fy_month} month${m.fy_month > 1 ? "s" : ""}) · <a href="${esc(m.source)}" target="_blank" rel="noopener">NRB file</a>`;
  $("fin-sections").innerHTML = FIN_SECTIONS.map(([k, l]) => `<button type="button" data-fsec="${k}" aria-pressed="${k === state.finSection}">${esc(l)}</button>`).join("");
  document.querySelectorAll(".ref-label").forEach((el) => (el.textContent = R()));
  $("fin-trend").hidden = false; $("fin-rank").hidden = false; $("fin-pick").hidden = true;
  if (state.finSection === "matrix") return renderFinMatrix(m);
  if (state.finSection === "profit") return renderFinProfit(m);
  const kind = state.finSection === "deposit" ? "deposit" : state.finLoanView;
  renderFinSnapshot(m);
  renderFinBreakdown(m, kind);
}

// "At a glance" cards for the comparison bank.
function renderFinSnapshot(m) {
  const card = (it, cls = "") => {
    const f = itemFacts(m, REF, it);
    if (!f) return "";
    return `<div class="kpi ${cls}"><div class="k-label">${esc(it.label)}</div><div class="k-value">${fmtArba(f.amt)}</div>
      <div class="k-facts">${it.total ? "" : `<span><b>${fmtPct(f.mix)}</b> of ${esc(R())}'s ${it.base}</span>`}<span><b>${fmtPct(f.share, 2)}</b> market share</span><span>Rank <b>#${f.rank}</b> of ${f.n}</span>${f.growth !== null ? `<span><b>${fmtSigned(f.growth)}</b> in a year</span>` : ""}</div></div>`;
  };
  const I = (k) => itemByKey(k);
  const cards = state.finSection === "deposit"
    ? [card(I("deposits"), "featured"), card(I("dep_current")), card(I("dep_savings")), card(I("dep_fixed")), card(I("dep_call"))]
    : [card(I("loans"), "featured"), ...topProducts(m, 4).map((it) => card(it))];
  $("fin-kpis").innerHTML = cards.join("");
  $("fin-kpis").className = "kpis fin-kpis";
}
// The comparison bank's largest loan products, for the Loans cards.
const topProducts = (m, n) => FIN_ITEMS.product.items.filter((it) => !it.memo).map((it) => ({ ...it, kind: "product", base: "loans" }))
  .sort((a, b) => (m.banks[REF]?.[b.key] || 0) - (m.banks[REF]?.[a.key] || 0)).slice(0, n);

// Breakdown table (deposit types, loan products or sectors) for the comparison bank.
function renderFinBreakdown(m, kind) {
  const g = FIN_ITEMS[kind];
  const items = g.items.map((it) => ({ ...it, kind, base: g.base, baseLabel: g.baseLabel }));
  const totalIt = { key: g.base, label: FIN_TOTALS[kind].label, kind, base: g.base, baseLabel: g.baseLabel, total: true };
  const sel = items.find((it) => it.key === state.finItem?.[kind]) || (state.finItem?.[kind] === g.base ? totalIt : items[0]);
  state.finItem = { ...(state.finItem || {}), [kind]: sel.key };
  const rows = items.map((it) => ({ it, f: itemFacts(m, REF, it) })).filter((r) => r.f);
  const sortKey = state.finBdSort?.[kind] || "amt";
  const dir = sortKey === "rank" ? 1 : -1;
  rows.sort((a, b) => (a.it.memo ? 1 : 0) - (b.it.memo ? 1 : 0) || ((a.f[sortKey] ?? -1e18) - (b.f[sortKey] ?? -1e18)) * dir);
  const th = (k, label, title = "") => `<th class="num ${sortKey === k ? "on" : ""}"><button type="button" data-bdsort="${k}" data-kind="${kind}" title="${esc(title || "Sort by " + label)}">${label}${sortKey === k ? " ↓" : ""}</button></th>`;
  const head = `<thead><tr><th>${kind === "deposit" ? "Deposit type" : kind === "product" ? "Loan product" : "Lending sector"}</th>
    ${th("amt", `${esc(R())} amount`)}${th("mix", `% of ${esc(R())}'s ${g.baseLabel}`)}${th("share", "Market share", `${R()}'s share of all 20 banks' total`)}${th("rank", "Rank among banks", "1 = largest amount")}
    ${th("growth", `${esc(R())} growth, 1 yr`)}${th("mktGrowth", "Market growth, 1 yr")}${th("mktMix", "Market mix", `% of all banks' ${g.baseLabel}`)}</tr></thead>`;
  const total = itemFacts(m, REF, { key: g.base, base: g.base, label: FIN_TOTALS[kind].label });
  const body = rows.map(({ it, f }) => `<tr class="bd-row ${it.key === sel.key ? "sel" : ""} ${it.memo ? "memo" : ""}" data-bditem="${it.key}" data-kind="${kind}" title="Show how all banks compare on ${esc(it.label)}">
      <td class="bd-name">${esc(it.label)}${it.memo ? '<span class="memo-tag">memo, overlaps other products</span>' : ""}</td>
      <td class="num"><b>${fmtArba(f.amt)}</b></td>
      <td class="num"><span class="mixbar"><i style="width:${Math.min(100, f.mix || 0).toFixed(1)}%"></i></span>${fmtPct(f.mix)}</td>
      <td class="num">${fmtPct(f.share, 2)}</td>
      <td class="num">${rankChip(f.rank, f.n)} <span class="dim">of ${f.n}</span></td>
      <td class="num ${f.growth !== null && f.mktGrowth !== null ? (f.growth >= f.mktGrowth ? "up" : "down") : ""}">${fmtSigned(f.growth)}</td>
      <td class="num dim">${fmtSigned(f.mktGrowth)}</td>
      <td class="num dim">${fmtPct(f.mktMix)}</td></tr>`).join("") +
    (total ? `<tr class="bd-total"><td>${esc(FIN_TOTALS[kind].label)}</td><td class="num"><b>${fmtArba(total.amt)}</b></td><td class="num">100%</td><td class="num">${fmtPct(total.share, 2)}</td><td class="num">${rankChip(total.rank, total.n)} <span class="dim">of ${total.n}</span></td><td class="num">${fmtSigned(total.growth)}</td><td class="num dim">${fmtSigned(total.mktGrowth)}</td><td class="num dim">100%</td></tr>` : "");
  const switcher = state.finSection === "loan" ? `<div class="toggle" role="group" aria-label="Break loans down by">
      <button type="button" data-lview="product" aria-pressed="${kind === "product"}">By product</button><button type="button" data-lview="sector" aria-pressed="${kind === "sector"}">By sector</button></div>` : "";
  $("fin-breakdown").innerHTML = `<header class="card-head chart-head"><div>
      <h2>${esc(R())}'s ${kind === "deposit" ? "deposits by type" : kind === "product" ? "loans by product" : "loans by sector"}</h2>
      <p>Largest first · <b>green growth</b> = growing faster than the market · click a row to compare all banks on it</p></div>${switcher}</header>
    <div class="bd-wrap"><table class="bd">${head}<tbody>${body}</tbody></table></div>`;
  renderFinPicker(kind, items, totalIt, sel);
  renderFinRanking(m, sel);
  renderFinItemTrend(sel);
}

// Chooses the line item the monthly table and the all-banks ranking show.
function renderFinPicker(kind, items, totalIt, sel) {
  const opts = [...items, totalIt];
  const what = kind === "deposit" ? "deposit type" : kind === "product" ? "loan product" : "lending sector";
  const control = kind === "deposit"
    ? `<div class="toggle wide" role="group" aria-label="Deposit type">${opts.map((it) => `<button type="button" data-finpick="${it.key}" data-kind="${kind}" aria-pressed="${it.key === sel.key}">${esc(it.label.replace(/ deposits$/, ""))}</button>`).join("")}</div>`
    : `<select data-finpick-kind="${kind}" aria-label="${what}">${opts.map((it) => `<option value="${it.key}" ${it.key === sel.key ? "selected" : ""}>${esc(it.label)}</option>`).join("")}</select>`;
  $("fin-pick").hidden = false;
  $("fin-pick").innerHTML = `<div><b>Show month by month and across all banks:</b> <span class="dim">choose a ${what}</span></div>${control}`;
}

// All 20 banks on one line item: by amount, or by how much of their own book it is.
function renderFinRanking(m, it) {
  const by = it.total ? "amt" : state.finRankBy || "amt";
  const rows = Object.keys(m.banks).map((c) => ({ c, f: itemFacts(m, c, it) })).filter((r) => r.f);
  rows.sort((a, b) => (by === "amt" ? b.f.amt - a.f.amt : (b.f.mix ?? -1) - (a.f.mix ?? -1)));
  const max = Math.max(...rows.map((r) => (by === "amt" ? r.f.amt : r.f.mix || 0)), 1);
  $("fin-rank").innerHTML = `<header class="card-head chart-head"><div>
      <h2>${esc(it.label)}: all banks</h2><p>${esc(m.bs)} · ${by === "amt" ? "largest amount first" : `largest share of the bank's own ${it.base} first`}</p></div>
      <div class="toggle" role="group" aria-label="Rank by"><button type="button" data-rankby="amt" aria-pressed="${by === "amt"}">By amount</button>${it.total ? "" : `<button type="button" data-rankby="mix" aria-pressed="${by === "mix"}">By % of own ${esc(it.base)}</button>`}</div></header>
    <div class="rank-list">${rows.map((r, i) => {
      const me = r.c === REF, v = by === "amt" ? r.f.amt : r.f.mix || 0;
      return `<div class="rank-row ${me ? "me" : ""}"><span class="rr-n">${i + 1}</span>
        <span class="rr-bank"><b>${esc(SCRIP[r.c] || r.c)}</b> <span>${esc(bankName(r.c))}</span></span>
        <span class="rr-bar"><i style="width:${((100 * v) / max).toFixed(1)}%"></i></span>
        <span class="rr-v"><b>${by === "amt" ? fmtArba(r.f.amt) : fmtPct(r.f.mix)}</b><small>${by === "amt" ? `${fmtPct(r.f.mix)} of its ${esc(it.base)}` : fmtArba(r.f.amt)} · ${fmtPct(r.f.share, 2)} market share</small></span></div>`;
    }).join("")}</div>`;
}

// Month-by-month table for the comparison bank on one line item.
function renderFinItemTrend(it) {
  const months = state.fin.months;
  const lastId = months.at(-1).id;
  const ids = Array.from({ length: 13 }, (_, i) => shiftId(lastId, -i));
  const max = Math.max(...ids.map((id) => monthById(id)?.banks[REF]?.[it.key] || 0), 1);
  const rows = ids.map((id, i) => {
    const m = monthById(id);
    const [yy, mo] = id.split("-").map(Number);
    const name = m ? m.bs : `${NEPALI_MONTH_NAMES[mo - 1]} ${yy}`;
    if (!m) return `<tr class="gap-row"><td>${esc(name)}</td><td colspan="6" class="dim">Not published by NRB as a spreadsheet (PDF only)</td></tr>`;
    const f = itemFacts(m, REF, it);
    const prevM = monthById(ids[i + 1]);
    const pf = prevM ? itemFacts(prevM, REF, it) : null;
    const ch = f && pf ? f.amt - pf.amt : null;
    return `<tr class="${id === state.finMonth ? "cur" : ""}"><td>${esc(name)}</td>
      <td class="num"><span class="mixbar wide"><i style="width:${(100 * (f?.amt || 0) / max).toFixed(1)}%"></i></span><b>${f ? fmtArba(f.amt) : "—"}</b></td>
      <td class="num ${ch === null ? "" : ch >= 0 ? "up" : "down"}">${ch === null ? "—" : `${ch >= 0 ? "+" : "−"}${fmtArba(Math.abs(ch)).replace("Rs ", "Rs ")}`}</td>
      <td class="num">${f ? fmtPct(f.mix) : "—"}</td><td class="num">${f ? fmtPct(f.share, 2) : "—"}</td><td class="num">${f ? `#${f.rank}` : "—"}</td></tr>`;
  }).join("");
  $("fin-trend").innerHTML = `<header class="card-head"><h2>${esc(R())} · ${esc(it.label)}: month by month</h2>
      <p>Last 12 months, newest first · change is against the month before</p></header>
    <div class="bd-wrap"><table class="bd trend-t"><thead><tr><th>Month</th><th class="num">Amount</th><th class="num">Change in month</th><th class="num">% of ${esc(R())}'s ${esc(it.base)}</th><th class="num">Market share</th><th class="num">Rank among banks</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
const NEPALI_MONTH_NAMES = ["Baisakh", "Jestha", "Asar", "Shrawan", "Bhadau", "Asoj", "Kartik", "Mangsir", "Poush", "Magh", "Falgun", "Chaitra"];

// Profit & efficiency: the comparison bank's ratios with rank, market average and best bank.
function renderFinProfit(m) {
  const sel = FIN_METRICS.find((x) => x.key === state.finMetric) || FIN_METRICS[0];
  state.finMetric = sel.key;
  const K = (k) => FIN_METRICS.find((x) => x.key === k);
  const card = (mt, cls = "") => {
    const s = finStats(m, mt);
    if (!s) return "";
    return `<div class="kpi ${cls}"><div class="k-label">${esc(mt.label)}${mt.note ? ` <span class="k-sub">(${esc(mt.note)})</span>` : ""}</div><div class="k-value">${finFmt(mt, s.ref)}</div>
      <div class="k-facts">${s.rank ? `<span>Rank <b>#${s.rank}</b> of ${s.n}</span>` : ""}<span>Market ${s.avgLabel} <b>${finFmt(mt, s.avg)}</b></span></div></div>`;
  };
  $("fin-kpis").innerHTML = [card(K("net_profit"), "featured"), card(K("profit_growth")), card(K("nii")), card(K("cost_income")), card(K("spread"))].join("");
  $("fin-kpis").className = "kpis fin-kpis";
  const body = FIN_METRICS.map((mt) => {
    const s = finStats(m, mt);
    if (!s) return "";
    return `<tr class="bd-row ${mt.key === sel.key ? "sel" : ""}" data-fmetric="${mt.key}" title="Show how all banks compare on ${esc(mt.label)}">
      <td class="bd-name">${esc(mt.label)}${mt.note ? `<span class="memo-tag">${esc(mt.note)}</span>` : ""}</td>
      <td class="num"><b>${finFmt(mt, s.ref)}</b></td><td class="num">${s.rank ? `${rankChip(s.rank, s.n)} <span class="dim">of ${s.n}</span>` : '<span class="dim">not ranked</span>'}</td>
      <td class="num">${finFmt(mt, s.avg)}${mt.median ? ' <span class="dim">(median)</span>' : ""}</td>
      <td class="num">${s.best ? `${finFmt(mt, s.best[1])} <span class="dim">${esc(SCRIP[s.best[0]] || s.best[0])}</span>` : "—"}</td></tr>`;
  }).join("");
  $("fin-breakdown").innerHTML = `<header class="card-head"><h2>${esc(R())}'s profitability and efficiency</h2><p>${m.fy_month}-month year-to-date figures · rates marked annualised are scaled to a full year · click a row to compare all banks</p></header>
    <div class="bd-wrap"><table class="bd"><thead><tr><th>Measure</th><th class="num">${esc(R())}</th><th class="num">Rank among banks</th><th class="num">Market average</th><th class="num">Best bank</th></tr></thead><tbody>${body}</tbody></table></div>`;

  // ranking + trend for the selected measure
  const rows = Object.keys(m.banks).map((c) => ({ c, v: finVal(m, c, sel) })).filter((r) => r.v !== null);
  rows.sort((a, b) => (sel.better === "low" ? a.v - b.v : b.v - a.v));
  const lo = Math.min(0, ...rows.map((r) => r.v)), hi = Math.max(...rows.map((r) => r.v), 0);
  const span = hi - lo || 1;
  $("fin-rank").innerHTML = `<header class="card-head"><h2>${esc(sel.label)}: all banks</h2><p>${esc(m.bs)} · ${sel.better === "low" ? "lowest (best) first" : "highest first"}</p></header>
    <div class="rank-list">${rows.map((r, i) => `<div class="rank-row ${r.c === REF ? "me" : ""}"><span class="rr-n">${sel.better ? i + 1 : ""}</span>
      <span class="rr-bank"><b>${esc(SCRIP[r.c] || r.c)}</b> <span>${esc(bankName(r.c))}</span></span>
      <span class="rr-bar">${lo < 0 ? `<i class="zero" style="left:${((-lo / span) * 100).toFixed(1)}%"></i>` : ""}<i class="${r.v < 0 ? "neg" : ""}" style="left:${(((Math.min(0, r.v) - lo) / span) * 100).toFixed(1)}%;width:${((Math.abs(r.v) / span) * 100).toFixed(1)}%"></i></span>
      <span class="rr-v"><b>${finFmt(sel, r.v)}</b></span></div>`).join("")}</div>`;
  const ids = Array.from({ length: 13 }, (_, i) => shiftId(state.fin.months.at(-1).id, -i));
  $("fin-trend").innerHTML = `<header class="card-head"><h2>${esc(R())} · ${esc(sel.label)}: month by month</h2><p>Last 12 months, newest first · profit items restart each Shrawan (new fiscal year)</p></header>
    <div class="bd-wrap"><table class="bd trend-t"><thead><tr><th>Month</th><th class="num">${esc(R())}</th><th class="num">Market ${sel.median ? "median" : "average"}</th><th class="num">Rank among banks</th></tr></thead><tbody>${ids.map((id) => {
      const mm = monthById(id); const [yy, mo] = id.split("-").map(Number);
      if (!mm) return `<tr class="gap-row"><td>${NEPALI_MONTH_NAMES[mo - 1]} ${yy}</td><td colspan="3" class="dim">Not published by NRB as a spreadsheet (PDF only)</td></tr>`;
      const s = finStats(mm, sel);
      return `<tr class="${id === state.finMonth ? "cur" : ""}"><td>${esc(mm.bs)}</td><td class="num"><b>${s ? finFmt(sel, s.ref) : "—"}</b></td><td class="num">${s ? finFmt(sel, s.avg) : "—"}</td><td class="num">${s && s.rank ? `#${s.rank} of ${s.n}` : "—"}</td></tr>`;
    }).join("")}</tbody></table></div>`;
}

// "All banks side by side": every line item or measure (rows) × every bank (columns).
const MX_MODES = [["amt", "Amount"], ["share", "Market share"], ["mix", "% of own book"], ["rank", "Rank"], ["growth", "1-year growth"]];
const MX_GROUPS = [["all", "Everything"], ["deposit", "Deposits"], ["product", "Loan products"], ["sector", "Loan sectors"], ["profit", "Profitability"]];
const MX_PROFIT = ["net_profit", "nii", "fee_income", "cost_income", "roa", "roe", "cost_of_deposits", "yield_on_loans", "spread", "cd_ratio"];

// Rows of the matrix for the chosen month: [{group, label, key, kind:'item'|'metric', cells:{code:{...}}}]
function matrixRows(m) {
  const rows = [];
  const itemRow = (group, it) => {
    const cells = {};
    for (const c of Object.keys(m.banks)) { const f = itemFacts(m, c, it); if (f) cells[c] = f; }
    rows.push({ group, label: it.label, key: it.key, kind: "item", it, total: !!it.total, memo: !!it.memo, cells, market: Object.values(cells)[0]?.market });
  };
  const add = (kind, group) => {
    const g = FIN_ITEMS[kind];
    if (kind !== "sector") itemRow(group, itemByKey(g.base));
    g.items.forEach((it) => itemRow(group, { ...it, kind, base: g.base }));
  };
  add("deposit", "deposit"); add("product", "product"); add("sector", "sector");
  for (const k of MX_PROFIT) {
    const mt = FIN_METRICS.find((x) => x.key === k);
    const vals = Object.keys(m.banks).map((c) => [c, finVal(m, c, mt)]).filter(([, v]) => v !== null);
    const cells = {};
    for (const [c, v] of vals) cells[c] = { val: v, rank: mt.better ? 1 + vals.filter(([, x]) => (mt.better === "high" ? x > v : x < v)).length : null, n: vals.length };
    const s = finStats(m, mt);
    rows.push({ group: "profit", label: mt.label, note: mt.note, key: k, kind: "metric", mt, cells, avg: s?.avg, avgLabel: s?.avgLabel });
  }
  return rows;
}

function mxCellText(row, f, mode) {
  if (!f) return "—";
  if (row.kind === "metric") return mode === "rank" ? (f.rank ? `#${f.rank}` : "—") : finFmt(row.mt, f.val);
  if (mode === "amt") return arba(f.amt) >= 100 ? arba(f.amt).toFixed(1) : arba(f.amt).toFixed(2);
  if (mode === "share") return fmtPct(f.share, 1);
  if (mode === "mix") return row.total ? "100%" : fmtPct(f.mix, 1);
  if (mode === "rank") return `#${f.rank}`;
  if (mode === "growth") return f.growth === null ? "—" : fmtSigned(f.growth, "%", 0);
  return "";
}
// Rank within the row for the shown measure (amount/share share one ranking; mix and growth rank separately).
function mxRank(row, code, mode) {
  const f = row.cells[code];
  if (!f) return null;
  if (row.kind === "metric") return f.rank ? { r: f.rank, n: f.n } : null;
  const key = mode === "mix" ? "mix" : mode === "growth" ? "growth" : "amt";
  const v = f[key];
  if (v === null || v === undefined) return null;
  const vals = Object.values(row.cells).map((x) => x[key]).filter((x) => x !== null && x !== undefined);
  return { r: 1 + vals.filter((x) => x > v).length, n: vals.length };
}
function mxShade(rk) {
  if (!rk || rk.n < 2) return "";
  const t = 1 - (rk.r - 1) / (rk.n - 1);   // 1 = best in row
  return heatStyle(0.05 + 0.95 * t * t);
}

function renderFinMatrix(m) {
  const mode = state.mxMode || "amt", group = state.mxGroup || "all", order = state.mxOrder || "loans";
  const rows = matrixRows(m).filter((r) => group === "all" || r.group === group);
  const others = Object.keys(m.banks).filter((c) => c !== REF);
  if (order === "az") others.sort((a, b) => (SCRIP[a] || a).localeCompare(SCRIP[b] || b));
  else others.sort((a, b) => (m.banks[b][order] || 0) - (m.banks[a][order] || 0));
  const cols = [REF, ...others].filter((c) => m.banks[c]);

  $("fin-kpis").innerHTML = "";
  $("fin-kpis").className = "kpis fin-kpis empty";
  $("fin-trend").innerHTML = ""; $("fin-trend").hidden = true;
  $("fin-rank").innerHTML = ""; $("fin-rank").hidden = true;

  const tog = (attr, list, cur) => `<div class="toggle" role="group">${list.map(([k, l]) => `<button type="button" data-${attr}="${k}" aria-pressed="${k === cur}">${esc(l)}</button>`).join("")}</div>`;
  const groupNames = Object.fromEntries([["deposit", "Deposits"], ["product", "Loans by product"], ["sector", "Loans by sector"], ["profit", "Profitability & efficiency"]]);
  const unitNote = mode === "amt" ? "Rs arba" : mode === "share" ? "% of all 20 banks' total" : mode === "mix" ? "% of the bank's own deposits or loans" : mode === "rank" ? "1 = largest (or best)" : "change against the same month last year";

  let head = `<thead><tr><th class="mx-item">Line item <span class="mx-unit">${esc(unitNote)}</span></th><th class="mx-lead">Leader</th>`;
  for (const c of cols) head += `<th class="${c === REF ? "mx-ref" : ""}" title="${esc(bankName(c))}"><span class="mx-sym">${esc(SCRIP[c] || c)}</span></th>`;
  head += `<th class="mx-mkt">${mode === "amt" ? "All banks" : "Market"}</th></tr></thead>`;

  let body = "", g = null;
  for (const row of rows) {
    if (row.group !== g) { g = row.group; body += `<tr class="mx-seg"><td class="mx-item" colspan="2">${esc(groupNames[g])}</td><td colspan="${cols.length + 1}"></td></tr>`; }
    // leader on the shown measure (profit rows: best on the measure)
    let lead = null;
    for (const c of cols) { const rk = mxRank(row, c, mode); if (rk && rk.r === 1) { lead = c; break; } }
    const rowMode = row.kind === "metric" && mode !== "rank" ? "val" : mode;
    body += `<tr class="${row.total ? "mx-total" : ""} ${row.memo ? "mx-memo" : ""}"><td class="mx-item">${esc(row.label)}${row.note ? `<span>${esc(row.note)}</span>` : ""}${row.memo ? "<span>memo, overlaps other products</span>" : ""}</td>
      <td class="mx-lead">${lead ? `<b>${esc(SCRIP[lead] || lead)}</b>` : "—"}</td>`;
    for (const c of cols) {
      const f = row.cells[c];
      const rk = mxRank(row, c, mode);
      const tip = !f ? "" : row.kind === "metric"
        ? `${bankName(c)} · ${row.label}: ${finFmt(row.mt, f.val)}${f.rank ? ` · rank ${f.rank} of ${f.n}` : ""}`
        : `${bankName(c)} · ${row.label}: ${fmtArba(f.amt)} · ${row.total ? "" : `${fmtPct(f.mix)} of its ${row.it.base} · `}${fmtPct(f.share, 2)} market share · rank ${f.rank} of ${f.n}${f.growth !== null ? ` · ${fmtSigned(f.growth)} in a year` : ""}`;
      body += `<td class="${c === REF ? "mx-ref" : ""}" style="${mxShade(rk)}" title="${esc(tip)}">${mxCellText(row, f, rowMode)}</td>`;
    }
    // market column
    let mk = "—";
    if (row.kind === "metric") mk = row.avg === undefined ? "—" : `${finFmt(row.mt, row.avg)}${row.avgLabel === "median" ? "*" : ""}`;
    else if (mode === "amt") mk = fmtArba(row.market).replace("Rs ", "").replace(" arba", "");
    else if (mode === "share") mk = "100%";
    else if (mode === "mix") mk = row.total ? "100%" : fmtPct(Object.values(row.cells)[0]?.mktMix);
    else if (mode === "growth") mk = fmtSigned(Object.values(row.cells)[0]?.mktGrowth ?? null, "%", 0);
    else mk = `${Object.keys(row.cells).length} banks`;
    body += `<td class="mx-mkt">${mk}</td></tr>`;
  }

  $("fin-breakdown").innerHTML = `<header class="card-head chart-head"><div>
      <h2>All banks side by side · ${esc(m.bs)}</h2>
      <p>Each row is shaded by rank within that row: darker = larger (or better). ${esc(R())} is pinned first · hover a cell for its full figures</p></div></header>
    <div class="mx-controls">
      <label class="lbl">Show ${tog("mxmode", MX_MODES, mode)}</label>
      <label class="lbl">Rows ${tog("mxgroup", MX_GROUPS, group)}</label>
      <label class="lbl">Bank order ${tog("mxorder", [["loans", "By loans"], ["deposits", "By deposits"], ["az", "A–Z"]], order)}</label>
    </div>
    <div class="mx2-wrap"><table class="mx2">${head}<tbody>${body}</tbody></table></div>
    <p class="legend mx-legend"><span>Profitability rows always show their own measure (switch to <b>Rank</b> to rank them)</span><span>* market median</span><span>Amounts in Rs arba (billion)</span></p>`;
}

// Overview: the latest NRB position of the comparison bank, in one block.
function renderOverviewFinancials() {
  const box = $("ov-fin");
  if (!box || !state.fin || !state.model) return;
  const m = state.fin.months.at(-1);
  const line = (it) => {
    const f = itemFacts(m, REF, it);
    if (!f) return "";
    return `<div class="kpi"><div class="k-label">${esc(it.label)}</div><div class="k-value">${fmtArba(f.amt)}</div>
      <div class="k-facts">${it.total ? "" : `<span><b>${fmtPct(f.mix)}</b> of ${esc(R())}'s ${it.base}</span>`}<span><b>${fmtPct(f.share, 2)}</b> market share</span><span>Rank <b>#${f.rank}</b> of ${f.n}</span>${f.growth !== null ? `<span><b>${fmtSigned(f.growth)}</b> in a year</span>` : ""}</div></div>`;
  };
  const I = (k) => itemByKey(k);
  const np = FIN_METRICS[0], s = finStats(m, np), pg = finStats(m, FIN_METRICS[1]);
  const products = FIN_ITEMS.product.items.filter((it) => !it.memo).map((it) => ({ it: { ...it, kind: "product", base: "loans" } })).map((x) => ({ ...x, f: itemFacts(m, REF, x.it) })).filter((x) => x.f && x.f.amt > 0);
  const byRank = [...products].sort((a, b) => a.f.rank - b.f.rank);
  const li = (x) => `<li><span>${esc(x.it.label)}</span><b>#${x.f.rank}</b><span class="dim">${fmtArba(x.f.amt)} · ${fmtPct(x.f.share, 2)} share</span></li>`;
  box.innerHTML = `<div class="section-title"><h2>Financial position · ${esc(m.bs)}</h2>
      <p>Balance-sheet figures from Nepal Rastra Bank's monthly statistics (${esc(m.label)}) · <button type="button" class="linkish" data-tab="fin">Open Bank financials →</button></p></div>
    <div class="kpis fin-kpis">${line(I("deposits"))}${line(I("dep_current"))}${line(I("dep_savings"))}${line(I("loans"))}
      ${s ? `<div class="kpi"><div class="k-label">Net profit <span class="k-sub">(year to date)</span></div><div class="k-value">${fmtArba(s.ref)}</div><div class="k-facts"><span>Rank <b>#${s.rank}</b> of ${s.n}</span>${pg && pg.ref !== null ? `<span><b>${fmtSigned(pg.ref)}</b> vs a year earlier</span>` : ""}</div></div>` : ""}</div>
    <div class="ov-loans">
      <div class="card ov-list"><h3>Loan products where ${esc(R())} ranks highest</h3><ol>${byRank.slice(0, 4).map(li).join("")}</ol></div>
      <div class="card ov-list"><h3>Loan products where ${esc(R())} ranks lowest</h3><ol>${byRank.slice(-4).reverse().map(li).join("")}</ol></div>
    </div>`;
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
  // same Japanese palette as the site: ai, kon, kamenozoki, sumi, nibi, tokiwa, enji, kinari, shironezumi, yamabuki
  brand: "FF165E83", brandInk: "FF1B2D4F", tint: "FFEAF3F6", ink: "FF2B2B2B", muted: "FF6E6E6B",
  good: "FF1E7A4C", goodBg: "FFE5F2EA", bad: "FFB03A48", badBg: "FFF8E6E8", band: "FFFBFAF5",
  hair: "FFDCDDDD", gold: "FFC68C00", white: "FFFFFFFF",
};
const PCT = "0.00%";
const PP = '+0.00" pp";-0.00" pp";0.00" pp"';
const GAP = '"▲ "0.00;"▼ "0.00;"="';
const DIFF = () => `0.00" pp above ${R()}";0.00" pp below ${R()}";"same as ${R()}"`;
const SHEET_FOR_TAB = { summary: "Overview", deposit: "Deposits", loan: "Lending", base: "Base rate", banks: "Banks", fin: "Fin side by side (Rs arba)" };

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
    return "FF" + rampHex(d < 0 ? RAMP_AI : RAMP_ODO, 0.15 + 0.7 * t).slice(1).toUpperCase();
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

function addFinancialSheets(wb) {
  const m = finMonth();
  if (!m) return;
  const r2 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
  const codes = [REF, ...Object.keys(m.banks).filter((c) => c !== REF).sort((a, b) => (SCRIP[a] || a).localeCompare(SCRIP[b] || b))].filter((c) => m.banks[c]);
  const intro = `Nepal Rastra Bank monthly statistics · position at ${m.bs} (${m.label}) · amounts in Rs arba (billion) · ${m.source}`;
  const highlight = (x, n) => { for (let c = 1; c <= n; c++) { x.getCell(c).fill = fill(XL.tint); x.getCell(c).font = { bold: true, size: 10, color: { argb: XL.brandInk } }; } };

  // One sheet per breakdown: every bank × every item (amount, % of the bank's total, market share)
  const breakdown = (name, title, kind) => {
    const g = FIN_ITEMS[kind];
    const items = g.items.map((it) => ({ ...it, base: g.base }));
    const ws = wb.addWorksheet(name, { properties: { tabColor: { argb: XL.brand } } });
    const cols = ["Symbol", "Bank", `Total ${g.baseLabel} (Rs arba)`, ...items.flatMap((it) => [`${it.label} (Rs arba)`, `${it.label}: % of ${g.baseLabel}`, `${it.label}: market share %`])];
    sheetTitle(ws, `${title} — ${m.bs}`, cols.length);
    ws.getCell(2, 1).value = intro;
    const H = 4;
    headerRow(ws, H, cols, { textCols: 2, height: 66 });
    codes.forEach((code, i) => {
      const x = ws.getRow(H + 1 + i);
      x.values = [SCRIP[code] || code, bankName(code), r2(arba(m.banks[code][g.base])), ...items.flatMap((it) => { const f = itemFacts(m, code, it); return f ? [r2(arba(f.amt)), r2(f.mix), r2(f.share)] : [null, null, null]; })];
      for (let c = 3; c <= cols.length; c++) x.getCell(c).numFmt = (c - 3) % 3 === 0 ? "#,##0.00" : '0.00"%"';
      if (code === REF) highlight(x, cols.length);
    });
    const end = H + codes.length;
    styleBody(ws, H + 1, end, cols.length, { textCols: 2, band: true });
    const rr = ws.getRow(end + 2);
    rr.getCell(2).value = `${R()} rank by amount (1 = largest)`;
    items.forEach((it, j) => { const f = itemFacts(m, REF, it); rr.getCell(4 + 3 * j).value = f ? `${f.rank} of ${f.n}` : ""; });
    for (let c = 2; c <= cols.length; c++) { rr.getCell(c).font = { bold: true, size: 10, color: { argb: XL.muted } }; rr.getCell(c).alignment = { horizontal: c === 2 ? "left" : "center" }; }
    finishSheet(ws, { headerRowNo: H, lastRow: end, ncol: cols.length, xSplit: 2, widths: [9, 28, 13, ...items.flatMap(() => [12, 11, 11])] });
  };
  breakdown("Fin deposits", "Deposits by type", "deposit");
  breakdown("Fin loan products", "Loans by product", "product");
  breakdown("Fin loan sectors", "Loans by sector", "sector");

  // Every line item × every bank: amounts, then market shares
  const mxRowsAll = matrixRows(m).filter((r) => r.kind === "item");
  for (const [sheet, title, pick, nf] of [["Fin side by side (Rs arba)", "All banks side by side — amounts (Rs arba)", (f) => r2(arba(f.amt)), "#,##0.00"],
                                          ["Fin side by side (share %)", "All banks side by side — market share (%)", (f) => r2(f.share), '0.00"%"']]) {
    const wsx = wb.addWorksheet(sheet, { properties: { tabColor: { argb: XL.brand } } });
    const mcols = ["Section", "Line item", ...codes.map((c) => SCRIP[c] || c), "Leader", `${R()} rank`];
    sheetTitle(wsx, `${title} — ${m.bs}`, mcols.length);
    wsx.getCell(2, 1).value = intro;
    const MH = 4;
    headerRow(wsx, MH, mcols, { textCols: 2, height: 30, refCol: 3 });
    const names = { deposit: "Deposits", product: "Loans by product", sector: "Loans by sector" };
    mxRowsAll.forEach((row, i) => {
      const x = wsx.getRow(MH + 1 + i);
      const leader = Object.entries(row.cells).sort((a, b) => b[1].amt - a[1].amt)[0]?.[0];
      x.values = [names[row.group], row.label + (row.memo ? " (memo)" : ""), ...codes.map((c) => (row.cells[c] ? pick(row.cells[c]) : null)), leader ? SCRIP[leader] || leader : "", row.cells[REF] ? `${row.cells[REF].rank} of ${row.cells[REF].n}` : ""];
      codes.forEach((c, j) => {
        const cell = x.getCell(3 + j); cell.numFmt = nf;
        const f = row.cells[c]; if (!f) return;
        const t = 1 - (f.rank - 1) / Math.max(1, f.n - 1);
        const h = 0.05 + 0.95 * t * t;
        if (h > 0.08) cell.fill = fill("FF" + rampHex(RAMP_AI, h).slice(1).toUpperCase());
        if (h > 0.62) cell.font = { size: 10, color: { argb: XL.white }, bold: c === REF };
        else if (c === REF) cell.font = { size: 10, bold: true, color: { argb: XL.brandInk } };
      });
      if (row.total) { x.getCell(2).font = { bold: true, size: 10, color: { argb: XL.ink } }; }
    });
    styleBody(wsx, MH + 1, MH + mxRowsAll.length, mcols.length, { textCols: 2 });
    finishSheet(wsx, { headerRowNo: MH, lastRow: MH + mxRowsAll.length, ncol: mcols.length, xSplit: 3, widths: [16, 40, ...codes.map(() => 9), 9, 10] });
  }

  // Profitability and efficiency
  const ws = wb.addWorksheet("Fin profitability", { properties: { tabColor: { argb: XL.brand } } });
  const fmt = (mt) => (mt.unit === "arba" ? "#,##0.00" : '0.00"' + (mt.unit === "pp" ? " pp" : "%") + '"');
  const val = (mt, v) => r2(mt.unit === "arba" ? arba(v) : v);
  const cols = ["Symbol", "Bank", ...FIN_METRICS.map((mt) => `${mt.label}${mt.unit === "arba" ? " (Rs arba)" : mt.unit === "pp" ? " (pp)" : " (%)"}${mt.note ? ` — ${mt.note}` : ""}`)];
  sheetTitle(ws, `Profitability & efficiency — ${m.bs}`, cols.length);
  ws.getCell(2, 1).value = `${intro} · profit and loss is fiscal year to date (${m.fy_month} months)`;
  const H = 4;
  headerRow(ws, H, cols, { textCols: 2, height: 66 });
  codes.forEach((code, i) => {
    const x = ws.getRow(H + 1 + i);
    x.values = [SCRIP[code] || code, bankName(code), ...FIN_METRICS.map((mt) => val(mt, finVal(m, code, mt)))];
    FIN_METRICS.forEach((mt, j) => (x.getCell(3 + j).numFmt = fmt(mt)));
    if (code === REF) highlight(x, cols.length);
  });
  const end = H + codes.length;
  styleBody(ws, H + 1, end, cols.length, { textCols: 2, band: true });
  const rr = ws.getRow(end + 2), ar = ws.getRow(end + 3);
  rr.getCell(2).value = `${R()} rank (1 = best)`; ar.getCell(2).value = "Market average (growth: median)";
  FIN_METRICS.forEach((mt, j) => { const s = finStats(m, mt); rr.getCell(3 + j).value = s && s.rank ? `${s.rank} of ${s.n}` : "not ranked"; ar.getCell(3 + j).value = s ? val(mt, s.avg) : null; ar.getCell(3 + j).numFmt = fmt(mt); });
  for (const r of [rr, ar]) for (let c = 2; c <= cols.length; c++) { r.getCell(c).font = { bold: true, size: 10, color: { argb: XL.muted } }; r.getCell(c).alignment = { horizontal: c === 2 ? "left" : "center" }; }
  finishSheet(ws, { headerRowNo: H, lastRow: end, ncol: cols.length, xSplit: 2, widths: [9, 28, ...FIN_METRICS.map(() => 14)] });

  // The comparison bank month by month
  const wt = wb.addWorksheet("Fin trend", { properties: { tabColor: { argb: XL.brand } } });
  const lines = [itemByKey("deposits"), ...FIN_ITEMS.deposit.items.map((it) => ({ ...it, base: "deposits" })), itemByKey("loans"), ...FIN_ITEMS.product.items.map((it) => ({ ...it, base: "loans" }))];
  const tcols = ["Month", "Nepali month", ...lines.flatMap((it) => [`${it.label} (Rs arba)`, `${it.label}: market share %`, `${it.label}: rank`]), "Net profit, year to date (Rs arba)", "Net profit: rank"];
  sheetTitle(wt, `${RN()} — month by month`, tcols.length);
  wt.getCell(2, 1).value = "Nepal Rastra Bank monthly statistics · amounts in Rs arba · rank among the 20 commercial banks (1 = largest)";
  const TH = 4;
  headerRow(wt, TH, tcols, { textCols: 2, height: 66 });
  state.fin.months.forEach((mo, i) => {
    const x = wt.getRow(TH + 1 + i), s = finStats(mo, FIN_METRICS[0]);
    x.values = [mo.label, mo.bs, ...lines.flatMap((it) => { const f = itemFacts(mo, REF, it); return f ? [r2(arba(f.amt)), r2(f.share), f.rank] : [null, null, null]; }), s ? r2(arba(s.ref)) : null, s?.rank ?? null];
    for (let c = 3; c <= tcols.length; c++) x.getCell(c).numFmt = (c - 3) % 3 === 0 ? "#,##0.00" : (c - 3) % 3 === 1 ? '0.00"%"' : "0";
  });
  styleBody(wt, TH + 1, TH + state.fin.months.length, tcols.length, { textCols: 2, band: true });
  finishSheet(wt, { headerRowNo: TH, lastRow: TH + state.fin.months.length, ncol: tcols.length, xSplit: 2, widths: [16, 14, ...lines.flatMap(() => [12, 11, 8]), 14, 10] });
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
    ["Sheets", `Overview: headline figures and ${R()}'s rank, market best/average/worst for every product.\nDeposits / Lending: every bank's rate per product, ${R()} first, base rates above the header.\nBase rate: ranking and a bank-by-bank base rate matrix.\nBanks: base rate, NPL and key rates per bank.\nFin deposits / Fin loan products / Fin loan sectors / Fin profitability: Nepal Rastra Bank's monthly figures for every bank (amount, % of the bank's total, market share).\nFin side by side: every line item for every bank (amounts, and market shares), shaded by rank within the row.\nFin trend: the comparison bank month by month.\nAll rates: one row per bank and product, with ranges and premiums, for filtering and pivot tables.`],
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
    wb.creator = "Bank Tulana (independent project)";
    wb.created = new Date();
    addOverviewSheet(wb);
    addBaseSheet(wb);
    addGridSheet(wb, "deposit");
    addGridSheet(wb, "loan");
    addBanksSheet(wb);
    if (state.fin) addFinancialSheets(wb);
    addDetailSheet(wb);
    addNotesSheet(wb);
    const active = wb.worksheets.findIndex((w) => w.name === SHEET_FOR_TAB[state.tab]);
    wb.views = [{ activeTab: Math.max(0, active), firstSheet: 0 }];
    const buf = await wb.xlsx.writeBuffer();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    a.download = `Bank-Tulana-${new Date().toISOString().slice(0, 10)}.xlsx`;
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
  history.replaceState(null, "", location.search + "#" + tab + (tab === "fin" && state.finSection ? "/" + state.finSection : ""));
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
  if (t.dataset.fsec) { state.finSection = t.dataset.fsec; history.replaceState(null, "", location.search + "#fin/" + state.finSection); return renderFinancials(); }
  if (t.dataset.lview) { state.finLoanView = t.dataset.lview; return renderFinancials(); }
  if (t.dataset.mxmode) { state.mxMode = t.dataset.mxmode; return renderFinancials(); }
  if (t.dataset.mxgroup) { state.mxGroup = t.dataset.mxgroup; return renderFinancials(); }
  if (t.dataset.mxorder) { state.mxOrder = t.dataset.mxorder; return renderFinancials(); }
  if (t.dataset.finpick) { state.finItem = { ...(state.finItem || {}), [t.dataset.kind]: t.dataset.finpick }; return renderFinancials(); }
  if (t.dataset.rankby) { state.finRankBy = t.dataset.rankby; return renderFinancials(); }
  if (t.dataset.bdsort) { state.finBdSort = { ...(state.finBdSort || {}), [t.dataset.kind]: t.dataset.bdsort }; return renderFinancials(); }
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
$("fin-month").addEventListener("change", (e) => { state.finMonth = e.target.value; renderFinancials(); });
$("fin-pick").addEventListener("change", (e) => {
  const k = e.target.dataset.finpickKind;
  if (k) { state.finItem = { ...(state.finItem || {}), [k]: e.target.value }; renderFinancials(); }
});
// Clicking a breakdown or measure row selects it for the all-banks ranking and the monthly table.
$("fin-breakdown").addEventListener("click", (e) => {
  if (e.target.closest("button")) return;
  const tr = e.target.closest("tr[data-bditem], tr[data-fmetric]");
  if (!tr) return;
  if (tr.dataset.fmetric) state.finMetric = tr.dataset.fmetric;
  else state.finItem = { ...(state.finItem || {}), [tr.dataset.kind]: tr.dataset.bditem };
  renderFinancials();
});
$("ref-select").addEventListener("change", (e) => setRef(e.target.value));
window.addEventListener("resize", fitGrids);

state.order = "az";
state.show = { loan: "premium", deposit: "range" };
// links can open a tab, or a Financials section: #fin/loan, #fin/matrix …
const [initial, initialSection] = location.hash.slice(1).split("/");
if (initial === "fin" && ["deposit", "loan", "profit", "matrix"].includes(initialSection)) state.finSection = initialSection;
if (["summary", "loan", "deposit", "base", "banks", "fin"].includes(initial)) showTab(initial);
load();
loadFinancials();
setInterval(() => { if (!document.hidden) load(); }, AUTO_REFRESH_MS);
// coming back to a tab left open for a while: refresh once
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt > AUTO_REFRESH_MS) load();
});
