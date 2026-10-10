// Run: node apps/runner-26-check/tests/rules.test.js
const assert = require("assert");
const path = require("path");
const yaml = require(path.join(__dirname, "../vendor/js-yaml.min.js"));
const R = require(path.join(__dirname, "../rules.js"));
let n = 0;
function t(name, fn) { fn(); n++; console.log("ok", n, name); }
const A = (s, f) => R.analyze(s, { yaml, fileName: f || "ci.yml" });
const rules = (r) => r.jobs.flatMap(j => j.findings.map(f => f.rule + ":" + f.cmd));

t("sample analyses with expected findings", () => {
  const r = A(R.SAMPLE);
  assert.ok(!r.error, r.error);
  const b = r.jobs.find(j => j.id === "build");
  assert.equal(b.verdict.level, "high");
  const ids = b.findings.map(f => f.cmd);
  assert.ok(ids.includes("tsc"));
  assert.ok(ids.includes("clang++-17"));
  assert.ok(ids.includes("cmake"));
  assert.ok(!ids.includes("npm"), "setup-node mitigates npm");
  const p = r.jobs.find(j => j.id === "python");
  assert.deepEqual(p.labels.map(l => l.kind).sort(), ["macos14", "moves"]);
  assert.ok(p.findings.some(f => f.cmd === "$CONDA"));
  assert.ok(p.findings.some(f => f.cmd === "pip" || f.cmd === "python"));
  const i = r.jobs.find(j => j.id === "integration");
  assert.ok(i.findings.some(f => f.rule === "changed-compose"));
  assert.ok(i.findings.some(f => f.rule === "changed-java"));
  assert.equal(r.jobs.find(j => j.id === "release").verdict.level, "ok");
});

t("npx / bundle exec / local paths are not flagged", () => {
  const r = A(`jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npx tsc && yarn webpack && ./node_modules/.bin/lerna run build\n      - run: bundle exec fastlane beta\n`);
  const f = rules(r).filter(x => x.startsWith("removed:"));
  assert.deepEqual(f, []);
});

t("global install in the job mitigates", () => {
  const r = A(`jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm install -g typescript newman\n      - run: tsc -p . && newman run x.json\n      - run: sudo apt-get install -y mercurial\n      - run: hg clone x\n`);
  assert.deepEqual(rules(r).filter(x => x.startsWith("removed:")), []);
});

t("command position: sudo, env prefix, pipes, if, comments", () => {
  const r = A(`jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          # tsc is mentioned in a comment\n          echo "use gulp later"\n          FOO=1 sudo -E mediainfo f.mp4 | grep x\n          if julia --version; then echo y; fi\n`);
  const f = rules(r);
  assert.ok(f.includes("removed:mediainfo"));
  assert.ok(f.includes("removed:julia"));
  assert.ok(!f.includes("removed:tsc"));
  assert.ok(!f.includes("removed:gulp"));
});

t("pinned and self-hosted jobs are not scanned", () => {
  const r = A(`jobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps: [{run: tsc}]\n  b:\n    runs-on: [self-hosted, linux]\n    steps: [{run: tsc}]\n`);
  assert.equal(r.jobs[0].findings.length, 0);
  assert.equal(r.jobs[1].findings.length, 0);
  assert.equal(r.worst, "ok");
});

t("matrix include and workflow_call input defaults resolve", () => {
  const r = A(`on:\n  workflow_call:\n    inputs:\n      os: {type: string, default: ubuntu-latest}\njobs:\n  a:\n    runs-on: \${{ inputs.os }}\n    steps: [{run: pulumi up}]\n  b:\n    runs-on: \${{ matrix.os }}\n    strategy:\n      matrix:\n        include:\n          - os: ubuntu-22.04\n`);
  assert.equal(r.jobs[0].labels[0].kind, "moves");
  assert.ok(rules(r).includes("removed:pulumi"));
  assert.equal(r.jobs[1].labels[0].kind, "u2204");
});

t("unresolved expression reported, not guessed", () => {
  const r = A(`jobs:\n  a:\n    runs-on: \${{ fromJSON(needs.x.outputs.os) }}\n    steps: [{run: tsc}]\n`);
  assert.equal(r.jobs[0].verdict.level, "info");
  assert.equal(r.jobs[0].findings.length, 0);
});

t("container jobs downgraded", () => {
  const r = A(`jobs:\n  a:\n    runs-on: ubuntu-latest\n    container: node:22\n    steps: [{run: tsc}]\n`);
  assert.equal(r.jobs[0].verdict.level, "low");
  assert.equal(r.jobs[0].findings.length, 0);
});

t("setup actions mitigate runtimes; JAVA_HOME_8 with setup-java 8 ok", () => {
  const r = A(`jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/setup-java@v6\n        with: {java-version: '8', distribution: temurin}\n      - uses: actions/setup-python@v7\n      - run: echo $JAVA_HOME_8_X64 && mvn test && python -V\n`);
  assert.deepEqual(rules(r), []);
});

t("JAVA_HOME_8 without setup is high", () => {
  const r = A(`jobs:\n  a:\n    runs-on: ubuntu-latest\n    env:\n      JAVA_HOME: \${{ env.JAVA_HOME_8_X64 }}\n    steps: [{run: echo hi}]\n`);
  assert.ok(rules(r).includes("java8:JAVA_HOME_8_X64"));
  assert.equal(r.jobs[0].verdict.level, "high");
});

t("mysql service container mitigates; systemctl start mysql flagged otherwise", () => {
  const a = A(`jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{run: sudo systemctl start mysql.service}]\n`);
  assert.ok(rules(a).includes("changed-mysql:mysql"));
  const b = A(`jobs:\n  a:\n    runs-on: ubuntu-latest\n    services:\n      db: {image: "mysql:8.0"}\n    steps: [{run: mysql -h 127.0.0.1 -e 'select 1'}]\n`);
  assert.ok(!rules(b).includes("changed-mysql:mysql"));
});

t("apt renamed packages are low", () => {
  const r = A(`jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{run: sudo apt-get install -y p7zip-full dnsutils}]\n`);
  const f = r.jobs[0].findings;
  assert.ok(f.every(x => x.sev === "low"));
  assert.equal(f.length, 2);
});

t("macOS 14 and retired labels", () => {
  const r = A(`jobs:\n  a: {runs-on: macos-14-xlarge, steps: [{run: x}]}\n  b: {runs-on: ubuntu-20.04, steps: [{run: x}]}\n`);
  assert.equal(r.jobs[0].verdict.level, "high");
  assert.equal(r.jobs[1].verdict.text, "Uses a retired runner image");
});

t("reusable workflow call job", () => {
  const r = A(`jobs:\n  a:\n    uses: org/repo/.github/workflows/ci.yml@main\n`);
  assert.equal(r.jobs[0].verdict.level, "info");
});

t("azure pipelines vmImage", () => {
  const r = A(`pool:\n  vmImage: ubuntu-latest\nsteps:\n  - script: lerna run build\n  - bash: python3 -m pytest\n`, "azure-pipelines.yml");
  assert.equal(r.type, "azure");
  const f = rules(r);
  assert.ok(f.includes("removed:lerna"));
  assert.ok(f.includes("changed-python:python3"));
});

t("errors: empty, invalid YAML, action.yml, no jobs", () => {
  assert.ok(A("").error);
  assert.ok(/line/.test(A("jobs:\n  a: [\n").error));
  assert.ok(/action definition/.test(A("runs:\n  using: composite\n  steps: []\n").error));
  assert.ok(/No `jobs:`/.test(A("foo: bar\n").error));
  assert.ok(A("- a\n- b\n").error);
});

t("line numbers point at the right line", () => {
  const r = A(R.SAMPLE);
  const tsc = r.jobs[0].findings.find(f => f.cmd === "tsc");
  assert.equal(R.SAMPLE.split("\n")[tsc.line - 1].trim(), "run: tsc --noEmit");
});

t("pinPatch replaces labels, keeps comments", () => {
  const p = R.pinPatch("runs-on: ubuntu-latest # ubuntu-latest comment\n# runs-on: ubuntu-latest\nif: matrix.os == 'ubuntu-latest'\n");
  assert.equal(p.text, "runs-on: ubuntu-24.04 # ubuntu-latest comment\n# runs-on: ubuntu-latest\nif: matrix.os == 'ubuntu-24.04'\n");
  assert.deepEqual(p.changed, [1, 3]);
});

t("canary workflow is valid YAML and probes detected tools", () => {
  const r = A(R.SAMPLE);
  const c = R.canaryWorkflow([r]);
  const d = yaml.load(c);
  assert.deepEqual(d.jobs.compare.strategy.matrix.os, ["ubuntu-24.04", "ubuntu-26.04"]);
  assert.ok(/command -v tsc/.test(c));
  assert.ok(/command -v clang\+\+-17/.test(c));
  assert.ok(!/command -v conda/.test(c), "$CONDA is a var rule, not a probe");
});

t("markdown report includes checklist", () => {
  const md = R.markdownReport([A(R.SAMPLE), { file: "x.yml", error: "bad" }]);
  assert.ok(md.includes("- [ ] **HIGH**"));
  assert.ok(md.includes("Not checked: bad"));
});

t("daysUntil", () => {
  assert.equal(R.daysUntil("2026-10-19", new Date(2026, 9, 10)), 9);
});

t("large adversarial input is bounded", () => {
  const big = "jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n" + Array.from({ length: 3000 }, (_, i) => `      - run: echo ${i} && tsc`).join("\n") + "\n";
  const t0 = Date.now(); const r = A(big); assert.ok(Date.now() - t0 < 3000);
  assert.equal(r.jobs[0].findings.find(f => f.cmd === "tsc").count, 3000);
});
t("changed-* findings are reported once per job", () => {
  const r = A(`jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pip install x && python -V && python3 -V\n`);
  const py = r.jobs[0].findings.filter(f => f.rule === "changed-python");
  assert.equal(py.length, 1);
  assert.equal(py[0].count, 3);
});
console.log(`\n${n} tests passed`);
