# Product registry

Machine-readable version: [`registry/products.json`](registry/products.json). Run logs: [`runs-log/`](runs-log/).
Shipped products live in `apps/<slug>/` and are deployed to GitHub Pages by `.github/workflows/pages.yml`.
(`products/` remains the gitignored scratch output of the Python pipeline.)

| Product | Problem | Status | URL | Social |
|---|---|---|---|---|
| [EDF Tracker](apps/edf-tracker/) | India's new monthly Export Declaration Form for service exports (from 1 Oct 2026); who must file after RBI's 7 Oct clarification | Live, v1.1.0 (2026-10-08), first deployed 2026-10-07 | https://abhishek01239.github.io/product-factory/edf-tracker/ | Drafted, not published |
| [GPT Backup Kit](apps/gpt-backup-kit/) | Custom GPTs retire Dec 11, 2026; migration drops actions, model, sharing, drafts; no export button | Live, v1.0.0 (2026-10-09) | https://abhishek01239.github.io/product-factory/gpt-backup-kit/ | Drafted, not published |
| [Ubuntu 26 Runner Check](apps/runner-26-check/) | ubuntu-latest moves to Ubuntu 26.04 Oct 19-Nov 19, 2026; image drops Java 8, Clang 16-18, GCC 12, Miniconda, Swift, global tsc/webpack/lerna; no official pre-check | Live, v1.0.1 (2026-10-10) | https://abhishek01239.github.io/product-factory/runner-26-check/ | Drafted, not published |
| [Claude 5.5 Request Check](apps/claude-55-check/) | Claude Sonnet 4.5 retires Nov 30, 2026; Sonnet/Opus/Haiku 5.5 return 400 for prefill, sampling params, budget_tokens, forced tool_choice (Sonnet/Opus), thinking disabled, old computer-use tools | Live, v1.0.0 (2026-10-11) | https://abhishek01239.github.io/product-factory/claude-55-check/ | Drafted, not published |

## Investigated / rejected
See `investigated` in `registry/products.json`.
