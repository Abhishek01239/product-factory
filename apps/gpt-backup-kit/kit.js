/*
 * GPT Backup Kit — pure logic (no DOM). Works in the browser (window.Kit) and in Node (require).
 * Everything here runs locally; nothing is sent anywhere.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Kit = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var VERSION = "1.0.0";
  // Source: OpenAI Help Center, "Custom GPT retirement and migration FAQ" (checked 9 Oct 2026).
  var DATES = {
    retirement: "2026-12-11",
    deferral: "2027-02-11",
    enterpriseCreationEnds: "2026-10-26"
  };
  var CAPABILITIES = [
    ["web", "Web search"],
    ["canvas", "Canvas"],
    ["image", "Image generation"],
    ["code", "Code interpreter & data analysis"]
  ];
  var SHARING = {
    private: "Only me",
    link: "Anyone with the link",
    workspace: "My workspace",
    store: "GPT Store (public)"
  };

  function str(v) { return v == null ? "" : String(v); }
  function trim(v) { return str(v).replace(/^\s+|\s+$/g, ""); }

  function normalize(input) {
    var g = input || {};
    var out = {
      name: trim(g.name),
      description: trim(g.description),
      instructions: str(g.instructions).replace(/\r\n?/g, "\n").replace(/\s+$/, ""),
      starters: (Array.isArray(g.starters) ? g.starters : []).map(trim).filter(Boolean),
      capabilities: {},
      model: trim(g.model),
      knowledge: (Array.isArray(g.knowledge) ? g.knowledge : []).map(function (k) {
        if (typeof k === "string") return { name: trim(k), size: null };
        return { name: trim(k && k.name), size: k && typeof k.size === "number" ? k.size : null };
      }).filter(function (k) { return k.name; }),
      apps: trim(g.apps),
      actions: (Array.isArray(g.actions) ? g.actions : []).map(function (a) {
        a = a || {};
        return { name: trim(a.name), schema: str(a.schema), auth: ["none", "apikey", "oauth"].indexOf(a.auth) >= 0 ? a.auth : "none", privacy: trim(a.privacy) };
      }).filter(function (a) { return a.name || trim(a.schema); }),
      sharing: SHARING[g.sharing] ? g.sharing : "private",
      shareLink: trim(g.shareLink),
      users: trim(g.users),
      published: g.published === "draft" ? "draft" : g.published === "unsure" ? "unsure" : "published",
      plan: g.plan === "enterprise" ? "enterprise" : "personal",
      tests: (Array.isArray(g.tests) ? g.tests : []).map(function (t) {
        t = t || {};
        return { prompt: trim(t.prompt), expect: trim(t.expect) };
      }).filter(function (t) { return t.prompt; })
    };
    var caps = g.capabilities || {};
    CAPABILITIES.forEach(function (c) { out.capabilities[c[0]] = !!caps[c[0]]; });
    return out;
  }

  /* ---------- dates ---------- */
  function daysUntil(iso, now) {
    var p = iso.split("-").map(Number);
    var target = Date.UTC(p[0], p[1] - 1, p[2]);
    var n = now instanceof Date ? now : new Date();
    var today = Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
    return Math.round((target - today) / 86400000);
  }
  function fmtDate(iso) {
    var m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var p = iso.split("-").map(Number);
    return m[p[1] - 1] + " " + p[2] + ", " + p[0];
  }

  /* ---------- naming ---------- */
  function slugify(name) {
    var s = str(name).toLowerCase();
    if (s.normalize) s = s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
    s = s.replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    if (s.length > 64) s = s.slice(0, 64).replace(/-+$/, "");
    return s || "my-gpt";
  }
  var PY_KEYWORDS = ("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case type").split(" ");
  function pyIdent(s, fallback) {
    var id = str(s).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
    if (!id) id = fallback || "value";
    if (/^[0-9]/.test(id)) id = "_" + id;
    if (PY_KEYWORDS.indexOf(id) >= 0) id = id + "_";
    return id;
  }

  /* ---------- secrets ---------- */
  var SECRET_PATTERNS = [
    [/sk-(?:proj-|live-|test-)?[A-Za-z0-9_\-]{20,}/g, "OpenAI/Stripe-style secret key"],
    [/gh[pousr]_[A-Za-z0-9]{30,}/g, "GitHub token"],
    [/AKIA[0-9A-Z]{16}/g, "AWS access key ID"],
    [/AIza[0-9A-Za-z_\-]{35}/g, "Google API key"],
    [/xox[abpors]-[A-Za-z0-9\-]{10,}/g, "Slack token"],
    [/Bearer\s+[A-Za-z0-9\-._~+\/]{20,}=*/g, "Bearer token"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "Private key"]
  ];
  function findSecrets(text) {
    var found = [];
    var t = str(text);
    SECRET_PATTERNS.forEach(function (p) {
      var m = t.match(p[0]);
      if (m) m.forEach(function (hit) { found.push({ kind: p[1], preview: hit.slice(0, 6) + "…" }); });
    });
    return found;
  }

  /* ---------- OpenAPI ---------- */
  function parseSpec(text, yaml) {
    var t = trim(text);
    if (!t) return { ok: false, error: "Paste the action's OpenAPI schema (JSON or YAML)." };
    var spec = null, format = "json";
    if (t.charAt(0) === "{") {
      try { spec = JSON.parse(t); } catch (e) { return { ok: false, error: "Invalid JSON: " + e.message }; }
    } else {
      format = "yaml";
      if (!yaml || typeof yaml.load !== "function") return { ok: false, error: "YAML parser unavailable; paste JSON instead." };
      try { spec = yaml.load(t, { json: true }); } catch (e2) { return { ok: false, error: "Invalid YAML: " + String(e2.message || e2).split("\n")[0] }; }
    }
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) return { ok: false, error: "Schema must be an object." };
    if (!spec.openapi && !spec.swagger) return { ok: false, error: "Missing 'openapi' (or 'swagger') version field — this doesn't look like an OpenAPI schema." };
    if (!spec.paths || typeof spec.paths !== "object") return { ok: false, error: "Schema has no 'paths'." };
    return { ok: true, spec: spec, format: format };
  }

  function resolveRef(spec, obj, depth) {
    depth = depth || 0;
    if (!obj || typeof obj !== "object" || !obj.$ref || depth > 10) return obj;
    var ref = String(obj.$ref);
    if (ref.indexOf("#/") !== 0) return obj;
    var cur = spec;
    ref.slice(2).split("/").forEach(function (seg) {
      seg = seg.replace(/~1/g, "/").replace(/~0/g, "~");
      cur = cur && typeof cur === "object" ? cur[seg] : undefined;
    });
    return cur ? resolveRef(spec, cur, depth + 1) : obj;
  }

  function pyType(schema) {
    var t = schema && schema.type;
    if (Array.isArray(t)) t = t.filter(function (x) { return x !== "null"; })[0];
    return { string: "str", integer: "int", number: "float", boolean: "bool", array: "list", object: "dict" }[t] || "str";
  }

  var METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
  function listOperations(spec) {
    var ops = [];
    Object.keys(spec.paths || {}).forEach(function (path) {
      var item = resolveRef(spec, spec.paths[path]) || {};
      var shared = Array.isArray(item.parameters) ? item.parameters : [];
      METHODS.forEach(function (method) {
        var op = item[method];
        if (!op || typeof op !== "object") return;
        var params = [];
        var seen = {};
        shared.concat(Array.isArray(op.parameters) ? op.parameters : []).forEach(function (p) {
          p = resolveRef(spec, p);
          if (!p || !p.name || ["path", "query", "header"].indexOf(p.in) < 0) return;
          var key = p.in + ":" + p.name;
          var schema = resolveRef(spec, p.schema || { type: p.type });
          var entry = { name: String(p.name), in: p.in, required: p.in === "path" ? true : !!p.required, type: pyType(schema), description: str(p.description) };
          if (seen[key] != null) params[seen[key]] = entry; else { seen[key] = params.length; params.push(entry); }
        });
        var hasBody = false, bodyRequired = false;
        if (op.requestBody) {
          var rb = resolveRef(spec, op.requestBody);
          hasBody = true; bodyRequired = !!(rb && rb.required);
        } else if (Array.isArray(op.parameters)) {
          op.parameters.forEach(function (p) { p = resolveRef(spec, p); if (p && p.in === "body") { hasBody = true; bodyRequired = !!p.required; } });
        }
        ops.push({
          operationId: str(op.operationId) || (method + "_" + path),
          method: method.toUpperCase(),
          path: path,
          summary: str(op.summary || op.description).split("\n")[0].slice(0, 200),
          description: str(op.description || op.summary),
          params: params,
          hasBody: hasBody,
          bodyRequired: bodyRequired,
          consequential: op["x-openai-isConsequential"] === true
        });
      });
    });
    return ops;
  }

  function baseUrl(spec) {
    if (Array.isArray(spec.servers) && spec.servers[0] && spec.servers[0].url) return String(spec.servers[0].url).replace(/\/+$/, "");
    if (spec.host) return ((spec.schemes && spec.schemes[0]) || "https") + "://" + spec.host + str(spec.basePath).replace(/\/+$/, "");
    return "";
  }

  function securitySchemes(spec) {
    var s = (spec.components && spec.components.securitySchemes) || spec.securityDefinitions || {};
    return Object.keys(s).map(function (k) {
      var v = resolveRef(spec, s[k]) || {};
      return { id: k, type: str(v.type), scheme: str(v.scheme).toLowerCase(), in: str(v.in), name: str(v.name) };
    });
  }

  function summarizeSpec(spec) {
    var ops = listOperations(spec);
    return {
      title: str(spec.info && spec.info.title) || "Untitled API",
      version: str(spec.openapi || spec.swagger),
      baseUrl: baseUrl(spec),
      operations: ops,
      security: securitySchemes(spec)
    };
  }

  function pyStr(s) { return JSON.stringify(str(s)); }
  function pyDoc(s) { return str(s).replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"').replace(/\s+$/, ""); }

  function mcpServerPy(actionName, spec) {
    var sum = summarizeSpec(spec);
    var sec = sum.security[0] || null;
    var L = [];
    L.push("# MCP server stub generated by GPT Backup Kit v" + VERSION + " from the OpenAPI schema of the");
    L.push("# custom GPT action " + JSON.stringify(actionName || sum.title) + ". It is a STARTING POINT: review every tool,");
    L.push("# add validation and error handling, and test it before connecting it to any assistant.");
    L.push("#");
    L.push("# Install:  pip install \"mcp[cli]\" httpx");
    L.push("# Run locally (stdio):           python server.py");
    L.push("# Run over HTTP (for remote use): mcp run server.py --transport streamable-http");
    L.push("# Secrets come from environment variables. Never hard-code keys in this file.");
    L.push("");
    L.push("import os");
    L.push("from typing import Any, Optional");
    L.push("from urllib.parse import quote");
    L.push("");
    L.push("import httpx");
    L.push("");
    L.push("try:  # MCP Python SDK v2");
    L.push("    from mcp.server import MCPServer as _Server");
    L.push("except ImportError:  # MCP Python SDK v1.x");
    L.push("    from mcp.server.fastmcp import FastMCP as _Server");
    L.push("");
    L.push("BASE_URL = os.environ.get(\"API_BASE_URL\", " + pyStr(sum.baseUrl || "https://api.example.com") + ")" + (sum.baseUrl ? "" : "  # TODO: schema had no server URL"));
    L.push("API_KEY = os.environ.get(\"API_KEY\", \"\")");
    L.push("TIMEOUT = float(os.environ.get(\"API_TIMEOUT\", \"30\"))");
    L.push("");
    L.push("mcp = _Server(" + pyStr(actionName || sum.title) + ")");
    L.push("");
    L.push("");
    L.push("def _auth_headers() -> dict:");
    L.push("    headers: dict = {}");
    L.push("    if not API_KEY:");
    L.push("        return headers");
    if (sec && sec.type === "apiKey" && sec.in === "header" && sec.name) {
      L.push("    headers[" + pyStr(sec.name) + "] = API_KEY  # from securityScheme " + JSON.stringify(sec.id));
    } else if (sec && sec.type === "http" && sec.scheme === "basic") {
      L.push("    import base64");
      L.push("    headers[\"Authorization\"] = \"Basic \" + base64.b64encode(API_KEY.encode()).decode()  # API_KEY as user:password");
    } else if (sec && sec.type === "oauth2") {
      L.push("    # TODO: the original action used OAuth. Implement the token flow your API requires;");
      L.push("    # as a placeholder this sends API_KEY as a bearer access token.");
      L.push("    headers[\"Authorization\"] = \"Bearer \" + API_KEY");
    } else {
      L.push("    headers[\"Authorization\"] = \"Bearer \" + API_KEY");
    }
    L.push("    return headers");
    L.push("");
    L.push("");
    L.push("def _query_auth() -> dict:");
    if (sec && sec.type === "apiKey" && sec.in === "query" && sec.name) {
      L.push("    return {" + pyStr(sec.name) + ": API_KEY} if API_KEY else {}");
    } else {
      L.push("    return {}");
    }
    L.push("");
    L.push("");
    L.push("def _call(method: str, path: str, query: dict, headers: dict, body: Any = None) -> Any:");
    L.push("    q = {k: v for k, v in {**_query_auth(), **query}.items() if v is not None}");
    L.push("    h = {k: str(v) for k, v in {**_auth_headers(), **headers}.items() if v is not None}");
    L.push("    with httpx.Client(timeout=TIMEOUT) as client:");
    L.push("        r = client.request(method, BASE_URL + path, params=q, headers=h, json=body)");
    L.push("    if r.status_code >= 400:");
    L.push("        return {\"error\": f\"HTTP {r.status_code}\", \"body\": r.text[:2000]}");
    L.push("    try:");
    L.push("        return r.json()");
    L.push("    except ValueError:");
    L.push("        return r.text");
    var used = {};
    sum.operations.forEach(function (op) {
      var fn = pyIdent(op.operationId, "operation");
      while (used[fn]) fn = fn + "_";
      used[fn] = true;
      var names = {};
      var args = op.params.map(function (p) {
        var id = pyIdent(p.name, "param");
        if (id === "body") id = "body_";
        while (names[id]) id = id + "_";
        names[id] = true;
        return { p: p, id: id };
      });
      var req = args.filter(function (a) { return a.p.required; });
      var opt = args.filter(function (a) { return !a.p.required; });
      var sig = req.map(function (a) { return a.id + ": " + a.p.type; });
      if (op.hasBody && op.bodyRequired) sig.push("body: dict");
      opt.forEach(function (a) { sig.push(a.id + ": Optional[" + a.p.type + "] = None"); });
      if (op.hasBody && !op.bodyRequired) sig.push("body: Optional[dict] = None");
      L.push("");
      L.push("");
      L.push("@mcp.tool()");
      L.push("def " + fn + "(" + sig.join(", ") + ") -> Any:");
      var doc = pyDoc(op.summary || (op.method + " " + op.path));
      var lines = ['    """' + doc];
      if (op.consequential) lines.push("", "    Marked consequential in the original action: ask the user before calling.");
      args.forEach(function (a) { if (a.p.description) lines.push("    " + a.id + ": " + pyDoc(a.p.description).replace(/\n/g, " ").slice(0, 200)); });
      if (op.hasBody) lines.push("    body: JSON request body, as defined in the original OpenAPI schema.");
      L.push(lines.length > 1 ? lines.join("\n") + '\n    """' : lines[0] + '"""');
      var pathExpr = pyStr(op.path);
      var pathArgs = args.filter(function (a) { return a.p.in === "path"; });
      if (pathArgs.length) {
        L.push("    path = " + pyStr(op.path));
        pathArgs.forEach(function (a) {
          L.push("    path = path.replace(" + pyStr("{" + a.p.name + "}") + ", quote(str(" + a.id + "), safe=\"\"))");
        });
        pathExpr = "path";
      }
      var q = args.filter(function (a) { return a.p.in === "query"; }).map(function (a) { return pyStr(a.p.name) + ": " + a.id; });
      var h = args.filter(function (a) { return a.p.in === "header"; }).map(function (a) { return pyStr(a.p.name) + ": " + a.id; });
      L.push("    return _call(" + pyStr(op.method) + ", " + pathExpr + ", {" + q.join(", ") + "}, {" + h.join(", ") + "}, " + (op.hasBody ? "body" : "None") + ")");
    });
    if (!sum.operations.length) {
      L.push("");
      L.push("# No operations were found in the schema's 'paths'.");
    }
    L.push("");
    L.push("");
    L.push("if __name__ == \"__main__\":");
    L.push("    mcp.run()");
    L.push("");
    return L.join("\n");
  }

  /* ---------- outputs ---------- */
  function capList(g) {
    return CAPABILITIES.filter(function (c) { return g.capabilities[c[0]]; }).map(function (c) { return c[1]; });
  }

  function skillMd(gIn) {
    var g = normalize(gIn);
    var slug = slugify(g.name);
    var desc = g.description || ("Instructions migrated from the custom GPT \"" + (g.name || "My GPT") + "\".");
    desc = desc.replace(/\s+/g, " ");
    if (desc.length > 1024) desc = desc.slice(0, 1021) + "...";
    var L = ["---", "name: " + slug, "description: " + JSON.stringify(desc)];
    L.push("metadata:");
    L.push("  source: " + JSON.stringify("custom GPT backup (GPT Backup Kit v" + VERSION + ")"));
    if (g.name) L.push("  original-name: " + JSON.stringify(g.name));
    L.push("---", "");
    L.push("# " + (g.name || "My GPT"), "");
    L.push(g.instructions || "_(No instructions entered.)_");
    if (g.starters.length) {
      L.push("", "## Example requests", "", "These were the GPT's conversation starters:", "");
      g.starters.forEach(function (s) { L.push("- " + s); });
    }
    if (g.knowledge.length) {
      L.push("", "## Reference files", "", "Use these files (in `references/`) when they are relevant:", "");
      g.knowledge.forEach(function (k) { L.push("- `references/" + k.name + "`"); });
    }
    L.push("");
    return L.join("\n");
  }

  function portablePrompt(gIn, target) {
    var g = normalize(gIn);
    var L = [];
    var label = { claude: "Claude Project instructions", gemini: "Gemini Gem instructions", generic: "System prompt" }[target] || "System prompt";
    if (target !== "generic") L.push("<!-- " + label + " for \"" + (g.name || "My GPT") + "\". Paste everything below into the instructions field. -->", "");
    if (g.description) L.push("Purpose: " + g.description, "");
    L.push(g.instructions || "(No instructions entered.)");
    if (g.starters.length) {
      L.push("", "Typical requests you will receive:");
      g.starters.forEach(function (s) { L.push("- " + s); });
    }
    if (g.knowledge.length) {
      L.push("", "Reference files available in this " + (target === "claude" ? "project" : target === "gemini" ? "Gem" : "workspace") + ": " + g.knowledge.map(function (k) { return k.name; }).join(", ") + ".");
    }
    if (g.actions.length) {
      L.push("", "Note: the original assistant could call these external tools, which are not connected here: " + g.actions.map(function (a) { return a.name || "unnamed action"; }).join(", ") + ". If a request needs them, say so instead of guessing.");
    }
    return L.join("\n") + "\n";
  }

  function migrationReport(gIn, now) {
    var g = normalize(gIn);
    var deadline = DATES.retirement;
    var items = [];
    function add(status, title, detail) { items.push({ status: status, title: title, detail: detail }); }

    add(g.instructions ? "carries" : "check", "Instructions → become a skill",
      g.instructions ? "OpenAI's migration turns them into a skill inside the plugin. Your backup also has them as SKILL.md and plain text." : "No instructions entered yet — paste them from the GPT's Configure tab so your backup is complete.");
    if (g.knowledge.length) add("carries", "Knowledge files → reference files (" + g.knowledge.length + ")", "Copied into the plugin's reference files; OpenAI says retrieval may differ, so test answers that depend on them. Add the files here to keep your own copy in the backup ZIP.");
    else add("check", "Knowledge files", "None listed. If your GPT has files under Knowledge, download them and add them here.");
    if (g.apps) add("carries", "Connected apps", "Added to the plugin as apps. Each user still needs their own app access and authorization.");
    if (g.actions.length) add("lost", "Custom actions (" + g.actions.length + ") — do NOT transfer", "Features that depend on " + g.actions.map(function (a) { return a.name || "unnamed action"; }).join(", ") + " stop working in the plugin until you rebuild them with an available app or a custom MCP server. This kit generates an MCP server stub per action from its OpenAPI schema.");
    if (g.starters.length) add("lost", "Conversation starters (" + g.starters.length + ")", "OpenAI's guide says they don't transfer one-to-one. They're saved in your backup and included as example requests in SKILL.md.");
    if (g.model) add("lost", "Selected model: " + g.model, "The selected model does not carry over (Enterprise defaults apply in Enterprise workspaces).");
    var caps = capList(g);
    if (caps.length) add("check", "Capabilities: " + caps.join(", "), "Capability settings don't guarantee the same tools or behavior in the plugin. Test anything that depends on them.");
    if (g.sharing !== "private" || g.users) add("lost", "Sharing: " + SHARING[g.sharing], "Sharing settings don't carry over and existing users don't get access automatically. The plugin starts private" + (g.sharing === "store" ? "; making it public needs a separate plugin submission" : "") + ". Tell people where to find the replacement" + (g.users ? " (" + g.users + ")" : "") + ".");
    if (g.published !== "published") add("lost", g.published === "draft" ? "Unpublished draft" : "Published status unclear", "Migration uses the latest published version; drafts and unpublished edits do not transfer. Publish (privately is fine) before migrating" + (g.plan === "enterprise" ? " — Enterprise creation of new GPTs is planned to end " + fmtDate(DATES.enterpriseCreationEnds) : "") + ".");
    add("check", "Conversation history", "OpenAI says existing conversations with custom GPTs stay accessible after retirement; they do not move into the plugin.");
    add(g.tests.length ? "carries" : "check", "Test prompts" + (g.tests.length ? " (" + g.tests.length + ")" : ""), g.tests.length ? "Saved with expected answers so you can compare the plugin (or a Claude/Gemini copy) against the original." : "Add 3–5 prompts you use often, plus one hard case, while the original GPT still runs.");
    var secrets = findSecrets(g.instructions + "\n" + g.actions.map(function (a) { return a.schema; }).join("\n"));
    if (secrets.length) add("lost", "Possible secret found (" + secrets.map(function (s) { return s.kind; }).join(", ") + ")", "Remove keys from instructions and schemas before saving or sharing a backup. Rotate any key that was ever pasted into a GPT.");

    var days = daysUntil(deadline, now);
    return {
      deadline: deadline,
      deadlineLabel: fmtDate(deadline),
      days: days,
      deferral: fmtDate(DATES.deferral),
      items: items,
      lostCount: items.filter(function (i) { return i.status === "lost"; }).length,
      secrets: secrets
    };
  }

  function reportMd(gIn, now) {
    var g = normalize(gIn);
    var r = migrationReport(g, now);
    var icon = { carries: "[carries over]", lost: "[ACTION NEEDED]", check: "[check]" };
    var L = ["# Migration checklist: " + (g.name || "My GPT"), ""];
    L.push("Custom GPTs retire on **" + r.deadlineLabel + "** (" + (r.days >= 0 ? r.days + " days from " + (now instanceof Date ? now.toISOString().slice(0, 10) : "today") : "date passed") + "). Enterprise workspaces with an approved deferral: " + r.deferral + ".", "");
    r.items.forEach(function (i) { L.push("- " + icon[i.status] + " **" + i.title + "** — " + i.detail); });
    L.push("", "## Steps", "",
      "1. Keep this backup somewhere you control.",
      "2. In ChatGPT open My GPTs → your GPT → **Migrate to plugin** (when available for your account).",
      "3. Run the saved test prompts against the plugin and compare with the expected answers.",
      "4. Rebuild custom actions (see `actions/`), then test them separately.",
      "5. Share the plugin with the people who used the GPT; confirm one of them can install it.",
      "", "Source: OpenAI Help Center — https://help.openai.com/en/articles/20001519-custom-gpt-retirement-and-migration-faq", "");
    return L.join("\n");
  }

  function readmeMd(gIn) {
    var g = normalize(gIn);
    var caps = capList(g);
    var L = ["# " + (g.name || "My GPT") + " — custom GPT backup", ""];
    if (g.description) L.push("> " + g.description, "");
    L.push("Created with GPT Backup Kit v" + VERSION + " — https://abhishek01239.github.io/product-factory/gpt-backup-kit/", "");
    L.push("| Field | Value |", "|---|---|");
    L.push("| Model | " + (g.model || "not recorded") + " |");
    L.push("| Capabilities | " + (caps.join(", ") || "none recorded") + " |");
    L.push("| Knowledge files | " + (g.knowledge.length ? g.knowledge.map(function (k) { return k.name; }).join(", ") : "none") + " |");
    L.push("| Connected apps | " + (g.apps || "none recorded") + " |");
    L.push("| Custom actions | " + (g.actions.length ? g.actions.map(function (a) { return a.name || "unnamed"; }).join(", ") : "none") + " |");
    L.push("| Sharing | " + SHARING[g.sharing] + (g.shareLink ? " (" + g.shareLink + ")" : "") + " |");
    L.push("", "## What's in this folder", "",
      "- `gpt.json` — the full configuration. Re-open it in GPT Backup Kit with **Import backup**.",
      "- `instructions.md` — the instructions exactly as entered.",
      "- `skill/" + slugify(g.name) + "/SKILL.md` — an Agent Skills-format skill (YAML frontmatter + Markdown), with `references/` for knowledge files.",
      "- `portable/` — ready-to-paste instructions for a Claude Project, a Gemini Gem, or any system prompt.",
      "- `actions/` — each action's OpenAPI schema and a Python MCP server stub to rebuild it.",
      "- `test-prompts.md` — prompts and expected answers for comparing replacements.",
      "- `MIGRATION.md` — what OpenAI's migration keeps and what you must redo.", "");
    if (g.starters.length) {
      L.push("## Conversation starters", "");
      g.starters.forEach(function (s) { L.push("- " + s); });
      L.push("");
    }
    return L.join("\n");
  }

  function testsMd(gIn) {
    var g = normalize(gIn);
    var L = ["# Test prompts: " + (g.name || "My GPT"), "", "Run each prompt against the original GPT and the replacement. Note differences.", ""];
    if (!g.tests.length) L.push("_No test prompts saved._", "");
    g.tests.forEach(function (t, i) {
      L.push("## " + (i + 1) + ". " + t.prompt.split("\n")[0].slice(0, 80), "", "**Prompt**", "", "```text", t.prompt, "```", "");
      L.push("**Expected (from the original GPT)**", "", t.expect ? t.expect : "_not recorded_", "", "**Replacement result:** ☐ same  ☐ acceptable  ☐ worse — notes:", "");
    });
    return L.join("\n");
  }

  function actionReadme(name, sum) {
    var L = ["# Action: " + (name || sum.title), ""];
    L.push("Custom GPT actions do not transfer to plugins. This folder has what you need to rebuild this one.", "");
    L.push("- API: " + sum.title + " (OpenAPI " + sum.version + ")");
    L.push("- Base URL: " + (sum.baseUrl || "not set in schema"));
    L.push("- Auth: " + (sum.security.length ? sum.security.map(function (s) { return s.id + " (" + s.type + (s.scheme ? " " + s.scheme : "") + (s.in ? " in " + s.in : "") + ")"; }).join(", ") : "none declared"));
    L.push("- Operations: " + sum.operations.length, "");
    sum.operations.forEach(function (o) { L.push("  - `" + o.method + " " + o.path + "` — " + (o.summary || o.operationId)); });
    L.push("", "## Rebuild as an MCP server", "",
      "```bash", "pip install \"mcp[cli]\" httpx", "export API_KEY=...        # never commit this", "python server.py           # stdio, for local MCP clients", "mcp run server.py --transport streamable-http   # HTTP", "```", "",
      "Remote assistants (such as a ChatGPT custom MCP connection, where your plan allows it) need the server reachable over HTTPS with authentication. `server.py` is a generated starting point: review it, restrict what it can do, and test before use.", "");
    return L.join("\n");
  }

  function buildBundle(gIn, opts) {
    opts = opts || {};
    var g = normalize(gIn);
    var slug = slugify(g.name);
    var root = slug + "-backup/";
    var files = [];
    function add(p, c) { files.push({ path: root + p, content: c }); }
    var json = JSON.parse(JSON.stringify(g));
    json.kit = { app: "gpt-backup-kit", version: VERSION, exported: (opts.now || new Date()).toISOString() };
    add("gpt.json", JSON.stringify(json, null, 2) + "\n");
    add("README.md", readmeMd(g));
    add("instructions.md", (g.instructions || "") + "\n");
    add("MIGRATION.md", reportMd(g, opts.now));
    add("test-prompts.md", testsMd(g));
    add("skill/" + slug + "/SKILL.md", skillMd(g));
    add("portable/claude-project.md", portablePrompt(g, "claude"));
    add("portable/gemini-gem.md", portablePrompt(g, "gemini"));
    add("portable/system-prompt.txt", portablePrompt(g, "generic"));
    (opts.files || []).forEach(function (f) {
      if (f && f.name && f.data) add("skill/" + slug + "/references/" + safeFileName(f.name), f.data);
    });
    var usedAction = {};
    g.actions.forEach(function (a, i) {
      var dir = slugify(a.name || "action-" + (i + 1));
      while (usedAction[dir]) dir += "-" + (i + 1);
      usedAction[dir] = true;
      var parsed = parseSpec(a.schema, opts.yaml);
      add("actions/" + dir + "/openapi." + (parsed.ok ? parsed.format : "txt"), a.schema.replace(/\s+$/, "") + "\n");
      if (parsed.ok) {
        var sum = summarizeSpec(parsed.spec);
        add("actions/" + dir + "/server.py", mcpServerPy(a.name, parsed.spec));
        add("actions/" + dir + "/README.md", actionReadme(a.name, sum));
      } else {
        add("actions/" + dir + "/README.md", "# Action: " + (a.name || dir) + "\n\nThe schema could not be parsed (" + parsed.error + "), so no MCP stub was generated. The raw text is saved next to this file.\n");
      }
    });
    return files;
  }

  function safeFileName(n) {
    var s = str(n).replace(/[\\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/^\.+/, "_").slice(0, 120);
    return s || "file";
  }

  /* ---------- ZIP (stored, no compression) ---------- */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function utf8(s) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s);
    return Uint8Array.from(Buffer.from(s, "utf8"));
  }
  function zip(files, date) {
    var d = date || new Date();
    var dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    var dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    var chunks = [], central = [], offset = 0;
    function u16(v) { return [v & 0xff, (v >>> 8) & 0xff]; }
    function u32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }
    files.forEach(function (f) {
      var name = utf8(f.path);
      var data = typeof f.content === "string" ? utf8(f.content) : new Uint8Array(f.content);
      var crc = crc32(data);
      var head = [].concat([0x50, 0x4b, 0x03, 0x04], u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0));
      chunks.push(Uint8Array.from(head), name, data);
      var cen = [].concat([0x50, 0x4b, 0x01, 0x02], u16(20), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset));
      central.push(Uint8Array.from(cen), name);
      offset += head.length + name.length + data.length;
    });
    var cenSize = central.reduce(function (s, c) { return s + c.length; }, 0);
    var end = Uint8Array.from([].concat([0x50, 0x4b, 0x05, 0x06], u16(0), u16(0), u16(files.length), u16(files.length), u32(cenSize), u32(offset), u16(0)));
    var all = chunks.concat(central, [end]);
    var total = all.reduce(function (s, c) { return s + c.length; }, 0);
    var out = new Uint8Array(total), pos = 0;
    all.forEach(function (c) { out.set(c, pos); pos += c.length; });
    return out;
  }

  function sample() {
    return {
      name: "Weekly Report Writer",
      description: "Turns rough bullet notes into a clear weekly status report in our team format, and can pull open tickets from our tracker.",
      instructions: "You write weekly status reports for a small product team.\n\nFormat:\n1. Headline (one sentence)\n2. Shipped\n3. In progress (with owner)\n4. Risks and asks\n\nRules:\n- Keep it under 250 words.\n- Use plain language; no hype.\n- If the user mentions a ticket ID, call getTicket to fetch its current status.\n- Ask one clarifying question if the notes are ambiguous.",
      starters: ["Turn these notes into this week's report", "Summarize open tickets for the team", "Rewrite this report for executives"],
      capabilities: { web: false, canvas: true, image: false, code: true },
      model: "GPT-5.4 Thinking",
      knowledge: [{ name: "report-template.docx", size: 18432 }, { name: "team-glossary.pdf", size: 52011 }],
      apps: "",
      actions: [{
        name: "Ticket Tracker",
        auth: "apikey",
        privacy: "https://example.com/privacy",
        schema: JSON.stringify({
          openapi: "3.1.0",
          info: { title: "Ticket Tracker API", version: "1.0.0" },
          servers: [{ url: "https://tickets.example.com/api" }],
          paths: {
            "/tickets/{ticketId}": { get: { operationId: "getTicket", summary: "Get a ticket by ID", parameters: [{ name: "ticketId", in: "path", required: true, schema: { type: "string" }, description: "Ticket ID such as PRJ-123" }] } },
            "/tickets": {
              get: { operationId: "listTickets", summary: "List tickets", parameters: [{ name: "status", in: "query", schema: { type: "string", enum: ["open", "closed"] } }, { name: "limit", in: "query", schema: { type: "integer" } }] },
              post: { operationId: "createTicket", summary: "Create a ticket", "x-openai-isConsequential": true, requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { title: { type: "string" } } } } } } }
            }
          },
          components: { securitySchemes: { ApiKeyAuth: { type: "apiKey", in: "header", name: "X-API-Key" } } }
        }, null, 2)
      }],
      sharing: "workspace",
      shareLink: "",
      users: "Product team (8 people)",
      published: "published",
      plan: "personal",
      tests: [
        { prompt: "Notes: shipped login fix, PRJ-12 still blocked on design, hiring a QA contractor. Write the report.", expect: "Four sections, under 250 words, PRJ-12 status fetched and listed under Risks." },
        { prompt: "Rewrite last week's report for executives in 3 bullets.", expect: "Three bullets, outcome-focused, no ticket IDs." }
      ]
    };
  }

  return {
    VERSION: VERSION, DATES: DATES, CAPABILITIES: CAPABILITIES, SHARING: SHARING,
    normalize: normalize, daysUntil: daysUntil, fmtDate: fmtDate, slugify: slugify, pyIdent: pyIdent,
    findSecrets: findSecrets, parseSpec: parseSpec, listOperations: listOperations, summarizeSpec: summarizeSpec,
    mcpServerPy: mcpServerPy, skillMd: skillMd, portablePrompt: portablePrompt, migrationReport: migrationReport,
    reportMd: reportMd, readmeMd: readmeMd, testsMd: testsMd, buildBundle: buildBundle, zip: zip, crc32: crc32,
    safeFileName: safeFileName, sample: sample
  };
});
