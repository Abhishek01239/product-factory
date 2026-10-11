# Launch drafts: Claude 5.5 Request Check

Status: DRAFT, NOT PUBLISHED (no social accounts connected: X, Bluesky, Facebook Pages, Mastodon are disconnected).
Product verified live before drafting. Image: `og.png` (1200x630, same as the site's social card).
URL: https://abhishek01239.github.io/product-factory/claude-55-check/

## X (thread)

1/ Claude Sonnet 4.5 retires on the Claude API on Nov 30. Swapping the model string to Sonnet 5.5 is not enough: several settings that worked before now return HTTP 400.

2/ The ones that bite most often:
- a prefilled assistant "{" to force JSON
- temperature / top_p / top_k
- thinking budget_tokens
- tool_choice "any" or "tool" (Sonnet/Opus 5.5)
- thinking: disabled

3/ The rules differ per model. Haiku 5.5 still allows forced tool_choice. Only Sonnet 5.5 has between_tools. Bedrock has no strict tools for these models. Thinking is on by default, so content[0] can be a thinking block.

4/ I built a free checker: paste a request body, some code, or a public GitHub repo. It shows each setting that fails on the target model and generates a corrected request. Runs in your browser, no API key.
https://abhishek01239.github.io/product-factory/claude-55-check/

## Bluesky

Moving off Claude Sonnet 4.5 before Nov 30? Prefill, temperature, budget_tokens and forced tool_choice all return 400 on Sonnet 5.5 (Haiku 5.5 differs).

Free browser-only checker: paste a request, code or a public repo, get the failing lines and a fixed request.
https://abhishek01239.github.io/product-factory/claude-55-check/

## Mastodon

Claude Sonnet 4.5 retires on the Claude API on Nov 30, 2026, and its replacement rejects settings older code sends all the time: assistant prefill, non-default temperature, thinking budgets, forced tool_choice.

I made a small open-source checker that runs entirely in the browser. Paste a request body, code or a public GitHub repo, pick Sonnet/Opus/Haiku 5.5 and your platform, and it lists what returns 400 with a corrected request.

https://abhishek01239.github.io/product-factory/claude-55-check/
#Claude #LLM #DevTools #OpenSource

## Facebook (developer groups/page)

If your app calls Claude Sonnet 4.5, it stops working on Nov 30, 2026, and moving to Sonnet 5.5 can break it in a different way: the new models return HTTP 400 for assistant prefill, non-default temperature/top_p, thinking budgets and (on Sonnet and Opus) forced tool_choice.

Here's a free tool that checks your request or code before you switch and gives you a corrected request. Nothing is uploaded and no API key is needed: https://abhishek01239.github.io/product-factory/claude-55-check/

## Useful-content angle (for a dev.to / blog post)

Title: "The five settings that turn Sonnet 4.5 code into 400 errors on Sonnet 5.5"
Outline: retirement dates → table per target model (from the three migration guides) → JSON prefill → structured outputs; forced tool → auto + strict; budget_tokens → effort; reading content blocks by type → link to the checker as the quick way to audit a repo.
