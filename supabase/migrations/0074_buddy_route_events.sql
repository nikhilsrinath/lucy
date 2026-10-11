-- ============================================================================
-- 0074_buddy_route_events.sql — what Buddy's local router decided, per message.
--
-- Buddy now reads each message before any model is called
-- (api/_lib/agent/local): what a business function can answer is answered
-- from the records, and only the rest reaches the model. This table is the
-- record of those decisions, so the lexicon and the evaluation set can be
-- improved from real use.
--
-- It deliberately holds NO message content: no words, no names, no amounts,
-- no arguments. One row is
--
--   intent        the intent the message was read as (a fixed vocabulary)
--   route         local | clarify | llm | shadow
--   reason_code   why (needs_model, unresolved, answered, declined_reading …)
--   confidence    0–1
--   clarified     a question was asked
--   llm_used      the model was called for this message
--   latency_ms, ok, error_kind
--   signature     the CONCEPTS the message was read as and how many words
--                 were left unexplained ("INVOICE+UNPAID|r1") — enough to see
--                 which kinds of phrasing keep reaching the model, without
--                 anybody's sentence being stored
--   corrected_to  the intent the person chose when asked "did you mean…?"
--
-- Rows are written by the API with the service role only. Owners and admins
-- (anyone who may see usage) can read their own company's. Rows older than
-- 90 days are removed by prune_buddy_route_events(), which the daily worker
-- wake-up calls.
--
-- The router works without this table: api/_lib/agent/local/telemetry.js logs
-- to the platform log and stops trying to insert when the table is missing.
--
-- Idempotent: safe to run more than once.
-- ============================================================================

create table if not exists public.buddy_route_events (
  id            bigint generated always as identity primary key,
  org_id        uuid not null references public.organizations(id) on delete cascade,
  user_id       uuid references auth.users(id) on delete set null,
  channel       text not null default 'chat',
  intent        text not null,
  route         text not null check (route in ('local', 'clarify', 'llm', 'shadow')),
  reason_code   text,
  confidence    numeric(3, 2) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  clarified     boolean not null default false,
  llm_used      boolean not null default false,
  latency_ms    integer check (latency_ms is null or latency_ms >= 0),
  ok            boolean not null default true,
  error_kind    text,
  signature     text,
  corrected_to  text,
  tokens        integer check (tokens is null or tokens >= 0),
  created_at    timestamptz not null default now()
);

create index if not exists buddy_route_events_org_time_idx
  on public.buddy_route_events (org_id, created_at desc);
create index if not exists buddy_route_events_route_idx
  on public.buddy_route_events (route, created_at desc);

alter table public.buddy_route_events enable row level security;

drop policy if exists buddy_route_events_select on public.buddy_route_events;
create policy buddy_route_events_select on public.buddy_route_events
  for select to authenticated
  using (app.has_permission(org_id, 'usage_counters', 'view'));

-- 0022 hands authenticated default privileges on new tables; take the writes
-- back so the policy above is not the only thing standing in the way.
revoke all on public.buddy_route_events from anon;
revoke insert, update, delete, truncate on public.buddy_route_events from authenticated;
grant select on public.buddy_route_events to authenticated;
grant all on public.buddy_route_events to service_role;

comment on table public.buddy_route_events is
  'One row per chat message: how the local router handled it (no message content). Kept 90 days.';

-- Retention. Called by the scheduled worker; safe to call by hand.
create or replace function public.prune_buddy_route_events(p_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  removed integer;
begin
  delete from public.buddy_route_events
   where created_at < now() - make_interval(days => greatest(coalesce(p_days, 90), 7));
  get diagnostics removed = row_count;
  return removed;
end
$fn$;

revoke all on function public.prune_buddy_route_events(integer) from public, anon, authenticated;
grant execute on function public.prune_buddy_route_events(integer) to service_role;

-- What keeps reaching the model, by signature: the worklist for the lexicon.
create or replace view public.buddy_route_summary
with (security_invoker = true) as
select org_id,
       date_trunc('day', created_at)::date as day,
       route,
       intent,
       signature,
       count(*)                                   as messages,
       count(*) filter (where llm_used)           as model_calls,
       count(*) filter (where not ok)             as failures,
       count(*) filter (where corrected_to is not null and corrected_to <> intent) as corrected,
       round(avg(latency_ms))                     as avg_latency_ms
  from public.buddy_route_events
 group by 1, 2, 3, 4, 5;

grant select on public.buddy_route_summary to authenticated;
