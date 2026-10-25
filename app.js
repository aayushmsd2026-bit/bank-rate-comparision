// NMB Bank rate comparison. Reads the BankByaj API live in the browser and
// falls back to data/snapshot.json (refreshed hourly by GitHub Actions).
"use strict";

const API = "https://admin.bankbyaj.com/api/v1/";
const NMB = "NMB Bank";             // institute_code used by BankByaj
const AUTO_REFRESH_MS = 15 * 60 * 1000;

const state = { data: null, source: null, tab: "summary", loanKey: null, depositKey: null, sort: {} };
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
  state.loanKey ||= model.loans[0]?.key;
  state.depositKey ||= model.deposits[0]?.key;
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
  renderBase();
  renderCategory("loan");
  renderCategory("deposit");
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
  state.csv = state.csv || {};
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

function renderBase() {
  const m = state.model;
  const list = m.banks.map((b) => ({ code: b.code, rate: m.base[b.code] ?? null }))
    .filter((b) => b.rate !== null).sort((a, b) => a.rate - b.rate);
  const s = standing(m.base, true);
  const nmb = m.base[NMB];
  const max = Math.max(...list.map((b) => b.rate));
  $("base-card").innerHTML = s ? cards([
    ["NMB base rate", pct(nmb), s.rank ? `${ordinal(s.rank)} lowest of ${s.n}` : ""],
    ["Lowest", pct(s.min), s.minBanks.map(bankLabel).join(", ")],
    ["Highest", pct(s.max), s.maxBanks.map(bankLabel).join(", ")],
    ["Average", pct(s.avg), nmb !== undefined ? `NMB is ${Math.abs(nmb - s.avg).toFixed(2)} pp ${nmb > s.avg ? "above" : "below"}` : ""],
  ]) : "";
  let body = "";
  list.forEach((b, i) => {
    body += `<tr class="${b.code === NMB ? "nmb" : ""}">
      <td class="num">${i + 1}</td><td>${bankLabel(b.code)}</td><td class="num"><b>${pct(b.rate)}</b></td>
      <td class="num">${b.code === NMB ? '<span class="dim">NMB</span>' : deltaBadge(b.rate - nmb, true)}</td>
      <td style="width:35%"><div class="bar ${b.code === NMB ? "nmb" : ""}" style="width:${(b.rate / max * 100).toFixed(1)}%"></div></td>
    </tr>`;
  });
  $("base-table").innerHTML = `<thead><tr><th class="num">#</th><th>Bank</th><th class="num">Base rate</th><th class="num">vs NMB</th><th></th></tr></thead><tbody>${body}</tbody>`;
  state.csv.base = [["Rank", "Bank", "Base rate", "Difference vs NMB (pp)"],
    ...list.map((b, i) => [i + 1, m.nameOf[b.code], b.rate.toFixed(2), (b.rate - nmb).toFixed(2)])];
}

function cards(items) {
  return items.map(([label, value, note]) =>
    `<div class="card"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="note">${note || ""}</div></div>`).join("");
}

function fillSelect(type) {
  const sel = $(type + "-select");
  const cats = type === "loan" ? state.model.loans : state.model.deposits;
  const current = type === "loan" ? state.loanKey : state.depositKey;
  sel.innerHTML = cats.map((c) =>
    `<option value="${esc(c.key)}" ${c.key === current ? "selected" : ""}>${esc(c.title)}${c.rows[NMB] ? "" : " (no NMB product)"}</option>`).join("");
}

function renderCategory(type) {
  fillSelect(type);
  const m = state.model;
  const isLoan = type === "loan";
  const key = isLoan ? state.loanKey : state.depositKey;
  const cat = (isLoan ? m.loans : m.deposits).find((c) => c.key === key);
  if (!cat) return;
  const nmb = cat.rows[NMB];
  const rows = Object.values(cat.rows);

  // Cards
  const items = [];
  if (isLoan) {
    for (const kind of ["variable", "fixed"]) {
      const values = Object.fromEntries(rows.filter((r) => hasRange(r[kind])).map((r) => [r.code, r[kind].lo]));
      const s = standing(values, true);
      if (!s) continue;
      const label = kind === "variable" ? "Variable" : "Fixed";
      items.push([`NMB · ${label}`, range(nmb?.[kind]), s.rank ? `${ordinal(s.rank)} cheapest of ${s.n} (by lowest rate)` : `NMB has no ${kind}-rate product`]);
      items.push([`Market · ${label}`, `${pct(s.min)} – ${pct(Math.max(...rows.filter((r) => hasRange(r[kind])).map((r) => r[kind].hi)))}`,
        `Cheapest: ${s.minBanks.map(bankLabel).join(", ")} · avg from ${pct(s.avg)}`]);
    }
  } else {
    const values = Object.fromEntries(rows.map((r) => [r.code, r.all.hi]));
    const s = standing(values, false);
    if (s) {
      items.push(["NMB", range(nmb?.all), s.rank ? `${ordinal(s.rank)} highest of ${s.n} (by top rate)` : "NMB has no product here"]);
      items.push(["Market top rate", pct(s.max), s.maxBanks.map(bankLabel).join(", ")]);
      items.push(["Average top rate", pct(s.avg), s.nmb !== null ? `NMB is ${Math.abs(s.nmb - s.avg).toFixed(2)} pp ${s.nmb >= s.avg ? "above" : "below"}` : ""]);
    }
  }
  $(type + "-card").innerHTML = cards(items);

  // Table
  const sortState = state.sort[type] ||= { key: isLoan ? "variable" : "all", dir: isLoan ? 1 : -1 };
  const sortVal = (r) => {
    switch (sortState.key) {
      case "bank": return m.nameOf[r.code] || r.code;
      case "base": return m.base[r.code] ?? Infinity;
      case "variable": return hasRange(r.variable) ? r.variable.lo : null;
      case "fixed": return hasRange(r.fixed) ? r.fixed.lo : null;
      case "all": return r.all.hi;
    }
  };
  rows.sort((a, b) => {
    const va = sortVal(a), vb = sortVal(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;            // banks without that rate go last
    if (vb === null) return -1;
    return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * sortState.dir;
  });

  const th = (k, label, cls = "") => {
    const arrow = sortState.key === k ? (sortState.dir === 1 ? " ▲" : " ▼") : "";
    return `<th class="sortable ${cls}" data-sort="${k}" data-type="${type}">${label}<span class="arrow">${arrow}</span></th>`;
  };
  const head = isLoan
    ? `<thead><tr><th class="num">#</th>${th("bank", "Bank")}${th("base", "Base rate", "num")}${th("variable", "Variable rate")}<th class="num">vs NMB</th>${th("fixed", "Fixed rate")}<th class="num">vs NMB</th><th class="num">Products</th></tr></thead>`
    : `<thead><tr><th class="num">#</th>${th("bank", "Bank")}${th("all", "Rate (lowest – highest)")}<th class="num">Top rate vs NMB</th><th class="num">Products</th></tr></thead>`;

  const cols = isLoan ? 8 : 5;
  let body = "";
  rows.forEach((r, i) => {
    const me = r.code === NMB;
    const cells = isLoan
      ? `<td class="num">${pct(m.base[r.code])}</td>
         <td>${range(r.variable)}</td>
         <td class="num">${me ? '<span class="dim">NMB</span>' : deltaBadge(hasRange(r.variable) && hasRange(nmb?.variable) ? r.variable.lo - nmb.variable.lo : null, true)}</td>
         <td>${range(r.fixed)}</td>
         <td class="num">${me ? '<span class="dim">NMB</span>' : deltaBadge(hasRange(r.fixed) && hasRange(nmb?.fixed) ? r.fixed.lo - nmb.fixed.lo : null, true)}</td>`
      : `<td>${range(r.all)}</td>
         <td class="num">${me ? '<span class="dim">NMB</span>' : deltaBadge(nmb ? r.all.hi - nmb.all.hi : null, false)}</td>`;
    body += `<tr class="bank-row ${me ? "nmb" : ""}" data-detail="${type}-${i}">
      <td class="num">${i + 1}</td>
      <td><span class="caret">›</span>${bankLabel(r.code)}</td>
      ${cells}
      <td class="num">${r.products.length}</td>
    </tr>
    <tr class="detail" id="${type}-${i}" hidden><td colspan="${cols}">${productTable(r, isLoan)}</td></tr>`;
  });
  $(type + "-table").innerHTML = head + `<tbody>${body}</tbody>`;

  const csv = isLoan
    ? [["Bank", "Product", "Rate type", "Rate from", "Rate to", "Offer rate", "Base rate", "Premium from", "Premium to", "Processing fee", "Max tenure"]]
    : [["Bank", "Product", "Rate from", "Rate to", "Minimum balance", "Tenure"]];
  for (const r of rows) for (const p of r.products) {
    const b = m.base[r.code];
    csv.push(isLoan
      ? [m.nameOf[r.code], p.name, p.fixed ? "Fixed" : "Variable", p.rate.lo.toFixed(2), p.rate.hi.toFixed(2), p.rate.offer ? "Yes" : "",
        b?.toFixed(2) ?? "", b !== undefined ? (p.rate.lo - b).toFixed(2) : "", b !== undefined ? (p.rate.hi - b).toFixed(2) : "", p.processing_fee || "", p.max_tenure || ""]
      : [m.nameOf[r.code], p.name, p.rate.lo.toFixed(2), p.rate.hi.toFixed(2), p.minimum_balance || "", p.max_tenure || ""]);
  }
  state.csv[type] = csv;
}

function productTable(r, isLoan) {
  const base = state.model.base[r.code];
  const rows = r.products.map((p) => {
    const rate = p.rate.lo === p.rate.hi ? pct(p.rate.lo) : `${pct(p.rate.lo)} – ${pct(p.rate.hi)}`;
    const tags = (p.fixed ? '<span class="tag fixed">Fixed</span>' : "") + (p.rate.offer ? '<span class="tag">Offer</span>' : "");
    if (isLoan) {
      const prem = base === undefined ? "—"
        : p.rate.lo === p.rate.hi ? `${(p.rate.lo - base).toFixed(2)}` : `${(p.rate.lo - base).toFixed(2)} – ${(p.rate.hi - base).toFixed(2)}`;
      return `<tr><td>${esc(p.name)}${tags}</td><td>${rate}</td><td class="num">${prem}</td><td>${esc(p.processing_fee || "—")}</td><td>${esc(p.max_tenure || "—")}</td></tr>`;
    }
    return `<tr><td>${esc(p.name)}</td><td>${rate}</td><td>${esc(p.minimum_balance || "0")}</td><td>${esc(p.max_tenure || "—")}</td></tr>`;
  }).join("");
  return isLoan
    ? `<table><thead><tr><th>Product</th><th>Rate</th><th class="num">Premium over base (pp)</th><th>Processing fee</th><th>Max tenure</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<table><thead><tr><th>Product</th><th>Rate</th><th>Minimum balance</th><th>Tenure</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ---------- CSV ----------

function downloadCsv(name) {
  const rows = state.csv?.[name];
  if (!rows) return;
  const text = rows.map((r) => r.map((v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\n");
  const label = name === "loan" ? state.loanKey : name === "deposit" ? state.depositKey : name;
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
}

document.querySelector(".tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) showTab(b.dataset.tab);
});
$("refresh").addEventListener("click", load);
$("loan-select").addEventListener("change", (e) => { state.loanKey = e.target.value; renderCategory("loan"); });
$("deposit-select").addEventListener("change", (e) => { state.depositKey = e.target.value; renderCategory("deposit"); });

document.addEventListener("click", (e) => {
  const csvBtn = e.target.closest("[data-csv]");
  if (csvBtn) return downloadCsv(csvBtn.dataset.csv);

  const sortTh = e.target.closest("th[data-sort]");
  if (sortTh) {
    const type = sortTh.dataset.type, k = sortTh.dataset.sort;
    const s = state.sort[type];
    if (s.key === k) s.dir *= -1;
    else { s.key = k; s.dir = k === "all" ? -1 : 1; }
    return renderCategory(type);
  }

  const row = e.target.closest("tr.bank-row");
  if (row) {
    const detail = $(row.dataset.detail);
    detail.hidden = !detail.hidden;
    row.classList.toggle("open", !detail.hidden);
  }
});

const initial = location.hash.slice(1);
if (["summary", "base", "loan", "deposit"].includes(initial)) showTab(initial);
load();
setInterval(() => { if (!document.hidden) load(); }, AUTO_REFRESH_MS);
