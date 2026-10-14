/* Supabase Grants Check: analysis engine (browser + Node).
 * Replays Supabase SQL migrations, reads supabase-js calls in app code and (optionally) a live
 * catalog snapshot, then reports which tables lose Data API access when Supabase stops
 * auto-granting new public tables (Oct 30, 2026) and writes least-privilege GRANTs.
 * Everything runs locally; nothing here makes network requests. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SG = factory();
})(this, function () {
  "use strict";

  var DATA_AS_OF = "2026-10-13";
  var CUTOFF_TS = "20261030000000";
  var API_ROLES = ["anon", "authenticated", "service_role"];
  var CLIENT_ROLES = ["anon", "authenticated"];
  var PRIVS = ["select", "insert", "update", "delete"];
  var SRC = {
    changelog: "https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically",
    securing: "https://supabase.com/docs/guides/api/securing-your-api",
    e42501: "https://supabase.com/docs/guides/troubleshooting/database-api-42501-errors",
    pgPrivs: "https://www.postgresql.org/docs/current/sql-grant.html",
    pgSeq: "https://www.postgresql.org/docs/current/datatype-numeric.html#DATATYPE-SERIAL",
    rls: "https://supabase.com/docs/guides/database/postgres/row-level-security",
    viewLint: "https://supabase.com/docs/guides/database/database-advisors?lint=0010_security_definer_view",
    definerLint: "https://supabase.com/docs/guides/database/database-advisors?lint=0028_anon_security_definer_function_executable"
  };

  // ---------------------------------------------------------------- SQL lexing
  /** Split SQL into statements, dropping comments and respecting quotes / dollar quotes.
   *  Returns [{ text, line }] where line is 1-based start line. String contents are kept. */
  function splitSql(sql) {
    var out = [], buf = "", i = 0, n = sql.length, line = 1, startLine = 1, started = false;
    function push() {
      var t = buf.trim();
      if (t) out.push({ text: t, line: startLine });
      buf = ""; started = false;
    }
    while (i < n) {
      var c = sql[i], d = sql[i + 1];
      if (c === "\n") line++;
      if (!started && !/\s/.test(c) && !(c === "-" && d === "-") && !(c === "/" && d === "*")) { started = true; startLine = line; }
      if (c === "-" && d === "-") { while (i < n && sql[i] !== "\n") i++; buf += " "; continue; }
      if (c === "/" && d === "*") {
        var depth = 1; i += 2;
        while (i < n && depth) {
          if (sql[i] === "\n") line++;
          if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; }
          else if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; }
          else i++;
        }
        buf += " "; continue;
      }
      if (c === "'") {
        var esc = /[eE]$/.test(buf) && !/\w[eE]$/.test(buf);
        buf += c; i++;
        while (i < n) {
          var ch = sql[i]; if (ch === "\n") line++;
          if (esc && ch === "\\") { buf += ch + (sql[i + 1] || ""); i += 2; continue; }
          if (ch === "'" && sql[i + 1] === "'") { buf += "''"; i += 2; continue; }
          buf += ch; i++;
          if (ch === "'") break;
        }
        continue;
      }
      if (c === '"') {
        buf += c; i++;
        while (i < n) { var q = sql[i]; if (q === "\n") line++; buf += q; i++; if (q === '"') { if (sql[i] === '"') { buf += '"'; i++; continue; } break; } }
        continue;
      }
      if (c === "$") {
        var m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
        if (m && !/[\w$]$/.test(buf)) {
          var tag = m[0], end = sql.indexOf(tag, i + tag.length);
          if (end < 0) end = n - tag.length;
          var body = sql.slice(i, end + tag.length);
          line += (body.match(/\n/g) || []).length;
          buf += body; i = end + tag.length; continue;
        }
      }
      if (c === ";") { push(); i++; continue; }
      buf += c; i++;
    }
    push();
    return out;
  }

  /** Replace string/dollar-quoted contents with placeholders so keyword regexes don't match inside them. */
  function maskStrings(s) {
    return s.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "$$body$$").replace(/'(?:[^']|'')*'/g, "'str'");
  }

  var IDENT = '(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)';
  var QNAME = IDENT + "(?:\\s*\\.\\s*" + IDENT + ")?";
  function unq(id) { id = id.trim(); return id[0] === '"' ? id.slice(1, -1).replace(/""/g, '"') : id.toLowerCase(); }
  function splitQ(q) {
    var parts = q.match(new RegExp(IDENT, "g")) || [];
    return parts.length > 1 ? { schema: unq(parts[0]), name: unq(parts[1]) } : { schema: "public", name: unq(parts[0] || "") };
  }
  function keyOf(o) { return o.schema + "." + o.name; }
  function quoteIdent(s) { return /^[a-z_][a-z0-9_$]*$/.test(s) && !RESERVED[s] ? s : '"' + s.replace(/"/g, '""') + '"'; }
  var RESERVED = {}; "all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create current_catalog current_date current_role current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign from grant group having in initially intersect into lateral leading limit localtime localtimestamp not null offset on only or order placing primary references returning select session_user some symmetric table then to trailing true union unique user using variadic when where window with".split(" ").forEach(function (w) { RESERVED[w] = 1; });
  function qn(schema, name) { return quoteIdent(schema) + "." + quoteIdent(name); }

  /** Split on top-level commas (ignoring commas inside parentheses). */
  function splitTop(s) {
    var out = [], depth = 0, cur = "";
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === "(") depth++; else if (c === ")") depth--;
      if (c === "," && depth === 0) { out.push(cur); cur = ""; } else cur += c;
    }
    if (cur.trim()) out.push(cur);
    return out;
  }
  /** Return the text inside the first balanced (...) at or after index i, and the index after it. */
  function balanced(s, i) {
    var start = s.indexOf("(", i); if (start < 0) return null;
    var depth = 0;
    for (var j = start; j < s.length; j++) {
      if (s[j] === "(") depth++;
      else if (s[j] === ")") { depth--; if (!depth) return { inner: s.slice(start + 1, j), end: j + 1 }; }
    }
    return { inner: s.slice(start + 1), end: s.length };
  }

  function parsePrivs(txt) {
    var t = txt.trim().toLowerCase();
    if (/^all(\s+privileges)?(\s*\(|$)/.test(t)) return { privs: PRIVS.slice(), columns: /\(/.test(t) };
    var set = [], cols = false;
    splitTop(t).forEach(function (p) {
      p = p.trim(); if (/\(/.test(p)) cols = true;
      var w = p.split(/[\s(]/)[0];
      if (PRIVS.indexOf(w) >= 0 && set.indexOf(w) < 0) set.push(w);
    });
    return { privs: set, columns: cols };
  }
  function parseRoles(txt) {
    return splitTop(txt).map(function (r) { r = r.trim().replace(/^group\s+/i, ""); return unq(r); }).filter(Boolean);
  }
  function rolesExpand(roles) {
    var out = [];
    roles.forEach(function (r) { if (r === "public") API_ROLES.forEach(function (x) { if (out.indexOf(x) < 0) out.push(x); }); else if (API_ROLES.indexOf(r) >= 0 && out.indexOf(r) < 0) out.push(r); });
    return out;
  }

  // ---------------------------------------------------------------- schema model
  function newState(exposed) {
    return { exposed: exposed || ["public"], objects: {}, funcs: {}, blanket: [], defaults: [], revokedDefaults: null, order: 0, errors: [] };
  }
  function grantsObj() { var g = {}; API_ROLES.forEach(function (r) { g[r] = []; }); return g; }
  function addPriv(g, role, privs) { privs.forEach(function (p) { if (g[role].indexOf(p) < 0) g[role].push(p); }); }
  function delPriv(g, role, privs) { g[role] = g[role].filter(function (p) { return privs.indexOf(p) < 0; }); }

  function fileTs(path) { var m = /(?:^|\/)(\d{14})_[^/]*$/.exec(path || ""); return m ? m[1] : null; }

  function applyStatement(st, stmt, file) {
    var raw = stmt.text, s = maskStrings(raw), m, here = { path: file.path, line: stmt.line, ts: file.ts };
    var ls = s.replace(/\s+/g, " ").trim();

    // CREATE TABLE
    m = new RegExp("^create\\s+(?:(?:global|local)\\s+)?(temp|temporary|unlogged)?\\s*table\\s+(?:if\\s+not\\s+exists\\s+)?(" + QNAME + ")", "i").exec(ls);
    if (m) {
      if (/^temp/i.test(m[1] || "")) return;
      var t = splitQ(m[2]), k = keyOf(t);
      var o = { schema: t.schema, name: t.name, kind: "table", created: here, rls: false, policies: [], grants: grantsObj(), explicit: grantsObj(), sequences: [], columnGrants: false, order: st.order++ };
      if (st.defaults.length) st.defaults.forEach(function (d) { if (d.type === "tables" && (!d.schemas || d.schemas.indexOf(t.schema) >= 0)) d.roles.forEach(function (r) { addPriv(o.grants, r, d.privs); }); });
      var rest = ls.slice(m.index + m[0].length);
      if (/^\s*\(/.test(rest)) {
        var b = balanced(rest, 0);
        splitTop(b.inner).forEach(function (col) {
          var cm = new RegExp("^\\s*(" + IDENT + ")\\s+([A-Za-z0-9_]+)", "i").exec(col);
          if (!cm || /^(constraint|primary|unique|foreign|check|exclude|like)$/i.test(cm[1])) return;
          var cname = unq(cm[1]), type = cm[2].toLowerCase();
          if (/^(small|big)?serial[248]?$/.test(type)) o.sequences.push({ name: (t.name + "_" + cname + "_seq").slice(0, 63), column: cname, serial: true });
          var nv = /nextval\s*\(\s*'([^']+)'/i.exec(raw.slice(0));
          if (nv && new RegExp("\\b" + cname + "\\b[^,]*nextval", "i").test(col.replace(/'str'/g, "'x'"))) {
            var sq = splitQ(nv[1].replace(/::regclass/i, ""));
            if (!o.sequences.some(function (x) { return x.name === sq.name; })) o.sequences.push({ name: sq.name, column: cname, serial: false });
          }
        });
      }
      st.objects[k] = o; return;
    }
    // CREATE VIEW / MATERIALIZED VIEW
    m = new RegExp("^create\\s+(?:or\\s+replace\\s+)?(?:temp(?:orary)?\\s+)?(?:recursive\\s+)?(materialized\\s+)?view\\s+(?:if\\s+not\\s+exists\\s+)?(" + QNAME + ")", "i").exec(ls);
    if (m) {
      var v = splitQ(m[2]), vk = keyOf(v), prev = st.objects[vk];
      var head = ls.slice(m.index + m[0].length).split(/\sas\s/i)[0];
      var inv = /security_invoker\s*(=\s*(true|on|1|'str')|\)|,)/i.test(head) && !/security_invoker\s*=\s*(false|off|0)/i.test(head);
      var vo = prev && prev.kind !== "table" ? prev : { schema: v.schema, name: v.name, kind: m[1] ? "matview" : "view", created: here, rls: null, policies: [], grants: grantsObj(), explicit: grantsObj(), sequences: [], order: st.order++ };
      vo.securityInvoker = inv || (prev && prev.securityInvoker && /or\s+replace/i.test(ls) ? prev.securityInvoker : inv);
      if (!prev && st.defaults.length) st.defaults.forEach(function (d) { if (d.type === "tables" && (!d.schemas || d.schemas.indexOf(v.schema) >= 0)) d.roles.forEach(function (r) { addPriv(vo.grants, r, d.privs); }); });
      st.objects[vk] = vo; return;
    }
    // ALTER VIEW ... SET (security_invoker)
    m = new RegExp("^alter\\s+view\\s+(?:if\\s+exists\\s+)?(" + QNAME + ")\\s+(.*)$", "i").exec(ls);
    if (m) {
      var av = st.objects[keyOf(splitQ(m[1]))];
      if (av) {
        if (/set\s*\([^)]*security_invoker\s*(=\s*(true|on|1))?\s*[,)]/i.test(m[2]) && !/security_invoker\s*=\s*(false|off|0)/i.test(m[2])) av.securityInvoker = true;
        if (/security_invoker\s*=\s*(false|off|0)/i.test(m[2])) av.securityInvoker = false;
        var rn0 = new RegExp("rename\\s+to\\s+(" + IDENT + ")", "i").exec(m[2]);
        if (rn0) { delete st.objects[keyOf(av)]; av.name = unq(rn0[1]); st.objects[keyOf(av)] = av; }
      }
      return;
    }
    // ALTER TABLE
    m = new RegExp("^alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(" + QNAME + ")\\s*\\*?\\s+(.*)$", "i").exec(ls);
    if (m) {
      var at = st.objects[keyOf(splitQ(m[1]))];
      if (!at) return;
      var act = m[2];
      if (/\benable\s+row\s+level\s+security\b/i.test(act)) at.rls = true;
      if (/\bdisable\s+row\s+level\s+security\b/i.test(act)) at.rls = false;
      var rn = new RegExp("^rename\\s+to\\s+(" + IDENT + ")", "i").exec(act);
      if (rn) { delete st.objects[keyOf(at)]; at.name = unq(rn[1]); st.objects[keyOf(at)] = at; }
      var sm = /\bset\s+schema\s+([A-Za-z_][\w$]*|"[^"]+")/i.exec(act);
      if (sm) { delete st.objects[keyOf(at)]; at.schema = unq(sm[1]); st.objects[keyOf(at)] = at; }
      var addc = new RegExp("add\\s+(?:column\\s+)?(?:if\\s+not\\s+exists\\s+)?(" + IDENT + ")\\s+(small|big)?serial[248]?\\b", "ig"), ac;
      while ((ac = addc.exec(act))) { var cn = unq(ac[1]); at.sequences.push({ name: (at.name + "_" + cn + "_seq").slice(0, 63), column: cn, serial: true }); }
      return;
    }
    // DROP TABLE / VIEW
    m = /^drop\s+(?:materialized\s+)?(table|view)\s+(?:if\s+exists\s+)?(.*?)(\s+(cascade|restrict))?$/i.exec(ls);
    if (m) { splitTop(m[2]).forEach(function (x) { delete st.objects[keyOf(splitQ(x))]; }); return; }
    // CREATE POLICY
    m = new RegExp("^create\\s+policy\\s+(" + IDENT + ")\\s+on\\s+(" + QNAME + ")(.*)$", "i").exec(ls);
    if (m) {
      var pt = st.objects[keyOf(splitQ(m[2]))];
      var pol = parsePolicyTail(m[3], raw);
      pol.name = unq(m[1]); pol.at = here;
      if (pt) { pt.policies = pt.policies.filter(function (p) { return p.name !== pol.name; }); pt.policies.push(pol); }
      return;
    }
    m = new RegExp("^drop\\s+policy\\s+(?:if\\s+exists\\s+)?(" + IDENT + ")\\s+on\\s+(" + QNAME + ")", "i").exec(ls);
    if (m) { var dt = st.objects[keyOf(splitQ(m[2]))], pn = unq(m[1]); if (dt) dt.policies = dt.policies.filter(function (p) { return p.name !== pn; }); return; }
    m = new RegExp("^alter\\s+policy\\s+(" + IDENT + ")\\s+on\\s+(" + QNAME + ")\\s+(.*)$", "i").exec(ls);
    if (m) {
      var apt = st.objects[keyOf(splitQ(m[2]))]; if (!apt) return;
      var ap = apt.policies.filter(function (p) { return p.name === unq(m[1]); })[0]; if (!ap) return;
      var rn2 = new RegExp("^rename\\s+to\\s+(" + IDENT + ")", "i").exec(m[3]);
      if (rn2) { ap.name = unq(rn2[1]); return; }
      var np = parsePolicyTail(" " + m[3], raw);
      if (/\bto\s/i.test(m[3].split(/\busing\b|\bwith\s+check\b/i)[0])) ap.roles = np.roles;
      if (np.using) ap.using = np.using; if (np.check) ap.check = np.check;
      return;
    }
    // CREATE FUNCTION
    m = new RegExp("^create\\s+(?:or\\s+replace\\s+)?function\\s+(" + QNAME + ")\\s*\\(", "i").exec(ls);
    if (m) {
      var f = splitQ(m[1]), fk = keyOf(f), body = ls.slice(m.index + m[0].length - 1);
      var bb = balanced(body, 0), tail = body.slice(bb.end);
      var fo = st.funcs[fk] || { schema: f.schema, name: f.name, exec: { anon: true, authenticated: true, service_role: true }, roleExec: { anon: true, authenticated: true, service_role: true }, publicExec: true, created: here };
      fo.definer = /\bsecurity\s+definer\b/i.test(tail);
      fo.searchPath = /\bset\s+search_path\b/i.test(tail);
      fo.args = bb.inner.trim();
      fo.trigger = /\breturns\s+trigger\b/i.test(tail);
      st.funcs[fk] = fo; return;
    }
    // GRANT / REVOKE on objects
    m = /^(grant|revoke)\s+(?:grant\s+option\s+for\s+)?(.+?)\s+on\s+(.+?)\s+(to|from)\s+(.+?)(\s+with\s+grant\s+option|\s+granted\s+by\s+.*|\s+cascade|\s+restrict)?$/i.exec(ls);
    if (m && !/^(grant|revoke)\s+[\w", ]+\s+(to|from)\s/i.test(ls.replace(/\son\s.*$/i, ""))) {
      var isGrant = m[1].toLowerCase() === "grant", what = m[3].trim(), roles = rolesExpand(parseRoles(m[5]));
      var pp = parsePrivs(m[2]);
      var allIn = /^all\s+(tables|sequences|functions|routines)\s+in\s+schema\s+(.+)$/i.exec(what);
      if (allIn) {
        var kind = allIn[1].toLowerCase(), schemas = parseRoles(allIn[2]);
        if (kind === "tables") {
          Object.keys(st.objects).forEach(function (k2) {
            var ob = st.objects[k2]; if (schemas.indexOf(ob.schema) < 0) return;
            roles.forEach(function (r) { if (isGrant) { addPriv(ob.grants, r, pp.privs); addPriv(ob.explicit, r, pp.privs); ob.blanket = true; } else { delPriv(ob.grants, r, pp.privs); delPriv(ob.explicit, r, pp.privs); } });
          });
          if (isGrant && roles.some(function (r) { return r !== "service_role"; }) && pp.privs.length) st.blanket.push({ at: here, code: raw.trim(), roles: roles.filter(function (r) { return r !== "service_role"; }), kind: "tables" });
        } else if (kind === "sequences") {
          Object.keys(st.objects).forEach(function (k2) { var ob = st.objects[k2]; if (schemas.indexOf(ob.schema) < 0) return; ob.sequences.forEach(function (sq) { sq.usage = sq.usage || []; roles.forEach(function (r) { if (isGrant) { if (sq.usage.indexOf(r) < 0) sq.usage.push(r); } else sq.usage = sq.usage.filter(function (x) { return x !== r; }); }); }); });
        } else {
          Object.keys(st.funcs).forEach(function (k2) { var fn = st.funcs[k2]; if (schemas.indexOf(fn.schema) < 0) return; applyFuncGrant(fn, isGrant, m[5]); });
        }
        return;
      }
      var seqM = /^sequence\s+(.+)$/i.exec(what);
      if (seqM) {
        splitTop(seqM[1]).forEach(function (x) {
          var q = splitQ(x);
          Object.keys(st.objects).forEach(function (k2) { st.objects[k2].sequences.forEach(function (sq) { if (sq.name === q.name && st.objects[k2].schema === q.schema) { sq.usage = sq.usage || []; roles.forEach(function (r) { if (isGrant) { if (sq.usage.indexOf(r) < 0) sq.usage.push(r); } else sq.usage = sq.usage.filter(function (y) { return y !== r; }); }); } }); });
        });
        return;
      }
      var fnM = /^(?:function|routine|procedure)\s+(.+)$/i.exec(what);
      if (fnM) {
        fnM[1].replace(/\([^)]*\)/g, "").split(",").forEach(function (x) { var fn = st.funcs[keyOf(splitQ(x))]; if (fn) applyFuncGrant(fn, isGrant, m[5]); });
        return;
      }
      if (/^(schema|database|type|domain|foreign|language|large|tablespace)\b/i.test(what)) return;
      splitTop(what.replace(/^table\s+/i, "")).forEach(function (x) {
        var ob = st.objects[keyOf(splitQ(x))]; if (!ob) return;
        if (pp.columns) ob.columnGrants = true;
        roles.forEach(function (r) { if (isGrant) { addPriv(ob.grants, r, pp.privs); addPriv(ob.explicit, r, pp.privs); } else { delPriv(ob.grants, r, pp.privs); delPriv(ob.explicit, r, pp.privs); ob.revoked = true; } });
      });
      return;
    }
    // ALTER DEFAULT PRIVILEGES
    m = /^alter\s+default\s+privileges\s+(?:for\s+(?:role|user)\s+(.+?)\s+)?(?:in\s+schema\s+(.+?)\s+)?(grant|revoke)\s+(?:grant\s+option\s+for\s+)?(.+?)\s+on\s+(tables|sequences|functions|routines|types|schemas)\s+(to|from)\s+(.+?)(\s+with\s+grant\s+option|\s+cascade|\s+restrict)?$/i.exec(ls);
    if (m) {
      var dGrant = m[3].toLowerCase() === "grant", dType = m[5].toLowerCase(), dRoles = rolesExpand(parseRoles(m[7]));
      var dSchemas = m[2] ? parseRoles(m[2]) : null, dp = parsePrivs(m[4]);
      if (dType !== "tables" && dType !== "sequences") return;
      if (dGrant) {
        if (dType === "tables") st.defaults.push({ type: "tables", roles: dRoles, privs: dp.privs, schemas: dSchemas, at: here, code: raw.trim() });
        if (dType === "tables" && dRoles.some(function (r) { return r !== "service_role"; })) st.blanket.push({ at: here, code: raw.trim(), roles: dRoles.filter(function (r) { return r !== "service_role"; }), kind: "defaults" });
      } else {
        st.defaults = st.defaults.filter(function (d) { return d.type !== dType || !d.roles.some(function (r) { return dRoles.indexOf(r) >= 0; }); });
        if (dType === "tables" && dRoles.some(function (r) { return CLIENT_ROLES.indexOf(r) >= 0; })) st.revokedDefaults = here;
      }
      return;
    }
  }
  function applyFuncGrant(fn, isGrant, rolesTxt) {
    // Postgres: EXECUTE via PUBLIC still applies after revoking from a single role.
    parseRoles(rolesTxt).forEach(function (r) {
      if (r === "public") fn.publicExec = isGrant;
      else if (API_ROLES.indexOf(r) >= 0) fn.roleExec[r] = isGrant;
    });
    API_ROLES.forEach(function (r) { fn.exec[r] = !!(fn.roleExec[r] || fn.publicExec); });
    fn.touched = true;
  }

  /** Parse the part of CREATE POLICY after the table name. */
  function parsePolicyTail(tail, raw) {
    var t = " " + tail.trim();
    var cut = t.search(/\susing\s*\(|\swith\s+check\s*\(/i);
    var head = cut >= 0 ? t.slice(0, cut) : t;
    var pol = { permissive: !/\bas\s+restrictive\b/i.test(head), cmd: "all", roles: ["public"], using: "", check: "" };
    var cm = /\bfor\s+(all|select|insert|update|delete)\b/i.exec(head); if (cm) pol.cmd = cm[1].toLowerCase();
    var rm = /\bto\s+(.+)$/i.exec(head); if (rm) pol.roles = parseRoles(rm[1]);
    // expressions from the raw (unmasked) statement so string literals survive
    var rawFlat = raw.replace(/\s+/g, " ");
    var um = /\susing\s*\(/i.exec(rawFlat); if (um) pol.using = balanced(rawFlat, um.index + um[0].length - 1).inner.trim();
    var wm = /\swith\s+check\s*\(/i.exec(rawFlat); if (wm) pol.check = balanced(rawFlat, wm.index + wm[0].length - 1).inner.trim();
    return pol;
  }

  /** Does a policy expression only ever pass for signed-in users? */
  function requiresAuth(expr) {
    var e = (expr || "").toLowerCase().replace(/\s+/g, " ");
    if (!e) return false;
    if (/auth\.uid\(\)\s*is\s+null|auth\.role\(\)\s*=\s*'anon'|is_anonymous/.test(e)) return false;
    if (/^\(?\s*true\s*\)?$/.test(e)) return false;
    return /auth\.uid\(\)|auth\.jwt\(\)|auth\.role\(\)\s*=\s*'authenticated'|auth\.email\(\)/.test(e);
  }

  /** Privileges each client role can use under RLS, from permissive policies. */
  function policyPrivs(o) {
    var res = { anon: [], authenticated: [] };
    (o.policies || []).forEach(function (p) {
      if (!p.permissive) return;
      var cmds = p.cmd === "all" ? PRIVS : [p.cmd];
      var roles = [];
      p.roles.forEach(function (r) {
        if (r === "public") { roles.push("authenticated"); if (!requiresAuth(p.using || p.check)) roles.push("anon"); }
        else if (CLIENT_ROLES.indexOf(r) >= 0) roles.push(r);
      });
      roles.forEach(function (r) { cmds.forEach(function (c) { if (res[r].indexOf(c) < 0) res[r].push(c); }); });
    });
    return res;
  }

  // ---------------------------------------------------------------- app code
  var CODE_RE = /\.(m?[jt]sx?|cjs|vue|svelte|astro)$/i;
  var SKIP_PATH = /(^|\/)(node_modules|dist|build|out|\.next|\.nuxt|\.svelte-kit|coverage|vendor|\.vercel|\.output)\//;
  function isCodePath(p) { return CODE_RE.test(p) && !SKIP_PATH.test(p) && !/\.min\.js$|\.d\.ts$/.test(p); }
  function isServerFile(path, text) {
    if (/(^|\/)supabase\/functions\//.test(path)) return true;
    return /SERVICE_ROLE|service_role|SUPABASE_SECRET_KEY|sb_secret_|serviceRoleKey/i.test(text);
  }
  function chainAfter(text, i) {
    var depth = 0, j = i, q = null;
    for (; j < text.length && j < i + 2000; j++) {
      var c = text[j];
      if (q) { if (c === "\\") { j++; continue; } if (c === q) q = null; continue; }
      if (c === "'" || c === '"' || c === "`") { q = c; continue; }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") { if (depth === 0) break; depth--; }
      else if (depth === 0 && (c === ";" || c === ",")) break;
      else if (depth === 0 && c === "\n") { var rest = text.slice(j + 1).replace(/^\s+/, ""); if (rest[0] !== "." && rest.slice(0, 2) !== "?.") break; }
    }
    return text.slice(i, j);
  }
  /** Find supabase-js table and RPC calls. */
  function scanCode(path, text) {
    var calls = [], server = isServerFile(path, text), m;
    var re = /\.\s*from\s*\(\s*(['"`])([A-Za-z_][\w$-]*)\1\s*\)/g;
    while ((m = re.exec(text))) {
      var before = text.slice(Math.max(0, m.index - 80), m.index);
      if (/storage\s*$/.test(before) || /\bstorage\s*\.\s*$/.test(before)) continue;
      if (/\b(Array|Buffer|Uint8Array|Object|Promise)\s*$/.test(before)) continue;
      var sch = /\.\s*schema\s*\(\s*(['"`])([\w$-]+)\1\s*\)\s*$/.exec(before);
      var recv = /([A-Za-z_$][\w$]*)\s*(?:\(\s*\))?\s*(?:\.\s*schema\s*\([^)]*\)\s*)?$/.exec(before);
      var chain = chainAfter(text, m.index + m[0].length);
      var ops = [], om, ore = /\.\s*(select|insert|update|upsert|delete)\s*\(/g;
      while ((om = ore.exec(chain))) if (ops.indexOf(om[1]) < 0) ops.push(om[1]);
      if (!ops.length) continue; // .from() without an operation (e.g. a query builder stored for later)
      var line = text.slice(0, m.index).split("\n").length;
      var srv = server || (recv && /admin|service/i.test(recv[1]));
      var schema0 = sch ? sch[2] : "public";
      calls.push({ kind: "table", schema: schema0, name: m[2], ops: ops, server: !!srv, path: path, line: line });
      // embedded resources: .select('*, prices(*), author:profiles!fk(name)') also reads those tables
      var selRe = /\.\s*select\s*\(\s*(['"`])([\s\S]*?)\1/g, sm2;
      while ((sm2 = selRe.exec(chain))) {
        var emb = /(?:^|[,\s(])(?:[A-Za-z_][\w]*\s*:\s*)?([A-Za-z_][\w]*)\s*(?:!\s*[A-Za-z_][\w]*\s*)*\(/g, em;
        while ((em = emb.exec(sm2[2]))) {
          if (/^(count|sum|avg|min|max)$/i.test(em[1]) || em[1] === m[2]) continue;
          calls.push({ kind: "table", schema: schema0, name: em[1], ops: ["select"], server: !!srv, path: path, line: line, embedded: true });
        }
      }
    }
    var rre = /\.\s*rpc\s*\(\s*(['"`])([A-Za-z_][\w$]*)\1/g;
    while ((m = rre.exec(text))) {
      var before2 = text.slice(Math.max(0, m.index - 80), m.index);
      var sch2 = /\.\s*schema\s*\(\s*(['"`])([\w$-]+)\1\s*\)\s*$/.exec(before2);
      calls.push({ kind: "rpc", schema: sch2 ? sch2[2] : "public", name: m[2], server: server || /admin|service/i.test(before2), path: path, line: text.slice(0, m.index).split("\n").length });
    }
    var dyn = (text.match(/\.\s*from\s*\(\s*[A-Za-z_$][\w$.]*\s*\)\s*\.\s*(select|insert|update|upsert|delete)\b/g) || []).length;
    return { calls: calls, dynamic: dyn };
  }
  /** Privileges a supabase-js operation needs (verified against Postgres 18). */
  function opPrivs(op) {
    if (op === "select") return ["select"];
    if (op === "insert") return ["insert"];
    if (op === "update") return ["update", "select"]; // filters read columns
    if (op === "delete") return ["delete", "select"];
    if (op === "upsert") return ["insert", "update", "select"]; // ON CONFLICT reads the conflict target
    return [];
  }

  // ---------------------------------------------------------------- config & snapshot
  function parseConfigToml(text) {
    var sec = null, schemas = null;
    (text || "").split(/\r?\n/).forEach(function (l) {
      var h = /^\s*\[([^\]]+)\]/.exec(l); if (h) { sec = h[1].trim(); return; }
      if (sec === "api") { var m = /^\s*schemas\s*=\s*\[([^\]]*)\]/.exec(l); if (m) schemas = (m[1].match(/"([^"]+)"|'([^']+)'/g) || []).map(function (x) { return x.slice(1, -1); }); }
    });
    if (!schemas) return null;
    return schemas.filter(function (s) { return ["graphql_public", "storage", "auth", "realtime", "extensions"].indexOf(s) < 0; });
  }

  var SNAPSHOT_SQL = [
    "-- Supabase Grants Check: read-only snapshot. Run in the SQL Editor, copy the single JSON cell.",
    "with s as (select unnest(array['public']) as nsp)",
    "select json_build_object(",
    "  'tool', 'supabase-grants-check', 'version', 1,",
    "  'tables', (select coalesce(json_agg(json_build_object(",
    "      'schema', n.nspname, 'name', c.relname, 'kind', c.relkind::text, 'rls', c.relrowsecurity,",
    "      'options', coalesce(c.reloptions, '{}'),",
    "      'grants', json_build_object(",
    "        'anon', array(select p from unnest(array['select','insert','update','delete']) p where has_table_privilege('anon', c.oid, p)),",
    "        'authenticated', array(select p from unnest(array['select','insert','update','delete']) p where has_table_privilege('authenticated', c.oid, p)),",
    "        'service_role', array(select p from unnest(array['select','insert','update','delete']) p where has_table_privilege('service_role', c.oid, p))))",
    "      order by c.relname), '[]'::json)",
    "    from pg_class c join pg_namespace n on n.oid = c.relnamespace",
    "    where n.nspname in (select nsp from s) and c.relkind in ('r','p','v','m')",
    "      and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')),",
    "  'policies', (select coalesce(json_agg(json_build_object(",
    "      'schema', schemaname, 'table', tablename, 'name', policyname, 'permissive', permissive = 'PERMISSIVE',",
    "      'cmd', lower(cmd), 'roles', roles, 'using', qual, 'check', with_check)), '[]'::json)",
    "    from pg_policies where schemaname in (select nsp from s)),",
    "  'sequences', (select coalesce(json_agg(json_build_object(",
    "      'schema', n.nspname, 'name', q.relname, 'table', t.relname, 'identity', d.deptype = 'i',",
    "      'usage', array(select r from unnest(array['anon','authenticated','service_role']) r where has_sequence_privilege(r, q.oid, 'USAGE')))), '[]'::json)",
    "    from pg_class q join pg_namespace n on n.oid = q.relnamespace",
    "    left join pg_depend d on d.objid = q.oid and d.classid = 'pg_class'::regclass and d.refclassid = 'pg_class'::regclass and d.deptype in ('a','i')",
    "    left join pg_class t on t.oid = d.refobjid",
    "    where q.relkind = 'S' and n.nspname in (select nsp from s)),",
    "  'functions', (select coalesce(json_agg(json_build_object(",
    "      'schema', n.nspname, 'name', p.proname, 'definer', p.prosecdef, 'search_path', coalesce(array_to_string(p.proconfig, ','), '') like '%search_path%',",
    "      'trigger', p.prorettype = 'trigger'::regtype,",
    "      'exec', json_build_object('anon', has_function_privilege('anon', p.oid, 'EXECUTE'), 'authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE')))), '[]'::json)",
    "    from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
    "    where n.nspname in (select nsp from s) and p.prokind = 'f'",
    "      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')),",
    "  'default_acl', (select coalesce(json_agg(json_build_object(",
    "      'owner', pg_get_userbyid(a.defaclrole), 'schema', coalesce(n.nspname, ''), 'type', a.defaclobjtype::text, 'acl', a.defaclacl::text[])), '[]'::json)",
    "    from pg_default_acl a left join pg_namespace n on n.oid = a.defaclnamespace",
    "    where a.defaclnamespace = 0 or n.nspname in (select nsp from s))",
    ") as snapshot;"
  ].join("\n");

  function parseSnapshot(text) {
    if (!text || !text.trim()) return null;
    var t = text.trim(), a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a < 0 || b < a) throw new Error("The snapshot doesn't contain JSON. Copy the value of the single \"snapshot\" cell.");
    var body = t.slice(a, b + 1), j;
    try { j = JSON.parse(body); } catch (e) {
      try { j = JSON.parse(body.replace(/""/g, '"')); } catch (e2) { throw new Error("The snapshot isn't valid JSON (" + e.message + "). Copy the whole cell; it starts with {\"tool\"."); }
    }
    if (typeof j.snapshot === "object" && j.snapshot) j = j.snapshot;
    if (!Array.isArray(j.tables)) throw new Error("That JSON isn't a Supabase Grants Check snapshot (no \"tables\" list).");
    return j;
  }
  function aclAutoGrants(acls) {
    // entries like "anon=arwdDxtm/postgres" for objtype r (tables)
    var roles = {};
    (acls || []).forEach(function (d) {
      if (d.type !== "r") return;
      (d.acl || []).forEach(function (e) {
        var m = /^"?([^=]*)"?=([a-zA-Z*]*)\//.exec(e); if (!m) return;
        var r = m[1] || "public";
        if (/r/.test(m[2]) && (API_ROLES.indexOf(r) >= 0 || r === "public")) roles[r] = (roles[r] || []).concat([d.owner]);
      });
    });
    return roles;
  }

  // ---------------------------------------------------------------- analysis
  /**
   * input: { migrations: [{path,text}], code: [{path,text}], configText, snapshotText, now }
   */
  function analyze(input) {
    input = input || {};
    var exposed = parseConfigToml(input.configText) || ["public"];
    var st = newState(exposed);
    var migs = (input.migrations || []).filter(function (f) { return /\.sql$/i.test(f.path) && !/(^|\/)seed[^/]*\.sql$/i.test(f.path); });
    migs.sort(function (a, b) { var ta = fileTs(a.path) || "0", tb = fileTs(b.path) || "0"; return ta === tb ? (a.path < b.path ? -1 : 1) : (ta < tb ? -1 : 1); });
    var stmtCount = 0;
    migs.forEach(function (f) {
      var file = { path: f.path, ts: fileTs(f.path) };
      splitSql(f.text || "").forEach(function (s) { stmtCount++; try { applyStatement(st, s, file); } catch (e) { st.errors.push({ path: f.path, line: s.line, message: e.message }); } });
    });

    // snapshot merges in as the source of truth for current state
    var snap = input.snapshotText ? parseSnapshot(input.snapshotText) : null;
    var autoNow = null;
    if (snap) {
      autoNow = aclAutoGrants(snap.default_acl);
      var seen = {};
      snap.tables.forEach(function (t) {
        var k = t.schema + "." + t.name; seen[k] = 1;
        var o = st.objects[k] || { schema: t.schema, name: t.name, created: null, policies: [], explicit: grantsObj(), sequences: [], order: st.order++ };
        o.kind = t.kind === "v" ? "view" : t.kind === "m" ? "matview" : "table";
        o.rls = o.kind === "table" ? !!t.rls : null;
        o.grants = grantsObj(); API_ROLES.forEach(function (r) { addPriv(o.grants, r, ((t.grants || {})[r] || []).map(function (x) { return String(x).toLowerCase(); })); });
        if (o.kind !== "table") o.securityInvoker = (t.options || []).some(function (x) { return /^security_invoker=(true|on|1)$/i.test(x); });
        o.policies = []; o.live = true;
        st.objects[k] = o;
      });
      Object.keys(st.objects).forEach(function (k) { if (!seen[k] && exposed.indexOf(st.objects[k].schema) >= 0) st.objects[k].notLive = true; });
      (snap.policies || []).forEach(function (p) {
        var o = st.objects[p.schema + "." + p.table]; if (!o) return;
        var roles = Array.isArray(p.roles) ? p.roles : String(p.roles || "").replace(/[{}]/g, "").split(",");
        o.policies.push({ name: p.name, permissive: p.permissive !== false, cmd: (p.cmd || "all").toLowerCase(), roles: roles.map(function (r) { return String(r).trim().toLowerCase(); }), using: p.using || "", check: p.check || "" });
      });
      (snap.sequences || []).forEach(function (q) {
        var o = q.table && st.objects[q.schema + "." + q.table]; if (!o) return;
        var ex = o.sequences.filter(function (x) { return x.name === q.name; })[0];
        if (!ex) { ex = { name: q.name, serial: !q.identity }; o.sequences.push(ex); }
        ex.identity = !!q.identity; ex.usage = q.usage || []; ex.serial = !q.identity;
      });
      (snap.functions || []).forEach(function (f) {
        var k = f.schema + "." + f.name;
        st.funcs[k] = { schema: f.schema, name: f.name, definer: !!f.definer, searchPath: !!f.search_path, trigger: !!f.trigger, exec: { anon: !!(f.exec || {}).anon, authenticated: !!(f.exec || {}).authenticated, service_role: true }, live: true };
      });
    }

    // code
    var calls = [], dynamic = 0, codeFiles = 0;
    (input.code || []).forEach(function (f) {
      if (!isCodePath(f.path)) return;
      codeFiles++;
      var r = scanCode(f.path, f.text || ""); calls = calls.concat(r.calls); dynamic += r.dynamic;
    });
    var hasCode = calls.length > 0;

    var objs = Object.keys(st.objects).map(function (k) { return st.objects[k]; }).filter(function (o) { return exposed.indexOf(o.schema) >= 0; });
    objs.sort(function (a, b) { return a.order - b.order; });
    var byKey = {}; objs.forEach(function (o) { byKey[keyOf(o)] = o; o.usage = { client: [], server: [], sites: [] }; });
    var unknownTables = {};
    calls.forEach(function (c) {
      var k = c.schema + "." + c.name, o = byKey[k];
      if (c.kind === "rpc") return;
      if (!o) { if (exposed.indexOf(c.schema) >= 0) { unknownTables[k] = unknownTables[k] || { schema: c.schema, name: c.name, ops: [], sites: [] }; c.ops.forEach(function (op) { if (unknownTables[k].ops.indexOf(op) < 0) unknownTables[k].ops.push(op); }); unknownTables[k].sites.push(c); } return; }
      var bucket = c.server ? o.usage.server : o.usage.client;
      c.ops.forEach(function (op) { if (bucket.indexOf(op) < 0) bucket.push(op); });
      o.usage.sites.push(c);
    });

    var findings = [];
    var cutoffNote = "Supabase applies the new default to every existing project on Oct 30, 2026.";
    var afterCutoff = [], relyAuto = [], openNow = [], seqMissing = [], viewsBypass = [], noPolicyUse = [];

    objs.forEach(function (o) {
      var pol = policyPrivs(o);
      var explicitAny = API_ROLES.some(function (r) { return o.explicit[r].length; });
      o.isNew = !!(o.created && o.created.ts && o.created.ts >= CUTOFF_TS);
      var rec = { anon: [], authenticated: [], service_role: o.kind === "table" || o.kind === "view" || o.kind === "matview" ? PRIVS.slice() : [] };
      if (o.kind !== "table") rec.service_role = ["select"];
      var notes = [];
      if (o.kind === "table") {
        CLIENT_ROLES.forEach(function (r) {
          var want = [];
          if (hasCode) {
            o.usage.client.forEach(function (op) {
              var need = opPrivs(op), main = need[0];
              if (pol[r].indexOf(main) >= 0) need.forEach(function (p) { if (want.indexOf(p) < 0) want.push(p); });
            });
            // keep reads the policies allow if the code reads at all
          } else {
            pol[r].forEach(function (p) { if (want.indexOf(p) < 0) want.push(p); if ((p === "update" || p === "delete") && want.indexOf("select") < 0) want.push("select"); });
          }
          rec[r] = PRIVS.filter(function (p) { return want.indexOf(p) >= 0; });
        });
        if (hasCode) o.usage.client.forEach(function (op) {
          var main = opPrivs(op)[0];
          if (!pol.anon.concat(pol.authenticated).some(function (p) { return p === main; }) && o.rls) noPolicyUse.push({ o: o, op: op });
        });
      } else {
        // views: no RLS of their own; grant what the code reads, to signed-in users
        var reads = o.usage.client.length > 0 || (!hasCode && (o.explicit.authenticated.length || o.grants.authenticated.length));
        if (reads) rec.authenticated = ["select"];
        if (o.explicit.anon.indexOf("select") >= 0) rec.anon = ["select"];
      }
      // sequences for serial columns
      o.seqRec = [];
      o.sequences.forEach(function (sq) {
        if (sq.identity) return;
        var roles = API_ROLES.filter(function (r) { return rec[r].indexOf("insert") >= 0; });
        if (roles.length) o.seqRec.push({ name: sq.name, roles: roles });
        var explicitInsert = API_ROLES.filter(function (r) { return o.explicit[r].indexOf("insert") >= 0 && (!sq.usage || sq.usage.indexOf(r) < 0); });
        if (explicitInsert.length && !o.live) seqMissing.push({ o: o, seq: sq, roles: explicitInsert });
        if (o.live && sq.usage) { var miss = API_ROLES.filter(function (r) { return o.grants[r].indexOf("insert") >= 0 && sq.usage.indexOf(r) < 0; }); if (miss.length) seqMissing.push({ o: o, seq: sq, roles: miss, live: true }); }
      });
      o.rec = rec;
      // classification
      var clientNeeds = rec.anon.length || rec.authenticated.length || o.usage.client.length;
      var used = clientNeeds || o.usage.server.length;
      // current client access: live grants if snapshot, else explicit + (auto-grant assumption for pre-cutoff tables unless revoked)
      var current = {};
      CLIENT_ROLES.forEach(function (r) {
        if (o.live) current[r] = o.grants[r];
        else if (o.explicit[r].length || o.revoked) current[r] = o.grants[r].length ? o.grants[r] : o.explicit[r];
        else if (!o.isNew && !st.revokedDefaults) current[r] = PRIVS.slice();
        else current[r] = o.grants[r];
      });
      o.current = current;
      if (o.kind === "table" && o.rls === false && (current.anon.length || current.authenticated.length)) openNow.push(o);
      if (o.kind !== "table" && !o.securityInvoker && (current.anon.length || current.authenticated.length || o.usage.client.length)) viewsBypass.push(o);
      if (!explicitAny && !o.live) {
        if (o.isNew) afterCutoff.push(o); else if (used || o.policies.length) relyAuto.push(o); else relyAuto.push(o);
      } else if (!o.live) {
        // explicit grants exist but miss roles the code/policies need
        var missing = API_ROLES.filter(function (r) { return rec[r].some(function (p) { return o.explicit[r].indexOf(p) < 0; }); });
        if (missing.length && o.isNew) afterCutoff.push(o);
        o.missingRoles = missing;
      } else {
        var lmiss = API_ROLES.filter(function (r) { return rec[r].some(function (p) { return o.grants[r].indexOf(p) < 0; }); });
        o.missingRoles = lmiss;
      }
      o.notes = notes;
      o.status = o.kind === "table" && o.rls === false && (current.anon.length || current.authenticated.length) ? "open"
        : o.isNew && afterCutoff.indexOf(o) >= 0 ? "breaks"
        : o.live ? ((o.missingRoles || []).length ? "missing" : "ok")
        : !explicitAny ? "auto" : (o.missingRoles || []).length ? "missing" : "ok";
    });

    // ---- findings
    if (afterCutoff.length) findings.push({
      level: "error", id: "after-cutoff", title: afterCutoff.length + " table" + (afterCutoff.length > 1 ? "s" : "") + " created after Oct 30 without grants",
      objects: afterCutoff.map(keyOf),
      why: "These migrations run after Supabase stops auto-granting new tables. Without a GRANT, every Data API request (supabase-js, REST, GraphQL, even with the service_role key) fails with 42501 \"permission denied for table\", before RLS is checked.",
      fix: "Add the grants below to the same migration that creates each table.", src: SRC.changelog
    });
    if (openNow.length) findings.push({
      level: "error", id: "rls-off", title: openNow.length + " table" + (openNow.length > 1 ? "s are" : " is") + " readable by anyone with your anon key (RLS off)",
      objects: openNow.map(keyOf),
      why: "Row Level Security is off and the anon/authenticated roles " + (snap ? "have" : "most likely have (old default grants)") + " access, so anyone with the public anon key can read" + " and change every row through the Data API. Adding GRANTs to fix a 42501 on a table like this makes it worse.",
      fix: "Run alter table ... enable row level security; and add policies before granting anything to anon or authenticated. The generated migration leaves these grants commented out.", src: SRC.rls
    });
    if (relyAuto.length) findings.push({
      level: "warn", id: "relies-on-auto", title: relyAuto.length + " table" + (relyAuto.length > 1 ? "s rely" : " relies") + " on the automatic grants that end on Oct 30",
      objects: relyAuto.map(keyOf),
      why: "Your migrations never GRANT these tables to anon, authenticated or service_role. They work on your current project only because of the old default. " + cutoffNote + " Replaying these migrations on a new project (new projects have had the new default since May 30, 2026) leaves them unreachable, and any table you add the same way after Oct 30 fails with 42501.",
      fix: "Commit the generated migration so every table's access is explicit, and copy its pattern into future CREATE TABLE migrations.", src: SRC.changelog
    });
    if (seqMissing.length) findings.push({
      level: seqMissing.some(function (x) { return x.o.isNew || x.live; }) ? "error" : "warn", id: "sequence", title: "Inserts need USAGE on " + seqMissing.length + " serial sequence" + (seqMissing.length > 1 ? "s" : ""),
      objects: seqMissing.map(function (x) { return keyOf(x.o) + " (" + x.seq.name + ")"; }),
      why: "A serial / bigserial column draws its id from a sequence. A role with INSERT on the table but no USAGE on the sequence gets \"permission denied for sequence\" (checked on Postgres 18). Identity columns (generated ... as identity) don't need this.",
      fix: "grant usage on sequence <name> to the roles that insert (included in the migration).", src: SRC.pgSeq
    });
    if (st.blanket.length) findings.push({
      level: "warn", id: "blanket", title: "Blanket grant re-exposes every table to " + uniq([].concat.apply([], st.blanket.map(function (b) { return b.roles; }))).join(" and "),
      code: st.blanket.map(function (b) { return b.at.path + ":" + b.at.line + "  " + b.code.replace(/\s+/g, " ").slice(0, 200); }).join("\n"),
      why: "GRANT ... ON ALL TABLES IN SCHEMA and ALTER DEFAULT PRIVILEGES ... TO anon/authenticated are the quick fix for 42501, and they bring back the old behaviour: every table, including ones without RLS, is reachable by anyone with the anon key.",
      fix: "Replace them with per-table grants (generated below) and, if needed, revoke ... on all tables in schema public from anon.", src: SRC.securing
    });
    if (viewsBypass.length) findings.push({
      level: "warn", id: "view-definer", title: viewsBypass.length + " view" + (viewsBypass.length > 1 ? "s bypass" : " bypasses") + " RLS when exposed",
      objects: viewsBypass.map(keyOf),
      why: "Views run with their owner's rights unless created with security_invoker, so RLS on the underlying tables doesn't apply to anon/authenticated callers. Supabase's Security Advisor flags these (security_definer_view).",
      fix: "alter view <name> set (security_invoker = true); before granting it to clients.", src: SRC.viewLint
    });
    var definers = Object.keys(st.funcs).map(function (k) { return st.funcs[k]; }).filter(function (f) { return exposed.indexOf(f.schema) >= 0 && f.definer && !f.trigger && f.exec.anon; });
    if (definers.length) findings.push({
      level: "warn", id: "definer-fn", title: definers.length + " SECURITY DEFINER function" + (definers.length > 1 ? "s" : "") + " callable with the anon key",
      objects: definers.map(function (f) { return f.schema + "." + f.name + (f.searchPath ? "" : " (no search_path)"); }),
      why: "Postgres gives EXECUTE on new functions to PUBLIC, and Oct 30 doesn't change that. A SECURITY DEFINER function in an exposed schema runs as its owner and is callable at /rest/v1/rpc by anyone, unless EXECUTE is revoked from public and anon.",
      fix: "revoke execute on function <name> from public, anon; then grant execute ... to authenticated only if signed-in users call it. Add set search_path = '' to the function.", src: SRC.definerLint
    });
    var openPol = [];
    objs.forEach(function (o) {
      (o.policies || []).forEach(function (p) {
        if (!p.permissive || ["all", "insert", "update", "delete"].indexOf(p.cmd) < 0) return;
        var toAnon = p.roles.some(function (r) { return r === "anon" || r === "public"; });
        var expr = (p.cmd === "insert" ? p.check : (p.using || p.check)) || "";
        if (toAnon && /^\(?\s*true\s*\)?$/i.test(expr.trim())) openPol.push(keyOf(o) + " (\"" + p.name + "\", " + p.cmd + ")");
      });
    });
    if (openPol.length) findings.push({
      level: "warn", id: "open-policy", title: openPol.length + " polic" + (openPol.length > 1 ? "ies let" : "y lets") + " anyone with the anon key write",
      objects: openPol,
      why: "These permissive policies apply to every role (no TO clause, or TO anon) and use true as the condition, so logged-out visitors can insert, change or delete rows. Grants generated from them would keep that open. Supabase's Security Advisor flags the same pattern (rls_policy_always_true).",
      fix: "Restrict the policy: add TO authenticated and a condition such as ((select auth.uid()) = user_id), then re-run this check.", src: SRC.rls
    });
    if (noPolicyUse.length) findings.push({
      level: "info", id: "no-policy", title: noPolicyUse.length + " call" + (noPolicyUse.length > 1 ? "s" : "") + " in your code that no RLS policy allows",
      objects: noPolicyUse.map(function (x) { return keyOf(x.o) + ": ." + x.op + "()"; }),
      why: "The client code calls these operations, but no permissive policy for anon or authenticated covers them, so they return empty results or an RLS error today. No grant is generated for them.",
      fix: "Add a policy if the call is meant to work, or remove the call.", src: SRC.rls
    });
    var unk = Object.keys(unknownTables).map(function (k) { return unknownTables[k]; });
    if (unk.length) findings.push({
      level: "info", id: "unknown-tables", title: unk.length + " table" + (unk.length > 1 ? "s" : "") + " used in code but not in your migrations",
      objects: unk.map(function (u) { return u.schema + "." + u.name + " (" + u.ops.join(", ") + ")"; }),
      why: "These were probably created in the Dashboard or Table Editor, so their RLS and grants aren't in the files checked. Supabase still treats them as existing tables (they keep their grants).",
      fix: "Run the read-only snapshot query below in the SQL Editor and paste the result, to include them with their real policies.", src: SRC.e42501
    });
    if (dynamic) findings.push({ level: "info", id: "dynamic", title: dynamic + " supabase-js call" + (dynamic > 1 ? "s use" : " uses") + " a table name from a variable", why: "Calls like .from(tableName) can't be matched to a table, so their operations aren't counted.", fix: "Check those tables by hand in the table below." });
    if (st.revokedDefaults) findings.push({ level: "info", id: "opted-in", title: "Your migrations already revoke the automatic grants", code: st.revokedDefaults.path + ":" + st.revokedDefaults.line, why: "Tables created after that statement already need explicit grants, the same behaviour Supabase turns on for everyone on Oct 30." });
    if (snap && autoNow) {
      var aroles = Object.keys(autoNow);
      findings.push(aroles.length
        ? { level: "info", id: "live-auto", title: "This project still auto-grants new tables to " + aroles.join(", "), why: "Its default privileges in public still hand new tables to the Data API roles. " + cutoffNote + " After that, new tables need the explicit grants shown here." }
        : { level: "info", id: "live-switched", title: "This project already uses explicit grants", why: "No default privileges hand new tables in public to anon or authenticated. Every new table needs a GRANT now." });
    }
    if (!migs.length && !snap) findings.push({ level: "warn", id: "no-sql", title: "No SQL migrations or snapshot found", why: "Without migrations or a snapshot this check can't see your tables, RLS or grants.", fix: "Add supabase/migrations/*.sql, or paste the snapshot from the SQL Editor." });
    st.errors.forEach(function (e) { findings.push({ level: "info", id: "parse", title: "Skipped a statement it couldn't read", code: e.path + ":" + e.line, why: e.message }); });

    var order = { error: 0, warn: 1, info: 2 };
    findings.sort(function (a, b) { return order[a.level] - order[b.level]; });
    return {
      exposed: exposed, objects: objs, findings: findings, funcs: st.funcs, calls: calls, hasCode: hasCode, codeFiles: codeFiles,
      migrationCount: migs.length, statementCount: stmtCount, snapshot: !!snap, unknownTables: unk,
      rpc: uniq(calls.filter(function (c) { return c.kind === "rpc"; }).map(function (c) { return c.schema + "." + c.name + (c.server ? "@server" : ""); }))
    };
  }
  function uniq(a) { var o = []; a.forEach(function (x) { if (o.indexOf(x) < 0) o.push(x); }); return o; }
  function summarize(findings) { var s = { error: 0, warn: 0, info: 0 }; findings.forEach(function (f) { s[f.level]++; }); return s; }

  // ---------------------------------------------------------------- outputs
  function stamp(d) {
    d = d || new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return "" + d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds());
  }
  function privList(ps) { return PRIVS.filter(function (p) { return ps.indexOf(p) >= 0; }).join(", "); }

  /** Build the migration. opts: { tighten: bool, includeServiceRole: bool, now: Date, title } */
  function buildMigration(report, opts) {
    opts = opts || {};
    var incSR = opts.includeServiceRole !== false;
    var L = [];
    var fname = "supabase/migrations/" + stamp(opts.now) + "_explicit_data_api_grants.sql";
    L.push("-- " + fname);
    L.push("-- Generated by Supabase Grants Check (" + (opts.title || "your project") + ").");
    L.push("-- Makes Data API access explicit so it no longer depends on the automatic grants");
    L.push("-- Supabase stops giving new tables on Oct 30, 2026. Grants decide whether a role can");
    L.push("-- reach a table at all; RLS policies still decide which rows. Review before applying.");
    L.push("-- Re-running a GRANT that already exists changes nothing.");
    var any = false;
    report.objects.forEach(function (o) {
      var name = qn(o.schema, o.name);
      var meta = [o.kind === "table" ? (o.rls ? "RLS on" : o.rls === false ? "RLS OFF" : "RLS ?") : (o.kind === "matview" ? "materialized view" : "view" + (o.securityInvoker ? ", security_invoker" : ", runs as owner"))];
      if (o.policies && o.policies.length) meta.push(o.policies.length + " polic" + (o.policies.length > 1 ? "ies" : "y"));
      if (o.usage.client.length) meta.push("client code: " + o.usage.client.join("/"));
      if (o.usage.server.length) meta.push("server code: " + o.usage.server.join("/"));
      L.push(""); L.push("-- " + o.schema + "." + o.name + " (" + meta.join("; ") + ")");
      var openTbl = o.kind === "table" && o.rls === false;
      var clientLines = [];
      CLIENT_ROLES.forEach(function (r) {
        var ps = o.rec[r];
        if (openTbl && hasCodeUse(o)) ps = uniq([].concat.apply([], o.usage.client.map(opPrivs)));
        if (ps.length) clientLines.push("grant " + privList(ps) + " on table " + name + " to " + r + ";");
      });
      if (openTbl && clientLines.length) {
        L.push("-- RLS is off: anyone with your anon key can read and write every row.");
        L.push("-- Enable RLS and add policies first, then uncomment what your app needs:");
        L.push("-- alter table " + name + " enable row level security;");
        var need = privList(uniq([].concat.apply([], o.usage.client.map(opPrivs))));
        L.push("-- grant " + need + " on table " + name + " to authenticated;");
        L.push("-- grant " + need + " on table " + name + " to anon;  -- only if logged-out visitors need it");
      } else if (openTbl) {
        L.push("-- RLS is off. No client grants: enable RLS and add policies before exposing it.");
      } else clientLines.forEach(function (l) { L.push(l); });
      if (incSR && o.rec.service_role.length) L.push("grant " + privList(o.rec.service_role) + " on table " + name + " to service_role;");
      (o.seqRec || []).forEach(function (sq) {
        var roles = sq.roles.filter(function (r) { return (r !== "service_role" || incSR) && !(openTbl && r !== "service_role"); });
        if (roles.length) L.push("grant usage on sequence " + qn(o.schema, sq.name) + " to " + roles.join(", ") + ";");
      });
      if (opts.tighten) {
        CLIENT_ROLES.forEach(function (r) {
          var extra = (o.current[r] || []).filter(function (p) { return o.rec[r].indexOf(p) < 0 && !(openTbl && false); });
          if (extra.length) L.push("revoke " + privList(extra) + " on table " + name + " from " + r + ";" + (o.live ? "" : " -- assumes the old default granted it"));
        });
      }
      if (o.kind === "view" && !o.securityInvoker && (o.rec.anon.length || o.rec.authenticated.length)) L.push("-- Consider first: alter view " + name + " set (security_invoker = true);");
      any = true;
    });
    // RPC functions called from client code
    var fnLines = [];
    report.rpc.forEach(function (id) {
      var server = /@server$/.test(id), k = id.replace(/@server$/, "");
      if (server) return;
      var f = report.funcs[k];
      var parts = k.split(".");
      if (f && f.definer) fnLines.push("-- " + k + " is SECURITY DEFINER: keep it from anon unless logged-out visitors call it.");
      fnLines.push("grant execute on function " + qn(parts[0], parts[1]) + " to authenticated;");
    });
    if (fnLines.length) { L.push(""); L.push("-- Functions your client code calls with .rpc() (EXECUTE on functions isn't affected by Oct 30;"); L.push("-- this just makes it explicit. Add argument types if a name is overloaded.)"); fnLines.forEach(function (l) { L.push(l); }); }
    if (!any) L.push("", "-- No tables found in the exposed schemas (" + report.exposed.join(", ") + ").");
    return { filename: fname, sql: L.join("\n") + "\n" };
  }
  function hasCodeUse(o) { return o.usage.client.length > 0; }

  var TEMPLATE = [
    "-- Pattern for every new table after Oct 30, 2026",
    "create table public.notes (",
    "  id bigint generated always as identity primary key,  -- identity: no sequence grant needed",
    "  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,",
    "  body text not null,",
    "  created_at timestamptz not null default now()",
    ");",
    "alter table public.notes enable row level security;",
    "create policy \"own notes\" on public.notes for all to authenticated",
    "  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);",
    "grant select, insert, update, delete on table public.notes to authenticated;",
    "grant select, insert, update, delete on table public.notes to service_role;",
    "-- grant select on table public.notes to anon;  -- only for data logged-out visitors may read"
  ].join("\n");

  function markdown(report, mig, title) {
    var L = ["# Supabase Oct 30 grants check: " + (title || "project"), "", "Checked with Supabase Grants Check (rules as of " + DATA_AS_OF + "). " + report.migrationCount + " migration file(s), " + report.codeFiles + " code file(s)" + (report.snapshot ? ", live snapshot" : "") + ".", ""];
    report.findings.forEach(function (f) {
      L.push("- [ ] **" + ({ error: "Breaks", warn: "Review", info: "Note" })[f.level] + ":** " + f.title);
      if (f.objects) L.push("  - " + f.objects.slice(0, 30).join(", ") + (f.objects.length > 30 ? " …" : ""));
      if (f.fix) L.push("  - Fix: " + f.fix);
    });
    L.push("", "## Tables", "", "| Table | RLS | Status | anon | authenticated |", "|---|---|---|---|---|");
    report.objects.forEach(function (o) { L.push("| `" + o.schema + "." + o.name + "` | " + (o.rls === null ? "view" : o.rls ? "on" : "**off**") + " | " + STATUS[o.status] + " | " + (o.rec.anon.join(", ") || "none") + " | " + (o.rec.authenticated.join(", ") || "none") + " |"); });
    L.push("", "## Migration (`" + mig.filename + "`)", "", "```sql", mig.sql.trim(), "```", "");
    return L.join("\n");
  }
  var STATUS = { open: "Open to anon key", breaks: "Breaks after Oct 30", auto: "Relies on auto-grant", missing: "Missing grants", ok: "Explicit" };

  function parseRepo(s) {
    s = (s || "").trim().replace(/\.git$/, "").replace(/\/+$/, "");
    var m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/tree\/(.+))?$/.exec(s) || /^([\w.-]+)\/([\w.-]+)$/.exec(s);
    if (!m) return null;
    return { owner: m[1], repo: m[2], ref: m[3] || null };
  }
  function fileKind(path) {
    if (/(^|\/)supabase\/config\.toml$/.test(path) || /^config\.toml$/.test(path)) return "config";
    if (/\.sql$/i.test(path)) return "sql";
    if (isCodePath(path)) return "code";
    return null;
  }

  /** Choose which files of a repo tree to read. tree: [{path,size,type}] */
  function pickRepoFiles(tree, maxCode) {
    maxCode = maxCode || 250;
    var blobs = tree.filter(function (t) { return t.type === "blob" && (t.size || 0) < 400000 && !SKIP_PATH.test(t.path); });
    var sql = blobs.filter(function (t) {
      return /\.sql$/i.test(t.path) && /(^|\/)supabase\/(migrations|schemas)\//.test(t.path) && !/(^|\/)(tests?|__tests__|fixtures?|examples?)\//.test(t.path.replace(/^.*?supabase\//, ""));
    });
    var cfg = blobs.filter(function (t) { return /(^|\/)supabase\/config\.toml$/.test(t.path); }).slice(0, 1);
    var code = blobs.filter(function (t) {
      return isCodePath(t.path) && !/(^|\/)(tests?|__tests__|e2e|cypress|playwright|fixtures?|stories|\.storybook|scripts)\//.test(t.path) && !/\.(test|spec|stories)\.[jt]sx?$/.test(t.path) && !/(^|\/)(database|supabase)\.types\.ts$|types\/supabase\.ts$/.test(t.path);
    });
    code.sort(function (a, b) { return score(b.path) - score(a.path); });
    function score(p) { return (/supabase|db|api|lib|hooks|services|actions|queries|server/i.test(p) ? 2 : 0) + (/^(src|app|lib|supabase)\//.test(p) ? 1 : 0); }
    return { sql: sql, config: cfg, code: code.slice(0, maxCode), codeTotal: code.length };
  }

  var SAMPLE = {
    title: "sample todo app",
    migrations: [
      { path: "supabase/migrations/20250114093000_init.sql", text: [
        "create table public.profiles (",
        "  id uuid primary key references auth.users on delete cascade,",
        "  username text unique,",
        "  avatar_url text",
        ");",
        "alter table public.profiles enable row level security;",
        "create policy \"Public profiles are viewable by everyone\" on public.profiles for select using (true);",
        "create policy \"Users update own profile\" on public.profiles for update to authenticated using ((select auth.uid()) = id);",
        "",
        "create table public.todos (",
        "  id bigserial primary key,",
        "  user_id uuid not null references auth.users default auth.uid(),",
        "  task text not null check (char_length(task) > 0),",
        "  done boolean default false",
        ");",
        "alter table public.todos enable row level security;",
        "create policy \"own todos\" on public.todos for all to authenticated",
        "  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);"
      ].join("\n") },
      { path: "supabase/migrations/20250302120000_feedback.sql", text: [
        "-- quick feedback table for the landing page",
        "create table public.feedback (id serial primary key, email text, message text, created_at timestamptz default now());",
        "create table public.admin_notes (id uuid primary key default gen_random_uuid(), note text);",
        "alter table public.admin_notes enable row level security;",
        "create view public.todo_stats as select user_id, count(*) as total, count(*) filter (where done) as done from public.todos group by user_id;"
      ].join("\n") },
      { path: "supabase/migrations/20261104101500_teams.sql", text: [
        "create table public.teams (",
        "  id bigint generated always as identity primary key,",
        "  name text not null,",
        "  owner_id uuid not null default auth.uid()",
        ");",
        "alter table public.teams enable row level security;",
        "create policy \"members read teams\" on public.teams for select to authenticated using (owner_id = (select auth.uid()));",
        "create policy \"owners create teams\" on public.teams for insert to authenticated with check (owner_id = (select auth.uid()));",
        "",
        "create or replace function public.team_count() returns bigint language sql security definer as $$",
        "  select count(*) from public.teams;",
        "$$;"
      ].join("\n") }
    ],
    code: [
      { path: "src/lib/todos.ts", text: [
        "import { supabase } from './supabase'",
        "export async function listTodos() {",
        "  const { data, error } = await supabase.from('todos').select('id, task, done').order('id')",
        "  if (error) throw error",
        "  return data",
        "}",
        "export const addTodo = (task: string) => supabase.from('todos').insert({ task }).select().single()",
        "export const toggle = (id: number, done: boolean) => supabase.from('todos').update({ done }).eq('id', id)",
        "export const remove = (id: number) => supabase.from('todos').delete().eq('id', id)",
        "export async function saveProfile(p) {",
        "  return supabase",
        "    .from('profiles')",
        "    .upsert(p)",
        "}",
        "export const profile = (id) => supabase.from('profiles').select('*').eq('id', id).single()",
        "export const sendFeedback = (email, message) => supabase.from('feedback').insert({ email, message })",
        "export const avatar = (path) => supabase.storage.from('avatars').getPublicUrl(path)"
      ].join("\n") },
      { path: "src/lib/teams.ts", text: [
        "import { supabase } from './supabase'",
        "export const myTeams = () => supabase.from('teams').select('id, name')",
        "export const createTeam = (name) => supabase.from('teams').insert({ name }).select('id').single()",
        "export const stats = () => supabase.from('todo_stats').select('*')",
        "export const count = () => supabase.rpc('team_count')"
      ].join("\n") },
      { path: "supabase/functions/cleanup/index.ts", text: [
        "import { createClient } from 'npm:@supabase/supabase-js@2'",
        "const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)",
        "Deno.serve(async () => {",
        "  await admin.from('admin_notes').insert({ note: 'cleanup ran' })",
        "  await admin.from('todos').delete().eq('done', true)",
        "  return new Response('ok')",
        "})"
      ].join("\n") }
    ]
  };

  return {
    DATA_AS_OF: DATA_AS_OF, CUTOFF_TS: CUTOFF_TS, SRC: SRC, SNAPSHOT_SQL: SNAPSHOT_SQL, TEMPLATE: TEMPLATE, SAMPLE: SAMPLE, STATUS: STATUS,
    splitSql: splitSql, scanCode: scanCode, opPrivs: opPrivs, policyPrivs: policyPrivs, requiresAuth: requiresAuth, parseConfigToml: parseConfigToml,
    parseSnapshot: parseSnapshot, analyze: analyze, summarize: summarize, buildMigration: buildMigration, markdown: markdown,
    parseRepo: parseRepo, fileKind: fileKind, pickRepoFiles: pickRepoFiles, isCodePath: isCodePath, stamp: stamp
  };
});
