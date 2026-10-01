-- ============================================================================
-- EdgeOS · Autonomous Buddy Engine (0072)
--
-- What must hold in the database, whatever the API does:
--
--   · the Buddy principal (a token with no user, no person, sb_buddy { org })
--     reads and writes only its own company's operational data — tasks,
--     people, projects, notifications — and only view/create/edit tasks and
--     notifications; never delete, never money, clients, pay or governance;
--   · a claim naming another company, a company whose autonomy is switched
--     off, a token also carrying a user or a person — all get nothing, at
--     once (the kill switch also stops tokens already issued);
--   · the guards apply to it (it counts as signed in);
--   · audit: an autonomous action is 'edgeai_auto' with actor_system
--     'buddy'; a human-confirmed one stays 'edgeai'; a forged action id
--     attributes nothing;
--   · ai_actions: every row is exactly one kind of actor;
--   · the queue: one job per (company, event); no client role may write jobs,
--     workflows or the policy; owners/admins read their own company's only;
--   · buddy_claim_jobs hands a job to one worker; an expired lease is
--     reclaimed as a new attempt; an exhausted one fails; and two concurrent
--     claimers never get the same job (the last section, with dblink).
--
-- Everything but the concurrency section runs in one transaction and rolls back.
-- ============================================================================

\set QUIET on
\pset pager off
\pset tuples_only on
set client_min_messages = notice;

begin;

create or replace function pg_temp.check(p_cond boolean, p_label text) returns void language plpgsql as $$
begin
  if coalesce(p_cond, false) then raise notice '  PASS  %', p_label;
  else raise exception 'FAIL  %', p_label; end if;
end $$;

-- Acts as a request PostgREST would make with the API's Buddy token.
create or replace function pg_temp.be_buddy(p_org uuid, p_action uuid default null, p_extra jsonb default '{}'::jsonb)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_extra ->> 'sub', ''), true);
  perform set_config('request.jwt.claims', (jsonb_build_object('role', 'authenticated',
    'sb_buddy', jsonb_build_object('org', p_org)) || p_extra)::text, true);
  perform set_config('request.headers',
    case when p_action is null then '{}' else json_build_object('x-edgeos-agent-action', p_action)::text end, true);
end $$;

create or replace function pg_temp.buddy_err(p_sql text, p_org uuid default 'e1610000-0000-0000-0000-00000000000a',
  p_action uuid default null) returns text language plpgsql as $$
begin
  perform pg_temp.be_buddy(p_org, p_action);
  perform set_config('role', 'authenticated', true);
  begin
    execute p_sql;
    reset role;
    return null;
  exception when others then
    reset role;
    return sqlerrm;
  end;
end $$;

create or replace function pg_temp.buddy_count(p_sql text, p_org uuid default 'e1610000-0000-0000-0000-00000000000a',
  p_extra jsonb default '{}'::jsonb) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform pg_temp.be_buddy(p_org, null, p_extra);
  perform set_config('role', 'authenticated', true);
  execute p_sql into n;
  reset role;
  return n;
end $$;

create or replace function pg_temp.buddy_bool(p_sql text, p_org uuid default 'e1610000-0000-0000-0000-00000000000a')
returns boolean language plpgsql as $$
declare b boolean;
begin
  perform pg_temp.be_buddy(p_org);
  execute p_sql into b;
  return b;
end $$;

-- A signed-in user, as PostgREST would run them.
create or replace function pg_temp.user_count(p_user uuid, p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user)::text, true);
  perform set_config('request.headers', '{}', true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into n;
  reset role;
  return n;
end $$;

create or replace function pg_temp.user_err(p_user uuid, p_sql text) returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user)::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    execute p_sql;
    reset role;
    return null;
  exception when others then
    reset role;
    return sqlerrm;
  end;
end $$;

-- Catalysis23 (A): founder Nikhil (owner), a member; Swetha (a person). Org B.
insert into auth.users (id, email) values
  ('e1600000-0000-0000-0000-000000000001', 'nikhil@a.test'),
  ('e1600000-0000-0000-0000-000000000002', 'member@a.test'),
  ('e1600000-0000-0000-0000-000000000003', 'owner@b.test');
insert into organizations (id, company_name, owner_uid) values
  ('e1610000-0000-0000-0000-00000000000a', 'Catalysis23', 'e1600000-0000-0000-0000-000000000001'),
  ('e1610000-0000-0000-0000-00000000000b', 'Org B', 'e1600000-0000-0000-0000-000000000003');
insert into memberships (org_id, user_id, role) values
  ('e1610000-0000-0000-0000-00000000000a', 'e1600000-0000-0000-0000-000000000001', 'owner'),
  ('e1610000-0000-0000-0000-00000000000a', 'e1600000-0000-0000-0000-000000000002', 'member'),
  ('e1610000-0000-0000-0000-00000000000b', 'e1600000-0000-0000-0000-000000000003', 'owner');
insert into public.employees (id, org_id, full_name, user_id) values
  ('e1650000-0000-0000-0000-000000000001', 'e1610000-0000-0000-0000-00000000000a', 'Swetha NM', null),
  ('e1650000-0000-0000-0000-000000000009', 'e1610000-0000-0000-0000-00000000000b', 'Bob (Org B)', null);
insert into public.employee_compensation (employee_id, org_id, amount) values
  ('e1650000-0000-0000-0000-000000000001', 'e1610000-0000-0000-0000-00000000000a', 50000);
insert into public.tasks (id, org_id, title, assignee_id, deadline) values
  ('e1680000-0000-0000-0000-00000000000a', 'e1610000-0000-0000-0000-00000000000a', 'Follow up sponsor', 'e1650000-0000-0000-0000-000000000001', current_date + 1),
  ('e1680000-0000-0000-0000-00000000000b', 'e1610000-0000-0000-0000-00000000000b', 'B task', null, current_date + 1);
insert into public.clients (id, org_id, name) values
  ('e1670000-0000-0000-0000-00000000000a', 'e1610000-0000-0000-0000-00000000000a', 'Sponsor Co');
insert into public.financial_documents (id, org_id, type, status, doc_number, bill_to_name, grand_total) values
  ('e1690000-0000-0000-0000-00000000000a', 'e1610000-0000-0000-0000-00000000000a', 'invoice', 'draft', 'INV-A-1', 'Sponsor Co', 25000);

-- ── identity ────────────────────────────────────────────────────────────────
select pg_temp.check(pg_temp.buddy_bool($q$select app.buddy_principal('e1610000-0000-0000-0000-00000000000a') = 'e1610000-0000-0000-0000-00000000000a'
  and app.buddy_principal('e1610000-0000-0000-0000-00000000000b') is null$q$),
  'the Buddy token is the principal of its own company only');
select pg_temp.check(pg_temp.buddy_bool($q$select app.is_signed_in() and app.person_principal(null) is null and auth.uid() is null$q$),
  'it is signed in (guards apply to it), and it is neither a user nor a person');
select pg_temp.check(pg_temp.buddy_bool($q$select not app.is_member('e1610000-0000-0000-0000-00000000000a') and not app.is_admin('e1610000-0000-0000-0000-00000000000a')$q$),
  'it is not a member and never an admin (pay, banking and governance stay closed)');

-- ── what it may do ──────────────────────────────────────────────────────────
select pg_temp.check(pg_temp.buddy_count('select count(*) from public.tasks') = 1
                 and pg_temp.buddy_count('select count(*) from public.employees') = 1,
  'it reads its company''s tasks and people — only those');
select pg_temp.check(pg_temp.buddy_err($q$insert into public.tasks (org_id, title) values ('e1610000-0000-0000-0000-00000000000a', 'Chase sponsor')$q$) is null,
  'it creates a task');
select pg_temp.check(pg_temp.buddy_err($q$update public.tasks set notes = 'Reminded on Telegram' where id = 'e1680000-0000-0000-0000-00000000000a'$q$) is null,
  'it edits a task');
select pg_temp.check((select notes from public.tasks where id = 'e1680000-0000-0000-0000-00000000000a') = 'Reminded on Telegram',
  'the edit is saved');
select pg_temp.check(pg_temp.buddy_bool($q$select exists (select 1 from public.my_permissions('e1610000-0000-0000-0000-00000000000a') where resource = 'tasks' and can_view and can_create and can_edit)
  and not exists (select 1 from public.my_permissions('e1610000-0000-0000-0000-00000000000a') where can_delete)
  and not exists (select 1 from public.my_permissions('e1610000-0000-0000-0000-00000000000a') where resource in ('clients', 'financial_documents', 'expenses', 'payments', 'memberships', 'audit_log'))$q$),
  'its permission map: operational view/create/edit, no delete, no money, clients or governance');

-- ── what it may never do ────────────────────────────────────────────────────
select pg_temp.buddy_err($q$delete from public.tasks where id = 'e1680000-0000-0000-0000-00000000000a'$q$);
select pg_temp.check((select count(*) from public.tasks where id = 'e1680000-0000-0000-0000-00000000000a') = 1,
  'it cannot delete (a delete removes nothing)');
select pg_temp.check(pg_temp.buddy_count('select count(*) from public.clients') = 0
                 and pg_temp.buddy_count('select count(*) from public.financial_documents') = 0
                 and pg_temp.buddy_count('select count(*) from public.employee_compensation') = 0
                 and pg_temp.buddy_count('select count(*) from public.ai_actions') = 0
                 and pg_temp.buddy_count('select count(*) from public.buddy_jobs') = 0,
  'it reads no clients, invoices, pay, AI log or queue');
select pg_temp.check(pg_temp.buddy_err($q$insert into public.financial_documents (org_id, type, status, bill_to_name) values ('e1610000-0000-0000-0000-00000000000a', 'invoice', 'draft', 'X')$q$) is not null
                 and pg_temp.buddy_err($q$insert into public.clients (org_id, name) values ('e1610000-0000-0000-0000-00000000000a', 'X')$q$) is not null,
  'it cannot create invoices or clients');
select pg_temp.check(pg_temp.buddy_err($q$insert into public.buddy_autonomy_policies (org_id, enabled) values ('e1610000-0000-0000-0000-00000000000b', true)$q$) is not null
                 and pg_temp.buddy_err($q$insert into public.buddy_jobs (org_id, kind, dedupe_key) values ('e1610000-0000-0000-0000-00000000000a', 'task_due_soon', 'forged')$q$) is not null,
  'it cannot write its own policy or queue');

-- ── company isolation ───────────────────────────────────────────────────────
select pg_temp.check(pg_temp.buddy_err($q$insert into public.tasks (org_id, title) values ('e1610000-0000-0000-0000-00000000000b', 'Sneaky')$q$) is not null,
  'it cannot write into another company');
select pg_temp.buddy_err($q$update public.tasks set title = 'hijacked' where id = 'e1680000-0000-0000-0000-00000000000b'$q$);
select pg_temp.check((select title from public.tasks where id = 'e1680000-0000-0000-0000-00000000000b') = 'B task',
  'nor change another company''s rows');
select pg_temp.check(pg_temp.buddy_count('select count(*) from public.tasks where org_id = ''e1610000-0000-0000-0000-00000000000b''') = 0,
  'nor read them');

-- ── the claim is only a pointer ─────────────────────────────────────────────
select pg_temp.check(pg_temp.buddy_count('select count(*) from public.tasks where org_id = ''e1610000-0000-0000-0000-00000000000a''', 'e1610000-0000-0000-0000-00000000000a',
  jsonb_build_object('sub', 'e1600000-0000-0000-0000-000000000003')) = 0,
  'a real user''s (Org B owner) token carrying sb_buddy for Catalysis23 gains nothing from it');
select pg_temp.check(pg_temp.buddy_count('select count(*) from public.tasks', 'e1610000-0000-0000-0000-00000000000a',
  jsonb_build_object('sb_person', jsonb_build_object('link', gen_random_uuid(), 'person', gen_random_uuid(), 'org', 'e1610000-0000-0000-0000-00000000000a'))) = 0,
  'a token carrying both sb_buddy and sb_person is neither');
select pg_temp.check(pg_temp.buddy_count('select count(*) from public.tasks', gen_random_uuid()) = 0,
  'a claim naming a company that does not exist opens nothing');

-- ── the kill switch ─────────────────────────────────────────────────────────
insert into public.buddy_autonomy_policies (org_id, enabled) values ('e1610000-0000-0000-0000-00000000000a', false);
select pg_temp.check(pg_temp.buddy_count('select count(*) from public.tasks') = 0
                 and pg_temp.buddy_err($q$insert into public.tasks (org_id, title) values ('e1610000-0000-0000-0000-00000000000a', 'While off')$q$) is not null,
  'autonomy switched off: the same token reads and writes nothing, immediately');
update public.buddy_autonomy_policies set enabled = true where org_id = 'e1610000-0000-0000-0000-00000000000a';
select pg_temp.check(pg_temp.buddy_count('select count(*) from public.tasks') > 0, 'switched back on: it works again');
select pg_temp.check(exists (select 1 from public.audit_log where entity_type = 'buddy_autonomy_policies' and action = 'buddy_autonomy_policies.update'),
  'a policy change is in the audit log');

-- ── ai_actions: one kind of actor per row ──────────────────────────────────
set local role service_role;
insert into public.ai_actions (id, org_id, user_id, employee_id, tool, risk, status) values
  ('e16a0000-0000-0000-0000-000000000001', 'e1610000-0000-0000-0000-00000000000a', null, 'e1650000-0000-0000-0000-000000000001', 'create_task', 'low', 'proposed');
reset role;
select pg_temp.check((select actor_kind from public.ai_actions where id = 'e16a0000-0000-0000-0000-000000000001') = 'person',
  'an API from before 0072 writing a person''s action gets actor_kind person');
do $$ begin
  begin
    insert into public.ai_actions (org_id, user_id, tool, risk, actor_kind)
    values ('e1610000-0000-0000-0000-00000000000a', 'e1600000-0000-0000-0000-000000000001', 'create_task', 'low', 'buddy');
    raise exception 'FAIL  a Buddy action carrying a user was accepted';
  exception when check_violation then raise notice '  PASS  a Buddy action carries no user and no person';
  end;
  begin
    insert into public.ai_actions (org_id, tool, risk, actor_kind, idempotency_key) values
      ('e1610000-0000-0000-0000-00000000000a', 'create_task', 'low', 'buddy', 'ev:dup'),
      ('e1610000-0000-0000-0000-00000000000a', 'create_task', 'low', 'buddy', 'ev:dup');
    raise exception 'FAIL  two actions with one idempotency key';
  exception when unique_violation then raise notice '  PASS  an idempotency key is used once per company';
  end;
end $$;

-- ── audit attribution ───────────────────────────────────────────────────────
set local role service_role;
insert into public.ai_actions (id, org_id, user_id, employee_id, actor_kind, autonomous, tool, risk, status) values
  ('e16a0000-0000-0000-0000-000000000002', 'e1610000-0000-0000-0000-00000000000a', null, null, 'buddy', true, 'create_task', 'low', 'confirmed'),
  ('e16a0000-0000-0000-0000-000000000003', 'e1610000-0000-0000-0000-00000000000b', null, null, 'buddy', true, 'create_task', 'low', 'confirmed'),
  ('e16a0000-0000-0000-0000-000000000004', 'e1610000-0000-0000-0000-00000000000a', 'e1600000-0000-0000-0000-000000000001', null, 'user', false, 'create_task', 'low', 'confirmed');
reset role;
select pg_temp.check(pg_temp.buddy_err($q$insert into public.tasks (org_id, title) values ('e1610000-0000-0000-0000-00000000000a', 'Auto task')$q$,
  'e1610000-0000-0000-0000-00000000000a', 'e16a0000-0000-0000-0000-000000000002') is null, 'an autonomous Buddy action writes');
select pg_temp.check((select via = 'edgeai_auto' and ai_action_id = 'e16a0000-0000-0000-0000-000000000002' and actor_system = 'buddy'
                        and actor_id is null and actor_employee_id is null
                        from public.audit_log where diff ->> 'title' = 'Auto task'),
  'audit: autonomous, by Buddy itself, with the action id');
select pg_temp.check(pg_temp.buddy_err($q$insert into public.tasks (org_id, title) values ('e1610000-0000-0000-0000-00000000000a', 'Forged task')$q$,
  'e1610000-0000-0000-0000-00000000000a', 'e16a0000-0000-0000-0000-000000000003') is null, 'Buddy writes while sending another company''s action id');
select pg_temp.check((select via is null and ai_action_id is null and actor_system = 'buddy' from public.audit_log where diff ->> 'title' = 'Forged task'),
  'another company''s Buddy action id attributes nothing');
do $$ begin
  perform set_config('request.jwt.claim.sub', 'e1600000-0000-0000-0000-000000000001', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', 'e1600000-0000-0000-0000-000000000001')::text, true);
  perform set_config('request.headers', json_build_object('x-edgeos-agent-action', 'e16a0000-0000-0000-0000-000000000004')::text, true);
  set local role authenticated;
  insert into public.tasks (org_id, title) values ('e1610000-0000-0000-0000-00000000000a', 'Human confirmed');
  reset role;
end $$;
select pg_temp.check((select via = 'edgeai' and actor_id = 'e1600000-0000-0000-0000-000000000001' and actor_system is null
                        from public.audit_log where diff ->> 'title' = 'Human confirmed'),
  'audit: a human-confirmed action is still ''edgeai'', by that person');

-- ── the queue, the workflows and the policy: server-written ─────────────────
insert into public.buddy_jobs (id, org_id, kind, dedupe_key) values
  ('e16b0000-0000-0000-0000-00000000000a', 'e1610000-0000-0000-0000-00000000000a', 'task_due_soon', 'task_due_soon:a'),
  ('e16b0000-0000-0000-0000-00000000000b', 'e1610000-0000-0000-0000-00000000000b', 'task_due_soon', 'task_due_soon:b');
insert into public.buddy_workflows (org_id, kind, task_id, assignee_employee_id, initiator_kind, initiator_user_id) values
  ('e1610000-0000-0000-0000-00000000000a', 'task_followup', 'e1680000-0000-0000-0000-00000000000a', 'e1650000-0000-0000-0000-000000000001', 'user', 'e1600000-0000-0000-0000-000000000001');
do $$ begin
  begin
    insert into public.buddy_jobs (org_id, kind, dedupe_key) values ('e1610000-0000-0000-0000-00000000000a', 'task_due_soon', 'task_due_soon:a');
    raise exception 'FAIL  the same event became two jobs';
  exception when unique_violation then raise notice '  PASS  one job per company per event (dedupe_key)';
  end;
  begin
    insert into public.buddy_workflows (org_id, kind, task_id, assignee_employee_id, initiator_kind)
    values ('e1610000-0000-0000-0000-00000000000a', 'task_followup', 'e1680000-0000-0000-0000-00000000000a', 'e1650000-0000-0000-0000-000000000001', 'buddy');
    raise exception 'FAIL  a task got two live follow-throughs';
  exception when unique_violation then raise notice '  PASS  one live follow-through per task';
  end;
  begin
    insert into public.buddy_workflows (org_id, kind, task_id, assignee_employee_id, initiator_kind)
    values ('e1610000-0000-0000-0000-00000000000a', 'task_followup', 'e1680000-0000-0000-0000-00000000000b', null, 'buddy');
    raise exception 'FAIL  a workflow pointed at another company''s task';
  exception when foreign_key_violation then raise notice '  PASS  a workflow''s task must be in its company';
  end;
  begin
    insert into public.buddy_jobs (org_id, kind, dedupe_key, actor_kind, actor_employee_id)
    values ('e1610000-0000-0000-0000-00000000000a', 'buddy_review', 'x:1', 'person', 'e1650000-0000-0000-0000-000000000009');
    raise exception 'FAIL  a job acted as another company''s person';
  exception when foreign_key_violation then raise notice '  PASS  a job''s person actor must be in its company';
  end;
end $$;
select pg_temp.check(pg_temp.user_count('e1600000-0000-0000-0000-000000000001', 'select count(*) from public.buddy_jobs') = 1
                 and pg_temp.user_count('e1600000-0000-0000-0000-000000000001', 'select count(*) from public.buddy_workflows') = 1,
  'the owner reads their company''s jobs and follow-throughs, not another''s');
select pg_temp.check(pg_temp.user_count('e1600000-0000-0000-0000-000000000002', 'select count(*) from public.buddy_jobs') = 0
                 and pg_temp.user_count('e1600000-0000-0000-0000-000000000002', 'select count(*) from public.buddy_autonomy_policies') = 1,
  'a member reads the policy but not the queue');
select pg_temp.check(pg_temp.user_err('e1600000-0000-0000-0000-000000000001', $q$update public.buddy_autonomy_policies set enabled = false$q$) is not null
                 and pg_temp.user_err('e1600000-0000-0000-0000-000000000001', $q$insert into public.buddy_jobs (org_id, kind, dedupe_key) values ('e1610000-0000-0000-0000-00000000000a', 'task_due_soon', 'forged')$q$) is not null
                 and pg_temp.user_err('e1600000-0000-0000-0000-000000000001', $q$update public.buddy_jobs set status = 'completed'$q$) is not null,
  'no client role writes the policy or the queue — not even the owner (the API does, after its checks)');
select pg_temp.check(pg_temp.user_err('e1600000-0000-0000-0000-000000000001', $q$select * from public.buddy_claim_jobs('w-client', 10)$q$) is not null,
  'a client cannot claim jobs');

-- ── claiming ────────────────────────────────────────────────────────────────
update public.buddy_jobs set run_at = now() + interval '1 hour' where id = 'e16b0000-0000-0000-0000-00000000000b';
select pg_temp.check((select count(*) from public.buddy_claim_jobs('w-1', 10)) = 1, 'a due job is claimed; a future one is not');
select pg_temp.check((select status = 'processing' and attempts = 1 and locked_by = 'w-1' and lease_until > now()
                        from public.buddy_jobs where id = 'e16b0000-0000-0000-0000-00000000000a'),
  'with a lease and a counted attempt');
select pg_temp.check((select count(*) from public.buddy_claim_jobs('w-2', 10)) = 0, 'a claimed, leased job is not handed out again');
update public.buddy_jobs set lease_until = now() - interval '1 second' where id = 'e16b0000-0000-0000-0000-00000000000a';
select pg_temp.check((select count(*) from public.buddy_claim_jobs('w-3', 10)) = 1, 'a job whose worker died (lease expired) is reclaimed');
select pg_temp.check((select attempts = 2 and locked_by = 'w-3' from public.buddy_jobs where id = 'e16b0000-0000-0000-0000-00000000000a'),
  'as a new attempt, by the new worker');
update public.buddy_jobs set lease_until = now() - interval '1 second', max_attempts = 2 where id = 'e16b0000-0000-0000-0000-00000000000a';
select pg_temp.check((select count(*) from public.buddy_claim_jobs('w-4', 10)) = 0, 'an expired lease on the last attempt is not retried');
select pg_temp.check((select status = 'failed' from public.buddy_jobs where id = 'e16b0000-0000-0000-0000-00000000000a'),
  'it fails the job instead');
do $$ begin
  begin
    perform public.buddy_claim_jobs('bad worker id!', 1);
    raise exception 'FAIL  a malformed worker id was accepted';
  exception when invalid_parameter_value then raise notice '  PASS  the worker id is validated';
  end;
end $$;

-- ── the team group (0073) ───────────────────────────────────────────────────
insert into public.org_telegram (org_id, enabled) values
  ('e1610000-0000-0000-0000-00000000000a', true), ('e1610000-0000-0000-0000-00000000000b', true);
insert into public.telegram_chats (id, org_id, chat_id, chat_type, title) values
  ('e16d0000-0000-0000-0000-00000000000a', 'e1610000-0000-0000-0000-00000000000a', -100111, 'supergroup', 'A team'),
  ('e16d0000-0000-0000-0000-00000000000b', 'e1610000-0000-0000-0000-00000000000b', -100222, 'supergroup', 'B team');
select pg_temp.check((select not group_posts and group_chat_ref is null from public.org_telegram where org_id = 'e1610000-0000-0000-0000-00000000000a'),
  'group posts are off by default');
do $$ begin
  begin
    update public.org_telegram set group_chat_ref = 'e16d0000-0000-0000-0000-00000000000b' where org_id = 'e1610000-0000-0000-0000-00000000000a';
    raise exception 'FAIL  a company pointed Buddy at another company''s group';
  exception when foreign_key_violation then raise notice '  PASS  Buddy''s group must be one of the company''s own';
  end;
end $$;
update public.org_telegram set group_posts = true, group_chat_ref = 'e16d0000-0000-0000-0000-00000000000a' where org_id = 'e1610000-0000-0000-0000-00000000000a';
delete from public.telegram_chats where id = 'e16d0000-0000-0000-0000-00000000000a';
select pg_temp.check((select group_chat_ref is null and group_posts from public.org_telegram where org_id = 'e1610000-0000-0000-0000-00000000000a'),
  'removing the group clears the choice (and nothing else)');
select pg_temp.check(pg_temp.user_err('e1600000-0000-0000-0000-000000000001', $q$update public.org_telegram set group_posts = false$q$) is not null,
  'no client role changes the group setting (the API does, after an admin check)');

rollback;

-- ── concurrency: two workers at the same moment (separate sessions) ────────
-- Needs dblink (Supabase ships it; local clusters from postgresql-contrib).
do $$
declare
  n_a int; n_b int; n_both int; conn text;
begin
  begin
    create extension if not exists dblink;
  exception when others then
    raise notice '  PASS  (skipped: dblink unavailable, concurrency covered by the API tests)';
    return;
  end;
  conn := format('dbname=%s user=%s host=%s port=%s', current_database(), current_user,
                 split_part(current_setting('unix_socket_directories'), ',', 1), current_setting('port'));
  perform dblink_connect('setup', conn);
  perform dblink_exec('setup', $s$
    insert into auth.users (id, email) values ('e16c0000-0000-0000-0000-000000000001', 'conc@c.test') on conflict do nothing;
    insert into organizations (id, company_name, owner_uid) values ('e16c0000-0000-0000-0000-00000000000c', 'Concurrency Co', 'e16c0000-0000-0000-0000-000000000001') on conflict do nothing;
    insert into public.buddy_jobs (org_id, kind, dedupe_key)
      select 'e16c0000-0000-0000-0000-00000000000c', 'reminder_due', 'conc:' || g from generate_series(1, 6) g;
  $s$);
  perform dblink_connect('w1', conn);
  perform dblink_connect('w2', conn);
  perform dblink_exec('w1', 'begin');
  perform dblink_exec('w2', 'begin');
  -- w1 claims 4 and holds its transaction open; w2 claims at the same time.
  perform dblink_exec('w1', $s$create temp table got as select id from public.buddy_claim_jobs('w-one', 4, 120, 'e16c0000-0000-0000-0000-00000000000c')$s$);
  perform dblink_exec('w2', $s$create temp table got as select id from public.buddy_claim_jobs('w-two', 10, 120, 'e16c0000-0000-0000-0000-00000000000c')$s$);
  select c into n_a from dblink('w1', 'select count(*) from got') as t(c int);
  select c into n_b from dblink('w2', 'select count(*) from got') as t(c int);
  perform dblink_exec('w1', 'commit');
  perform dblink_exec('w2', 'commit');
  select c into n_both from dblink('setup', $s$select count(distinct locked_by) from public.buddy_jobs
    where org_id = 'e16c0000-0000-0000-0000-00000000000c' and status = 'processing' and attempts = 1$s$) as t(c int);
  -- The jobs go; the scratch company stays in this throwaway test database
  -- (deleting a company cascades into EdgeBrain's own bookkeeping).
  perform dblink_exec('setup', $s$delete from public.buddy_jobs where org_id = 'e16c0000-0000-0000-0000-00000000000c'$s$);
  perform dblink_disconnect('w1');
  perform dblink_disconnect('w2');
  perform dblink_disconnect('setup');
  if n_a = 4 and n_b = 2 and n_both = 2 then
    raise notice '  PASS  two concurrent workers split 6 jobs 4 + 2, none claimed twice (SKIP LOCKED)';
  else
    raise exception 'FAIL  concurrent claim: w1 % w2 % owners %', n_a, n_b, n_both;
  end if;
end $$;
