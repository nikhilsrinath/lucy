-- ============================================================================
-- 0072_buddy_autonomy.sql — the Autonomous Buddy Engine.
--
-- Until now every change Buddy made waited for a person's tap (ai_actions:
-- proposed → confirmed → executed). This migration adds the durable layer
-- that lets Buddy keep working between requests, WITHOUT a second agent,
-- action system, permission model or audit trail:
--
--   buddy_jobs               the one durable job/event queue. A job is a
--                            meaningful business event that has become due
--                            (task_due_soon, task_overdue, workflow_check_due,
--                            reminder_due, pulse_due, …). A deterministic
--                            dedupe_key per company makes enqueueing
--                            idempotent; buddy_claim_jobs() hands a due job to
--                            exactly one worker (FOR UPDATE SKIP LOCKED + a
--                            lease), so two cron invocations never run the
--                            same job; a crashed worker's lease expires and
--                            the job is retried, up to max_attempts.
--   buddy_workflows          long-running follow-through ("make sure Swetha
--                            follows up with the sponsor tomorrow"): the
--                            task, who is responsible, who asked, the
--                            escalation thresholds and what was already said,
--                            so it continues across invocations, deploys
--                            and days, and never repeats a message.
--   buddy_autonomy_policies  per company: may Buddy act on its own at all
--                            (the kill switch), per-tool overrides, and the
--                            thresholds (reminder lead time, escalation
--                            delay, quiet hours, daily message cap). Readable
--                            by the company, written only by the API after
--                            an owner/admin check.
--
-- ai_actions stays the one action log. An autonomous action is an ordinary
-- row that skipped the human tap because the policy allowed it:
-- autonomous = true, policy_decision says which rule allowed it, job_id and
-- workflow_id say what caused it, idempotency_key makes a retried job find
-- its earlier attempt instead of repeating a side effect.
--
-- The Buddy principal. Work nobody asked for directly (a deadline reminder,
-- an escalation) must not run as an anonymous global admin, nor as a person
-- who did not ask. The API signs a short-lived token with role
-- 'authenticated', NO sub, and one claim, sb_buddy { org }. The database
-- trusts it only for that company, only while the company exists and its
-- autonomy is not switched off (checked on every query, so the kill switch
-- also stops tokens already issued), and grants it a fixed operational set:
-- view tasks / people / projects / notifications, create and edit tasks and
-- notifications — intersected with what the company's admin role holds.
-- Never delete, never money, clients, pay or governance. Every RLS policy and
-- guard applies to it as to anyone (has_permission, is_signed_in).
--
-- Audit: audit_log.via is 'edgeai' for a human-confirmed Buddy action (as
-- before) and 'edgeai_auto' for an autonomous one; actor_system = 'buddy'
-- when the Buddy principal made the write.
--
-- Idempotent: safe to run more than once.
-- ============================================================================

-- ─── 1. Keys composite FKs can name ──────────────────────────────────────────

create unique index if not exists tasks_id_org_key on public.tasks (id, org_id);

-- ─── 2. Company autonomy policy ──────────────────────────────────────────────

create table if not exists public.buddy_autonomy_policies (
  org_id      uuid primary key references public.organizations(id) on delete cascade,
  -- The kill switch. false = Buddy never acts on its own for this company
  -- and the Buddy principal is refused by the database.
  enabled     boolean not null default true,
  -- Per-tool overrides: { "<tool>": "autonomous" | "approval" | "off" }.
  -- The server only ever lets these narrow a tool's class, or widen a
  -- low-risk, non-deleting, internal tool — never money, deletes or email.
  rules       jsonb not null default '{}'::jsonb check (jsonb_typeof(rules) = 'object'),
  -- Thresholds (see api/_lib/autonomy/policy.js DEFAULT_SETTINGS).
  settings    jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  version     integer not null default 1,
  updated_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.buddy_autonomy_policies is
  'What Buddy may do on its own in this company. No row = the server default policy. Written only by /api/agent after an owner/admin check.';

-- ─── 3. Workflows ────────────────────────────────────────────────────────────

create table if not exists public.buddy_workflows (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references public.organizations(id) on delete cascade,
  kind                   text not null check (kind in ('task_followup')),
  status                 text not null default 'active'
                         check (status in ('active', 'completed', 'escalated', 'cancelled', 'failed')),
  task_id                uuid,
  assignee_employee_id   uuid,
  -- Who asked. Exactly the identities an action can have.
  initiator_kind         text not null check (initiator_kind in ('user', 'person', 'buddy')),
  initiator_user_id      uuid references auth.users(id) on delete set null,
  initiator_employee_id  uuid,
  goal                   text check (goal is null or length(goal) <= 500),
  -- Threshold snapshot at creation (so a later policy edit is explicit).
  policy                 jsonb not null default '{}'::jsonb,
  -- What happened so far: phase, deadline seen, reminded/followed-up/escalated at.
  state                  jsonb not null default '{}'::jsonb,
  next_check_at          timestamptz,
  source_action_id       uuid references public.ai_actions(id) on delete set null,
  completed_at           timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint buddy_workflows_task_fkey foreign key (task_id, org_id)
    references public.tasks (id, org_id) on delete cascade,
  constraint buddy_workflows_assignee_fkey foreign key (assignee_employee_id, org_id)
    references public.employees (id, org_id) on delete cascade,
  constraint buddy_workflows_initiator_emp_fkey foreign key (initiator_employee_id, org_id)
    references public.employees (id, org_id) on delete set null (initiator_employee_id)
);

-- One live follow-through per task: asking twice updates, never duplicates.
create unique index if not exists buddy_workflows_live_task_idx
  on public.buddy_workflows (org_id, kind, task_id) where status in ('active', 'escalated');
create index if not exists buddy_workflows_due_idx
  on public.buddy_workflows (next_check_at) where status in ('active', 'escalated');

comment on table public.buddy_workflows is
  'Long-running follow-through Buddy owns (e.g. make sure a task gets done: remind, follow up, escalate). Server-written.';

-- ─── 4. Jobs ─────────────────────────────────────────────────────────────────

create table if not exists public.buddy_jobs (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  kind               text not null check (kind ~ '^[a-z][a-z0-9_]{2,40}$'),
  -- Deterministic per business event, e.g. task_due_soon:<task>:<deadline>.
  dedupe_key         text not null check (length(dedupe_key) between 3 and 300),
  status             text not null default 'pending'
                     check (status in ('pending', 'processing', 'retry', 'completed', 'failed', 'cancelled')),
  run_at             timestamptz not null default now(),
  attempts           integer not null default 0 check (attempts >= 0),
  max_attempts       integer not null default 5 check (max_attempts between 1 and 20),
  lease_until        timestamptz,
  locked_by          text,
  last_error         text,
  -- Who the job acts as. 'buddy' = the Buddy principal of this company.
  actor_kind         text not null default 'buddy' check (actor_kind in ('user', 'person', 'buddy')),
  actor_user_id      uuid references auth.users(id) on delete cascade,
  actor_employee_id  uuid,
  workflow_id        uuid references public.buddy_workflows(id) on delete cascade,
  payload            jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  result             jsonb,
  action_ids         uuid[] not null default '{}',
  source             text check (source is null or source ~ '^[a-z][a-z0-9_:.-]{1,60}$'),
  started_at         timestamptz,
  finished_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint buddy_jobs_actor check (
    (actor_kind = 'user'   and actor_user_id is not null and actor_employee_id is null) or
    (actor_kind = 'person' and actor_employee_id is not null and actor_user_id is null) or
    (actor_kind = 'buddy'  and actor_user_id is null and actor_employee_id is null)),
  constraint buddy_jobs_actor_emp_fkey foreign key (actor_employee_id, org_id)
    references public.employees (id, org_id) on delete cascade
);

create unique index if not exists buddy_jobs_dedupe_idx on public.buddy_jobs (org_id, dedupe_key);
create index if not exists buddy_jobs_due_idx on public.buddy_jobs (run_at) where status in ('pending', 'retry');
create index if not exists buddy_jobs_lease_idx on public.buddy_jobs (lease_until) where status = 'processing';
create index if not exists buddy_jobs_org_time_idx on public.buddy_jobs (org_id, created_at desc);
create index if not exists buddy_jobs_workflow_idx on public.buddy_jobs (workflow_id) where workflow_id is not null;

comment on table public.buddy_jobs is
  'The durable job/event queue of the Autonomous Buddy Engine. One row per business event (dedupe_key), claimed by exactly one worker.';

-- Hands up to p_limit due jobs to this worker, atomically. A job is due when
-- it is pending/retry and its run_at has come, or when it is processing but
-- its lease expired (the worker died). SKIP LOCKED: a concurrent claimer
-- skips rows another is taking, so no job is ever handed out twice at once.
-- A stale job that already used all its attempts is failed, not retried.
-- p_ids narrows the claim to these jobs (running a just-created job at once).
create or replace function public.buddy_claim_jobs(
  p_worker text, p_limit integer default 10, p_lease_seconds integer default 120,
  p_org uuid default null, p_ids uuid[] default null)
returns setof public.buddy_jobs
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if coalesce(p_worker, '') !~ '^[A-Za-z0-9_.:-]{3,80}$' then
    raise exception 'buddy_claim_jobs: bad worker id' using errcode = '22023';
  end if;

  update public.buddy_jobs
     set status = 'failed', finished_at = now(), lease_until = null,
         last_error = left(coalesce(last_error || ' · ', '') || 'lease expired after the last attempt', 1000)
   where status = 'processing' and lease_until < now() and attempts >= max_attempts
     and (p_org is null or org_id = p_org)
     and (p_ids is null or id = any (p_ids));

  return query
  with picked as (
    select j.id
      from public.buddy_jobs j
     where ((j.status in ('pending', 'retry') and j.run_at <= now())
            or (j.status = 'processing' and j.lease_until < now()))
       and (p_org is null or j.org_id = p_org)
       and (p_ids is null or j.id = any (p_ids))
     order by j.run_at, j.created_at
     limit greatest(1, least(coalesce(p_limit, 10), 100))
     for update skip locked
  )
  update public.buddy_jobs j
     set status = 'processing',
         attempts = j.attempts + 1,
         locked_by = p_worker,
         lease_until = now() + make_interval(secs => greatest(10, least(coalesce(p_lease_seconds, 120), 900))),
         started_at = now()
    from picked
   where j.id = picked.id
  returning j.*;
end $$;

revoke execute on function public.buddy_claim_jobs(text, integer, integer, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.buddy_claim_jobs(text, integer, integer, uuid, uuid[]) to service_role;

-- ─── 5. ai_actions: autonomous actions in the same log ──────────────────────

alter table public.ai_actions add column if not exists actor_kind      text not null default 'user';
alter table public.ai_actions add column if not exists autonomous      boolean not null default false;
alter table public.ai_actions add column if not exists policy_decision jsonb;
alter table public.ai_actions add column if not exists job_id          uuid references public.buddy_jobs(id) on delete set null;
alter table public.ai_actions add column if not exists workflow_id     uuid references public.buddy_workflows(id) on delete set null;
alter table public.ai_actions add column if not exists idempotency_key text;
alter table public.ai_actions add column if not exists approved_by     uuid references auth.users(id) on delete set null;

-- Rows written before this migration by a linked person (0071).
update public.ai_actions set actor_kind = 'person'
 where actor_kind = 'user' and user_id is null and employee_id is not null;

-- An API that predates this migration names the person but not the kind;
-- the kind follows from the identity columns it did send.
create or replace function app.ai_actions_actor_kind()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.actor_kind = 'user' and new.user_id is null and new.employee_id is not null then
    new.actor_kind := 'person';
  end if;
  return new;
end $$;

drop trigger if exists ai_actions_actor_kind on public.ai_actions;
create trigger ai_actions_actor_kind before insert on public.ai_actions
  for each row execute function app.ai_actions_actor_kind();

do $mig$
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_actions_actor_kind_check') then
    alter table public.ai_actions add constraint ai_actions_actor_kind_check check (
      (actor_kind = 'user'   and user_id is not null) or
      (actor_kind = 'person' and user_id is null and employee_id is not null) or
      (actor_kind = 'buddy'  and user_id is null and employee_id is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_actions_idem_key_check') then
    alter table public.ai_actions add constraint ai_actions_idem_key_check
      check (idempotency_key is null or length(idempotency_key) between 3 and 300);
  end if;
end $mig$;

create unique index if not exists ai_actions_idem_idx on public.ai_actions (org_id, idempotency_key) where idempotency_key is not null;
create index if not exists ai_actions_job_idx on public.ai_actions (job_id) where job_id is not null;
create index if not exists ai_actions_auto_idx on public.ai_actions (org_id, proposed_at desc) where autonomous;

comment on column public.ai_actions.autonomous is
  'true = executed without a human tap because the company autonomy policy allowed it (policy_decision says which rule).';
comment on column public.ai_actions.actor_kind is
  'user (user_id) | person (employee_id, a linked company person) | buddy (the company''s Buddy principal, no human).';

-- ─── 6. audit_log: who, when it was Buddy itself ────────────────────────────

alter table public.audit_log add column if not exists actor_system text;
comment on column public.audit_log.actor_system is
  '''buddy'' when the company''s Buddy principal made the change (an autonomous job with no human actor).';
comment on column public.audit_log.via is
  'null = written directly by the actor; ''edgeai'' = by Buddy after the actor confirmed it; ''edgeai_auto'' = by Buddy autonomously, as the company policy allowed.';

-- ─── 7. The Buddy principal ──────────────────────────────────────────────────

-- The company this request acts for as Buddy, or null. Only for a token with
-- no user and no person claim whose sb_buddy.org names a live company whose
-- autonomy is not switched off.
create or replace function app.buddy_principal(p_org uuid default null)
returns uuid language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_claims jsonb;
  v_b      jsonb;
  v_org    uuid;
  re       constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if auth.uid() is not null then
    return null;
  end if;
  begin
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then
    return null;
  end;
  if v_claims is null or coalesce(v_claims ->> 'role', '') <> 'authenticated' or v_claims ? 'sb_person' then
    return null;
  end if;
  v_b := v_claims -> 'sb_buddy';
  if v_b is null or jsonb_typeof(v_b) <> 'object' or coalesce(v_b ->> 'org', '') !~* re then
    return null;
  end if;
  v_org := (v_b ->> 'org')::uuid;
  if p_org is not null and p_org <> v_org then
    return null;
  end if;
  if not exists (select 1 from public.organizations o where o.id = v_org and o.deleted_at is null) then
    return null;
  end if;
  if exists (select 1 from public.buddy_autonomy_policies p where p.org_id = v_org and not p.enabled) then
    return null;
  end if;
  return v_org;
end $$;

revoke execute on function app.buddy_principal(uuid) from public;
grant execute on function app.buddy_principal(uuid) to authenticated, service_role;

-- What Buddy may read, and what it may create/edit, on its own.
create or replace function app.buddy_view_resources()
returns text[] language sql immutable as $$
  select array['tasks', 'employees', 'projects', 'project_milestones', 'project_members', 'notifications', 'departments']::text[];
$$;
create or replace function app.buddy_write_resources()
returns text[] language sql immutable as $$
  select array['tasks', 'notifications']::text[];
$$;

create or replace function app.buddy_permission(p_org uuid, p_resource text, p_action text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select p_action in ('view', 'create', 'edit')
     and p_resource = any (case when p_action = 'view' then app.buddy_view_resources() else app.buddy_write_resources() end)
     and app.buddy_principal(p_org) is not null
     and coalesce((
       select case p_action
                when 'view'   then rp.can_view
                when 'create' then rp.can_create
                when 'edit'   then rp.can_edit
              end
         from public.role_permissions rp
        where rp.org_id = p_org and rp.role = 'admin' and rp.resource = p_resource
     ), false);
$$;

revoke execute on function app.buddy_permission(uuid, text, text) from public;

create or replace function app.buddy_permissions(p_org uuid)
returns table (resource text, can_view boolean, can_create boolean, can_edit boolean, can_delete boolean, custom boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select pr.key,
         app.buddy_permission(p_org, pr.key, 'view'),
         app.buddy_permission(p_org, pr.key, 'create'),
         app.buddy_permission(p_org, pr.key, 'edit'),
         false,
         false
    from public.permission_resources pr
   where app.buddy_principal(p_org) is not null
     and pr.key = any (app.buddy_view_resources());
$$;

revoke execute on function app.buddy_permissions(uuid) from public;

-- 0071's is_signed_in, plus the Buddy principal: the guards rewritten in 0071
-- then apply their checks to Buddy as to anyone (never "the database's own
-- write").
create or replace function app.is_signed_in()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null or app.person_principal(null) is not null or app.buddy_principal(null) is not null;
$$;

-- 0071's has_permission, plus the Buddy principal.
create or replace function app.has_permission(p_org uuid, p_resource text, p_action text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select case p_action
             when 'view'   then coalesce(mp.can_view,   rp.can_view)
             when 'create' then coalesce(mp.can_create, rp.can_create)
             when 'edit'   then coalesce(mp.can_edit,   rp.can_edit)
             when 'delete' then coalesce(mp.can_delete, rp.can_delete)
           end
      from public.memberships m
      left join public.member_permissions mp
        on mp.membership_id = m.id and mp.resource = p_resource
      left join public.role_permissions rp
        on rp.org_id = m.org_id and rp.role = m.role and rp.resource = p_resource
     where m.org_id = p_org
       and m.user_id = auth.uid()
  ), false)
  or (auth.uid() is null and app.person_permission(p_org, p_resource, p_action))
  or (auth.uid() is null and app.buddy_permission(p_org, p_resource, p_action));
$$;

-- 0071's my_permissions: a user's, a person principal's, or Buddy's map.
create or replace function public.my_permissions(p_org uuid)
returns table (resource text, can_view boolean, can_create boolean, can_edit boolean, can_delete boolean, custom boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select * from app.effective_permissions(p_org, auth.uid()) where auth.uid() is not null
  union all
  select * from app.person_permissions(p_org) where auth.uid() is null
  union all
  select * from app.buddy_permissions(p_org) where auth.uid() is null;
$$;

-- 0071's agent_action_id: also a confirmed/executed action of Buddy itself.
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
     and a.status in ('confirmed', 'executed')
     and (a.user_id = auth.uid()
          or (a.user_id is null and a.employee_id is not null and a.employee_id = app.person_principal(a.org_id))
          or (a.actor_kind = 'buddy' and a.user_id is null and a.employee_id is null
              and a.org_id = app.buddy_principal(a.org_id)));
  return v_id;
end $$;

revoke execute on function app.agent_action_id() from public;

-- 0071's write_audit, plus: autonomous actions are 'edgeai_auto', and a write
-- by the Buddy principal records actor_system = 'buddy'.
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
  v_auto      boolean := false;
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
  if v_agent is not null then
    select coalesce(a.autonomous, false) into v_auto from public.ai_actions a where a.id = v_agent;
  end if;

  insert into public.audit_log (org_id, actor_id, actor_employee_id, actor_system, action, entity_type, entity_id, diff, via, ai_action_id)
  values (v_org, auth.uid(), app.person_principal(v_org),
          case when app.buddy_principal(v_org) is not null then 'buddy' end,
          v_action, tg_table_name, v_entity, v_diff,
          case when v_agent is null then null when v_auto then 'edgeai_auto' else 'edgeai' end, v_agent);

  return null;
exception when others then
  raise warning 'audit trigger on % failed: %', tg_table_name, sqlerrm;
  return null;
end $$;

-- ─── 8. updated_at, audit, RLS ───────────────────────────────────────────────

do $mig$
declare t text;
begin
  foreach t in array array['buddy_autonomy_policies', 'buddy_workflows', 'buddy_jobs'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I for each row execute function app.touch_updated_at()', t, t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $mig$;

-- A policy change is a governance change: it is audited like one.
drop trigger if exists buddy_autonomy_policies_audit on public.buddy_autonomy_policies;
create trigger buddy_autonomy_policies_audit after insert or update or delete on public.buddy_autonomy_policies
  for each row execute function app.write_audit();

-- The company may read its policy; owners and admins may read what Buddy
-- scheduled and followed up. Nobody writes any of it from the client.
drop policy if exists buddy_autonomy_policies_select on public.buddy_autonomy_policies;
create policy buddy_autonomy_policies_select on public.buddy_autonomy_policies
  for select to authenticated using (app.is_member(org_id));
drop policy if exists buddy_workflows_select on public.buddy_workflows;
create policy buddy_workflows_select on public.buddy_workflows
  for select to authenticated using (app.is_admin(org_id));
drop policy if exists buddy_jobs_select on public.buddy_jobs;
create policy buddy_jobs_select on public.buddy_jobs
  for select to authenticated using (app.is_admin(org_id));

grant select on public.buddy_autonomy_policies, public.buddy_workflows, public.buddy_jobs to authenticated;
