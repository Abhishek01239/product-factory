/* Python 3.15 Readiness Check — UI. All analysis happens in this browser tab. */
(function () {
  "use strict";
  var P = window.P315;
  var $ = function (id) { return document.getElementById(id); };
  var MAX_LOOKUPS = 300, MAX_FILE = 8 * 1024 * 1024;
  var state = { files: [], report: null, title: "" };

  // ---------- platforms
  var platSet = $("plat-set");
  P.PLATFORMS.forEach(function (p) {
    var l = document.createElement("label");
    var i = document.createElement("input");
    i.type = "checkbox"; i.value = p.id; i.checked = P.DEFAULT_PLATFORMS.indexOf(p.id) >= 0;
    l.appendChild(i); l.appendChild(document.createTextNode(" " + p.label));
    platSet.appendChild(l);
  });
  function platforms() {
    var v = [].slice.call(platSet.querySelectorAll("input:checked")).map(function (i) { return i.value; });
    return v.length ? v : P.DEFAULT_PLATFORMS.slice();
  }
  function freeThreaded() { var r = document.querySelector("input[name=build]:checked"); return !!r && r.value === "ft"; }
  $("asof").textContent = P.DATA_AS_OF;

  // ---------- tabs
  var tabs = [].slice.call(document.querySelectorAll("[role=tab]"));
  function selectTab(t, focus) {
    tabs.forEach(function (x) {
      var on = x === t;
      x.setAttribute("aria-selected", on ? "true" : "false");
      x.tabIndex = on ? 0 : -1;
      $(x.getAttribute("aria-controls")).hidden = !on;
    });
    if (focus) t.focus();
  }
  tabs.forEach(function (t, i) {
    t.addEventListener("click", function () { selectTab(t); });
    t.addEventListener("keydown", function (e) {
      var k = e.key, n = null;
      if (k === "ArrowRight") n = tabs[(i + 1) % tabs.length];
      else if (k === "ArrowLeft") n = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (k === "Home") n = tabs[0];
      else if (k === "End") n = tabs[tabs.length - 1];
      if (n) { e.preventDefault(); selectTab(n, true); }
    });
  });

  // ---------- status
  function status(msg, kind) { var s = $("status"); s.textContent = msg || ""; s.className = "status" + (kind ? " " + kind : ""); }

  // ---------- files
  var drop = $("drop"), fileInput = $("file-input");
  function listFiles() {
    var ul = $("files-list"); ul.textContent = "";
    state.files.forEach(function (f) { var li = document.createElement("li"); li.textContent = f.path; ul.appendChild(li); });
  }
  function readFiles(list) {
    var arr = [].slice.call(list || []);
    var skipped = [];
    return Promise.all(arr.map(function (f) {
      if (f.size > MAX_FILE) { skipped.push(f.name); return null; }
      return f.text().then(function (t) { return { path: f.webkitRelativePath || f.name, text: t }; });
    })).then(function (got) {
      got.filter(Boolean).forEach(function (g) {
        var i = state.files.findIndex(function (x) { return x.path === g.path; });
        if (i >= 0) state.files[i] = g; else state.files.push(g);
      });
      listFiles();
      if (skipped.length) status("Skipped files over 8 MB: " + skipped.join(", "), "bad");
    });
  }
  fileInput.addEventListener("change", function () { readFiles(fileInput.files); });
  ["dragenter", "dragover"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("over"); }); });
  ["dragleave", "drop"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("over"); }); });
  drop.addEventListener("drop", function (e) { if (e.dataTransfer && e.dataTransfer.files) readFiles(e.dataTransfer.files); });

  function sampleFiles() {
    return [
      { path: "requirements.txt", text: P.SAMPLE.requirements },
      { path: ".github/workflows/tests.yml", text: P.SAMPLE.workflow },
      { path: "Dockerfile", text: P.SAMPLE.dockerfile },
      { path: "app/db.py", text: P.SAMPLE.code }
    ];
  }
  $("sample-files").addEventListener("click", function () { state.files = sampleFiles(); listFiles(); status("Sample loaded. Press Check files."); });
  $("sample-paste").addEventListener("click", fillPasteSample);
  $("hero-sample").addEventListener("click", function () {
    selectTab($("tab-paste")); fillPasteSample();
    $("check").scrollIntoView({ behavior: "smooth" });
    run(pasteFiles(), "sample project");
  });
  function fillPasteSample() {
    $("deps-input").value = P.SAMPLE.requirements;
    $("code-input").value = P.SAMPLE.code;
    $("ci-input").value = P.SAMPLE.workflow + "\n";
    $("pyproject-input").value = "[project]\nname = \"sample\"\nrequires-python = \">=3.10,<3.15\"\nclassifiers = [\n  \"Programming Language :: Python :: 3.13\",\n  \"Programming Language :: Python :: 3.14\",\n]\n";
  }
  function pasteFiles() {
    var out = [], d = $("deps-input").value, c = $("code-input").value, ci = $("ci-input").value, pp = $("pyproject-input").value;
    if (d.trim()) { var k = P.sniff(d); out.push({ path: k === "uv" ? "uv.lock" : k === "poetry" ? "poetry.lock" : k === "pipfile" ? "Pipfile.lock" : k === "pylock" ? "pylock.toml" : k === "pyproject" ? "pyproject.toml" : "requirements.txt", text: d, kind: k === "py" || k === "ci" ? "requirements" : (k || "requirements") }); }
    if (c.trim()) out.push({ path: "pasted.py", text: c, kind: "py" });
    if (ci.trim()) { var isDocker = /^\s*FROM\s+/mi.test(ci); out.push({ path: isDocker ? "Dockerfile" : ".github/workflows/pasted.yml", text: ci, kind: "ci" }); }
    if (pp.trim()) out.push({ path: "pyproject.toml", text: pp, kind: "pyproject" });
    return out;
  }
  $("run-files").addEventListener("click", function () {
    if (!state.files.length) { status("Choose or drop at least one file first.", "bad"); return; }
    run(state.files, state.files.length === 1 ? state.files[0].path : state.files.length + " files");
  });
  $("run-paste").addEventListener("click", function () {
    var f = pasteFiles();
    if (!f.length) { status("Paste a requirements file, lockfile, code or a workflow first.", "bad"); return; }
    run(f, "pasted input");
  });
  $("repo-input").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); $("run-repo").click(); } });
  $("run-repo").addEventListener("click", function () {
    var r = P.parseRepo($("repo-input").value);
    if (!r) { status("Enter a public repository as owner/repo or https://github.com/owner/repo.", "bad"); return; }
    scanRepo(r);
  });

  // ---------- network
  function getJSON(url, headers) {
    return fetch(url, { headers: headers || {}, credentials: "omit", referrerPolicy: "no-referrer" }).then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) { var e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
      return r.json();
    });
  }
  function pool(items, n, fn, onProgress) {
    var i = 0, done = 0;
    return new Promise(function (resolve) {
      if (!items.length) return resolve();
      var active = 0;
      function next() {
        if (i >= items.length && active === 0) return resolve();
        while (active < n && i < items.length) {
          var it = items[i++]; active++;
          Promise.resolve(fn(it)).catch(function () {}).then(function () { active--; done++; if (onProgress) onProgress(done, items.length); next(); });
        }
      }
      next();
    });
  }
  function pypiPinned(list, cache) {
    return pool(list, 8, function (p) {
      var key = p.name + "@" + p.version;
      if (key in cache) return;
      return getJSON("https://pypi.org/pypi/" + encodeURIComponent(p.name) + "/" + encodeURIComponent(p.version) + "/json")
        .then(function (j) { cache[key] = P.fromPypiJSON(j); }, function () { cache[key] = null; });
    }, function (d, t) { status("Reading wheel lists from PyPI… " + d + "/" + t); });
  }
  function pypiSimple(names, cache) {
    return pool(names, 4, function (n) {
      if (n in cache) return;
      return getJSON("https://pypi.org/simple/" + encodeURIComponent(n) + "/", { Accept: "application/vnd.pypi.simple.v1+json" })
        .then(function (j) { cache[n] = P.fromSimpleJSON(j); }, function () { cache[n] = null; });
    }, function (d, t) { status("Finding the smallest upgrade with 3.15 wheels… " + d + "/" + t); });
  }

  var busy = false;
  function setBusy(b) { busy = b; ["run-files", "run-paste", "run-repo", "hero-sample"].forEach(function (id) { $(id).disabled = b; }); }

  function run(files, title) {
    if (busy) return;
    setBusy(true);
    state.title = title;
    var plats = platforms(), ft = freeThreaded(), pypi = {}, simple = {};
    var usePypi = $("use-pypi").checked;
    var collected;
    try { collected = P.collect({ files: files }); } catch (e) { setBusy(false); status("Couldn't read the input: " + e.message, "bad"); return; }
    var need = P.lookupsNeeded(collected);
    var capped = false;
    var chain = Promise.resolve();
    if (usePypi) {
      var pinned = need.pinned.slice(0, MAX_LOOKUPS);
      capped = need.pinned.length > MAX_LOOKUPS;
      chain = chain.then(function () { return pypiPinned(pinned, pypi); }).then(function () {
        var first = P.analyze({ files: files, platforms: plats, freeThreaded: ft, pypi: pypi, simple: {} });
        var flagged = first.pkgs.filter(function (p) { return ["build", "no-install", "blocked", "sdist-only"].indexOf(p.status) >= 0; }).map(function (p) { return p.norm; });
        var names = flagged.concat(need.names).filter(function (n, i, a) { return a.indexOf(n) === i; }).slice(0, 80);
        return pypiSimple(names, simple);
      });
    }
    chain.then(function () {
      var report = P.analyze({ files: files, platforms: plats, freeThreaded: ft, pypi: pypi, simple: simple });
      if (!usePypi && need.pinned.length) report.notes.push(need.pinned.length + " pinned packages weren't checked because PyPI lookup is off.");
      if (capped) report.notes.push("Only the first " + MAX_LOOKUPS + " pinned packages were looked up.");
      state.report = report;
      render(report);
      var c = report.counts, errs = report.findings.filter(function (f) { return f.level === "error"; }).length;
      status(errs ? errs + " thing" + (errs > 1 ? "s" : "") + " to fix before 3.15." : report.findings.length ? "Nothing blocking found; review the notes below." : "No 3.15 problems found in what you provided.", errs ? "bad" : "ok");
    }).catch(function (e) {
      status("Something went wrong: " + e.message, "bad");
    }).then(function () { setBusy(false); });
  }

  function scanRepo(r) {
    if (busy) return;
    setBusy(true);
    status("Reading " + r.owner + "/" + r.repo + " from GitHub…");
    var base = "https://api.github.com/repos/" + encodeURIComponent(r.owner) + "/" + encodeURIComponent(r.repo);
    var refP = r.ref ? Promise.resolve(r.ref) : getJSON(base).then(function (j) { if (!j) throw new Error("Repository not found or not public."); return j.default_branch; });
    refP.then(function (ref) {
      return getJSON(base + "/git/trees/" + encodeURIComponent(ref) + "?recursive=1").then(function (t) {
        if (!t || !t.tree) throw new Error("Couldn't list files on branch " + ref + ".");
        var paths = t.tree.filter(function (x) { return x.type === "blob" && (x.size || 0) <= MAX_FILE; }).map(function (x) { return x.path; });
        var pick = P.pickRepoFiles(paths);
        var all = pick.deps.concat(pick.ci, pick.pth, pick.py);
        if (!all.length) throw new Error("No Python dependency files, workflows or .py files found.");
        var files = [];
        return pool(all, 8, function (p) {
          var url = "https://raw.githubusercontent.com/" + encodeURIComponent(r.owner) + "/" + encodeURIComponent(r.repo) + "/" + encodeURIComponent(ref) + "/" + p.split("/").map(encodeURIComponent).join("/");
          return fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" }).then(function (res) { return res.ok ? res.text() : null; }).then(function (txt) { if (txt != null) files.push({ path: p, text: txt }); });
        }, function (d, n) { status("Reading files… " + d + "/" + n); }).then(function () {
          files.sort(function (a, b) { return all.indexOf(a.path) - all.indexOf(b.path); });
          var note = [];
          if (t.truncated) note.push("GitHub truncated the file list for this large repo; some files may be missing.");
          if (pick.pyTotal > pick.py.length) note.push("Scanned " + pick.py.length + " of " + pick.pyTotal + " .py files (source before tests).");
          setBusy(false);
          state.repoNotes = note;
          run(files, r.owner + "/" + r.repo + "@" + ref);
        });
      });
    }).catch(function (e) {
      setBusy(false);
      var msg = e.status === 403 ? "GitHub's unauthenticated API limit (60 requests an hour) was reached. Try again later, or download the files and use the Files tab." : e.message;
      status(msg, "bad");
    });
  }

  // ---------- render
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  var STATUS_LABEL = { ok: "Installs from wheel", na: "Not used on these platforms", build: "Compiles from source", "sdist-only": "Source only (likely pure Python)", "no-install": "Can't install", blocked: "Excludes 3.15", "lookup-failed": "Not found on PyPI", "not-checked": "Not checked", "no-candidate": "No matching release" };
  var PLAT_LABEL = { wheel: "wheel", build: "builds", none: "none", na: "n/a" };
  var LEVEL = { error: "Fix first", warn: "Review", info: "Note" };

  function render(rep) {
    $("results").hidden = false;
    var c = rep.counts, sum = $("summary"); sum.textContent = "";
    var errs = rep.findings.filter(function (f) { return f.level === "error"; }).length;
    var warns = rep.findings.filter(function (f) { return f.level === "warn"; }).length;
    var infos = rep.findings.filter(function (f) { return f.level === "info"; }).length;
    sum.appendChild(el("span", "pill error", errs + " to fix"));
    sum.appendChild(el("span", "pill warn", warns + " to review"));
    sum.appendChild(el("span", "pill info", infos + " notes"));
    if (c.total) sum.appendChild(el("span", "pill ok", c.ok + " of " + c.total + " deps install from wheels"));

    var ol = $("findings"); ol.textContent = "";
    if (!rep.findings.length) {
      var li0 = el("li", "allclear", rep.hasDeps ? "Every checked dependency installs from a wheel on the selected platforms, and no removed APIs or floating versions were found." : "No problems found. Add a requirements file or lockfile to check dependencies too.");
      ol.appendChild(li0);
    }
    rep.findings.forEach(function (f) {
      var li = el("li", "finding " + f.level);
      var h = el("h4"); h.appendChild(el("span", "tag " + f.level, LEVEL[f.level])); h.appendChild(document.createTextNode(f.title)); li.appendChild(h);
      if (f.path) li.appendChild(el("p", "loc", f.path + (f.line ? ":" + f.line : "")));
      if (f.code) { var pre = el("pre", null, f.code); pre.tabIndex = 0; li.appendChild(pre); }
      if (f.why) li.appendChild(el("p", null, f.why));
      if (f.fix) { var p = el("p", "fix"); p.appendChild(el("strong", null, "Fix: ")); p.appendChild(document.createTextNode(f.fix)); li.appendChild(p); }
      if (f.src) { var s = el("p", "small"); var a = el("a", null, "Source"); a.href = f.src; a.target = "_blank"; a.rel = "noopener"; s.appendChild(a); li.appendChild(s); }
      ol.appendChild(li);
    });

    renderPkgs(rep);
    var u = P.upgradeLines(rep), lines = [];
    if (u.requirements.length) { lines.push("# requirements.txt"); lines = lines.concat(u.requirements); }
    if (u.uv.length) { lines.push("# uv"); lines = lines.concat(u.uv); }
    if (u.poetry.length) { lines.push("# Poetry"); lines = lines.concat(u.poetry); }
    if (u.pipenv.length) { lines.push("# Pipenv"); lines = lines.concat(u.pipenv); }
    $("out-wrap").hidden = !lines.length;
    $("out-up").textContent = lines.join("\n");
    var notes = rep.notes.concat(state.repoNotes || []);
    state.repoNotes = null;
    $("notes").textContent = notes.join(" ");
    $("results-h").textContent = "Results for " + state.title;
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function renderPkgs(rep) {
    var wrap = $("pkgs-wrap"), tb = $("pkgs");
    wrap.hidden = !rep.pkgs.length;
    tb.textContent = "";
    var only = $("only-problems").checked, shown = 0;
    rep.pkgs.forEach(function (p) {
      if (only && (p.status === "ok" || p.status === "na")) return;
      shown++;
      var tr = el("tr");
      var th = el("th"); th.scope = "row";
      th.appendChild(el("strong", null, p.name)); th.appendChild(document.createTextNode(" " + (p.version || p.spec || "")));
      var meta = (p.paths || []).join(", ") + (p.resolvedFromSpec ? " · resolved from " + (p.spec || "unpinned") : "") + (p.requiresPython ? " · requires-python " + p.requiresPython : "") + (p.pinnedBy ? " · pinned by " + p.pinnedBy : "");
      th.appendChild(el("div", "meta", meta));
      tr.appendChild(th);
      var tds = el("td"); tds.setAttribute("data-label", "On 3.15"); tr.appendChild(tds).appendChild(el("span", "st " + p.status, STATUS_LABEL[p.status] || p.status));
      var tdp = el("td"); tdp.setAttribute("data-label", "Platforms");
      if (p.per) rep.platforms.forEach(function (pid) { var s = p.per[pid].status; var sp = el("span", "plat " + s, P.platLabel(pid).replace(/ \(glibc\)/, "") + ": " + PLAT_LABEL[s]); tdp.appendChild(sp); });
      else tdp.textContent = "–";
      tr.appendChild(tdp);
      var tdf = el("td"); tdf.setAttribute("data-label", "Fix");
      if (p.status === "ok" || p.status === "na") tdf.textContent = "Nothing to do";
      else if (p.upgrade) { tdf.appendChild(el("strong", null, (p.pinnedBy ? "Upgrade " + p.pinnedBy.split(" ")[0] + " (needs " + p.name + " ≥ " + p.upgrade.version + ")" : "≥ " + p.upgrade.version))); tdf.appendChild(el("div", "meta", p.upgrade.jump + (p.upgrade.requiresPython ? " · requires-python " + p.upgrade.requiresPython : ""))); }
      else if (p.latest) tdf.textContent = "No release has 3.15 wheels for these platforms yet (latest " + p.latest.version + ")";
      else if (p.status === "sdist-only") tdf.textContent = "Usually fine: pure-Python source builds need no compiler";
      else tdf.textContent = "–";
      tr.appendChild(tdf);
      tb.appendChild(tr);
    });
    $("pkg-count").textContent = "Showing " + shown + " of " + rep.pkgs.length;
  }
  $("only-problems").addEventListener("change", function () { if (state.report) renderPkgs(state.report); });

  // ---------- copy
  function copy(text, btn) {
    var done = function () { var o = btn.textContent; btn.textContent = "Copied"; setTimeout(function () { btn.textContent = o; }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    else fallback();
    function fallback() { var t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand("copy"); done(); } catch (e) {} document.body.removeChild(t); }
  }
  $("copy-md").addEventListener("click", function (e) { if (state.report) copy(P.markdown(state.report, state.title), e.currentTarget); });
  document.addEventListener("click", function (e) { var b = e.target.closest && e.target.closest("[data-copy]"); if (b) copy($(b.getAttribute("data-copy")).textContent, b); });

  // ---------- deep link: ?repo=owner/name
  var q = new URLSearchParams(location.search).get("repo");
  if (q && P.parseRepo(q)) { $("repo-input").value = q; selectTab($("tab-repo")); scanRepo(P.parseRepo(q)); }

  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(function () {});
})();
