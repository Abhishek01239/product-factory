/* Python 3.15 Readiness Check — analysis engine (no DOM). Works in browsers (window.P315) and Node (module.exports).
 * Sources (checked 2026-10-13):
 *  - What's new in Python 3.15 (released 9 Oct 2026): https://docs.python.org/3/whatsnew/3.15.html
 *  - PEP 686 (UTF-8 default): https://peps.python.org/pep-0686/
 *  - Wheel platform/ABI tags: https://packaging.python.org/en/latest/specifications/platform-compatibility-tags/
 *  - Docker official image tags (python:3, latest, slim, alpine -> 3.15.0): https://github.com/docker-library/official-images/blob/master/library/python
 *  - setup-python versions manifest (3.15.0 available): https://github.com/actions/python-versions/blob/main/versions-manifest.json
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.P315 = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DATA_AS_OF = "2026-10-13";
  var TARGET = { major: 3, minor: 15, full: "3.15.0" };
  var SRC = {
    whatsnew: "https://docs.python.org/3/whatsnew/3.15.html",
    removed: "https://docs.python.org/3/whatsnew/3.15.html#removed",
    porting: "https://docs.python.org/3/whatsnew/3.15.html#porting-to-python-3-15",
    pep686: "https://peps.python.org/pep-0686/",
    pep829: "https://docs.python.org/3/whatsnew/3.15.html#pep-829-package-startup-configuration-files",
    tags: "https://packaging.python.org/en/latest/specifications/platform-compatibility-tags/",
    docker: "https://github.com/docker-library/official-images/blob/master/library/python",
    setupPython: "https://github.com/actions/python-versions/blob/main/versions-manifest.json"
  };

  var PLATFORMS = [
    { id: "linux-x86_64", label: "Linux x86-64 (glibc)" },
    { id: "linux-aarch64", label: "Linux ARM64 (glibc)" },
    { id: "musl-x86_64", label: "Alpine / musl x86-64" },
    { id: "macos-arm64", label: "macOS Apple silicon" },
    { id: "macos-x86_64", label: "macOS Intel" },
    { id: "win-amd64", label: "Windows x64" }
  ];
  var DEFAULT_PLATFORMS = ["linux-x86_64", "macos-arm64", "win-amd64"];

  // ------------------------------------------------------------- names
  function normName(n) { return String(n || "").trim().toLowerCase().replace(/[-_.]+/g, "-"); }

  // ------------------------------------------------------------- PEP 440 (subset)
  function parseVer(v) {
    var s = String(v || "").trim().toLowerCase().replace(/^v/, "");
    s = s.replace(/^(\d+!)/, ""); // drop epoch (rare)
    s = s.split("+")[0];
    var m = /^(\d+(?:\.\d+)*)(?:[-_.]?(a|b|c|rc|alpha|beta|pre|preview)[-_.]?(\d*))?(?:(?:[-_.]?(post|rev|r)[-_.]?(\d*))|-(\d+))?(?:[-_.]?dev[-_.]?(\d*))?$/.exec(s);
    if (!m) return null;
    var pre = null;
    if (m[2]) {
      var t = m[2];
      t = t === "alpha" ? "a" : t === "beta" ? "b" : (t === "c" || t === "pre" || t === "preview") ? "rc" : t;
      pre = [t === "a" ? 0 : t === "b" ? 1 : 2, +(m[3] || 0)];
    }
    var post = m[4] ? +(m[5] || 0) : m[6] ? +m[6] : null;
    var dev = m[7] !== undefined ? +(m[7] || 0) : null;
    return { rel: m[1].split(".").map(Number), pre: pre, post: post, dev: dev, raw: v };
  }
  function cmpRel(a, b) {
    var n = Math.max(a.length, b.length);
    for (var i = 0; i < n; i++) { var x = a[i] || 0, y = b[i] || 0; if (x !== y) return x < y ? -1 : 1; }
    return 0;
  }
  function cmpVer(a, b) {
    if (typeof a === "string") a = parseVer(a);
    if (typeof b === "string") b = parseVer(b);
    if (!a || !b) return 0;
    var c = cmpRel(a.rel, b.rel); if (c) return c;
    // dev-only release sorts before pre; pre before final; post after final
    function key(v) {
      var preK = v.pre ? v.pre : (v.post === null && v.dev !== null ? [-1, 0] : [3, 0]);
      return [preK[0], preK[1], v.post === null ? -1 : v.post, v.dev === null ? Infinity : v.dev];
    }
    var ka = key(a), kb = key(b);
    for (var i = 0; i < 4; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  }
  function isPre(v) { var p = typeof v === "string" ? parseVer(v) : v; return !!(p && (p.pre || p.dev !== null)); }

  // specifier set ">=3.9,<3.15", "~=3.10", "==3.*", "!=3.0.*"; also poetry "^3.9" / "~3.9" / "*"
  function satisfies(version, spec) {
    var v = parseVer(version);
    if (!v) return false;
    spec = String(spec == null ? "" : spec).trim();
    if (!spec || spec === "*") return true;
    var parts = spec.split(/\s*,\s*/);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim(); if (!p) continue;
      if (p.indexOf("||") >= 0) { // poetry-style OR
        var any = p.split("||").some(function (q) { return satisfies(version, q); });
        if (!any) return false; continue;
      }
      var m = /^(~=|===|==|!=|<=|>=|<|>|\^|~)?\s*v?([0-9][\w.*+!-]*)$/.exec(p);
      if (!m) continue; // unknown clause: don't block
      var op = m[1] || "==", target = m[2];
      if (!ok(op, target)) return false;
    }
    return true;
    function ok(op, t) {
      if (/\.\*$/.test(t)) {
        var pre = t.replace(/\.\*$/, "").split(".").map(Number);
        var eq = pre.every(function (x, i) { return (v.rel[i] || 0) === x; });
        return op === "!=" ? !eq : eq;
      }
      var tv = parseVer(t); if (!tv) return true;
      var c = cmpVer(v, tv);
      switch (op) {
        case "==": case "===": return c === 0;
        case "!=": return c !== 0;
        case "<": return c < 0;
        case "<=": return c <= 0;
        case ">": return c > 0;
        case ">=": return c >= 0;
        case "~=": {
          if (c < 0) return false;
          var r = tv.rel.slice(0, Math.max(1, tv.rel.length - 1));
          return r.every(function (x, i) { return (v.rel[i] || 0) === x; });
        }
        case "^": {
          if (c < 0) return false;
          var idx = 0; while (idx < tv.rel.length - 1 && tv.rel[idx] === 0) idx++;
          for (var j = 0; j <= idx; j++) if ((v.rel[j] || 0) !== (tv.rel[j] || 0)) return false;
          return true;
        }
        case "~": {
          if (c < 0) return false;
          var k = tv.rel.length > 1 ? 2 : 1;
          return tv.rel.slice(0, k).every(function (x, i) { return (v.rel[i] || 0) === x; });
        }
      }
      return true;
    }
  }
  function allowsTarget(requiresPython) { return !requiresPython || satisfies(TARGET.full, requiresPython); }

  // ------------------------------------------------------------- environment markers
  // Evaluates python_version / python_full_version / implementation_name atoms for CPython 3.15; anything else is "unknown" (true).
  function evalMarker(marker, env) {
    if (!marker || !String(marker).trim()) return true;
    env = env || {};
    var s = String(marker);
    var toks = [], re = /\s*(\(|\)|and\b|or\b|(?:"[^"]*"|'[^']*'|[A-Za-z_.]+)\s*(?:===|==|!=|<=|>=|~=|<|>|not\s+in\b|in\b)\s*(?:"[^"]*"|'[^']*'|[A-Za-z_.]+))\s*/gy, m;
    var pos = 0;
    re.lastIndex = 0;
    while (pos < s.length) {
      re.lastIndex = pos;
      m = re.exec(s);
      if (!m) return true; // unparseable: assume it applies
      toks.push(m[1]); pos = re.lastIndex;
    }
    var i = 0;
    function atom(t) {
      var mm = /^("[^"]*"|'[^']*'|[A-Za-z_.]+)\s*(===|==|!=|<=|>=|~=|<|>|not\s+in|in)\s*("[^"]*"|'[^']*'|[A-Za-z_.]+)$/.exec(t);
      if (!mm) return true;
      var L = mm[1], op = mm[2].replace(/\s+/g, " "), R = mm[3];
      var isQ = function (x) { return /^["']/.test(x); };
      var unq = function (x) { return x.slice(1, -1); };
      var varName, val, flipped = false;
      if (!isQ(L) && isQ(R)) { varName = L; val = unq(R); }
      else if (isQ(L) && !isQ(R)) { varName = R; val = unq(L); flipped = true; }
      else return true;
      var known = { python_version: "3.15", python_full_version: TARGET.full, implementation_name: "cpython", platform_python_implementation: "CPython" };
      Object.keys(env).forEach(function (k) { known[k] = env[k]; });
      if (!(varName in known)) return true;
      var cur = known[varName];
      if (op === "in" || op === "not in") {
        var hay = flipped ? cur : val, needle = flipped ? val : cur;
        var inn = hay.indexOf(needle) >= 0;
        return op === "in" ? inn : !inn;
      }
      if (/python_(full_)?version/.test(varName)) {
        var a = flipped ? val : cur, b = flipped ? cur : val;
        if (op === "~=" || op === "===") return satisfies(a, op + b);
        return satisfies(a, op + b);
      }
      var eq = cur === val;
      return op === "==" || op === "===" ? eq : op === "!=" ? !eq : true;
    }
    function expr() { var v = term(); while (toks[i] === "or") { i++; var r = term(); v = v || r; } return v; }
    function term() { var v = factor(); while (toks[i] === "and") { i++; var r = factor(); v = v && r; } return v; }
    function factor() {
      if (toks[i] === "(") { i++; var v = expr(); if (toks[i] === ")") i++; return v; }
      return atom(toks[i++] || "");
    }
    try { return expr(); } catch (e) { return true; }
  }

  // ------------------------------------------------------------- wheel tags
  function parseWheel(fn) {
    var base = String(fn).split("/").pop().split("#")[0].split("?")[0];
    if (!/\.whl$/i.test(base)) return null;
    var p = base.slice(0, -4).split("-");
    if (p.length < 5) return null;
    return { file: base, name: normName(p[0]), version: p[1], py: p[p.length - 3].split("."), abi: p[p.length - 2].split("."), plat: p[p.length - 1].split(".") };
  }
  function isSdist(fn) { return /\.(tar\.gz|zip|tar\.bz2|tgz)$/i.test(String(fn).split("/").pop()); }

  function pyAbiOK(py, abi, ft) {
    var cpm = /^cp3(\d+)$/.exec(py), pym = /^py3(\d*)$/.exec(py);
    if (abi === "none") {
      if (py === "py3") return true;
      if (pym) return pym[1] === "" || +pym[1] <= TARGET.minor;
      if (cpm) return +cpm[1] === TARGET.minor;
      return false;
    }
    if (abi === "abi3") return !ft && !!cpm && +cpm[1] >= 2 && +cpm[1] <= TARGET.minor;
    if (abi === "abi3t") return !!cpm && +cpm[1] >= 15 && +cpm[1] <= TARGET.minor; // new in 3.15, valid for both builds
    if (abi === "cp3" + TARGET.minor) return !ft && py === "cp3" + TARGET.minor;
    if (abi === "cp3" + TARGET.minor + "t") return ft && py === "cp3" + TARGET.minor;
    return false;
  }
  function platOK(tag, pid) {
    if (tag === "any") return true;
    switch (pid) {
      case "linux-x86_64": return /^manylinux(1|2010|2014|_\d+_\d+)_x86_64$/.test(tag);
      case "linux-aarch64": return /^manylinux(2014|_\d+_\d+)_aarch64$/.test(tag);
      case "musl-x86_64": return /^musllinux_\d+_\d+_x86_64$/.test(tag);
      case "macos-arm64": return /^macosx_\d+_\d+_(arm64|universal2)$/.test(tag);
      case "macos-x86_64": return /^macosx_\d+_\d+_(x86_64|universal2|intel|universal|fat64|fat3)$/.test(tag);
      case "win-amd64": return tag === "win_amd64";
    }
    return false;
  }
  function wheelOK(w, pid, ft) {
    var okPy = w.py.some(function (py) { return w.abi.some(function (abi) { return pyAbiOK(py, abi, ft); }); });
    return okPy && w.plat.some(function (t) { return platOK(t, pid); });
  }
  function isBinaryWheel(w) { return !w.plat.every(function (t) { return t === "any"; }) || w.abi.some(function (a) { return a !== "none"; }); }

  // files: [{ filename, requiresPython?, yanked? }]
  function classifyFiles(files, platforms, ft) {
    var wheels = [], hasSdist = false, binary = false;
    (files || []).forEach(function (f) {
      var fn = f.filename || f;
      var w = parseWheel(fn);
      if (w) { wheels.push(w); if (isBinaryWheel(w)) binary = true; }
      else if (isSdist(fn)) hasSdist = true;
    });
    var per = {};
    platforms.forEach(function (pid) {
      var hit = null;
      for (var i = 0; i < wheels.length; i++) if (wheelOK(wheels[i], pid, ft)) { hit = wheels[i]; break; }
      var platformExists = wheels.some(function (w) { return w.plat.some(function (t) { return platOK(t, pid); }); });
      // no wheel for this platform for any Python and no sdist: the package isn't meant for it (e.g. CUDA wheels on macOS)
      per[pid] = hit ? { status: "wheel", file: hit.file } : hasSdist ? { status: "build" } : platformExists ? { status: "none" } : { status: "na" };
    });
    var statuses = platforms.map(function (p) { return per[p].status; }).filter(function (st) { return st !== "na"; });
    var anyWheel = statuses.indexOf("wheel") >= 0;
    var pureOnly = wheels.length > 0 && !binary;
    return { per: per, hasSdist: hasSdist, binary: binary, wheels: wheels.length, pureOnly: pureOnly,
      allWheel: statuses.every(function (s) { return s === "wheel"; }), anyWheel: anyWheel, allNA: statuses.length === 0 };
  }

  // ------------------------------------------------------------- tiny TOML block reader (enough for lockfiles)
  function tomlBlocks(text, header) {
    // returns raw text of each [[header]] block
    var out = [], lines = String(text).split(/\r?\n/), cur = null, re = new RegExp("^\\s*\\[\\[" + header.replace(/\./g, "\\.") + "\\]\\]\\s*$");
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (re.test(l)) { if (cur) out.push(cur); cur = { start: i + 1, text: "" }; continue; }
      if (/^\s*\[\[?[^\]]+\]\]?\s*$/.test(l) && cur && !new RegExp("^\\s*\\[" + header.replace(/\./g, "\\.") + "\\.").test(l)) {
        // a different table; poetry uses [package.source]/[package.extras] sub-tables which belong to the block
        if (!/^\s*\[package\./.test(l) && !/^\s*\[packages\./.test(l)) { out.push(cur); cur = null; continue; }
      }
      if (cur) cur.text += l + "\n";
    }
    if (cur) out.push(cur);
    return out;
  }
  function tomlStr(block, key) {
    var m = new RegExp("^\\s*" + key.replace(/[-.]/g, "\\$&") + "\\s*=\\s*(\"(?:[^\"\\\\]|\\\\.)*\"|'[^']*')", "m").exec(block);
    return m ? m[1].slice(1, -1).replace(/\\"/g, "\"") : null;
  }
  function tomlStrArray(block, key) {
    var m = new RegExp("^\\s*" + key.replace(/[-.]/g, "\\$&") + "\\s*=\\s*\\[([\\s\\S]*?)\\]", "m").exec(block);
    if (!m) return null;
    var out = [], re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g, x;
    while ((x = re.exec(m[1]))) out.push((x[1] != null ? x[1] : x[2]).replace(/\\"/g, "\""));
    return out;
  }
  function fileNamesIn(block) {
    var out = [], re = /([A-Za-z0-9_.+!-]+\.(?:whl|tar\.gz|zip|tar\.bz2))(?=["'#?]|\s|$)/g, m, seen = {};
    while ((m = re.exec(block))) { if (!seen[m[1]]) { seen[m[1]] = 1; out.push(m[1]); } }
    return out;
  }

  // ------------------------------------------------------------- dependency sources
  function parseRequirementLine(line) {
    var s = line.replace(/\s+#.*$/, "").replace(/^#.*$/, "").trim();
    if (!s) return null;
    s = s.replace(/\s--hash[=\s]\S+/g, "").trim();
    if (/^-/.test(s)) return { skip: "option", raw: line.trim() };
    if (/^(git\+|hg\+|svn\+|bzr\+|https?:|file:|\.|\/)/i.test(s) || /\s@\s*(git\+|https?:|file:)/.test(s)) return { skip: "url", raw: line.trim() };
    var marker = null, mi = s.indexOf(";");
    if (mi >= 0) { marker = s.slice(mi + 1).trim(); s = s.slice(0, mi).trim(); }
    var m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/.exec(s);
    if (!m) return null;
    var spec = m[3].replace(/^\(|\)$/g, "").trim();
    var pin = /^===?\s*([0-9][\w.+!-]*)$/.exec(spec);
    return { name: m[1], norm: normName(m[1]), spec: spec, version: pin ? pin[1] : null, marker: marker };
  }
  function parseRequirements(text, path) {
    var out = [], logical = String(text).replace(/\\\r?\n/g, " ").split(/\r?\n/);
    logical.forEach(function (l, i) {
      var r = parseRequirementLine(l);
      if (!r || r.skip) return;
      r.path = path; r.line = i + 1; r.kind = "requirements";
      out.push(r);
    });
    return out;
  }
  function parseUvLock(text, path) {
    var out = [];
    tomlBlocks(text, "package").forEach(function (b) {
      var name = tomlStr(b.text, "name"), version = tomlStr(b.text, "version");
      if (!name) return;
      var src = /^\s*source\s*=\s*\{([^}]*)\}/m.exec(b.text);
      var srcText = src ? src[1] : "";
      if (/\b(editable|virtual|path|directory|git)\s*=/.test(srcText)) return; // your own / non-registry packages
      var markers = tomlStrArray(b.text, "resolution-markers");
      if (markers && markers.length && !markers.some(function (mk) { return evalMarker(mk); })) return;
      var reg = /registry\s*=\s*"([^"]+)"/.exec(srcText);
      var files = fileNamesIn(b.text).map(function (f) { return { filename: f }; });
      out.push({ name: name, norm: normName(name), version: version, path: path, kind: "uv.lock", files: files, registry: reg ? reg[1] : null, line: b.start });
    });
    return out;
  }
  function parsePoetryLock(text, path) {
    var out = [];
    tomlBlocks(text, "package").forEach(function (b) {
      var name = tomlStr(b.text, "name"), version = tomlStr(b.text, "version");
      if (!name) return;
      var srcType = /\[package\.source\][\s\S]*?type\s*=\s*"([^"]+)"/.exec(b.text);
      if (srcType && srcType[1] !== "legacy") return; // git / directory / file / url
      var mk = tomlStr(b.text, "markers");
      if (mk && !evalMarker(mk)) return;
      var files = []; var re = /file\s*=\s*"([^"]+)"/g, m;
      while ((m = re.exec(b.text))) files.push({ filename: m[1] });
      out.push({ name: name, norm: normName(name), version: version, path: path, kind: "poetry.lock", files: files.length ? files : null, requiresPython: tomlStr(b.text, "python-versions"), line: b.start });
    });
    return out;
  }
  function parsePylock(text, path) {
    var out = [];
    tomlBlocks(text, "packages").forEach(function (b) {
      var name = tomlStr(b.text, "name"), version = tomlStr(b.text, "version");
      if (!name) return;
      if (/^\s*(vcs|directory|archive)\s*=/m.test(b.text) && !/\.whl/.test(b.text)) return;
      var mk = tomlStr(b.text, "marker");
      if (mk && !evalMarker(mk)) return;
      var files = fileNamesIn(b.text).map(function (f) { return { filename: f }; });
      out.push({ name: name, norm: normName(name), version: version, path: path, kind: "pylock.toml", files: files.length ? files : null, requiresPython: tomlStr(b.text, "requires-python"), line: b.start });
    });
    return out;
  }
  function parsePipfileLock(text, path) {
    var j = JSON.parse(text), out = [];
    ["default", "develop"].forEach(function (sec) {
      var o = j[sec] || {};
      Object.keys(o).forEach(function (n) {
        var e = o[n] || {};
        if (e.git || e.path || e.file || e.editable) return;
        if (e.markers && !evalMarker(e.markers)) return;
        var v = /^===?\s*(.+)$/.exec(e.version || "");
        out.push({ name: n, norm: normName(n), version: v ? v[1] : null, spec: e.version || "", path: path, kind: "Pipfile.lock", dev: sec === "develop" });
      });
    });
    return out;
  }
  function parsePyproject(text, path) {
    var t = String(text), info = { path: path };
    var proj = /^\s*\[project\]\s*$([\s\S]*?)(?=^\s*\[[^\]]+\]\s*$|(?![\s\S]))/m.exec(t);
    var body = proj ? proj[1] : "";
    info.name = tomlStr(body, "name");
    info.requiresPython = tomlStr(body, "requires-python");
    var m = /^\s*requires-python\s*=/m.exec(body);
    if (m) info.requiresPythonLine = t.slice(0, (proj ? proj.index + proj[0].indexOf(body) : 0) + m.index).split("\n").length;
    info.classifiers = tomlStrArray(body, "classifiers") || [];
    info.dependencies = (tomlStrArray(body, "dependencies") || []).map(function (d) {
      var r = parseRequirementLine(d); if (r && !r.skip) { r.path = path; r.kind = "pyproject"; } return r;
    }).filter(function (r) { return r && !r.skip; });
    var poetryPy = /^\s*\[tool\.poetry\.dependencies\]\s*$[\s\S]*?^\s*python\s*=\s*"([^"]+)"/m.exec(t);
    if (poetryPy) info.poetryPython = poetryPy[1];
    return info;
  }

  // ------------------------------------------------------------- code rules (.py)
  var CODE_RULES = [
    { id: "sre", level: "error", re: /^\s*(?:import\s+(?:[\w.]+\s*,\s*)*(sre_compile|sre_constants|sre_parse)\b|from\s+(sre_compile|sre_constants|sre_parse)\s+import\b)/m,
      title: "sre_compile / sre_constants / sre_parse were removed", why: "These private regex modules are gone in 3.15; the import raises ModuleNotFoundError.", fix: "Use the public re module (re.compile, re.error); for the parser internals, re._parser and re._compiler exist but are private.", src: SRC.removed },
    { id: "cgi-handler", level: "error", re: /\bCGIHTTPRequestHandler\b/, title: "http.server.CGIHTTPRequestHandler was removed", why: "The class and the --cgi flag of python -m http.server are gone in 3.15.", fix: "Serve CGI with a real web server, or port the script to a small WSGI app.", src: SRC.removed },
    { id: "http-cgi-flag", level: "error", re: /http\.server\b[^\n]*\s--cgi\b/, title: "python -m http.server --cgi no longer exists", why: "The --cgi flag was removed in 3.15; the command exits with a usage error.", fix: "Drop --cgi and serve CGI scripts another way.", src: SRC.removed, files: "any" },
    { id: "glob01", level: "error", re: /\bglob\.glob[01]\s*\(/, title: "glob.glob0() / glob.glob1() were removed", why: "These undocumented helpers are gone in 3.15 (AttributeError).", fix: "Use glob.glob(pattern, root_dir=directory).", src: SRC.removed },
    { id: "java-ver", level: "error", re: /\bplatform\.java_ver\s*\(/, title: "platform.java_ver() was removed", why: "Removed in 3.15 (AttributeError).", fix: "Delete the call; it only ever worked on Jython.", src: SRC.removed },
    { id: "is-reserved", level: "warn", re: /\.is_reserved\s*\(\s*\)/, title: "PurePath.is_reserved() was removed", why: "pathlib.PurePath.is_reserved() is gone in 3.15. If this call is on a path object it raises AttributeError.", fix: "Use os.path.isreserved(path) (Windows only, 3.13+).", src: SRC.removed },
    { id: "lnotab", level: "error", re: /\bco_lnotab\b/, title: "code.co_lnotab was removed", why: "types.CodeType.co_lnotab is gone in 3.15 (deprecated since 3.12 by PEP 626).", fix: "Use code.co_lines() (or co_positions()) instead.", src: SRC.removed },
    { id: "setpointertype", level: "error", re: /\bSetPointerType\s*\(/, title: "ctypes.SetPointerType() was removed", why: "Removed in 3.15.", fix: "Set the pointer type's _type_ via a properly declared POINTER() type.", src: SRC.removed },
    { id: "nt-kwargs", level: "error", re: /\bNamedTuple\s*\(\s*(["'])[^"']+\1\s*,\s*[A-Za-z_]\w*\s*=/, title: "NamedTuple(\"X\", field=type) keyword syntax no longer works", why: "The undocumented keyword-argument form of typing.NamedTuple was removed in 3.15 (TypeError).", fix: "Use the class syntax or NamedTuple(\"X\", [(\"field\", type)]).", src: SRC.removed },
    { id: "td-empty", level: "error", re: /\bTypedDict\s*\(\s*(["'])[^"']+\1\s*(?:,\s*None\s*)?\)/, title: "TypedDict(\"TD\") / TypedDict(\"TD\", None) no longer works", why: "Creating a zero-field TypedDict this way was removed in 3.15.", fix: "Use class TD(TypedDict): pass, or TypedDict(\"TD\", {}).", src: SRC.removed },
    { id: "ntc-decorator", level: "error", re: /\bno_type_check_decorator\b/, title: "typing.no_type_check_decorator was removed", why: "Removed in 3.15 (deprecated since 3.13).", fix: "Remove it; apply @typing.no_type_check directly if needed.", src: SRC.removed },
    { id: "wave-marks", level: "warn", re: /\.(getmarkers|getmark|setmark)\s*\(/, title: "wave getmark() / setmark() / getmarkers() were removed", why: "If this is a wave.Wave_read/Wave_write object, these methods are gone in 3.15.", fix: "Remove the calls; they never did anything useful for WAV files.", src: SRC.removed, need: /\bwave\b/ },
    { id: "load-module", level: "warn", re: /\bdef\s+load_module\s*\(|\.load_module\s*\(/, title: "importlib load_module() is no longer called or available", why: "3.15 removed Loader.load_module() and zipimporter.load_module(); the import system no longer calls load_module() on custom loaders.", fix: "Implement exec_module() (and create_module()) on custom loaders; call importlib.util.module_from_spec() + loader.exec_module().", src: SRC.removed },
    { id: "res-files-package", level: "error", re: /\bfiles\s*\(\s*package\s*=/, title: "importlib.resources.files(package=...) was removed", why: "The deprecated package keyword is gone in 3.15 (TypeError).", fix: "Pass the anchor positionally: files(\"mypkg\").", src: SRC.removed, need: /importlib[._]resources|from\s+importlib\s+import\s+resources/ },
    { id: "check-home", level: "error", re: /\bis_python_build\s*\([^)]*check_home/, title: "sysconfig.is_python_build(check_home=...) was removed", why: "The check_home parameter is gone in 3.15.", fix: "Call sysconfig.is_python_build() without it.", src: SRC.removed },
    { id: "bytestring", level: "warn", re: /\b(?:collections\.abc|typing)\.ByteString\b|from\s+(?:collections\.abc|typing)\s+import\s+[^\n]*\bByteString\b/, title: "ByteString is deprecated and left __all__", why: "typing.ByteString and collections.abc.ByteString were dropped from __all__ in 3.15 (star-imports no longer provide them), now warn on import, and are removed in 3.17.", fix: "Use bytes | bytearray | memoryview, or collections.abc.Buffer.", src: SRC.removed },
    { id: "sqlite-positional", level: "error", re: /\bsqlite3\.connect\s*\(\s*(?:[^,()]|\([^()]*\))+,\s*(?![A-Za-z_]\w*\s*=)(?!\*)[^,()\s][^,()]*[,)]/, title: "sqlite3.connect() arguments after the database are keyword-only", why: "In 3.15 every parameter except database is keyword-only; a second positional argument (such as timeout) raises TypeError.", fix: "Pass it by name, e.g. sqlite3.connect(path, timeout=10).", src: SRC.porting },
    { id: "argparse-dest", level: "warn", re: /\badd_argument\s*\(\s*(["'])-[A-Za-z0-9]\1\s*,\s*(["'])-[A-Za-z0-9][\w-]+\2/, title: "argparse dest now comes from the single-dash long option", why: "For add_argument('-f', '-foo'), dest is now 'foo' instead of 'f' in 3.15, so args.f becomes args.foo.", fix: "Pass dest= explicitly to keep the old attribute name.", src: SRC.porting },
    { id: "rlimit-neg", level: "info", re: /\b(?:setrlimit|prlimit)\s*\([^)]*,\s*\(\s*-\d/, title: "Negative resource limits are deprecated", why: "resource.RLIM_INFINITY is now always positive; passing -1 to setrlimit()/prlimit() is deprecated.", fix: "Use resource.RLIM_INFINITY.", src: SRC.porting }
  ];

  // strptime with %d and no year directive -> ValueError in 3.15
  var STRPTIME = /\bstrptime\s*\(\s*[^,()]+(?:\([^()]*\))?\s*,\s*[rbuRBU]?(["'])((?:(?!\1).)*)\1/g;
  function strptimeHits(text) {
    var hits = [], m;
    STRPTIME.lastIndex = 0;
    while ((m = STRPTIME.exec(text))) {
      var fmt = m[2];
      if (/%d/.test(fmt) && !/%[YyGcxsD]/.test(fmt)) hits.push({ index: m.index, fmt: fmt });
    }
    return hits;
  }

  // text-mode I/O without encoding -> now UTF-8 everywhere (PEP 686)
  function encodingHits(text) {
    var hits = [], lines = text.split(/\r?\n/);
    var reOpen = /(?:^|[^\w.])(?:io\.)?open\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
    var rePath = /\.(read_text|write_text)\s*\(([^()]*)\)/g;
    lines.forEach(function (l, i) {
      if (/^\s*#/.test(l)) return;
      var m;
      reOpen.lastIndex = 0;
      while ((m = reOpen.exec(l))) {
        var args = m[1];
        if (/\bencoding\s*=/.test(args)) continue;
        var mode = /(?:^|,)\s*(?:mode\s*=\s*)?[rbuRBU]?(["'])([rwxabt+U]+)\1/.exec(args.replace(/^[^,]*/, function (first) { return /^\s*mode\s*=/.test(first) ? first : ""; }));
        var modeStr = mode ? mode[2] : "";
        if (/b/.test(modeStr)) continue;
        if (/^\s*$/.test(args)) continue;
        hits.push({ line: i + 1, code: l.trim() });
      }
      rePath.lastIndex = 0;
      while ((m = rePath.exec(l))) {
        if (/\bencoding\s*=/.test(m[2])) continue;
        if (m[1] === "write_text" && !m[2].trim()) continue;
        hits.push({ line: i + 1, code: l.trim() });
      }
    });
    return hits;
  }

  function lineOf(text, index) { return text.slice(0, index).split("\n").length; }
  function lineText(text, index) { var s = text.lastIndexOf("\n", index - 1) + 1, e = text.indexOf("\n", index); return text.slice(s, e < 0 ? text.length : e).trim(); }

  function scanPython(path, text, findings) {
    // strip nothing: regexes are anchored to code-ish shapes. Skip if file is huge.
    if (text.length > 600000) return;
    CODE_RULES.forEach(function (r) {
      if (r.files === "any") return;
      if (r.need && !r.need.test(text)) return;
      var re = new RegExp(r.re.source, r.re.flags.indexOf("g") >= 0 ? r.re.flags : r.re.flags + "g"), m, n = 0;
      while ((m = re.exec(text)) && n < 3) {
        var ln = lineOf(text, m.index + (m[0].match(/^\s*/)[0].length));
        var code = lineText(text, m.index + (m[0].match(/^\s*/)[0].length));
        if (/^\s*#/.test(code)) { if (m[0].length === 0) re.lastIndex++; continue; }
        findings.push({ id: r.id, level: r.level, title: r.title, why: r.why, fix: r.fix, src: r.src, path: path, line: ln, code: code });
        n++;
        if (m[0].length === 0) re.lastIndex++;
      }
    });
    strptimeHits(text).slice(0, 3).forEach(function (h) {
      findings.push({ id: "strptime-noyear", level: "error", title: "strptime() with %d but no year now raises ValueError", why: "In 3.15, datetime.strptime() rejects formats that contain %d (day of month) without a year directive, because 29 February can't be parsed without a year.", fix: "Add a year to the string and format (e.g. prefix \"2000 \" and \"%Y \"), or parse day/month yourself.", src: SRC.removed, path: path, line: lineOf(text, h.index), code: lineText(text, h.index) });
    });
    var enc = encodingHits(text);
    if (enc.length) findings.push({ id: "utf8-default", level: "info", title: "Text files opened without encoding= now use UTF-8 on every OS", why: "PEP 686: open(), Path.read_text() and friends default to UTF-8 in 3.15 instead of the locale encoding. Nothing changes on most Linux and macOS setups; on Windows (cp1252 and others) files written by older versions or other programs may now fail to decode or round-trip differently. " + enc.length + " call" + (enc.length > 1 ? "s" : "") + " in this file.", fix: "Pass encoding=\"utf-8\" (or encoding=\"locale\" to keep the old behaviour) explicitly. Run with -X warn_default_encoding to find the rest; PYTHONUTF8=0 restores the old default.", src: SRC.pep686, path: path, line: enc[0].line, code: enc.slice(0, 4).map(function (h) { return h.line + ": " + h.code; }).join("\n"), count: enc.length });
  }

  function scanPth(path, text, findings) {
    var lines = text.split(/\r?\n/), hits = [];
    lines.forEach(function (l, i) { if (/^import[ \t]/.test(l)) hits.push(i + 1); });
    if (hits.length) findings.push({ id: "pth-import", level: "warn", title: ".pth file runs code with an import line", why: "PEP 829: import lines in .pth files are deprecated in 3.15 and are ignored when a matching .start file exists. Plain path lines are unchanged.", fix: "Ship a .start file with a pkg.module:callable entry point instead of the import line.", src: SRC.pep829, path: path, line: hits[0], code: lines[hits[0] - 1] });
  }

  // ------------------------------------------------------------- CI / Docker / config rules
  var FLOATING_DOCKER = /^(?:python|docker\.io\/(?:library\/)?python|library\/python)(?::(3|latest|slim|alpine|bookworm|trixie|slim-bookworm|slim-trixie|alpine3\.\d+|3-slim|3-alpine|3-bookworm|3-trixie|3-slim-bookworm|3-slim-trixie|3-alpine3\.\d+|windowsservercore[\w.-]*|3-windowsservercore[\w.-]*))?(?:@sha256:[a-f0-9]+)?$/i;
  function scanCI(path, text, findings) {
    var lines = String(text).split(/\r?\n/);
    var isDocker = /(^|\/)(Dockerfile|Containerfile)[^\/]*$|\.dockerfile$/i.test(path);
    var isWorkflow = /\.ya?ml$/i.test(path);
    var matrixVersions = [], matrixLine = 0, mentions315 = /3\.15/.test(text);
    lines.forEach(function (l, i) {
      var ln = i + 1, t = l.trim();
      if (/^#/.test(t)) return;
      if (isDocker || /\bimage:\s|FROM\s|container:|docker\s+run|uses:\s*docker:\/\//i.test(l)) {
        var mFrom = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(l) || /\bimage:\s*["']?([^\s"']+)/.exec(l) || /uses:\s*docker:\/\/([^\s"']+)/.exec(l) || /\bdocker\s+run\b[^\n]*?\s((?:docker\.io\/)?(?:library\/)?python(?::[\w.-]+)?)(?=\s|$)/.exec(l);
        if (mFrom && FLOATING_DOCKER.test(mFrom[1])) {
          findings.push({ id: "docker-floating", level: "warn", title: "Floating python image tag now pulls Python 3.15", why: "The official python:3, latest, slim, alpine, bookworm and trixie tags point to 3.15.0 since 9 Oct 2026. The next rebuild changes your Python minor version, and slim/alpine images have no compiler for packages without 3.15 wheels.", fix: "Pin the minor version you tested, e.g. python:3.14-slim, and move to python:3.15-slim deliberately once this check is clean.", src: SRC.docker, path: path, line: ln, code: t });
        }
      }
      if (isWorkflow) {
        var pv = /python-version\s*:\s*["']?([^"'#\n]+?)["']?\s*(?:#.*)?$/.exec(l);
        if (pv) {
          var val = pv[1].trim();
          if (/^3\.x$|^3$|^>=\s*3\.\d+$|^\*$|^latest$/i.test(val)) {
            findings.push({ id: "setup-python-floating", level: "warn", title: "python-version: " + val + " now resolves to 3.15", why: "actions/setup-python picks the newest stable release matching the spec, and 3.15.0 is in its manifest since 9 Oct 2026. Jobs that passed last week may now install 3.15 and hit the dependency problems listed here.", fix: "Pin the minor version you support (e.g. \"3.14\") and add \"3.15\" to a test matrix instead.", src: SRC.setupPython, path: path, line: ln, code: t });
          }
        }
        // unquoted YAML floats: 3.10 -> 3.1, 3.150 etc. In lists too.
        var unq = /(?:python-version\s*:\s*|^\s*-\s*|[\[,]\s*)(3\.1\d?0)\s*(?=[,\]\s#]|$)/.exec(l);
        if (unq && /python/.test(lines.slice(Math.max(0, i - 6), i + 1).join("\n")) && /^3\.(10|150?)$/.test(unq[1])) {
          findings.push({ id: "yaml-float", level: "warn", title: "Unquoted " + unq[1] + " is read by YAML as a number", why: "YAML turns 3.10 into 3.1 (and 3.150 into 3.15). Quote Python versions in workflow files.", fix: "Write \"" + unq[1] + "\" with quotes.", src: SRC.setupPython, path: path, line: ln, code: t });
        }
        var mx = /python(?:-version)?\s*:\s*\[([^\]]+)\]/.exec(l);
        if (mx) { matrixVersions = mx[1].split(",").map(function (x) { return x.trim().replace(/["']/g, ""); }); matrixLine = ln; }
      }
    });
    if (matrixVersions.length && !mentions315 && matrixVersions.some(function (v) { return /^3\.1[0-4]$/.test(v); })) {
      findings.push({ id: "matrix-missing-315", level: "info", title: "Test matrix doesn't include 3.15 yet", why: "Your matrix tests " + matrixVersions.join(", ") + ". Python 3.15 has been the newest stable release since 9 Oct 2026.", fix: "Add \"3.15\" (and \"3.15t\" if you ship free-threaded wheels) to the matrix.", src: SRC.whatsnew, path: path, line: matrixLine, code: lines[matrixLine - 1].trim() });
    }
    if (isWorkflow || /\.(sh|bash|ps1|cfg|ini|toml|txt)$|Makefile$|(^|\/)tox\.ini$/i.test(path) || isDocker) {
      lines.forEach(function (l, i) {
        if (/http\.server\b[^\n]*\s--cgi\b/.test(l)) findings.push({ id: "http-cgi-flag", level: "error", title: "python -m http.server --cgi no longer exists", why: "The --cgi flag was removed in 3.15.", fix: "Drop --cgi and serve CGI another way.", src: SRC.removed, path: path, line: i + 1, code: l.trim() });
      });
    }
  }

  function scanPyproject(info, findings) {
    var rp = info.requiresPython || info.poetryPython;
    if (rp && !allowsTarget(rp)) {
      findings.push({ id: "requires-python-cap", level: "error", title: "requires-python " + rp + " excludes 3.15", why: "pip and uv refuse to install this project on Python 3.15, and resolvers skip it as a dependency.", fix: "Raise or remove the upper bound (an upper cap on requires-python is generally discouraged) once tests pass on 3.15.", src: "https://packaging.python.org/en/latest/specifications/core-metadata/#requires-python", path: info.path, line: info.requiresPythonLine || null, code: "requires-python = \"" + rp + "\"" });
    }
    var cls = info.classifiers || [];
    var hasPyCls = cls.some(function (c) { return /^Programming Language :: Python :: 3\.\d+$/.test(c); });
    if (hasPyCls && cls.indexOf("Programming Language :: Python :: 3.15") < 0) {
      findings.push({ id: "classifier-315", level: "info", title: "No \"Python :: 3.15\" classifier", why: "Tools such as pyreadiness.org read this classifier to report 3.15 support. It doesn't affect installation.", fix: "Add \"Programming Language :: Python :: 3.15\" once your tests pass on 3.15.", src: "https://pyreadiness.org/3.15/", path: info.path, line: null });
    }
  }

  // ------------------------------------------------------------- file routing
  function fileKind(name) {
    var n = String(name).split("/").pop();
    if (/^uv\.lock$/i.test(n)) return "uv";
    if (/^poetry\.lock$/i.test(n)) return "poetry";
    if (/^pylock(\.[\w-]+)?\.toml$/i.test(n)) return "pylock";
    if (/^Pipfile\.lock$/i.test(n)) return "pipfile";
    if (/^pyproject\.toml$/i.test(n)) return "pyproject";
    if (/requirements.*\.(txt|in)$|^constraints.*\.txt$|\.req$/i.test(n) && !/\.in$/i.test(n)) return "requirements";
    if (/\.pth$/i.test(n)) return "pth";
    if (/\.pyw?$/i.test(n)) return "py";
    if (/\.ya?ml$/i.test(n) || /^(Dockerfile|Containerfile)/i.test(n) || /\.dockerfile$/i.test(n) || /\.(sh|bash|ps1)$/i.test(n) || /^(Makefile|tox\.ini|noxfile\.py|setup\.cfg)$/i.test(n)) return "ci";
    return null;
  }
  // sniff pasted text
  function sniff(text) {
    var t = String(text || "").trim();
    if (!t) return null;
    if (/^\s*\{/.test(t) && /"_meta"\s*:/.test(t)) return "pipfile";
    if (/^\s*version\s*=\s*1\s*$/m.test(t) && /^\s*\[\[package\]\]/m.test(t) && /source\s*=\s*\{/.test(t)) return "uv";
    if (/^\s*\[\[package\]\]/m.test(t) && /(^\s*files\s*=|content-hash|python-versions)/m.test(t)) return "poetry";
    if (/^\s*lock-version\s*=/m.test(t) && /^\s*\[\[packages\]\]/m.test(t)) return "pylock";
    if (/^\s*\[project\]|^\s*\[build-system\]|^\s*\[tool\./m.test(t)) return "pyproject";
    if (/^\s*FROM\s+\S+/mi.test(t) || /^\s*(on|jobs|steps)\s*:/m.test(t) || /uses:\s*actions\//.test(t)) return "ci";
    if (/^\s*(import|from)\s+[\w.]+|^\s*def\s+\w+\s*\(|^\s*class\s+\w+/m.test(t)) return "py";
    if (/^\s*[A-Za-z0-9][\w.-]*\s*(\[[^\]]*\])?\s*(==|>=|<=|~=|!=|<|>|;|$)/m.test(t)) return "requirements";
    return null;
  }

  // ------------------------------------------------------------- analysis
  // input: { files: [{path, text}], platforms: [...], freeThreaded: bool, pypi: { "name@ver": {files, requiresPython} | null }, simple: { name: {files:[{filename, requiresPython, yanked}], versions} | null } }
  function collect(input) {
    var findings = [], deps = [], projects = [], notes = [], sources = {};
    (input.files || []).forEach(function (f) {
      var kind = f.kind || fileKind(f.path) || sniff(f.text);
      if (!kind) return;
      try {
        if (kind === "requirements") push(parseRequirements(f.text, f.path), f.path, "requirements");
        else if (kind === "uv") push(parseUvLock(f.text, f.path), f.path, "uv.lock");
        else if (kind === "poetry") push(parsePoetryLock(f.text, f.path), f.path, "poetry.lock");
        else if (kind === "pylock") push(parsePylock(f.text, f.path), f.path, "pylock.toml");
        else if (kind === "pipfile") push(parsePipfileLock(f.text, f.path), f.path, "Pipfile.lock");
        else if (kind === "pyproject") { var info = parsePyproject(f.text, f.path); projects.push(info); scanPyproject(info, findings); scanCI(f.path, f.text, findings); }
        else if (kind === "py") scanPython(f.path, f.text, findings);
        else if (kind === "pth") scanPth(f.path, f.text, findings);
        else if (kind === "ci") scanCI(f.path, f.text, findings);
      } catch (e) {
        notes.push("Couldn't parse " + f.path + ": " + e.message);
      }
    });
    function push(list, path, kind) { sources[path] = kind; list.forEach(function (d) { deps.push(d); }); }
    // pyproject dependencies only when no lock/requirements present
    if (!deps.length) projects.forEach(function (p) { p.dependencies.forEach(function (d) { deps.push(d); }); });
    // dedupe: same name+version (keep first path)
    var seen = {}, uniq = [];
    deps.forEach(function (d) {
      if (d.marker && !evalMarker(d.marker)) return;
      var key = d.norm + "@" + (d.version || d.spec || "");
      if (seen[key]) { seen[key].paths.push(d.path); return; }
      d.paths = [d.path]; seen[key] = d; uniq.push(d);
    });
    return { findings: findings, deps: uniq, projects: projects, notes: notes, sources: sources };
  }

  // which deps need network lookups
  function lookupsNeeded(collected) {
    var pinned = [], names = [];
    collected.deps.forEach(function (d) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(d.name)) return;
      if (d.version && !d.files) pinned.push({ name: d.norm, version: d.version });
      if (!d.version) names.push(d.norm);
    });
    return { pinned: pinned, names: names };
  }

  function analyze(input) {
    var platforms = (input.platforms && input.platforms.length) ? input.platforms : DEFAULT_PLATFORMS;
    var ft = !!input.freeThreaded;
    var c = collect(input);
    var pypi = input.pypi || {}, simple = input.simple || {};
    var pkgs = [];
    c.deps.forEach(function (d) {
      var p = { name: d.name, norm: d.norm, version: d.version, spec: d.spec || null, kind: d.kind, paths: d.paths, line: d.line, dev: !!d.dev, registry: d.registry || null };
      var files = d.files, rp = d.requiresPython || null, resolved = false;
      if (!d.version) {
        var s = simple[d.norm];
        if (s && s.files) {
          var cand = pickVersion(s, d.spec);
          if (cand) { p.version = cand.version; p.resolvedFromSpec = true; files = cand.files; rp = cand.requiresPython; resolved = true; }
          else { p.status = "no-candidate"; }
        } else if (s === null) p.status = "lookup-failed";
        else p.status = "not-checked";
      } else if (!files) {
        var key = d.norm + "@" + d.version;
        if (pypi[key]) { files = pypi[key].files; rp = rp || pypi[key].requiresPython; resolved = true; }
        else if (pypi[key] === null) p.status = "lookup-failed";
        else p.status = "not-checked";
      } else resolved = true;
      if (resolved && files) {
        if (!rp) { var rps = files.map(function (f) { return f.requiresPython; }).filter(Boolean); rp = rps[0] || null; }
        p.requiresPython = rp;
        var cl = classifyFiles(files, platforms, ft);
        p.per = cl.per; p.binary = cl.binary; p.hasSdist = cl.hasSdist; p.wheels = cl.wheels;
        if (rp && !allowsTarget(rp)) p.status = "blocked";
        else if (cl.allWheel) p.status = cl.allNA ? "na" : "ok";
        else if (!cl.wheels && cl.hasSdist) p.status = "sdist-only";
        else if (platforms.some(function (pid) { return cl.per[pid].status === "none"; })) p.status = "no-install";
        else p.status = "build";
        if (p.status !== "ok" && simple[d.norm] && simple[d.norm].files) {
          p.upgrade = smallestUpgrade(simple[d.norm], p.version, platforms, ft);
          p.latest = latestInfo(simple[d.norm], platforms, ft);
        }
      }
      pkgs.push(p);
    });
    // exact pins from other locked packages (e.g. pydantic 2.11.7 requires pydantic-core==2.33.2)
    pkgs.forEach(function (parent) {
      var meta = parent.version && pypi[parent.norm + "@" + parent.version];
      if (!meta || !meta.requiresDist) return;
      meta.requiresDist.forEach(function (rd) {
        var r = parseRequirementLine(rd);
        if (!r || r.skip || !r.version || (r.marker && /extra\s*==/.test(r.marker))) return;
        if (r.marker && !evalMarker(r.marker)) return;
        pkgs.forEach(function (child) {
          if (child.norm === r.norm && child !== parent && child.version === r.version) child.pinnedBy = parent.name + " " + parent.version;
        });
      });
    });
    var order = { "no-install": 0, blocked: 1, build: 2, "lookup-failed": 3, "no-candidate": 3, "sdist-only": 4, "not-checked": 5, ok: 6, na: 7 };
    pkgs.sort(function (a, b) { return (order[a.status] - order[b.status]) || a.norm.localeCompare(b.norm); });

    var findings = c.findings.slice();
    pkgs.forEach(function (p) {
      var label = p.name + (p.version ? " " + p.version : "");
      var up = p.upgrade ? " Smallest upgrade that installs from a wheel: " + p.upgrade.version + (p.upgrade.requiresPython ? " (requires-python " + p.upgrade.requiresPython + ")" : "") + "." : (p.latest && !p.latest.allWheel ? " No release has 3.15 wheels for these platforms yet (latest is " + p.latest.version + ")." : "");
      var where = p.paths && p.paths[0];
      if (p.pinnedBy && p.upgrade) up += " " + p.pinnedBy + " requires exactly " + p.name + "==" + p.version + ", so upgrade " + p.pinnedBy.split(" ")[0] + " (which pulls a newer " + p.name + ") rather than " + p.name + " alone.";
      if (p.status === "blocked") findings.push({ id: "dep-blocked", level: "error", pkg: p.norm, title: label + " doesn't allow Python 3.15 (requires-python " + p.requiresPython + ")", why: "pip refuses this exact version on 3.15, so a locked install fails with \"No matching distribution\"." + up, fix: p.upgrade ? "Upgrade to " + p.upgrade.version + " or later." : "Keep this environment on 3.14 until a compatible release ships.", path: where, line: p.line, src: SRC.tags });
      else if (p.status === "no-install") findings.push({ id: "dep-noinstall", level: "error", pkg: p.norm, title: label + " has no 3.15 wheel and no source package", why: "On " + missing(p, "none") + " there is nothing pip can install for Python 3.15." + up, fix: p.upgrade ? "Upgrade to " + p.upgrade.version + "." : "Wait for a 3.15 release, or stay on 3.14 for now.", path: where, line: p.line, src: SRC.tags });
      else if (p.status === "build") findings.push({ id: "dep-build", level: p.binary ? "error" : "warn", pkg: p.norm, title: label + " has no 3.15 wheel: pip will compile it from source", why: "On " + missing(p, "build") + " pip falls back to the sdist and runs a C/C++/Rust build. That fails in slim and Alpine images and on machines without a compiler and headers, and is slow everywhere." + up, fix: p.upgrade ? (p.pinnedBy ? "Upgrade " + p.pinnedBy.split(" ")[0] + " to a release that requires " + p.name + " >= " + p.upgrade.version + "." : "Upgrade to " + p.upgrade.version + " (" + p.upgrade.jump + ").") : "Stay on 3.14 for this environment, or make sure a compiler and the library's build dependencies are installed.", path: where, line: p.line, src: SRC.tags });
      else if (p.status === "lookup-failed") findings.push({ id: "dep-lookup", level: "info", pkg: p.norm, title: "Couldn't read " + label + " from PyPI", why: "It may be on a private index, misspelled, or PyPI didn't answer.", fix: "Check it manually: pip download --only-binary=:all: --python-version 3.15 " + p.name + (p.version ? "==" + p.version : ""), path: where, line: p.line });
    });
    var lvl = { error: 0, warn: 1, info: 2 };
    findings.sort(function (a, b) { return lvl[a.level] - lvl[b.level]; });
    return { findings: findings, pkgs: pkgs, platforms: platforms, freeThreaded: ft, projects: c.projects, notes: c.notes, sources: c.sources,
      hasDeps: c.deps.length > 0, counts: countPkgs(pkgs) };
    function missing(p, st) { return platforms.filter(function (pid) { return p.per[pid].status === st; }).map(platLabel).join(", "); }
  }
  function platLabel(pid) { for (var i = 0; i < PLATFORMS.length; i++) if (PLATFORMS[i].id === pid) return PLATFORMS[i].label; return pid; }
  function countPkgs(pkgs) {
    var c = { total: pkgs.length, ok: 0, build: 0, blocked: 0, noinstall: 0, sdist: 0, unknown: 0, na: 0 };
    pkgs.forEach(function (p) {
      if (p.status === "na") c.na++; else if (p.status === "ok") c.ok++; else if (p.status === "build") c.build++; else if (p.status === "blocked") c.blocked++;
      else if (p.status === "no-install") c.noinstall++; else if (p.status === "sdist-only") c.sdist++; else c.unknown++;
    });
    return c;
  }

  // simple: { files: [{filename, requiresPython, yanked}] } (PyPI Simple API JSON, normalised)
  function groupByVersion(simple) {
    if (simple._byVer) return simple._byVer;
    var by = {};
    simple.files.forEach(function (f) {
      var fn = f.filename, v = null, w = parseWheel(fn);
      if (w) v = w.version;
      else if (isSdist(fn)) { var m = /^(.+?)-([0-9][\w.!+]*?)\.(tar\.gz|zip|tar\.bz2|tgz)$/i.exec(fn); if (m) v = m[2]; }
      if (!v) return;
      (by[v] = by[v] || []).push(f);
    });
    simple._byVer = by;
    return by;
  }
  function versionsSorted(simple) {
    var by = groupByVersion(simple);
    return Object.keys(by).filter(function (v) { return parseVer(v); }).sort(cmpVer);
  }
  function relInfo(simple, v, platforms, ft) {
    var files = groupByVersion(simple)[v] || [];
    var live = files.filter(function (f) { return !f.yanked; });
    var rp = (live[0] || files[0] || {}).requiresPython || null;
    var cl = classifyFiles(live, platforms, ft);
    return { version: v, files: live, requiresPython: rp, allWheel: cl.allWheel, allowed: allowsTarget(rp), yanked: !live.length };
  }
  function smallestUpgrade(simple, fromVersion, platforms, ft) {
    var vs = versionsSorted(simple), from = parseVer(fromVersion);
    for (var i = 0; i < vs.length; i++) {
      if (from && cmpVer(vs[i], from) <= 0) continue;
      if (isPre(vs[i])) continue;
      var r = relInfo(simple, vs[i], platforms, ft);
      if (!r.yanked && r.allowed && r.allWheel) {
        var a = parseVer(vs[i]);
        r.jump = !from ? "upgrade" : a.rel[0] !== from.rel[0] ? "major version change: read the changelog" : (a.rel[1] || 0) !== (from.rel[1] || 0) ? "minor version change" : "patch release";
        return r;
      }
    }
    return null;
  }
  function latestInfo(simple, platforms, ft) {
    var vs = versionsSorted(simple).filter(function (v) { return !isPre(v); });
    for (var i = vs.length - 1; i >= 0; i--) { var r = relInfo(simple, vs[i], platforms, ft); if (!r.yanked) return r; }
    return null;
  }
  // pip without --prefer-binary picks the newest allowed version matching the spec
  function pickVersion(simple, spec) {
    var vs = versionsSorted(simple).filter(function (v) { return !isPre(v); });
    for (var i = vs.length - 1; i >= 0; i--) {
      if (spec && !satisfies(vs[i], spec.replace(/\s+/g, ""))) continue;
      var files = (groupByVersion(simple)[vs[i]] || []).filter(function (f) { return !f.yanked; });
      if (!files.length) continue;
      var rp = files[0].requiresPython || null;
      if (!allowsTarget(rp)) continue;
      return { version: vs[i], files: files, requiresPython: rp };
    }
    return null;
  }

  // normalise PyPI responses
  function fromPypiJSON(j) {
    if (!j) return null;
    return { requiresPython: (j.info && j.info.requires_python) || null, requiresDist: (j.info && j.info.requires_dist) || [], files: (j.urls || []).filter(function (u) { return !u.yanked; }).map(function (u) { return { filename: u.filename, requiresPython: u.requires_python || null }; }) };
  }
  function fromSimpleJSON(j) {
    if (!j || !j.files) return null;
    return { files: j.files.map(function (f) { return { filename: f.filename, requiresPython: f["requires-python"] || null, yanked: !!f.yanked }; }) };
  }

  // ------------------------------------------------------------- outputs
  function upgradeLines(report) {
    var req = [], uv = [], poetry = [], pipenv = [];
    report.pkgs.forEach(function (p) {
      if (!p.upgrade || p.status === "ok") return;
      var k = p.kind;
      if (p.pinnedBy) { req.push("# " + p.name + ": upgrade " + p.pinnedBy.split(" ")[0] + " instead (it pins " + p.name + "==" + p.version + ")"); return; }
      if (k === "requirements" || k === "pyproject") req.push(p.name + "==" + p.upgrade.version + "    # was " + (p.version || p.spec || "unpinned"));
      else if (k === "uv.lock") uv.push("uv lock --upgrade-package " + p.name + "==" + p.upgrade.version);
      else if (k === "poetry.lock") poetry.push("poetry add \"" + p.name + ">=" + p.upgrade.version + "\"");
      else if (k === "Pipfile.lock") pipenv.push("pipenv install \"" + p.name + ">=" + p.upgrade.version + "\"");
      else if (k === "pylock.toml") req.push(p.name + ">=" + p.upgrade.version);
    });
    return { requirements: req, uv: uv, poetry: poetry, pipenv: pipenv };
  }
  function markdown(report, title) {
    var L = [], c = report.counts;
    L.push("## Python 3.15 readiness: " + (title || "project"));
    L.push("");
    L.push("Checked " + c.total + " dependencies for " + report.platforms.map(platLabel).join(", ") + (report.freeThreaded ? " (free-threaded 3.15t)" : "") + ". " + c.ok + " install from wheels, " + c.build + " compile from source, " + (c.blocked + c.noinstall) + " can't install.");
    L.push("");
    report.findings.forEach(function (f) {
      if (f.level === "info" && f.id === "dep-lookup") return;
      L.push("- [ ] **" + (f.level === "error" ? "Fix first" : f.level === "warn" ? "Review" : "Note") + ":** " + f.title + (f.path ? " (`" + f.path + (f.line ? ":" + f.line : "") + "`)" : ""));
      if (f.fix) L.push("  - Fix: " + f.fix);
    });
    var u = upgradeLines(report);
    var all = u.requirements.concat(u.uv, u.poetry, u.pipenv);
    if (all.length) { L.push(""); L.push("```"); all.forEach(function (x) { L.push(x); }); L.push("```"); }
    L.push("");
    L.push("Generated by Python 3.15 Readiness Check (rules as of " + DATA_AS_OF + "), https://abhishek01239.github.io/product-factory/py315-check/");
    return L.join("\n");
  }

  function parseRepo(s) {
    s = String(s || "").trim().replace(/\.git$/, "").replace(/\/+$/, "");
    var m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/tree\/(.+))?$/.exec(s) || /^([\w.-]+)\/([\w.-]+)$/.exec(s);
    if (!m) return null;
    return { owner: m[1], repo: m[2], ref: m[3] || null };
  }
  // pick files from a git tree listing
  var SKIP_DIRS = /(^|\/)(\.venv|venv|env|\.tox|\.nox|node_modules|site-packages|build|dist|\.git|__pycache__|vendor|vendored|_vendor|third_party|thirdparty|\.eggs)(\/|$)/i;
  function pickRepoFiles(paths) {
    var deps = [], ci = [], py = [], pth = [];
    paths.forEach(function (p) {
      if (SKIP_DIRS.test(p)) return;
      var k = fileKind(p);
      if (!k) return;
      if (k === "py") py.push(p);
      else if (k === "pth") pth.push(p);
      else if (k === "ci") { if (/^\.github\/workflows\/|(^|\/)(Dockerfile|Containerfile)[^\/]*$|\.dockerfile$|(^|\/)tox\.ini$|(^|\/)noxfile\.py$/i.test(p)) ci.push(p); }
      else if (!/(^|\/)(tests?|testing|fixtures?|examples?|docs?|samples?|benchmarks?)\//i.test(p)) deps.push(p);
    });
    var depth = function (p) { return p.split("/").length; };
    deps.sort(function (a, b) { return depth(a) - depth(b) || a.localeCompare(b); });
    py.sort(function (a, b) {
      var ta = /(^|\/)(tests?|docs?|examples?|benchmarks?)\//.test(a) ? 1 : 0, tb = /(^|\/)(tests?|docs?|examples?|benchmarks?)\//.test(b) ? 1 : 0;
      return ta - tb || depth(a) - depth(b) || a.localeCompare(b);
    });
    return { deps: deps.slice(0, 12), ci: ci.slice(0, 25), py: py.slice(0, 200), pth: pth.slice(0, 10), pyTotal: py.length };
  }

  var SAMPLE = {
    requirements: [
      "# requirements.txt pinned last spring",
      "numpy==2.2.6",
      "pandas==2.2.3",
      "pyyaml==6.0.2",
      "requests==2.32.3",
      "psycopg2-binary==2.9.10",
      "tomli==2.2.1 ; python_version < \"3.11\"",
      "pydantic==2.11.7",
      "pydantic-core==2.33.2"
    ].join("\n"),
    workflow: [
      "name: tests",
      "on: [push]",
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: actions/setup-python@v5",
      "        with:",
      "          python-version: '3.x'",
      "      - run: pip install -r requirements.txt",
      "      - run: pytest"
    ].join("\n"),
    dockerfile: "FROM python:3-slim\nCOPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\n",
    code: [
      "import sqlite3, sre_constants",
      "from datetime import datetime",
      "",
      "def load(path):",
      "    with open(path) as f:",
      "        return f.read()",
      "",
      "db = sqlite3.connect('app.db', 10)",
      "birthday = datetime.strptime('29 Feb', '%d %b')"
    ].join("\n")
  };

  return {
    DATA_AS_OF: DATA_AS_OF, TARGET: TARGET, SRC: SRC, PLATFORMS: PLATFORMS, DEFAULT_PLATFORMS: DEFAULT_PLATFORMS, SAMPLE: SAMPLE,
    normName: normName, parseVer: parseVer, cmpVer: cmpVer, satisfies: satisfies, allowsTarget: allowsTarget, evalMarker: evalMarker,
    parseWheel: parseWheel, wheelOK: wheelOK, classifyFiles: classifyFiles,
    parseRequirements: parseRequirements, parseUvLock: parseUvLock, parsePoetryLock: parsePoetryLock, parsePylock: parsePylock, parsePipfileLock: parsePipfileLock, parsePyproject: parsePyproject,
    encodingHits: encodingHits, strptimeHits: strptimeHits,
    fileKind: fileKind, sniff: sniff, collect: collect, lookupsNeeded: lookupsNeeded, analyze: analyze,
    smallestUpgrade: smallestUpgrade, latestInfo: latestInfo, pickVersion: pickVersion,
    fromPypiJSON: fromPypiJSON, fromSimpleJSON: fromSimpleJSON, upgradeLines: upgradeLines, markdown: markdown, platLabel: platLabel,
    parseRepo: parseRepo, pickRepoFiles: pickRepoFiles
  };
});
