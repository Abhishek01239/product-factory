/* EDF Tracker UI. All user data is rendered with textContent (never innerHTML). */
(function () {
  "use strict";
  var E = window.EDF;
  var KEY = "edf-tracker:v1";
  var state = load();
  var editingId = null;
  var filingMonth = null;

  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "text") n.textContent = attrs[k];
      else if (k === "class") n.className = attrs[k];
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }

  function today() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return { invoices: [], filings: {} };
      var r = E.parseBackup(raw);
      return r.ok ? r.data : { invoices: [], filings: {} };
    } catch (e) { return { invoices: [], filings: {} }; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ version: 1, invoices: state.invoices, filings: state.filings })); }
    catch (e) { toast("Could not save — your browser storage may be full or disabled.", true); }
  }

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function human(iso) {
    var d = E.parseDate(iso);
    return d ? d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear() : "—";
  }
  function monthName(key) {
    var m = key.split("-");
    return ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][+m[1] - 1] + " " + m[0];
  }
  function money(cur, amt) {
    var n = Number(String(amt).replace(/,/g, ""));
    if (!isFinite(n)) return cur + " " + amt;
    try {
      if (cur !== "OTHER") return new Intl.NumberFormat(cur === "INR" ? "en-IN" : "en", { style: "currency", currency: cur, maximumFractionDigits: 2 }).format(n);
    } catch (e) { /* fall through */ }
    return n.toLocaleString("en-IN") + (cur === "OTHER" ? "" : " " + cur);
  }
  function rel(days) {
    if (days === null) return "";
    if (days === 0) return "today";
    if (days > 0) return "in " + days + " day" + (days === 1 ? "" : "s");
    return Math.abs(days) + " day" + (days === -1 ? "" : "s") + " ago";
  }

  var STATUS_LABEL = { "done": "Filed", "overdue": "Overdue", "due-soon": "Due soon", "upcoming": "Upcoming", "pre-rules": "Before new rules", "unknown": "—" };

  var toastTimer;
  function toast(msg, bad) {
    var t = $("toast");
    t.textContent = msg;
    t.className = "toast show" + (bad ? " bad" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = "toast"; }, 3500);
  }

  // ---------- Quick calculator ----------
  function renderCalc() {
    var d = $("qc-date").value;
    var inr = document.querySelector('input[name="qc-cur"]:checked').value === "inr";
    var out = $("qc-out");
    out.textContent = "";
    if (!E.parseDate(d)) { out.appendChild(el("p", { class: "muted", text: "Pick a date to see your deadlines." })); return; }
    var t = today();
    if (!E.inScope(d)) {
      out.appendChild(el("p", { class: "warn", text: "This invoice is dated before 1 October 2026, when the EDF rules for services started. Check with your bank how older invoices are treated." }));
    }
    var edf = E.edfDue(d), real = E.realisationDue(d, inr), chase = E.chaseDate(d);
    var dl = el("dl", { class: "calc-dl" }, [
      el("dt", { text: "File EDF by" }), el("dd", {}, [el("strong", { text: human(edf) }), el("span", { class: "muted", text: " " + rel(E.daysBetween(t, edf)) })]),
      el("dt", { text: "Chase payment from" }), el("dd", { text: human(chase) }),
      el("dt", { text: "Get paid by" }), el("dd", {}, [el("strong", { text: human(real) }), el("span", { class: "muted", text: inr ? " (12 months, INR)" : " (9 months)" })])
    ]);
    out.appendChild(dl);
  }

  // ---------- Dashboard ----------
  function render() {
    var t = today();
    var invs = state.invoices;
    var batches = E.buildBatches(invs, state.filings, t);
    $("empty").hidden = invs.length > 0;
    $("invoice-section").hidden = invs.length === 0;
    renderStats(batches, t);
    renderBatches(batches, t);
    renderTable(t);
  }

  function renderStats(batches, t) {
    var s = $("stats");
    s.textContent = "";
    if (!state.invoices.length) return;
    var pending = batches.filter(function (b) { return b.inScope && !b.filed; }).sort(function (a, b) { return a.edfDue < b.edfDue ? -1 : 1; });
    var next = pending[0];
    var unpaid = state.invoices.filter(function (i) { return !i.paidDate; });
    var overdueEdf = pending.filter(function (b) { return b.status === "overdue"; }).length;
    var overduePay = unpaid.filter(function (i) { return E.invoiceView(i, t).realisationStatus === "overdue" && E.inScope(i.date); }).length;
    function stat(label, value, sub, tone) {
      return el("div", { class: "stat card" + (tone ? " " + tone : "") }, [el("p", { class: "stat-label", text: label }), el("p", { class: "stat-value", text: value }), sub ? el("p", { class: "stat-sub", text: sub }) : null]);
    }
    s.appendChild(stat("Next EDF due", next ? human(next.edfDue) : "All filed", next ? monthName(next.month) + " · " + rel(next.daysLeft) : "Nothing pending", next && next.status !== "upcoming" ? next.status : ""));
    s.appendChild(stat("EDFs not yet filed", String(pending.length), overdueEdf ? overdueEdf + " overdue" : "none overdue", overdueEdf ? "overdue" : ""));
    s.appendChild(stat("Invoices awaiting payment", String(unpaid.length), overduePay ? overduePay + " past realisation date" : "none past 9-month limit", overduePay ? "overdue" : ""));
  }

  function renderBatches(batches, t) {
    var wrap = $("batches");
    wrap.textContent = "";
    if (!batches.length) return;
    wrap.appendChild(el("h3", { class: "sub", text: "Monthly EDFs" }));
    batches.forEach(function (b) {
      var total = {};
      b.invoices.forEach(function (i) { total[i.currency] = (total[i.currency] || 0) + Number(i.amount); });
      var totals = Object.keys(total).map(function (c) { return money(c, total[c]); }).join(" + ");
      var head = el("div", { class: "batch-head" }, [
        el("div", {}, [
          el("h4", { text: monthName(b.month) + " EDF" }),
          el("p", { class: "muted small", text: b.invoices.length + " invoice" + (b.invoices.length === 1 ? "" : "s") + " · " + totals })
        ]),
        el("span", { class: "pill " + b.status, text: STATUS_LABEL[b.status] })
      ]);
      var info;
      if (!b.inScope) info = "These invoices are dated before 1 October 2026. Check with your bank whether an EDF is needed.";
      else if (b.filed) info = "Filed on " + human(b.filed.filedOn) + (b.filed.ref ? " · Ref " + b.filed.ref : "") + ".";
      else info = "Due " + human(b.edfDue) + " (" + rel(b.daysLeft) + "). One EDF covers all invoices below." + (b.hasNonSoftware ? " Non-software services may also be filed on or before the payment date." : "");
      var actions = el("div", { class: "batch-actions" }, [
        el("button", { class: "btn small", type: "button", text: "Download Part 2B CSV", onclick: function () { downloadCsv(b); } }),
        b.inScope ? (b.filed
          ? el("button", { class: "btn small", type: "button", text: "Mark as not filed", onclick: function () { delete state.filings[b.month]; save(); render(); toast("Marked as not filed."); } })
          : el("button", { class: "btn small primary", type: "button", text: "Mark EDF filed", onclick: function () { openFiling(b.month); } })) : null
      ]);
      wrap.appendChild(el("article", { class: "batch card " + b.status }, [head, el("p", { class: "batch-info", text: info }), actions]));
    });
  }

  function renderTable(t) {
    var body = $("inv-body");
    body.textContent = "";
    state.invoices.slice().sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; }).forEach(function (i) {
      var v = E.invoiceView(i, t);
      var status = i.paidDate ? "done" : (v.inScope ? v.realisationStatus : "pre-rules");
      var statusText = i.paidDate ? "Paid " + human(i.paidDate) : (v.inScope ? (status === "overdue" ? "Payment overdue" : "Awaiting payment · " + rel(v.daysToRealise)) : "Before new rules");
      var smallNote = v.small === true ? "≤ ₹10 lakh: can close on your declaration" : v.small === false ? "> ₹10 lakh: bank needs payment evidence" : "";
      body.appendChild(el("tr", {}, [
        el("td", { "data-label": "Invoice" }, [el("strong", { text: i.number }), el("br"), el("span", { class: "muted small", text: human(i.date) + " · " + (i.category === "software" ? "Software" : "Other services") })]),
        el("td", { "data-label": "Client", text: i.client + (i.country ? " (" + i.country + ")" : "") }),
        el("td", { "data-label": "Amount" }, [document.createTextNode(money(i.currency, i.amount)), smallNote ? el("br") : null, smallNote ? el("span", { class: "muted small", text: smallNote }) : null]),
        el("td", { "data-label": "EDF due", text: v.inScope ? human(v.edfDue) : "—" }),
        el("td", { "data-label": "Get paid by", text: v.inScope ? human(v.realisationDue) : "—" }),
        el("td", { "data-label": "Status" }, [el("span", { class: "pill " + status, text: statusText })]),
        el("td", { class: "row-actions" }, [
          i.paidDate ? null : el("button", { class: "btn small", type: "button", text: "Mark paid", "aria-label": "Mark invoice " + i.number + " paid today", onclick: function () { i.paidDate = today(); if (i.paidDate < i.date) i.advance = true; save(); render(); toast("Marked " + i.number + " as paid today."); } }),
          el("button", { class: "btn small", type: "button", text: "Edit", "aria-label": "Edit invoice " + i.number, onclick: function () { openForm(i); } }),
          el("button", { class: "btn small danger", type: "button", text: "Delete", "aria-label": "Delete invoice " + i.number, onclick: function () { if (confirm("Delete invoice " + i.number + "?")) { state.invoices = state.invoices.filter(function (x) { return x.id !== i.id; }); save(); render(); toast("Invoice deleted."); } } })
        ])
      ]));
    });
  }

  // ---------- Invoice form ----------
  var FORM_FIELDS = ["number", "date", "client", "country", "address", "currency", "amount", "inrValue", "netRealisable", "sac", "contract", "description", "bank", "paidDate"];
  function openForm(inv) {
    editingId = inv ? inv.id : null;
    $("dlg-title").textContent = inv ? "Edit invoice " + inv.number : "Add invoice";
    var last = state.invoices[state.invoices.length - 1];
    FORM_FIELDS.forEach(function (f) { $("f-" + f).value = inv && inv[f] !== undefined ? inv[f] : ""; });
    $("f-currency").value = inv ? inv.currency : (last ? last.currency : "USD");
    if (!inv) { $("f-date").value = today(); if (last) { $("f-bank").value = last.bank || ""; $("f-sac").value = last.sac || ""; } }
    var cat = inv ? inv.category : (last ? last.category : "software");
    document.querySelectorAll('input[name="category"]').forEach(function (r) { r.checked = r.value === cat; });
    $("f-advance").checked = !!(inv && inv.advance);
    clearErrors();
    toggleInr();
    $("inv-dialog").showModal();
    $("f-number").focus();
  }
  function clearErrors() {
    document.querySelectorAll("#inv-form .err").forEach(function (e) { e.textContent = ""; });
    document.querySelectorAll("#inv-form [aria-invalid]").forEach(function (e) { e.removeAttribute("aria-invalid"); });
  }
  function toggleInr() { $("inr-field").hidden = $("f-currency").value === "INR"; }
  function readForm() {
    var inv = {};
    FORM_FIELDS.forEach(function (f) { var v = $("f-" + f).value.trim(); if (v !== "") inv[f] = v; });
    var cat = document.querySelector('input[name="category"]:checked');
    inv.category = cat ? cat.value : "";
    if ($("f-advance").checked) inv.advance = true;
    ["amount", "inrValue", "netRealisable"].forEach(function (f) { if (inv[f]) inv[f] = inv[f].replace(/[,\s₹$€£]/g, ""); });
    if (inv.currency === "INR") delete inv.inrValue;
    return inv;
  }
  function submitForm(ev) {
    ev.preventDefault();
    clearErrors();
    var inv = readForm();
    var errs = E.validateInvoice(inv);
    var dup = state.invoices.some(function (x) { return x.number.toLowerCase() === (inv.number || "").toLowerCase() && x.id !== editingId; });
    if (dup) errs.number = "You already have an invoice with this number.";
    var keys = Object.keys(errs);
    if (keys.length) {
      keys.forEach(function (k) {
        var e = $("e-" + k); if (e) e.textContent = errs[k];
        var f = $("f-" + k); if (f) f.setAttribute("aria-invalid", "true");
      });
      var first = $("f-" + keys[0]) || document.querySelector('input[name="category"]');
      if (first) first.focus();
      return;
    }
    if (editingId) {
      inv.id = editingId;
      state.invoices = state.invoices.map(function (x) { return x.id === editingId ? inv : x; });
    } else {
      inv.id = E.uid();
      state.invoices.push(inv);
    }
    save();
    $("inv-dialog").close();
    render();
    toast(editingId ? "Invoice updated." : "Invoice " + inv.number + " added. EDF due " + human(E.edfDue(inv.date)) + ".");
    editingId = null;
  }

  // ---------- Filing ----------
  function openFiling(month) {
    filingMonth = month;
    $("file-title").textContent = "Mark " + monthName(month) + " EDF as filed";
    $("ff-date").value = today();
    $("ff-ref").value = "";
    $("e-ff-date").textContent = "";
    $("file-dialog").showModal();
  }
  function submitFiling(ev) {
    ev.preventDefault();
    var d = $("ff-date").value;
    if (!E.parseDate(d)) { $("e-ff-date").textContent = "Enter the date you filed."; return; }
    state.filings[filingMonth] = { filedOn: d, ref: $("ff-ref").value.trim().slice(0, 80) };
    save();
    $("file-dialog").close();
    render();
    toast(monthName(filingMonth) + " EDF marked as filed.");
  }

  // ---------- Files ----------
  function download(name, mime, text) {
    var blob = new Blob([text], { type: mime });
    var a = el("a", { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function downloadCsv(b) { download("EDF-Part2B-" + b.month + ".csv", "text/csv;charset=utf-8", "\ufeff" + E.part2bCsv(b.invoices)); toast("CSV downloaded for " + monthName(b.month) + "."); }
  function stampNow() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"); }

  function bind() {
    var cur = $("f-currency");
    E.CURRENCIES.forEach(function (c) { cur.appendChild(el("option", { value: c, text: c === "OTHER" ? "Other" : c })); });
    cur.addEventListener("change", toggleInr);

    $("qc-date").addEventListener("input", renderCalc);
    document.querySelectorAll('input[name="qc-cur"]').forEach(function (r) { r.addEventListener("change", renderCalc); });
    $("quick-calc").addEventListener("submit", function (e) { e.preventDefault(); });
    $("qc-date").value = today();
    renderCalc();

    $("add-btn").addEventListener("click", function () { openForm(null); });
    $("empty-add").addEventListener("click", function () { openForm(null); });
    $("inv-form").addEventListener("submit", submitForm);
    $("dlg-cancel").addEventListener("click", function () { $("inv-dialog").close(); });
    $("dlg-close").addEventListener("click", function () { $("inv-dialog").close(); });
    $("file-form").addEventListener("submit", submitFiling);
    $("file-cancel").addEventListener("click", function () { $("file-dialog").close(); });
    $("file-close").addEventListener("click", function () { $("file-dialog").close(); });

    $("ics-btn").addEventListener("click", function () {
      if (!state.invoices.length) { toast("Add an invoice first — there are no deadlines yet.", true); return; }
      download("edf-deadlines.ics", "text/calendar;charset=utf-8", E.buildIcs(state.invoices, state.filings, today(), stampNow()));
      toast("Calendar file downloaded. Open it to add reminders (5 days before each deadline).");
    });
    $("export-btn").addEventListener("click", function () {
      download("edf-tracker-backup-" + today() + ".json", "application/json", JSON.stringify({ version: 1, exported: today(), invoices: state.invoices, filings: state.filings }, null, 2));
      toast("Backup downloaded.");
    });
    $("import-file").addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!f) return;
      if (f.size > 5 * 1024 * 1024) { toast("That file is too large to be a backup.", true); return; }
      f.text().then(function (txt) {
        var r = E.parseBackup(txt);
        if (!r.ok) { toast(r.error, true); return; }
        if (state.invoices.length && !confirm("Replace your current " + state.invoices.length + " invoices with the " + r.data.invoices.length + " in this backup?")) return;
        state = r.data; save(); render(); toast("Restored " + state.invoices.length + " invoices.");
      });
    });
    function demo() {
      if (state.invoices.length && !confirm("Replace your data with sample invoices?")) return;
      state = sample(); save(); render(); toast("Sample data loaded. Delete it any time from Backup → Delete all data.");
      $("batches").scrollIntoView({ behavior: "smooth", block: "start" });
    }
    $("demo-btn").addEventListener("click", demo);
    $("empty-demo").addEventListener("click", demo);
    $("clear-btn").addEventListener("click", function () {
      if (!state.invoices.length) { toast("Nothing to delete."); return; }
      if (confirm("Delete all invoices and filings from this browser? Download a backup first if you need it.")) { state = { invoices: [], filings: {} }; save(); render(); toast("All data deleted."); }
    });
  }

  function sample() {
    var t = E.parseDate(today());
    function ago(m, d) { var x = E.addMonths(t, -m); x = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), d)); return E.fmt(x); }
    var invs = [
      { number: "INV-2026-031", date: ago(0, 2), client: "Northwind Labs", country: "United States", currency: "USD", amount: "2400", inrValue: "211000", category: "software", sac: "998314", description: "Web app development", bank: "HDFC Bank" },
      { number: "INV-2026-032", date: ago(0, 5), client: "Brightside GmbH", country: "Germany", currency: "EUR", amount: "1500", inrValue: "146000", category: "other", sac: "998311", description: "Product strategy consulting", bank: "HDFC Bank" },
      { number: "INV-2026-029", date: ago(1, 12), client: "Northwind Labs", country: "United States", currency: "USD", amount: "2400", inrValue: "211000", category: "software", sac: "998314", description: "Web app development", bank: "HDFC Bank" }
    ].filter(function (i) { return i.date <= today(); });
    invs.forEach(function (i) { i.id = E.uid(); });
    return { invoices: invs, filings: {} };
  }


  function bindCoverage() {
    var form = $("cov-form"), out = $("cov-out");
    if (!form) return;
    function val(name) { var c = form.querySelector('input[name="' + name + '"]:checked'); return c ? c.value : ""; }
    form.addEventListener("change", function () {
      var who = val("cov-who"), bill = val("cov-bill");
      out.textContent = "";
      if (!who || !bill) { out.appendChild(el("p", { class: "muted", text: who || bill ? "Answer the other question too." : "Answer both questions to see your result." })); return; }
      var r = E.coverage(who, bill);
      if (!r) return;
      var box = el("div", { class: "cov-result " + r.level }, [
        el("h3", { text: r.title }),
        el("ul", null, r.points.map(function (p) { return el("li", { text: p }); }))
      ]);
      box.appendChild(el("p", { class: "small" }, [r.level === "not-required" ? "You can still use the tracker below to log invoices and payment deadlines. " : "Use the tracker below to log invoices and get your monthly due dates. ", el("a", { href: "#tracker", text: "Go to the tracker" })]));
      out.appendChild(box);
    });
    form.addEventListener("submit", function (e) { e.preventDefault(); });
  }

  bind();
  bindCoverage();
  render();
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(function () { /* offline cache is optional */ });
  }
})();
