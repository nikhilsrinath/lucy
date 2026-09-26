-- ─────────────────────────────────────────────────────────────────────────────
-- EdgeAI agent — PREFLIGHT (read-only)
--
-- The agent (api/agent.js) writes to tasks, clients, cash entries, documents,
-- payments, attendance and leave AS THE SIGNED-IN USER, and its migration adds
-- public.ai_actions plus an "edgeai" actor on audit_log. Every permission key,
-- column, enum value, guard function and trigger it relies on has to come from
-- the LIVE database, which has drifted from the repo before (attendance is
-- keyed `attendance` live, `attendance_days` in 0029).
--
-- Run in the Supabase SQL editor (as postgres). It writes nothing: one SELECT
-- inside a read-only transaction. The editor shows only the last result set,
-- so everything is one UNION ALL returning (ord, section, item, detail).
-- Export as CSV, or copy the grid, and paste it back.
--
-- No business content is read: only catalogue metadata and aggregate counts.
-- ─────────────────────────────────────────────────────────────────────────────

begin transaction read only;

with
watched(t) as (values
  -- the tables the Phase 1–3 tools write
  ('tasks'), ('clients'), ('expenses'), ('income_entries'),
  ('financial_documents'), ('document_line_items'), ('payments'),
  ('attendance_days'), ('leave_requests'), ('leave_types'), ('leave_adjustments'),
  ('employees'), ('announcements'), ('vendors'), ('purchase_invoices'),
  ('projects'), ('project_members'), ('finance_categories'), ('records'),
  -- context the agent reads (timezone, GST default, plan, role)
  ('organizations'), ('org_settings'), ('subscriptions'), ('usage_counters'),
  ('memberships'), ('member_permissions'), ('ai_usage_events'),
  -- attribution
  ('audit_log'),
  -- the permission model
  ('permission_resources'), ('role_permission_defaults'), ('role_permissions'), ('roles'),
  -- must NOT exist yet (collision check), listed so its absence is visible
  ('ai_actions')
),
act_tables(t) as (values
  ('tasks'), ('clients'), ('expenses'), ('income_entries'), ('financial_documents'),
  ('payments'), ('attendance_days'), ('leave_requests'), ('employees'), ('audit_log')
)

select ord, section, item, detail from (

  -- 0. Server and schema basics.
  select 0 as ord, 'server' as section, 'version' as item, version() as detail
  union all
  select 1, 'schema', s, case when exists (select 1 from pg_namespace where nspname = s)
                              then 'exists' else 'MISSING' end
    from (values ('app'), ('extensions'), ('supabase_migrations')) v(s)

  -- 1. Which migrations live thinks it has applied (if the CLI table exists).
  union all
  select 2, 'applied_migrations', 'supabase_migrations.schema_migrations',
         case when to_regclass('supabase_migrations.schema_migrations') is null
              then 'table absent (migrations applied by hand)'
              else (xpath('string(/row/v)', query_to_xml(
                     'select string_agg(version || coalesce(''_'' || name, ''''), '', '' order by version) as v
                        from supabase_migrations.schema_migrations', false, true, '')))[1]::text
         end

  -- 2. Permission catalogue — every key the tool registry will name.
  union all
  select 10, 'permission_resource', pr.key,
         format('category=%s | actions=%s | sort=%s | label=%s',
                pr.category, pr.actions::text, pr.sort_order, pr.label)
    from public.permission_resources pr

  -- 3. Roles.
  union all
  select 20, 'role', r.key, format('label=%s | sort=%s', r.label, r.sort_order)
    from public.roles r

  -- 4. Full default matrix (v/c/e/d per role) — decides which tools each role sees.
  union all
  select 30, 'role_permission_default', d.resource,
         string_agg(format('%s:%s%s%s%s', d.role,
                           case when d.can_view   then 'v' else '-' end,
                           case when d.can_create then 'c' else '-' end,
                           case when d.can_edit   then 'e' else '-' end,
                           case when d.can_delete then 'd' else '-' end),
                    ' ' order by d.role)
    from public.role_permission_defaults d
   group by d.resource

  -- 5. Fan-out health: resources some organizations have no matrix rows for
  --    (the silent-403 case from the 0038 repair).
  union all
  select 40, 'role_permissions_gap', pr.key,
         format('%s of %s orgs have rows', count(distinct rp.org_id),
                (select count(*) from public.organizations))
    from public.permission_resources pr
    left join public.role_permissions rp on rp.resource = pr.key
   group by pr.key
  having count(distinct rp.org_id) < (select count(*) from public.organizations)

  -- 6. Columns of every watched table.
  union all
  select 50, 'column:' || c.table_name,
         lpad(c.ordinal_position::text, 3, '0') || ' ' || c.column_name,
         format('%s%s%s',
                case when c.data_type in ('USER-DEFINED', 'ARRAY') then c.udt_name
                     when c.character_maximum_length is not null
                       then c.data_type || '(' || c.character_maximum_length || ')'
                     when c.numeric_precision is not null and c.data_type = 'numeric'
                       then 'numeric(' || c.numeric_precision || ',' || c.numeric_scale || ')'
                     else c.data_type end,
                case when c.is_nullable = 'NO' then ' not null' else '' end,
                coalesce(' default ' || c.column_default, ''))
    from information_schema.columns c
    join watched w on w.t = c.table_name
   where c.table_schema = 'public'

  -- 7. Watched tables that do not exist (ai_actions SHOULD appear here).
  union all
  select 55, 'missing_table', w.t, 'no public.' || w.t
    from watched w
   where to_regclass('public.' || w.t) is null

  -- 8. Check / FK / unique constraints on the tables the tools write.
  union all
  select 60, 'constraint:' || cl.relname, con.conname::text, pg_get_constraintdef(con.oid)
    from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid
    join pg_namespace n on n.oid = cl.relnamespace and n.nspname = 'public'
    join act_tables d on d.t = cl.relname

  -- 9. Every enum in public (task_status, leave_status, attendance_status,
  --    client status, doc_type, doc_status… — the values tools may set).
  union all
  select 70, 'enum', t.typname::text, string_agg(e.enumlabel, ', ' order by e.enumsortorder)
    from pg_type t
    join pg_enum e on e.enumtypid = t.oid
    join pg_namespace n on n.oid = t.typnamespace and n.nspname = 'public'
   group by t.typname

  -- 10. Triggers on the tables the tools write: guards the executors must
  --     respect, and which of them carry the audit trigger.
  union all
  select 80, 'trigger:' || cl.relname, tg.tgname::text,
         regexp_replace(pg_get_triggerdef(tg.oid), '^CREATE (CONSTRAINT )?TRIGGER \S+ ', '')
    from pg_trigger tg
    join pg_class cl on cl.oid = tg.tgrelid
    join pg_namespace n on n.oid = cl.relnamespace and n.nspname = 'public'
    join act_tables d on d.t = cl.relname
   where not tg.tgisinternal

  -- 11. Every table the generic audit trigger is attached to.
  union all
  select 85, 'audited_table', cl.relname::text, tg.tgname::text
    from pg_trigger tg
    join pg_class cl on cl.oid = tg.tgrelid
    join pg_proc p on p.oid = tg.tgfoid
   where p.proname = 'write_audit' and not tg.tgisinternal

  -- 12. The live app.write_audit body: 0068 replaces it to stamp actor=edgeai,
  --     so it must still be the 0020 version (auth.uid() actor, never raises).
  --     Compare lf_md5 — the body with CRLF folded to LF — with 0020's
  --     ee442a926db778edd095d1f4fe5c7bcb (2491 chars): a file applied from a
  --     Windows checkout carries carriage returns and hashes differently while being the same.
  union all
  select 86, 'write_audit', 'fingerprint',
         format('lf_md5=%s | lf_len=%s | md5=%s | len=%s | uses auth.uid=%s | reads request.headers=%s | has exception block=%s | %s',
                md5(replace(p.prosrc, E'\r', '')), length(replace(p.prosrc, E'\r', '')),
                md5(p.prosrc), length(p.prosrc),
                p.prosrc ilike '%auth.uid()%',
                p.prosrc ilike '%request.headers%',
                p.prosrc ilike '%exception when others%',
                case when p.prosecdef then 'SECURITY DEFINER' else 'invoker' end)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'app'
   where p.proname = 'write_audit'

  -- 13. RLS state and policies on the tables the tools write.
  union all
  select 89, 'rls:' || c.relname,
         case when c.relrowsecurity then 'enabled' else 'DISABLED' end,
         case when c.relforcerowsecurity then 'forced' else 'not forced' end
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    join act_tables d on d.t = c.relname
  union all
  select 90, 'policy:' || p.tablename, p.policyname::text,
         format('%s to %s | using: %s | check: %s', p.cmd, p.roles::text,
                coalesce(p.qual, '-'), coalesce(p.with_check, '-'))
    from pg_policies p
    join act_tables d on d.t = p.tablename
   where p.schemaname = 'public'

  -- 14. Table grants to the client roles.
  union all
  select 95, 'grant:' || g.table_name, g.grantee,
         string_agg(g.privilege_type, ',' order by g.privilege_type)
    from information_schema.role_table_grants g
    join act_tables d on d.t = g.table_name
   where g.table_schema = 'public' and g.grantee in ('anon', 'authenticated', 'service_role')
   group by g.table_name, g.grantee

  -- 15. Every function in schema app, plus the public RPCs executors will call.
  union all
  select 100, 'function:' || n.nspname,
         p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         format('returns %s | %s | %s', pg_get_function_result(p.oid),
                case when p.prosecdef then 'SECURITY DEFINER' else 'invoker' end,
                coalesce(array_to_string(p.proconfig, ','), 'no config'))
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app'
      or (n.nspname = 'public' and p.proname in (
            'next_document_number', 'record_payment', 'bump_ai_usage', 'org_members',
            'accept_quotation', 'create_organization', 'my_permissions',
            'log_ai_usage_event'))

  -- 16. Who may execute the public RPCs (the agent calls them with the user's JWT).
  union all
  select 105, 'function_acl', n.nspname || '.' || p.proname,
         coalesce(p.proacl::text, 'default (PUBLIC execute)')
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where (n.nspname = 'public' and p.proname in ('next_document_number', 'record_payment',
                                                 'bump_ai_usage', 'org_members'))
      or (n.nspname = 'app' and p.proname in ('has_permission', 'is_admin', 'is_member',
                                              'secure_tenant_table', 'sync_role_permissions',
                                              'write_audit', 'forbid_write', 'freeze_org_id',
                                              'touch_updated_at'))

  -- 17. Realtime publication membership (confirmed writes must reach open screens).
  union all
  select 110, 'realtime_table', pt.schemaname || '.' || pt.tablename, pt.pubname::text
    from pg_publication_tables pt
   where pt.pubname = 'supabase_realtime'

  -- 18. Name collisions with what 0068 will create.
  union all
  select 130, 'collision:relation', n.nspname || '.' || c.relname, c.relkind::text
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'app')
     and (c.relname ilike '%ai_action%' or c.relname ilike '%agent%')
  union all
  select 132, 'collision:function', n.nspname || '.' || p.proname,
         pg_get_function_identity_arguments(p.oid)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'app')
     and (p.proname ilike '%ai_action%' or p.proname ilike '%agent%' or p.proname ilike '%actor%')
  union all
  select 133, 'collision:column', c.table_name || '.' || c.column_name, c.data_type
    from information_schema.columns c
   where c.table_schema = 'public'
     and c.table_name = 'audit_log'
     and c.column_name not in ('id', 'org_id', 'actor_id', 'action', 'entity_type',
                               'entity_id', 'diff', 'ip', 'created_at')

  -- 19. Data shape (counts only) the resolvers and defaults will meet.
  union all
  select 140, 'count', 'organizations', count(*)::text from public.organizations
  union all
  select 141, 'memberships_by_role', m.role::text, count(*)::text
    from public.memberships m group by m.role
  union all
  select 142, 'tasks_by_status', t.status::text, count(*)::text
    from public.tasks t group by t.status
  union all
  select 143, 'tasks_deadline_fill', 'with deadline / total',
         (select count(*) from public.tasks t
           where (to_jsonb(t) ->> 'deadline') is not null or (to_jsonb(t) ->> 'due_date') is not null)::text
         || ' / ' || (select count(*) from public.tasks)::text
  union all
  select 144, 'clients_by_status', coalesce(to_jsonb(c) ->> 'status', '(none)'), count(*)::text
    from public.clients c group by 3
  union all
  select 145, 'clients_by_stage', coalesce(to_jsonb(c) ->> 'stage', '(no stage column / null)'), count(*)::text
    from public.clients c group by 3
  union all
  select 146, 'leave_by_status', coalesce(to_jsonb(l) ->> 'status', '(none)'), count(*)::text
    from public.leave_requests l group by 3
  union all
  select 147, 'subscriptions_by_plan', coalesce(to_jsonb(s) ->> 'plan', to_jsonb(s) ->> 'tier', '(none)'),
         count(*)::text
    from public.subscriptions s group by 3
  union all
  select 148, 'member_permissions_rows', 'overrides in use',
         case when to_regclass('public.member_permissions') is null then 'table absent'
              else (xpath('string(/row/n)', query_to_xml(
                     'select count(*) as n from public.member_permissions', false, true, '')))[1]::text
         end
  union all
  select 149, 'org_timezone', coalesce(to_jsonb(o) ->> 'timezone', to_jsonb(o) ->> 'time_zone', '(no column / null)'),
         count(*)::text
    from public.organizations o group by 3

) preflight
order by ord, section, item;

rollback;
