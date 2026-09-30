-- ============================================================================
-- 0071_telegram_person_identity.sql — a company person can use Buddy on
-- Telegram without a StartupBuddy login.
--
-- Until now a Telegram account could only be linked to an auth user
-- (telegram_links.user_id), and Buddy acted with that user's own token. A
-- person in Team (public.employees) with no login could not use Buddy at all.
-- This migration adds the second kind of identity:
--
--   Telegram account ──(one-time invite an admin made for THIS person)──►
--   telegram_links (employee_id, org_id) ──► employees row ──► company
--
-- No auth.users row is created for anyone. Instead the API signs a short-lived
-- JWT for the request with role 'authenticated', NO `sub` (so auth.uid() is
-- null and no policy written for users can match), and one claim:
--
--   sb_person: { link: <telegram_links.id>, person: <employees.id>, org: <org id> }
--
-- The claim is only a pointer. app.person_principal() trusts it only while
-- the telegram_links row it names is live (not revoked), belongs to that
-- person in that company, and the person has not left — checked by the
-- database on every call, so revoking a link ends access on the very next
-- query, even for a token already issued.
--
-- What such a person may do (app.person_permission): what the company's
-- `admin` role may view / create / edit, per the org's own permission matrix
-- — except governance (company profile, team access, invitations, the
-- activity log, the AI log) — and NEVER delete. Pay and other is_admin()-only
-- data stay hidden: a person principal is never an owner or admin.
--
-- Everything else is the existing machinery: the same RLS policies (they all
-- go through app.has_permission / app.is_member, extended here), the same
-- ai_actions lifecycle, the same audit trigger (now also recording which
-- person acted), the same undo.
--
-- Also: several guards treated "auth.uid() is null" as "a trusted database or
-- service-role write" and skipped their permission check. A person principal
-- also has no auth.uid(), so section 6 rewrites those checks to
-- app.is_signed_in() — true for a user OR a person principal — so the guards
-- apply to Telegram persons exactly as to users.
--
-- Idempotent: safe to run more than once.
-- ============================================================================

-- ─── 1. employees: a key a composite FK can name ─────────────────────────────
-- (id is already unique; (id, org_id) lets a link row prove its person is in
-- its company.)

create unique index if not exists employees_id_org_key on public.employees (id, org_id);

-- ─── 2. telegram_links: a link to a user OR to a person ─────────────────────

alter table public.telegram_links alter column user_id drop not null;
alter table public.telegram_links add column if not exists employee_id uuid;

do $mig$
begin
  if not exists (select 1 from pg_constraint where conname = 'telegram_links_employee_fkey') then
    alter table public.telegram_links
      add constraint telegram_links_employee_fkey foreign key (employee_id, org_id)
      references public.employees (id, org_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'telegram_links_one_identity') then
    alter table public.telegram_links
      add constraint telegram_links_one_identity check (num_nonnulls(user_id, employee_id) = 1);
  end if;
  alter table public.telegram_links drop constraint if exists telegram_links_linked_via_check;
  alter table public.telegram_links
    add constraint telegram_links_linked_via_check check (linked_via in ('self', 'invite', 'person_invite'));
end $mig$;

-- One live link per person per company, and a Telegram account is linked to
-- at most ONE live company person anywhere (a founder's own user links, one
-- per company, are separate — telegram_links_tg_live_idx still allows one
-- identity of either kind per Telegram account per company).
create unique index if not exists telegram_links_person_live_idx
  on public.telegram_links (org_id, employee_id) where revoked_at is null and employee_id is not null;
create unique index if not exists telegram_links_tg_person_live_idx
  on public.telegram_links (telegram_user_id) where revoked_at is null and employee_id is not null;

comment on column public.telegram_links.employee_id is
  'A company person (no StartupBuddy login needed) this Telegram account acts as. Exactly one of user_id / employee_id is set.';

-- ─── 3. telegram_link_tokens: the person invite ─────────────────────────────

alter table public.telegram_link_tokens add column if not exists employee_id uuid;

do $mig$
begin
  alter table public.telegram_link_tokens drop constraint if exists telegram_link_tokens_purpose_check;
  alter table public.telegram_link_tokens
    add constraint telegram_link_tokens_purpose_check check (purpose in ('link', 'group', 'person'));
  if not exists (select 1 from pg_constraint where conname = 'telegram_link_tokens_person') then
    alter table public.telegram_link_tokens
      add constraint telegram_link_tokens_person check (purpose <> 'person' or employee_id is not null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'telegram_link_tokens_employee_fkey') then
    alter table public.telegram_link_tokens
      add constraint telegram_link_tokens_employee_fkey foreign key (employee_id, org_id)
      references public.employees (id, org_id) on delete cascade;
  end if;
end $mig$;

-- ─── 4. ai_actions and audit_log: who acted, when it was not a user ──────────

alter table public.ai_actions alter column user_id drop not null;
alter table public.ai_actions add column if not exists employee_id uuid references public.employees(id) on delete set null;
alter table public.ai_actions add column if not exists channel_actor text;
create index if not exists ai_actions_employee_chat_idx on public.ai_actions (employee_id, chat_id, status) where employee_id is not null;

comment on column public.ai_actions.employee_id is
  'The company person who asked, when they acted through a linked channel identity with no StartupBuddy login (user_id is then null).';
comment on column public.ai_actions.channel_actor is
  'The channel account that asked, e.g. telegram:<telegram user id>. Never a message body.';

alter table public.audit_log add column if not exists actor_employee_id uuid;
comment on column public.audit_log.actor_employee_id is
  'The company person who made the change through a linked channel identity (Telegram) with no login; actor_id is then null.';

-- ─── 5. The person principal ─────────────────────────────────────────────────

-- The employees.id this request acts as, or null. Only for a token with no
-- user (auth.uid() null) whose sb_person claim names a live link of that
-- person in that company, and only while the person has not left. p_org, when
-- given, must be that company.
create or replace function app.person_principal(p_org uuid default null)
returns uuid language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_claims jsonb;
  v_p      jsonb;
  v_emp    uuid;
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
  if v_claims is null or coalesce(v_claims ->> 'role', '') <> 'authenticated' then
    return null;
  end if;
  v_p := v_claims -> 'sb_person';
  if v_p is null or jsonb_typeof(v_p) <> 'object'
     or coalesce(v_p ->> 'link', '') !~* re or coalesce(v_p ->> 'person', '') !~* re or coalesce(v_p ->> 'org', '') !~* re then
    return null;
  end if;
  if p_org is not null and p_org <> (v_p ->> 'org')::uuid then
    return null;
  end if;
  select e.id into v_emp
    from public.telegram_links l
    join public.employees e on e.id = l.employee_id and e.org_id = l.org_id
   where l.id = (v_p ->> 'link')::uuid
     and l.employee_id = (v_p ->> 'person')::uuid
     and l.org_id = (v_p ->> 'org')::uuid
     and l.revoked_at is null
     and e.exited_at is null
     and e.access_revoked_at is null;
  return v_emp;
end $$;

revoke execute on function app.person_principal(uuid) from public;
grant execute on function app.person_principal(uuid) to authenticated, service_role;

-- Someone is signed in: a user, or a person principal. What the guards below
-- mean by "not the database's own write".
create or replace function app.is_signed_in()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null or app.person_principal(null) is not null;
$$;

revoke execute on function app.is_signed_in() from public;
grant execute on function app.is_signed_in() to authenticated, service_role;

-- Governance a person principal never gets, whatever the admin role holds.
create or replace function app.person_withheld_resources()
returns text[] language sql immutable as $$
  select array['organizations', 'memberships', 'invitations', 'audit_log', 'ai_actions']::text[];
$$;

-- What a person principal may do: the org's `admin` row for view / create /
-- edit, never delete, never the withheld resources.
create or replace function app.person_permission(p_org uuid, p_resource text, p_action text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select p_action in ('view', 'create', 'edit')
     and not (p_resource = any (app.person_withheld_resources()))
     and app.person_principal(p_org) is not null
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

revoke execute on function app.person_permission(uuid, text, text) from public;

-- 0002's is_member, plus the person principal of this company.
create or replace function app.is_member(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.memberships
    where org_id = p_org and user_id = auth.uid()
  ) or app.person_principal(p_org) is not null;
$$;

-- 0062's has_permission, plus the person principal.
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
  or (auth.uid() is null and app.person_permission(p_org, p_resource, p_action));
$$;

-- The person principal's whole map, in effective_permissions' shape.
create or replace function app.person_permissions(p_org uuid)
returns table (resource text, can_view boolean, can_create boolean, can_edit boolean, can_delete boolean, custom boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select pr.key,
         coalesce(rp.can_view, false),
         coalesce(rp.can_create, false),
         coalesce(rp.can_edit, false),
         false,
         false
    from public.permission_resources pr
    join public.role_permissions rp
      on rp.org_id = p_org and rp.role = 'admin' and rp.resource = pr.key
   where app.person_principal(p_org) is not null
     and not (pr.key = any (app.person_withheld_resources()));
$$;

revoke execute on function app.person_permissions(uuid) from public;

-- 0062's my_permissions: the caller's map — a user's, or a person principal's.
create or replace function public.my_permissions(p_org uuid)
returns table (resource text, can_view boolean, can_create boolean, can_edit boolean, can_delete boolean, custom boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select * from app.effective_permissions(p_org, auth.uid()) where auth.uid() is not null
  union all
  select * from app.person_permissions(p_org) where auth.uid() is null;
$$;

-- 0029's my_employee_id: a person principal IS an employee record.
create or replace function app.my_employee_id(p_org uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select e.id
       from public.employees e
      where e.org_id = p_org
        and e.user_id = auth.uid()
        and e.exited_at is null
      limit 1),
    app.person_principal(p_org));
$$;

-- 0068's agent_action_id: also a confirmed action of this person principal.
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
          or (a.user_id is null and a.employee_id is not null and a.employee_id = app.person_principal(a.org_id)));
  return v_id;
end $$;

revoke execute on function app.agent_action_id() from public;

-- 0068's write_audit, recording the person principal as well.
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

  insert into public.audit_log (org_id, actor_id, actor_employee_id, action, entity_type, entity_id, diff, via, ai_action_id)
  values (v_org, auth.uid(), app.person_principal(v_org), v_action, tg_table_name, v_entity, v_diff,
          case when v_agent is not null then 'edgeai' end, v_agent);

  return null;
exception when others then
  raise warning 'audit trigger on % failed: %', tg_table_name, sqlerrm;
  return null;
end $$;

-- ─── 6. Guards that read "no auth.uid()" as "the database itself" ────────────
-- Rewritten in place from their live definitions: "auth.uid() is not null"
-- becomes app.is_signed_in(), "auth.uid() is null" becomes
-- not app.is_signed_in(). Nothing else in them changes. The functions of this
-- migration are excluded (they must see the raw auth.uid()).

do $mig$
declare
  f   record;
  def text;
begin
  for f in
    select p.oid, n.nspname, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('app', 'public')
       and p.prokind = 'f'
       and p.prosrc ~* 'auth\.uid\(\)\s+is\s+(not\s+)?null'
       and p.proname not in ('person_principal', 'is_signed_in', 'person_permission', 'person_permissions',
                             'has_permission', 'my_permissions', 'is_member', 'my_employee_id', 'agent_action_id')
  loop
    def := pg_get_functiondef(f.oid);
    def := regexp_replace(def, 'auth\.uid\(\)\s+is\s+not\s+null', 'app.is_signed_in()', 'gi');
    def := regexp_replace(def, 'auth\.uid\(\)\s+is\s+null', '(not app.is_signed_in())', 'gi');
    execute def;
    raise notice 'person principal: guard %.% now applies to Telegram persons too', f.nspname, f.proname;
  end loop;
end $mig$;
