# Claude 5.5 Request Check

Find the Claude API requests and code that return HTTP 400 after you switch to Claude Sonnet 5.5, Opus 5.5 or Haiku 5.5, and get a corrected request.

Live: https://abhishek01239.github.io/product-factory/claude-55-check/

Independent tool, not affiliated with Anthropic.

## Problem

Claude Sonnet 4.5 was deprecated on Sep 30, 2026 and retires on the Claude API on **Nov 30, 2026**. Claude Haiku 4.5 ("not sooner than" Oct 15, 2026) and Opus 4.5 ("not sooner than" Nov 24, 2026) have tentative dates ([model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations)). The replacements reject several settings that older code sends routinely, so changing the model string turns working calls into 400 errors:

| Setting | Sonnet 5.5 | Opus 5.5 | Haiku 5.5 |
|---|---|---|---|
| Assistant prefill (last turn is `assistant`) | 400 | 400 | 400 |
| `thinking: {type: "enabled", budget_tokens}` | 400 | 400 | 400 |
| `thinking: {type: "disabled"}` | 400 → `between_tools` | 400 → omit | not documented → omit |
| Non-default `temperature` / `top_p` / `top_k` | 400 | 400 | 400 (temperature must be 1, top_p 0.99, no top_k, not both) |
| `tool_choice` `any` / `tool` | 400 | 400 | allowed |
| `computer_20250124` | 400 everywhere | 400 on API/GCP | 400 everywhere |
| `computer_20251124` | 400 on API/GCP | 400 on API/GCP | use toolset on API/GCP |
| `output_format` without beta header | 400 | 400 | deprecated |

Sources: [Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide), [Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide) and [Haiku 5.5](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide) migration guides. Real breakage example: [valentinfrlch/ha-llmvision#742](https://github.com/valentinfrlch/ha-llmvision/issues/742).

## What it does

- **Request JSON** (exact): paste a Messages API body (Python dict literals with `True`/`None` also work) plus optional beta headers. Pick the target model and platform (Claude API, Google Cloud, Bedrock). You get every finding with the reason and fix, and a corrected body: model swapped, thinking/effort fixed, sampling removed, forced tool → `auto` + `strict: true` (not on Bedrock), prefill removed, `output_format` → `output_config.format`, computer tool → `computer_toolset_20260801`, obsolete betas dropped.
- **Code** (heuristic, line-based): paste code or choose files (Python, TS/JS, Go, Java, C#, Ruby, PHP, notebooks, YAML/JSON config). Flags retiring/retired model IDs, `budget_tokens`, `thinking: disabled`, sampling params, forced `tool_choice`, likely prefills, legacy computer-use tools, deprecated `output_format`, obsolete beta headers and `content[0].text` (now often a thinking block).
- **Public GitHub repo**: reads up to 600 source files (tests, docs, dependencies and lock files skipped) via `api.github.com` (2 requests) and `raw.githubusercontent.com`. Only files mentioning "anthropic" or "claude" are analysed. Repeats of one rule in one file are grouped.
- Copy a Markdown checklist for an issue or PR.

## Privacy and security

Static site, no backend, no analytics, no API key. Pasted requests (including prompts) and files never leave the browser. CSP allows network access only to `api.github.com` and `raw.githubusercontent.com`. Output is rendered with `textContent`.

## Limits

The JSON check is exact for the rules above. The code scan can miss settings built dynamically and may flag a `temperature` that goes to another provider (multi-provider libraries). It cannot detect edited conversation history (thinking blocks must be replayed unchanged on accounts created on/after Aug 31, 2026), refusal changes or tokenizer cost changes (~30% more tokens); those are shown as notes. Anthropic's own `/claude-api migrate` skill in Claude Code edits code automatically; this tool is a free, read-only pre-check.

## Develop

```bash
node --test apps/claude-55-check/tests/   # 27 unit tests
python3 -m http.server -d apps 8000       # open http://localhost:8000/claude-55-check/
```

`rules.js` is a UMD module with no dependencies (`checkRequest`, `scanText`, `groupFindings`, `parseRepo`, `markdownReport`). Update `DATA_AS_OF`, `MODELS` and the rules when Anthropic changes the guides.
