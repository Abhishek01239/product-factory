// Run: node --test apps/edf-tracker/tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../edf.js");

test("EDF due = 30 days after end of invoice month (examples from published guidance)", () => {
  assert.equal(E.edfDue("2026-10-12"), "2026-11-30");
  assert.equal(E.edfDue("2026-10-20"), "2026-11-30");
  assert.equal(E.edfDue("2026-10-31"), "2026-11-30");
  assert.equal(E.edfDue("2026-11-14"), "2026-12-30");
  assert.equal(E.edfDue("2026-12-10"), "2027-01-30");
  assert.equal(E.edfDue("2027-01-05"), "2027-03-02");
  assert.equal(E.edfDue("2028-01-05"), "2028-03-01"); // leap year
});

test("realisation: 9 months, 12 months for INR invoices, month-end clamping", () => {
  assert.equal(E.realisationDue("2026-10-15", false), "2027-07-15");
  assert.equal(E.realisationDue("2026-10-15", true), "2027-10-15");
  assert.equal(E.realisationDue("2027-05-31", false), "2028-02-29");
  assert.equal(E.realisationDue("2026-11-30", false), "2027-08-30");
  assert.equal(E.chaseDate("2026-10-15"), "2027-04-15");
});

test("date parsing rejects impossible dates", () => {
  assert.equal(E.parseDate("2026-02-30"), null);
  assert.equal(E.parseDate("2026-13-01"), null);
  assert.equal(E.parseDate("hello"), null);
  assert.equal(E.edfDue("bad"), null);
});

test("scope: invoices from 1 Oct 2026", () => {
  assert.equal(E.inScope("2026-09-30"), false);
  assert.equal(E.inScope("2026-10-01"), true);
});

test("small invoice threshold Rs 10 lakh", () => {
  assert.equal(E.smallInvoice({ currency: "INR", amount: "1000000" }), true);
  assert.equal(E.smallInvoice({ currency: "INR", amount: "1000001" }), false);
  assert.equal(E.smallInvoice({ currency: "USD", amount: "5000", inrValue: "440000" }), true);
  assert.equal(E.smallInvoice({ currency: "USD", amount: "5000" }), null);
});

test("deadline status", () => {
  assert.equal(E.deadlineStatus("2026-11-30", "2026-10-07", false), "upcoming");
  assert.equal(E.deadlineStatus("2026-11-30", "2026-11-25", false), "due-soon");
  assert.equal(E.deadlineStatus("2026-11-30", "2026-12-01", false), "overdue");
  assert.equal(E.deadlineStatus("2026-11-30", "2026-12-01", true), "done");
});

const good = { id: "a", number: "INV-1", date: "2026-10-03", client: "Acme Inc", currency: "USD", amount: "1200", category: "software" };

test("validation", () => {
  assert.deepEqual(E.validateInvoice(good), {});
  const e = E.validateInvoice({ ...good, number: "", amount: "-5", date: "2026-02-31", category: "x", sac: "abc" });
  assert.ok(e.number && e.amount && e.date && e.category && e.sac);
  assert.ok(E.validateInvoice({ ...good, paidDate: "2026-09-01" }).paidDate);
  assert.deepEqual(E.validateInvoice({ ...good, paidDate: "2026-09-01", advance: true }), {});
});

test("batches group by month and respect filings", () => {
  const invs = [good, { ...good, id: "b", number: "INV-2", date: "2026-10-22" }, { ...good, id: "c", number: "INV-3", date: "2026-11-02", category: "other" }];
  const b = E.buildBatches(invs, { "2026-10": { filedOn: "2026-11-10" } }, "2026-11-25");
  assert.equal(b.length, 2);
  assert.equal(b[0].month, "2026-11");
  assert.equal(b[0].status, "upcoming");
  assert.equal(b[0].hasNonSoftware, true);
  assert.equal(b[1].invoices.length, 2);
  assert.equal(b[1].status, "done");
  const pre = E.buildBatches([{ ...good, date: "2026-09-15" }], {}, "2026-10-07");
  assert.equal(pre[0].status, "pre-rules");
});

test("CSV export escapes and neutralises formulas", () => {
  const csv = E.part2bCsv([{ ...good, client: '=HYPERLINK("x")', description: 'Dev, "QA"\nwork' }]);
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(csv.includes('"Dev, ""QA""\nwork"'));
  assert.ok(csv.startsWith("Recipient name,"));
});

test("ICS has EDF + realisation events and skips filed months", () => {
  const ics = E.buildIcs([good], {}, "2026-10-07");
  assert.ok(ics.includes("BEGIN:VCALENDAR"));
  assert.ok(ics.includes("DTSTART;VALUE=DATE:20261130"));
  assert.ok(ics.includes("DTSTART;VALUE=DATE:20270703"));
  assert.ok(ics.includes("DTSTART;VALUE=DATE:20270403"));
  const filed = E.buildIcs([good], { "2026-10": { filedOn: "2026-10-30" } }, "2026-10-07");
  assert.ok(!filed.includes("UID:edf-2026-10"));
  assert.ok(E.buildIcs([{ ...good, client: "A, B; C" }], {}, "2026-10-07").includes("A\\, B\\; C"));
});

test("backup import validates and strips unknown fields", () => {
  assert.equal(E.parseBackup("nope").ok, false);
  assert.equal(E.parseBackup("{}").ok, false);
  const r = E.parseBackup(JSON.stringify({ invoices: [{ ...good, evil: "<script>" }], filings: { "2026-10": { filedOn: "2026-11-01", ref: "X" }, bad: 1 } }));
  assert.equal(r.ok, true);
  assert.equal(r.data.invoices[0].evil, undefined);
  assert.deepEqual(Object.keys(r.data.filings), ["2026-10"]);
  const bad = E.parseBackup(JSON.stringify({ invoices: [{ ...good, amount: "x" }] }));
  assert.equal(bad.ok, false);
});

test("coverage: reflects RBI 7 Oct 2026 clarification and rejects bad input", () => {
  assert.equal(E.coverage("entity", "large").level, "required");
  assert.equal(E.coverage("business", "unsure").level, "unclear");
  const ind = E.coverage("individual", "small");
  assert.equal(ind.level, "not-required");
  assert.ok(ind.points.some((p) => p.includes("self-declaration")));
  assert.ok(ind.points.some((p) => p.includes("bank")));
  assert.ok(E.coverage("entity", "unsure").points.some((p) => p.includes("per bill")));
  assert.equal(E.coverage("robot", "small"), null);
  assert.equal(E.coverage("individual", "<script>"), null);
  assert.equal(E.CLARIFIED_ON, "2026-10-07");
});
