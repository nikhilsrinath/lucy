-- ============================================================================
-- EdgeOS · EdgeAI agent actions (0068)
--
-- What must hold:
--   · ai_actions: each person reads their own proposals; owners and admins
--     read the whole org's; other orgs read nothing; nobody writes from the
--     browser — only the API's service role;
--   · the agent's executor, acting with a user's JWT, can do no more than
--     that user: a member whose finance rights were taken away cannot record
--     a payment or an expense, with or without the agent header;
--   · the audit trigger stamps via = 'edgeai' only for a confirmed action
--     that belongs to the writer — a forged or someone else's id, or one
--     still merely proposed, attributes nothing.
--
-- Everything runs in one transaction and rolls back at the end.
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

-- Acts as p_user, optionally carrying the agent's header, as PostgREST would.
create or replace function pg_temp.be(p_user uuid, p_action uuid default null) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user)::text, true);
  perform set_config('request.headers',
    case when p_action is null then '{}' else json_build_object('x-edgeos-agent-action', p_action)::text end, true);
end $$;

create or replace function pg_temp.err_as(p_user uuid, p_sql text, p_action uuid default null) returns text language plpgsql as $$
begin
  perform pg_temp.be(p_user, p_action);
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

create or replace function pg_temp.count_as(p_user uuid, p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform pg_temp.be(p_user);
  perform set_config('role', 'authenticated', true);
  execute p_sql into n;
  reset role;
  return n;
end $$;

-- Users: owner and two members of Org A (one with finance taken away), an owner of Org B.
insert into auth.users (id, email) values
  ('e1300000-0000-0000-0000-000000000001', 'owner@a.test'),
  ('e1300000-0000-0000-0000-000000000002', 'member@a.test'),
  ('e1300000-0000-0000-0000-000000000003', 'nofinance@a.test'),
  ('e1300000-0000-0000-0000-000000000004', 'owner@b.test');

insert into organizations (id, company_name, owner_uid) values
  ('e1310000-0000-0000-0000-00000000000a', 'Org A', 'e1300000-0000-0000-0000-000000000001'),
  ('e1310000-0000-0000-0000-00000000000b', 'Org B', 'e1300000-0000-0000-0000-000000000004');

insert into memberships (id, org_id, user_id, role) values
  ('e1320000-0000-0000-0000-000000000001', 'e1310000-0000-0000-0000-00000000000a', 'e1300000-0000-0000-0000-000000000001', 'owner'),
  ('e1320000-0000-0000-0000-000000000002', 'e1310000-0000-0000-0000-00000000000a', 'e1300000-0000-0000-0000-000000000002', 'member'),
  ('e1320000-0000-0000-0000-000000000003', 'e1310000-0000-0000-0000-00000000000a', 'e1300000-0000-0000-0000-000000000003', 'member'),
  ('e1320000-0000-0000-0000-000000000004', 'e1310000-0000-0000-0000-00000000000b', 'e1300000-0000-0000-0000-000000000004', 'owner');

-- The member without finance rights: payments and expenses taken away (0062).
insert into public.member_permissions (org_id, membership_id, resource, can_view, can_create, can_edit, can_delete) values
  ('e1310000-0000-0000-0000-00000000000a', 'e1320000-0000-0000-0000-000000000003', 'payments', false, false, false, false),
  ('e1310000-0000-0000-0000-00000000000a', 'e1320000-0000-0000-0000-000000000003', 'expenses', false, false, false, false),
  ('e1310000-0000-0000-0000-00000000000a', 'e1320000-0000-0000-0000-000000000003', 'financial_documents', false, false, false, false);

insert into public.financial_documents (id, org_id, type, status, doc_number, bill_to_name, grand_total)
values ('e1330000-0000-0000-0000-000000000001', 'e1310000-0000-0000-0000-00000000000a', 'invoice', 'sent', 'INV-A-1', 'Acme', 54000);

-- The API's proposals, as the service role.
set local role service_role;
insert into public.ai_actions (id, org_id, user_id, chat_id, tool, module, risk, status) values
  ('e1340000-0000-0000-0000-000000000001', 'e1310000-0000-0000-0000-00000000000a', 'e1300000-0000-0000-0000-000000000001', 'c1', 'update_task', 'tasks', 'low', 'confirmed'),
  ('e1340000-0000-0000-0000-000000000002', 'e1310000-0000-0000-0000-00000000000a', 'e1300000-0000-0000-0000-000000000002', 'c2', 'create_task', 'tasks', 'low', 'confirmed'),
  ('e1340000-0000-0000-0000-000000000003', 'e1310000-0000-0000-0000-00000000000a', 'e1300000-0000-0000-0000-000000000002', 'c2', 'create_task', 'tasks', 'low', 'proposed'),
  ('e1340000-0000-0000-0000-000000000004', 'e1310000-0000-0000-0000-00000000000a', 'e1300000-0000-0000-0000-000000000003', 'c3', 'create_cash_entry', 'finance', 'high', 'confirmed'),
  ('e1340000-0000-0000-0000-000000000005', 'e1310000-0000-0000-0000-00000000000b', 'e1300000-0000-0000-0000-000000000004', 'c4', 'create_task', 'tasks', 'low', 'proposed');
reset role;
select pg_temp.check(true, 'service role writes proposals');

-- ── who reads what ──────────────────────────────────────────────────────────
select pg_temp.check(pg_temp.count_as('e1300000-0000-0000-0000-000000000002',
  'select count(*) from public.ai_actions') = 2, 'a member reads only their own 2 actions');
select pg_temp.check(pg_temp.count_as('e1300000-0000-0000-0000-000000000001',
  'select count(*) from public.ai_actions') = 4, 'the owner reads all 4 of the org''s actions');
select pg_temp.check(pg_temp.count_as('e1300000-0000-0000-0000-000000000004',
  'select count(*) from public.ai_actions') = 1, 'another org reads only its own');

-- ── nobody writes from the browser ─────────────────────────────────────────
select pg_temp.check(pg_temp.err_as('e1300000-0000-0000-0000-000000000002',
  $q$insert into public.ai_actions (org_id, user_id, tool, risk) values ('e1310000-0000-0000-0000-00000000000a', 'e1300000-0000-0000-0000-000000000002', 'x', 'low')$q$) is not null,
  'a member cannot insert an action');
select pg_temp.check(pg_temp.err_as('e1300000-0000-0000-0000-000000000002',
  $q$update public.ai_actions set status = 'executed'$q$) is not null,
  'a member cannot move an action''s status (e.g. forge a confirmation)');
select pg_temp.check(pg_temp.err_as('e1300000-0000-0000-0000-000000000001',
  $q$delete from public.ai_actions$q$) is not null,
  'even the owner cannot delete the log');

-- ── the executor can do no more than the user ──────────────────────────────
select pg_temp.check(pg_temp.err_as('e1300000-0000-0000-0000-000000000003',
  $q$insert into public.payments (org_id, document_id, amount, paid_on, method) values ('e1310000-0000-0000-0000-00000000000a', 'e1330000-0000-0000-0000-000000000001', 54000, current_date, 'upi')$q$,
  'e1340000-0000-0000-0000-000000000004') is not null,
  'record_payment as a member without finance rights is refused, even with a confirmed agent action');
select pg_temp.check(pg_temp.err_as('e1300000-0000-0000-0000-000000000003',
  $q$insert into public.expenses (org_id, description, original_amount, category, incurred_on) values ('e1310000-0000-0000-0000-00000000000a', 'Chairs', 4500, 'furniture', current_date)$q$,
  'e1340000-0000-0000-0000-000000000004') is not null,
  'create_cash_entry as that member is refused too');
select pg_temp.check((select count(*) from public.payments where org_id = 'e1310000-0000-0000-0000-00000000000a') = 0
                 and (select count(*) from public.expenses where org_id = 'e1310000-0000-0000-0000-00000000000a') = 0,
  'and nothing was written');
select pg_temp.check(pg_temp.err_as('e1300000-0000-0000-0000-000000000002',
  $q$insert into public.expenses (org_id, description, original_amount, category, incurred_on) values ('e1310000-0000-0000-0000-00000000000a', 'Chairs', 4500, 'furniture', current_date)$q$,
  'e1340000-0000-0000-0000-000000000002') is null,
  'a member who does hold the right records it through the same path');

-- ── attribution ─────────────────────────────────────────────────────────────
select pg_temp.check(pg_temp.err_as('e1300000-0000-0000-0000-000000000002',
  $q$insert into public.tasks (org_id, title) values ('e1310000-0000-0000-0000-00000000000a', 'Agent task')$q$,
  'e1340000-0000-0000-0000-000000000002') is null, 'member creates a task via a confirmed action');
select pg_temp.check((select via = 'edgeai' and ai_action_id = 'e1340000-0000-0000-0000-000000000002'
                        and actor_id = 'e1300000-0000-0000-0000-000000000002'
                        from public.audit_log where entity_type = 'tasks' and diff ->> 'title' = 'Agent task'),
  'audit row: actor is the member, via edgeai, with the action id');

select pg_temp.check(pg_temp.err_as('e1300000-0000-0000-0000-000000000002',
  $q$insert into public.tasks (org_id, title) values ('e1310000-0000-0000-0000-00000000000a', 'Direct task')$q$) is null,
  'member creates a task by hand');
select pg_temp.check((select via is null and ai_action_id is null from public.audit_log where diff ->> 'title' = 'Direct task'),
  'no header → not attributed to EdgeAI');

select pg_temp.check(pg_temp.err_as('e1300000-0000-0000-0000-000000000002',
  $q$insert into public.tasks (org_id, title) values ('e1310000-0000-0000-0000-00000000000a', 'Borrowed id')$q$,
  'e1340000-0000-0000-0000-000000000001') is null, 'member sends the OWNER''s action id');
select pg_temp.check((select via is null and ai_action_id is null from public.audit_log where diff ->> 'title' = 'Borrowed id'),
  'someone else''s action id attributes nothing');

select pg_temp.check(pg_temp.err_as('e1300000-0000-0000-0000-000000000002',
  $q$insert into public.tasks (org_id, title) values ('e1310000-0000-0000-0000-00000000000a', 'Unconfirmed')$q$,
  'e1340000-0000-0000-0000-000000000003') is null, 'member sends a merely proposed action id');
select pg_temp.check((select via is null from public.audit_log where diff ->> 'title' = 'Unconfirmed'),
  'an unconfirmed proposal attributes nothing');

select pg_temp.check(pg_temp.err_as('e1300000-0000-0000-0000-000000000002',
  $q$insert into public.tasks (org_id, title) values ('e1310000-0000-0000-0000-00000000000a', 'Garbage header')$q$,
  null) is null and pg_temp.err_as('e1300000-0000-0000-0000-000000000002',
  $q$select set_config('request.headers', '{"x-edgeos-agent-action": "not-a-uuid"}', true)$q$) is null,
  'a malformed header never breaks a write');

-- ── the permission row exists for every org (the silent-403 case) ──────────
select pg_temp.check((select count(distinct org_id) from public.role_permissions where resource = 'ai_actions')
                     = (select count(*) from public.organizations), 'every org has ai_actions permission rows');

rollback;
