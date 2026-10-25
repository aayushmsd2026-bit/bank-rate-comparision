// Pulls every endpoint the site uses from the BankByaj API and saves it as
// data/snapshot.json. The page reads the API live; this file is the fallback
// when the API is unreachable. Run by .github/workflows/sync.yml every hour.
import { writeFile, mkdir } from "node:fs/promises";

const API = "https://admin.bankbyaj.com/api/v1/";

async function get(path) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(API + path, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.success === false) throw new Error(json.message || "API error");
      return json;
    } catch (err) {
      if (attempt >= 3) throw new Error(`${path}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

const [loanCats, depositCats, baseRates] = await Promise.all([
  get("categories/loan"),
  get("categories/deposit"),
  get("baserates"),
]);

// Each category response repeats the full institute list; keep it once.
const categories = {};
let institutes = [];
for (const c of [...loanCats.categories, ...depositCats.categories]) {
  const d = await get("category/" + encodeURIComponent(c.url_key));
  if (d.institutes?.length) institutes = d.institutes;
  categories[c.url_key] = { last_modified_date: d.last_modified_date, products: d.products };
}

const snapshot = {
  fetched_at: new Date().toISOString(),
  loanCategories: loanCats.categories,
  depositCategories: depositCats.categories,
  baseRates: baseRates.base_rates,
  institutes: institutes.map(({ name, code, type, class: cls, current_base_rate }) =>
    ({ name, code, type, class: cls, current_base_rate })),
  categories,
};

await mkdir("data", { recursive: true });
await writeFile("data/snapshot.json", JSON.stringify(snapshot));
console.log(`Saved ${Object.keys(categories).length} categories, ${snapshot.baseRates.length} base rates`);
