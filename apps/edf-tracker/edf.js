/*
 * EDF Tracker — pure date/rule logic (no DOM). Works in the browser
 * (window.EDF) and in Node (module.exports) so it can be unit tested.
 *
 * Rules implemented (FEMA Export & Import of Goods and Services Regulations,
 * 2026, effective 1 Oct 2026, as amended 22 Sep 2026):
 *  - Services EDF due within 30 days from the END of the invoice month.
 *  - One EDF may cover all invoices of a month (any number of recipients).
 *  - Realisation: 9 months from invoice date; 12 months if invoiced/settled in INR.
 *  - Invoices up to Rs 10 lakh: EDPMS entry can be closed on the exporter's
 *    declaration (singly or quarterly in bulk).
 * Dates are handled as plain calendar dates (YYYY-MM-DD) in UTC to avoid
 * timezone drift.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.EDF = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var EFFECTIVE_FROM = "2026-10-01";
  var SMALL_INVOICE_LIMIT_INR = 1000000; // Rs 10 lakh
  var EDF_DAYS_AFTER_MONTH_END = 30;
  var REALISATION_MONTHS = 9;
  var REALISATION_MONTHS_INR = 12;
  var CHASE_MONTHS = 6;

  var ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  function parseDate(s) {
    if (typeof s !== "string") return null;
    var m = s.trim().match(ISO_RE);
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || y < 1900 || y > 2200) return null;
    var dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null; // e.g. 2026-02-30
    return dt;
  }

  function fmt(dt) {
    var y = dt.getUTCFullYear();
    var m = String(dt.getUTCMonth() + 1).padStart(2, "0");
    var d = String(dt.getUTCDate()).padStart(2, "0");
    return y + "-" + m + "-" + d;
  }

  function addDays(dt, n) {
    return new Date(dt.getTime() + n * 86400000);
  }

  function lastDayOfMonth(y, m0) {
    return new Date(Date.UTC(y, m0 + 1, 0));
  }

  // Add calendar months, clamping to the last day of the target month
  // (31 Jan + 1 month = 28/29 Feb).
  function addMonths(dt, n) {
    var y = dt.getUTCFullYear(), m0 = dt.getUTCMonth() + n, d = dt.getUTCDate();
    var ty = y + Math.floor(m0 / 12), tm = ((m0 % 12) + 12) % 12;
    var last = lastDayOfMonth(ty, tm).getUTCDate();
    return new Date(Date.UTC(ty, tm, Math.min(d, last)));
  }

  function monthKey(isoDate) {
    var dt = parseDate(isoDate);
    return dt ? isoDate.slice(0, 7) : null;
  }

  function edfDueForMonth(key) {
    var m = String(key || "").match(/^(\d{4})-(\d{2})$/);
    if (!m) return null;
    var end = lastDayOfMonth(+m[1], +m[2] - 1);
    return fmt(addDays(end, EDF_DAYS_AFTER_MONTH_END));
  }

  function edfDue(invoiceDate) {
    var k = monthKey(invoiceDate);
    return k ? edfDueForMonth(k) : null;
  }

  function realisationDue(invoiceDate, invoicedInInr) {
    var dt = parseDate(invoiceDate);
    if (!dt) return null;
    return fmt(addMonths(dt, invoicedInInr ? REALISATION_MONTHS_INR : REALISATION_MONTHS));
  }

  function chaseDate(invoiceDate) {
    var dt = parseDate(invoiceDate);
    return dt ? fmt(addMonths(dt, CHASE_MONTHS)) : null;
  }

  function inScope(invoiceDate) {
    return !!parseDate(invoiceDate) && invoiceDate >= EFFECTIVE_FROM;
  }

  function daysBetween(fromIso, toIso) {
    var a = parseDate(fromIso), b = parseDate(toIso);
    if (!a || !b) return null;
    return Math.round((b - a) / 86400000);
  }

  function inrValue(inv) {
    if (!inv) return null;
    if (inv.currency === "INR") return toNum(inv.amount);
    return toNum(inv.inrValue);
  }

  function toNum(v) {
    if (v === "" || v === null || v === undefined) return null;
    var n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
    return isFinite(n) ? n : null;
  }

  function smallInvoice(inv) {
    var v = inrValue(inv);
    return v === null ? null : v <= SMALL_INVOICE_LIMIT_INR;
  }

  // Deadline status relative to `today` (ISO string).
  function deadlineStatus(dueIso, today, done) {
    if (done) return "done";
    var d = daysBetween(today, dueIso);
    if (d === null) return "unknown";
    if (d < 0) return "overdue";
    if (d <= 7) return "due-soon";
    return "upcoming";
  }

  var CURRENCIES = ["USD", "EUR", "GBP", "AUD", "CAD", "SGD", "AED", "CHF", "JPY", "NZD", "INR", "OTHER"];

  function validateInvoice(inv) {
    var errors = {};
    if (!inv || typeof inv !== "object") return { _: "Invalid invoice" };
    if (!str(inv.number)) errors.number = "Invoice number is required.";
    else if (inv.number.length > 60) errors.number = "Keep the invoice number under 60 characters.";
    if (!parseDate(inv.date)) errors.date = "Enter a valid invoice date.";
    if (!str(inv.client)) errors.client = "Client name is required.";
    else if (inv.client.length > 120) errors.client = "Keep the client name under 120 characters.";
    if (CURRENCIES.indexOf(inv.currency) === -1) errors.currency = "Pick a currency.";
    var amt = toNum(inv.amount);
    if (amt === null || amt <= 0) errors.amount = "Amount must be a positive number.";
    if (inv.inrValue !== undefined && inv.inrValue !== "" && inv.inrValue !== null) {
      var iv = toNum(inv.inrValue);
      if (iv === null || iv < 0) errors.inrValue = "INR value must be a positive number.";
    }
    if (inv.netRealisable !== undefined && inv.netRealisable !== "" && inv.netRealisable !== null) {
      var nr = toNum(inv.netRealisable);
      if (nr === null || nr < 0) errors.netRealisable = "Net realisable value must be a positive number.";
    }
    if (inv.category !== "software" && inv.category !== "other") errors.category = "Pick a service type.";
    if (inv.paidDate && !parseDate(inv.paidDate)) errors.paidDate = "Enter a valid payment date.";
    if (inv.paidDate && parseDate(inv.date) && inv.paidDate < inv.date && !inv.advance)
      errors.paidDate = "Payment date is before the invoice date. Tick 'advance' if this was an advance.";
    if (inv.sac && !/^\d{4,8}$/.test(String(inv.sac).trim())) errors.sac = "SAC is usually a 6-digit number (e.g. 998314).";
    return errors;
  }

  function str(v) {
    return typeof v === "string" && v.trim().length > 0;
  }

  // Group invoices into monthly EDF batches.
  function buildBatches(invoices, filings, today) {
    filings = filings || {};
    var map = {};
    (invoices || []).forEach(function (inv) {
      var k = monthKey(inv.date);
      if (!k) return;
      if (!map[k]) map[k] = { month: k, invoices: [] };
      map[k].invoices.push(inv);
    });
    return Object.keys(map).sort().reverse().map(function (k) {
      var b = map[k];
      var scoped = b.invoices.some(function (i) { return inScope(i.date); });
      var filing = filings[k] || null;
      var due = edfDueForMonth(k);
      b.edfDue = due;
      b.inScope = scoped;
      b.filed = filing && filing.filedOn ? filing : null;
      b.status = scoped ? deadlineStatus(due, today, !!b.filed) : "pre-rules";
      b.daysLeft = daysBetween(today, due);
      b.hasNonSoftware = b.invoices.some(function (i) { return i.category === "other"; });
      return b;
    });
  }

  function invoiceView(inv, today) {
    var real = realisationDue(inv.date, inv.currency === "INR");
    var paid = !!inv.paidDate;
    return {
      edfDue: edfDue(inv.date),
      realisationDue: real,
      chaseOn: chaseDate(inv.date),
      inScope: inScope(inv.date),
      small: smallInvoice(inv),
      realisationStatus: deadlineStatusLong(real, today, paid),
      daysToRealise: daysBetween(today, real)
    };
  }

  // Realisation uses a 30-day "soon" window because it is a months-long clock.
  function deadlineStatusLong(dueIso, today, done) {
    if (done) return "done";
    var d = daysBetween(today, dueIso);
    if (d === null) return "unknown";
    if (d < 0) return "overdue";
    if (d <= 30) return "due-soon";
    return "upcoming";
  }

  // ---------- Exports ----------
  function csvCell(v) {
    var s = v === null || v === undefined ? "" : String(v);
    // Neutralise spreadsheet formula injection.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  var PART2B_HEADERS = ["Recipient name", "Recipient address", "Recipient country", "Invoice number", "Invoice date",
    "Currency", "Invoice amount", "Net realisable value", "Contract no. / date", "Description of services", "SAC",
    "Service type", "INR value (approx)", "Payment received on"];

  function part2bCsv(invoices) {
    var rows = [PART2B_HEADERS];
    (invoices || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; })
      .forEach(function (i) {
        rows.push([i.client, i.address || "", i.country || "", i.number, i.date, i.currency, i.amount,
          i.netRealisable === undefined || i.netRealisable === "" ? i.amount : i.netRealisable,
          i.contract || "", i.description || "", i.sac || "",
          i.category === "software" ? "Software" : "Other services",
          i.currency === "INR" ? i.amount : (i.inrValue || ""), i.paidDate || ""]);
      });
    return rows.map(function (r) { return r.map(csvCell).join(","); }).join("\r\n") + "\r\n";
  }

  function icsEscape(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  }

  function icsDate(iso) { return iso.replace(/-/g, ""); }

  function fold(line) {
    // RFC 5545: lines should not exceed 75 octets; fold with CRLF + space.
    var out = [];
    while (line.length > 74) { out.push(line.slice(0, 74)); line = " " + line.slice(74); }
    out.push(line);
    return out.join("\r\n");
  }

  function buildIcs(invoices, filings, today, stamp) {
    var dtstamp = (stamp || "20261001T000000Z");
    var lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//EDF Tracker//Product Factory//EN", "CALSCALE:GREGORIAN",
      "X-WR-CALNAME:EDF & realisation deadlines"];
    function ev(uid, date, summary, desc) {
      var next = fmt(addDays(parseDate(date), 1));
      lines.push("BEGIN:VEVENT", "UID:" + uid + "@edf-tracker", "DTSTAMP:" + dtstamp,
        "DTSTART;VALUE=DATE:" + icsDate(date), "DTEND;VALUE=DATE:" + icsDate(next),
        fold("SUMMARY:" + icsEscape(summary)), fold("DESCRIPTION:" + icsEscape(desc)),
        "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + icsEscape(summary), "TRIGGER:-P5D", "END:VALARM",
        "END:VEVENT");
    }
    buildBatches(invoices, filings, today).forEach(function (b) {
      if (!b.inScope || b.filed) return;
      ev("edf-" + b.month, b.edfDue, "File EDF for " + b.month + " invoices (" + b.invoices.length + ")",
        "Submit one Export Declaration Form to your AD bank covering all " + b.month +
        " export invoices. Generated by EDF Tracker; verify with your bank.");
    });
    (invoices || []).forEach(function (i) {
      if (i.paidDate || !inScope(i.date)) return;
      var v = invoiceView(i, today);
      ev("chase-" + i.id, v.chaseOn, "Chase payment: invoice " + i.number + " (" + i.client + ")",
        "Six months since invoice date. Realisation deadline is " + v.realisationDue + ".");
      ev("real-" + i.id, v.realisationDue, "Realisation deadline: invoice " + i.number,
        "Full export value should be realised by today, or request an extension from your AD bank before this date.");
    });
    lines.push("END:VCALENDAR");
    return lines.join("\r\n") + "\r\n";
  }

  // Validate an imported backup; returns {ok, data|error}.
  function parseBackup(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) { return { ok: false, error: "That file is not valid JSON." }; }
    if (!data || typeof data !== "object" || !Array.isArray(data.invoices))
      return { ok: false, error: "That file does not look like an EDF Tracker backup." };
    if (data.invoices.length > 5000) return { ok: false, error: "Backup has too many invoices (max 5000)." };
    var clean = [];
    for (var i = 0; i < data.invoices.length; i++) {
      var inv = sanitizeInvoice(data.invoices[i]);
      var errs = validateInvoice(inv);
      if (Object.keys(errs).length) return { ok: false, error: "Invoice #" + (i + 1) + ": " + errs[Object.keys(errs)[0]] };
      clean.push(inv);
    }
    var filings = {};
    if (data.filings && typeof data.filings === "object") {
      Object.keys(data.filings).forEach(function (k) {
        var f = data.filings[k];
        if (/^\d{4}-\d{2}$/.test(k) && f && parseDate(f.filedOn))
          filings[k] = { filedOn: f.filedOn, ref: String(f.ref || "").slice(0, 80) };
      });
    }
    return { ok: true, data: { invoices: clean, filings: filings } };
  }

  var FIELDS = ["id", "number", "date", "client", "address", "country", "currency", "amount", "inrValue",
    "netRealisable", "category", "sac", "description", "contract", "bank", "paidDate", "advance", "notes"];

  function sanitizeInvoice(raw) {
    var out = {};
    if (!raw || typeof raw !== "object") return out;
    FIELDS.forEach(function (f) {
      var v = raw[f];
      if (v === undefined || v === null) return;
      if (f === "advance") { out[f] = !!v; return; }
      out[f] = String(v).slice(0, 500);
    });
    if (!out.id) out.id = uid();
    return out;
  }

  function uid() {
    return "i" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  return {
    EFFECTIVE_FROM: EFFECTIVE_FROM, SMALL_INVOICE_LIMIT_INR: SMALL_INVOICE_LIMIT_INR, CURRENCIES: CURRENCIES,
    parseDate: parseDate, fmt: fmt, addMonths: addMonths, edfDue: edfDue, edfDueForMonth: edfDueForMonth,
    realisationDue: realisationDue, chaseDate: chaseDate, inScope: inScope, daysBetween: daysBetween,
    smallInvoice: smallInvoice, inrValue: inrValue, deadlineStatus: deadlineStatus, validateInvoice: validateInvoice,
    buildBatches: buildBatches, invoiceView: invoiceView, part2bCsv: part2bCsv, buildIcs: buildIcs,
    parseBackup: parseBackup, sanitizeInvoice: sanitizeInvoice, uid: uid, csvCell: csvCell
  };
});
