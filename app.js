// NMB Bank rate comparison. Reads the BankByaj API live in the browser and
// falls back to data/snapshot.json (refreshed hourly by GitHub Actions).
"use strict";

const API = "https://admin.bankbyaj.com/api/v1/";
const NMB = "NMB Bank";             // institute_code used by BankByaj
const AUTO_REFRESH_MS = 15 * 60 * 1000;

const state = { data: null, source: null, tab: "summary", csv: {} };
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
  const [loanCats, depositCats, baseRates] = await Promise.all([
    getJson(API + "categories/loan"),
    getJson(API + "categories/deposit"),
    getJson(API + "baserates"),
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

  const base = {};
  for (const b of d.baseRates) if (codes.has(b.code)) base[b.code] = num(b.base_rate);

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
    base,
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
  const add = (section, segment, product, variant, cellList) => {
    const cells = {};
    for (const c of cellList) cells[c.code] = c;
    if (!cellList.length) return;
    const lowerIsBetter = section === "loan";
    const values = Object.fromEntries(cellList.map((c) => [c.code, c.value]));
    rows.push({ section, segment, product, variant, cells, lowerIsBetter, s: standing(values, lowerIsBetter) });
  };

  for (const [segment, cats] of bySegment(m.loans, LOAN_SEGMENTS)) {
    for (const c of cats) {
      for (const kind of ["variable", "fixed"]) {
        add("loan", segment, c.title, kind === "fixed" ? "Fixed" : "Variable",
          Object.values(c.rows).filter((r) => hasRange(r[kind])).map((r) => ({
            code: r.code, range: r[kind], value: r[kind].lo, products: r.products.filter((p) => p.fixed === (kind === "fixed")),
          })));
      }
    }
  }

  const depCell = (r) => ({ code: r.code, range: r.all, value: r.all.hi, products: r.products });
  for (const c of m.deposits.filter((c) => c.periods)) {
    for (const p of c.periods) add("deposit", `${c.title} by tenure`, p.label, null, Object.values(p.rows).map(depCell));
  }
  for (const [segment, cats] of bySegment(m.deposits.filter((c) => !c.periods), DEPOSIT_SEGMENTS)) {
    for (const c of cats) add("deposit", segment, c.title, null, Object.values(c.rows).map(depCell));
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
  if (mode === "single" || r.lo === r.hi) return pct(mode === "single" ? r.single : r.lo);
  return `${r.lo.toFixed(2)}<span class="to">–</span>${pct(r.hi)}`;
}

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
  fitGrids();
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
    kpi("Base rate", pct(base.nmb), `Rank ${base.rank} of ${base.n} (lowest first) · market avg ${pct(base.avg)}`, "featured"),
    kpi("Deposits paying above market avg", `${depWins}<small>/${deps.length}</small>`, "deposit lines NMB offers, by top rate"),
    kpi("Lending priced below market avg", `${loanWins}<small>/${loans.length}</small>`, "loan lines NMB offers, by lowest rate"),
    kpi("Market-leading rates", `${leads.length}`, leads.length ? esc(leadText.slice(0, 3).join(" · ") + (leads.length > 3 ? ` +${leads.length - 3}` : "")) : "None today"),
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

  const csv = [["Segment", "Product", "Variant", "NMB", "NMB rank", "Banks", "Market best", "Market average", "Market worst", "NMB minus average (pp)"]];
  for (const r of rows) {
    const s = r.s, best = r.lowerIsBetter ? s.min : s.max, worst = r.lowerIsBetter ? s.max : s.min;
    csv.push([r.segment, r.product, r.variant || "", s.nmb?.toFixed(2) ?? "Not offered", s.rank ?? "", s.n, best.toFixed(2), s.avg.toFixed(2), worst.toFixed(2), s.nmb === null ? "" : (s.nmb - s.avg).toFixed(2)]);
  }
  state.csv[section + "-score"] = csv;
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
function renderGrid(section) {
  const m = state.model;
  const rows = state.rows.filter((r) => r.section === section);
  const cols = orderedBanks();
  const others = cols.slice(1);
  const mode = state.show;
  const nmbBase = m.base[NMB];

  let head = `<thead><tr>
    <th class="pin c1">Product</th>
    <th class="pin c2 nmb"><img src="assets/nmb-logo-white.png" alt="NMB Bank" class="nmb-logo"><div class="b-base">Base <b>${pct(nmbBase)}</b></div></th>
    <th class="pin c3">Rank<div class="b-base">best in market</div></th>`;
  for (const b of others) {
    head += `<th><div class="b-name">${bankLabel(b.code)}</div><div class="b-base">Base <b>${pct(m.base[b.code])}</b> ${arrow(m.base[b.code] - nmbBase, true)}</div></th>`;
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
    const tip = (c) => esc(c.products.map((p) => `${p.name}: ${p.rate.lo === p.rate.hi ? pct(p.rate.lo) : pct(p.rate.lo) + " – " + pct(p.rate.hi)}`).join("\n"));
    const cellRange = (c) => ({ ...c.range, single: c.value });
    const star = (c) => (Math.abs(c.value - best) < 0.005 ? `<span class="star" title="Best rate in market">★</span>` : "");

    body += `<tr class="${r.variant === "Fixed" ? "sub" : ""}">
      <td class="pin c1">${r.variant === "Fixed" ? `<span class="tag">Fixed</span>` : esc(r.product)}${r.variant === "Variable" ? `<span class="var">variable</span>` : ""}</td>
      <td class="pin c2 nmb" ${nmb ? `title="${tip(nmb)}"` : ""}>${nmb ? `<div class="rate">${rateHtml(cellRange(nmb), mode)}${star(nmb)}</div>` : '<span class="na">Not offered</span>'}</td>
      <td class="pin c3"><div class="rank">${s.rank ? `${s.rank}<span>/${s.n}</span>` : '<span class="na">—</span>'}</div><div class="best">${pct(best)}</div></td>`;
    for (const b of others) {
      const c = r.cells[b.code];
      if (!c) { body += `<td><span class="na">—</span></td>`; continue; }
      body += `<td title="${tip(c)}"><div class="rate">${rateHtml(cellRange(c), mode)}${star(c)}</div>${nmb ? arrow(c.value - nmb.value, r.lowerIsBetter) : ""}</td>`;
    }
    body += `</tr>`;
  }
  $(`${section}-table`).innerHTML = head + `<tbody>${body}</tbody>`;
  $(`${section}-jump`).innerHTML = segments.map(([name, id]) => `<button type="button" data-jump="${id}">${esc(name)}</button>`).join("");

  const csv = [["Segment", "Product", "Variant", "NMB rank", "Market best", ...cols.map((b) => b.name), ...others.map((b) => `${b.name} minus NMB (pp)`)]];
  csv.push(["", "Base rate", "", "", "", ...cols.map((b) => m.base[b.code]?.toFixed(2) ?? ""), ...others.map((b) => m.base[b.code] !== undefined ? (m.base[b.code] - nmbBase).toFixed(2) : "")]);
  for (const r of rows) {
    const nmb = r.cells[NMB];
    const fmt = (c) => (c ? (c.range.lo === c.range.hi ? c.range.lo.toFixed(2) : `${c.range.lo.toFixed(2)} - ${c.range.hi.toFixed(2)}`) : "");
    csv.push([r.segment, r.product, r.variant || "", r.s.rank ? `${r.s.rank}/${r.s.n}` : "", (r.lowerIsBetter ? r.s.min : r.s.max).toFixed(2),
      ...cols.map((b) => fmt(r.cells[b.code])), ...others.map((b) => (r.cells[b.code] && nmb ? (r.cells[b.code].value - nmb.value).toFixed(2) : ""))]);
  }
  state.csv[section] = csv;
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

// ---------- CSV ----------

function downloadCsv(names) {
  const rows = names.split(",").flatMap((n, i) => (i ? [[], ...(state.csv[n] || [])] : state.csv[n] || []));
  if (!rows.length) return;
  const text = rows.map((r) => r.map((v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv" }));
  a.download = `nmb-rate-comparison-${names.split(",")[0].replace("-score", "-overview")}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
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
  if (t.dataset.csv) return downloadCsv(t.dataset.csv);
  if (t.dataset.order) { state.order = t.dataset.order; setToggle("order", state.order); renderGrid("loan"); renderGrid("deposit"); return; }
  if (t.dataset.show) { state.show = t.dataset.show; setToggle("show", state.show); renderGrid("loan"); renderGrid("deposit"); return; }
  if (t.dataset.jump) {
    const row = $(t.dataset.jump), wrap = row.closest(".grid-wrap");
    wrap.scrollTo({ top: row.offsetTop - wrap.querySelector("thead").offsetHeight, behavior: "smooth" });
  }
});
$("refresh").addEventListener("click", load);
window.addEventListener("resize", fitGrids);

state.order = "az";
state.show = "range";
const initial = location.hash.slice(1);
if (["summary", "loan", "deposit"].includes(initial)) showTab(initial);
load();
setInterval(() => { if (!document.hidden) load(); }, AUTO_REFRESH_MS);
