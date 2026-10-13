"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../rules.js");

const ids = (r) => r.findings.map((f) => f.level + ":" + f.id);
const has = (r, level, id) => ids(r).includes(level + ":" + id);
const files = (...names) => names.map((n) => ({ filename: n }));

test("PEP 440 compare and specifiers", () => {
  assert.equal(P.cmpVer("2.5.2", "2.5.10"), -1);
  assert.equal(P.cmpVer("3.0.0rc1", "3.0.0"), -1);
  assert.equal(P.cmpVer("3.0.0.post1", "3.0.0"), 1);
  assert.equal(P.cmpVer("3.0.0.dev1", "3.0.0a1"), -1);
  assert.ok(P.satisfies("3.15.0", ">=3.10"));
  assert.ok(!P.satisfies("3.15.0", ">=3.10,<3.15"));
  assert.ok(P.satisfies("3.15.0", "!=3.0.*,>=3.8"));
  assert.ok(!P.satisfies("3.15.0", "==3.14.*"));
  assert.ok(P.satisfies("3.15.0", "~=3.10"));
  assert.ok(!P.satisfies("3.15.0", "~=3.10.0"));
  assert.ok(P.satisfies("3.15.0", "^3.9"));
  assert.ok(!P.satisfies("3.15.0", "~3.9"));
  assert.ok(P.satisfies("3.15.0", ">=3.8,<4.0"));
  assert.ok(P.allowsTarget(null));
});

test("markers evaluate for CPython 3.15", () => {
  assert.equal(P.evalMarker("python_version < \"3.11\""), false);
  assert.equal(P.evalMarker("python_full_version >= '3.15'"), true);
  assert.equal(P.evalMarker("python_full_version == '3.13.*' and implementation_name == 'cpython'"), false);
  assert.equal(P.evalMarker("(python_full_version >= '3.12' and python_full_version < '3.15') or python_full_version == '3.14.*'"), false);
  assert.equal(P.evalMarker("sys_platform == 'win32'"), true, "unknown variables don't exclude");
  assert.equal(P.evalMarker("platform_machine == 'x86_64' and python_version >= '3.12'"), true);
});

test("wheel tags: cp315, abi3, pure, free-threaded", () => {
  const w = (f) => P.parseWheel(f);
  assert.ok(P.wheelOK(w("numpy-2.5.2-cp315-cp315-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl"), "linux-x86_64", false));
  assert.ok(!P.wheelOK(w("numpy-2.2.6-cp314-cp314-manylinux_2_27_x86_64.whl"), "linux-x86_64", false));
  assert.ok(P.wheelOK(w("cryptography-50.0.2-cp311-abi3-macosx_10_9_universal2.whl"), "macos-arm64", false));
  assert.ok(!P.wheelOK(w("cryptography-50.0.2-cp311-abi3-macosx_10_9_universal2.whl"), "macos-arm64", true), "abi3 is not valid on 3.15t");
  assert.ok(P.wheelOK(w("cryptography-50.0.2-cp315-abi3.abi3t-win_amd64.whl"), "win-amd64", true), "abi3t works on 3.15t");
  assert.ok(P.wheelOK(w("requests-2.32.3-py3-none-any.whl"), "win-amd64", false));
  assert.ok(P.wheelOK(w("six-1.16.0-py2.py3-none-any.whl"), "musl-x86_64", false));
  assert.ok(P.wheelOK(w("ruff-0.9.0-py3-none-musllinux_1_2_x86_64.whl"), "musl-x86_64", false));
  assert.ok(!P.wheelOK(w("ruff-0.9.0-py3-none-musllinux_1_2_x86_64.whl"), "linux-x86_64", false));
  assert.ok(P.wheelOK(w("x-1.0-cp315-cp315t-manylinux_2_28_aarch64.whl"), "linux-aarch64", true));
  assert.ok(!P.wheelOK(w("x-1.0-cp315-cp315t-manylinux_2_28_aarch64.whl"), "linux-aarch64", false));
  assert.ok(!P.wheelOK(w("x-1.0-cp316-abi3-win_amd64.whl"), "win-amd64", false), "abi3 from a newer minor is not compatible");
});

test("classifyFiles: build, none, n/a", () => {
  const plats = ["linux-x86_64", "macos-arm64", "win-amd64"];
  const old = P.classifyFiles(files("numpy-2.2.6-cp314-cp314-win_amd64.whl", "numpy-2.2.6-cp314-cp314-macosx_14_0_arm64.whl", "numpy-2.2.6-cp314-cp314-manylinux_2_17_x86_64.whl", "numpy-2.2.6.tar.gz"), plats, false);
  assert.deepEqual(plats.map((p) => old.per[p].status), ["build", "build", "build"]);
  assert.ok(old.binary);
  const torch = P.classifyFiles(files("torch-2.12.1-cp314-cp314-manylinux_2_28_x86_64.whl", "torch-2.12.1-cp314-cp314-win_amd64.whl", "torch-2.12.1-cp314-none-macosx_11_0_arm64.whl"), plats, false);
  assert.deepEqual(plats.map((p) => torch.per[p].status), ["none", "none", "none"]);
  const cuda = P.classifyFiles(files("nvidia_cublas-12.9.1-py3-none-manylinux_2_27_x86_64.whl"), plats, false);
  assert.deepEqual(plats.map((p) => cuda.per[p].status), ["wheel", "na", "na"]);
  assert.ok(cuda.allWheel);
});

test("requirements.txt parsing: pins, markers, options, continuations", () => {
  const deps = P.parseRequirements([
    "# comment", "-r base.txt", "--index-url https://example.com/simple",
    "numpy==2.2.6 \\", "    --hash=sha256:abc", "Django>=5.0", "tomli==2.2.1 ; python_version < \"3.11\"",
    "requests[socks]==2.32.3  # inline", "git+https://github.com/x/y.git#egg=y", "./local", "pywin32==312; sys_platform == 'win32'"
  ].join("\n"), "requirements.txt");
  const by = Object.fromEntries(deps.map((d) => [d.norm, d]));
  assert.equal(by.numpy.version, "2.2.6");
  assert.equal(by.django.version, null);
  assert.equal(by.django.spec, ">=5.0");
  assert.equal(by.requests.version, "2.32.3");
  assert.ok(!("y" in by));
  const c = P.collect({ files: [{ path: "requirements.txt", text: "tomli==2.2.1 ; python_version < \"3.11\"\nattrs==25.1.0" }] });
  assert.deepEqual(c.deps.map((d) => d.norm), ["attrs"], "deps excluded by markers are dropped");
});

const UV_LOCK = `version = 1
revision = 3
requires-python = ">=3.10"
resolution-markers = [
    "python_full_version >= '3.12'",
    "python_full_version < '3.12'",
]

[[package]]
name = "myapp"
version = "0.1.0"
source = { editable = "." }

[[package]]
name = "numpy"
version = "2.2.6"
source = { registry = "https://pypi.org/simple" }
resolution-markers = [
    "python_full_version < '3.12'",
]
sdist = { url = "https://files.pythonhosted.org/packages/aa/numpy-2.2.6.tar.gz", hash = "sha256:1", size = 1 }
wheels = [
    { url = "https://files.pythonhosted.org/packages/bb/numpy-2.2.6-cp311-cp311-manylinux_2_17_x86_64.whl", hash = "sha256:2", size = 1 },
]

[[package]]
name = "numpy"
version = "2.3.4"
source = { registry = "https://pypi.org/simple" }
resolution-markers = [
    "python_full_version >= '3.12'",
]
sdist = { url = "https://files.pythonhosted.org/packages/aa/numpy-2.3.4.tar.gz", hash = "sha256:1", size = 1 }
wheels = [
    { url = "https://files.pythonhosted.org/packages/bb/numpy-2.3.4-cp314-cp314-manylinux_2_27_x86_64.whl", hash = "sha256:2", size = 1 },
    { url = "https://files.pythonhosted.org/packages/bb/numpy-2.3.4-cp314-cp314-win_amd64.whl", hash = "sha256:2", size = 1 },
]

[[package]]
name = "requests"
version = "2.32.3"
source = { registry = "https://pypi.org/simple" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/cc/requests-2.32.3-py3-none-any.whl", hash = "sha256:3", size = 1 },
]

[[package]]
name = "cryptography"
version = "50.0.2"
source = { registry = "https://pypi.org/simple" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/dd/cryptography-50.0.2-cp311-abi3-manylinux_2_28_x86_64.whl", hash = "sha256:4", size = 1 },
    { url = "https://files.pythonhosted.org/packages/dd/cryptography-50.0.2-cp311-abi3-win_amd64.whl", hash = "sha256:4", size = 1 },
]
`;

test("uv.lock: offline wheel check, editable skipped, resolution markers respected", () => {
  const r = P.analyze({ files: [{ path: "uv.lock", text: UV_LOCK }], platforms: ["linux-x86_64", "win-amd64"] });
  const by = Object.fromEntries(r.pkgs.map((p) => [p.norm + "@" + p.version, p]));
  assert.ok(!("myapp@0.1.0" in by));
  assert.ok(!("numpy@2.2.6" in by), "fork for <3.12 is not installed on 3.15");
  assert.equal(by["numpy@2.3.4"].status, "build");
  assert.equal(by["requests@2.32.3"].status, "ok");
  assert.equal(by["cryptography@50.0.2"].status, "ok");
  assert.ok(has(r, "error", "dep-build"));
  assert.deepEqual(P.lookupsNeeded(P.collect({ files: [{ path: "uv.lock", text: UV_LOCK }] })).pinned, [], "uv.lock needs no per-version lookups");
});

test("poetry.lock: files list and markers", () => {
  const lock = `[[package]]
name = "pyyaml"
version = "6.0.2"
description = "YAML"
optional = false
python-versions = ">=3.8"
files = [
    {file = "PyYAML-6.0.2-cp313-cp313-win_amd64.whl", hash = "sha256:1"},
    {file = "pyyaml-6.0.2.tar.gz", hash = "sha256:2"},
]

[[package]]
name = "tomli"
version = "2.2.1"
python-versions = ">=3.8"
markers = "python_version < \\"3.11\\""
files = [
    {file = "tomli-2.2.1-py3-none-any.whl", hash = "sha256:3"},
]

[[package]]
name = "oldlib"
version = "1.0.0"
python-versions = ">=3.8,<3.15"
files = [
    {file = "oldlib-1.0.0-py3-none-any.whl", hash = "sha256:4"},
]

[package.extras]
dev = ["pytest"]

[metadata]
lock-version = "2.1"
python-versions = "^3.10"
content-hash = "abc"
`;
  const r = P.analyze({ files: [{ path: "poetry.lock", text: lock }], platforms: ["win-amd64"] });
  const st = Object.fromEntries(r.pkgs.map((p) => [p.norm, p.status]));
  assert.deepEqual(st, { pyyaml: "build", oldlib: "blocked" });
  assert.ok(has(r, "error", "dep-blocked"));
});

test("Pipfile.lock and pylock.toml parse", () => {
  const pf = JSON.stringify({ _meta: {}, default: { numpy: { version: "==2.2.6" }, tomli: { version: "==2.2.1", markers: "python_version < '3.11'" } }, develop: { pytest: { version: "==8.3.4" } } });
  const d = P.parsePipfileLock(pf, "Pipfile.lock");
  assert.deepEqual(d.map((x) => x.norm + "@" + x.version), ["numpy@2.2.6", "pytest@8.3.4"]);
  const pl = `lock-version = "1.0"
[[packages]]
name = "attrs"
version = "25.1.0"
wheels = [{ name = "attrs-25.1.0-py3-none-any.whl", url = "https://files.pythonhosted.org/x/attrs-25.1.0-py3-none-any.whl", hashes = {sha256 = "1"} }]
`;
  const r = P.analyze({ files: [{ path: "pylock.toml", text: pl }] });
  assert.equal(r.pkgs[0].status, "ok");
});

test("pinned lookup + smallest upgrade + parent pin", () => {
  const req = "numpy==2.2.6\npydantic==2.11.7\npydantic-core==2.33.2\n";
  const pypi = {
    "numpy@2.2.6": { requiresPython: ">=3.10", files: files("numpy-2.2.6-cp314-cp314-manylinux_2_17_x86_64.whl", "numpy-2.2.6.tar.gz") },
    "pydantic@2.11.7": { requiresPython: ">=3.9", requiresDist: ["pydantic-core==2.33.2", "typing-extensions>=4.12", "email-validator>=2.0.0; extra == \"email\""], files: files("pydantic-2.11.7-py3-none-any.whl") },
    "pydantic-core@2.33.2": { requiresPython: ">=3.9", files: files("pydantic_core-2.33.2-cp314-cp314-manylinux_2_17_x86_64.whl", "pydantic_core-2.33.2.tar.gz") }
  };
  const simple = {
    numpy: { files: [
      { filename: "numpy-2.2.6.tar.gz", requiresPython: ">=3.10" },
      { filename: "numpy-2.5.0rc1-cp315-cp315-manylinux_2_27_x86_64.whl", requiresPython: ">=3.12" },
      { filename: "numpy-2.5.1-cp314-cp314-manylinux_2_27_x86_64.whl", requiresPython: ">=3.12" },
      { filename: "numpy-2.5.2-cp315-cp315-manylinux_2_27_x86_64.whl", requiresPython: ">=3.12" },
      { filename: "numpy-2.5.3-cp315-cp315-manylinux_2_27_x86_64.whl", requiresPython: ">=3.12", yanked: false },
      { filename: "numpy-2.10.0-cp315-cp315-manylinux_2_27_x86_64.whl", requiresPython: ">=3.12" }
    ] },
    "pydantic-core": { files: [{ filename: "pydantic_core-2.48.0-cp315-cp315-manylinux_2_17_x86_64.whl", requiresPython: ">=3.10" }] }
  };
  const r = P.analyze({ files: [{ path: "requirements.txt", text: req }], platforms: ["linux-x86_64"], pypi, simple });
  const by = Object.fromEntries(r.pkgs.map((p) => [p.norm, p]));
  assert.equal(by.numpy.status, "build");
  assert.equal(by.numpy.upgrade.version, "2.5.2", "skips prereleases and versions without wheels, picks the lowest fix");
  assert.equal(by.numpy.upgrade.jump, "minor version change");
  assert.equal(by["pydantic-core"].pinnedBy, "pydantic 2.11.7");
  assert.equal(by.pydantic.status, "ok");
  const up = P.upgradeLines(r).requirements.join("\n");
  assert.match(up, /numpy==2\.5\.2/);
  assert.match(up, /pydantic-core: upgrade pydantic instead/);
  const md = P.markdown(r, "demo");
  assert.match(md, /Fix first/);
});

test("unpinned spec resolves like pip (newest allowed, no prerelease)", () => {
  const simple = { django: { files: [
    { filename: "django-5.2.0-py3-none-any.whl", requiresPython: ">=3.10" },
    { filename: "django-6.0.0-py3-none-any.whl", requiresPython: ">=3.12" },
    { filename: "django-6.1a1-py3-none-any.whl", requiresPython: ">=3.12" }
  ] } };
  const r = P.analyze({ files: [{ path: "requirements.txt", text: "Django>=5.0,<6.1" }], simple });
  assert.equal(r.pkgs[0].version, "6.0.0");
  assert.equal(r.pkgs[0].status, "ok");
});

test("code rules: removed APIs, strptime, sqlite, argparse, encoding", () => {
  const code = [
    "import sre_constants",
    "from sre_parse import parse",
    "# import sre_compile  (comment, ignored)",
    "from http.server import CGIHTTPRequestHandler",
    "names = glob.glob1(d, '*.py')",
    "co.co_lnotab",
    "Point = NamedTuple('Point', x=int, y=int)",
    "TD = TypedDict('TD')",
    "ok = TypedDict('TD', {'a': int})",
    "con = sqlite3.connect(path, 5)",
    "con2 = sqlite3.connect(path, timeout=5)",
    "datetime.strptime(s, '%d/%m')",
    "datetime.strptime(s, '%d/%m/%Y')",
    "p.add_argument('-f', '-foo')",
    "data = open('a.txt').read()",
    "raw = open('a.bin', 'rb').read()",
    "txt = open('a.txt', encoding='utf-8').read()",
    "Path('x').read_text()",
    "from typing import ByteString",
    "files(package='mypkg')  # importlib.resources"
  ].join("\n");
  const r = P.analyze({ files: [{ path: "m.py", text: code }] });
  for (const id of ["sre", "cgi-handler", "glob01", "lnotab", "nt-kwargs", "td-empty", "sqlite-positional", "strptime-noyear", "res-files-package"]) assert.ok(has(r, "error", id), id);
  for (const id of ["argparse-dest", "bytestring"]) assert.ok(has(r, "warn", id), id);
  assert.equal(r.findings.filter((f) => f.id === "sre").length, 2, "commented import is ignored");
  assert.equal(r.findings.filter((f) => f.id === "sqlite-positional").length, 1);
  assert.equal(r.findings.filter((f) => f.id === "strptime-noyear").length, 1);
  assert.equal(r.findings.filter((f) => f.id === "td-empty").length, 1);
  const enc = r.findings.find((f) => f.id === "utf8-default");
  assert.equal(enc.count, 2, "binary and explicit encodings are skipped");
});

test("CI rules: floating docker tags and setup-python", () => {
  const wf = [
    "jobs:", "  t:", "    strategy:", "      matrix:", "        python: ['3.12', '3.13', '3.14']", "    steps:",
    "      - uses: actions/setup-python@v5", "        with:", "          python-version: '3.x'",
    "      - uses: actions/setup-python@v5", "        with:", "          python-version: 3.10",
    "      - uses: actions/setup-python@v5", "        with:", "          python-version: '3.14'",
    "    container:", "      image: python:3-slim"
  ].join("\n");
  const r = P.analyze({ files: [{ path: ".github/workflows/ci.yml", text: wf }, { path: "Dockerfile", text: "FROM python:3.14-slim AS a\nFROM python:latest\nFROM python\nFROM python:3-alpine AS b\nFROM python:3.15-slim\n" }] });
  assert.equal(r.findings.filter((f) => f.id === "setup-python-floating").length, 1);
  assert.ok(has(r, "warn", "yaml-float"));
  assert.ok(has(r, "info", "matrix-missing-315"));
  const docker = r.findings.filter((f) => f.id === "docker-floating").map((f) => f.path + ":" + f.line);
  assert.deepEqual(docker, [".github/workflows/ci.yml:17", "Dockerfile:2", "Dockerfile:3", "Dockerfile:4"]);
});

test("pyproject: requires-python cap and classifier", () => {
  const py = `[build-system]\nrequires = ["hatchling"]\n\n[project]\nname = "demo"\nrequires-python = ">=3.10,<3.15"\nclassifiers = [\n  "Programming Language :: Python :: 3.14",\n]\ndependencies = ["numpy>=2"]\n`;
  const r = P.analyze({ files: [{ path: "pyproject.toml", text: py }] });
  const cap = r.findings.find((f) => f.id === "requires-python-cap");
  assert.equal(cap.level, "error");
  assert.equal(cap.line, 6);
  assert.ok(has(r, "info", "classifier-315"));
  assert.deepEqual(P.lookupsNeeded(P.collect({ files: [{ path: "pyproject.toml", text: py }] })).names, ["numpy"], "pyproject deps used when no lock exists");
});

test(".pth import lines", () => {
  const r = P.analyze({ files: [{ path: "src/_virtualenv.pth", text: "import _virtualenv\n" }, { path: "paths.pth", text: "/opt/lib\n" }] });
  assert.equal(r.findings.filter((f) => f.id === "pth-import").length, 1);
});

test("sniffing and repo helpers", () => {
  assert.equal(P.sniff(UV_LOCK), "uv");
  assert.equal(P.sniff("numpy==2.2.6\npandas==2.2.3"), "requirements");
  assert.equal(P.sniff("FROM python:3\n"), "ci");
  assert.equal(P.sniff("import os\ndef f():\n  pass"), "py");
  assert.deepEqual(P.parseRepo("https://github.com/pallets/flask/tree/stable"), { owner: "pallets", repo: "flask", ref: "stable" });
  assert.equal(P.parseRepo("not a repo"), null);
  const pick = P.pickRepoFiles(["uv.lock", "tests/fixtures/requirements.txt", ".venv/lib/x.py", "src/a.py", "tests/test_a.py", ".github/workflows/ci.yml", "docs/conf.py", "Dockerfile"]);
  assert.deepEqual(pick.deps, ["uv.lock"]);
  assert.deepEqual(pick.py, ["src/a.py", "docs/conf.py", "tests/test_a.py"]);
  assert.deepEqual(pick.ci.sort(), [".github/workflows/ci.yml", "Dockerfile"]);
});

test("sample runs offline without throwing", () => {
  const S = P.SAMPLE;
  const r = P.analyze({ files: [{ path: "requirements.txt", text: S.requirements }, { path: "ci.yml", text: S.workflow }, { path: "Dockerfile", text: S.dockerfile }, { path: "app.py", text: S.code }] });
  assert.ok(r.pkgs.every((p) => p.status === "not-checked"));
  assert.ok(has(r, "warn", "docker-floating"));
  assert.ok(has(r, "warn", "setup-python-floating"));
  assert.ok(has(r, "error", "sre"));
});
