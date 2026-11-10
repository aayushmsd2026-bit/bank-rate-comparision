// Service worker: lets browsers install Bank Tulana as an app and opens it offline.
// Network first, so visitors always get the latest files and rates; the cached copy is
// only used when the network is unavailable. Other sites (BankByaj's feed) pass straight through.
const CACHE = "bank-tulana-v1";
const SHELL = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest", "assets/icon-192.png", "data/snapshot.json", "data/nrb/financials.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === "navigate" ? caches.match("index.html") : Response.error())))
  );
});
