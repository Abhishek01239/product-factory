"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const zlib = require("node:zlib");
const Kit = require(path.join(__dirname, "..", "kit.js"));
const yaml = require(path.join(__dirname, "..", "vendor", "js-yaml.min.js"));

const NOW = new Date(2026, 9, 9); // 9 Oct 2026 local

test("days until retirement", () => {
  assert.strictEqual(Kit.daysUntil(Kit.DATES.retirement, NOW), 63);
  assert.strictEqual(Kit.daysUntil("2026-10-09", NOW), 0);
  assert.strictEqual(Kit.fmtDate("2026-12-11"), "Dec 11, 2026");
});

test("slugify follows Agent Skills name rules", () => {
  assert.strictEqual(Kit.slugify("Weekly Report Writer!"), "weekly-report-writer");
  assert.strictEqual(Kit.slugify("  --Café  Über--  "), "cafe-uber");
  assert.strictEqual(Kit.slugify(""), "my-gpt");
  assert.strictEqual(Kit.slugify("日本語"), "my-gpt");
  const long = Kit.slugify("a ".repeat(80));
  assert.ok(long.length <= 64 && !/--|^-|-$/.test(long));
});

test("python identifiers", () => {
  assert.strictEqual(Kit.pyIdent("getTicketByID"), "get_ticket_by_id");
  assert.strictEqual(Kit.pyIdent("class"), "class_");
  assert.strictEqual(Kit.pyIdent("2fa-code"), "_2fa_code");
  assert.strictEqual(Kit.pyIdent("***", "param"), "param");
});

test("SKILL.md has valid frontmatter", () => {
  const md = Kit.skillMd(Kit.sample());
  const m = md.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, "frontmatter present");
  const fm = yaml.load(m[1]);
  assert.strictEqual(fm.name, "weekly-report-writer");
  assert.ok(fm.description.length > 0 && fm.description.length <= 1024);
  assert.match(md, /## Example requests/);
  assert.match(md, /references\/report-template.docx/);
  const longDesc = Kit.skillMd({ name: "x", description: "y".repeat(2000), instructions: "z" });
  assert.ok(yaml.load(longDesc.match(/^---\n([\s\S]*?)\n---/)[1]).description.length <= 1024);
  const tricky = Kit.skillMd({ name: "a", description: "Has: colons, \"quotes\" and # hashes", instructions: "i" });
  assert.strictEqual(yaml.load(tricky.match(/^---\n([\s\S]*?)\n---/)[1]).description, "Has: colons, \"quotes\" and # hashes");
});

test("parseSpec handles JSON, YAML and errors", () => {
  assert.strictEqual(Kit.parseSpec("", yaml).ok, false);
  assert.match(Kit.parseSpec("{bad", yaml).error, /Invalid JSON/);
  assert.match(Kit.parseSpec('{"info":{}}', yaml).error, /openapi/);
  const y = Kit.parseSpec("openapi: 3.0.0\ninfo:\n  title: Y\n  version: '1'\nservers:\n  - url: https://y.example.com/\npaths:\n  /a/{id}:\n    parameters:\n      - name: id\n        in: path\n        schema: {type: integer}\n    delete:\n      operationId: deleteA\n", yaml);
  assert.ok(y.ok);
  assert.strictEqual(y.format, "yaml");
  const s = Kit.summarizeSpec(y.spec);
  assert.strictEqual(s.baseUrl, "https://y.example.com");
  assert.strictEqual(s.operations[0].method, "DELETE");
  assert.deepStrictEqual(s.operations[0].params[0], { name: "id", in: "path", required: true, type: "int", description: "" });
});

test("operations resolve $ref parameters and bodies", () => {
  const spec = {
    openapi: "3.1.0", info: { title: "R" }, paths: {
      "/x": { post: { parameters: [{ $ref: "#/components/parameters/Lim" }], requestBody: { $ref: "#/components/requestBodies/B" } } }
    },
    components: { parameters: { Lim: { name: "limit", in: "query", schema: { type: ["integer", "null"] } } }, requestBodies: { B: { required: true, content: {} } } }
  };
  const ops = Kit.listOperations(spec);
  assert.strictEqual(ops[0].operationId, "post_/x");
  assert.strictEqual(ops[0].params[0].type, "int");
  assert.ok(ops[0].hasBody && ops[0].bodyRequired);
});

test("MCP stub is well-formed for the sample action", () => {
  const s = Kit.sample();
  const py = Kit.mcpServerPy(s.actions[0].name, JSON.parse(s.actions[0].schema));
  assert.match(py, /from mcp\.server import MCPServer as _Server/);
  assert.match(py, /from mcp\.server\.fastmcp import FastMCP as _Server/);
  assert.match(py, /def get_ticket\(ticket_id: str\) -> Any:/);
  assert.match(py, /def list_tickets\(status: Optional\[str\] = None, limit: Optional\[int\] = None\)/);
  assert.match(py, /def create_ticket\(body: dict\)/);
  assert.match(py, /headers\["X-API-Key"\] = API_KEY/);
  assert.match(py, /ask the user before calling/);
  assert.doesNotMatch(py, /sk-|password/i);
});

test("MCP stub escapes hostile strings", () => {
  const spec = { openapi: "3.0.0", info: { title: 't"""x' }, servers: [{ url: 'https://e.com/"; import os' }], paths: { "/p": { get: { operationId: "go", summary: 'evil """ \\ end' } } } };
  const py = Kit.mcpServerPy('n"""ame', spec);
  assert.match(py, /BASE_URL = os\.environ\.get\("API_BASE_URL", "https:\/\/e\.com\/\\"; import os"\)/);
  assert.match(py, /mcp = _Server\("n\\"\\"\\"ame"\)/);
  const doc = py.split("def go()")[1];
  assert.ok(!/"""[^\n]*"""[^\n]*"""/.test(doc.split("\n")[1]), "docstring not broken");
});

test("migration report flags what is dropped", () => {
  const r = Kit.migrationReport(Kit.sample(), NOW);
  const titles = r.items.map((i) => i.title).join("|");
  assert.match(titles, /Custom actions \(1\)/);
  assert.match(titles, /Conversation starters \(3\)/);
  assert.match(titles, /Selected model/);
  assert.match(titles, /Sharing: My workspace/);
  assert.strictEqual(r.days, 63);
  const draft = Kit.migrationReport({ name: "a", instructions: "b", published: "draft", plan: "enterprise" }, NOW);
  assert.ok(draft.items.some((i) => i.status === "lost" && /draft/i.test(i.title) && /Oct 26, 2026/.test(i.detail)));
  const empty = Kit.migrationReport({}, NOW);
  assert.ok(empty.items[0].status === "check");
});

test("secret scanner", () => {
  assert.strictEqual(Kit.findSecrets("Use key " + ["sk", "proj", "x".repeat(26)].join("-")).length, 1);
  assert.strictEqual(Kit.findSecrets("ghp_" + "a".repeat(36))[0].kind, "GitHub token");
  assert.strictEqual(Kit.findSecrets("Authorization: " + "Bear" + "er " + "t".repeat(30)).length, 1);
  assert.strictEqual(Kit.findSecrets("Ask for the user's sk- prefix").length, 0);
});

test("bundle contents and ZIP validity", () => {
  const files = Kit.buildBundle(Kit.sample(), { now: NOW, yaml, files: [{ name: "../evil/report-template.docx", data: new Uint8Array([1, 2, 3]) }] });
  const paths = files.map((f) => f.path);
  ["gpt.json", "README.md", "instructions.md", "MIGRATION.md", "test-prompts.md", "skill/weekly-report-writer/SKILL.md", "portable/claude-project.md", "portable/gemini-gem.md", "portable/system-prompt.txt", "actions/ticket-tracker/openapi.json", "actions/ticket-tracker/server.py", "actions/ticket-tracker/README.md"]
    .forEach((p) => assert.ok(paths.includes("weekly-report-writer-backup/" + p), p));
  assert.ok(paths.every((p) => !p.includes("..")), "no path traversal");
  const json = JSON.parse(files.find((f) => f.path.endsWith("gpt.json")).content);
  assert.strictEqual(json.kit.version, Kit.VERSION);
  assert.deepStrictEqual(Kit.normalize(json).starters, Kit.normalize(Kit.sample()).starters);

  const zip = Buffer.from(Kit.zip(files, NOW));
  assert.strictEqual(zip.readUInt32LE(0), 0x04034b50);
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.strictEqual(zip.readUInt16LE(eocd + 10), files.length);
  // Walk local headers and verify CRCs + content round-trip.
  let off = 0, n = 0;
  while (zip.readUInt32LE(off) === 0x04034b50) {
    const crc = zip.readUInt32LE(off + 14), size = zip.readUInt32LE(off + 18), nl = zip.readUInt16LE(off + 26);
    const name = zip.slice(off + 30, off + 30 + nl).toString("utf8");
    const data = zip.slice(off + 30 + nl, off + 30 + nl + size);
    assert.strictEqual(crc, zlib.crc32 ? zlib.crc32(data) : Kit.crc32(data), name);
    assert.strictEqual(name, files[n].path);
    off += 30 + nl + size; n++;
  }
  assert.strictEqual(n, files.length);
});

test("bad action schema still produces a README, no stub", () => {
  const files = Kit.buildBundle({ name: "A", instructions: "B", actions: [{ name: "Broken", schema: "not: [valid" }] }, { yaml, now: NOW });
  const p = files.map((f) => f.path);
  assert.ok(p.includes("a-backup/actions/broken/openapi.txt"));
  assert.ok(!p.some((x) => x.endsWith("server.py")));
});

test("crc32 known value", () => {
  assert.strictEqual(Kit.crc32(Buffer.from("123456789")), 0xcbf43926);
});
