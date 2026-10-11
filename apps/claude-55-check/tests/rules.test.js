"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../rules.js");

const ids = (r) => r.findings.map((f) => f.level + ":" + f.id);
const has = (r, level, id) => ids(r).includes(level + ":" + id);

test("sample request: four 400s on Sonnet 5.5 and a clean fixed body", () => {
  const r = C.checkRequest(C.SAMPLE_REQUEST, { target: "sonnet" });
  assert.equal(C.summarize(r.findings).error, 4);
  assert.equal(r.fixed.model, "claude-sonnet-5-5");
  assert.deepEqual(r.fixed.thinking, { type: "adaptive" });
  assert.equal(r.fixed.temperature, undefined);
  assert.deepEqual(r.fixed.tool_choice, { type: "auto" });
  assert.equal(r.fixed.tools[0].strict, true);
  assert.equal(r.fixed.messages.at(-1).role, "user");
  // Re-checking the fixed body must produce no 400s.
  const again = C.checkRequest(r.fixed, { target: "sonnet" });
  assert.equal(C.summarize(again.findings).error, 0);
});

test("fixed bodies are clean for every target and platform", () => {
  for (const target of ["sonnet", "opus", "haiku"]) for (const platform of ["api", "gcp", "bedrock"]) {
    const r = C.checkRequest(C.SAMPLE_REQUEST, { target, platform, betas: "interleaved-thinking-2025-05-14" });
    const again = C.checkRequest(r.fixed, { target, platform });
    assert.equal(C.summarize(again.findings).error, 0, target + "/" + platform + " " + ids(again));
  }
});

test("does not mutate the input", () => {
  const body = JSON.parse(JSON.stringify(C.SAMPLE_REQUEST));
  C.checkRequest(body, { target: "sonnet" });
  assert.deepEqual(body, C.SAMPLE_REQUEST);
});

test("Haiku 5.5 allows forced tool_choice; Sonnet/Opus do not", () => {
  const body = { model: "claude-haiku-4-5", max_tokens: 10, tool_choice: { type: "any" }, tools: [{ name: "a", input_schema: { type: "object" } }], messages: [{ role: "user", content: "hi" }] };
  assert.ok(has(C.checkRequest(body, { target: "haiku" }), "info", "tool-choice-haiku"));
  assert.ok(has(C.checkRequest(body, { target: "sonnet" }), "error", "tool-choice-forced"));
  assert.ok(has(C.checkRequest(body, { target: "opus" }), "error", "tool-choice-forced"));
  // tool_choice any marks all custom tools strict
  assert.equal(C.checkRequest(body, { target: "sonnet" }).fixed.tools[0].strict, true);
});

test("Bedrock: forced tool fix does not add strict, and strict tools are flagged", () => {
  const body = { model: "x", max_tokens: 10, tool_choice: { type: "tool", name: "a" }, tools: [{ name: "a", input_schema: { type: "object" } }], messages: [{ role: "user", content: "hi" }] };
  const r = C.checkRequest(body, { target: "sonnet", platform: "bedrock" });
  assert.equal(r.fixed.tools[0].strict, undefined);
  const s = C.checkRequest({ ...body, tool_choice: undefined, tools: [{ name: "a", strict: true, input_schema: {} }] }, { target: "opus", platform: "bedrock" });
  assert.ok(has(s, "warn", "strict-bedrock"));
});

test("thinking disabled: per-target handling", () => {
  const body = { model: "claude-sonnet-5", max_tokens: 10, thinking: { type: "disabled" }, output_config: { effort: "xhigh" }, messages: [{ role: "user", content: "hi" }] };
  const s = C.checkRequest(body, { target: "sonnet" });
  assert.ok(has(s, "error", "thinking-disabled"));
  assert.deepEqual(s.fixed.thinking, { type: "between_tools" });
  assert.equal(s.fixed.output_config.effort, "high");
  const o = C.checkRequest(body, { target: "opus" });
  assert.ok(has(o, "error", "thinking-disabled"));
  assert.equal(o.fixed.thinking, undefined);
  assert.ok(has(C.checkRequest(body, { target: "haiku" }), "warn", "thinking-disabled"));
});

test("between_tools rules on Sonnet 5.5", () => {
  const body = { model: "claude-sonnet-5-5", max_tokens: 10, thinking: { type: "between_tools", display: "summarized" }, output_config: { effort: "max" }, messages: [{ role: "user", content: "hi" }] };
  const r = C.checkRequest(body, { target: "sonnet" });
  assert.ok(has(r, "error", "between-tools-effort"));
  assert.ok(has(r, "error", "between-tools-field"));
  assert.deepEqual(r.fixed.thinking, { type: "between_tools" });
  assert.ok(has(C.checkRequest(body, { target: "opus" }), "warn", "between-tools-other"));
});

test("sampling parameters: defaults vs non-defaults", () => {
  const m = [{ role: "user", content: "hi" }];
  assert.ok(has(C.checkRequest({ model: "x", temperature: 1, messages: m }, { target: "sonnet" }), "info", "sampling-temperature"));
  assert.ok(has(C.checkRequest({ model: "x", temperature: 0, messages: m }, { target: "sonnet" }), "error", "sampling-temperature"));
  assert.ok(has(C.checkRequest({ model: "x", top_k: 5, messages: m }, { target: "opus" }), "error", "sampling-top_k"));
  // Haiku 5.5: top_p must be 0.99; 1 is rejected; both temperature+top_p rejected
  assert.ok(has(C.checkRequest({ model: "x", top_p: 0.99, messages: m }, { target: "haiku" }), "info", "sampling-top_p"));
  assert.ok(has(C.checkRequest({ model: "x", top_p: 1, messages: m }, { target: "haiku" }), "error", "sampling-top_p"));
  const both = C.checkRequest({ model: "x", temperature: 1, top_p: 0.99, messages: m }, { target: "haiku" });
  assert.ok(has(both, "error", "sampling-temperature"));
});

test("prefill detection and JSON-prefill advice", () => {
  const r = C.checkRequest({ model: "x", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: "[" }] }] }, { target: "haiku" });
  const f = r.findings.find((x) => x.id === "prefill");
  assert.equal(f.level, "error");
  assert.match(f.fix, /structured outputs/);
  assert.equal(r.fixed.messages.length, 1);
  // assistant turn in the middle is fine
  const ok = C.checkRequest({ model: "x", messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] }, { target: "sonnet" });
  assert.ok(!ids(ok).some((i) => i.endsWith(":prefill")));
});

test("computer use versions per platform", () => {
  const body = (t) => ({ model: "x", messages: [{ role: "user", content: "hi" }], tools: [{ type: t, name: "computer", display_width_px: 1024, display_height_px: 768 }] });
  const api = C.checkRequest(body("computer_20251124"), { target: "sonnet", platform: "api" });
  assert.ok(has(api, "error", "computer-tool"));
  assert.deepEqual(api.fixed.tools[0], { type: "computer_toolset_20260801" });
  const br = C.checkRequest(body("computer_20251124"), { target: "sonnet", platform: "bedrock" });
  assert.ok(!ids(br).some((i) => i.endsWith(":computer-tool")));
  const brOld = C.checkRequest(body("computer_20250124"), { target: "haiku", platform: "bedrock" });
  assert.ok(has(brOld, "error", "computer-tool"));
  assert.equal(brOld.fixed.tools[0].type, "computer_20251124");
});

test("fine-grained streaming header is a 400 next to a toolset", () => {
  const body = { model: "x", messages: [{ role: "user", content: "hi" }], tools: [{ type: "computer_toolset_20260801" }], betas: ["fine-grained-tool-streaming-2025-05-14", "keep-me"] };
  const r = C.checkRequest(body, { target: "sonnet" });
  assert.ok(has(r, "error", "beta-fgts"));
  assert.deepEqual(r.fixed.betas, ["keep-me"]);
});

test("output_format moves to output_config.format", () => {
  const r = C.checkRequest({ model: "x", output_format: { type: "json_schema", schema: {} }, messages: [{ role: "user", content: "hi" }] }, { target: "opus" });
  assert.ok(has(r, "error", "output-format"));
  assert.deepEqual(r.fixed.output_config.format, { type: "json_schema", schema: {} });
  assert.ok(has(C.checkRequest({ model: "x", output_format: {}, messages: [{ role: "user", content: "hi" }] }, { target: "opus", betas: "structured-outputs-2025-11-13" }), "warn", "output-format"));
});

test("model ID classification", () => {
  assert.equal(C.modelInfo("claude-sonnet-4-5-20250929").state, "deprecated");
  assert.equal(C.modelInfo("anthropic.claude-sonnet-4-5-20250929-v1:0").state, "deprecated");
  assert.equal(C.modelInfo("claude-sonnet-4-5@20250929").state, "deprecated");
  assert.equal(C.modelInfo("claude-haiku-4-5").state, "tentative");
  assert.equal(C.modelInfo("claude-3-5-sonnet-20241022").state, "retired");
  assert.equal(C.modelInfo("claude-sonnet-4-6"), null);
  assert.equal(C.modelInfo("claude-sonnet-5-5"), null);
  assert.equal(C.modelInfo("claude-opus-4-8"), null);
});

test("rejects non-object bodies", () => {
  assert.throws(() => C.checkRequest([], {}), /JSON object/);
  assert.throws(() => C.checkRequest(null, {}), /JSON object/);
});

test("code scan: sample Python finds each problem on the right line", () => {
  const f = C.scanText(C.SAMPLE_CODE, "a.py", { target: "sonnet" });
  const byLine = Object.fromEntries(f.map((x) => [x.id, x.line]));
  assert.equal(byLine.model, 5);
  assert.equal(byLine.sampling, 7);
  assert.equal(byLine.disabled, 8);
  assert.equal(byLine.forced, 10);
  assert.equal(byLine.prefill, 13);
  assert.equal(byLine.beta, 15);
  assert.equal(byLine.content0, 17);
  // Haiku target: no forced-tool finding
  assert.ok(!C.scanText(C.SAMPLE_CODE, "a.py", { target: "haiku" }).some((x) => x.id === "forced"));
});

test("code scan: TypeScript patterns", () => {
  const ts = [
    "import Anthropic from '@anthropic-ai/sdk';",
    "const msg = await client.messages.create({",
    "  model: 'claude-haiku-4-5',",
    "  thinking: { type: 'enabled', budget_tokens: 2048 },",
    "  tool_choice: { type: 'any' },",
    "  tools: [{ type: 'computer_20250124', name: 'computer' }],",
    "  temperature: 1,",
    "});",
    "console.log(msg.content[0].text);"
  ].join("\n");
  const f = C.scanText(ts, "a.ts", { target: "opus" });
  const got = f.map((x) => x.id + "@" + x.line);
  for (const want of ["model@3", "budget@4", "forced@5", "computer@6", "content0@9"]) assert.ok(got.includes(want), want + " in " + got);
  assert.ok(!got.some((g) => g.startsWith("sampling")), "temperature: 1 is the default");
});

test("code scan: ignores unrelated files and type annotations", () => {
  assert.deepEqual(C.scanText("temperature = 0.2\nopenai.chat(...)", "x.py", { target: "sonnet" }), []);
  const types = "// claude client\ninterface Opts { temperature?: number; top_p: number }\n";
  assert.ok(!C.scanText(types, "t.ts", { target: "sonnet" }).some((x) => x.id === "sampling"));
  // role assistant with long content is history, not flagged
  const hist = "# claude\nmsgs = [{\"role\": \"assistant\", \"content\": \"" + "x".repeat(80) + "\"}]";
  assert.ok(!C.scanText(hist, "h.py", { target: "sonnet" }).some((x) => x.id === "prefill"));
  // parse() helper output_format is fine
  assert.ok(!C.scanText("# anthropic\nclient.messages.parse(model=m, output_format=Invoice)", "p.py", { target: "sonnet" }).some((x) => x.id === "outfmt"));
});

test("code scan: forced tool_choice needs tool_choice context", () => {
  const code = "# anthropic\nblock = {\"type\": \"tool\"}\n";
  assert.ok(!C.scanText(code, "a.py", { target: "sonnet" }).some((x) => x.id === "forced"));
  const go = "// anthropic\nToolChoice: anthropic.ToolChoiceUnionParam{OfAny: &anthropic.ToolChoiceAnyParam{}},";
  assert.ok(C.scanText(go, "a.go", { target: "sonnet" }).some((x) => x.id === "forced"));
});

test("file filter and repo parser", () => {
  assert.ok(C.wantFile("src/llm/client.py"));
  assert.ok(!C.wantFile("node_modules/@anthropic-ai/sdk/index.js"));
  assert.ok(!C.wantFile("package-lock.json"));
  assert.ok(!C.wantFile("assets/logo.png"));
  assert.ok(!C.wantFile("HISTORY.md"));
  assert.ok(!C.wantFile("tests/test_providers.py"));
  assert.ok(C.wantFile("tests/test_providers.py", true));
  assert.ok(!C.wantFile("src/client.test.ts"));
  assert.deepEqual(C.parseRepo("https://github.com/a-b/c.d/tree/dev/x"), { owner: "a-b", repo: "c.d", ref: "dev/x" });
  assert.deepEqual(C.parseRepo("owner/repo.git"), { owner: "owner", repo: "repo", ref: null });
  assert.equal(C.parseRepo("not a repo"), null);
  assert.equal(C.parseRepo("a/.."), null);
});

test("markdown report", () => {
  const r = C.checkRequest(C.SAMPLE_REQUEST, { target: "sonnet" });
  const md = C.markdownReport("json", "T", r.findings);
  assert.match(md, /4 will return 400/);
  assert.match(md, /- \[ \] \(400\) Assistant prefill/);
});

test("large input performance", () => {
  const big = ("# anthropic\n" + C.SAMPLE_CODE + "\n").repeat(3000);
  const t = Date.now();
  const f = C.scanText(big, "big.py", { target: "sonnet" });
  assert.ok(f.length > 1000);
  assert.ok(Date.now() - t < 3000);
});

test("prefill heuristic ignores history acknowledgements", () => {
  const code = "# anthropic\nmsgs = [dict(role=\"assistant\", content=\"Ok.\")]\nm2 = [{\"role\": \"assistant\", \"content\": \"Here is the JSON:\"}]";
  const f = C.scanText(code, "a.py", { target: "sonnet" }).filter((x) => x.id === "prefill");
  assert.deepEqual(f.map((x) => x.line), [3]);
});

test("output_format: parse() helper across lines is not flagged", () => {
  const code = "# anthropic\nr = client.messages.parse(\n    model=m,\n    output_format=ExtractedGraph,\n)\nclient.messages.create(model=m, output_format={\"type\": \"json_schema\"})";
  const f = C.scanText(code, "a.py", { target: "sonnet" }).filter((x) => x.id === "outfmt");
  assert.deepEqual(f.map((x) => x.line), [6]);
});

test("groupFindings collapses repeats per file and rule", () => {
  const code = "# claude\n" + "x = dict(temperature=0.5)\n".repeat(5);
  const g = C.groupFindings(C.scanText(code, "a.py", { target: "sonnet" }).concat(C.scanText(code, "b.py", { target: "sonnet" })));
  assert.equal(g.length, 2);
  assert.equal(g[0].count, 5);
  assert.equal(C.locLines(g[0]), ":2, 3, 4, 5, 6");
});

test("notebooks are scanned per code cell", () => {
  const nb = JSON.stringify({ cells: [{ cell_type: "markdown", source: ["claude-sonnet-4-5 in prose"] }, { cell_type: "code", source: ["import anthropic\n", "r = client.messages.parse(\n", "    output_format=Graph,\n", ")\n", "x = client.messages.create(model=\"claude-sonnet-4-5\", temperature=0)\n"] }] });
  const f = C.scanText(nb, "g.ipynb", { target: "sonnet" });
  assert.deepEqual(f.map((x) => x.id + "@" + x.path + ":" + x.line).sort(), ["model@g.ipynb (cell 2):5", "sampling@g.ipynb (cell 2):5"]);
});

test("output_format for other APIs (string values, URLs) is ignored", () => {
  const code = "# claude\naudio = tts(output_format=\"mp3_44100_128\")\nurl = f\"wss://x?model=1&output_format={fmt}\"";
  assert.equal(C.scanText(code, "a.py", { target: "sonnet" }).filter((x) => x.id === "outfmt").length, 0);
});

test("comment lines are ignored", () => {
  const code = "import anthropic\n# thinking={\"type\": \"disabled\"} is off\n// model: claude-sonnet-4-5\n";
  assert.deepEqual(C.scanText(code, "a.py", { target: "sonnet" }), []);
});
