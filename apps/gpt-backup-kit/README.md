# GPT Backup Kit

Free, private, browser-only tool to back up a custom GPT and prepare its migration before **custom GPTs retire on Dec 11, 2026** (Feb 11, 2027 for Enterprise workspaces with an approved deferral).

Live: https://abhishek01239.github.io/product-factory/gpt-backup-kit/

## Problem
OpenAI is retiring custom GPTs and replacing them with plugins. Its "Migrate to plugin" flow moves instructions (as a skill), knowledge files and connected apps, but **custom actions, the selected model, sharing settings and unpublished edits do not transfer**, and conversation starters don't map one-to-one ([OpenAI FAQ](https://help.openai.com/en/articles/20001519-custom-gpt-retirement-and-migration-faq), [migration guide](https://learn.chatgpt.com/docs/migrate-custom-gpts)). There is no export button for GPTs, so every guide tells creators to copy fields by hand.

## What it does
Paste the fields from your GPT's Configure tab and get:
- A per-GPT **migration checklist** (what's kept, what's dropped, what to test) with a countdown.
- A **backup ZIP**: `gpt.json` (re-importable), `instructions.md`, `README.md`, `MIGRATION.md`, `test-prompts.md`.
- `skill/<name>/SKILL.md` in the open [Agent Skills](https://agentskills.io/specification) format, with knowledge files in `references/`.
- Ready-to-paste **Claude Project** and **Gemini Gem** instructions and a generic system prompt.
- For each **custom action**: its OpenAPI schema plus a generated **Python MCP server stub** (one tool per operation; auth from env vars; works with MCP Python SDK v1.x and v2).
- A secret scanner that warns if instructions or schemas contain API keys.

## Privacy & security
Static HTML/JS. No server, no analytics, no account access. CSP blocks third-party connections. Text is saved in `localStorage` (clearable); files stay in memory. All user text is rendered with `textContent`.

## Run locally
```bash
cd apps/gpt-backup-kit && python3 -m http.server 8080   # open http://localhost:8080
node --test apps/gpt-backup-kit/tests/                   # unit tests
```

## Files
`index.html` UI · `app.js` DOM wiring · `kit.js` pure logic (UMD, unit-tested) · `vendor/js-yaml.min.js` (MIT, for YAML schemas) · `sw.js` offline cache.

## Watch
Update `kit.js` `DATES` and the "kept/dropped" table if OpenAI changes the retirement FAQ.
