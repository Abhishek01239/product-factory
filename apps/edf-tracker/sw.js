/* Offline cache for EDF Tracker (static assets only; no user data passes through here). */
var CACHE = "edf-tracker-v1";
var ASSETS = ["./", "index.html", "privacy.html", "styles.css", "edf.js", "app.js", "favicon.svg", "icon-192.png", "manifest.webmanifest"];
self.addEventListener("install", function (e) { e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener("activate", function (e) { e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); })); });
self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== self.location.origin) return;
  // Network first so updates to rules ship quickly; fall back to cache offline.
  e.respondWith(fetch(e.request).then(function (r) { var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); return r; }).catch(function () { return caches.match(e.request).then(function (m) { return m || caches.match("index.html"); }); }));
});
