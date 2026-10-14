/* Supabase Grants Check: UI. All analysis is local (rules.js). */
(function () {
  "use strict";
  var SG = window.SG;
  var $ = function (id) { return document.getElementById(id); };
  var state = { input: null, report: null, title: "", repo: null };

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function setStatus(msg, kind) { var el = $("status"); el.textContent = msg || ""; el.className = "status" + (kind ? " " + kind : ""); }

  $("snap-sql").textContent = SG.SNAPSHOT_SQL;
  $("tpl").textContent = SG.TEMPLATE;
  $("asof").textContent = SG.DATA_AS_OF;

  // ---- tabs
  var tabs = Array.prototype.slice.call(document.querySelectorAll("[role=tab]"));
  function selectTab(t, focus) {
    tabs.forEach(function (x) {
      var on = x === t; x.setAttribute("aria-selected", on); x.tabIndex = on ? 0 : -1;
      $(x.getAttribute("aria-controls")).hidden = !on;
    });
    if (focus) t.focus();
  }
  tabs.forEach(function (t, i) {
    t.addEventListener("click", function () { selectTab(t); });
    t.addEventListener("keydown", function (e) {
      var j = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
      if (j >= 0) { e.preventDefault(); selectTab(tabs[j], true); }
    });
  });

  // ---- run
  function run(input, title) {
    state.input = input; state.title = title;
    input.snapshotText = $("snap").value;
    var report;
    try { report = SG.analyze(input); }
    catch (e) { setStatus(e.message, "bad"); if (!/snapshot/i.test(e.message)) return; input.snapshotText = ""; report = SG.analyze(input); }
    state.report = report;
    render();
    var s = SG.summarize(report.findings);
    if (!$("status").classList.contains("bad")) setStatus(report.objects.length ? ("Checked " + report.objects.length + " table" + (report.objects.length === 1 ? "" : "s") + " and view" + "s: " + s.error + " breaking, " + s.warn + " to review.") : "No tables found in the exposed schemas.", report.objects.length ? "ok" : "bad");
    var res = $("results"); res.hidden = false; res.focus({ preventScroll: true }); res.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }

  function migration() {
    return SG.buildMigration(state.report, { includeServiceRole: $("opt-sr").checked, tighten: $("opt-tighten").checked, title: state.title });
  }

  function render() {
    var r = state.report, s = SG.summarize(r.findings);
    $("res-meta").textContent = state.title + " · " + r.migrationCount + " migration file" + (r.migrationCount === 1 ? "" : "s") + ", " + r.statementCount + " statements, " + r.codeFiles + " code file" + (r.codeFiles === 1 ? "" : "s") + ", " + r.calls.length + " supabase-js call" + (r.calls.length === 1 ? "" : "s") + (r.snapshot ? ", live snapshot" : "") + " · exposed schemas: " + r.exposed.join(", ");
    var pills = [];
    if (s.error) pills.push('<span class="pill error">' + s.error + " breaking</span>");
    if (s.warn) pills.push('<span class="pill warn">' + s.warn + " to review</span>");
    if (s.info) pills.push('<span class="pill info">' + s.info + " note" + (s.info > 1 ? "s" : "") + "</span>");
    if (!s.error && !s.warn) pills.push('<span class="pill ok">Nothing breaking found</span>');
    $("summary").innerHTML = pills.join("");
    var LBL = { error: "Breaks", warn: "Review", info: "Note" };
    $("findings").innerHTML = r.findings.map(function (f) {
      var objs = f.objects || [];
      var list = objs.length ? '<ul class="objs">' + objs.slice(0, 40).map(function (o) { return "<li>" + esc(o) + "</li>"; }).join("") + (objs.length > 40 ? "<li>… and " + (objs.length - 40) + " more</li>" : "") + "</ul>" : "";
      return '<li class="finding ' + f.level + '"><h4><span class="tag ' + f.level + '">' + LBL[f.level] + "</span>" + esc(f.title) + "</h4>" + list +
        (f.code ? "<pre>" + esc(f.code) + "</pre>" : "") + (f.why ? "<p>" + esc(f.why) + "</p>" : "") +
        (f.fix ? '<p class="fix"><strong>Fix:</strong> ' + esc(f.fix) + "</p>" : "") +
        (f.src ? '<p class="small"><a href="' + esc(f.src) + '" rel="noopener" target="_blank">Documentation</a></p>' : "") + "</li>";
    }).join("") || '<li class="allclear">No findings.</li>';
    $("objs").innerHTML = r.objects.map(function (o) {
      var rls = o.kind !== "table" ? (o.kind === "matview" ? "mat. view" : "view" + (o.securityInvoker ? " (invoker)" : "")) : o.rls ? "on" : "<strong>off</strong>";
      var use = (o.usage.client.length ? "client: " + o.usage.client.join(", ") : "") + (o.usage.server.length ? (o.usage.client.length ? "; " : "") + "server: " + o.usage.server.join(", ") : "");
      var where = o.created ? '<div class="meta">' + esc(o.created.path.split("/").pop()) + ":" + o.created.line + "</div>" : o.live ? '<div class="meta">live snapshot</div>' : "";
      return '<tr><th scope="row"><code>' + esc(o.schema + "." + o.name) + "</code>" + where + "</th><td>" + rls + '</td><td><span class="st ' + o.status + '">' + esc(SG.STATUS[o.status]) + '</span></td><td class="privs">' + esc(o.rec.anon.join(", ") || "none") + '</td><td class="privs">' + esc(o.rec.authenticated.join(", ") || "none") + '</td><td class="small">' + esc(use || (r.hasCode ? "not found" : "no code checked")) + "</td></tr>";
    }).join("") || '<tr><td colspan="6">No tables in ' + esc(r.exposed.join(", ")) + ".</td></tr>";
    var m = migration();
    $("mig-name").textContent = m.filename; $("mig").textContent = m.sql;
  }
  ["opt-sr", "opt-tighten"].forEach(function (id) { $(id).addEventListener("change", function () { if (state.report) render(); }); });
  var snapTimer;
  $("snap").addEventListener("input", function () {
    clearTimeout(snapTimer);
    snapTimer = setTimeout(function () {
      setStatus("");
      if (state.input) run(state.input, state.title);
      else if ($("snap").value.trim()) run({ migrations: [], code: [] }, "live snapshot");
    }, 400);
  });

  // ---- paste & sample
  $("run-paste").addEventListener("click", function () {
    var sql = $("sql").value, code = $("code").value;
    if (!sql.trim() && !$("snap").value.trim()) { setStatus("Paste some migration SQL first (or a snapshot in step 2).", "bad"); $("sql").focus(); return; }
    run({ migrations: sql.trim() ? [{ path: "pasted.sql", text: sql }] : [], code: code.trim() ? [{ path: "pasted.ts", text: code }] : [] }, "pasted SQL");
  });
  function loadSample() {
    selectTab($("tab-paste"));
    $("sql").value = SG.SAMPLE.migrations.map(function (m) { return "-- " + m.path + "\n" + m.text; }).join("\n\n");
    $("code").value = SG.SAMPLE.code.map(function (c) { return "// " + c.path + "\n" + c.text; }).join("\n\n");
    run({ migrations: SG.SAMPLE.migrations.slice(), code: SG.SAMPLE.code.slice() }, SG.SAMPLE.title);
  }
  $("sample").addEventListener("click", loadSample);
  $("hero-sample").addEventListener("click", loadSample);

  // ---- files
  function readFiles(list, title) {
    var picked = list.filter(function (f) { var p = f.path; return SG.fileKind(p) && f.file.size < 400000; });
    if (!picked.length) { setStatus("No .sql, config.toml or JS/TS source files found in that selection.", "bad"); return; }
    setStatus("Reading " + picked.length + " files…");
    Promise.all(picked.map(function (f) { return f.file.text().then(function (t) { return { path: f.path, text: t }; }); })).then(function (files) {
      var migrations = files.filter(function (f) { return SG.fileKind(f.path) === "sql" && !/(^|\/)seed[^/]*\.sql$/i.test(f.path); });
      var code = files.filter(function (f) { return SG.fileKind(f.path) === "code"; }).slice(0, 1500);
      var cfg = files.filter(function (f) { return SG.fileKind(f.path) === "config"; })[0];
      $("files-list").innerHTML = "<li>" + migrations.length + " SQL</li><li>" + code.length + " code</li>" + (cfg ? "<li>config.toml</li>" : "");
      run({ migrations: migrations, code: code, configText: cfg ? cfg.text : "" }, title);
    }).catch(function (e) { setStatus("Couldn't read the files: " + e.message, "bad"); });
  }
  function fromInput(input) {
    var arr = Array.prototype.slice.call(input.files).map(function (f) { return { path: (f.webkitRelativePath || f.name).replace(/^[^/]+\//, function (m) { return f.webkitRelativePath ? "" : m; }), file: f }; });
    var root = input.files[0] && input.files[0].webkitRelativePath ? input.files[0].webkitRelativePath.split("/")[0] : "uploaded files";
    readFiles(arr, root);
  }
  $("folder").addEventListener("change", function () { fromInput(this); });
  $("files").addEventListener("change", function () {
    // loose .sql files without folders: treat as migrations
    var arr = Array.prototype.slice.call(this.files).map(function (f) { return { path: /\.sql$/i.test(f.name) ? "supabase/migrations/" + f.name : f.name, file: f }; });
    readFiles(arr, "uploaded files");
  });
  var drop = $("drop");
  ["dragenter", "dragover"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("over"); }); });
  ["dragleave", "drop"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("over"); }); });
  drop.addEventListener("drop", function (e) {
    var items = e.dataTransfer.items, entries = [];
    for (var i = 0; i < items.length; i++) { var en = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry(); if (en) entries.push(en); }
    if (!entries.length) return;
    var out = [], pending = 0, rootName = entries[0].name;
    function walk(entry, prefix) {
      if (SKIP(prefix + entry.name)) return;
      pending++;
      if (entry.isFile) entry.file(function (f) { out.push({ path: (prefix + entry.name).replace(/^[^/]+\//, entries.length === 1 && entries[0].isDirectory ? "" : "$&"), file: f }); done(); }, done);
      else {
        var rd = entry.createReader(), all = [];
        (function more() { rd.readEntries(function (es) { if (es.length) { all = all.concat(es); more(); } else { all.forEach(function (c) { walk(c, prefix + entry.name + "/"); }); done(); } }, done); })();
      }
    }
    function SKIP(p) { return /(^|\/)(node_modules|\.git|dist|build|\.next|\.nuxt|\.svelte-kit|coverage|\.vercel|\.output)$/.test(p); }
    function done() { if (--pending === 0) readFiles(out.map(function (o) { return /\.sql$/i.test(o.path) && !/\//.test(o.path) ? { path: "supabase/migrations/" + o.path, file: o.file } : o; }), rootName); }
    entries.forEach(function (en) { walk(en, ""); });
  });

  // ---- GitHub repo
  function gh(url) {
    return fetch(url, { headers: { Accept: "application/vnd.github+json" } }).then(function (r) {
      if (r.status === 404) throw new Error("Repository not found. Is it public and spelled right?");
      if (r.status === 403 || r.status === 429) throw new Error("GitHub's rate limit for anonymous requests was reached (60 per hour). Try again later or use Upload folder.");
      if (!r.ok) throw new Error("GitHub returned " + r.status + ".");
      return r.json();
    });
  }
  function pool(items, n, fn) {
    var i = 0, out = new Array(items.length);
    function next() { if (i >= items.length) return Promise.resolve(); var k = i++; return fn(items[k]).then(function (v) { out[k] = v; return next(); }); }
    var ps = []; for (var j = 0; j < Math.min(n, items.length); j++) ps.push(next());
    return Promise.all(ps).then(function () { return out; });
  }
  function checkRepo(value) {
    var p = SG.parseRepo(value);
    if (!p) { setStatus("Enter a GitHub repo as owner/repo or a github.com URL.", "bad"); $("repo").focus(); return; }
    var btn = $("run-repo"); btn.disabled = true;
    setStatus("Reading " + p.owner + "/" + p.repo + " from GitHub…");
    var api = "https://api.github.com/repos/" + encodeURIComponent(p.owner) + "/" + encodeURIComponent(p.repo);
    (p.ref ? Promise.resolve({ default_branch: p.ref }) : gh(api)).then(function (info) {
      var ref = p.ref || info.default_branch;
      return gh(api + "/git/trees/" + encodeURIComponent(ref) + "?recursive=1").then(function (tree) {
        var pick = SG.pickRepoFiles(tree.tree || []);
        if (!pick.sql.length) setStatus("No supabase/migrations or supabase/schemas SQL found in this repo. Checking code only; add the snapshot in step 2 for real tables.");
        var all = pick.sql.concat(pick.config, pick.code);
        var got = 0;
        return pool(all, 8, function (t) {
          return fetch("https://raw.githubusercontent.com/" + p.owner + "/" + p.repo + "/" + encodeURIComponent(ref) + "/" + t.path.split("/").map(encodeURIComponent).join("/"))
            .then(function (r) { return r.ok ? r.text() : ""; }).catch(function () { return ""; })
            .then(function (text) { got++; if (got % 20 === 0) setStatus("Reading files… " + got + "/" + all.length); return { path: t.path, text: text }; });
        }).then(function (files) {
          var sqlPaths = pick.sql.map(function (x) { return x.path; }), cfgPath = pick.config[0] && pick.config[0].path;
          state.repo = p.owner + "/" + p.repo + (p.ref ? "/tree/" + p.ref : "");
          history.replaceState(null, "", "?repo=" + encodeURIComponent(state.repo) + "#check");
          var cfg = files.filter(function (f) { return f.path === cfgPath; })[0];
          run({ migrations: files.filter(function (f) { return sqlPaths.indexOf(f.path) >= 0; }), code: files.filter(function (f) { return SG.fileKind(f.path) === "code"; }), configText: cfg ? cfg.text : "" },
            p.owner + "/" + p.repo + "@" + ref + (tree.truncated ? " (GitHub truncated the file list)" : "") + (pick.codeTotal > pick.code.length ? " (" + pick.code.length + " of " + pick.codeTotal + " source files)" : ""));
        });
      });
    }).catch(function (e) { setStatus(e.message, "bad"); }).then(function () { btn.disabled = false; });
  }
  $("run-repo").addEventListener("click", function () { checkRepo($("repo").value); });
  $("repo").addEventListener("keydown", function (e) { if (e.key === "Enter") checkRepo(this.value); });

  // ---- outputs
  function download(name, text, type) {
    var a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: type })); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  $("dl-sql").addEventListener("click", function () { var m = migration(); download(m.filename.split("/").pop(), m.sql, "application/sql"); });
  $("dl-md").addEventListener("click", function () { download("supabase-oct30-checklist.md", SG.markdown(state.report, migration(), state.title), "text/markdown"); });
  $("share").addEventListener("click", function () {
    var url = location.origin + location.pathname + (state.repo ? "?repo=" + encodeURIComponent(state.repo) : "") + "#check";
    copy(url, this, state.repo ? "Link copied" : "Copied (repo checks only)");
  });
  function copy(text, btn, done) {
    var orig = btn.textContent;
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { btn.textContent = done || "Copied"; }, function () { btn.textContent = "Select and copy"; })
      .then(function () { setTimeout(function () { btn.textContent = orig; }, 1600); });
  }
  Array.prototype.forEach.call(document.querySelectorAll("[data-copy]"), function (b) { b.addEventListener("click", function () { copy($(b.getAttribute("data-copy")).textContent, b); }); });

  // ---- deep link
  var q = new URLSearchParams(location.search).get("repo");
  if (q) { $("repo").value = q; checkRepo(q); }

  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(function () {});
})();
