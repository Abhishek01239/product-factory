/*
 * Ubuntu 26 Runner Check: analysis engine.
 * Pure functions, no DOM, no network. Works in the browser (window.R26) and in Node (module.exports).
 *
 * Data source: actions/runner-images
 *   images/ubuntu/toolsets/toolset-2404.json vs toolset-2604.json
 *   images/ubuntu/Ubuntu2404-Readme.md (image 20261004.327.1) vs Ubuntu2604-Readme.md (image 20260927.149.1)
 *   Announcements #14748 (ubuntu-latest -> 26.04, Oct 19 - Nov 19, 2026), #13518 (macOS 14, Nov 2, 2026),
 *   #14254 (Ubuntu 22.04, unsupported Apr 17, 2027).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.R26 = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DATA_AS_OF = "2026-10-10";
  var DATES = {
    migrationStart: "2026-10-19",
    migrationEnd: "2026-11-19",
    macos14Retired: "2026-11-02",
    ubuntu2204Unsupported: "2027-04-17"
  };
  var SRC = {
    readme2604: "https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2604-Readme.md",
    toolset2604: "https://github.com/actions/runner-images/blob/main/images/ubuntu/toolsets/toolset-2604.json",
    issue: "https://github.com/actions/runner-images/issues/14748",
    macos14: "https://github.com/actions/runner-images/issues/13518",
    u2204: "https://github.com/actions/runner-images/issues/14254",
    cmake4: "https://cmake.org/cmake/help/latest/release/4.0.html",
    mysql84: "https://dev.mysql.com/doc/refman/8.4/en/native-pluggable-authentication.html"
  };

  // Setup actions that make a runtime/tool independent of what is preinstalled on the image.
  // key: lowercase "owner/repo" (path after repo ignored); value: list of mitigation tags
  var SETUP_ACTIONS = {
    "actions/setup-python": ["python"],
    "actions/setup-node": ["node", "nodeglobals"],
    "actions/setup-java": ["java", "java8"],
    "graalvm/setup-graalvm": ["java"],
    "ruby/setup-ruby": ["ruby"],
    "shivammathur/setup-php": ["php"],
    "conda-incubator/setup-miniconda": ["conda", "python"],
    "mamba-org/setup-micromamba": ["conda", "python"],
    "julia-actions/setup-julia": ["julia"],
    "swift-actions/setup-swift": ["swift"],
    "pulumi/actions": ["pulumi"],
    "pulumi/setup-pulumi": ["pulumi"],
    "azure/setup-helm": ["helm"],
    "docker/setup-compose-action": ["compose"],
    "kylemayes/install-llvm-action": ["clang"],
    "aminya/setup-cpp": ["clang", "gcc", "cmake"],
    "jwlawson/actions-setup-cmake": ["cmake"],
    "lukka/get-cmake": ["cmake"],
    "maxim-lobanov/setup-xcode": [],
    "jdx/mise-action": ["python", "node", "java", "ruby", "php", "cmake", "helm", "julia", "pulumi"],
    "asdf-vm/actions": ["python", "node", "java", "ruby", "php", "cmake", "helm", "julia", "pulumi"],
    "volta-cli/action": ["node", "nodeglobals"],
    "cachix/install-nix-action": ["python", "node", "java", "ruby", "php", "cmake", "helm", "clang", "gcc", "julia", "pulumi", "swift"]
  };
  var SETUP_FIX = {
    python: "actions/setup-python@v7", node: "actions/setup-node@v7", java: "actions/setup-java@v6",
    ruby: "ruby/setup-ruby@v1", php: "shivammathur/setup-php@v2", conda: "conda-incubator/setup-miniconda@v4",
    julia: "julia-actions/setup-julia@v3", swift: "swift-actions/setup-swift@v2", pulumi: "pulumi/actions@v7",
    helm: "azure/setup-helm@v5", compose: "docker/setup-compose-action@v2", clang: "KyleMayes/install-llvm-action@v2",
    cmake: "jwlawson/actions-setup-cmake@v2"
  };

  // Commands that are on ubuntu-24.04 but NOT on ubuntu-26.04.
  // pkg: how it is usually installed (used to detect a mitigating install in the same job)
  var REMOVED_COMMANDS = {
    tsc: { tool: "TypeScript (global tsc)", pkg: ["typescript"], via: "npm", fix: "Call it through your project: `npx tsc` (with typescript in devDependencies), or `npm install -g typescript` first." },
    webpack: { tool: "webpack (global)", pkg: ["webpack"], via: "npm", fix: "Use `npx webpack` with webpack in devDependencies, or install it in the job." },
    "webpack-cli": { tool: "webpack-cli (global)", pkg: ["webpack-cli"], via: "npm", fix: "Use `npx webpack-cli`, or install it in the job." },
    lerna: { tool: "Lerna (global)", pkg: ["lerna"], via: "npm", fix: "Use `npx lerna` with lerna in devDependencies, or `npm install -g lerna` first." },
    grunt: { tool: "Grunt (global)", pkg: ["grunt", "grunt-cli"], via: "npm", fix: "Use `npx grunt`, or `npm install -g grunt-cli` first." },
    gulp: { tool: "gulp (global)", pkg: ["gulp", "gulp-cli"], via: "npm", fix: "Use `npx gulp`, or `npm install -g gulp-cli` first." },
    parcel: { tool: "Parcel (global)", pkg: ["parcel"], via: "npm", fix: "Use `npx parcel`, or install it in the job." },
    newman: { tool: "Newman (global)", pkg: ["newman"], via: "npm", fix: "Use `npx newman`, or `npm install -g newman` first." },
    fastlane: { tool: "Fastlane", pkg: ["fastlane"], via: "gem", fix: "Add fastlane to a Gemfile and run `bundle exec fastlane` after ruby/setup-ruby@v1, or `gem install fastlane` first." },
    julia: { tool: "Julia", tag: "julia", fix: "Add `julia-actions/setup-julia@v3` before this step." },
    swift: { tool: "Swift", tag: "swift", fix: "Add `swift-actions/setup-swift@v2` before this step (check it supports 26.04), or pin the job to ubuntu-24.04." },
    swiftc: { tool: "Swift", tag: "swift", fix: "Add `swift-actions/setup-swift@v2` before this step, or pin the job to ubuntu-24.04." },
    hg: { tool: "Mercurial", pkg: ["mercurial"], via: "apt", fix: "Install it in the job: `sudo apt-get install -y mercurial`." },
    pulumi: { tool: "Pulumi CLI", tag: "pulumi", fix: "Add `pulumi/actions@v7` (installs the CLI) before this step." },
    mediainfo: { tool: "MediaInfo", pkg: ["mediainfo"], via: "apt", fix: "Install it in the job: `sudo apt-get install -y mediainfo`." },
    haveged: { tool: "haveged", pkg: ["haveged"], via: "apt", fix: "Install it in the job (`sudo apt-get install -y haveged`), or drop it: modern kernels don't need it." },
    searchd: { tool: "Sphinx search server", pkg: ["sphinxsearch"], via: "apt", fix: "Run Sphinx/Manticore in a service container instead." },
    conda: { tool: "Miniconda", tag: "conda", fix: "Add `conda-incubator/setup-miniconda@v4` before this step; $CONDA is empty on 26.04." },
    mamba: { tool: "Miniconda (mamba)", tag: "conda", fix: "Add `conda-incubator/setup-miniconda@v4` or `mamba-org/setup-micromamba@v3`." }
  };

  // Commands whose preinstalled default version changes on 26.04.
  var CHANGED_COMMANDS = {
    python: "python", python3: "python", pip: "python", pip3: "python", pipx: null,
    node: "node", npm: "node", npx: "node", corepack: "node",
    java: "java", javac: "java", mvn: "java", gradle: "java", "./gradlew": "java", "./mvnw": "java", sbt: "java", ant: "java", lein: "java",
    ruby: "ruby", gem: "ruby", bundle: "ruby", rake: "ruby",
    php: "php", composer: "php",
    cmake: "cmake",
    helm: "helm",
    "docker-compose": "compose",
    mysql: "mysql", mysqld: "mysql", mysqladmin: "mysql",
    psql: "postgres", pg_ctl: "postgres", pg_ctlcluster: "postgres", createdb: "postgres",
    clang: "clangdefault", "clang++": "clangdefault",
    gcc: "gccdefault", "g++": "gccdefault", cc: "gccdefault", "c++": "gccdefault", gfortran: "gccdefault",
    openssl: "openssl"
  };
  var CHANGES = {
    python: { sev: "medium", tool: "Python", from: "3.12.3", to: "3.14.4", why: "Default `python3` moves from 3.12 to 3.14. Pinned dependencies without 3.14 wheels fall back to source builds or fail.", tag: "python" },
    node: { sev: "medium", tool: "Node.js", from: "22.23", to: "24.21", why: "Default `node` moves from 22 to 24, and npm from 10 to 11.", tag: "node" },
    java: { sev: "medium", tool: "Java (default JDK)", from: "17", to: "25", why: "The 26.04 image README and toolset list Java 25 as the default JDK (24.04: Java 17). Note: the announcement's summary table says Java 17 remains default, so the sources disagree; pin it to be safe.", tag: "java" },
    ruby: { sev: "low", tool: "Ruby", from: "3.2.3", to: "3.3.8", why: "System Ruby moves from 3.2 to 3.3; native gems rebuild.", tag: "ruby" },
    php: { sev: "medium", tool: "PHP", from: "8.3", to: "8.5", why: "Preinstalled PHP jumps two minor versions (8.3 to 8.5); deprecations can become errors in strict test suites.", tag: "php" },
    cmake: { sev: "medium", tool: "CMake", from: "3.31.6", to: "4.4.3", why: "CMake 4 removed compatibility with `cmake_minimum_required` below 3.5, so older projects and vendored dependencies fail at configure time. (24.04 kept CMake pinned to 3.31 for exactly this reason.)", tag: "cmake", fixExtra: "Or raise `cmake_minimum_required(VERSION 3.5...)`, or pass `-DCMAKE_POLICY_VERSION_MINIMUM=3.5` to configure.", link: "cmake4" },
    helm: { sev: "medium", tool: "Helm", from: "3.22", to: "4.3", why: "Helm moves to a new major version (3 to 4). Plugins and some flags changed.", tag: "helm" },
    compose: { sev: "medium", tool: "Docker Compose", from: "2.38.2", to: "5.1.3", why: "Docker Compose jumps major versions (2.38 to 5.1), and Docker Engine moves from 28 to 29.", tag: "compose" },
    mysql: { sev: "medium", tool: "MySQL (preinstalled server)", from: "8.0", to: "8.4", why: "The preinstalled MySQL server moves from 8.0 to 8.4 LTS, where the `mysql_native_password` plugin is disabled by default. Old clients and `IDENTIFIED WITH mysql_native_password` setups fail to authenticate.", tag: "mysql", fixExtra: "Use a `services:` container with a pinned image (e.g. mysql:8.0), or update clients to caching_sha2_password.", link: "mysql84" },
    postgres: { sev: "medium", tool: "PostgreSQL (preinstalled)", from: "16", to: "18", why: "Preinstalled PostgreSQL moves from 16 to 18.", tag: "postgres", fixExtra: "Use a `services:` container with a pinned postgres image." },
    clangdefault: { sev: "low", tool: "Clang (default)", from: "18", to: "21", why: "Default clang moves from 18 to 21; new warnings may fail -Werror builds.", tag: "clang" },
    gccdefault: { sev: "low", tool: "GCC (default)", from: "13", to: "15", why: "Default gcc/g++ moves from 13 to 15 (15 defaults to C23 for C); new warnings may fail -Werror builds.", tag: "gcc" },
    openssl: { sev: "low", tool: "OpenSSL", from: "3.0.13", to: "3.5.5", why: "System OpenSSL moves from 3.0 to 3.5.", tag: null }
  };

  var APT_RENAMED = {
    "p7zip-full": "7zip", "p7zip-rar": "7zip-rar", "dnsutils": "bind9-dnsutils"
  };

  var LABELS = [
    { re: /^ubuntu-latest$/, kind: "moves", note: "Moves to Ubuntu 26.04 between Oct 19 and Nov 19, 2026." },
    { re: /^ubuntu-26\.04(-arm)?$/, kind: "on26", note: "Already on Ubuntu 26.04." },
    { re: /^ubuntu-24\.04(-arm)?$/, kind: "pinned", note: "Pinned to Ubuntu 24.04; not affected by the ubuntu-latest move." },
    { re: /^ubuntu-22\.04(-arm)?$/, kind: "u2204", note: "Ubuntu 22.04 is deprecated (since Sep 17, 2026) and fully unsupported from Apr 17, 2027, with brownouts in March and April 2027." },
    { re: /^ubuntu-(20\.04|18\.04)$/, kind: "gone", note: "This image has already been retired; jobs using it will not run." },
    { re: /^ubuntu-slim$/, kind: "other", note: "ubuntu-slim is a separate image; not part of this move." },
    { re: /^macos-14(-large|-xlarge|-arm64)?$/, kind: "macos14", note: "macOS 14 images are fully unsupported from Nov 2, 2026. Move to macos-15 or macos-latest." },
    { re: /^macos-1[123](-large|-xlarge)?$/, kind: "gone", note: "This macOS image has already been retired." }
  ];

  function classifyLabel(label) {
    var l = String(label).trim().toLowerCase();
    for (var i = 0; i < LABELS.length; i++) if (LABELS[i].re.test(l)) return { label: l, kind: LABELS[i].kind, note: LABELS[i].note };
    if (/\$\{\{/.test(l)) return { label: l, kind: "unknown", note: "Runner label comes from an expression the checker could not resolve." };
    return { label: l, kind: "other", note: "Not a GitHub-hosted Ubuntu label (self-hosted, Windows, macOS or a larger-runner name)." };
  }

  function daysUntil(iso, now) {
    var p = iso.split("-").map(Number);
    var t = new Date(p[0], p[1] - 1, p[2]);
    var n = now ? new Date(now.getFullYear(), now.getMonth(), now.getDate()) : (function () { var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); })();
    return Math.round((t - n) / 86400000);
  }
  function fmtDate(iso) {
    var m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var p = iso.split("-").map(Number);
    return m[p[1] - 1] + " " + p[2] + ", " + p[0];
  }

  // ---------- shell helpers ----------
  function stripComment(line) {
    // remove "# ..." when # starts a word (not inside quotes, not ${#var}, not a URL fragment)
    var q = null;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (q) { if (c === q && line[i - 1] !== "\\") q = null; continue; }
      if (c === "'" || c === '"') { q = c; continue; }
      if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
    }
    return line;
  }
  var PREFIX_WORDS = { sudo: 1, time: 1, then: 1, do: 1, else: 1, exec: 1, command: 1, nohup: 1, "!": 1, if: 1, while: 1, until: 1, "{": 1, "(": 1, env: 1, xvfb_run: 1, "xvfb-run": 1, timeout: 1, stdbuf: 1, nice: 1 };
  // Returns [{cmd, rest, raw}] for every simple command on the line.
  function commandsInLine(line) {
    var out = [];
    var clean = stripComment(line);
    var segs = clean.split(/&&|\|\||;|\||\$\(|`|\bthen\b|\bdo\b/);
    for (var s = 0; s < segs.length; s++) {
      var toks = segs[s].trim().split(/\s+/).filter(Boolean);
      var i = 0;
      while (i < toks.length) {
        var t = toks[i];
        if (PREFIX_WORDS[t]) { i++; if (t === "timeout" && i < toks.length && /^\d/.test(toks[i])) i++; continue; }
        if (/^-/.test(t) && i > 0 && PREFIX_WORDS[toks[i - 1]]) { i++; continue; } // sudo -E
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; } // FOO=bar cmd
        break;
      }
      if (i < toks.length) {
        var cmd = toks[i].replace(/^["'(]+|["');]+$/g, "");
        out.push({ cmd: cmd, rest: toks.slice(i + 1).join(" "), raw: segs[s].trim() });
      }
    }
    return out;
  }

  // ---------- YAML walking ----------
  function asArray(v) { return v == null ? [] : Array.isArray(v) ? v : [v]; }
  function actionName(uses) {
    var u = String(uses || "").trim();
    if (!u || u.indexOf("docker://") === 0 || u.indexOf("./") === 0) return u.split("@")[0].toLowerCase();
    var noRef = u.split("@")[0].toLowerCase();
    var parts = noRef.split("/");
    return parts.slice(0, 2).join("/");
  }

  // Find the 1-based line number in source where `needle` first appears at or after `fromLine`.
  function findLine(lines, needle, fromLine) {
    if (!needle) return null;
    var n = String(needle).split("\n")[0].trim();
    if (!n) return null;
    for (var i = Math.max(0, (fromLine || 1) - 1); i < lines.length; i++) if (lines[i].indexOf(n) !== -1) return i + 1;
    for (var j = 0; j < lines.length; j++) if (lines[j].indexOf(n) !== -1) return j + 1;
    return null;
  }
  function findKeyLine(lines, key, fromLine) {
    var re = new RegExp("^\\s*" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:");
    for (var i = Math.max(0, (fromLine || 1) - 1); i < lines.length; i++) if (re.test(lines[i])) return i + 1;
    return null;
  }

  function resolveRunsOn(job, workflow) {
    var ro = job["runs-on"];
    if (ro == null) return { labels: [], unresolved: job.uses ? "reusable" : "missing" };
    var raw = [];
    if (typeof ro === "string" || typeof ro === "number") raw = [String(ro)];
    else if (Array.isArray(ro)) raw = ro.map(String);
    else if (typeof ro === "object") raw = asArray(ro.labels).map(String).concat(ro.group ? ["group:" + ro.group] : []);
    var labels = [];
    var unresolved = null;
    raw.forEach(function (r) {
      var m = r.match(/^\s*\$\{\{\s*matrix\.([A-Za-z0-9_\-]+)\s*\}\}\s*$/);
      var mi = r.match(/^\s*\$\{\{\s*inputs\.([A-Za-z0-9_\-]+)\s*\}\}\s*$/);
      if (m) {
        var key = m[1];
        var mx = job.strategy && job.strategy.matrix;
        var vals = [];
        if (mx && typeof mx === "object") {
          vals = asArray(mx[key]).filter(function (v) { return typeof v === "string" || Array.isArray(v); });
          asArray(mx.include).forEach(function (inc) { if (inc && inc[key] != null) vals.push(inc[key]); });
        }
        var flat = [];
        vals.forEach(function (v) { asArray(v).forEach(function (x) { if (typeof x === "string") flat.push(x); }); });
        if (flat.length) labels = labels.concat(flat); else unresolved = "matrix." + key;
      } else if (mi) {
        var on = workflow && workflow.on;
        var inputs = on && typeof on === "object" && ((on.workflow_call && on.workflow_call.inputs) || (on.workflow_dispatch && on.workflow_dispatch.inputs));
        var def = inputs && inputs[mi[1]] && inputs[mi[1]].default;
        if (typeof def === "string") labels.push(def); else unresolved = "inputs." + mi[1];
      } else if (/\$\{\{/.test(r)) {
        unresolved = r.trim();
      } else labels.push(r);
    });
    var seen = {};
    labels = labels.filter(function (l) { var k = l.trim().toLowerCase(); if (seen[k]) return false; seen[k] = 1; return true; });
    return { labels: labels, unresolved: unresolved };
  }

  // A job whose labels include self-hosted is not a GitHub-hosted image.
  function jobKinds(labels) {
    var lower = labels.map(function (l) { return l.trim().toLowerCase(); });
    if (lower.indexOf("self-hosted") !== -1) return [{ label: "self-hosted", kind: "other", note: "Self-hosted runner: you control the image, so this move does not apply." }];
    return lower.map(classifyLabel);
  }

  var SEV_RANK = { high: 3, medium: 2, low: 1, info: 0 };

  function scanJob(jobId, job, ctx) {
    var findings = [];
    var steps = asArray(job.steps);
    var mitig = {};
    var apt = {};
    var npmGlobal = {};
    var gemInstalled = {};
    var setupList = [];
    var stepFrom = ctx.jobLine || 1;

    steps.forEach(function (st) {
      if (!st || typeof st !== "object") return;
      if (st.uses) {
        var a = actionName(st.uses);
        setupList.push(a);
        var tags = SETUP_ACTIONS[a];
        if (a === "astral-sh/setup-uv") tags = st.with && st.with["python-version"] ? ["python"] : [];
        (tags || []).forEach(function (t) { mitig[t] = true; });
        if (a === "actions/setup-java" && st.with && /^8(\D|$)|^1\.8/.test(String(st.with["java-version"] || ""))) mitig.java8 = true;
      }
      if (typeof st.run === "string") {
        st.run.split("\n").forEach(function (line) {
          commandsInLine(line).forEach(function (c) {
            if (c.cmd === "apt-get" || c.cmd === "apt") {
              var m = c.rest.match(/\binstall\b(.*)$/);
              if (m) m[1].split(/\s+/).forEach(function (p) { if (p && p[0] !== "-") apt[p.replace(/[=:].*$/, "")] = true; });
            }
            if (c.cmd === "npm" || c.cmd === "pnpm" || c.cmd === "yarn") {
              var g = /(^|\s)(-g|--global|global)(\s|$)/.test(c.rest) && /\b(install|i|add)\b/.test(c.rest);
              if (g) c.rest.split(/\s+/).forEach(function (p) { if (p && p[0] !== "-") npmGlobal[p.replace(/@[^/]*$/, "")] = true; });
            }
            if (c.cmd === "gem" && /\binstall\b/.test(c.rest)) c.rest.split(/\s+/).forEach(function (p) { if (p && p[0] !== "-") gemInstalled[p] = true; });
            if (c.cmd === "brew" && /\binstall\b/.test(c.rest)) c.rest.split(/\s+/).forEach(function (p) { if (p && p[0] !== "-") { apt[p] = true; npmGlobal[p] = true; } });
          });
        });
      }
    });

    function add(f) {
      // de-duplicate by rule+command
      var key = f.rule.indexOf("changed-") === 0 ? f.rule : f.rule + "|" + (f.cmd || "");
      for (var i = 0; i < findings.length; i++) if (findings[i]._k === key) { findings[i].count++; return; }
      f._k = key; f.count = 1; f.job = jobId;
      findings.push(f);
    }

    var services = job.services && typeof job.services === "object" ? Object.keys(job.services).map(function (k) { var s = job.services[k]; return String((s && s.image) || s || k).toLowerCase(); }) : [];
    var hasServiceDb = function (name) { return services.some(function (s) { return s.indexOf(name) !== -1; }); };

    var jobText = ctx.jobText || "";
    // compiler versions removed from the image (anywhere in the job: run, env, matrix, with)
    var compilerRe = /\b((?:clang(?:\+\+|-format|-tidy)?|llvm-[a-z]+|lld|clangd)-(1[678]))\b|\b((?:g\+\+|gcc|gfortran|cpp)-12)\b/g;
    var m;
    var seenComp = {};
    while ((m = compilerRe.exec(jobText))) {
      var tok = m[0];
      if (seenComp[tok]) continue; seenComp[tok] = 1;
      var isClang = !!m[1];
      if (isClang && mitig.clang) continue;
      if (!isClang && mitig.gcc) continue;
      if (apt[tok]) continue;
      add({ rule: "removed-compiler", sev: "high", cmd: tok, tool: isClang ? "Clang/LLVM " + m[2] : "GCC 12",
        title: "`" + tok + "` is not on Ubuntu 26.04",
        why: isClang ? "Ubuntu 26.04 ships Clang 20, 21 and 22 (24.04 had 16, 17, 18)." : "Ubuntu 26.04 ships GCC 13, 14 and 15 (24.04 had 12, 13, 14).",
        fix: isClang ? "Use clang-20/21/22, install the version with KyleMayes/install-llvm-action@v2, or pin this job to ubuntu-24.04." : "Use gcc-13 or newer, or pin this job to ubuntu-24.04.",
        line: findLine(ctx.lines, tok, stepFrom) });
    }
    if (/JAVA_HOME_8_X64/.test(jobText) && !mitig.java8) {
      add({ rule: "java8", sev: "high", cmd: "JAVA_HOME_8_X64", tool: "Java 8", title: "Java 8 (JAVA_HOME_8_X64) is not on Ubuntu 26.04",
        why: "26.04 ships Java 11, 17, 21 and 25 only; JAVA_HOME_8_X64 is unset.",
        fix: "Add actions/setup-java@v6 with `java-version: '8'` and `distribution: temurin`, or pin to ubuntu-24.04.",
        line: findLine(ctx.lines, "JAVA_HOME_8_X64", stepFrom) });
    }
    if (/\$\{?CONDA\b/.test(jobText) && !mitig.conda) {
      add({ rule: "removed", sev: "high", cmd: "$CONDA", tool: "Miniconda", title: "`$CONDA` is empty on Ubuntu 26.04",
        why: "Miniconda is no longer preinstalled, so the CONDA variable has no value and $CONDA/bin does not exist.",
        fix: REMOVED_COMMANDS.conda.fix, line: findLine(ctx.lines, "CONDA", stepFrom) });
    }

    steps.forEach(function (st, idx) {
      if (!st || typeof st.run !== "string") return;
      var stepName = st.name || st.id || ("step " + (idx + 1));
      var runLines = st.run.split("\n");
      runLines.forEach(function (line) {
        commandsInLine(line).forEach(function (c) {
          var cmd = c.cmd;
          if (!cmd || cmd.indexOf("/") !== -1 && cmd !== "./gradlew" && cmd !== "./mvnw") return;
          var line1 = findLine(ctx.lines, c.raw, stepFrom) || findLine(ctx.lines, line.trim(), stepFrom);
          var rm = REMOVED_COMMANDS[cmd];
          if (rm) {
            var ok = (rm.tag && mitig[rm.tag]) || (rm.pkg && rm.pkg.some(function (p) { return (rm.via === "npm" && npmGlobal[p]) || (rm.via === "apt" && apt[p]) || (rm.via === "gem" && Object.keys(gemInstalled).some(function (g) { return g.indexOf(p) !== -1 || /\$\{\{|\.gem"?$/.test(g); })); }));
            if (!ok) add({ rule: "removed", sev: "high", cmd: cmd, tool: rm.tool, step: stepName,
              title: "`" + cmd + "` is not preinstalled on Ubuntu 26.04",
              why: rm.tool + " was preinstalled on ubuntu-24.04 and is removed from the 26.04 image. The step will fail with \"command not found\".",
              fix: rm.fix, line: line1 });
            return;
          }
          if (cmd === "docker" && /^compose\b/.test(c.rest)) cmd = "docker-compose";
          if (cmd === "systemctl" || cmd === "service") {
            if (/\bmysql\b/.test(c.rest)) cmd = "mysql"; else if (/\bpostgresql\b/.test(c.rest)) cmd = "psql"; else return;
          }
          if (/^\/etc\/init\.d\/mysql/.test(c.cmd)) cmd = "mysql";
          var key = CHANGED_COMMANDS[cmd];
          if (!key) return;
          var ch = CHANGES[key];
          if (ch.tag && mitig[ch.tag]) return;
          if (key === "mysql" && hasServiceDb("mysql")) return;
          if (key === "postgres" && hasServiceDb("postgres")) return;
          var fix = ch.tag && SETUP_FIX[ch.tag] ? "Pin the version with `" + SETUP_FIX[ch.tag] + "` before this step" + (ch.fixExtra ? ". " + ch.fixExtra : ".") : (ch.fixExtra || "Test this step on ubuntu-26.04, or pin the job to ubuntu-24.04.");
          add({ rule: "changed-" + key, sev: ch.sev, cmd: cmd, tool: ch.tool, step: stepName,
            title: ch.tool + " changes from " + ch.from + " to " + ch.to,
            why: ch.why, fix: fix, link: ch.link ? SRC[ch.link] : null, line: line1 });
        });
        // apt names that changed
        var cl = stripComment(line);
        if (/\bapt(-get)?\b[^\n]*\binstall\b/.test(cl)) {
          Object.keys(APT_RENAMED).forEach(function (p) {
            if (new RegExp("(^|\\s)" + p.replace(/[-]/g, "\\-") + "(\\s|$)").test(cl)) add({ rule: "apt-renamed", sev: "low", cmd: p, tool: p, step: stepName,
              title: "Package `" + p + "` is `" + APT_RENAMED[p] + "` on the 26.04 image",
              why: "The image now preinstalls `" + APT_RENAMED[p] + "` instead of `" + p + "`. The commands it provides are already present, so this install may be unnecessary; if `apt-get` reports the package is missing on 26.04, switch to the new name.",
              fix: "Install `" + APT_RENAMED[p] + "`, or drop the install.", line: findLine(ctx.lines, p, stepFrom) });
          });
        }
      });
    });

    findings.sort(function (a, b) { return (SEV_RANK[b.sev] - SEV_RANK[a.sev]) || ((a.line || 0) - (b.line || 0)); });
    findings.forEach(function (f) { delete f._k; });
    return { findings: findings, setups: setupList };
  }

  function sliceJobText(lines, startLine, nextStart) {
    return lines.slice(Math.max(0, startLine - 1), nextStart ? nextStart - 1 : lines.length).join("\n");
  }

  function verdictFor(kinds, findings, extra) {
    var ks = kinds.map(function (k) { return k.kind; });
    var top = findings.reduce(function (m, f) { return Math.max(m, SEV_RANK[f.sev]); }, -1);
    if (ks.indexOf("gone") !== -1) return { level: "high", text: "Uses a retired runner image" };
    if (ks.indexOf("macos14") !== -1) return { level: "high", text: "macOS 14 is unsupported from Nov 2, 2026" };
    if (ks.indexOf("moves") !== -1) {
      if (extra && extra.container) return { level: "low", text: "Moves to 26.04, but steps run in a container" };
      if (top >= 3) return { level: "high", text: "Likely to break on 26.04" };
      if (top === 2) return { level: "medium", text: "Test on 26.04 before Oct 19" };
      return { level: "low", text: "Moves to 26.04; no known breakers found" };
    }
    if (ks.indexOf("on26") !== -1) {
      if (top >= 3) return { level: "medium", text: "Already on 26.04 but uses removed tools" };
      return { level: "ok", text: "Already on 26.04" };
    }
    if (ks.indexOf("u2204") !== -1) return { level: "medium", text: "Ubuntu 22.04 is deprecated" };
    if (ks.indexOf("unknown") !== -1 || (extra && extra.unresolved)) return { level: "info", text: "Runner label not resolved" };
    if (ks.indexOf("pinned") !== -1) return { level: "ok", text: "Pinned to 24.04: not affected" };
    if (extra && extra.reusable) return { level: "info", text: "Calls a reusable workflow" };
    return { level: "ok", text: "Not a GitHub-hosted Ubuntu runner" };
  }

  function analyzeGithub(doc, text, lines, fileName) {
    var jobs = doc.jobs || {};
    var ids = Object.keys(jobs);
    var jobStarts = ids.map(function (id) {
      var jl = findKeyLine(lines, id, findKeyLine(lines, "jobs") || 1);
      return jl;
    });
    var results = ids.map(function (id, i) {
      var job = jobs[id] || {};
      var start = jobStarts[i] || 1;
      var next = null;
      for (var k = 0; k < jobStarts.length; k++) if (jobStarts[k] && jobStarts[k] > start && (!next || jobStarts[k] < next)) next = jobStarts[k];
      var jobText = sliceJobText(lines, start, next);
      var ro = resolveRunsOn(job, doc);
      var kinds = jobKinds(ro.labels);
      var affected = kinds.some(function (k) { return k.kind === "moves" || k.kind === "on26"; });
      var container = !!job.container;
      var scan = { findings: [], setups: [] };
      if (affected && !container) scan = scanJob(id, job, { lines: lines, jobLine: start, jobText: jobText });
      var notes = [];
      if (ro.unresolved === "reusable") notes.push("This job calls a reusable workflow (`" + job.uses + "`). Check that workflow's runs-on too.");
      else if (ro.unresolved === "missing") notes.push("No runs-on found.");
      else if (ro.unresolved) notes.push("Could not resolve `" + ro.unresolved + "`. If it can be ubuntu-latest, this job is affected.");
      var localActs = scan.setups.filter(function (a) { return a.indexOf("./") === 0; });
      if (affected && localActs.length) notes.push("Uses local action" + (localActs.length > 1 ? "s " : " ") + localActs.map(function (a) { return "`" + a + "`"; }).join(", ") + ". If they install runtimes (setup-java, setup-python...), some findings below are already handled.");
      if (container && affected) notes.push("Steps run inside the `" + (typeof job.container === "string" ? job.container : (job.container.image || "container")) + "` image, so tools come from that image, not the runner.");
      var verdict = verdictFor(kinds, scan.findings, { container: container, unresolved: ro.unresolved && ro.unresolved !== "reusable" && ro.unresolved !== "missing", reusable: ro.unresolved === "reusable" });
      return {
        id: id, name: job.name || id, line: start, labels: kinds, unresolved: ro.unresolved,
        container: container, findings: scan.findings, setups: scan.setups, notes: notes, verdict: verdict,
        runsOnLine: findKeyLine(lines, "runs-on", start)
      };
    });
    return results;
  }

  // Azure Pipelines: vmImage: ubuntu-latest moves too (same images, same issue).
  function analyzeAzure(doc, text, lines) {
    var vm = [];
    var scripts = [];
    (function walk(n) {
      if (Array.isArray(n)) return n.forEach(walk);
      if (n && typeof n === "object") {
        Object.keys(n).forEach(function (k) {
          var v = n[k];
          if (k === "vmImage" && typeof v === "string") vm.push(v);
          else if ((k === "script" || k === "bash") && typeof v === "string") scripts.push(v);
          else walk(v);
        });
      }
    })(doc);
    var labels = vm.map(function (v) { return v.replace(/^ubuntu-(\d\d)\.04$/, "ubuntu-$1.04"); });
    var kinds = jobKinds(labels.length ? labels : []);
    var affected = kinds.some(function (k) { return k.kind === "moves" || k.kind === "on26"; });
    var fake = { steps: scripts.map(function (s) { return { run: s }; }) };
    var scan = affected ? scanJob("pipeline", fake, { lines: lines, jobLine: 1, jobText: text }) : { findings: [], setups: [] };
    return [{ id: "pipeline", name: "Azure Pipelines (all jobs)", line: findKeyLine(lines, "vmImage") || 1, labels: kinds, unresolved: null,
      container: false, findings: scan.findings, setups: [], notes: ["Azure DevOps Microsoft-hosted `ubuntu-latest` follows the same images and the same migration (announcement #14748). Use the UsePythonVersion / JavaToolInstaller / NodeTool tasks to pin runtimes."],
      verdict: verdictFor(kinds, scan.findings, {}), runsOnLine: findKeyLine(lines, "vmImage") }];
  }

  function analyze(text, opts) {
    opts = opts || {};
    var yaml = opts.yaml || (typeof window !== "undefined" ? window.jsyaml : null);
    var fileName = opts.fileName || "workflow.yml";
    var src = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
    if (!src.trim()) return { file: fileName, error: "This file is empty." };
    if (src.length > 500000) return { file: fileName, error: "This file is larger than 500 KB; paste one workflow at a time." };
    var doc;
    try { doc = yaml.load(src, { json: true }); }
    catch (e) {
      var ln = e && e.mark ? e.mark.line + 1 : null;
      return { file: fileName, error: "This isn't valid YAML" + (ln ? " (line " + ln + ")" : "") + ": " + String(e.reason || e.message || e).split("\n")[0] };
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { file: fileName, error: "This doesn't look like a workflow file (expected a YAML mapping with `jobs:`)." };
    var lines = src.split("\n");
    var type, jobs;
    if (doc.jobs && typeof doc.jobs === "object" && !Array.isArray(doc.jobs)) { type = "github"; jobs = analyzeGithub(doc, src, lines, fileName); }
    else if (/\bvmImage\s*:/.test(src) || doc.pool || doc.stages) { type = "azure"; jobs = analyzeAzure(doc, src, lines); }
    else if (doc.runs && doc.runs.using) return { file: fileName, error: "This is an action definition (action.yml), not a workflow. Paste the workflow that uses it; composite action steps run on the caller's runner." };
    else return { file: fileName, error: "No `jobs:` found. Paste a file from .github/workflows/." };
    var counts = { high: 0, medium: 0, low: 0 };
    var levels = { high: 0, medium: 0, low: 0, ok: 0, info: 0 };
    jobs.forEach(function (j) { levels[j.verdict.level]++; j.findings.forEach(function (f) { if (counts[f.sev] != null) counts[f.sev]++; }); });
    var worst = levels.high ? "high" : levels.medium ? "medium" : levels.low ? "low" : levels.info ? "info" : "ok";
    return { file: fileName, type: type, name: doc.name || fileName, jobs: jobs, counts: counts, levels: levels, worst: worst, source: src };
  }

  // Replace runner label ubuntu-latest with ubuntu-24.04 outside comments. Returns {text, changed: [lineNumbers]}
  function pinPatch(src) {
    var changed = [];
    var out = String(src).replace(/\r\n?/g, "\n").split("\n").map(function (line, i) {
      var code = stripComment(line);
      var comment = line.slice(code.length);
      if (!/\bubuntu-latest\b/.test(code)) return line;
      changed.push(i + 1);
      return code.replace(/\bubuntu-latest\b/g, "ubuntu-24.04") + comment;
    });
    return { text: out.join("\n"), changed: changed };
  }

  var PROBE = {
    tsc: "tsc", webpack: "webpack", "webpack-cli": "webpack-cli", lerna: "lerna", grunt: "grunt", gulp: "gulp", parcel: "parcel", newman: "newman",
    fastlane: "fastlane", julia: "julia", swift: "swift", swiftc: "swift", hg: "hg", pulumi: "pulumi", mediainfo: "mediainfo", haveged: "haveged", searchd: "searchd", conda: "conda", mamba: "mamba"
  };
  var VERSION_CMDS = [
    ["python3", "python3 --version"], ["node", "node --version"], ["java", "java -version 2>&1 | head -1"], ["ruby", "ruby --version"],
    ["php", "php --version | head -1"], ["cmake", "cmake --version | head -1"], ["helm", "helm version --short"], ["docker compose", "docker compose version"],
    ["gcc", "gcc --version | head -1"], ["clang", "clang --version | head -1"], ["mysql", "mysql --version"], ["psql", "psql --version"], ["openssl", "openssl version"]
  ];

  // Generate a canary workflow that runs on both images and checks each tool this file relies on.
  function canaryWorkflow(results) {
    var tools = {};
    var jobsAffected = [];
    results.forEach(function (r) {
      if (!r || !r.jobs) return;
      r.jobs.forEach(function (j) {
        if (j.labels.some(function (k) { return k.kind === "moves"; })) jobsAffected.push(r.file + " → " + j.id);
        j.findings.forEach(function (f) {
          if (f.rule === "removed" && PROBE[f.cmd]) tools[PROBE[f.cmd]] = 1;
          if (f.rule === "removed-compiler") tools[f.cmd] = 1;
        });
      });
    });
    var tl = Object.keys(tools).sort();
    var y = [];
    y.push("# Generated by Ubuntu 26 Runner Check (" + DATA_AS_OF + " data).");
    y.push("# Runs on ubuntu-24.04 and ubuntu-26.04 side by side so you can compare before ubuntu-latest moves (Oct 19 - Nov 19, 2026).");
    if (jobsAffected.length) y.push("# Jobs on ubuntu-latest: " + jobsAffected.slice(0, 20).join(", ") + (jobsAffected.length > 20 ? ", ..." : ""));
    y.push("name: ubuntu-26-canary");
    y.push("on:");
    y.push("  workflow_dispatch:");
    y.push("permissions:");
    y.push("  contents: read");
    y.push("jobs:");
    y.push("  compare:");
    y.push("    strategy:");
    y.push("      fail-fast: false");
    y.push("      matrix:");
    y.push("        os: [ubuntu-24.04, ubuntu-26.04]");
    y.push("    runs-on: ${{ matrix.os }}");
    y.push("    steps:");
    y.push("      - name: Default tool versions");
    y.push("        run: |");
    y.push("          cat /etc/os-release | head -2");
    VERSION_CMDS.forEach(function (v) { y.push("          echo \"--- " + v[0] + "\"; " + v[1] + " || echo \"(not installed)\""); });
    y.push("      - name: Tools this repo calls that 26.04 removed");
    y.push("        run: |");
    if (!tl.length) y.push("          echo \"No removed tools detected by the checker.\"");
    else {
      y.push("          missing=0");
      tl.forEach(function (t) { y.push("          if command -v " + t + " >/dev/null 2>&1; then echo \"ok      " + t + "\"; else echo \"MISSING " + t + "\"; missing=1; fi"); });
      y.push("          if [ \"$missing\" = 1 ]; then echo \"::warning::Some tools are missing on ${{ matrix.os }}\"; fi");
    }
    y.push("      # Next: copy your real job here with runs-on: ${{ matrix.os }} to run your build on both images.");
    return y.join("\n") + "\n";
  }

  function markdownReport(results, now) {
    var md = ["# Ubuntu 26.04 runner check", "", "`ubuntu-latest` moves from Ubuntu 24.04 to 26.04 between " + fmtDate(DATES.migrationStart) + " and " + fmtDate(DATES.migrationEnd) + " ([announcement](" + SRC.issue + ")). Data: runner-images toolsets and image READMEs as of " + DATA_AS_OF + ".", ""];
    results.forEach(function (r) {
      if (r.error) { md.push("## " + r.file, "", "Not checked: " + r.error, ""); return; }
      md.push("## " + r.file, "");
      r.jobs.forEach(function (j) {
        md.push("### `" + j.id + "`: " + j.verdict.text, "");
        md.push("Runner: " + (j.labels.length ? j.labels.map(function (k) { return "`" + k.label + "`"; }).join(", ") : "unresolved"), "");
        j.notes.forEach(function (n) { md.push("- " + n); });
        j.findings.forEach(function (f) {
          md.push("- [ ] **" + f.sev.toUpperCase() + "** " + f.title + (f.line ? " (line " + f.line + ")" : "") + ". " + f.why + " Fix: " + f.fix);
        });
        if (!j.findings.length && !j.notes.length) md.push("- No issues found.");
        md.push("");
      });
    });
    md.push("Generated by Ubuntu 26 Runner Check: https://abhishek01239.github.io/product-factory/runner-26-check/ (static checks; run the canary workflow to confirm).");
    return md.join("\n") + "\n";
  }

  var SAMPLE = [
    "name: CI",
    "on: [push, pull_request]",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v7",
    "      - uses: actions/setup-node@v7",
    "        with:",
    "          node-version: 22",
    "      - run: npm ci",
    "      - name: Type-check",
    "        run: tsc --noEmit",
    "      - name: Native addon",
    "        run: |",
    "          cmake -S native -B build -DCMAKE_CXX_COMPILER=clang++-17",
    "          cmake --build build",
    "  python:",
    "    runs-on: ${{ matrix.os }}",
    "    strategy:",
    "      matrix:",
    "        os: [ubuntu-latest, macos-14]",
    "    steps:",
    "      - uses: actions/checkout@v7",
    "      - run: pip install -r requirements.txt && python -m pytest",
    "      - run: $CONDA/bin/conda env list",
    "  integration:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v7",
    "      - run: docker compose up -d --wait",
    "      - run: ./gradlew test",
    "  release:",
    "    runs-on: ubuntu-24.04",
    "    steps:",
    "      - run: echo pinned, not affected",
    ""
  ].join("\n");

  return {
    DATA_AS_OF: DATA_AS_OF, DATES: DATES, SRC: SRC, SAMPLE: SAMPLE,
    REMOVED_COMMANDS: REMOVED_COMMANDS, CHANGES: CHANGES,
    analyze: analyze, pinPatch: pinPatch, canaryWorkflow: canaryWorkflow, markdownReport: markdownReport,
    commandsInLine: commandsInLine, stripComment: stripComment, classifyLabel: classifyLabel, resolveRunsOn: resolveRunsOn,
    daysUntil: daysUntil, fmtDate: fmtDate, actionName: actionName
  };
});
