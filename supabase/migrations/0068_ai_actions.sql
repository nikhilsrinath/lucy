-- ============================================================================
-- 0068_ai_actions.sql — the EdgeAI agent's action log and its audit attribution.
--
-- EdgeAI (api/agent.js) now operates the app: it proposes changes as cards,
-- and executes one only after the user taps Confirm. Two things follow.
--
-- 1. public.ai_actions — one row per proposed change, carrying what was
--    proposed (tool, resolved args, the preview the user saw), what became
--    of it (proposed → confirmed → executed / failed / cancelled / expired /
--    undone) and the before/after state that Undo restores. The row id is
--    the idempotency key for the confirm tap.
--
--    Written ONLY by the API with the service role. The browser may read its
--    own rows (and owner/admin every row in the org, for the AI activity
--    log); nobody may insert, edit or delete one from the client.
--
-- 2. Attribution. The agent writes business rows through PostgREST with the
--    user's own token, so the audit trigger already records the user as the
--    actor. A confirmed write also sends `x-edgeos-agent-action: <id>`, which
--    PostgREST exposes as request.headers; app.write_audit now stamps such
--    rows `via = 'edgeai'` with the action id — but only when that id is a
--    confirmed/executed action belonging to auth.uid(). A client forging the
--    header can at most mislabel its own edit, never anybody else's.
--
-- PREFLIGHT: supabase/checks/agent_preflight.sql. Apply only once it shows
-- app.write_audit unchanged from 0020 (section 86: lf_md5 ee442a92…), no
-- ai_actions collision (18) and no extra audit_log columns (133). If the live
-- body differs, supabase/checks/write_audit_live.sql returns it: whatever it
-- does beyond 0020 must be carried into section 4 below before applying.
--
-- Idempotent: safe to run more than once.
-- ============================================================================

-- ─── 1. The table ────────────────────────────────────────────────────────────

create table if not exists public.ai_actions (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,
  chat_id        text,
  message_id     text,
  tool           text not null,
  module         text,
  risk           text not null check (risk in ('low', 'high')),
  args           jsonb not null default '{}'::jsonb,
  target_ref     jsonb,
  preview        jsonb,
  status         text not null default 'proposed'
                 check (status in ('proposed', 'confirmed', 'executed', 'failed', 'cancelled', 'expired', 'undone')),
  before_state   jsonb,
  after_state    jsonb,
  result         jsonb,
  error          text,
  prompt_version text,
  proposed_at    timestamptz not null default now(),
  decided_at     timestamptz,
  executed_at    timestamptz,
  undone_at      timestamptz,
  expires_at     timestamptz not null default (now() + interval '30 minutes'),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists ai_actions_org_time_idx  on public.ai_actions (org_id, proposed_at desc);
create index if not exists ai_actions_user_chat_idx on public.ai_actions (user_id, chat_id, status);

drop trigger if exists ai_actions_touch on public.ai_actions;
create trigger ai_actions_touch before update on public.ai_actions
  for each row execute function app.touch_updated_at();

comment on table public.ai_actions is
  'Every change EdgeAI proposed and what became of it. Written by /api/agent with the service role only.';

-- ─── 2. Permission resource (the 0038 repair pattern, idempotent) ────────────

insert into public.permission_resources (key, label, category, description, actions, sort_order) values
  ('ai_actions', 'AI activity', 'Settings',
   'Changes EdgeAI proposed and made. Everyone sees their own; owners and admins see the whole organization''s.',
   array['view'], 905)
on conflict (key) do update
  set label = excluded.label, category = excluded.category,
      description = excluded.description, actions = excluded.actions;

insert into public.role_permission_defaults (role, resource, can_view, can_create, can_edit, can_delete)
select r.key, 'ai_actions', true, false, false, false
  from public.roles r
on conflict (role, resource) do nothing;

select app.sync_role_permissions(null);

-- ─── 3. Row-level security ───────────────────────────────────────────────────
-- secure_tenant_table enables and forces RLS and builds the matrix policy
-- (view only — the resource's only action). Its select policy is then
-- narrowed to the reader's own rows unless they are an owner or admin.
-- One permissive policy rather than an extra RESTRICTIVE one, because the
-- access-matrix evaluator (tests/02) models permissive policies only.
-- NOTE: re-running secure_tenant_table on this table would widen it again;
-- re-run this block after any such repair.

select app.secure_tenant_table('public.ai_actions'::regclass, 'ai_actions');

drop policy if exists ai_actions_own_rows on public.ai_actions;
drop policy if exists ai_actions_select on public.ai_actions;
create policy ai_actions_select on public.ai_actions
  for select to authenticated
  using (app.has_permission(org_id, 'ai_actions', 'view')
         and (user_id = auth.uid() or app.is_admin(org_id)));

revoke all on public.ai_actions from anon;
revoke insert, update, delete, truncate on public.ai_actions from authenticated;
grant select on public.ai_actions to authenticated;
grant all on public.ai_actions to service_role;

-- ─── 4. Audit attribution ────────────────────────────────────────────────────

alter table public.audit_log add column if not exists via text;
alter table public.audit_log add column if not exists ai_action_id uuid;
comment on column public.audit_log.via is
  'null = written directly by the actor; ''edgeai'' = written by EdgeAI on the actor''s behalf after they confirmed it.';

-- The agent action behind the current request, if it is one this user
-- confirmed. Never raises: an audit row with no attribution beats a failed write.
create or replace function app.agent_action_id()
returns uuid language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_raw text;
  v_id  uuid;
begin
  begin
    v_raw := nullif(current_setting('request.headers', true), '')::json ->> 'x-edgeos-agent-action';
  exception when others then
    return null;
  end;
  if v_raw is null or v_raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  select a.id into v_id
    from public.ai_actions a
   where a.id = v_raw::uuid
     and a.user_id = auth.uid()
     and a.status in ('confirmed', 'executed');
  return v_id;
end $$;

revoke execute on function app.agent_action_id() from public;

-- 0020's trigger, unchanged except for the two attribution columns.
create or replace function app.write_audit()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org       uuid;
  v_entity    uuid;
  v_action    text;
  v_diff      jsonb := '{}'::jsonb;
  v_old       jsonb;
  v_new       jsonb;
  v_key       text;
  v_ignored   text[] := app.audit_ignored_columns();
  v_agent     uuid;
begin
  if tg_op = 'DELETE' then
    v_old := to_jsonb(old);
    v_new := '{}'::jsonb;
    v_org := (v_old ->> 'org_id')::uuid;
    v_entity := app.audit_entity_id(v_old);
    v_action := tg_table_name || '.delete';
  elsif tg_op = 'INSERT' then
    v_old := '{}'::jsonb;
    v_new := to_jsonb(new);
    v_org := (v_new ->> 'org_id')::uuid;
    v_entity := app.audit_entity_id(v_new);
    v_action := tg_table_name || '.insert';
  else
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    v_org := (v_new ->> 'org_id')::uuid;
    v_entity := app.audit_entity_id(v_new);
    v_action := tg_table_name || '.update';
  end if;

  if tg_op = 'UPDATE' then
    for v_key in select jsonb_object_keys(v_new) loop
      if v_key = any(v_ignored) then
        continue;
      end if;
      if (v_new -> v_key) is distinct from (v_old -> v_key) then
        v_diff := v_diff || jsonb_build_object(
          v_key, jsonb_build_object('from', v_old -> v_key, 'to', v_new -> v_key)
        );
      end if;
    end loop;

    if v_diff = '{}'::jsonb then
      return null;
    end if;
  else
    v_diff := jsonb_strip_nulls(jsonb_build_object(
      'name',       coalesce(v_new -> 'name',       v_old -> 'name'),
      'title',      coalesce(v_new -> 'title',      v_old -> 'title'),
      'full_name',  coalesce(v_new -> 'full_name',  v_old -> 'full_name'),
      'doc_number', coalesce(v_new -> 'doc_number', v_old -> 'doc_number'),
      'status',     coalesce(v_new -> 'status',     v_old -> 'status'),
      'amount',     coalesce(v_new -> 'amount',     v_old -> 'amount')
    ));
  end if;

  v_agent := app.agent_action_id();

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, diff, via, ai_action_id)
  values (v_org, auth.uid(), v_action, tg_table_name, v_entity, v_diff,
          case when v_agent is not null then 'edgeai' end, v_agent);

  return null;
exception when others then
  raise warning 'audit trigger on % failed: %', tg_table_name, sqlerrm;
  return null;
end $$;

drop trigger if exists ai_actions_audit on public.ai_actions;
create trigger ai_actions_audit after insert or update or delete on public.ai_actions
  for each row execute function app.write_audit();

-- ─── 5. Realtime for what the agent changes ─────────────────────────────────
-- A confirmed change must reach every open screen. orgStore already listens
-- for postgres_changes on these sections, but the live publication (preflight
-- 2026-09-27) carries only the brain, project, timesheet and version tables —
-- so an edit to a task, a client, a cash entry, an invoice, a payment, a bill
-- or a vendor reached other tabs and other people only on reload, whoever made
-- it. Same idempotent block as 0045.
-- Realtime applies each table's RLS, so nobody receives a row they could not read.
do $mig$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  foreach t in array array['tasks', 'clients', 'expenses', 'income_entries',
                           'financial_documents', 'payments', 'purchase_invoices', 'vendors'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $mig$;
