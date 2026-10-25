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
  setBadge("Loading…", "");
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
  b.className = "badge " + cls;
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
    deposits: build(d.depositCategories, "deposit"),
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

// ---------- formatting ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (v) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(2) + "%");
const range = (r) => (!hasRange(r) ? "—" : r.lo === r.hi ? pct(r.lo) : `${pct(r.lo)} – ${pct(r.hi)}`);
const ordinal = (n) => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
const fmtDate = (s) => (s ? new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

// diff = other − NMB. lowerIsBetter: for loans a cheaper NMB is "good".
function deltaBadge(diff, lowerIsBetter, vsLabel = "") {
  if (diff === null || !Number.isFinite(diff)) return '<span class="dim">—</span>';
  if (Math.abs(diff) < 0.005) return `<span class="delta even">same${vsLabel}</span>`;
  const nmbBetter = lowerIsBetter ? diff > 0 : diff < 0;
  const sign = diff > 0 ? "+" : "−";
  return `<span class="delta ${nmbBetter ? "good" : "bad"}">${sign}${Math.abs(diff).toFixed(2)}${vsLabel}</span>`;
}

// Shows NMB − average; below average is good for loans/base, above is good for deposits.
function vsAvgBadge(s, lowerIsBetter) {
  if (s.nmb === null) return '<span class="dim">—</span>';
  const v = s.nmb - s.avg;
  if (Math.abs(v) < 0.005) return '<span class="delta even">at avg</span>';
  const good = lowerIsBetter ? v < 0 : v > 0;
  return `<span class="delta ${good ? "good" : "bad"}">${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}</span>`;
}

function bankLabel(code) {
  return esc(state.model.nameOf[code] || code);
}

// ---------- rendering ----------

function render() {
  const m = state.model;
  $("bank-count").textContent = m.banks.length;
  if (state.source === "live") setBadge("● Live", "live");
  else setBadge("Backup copy", "snap");
  const when = state.source === "live" ? "Fetched " + fmtDate(state.data.fetched_at) : "Backup from " + fmtDate(state.data.fetched_at);
  $("updated").textContent = `${when}${m.modified ? " · source updated " + fmtDate(m.modified) : ""}`;

  renderSummary();
  renderMatrix("loan");
  renderMatrix("deposit");
}

function summaryRows() {
  const m = state.model;
  const rows = [];
  const push = (group, label, values, ascending, nmbText) => {
    const s = standing(values, ascending);
    if (s) rows.push({ group, label, s, ascending, nmbText });
  };
  push("Base rate", "Base rate", { ...m.base }, true, (s) => pct(s.nmb));
  for (const kind of ["variable", "fixed"]) {
    for (const c of m.loans) {
      const values = {};
      for (const r of Object.values(c.rows)) if (hasRange(r[kind])) values[r.code] = r[kind].lo;
      const nmbRow = c.rows[NMB];
      push(kind === "variable" ? "Loans · variable rate" : "Loans · fixed rate", c.title, values, true,
        () => range(nmbRow?.[kind]));
    }
  }
  for (const c of m.deposits) {
    const values = {};
    for (const r of Object.values(c.rows)) values[r.code] = r.all.hi;
    push("Deposits", c.title, values, false, () => range(c.rows[NMB]?.all));
  }
  return rows;
}

function renderSummary() {
  const rows = summaryRows();
  const head = `<thead><tr><th>Product</th><th>NMB rate</th><th class="num">NMB rank</th><th>Market lowest</th><th>Market highest</th><th class="num">Average</th><th class="num">NMB vs avg</th></tr></thead>`;
  let body = "", group = null;
  const csv = [["Group", "Product", "NMB rate", "NMB rank", "Banks compared", "Market lowest", "Lowest bank(s)", "Market highest", "Highest bank(s)", "Average", "NMB minus average (pp)"]];
  for (const r of rows) {
    if (r.group !== group) {
      group = r.group;
      body += `<tr class="group"><td colspan="7">${esc(group)}</td></tr>`;
    }
    const s = r.s;
    const diff = s.nmb === null ? null : s.nmb - s.avg;
    const names = (codes) => codes.length === 1 ? bankLabel(codes[0])
      : `<span title="${codes.map(bankLabel).join(", ")}">${bankLabel(codes[0])} +${codes.length - 1} more</span>`;
    body += `<tr>
      <td>${esc(r.label)}</td>
      <td><b>${esc(r.nmbText(s))}</b></td>
      <td class="num">${s.rank ? `${ordinal(s.rank)} <span class="dim">of ${s.n}</span>` : '<span class="dim">no product</span>'}</td>
      <td>${pct(s.min)}<div class="who">${names(s.minBanks)}</div></td>
      <td>${pct(s.max)}<div class="who">${names(s.maxBanks)}</div></td>
      <td class="num">${pct(s.avg)}</td>
      <td class="num">${vsAvgBadge(s, r.ascending)}</td>
    </tr>`;
    csv.push([r.group, r.label, r.nmbText(s), s.rank ? `${s.rank} of ${s.n}` : "", s.n,
      s.min.toFixed(2), s.minBanks.map((c) => state.model.nameOf[c]).join("; "),
      s.max.toFixed(2), s.maxBanks.map((c) => state.model.nameOf[c]).join("; "),
      s.avg.toFixed(2), diff === null ? "" : diff.toFixed(2)]);
  }
  $("summary-table").innerHTML = head + `<tbody>${body}</tbody>`;
  state.csv.summary = csv;
}

// One matrix per section: rows = product types, columns = banks.
// Product and NMB columns stay pinned on the left; bank names and the base-rate
// row stay pinned on top. Each cell compares that bank with NMB.
function renderMatrix(type) {
  const m = state.model;
  const isLoan = type === "loan";
  const others = m.banks.filter((b) => b.code !== NMB).sort((a, b) => a.name.localeCompare(b.name));
  const cols = [m.banks.find((b) => b.code === NMB), ...others].filter(Boolean);

  // Rows: loans split into variable/fixed; compare on lowest rate for loans,
  // highest rate for deposits.
  const rows = [];
  if (isLoan) {
    for (const kind of ["variable", "fixed"]) {
      for (const c of m.loans) {
        const cells = {};
        for (const r of Object.values(c.rows)) {
          if (!hasRange(r[kind])) continue;
          cells[r.code] = { range: r[kind], value: r[kind].lo, products: r.products.filter((p) => p.fixed === (kind === "fixed")) };
        }
        if (Object.keys(cells).length) rows.push({ group: kind === "variable" ? "Variable rate loans" : "Fixed rate loans", title: c.title, cells });
      }
    }
  } else {
    for (const c of m.deposits) {
      const cells = {};
      for (const r of Object.values(c.rows)) cells[r.code] = { range: r.all, value: r.all.hi, products: r.products };
      rows.push({ group: "Deposits", title: c.title, cells });
    }
  }

  const lowerIsBetter = isLoan;
  const nmbBase = m.base[NMB];

  let head = `<thead><tr><th class="pin pin-1">Product</th>`;
  for (const b of cols) head += `<th class="${b.code === NMB ? "pin pin-2 nmb-col" : "bank-col"}">${bankLabel(b.code)}</th>`;
  head += `</tr><tr class="base-row"><th class="pin pin-1">Base rate</th>`;
  for (const b of cols) {
    const v = m.base[b.code];
    if (b.code === NMB) head += `<th class="pin pin-2 nmb-col"><div class="rate">${pct(v)}</div></th>`;
    else head += `<th><div class="rate">${pct(v)}</div>${cmp(v, nmbBase, true)}</th>`;
  }
  head += `</tr></thead>`;

  let body = "", group = null;
  const csv = [["Section", "Product", ...cols.map((b) => b.name), ...cols.filter((b) => b.code !== NMB).map((b) => b.name + " vs NMB")]];
  csv.push(["", "Base rate", ...cols.map((b) => m.base[b.code]?.toFixed(2) ?? ""), ...cols.filter((b) => b.code !== NMB).map((b) => m.base[b.code] !== undefined && nmbBase !== undefined ? (m.base[b.code] - nmbBase).toFixed(2) : "")]);

  for (const row of rows) {
    if (row.group !== group) {
      group = row.group;
      body += `<tr class="group"><td class="pin pin-1">${esc(group)}</td><td class="pin pin-2 nmb-col"></td><td colspan="${cols.length - 1}"></td></tr>`;
    }
    const vals = Object.values(row.cells).map((c) => c.value);
    const best = lowerIsBetter ? Math.min(...vals) : Math.max(...vals);
    const nmb = row.cells[NMB];
    body += `<tr><td class="pin pin-1">${esc(row.title)}</td>`;
    for (const b of cols) {
      const c = row.cells[b.code];
      const me = b.code === NMB;
      const cls = me ? "pin pin-2 nmb-col" : "";
      if (!c) { body += `<td class="${cls}"><span class="dim">—</span></td>`; continue; }
      const tip = c.products.map((p) => `${p.name}: ${p.rate.lo === p.rate.hi ? pct(p.rate.lo) : pct(p.rate.lo) + " – " + pct(p.rate.hi)}`).join("\n");
      const star = Math.abs(c.value - best) < 0.005 ? `<span class="best" title="Best rate in market">★</span>` : "";
      body += `<td class="${cls}" title="${esc(tip)}"><div class="rate">${shortRange(c.range)}${star}</div>${me ? "" : cmp(c.value, nmb?.value, lowerIsBetter)}</td>`;
    }
    body += `</tr>`;
    csv.push([row.group, row.title, ...cols.map((b) => row.cells[b.code] ? shortRange(row.cells[b.code].range) : ""),
      ...cols.filter((b) => b.code !== NMB).map((b) => row.cells[b.code] && nmb ? (row.cells[b.code].value - nmb.value).toFixed(2) : "")]);
  }
  const table = $(type + "-table");
  table.innerHTML = head + `<tbody>${body}</tbody>`;
  state.csv[type] = csv;
  pinBaseRow(table);
}

// The base-rate row sticks just under the bank-name row; its offset depends on
// how many lines the bank names wrap to. Hidden tabs measure 0, so redo on show.
function pinBaseRow(table) {
  const h = table.tHead?.rows[0]?.offsetHeight;
  if (h) table.style.setProperty("--head-h", h + "px");
}

function shortRange(r) {
  return r.lo === r.hi ? pct(r.lo) : `${r.lo.toFixed(2)} – ${pct(r.hi)}`;
}

// Small "▲ 0.25 higher" / "▼ 0.25 lower" vs NMB. Green when NMB is the better deal.
function cmp(v, nmb, lowerIsBetter) {
  if (v === undefined || v === null || nmb === undefined || nmb === null) return `<div class="cmp none">no NMB product</div>`;
  const d = v - nmb;
  if (Math.abs(d) < 0.005) return `<div class="cmp even">same as NMB</div>`;
  const nmbBetter = lowerIsBetter ? d > 0 : d < 0;
  return `<div class="cmp ${nmbBetter ? "good" : "bad"}">${d > 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(2)} ${d > 0 ? "higher" : "lower"}</div>`;
}

// ---------- CSV ----------

function downloadCsv(name) {
  const rows = state.csv?.[name];
  if (!rows) return;
  const text = rows.map((r) => r.map((v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\n");
  const label = name;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv" }));
  a.download = `nmb-comparison-${label}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- events ----------

function showTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.id !== "tab-" + tab));
  history.replaceState(null, "", "#" + tab);
  const t = $(tab + "-table");
  if (t) pinBaseRow(t);
}

document.querySelector(".tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) showTab(b.dataset.tab);
});
$("refresh").addEventListener("click", load);

document.addEventListener("click", (e) => {
  const csvBtn = e.target.closest("[data-csv]");
  if (csvBtn) return downloadCsv(csvBtn.dataset.csv);
});

const initial = location.hash.slice(1);
if (["summary", "loan", "deposit"].includes(initial)) showTab(initial);
load();
setInterval(() => { if (!document.hidden) load(); }, AUTO_REFRESH_MS);
