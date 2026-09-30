-- ============================================================================
-- EdgeOS · Telegram person principal (0071)
--
-- A company person with NO StartupBuddy login acts through a linked Telegram
-- account. The API signs a token with role 'authenticated', no `sub`, and an
-- sb_person claim naming the link. What must hold:
--
--   · the person reads and writes their own company's operational data —
--     tasks, clients, invoices, quotations, payments, cash in/out, HR records
--     (offer letters, NDAs) — as the company's admin role could;
--   · they never delete anything, and never see governance or pay;
--   · they never see another company, even with a claim that names it;
--   · the claim is only a pointer: a revoked link, a person who left, a claim
--     whose parts do not match one live link, or a real user's token carrying
--     the claim — all get nothing, immediately;
--   · the guards that used to skip their check for "no auth.uid()" apply to
--     the person too;
--   · the audit trigger records the person, and EdgeAI attribution works for
--     their confirmed actions.
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

-- Acts as a person principal (no sub), as PostgREST would with the API's token.
create or replace function pg_temp.be_person(p_link uuid, p_person uuid, p_org uuid, p_action uuid default null, p_sub uuid default null)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
  perform set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object(
    'role', 'authenticated', 'sub', p_sub,
    'sb_person', jsonb_build_object('link', p_link, 'person', p_person, 'org', p_org)))::text, true);
  perform set_config('request.headers',
    case when p_action is null then '{}' else json_build_object('x-edgeos-agent-action', p_action)::text end, true);
end $$;

create or replace function pg_temp.person_err(p_sql text, p_action uuid default null,
  p_link uuid default 'e1560000-0000-0000-0000-000000000001', p_person uuid default 'e1550000-0000-0000-0000-000000000001',
  p_org uuid default 'e1510000-0000-0000-0000-00000000000a') returns text language plpgsql as $$
begin
  perform pg_temp.be_person(p_link, p_person, p_org, p_action);
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

create or replace function pg_temp.person_count(p_sql text,
  p_link uuid default 'e1560000-0000-0000-0000-000000000001', p_person uuid default 'e1550000-0000-0000-0000-000000000001',
  p_org uuid default 'e1510000-0000-0000-0000-00000000000a') returns bigint language plpgsql as $$
declare n bigint;
begin
  perform pg_temp.be_person(p_link, p_person, p_org);
  perform set_config('role', 'authenticated', true);
  execute p_sql into n;
  reset role;
  return n;
end $$;

create or replace function pg_temp.person_bool(p_sql text) returns boolean language plpgsql as $$
declare b boolean;
begin
  -- The app.* helpers are not callable by client roles; the claims are what
  -- they read, so they are evaluated here as the test owner.
  perform pg_temp.be_person('e1560000-0000-0000-0000-000000000001', 'e1550000-0000-0000-0000-000000000001', 'e1510000-0000-0000-0000-00000000000a');
  execute p_sql into b;
  return b;
end $$;

-- Catalysis23 (A): the founder Nikhil (a user), Swetha and Madheswaran (people,
-- no login). Org B: its own owner and a client.
insert into auth.users (id, email) values
  ('e1500000-0000-0000-0000-000000000001', 'nikhil@a.test'),
  ('e1500000-0000-0000-0000-000000000002', 'owner@b.test');

insert into organizations (id, company_name, owner_uid) values
  ('e1510000-0000-0000-0000-00000000000a', 'Catalysis23', 'e1500000-0000-0000-0000-000000000001'),
  ('e1510000-0000-0000-0000-00000000000b', 'Org B', 'e1500000-0000-0000-0000-000000000002');

insert into memberships (org_id, user_id, role) values
  ('e1510000-0000-0000-0000-00000000000a', 'e1500000-0000-0000-0000-000000000001', 'owner'),
  ('e1510000-0000-0000-0000-00000000000b', 'e1500000-0000-0000-0000-000000000002', 'owner');

insert into public.employees (id, org_id, full_name, user_id) values
  ('e1550000-0000-0000-0000-000000000001', 'e1510000-0000-0000-0000-00000000000a', 'Swetha NM', null),
  ('e1550000-0000-0000-0000-000000000002', 'e1510000-0000-0000-0000-00000000000a', 'Madheswaran', null),
  ('e1550000-0000-0000-0000-000000000009', 'e1510000-0000-0000-0000-00000000000b', 'Bob (Org B)', null);

select pg_temp.check(not exists (select 1 from public.employees
                                   where id in ('e1550000-0000-0000-0000-000000000001', 'e1550000-0000-0000-0000-000000000002')
                                     and user_id is not null)
                 and not exists (select 1 from auth.users where id in ('e1550000-0000-0000-0000-000000000001', 'e1550000-0000-0000-0000-000000000002')),
  'A: Swetha and Madheswaran exist as people with no auth account');

-- The API links Telegram accounts (service role).
set local role service_role;
insert into public.telegram_links (id, org_id, employee_id, telegram_user_id, linked_via) values
  ('e1560000-0000-0000-0000-000000000001', 'e1510000-0000-0000-0000-00000000000a', 'e1550000-0000-0000-0000-000000000001', 7001, 'person_invite'),
  ('e1560000-0000-0000-0000-000000000002', 'e1510000-0000-0000-0000-00000000000a', 'e1550000-0000-0000-0000-000000000002', 7002, 'person_invite'),
  ('e1560000-0000-0000-0000-000000000009', 'e1510000-0000-0000-0000-00000000000b', 'e1550000-0000-0000-0000-000000000009', 7009, 'person_invite');
reset role;

-- ── the link table's own rules ──────────────────────────────────────────────
do $$ begin
  begin
    insert into public.telegram_links (org_id, employee_id, telegram_user_id, linked_via)
    values ('e1510000-0000-0000-0000-00000000000b', 'e1550000-0000-0000-0000-000000000001', 7100, 'person_invite');
    raise exception 'FAIL  a link naming a person of ANOTHER company was accepted';
  exception when foreign_key_violation then raise notice '  PASS  a link''s person must be in the link''s company (composite FK)';
  end;
  begin
    insert into public.telegram_links (org_id, employee_id, telegram_user_id, linked_via)
    values ('e1510000-0000-0000-0000-00000000000b', 'e1550000-0000-0000-0000-000000000009', 7001, 'person_invite');
    raise exception 'FAIL  one Telegram account became two live company people';
  exception when unique_violation then raise notice '  PASS  a Telegram account is at most one live company person';
  end;
  begin
    insert into public.telegram_links (org_id, user_id, employee_id, telegram_user_id, linked_via)
    values ('e1510000-0000-0000-0000-00000000000a', 'e1500000-0000-0000-0000-000000000001', 'e1550000-0000-0000-0000-000000000002', 7200, 'invite');
    raise exception 'FAIL  a link to a user AND a person was accepted';
  exception when check_violation then raise notice '  PASS  a link is to a user or to a person, never both';
  end;
end $$;

-- Company data in both companies.
insert into public.clients (id, org_id, name) values
  ('e1570000-0000-0000-0000-00000000000a', 'e1510000-0000-0000-0000-00000000000a', 'Sponsor Co'),
  ('e1570000-0000-0000-0000-00000000000b', 'e1510000-0000-0000-0000-00000000000b', 'B Client');
insert into public.tasks (id, org_id, title) values
  ('e1580000-0000-0000-0000-00000000000a', 'e1510000-0000-0000-0000-00000000000a', 'Follow up sponsor'),
  ('e1580000-0000-0000-0000-00000000000b', 'e1510000-0000-0000-0000-00000000000b', 'B task');
insert into public.financial_documents (id, org_id, type, status, doc_number, bill_to_name, grand_total) values
  ('e1590000-0000-0000-0000-00000000000a', 'e1510000-0000-0000-0000-00000000000a', 'invoice', 'draft', 'INV-A-1', 'Sponsor Co', 25000),
  ('e1590000-0000-0000-0000-00000000000b', 'e1510000-0000-0000-0000-00000000000b', 'invoice', 'draft', 'INV-B-1', 'B Client', 1000);

-- ── identity ────────────────────────────────────────────────────────────────
select pg_temp.check(pg_temp.person_bool($q$select app.person_principal('e1510000-0000-0000-0000-00000000000a') = 'e1550000-0000-0000-0000-000000000001'$q$),
  'R: Swetha''s Telegram identity resolves to her person record with no auth account');
select pg_temp.check(pg_temp.person_bool($q$select app.my_employee_id('e1510000-0000-0000-0000-00000000000a') = 'e1550000-0000-0000-0000-000000000001'$q$),
  '"my tasks" resolves to her employee record');
select pg_temp.check(pg_temp.person_bool($q$select app.is_member('e1510000-0000-0000-0000-00000000000a') and not app.is_member('e1510000-0000-0000-0000-00000000000b')$q$),
  'she is a member of her company only');
select pg_temp.check(pg_temp.person_bool($q$select not app.is_admin('e1510000-0000-0000-0000-00000000000a')$q$),
  'she is never an owner/admin (pay and admin-only data stay hidden)');

-- ── operational work: view / create / edit ─────────────────────────────────
select pg_temp.check(pg_temp.person_count('select count(*) from public.tasks') = 1
                 and pg_temp.person_count('select count(*) from public.clients') = 1
                 and pg_temp.person_count('select count(*) from public.financial_documents') = 1,
  'D: she reads her company''s tasks, clients and invoices — and only those');

select pg_temp.check(pg_temp.person_err($q$insert into public.tasks (org_id, title, assignee_id) values ('e1510000-0000-0000-0000-00000000000a', 'Call sponsor tomorrow', 'e1550000-0000-0000-0000-000000000001')$q$) is null,
  'F: she creates a task');
select pg_temp.check(pg_temp.person_err($q$update public.tasks set assignee_id = 'e1550000-0000-0000-0000-000000000002' where id = 'e1580000-0000-0000-0000-00000000000a'$q$) is null,
  'G: she assigns a task to a teammate');
select pg_temp.check((select assignee_id from public.tasks where id = 'e1580000-0000-0000-0000-00000000000a') = 'e1550000-0000-0000-0000-000000000002',
  'G: the assignment is saved');
select pg_temp.check(pg_temp.person_err($q$update public.tasks set status = 'done' where id = 'e1580000-0000-0000-0000-00000000000a'$q$) is null,
  'she completes a task');
select pg_temp.check(pg_temp.person_err($q$insert into public.financial_documents (org_id, type, status, bill_to_name, doc_number) values ('e1510000-0000-0000-0000-00000000000a', 'invoice', 'draft', 'Client X', public.next_document_number('e1510000-0000-0000-0000-00000000000a', 'invoice'))$q$) is null,
  'H: she creates an invoice, numbered the way Buddy''s tool numbers it');
select pg_temp.check(pg_temp.person_err($q$update public.financial_documents set notes = 'Net 15' where id = 'e1590000-0000-0000-0000-00000000000a'$q$) is null,
  'she edits an invoice');
select pg_temp.check(pg_temp.person_err($q$insert into public.financial_documents (org_id, type, status, bill_to_name, doc_number) values ('e1510000-0000-0000-0000-00000000000a', 'quotation', 'draft', 'Client X', public.next_document_number('e1510000-0000-0000-0000-00000000000a', 'quotation'))$q$) is null,
  'K: she creates an offer (quotation)');
select pg_temp.check(pg_temp.person_err($q$insert into public.income_entries (org_id, description, original_amount, received_on) values ('e1510000-0000-0000-0000-00000000000a', 'Sponsor advance', 25000, current_date)$q$) is null,
  'I: she records cash in');
select pg_temp.check(pg_temp.person_err($q$insert into public.expenses (org_id, description, original_amount, category, incurred_on) values ('e1510000-0000-0000-0000-00000000000a', 'Office supplies', 5000, 'office', current_date)$q$) is null,
  'J: she records cash out');
select pg_temp.check(pg_temp.person_err($q$insert into public.payments (org_id, document_id, amount, paid_on, method) values ('e1510000-0000-0000-0000-00000000000a', 'e1590000-0000-0000-0000-00000000000a', 1000, current_date, 'upi')$q$) is null,
  'she records a payment against an invoice');
select pg_temp.check(pg_temp.person_err($q$insert into public.records (org_id, type, status, title, doc_number) values ('e1510000-0000-0000-0000-00000000000a', 'nda', 'draft', 'NDA — Vendor Y', public.next_document_number('e1510000-0000-0000-0000-00000000000a', 'nda'))$q$) is null
                 and pg_temp.person_err($q$insert into public.records (org_id, type, status, title, doc_number) values ('e1510000-0000-0000-0000-00000000000a', 'offer', 'draft', 'Offer — New hire', public.next_document_number('e1510000-0000-0000-0000-00000000000a', 'offer'))$q$) is null,
  'L: she creates an NDA and an offer letter');
select pg_temp.check(pg_temp.person_err($q$insert into public.clients (org_id, name) values ('e1510000-0000-0000-0000-00000000000a', 'New Client')$q$) is null
                 and pg_temp.person_err($q$update public.clients set notes = 'Budget frozen till March' where id = 'e1570000-0000-0000-0000-00000000000a'$q$) is null,
  'M: she creates and updates clients');

-- ── never delete ────────────────────────────────────────────────────────────
select pg_temp.check(pg_temp.person_bool($q$select not app.has_permission('e1510000-0000-0000-0000-00000000000a', 'tasks', 'delete')
  and not exists (select 1 from public.my_permissions('e1510000-0000-0000-0000-00000000000a') where can_delete)$q$),
  'N: her permission map holds no delete at all');
select pg_temp.person_err($q$delete from public.tasks where id = 'e1580000-0000-0000-0000-00000000000a'$q$);
select pg_temp.person_err($q$delete from public.financial_documents where id = 'e1590000-0000-0000-0000-00000000000a'$q$);
select pg_temp.person_err($q$delete from public.clients where id = 'e1570000-0000-0000-0000-00000000000a'$q$);
select pg_temp.check((select count(*) from public.tasks where id = 'e1580000-0000-0000-0000-00000000000a') = 1
                 and (select count(*) from public.financial_documents where id = 'e1590000-0000-0000-0000-00000000000a') = 1
                 and (select count(*) from public.clients where id = 'e1570000-0000-0000-0000-00000000000a') = 1,
  'N: her deletes of a task, an invoice and a client remove nothing');

-- ── governance ──────────────────────────────────────────────────────────────
select pg_temp.check(pg_temp.person_bool($q$select not app.has_permission('e1510000-0000-0000-0000-00000000000a', 'memberships', 'create')
  and not app.has_permission('e1510000-0000-0000-0000-00000000000a', 'organizations', 'edit')
  and not app.has_permission('e1510000-0000-0000-0000-00000000000a', 'audit_log', 'view')$q$),
  'she cannot manage team access, the company profile or the activity log');

-- ── company isolation ───────────────────────────────────────────────────────
select pg_temp.check(pg_temp.person_err($q$insert into public.tasks (org_id, title) values ('e1510000-0000-0000-0000-00000000000b', 'Sneaky')$q$) is not null,
  'P: she cannot write into Company B');
select pg_temp.check(pg_temp.person_err($q$select public.next_document_number('e1510000-0000-0000-0000-00000000000b', 'invoice')$q$) is not null,
  'P: nor take a document number in Company B');
select pg_temp.person_err($q$update public.tasks set title = 'hijacked' where id = 'e1580000-0000-0000-0000-00000000000b'$q$);
select pg_temp.check((select title from public.tasks where id = 'e1580000-0000-0000-0000-00000000000b') = 'B task',
  'P: nor change Company B''s rows');
select pg_temp.check(pg_temp.person_count('select count(*) from public.tasks',
  'e1560000-0000-0000-0000-000000000001', 'e1550000-0000-0000-0000-000000000001', 'e1510000-0000-0000-0000-00000000000b') = 0,
  'P: a claim that names Company B with her link opens nothing');
select pg_temp.check(pg_temp.person_count('select count(*) from public.tasks',
  'e1560000-0000-0000-0000-000000000001', 'e1550000-0000-0000-0000-000000000009', 'e1510000-0000-0000-0000-00000000000b') = 0,
  'P: her link with Company B''s person opens nothing');
select pg_temp.check(pg_temp.person_count('select count(*) from public.tasks',
  'e1560000-0000-0000-0000-000000000009', 'e1550000-0000-0000-0000-000000000001', 'e1510000-0000-0000-0000-00000000000a') = 0,
  'a Company B link with Swetha''s person opens nothing');

-- ── the claim is only a pointer ─────────────────────────────────────────────
select pg_temp.check((select count(*) from (select pg_temp.be_person(null, null, null)) x) = 1
  and (select app.person_principal(null)) is null, 'O: no claim, no identity');
do $$ declare n bigint; begin
  perform set_config('request.jwt.claim.sub', 'e1500000-0000-0000-0000-000000000002', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', 'e1500000-0000-0000-0000-000000000002',
    'sb_person', jsonb_build_object('link', 'e1560000-0000-0000-0000-000000000001', 'person', 'e1550000-0000-0000-0000-000000000001', 'org', 'e1510000-0000-0000-0000-00000000000a'))::text, true);
  set local role authenticated;
  select count(*) into n from public.tasks where org_id = 'e1510000-0000-0000-0000-00000000000a';
  reset role;
  if n <> 0 then raise exception 'FAIL  a real user''s token carrying the claim read Company A'; end if;
  raise notice '  PASS  a real user''s token carrying an sb_person claim gains nothing from it';
end $$;

-- ── revocation is immediate ─────────────────────────────────────────────────
select pg_temp.check(pg_temp.person_count('select count(*) from public.tasks',
  'e1560000-0000-0000-0000-000000000002', 'e1550000-0000-0000-0000-000000000002') >= 1, 'Madheswaran reads tasks while linked');
update public.telegram_links set revoked_at = now(), revoked_reason = 'admin_unlink' where id = 'e1560000-0000-0000-0000-000000000002';
select pg_temp.check(pg_temp.person_count('select count(*) from public.tasks',
  'e1560000-0000-0000-0000-000000000002', 'e1550000-0000-0000-0000-000000000002') = 0,
  'Q: revoking his link blocks the very next query, with the same token');
select pg_temp.check(pg_temp.person_err($q$insert into public.tasks (org_id, title) values ('e1510000-0000-0000-0000-00000000000a', 'After revoke')$q$, null,
  'e1560000-0000-0000-0000-000000000002', 'e1550000-0000-0000-0000-000000000002') is not null,
  'Q: and he cannot write');

-- ── attribution ─────────────────────────────────────────────────────────────
set local role service_role;
insert into public.ai_actions (id, org_id, user_id, employee_id, channel_actor, chat_id, tool, module, risk, status) values
  ('e15a0000-0000-0000-0000-000000000001', 'e1510000-0000-0000-0000-00000000000a', null, 'e1550000-0000-0000-0000-000000000001', 'telegram:7001', 'tg:7001', 'create_task', 'tasks', 'low', 'confirmed'),
  ('e15a0000-0000-0000-0000-000000000002', 'e1510000-0000-0000-0000-00000000000a', 'e1500000-0000-0000-0000-000000000001', null, null, 'web', 'create_task', 'tasks', 'low', 'confirmed');
reset role;
select pg_temp.check(pg_temp.person_err($q$insert into public.tasks (org_id, title) values ('e1510000-0000-0000-0000-00000000000a', 'Agent task by Swetha')$q$,
  'e15a0000-0000-0000-0000-000000000001') is null, 'S: a confirmed Buddy action of hers writes through the same path');
select pg_temp.check((select via = 'edgeai' and ai_action_id = 'e15a0000-0000-0000-0000-000000000001'
                        and actor_id is null and actor_employee_id = 'e1550000-0000-0000-0000-000000000001'
                        from public.audit_log where diff ->> 'title' = 'Agent task by Swetha'),
  'audit: the person is recorded as the actor, via EdgeAI, with the action id');
select pg_temp.check(pg_temp.person_err($q$insert into public.tasks (org_id, title) values ('e1510000-0000-0000-0000-00000000000a', 'Borrowed by Swetha')$q$,
  'e15a0000-0000-0000-0000-000000000002') is null, 'she writes while sending the founder''s action id');
select pg_temp.check((select via is null from public.audit_log where diff ->> 'title' = 'Borrowed by Swetha'),
  'the founder''s action id attributes nothing to her');

-- ── the guards that skipped "no auth.uid()" now apply ──────────────────────
select pg_temp.check(pg_temp.person_bool($q$select app.is_signed_in()$q$), 'a person principal counts as signed in');
select pg_temp.check((select not app.is_signed_in() from (select pg_temp.be_person(null, null, null)) x),
  'the database''s own writes are still recognised as such');
select pg_temp.check(not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('app', 'public') and p.prosrc ~* 'auth\.uid\(\)\s+is\s+(not\s+)?null'
       and p.proname not in ('person_principal', 'is_signed_in', 'has_permission', 'my_permissions')),
  'no guard still reads "auth.uid() is null" as a trusted write');

rollback;
