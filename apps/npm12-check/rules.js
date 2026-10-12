/* npm 12 Readiness Check — analysis engine (no DOM). Works in browsers (window.N12) and Node (module.exports).
 * Sources (checked 2026-10-12):
 *  - npm 12 changelog: https://docs.npmjs.com/cli/v12/using-npm/changelog/
 *  - npm install-scripts: https://docs.npmjs.com/cli/v12/commands/npm-install-scripts/
 *  - npm config (allow-scripts / allow-git / allow-remote): https://docs.npmjs.com/cli/v12/using-npm/config/
 *  - Hands-on tests of popular packages: https://nilaykabariya.blog/tested/npm-12-breaking-changes-tested
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.N12 = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DATA_AS_OF = "2026-10-12";
  var SRC = {
    changelog: "https://docs.npmjs.com/cli/v12/using-npm/changelog/",
    installScripts: "https://docs.npmjs.com/cli/v12/commands/npm-install-scripts/",
    config: "https://docs.npmjs.com/cli/v12/using-npm/config/",
    tested: "https://nilaykabariya.blog/tested/npm-12-breaking-changes-tested"
  };
  var INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];

  // ---------------------------------------------------------------- tiny semver
  function parseVer(v) {
    var m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/.exec(String(v || "").trim());
    return m ? { M: +m[1], m: +m[2], p: +m[3], pre: m[4] || "" } : null;
  }
  function cmpVer(a, b) {
    if (a.M !== b.M) return a.M - b.M;
    if (a.m !== b.m) return a.m - b.m;
    if (a.p !== b.p) return a.p - b.p;
    if (a.pre === b.pre) return 0;
    if (!a.pre) return 1;
    if (!b.pre) return -1;
    return a.pre < b.pre ? -1 : 1;
  }
  function partial(s) {
    var m = /^v?(\d+|[xX*])?(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([\w.-]+))?$/.exec(s);
    if (!m) return null;
    var w = function (x) { return x == null || /^[xX*]$/.test(x) ? null : +x; };
    return { M: w(m[1]), m: w(m[2]), p: w(m[3]), pre: m[4] || "" };
  }
  function lo(p) { return { M: p.M || 0, m: p.m || 0, p: p.p || 0, pre: p.pre }; }
  // Returns a list of [op, version] comparators for one comparator token.
  function expand(tok) {
    var m = /^(<=|>=|<|>|=|\^|~>?)?\s*(.*)$/.exec(tok);
    var op = m[1] || "", p = partial(m[2]);
    if (!p) return null;
    if (p.M == null) return [];
    var L = lo(p);
    if (op === "^") {
      var up = p.M > 0 || p.m == null ? { M: p.M + 1, m: 0, p: 0, pre: "" }
        : (p.m > 0 || p.p == null ? { M: 0, m: p.m + 1, p: 0, pre: "" } : { M: 0, m: 0, p: p.p + 1, pre: "" });
      return [[">=", L], ["<", up]];
    }
    if (op === "~" || op === "~>") {
      return [[">=", L], ["<", p.m == null ? { M: p.M + 1, m: 0, p: 0, pre: "" } : { M: p.M, m: p.m + 1, p: 0, pre: "" }]];
    }
    if (op === "" || op === "=") {
      if (p.m == null) return [[">=", L], ["<", { M: p.M + 1, m: 0, p: 0, pre: "" }]];
      if (p.p == null) return [[">=", L], ["<", { M: p.M, m: p.m + 1, p: 0, pre: "" }]];
      return [["=", L]];
    }
    return [[op, L]];
  }
  function satisfies(version, range) {
    var v = parseVer(version);
    if (!v) return false;
    var r = String(range || "").trim();
    if (r === "" || r === "*" || r === "latest") return true;
    return r.split("||").some(function (part) {
      part = part.trim();
      var cs = [];
      var hy = /^(\S+)\s+-\s+(\S+)$/.exec(part);
      if (hy) { cs = [[">=", lo(partial(hy[1]) || {})], ["<=", lo(partial(hy[2]) || {})]]; }
      else {
        var toks = part.replace(/(<=|>=|<|>|=|\^|~>?)\s+/g, "$1").split(/\s+/).filter(Boolean);
        for (var i = 0; i < toks.length; i++) { var e = expand(toks[i]); if (!e) return false; cs = cs.concat(e); }
      }
      return cs.every(function (c) {
        var d = cmpVer(v, c[1]);
        return c[0] === ">=" ? d >= 0 : c[0] === ">" ? d > 0 : c[0] === "<=" ? d <= 0 : c[0] === "<" ? d < 0 : d === 0;
      });
    });
  }

  // ---------------------------------------------------------------- knowledge base
  // verdict: "breaks" (the package does not work without its script), "safe" (works without it), "review".
  // "when" restricts by version range. First match wins.
  var KNOWN = [
    { name: "puppeteer", verdict: "breaks", why: "Its postinstall downloads Chrome. Without it, launch() fails with \"Could not find Chrome\".", src: SRC.tested },
    { name: "cypress", verdict: "breaks", why: "Its postinstall downloads the Cypress app. Without it: \"No version of Cypress is installed\".", src: SRC.tested },
    { name: "sqlite3", verdict: "breaks", why: "Its install script fetches or builds the native binding. Without it: \"Could not locate the bindings file\".", src: SRC.tested },
    { name: "@prisma/engines", verdict: "breaks", why: "Its postinstall downloads the query engine. The app then fails with \"Cannot find module '.prisma/client/default'\".", src: SRC.tested },
    { name: "@prisma/client", verdict: "breaks", why: "Its postinstall generates the client. The app fails with \"Cannot find module '.prisma/client/default'\" (or run `prisma generate` in your build).", src: SRC.tested },
    { name: "prisma", verdict: "breaks", why: "Prisma's install scripts prepare the engines and client; the tested project failed at runtime when they were blocked.", src: SRC.tested },
    { name: "lefthook", verdict: "breaks", why: "Its postinstall installs your git hooks. When blocked there is no error, but no hooks are installed.", src: SRC.tested },
    { name: "@anthropic-ai/claude-code", verdict: "breaks", why: "Its install script sets up the native binary; when blocked the CLI fails to start (reported on Windows)." , src: SRC.tested },
    { name: "electron", verdict: "breaks", why: "Electron versions that have an install script download the Electron binary in it; without it `electron` fails to start. (Recent versions have no install script and are not affected.)" },
    { name: "node-sass", verdict: "breaks", why: "Its install/postinstall downloads or builds the native binding (node-sass is also deprecated; consider `sass`)." },
    { name: "chromedriver", verdict: "breaks", why: "Its install script downloads the chromedriver binary." },
    { name: "geckodriver", verdict: "breaks", why: "Its postinstall downloads the geckodriver binary." },
    { name: "bcrypt", when: "<6.0.0", verdict: "breaks", why: "bcrypt 5.x uses `node-pre-gyp install` to download its native binding. bcrypt 6 ships prebuilt binaries and works without the script." },
    { name: "bcrypt", when: ">=6.0.0", verdict: "safe", why: "bcrypt 6 ships prebuilt binaries; hashing worked with the script blocked.", src: SRC.tested },
    { name: "esbuild", verdict: "safe", why: "The binary comes from a platform-specific optional dependency; the postinstall only verifies it. Builds worked with it blocked.", src: SRC.tested },
    { name: "@sentry/cli", verdict: "safe", why: "The CLI worked in testing with its install script blocked.", src: SRC.tested },
    { name: "fsevents", when: ">=2.0.0", verdict: "safe", why: "macOS-only optional dependency that ships a prebuilt binary; the blocked `node-gyp rebuild` is not needed." },
    { name: "core-js", verdict: "safe", why: "The postinstall only prints a funding message." },
    { name: "core-js-pure", verdict: "safe", why: "The postinstall only prints a funding message." },
    { name: "es5-ext", verdict: "safe", why: "The postinstall only prints a message." },
    { name: "nodemon", verdict: "safe", why: "The postinstall only prints a message." },
    { name: "protobufjs", verdict: "safe", why: "The postinstall only checks version-scheme compatibility." }
  ];
  function knownFor(name, version) {
    for (var i = 0; i < KNOWN.length; i++) {
      var k = KNOWN[i];
      if (k.name === name && (!k.when || satisfies(version, k.when))) return k;
    }
    return null;
  }

  // Classify an install-script command string (from the registry) when the package isn't in KNOWN.
  function classifyScript(scripts, gypfile) {
    scripts = scripts || {};
    var parts = INSTALL_SCRIPTS.filter(function (k) { return scripts[k]; }).map(function (k) { return k + ": " + scripts[k]; });
    if (!parts.length && gypfile) parts.push("install: node-gyp rebuild (implicit, binding.gyp)");
    var text = parts.join("\n");
    if (!text) return { verdict: "review", why: "The registry shows no install script for this version; npm may still flag it. Check `npm install-scripts ls`.", script: "" };
    if (/node-gyp-build(-optional-packages)?(?!\S)/.test(text) && !/node-gyp rebuild/.test(text))
      return { verdict: "safe", why: "Uses node-gyp-build, which loads prebuilt binaries shipped in the package and only compiles when none match.", script: text };
    if (/napi-postinstall/.test(text))
      return { verdict: "safe", why: "napi-postinstall only fills in a missing platform binary; normally the optional dependency already provides it.", script: text };
    if (/prebuild-install|node-pre-gyp|cmake-js|node-gyp\s+(rebuild|configure|build)/.test(text))
      return { verdict: "breaks", why: "Downloads or compiles a native binary at install time. Unless the package also ships prebuilds, require() fails without it.", script: text };
    if (/opencollective|echo\s|thank|funding|donat|postinstall-postinstall|catch\s*\(\s*e\s*\)\s*\{\s*\}/i.test(text) && !/download|install\.js|\.mjs/.test(text))
      return { verdict: "safe", why: "Looks like a message-only script.", script: text };
    if (/husky|simple-git-hooks|git config core\.hooksPath|yorkie/.test(text))
      return { verdict: "breaks", why: "Installs git hooks. When blocked there is no error, but hooks are silently not installed.", script: text };
    if (/download|install\.(m?js|cjs)|postinstall\.(m?js|cjs)|setup\.(m?js|cjs)|\bcurl\b|\bwget\b/i.test(text))
      return { verdict: "review", why: "Runs a setup script that may download a binary. Read it, then approve if the package fails without it.", script: text };
    return { verdict: "review", why: "Runs a custom command. Read it and decide.", script: text };
  }

  // ---------------------------------------------------------------- parsing
  function parseJson(text, label) {
    var t = String(text || "").replace(/^\uFEFF/, "").trim();
    if (!t) return null;
    if (t.length > 60e6) throw new Error(label + " is over 60 MB.");
    try { return JSON.parse(t); } catch (e) { throw new Error(label + " isn't valid JSON (" + e.message + ")."); }
  }
  function nameFromKey(key) {
    var i = key.lastIndexOf("node_modules/");
    return i < 0 ? null : key.slice(i + 13);
  }
  function isGitSpec(s) {
    s = String(s || "");
    return /^(git\+|git:\/\/|github:|gitlab:|bitbucket:|gist:|git@)/.test(s) || isHostedGitUrl(s) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(s) && !/^@/.test(s) && !/^(file|link|npm|workspace):/.test(s);
  }
  function isHostedGitUrl(s) {
    s = String(s || "");
    if (!/^https?:\/\//.test(s)) return false;
    if (/\.git(#.*)?$/.test(s)) return true;
    var m = /^https?:\/\/(?:www\.)?(github\.com|gitlab\.com|bitbucket\.org)\/[^/]+\/[^/#?]+\/?(#.*)?$/.exec(s);
    return !!m;
  }
  function isRemoteSpec(s) { return /^https?:\/\//.test(String(s || "")) && !isHostedGitUrl(s); }
  function isLocalSpec(s) { return /^(file:|link:|\.{0,2}\/)/.test(String(s || "")); }

  function depSpecs(obj) {
    var out = [];
    ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].forEach(function (f) {
      var d = obj && obj[f];
      if (d && typeof d === "object") Object.keys(d).forEach(function (n) { out.push({ name: n, spec: String(d[n]), field: f }); });
    });
    return out;
  }

  function parseLock(lock) {
    var res = { version: lock && lock.lockfileVersion, scripts: [], git: [], remote: [], local: [], total: 0, rootName: "" };
    if (!lock || typeof lock !== "object") return res;
    var pk = lock.packages;
    if (!pk || typeof pk !== "object") { res.v1 = true; return res; }
    var rootPkg = pk[""] || {};
    res.rootName = rootPkg.name || lock.name || "";
    var byId = {}, linkName = {};
    Object.keys(pk).forEach(function (key) {
      var e = pk[key] || {};
      if (e.link && e.resolved) linkName[String(e.resolved)] = nameFromKey(key);
    });
    Object.keys(pk).forEach(function (key) {
      if (key === "") return;
      var e = pk[key] || {};
      var nm = e.name || nameFromKey(key) || linkName[key];
      var isWorkspace = !nameFromKey(key);
      if (e.link) return; // the target entry (workspace path) carries the data
      res.total++;
      if (!nm) nm = key;
      // Dependency specs inside every entry (for git / remote detection)
      depSpecs(e).forEach(function (d) {
        if (d.field === "peerDependencies") return;
        var where = key;
        if (isGitSpec(d.spec)) res.git.push({ name: d.name, spec: d.spec, from: where, root: false });
        else if (isRemoteSpec(d.spec)) res.remote.push({ name: d.name, spec: d.spec, from: where, root: false });
      });
      var resolved = String(e.resolved || "");
      if (/^git(\+|:)/.test(resolved) && !res.git.some(function (g) { return g.name === nm; }))
        res.git.push({ name: nm, spec: resolved, from: key, root: false, resolvedOnly: true });
      if (e.hasInstallScript) {
        var id = nm + "@" + (e.version || "");
        if (!byId[id]) {
          byId[id] = { name: nm, version: e.version || "", paths: [], dev: true, optional: true, os: e.os || null, cpu: e.cpu || null, workspace: isWorkspace, git: /^git/.test(resolved) };
          res.scripts.push(byId[id]);
        }
        byId[id].paths.push(key);
        if (!e.dev) byId[id].dev = false;
        if (!e.optional && !e.devOptional) byId[id].optional = false;
      }
    });
    depSpecs(rootPkg).forEach(function (d) {
      if (d.field === "peerDependencies") return;
      if (isGitSpec(d.spec)) res.git.push({ name: d.name, spec: d.spec, from: "package.json", root: true });
      else if (isRemoteSpec(d.spec)) res.remote.push({ name: d.name, spec: d.spec, from: "package.json", root: true });
      else if (isLocalSpec(d.spec)) res.local.push({ name: d.name, spec: d.spec });
    });
    // De-duplicate git/remote by name; root wins.
    function dedupe(list) {
      var m = {};
      list.forEach(function (g) { if (!m[g.name] || g.root) m[g.name] = g; });
      return Object.keys(m).sort().map(function (k) { return m[k]; });
    }
    res.git = dedupe(res.git); res.remote = dedupe(res.remote);
    res.scripts.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    return res;
  }

  function parseAllowKey(key) {
    var k = String(key);
    var at = k.indexOf("@", k[0] === "@" ? 1 : 0);
    return at > 0 ? { name: k.slice(0, at), spec: k.slice(at + 1) } : { name: k, spec: "" };
  }
  // -> {status: "approved"|"denied"|"uncovered"|"pin-mismatch", key}
  function coverage(allow, name, version) {
    if (!allow || typeof allow !== "object") return { status: "uncovered" };
    var hits = [], forName = [];
    Object.keys(allow).forEach(function (key) {
      var p = parseAllowKey(key);
      if (p.name !== name) return;
      forName.push(key);
      if (allow[key] === false && !p.spec) hits.push({ key: key, v: false });
      else if (!p.spec || satisfies(version, p.spec)) hits.push({ key: key, v: allow[key] !== false });
    });
    var deny = hits.filter(function (h) { return !h.v; })[0];
    if (deny) return { status: "denied", key: deny.key };
    if (hits.length) return { status: "approved", key: hits[0].key };
    if (forName.length) return { status: "pin-mismatch", key: forName.join(", ") };
    return { status: "uncovered" };
  }

  function parseNpmrc(text) {
    var out = {};
    String(text || "").split(/\r?\n/).forEach(function (line, i) {
      var l = line.replace(/[;#].*$/, "").trim();
      var m = /^([\w@:/.\-\[\]]+)\s*=\s*(.*)$/.exec(l);
      if (m) out[m[1].replace(/\[\]$/, "")] = { value: m[2].trim(), line: i + 1 };
    });
    return out;
  }

  // ---------------------------------------------------------------- CI / script text scan
  var FULL_FLAGS = ("access all allow-directory allow-file allow-git allow-remote allow-same-version allow-scripts allow-scripts-pending allow-scripts-pin allow-unused-patches also audit audit-level auth-type before bin-links browser bypass-2fa ca cache cache-max cache-min cafile call cert cidr color commit-hooks cpu dangerously-allow-all-scripts depth description dev diff diff-dst-prefix diff-ignore-all-space diff-name-only diff-no-prefix diff-src-prefix diff-text diff-unified dry-run edit-dir editor engine-strict expect-result-count expect-results expires extension-file fetch-retries fetch-retry-factor fetch-retry-maxtimeout fetch-retry-mintimeout fetch-timeout force foreground-scripts format-package-lock fund git git-tag-version global global-ignore-file global-style globalconfig heading https-proxy if-present ignore-existing ignore-extension ignore-patch-failures ignore-scripts include include-attestations include-staged include-workspace-root init-author-email init-author-name init-author-url init-license init-module init-private init-type init-version install-links install-strategy json keep-edit-dir key legacy-bundling legacy-peer-deps libc link local-address location lockfile-version loglevel logs-dir logs-max long maxsockets message min-release-age min-release-age-exclude name node-gyp node-options noproxy offline omit omit-lockfile-registry-resolved only optional orgs orgs-permission os otp pack-destination package package-lock package-lock-only packages packages-all packages-and-scopes-permission parseable password patches-dir prefer-dedupe prefer-offline prefer-online prefix preid production progress provenance provenance-file proxy read-only rebuild-bundle registry replace-registry-host save save-bundle save-dev save-exact save-optional save-peer save-prefix save-prod sbom-format sbom-type scope scopes script-shell searchexclude searchlimit searchopts searchstaleness shell sign-git-commit sign-git-tag strict-allow-scripts strict-npmrc strict-peer-deps strict-ssl tag tag-version-prefix timing to token-description umask unicode update-notifier usage user-agent userconfig version versions viewer which workspace workspaces workspaces-update yes").split(" "); // npm/cli latest (12.2.0) config definitions
  var FLAG_ALIASES = ("enjoy-by d dd ddd quiet q s silent verbose desc help local n no porcelain readonly reg iwr ws").split(" "); // npm shorthands

  function scanText(text, path) {
    var lines = String(text || "").split(/\r?\n/);
    var findings = [];
    var nodeMajors = [], upgradesNpm = null;
    function add(f, i, line) { f.path = path; f.line = i + 1; f.code = line.trim().slice(0, 240); findings.push(f); }
    lines.forEach(function (raw, i) {
      var line = raw.replace(/\s+#.*$/, "");
      if (/^\s*(#|\/\/)/.test(raw)) return;
      var nv = /node-version\s*:\s*['"]?(\d+)/.exec(line) || /\bFROM\s+(?:[\w./-]+\/)?node:(\d+)/i.exec(line) || /\bnvm\s+(?:install|use)\s+v?(\d+)/.exec(line);
      if (nv) nodeMajors.push({ major: +nv[1], line: i + 1 });
      if (/\bnpm\s+(?:i|install|add)\s+(?:-g|--global)\s+npm(@(latest|12[\w.^~]*|next[\w-]*))?(\s|$|['"])/.test(line) ||
          /\bnpm\s+(?:i|install)\s+npm(@(latest|12[\w.^~]*))?\s+(?:-g|--global)\b/.test(line) ||
          /corepack\s+(?:prepare|use|install)\s[^\n]*npm@(latest|12)/.test(line) || /"packageManager"\s*:\s*"npm@12/.test(line)) {
        upgradesNpm = upgradesNpm || i + 1;
        add({ level: "info", id: "gets-npm12", title: "This line puts you on npm 12", why: "Node.js still bundles npm 11 or older, so this upgrade step is what brings in npm 12's new defaults." }, i, raw);
      }
      var re = /\bnpm\s+([a-z][\w-]*)([^;&|\n]*)/g, m;
      while ((m = re.exec(line))) {
        var cmd = m[1], rest = m[2] || "";
        var args = rest.split(/\s--\s/)[0];
        if (cmd === "shrinkwrap") add({ level: "error", id: "shrinkwrap", title: "`npm shrinkwrap` was removed", why: "npm 12 removed the command and no longer reads npm-shrinkwrap.json.", fix: "Delete the step. Rename npm-shrinkwrap.json to package-lock.json; use bundleDependencies if you ship a locked tree.", src: SRC.changelog }, i, raw);
        else if (cmd === "adduser") add({ level: "error", id: "adduser", title: "`npm adduser` was removed", why: "Create accounts on npmjs.com.", fix: "Use `npm login` (or a token in .npmrc for CI).", src: SRC.changelog }, i, raw);
        else if (/^(star|stars|unstar)$/.test(cmd)) add({ level: "error", id: "star", title: "`npm " + cmd + "` was removed", why: "The star commands no longer exist in npm 12.", fix: "Remove the step.", src: SRC.changelog }, i, raw);
        if (/^(view|info|show|v)$/.test(cmd) && /--json\b/.test(args)) add({ level: "warn", id: "view-json", title: "`npm " + cmd + " --json` now always returns an array", why: "npm 11 printed a bare value for single results (\"3.0.1\"); npm 12 prints [\"3.0.1\"]. Scripts that parse it break.", fix: "Read the first element (e.g. `| jq -r '.[0]'`), or drop --json and parse the plain value.", src: SRC.changelog }, i, raw);
        if (/^(pack|publish)$/.test(cmd) && /--json\b/.test(args)) add({ level: "warn", id: "pack-json", title: "`npm " + cmd + " --json` output changed", why: "npm 12 made pack and publish JSON output consistent, in one format.", fix: "Re-check any jq or parsing that reads this output.", src: SRC.changelog }, i, raw);
        if (cmd === "sbom" && /cyclonedx/.test(args)) add({ level: "info", id: "sbom", title: "CycloneDX SBOM names may change", why: "npm 12 reports each package's package.json name instead of its folder name, so root and aliased components' name, bom-ref and purl can change.", src: SRC.changelog }, i, raw);
        if (cmd === "init" && /(\s|^)(-y|--yes)\b/.test(args)) add({ level: "info", id: "init-license", title: "`npm init -y` no longer writes a license", why: "The default license changed from \"ISC\" to empty, so the field is omitted.", fix: "Pass `--init-license=ISC` (or your license) if a later step expects it.", src: SRC.changelog }, i, raw);
        var isInstall = /^(i|install|ci|add|isntall|in|ins|inst|insta|instal|isnt|isnta|isntal|install-test|it|install-ci-test|cit|clean-install|update|up|upgrade|rebuild|rb)$/.test(cmd);
        var isGlobal = /(\s|^)(-g|--global)\b/.test(args) || /--location[= ]global/.test(args);
        if (isInstall && !isGlobal && /--allow-scripts(=|\s)/.test(args)) add({ level: "error", id: "allow-scripts-cli", title: "`--allow-scripts` fails on project installs (EALLOWSCRIPTS)", why: "npm 12 rejects --allow-scripts for project-scoped installs: \"--allow-scripts is not allowed in project-scoped installs\".", fix: "Commit an allowScripts block in package.json (generated below) or put allow-scripts in the project .npmrc.", src: SRC.tested }, i, raw);
        if (isInstall && isGlobal) {
          var pkgs = args.replace(/(\s|^)--?[\w-]+(=\S+)?/g, " ").trim().split(/\s+/).filter(function (p) { return p && !/^npm(@|$)/.test(p) && !/^['"$]/.test(p); });
          if (pkgs.length && !/--allow-scripts(=|\s)/.test(args)) {
            var named = pkgs.map(function (p) { return p.replace(/@[^@/]*$/, "") || p; });
            var bad = named.filter(function (n) { var k = knownFor(n, ""); return k && k.verdict === "breaks"; });
            add({ level: bad.length ? "warn" : "info", id: "global-install", title: "Global install skips install scripts" + (bad.length ? ": " + bad.join(", ") + " needs its script" : ""),
              why: "Global installs have no package.json for allowScripts, so every dependency script is skipped unless you pass --allow-scripts." + (bad.length ? " " + knownFor(bad[0], "").why : ""),
              fix: "Add `--allow-scripts=" + named.join(",") + "` to this command (only for packages you trust).", src: SRC.installScripts }, i, raw);
          }
        }
        // Abbreviated long flags now throw (EUNKNOWNCONFIG)
        var fre = /(?:^|\s)--([a-z][\w-]*)/g, fm;
        while ((fm = fre.exec(args))) {
          var f = fm[1].replace(/^no-/, "");
          if (FULL_FLAGS.indexOf(f) >= 0 || FLAG_ALIASES.indexOf(f) >= 0 || f.length < 3) continue;
          var cands = FULL_FLAGS.filter(function (x) { return x.indexOf(f) === 0; });
          if (!cands.length && !/^(exec|x|config|c|set|get|pkg|help|explain|why)$/.test(cmd)) add({ level: "error", id: "unknown-flag", title: "Unknown flag `--" + fm[1] + "` now throws (EUNKNOWNCONFIG)", why: "npm 11 only warned about unknown CLI flags; npm 12 stops with an error. `--" + f + "` is not an npm 12 config" + (f === "unsafe-perm" ? " (it was removed long ago and did nothing since npm 7)" : "") + ".", fix: "Remove the flag" + (/^npm\s+(run|run-script|test|start|rum|urn)\b/.test(line.slice(m.index)) ? ", or pass it to your script after `--` (npm run x -- --" + fm[1] + ")" : "") + ".", src: SRC.changelog }, i, raw);
          if (cands.length) add({ level: "error", id: "abbrev-flag", title: "Abbreviated flag `--" + fm[1] + "` now throws (EUNKNOWNCONFIG)", why: "npm 11 expanded unique prefixes; npm 12 throws on abbreviated and unknown CLI flags.", fix: "Write the full flag: `--" + (fm[1].indexOf("no-") === 0 ? "no-" : "") + cands[0] + "`" + (cands.length > 1 ? " (or " + cands.slice(1, 3).map(function (c) { return "--" + c; }).join(", ") + ")" : "") + ".", src: SRC.changelog }, i, raw);
        }
      }
      if (/npm_config_allow_scripts\s*[:=]/i.test(line)) add({ level: "error", id: "allow-scripts-env", title: "`npm_config_allow_scripts` breaks project installs", why: "npm 12 throws EALLOWSCRIPTS when allow-scripts comes from the CLI or environment during a project install. Child `npm install` processes inherit it too.", fix: "Remove the variable; use allowScripts in package.json for projects and --allow-scripts only on `npm install -g`.", src: SRC.config }, i, raw);
    });
    if (upgradesNpm) nodeMajors.forEach(function (n) {
      if ([18, 19, 20, 21, 23, 25].indexOf(n.major) >= 0)
        findings.push({ level: "warn", id: "node-engine", path: path, line: n.line, code: lines[n.line - 1].trim(), title: "npm 12 does not support Node " + n.major, why: "npm 12 requires Node ^22.22.2, ^24.15.0 or >=26.0.0, and this file also upgrades npm (line " + upgradesNpm + ").", fix: "Move to Node 22.22.2+, 24.15+ or 26, or pin npm to 11 (`npm i -g npm@11`).", src: SRC.changelog });
    });
    return findings;
  }

  // ---------------------------------------------------------------- main analysis
  // input: {lockText, pkgText, npmrcText, files:[{path,text}], registry: {"name@ver": {scripts, gypfile} | null}, hasShrinkwrap}
  function analyze(input) {
    input = input || {};
    var findings = [];
    var lock = parseJson(input.lockText, "package-lock.json");
    var pkg = input.pkgText ? parseJson(input.pkgText, "package.json") : (lock && lock.packages && lock.packages[""]) || null;
    var npmrc = parseNpmrc(input.npmrcText);
    var L = parseLock(lock);
    var allow = pkg && pkg.allowScripts && typeof pkg.allowScripts === "object" ? pkg.allowScripts : null;
    if (input.pkgText && pkg && !pkg.allowScripts && lock && lock.packages && lock.packages[""] && lock.packages[""].allowScripts) allow = lock.packages[""].allowScripts;
    var npmrcAllow = npmrc["allow-scripts"] ? npmrc["allow-scripts"].value.split(/[,\s]+/).filter(Boolean) : [];
    var reg = input.registry || {};

    if (!lock) findings.push({ level: "warn", id: "no-lock", title: "No package-lock.json, so install scripts can't be listed", why: "The lockfile's hasInstallScript flags are how this check finds every dependency (including transitive ones) with a script.", fix: "Add package-lock.json (run `npm install --package-lock-only` if you don't commit one)." });
    else if (L.v1) findings.push({ level: "warn", id: "lock-v1", title: "lockfileVersion 1 has no install-script flags", why: "Only lockfile v2/v3 (npm 7+) record hasInstallScript.", fix: "Regenerate with `npm install --package-lock-only` on npm 7 or newer, then check again." });

    // --- packages with install scripts
    var pkgs = L.scripts.map(function (s) {
      var k = knownFor(s.name, s.version);
      var r = reg[s.name + "@" + s.version];
      var c = r ? classifyScript(r.scripts, r.gypfile) : null;
      var verdict, why, src;
      if (k) { verdict = k.verdict; why = k.why; src = k.src; }
      else if (c) { verdict = c.verdict; why = c.why; }
      else { verdict = "review"; why = r === null ? "Couldn't read this version from the npm registry." : "Turn on registry lookup to see the exact script, or read it in node_modules/" + s.name + "/package.json."; }
      if (s.workspace) { verdict = "review"; why = "Workspace or local package with its own install script. npm 12.1.0 matches allowScripts keys for local paths; confirm with `npm install-scripts ls`."; }
      var cov = coverage(allow, s.name, s.version);
      if (cov.status === "uncovered" && npmrcAllow.indexOf(s.name) >= 0) cov = { status: "approved", key: ".npmrc allow-scripts" };
      if (npmrcAllow.indexOf("true") >= 0 || npmrcAllow.indexOf("all") >= 0) cov = { status: "approved", key: ".npmrc allow-scripts=" + npmrcAllow.join(",") };
      return { name: s.name, version: s.version, dev: s.dev, optional: s.optional, os: s.os, workspace: s.workspace, paths: s.paths, verdict: verdict, why: why, src: src, script: c ? c.script : (r && r.scripts ? classifyScript(r.scripts, r.gypfile).script : ""), coverage: cov };
    });

    var uncovered = pkgs.filter(function (p) { return p.coverage.status === "uncovered" || p.coverage.status === "pin-mismatch"; });
    var breaking = uncovered.filter(function (p) { return p.verdict === "breaks"; });
    breaking.forEach(function (p) {
      findings.push({ level: "error", id: "script-breaks", pkg: p.name, title: p.name + "@" + p.version + ": install script will be skipped and the package needs it", why: p.why + (p.coverage.status === "pin-mismatch" ? " Your allowScripts entry (" + p.coverage.key + ") is pinned to a different version, so this version is blocked again." : ""), fix: "Approve it if you trust it: `npm install-scripts approve " + p.name + "` then `npm rebuild " + p.name + "`.", src: p.src || SRC.installScripts, code: p.script });
    });
    uncovered.filter(function (p) { return p.coverage.status === "pin-mismatch" && p.verdict !== "breaks"; }).forEach(function (p) {
      findings.push({ level: "warn", id: "pin-mismatch", pkg: p.name, title: p.name + ": your pinned approval (" + p.coverage.key + ") doesn't match " + p.version, why: "npm 12 pins approvals to an exact version by default, so upgrading the package blocks its script again.", fix: "Re-approve with `npm install-scripts approve " + p.name + "`, or use an unpinned key (\"" + p.name + "\": true) if you accept future versions.", src: SRC.installScripts });
    });
    var reviews = uncovered.filter(function (p) { return p.verdict === "review"; });
    if (reviews.length) findings.push({ level: "warn", id: "script-review", title: reviews.length + " package" + (reviews.length > 1 ? "s have" : " has") + " install scripts to review", why: reviews.map(function (p) { return p.name + "@" + p.version; }).join(", ") + ". npm 12 skips them and still exits 0, so failures show up later.", fix: "Read each script in the table below, then approve or deny it.", src: SRC.installScripts });
    var safes = uncovered.filter(function (p) { return p.verdict === "safe"; });
    if (safes.length) findings.push({ level: "info", id: "script-safe", title: safes.length + " package" + (safes.length > 1 ? "s" : "") + " work without their script", why: safes.map(function (p) { return p.name; }).join(", ") + ". npm will warn about them on every install until you record a decision.", fix: "Deny them to silence the warning: `npm install-scripts deny " + safes.map(function (p) { return p.name; }).join(" ") + "`.", src: SRC.installScripts });
    pkgs.filter(function (p) { return p.coverage.status === "denied" && p.verdict === "breaks"; }).forEach(function (p) {
      findings.push({ level: "info", id: "denied-breaks", title: p.name + " is denied in allowScripts; check that is intentional", why: p.why + " If the package is optional or has a fallback, denying it is fine.", fix: "Change \"" + p.coverage.key + "\": false to true if you trust it, then `npm rebuild " + p.name + "`.", src: p.src });
    });
    if (allow) {
      var stale = Object.keys(allow).filter(function (key) {
        var p = parseAllowKey(key);
        return !L.scripts.some(function (s) { return s.name === p.name && (!p.spec || satisfies(s.version, p.spec)); });
      });
      if (stale.length && lock && !L.v1) findings.push({ level: "info", id: "stale-allow", title: stale.length + " allowScripts entr" + (stale.length > 1 ? "ies match" : "y matches") + " nothing in the lockfile", why: stale.join(", "), fix: "`npm install-scripts prune --dry-run` shows what it would remove.", src: SRC.installScripts });
    }

    // --- git / remote dependencies
    var allowGit = npmrc["allow-git"] && npmrc["allow-git"].value, allowRemote = npmrc["allow-remote"] && npmrc["allow-remote"].value;
    function depFinding(list, kind, setting, val, code) {
      if (!list.length) return null;
      var trans = list.filter(function (g) { return !g.root; });
      var need = trans.length ? "all" : "root";
      if (val === "all" || (val === "root" && need === "root")) return need;
      findings.push({ level: "error", id: kind, title: list.length + " " + (kind === "git" ? "git" : "remote tarball") + " dependenc" + (list.length > 1 ? "ies" : "y") + " will be refused (" + code + ")",
        why: list.slice(0, 8).map(function (g) { return g.name + " → " + g.spec + (g.root ? " (in package.json)" : " (via " + g.from.replace(/^node_modules\//, "") + ")"); }).join("; ") + (list.length > 8 ? "; …" : "") + ". npm 12 defaults " + setting + " to none." + (kind === "git" ? " Their prepare scripts are also blocked unless approved." : ""),
        fix: (trans.length ? "A transitive dependency pulls this in, so `root` isn't enough: set `" + setting + "=all` in the project .npmrc (every package may then fetch from " + (kind === "git" ? "git" : "URLs") + "), or replace the dependency with a registry version." : "Add `" + setting + "=root` to the project .npmrc, or publish/replace it with a registry version."), src: SRC.changelog });
      return need;
    }
    var gitNeed = depFinding(L.git, "git", "allow-git", allowGit, "EALLOWGIT");
    var remoteNeed = depFinding(L.remote, "remote", "allow-remote", allowRemote, "EALLOWREMOTE");
    if (L.local.length) findings.push({ level: "info", id: "local-deps", title: "file:/link: dependencies: their prepare scripts are blocked too", why: L.local.map(function (d) { return d.name + " → " + d.spec; }).join("; "), fix: "If they build in `prepare`, approve them in allowScripts (npm 12.1+ matches local paths).", src: SRC.installScripts });

    // --- package.json / .npmrc
    if (pkg) {
      if (/^npm@12/.test(String(pkg.packageManager || ""))) findings.push({ level: "info", id: "pm-12", title: "packageManager pins npm 12", why: "Tools that honour packageManager (e.g. Corepack) will run npm 12 here, so these defaults apply now.", path: "package.json" });
      if (pkg.engines && pkg.engines.npm && !satisfies("12.2.0", pkg.engines.npm)) findings.push({ level: "info", id: "engines-npm", title: "engines.npm (" + pkg.engines.npm + ") excludes npm 12", why: "With engine-strict this blocks installs on npm 12; without it npm just warns.", path: "package.json" });
      var scripts = pkg.scripts || {};
      Object.keys(scripts).forEach(function (k) {
        scanText(String(scripts[k]), "package.json › scripts." + k).forEach(function (f) { f.line = null; findings.push(f); });
      });
    }
    if (input.hasShrinkwrap) findings.push({ level: "error", id: "shrinkwrap-file", title: "npm-shrinkwrap.json is ignored by npm 12", why: "npm 12 no longer loads or honours npm-shrinkwrap.json at the project root or inside dependency tarballs.", fix: "Rename it to package-lock.json.", src: SRC.changelog, path: "npm-shrinkwrap.json" });
    if (npmrc["ignore-scripts"] && /^true$/i.test(npmrc["ignore-scripts"].value)) findings.push({ level: "info", id: "ignore-scripts", title: ".npmrc already sets ignore-scripts=true", why: "No scripts run at all (including yours), so allowScripts has no effect until you remove it. It overrides strict-allow-scripts.", path: ".npmrc", line: npmrc["ignore-scripts"].line, src: SRC.config });
    ["auto-install-peers", "strict-peer-dependencies", "shamefully-hoist", "node-linker", "public-hoist-pattern", "hoist-pattern", "resolution-mode", "link-workspace-packages"].forEach(function (k) {
      if (npmrc[k]) findings.push({ level: "info", id: "pnpm-key", title: "pnpm setting `" + k + "` in .npmrc", why: "npm warns that unknown .npmrc keys will stop working in a future major; with `strict-npmrc` they error today.", fix: "Move pnpm settings to pnpm-workspace.yaml, or ignore the warning if you only use pnpm.", path: ".npmrc", line: npmrc[k].line, src: SRC.changelog });
    });

    // --- other files
    (input.files || []).forEach(function (f) { scanText(f.text, f.path).forEach(function (x) { findings.push(x); }); });

    var order = { error: 0, warn: 1, info: 2 };
    findings.sort(function (a, b) { return order[a.level] - order[b.level]; });
    return { lock: L, pkgs: pkgs, findings: findings, allow: allow, gitNeed: gitNeed, remoteNeed: remoteNeed, hasLock: !!lock && !L.v1 };
  }

  // decisions: {name: "approve"|"deny"|"skip"}; pin: boolean
  function buildOutputs(report, decisions, pin) {
    var allow = {}, approve = [], deny = [], seen = {};
    if (report.allow) Object.keys(report.allow).forEach(function (k) { allow[k] = report.allow[k]; });
    report.pkgs.forEach(function (p) {
      if (p.coverage.status === "approved" || p.coverage.status === "denied") return;
      var d = decisions && decisions[p.name] || defaultDecision(p);
      if (d !== "skip" && p.coverage.status === "pin-mismatch") p.coverage.key.split(", ").forEach(function (k) { delete allow[k]; });
      if (d === "approve") {
        allow[pin && p.version ? p.name + "@" + p.version : p.name] = true;
        if (!seen[p.name]) { approve.push(p.name); seen[p.name] = 1; }
      } else if (d === "deny") {
        allow[p.name] = false;
        if (!seen[p.name]) { deny.push(p.name); seen[p.name] = 1; }
      }
    });
    var sorted = {};
    Object.keys(allow).sort().forEach(function (k) { sorted[k] = allow[k]; });
    var cmds = [];
    if (approve.length) cmds.push("npm install-scripts approve " + approve.join(" ") + (pin ? "" : " --no-allow-scripts-pin"));
    if (deny.length) cmds.push("npm install-scripts deny " + deny.join(" "));
    if (approve.length) cmds.push("npm rebuild " + approve.join(" "));
    cmds.push("npm install-scripts ls   # should list nothing undecided");
    var rc = [];
    if (report.gitNeed) rc.push("allow-git=" + report.gitNeed);
    if (report.remoteNeed) rc.push("allow-remote=" + report.remoteNeed);
    return { allowScripts: sorted, json: JSON.stringify({ allowScripts: sorted }, null, 2), commands: cmds, npmrc: rc };
  }
  function defaultDecision(p) {
    if (p.coverage && p.coverage.status === "pin-mismatch") return "approve"; // you approved another version before
    return p.verdict === "breaks" ? "approve" : p.verdict === "safe" ? "deny" : "skip";
  }

  function summarize(findings) {
    var s = { error: 0, warn: 0, info: 0 };
    findings.forEach(function (f) { s[f.level]++; });
    return s;
  }

  function markdown(report, outputs, title) {
    var s = summarize(report.findings);
    var md = ["# npm 12 readiness: " + title, "", "Checked " + new Date().toISOString().slice(0, 10) + " with npm 12 Readiness Check (rules as of " + DATA_AS_OF + "). " + s.error + " will break, " + s.warn + " to review, " + s.info + " notes.", ""];
    report.findings.forEach(function (f) {
      md.push("- [ ] **" + (f.level === "error" ? "BREAKS" : f.level === "warn" ? "REVIEW" : "NOTE") + "** " + f.title.replace(/`/g, "`") + (f.path ? " (`" + f.path + (f.line ? ":" + f.line : "") + "`)" : ""));
      if (f.why) md.push("  - " + f.why);
      if (f.fix) md.push("  - Fix: " + f.fix);
    });
    if (report.pkgs.length) {
      md.push("", "## Packages with install scripts", "", "| Package | Verdict | allowScripts | Script |", "|---|---|---|---|");
      report.pkgs.forEach(function (p) { md.push("| " + p.name + "@" + p.version + " | " + p.verdict + " | " + p.coverage.status + " | " + (p.script || "").replace(/\n/g, "; ").replace(/\|/g, "\\|").slice(0, 120) + " |"); });
    }
    md.push("", "## Suggested package.json block", "", "```json", outputs.json, "```", "", "## Commands", "", "```sh", outputs.commands.join("\n"), "```");
    if (outputs.npmrc.length) md.push("", "## Project .npmrc", "", "```ini", outputs.npmrc.join("\n"), "```");
    return md.join("\n");
  }

  function parseRepo(input) {
    var s = String(input || "").trim();
    if (!s || s.length > 300) return null;
    var m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})(?:\/tree\/([A-Za-z0-9._\/-]{1,200}))?(?:[\/?#].*)?$/) ||
      s.match(/^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/);
    if (!m) return null;
    var repo = m[2].replace(/\.git$/, "");
    if (repo === "." || repo === "..") return null;
    return { owner: m[1], repo: repo, ref: m[3] ? m[3].replace(/\/+$/, "") : null };
  }
  // Route a file by its path: lock | pkg | npmrc | shrinkwrap | text | null
  function fileKind(path) {
    var p = String(path || "").replace(/\\/g, "/"), base = p.split("/").pop();
    if (base === "package-lock.json") return "lock";
    if (base === "npm-shrinkwrap.json") return "shrinkwrap";
    if (base === "package.json") return "pkg";
    if (base === ".npmrc") return "npmrc";
    if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(p) || /^(\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml|bitbucket-pipelines\.yml|Jenkinsfile|netlify\.toml|Makefile|\.travis\.yml)$/.test(base) || /(^|\/)\.circleci\/config\.yml$/.test(p) || /^Dockerfile(\..+)?$|\.Dockerfile$|^Containerfile$/.test(base) || /\.(sh|bash|ya?ml|ps1|cmd|bat|toml)$/.test(base)) return "text";
    return null;
  }

  var SAMPLE = {
    pkg: JSON.stringify({ name: "sample-app", version: "1.0.0", scripts: { build: "tsc", "release:check": "npm view sample-app version --json | jq -r .", "ci:install": "npm ci --leg" },
      dependencies: { "@prisma/client": "^5.22.0", bcrypt: "^5.1.1", "left-pad-fork": "github:someone/left-pad#v1.3.0", puppeteer: "^24.0.0" },
      devDependencies: { esbuild: "^0.25.0", lefthook: "^1.11.0", prisma: "^5.22.0" },
      allowScripts: { "esbuild@0.24.2": true } }, null, 2),
    lock: JSON.stringify({ name: "sample-app", version: "1.0.0", lockfileVersion: 3, requires: true, packages: {
      "": { name: "sample-app", version: "1.0.0", dependencies: { "@prisma/client": "^5.22.0", bcrypt: "^5.1.1", "left-pad-fork": "github:someone/left-pad#v1.3.0", puppeteer: "^24.0.0" }, devDependencies: { esbuild: "^0.25.0", lefthook: "^1.11.0", prisma: "^5.22.0" } },
      "node_modules/@prisma/client": { version: "5.22.0", resolved: "https://registry.npmjs.org/@prisma/client/-/client-5.22.0.tgz", hasInstallScript: true },
      "node_modules/@prisma/engines": { version: "5.22.0", resolved: "https://registry.npmjs.org/@prisma/engines/-/engines-5.22.0.tgz", dev: true, hasInstallScript: true },
      "node_modules/bcrypt": { version: "5.1.1", resolved: "https://registry.npmjs.org/bcrypt/-/bcrypt-5.1.1.tgz", hasInstallScript: true, dependencies: { "@mapbox/node-pre-gyp": "^1.0.11" } },
      "node_modules/core-js": { version: "3.38.1", resolved: "https://registry.npmjs.org/core-js/-/core-js-3.38.1.tgz", hasInstallScript: true },
      "node_modules/esbuild": { version: "0.25.0", resolved: "https://registry.npmjs.org/esbuild/-/esbuild-0.25.0.tgz", dev: true, hasInstallScript: true },
      "node_modules/fsevents": { version: "2.3.3", resolved: "https://registry.npmjs.org/fsevents/-/fsevents-2.3.3.tgz", dev: true, optional: true, os: ["darwin"], hasInstallScript: true },
      "node_modules/left-pad-fork": { version: "1.3.0", resolved: "git+ssh://git@github.com/someone/left-pad.git#5e3b9c2", license: "MIT" },
      "node_modules/lefthook": { version: "1.11.0", resolved: "https://registry.npmjs.org/lefthook/-/lefthook-1.11.0.tgz", dev: true, hasInstallScript: true },
      "node_modules/prisma": { version: "5.22.0", resolved: "https://registry.npmjs.org/prisma/-/prisma-5.22.0.tgz", dev: true, hasInstallScript: true },
      "node_modules/puppeteer": { version: "24.0.0", resolved: "https://registry.npmjs.org/puppeteer/-/puppeteer-24.0.0.tgz", hasInstallScript: true }
    } }, null, 2),
    workflow: "name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n      - run: npm install -g npm@latest\n      - run: npm ci --allow-scripts=puppeteer\n      - run: npm install -g @anthropic-ai/claude-code\n      - run: npm test\n"
  };

  return { DATA_AS_OF: DATA_AS_OF, SRC: SRC, KNOWN: KNOWN, satisfies: satisfies, knownFor: knownFor, classifyScript: classifyScript, parseLock: parseLock, coverage: coverage, parseNpmrc: parseNpmrc, scanText: scanText, analyze: analyze, buildOutputs: buildOutputs, defaultDecision: defaultDecision, summarize: summarize, markdown: markdown, SAMPLE: SAMPLE, isGitSpec: isGitSpec, parseRepo: parseRepo, fileKind: fileKind };
});
