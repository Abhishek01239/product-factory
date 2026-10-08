# EDF Tracker

Free, private deadline tracker for India's new **Export Declaration Form (EDF)** requirement for service exports
(FEMA Export & Import of Goods and Services Regulations, 2026 — effective **1 October 2026**).

**Live:** https://abhishek01239.github.io/product-factory/edf-tracker/

## Problem
From 1 Oct 2026 Indian service exporters must file an EDF with their AD bank within 30 days of the end of the
invoice month, and realise payment within 9 months (12 if invoiced in INR). On 7 Oct 2026 RBI said publicly that
individuals with forex transactions of a personal nature (examples given: tutoring, small software work) are not
required to report, and that small exporters with bills up to ₹10 lakh can use a self-declaration with the invoice.
Written RBI FAQs are pending, so many freelancers and small businesses still do not know whether they must file.

## What it does
- **Do I need to file?** (v1.1): two-question checker (how you invoice × invoice size) giving hedged guidance based on RBI's 7 Oct 2026 statements: companies/LLPs/firms → file; proprietorships → unclear, ask bank; individuals → probably not. Logic in `edf.js → coverage()`, unit-tested.
- Quick deadline check: pick an invoice date → EDF due date, 6-month chase date, realisation deadline.
- Log invoices (Part 2B fields: recipient, country, invoice no/date, currency, amount, net realisable value, contract, description, SAC).
- Groups invoices into **one EDF per month**, shows status (upcoming / due soon / overdue / filed), lets you mark filed with a bank reference.
- Tracks the **9-month / 12-month realisation** window per invoice and flags the ₹10 lakh self-declaration closure route.
- Exports: **Part 2B CSV** per month (formula-injection safe), **.ics calendar** reminders (alarm 5 days before), JSON backup/restore.
- Flags invoices dated before 1 Oct 2026 ("before new rules").

## Privacy & security
- 100% client-side. Data lives in `localStorage` on the user's device. No server, cookies, analytics or third-party scripts.
- Strict CSP (`connect-src 'none'`), all user data rendered via `textContent`, imports validated and whitelisted.
- Service worker caches static assets for offline use.

## Run locally
```bash
python3 -m http.server 8000 --directory apps   # open http://localhost:8000/edf-tracker/
node --test apps/edf-tracker/tests/            # rule/unit tests
```

## Files
`index.html` (UI + content/SEO), `edf.js` (pure rule logic, unit-tested), `app.js` (UI), `styles.css`, `sw.js`, icons, `og.png`.

## Rule notes / limitations
- RBI's 7 Oct 2026 clarification was oral (press conference); update `coverage()` and the page copy when RBI publishes its FAQs.
- Non-software services may also file "on or before the date of receipt of payment"; guidance differs on whether this replaces the 30-day limit, so the tracker shows the 30-day date as the conservative outer deadline.
- Bank SOPs were still being published in Oct 2026; procedures for payment platforms (Upwork, Wise, PayPal, Skydo) depend on the settling AD bank.
- Not legal advice. Sources are linked in the app.

## Changelog
- 1.1.0 (2026-10-08): RBI 7 Oct clarification banner, "Do I need to file?" checker, corrected hero/rules copy, new sources.
- 1.0.0 (2026-10-07): initial release.
