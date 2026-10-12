(function () {
  "use strict";
  var N = window.N12;
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function setStatus(msg, kind) { var s = $("status"); s.textContent = msg || ""; s.className = "status" + (kind ? " " + kind : ""); }
  $("asof").textContent = N.DATA_AS_OF;

  // ---- tabs (roving tabindex, arrow keys)
  var tabs = ["files", "paste", "repo"];
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

  // ---- state
  var state = null; // { title, input, report, decisions }

  // ---- registry lookups (names + versions only)
  var regCache = {};
  function regUrl(name, version) { return "https://registry.npmjs.org/" + name.replace("/", "%2F") + "/" + encodeURIComponent(version); }
  function lookup(pkgs) {
    if (!$("use-registry").checked || !pkgs.length) return Promise.resolve({});
    // Workspace packages are yours (maybe private): never sent to the registry.
    var list = pkgs.filter(function (p) { return !p.workspace && p.version && /^[@\w.\/-]+$/.test(p.name); }).slice(0, 200);
    var out = {}, i = 0, done = 0;
    function worker() {
      if (i >= list.length) return Promise.resolve();
      var p = list[i++], id = p.name + "@" + p.version;
      var cached = regCache[id];
      var job = cached !== undefined ? Promise.resolve(cached) :
        fetch(regUrl(p.name, p.version), { credentials: "omit", referrerPolicy: "no-referrer", headers: { Accept: "application/json" } })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) { var v = j ? { scripts: j.scripts || {}, gypfile: !!j.gypfile } : null; regCache[id] = v; return v; })
          .catch(function () { return null; });
      return job.then(function (v) { out[id] = v; done++; if (done % 10 === 0) setStatus("Reading install scripts from the npm registry… " + done + "/" + list.length); return worker(); });
    }
    var pool = []; for (var k = 0; k < 6; k++) pool.push(worker());
    return Promise.all(pool).then(function () { return out; });
  }

  function run(title, input) {
    var report;
    try { report = N.analyze(input); } catch (e) { setStatus(e.message, "bad"); return Promise.resolve(); }
    var need = report.pkgs;
    setStatus(need.length && $("use-registry").checked ? "Reading install scripts from the npm registry…" : "Checking…");
    return lookup(need).then(function (reg) {
      input.registry = reg;
      report = N.analyze(input);
      state = { title: title, input: input, report: report, decisions: {} };
      render();
      var s = N.summarize(report.findings);
      setStatus("Checked " + title + ": " + report.lock.total + " locked packages, " + report.pkgs.length + " with install scripts.", s.error ? "bad" : "ok");
      $("results").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    });
  }

  // ---- rendering
  var LABEL = { error: "Breaks", warn: "Review", info: "Note" };
  function render() {
    var r = state.report;
    $("results").hidden = false;
    var s = N.summarize(r.findings);
    var sum = $("summary"); sum.textContent = "";
    sum.appendChild(el("span", "pill error", s.error + " will break"));
    sum.appendChild(el("span", "pill warn", s.warn + " to review"));
    sum.appendChild(el("span", "pill info", s.info + " notes"));
    var ol = $("findings"); ol.textContent = "";
    if (!s.error && !s.warn) {
      var ok = el("li", "allclear", r.hasLock ? "Nothing in these files breaks on npm 12. Keep the allowScripts block below up to date when you add dependencies." : "Nothing breaking found in these files.");
      ol.appendChild(ok);
    }
    r.findings.forEach(function (f) {
      var li = el("li", "finding " + f.level);
      var h = el("h4"); h.appendChild(el("span", "tag " + f.level, LABEL[f.level])); h.appendChild(el("span", null, f.title.replace(/`/g, "")));
      li.appendChild(h);
      if (f.path) li.appendChild(el("p", "loc", f.path + (f.line ? ":" + f.line : "")));
      if (f.code) { var pre = el("pre", null, f.code); pre.tabIndex = 0; li.appendChild(pre); }
      if (f.why) li.appendChild(el("p", null, f.why.replace(/`/g, "")));
      if (f.fix) { var fx = el("p", "fix"); fx.appendChild(el("strong", null, "Fix: ")); fx.appendChild(document.createTextNode(f.fix.replace(/`/g, ""))); li.appendChild(fx); }
      if (f.src) { var sp = el("p", "small"); var a = el("a", null, "Source"); a.href = f.src; a.target = "_blank"; a.rel = "noopener"; sp.appendChild(a); li.appendChild(sp); }
      ol.appendChild(li);
    });
    renderPkgs();
    renderOutputs();
  }

  var VERDICT = { breaks: "Breaks", review: "Review", safe: "Works" };
  var COV = { approved: "Approved", denied: "Denied", uncovered: "Not decided", "pin-mismatch": "Pinned to another version" };
  function renderPkgs() {
    var r = state.report, tb = $("pkgs"); tb.textContent = "";
    $("pkgs-wrap").hidden = !r.pkgs.length;
    r.pkgs.forEach(function (p) {
      var tr = el("tr");
      var th = el("th"); th.scope = "row";
      th.appendChild(el("code", null, p.name + "@" + p.version));
      var meta = [];
      if (p.dev) meta.push("dev"); if (p.optional) meta.push("optional");
      if (p.os) meta.push("only " + p.os.join("/")); if (p.workspace) meta.push("workspace");
      if (p.paths.length > 1) meta.push(p.paths.length + " copies");
      if (meta.length) th.appendChild(el("div", "meta", meta.join(" · ")));
      tr.appendChild(th);
      var td = el("td"); td.appendChild(el("span", "verdict " + p.verdict, VERDICT[p.verdict]));
      td.appendChild(el("div", "small", p.why.replace(/`/g, "")));
      if (p.script) td.appendChild(el("pre", null, p.script));
      tr.appendChild(td);
      tr.appendChild(el("td", "small", COV[p.coverage.status] + (p.coverage.key ? " (" + p.coverage.key + ")" : "")));
      var tdd = el("td");
      if (p.coverage.status === "approved" || p.coverage.status === "denied") tdd.appendChild(el("span", "small muted", "Keep"));
      else {
        var sel = el("select"); sel.setAttribute("aria-label", "Decision for " + p.name);
        [["approve", "Approve"], ["deny", "Deny"], ["skip", "Decide later"]].forEach(function (o) { var op = el("option", null, o[1]); op.value = o[0]; sel.appendChild(op); });
        sel.value = state.decisions[p.name] || N.defaultDecision(p);
        sel.addEventListener("change", function () { state.decisions[p.name] = sel.value; renderOutputs(); });
        tdd.appendChild(sel);
      }
      tr.appendChild(tdd);
      tb.appendChild(tr);
    });
  }
  function renderOutputs() {
    var r = state.report;
    var o = N.buildOutputs(r, state.decisions, $("pin").checked);
    state.outputs = o;
    var show = r.pkgs.length || o.npmrc.length;
    $("out-wrap").hidden = !show;
    if (!show) return;
    $("out-json").textContent = "// package.json\n" + o.json + (o.npmrc.length ? "\n\n# project .npmrc\n" + o.npmrc.join("\n") : "");
    $("out-cmds").textContent = "# with npm 12 installed\n" + o.commands.join("\n");
  }
  $("pin").addEventListener("change", function () { if (state) renderOutputs(); });

  function copy(text, btn) {
    var done = function () { var t = btn.textContent; btn.textContent = "Copied"; setTimeout(function () { btn.textContent = t; }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { setStatus("Couldn't copy; select the text instead.", "bad"); });
    else setStatus("Clipboard isn't available; select the text instead.", "bad");
  }
  Array.prototype.forEach.call(document.querySelectorAll("[data-copy]"), function (b) {
    b.addEventListener("click", function () {
      var t = $(b.getAttribute("data-copy")).textContent;
      if (b.getAttribute("data-copy") === "out-json" && state) t = state.outputs.json.replace(/^\{\n|\n\}$/g, "") + (state.outputs.npmrc.length ? "\n\n# .npmrc\n" + state.outputs.npmrc.join("\n") : "");
      copy(t, b);
    });
  });
  $("copy-md").addEventListener("click", function () { if (state) copy(N.markdown(state.report, state.outputs, state.title), $("copy-md")); });

  // ---- files tab
  var picked = [];
  function setPicked(files) {
    picked = Array.prototype.slice.call(files || []).filter(function (f) { return f.size < 60e6; });
    var ul = $("files-list"); ul.textContent = "";
    picked.forEach(function (f) { ul.appendChild(el("li", null, (f.webkitRelativePath || f.name) + (N.fileKind(f.name) ? "" : " (ignored)"))); });
  }
  $("file-input").addEventListener("change", function (e) { setPicked(e.target.files); });
  var drop = $("drop");
  ["dragenter", "dragover"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("over"); }); });
  ["dragleave", "drop"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("over"); }); });
  drop.addEventListener("drop", function (e) { if (e.dataTransfer && e.dataTransfer.files) setPicked(e.dataTransfer.files); });

  $("run-files").addEventListener("click", function () {
    if (!picked.length) { setStatus("Choose or drop at least package-lock.json.", "bad"); $("file-input").focus(); return; }
    var input = { files: [] };
    Promise.all(picked.map(function (f) {
      var kind = N.fileKind(f.name);
      if (!kind) return null;
      return f.text().then(function (t) {
        if (kind === "lock") input.lockText = t;
        else if (kind === "pkg") input.pkgText = t;
        else if (kind === "npmrc") input.npmrcText = t;
        else if (kind === "shrinkwrap") { input.hasShrinkwrap = true; if (!input.lockText) input.lockText = t; }
        else input.files.push({ path: f.name, text: t });
      });
    })).then(function () {
      if (!input.lockText && !input.pkgText && !input.files.length) { setStatus("None of those files are ones this check reads. Add package-lock.json.", "bad"); return; }
      return run(picked.length === 1 ? picked[0].name : picked.length + " files", input);
    }).catch(function (err) { setStatus("Couldn't read the files: " + err.message, "bad"); });
  });

  // ---- paste tab
  function runPaste() {
    var input = { lockText: $("lock-input").value, pkgText: $("pkg-input").value, npmrcText: $("npmrc-input").value, files: [] };
    if ($("ci-input").value.trim()) input.files.push({ path: "pasted CI/script", text: $("ci-input").value });
    if (!input.lockText.trim() && !input.pkgText.trim() && !input.files.length) { setStatus("Paste a package-lock.json (and optionally the rest).", "bad"); $("lock-input").focus(); return; }
    run("pasted files", input);
  }
  $("run-paste").addEventListener("click", runPaste);
  function loadSample() {
    selectTab("paste");
    $("lock-input").value = N.SAMPLE.lock; $("pkg-input").value = N.SAMPLE.pkg; $("npmrc-input").value = ""; $("ci-input").value = N.SAMPLE.workflow;
    runPaste();
  }
  $("sample-paste").addEventListener("click", loadSample);
  $("sample-files").addEventListener("click", loadSample);
  $("hero-sample").addEventListener("click", function () { $("check").scrollIntoView(); loadSample(); });

  // ---- repo tab
  function ghError(res, what) {
    if (res.status === 404) return "Repository or branch not found. It may be private or misspelled.";
    if (res.status === 403 || res.status === 429) return "GitHub's unauthenticated rate limit was hit (60 requests/hour per IP). Try again later, or use the Files tab.";
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
    var p = N.parseRepo($("repo-input").value);
    if (!p) { setStatus("Enter a repo as owner/repo or a github.com URL.", "bad"); $("repo-input").focus(); return; }
    busy = true; $("run-repo").disabled = true;
    var base = "https://api.github.com/repos/" + encodeURIComponent(p.owner) + "/" + encodeURIComponent(p.repo);
    setStatus("Reading " + p.owner + "/" + p.repo + "…");
    (p.ref ? Promise.resolve({ default_branch: p.ref }) : getJSON(base, "the repository")).then(function (info) {
      var ref = info.default_branch || "main";
      return getJSON(base + "/git/trees/" + encodeURIComponent(ref) + "?recursive=1", "the file list").then(function (tree) { return { ref: ref, tree: tree }; });
    }).then(function (x) {
      var blobs = (x.tree.tree || []).filter(function (t) { return t.type === "blob"; });
      var wanted = blobs.filter(function (t) {
        var k = N.fileKind(t.path);
        if (!k || /(^|\/)node_modules\//.test(t.path)) return false;
        if (k === "lock" || k === "pkg" || k === "npmrc" || k === "shrinkwrap") return t.path.indexOf("/") < 0;
        if (/\.(ya?ml|toml)$/.test(t.path) && !/(^|\/)\.github\/workflows\/|(^|\/)\.circleci\/|^[^/]+$/.test(t.path)) return false;
        return (t.size || 0) < 300000;
      });
      var manifests = wanted.filter(function (t) { return t.path.indexOf("/") < 0 && /^(lock|pkg|npmrc|shrinkwrap)$/.test(N.fileKind(t.path)); });
      wanted = manifests.concat(wanted.filter(function (t) { return manifests.indexOf(t) < 0; }).slice(0, 50));
      if (!wanted.some(function (t) { return t.path === "package-lock.json"; })) {
        var nested = blobs.filter(function (t) { return /\/package-lock\.json$/.test(t.path) && !/node_modules\//.test(t.path); }).map(function (t) { return t.path; });
        if (!wanted.some(function (t) { return t.path === "package.json"; }) && !nested.length) throw new Error("No package-lock.json or package.json at the root of this repo.");
        if (nested.length) setStatus("No root package-lock.json; found " + nested.slice(0, 3).join(", ") + ". Use the Files tab for those.");
      }
      var input = { files: [] };
      var rawBase = "https://raw.githubusercontent.com/" + encodeURIComponent(p.owner) + "/" + encodeURIComponent(p.repo) + "/" + x.ref.split("/").map(encodeURIComponent).join("/") + "/";
      return Promise.all(wanted.map(function (t) {
        return fetch(rawBase + t.path.split("/").map(encodeURIComponent).join("/"), { credentials: "omit", referrerPolicy: "no-referrer" })
          .then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
          .then(function (txt) {
            var k = N.fileKind(t.path);
            if (k === "lock") input.lockText = txt; else if (k === "pkg") input.pkgText = txt; else if (k === "npmrc") input.npmrcText = txt;
            else if (k === "shrinkwrap") { input.hasShrinkwrap = true; }
            else input.files.push({ path: t.path, text: txt });
          }).catch(function () {});
      })).then(function () { return run(p.owner + "/" + p.repo + (p.ref ? "@" + p.ref : ""), input); });
    }).catch(function (err) { setStatus(err.message, "bad"); })
      .then(function () { busy = false; $("run-repo").disabled = false; });
  }
  $("run-repo").addEventListener("click", runRepo);
  $("repo-input").addEventListener("keydown", function (e) { if (e.key === "Enter") runRepo(); });

  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(function () {});
})();
