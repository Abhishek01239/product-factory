"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../rules.js");

const run = (sql, code, extra) => S.analyze(Object.assign({ migrations: [{ path: "supabase/migrations/20250101000000_init.sql", text: sql }], code: code ? [{ path: "src/app.ts", text: code }] : [] }, extra || {}));
const ids = (r) => r.findings.map((f) => f.level + ":" + f.id);
const obj = (r, name) => r.objects.find((o) => o.name === name);

test("splitSql keeps dollar-quoted bodies, drops comments, tracks lines", () => {
  const st = S.splitSql("-- c1\ncreate table a (x int); /* block ; */\ncreate function f() returns int language plpgsql as $fn$ begin perform 1; return 2; end $fn$;\nselect 'a;b';");
  assert.equal(st.length, 3);
  assert.equal(st[0].line, 2);
  assert.match(st[1].text, /perform 1; return 2;/);
  assert.equal(st[1].line, 3);
  assert.equal(st[2].text, "select 'a;b'");
});

test("sample: new table after Oct 30, RLS-off table, auto-grant reliance, view, definer function", () => {
  const r = S.analyze({ migrations: S.SAMPLE.migrations, code: S.SAMPLE.code });
  const got = ids(r);
  for (const id of ["error:after-cutoff", "error:rls-off", "warn:relies-on-auto", "warn:view-definer", "warn:definer-fn", "info:no-policy"]) assert.ok(got.includes(id), id + " missing: " + got.join(","));
  assert.equal(obj(r, "teams").status, "breaks");
  assert.equal(obj(r, "feedback").status, "open");
  assert.deepEqual(obj(r, "todos").rec.authenticated, ["select", "insert", "update", "delete"]);
  assert.deepEqual(obj(r, "todos").rec.anon, []);
  assert.deepEqual(obj(r, "profiles").rec.anon, ["select"]);
  assert.deepEqual(obj(r, "teams").rec.authenticated, ["select", "insert"]);
  assert.deepEqual(obj(r, "admin_notes").usage.server, ["insert"]);
  assert.deepEqual(r.rpc, ["public.team_count"]);
});

test("supabase-js scanning: storage ignored, multi-line chains, admin clients are server-side", () => {
  const sc = S.scanCode("src/a.ts", "const a = supabase.storage.from('avatars').upload(p)\nawait supabase\n  .from('posts')\n  .update({ a: 1 })\n  .eq('id', 1)\nconst b = supabaseAdmin.from('logs').insert(x)\nconst c = [1].from('x')\nArray.from('abc')\n");
  const t = sc.calls.filter((c) => c.kind === "table");
  assert.deepEqual(t.map((c) => c.name), ["posts", "logs"]);
  assert.deepEqual(t[0].ops, ["update"]);
  assert.equal(t[0].server, false);
  assert.equal(t[1].server, true);
  assert.equal(S.scanCode("supabase/functions/x/index.ts", "db.from('a').select()").calls[0].server, true);
  assert.equal(S.scanCode("src/x.ts", "Promise.all([sb.from('a').select(), sb.from('b').delete().eq('id',1)])").calls.map((c) => c.name + ":" + c.ops).join(" "), "a:select b:delete");
});

test("privileges an operation needs (verified on Postgres 18)", () => {
  assert.deepEqual(S.opPrivs("update"), ["update", "select"]);
  assert.deepEqual(S.opPrivs("delete"), ["delete", "select"]);
  assert.deepEqual(S.opPrivs("upsert"), ["insert", "update", "select"]);
  assert.deepEqual(S.opPrivs("insert"), ["insert"]);
});

test("without code, grants mirror the policies; update/delete imply select", () => {
  const r = run("create table public.posts (id bigint generated always as identity primary key, user_id uuid, body text);\nalter table public.posts enable row level security;\ncreate policy p1 on public.posts for select using (true);\ncreate policy p2 on public.posts for delete to authenticated using (auth.uid() = user_id);");
  const o = obj(r, "posts");
  assert.deepEqual(o.rec.anon, ["select"]);
  assert.deepEqual(o.rec.authenticated, ["select", "delete"]);
  assert.equal(o.seqRec.length, 0, "identity columns need no sequence grant");
});

test("policies TO public that use auth.uid() don't grant anon", () => {
  assert.ok(S.requiresAuth("(select auth.uid()) = user_id"));
  assert.ok(!S.requiresAuth("true"));
  assert.ok(!S.requiresAuth("auth.uid() is null or published"));
  const r = run("create table todos (id int primary key, user_id uuid);\nalter table todos enable row level security;\ncreate policy own on todos using (auth.uid() = user_id);");
  assert.deepEqual(obj(r, "todos").rec.anon, []);
  assert.deepEqual(obj(r, "todos").rec.authenticated, ["select", "insert", "update", "delete"]);
});

test("explicit grants are recognised; serial without sequence usage is flagged", () => {
  const r = run("create table public.items (id serial primary key, name text);\nalter table public.items enable row level security;\ncreate policy i on public.items for insert to authenticated with check (true);\ngrant insert on public.items to authenticated;");
  const o = obj(r, "items");
  assert.equal(o.status, "missing");
  assert.deepEqual(o.missingRoles, ["service_role"]);
  assert.ok(ids(r).includes("warn:sequence"));
  const mig = S.buildMigration(r, {}).sql;
  assert.match(mig, /grant usage on sequence public\.items_id_seq to authenticated, service_role;/);
  const r2 = run("create table public.items (id serial primary key);\ngrant insert on public.items to authenticated;\ngrant usage on sequence public.items_id_seq to authenticated;");
  assert.ok(!ids(r2).includes("warn:sequence"));
});

test("blanket grants and default-privilege rollbacks are flagged", () => {
  const r = run("create table a (id int);\ngrant all on all tables in schema public to anon, authenticated;");
  assert.ok(ids(r).includes("warn:blanket"));
  const r2 = run("alter default privileges in schema public grant all on tables to anon, authenticated, service_role;\ncreate table b (id int);");
  assert.ok(ids(r2).includes("warn:blanket"));
  assert.deepEqual(obj(r2, "b").grants.anon, ["select", "insert", "update", "delete"]);
  const r3 = run("alter default privileges for role postgres in schema public revoke select, insert, update, delete on tables from anon, authenticated, service_role;\ncreate table c (id int);");
  assert.ok(ids(r3).includes("info:opted-in"));
});

test("drop, rename and revoke are replayed in order", () => {
  const r = run("create table old_name (id int);\nalter table old_name rename to new_name;\ncreate table gone (id int);\ndrop table if exists gone cascade;\ncreate table t (id int);\ngrant select on t to anon;\nrevoke select on t from anon;");
  assert.deepEqual(r.objects.map((o) => o.name), ["new_name", "t"]);
  assert.deepEqual(obj(r, "t").explicit.anon, []);
});

test("definer function: revoke from public and anon clears the warning", () => {
  const sql = "create function public.f() returns int language sql security definer set search_path = '' as $$ select 1 $$;";
  assert.ok(ids(run(sql)).includes("warn:definer-fn"));
  assert.ok(ids(run(sql + "\nrevoke execute on function public.f from anon;")).includes("warn:definer-fn"), "PUBLIC still grants it");
  assert.ok(!ids(run(sql + "\nrevoke execute on function public.f() from public, anon;")).includes("warn:definer-fn"));
});

test("views: security_invoker detected", () => {
  const r = run("create table t (id int);\ncreate view v with (security_invoker = true) as select * from t;\ncreate view w as select * from t;", "sb.from('v').select(); sb.from('w').select()");
  assert.equal(obj(r, "v").securityInvoker, true);
  assert.deepEqual(r.findings.find((f) => f.id === "view-definer").objects, ["public.w"]);
});

test("config.toml schemas and mixed-case identifiers", () => {
  assert.deepEqual(S.parseConfigToml('[api]\nenabled = true\nschemas = ["public", "graphql_public", "api"]\n'), ["public", "api"]);
  const r = S.analyze({ migrations: [{ path: "supabase/migrations/20250101000000_a.sql", text: 'create table api."UserEvents" (id int);\ncreate table private.secret (id int);' }], configText: '[api]\nschemas = ["api"]' });
  assert.deepEqual(r.objects.map((o) => o.schema + "." + o.name), ["api.UserEvents"]);
  assert.match(S.buildMigration(r, {}).sql, /on table api\."UserEvents" to service_role;/);
});

test("tables used in code but missing from migrations are reported", () => {
  const r = run("create table a (id int);", "sb.from('dashboard_table').select('*')");
  assert.ok(ids(r).includes("info:unknown-tables"));
});

test("snapshot parsing tolerates CSV-doubled quotes and reports live state", () => {
  const snap = { tool: "supabase-grants-check", version: 1, tables: [{ schema: "public", name: "open", kind: "r", rls: false, options: [], grants: { anon: ["select"], authenticated: [], service_role: ["select"] } }], policies: [], sequences: [], functions: [], default_acl: [{ owner: "postgres", schema: "public", type: "r", acl: ["anon=arwdDxtm/postgres"] }] };
  const csv = '"snapshot"\n"' + JSON.stringify(snap).replace(/"/g, '""') + '"';
  const p = S.parseSnapshot(csv);
  assert.equal(p.tables.length, 1);
  const r = S.analyze({ snapshotText: JSON.stringify(snap) });
  assert.ok(ids(r).includes("error:rls-off"));
  assert.ok(ids(r).includes("info:live-auto"));
  assert.throws(() => S.parseSnapshot("hello"), /doesn't contain JSON/);
  assert.throws(() => S.parseSnapshot('{"a":1}'), /isn't a Supabase Grants Check snapshot/);
});

test("RLS-off tables never get live client grants in the migration", () => {
  const r = run("create table public.leads (id bigint generated always as identity primary key, email text);", "sb.from('leads').insert({ email })");
  const sql = S.buildMigration(r, {}).sql;
  assert.ok(!/^grant [^\n]* to (anon|authenticated);/m.test(sql));
  assert.match(sql, /^-- grant insert on table public\.leads to anon;/m);
});

test("parseRepo and fileKind", () => {
  assert.deepEqual(S.parseRepo("https://github.com/a/b/tree/dev"), { owner: "a", repo: "b", ref: "dev" });
  assert.deepEqual(S.parseRepo("a/b"), { owner: "a", repo: "b", ref: null });
  assert.equal(S.parseRepo("nope"), null);
  assert.equal(S.fileKind("supabase/migrations/1_x.sql"), "sql");
  assert.equal(S.fileKind("supabase/config.toml"), "config");
  assert.equal(S.fileKind("node_modules/x/index.js"), null);
  assert.equal(S.fileKind("src/App.tsx"), "code");
});

test("embedded resources in select strings count as reads", () => {
  const sc = S.scanCode("src/q.ts", "sb.from('products').select('*, prices(*), author:profiles!author_id(name), count()').eq('active', true)");
  assert.deepEqual(sc.calls.map((c) => c.name), ["products", "prices", "profiles"]);
  const r = run("create table products (id int);\nalter table products enable row level security;\ncreate policy a on products for select using (true);\ncreate table prices (id int);\nalter table prices enable row level security;\ncreate policy b on prices for select using (true);", "sb.from('products').select('*, prices(*)')");
  assert.deepEqual(obj(r, "prices").rec.anon, ["select"]);
});

test("policies open to anon for writes are flagged", () => {
  const r = run("create table t (id int);\nalter table t enable row level security;\ncreate policy \"Allow all for demo\" on public.t for all using (true) with check (true);");
  assert.ok(ids(r).includes("warn:open-policy"));
  const r2 = run("create table t (id int);\nalter table t enable row level security;\ncreate policy p on public.t for all to authenticated using (true);");
  assert.ok(!ids(r2).includes("warn:open-policy"));
});
