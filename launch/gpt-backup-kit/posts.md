# GPT Backup Kit — launch drafts (v1.0.0, 2026-10-09)

Status: DRAFTED, NOT PUBLISHED (X, Bluesky, Facebook Pages, Mastodon are not connected).
Image: `og.png` (1200×630) — shows the real kept/dropped table from the app.
URL: https://abhishek01239.github.io/product-factory/gpt-backup-kit/

Facts used (all from OpenAI's retirement FAQ / migration guide, checked 9 Oct 2026): retirement Dec 11, 2026 (Feb 11, 2027 for approved Enterprise deferrals); migration keeps instructions (as a skill), knowledge files, connected apps; custom actions, selected model, sharing settings and unpublished edits do not transfer; starters don't transfer one-to-one.

## X (single post + optional reply)
Custom GPTs stop running on Dec 11.

"Migrate to plugin" keeps your instructions and files, but drops custom actions, the model you picked, sharing settings and unpublished edits. There's no export button.

I made a free kit that backs up a GPT into one ZIP and turns each action into an MCP server stub. Runs in your browser:
https://abhishek01239.github.io/product-factory/gpt-backup-kit/

Reply: What's in the ZIP: gpt.json (re-importable), SKILL.md (Agent Skills format), Claude Project + Gemini Gem instructions, test prompts, and a checklist for your specific GPT. Nothing is uploaded; source is on GitHub.

## Bluesky
If you built custom GPTs: they retire Dec 11, 2026.

OpenAI's migration moves instructions, knowledge files and apps into a plugin. Custom actions, model choice, sharing and unpublished drafts don't come along.

Free, browser-only backup kit (no login, nothing uploaded) that also generates MCP stubs for actions:
https://abhishek01239.github.io/product-factory/gpt-backup-kit/

## Mastodon (#OpenAI #ChatGPT #MCP)
Custom GPTs retire on Dec 11, 2026, and there's no export button.

Before you hit "Migrate to plugin", save what it leaves behind: custom actions, the selected model, sharing settings and unpublished edits.

GPT Backup Kit is a free, open-source static page: paste your GPT's config, download one ZIP with gpt.json, a SKILL.md, Claude/Gemini-ready instructions, test prompts, and a Python MCP server stub per action. No server, no analytics.

https://abhishek01239.github.io/product-factory/gpt-backup-kit/

## Facebook / Threads (useful-first)
A 10-minute checklist if your team uses custom GPTs (they stop running Dec 11, 2026):

1. Publish any unpublished edits. Only the latest published version migrates.
2. Copy the instructions and download the knowledge files.
3. Write down 3–5 prompts you use often and what a good answer looks like.
4. List custom actions. They don't transfer and need rebuilding.
5. Note who uses the GPT. The new plugin starts private.

I put all five steps into a free page that builds the backup ZIP for you and makes starter code for the actions. It runs in your browser and uploads nothing: https://abhishek01239.github.io/product-factory/gpt-backup-kit/

## Show HN (if posting manually)
Title: Show HN: GPT Backup Kit – back up a custom GPT before Dec 11 and turn its actions into MCP stubs
Text: OpenAI retires custom GPTs on Dec 11, 2026. The built-in migration moves instructions and files to a plugin but drops custom actions, model choice, sharing and unpublished edits, and there's no export. This is a static page (no backend, strict CSP) that builds a ZIP from what you paste: gpt.json, an Agent Skills SKILL.md, Claude/Gemini instructions, test prompts, and a Python MCP server per action (one tool per OpenAPI operation, tested with MCP Python SDK 1.30 and 2.3). Feedback on the OpenAPI→MCP mapping welcome.

## Do not claim
User counts, "best", "official", any affiliation with OpenAI, or that MCP stubs are production-ready.
