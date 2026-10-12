"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const N = require("../rules.js");

const ids = (r) => r.findings.map((f) => f.level + ":" + f.id);
const has = (r, level, id) => ids(r).includes(level + ":" + id);
const lockOf = (packages, root = {}) => JSON.stringify({ lockfileVersion: 3, packages: Object.assign({ "": Object.assign({ name: "x", version: "1.0.0" }, root) }, packages) });

test("semver subset", () => {
  assert.ok(N.satisfies("1.2.3", "^1.0.0"));
  assert.ok(!N.satisfies("2.0.0", "^1.0.0"));
  assert.ok(N.satisfies("0.2.5", "~0.2"));
  assert.ok(!N.satisfies("0.3.0", "^0.2.1"));
  assert.ok(N.satisfies("5.1.1", "<6.0.0"));
  assert.ok(N.satisfies("1.4.0", "1.x || >=3"));
  assert.ok(N.satisfies("3.1.0", "1.x || >=3"));
  assert.ok(!N.satisfies("2.1.0", "1.x || >=3"));
  assert.ok(N.satisfies("1.5.0", "1.2.0 - 1.6.0"));
  assert.ok(N.satisfies("4.0.0", "*"));
  assert.ok(!N.satisfies("not-a-version", "^1.0.0"));
});

test("sample: documented breakers are errors, safe ones are notes", () => {
  const S = N.SAMPLE;
  const r = N.analyze({ lockText: S.lock, pkgText: S.pkg, files: [{ path: "ci.yml", text: S.workflow }] });
  const breaks = r.findings.filter((f) => f.id === "script-breaks").map((f) => f.pkg).sort();
  assert.deepEqual(breaks, ["@prisma/client", "@prisma/engines", "bcrypt", "lefthook", "prisma", "puppeteer"]);
  assert.ok(has(r, "info", "script-safe"));
  assert.ok(has(r, "error", "git"));
  assert.ok(has(r, "error", "abbrev-flag"));
  assert.ok(has(r, "error", "allow-scripts-cli"));
  assert.ok(has(r, "warn", "view-json"));
  assert.ok(has(r, "warn", "global-install"));
  assert.ok(has(r, "warn", "node-engine"));
  assert.ok(has(r, "warn", "pin-mismatch"));
  assert.ok(has(r, "info", "gets-npm12"));
  // ordering: errors first
  const lv = r.findings.map((f) => f.level);
  assert.deepEqual(lv, [...lv].sort((a, b) => ({ error: 0, warn: 1, info: 2 }[a] - { error: 0, warn: 1, info: 2 }[b])));
});

test("bcrypt verdict depends on version", () => {
  assert.equal(N.knownFor("bcrypt", "5.1.1").verdict, "breaks");
  assert.equal(N.knownFor("bcrypt", "6.0.0").verdict, "safe");
});

test("applying the generated allowScripts clears every script finding", () => {
  const S = N.SAMPLE;
  const r = N.analyze({ lockText: S.lock, pkgText: S.pkg });
  const out = N.buildOutputs(r, {}, true);
  const pkg = JSON.parse(S.pkg); pkg.allowScripts = out.allowScripts;
  const again = N.analyze({ lockText: S.lock, pkgText: JSON.stringify(pkg), npmrcText: out.npmrc.join("\n") });
  for (const id of ["script-breaks", "script-review", "script-safe", "pin-mismatch", "git"]) assert.ok(!ids(again).some((x) => x.endsWith(":" + id)), id + " " + ids(again));
  assert.ok(again.pkgs.every((p) => p.coverage.status === "approved" || p.coverage.status === "denied"));
});

test("unpinned output uses bare names and --no-allow-scripts-pin", () => {
  const r = N.analyze({ lockText: N.SAMPLE.lock, pkgText: N.SAMPLE.pkg });
  const out = N.buildOutputs(r, {}, false);
  assert.equal(out.allowScripts.puppeteer, true);
  assert.ok(!Object.keys(out.allowScripts).some((k) => k.startsWith("puppeteer@")));
  assert.match(out.commands[0], /--no-allow-scripts-pin$/);
});

test("decisions override defaults", () => {
  const r = N.analyze({ lockText: N.SAMPLE.lock, pkgText: N.SAMPLE.pkg });
  const out = N.buildOutputs(r, { puppeteer: "deny", "core-js": "skip" }, true);
  assert.equal(out.allowScripts.puppeteer, false);
  assert.ok(!("core-js" in out.allowScripts));
});

test("allowScripts coverage: name, pinned, range, false wins, mismatch", () => {
  assert.equal(N.coverage({ a: true }, "a", "1.0.0").status, "approved");
  assert.equal(N.coverage({ "a@1.0.0": true }, "a", "1.0.0").status, "approved");
  assert.equal(N.coverage({ "a@1.0.0": true }, "a", "1.0.1").status, "pin-mismatch");
  assert.equal(N.coverage({ "a@^1.0.0": true }, "a", "1.4.0").status, "approved");
  assert.equal(N.coverage({ "a@1.0.0": true, a: false }, "a", "1.0.0").status, "denied");
  assert.equal(N.coverage({ "@s/a@2.0.0": true }, "@s/a", "2.0.0").status, "approved");
  assert.equal(N.coverage({}, "a", "1.0.0").status, "uncovered");
});

test("git deps: root-only needs allow-git=root; transitive needs all; .npmrc clears", () => {
  const rootOnly = lockOf({ "node_modules/f": { version: "1.0.0", resolved: "git+ssh://git@github.com/u/f.git#abc" } }, { dependencies: { f: "github:u/f" } });
  let r = N.analyze({ lockText: rootOnly });
  assert.ok(has(r, "error", "git")); assert.equal(r.gitNeed, "root");
  assert.ok(!has(N.analyze({ lockText: rootOnly, npmrcText: "allow-git=root" }), "error", "git"));
  const trans = lockOf({ "node_modules/a": { version: "1.0.0", dependencies: { g: "git+https://github.com/u/g.git" } }, "node_modules/g": { version: "1.0.0", resolved: "git+https://github.com/u/g.git#abc" } }, { dependencies: { a: "^1.0.0" } });
  r = N.analyze({ lockText: trans });
  assert.equal(r.gitNeed, "all");
  assert.ok(has(N.analyze({ lockText: trans, npmrcText: "allow-git=root" }), "error", "git"));
  assert.ok(!has(N.analyze({ lockText: trans, npmrcText: "allow-git=all" }), "error", "git"));
});

test("remote tarball deps", () => {
  const l = lockOf({ "node_modules/t": { version: "1.0.0", resolved: "https://example.com/t-1.0.0.tgz" } }, { dependencies: { t: "https://example.com/t-1.0.0.tgz" } });
  const r = N.analyze({ lockText: l });
  assert.ok(has(r, "error", "remote")); assert.equal(r.remoteNeed, "root");
});

test("registry tarball URLs and semver ranges are not git/remote", () => {
  const l = lockOf({ "node_modules/a": { version: "1.0.0", resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz", dependencies: { b: "^2.0.0", c: "npm:d@^1" } } }, { dependencies: { a: "^1.0.0", e: "latest", w: "workspace:*" } });
  const r = N.analyze({ lockText: l });
  assert.ok(!has(r, "error", "git")); assert.ok(!has(r, "error", "remote"));
});

test("script classifier on real registry script strings", () => {
  assert.equal(N.classifyScript({ install: "prebuild-install -r napi || node-gyp rebuild" }).verdict, "breaks");
  assert.equal(N.classifyScript({ install: "node-pre-gyp install --fallback-to-build" }).verdict, "breaks");
  assert.equal(N.classifyScript({ install: "node-gyp-build" }).verdict, "safe");
  assert.equal(N.classifyScript({ postinstall: "napi-postinstall unrs-resolver 1.7.2 check" }).verdict, "safe");
  assert.equal(N.classifyScript({ postinstall: "node -e \"try{require('./postinstall')}catch(e){}\"" }).verdict, "safe");
  assert.equal(N.classifyScript({ postinstall: "opencollective-postinstall || true" }).verdict, "safe");
  assert.equal(N.classifyScript({ postinstall: "node install.js" }).verdict, "review");
  assert.equal(N.classifyScript({}, true).verdict, "breaks");
  assert.equal(N.classifyScript({ test: "jest" }).verdict, "review");
});

test("registry data drives verdict for unknown packages", () => {
  const l = lockOf({ "node_modules/native-x": { version: "1.0.0", hasInstallScript: true } });
  const r = N.analyze({ lockText: l, registry: { "native-x@1.0.0": { scripts: { install: "node-gyp rebuild" } } } });
  assert.equal(r.pkgs[0].verdict, "breaks");
  assert.ok(has(r, "error", "script-breaks"));
  const r2 = N.analyze({ lockText: l });
  assert.equal(r2.pkgs[0].verdict, "review");
});

test("scoped and nested package names from lockfile keys", () => {
  const l = lockOf({ "node_modules/a/node_modules/@s/b": { version: "2.0.0", hasInstallScript: true }, "node_modules/@s/b": { version: "1.0.0", hasInstallScript: true } });
  const r = N.analyze({ lockText: l });
  assert.deepEqual(r.pkgs.map((p) => p.name + "@" + p.version).sort(), ["@s/b@1.0.0", "@s/b@2.0.0"]);
});

test("CI scan: removed commands, flags, env, global installs, view --json", () => {
  const t = [
    "npm shrinkwrap", "npm adduser", "npm star foo", "npm ci --prod", "npm install --legacy-peer-deps", "npm i --no-fund --no-audit",
    "npm ci --allow-scripts=puppeteer", "npm install -g puppeteer", "npm install -g typescript --allow-scripts=typescript",
    "VER=$(npm view pkg version --json)", "npm_config_allow_scripts: puppeteer", "npm run build -- --prod", "npm init -y"
  ].join("\n");
  const f = N.scanText(t, "ci.yml");
  const at = (line) => f.filter((x) => x.line === line).map((x) => x.level + ":" + x.id);
  assert.deepEqual(at(1), ["error:shrinkwrap"]);
  assert.deepEqual(at(2), ["error:adduser"]);
  assert.deepEqual(at(3), ["error:star"]);
  assert.deepEqual(at(4), ["error:abbrev-flag"]);
  assert.deepEqual(at(5), []);
  assert.deepEqual(at(6), []);
  assert.deepEqual(at(7), ["error:allow-scripts-cli"]);
  assert.deepEqual(at(8), ["warn:global-install"]);
  assert.deepEqual(at(9), []);
  assert.deepEqual(at(10), ["warn:view-json"]);
  assert.deepEqual(at(11), ["error:allow-scripts-env"]);
  assert.deepEqual(at(12), [], "flags after -- belong to the script");
  assert.deepEqual(at(13), ["info:init-license"]);
});

test("Node engine warning only when the same file upgrades npm", () => {
  assert.ok(N.scanText("node-version: 20\nrun: npm i -g npm@latest", "a.yml").some((f) => f.id === "node-engine"));
  assert.ok(!N.scanText("node-version: 20\nrun: npm ci", "a.yml").some((f) => f.id === "node-engine"));
  assert.ok(!N.scanText("node-version: 22\nrun: npm i -g npm@latest", "a.yml").some((f) => f.id === "node-engine"));
  assert.ok(N.scanText("FROM node:18-alpine\nRUN npm install -g npm@12", "Dockerfile").some((f) => f.id === "node-engine"));
});

test("package.json scripts are scanned; packageManager npm@12 noted", () => {
  const r = N.analyze({ lockText: lockOf({}), pkgText: JSON.stringify({ packageManager: "npm@12.2.0", scripts: { ci: "npm ci --leg" } }) });
  assert.ok(has(r, "error", "abbrev-flag"));
  assert.ok(has(r, "info", "pm-12"));
});

test(".npmrc: ignore-scripts, pnpm keys, allow-scripts list", () => {
  const l = lockOf({ "node_modules/puppeteer": { version: "24.0.0", hasInstallScript: true } });
  const r = N.analyze({ lockText: l, npmrcText: "ignore-scripts=true\nshamefully-hoist=true\nallow-scripts=puppeteer" });
  assert.ok(has(r, "info", "ignore-scripts"));
  assert.ok(has(r, "info", "pnpm-key"));
  assert.equal(r.pkgs[0].coverage.status, "approved");
});

test("missing / v1 lockfile and invalid JSON", () => {
  assert.ok(has(N.analyze({ pkgText: "{}" }), "warn", "no-lock"));
  assert.ok(has(N.analyze({ lockText: JSON.stringify({ lockfileVersion: 1, dependencies: {} }) }), "warn", "lock-v1"));
  assert.throws(() => N.analyze({ lockText: "{nope" }), /isn't valid JSON/);
});

test("shrinkwrap file and stale allowScripts entries", () => {
  const r = N.analyze({ lockText: lockOf({}), pkgText: JSON.stringify({ allowScripts: { gone: true } }), hasShrinkwrap: true });
  assert.ok(has(r, "error", "shrinkwrap-file"));
  assert.ok(has(r, "info", "stale-allow"));
});

test("markdown report contains the block and commands", () => {
  const r = N.analyze({ lockText: N.SAMPLE.lock, pkgText: N.SAMPLE.pkg });
  const md = N.markdown(r, N.buildOutputs(r, {}, true), "sample");
  assert.match(md, /"allowScripts"/);
  assert.match(md, /npm install-scripts approve/);
  assert.match(md, /\| puppeteer@24\.0\.0 \| breaks \|/);
});

test("fileKind and parseRepo", () => {
  assert.equal(N.fileKind("package-lock.json"), "lock");
  assert.equal(N.fileKind(".github/workflows/ci.yml"), "text");
  assert.equal(N.fileKind("Dockerfile.prod"), "text");
  assert.equal(N.fileKind("README.md"), null);
  assert.deepEqual(N.parseRepo("github.com/a/b.git"), { owner: "a", repo: "b", ref: null });
  assert.equal(N.parseRepo("not a repo"), null);
});

test("unknown flags throw; script args after -- and exec are ignored", () => {
  const f = N.scanText("npm i -g x --unsafe-perm true\nnpm run build --configuration=production\nnpm run build -- --whatever\nnpx foo --bar\nnpm exec foo --bar\nnpm ci --no-optional", "a.sh");
  const at = (line) => f.filter((x) => x.line === line).map((x) => x.id);
  assert.ok(at(1).includes("unknown-flag"));
  assert.ok(at(2).includes("unknown-flag"));
  assert.match(f.find((x) => x.line === 2).fix, /-- --configuration/);
  assert.deepEqual(at(3), []); assert.deepEqual(at(4), []); assert.deepEqual(at(5), []); assert.deepEqual(at(6), []);
});

test("https GitHub .git URLs are git deps; release tarballs are remote", () => {
  assert.ok(N.isGitSpec("https://github.com/u/r.git#abc"));
  assert.ok(N.isGitSpec("https://github.com/u/r"));
  assert.ok(!N.isGitSpec("https://github.com/u/r/releases/download/v1/r.tgz"));
  const l = lockOf({}, { dependencies: { a: "https://github.com/u/a.git#abc", b: "https://github.com/u/b/releases/download/v1/b.tgz" } });
  const r = N.analyze({ lockText: l });
  assert.ok(has(r, "error", "git")); assert.ok(has(r, "error", "remote"));
});

test("workspace packages take their name from the link entry", () => {
  const l = lockOf({ "node_modules/web": { resolved: "packages/web", link: true }, "packages/web": { version: "1.0.0", hasInstallScript: true } });
  const r = N.analyze({ lockText: l });
  assert.equal(r.pkgs[0].name, "web"); assert.ok(r.pkgs[0].workspace); assert.equal(r.pkgs[0].verdict, "review");
});
test("node-gyp-build-optional-packages counts as prebuilt", () => {
  assert.equal(N.classifyScript({ install: "node-gyp-build-optional-packages" }).verdict, "safe");
});
