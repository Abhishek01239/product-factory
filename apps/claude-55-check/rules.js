/*
 * Claude 5.5 Request Check — rules engine.
 * Every rule below is taken from Anthropic's migration guides (links in SRC).
 * Pure functions, no DOM, no network: usable in the browser and in Node tests.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.C55 = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DATA_AS_OF = "2026-10-11";

  var SRC = {
    sonnet: "https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide",
    opus: "https://platform.claude.com/docs/en/models/opus-5-5/migration-guide",
    haiku: "https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide",
    deprecations: "https://platform.claude.com/docs/en/about-claude/model-deprecations",
    tools: "https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools",
    notes: "https://platform.claude.com/docs/en/release-notes/overview"
  };

  var TARGETS = {
    sonnet: { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", src: SRC.sonnet },
    opus: { id: "claude-opus-5-5", name: "Claude Opus 5.5", src: SRC.opus },
    haiku: { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", src: SRC.haiku }
  };

  var PLATFORMS = { api: "Claude API", gcp: "Google Cloud (Vertex AI)", bedrock: "Amazon Bedrock" };

  // Retirement dates from the model deprecations page (as of DATA_AS_OF).
  var MODELS = [
    { re: /claude-sonnet-4-5(?![0-9])/i, name: "Claude Sonnet 4.5", state: "deprecated", date: "2026-11-30", note: "Deprecated Sep 30, 2026; retires on the Claude API on Nov 30, 2026." },
    { re: /claude-haiku-4-5(?![0-9])/i, name: "Claude Haiku 4.5", state: "tentative", date: "2026-10-15", note: "Active, but its tentative retirement date is \"not sooner than\" Oct 15, 2026." },
    { re: /claude-opus-4-5(?![0-9])/i, name: "Claude Opus 4.5", state: "tentative", date: "2026-11-24", note: "Active, but its tentative retirement date is \"not sooner than\" Nov 24, 2026." },
    { re: /claude-opus-4-1(?![0-9])/i, name: "Claude Opus 4.1", state: "retired", date: "2026-08-05", note: "Retired on the Claude API on Aug 5, 2026. Requests fail now." },
    { re: /claude-(?:sonnet|opus)-4-20250514/i, name: "Claude Sonnet 4 / Opus 4", state: "retired", date: "2026-06-15", note: "Retired on the Claude API on Jun 15, 2026. Requests fail now." },
    { re: /claude-3-(?:7|5)-sonnet|claude-3-(?:5-)?haiku|claude-3-opus|claude-3-sonnet/i, name: "Claude 3.x", state: "retired", date: "2026-04-20", note: "Every Claude 3.x model is retired on the Claude API. Requests fail now." },
    { re: /claude-(?:instant-)?[12]\.[0-9]/i, name: "Claude 1.x / 2.x", state: "retired", date: "2025-07-21", note: "Retired. Requests fail now." }
  ];

  function isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function F(level, id, title, detail, fix, src, extra) {
    var f = { level: level, id: id, title: title, detail: detail, fix: fix || "", src: src || "" };
    if (extra) for (var k in extra) f[k] = extra[k];
    return f;
  }

  function modelInfo(id) {
    if (typeof id !== "string") return null;
    for (var i = 0; i < MODELS.length; i++) if (MODELS[i].re.test(id)) return MODELS[i];
    return null;
  }

  function lastMessage(body) {
    return Array.isArray(body.messages) && body.messages.length ? body.messages[body.messages.length - 1] : null;
  }

  function textOf(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map(function (b) { return b && typeof b.text === "string" ? b.text : ""; }).join("");
    return "";
  }

  function parseBetas(input, body) {
    var list = [];
    if (typeof input === "string") list = input.split(/[\s,]+/);
    else if (Array.isArray(input)) list = input.slice();
    if (body && Array.isArray(body.betas)) list = list.concat(body.betas);
    return list.map(function (s) { return String(s).trim(); }).filter(Boolean);
  }

  /**
   * Check one Messages API request body against a target model.
   * opts: { target: "sonnet"|"opus"|"haiku", platform: "api"|"gcp"|"bedrock", betas: string|string[] }
   * Returns { findings, fixed, changes } — fixed is a corrected copy of the body.
   */
  function checkRequest(body, opts) {
    opts = opts || {};
    var tk = TARGETS[opts.target] ? opts.target : "sonnet";
    var T = TARGETS[tk];
    var platform = PLATFORMS[opts.platform] ? opts.platform : "api";
    var bedrock = platform === "bedrock";
    if (!isObj(body)) throw new Error("The request body must be a JSON object (the thing you pass to messages.create).");
    var out = [];
    var changes = [];
    var fixed = clone(body);
    var betas = parseBetas(opts.betas, body);
    var cfg = isObj(body.output_config) ? body.output_config : {};
    var effort = typeof cfg.effort === "string" ? cfg.effort : null;

    // --- model ID
    if (typeof body.model === "string") {
      var mi = modelInfo(body.model);
      if (mi) out.push(F(mi.state === "retired" ? "error" : "warn", "model-retiring", "Model " + body.model + " is " + (mi.state === "retired" ? "retired" : "on its way out"), mi.note, "Use " + T.id + (bedrock || platform === "gcp" ? " (or that platform's ID for it)" : "") + ".", SRC.deprecations));
      if (body.model !== T.id) { fixed.model = T.id; changes.push("model: " + body.model + " → " + T.id); }
    } else {
      fixed.model = T.id; changes.push("model: added " + T.id);
    }

    // --- thinking
    var th = body.thinking;
    var thType = isObj(th) ? th.type : undefined;
    if (thType === "enabled" || (isObj(th) && "budget_tokens" in th && thType !== "between_tools")) {
      out.push(F("error", "thinking-budget", "Manual thinking budget returns 400", T.name + " rejects thinking: {type: \"enabled\", budget_tokens}. Error: \"thinking.type.enabled\" is not supported for this model.", "Use thinking: {type: \"adaptive\"} (or omit it) and control depth with output_config.effort. There is no fixed budget→effort mapping, so evaluate 2–3 levels.", T.src));
      fixed.thinking = { type: "adaptive" };
      if (!effort) { var dflt = tk === "haiku" ? "medium" : "high"; fixed.output_config = Object.assign({}, fixed.output_config || {}, { effort: dflt }); changes.push("output_config.effort: set to \"" + dflt + "\" (re-test other levels)"); }
      changes.push("thinking: enabled/budget_tokens → {type: \"adaptive\"}");
    } else if (thType === "disabled") {
      if (tk === "sonnet") {
        out.push(F("error", "thinking-disabled", "thinking: disabled returns 400", "On Sonnet 5.5, send thinking: {type: \"between_tools\"} instead. It works at low, medium and high effort; xhigh or max return 400.", "Replace with {type: \"between_tools\"} and keep effort at high or below.", T.src));
        fixed.thinking = { type: "between_tools" };
        changes.push("thinking: disabled → between_tools");
        if (effort === "xhigh" || effort === "max") { fixed.output_config.effort = "high"; changes.push("output_config.effort: " + effort + " → high (between_tools rejects xhigh/max)"); }
      } else if (tk === "opus") {
        out.push(F("error", "thinking-disabled", "thinking: disabled returns 400", "Opus 5.5 always thinks adaptively. Error: \"thinking.type.disabled\" is not supported for this model.", "Remove the thinking field and use output_config.effort (e.g. \"low\") to keep latency down.", T.src));
        delete fixed.thinking; changes.push("thinking: removed (adaptive is always on)");
      } else {
        out.push(F("warn", "thinking-disabled", "thinking: disabled is not a documented setting", "The Haiku 5.5 guide says to leave thinking unset or send {type: \"adaptive\"}; it does not list a disabled setting.", "Remove the thinking field and set output_config.effort.", T.src));
        delete fixed.thinking; changes.push("thinking: removed");
      }
    } else if (thType === "between_tools") {
      if (tk === "sonnet") {
        if (effort === "xhigh" || effort === "max") {
          out.push(F("error", "between-tools-effort", "between_tools at " + effort + " effort returns 400", "between_tools is accepted only at low, medium and high effort.", "Lower effort to high, or switch to adaptive thinking for xhigh/max.", T.src));
          fixed.output_config.effort = "high"; changes.push("output_config.effort: " + effort + " → high");
        }
        ["display", "budget_tokens", "block_binding"].forEach(function (k) {
          if (k in th) {
            out.push(F("error", "between-tools-field", "between_tools with " + k + " returns 400", "between_tools takes no other field: display, budget_tokens or block_binding sent with it return a 400 error.", "Remove thinking." + k + ".", T.src));
            delete fixed.thinking[k]; changes.push("thinking." + k + ": removed");
          }
        });
      } else {
        out.push(F("warn", "between-tools-other", "between_tools is documented for Sonnet 5.5 only", "The " + T.name + " migration guide does not list between_tools.", "Omit thinking (adaptive is the default) and use effort to control depth.", T.src));
        delete fixed.thinking; changes.push("thinking: between_tools removed");
      }
    } else if (th === undefined) {
      out.push(F("info", "thinking-default", "Thinking now runs by default", "With no thinking field, " + T.name + " runs adaptive thinking. On Sonnet 4.6 and earlier and on Haiku 4.5 the same request ran without thinking. Responses can now start with a thinking block, and thinking tokens count toward max_tokens.", "Read content blocks by type (not content[0].text), pass thinking blocks back unchanged in tool loops, and revisit max_tokens." + (tk === "sonnet" ? " To skip up-front thinking, send {type: \"between_tools\"}." : ""), T.src));
    }

    // --- sampling parameters
    var samp = [];
    if ("temperature" in body) samp.push("temperature");
    if ("top_p" in body) samp.push("top_p");
    if ("top_k" in body) samp.push("top_k");
    samp.forEach(function (k) {
      var v = body[k];
      var bad;
      if (tk === "haiku") {
        bad = k === "top_k" || (k === "temperature" && v !== 1) || (k === "top_p" && v !== 0.99) || (k !== "top_k" && "temperature" in body && "top_p" in body);
      } else {
        bad = !(k === "temperature" && v === 1);
      }
      if (bad) {
        var why = tk === "haiku"
          ? (k === "top_k" ? "Any top_k value returns 400." : ("temperature" in body && "top_p" in body ? "Sending both temperature and top_p returns 400." : k === "temperature" ? "temperature must be 1 if present." : "top_p must be 0.99 (its default) if present; even 1 returns 400."))
          : "Non-default " + k + " values return 400 on " + T.name + ".";
        out.push(F("error", "sampling-" + k, k + " = " + JSON.stringify(v) + " returns 400", why, "Remove " + k + ". Steer output with the prompt and effort instead.", T.src));
      } else {
        out.push(F("info", "sampling-" + k, k + " = " + JSON.stringify(v) + " is the default", "This value is accepted, but it does nothing.", "You can remove it.", T.src));
      }
      delete fixed[k]; changes.push(k + ": removed");
    });

    // --- tool_choice
    var tc = body.tool_choice;
    var tools = Array.isArray(body.tools) ? body.tools : [];
    if (isObj(tc) && (tc.type === "any" || tc.type === "tool")) {
      if (tk === "haiku") {
        out.push(F("info", "tool-choice-haiku", "Forced tool_choice still works on Haiku 5.5", "Haiku 5.5 accepts tool_choice " + tc.type + ". The response starts with the tool call and has no thinking block.", "No change needed. To allow thinking before the call, use auto and say in the prompt when to use the tool.", T.src));
      } else {
        out.push(F("error", "tool-choice-forced", "tool_choice: " + tc.type + " returns 400", T.name + " rejects forced tool use, including on the token counting endpoint. Error: tool_choice: type \"tool\" and \"any\" are not supported for this model.", "Send tool_choice: {type: \"auto\"}" + (bedrock ? ". On Bedrock strict tools are not available for this model, so validate tool input in your code." : " and mark the tool strict: true.") + " Say in the prompt when to call the tool, and handle a reply with no tool_use block.", T.src));
        fixed.tool_choice = { type: "auto" };
        changes.push("tool_choice: " + tc.type + " → auto");
        if (!bedrock && Array.isArray(fixed.tools)) {
          var marked = 0;
          fixed.tools.forEach(function (t) {
            if (!isObj(t) || (t.type && t.type !== "custom") || !t.input_schema) return;
            if (tc.type === "tool" && t.name !== tc.name) return;
            if (marked >= 20) return;
            if (t.strict !== true) { t.strict = true; marked++; }
          });
          if (marked) changes.push("tools: strict: true on " + marked + (tc.type === "tool" ? " (\"" + tc.name + "\")" : " tool(s)") + " — strict needs additionalProperties: false on every object");
        }
        if (tc.type === "tool" && typeof tc.name === "string") changes.push("prompt: add \"Use the " + tc.name + " tool.\" to the user message (manual)");
      }
    }
    var strictCount = tools.filter(function (t) { return isObj(t) && t.strict === true; }).length;
    if (strictCount > 20) out.push(F("error", "strict-limit", strictCount + " strict tools in one request", "A request can have at most 20 strict tools.", "Mark only the tools that need schema-valid input.", SRC.sonnet));
    if (bedrock && strictCount) out.push(F("warn", "strict-bedrock", "Strict tools are not available on Bedrock for " + T.name, "Structured outputs, which include strict tool use, are not available for this model on Amazon Bedrock.", "Drop strict, describe the format in the prompt, and validate tool input in code.", T.src));

    // --- assistant prefill
    var lm = lastMessage(body);
    if (lm && lm.role === "assistant") {
      var pre = textOf(lm.content).trim();
      var jsonish = /^[\[{]/.test(pre);
      out.push(F("error", "prefill", "Assistant prefill returns 400", "The last message is an assistant turn" + (pre ? " (\"" + pre.slice(0, 40) + (pre.length > 40 ? "…" : "") + "\")" : "") + ". " + T.name + " rejects it" + (tk === "haiku" ? ", even with thinking turned off" : "") + ". Sonnet 4.5, Haiku 4.5 and older models accepted it.", jsonish ? "This looks like a JSON prefill: use structured outputs (output_config.format) or a tool with enum fields" + (bedrock ? " — on Bedrock, describe the format in the prompt and validate in code." : ".") : "End messages with a user turn. Move continuations or reminders into the user message; ask for a direct answer in the system prompt instead of prefilling a preamble.", T.src));
      fixed.messages = fixed.messages.slice(0, -1);
      changes.push("messages: removed the trailing assistant prefill");
    }

    // --- output_format (deprecated)
    if ("output_format" in body) {
      var hasBeta = betas.indexOf("structured-outputs-2025-11-13") >= 0;
      out.push(F(hasBeta ? "warn" : "error", "output-format", "output_format is deprecated" + (hasBeta ? "" : " and returns 400 without its beta header"), "output_format will be removed. Without the structured-outputs-2025-11-13 beta header the API returns 400.", "Move it to output_config.format.", T.src));
      fixed.output_config = Object.assign({}, fixed.output_config || {}, { format: body.output_format });
      delete fixed.output_format;
      changes.push("output_format → output_config.format");
    }

    // --- computer use
    var hasToolset = false;
    tools.forEach(function (t, i) {
      if (!isObj(t) || typeof t.type !== "string") return;
      if (/^computer_toolset_/.test(t.type)) { hasToolset = true; return; }
      if (t.type === "computer_20250124" || t.type === "computer_20251124") {
        var old = t.type === "computer_20250124";
        var level, why, fix;
        if (!bedrock) {
          level = (old || tk !== "haiku") ? "error" : "warn";
          why = old ? T.name + " does not accept computer_20250124." : (tk === "haiku" ? "The Haiku 5.5 guide says to use the computer_toolset_20260801 toolset on the Claude API and Google Cloud." : "On the Claude API and Google Cloud, " + T.name + " supports computer use only through computer_toolset_20260801. Error: '" + T.id + "' does not support tool types: computer_20251124.");
          fix = "Replace the tool with {type: \"computer_toolset_20260801\"} (no name or display size) and drop the computer-use beta header.";
          fixed.tools[i] = { type: "computer_toolset_20260801" }; hasToolset = true;
          changes.push("tools[" + i + "]: " + t.type + " → computer_toolset_20260801");
        } else if (old) {
          level = tk === "opus" ? "warn" : "error";
          why = tk === "opus" ? "The Opus 5.5 guide documents computer_20251124 on Bedrock; it does not confirm computer_20250124 there." : T.name + " does not accept computer_20250124 on any platform.";
          fix = "On Bedrock use computer_20251124 with the computer-use-2025-11-24 beta header.";
          fixed.tools[i].type = "computer_20251124";
          changes.push("tools[" + i + "]: computer_20250124 → computer_20251124");
        } else return;
        out.push(F(level, "computer-tool", t.type + " in tools", why, fix, T.src));
      }
    });

    // --- beta headers
    betas.forEach(function (b) {
      if (b === "fine-grained-tool-streaming-2025-05-14") {
        out.push(F(hasToolset ? "error" : "warn", "beta-fgts", "Beta header " + b, hasToolset ? "Alongside a computer or browser toolset entry this header returns 400." : "Not needed on 5.5 models.", "Remove it and set eager_input_streaming: true on each tool that needs streaming input.", T.src));
      } else if (b === "interleaved-thinking-2025-05-14") {
        out.push(F("warn", "beta-interleaved", "Beta header " + b, "Adaptive thinking interleaves automatically.", "Remove it.", T.src));
      } else if (/^(token-efficient-tools-2025-02-19|output-128k-2025-02-19|effort-2025-11-24)$/.test(b) || /^context-1m-/.test(b)) {
        out.push(F("info", "beta-legacy", "Beta header " + b, "Has no effect on 5.5 models.", "Remove it.", T.src));
      } else if (/^computer-use-/.test(b) && hasToolset) {
        out.push(F("warn", "beta-computer", "Beta header " + b, "The computer_toolset_20260801 toolset needs no beta header.", "Remove it.", T.src));
      }
    });
    if (Array.isArray(fixed.betas)) {
      fixed.betas = fixed.betas.filter(function (b) {
        return !/^(fine-grained-tool-streaming-2025-05-14|interleaved-thinking-2025-05-14|token-efficient-tools-2025-02-19|output-128k-2025-02-19|effort-2025-11-24)$/.test(b) && !/^context-1m-/.test(b) && !(hasToolset && /^computer-use-/.test(b));
      });
      if (fixed.betas.length !== body.betas.length) changes.push("betas: removed " + (body.betas.length - fixed.betas.length) + " obsolete header(s)");
      if (!fixed.betas.length) delete fixed.betas;
    }

    // --- effort
    if (!effort && (!fixed.output_config || !fixed.output_config.effort)) {
      out.push(F("info", "effort", "No effort level set", (tk === "haiku" ? "On Haiku 5.5, output_config.effort sets how much the model thinks; where Haiku 4.5 ran without thinking or with a small budget, the guide says to choose a lower effort level." : "Effort levels are recalibrated on 5.5 models (Sonnet 5.5 has low, medium, high, xhigh and max; the Claude API default is high). Sonnet 4.5 had no effort parameter."), "Set output_config.effort explicitly and re-run your evals at 2–3 levels.", T.src));
    }

    // Always-on reminders that cannot be detected from one request.
    out.push(F("info", "append-only", "Keep conversations append-only", "On accounts created on or after Aug 31, 2026, replaying a thinking block after editing system, tools or earlier messages returns 400.", "Change instructions or tools with mid-conversation system messages instead of rewriting history.", T.src));
    out.push(F("info", "tokens", "Re-baseline token counts and cost", "The 5.5 tokenizer produces about 30% more tokens for the same text than Sonnet 4.6, Sonnet 4.5 and Haiku 4.5, and images can cost more.", "Recount with the token counting endpoint and revisit max_tokens.", T.src));

    return { target: T, platform: PLATFORMS[platform], findings: sortFindings(out), fixed: fixed, changes: changes };
  }

  var ORDER = { error: 0, warn: 1, info: 2 };
  function sortFindings(list) {
    return list.map(function (f, i) { return [f, i]; }).sort(function (a, b) { return (ORDER[a[0].level] - ORDER[b[0].level]) || (a[1] - b[1]); }).map(function (x) { return x[0]; });
  }

  // ---------------------------------------------------------------------------
  // Source-code scanner (heuristic, line based).
  var CODE_EXT = /\.(py|ipynb|js|mjs|cjs|jsx|ts|tsx|mts|cts|go|rb|java|kt|kts|scala|cs|php|rs|swift|dart|ex|exs|clj|lua|r|jl|sh|json|jsonc|ya?ml|toml|ini|cfg|env|example)$/i;
  var TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs|testdata|fixtures|cassettes)(\/|$)|(_test|\.test|\.spec|_spec)\.[a-z]+$|(^|\/)test_[^\/]+$/i;
  var SKIP_PATH = /(^|\/)(node_modules|vendor|dist|build|out|\.next|\.git|coverage|site-packages|__pycache__|target)(\/|$)|\.min\.js$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|uv\.lock|Cargo\.lock|go\.sum|composer\.lock)$/i;

  function wantFile(path, includeTests) { return CODE_EXT.test(path) && !SKIP_PATH.test(path) && (includeTests || !TEST_PATH.test(path)); }
  function relevant(text) { return /anthropic|claude/i.test(text); }

  function codeRules(tk) {
    var T = TARGETS[tk];
    var forcedBreaks = tk !== "haiku";
    return [
      { id: "budget", level: "error", re: /\bbudget_?tokens\b|\bbudgetTokens\b/i, title: "Manual thinking budget (budget_tokens)", fix: "Use thinking {type: \"adaptive\"} or omit it, and set output_config.effort.", why: "Returns 400 on " + T.name + "." },
      { id: "disabled", level: tk === "haiku" ? "warn" : "error", re: /["']?type["']?\s*[:=]\s*["']disabled["']|ThinkingConfigDisabled|\bdisabled\s*\(\s*\)/, ctx: /thinking/i, title: "thinking: disabled", fix: tk === "sonnet" ? "Send thinking {type: \"between_tools\"} at high effort or below." : "Remove the thinking setting; use effort to control depth.", why: tk === "haiku" ? "Not a documented setting on Haiku 5.5." : "Returns 400 on " + T.name + "." },
      { id: "sampling", level: "warn", re: /\b(temperature|top_p|top_k|topP|topK)\b["']?\s*[:=]\s*(?!\s*(?:None|null|undefined)\b)([^,\n)}]*)/, skip: function (m, line) { return (m[1] === "temperature" && /^\s*1(?:\.0+)?\s*$/.test(m[2])) || /^\s*(?:number|float|int|double|Optional|Union|str\b|NotGiven|NOT_GIVEN|Omit|omit|undefined|Float|Double|Integer|\*?float64|\*?int64)/.test(m[2]) || /\?\s*:/.test(line.slice(0, line.indexOf(m[1]) + m[1].length + 2)); }, title: "Sampling parameter", fix: "Remove it" + (tk === "haiku" ? " (temperature must be 1, top_p 0.99, no top_k)." : " unless it is the default."), why: "Non-default values return 400 on " + T.name + ". Ignore if this call goes to another provider." },
      forcedBreaks ? { id: "forced", level: "error", re: /["']?type["']?\s*[:=]\s*["'](any|tool)["']|ToolChoiceAny|ToolChoiceTool|tool_choice\s*[:=]\s*["'](any|required)["']/, ctx: /tool_?choice|toolChoice/i, title: "Forced tool_choice (any / tool)", fix: "Use tool_choice auto + strict: true on the tool (Bedrock: auto only) and say in the prompt when to use it. Handle replies with no tool_use.", why: "Returns 400 on " + T.name + ", including token counting." } : null,
      { id: "prefill", level: "warn", re: /["']?role["']?\s*[:=]\s*["']assistant["']\s*,\s*["']?content["']?\s*[:=]\s*["']([^"'\n]{0,40})["']/, skip: function (m) { return !/^\s*$|^\s*[\[{<(`]|:\s*$/.test(m[1]); }, title: "Possible assistant prefill", fix: "If this is the last message, remove it: use structured outputs for JSON, or move the text into the user turn.", why: "A trailing assistant turn returns 400 on " + T.name + ". Earlier assistant turns in history are fine." },
      { id: "computer", level: "error", re: /computer_2025(0124|1124)/, title: "Legacy computer-use tool version", fix: "Claude API / Google Cloud: use {type: \"computer_toolset_20260801\"}. Bedrock: computer_20251124.", why: "computer_20250124 is rejected everywhere; computer_20251124 is rejected on the Claude API and Google Cloud." },
      { id: "outfmt", level: "warn", re: /\boutput_format\b\s*[=:]|\boutputFormat\b\s*:/, skip: function (m, line, win) {
        var calls = win.match(/\.(parse|stream|create)\s*\(/g);
        if (calls && /parse|stream/.test(calls[calls.length - 1])) return true;
        var after = line.slice(line.search(/\boutput_?[fF]ormat\b/));
        if (/^output_?[fF]ormat\s*[=:]\s*(?:[A-Z][A-Za-z0-9_.]*\s*[,)]?\s*$|f?["'`])/.test(after)) return true;
        var before = line.charAt(line.search(/\boutput_?[fF]ormat\b/) - 1);
        return before === "&" || before === "?";
      }, title: "output_format (deprecated)", fix: "Move to output_config.format (the parse()/stream() helper argument is unchanged).", why: "Returns 400 without the structured-outputs-2025-11-13 beta header." },
      { id: "beta", level: "warn", re: /(fine-grained-tool-streaming-2025-05-14|interleaved-thinking-2025-05-14|token-efficient-tools-2025-02-19|output-128k-2025-02-19|effort-2025-11-24|context-1m-[0-9-]+)/, title: "Obsolete beta header", fix: "Remove it (fine-grained streaming → eager_input_streaming: true per tool).", why: "Not needed on 5.5 models; fine-grained-tool-streaming returns 400 next to a toolset entry." },
      { id: "content0", level: "warn", re: /\.content\s*\[\s*0\s*\]\s*(?:\.text|\[\s*["']text["']\s*\])|\.content\s*\[\s*0\s*\]\s*\.\s*(?:Text|GetText)|\bcontent\.first\.text\b/, title: "Reads content[0].text", fix: "Loop over content blocks and pick type == \"text\".", why: "Thinking runs by default on " + T.name + ", so the first block can be a thinking block." }
    ].filter(Boolean);
  }

  function scanText(text, path, opts) {
    opts = opts || {};
    var tk = TARGETS[opts.target] ? opts.target : "sonnet";
    if (typeof text !== "string") return [];
    if (text.length > 2000000) text = text.slice(0, 2000000);
    if (!relevant(text)) return [];
    if (/\.ipynb$/i.test(path || "")) {
      var nb = null;
      try { nb = JSON.parse(text); } catch (e) { nb = null; }
      if (nb && Array.isArray(nb.cells)) {
        var res = [];
        nb.cells.forEach(function (cell, ci) {
          if (!cell || cell.cell_type !== "code") return;
          var src = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source || "");
          // Notebook cells rarely repeat the import, so scan each cell as Claude-relevant.
          res = res.concat(scanText("# claude\n" + src, path + " (cell " + (ci + 1) + ")", opts).map(function (f) { f.line -= 1; return f; }));
        });
        return res;
      }
    }
    var lines = text.split(/\r?\n/);
    var rules = codeRules(tk);
    var out = [];
    var seen = {};
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.length > 4000) continue;
      if (/^\s*(?:#|\/\/|\/?\*|--|<!--)/.test(line)) continue;
      // model IDs
      var mi = modelInfo(line);
      if (mi) {
        var mm = line.match(/(?:anthropic\.)?claude-[a-z0-9.@:-]+/i);
        out.push({ level: "warn", id: "model", path: path, line: i + 1, code: line.trim().slice(0, 200), title: (mm ? mm[0] : mi.name) + " — " + (mi.state === "retired" ? "retired (fails if sent)" : "retiring"), why: mi.note, fix: "Switch to " + TARGETS[tk].id + " and apply the fixes below." });
      }
      for (var r = 0; r < rules.length; r++) {
        var R = rules[r];
        var m = line.match(R.re);
        if (!m) continue;
        if (R.skip && R.skip(m, line, lines.slice(Math.max(0, i - 6), i + 1).join("\n"))) continue;
        if (R.ctx) {
          var win = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
          if (!R.ctx.test(win)) continue;
        }
        var key = R.id + ":" + i;
        if (seen[key]) continue;
        seen[key] = 1;
        out.push({ level: R.level, id: R.id, path: path, line: i + 1, code: line.trim().slice(0, 200), title: R.title, why: R.why, fix: R.fix });
      }
    }
    return out;
  }

  // Collapse repeats of the same rule in the same file into one finding with all line numbers.
  function groupFindings(list) {
    var map = {}, out = [];
    list.forEach(function (f) {
      var k = (f.path || "") + "|" + f.id + "|" + (f.id === "model" ? f.title : "");
      if (!map[k]) { map[k] = Object.assign({}, f, { lines: [] }); out.push(map[k]); }
      if (f.line) map[k].lines.push(f.line);
    });
    out.forEach(function (g) { g.count = Math.max(1, g.lines.length); });
    return sortFindings(out);
  }

  function summarize(findings) {
    var s = { error: 0, warn: 0, info: 0 };
    findings.forEach(function (f) { s[f.level] = (s[f.level] || 0) + 1; });
    return s;
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

  function locLines(f) {
    var ls = f.lines && f.lines.length ? f.lines : (f.line ? [f.line] : []);
    if (!ls.length) return "";
    return ":" + ls.slice(0, 12).join(", ") + (ls.length > 12 ? " (+" + (ls.length - 12) + " more)" : "");
  }

  function markdownReport(kind, title, findings, extra) {
    var md = ["# " + title, "", "Checked with Claude 5.5 Request Check (rules as of " + DATA_AS_OF + ", from Anthropic's migration guides).", ""];
    var s = summarize(findings);
    md.push("**" + s.error + " will return 400 · " + s.warn + " to review · " + s.info + " notes**", "");
    findings.forEach(function (f) {
      var box = f.level === "info" ? "- [ ] (note) " : f.level === "warn" ? "- [ ] (review) " : "- [ ] (400) ";
      var loc = f.path ? " — `" + f.path + locLines(f) + "`" : "";
      md.push(box + f.title + loc);
      if (f.why || f.detail) md.push("  - Why: " + (f.why || f.detail));
      if (f.fix) md.push("  - Fix: " + f.fix);
    });
    if (extra) md.push("", extra);
    return md.join("\n");
  }

  var SAMPLE_REQUEST = {
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    temperature: 0.2,
    thinking: { type: "enabled", budget_tokens: 4000 },
    tools: [{ name: "extract_invoice", description: "Extract invoice fields", input_schema: { type: "object", properties: { total: { type: "number" }, currency: { type: "string" } }, required: ["total", "currency"], additionalProperties: false } }],
    tool_choice: { type: "tool", name: "extract_invoice" },
    messages: [
      { role: "user", content: "Extract the fields from this invoice: ..." },
      { role: "assistant", content: "{" }
    ]
  };

  var SAMPLE_CODE = [
    "import anthropic",
    "client = anthropic.Anthropic()",
    "",
    "resp = client.messages.create(",
    "    model=\"claude-sonnet-4-5-20250929\",",
    "    max_tokens=1024,",
    "    temperature=0.3,",
    "    thinking={\"type\": \"disabled\"},",
    "    tools=[EXTRACT_TOOL],",
    "    tool_choice={\"type\": \"tool\", \"name\": \"extract\"},",
    "    messages=[",
    "        {\"role\": \"user\", \"content\": doc},",
    "        {\"role\": \"assistant\", \"content\": \"{\"},",
    "    ],",
    "    extra_headers={\"anthropic-beta\": \"interleaved-thinking-2025-05-14\"},",
    ")",
    "print(resp.content[0].text)"
  ].join("\n");

  return {
    DATA_AS_OF: DATA_AS_OF, SRC: SRC, TARGETS: TARGETS, PLATFORMS: PLATFORMS, MODELS: MODELS,
    checkRequest: checkRequest, scanText: scanText, groupFindings: groupFindings, locLines: locLines, summarize: summarize, parseRepo: parseRepo,
    wantFile: wantFile, relevant: relevant, modelInfo: modelInfo, markdownReport: markdownReport,
    SAMPLE_REQUEST: SAMPLE_REQUEST, SAMPLE_CODE: SAMPLE_CODE
  };
});
