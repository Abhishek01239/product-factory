# Launch drafts: Supabase Grants Check

Status: DRAFT, NOT PUBLISHED (no social accounts connected: X, Bluesky, Facebook Pages, Mastodon, Threads, Reddit and LinkedIn are disconnected).
Publish only after the live URL is verified. Image: `og.png` (1200x630, same as the site's social card; it shows the built-in sample app's real output). Source: `og-source.html`.
URL: https://abhishek01239.github.io/product-factory/supabase-grants-check/

Angle: useful first. Explain what changes on Oct 30, why GRANT ALL is the wrong fix, and the privilege rules people miss (update/delete/upsert need SELECT; serial needs sequence USAGE). The tool comes last. Facts: Supabase changelog + Postgres 18 tests run on 2026-10-13.

## X (thread)

1/ On Oct 30, Supabase stops auto-granting new public tables to anon, authenticated and service_role on every existing project. Nothing breaks that day. Your next `create table` does: 42501 "permission denied for table", even with the service_role key.

2/ The fix you'll see everywhere: `grant all on all tables in schema public to anon, authenticated`. That brings back the old default, including for tables that never had RLS turned on.

3/ What each supabase-js call actually needs (tested on Postgres 18):
- .select → SELECT
- .update/.delete with .eq() → UPDATE/DELETE plus SELECT
- .upsert → INSERT, UPDATE and SELECT
- bigserial id → USAGE on the sequence. Identity columns don't need it.

4/ I made a free checker. Point it at a public repo, your migrations folder or a read-only SQL snapshot. It replays your migrations, reads your RLS policies and supabase.from() calls, and writes a per-table GRANT migration. Runs in the browser, no email.
https://abhishek01239.github.io/product-factory/supabase-grants-check/

## Bluesky

Supabase's Oct 30 change: new public tables stop getting Data API grants automatically, on every existing project. Skip a GRANT and your next table returns 42501.

Don't fix it with GRANT ALL ON ALL TABLES. Free browser check that writes least-privilege grants from your own policies and supabase-js calls:
https://abhishek01239.github.io/product-factory/supabase-grants-check/

## Threads

If you build on Supabase (or with Lovable or Bolt), mark Oct 30. After that date new tables aren't reachable from your app until you GRANT them, and the error is 42501.

I built a free checker that reads your migrations and app code and tells you exactly which grants each table needs. It also flags tables where RLS is off. Nothing is uploaded.
https://abhishek01239.github.io/product-factory/supabase-grants-check/

## Reddit (r/Supabase): text post, only if the subreddit's self-promotion rules allow it

Title: Oct 30 grants change: what each supabase-js call actually needs (and a free checker)

On Oct 30 Supabase applies the explicit-grants default to existing projects (changelog: https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically). Existing tables keep their grants; new ones get none.

Things I verified on Postgres 18 while working out the right grants:
- `.update().eq()` and `.delete().eq()` need SELECT as well, because the filter reads columns.
- `.upsert()` needs INSERT, UPDATE and SELECT.
- `serial`/`bigserial` columns need `grant usage on sequence ...` for every role that inserts. `generated ... as identity` doesn't.
- service_role bypasses RLS but not grants.
- Policies `TO public` that check `auth.uid()` only matter for authenticated, so anon doesn't need the grant.

I put this into a free browser tool: it replays your migrations, reads `supabase.from()` calls (including embedded joins like `prices(*)`), and writes a per-table migration. RLS-off tables get commented-out lines, not grants. Repo or folder, no sign-up: https://abhishek01239.github.io/product-factory/supabase-grants-check/

It doesn't see Dashboard-created tables unless you run the read-only snapshot query it gives you. Feedback on false positives welcome.

## LinkedIn (only if explicitly configured)

Not drafted: LinkedIn is not configured for this factory.
