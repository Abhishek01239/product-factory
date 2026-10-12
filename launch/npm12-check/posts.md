# Launch drafts: npm 12 Readiness Check

Status: DRAFT, NOT PUBLISHED (no social accounts connected: X, Bluesky, Facebook Pages, Mastodon, Threads, LinkedIn are disconnected).
Publish only after the live URL is verified (done 2026-10-12). Image: `og.png` (1200x630, same as the site's social card).
URL: https://abhishek01239.github.io/product-factory/npm12-check/

Angle: useful first. Lead with the "exits 0, breaks later" gotcha and which packages actually need their scripts; the tool comes last.

## X (thread)

1/ npm 12 no longer runs dependency install scripts unless you approve them. The catch: `npm ci` still exits 0. You find out later, when Puppeteer can't find Chrome or Prisma can't find its client.

2/ Not every script matters. From npm's docs and public tests:
- needs it: puppeteer, cypress, sqlite3, prisma, lefthook, bcrypt 5
- fine without: esbuild, bcrypt 6, @sentry/cli, core-js (just a message)

3/ Other npm 12 changes that break CI:
- git deps refused (EALLOWGIT), tarball URLs too (EALLOWREMOTE)
- `--leg`, `--prod`, `--unsafe-perm` now throw
- `npm ci --allow-scripts=…` fails on project installs
- `npm view --json` always returns an array

4/ Node.js still bundles npm 11 or older, so this usually lands when a CI step runs `npm i -g npm@latest`.

I made a free checker: drop in package-lock.json or a public repo, see which scripts are needed, and copy the allowScripts block. Runs in the browser.
https://abhishek01239.github.io/product-factory/npm12-check/

## Bluesky

npm 12 skips dependency install scripts by default and `npm ci` still passes. Puppeteer, Prisma, sqlite3 and bcrypt 5 then break at runtime; esbuild and bcrypt 6 don't.

Free browser-only check: drop in package-lock.json, see which scripts you actually need, copy the allowScripts block.
https://abhishek01239.github.io/product-factory/npm12-check/

## Mastodon

npm 12 blocks dependency install scripts unless they're listed in package.json `allowScripts`, and the install still exits 0, so failures show up later ("Could not find Chrome", missing .prisma/client, missing sqlite3 bindings).

`npm install-scripts ls` lists every package with a script but not which ones need it. I made a free, browser-only checker that reads package-lock.json (or a public repo), fetches each package's real install script, marks what breaks vs. what's safe to deny, flags git/tarball deps and CI flags that now throw, and generates the allowScripts block.

https://abhishek01239.github.io/product-factory/npm12-check/

#npm #nodejs #javascript #devops

## Threads

Upgraded to npm 12? Your install can pass and your app can still be broken: dependency install scripts are skipped unless you approve them.

Free checker that tells you which packages actually need theirs (and gives you the allowScripts block): https://abhishek01239.github.io/product-factory/npm12-check/

## Reddit (r/node, r/javascript): only if the subreddit allows tools; post as a how-to

Title: npm 12 skips install scripts by default. Here's how to tell which of yours actually matter

Body: npm 12 (latest since Sep 30) blocks dependency `preinstall`/`install`/`postinstall` unless they're in `allowScripts`. The install exits 0, so the breakage shows up later. Quick rules of thumb from npm's docs and public tests:
- Scripts that run `prebuild-install`, `node-pre-gyp install` or `node-gyp rebuild` download or build a native binary, so the package breaks without them (sqlite3, bcrypt 5, keytar…).
- Scripts using `node-gyp-build` or `napi-postinstall` load prebuilt binaries already in the package and are fine to deny.
- Binary downloaders need approval: puppeteer, cypress, prisma.
- Message-only postinstalls (core-js, es5-ext) are safe to deny.
- Git dependencies need `allow-git=root` in the project .npmrc, or `all` if a transitive dependency uses git.
- `npm ci --allow-scripts=x` now errors on project installs; commit allowScripts instead.

I put these rules into a free browser-only checker that reads package-lock.json and writes the allowScripts block: https://abhishek01239.github.io/product-factory/npm12-check/ (source on GitHub). Feedback on wrong verdicts is welcome.
