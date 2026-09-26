-- ─────────────────────────────────────────────────────────────────────────────
-- The live body of app.write_audit — read-only, one row.
--
-- The agent preflight (2026-09-27) found the live function differs from
-- 0020_audit_triggers.sql (2548 chars vs 2491). 0068 replaces this function to
-- add EdgeAI attribution, so whatever the live version does differently has
-- to be carried over first, or applying 0068 would silently undo it.
--
-- Run in the Supabase SQL editor and copy the single `body` cell back.
-- ─────────────────────────────────────────────────────────────────────────────
select md5(replace(p.prosrc, E'\r', '')) as lf_md5,
       length(p.prosrc)                   as len,
       p.prosrc                           as body,
       pg_get_function_identity_arguments(p.oid) as args,
       p.proconfig                        as config
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app' and p.proname = 'write_audit';
