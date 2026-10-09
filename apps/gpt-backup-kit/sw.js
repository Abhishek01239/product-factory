/* Offline cache for GPT Backup Kit (static assets only; your GPT data never passes through here). */
var CACHE = "gpt-backup-kit-v1.0.0";
var ASSETS = ["./", "index.html", "privacy.html", "styles.css", "kit.js", "app.js", "vendor/js-yaml.min.js", "favicon.svg", "icon-192.png", "manifest.webmanifest"];
self.addEventListener("install", function (e) { e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener("activate", function (e) { e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k.indexOf("gpt-backup-kit-") === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); })); });
self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(fetch(e.request).then(function (r) { var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); return r; }).catch(function () { return caches.match(e.request).then(function (m) { return m || caches.match("index.html"); }); }));
});
