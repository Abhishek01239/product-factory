# npm 12 Readiness Check

Find the dependencies that break when npm 12 skips their install scripts, the git and tarball dependencies it refuses, and the CI lines that now fail. Get the `allowScripts` block to commit.

Live: https://abhishek01239.github.io/product-factory/npm12-check/

Independent tool, not affiliated with npm, Inc. or GitHub.

## Problem

npm 12.0.0 (Jul 8, 2026) stopped running dependency `preinstall` / `install` / `postinstall` scripts (including implicit `node-gyp rebuild`) unless they are approved in `allowScripts`, and set `allow-git` and `allow-remote` to `none` ([npm 12 changelog](https://docs.npmjs.com/cli/v12/using-npm/changelog/)). A blocked script is only a warning: `npm ci` exits 0 and the failure appears later ("Could not find Chrome", "Cannot find module '.prisma/client/default'", "Could not locate the bindings file"; see [hands-on tests](https://nilaykabariya.blog/tested/npm-12-breaking-changes-tested)). npm 12.2.0 became the registry's `latest` on Sep 30, 2026 while Node.js still bundles npm 11 or older, so teams hit it when a CI step runs `npm i -g npm@latest`, a Docker image or Corepack moves, or a teammate upgrades.

`npm install-scripts ls` lists every package with a script, but needs npm 12 and an installed tree, and doesn't say which scripts are actually needed. Approving everything defeats the security point.

## What it checks

| npm 12 change | Detection |
|---|---|
| Dependency install scripts need approval | Every lockfile entry with `hasInstallScript`; the real script from the registry; verdict (breaks / review / works without it); current `allowScripts` coverage (name, `name@version`, ranges, `false`) |
| Approvals pin to exact versions | Pinned keys that no longer match the locked version; stale keys |
| `allow-git` / `allow-remote` default `none` | git, GitHub shorthand, `https://…/repo.git` and tarball URL deps in package.json and inside the lockfile; whether `root` is enough or a transitive dep needs `all` |
| `--allow-scripts` only for global installs | Project installs with `--allow-scripts` or `npm_config_allow_scripts` (EALLOWSCRIPTS) |
| Unknown and abbreviated flags throw | Flags not in npm 12.2.0's 184 config definitions/shorthands, e.g. `--leg`, `--prod`, `--unsafe-perm` (EUNKNOWNCONFIG); flags after `--` are ignored |
| Removed commands / files | `npm shrinkwrap`, `adduser`, `star`; `npm-shrinkwrap.json` |
| Output changes | `npm view/info/show --json` (always an array), `pack/publish --json`, CycloneDX SBOM names, `npm init -y` license |
| Node engine | Files that upgrade npm while pinning Node 18/20/21/23/25 |
| Global installs | `npm i -g <pkg>` without `--allow-scripts`, warning when the package is known to need its script |
| Context | lines that put you on npm 12 (`npm i -g npm@latest`, `packageManager: npm@12`), `engines.npm`, `ignore-scripts=true`, pnpm-only `.npmrc` keys |

Verdicts come first from a short list of packages with documented behaviour (Puppeteer, Cypress, Prisma, sqlite3, lefthook, Electron, node-sass, chromedriver/geckodriver, bcrypt by version, esbuild, @sentry/cli, fsevents 2, core-js, es5-ext, nodemon, protobufjs), otherwise from the script text (`prebuild-install`, `node-pre-gyp`, `node-gyp rebuild`, `cmake-js` → breaks; `node-gyp-build`, `napi-postinstall` → works; message-only → works; anything else → review).

Outputs: an editable decision per package (approve / deny / decide later; pinned or unpinned), the `allowScripts` JSON, the equivalent `npm install-scripts approve|deny` + `npm rebuild` commands, `.npmrc` lines for git/remote deps, and a Markdown checklist.

## Inputs

- **Files**: drop or choose `package-lock.json` (v2/v3) plus optional `package.json`, `.npmrc`, workflow YAML, Dockerfiles, shell scripts.
- **Paste**: four text areas.
- **Public GitHub repo**: root manifests plus up to 50 workflow/Docker/CI files via `api.github.com` (2 requests, no token) and `raw.githubusercontent.com`.

## Privacy and security

Static site, no backend, no analytics. Files never leave the browser. Optional registry lookup sends only the names and versions of packages that have install scripts to `registry.npmjs.org` (workspace packages are never sent). CSP allows only `api.github.com`, `raw.githubusercontent.com` and `registry.npmjs.org`. All output is rendered with `textContent`.

## Limits

npm only (pnpm, Yarn and Bun have their own allowlists). Lockfile v1 has no `hasInstallScript` flags. Verdicts for unlisted packages are heuristics from the script text: read the script before approving. CI scanning is line-based.

## Develop

```bash
node --test apps/npm12-check/tests/   # unit tests
python3 -m http.server -d apps 8000  # open http://localhost:8000/npm12-check/
```

`rules.js` is a dependency-free UMD module (`analyze`, `buildOutputs`, `scanText`, `classifyScript`, `coverage`, `satisfies`, `markdown`). Update `DATA_AS_OF`, `KNOWN` and `FULL_FLAGS` when npm changes.
