-- ============================================================================
-- EdgeOS · Tenant isolation under every role
--
-- 01_isolation_test.sql proves isolation for the roles its fixture happens to
-- use. Once roles are data (0026), "every role" is no longer a fixed list, so
-- this file derives its callers from the `roles` table: one user per role in
-- organization P, whatever roles exist when it runs. A role added next year is
-- covered without anyone editing this file.
--
-- It also adds one role that did not exist before this phase — `ops_lead` —
-- the way a future role will be added: rows in `roles` and
-- `role_permission_defaults`, no DDL. ops_lead is granted EVERY action the
-- matrix can express, making it the most powerful configurable role possible;
-- if configuration could leak across tenants, it would leak here.
--
-- Every probe runs through the real RLS engine as `authenticated`:
--
--   foreign org  every caller of P (and Q's owner, the other way) against every
--                tenant table and storage bucket of the other org:
--                SELECT sees 0 rows, UPDATE and DELETE touch 0 rows, INSERT of
--                a copy of the other org's row fails with 42501. No exceptions,
--                for any role.
--   own org      the same four verbs against the caller's own org must match
--                exactly what role_permissions says (and what the grants
--                allow). This is the positive control: it proves the probes can
--                observe access at all, so the zeros above mean something.
--
-- Every write is rolled back inside its own subtransaction; the whole file runs
-- in one transaction and rolls back at the end.
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

-- ─── A role that did not exist before this phase, added as configuration ─────
insert into roles (key, label, description, sort_order)
values ('ops_lead', 'Ops lead', 'Test role: every configurable action.', 50);

-- Every action every resource supports. The 0026 statement trigger propagates
-- this to every existing organization.
insert into role_permission_defaults (role, resource, can_view, can_create, can_edit, can_delete)
select 'ops_lead', key, 'view' = any(actions), 'create' = any(actions),
       'edit' = any(actions), 'delete' = any(actions)
  from permission_resources;

-- ─── Fixture: organizations P and Q, one row in every tenant table each ──────
insert into auth.users (id, email)
select ('b0000000-0000-0000-0000-' || lpad(row_number() over (order by sort_order)::text, 12, '0'))::uuid,
       'p-' || key || '@p.test'
  from roles;
insert into auth.users (id, email) values
  ('b0000000-0000-0000-0000-0000000000f1', 'q-owner@q.test'),
  ('b0000000-0000-0000-0000-0000000000f2', 'q-member@q.test');

insert into organizations (id, company_name, owner_uid) values
  ('c0000000-0000-0000-0000-00000000000a', 'Org P', 'b0000000-0000-0000-0000-000000000001'),
  ('c0000000-0000-0000-0000-00000000000b', 'Org Q', 'b0000000-0000-0000-0000-0000000000f1');

-- One member of P per role.
insert into memberships (org_id, user_id, role)
select 'c0000000-0000-0000-0000-00000000000a', u.id, r.key
  from roles r
  join auth.users u on u.email = 'p-' || r.key || '@p.test';
insert into memberships (org_id, user_id, role) values
  ('c0000000-0000-0000-0000-00000000000b', 'b0000000-0000-0000-0000-0000000000f1', 'owner'),
  ('c0000000-0000-0000-0000-00000000000b', 'b0000000-0000-0000-0000-0000000000f2', 'member');

do $$
declare o uuid; s text; d uuid; e uuid; f uuid; r uuid; n uuid; l uuid; v uuid;
        ie uuid; pj uuid; bn1 uuid; bn2 uuid; ld uuid;
begin
  foreach o in array array['c0000000-0000-0000-0000-00000000000a',
                           'c0000000-0000-0000-0000-00000000000b']::uuid[] loop
    s := right(o::text, 1);   -- 'a' or 'b'
    insert into org_banking (org_id, bank_name) values (o, 'Bank ' || s);
    insert into org_secrets (org_id, gmail_user) values (o, 'ops-' || s || '@x.test');
    insert into org_settings (org_id) values (o);
    insert into subscriptions (org_id) values (o);
    insert into usage_counters (org_id) values (o);
    insert into ai_company_memory (org_id) values (o);
    insert into document_counters (org_id, type, year) values (o, 'invoice', 2026);
    insert into email_events (org_id, kind) values (o, 'send');
    insert into departments (org_id, name) values (o, 'Dept ' || s) returning id into d;
    insert into employees (org_id, full_name, department_id) values (o, 'Emp ' || s, d) returning id into e;
    insert into employee_compensation (employee_id, org_id, amount) values (e, o, 100000);
    insert into tasks (org_id, title) values (o, 'Task ' || s);
    insert into customers (org_id, name) values (o, 'Customer ' || s);
    insert into crm_leads (org_id, company_name) values (o, 'Lead ' || s);
    insert into products (org_id, name) values (o, 'Product ' || s);
    insert into clients (org_id, name) values (o, 'Client ' || s);
    insert into catalog_items (org_id, name, sku) values (o, 'Item ' || s, 'SKU-' || s);
    insert into expenses (org_id, description, amount) values (o, 'Expense ' || s, 10);
    insert into records (org_id, doc_number, type, title) values (o, 'OL-2026-9' || s, 'offer', 'Offer ' || s)
      returning id into r;
    insert into financial_documents (org_id, doc_number, type, bill_to_name)
      values (o, 'INV-2026-9' || s, 'invoice', 'Bill ' || s) returning id into f;
    insert into document_line_items (document_id, org_id, position, description, quantity, rate)
      values (f, o, 1, 'Line ' || s, 1, 0);
    -- Unconfirmed, so it does not move amount_paid past a zero grand total.
    insert into payments (org_id, document_id, amount) values (o, f, 1);
    insert into recurring_invoices (org_id, bill_to_name, frequency, start_date)
      values (o, 'Bill ' || s, 'monthly', current_date);
    insert into document_signatures (org_id, financial_doc_id, outcome, signer_name)
      values (o, f, 'accepted', 'Signer ' || s);
    insert into portal_tokens (org_id, scope, financial_doc_id, expires_at)
      values (o, 'view', f, now() + interval '1 day');
    insert into notifications (org_id, type, title) values (o, 'info', 'Note ' || s) returning id into n;
    insert into invitations (org_id, email, role, expires_at)
      values (o, 'invitee-' || s || '@x.test', 'member', now() + interval '7 days');
    insert into audit_log (org_id, action, entity_type) values (o, 'fixture', 'clients');

    -- Payables (0028).
    insert into vendors (org_id, company_name) values (o, 'Vendor ' || s) returning id into v;
    insert into purchase_invoices (org_id, vendor_id, bill_number, bill_date)
      values (o, v, 'BILL-9' || s, current_date);

    -- People ops (0029). leave_types are seeded per organization by
    -- app.seed_leave_types_trigger, so one is selected rather than inserted.
    select id into l from leave_types where org_id = o order by sort_order limit 1;
    insert into attendance_days (org_id, employee_id, work_date, status)
      values (o, e, current_date, 'present');
    insert into leave_requests (org_id, employee_id, leave_type_id, start_date, end_date, days)
      values (o, e, l, current_date, current_date, 1);
    insert into leave_adjustments (org_id, employee_id, leave_type_id, year, delta)
      values (o, e, l, extract(year from current_date)::int, 1);
    insert into announcements (org_id, title, body) values (o, 'Notice ' || s, 'Body ' || s);

    -- Cash book (0038).
    insert into income_entries (org_id, description, original_amount)
      values (o, 'Income ' || s, 10) returning id into ie;

    -- EdgeBrain (0033–0036). brain_state and brain_dirty may already hold the
    -- org from the sync triggers above.
    insert into brain_state (org_id) values (o) on conflict do nothing;
    insert into brain_dirty (org_id) values (o) on conflict do nothing;
    insert into brain_sync_runs (org_id, mode) values (o, 'full');
    insert into brain_nodes (org_id, kind, entity_id, source_table, label)
      values (o, 'client', gen_random_uuid(), 'clients', 'Node 1 ' || s) returning id into bn1;
    insert into brain_nodes (org_id, kind, entity_id, source_table, label)
      values (o, 'client', gen_random_uuid(), 'clients', 'Node 2 ' || s) returning id into bn2;
    insert into brain_edges (org_id, src_id, dst_id, rel) values (o, bn1, bn2, 'related');
    insert into brain_metrics (org_id, key) values (o, 'fixture.metric');
    insert into brain_insights (org_id, title, body) values (o, 'Insight ' || s, 'Body ' || s);

    -- Projects (0044–0052). project_code_counters is filled by the insert.
    insert into projects (org_id, name) values (o, 'Project ' || s) returning id into pj;
    insert into project_members (org_id, project_id, employee_id) values (o, pj, e);
    insert into project_milestones (org_id, project_id, title) values (o, pj, 'Milestone ' || s);
    insert into project_documents (org_id, project_id, record_id) values (o, pj, r);
    insert into project_allocations (org_id, project_id, source_type, source_id, mode)
      values (o, pj, 'income_entry', ie, 'full');
    insert into timesheet_entries (org_id, employee_id, project_id, work_date, minutes)
      values (o, e, pj, current_date, 60);

    -- AI call log (0067), written by the API.
    insert into ai_usage_events (org_id, surface) values (o, 'copilot');

    -- EdgeAI proposals (0068), written by the API. Readable by their author
    -- and the org's owners/admins only — asserted in 13_ai_actions_test.sql.
    insert into ai_actions (org_id, user_id, tool, risk)
    select o, m.user_id, 'create_task', 'low' from memberships m where m.org_id = o limit 1;

    -- Telegram adapter (0070, 0071): server-only tables, and the Daily Pulse
    -- log (readable by its person and owners/admins — 15_telegram_person_test
    -- and the pulse policy; here it only has to stay inside its org).
    insert into org_telegram (org_id) values (o);
    insert into telegram_chats (org_id, chat_id, chat_type)
      values (o, case s when 'a' then -1001 else -1002 end, 'group');
    insert into telegram_links (org_id, employee_id, telegram_user_id, linked_via)
      values (o, e, case s when 'a' then 9001 else 9002 end, 'person_invite');
    insert into telegram_link_tokens (token_hash, org_id, purpose, created_by, expires_at)
    select 'hash-' || s, o, 'group', m.user_id, now() + interval '1 hour' from memberships m where m.org_id = o limit 1;
    insert into telegram_conversations (chat_id, telegram_user_id, org_id)
      values (case s when 'a' then 1 else 2 end, 9000, o);
    insert into pulse_checkins (org_id, user_id, pulse_date, channel)
    select o, m.user_id, current_date, 'telegram' from memberships m where m.org_id = o limit 1;

    -- Document library (0063): a stored file and one passage read from it.
    insert into library_documents (org_id, title, file_name, mime_type, size_bytes, storage_path)
      values (o, 'Handbook ' || s, 'handbook.pdf', 'application/pdf', 1024, o || '/handbook-' || s || '.pdf')
      returning id into ld;
    insert into library_chunks (org_id, document_id, seq, heading, content)
      values (o, ld, 0, 'Page 1', 'Leave policy for ' || s);

    -- Document versions (0064): issuing a link sends the offer, which takes
    -- its v1 and opens the thread; the recipient comments on it.
    insert into portal_tokens (org_id, scope, record_id, expires_at)
      values (o, 'sign', r, now() + interval '1 day');
    insert into document_negotiation_events (version_id, kind, actor_type, body)
      select current_version_id, 'comment', 'recipient', 'Comment ' || s from records where id = r;

    -- Per-person exceptions (0062): one for the org's member-role login, equal
    -- to its role's row so the matrix expectations below still hold.
    insert into member_permissions (org_id, membership_id, resource, can_view, can_create, can_edit, can_delete)
    select o, m.id, rp.resource, rp.can_view, rp.can_create, rp.can_edit, rp.can_delete
      from memberships m
      join role_permissions rp on rp.org_id = m.org_id and rp.role = m.role and rp.resource = 'clients'
     where m.org_id = o and m.role = 'member';

    insert into storage.objects (bucket_id, name) values ('employee-photos', o || '/' || e || '.jpg');

    insert into storage.objects (bucket_id, name) values
      ('org-branding', o || '/logo.png'),
      ('signatures',   o || '/sig.png'),
      ('documents',    o || '/doc.pdf');
  end loop;

  -- Q's member has read one of Q's notifications.
  insert into notification_reads (notification_id, user_id)
  select id, 'b0000000-0000-0000-0000-0000000000f2' from notifications
   where org_id = 'c0000000-0000-0000-0000-00000000000b';
end $$;

-- Every tenant table must have a fixture row in both orgs, or a probe below
-- would be vacuous. This fails loudly when a phase 3–6 table is added and not
-- given one here.
do $$
declare t text; n integer;
begin
  for t in
    select c.table_name from information_schema.columns c
      join information_schema.tables tb using (table_schema, table_name)
     where c.table_schema = 'public' and c.column_name = 'org_id' and tb.table_type = 'BASE TABLE'
       and c.table_name not in ('role_permissions', 'memberships', 'legacy_id_map')
  loop
    execute format('select count(distinct org_id) from public.%I
                     where org_id in (''c0000000-0000-0000-0000-00000000000a'',
                                      ''c0000000-0000-0000-0000-00000000000b'')', t) into n;
    if n <> 2 then
      raise exception 'fixture gap: public.% has rows in % of the 2 orgs — add it to 03_role_isolation_test.sql', t, n;
    end if;
  end loop;
end $$;

-- ─── Callers ─────────────────────────────────────────────────────────────────
create temp table _callers as
select m.user_id as uid, m.org_id as own_org, m.role,
       case m.org_id when 'c0000000-0000-0000-0000-00000000000a'
                     then 'c0000000-0000-0000-0000-00000000000b'::uuid
                     else 'c0000000-0000-0000-0000-00000000000a'::uuid end as foreign_org,
       case m.org_id when 'c0000000-0000-0000-0000-00000000000a' then 'P:' else 'Q:' end || m.role as label
  from memberships m
 where m.org_id in ('c0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-00000000000b');

select pg_temp.check(
  (select count(*) from _callers where label like 'P:%') = (select count(*) from roles)
  and exists (select 1 from _callers where role = 'ops_lead'),
  format('%s roles exist; P has one member per role (%s), including the new ops_lead',
    (select count(*) from roles),
    (select string_agg(role, ', ' order by role) from _callers where label like 'P:%')));

-- ─── The probe ───────────────────────────────────────────────────────────────
-- Runs one statement as `authenticated` with the caller's JWT, inside a
-- subtransaction that is always rolled back, and reports:
--   'allow:<n>'  the statement ran (n = rows returned / affected)
--   'deny'       42501: no grant, or an RLS WITH CHECK rejection
--   'error:<sqlstate>'  anything else — RLS let the statement through and
--                something later stopped it (a constraint, a trigger)
create or replace function pg_temp.probe(p_uid uuid, p_sql text) returns text
language plpgsql as $$
declare n bigint; v_result text;
begin
  begin
    perform set_config('request.jwt.claim.sub', p_uid::text, true);
    execute 'set local role authenticated';
    execute p_sql into n;
    raise exception using errcode = 'ZX999', message = coalesce(n, 0)::text;
  exception
    when sqlstate 'ZX999' then v_result := 'allow:' || sqlerrm;
    when insufficient_privilege then v_result := 'deny';
    when others then v_result := 'error:' || sqlstate;
  end;
  return v_result;   -- the subtransaction's SET ROLE is gone; we are postgres again
end $$;

-- ─── Tables, their resource, and a sample row per org ────────────────────────
create temp table _tables as
select c.table_name as tbl,
       -- Tables whose permission key is not their own name.
       coalesce((select key from permission_resources
                  where key = case c.table_name
                                when 'project_code_counters' then 'projects'
                                when 'timesheet_entries' then 'timesheets'
                                when 'library_chunks'  then 'library_documents'
                                when 'ai_usage_events' then 'usage_counters'
                                when 'document_negotiation_events' then 'document_negotiation'
                                when 'brain_nodes'     then 'edgebrain'
                                when 'brain_edges'     then 'edgebrain'
                                when 'brain_metrics'   then 'edgebrain'
                                when 'brain_insights'  then 'edgebrain'
                                when 'brain_state'     then 'edgebrain'
                                when 'brain_sync_runs' then 'edgebrain'
                                else c.table_name end), '') as resource,
       -- A column the client may UPDATE, if any; SET col = col changes nothing.
       coalesce(
         (select a.column_name from information_schema.columns a
           where a.table_schema = 'public' and a.table_name = c.table_name
             and a.column_name <> 'org_id'
             and has_column_privilege('authenticated', 'public.' || a.table_name, a.column_name, 'UPDATE')
           order by a.ordinal_position limit 1),
         'org_id') as upd_col,
       -- Columns an INSERT may name. Identity-ALWAYS columns are rejected by the
       -- rewriter (428C9) before privileges are even checked, which would make
       -- a denied insert look like one that got through.
       (select string_agg(quote_ident(a.column_name), ', ' order by a.ordinal_position)
          from information_schema.columns a
         where a.table_schema = 'public' and a.table_name = c.table_name
           and not (a.is_identity = 'YES' and a.identity_generation = 'ALWAYS')
           and a.is_generated = 'NEVER') as ins_cols
  from information_schema.columns c
  join information_schema.tables tb using (table_schema, table_name)
 where c.table_schema = 'public' and c.column_name = 'org_id' and tb.table_type = 'BASE TABLE'
   and c.table_name not in ('legacy_id_map');

-- A copy of one row per (table, org), primary key replaced so an INSERT of it
-- can only be stopped by RLS or a grant — never by a key collision first.
create temp table _samples (tbl text, org uuid, j jsonb);
do $$
declare t record; o uuid; j jsonb;
begin
  for t in select * from _tables loop
    foreach o in array array['c0000000-0000-0000-0000-00000000000a',
                             'c0000000-0000-0000-0000-00000000000b']::uuid[] loop
      execute format('select to_jsonb(x) from public.%I x where org_id = $1 limit 1', t.tbl) into j using o;
      if j is null then continue; end if;
      if j ? 'id' and jsonb_typeof(j -> 'id') = 'string' then j := jsonb_set(j, '{id}', to_jsonb(gen_random_uuid())); end if;
      if j ? 'token' then j := jsonb_set(j, '{token}', to_jsonb(gen_random_uuid())); end if;
      if j ? 'jti'   then j := jsonb_set(j, '{jti}',   to_jsonb(gen_random_uuid())); end if;
      -- attendance_days is keyed (org, employee, date), so a verbatim copy
      -- collides on the unique index before RLS can be observed. Move the copy
      -- to a date the fixture never uses.
      if t.tbl = 'attendance_days' then
        j := jsonb_set(j, '{work_date}', to_jsonb((current_date - 400)::text));
      end if;
      -- A membership copy overlaps the original's dates, and an allocation
      -- copy collides with the original's claim on its source; both are
      -- refused by a guard after RLS has let an allowed caller through. Give
      -- each a range / a source of its own, as attendance_days does above.
      if t.tbl = 'project_members' then
        j := jsonb_set(jsonb_set(j, '{start_date}', to_jsonb((current_date - 400)::text)),
                       '{end_date}', to_jsonb((current_date - 399)::text));
      end if;
      if t.tbl = 'project_allocations' then
        insert into income_entries (org_id, description, original_amount) values (o, 'Alloc probe', 10)
          returning jsonb_set(j, '{source_id}', to_jsonb(id)) into j;
      end if;
      -- The fixture thread also holds the database's own entries; a copy must
      -- be something a member may write, or the probe measures the guard.
      if t.tbl = 'document_negotiation_events' then
        j := jsonb_set(jsonb_set(j, '{kind}', '"comment"'), '{actor_type}', '"recipient"');
      end if;
      if t.tbl = 'employee_compensation' then
        -- keyed by employee_id; point the copy at a fresh employee of the same org
        insert into employees (org_id, full_name) values (o, 'Comp probe') returning jsonb_set(j, '{employee_id}', to_jsonb(id)) into j;
      end if;
      insert into _samples values (t.tbl, o, j);
    end loop;
  end loop;
end $$;

-- ─── Expected access in the caller's own org ─────────────────────────────────
-- The source of truth is role_permissions plus the grants — except for the
-- tables the matrix deliberately cannot reach.
create or replace function pg_temp.expected(p_tbl text, p_resource text, p_org uuid, p_role text, p_verb text)
returns boolean language plpgsql as $$
declare v_flag boolean; v_grant boolean;
begin
  v_grant := case p_verb
    when 'S' then has_table_privilege('authenticated', 'public.' || p_tbl, 'SELECT')
    when 'I' then has_table_privilege('authenticated', 'public.' || p_tbl, 'INSERT')
    when 'U' then has_any_column_privilege('authenticated', 'public.' || p_tbl, 'UPDATE')
    when 'D' then has_table_privilege('authenticated', 'public.' || p_tbl, 'DELETE') end;
  if not v_grant then return false; end if;

  -- NON-NEGOTIABLE: pay and banking are owner/admin, whatever the matrix holds.
  if p_tbl in ('employee_compensation', 'org_banking') then
    return p_role in ('owner', 'admin');
  end if;
  -- 0049: every allocation policy also requires project_financials.view.
  if p_tbl = 'project_allocations' and not coalesce((
       select can_view from role_permissions
        where org_id = p_org and role = p_role and resource = 'project_financials'), false) then
    return false;
  end if;
  -- EdgeBrain (0033–0036) is written only by its sync functions; clients read.
  if p_tbl like 'brain\_%' and p_verb <> 'S' then
    return false;
  end if;
  -- NON-NEGOTIABLE: server-only.
  if p_tbl in ('org_secrets', 'email_events', 'org_telegram', 'telegram_chats', 'telegram_links',
               'telegram_link_tokens', 'telegram_conversations') then
    return false;
  end if;
  -- 0070: the Daily Pulse log is read by its own person and by owners/admins
  -- (the founder's view of the team pulse); it is written only by the API.
  -- The fixture row belongs to neither of the other roles' callers.
  if p_tbl = 'pulse_checkins' then
    return p_verb = 'S' and p_role in ('owner', 'admin');
  end if;

  -- 0029 §6: announcements carries an additive `announcements_self_select`
  -- policy on top of the matrix, so an announcement addressed to the whole
  -- organization is readable by every member — including the `employee` role,
  -- whose matrix row denies it. That is the point of the policy: an employee
  -- reads the notice board and nothing else on that table. What it allows and
  -- refuses (a department notice stays inside its department) is asserted
  -- precisely in 05_people_ops_test.sql; here the read is simply expected.
  if p_tbl = 'announcements' and p_verb = 'S' then
    return true;
  end if;

  select case p_verb when 'S' then can_view when 'I' then can_create
                     when 'U' then can_edit when 'D' then can_delete end
    into v_flag
    from role_permissions where org_id = p_org and role = p_role and resource = p_resource;
  return coalesce(v_flag, false);
end $$;

-- ─── Run it ──────────────────────────────────────────────────────────────────
create temp table _results (caller text, side text, tbl text, verb text, outcome text, ok boolean);

do $$
declare
  c record; t record; v_org uuid; v_side text; v_j jsonb; v_out text; v_exp boolean; v_allowed boolean;
  v_sql text; verb text;
begin
  for c in select * from _callers order by label loop
    foreach v_side in array array['foreign', 'own'] loop
      v_org := case v_side when 'own' then c.own_org else c.foreign_org end;

      for t in select * from _tables order by tbl loop
        -- Own-org behaviour of these is not "the matrix" and is asserted
        -- directly in 04_role_smoke_test.sql (member_permissions in
        -- 09_member_permissions_test.sql, ai_actions in 13_ai_actions_test.sql). Cross-tenant, they are probed
        -- like everything else.
        if v_side = 'own' and t.tbl in ('memberships', 'audit_log', 'role_permissions', 'member_permissions', 'ai_actions') then
          continue;
        end if;

        select j into v_j from _samples where tbl = t.tbl and org = v_org;

        foreach verb in array array['S', 'I', 'U', 'D'] loop
          v_sql := case verb
            when 'S' then format('select count(*) from public.%I where org_id = %L', t.tbl, v_org)
            when 'U' then format('with x as (update public.%I set %I = %I where org_id = %L returning 1) select count(*) from x',
                                 t.tbl, t.upd_col, t.upd_col, v_org)
            when 'D' then format('with x as (delete from public.%I where org_id = %L returning 1) select count(*) from x',
                                 t.tbl, v_org)
            when 'I' then format('with x as (insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, %L::jsonb) returning 1) select count(*) from x',
                                 t.tbl, t.ins_cols, t.ins_cols, t.tbl, v_j)
          end;
          if verb = 'I' and v_j is null then continue; end if;

          v_out := pg_temp.probe(c.uid, v_sql);

          -- For S/U/D a denial is 0 rows (RLS filters silently) or 42501 (no
          -- grant). For I it is 42501 only: any other error means the row got
          -- past RLS and something later stopped it.
          v_allowed := case
            when v_out = 'deny' then false
            when v_out like 'allow:%' then (verb = 'I' or split_part(v_out, ':', 2)::int > 0)
            else true
          end;

          if v_side = 'foreign' then
            v_exp := false;
          else
            v_exp := pg_temp.expected(t.tbl, t.resource, v_org, c.role, verb);
          end if;

          insert into _results values (c.label, v_side, t.tbl, verb, v_out, v_allowed = v_exp);
        end loop;
      end loop;
    end loop;
  end loop;
end $$;

-- ─── Storage buckets, the same way ───────────────────────────────────────────
do $$
declare c record; b record; v_side text; v_org uuid; v_out text; v_allowed boolean; v_exp boolean;
        verb text; v_sql text;
begin
  for c in select * from _callers order by label loop
    foreach v_side in array array['foreign', 'own'] loop
      v_org := case v_side when 'own' then c.own_org else c.foreign_org end;
      for b in select * from (values
          ('org-branding', 'storage_branding'),
          ('signatures',   'storage_signatures'),
          ('documents',    'storage_documents')) x(bucket, resource) loop
        foreach verb in array array['S', 'I', 'U', 'D'] loop
          v_sql := case verb
            when 'S' then format('select count(*) from storage.objects where bucket_id = %L and name like %L', b.bucket, v_org || '/%')
            when 'U' then format('with x as (update storage.objects set name = name where bucket_id = %L and name like %L returning 1) select count(*) from x', b.bucket, v_org || '/%')
            when 'D' then format('with x as (delete from storage.objects where bucket_id = %L and name like %L returning 1) select count(*) from x', b.bucket, v_org || '/%')
            when 'I' then format('with x as (insert into storage.objects (bucket_id, name) values (%L, %L) returning 1) select count(*) from x', b.bucket, v_org || '/probe-' || gen_random_uuid())
          end;
          v_out := pg_temp.probe(c.uid, v_sql);
          v_allowed := case
            when v_out = 'deny' then false
            when v_out like 'allow:%' then (verb = 'I' or split_part(v_out, ':', 2)::int > 0)
            else true end;
          if v_side = 'foreign' then
            v_exp := false;
          else
            select case verb when 'S' then can_view when 'I' then can_create
                             when 'U' then can_edit and can_view when 'D' then can_delete and can_view end
              into v_exp from role_permissions
             where org_id = v_org and role = c.role and resource = b.resource;
            -- An UPDATE or DELETE with a WHERE clause only reaches rows the
            -- caller can SELECT. org-branding has no select policy at all
            -- (public bucket, read through the CDN — 0004), so its update and
            -- delete policies are unreachable from a client, today as before
            -- this phase. Encoded here so the test states it rather than hides it.
            if b.bucket = 'org-branding' and verb = 'S' then v_exp := false; end if;
          end if;
          insert into _results values (c.label, v_side, 'storage:' || b.bucket, verb, v_out, v_allowed = coalesce(v_exp, false));
        end loop;
      end loop;
    end loop;
  end loop;
end $$;

-- ─── Tables without an org_id column ─────────────────────────────────────────
do $$
declare c record; v_out text;
begin
  for c in select * from _callers order by label loop
    -- organizations: the other org's row is invisible and unwritable.
    v_out := pg_temp.probe(c.uid, format('select count(*) from organizations where id = %L', c.foreign_org));
    insert into _results values (c.label, 'foreign', 'organizations', 'S', v_out, v_out = 'allow:0');
    v_out := pg_temp.probe(c.uid, format(
      'with x as (update organizations set company_name = company_name where id = %L returning 1) select count(*) from x', c.foreign_org));
    insert into _results values (c.label, 'foreign', 'organizations', 'U', v_out, v_out in ('allow:0', 'deny'));

    -- notification_reads: only ever your own rows.
    v_out := pg_temp.probe(c.uid, format('select count(*) from notification_reads where user_id <> %L', c.uid));
    insert into _results values (c.label, 'foreign', 'notification_reads', 'S', v_out, v_out = 'allow:0');
  end loop;
end $$;

-- ─── Report ──────────────────────────────────────────────────────────────────
-- One line per (caller, side, table). A mismatch prints every verb's outcome.
do $$
declare r record; n_fail integer := 0;
begin
  for r in
    select caller, side, tbl,
           bool_and(ok) as ok,
           string_agg(verb || '=' || outcome, ' ' order by array_position(array['S','I','U','D'], verb)) as detail,
           string_agg(case when outcome = 'deny' or outcome = 'allow:0' then verb end, '' order by array_position(array['S','I','U','D'], verb)) as denied
      from _results
     group by caller, side, tbl
     order by side, caller, tbl
  loop
    if r.ok then
      if r.side = 'foreign' then
        raise notice '  PASS  % → other org''s %: nothing visible, nothing writable', r.caller, r.tbl;
      else
        raise notice '  PASS  % → own %: matches the matrix (%)', r.caller, r.tbl, r.detail;
      end if;
    else
      n_fail := n_fail + 1;
      raise warning 'FAIL  % → % %: %', r.caller, r.side, r.tbl, r.detail;
    end if;
  end loop;
  if n_fail > 0 then
    raise exception 'FAIL  % (caller, table) combinations did not hold — see warnings above', n_fail;
  end if;
end $$;

-- The positive control must have observed real access, or the zeros mean nothing.
select pg_temp.check(count(*) > 100,
  format('positive control: %s own-org probes succeeded, so the probe does observe access when it exists', count(*)))
  from _results where side = 'own' and outcome like 'allow:%' and outcome <> 'allow:0';

select pg_temp.check(bool_and(ok) and count(*) > 0,
  format('%s cross-tenant probes across %s callers, every one denied', count(*), count(distinct caller)))
  from _results where side = 'foreign';

\echo ''
\echo '  ALL ROLE ISOLATION ASSERTIONS PASSED'
rollback;
