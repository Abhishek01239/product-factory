# Autonomous AI Product Factory

A continuously running, scheduled software factory that discovers trend-driven
opportunities, builds small useful products, verifies them with a strict
quality/security/compliance gate stack, deploys only when every gate passes,
distributes announcements across configured platforms, and records structured
postmortems so every run is more capable than the last.

**Repository:** `product-factory` — Python 3.11 stdlib only, zero runtime
dependencies, entirely runnable offline with a deterministic mock AI.

---

## What it does (one scheduled pass)

```
TREND SCOUT (HN · Reddit · Dev.to · GitHub trending — official APIs/RSS only)
   ↓
OPPORTUNITY SCORING (user need, demand, competition gap, buildability,
                     monetization − legal/security/platform risk penalties)
   ↓
PLANNER (spec from AI or deterministic mock)
   ↓
BUILDER (static site with whitelisted JS tools, or FastAPI webapp scaffold)
   ↓
TESTS (unittest battery) → DEBUGGER (repair loop, max 5 attempts)
   ↓
AUDITS: security · SEO · accessibility · legal truthfulness · AdSense readiness
   ↓
GATES (build, tests, security, seo, accessibility, legal, adsense, secrets)
   → any mandatory gate fails ⇒ NO DEPLOY, failure recorded
   ↓
QUALITY SCORE (0–59 REJECT · 60–79 REVIEW/IMPROVE · 80–100 ELIGIBLE)
   ↓
DEPLOY (Vercel / GitHub Pages / report-only; re-verifies gates internally)
   ↓
DISTRIBUTE (Telegram · Dev.to · Discord · Bluesky · Mastodon · Reddit · GitHub,
            only platforms with credentials; per-platform unique copy)
   ↓
LEARN (versioned memory postmortem + structured lessons)
```

Run it yourself:

```bash
python agent.py --selftest   # offline verification of every component (16 checks)
python agent.py --run        # one full pipeline pass (real AI if GROQ_API_KEY set)
python agent.py --run --mock-ai   # deterministic offline pass (no key, no network)
python agent.py --stage trends    # just trend discovery + scoring
python scripts/scan_secrets.py    # committed-secret CI gate
```

## The 16 selftest checks

| Group | Checks |
|---|---|
| core | config/env overrides, secret redaction, slugify |
| ai | mock AI determinism, client gate (no key ⇒ clean `AIUnavailable`) |
| memory | versioning, bump/rollback, postmortems, trend history |
| trends/scoring | real fetch attempted → graceful offline fallback, forbidden topics suppressed |
| builder | static site completeness (all pages, robots, sitemap), tool UI, no placeholders |
| quality | all 8 auditors pass on a good product; injected secrets/eval/legal claims fail them |
| lower quality | gate math, deploy-threshold logic |
| deploy | strategy selection + gate re-verification |
| distribution | capability registry, env-only credentials, per-platform copy |
| learn | postmortem schema, lesson persistence |

```bash
python -m unittest discover -s tests -t .   # 31 unit tests, stdlib only
```

## Repository layout

```
agent.py                  CLI entry (--run / --stage / --selftest / --approve)
factory.json              runtime configuration (mode, budgets, gates, weights)
.env.example              every secret the factory reads — copy to .env locally
factory/
  config.py               config loading + env overrides + secret redaction
  utils.py                redaction, atomic JSON, id/time helpers
  logging_setup.py        structured logging (secrets never logged)
  ai/                     Groq HTTP client + deterministic MockAIClient
  memory/                 versioned knowledge store (memory/vN/, VERSION)
  trends/                 scout (4 sources) + opportunity scoring
  planning/               spec generation
  build/                  static-site renderer + FastAPI scaffold
  quality/                tests, debugger, 6 auditors, gate runner, score
  deploy/                 deployer (vercel / ghpages / report), gate re-check
  distribute/             platform registry + adapters + per-platform copy
  learn/                  postmortems + structured lessons
  registry.py             projects.json project registry
  pipeline.py             16-stage orchestrator
  selftest.py             offline verification suite (16 checks)
tests/                    31 stdlib unittest tests
scripts/scan_secrets.py   committed-secret CI gate
.github/workflows/        factory-daily (cron) · factory-manual · factory-secrets
memory/                   versioned learning memory (committed, rollback-safe)
```

## Configuration

`factory.json` controls everything. Environment variables override it
(`FACTORY_MODE`, `FACTORY_MAX_AI_REQUESTS`, `GROQ_MODEL`, …). The default
mode is **`approval_required`** — the factory researches, builds, tests and
audits, then **stops for approval before any deploy/distribute** side effect.

## GitHub Actions

- **factory-daily** — `0 8 * * *` UTC: selftest → secret scan → full pipeline
  (real Groq when `GROQ_API_KEY` secret exists, deterministic mock otherwise).
  Never auto-deploys: `FACTORY_MODE` defaults to `approval_required` and can
  only be overridden with the repository *variable* `FACTORY_MODE`.
- **factory-manual** — `workflow_dispatch` with mode / AI backend / dry-run inputs.
- **factory-secrets** — runs `scripts/scan_secrets.py` on every push/PR.

**Important:** GitHub secrets are NOT automatic env vars. Every credential the
factory reads (`GROQ_API_KEY`, `VERCEL_TOKEN`, `TELEGRAM_BOT_TOKEN`,
`DEVTO_API_KEY`, `DISCORD_WEBHOOK_URL`, `BLUESKY_*`, `MASTODON_*`,
`REDDIT_*`) is mapped explicitly in each workflow's `env:` block. Add the ones
you use as repository secrets; the capability registry auto-deactivates
platforms whose credentials are absent.

## Gates — nothing deploys unless every gate passes

`build · tests · security · seo · accessibility · legal · adsense · secrets`

- **Security:** committed-secret scan, injection/path-traversal/eval patterns,
  template review (no raw user input into HTML/JS), no hardcoded credentials.
- **Legal:** privacy/terms/disclaimer/contact must exist and must NOT claim
  invented data practices (cookies/analytics claims are truthfulness-probed).
- **AdSense readiness:** original useful content, navigation, About/Contact,
  no doorway pages, no thin-content farms, no keyword stuffing, mobile +
  semantics. Passing is a readiness signal only — **AdSense approval remains
  subject to Google's independent review and policies** (stated in every report).
- **Quality score:** 0–59 REJECT, 60–79 REVIEW/IMPROVE, 80–100 ELIGIBLE
  (thresholds in `factory.json`).
- The deployer re-verifies every gate on the *final* artifact immediately
  before deploying (belt and braces).
- In `approval_required` mode, deploy/distribute await `python agent.py --approve <run_id>`.

## Distribution

Adapters activate **only** when their credentials exist. Each platform gets
unique copy tailored to its format (never identical spam) with hard character
limits per platform. Capabilities are tracked in `distribution/capabilities.json`
(`api_available`, `free_tier`, `posting_supported`, `credentials_configured`,
`last_success`, `last_error`).

## Budgets & safety

Conservative caps by default (see `factory.json → budgets`): 1 project/run, 30
AI requests, 5 repair attempts, 900 s build time, 60 min run. The factory
never spends money: no billing-enabled API is ever called unless explicitly
configured — missing credentials produce a clean `blocked_missing_credentials`
result, never a fake success.

## What "learning" means here

The Groq model is **not retrained** — the factory keeps an external, versioned
memory (`memory/vN/`, git-tracked): postmortems, lessons
(problem → cause → solution → rule), security findings, trend history. Each
new version snapshots the previous one, so a regression can be rolled back.
The planner reads past digests before spec'ing the next product.

## Local development

```bash
python agent.py --selftest          # 16 offline checks, run this after any change
python -m unittest discover -s tests -t .   # 31 unit tests
python scripts/scan_secrets.py      # committed-secret gate
```

License: MIT.