/* GPT Backup Kit — UI. All processing is local; nothing leaves the browser. */
(function () {
  "use strict";
  var Kit = window.Kit;
  var yaml = window.jsyaml;
  var STORE = "gpt-backup-kit:v1";
  var $ = function (id) { return document.getElementById(id); };
  var form = $("gpt-form");
  var fileData = {}; // name -> Uint8Array (memory only)
  var knowledge = []; // [{name,size}]
  var saveTimer = null;

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") e.className = attrs[k];
      else if (k.indexOf("data-") === 0 || k.indexOf("aria-") === 0 || ["type", "rows", "placeholder", "maxlength", "for", "id", "role", "spellcheck", "autocomplete", "tabindex", "value"].indexOf(k) >= 0) e.setAttribute(k, attrs[k]);
      else e[k] = attrs[k];
    });
    if (text != null) e.textContent = text;
    return e;
  }
  var uid = 0;
  function nextId(p) { uid += 1; return p + "-" + uid; }

  /* ---------- dynamic lists ---------- */
  function addStarter(value) {
    var row = el("div", { class: "item" });
    var id = nextId("starter");
    row.appendChild(el("label", { for: id, class: "sr-only" }, "Conversation starter"));
    var inp = el("input", { id: id, type: "text", maxlength: "300", autocomplete: "off", placeholder: "Conversation starter", "data-field": "starter" });
    inp.value = value || "";
    row.appendChild(inp);
    row.appendChild(removeBtn("Remove starter"));
    $("starters").appendChild(row);
    return inp;
  }
  function addTest(t) {
    t = t || {};
    var row = el("div", { class: "item stack" });
    var a = nextId("tp"), b = nextId("te");
    row.appendChild(el("label", { for: a }, "Prompt"));
    var p = el("textarea", { id: a, rows: "2", "data-field": "prompt", placeholder: "Something you often ask this GPT" });
    p.value = t.prompt || "";
    row.appendChild(p);
    row.appendChild(el("label", { for: b }, "What a good answer looks like"));
    var x = el("textarea", { id: b, rows: "2", "data-field": "expect", placeholder: "Key points, format, length" });
    x.value = t.expect || "";
    row.appendChild(x);
    row.appendChild(removeBtn("Remove test prompt"));
    $("tests").appendChild(row);
    return p;
  }
  function addAction(a) {
    a = a || {};
    var row = el("div", { class: "item stack action" });
    var n = nextId("an"), s = nextId("as"), au = nextId("au");
    row.appendChild(el("label", { for: n }, "Action name"));
    var name = el("input", { id: n, type: "text", maxlength: "120", autocomplete: "off", "data-field": "aname", placeholder: "e.g. Ticket Tracker" });
    name.value = a.name || "";
    row.appendChild(name);
    row.appendChild(el("label", { for: au }, "Authentication"));
    var auth = el("select", { id: au, "data-field": "auth" });
    [["none", "None"], ["apikey", "API key"], ["oauth", "OAuth"]].forEach(function (o) { var op = el("option", { value: o[0] }, o[1]); auth.appendChild(op); });
    auth.value = a.auth || "none";
    row.appendChild(auth);
    row.appendChild(el("label", { for: s }, "OpenAPI schema (JSON or YAML)"));
    var schema = el("textarea", { id: s, rows: "8", spellcheck: "false", "data-field": "schema", class: "mono", placeholder: "openapi: 3.1.0\ninfo: …\npaths: …" });
    schema.value = a.schema || "";
    row.appendChild(schema);
    row.appendChild(el("p", { class: "hint", "data-field": "schema-status", "aria-live": "polite" }));
    row.appendChild(removeBtn("Remove action"));
    $("actions").appendChild(row);
    return name;
  }
  function removeBtn(label) {
    var b = el("button", { type: "button", class: "btn tiny ghost remove", "aria-label": label }, "Remove");
    b.addEventListener("click", function () { b.parentNode.remove(); update(); });
    return b;
  }

  function buildCaps() {
    Kit.CAPABILITIES.forEach(function (c) {
      var id = "cap-" + c[0];
      var w = el("label", { class: "cap", for: id });
      var cb = el("input", { type: "checkbox", id: id, "data-cap": c[0] });
      w.appendChild(cb);
      w.appendChild(document.createTextNode(" " + c[1]));
      $("caps").appendChild(w);
    });
  }

  /* ---------- read / write form ---------- */
  function read() {
    var g = {
      name: $("f-name").value, description: $("f-description").value, instructions: $("f-instructions").value,
      model: $("f-model").value, plan: $("f-plan").value, published: $("f-published").value,
      apps: $("f-apps").value, sharing: $("f-sharing").value, users: $("f-users").value, shareLink: $("f-shareLink").value,
      starters: [], capabilities: {}, knowledge: knowledge.slice(), actions: [], tests: []
    };
    $("starters").querySelectorAll("[data-field=starter]").forEach(function (i) { g.starters.push(i.value); });
    $("caps").querySelectorAll("[data-cap]").forEach(function (c) { g.capabilities[c.getAttribute("data-cap")] = c.checked; });
    $("actions").querySelectorAll(".action").forEach(function (r) {
      g.actions.push({ name: r.querySelector("[data-field=aname]").value, auth: r.querySelector("[data-field=auth]").value, schema: r.querySelector("[data-field=schema]").value });
    });
    $("tests").querySelectorAll(".item").forEach(function (r) {
      g.tests.push({ prompt: r.querySelector("[data-field=prompt]").value, expect: r.querySelector("[data-field=expect]").value });
    });
    return g;
  }
  function write(gIn) {
    var g = Kit.normalize(gIn);
    $("f-name").value = g.name; $("f-description").value = g.description; $("f-instructions").value = g.instructions;
    $("f-model").value = g.model; $("f-plan").value = g.plan; $("f-published").value = g.published;
    $("f-apps").value = g.apps; $("f-sharing").value = g.sharing; $("f-users").value = g.users; $("f-shareLink").value = g.shareLink;
    $("starters").textContent = ""; $("actions").textContent = ""; $("tests").textContent = "";
    (g.starters.length ? g.starters : [""]).forEach(addStarter);
    g.actions.forEach(addAction);
    (g.tests.length ? g.tests : [{}]).forEach(addTest);
    $("caps").querySelectorAll("[data-cap]").forEach(function (c) { c.checked = !!g.capabilities[c.getAttribute("data-cap")]; });
    knowledge = g.knowledge.slice();
    renderKnowledge();
  }

  function renderKnowledge() {
    var ul = $("knowledge-list");
    ul.textContent = "";
    knowledge.forEach(function (k, i) {
      var li = el("li", { class: fileData[k.name] ? "chip has" : "chip" });
      li.appendChild(el("span", null, k.name + (k.size != null ? " · " + fmtSize(k.size) : "") + (fileData[k.name] ? "" : " (name only)")));
      var b = el("button", { type: "button", class: "chip-x", "aria-label": "Remove " + k.name }, "×");
      b.addEventListener("click", function () { delete fileData[k.name]; knowledge.splice(i, 1); renderKnowledge(); update(); });
      li.appendChild(b);
      ul.appendChild(li);
    });
  }
  function fmtSize(n) { return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(0) + " KB" : (n / 1048576).toFixed(1) + " MB"; }

  /* ---------- render outputs ---------- */
  function update() {
    var g = read();
    var n = Kit.normalize(g);
    $("instr-count").textContent = n.instructions.length.toLocaleString();
    var ready = !!(n.name && n.instructions);
    $("download-zip").disabled = !ready;
    $("out-title").textContent = n.name ? n.name + " — backup" : "Your backup";
    var r = Kit.migrationReport(n, new Date());
    $("out-sub").textContent = ready
      ? r.items.length + " items checked · " + r.lostCount + " need action before " + r.deadlineLabel
      : "Fill in a name and instructions to enable the download.";

    var ul = $("report");
    ul.textContent = "";
    var labels = { carries: "Kept", lost: "Action needed", check: "Check" };
    r.items.forEach(function (i) {
      var li = el("li", { class: "ri " + i.status });
      li.appendChild(el("span", { class: "tag " + (i.status === "carries" ? "ok" : i.status === "lost" ? "bad" : "warn") }, labels[i.status]));
      var body = el("div");
      body.appendChild(el("strong", null, i.title));
      body.appendChild(el("p", null, i.detail));
      li.appendChild(body);
      ul.appendChild(li);
    });

    $("skill-slug").textContent = Kit.slugify(n.name);
    $("out-skill").textContent = Kit.skillMd(n);
    $("out-claude").textContent = Kit.portablePrompt(n, "claude");
    $("out-gemini").textContent = Kit.portablePrompt(n, "gemini");
    renderActions(n);
    scheduleSave(g);
  }

  function renderActions(n) {
    var box = $("actions-out");
    box.textContent = "";
    var rows = $("actions").querySelectorAll(".action");
    if (!n.actions.length) {
      box.appendChild(el("p", { class: "muted small" }, "No custom actions added. If your GPT has none, nothing needs rebuilding."));
    }
    rows.forEach(function (row, idx) {
      var schema = row.querySelector("[data-field=schema]").value;
      var name = row.querySelector("[data-field=aname]").value.trim() || "Action " + (idx + 1);
      var status = row.querySelector("[data-field=schema-status]");
      if (!schema.trim()) { status.textContent = ""; status.className = "hint"; return; }
      var p = Kit.parseSpec(schema, yaml);
      var sec = Kit.findSecrets(schema);
      if (!p.ok) {
        status.textContent = p.error; status.className = "hint err";
        box.appendChild(el("p", { class: "error-inline" }, name + ": " + p.error));
        return;
      }
      var sum = Kit.summarizeSpec(p.spec);
      status.textContent = "Parsed " + sum.title + " · " + sum.operations.length + " operation(s)" + (sec.length ? " · possible secret found — remove it" : "");
      status.className = sec.length ? "hint err" : "hint ok";
      var card = el("div", { class: "action-card" });
      card.appendChild(el("h3", null, name));
      card.appendChild(el("p", { class: "muted small" }, (sum.baseUrl || "No server URL in schema") + " · auth: " + (sum.security.map(function (s) { return s.type + (s.in ? " (" + s.in + ")" : ""); }).join(", ") || "none declared")));
      var ops = el("ul", { class: "ops" });
      sum.operations.forEach(function (o) { var li = el("li"); li.appendChild(el("code", null, o.method + " " + o.path)); li.appendChild(document.createTextNode(" " + (o.summary || o.operationId))); ops.appendChild(li); });
      card.appendChild(ops);
      var id = "py-" + idx;
      var head = el("div", { class: "code-head" });
      head.appendChild(el("span", null, "server.py (MCP, Python)"));
      var cp = el("button", { type: "button", class: "btn tiny", "data-copy": id }, "Copy");
      head.appendChild(cp);
      card.appendChild(head);
      card.appendChild(el("pre", { class: "code", id: id, tabindex: "0" }, Kit.mcpServerPy(name, p.spec)));
      box.appendChild(card);
    });
  }

  /* ---------- persistence ---------- */
  function scheduleSave(g) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { localStorage.setItem(STORE, JSON.stringify(g)); $("save-status").textContent = "Saved in this browser"; }
      catch (e) { $("save-status").textContent = "Couldn't save locally (storage full or blocked)"; }
    }, 400);
  }
  function load() {
    try { var s = localStorage.getItem(STORE); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }

  /* ---------- actions ---------- */
  function showError(msg) {
    var e = $("form-error");
    if (!msg) { e.hidden = true; e.textContent = ""; return; }
    e.hidden = false; e.textContent = msg;
  }
  function download() {
    var g = Kit.normalize(read());
    if (!g.name || !g.instructions) { showError("Add at least a name and the instructions before downloading."); ($("f-name").value ? $("f-instructions") : $("f-name")).focus(); return; }
    var secrets = Kit.findSecrets(g.instructions + "\n" + g.actions.map(function (a) { return a.schema; }).join("\n"));
    if (secrets.length && !window.confirm("This looks like it contains a secret (" + secrets.map(function (s) { return s.kind; }).join(", ") + "). Remove it first? Press Cancel to remove it, OK to download anyway.")) return;
    showError("");
    var files = Kit.buildBundle(g, { yaml: yaml, now: new Date(), files: g.knowledge.filter(function (k) { return fileData[k.name]; }).map(function (k) { return { name: k.name, data: fileData[k.name] }; }) });
    var bytes = Kit.zip(files);
    var blob = new Blob([bytes], { type: "application/zip" });
    var a = el("a", { href: URL.createObjectURL(blob) });
    a.download = Kit.slugify(g.name) + "-gpt-backup.zip";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    $("save-status").textContent = "Downloaded " + files.length + " files";
  }

  function importFile(f) {
    if (!f) return;
    if (f.size > 5 * 1048576) { showError("That file is too large to be a gpt.json backup."); return; }
    var rd = new FileReader();
    rd.onload = function () {
      try {
        var g = JSON.parse(String(rd.result));
        if (!g || typeof g !== "object" || (!g.name && !g.instructions)) throw new Error("not a backup");
        fileData = {};
        write(g); update(); showError("");
        $("save-status").textContent = "Imported " + (g.name || "backup");
      } catch (e) { showError("Couldn't read that file. Choose the gpt.json from a GPT Backup Kit ZIP."); }
    };
    rd.readAsText(f);
  }

  function addKnowledge(list) {
    var total = 0;
    Object.keys(fileData).forEach(function (k) { total += fileData[k].length; });
    Array.prototype.forEach.call(list, function (f) {
      if (total + f.size > 200 * 1048576) { showError("Skipped " + f.name + ": files over 200 MB total are too big to zip in the browser."); return; }
      total += f.size;
      var rd = new FileReader();
      rd.onload = function () {
        fileData[f.name] = new Uint8Array(rd.result);
        knowledge = knowledge.filter(function (k) { return k.name !== f.name; });
        knowledge.push({ name: f.name, size: f.size });
        renderKnowledge(); update();
      };
      rd.readAsArrayBuffer(f);
    });
  }

  function copy(id, btn) {
    var text = $(id).textContent;
    var done = function () { var t = btn.textContent; btn.textContent = "Copied"; setTimeout(function () { btn.textContent = t; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    var ta = el("textarea"); ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch (e) { /* ignore */ } ta.remove();
  }

  /* ---------- tabs ---------- */
  function setupTabs() {
    var tabs = Array.prototype.slice.call(document.querySelectorAll("[role=tab]"));
    function select(t) {
      tabs.forEach(function (x) {
        var on = x === t;
        x.setAttribute("aria-selected", on ? "true" : "false");
        x.tabIndex = on ? 0 : -1;
        $(x.getAttribute("aria-controls")).hidden = !on;
      });
    }
    tabs.forEach(function (t, i) {
      t.addEventListener("click", function () { select(t); });
      t.addEventListener("keydown", function (e) {
        var j = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length : -1;
        if (j >= 0) { e.preventDefault(); tabs[j].focus(); select(tabs[j]); }
      });
    });
  }

  function countdown() {
    var d = Kit.daysUntil(Kit.DATES.retirement, new Date());
    $("countdown").textContent = d > 1 ? d + " days left" : d === 1 ? "1 day left" : d === 0 ? "today" : "retirement date has passed";
  }

  function loadSample() {
    fileData = {};
    write(Kit.sample()); update();
    $("kit").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ---------- init ---------- */
  buildCaps();
  setupTabs();
  countdown();
  $("ver").textContent = Kit.VERSION;
  var saved = load();
  write(saved || {});
  update();

  form.addEventListener("input", update);
  form.addEventListener("change", update);
  form.addEventListener("submit", function (e) { e.preventDefault(); });
  document.querySelectorAll("[data-add]").forEach(function (b) {
    b.addEventListener("click", function () {
      var k = b.getAttribute("data-add");
      var f = k === "starters" ? addStarter() : k === "tests" ? addTest() : addAction();
      f.focus(); update();
    });
  });
  document.addEventListener("click", function (e) {
    var t = e.target.closest && e.target.closest("[data-copy]");
    if (t) copy(t.getAttribute("data-copy"), t);
  });
  $("download-zip").addEventListener("click", download);
  $("import-file").addEventListener("change", function (e) { importFile(e.target.files[0]); e.target.value = ""; });
  $("knowledge-files").addEventListener("change", function (e) { addKnowledge(e.target.files); e.target.value = ""; });
  $("load-sample").addEventListener("click", loadSample);
  $("try-sample").addEventListener("click", loadSample);
  $("clear-all").addEventListener("click", function () {
    if (!window.confirm("Clear everything you've entered on this device?")) return;
    try { localStorage.removeItem(STORE); } catch (e) { /* ignore */ }
    fileData = {}; write({}); update(); showError("");
    $("save-status").textContent = "Cleared";
  });

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(function () { /* offline support is optional */ });
  }
})();
