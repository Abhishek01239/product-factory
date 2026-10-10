# Ubuntu 26 Runner Check

Find the GitHub Actions (and Azure Pipelines) steps that break when `ubuntu-latest` moves from Ubuntu 24.04 to 26.04.

Live: https://abhishek01239.github.io/product-factory/runner-26-check/

## Problem

GitHub moves every `ubuntu-latest` job to Ubuntu 26.04 between **Oct 19 and Nov 19, 2026** ([actions/runner-images#14748](https://github.com/actions/runner-images/issues/14748)). The announcement lists headline version changes but not the tools that were removed, and there is no official pre-migration check. Jobs that call a removed tool fail with `command not found` on whichever day their repo is switched.

Removed on 26.04 (from the image READMEs and toolsets): Java 8, Clang/clang-format/clang-tidy 16–18, GCC/G++/GFortran 12, Miniconda (`$CONDA` is empty), Swift, Julia, Fastlane, Pulumi, Mercurial, MediaInfo, haveged, Sphinx, and the global npm commands `tsc`, `webpack`, `webpack-cli`, `lerna`, `grunt`, `gulp`, `parcel`, `newman`.
Major default changes: Python 3.12→3.14, Node 22→24, default JDK 17→25 (README; the announcement table says 17), CMake 3.31→4.4, Docker Compose 2.38→5.1, Helm 3→4, MySQL 8.0→8.4, PostgreSQL 16→18, PHP 8.3→8.5, GCC 13→15, Clang 18→21, OpenSSL 3.0→3.5.

## What it does

- Input: a public repo (`owner/repo`, URL, `/tree/branch`), pasted YAML, or uploaded files. Azure Pipelines `vmImage` files work too.
- Resolves `runs-on` per job, including arrays, `${{ matrix.x }}` (with `include`), `${{ inputs.x }}` defaults, self-hosted labels and reusable-workflow jobs. Unresolvable expressions are reported, not guessed.
- For jobs on `ubuntu-latest`/`ubuntu-26.04`, scans every `run:` command at command position (handles `sudo`, `VAR=x cmd`, pipes, `&&`, `if`, comments) and reports removed tools and changed defaults with line numbers, why it breaks, and a fix.
- Knows mitigations: `actions/setup-*`, setup-miniconda, micromamba, setup-julia, setup-swift, pulumi/actions, setup-helm, setup-compose-action, install-llvm-action, setup-cmake, mise, asdf, nix, `npx`/`yarn`/`bundle exec`, global installs in the same job, `services:` database containers, and `container:` jobs.
- Also flags `macos-14` (unsupported Nov 2, 2026), Ubuntu 22.04 (unsupported Apr 17, 2027) and retired labels.
- Outputs: Markdown checklist (for an issue/PR), a per-file "pinned copy" (`ubuntu-latest` → `ubuntu-24.04`, comments preserved), and a canary workflow that runs on 24.04 and 26.04 side by side and probes each detected tool.

## Privacy and security

Static site, no backend, no analytics, no token. Pasted/uploaded files never leave the browser. Public-repo mode fetches only from `api.github.com` and `raw.githubusercontent.com` (enforced by CSP). All output is rendered with `textContent`.

## Limits

Static analysis only: it can't see inside scripts you call (`./build.sh`), local composite actions, Dockerfiles or Makefiles. Run the canary workflow to confirm. Unauthenticated GitHub API: 60 requests/hour per IP.

## Develop

```
node apps/runner-26-check/tests/rules.test.js   # 23 unit tests
cd apps && python3 -m http.server 8000          # open http://localhost:8000/runner-26-check/
```

Data lives in `rules.js` (`REMOVED_COMMANDS`, `CHANGES`, `LABELS`, `DATA_AS_OF`). To refresh, diff `images/ubuntu/Ubuntu2404-Readme.md` vs `Ubuntu2604-Readme.md` and `toolsets/toolset-2404.json` vs `toolset-2604.json` in actions/runner-images.

Data sources checked 2026-10-10: Ubuntu 26.04 image 20260927.149.1, Ubuntu 24.04 image 20261004.327.1.
