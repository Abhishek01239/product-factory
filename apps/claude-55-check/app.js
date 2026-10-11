(function () {
  "use strict";
  var C = window.C55;
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function opt(name) { var c = document.querySelector("input[name=" + name + "]:checked"); return c ? c.value : null; }
  function setStatus(msg, kind) { var s = $("status"); s.textContent = msg || ""; s.className = "status" + (kind ? " " + kind : ""); }

  var last = null; // { md, fixedJson }

  // ---- countdown
  (function () {
    var d = Math.ceil((Date.UTC(2026, 10, 30) - Date.now()) / 86400000);
    if (d > 1) $("countdown").textContent = "Sonnet 4.5 retires Nov 30, 2026 · " + d + " days left";
    else if (d <= 0) $("countdown").textContent = "Sonnet 4.5 retired on Nov 30, 2026";
    $("asof").textContent = C.DATA_AS_OF;
  })();

  // ---- tabs
  var tabs = ["json", "code", "repo"];
  function selectTab(name, focus) {
    tabs.forEach(function (t) {
      var on = t === name;
      $("tab-" + t).setAttribute("aria-selected", on ? "true" : "false");
      $("tab-" + t).tabIndex = on ? 0 : -1;
      $("panel-" + t).hidden = !on;
    });
    if (focus) $("tab-" + name).focus();
  }
  tabs.forEach(function (t, i) {
    $("tab-" + t).addEventListener("click", function () { selectTab(t); });
    $("tab-" + t).addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        selectTab(tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length], true);
      }
    });
  });

  // ---- lenient JSON (accepts Python dict literals with True/False/None and trailing commas)
  function parseBody(text) {
    var t = String(text || "").trim();
    if (!t) throw new Error("Paste a request body first.");
    if (t.length > 1000000) throw new Error("That is over 1 MB. Paste a single request body.");
    try { return JSON.parse(t); } catch (e1) {
      var py = t.replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false").replace(/\bNone\b/g, "null").replace(/,\s*([}\]])/g, "$1");
      if (/'/.test(py) && !/"/.test(py)) py = py.replace(/'/g, "\"");
      try { return JSON.parse(py); } catch (e2) {
        throw new Error("That isn't valid JSON (" + e1.message + "). Paste the request body as JSON, or use the Code tab for source code.");
      }
    }
  }

  // ---- rendering
  function render(title, findings, extra) {
    var s = C.summarize(findings);
    $("results").hidden = false;
    $("results-h").textContent = title;
    var sum = $("summary"); sum.textContent = "";
    if (!s.error && !s.warn) sum.appendChild(el("span", "pill ok", "Nothing here returns 400"));
    sum.appendChild(el("span", "pill error", s.error + " will return 400"));
    sum.appendChild(el("span", "pill warn", s.warn + " to review"));
    sum.appendChild(el("span", "pill info", s.info + " notes"));
    var list = $("findings"); list.textContent = "";
    findings.forEach(function (f) {
      var li = el("li", "finding " + f.level);
      var h = el("h4");
      h.appendChild(el("span", "tag " + f.level, f.level === "error" ? "400" : f.level === "warn" ? "review" : "note"));
      h.appendChild(document.createTextNode(f.title));
      li.appendChild(h);
      if (f.path) li.appendChild(el("p", "loc", f.path + C.locLines(f) + (f.count > 1 ? "  (" + f.count + " places)" : "")));
      if (f.code) li.appendChild(el("pre", null, f.code));
      if (f.why || f.detail) li.appendChild(el("p", null, f.why || f.detail));
      if (f.fix) { var p = el("p", "fix"); p.appendChild(el("strong", null, "Fix: ")); p.appendChild(document.createTextNode(f.fix)); li.appendChild(p); }
      if (f.src) { var a = el("a", "small", "Source"); a.href = f.src; a.target = "_blank"; a.rel = "noopener"; var pp = el("p"); pp.appendChild(a); li.appendChild(pp); }
      list.appendChild(li);
    });
    last = { md: C.markdownReport("json", title, findings, extra), fixedJson: last && last.fixedJson };
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function runJson() {
    var body;
    try { body = parseBody($("json-input").value); } catch (e) { setStatus(e.message, "bad"); $("json-input").focus(); return; }
    var r;
    try { r = C.checkRequest(body, { target: opt("target"), platform: opt("platform"), betas: $("beta-input").value }); }
    catch (e) { setStatus(e.message, "bad"); return; }
    last = { fixedJson: JSON.stringify(r.fixed, null, 2) };
    $("fixed-wrap").hidden = false;
    $("fixed").textContent = last.fixedJson;
    var ch = $("changes"); ch.textContent = "";
    (r.changes.length ? r.changes : ["No changes needed"]).forEach(function (c) { ch.appendChild(el("li", null, c)); });
    setStatus("Checked against " + r.target.name + " on " + r.platform + ".", "ok");
    render("Request → " + r.target.name + " (" + r.platform + ")", r.findings, "## Corrected request\n\n```json\n" + last.fixedJson + "\n```");
  }

  function finishScan(label, files, findings, note) {
    $("fixed-wrap").hidden = true;
    last = null;
    var T = C.TARGETS[opt("target")];
    if (!findings.length) {
      findings = [{ level: "info", id: "none", title: "No Claude API settings that break on " + T.name + " were found", why: files + " file(s) analysed. The scan is line-based; settings built dynamically may not show up.", fix: "Also paste one real request body into the Request JSON tab for an exact check." }];
    }
    findings = C.groupFindings(findings);
    setStatus(label + ": " + files + " file(s) analysed for " + T.name + "." + (note ? " " + note : ""), "ok");
    render(label + " → " + T.name, findings);
  }

  function runCode() {
    var text = $("code-input").value;
    if (!text.trim()) { setStatus("Paste some code or choose files first.", "bad"); $("code-input").focus(); return; }
    var f = C.scanText(text, "pasted code", { target: opt("target") });
    if (!C.relevant(text)) { setStatus("This code doesn't mention \"anthropic\" or \"claude\", so there is nothing to check.", "bad"); return; }
    finishScan("Pasted code", 1, f);
  }

  $("file-input").addEventListener("change", function (e) {
    var files = Array.prototype.slice.call(e.target.files || [], 0, 200);
    if (!files.length) return;
    var target = opt("target"), all = [], n = 0, big = 0;
    Promise.all(files.map(function (file) {
      if (file.size > 2000000) { big++; return Promise.resolve(); }
      return file.text().then(function (t) { if (C.relevant(t)) n++; all = all.concat(C.scanText(t, file.name, { target: target })); });
    })).then(function () {
      finishScan("Uploaded files", n, all, big ? big + " file(s) over 2 MB skipped." : (n < files.length ? (files.length - n) + " file(s) don't mention Claude and were skipped." : ""));
    }).catch(function (err) { setStatus("Couldn't read the files: " + err.message, "bad"); });
  });

  function ghError(res, what) {
    if (res.status === 404) return "Repository or branch not found. It may be private or misspelled.";
    if (res.status === 403 || res.status === 429) return "GitHub's unauthenticated rate limit was hit (60 requests/hour per IP). Try again later, or paste files instead.";
    return "GitHub returned " + res.status + " for " + what + ".";
  }
  function getJSON(url, what) {
    return fetch(url, { headers: { Accept: "application/vnd.github+json" }, credentials: "omit", referrerPolicy: "no-referrer" }).then(function (r) {
      if (!r.ok) throw new Error(ghError(r, what));
      return r.json();
    });
  }

  var busy = false;
  function runRepo() {
    if (busy) return;
    var p = C.parseRepo($("repo-input").value);
    if (!p) { setStatus("Enter a repo as owner/repo or a github.com URL.", "bad"); $("repo-input").focus(); return; }
    busy = true; $("run-repo").disabled = true;
    var target = opt("target");
    var base = "https://api.github.com/repos/" + encodeURIComponent(p.owner) + "/" + encodeURIComponent(p.repo);
    setStatus("Reading " + p.owner + "/" + p.repo + "…");
    (p.ref ? Promise.resolve({ default_branch: p.ref }) : getJSON(base, "the repository")).then(function (info) {
      var ref = p.ref || info.default_branch;
      return getJSON(base + "/git/trees/" + encodeURIComponent(ref) + "?recursive=1", "the file list").then(function (tree) { return { ref: ref, tree: tree }; });
    }).then(function (x) {
      var all0 = (x.tree.tree || []).filter(function (t) { return t.type === "blob" && C.wantFile(t.path, true) && (t.size || 0) < 400000; });
      var items = all0.filter(function (t) { return C.wantFile(t.path, false); });
      var testsSkipped = all0.length - items.length;
      var capped = items.length > 600;
      items = items.slice(0, 600);
      if (!items.length) throw new Error("No source files found in this repository.");
      var all = [], analysed = 0, done = 0, failed = 0, i = 0;
      function worker() {
        if (i >= items.length) return Promise.resolve();
        var it = items[i++];
        var url = "https://raw.githubusercontent.com/" + encodeURIComponent(p.owner) + "/" + encodeURIComponent(p.repo) + "/" + x.ref.split("/").map(encodeURIComponent).join("/") + "/" + it.path.split("/").map(encodeURIComponent).join("/");
        return fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
          .then(function (t) { if (C.relevant(t)) analysed++; all = all.concat(C.scanText(t, it.path, { target: target })); })
          .catch(function () { failed++; })
          .then(function () { done++; if (done % 20 === 0) setStatus("Reading files… " + done + "/" + items.length); return worker(); });
      }
      var pool = []; for (var k = 0; k < 8; k++) pool.push(worker());
      return Promise.all(pool).then(function () {
        var note = [];
        if (capped) note.push("Only the first 600 source files were read.");
        if (x.tree.truncated) note.push("GitHub truncated the file list for this large repo.");
        if (testsSkipped) note.push(testsSkipped + " test file(s) skipped.");
        if (failed) note.push(failed + " file(s) couldn't be fetched.");
        note.push(items.length + " source files read, " + analysed + " mention Claude.");
        finishScan(p.owner + "/" + p.repo + "@" + x.ref, analysed, all, note.join(" "));
      });
    }).catch(function (e) { setStatus(e.message || "Something went wrong reading the repository.", "bad"); })
      .then(function () { busy = false; $("run-repo").disabled = false; });
  }

  function copy(text, btn) {
    if (!text) return;
    var done = function () { var o = btn.textContent; btn.textContent = "Copied"; setTimeout(function () { btn.textContent = o; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { setStatus("Copy failed; select the text manually.", "bad"); });
    else setStatus("Copy isn't available in this browser; select the text manually.", "bad");
  }

  $("run-json").addEventListener("click", runJson);
  $("run-code").addEventListener("click", runCode);
  $("run-repo").addEventListener("click", runRepo);
  $("repo-input").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); runRepo(); } });
  $("sample-json").addEventListener("click", function () { $("json-input").value = JSON.stringify(C.SAMPLE_REQUEST, null, 2); $("beta-input").value = "interleaved-thinking-2025-05-14"; runJson(); });
  $("sample-code").addEventListener("click", function () { $("code-input").value = C.SAMPLE_CODE; runCode(); });
  $("hero-sample").addEventListener("click", function () { selectTab("json"); $("sample-json").click(); });
  $("copy-md").addEventListener("click", function (e) { copy(last && last.md, e.currentTarget); });
  $("copy-fixed").addEventListener("click", function (e) { copy(last && last.fixedJson, e.currentTarget); });
  Array.prototype.forEach.call(document.querySelectorAll("input[name=target],input[name=platform]"), function (r) {
    r.addEventListener("change", function () { if (!$("results").hidden) { if (!$("panel-json").hidden && $("json-input").value.trim()) runJson(); else if (!$("panel-code").hidden && $("code-input").value.trim()) runCode(); } });
  });

  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(function () {});
})();
