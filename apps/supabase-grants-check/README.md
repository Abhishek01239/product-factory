# Supabase Grants Check

Live: https://abhishek01239.github.io/product-factory/supabase-grants-check/

On **October 30, 2026** Supabase applies a new default to every existing project: tables created in `public` are no longer granted to `anon`, `authenticated` and `service_role` automatically (new projects have had this default since May 30, 2026). A table without an explicit `GRANT` fails every Data API request (supabase-js, REST, GraphQL, even with the service_role key) with `42501 permission denied for table`. Existing tables keep their grants. See the [Supabase changelog](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically) and [Securing your API](https://supabase.com/docs/guides/api/securing-your-api).

The common fix, `grant all on all tables in schema public to anon, authenticated`, brings back the old exposure, including tables that never had RLS enabled.

This tool works out the grants each table actually needs and writes them as a migration.

## What it does

1. **Replays your migrations** (`supabase/migrations/*.sql` in timestamp order, plus `supabase/schemas/*.sql`): tables, views, serial sequences, RLS on/off, policies (command, roles, `USING`/`WITH CHECK`), grants and revokes, `ALTER DEFAULT PRIVILEGES`, renames and drops, `SECURITY DEFINER` functions. Exposed schemas come from `supabase/config.toml` (`[api] schemas`), defaulting to `public`.
2. **Reads your supabase-js calls**: `.from('t').select/insert/update/upsert/delete`, tables embedded in select strings (`'*, prices(*)'`), `.schema('x')`, `.rpc('fn')`. Calls are server-side when the file uses the service-role key, an admin/service client, or lives in `supabase/functions/`. `storage.from()` is ignored.
3. **Optionally reads a live snapshot**: a read-only catalog query you run in the SQL Editor and paste back (tables, RLS, effective grants via `has_table_privilege`, policies, sequences, functions, default ACLs). Covers Dashboard-made tables and shows whether the project still auto-grants.
4. **Reports**: tables created after Oct 30 without grants (breaks), tables with RLS off that anon can reach, tables relying on the automatic grants, serial sequences missing `USAGE`, blanket grants / default-privilege rollbacks, views without `security_invoker`, `SECURITY DEFINER` functions executable by anon, policies that let anon write with `true`, code calls no policy allows, tables used in code but missing from migrations.
5. **Writes a migration** (`supabase/migrations/<timestamp>_explicit_data_api_grants.sql`): per-table grants = operations your client code performs, limited to roles your policies allow (policies `TO public` that depend on `auth.uid()` count for `authenticated` only). Without code, grants mirror the policies. `service_role` gets full access by default. RLS-off tables get commented-out lines only. Optional revokes for access nobody needs.

### Privilege rules (verified on PostgreSQL 18)

| supabase-js | Needs |
|---|---|
| `select` | SELECT |
| `insert` | INSERT (+ SELECT when `.select()` is chained) |
| `update` / `delete` with filters | UPDATE / DELETE + SELECT |
| `upsert` | INSERT + UPDATE + SELECT |
| `serial` / `bigserial` id | USAGE on the sequence for inserting roles |
| identity column | nothing extra |

## Verification done

- 18 unit tests: `node --test apps/supabase-grants-check/tests/`
- End to end on PostgreSQL 18 with simulated Supabase roles and the new default: the sample app's migrations alone give 42501 for every call; after the generated migration every app operation works and anon stays blocked from private tables.
- Snapshot query executed on PostgreSQL 18 and parsed back.
- Generated migration applied cleanly after the real migrations of `vercel/nextjs-subscription-payments`.
- Run against public repos: `vercel/nextjs-subscription-payments`, `mckaywrigley/chatbot-ui`, `KolbySisk/next-supabase-stripe-starter` and several Lovable-generated apps.

## Limits

Table names in variables (`.from(name)`), raw `fetch('/rest/v1/...')`, SQL run outside migrations (use the snapshot), and complex policy logic (only `auth.uid()`-style checks are recognised) are not analysed. Review the migration before applying it.

## Privacy

Static page, no backend, no analytics. Files are analysed in the browser. Repo checks use GitHub's public API without a token. The page never asks for database URLs or keys. CSP allows only `api.github.com` and `raw.githubusercontent.com`.

## Files

`index.html` · `app.js` (UI) · `rules.js` (engine, UMD; works in Node) · `styles.css` · `privacy.html` · `sw.js` · `manifest.webmanifest` · icons · `og.png` · `tests/`

Not affiliated with Supabase.
