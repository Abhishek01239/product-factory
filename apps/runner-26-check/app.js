/* Ubuntu 26 Runner Check: UI. All rendering uses textContent; workflow files are untrusted input. */
(function () {
  "use strict";
  var R = window.R26, Y = window.jsyaml;
  var $ = function (id) { return document.getElementById(id); };
  var state = { results: [], source: "" };
  var MAX_FILES = 50, MAX_BYTES = 500000;

  // ---------- helpers ----------
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  // Render text with `code` spans safely.
  function rich(tag, cls, text) {
    var e = el(tag, cls);
    String(text).split("`").forEach(function (part, i) {
      if (!part) return;
      e.appendChild(i % 2 ? el("code", null, part) : document.createTextNode(part));
    });
    return e;
  }
  function setStatus(msg, kind) {
    var s = $("status");
    s.textContent = msg || "";
    s.className = "status" + (kind ? " " + kind : "");
  }
  function download(name, text) {
    var blob = new Blob([text], { type: "text/yaml;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }

  // ---------- countdown ----------
  (function () {
    var d1 = R.daysUntil(R.DATES.migrationStart), d2 = R.daysUntil(R.DATES.migrationEnd);
    var c = $("countdown");
    if (d1 > 0) c.textContent = "ubuntu-latest starts moving to 26.04 in " + plural(d1, "day") + " (Oct 19, 2026)";
    else if (d2 > 0) c.textContent = "Migration in progress: ubuntu-latest jobs are moving to 26.04 now. Complete by Nov 19, 2026 (" + plural(d2, "day") + ")";
    else c.textContent = "ubuntu-latest is Ubuntu 26.04 (since Nov 19, 2026)";
    $("asof").textContent = R.DATA_AS_OF;
  })();

  // ---------- tabs ----------
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
  function selectTab(t) {
    tabs.forEach(function (x) {
      var on = x === t;
      x.setAttribute("aria-selected", on ? "true" : "false");
      x.tabIndex = on ? 0 : -1;
      $(x.getAttribute("aria-controls")).hidden = !on;
    });
  }
  tabs.forEach(function (t, i) {
    t.addEventListener("click", function () { selectTab(t); });
    t.addEventListener("keydown", function (e) {
      var k = e.key, j = null;
      if (k === "ArrowRight") j = (i + 1) % tabs.length;
      else if (k === "ArrowLeft") j = (i - 1 + tabs.length) % tabs.length;
      else if (k === "Home") j = 0; else if (k === "End") j = tabs.length - 1;
      if (j != null) { e.preventDefault(); selectTab(tabs[j]); tabs[j].focus(); }
    });
  });

  // ---------- inputs ----------
  function runAll(files, sourceLabel) {
    state.results = files.map(function (f) {
      if (f.text.length > MAX_BYTES) return { file: f.name, error: "This file is larger than 500 KB." };
      return R.analyze(f.text, { yaml: Y, fileName: f.name });
    });
    state.source = sourceLabel || "";
    render();
  }

  function loadSample() {
    selectTab($("tab-paste"));
    $("paste-name").value = "sample-ci.yml";
    $("paste-input").value = R.SAMPLE;
    runAll([{ name: "sample-ci.yml", text: R.SAMPLE }], "Sample workflow");
  }
  $("sample-btn").addEventListener("click", loadSample);
  $("hero-sample").addEventListener("click", function () { loadSample(); $("check").scrollIntoView({ behavior: "smooth" }); });

  $("paste-btn").addEventListener("click", function () {
    var text = $("paste-input").value;
    var name = ($("paste-name").value || "workflow.yml").trim().replace(/[^\w.\-]/g, "_").slice(0, 80) || "workflow.yml";
    if (!text.trim()) { setStatus("Paste a workflow file first.", "bad"); $("paste-input").focus(); return; }
    runAll([{ name: name, text: text }], "Pasted workflow");
  });

  function readFiles(list) {
    var arr = Array.prototype.slice.call(list || []).filter(function (f) { return /\.ya?ml$/i.test(f.name); });
    if (!arr.length) { setStatus("No .yml or .yaml files selected.", "bad"); return; }
    if (arr.length > MAX_FILES) { setStatus("Only the first " + MAX_FILES + " files are checked.", "warn"); arr = arr.slice(0, MAX_FILES); }
    var tooBig = arr.filter(function (f) { return f.size > MAX_BYTES; }).map(function (f) { return f.name; });
    Promise.all(arr.map(function (f) {
      if (f.size > MAX_BYTES) return Promise.resolve({ name: f.name, text: "x".repeat(MAX_BYTES + 1) });
      return f.text().then(function (t) { return { name: f.name, text: t }; });
    })).then(function (files) {
      runAll(files, plural(files.length, "uploaded file"));
      if (tooBig.length) setStatus("Skipped (over 500 KB): " + tooBig.join(", "), "warn");
    }, function () { setStatus("Couldn't read those files.", "bad"); });
  }
  $("file-input").addEventListener("change", function (e) { readFiles(e.target.files); });
  var drop = $("drop");
  ["dragenter", "dragover"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("over"); }); });
  ["dragleave", "drop"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("over"); }); });
  drop.addEventListener("drop", function (e) { readFiles(e.dataTransfer && e.dataTransfer.files); });

  // ---------- public repo ----------
  function parseRepo(input) {
    var s = String(input || "").trim().replace(/\.git$/, "").replace(/\/+$/, "");
    var m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})(?:\/tree\/([A-Za-z0-9._\/-]{1,200}))?(?:[\/?#].*)?$/) ||
            s.match(/^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})(?:@([A-Za-z0-9._\/-]{1,200}))?$/);
    if (!m) return null;
    if (m[2] === "." || m[2] === "..") return null;
    return { owner: m[1], repo: m[2], ref: m[3] || "" };
  }
  function ghError(res) {
    if (res.status === 404) return "Repository or .github/workflows folder not found. It may be private, misspelled, or have no workflows.";
    if (res.status === 403 || res.status === 429) {
      var reset = res.headers.get("x-ratelimit-reset");
      var when = reset ? new Date(Number(reset) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
      return "GitHub's public API limit (60 requests an hour) was reached" + (when ? "; it resets at " + when : "") + ". You can paste or upload the files instead.";
    }
    return "GitHub returned HTTP " + res.status + ".";
  }
  $("repo-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var p = parseRepo($("repo-input").value);
    if (!p) { setStatus("Enter a repo as owner/repo or a github.com URL.", "bad"); $("repo-input").focus(); return; }
    var btn = $("repo-btn");
    btn.disabled = true;
    setStatus("Listing workflows in " + p.owner + "/" + p.repo + "…", "busy");
    var base = "https://api.github.com/repos/" + encodeURIComponent(p.owner) + "/" + encodeURIComponent(p.repo) + "/contents/.github/workflows" + (p.ref ? "?ref=" + encodeURIComponent(p.ref) : "");
    fetch(base, { headers: { Accept: "application/vnd.github+json" }, credentials: "omit", referrerPolicy: "no-referrer" })
      .then(function (res) { if (!res.ok) throw new Error(ghError(res)); return res.json(); })
      .then(function (list) {
        if (!Array.isArray(list)) throw new Error("Unexpected response from GitHub.");
        var files = list.filter(function (f) { return f.type === "file" && /\.ya?ml$/i.test(f.name) && typeof f.download_url === "string" && f.download_url.indexOf("https://raw.githubusercontent.com/") === 0; });
        if (!files.length) throw new Error("No .yml files in .github/workflows.");
        var skipped = 0;
        if (files.length > MAX_FILES) { skipped = files.length - MAX_FILES; files = files.slice(0, MAX_FILES); }
        setStatus("Reading " + plural(files.length, "workflow") + "…", "busy");
        return Promise.all(files.map(function (f) {
          if (f.size > MAX_BYTES) return { name: f.name, text: "x".repeat(MAX_BYTES + 1) };
          return fetch(f.download_url, { credentials: "omit", referrerPolicy: "no-referrer" }).then(function (r) {
            if (!r.ok) return { name: f.name, text: "", err: "HTTP " + r.status };
            return r.text().then(function (t) { return { name: f.name, text: t }; });
          }, function () { return { name: f.name, text: "", err: "network error" }; });
        })).then(function (got) {
          runAll(got.map(function (g) { return g.err ? { name: g.name, text: "\u0000" } : g; }), p.owner + "/" + p.repo + (p.ref ? "@" + p.ref : ""));
          state.results.forEach(function (r, i) { if (got[i].err) { r.error = "Couldn't download (" + got[i].err + ")."; delete r.jobs; } });
          render();
          if (skipped) setStatus("Checked the first " + MAX_FILES + " files; " + skipped + " more not shown.", "warn");
        });
      })
      .catch(function (err) { setStatus(err && err.message ? err.message : "Couldn't reach GitHub. Check your connection, or paste the files instead.", "bad"); })
      .then(function () { btn.disabled = false; });
  });

  // ---------- rendering ----------
  var SEV_LABEL = { high: "Breaks", medium: "Test first", low: "Minor", info: "Info", ok: "OK" };

  function render() {
    var res = state.results;
    $("results").hidden = !res.length;
    if (!res.length) return;
    var showOk = $("show-ok").checked;
    var jobs = 0, moving = 0, high = 0, med = 0, errs = 0, mac = 0;
    res.forEach(function (r) {
      if (r.error) { errs++; return; }
      r.jobs.forEach(function (j) {
        jobs++;
        if (j.labels.some(function (k) { return k.kind === "moves"; })) moving++;
        if (j.labels.some(function (k) { return k.kind === "macos14"; })) mac++;
        if (j.verdict.level === "high") high++; else if (j.verdict.level === "medium") med++;
      });
    });
    var sum = $("summary");
    sum.textContent = "";
    var head = el("p", "summary-src", "Checked " + plural(res.length, "file") + (state.source ? " from " + state.source : "") + ".");
    sum.appendChild(head);
    var stats = el("div", "stats");
    [[jobs, "jobs found", ""], [moving, "on ubuntu-latest", ""], [high, "likely to break", high ? "bad" : ""], [med, "to test first", med ? "warn" : ""]].forEach(function (s) {
      var c = el("div", "stat " + s[2]);
      c.appendChild(el("strong", null, String(s[0])));
      c.appendChild(el("span", null, s[1]));
      stats.appendChild(c);
    });
    sum.appendChild(stats);
    var msg;
    if (errs === res.length) msg = "None of the files could be checked; see the errors below.";
    else if (high) msg = plural(high, "job") + " call tools that are not on Ubuntu 26.04. Fix or pin them before Oct 19." + (mac ? " " + plural(mac, "job") + (mac === 1 ? " also uses" : " also use") + " macOS 14, unsupported from Nov 2." : "");
    else if (med) msg = "No removed tools found, but " + plural(med, "job") + " rely on versions that change. Run the canary workflow to confirm.";
    else if (moving) msg = "No known breakers in jobs on ubuntu-latest. Scripts the checker can't see may still differ, so a canary run is cheap insurance.";
    else msg = "No jobs use ubuntu-latest, so the move doesn't affect these files.";
    sum.appendChild(el("p", "summary-msg", msg));
    setStatus("", "");

    var host = $("files");
    host.textContent = "";
    res.forEach(function (r, idx) { host.appendChild(renderFile(r, idx, showOk)); });
    $("dl-canary").disabled = errs === res.length;
  }

  function badge(level, text) { return el("span", "badge " + level, text || SEV_LABEL[level]); }

  function renderFile(r, idx, showOk) {
    var card = el("article", "file");
    var h = el("header", "file-head");
    var title = el("h3", null, r.file);
    h.appendChild(title);
    if (r.error) {
      h.appendChild(badge("bad", "Not checked"));
      card.appendChild(h);
      card.appendChild(rich("p", "file-err", r.error));
      return card;
    }
    h.appendChild(badge(r.worst === "info" ? "info" : r.worst, { high: "Likely to break", medium: "Test first", low: "Low risk", ok: "Not affected", info: "Check manually" }[r.worst]));
    var pin = R.pinPatch(r.source);
    if (pin.changed.length) {
      var b = el("button", "btn tiny", "Pinned copy (" + plural(pin.changed.length, "line") + ")");
      b.type = "button";
      b.title = "Download this file with ubuntu-latest replaced by ubuntu-24.04";
      b.addEventListener("click", function () { download(r.file.replace(/\.ya?ml$/i, "") + ".yml", pin.text); });
      h.appendChild(b);
    }
    card.appendChild(h);
    if (r.type === "azure") card.appendChild(el("p", "small muted", "Azure Pipelines file"));
    var shown = 0;
    r.jobs.forEach(function (j) {
      var quiet = (j.verdict.level === "ok") && !j.findings.length;
      if (quiet && !showOk) return;
      shown++;
      card.appendChild(renderJob(j));
    });
    var hidden = r.jobs.length - shown;
    if (hidden) card.appendChild(el("p", "small muted hidden-note", plural(hidden, "job") + " not affected (pinned, self-hosted or non-Ubuntu). Tick “Show unaffected jobs” to list them."));
    return card;
  }

  function renderJob(j) {
    var box = el("section", "job lvl-" + j.verdict.level);
    var top = el("div", "job-head");
    var name = el("h4", null);
    name.appendChild(el("code", null, j.id));
    if (j.name && j.name !== j.id) name.appendChild(el("span", "muted", " " + j.name));
    top.appendChild(name);
    top.appendChild(badge(j.verdict.level, j.verdict.text));
    box.appendChild(top);
    var lab = el("p", "labels small");
    lab.appendChild(document.createTextNode("runs-on" + (j.runsOnLine ? " (line " + j.runsOnLine + ")" : "") + ": "));
    if (!j.labels.length) lab.appendChild(el("span", "muted", j.unresolved === "reusable" ? "reusable workflow" : "unresolved"));
    j.labels.forEach(function (k, i) {
      if (i) lab.appendChild(document.createTextNode(", "));
      var c = el("code", "lab-" + k.kind, k.label);
      c.title = k.note;
      lab.appendChild(c);
    });
    box.appendChild(lab);
    j.labels.forEach(function (k) {
      if (k.kind === "macos14" || k.kind === "u2204" || k.kind === "gone") box.appendChild(rich("p", "note", k.label + ": " + k.note));
    });
    j.notes.forEach(function (n) { box.appendChild(rich("p", "note", n)); });
    if (j.findings.length) {
      var ul = el("ul", "findings");
      j.findings.forEach(function (f) {
        var li = el("li", "finding sev-" + f.sev);
        var row = el("div", "f-row");
        row.appendChild(badge(f.sev));
        row.appendChild(rich("strong", null, f.title));
        if (f.line) row.appendChild(el("span", "line", "line " + f.line + (f.count > 1 ? " (+" + (f.count - 1) + " more)" : "")));
        li.appendChild(row);
        li.appendChild(rich("p", "why", f.why));
        var fx = rich("p", "fix", "Fix: " + f.fix);
        if (f.link) { var a = el("a", null, " Details"); a.href = f.link; a.rel = "noopener"; fx.appendChild(a); }
        li.appendChild(fx);
        ul.appendChild(li);
      });
      box.appendChild(ul);
    } else if (j.labels.some(function (k) { return k.kind === "moves"; }) && !j.container) {
      box.appendChild(el("p", "small muted", "No removed tools or changed defaults found in this job's steps."));
    }
    return box;
  }

  $("show-ok").addEventListener("change", render);
  $("copy-md").addEventListener("click", function () {
    var md = R.markdownReport(state.results);
    var btn = $("copy-md");
    function done(ok) { btn.textContent = ok ? "Copied" : "Copy failed: downloaded instead"; setTimeout(function () { btn.textContent = "Copy checklist (Markdown)"; }, 2000); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(md).then(function () { done(true); }, function () { download("ubuntu-26-checklist.md", md); done(false); });
    else { download("ubuntu-26-checklist.md", md); done(false); }
  });
  $("dl-canary").addEventListener("click", function () { download("ubuntu-26-canary.yml", R.canaryWorkflow(state.results)); });

  // ?repo=owner/name deep link
  var q = new URLSearchParams(location.search).get("repo");
  if (q && parseRepo(q)) { $("repo-input").value = q; }

  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(function () {});
})();
