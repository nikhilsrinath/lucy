-- ============================================================================
-- 0070_telegram_channel.sql — Telegram as a channel into Buddy, and the Daily
-- Pulse check-in log.
--
-- Telegram is an ADAPTER, not a second Buddy. Every message a linked person
-- sends reaches the same api/_lib/agent/buddy.js the web chat and the voice
-- call use: the same tools, permissions, proposals (ai_actions, channel =
-- 'telegram'), approvals, audit attribution and undo. These tables hold only
-- what the adapter itself needs:
--
--   org_telegram            per company: is Telegram on, is Daily Pulse on
--   telegram_links          a Telegram account ↔ a StartupBuddy user, per
--                           company. Made only by a one-time token the person
--                           (or an admin, for them) generated in the app.
--                           A link is a pointer, never a grant: memberships
--                           and the permission matrix are re-checked on every
--                           update, so a removed member loses Telegram access
--                           on their next message.
--   telegram_chats          a Telegram group ↔ a company. Connected by an
--                           owner/admin whose own Telegram is linked.
--   telegram_link_tokens    the one-time tokens (only their SHA-256 is kept).
--   telegram_updates        every update_id once: duplicate deliveries and
--                           Telegram's retries are dropped; also the basis of
--                           the per-person inbound rate limit.
--   telegram_conversations  the short-term context of one person in one chat
--                           (history, records in play, the open question, the
--                           cards shown) — what the web client keeps in the
--                           browser, kept server-side because Telegram has no
--                           client state.
--   pulse_checkins          Daily Pulse: one check-in per person per day, on
--                           whichever channel asked it, with the reply and
--                           the ai_actions it produced. Channel-neutral.
--
-- Everything except pulse_checkins is server-only: RLS enabled with no policy,
-- so no client role can read or write it (the org_secrets pattern). The app
-- reaches it through /api/telegram, which checks the caller's membership.
-- pulse_checkins is readable by the person it belongs to and by owners/admins
-- (the founder's view of the company pulse, and Buddy's team_pulse tool, read
-- it with the reader's own token).
--
-- Idempotent: safe to run more than once.
-- ============================================================================

-- ─── org_telegram ────────────────────────────────────────────────────────────

create table if not exists public.org_telegram (
  org_id         uuid primary key references public.organizations(id) on delete cascade,
  enabled        boolean not null default false,
  pulse_enabled  boolean not null default false,
  pulse_hour     smallint not null default 18 check (pulse_hour between 0 and 23),
  updated_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ─── telegram_links ──────────────────────────────────────────────────────────

create table if not exists public.telegram_links (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  user_id            uuid not null references auth.users(id) on delete cascade,
  telegram_user_id   bigint not null,
  telegram_username  text,
  telegram_name      text,
  dm_chat_id         bigint,
  linked_via         text not null check (linked_via in ('self', 'invite')),
  invited_by         uuid references auth.users(id) on delete set null,
  pulse_opt_out      boolean not null default false,
  linked_at          timestamptz not null default now(),
  last_seen_at       timestamptz,
  revoked_at         timestamptz,
  revoked_reason     text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- One live link per Telegram account per company, and per person per company.
create unique index if not exists telegram_links_tg_live_idx
  on public.telegram_links (org_id, telegram_user_id) where revoked_at is null;
create unique index if not exists telegram_links_user_live_idx
  on public.telegram_links (org_id, user_id) where revoked_at is null;
create index if not exists telegram_links_tg_idx on public.telegram_links (telegram_user_id) where revoked_at is null;

-- ─── telegram_chats ──────────────────────────────────────────────────────────

create table if not exists public.telegram_chats (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  chat_id          bigint not null,
  chat_type        text not null check (chat_type in ('group', 'supergroup')),
  title            text,
  connected_by     uuid references auth.users(id) on delete set null,
  connected_at     timestamptz not null default now(),
  disconnected_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- A group belongs to at most one company at a time.
create unique index if not exists telegram_chats_live_idx
  on public.telegram_chats (chat_id) where disconnected_at is null;
create index if not exists telegram_chats_org_idx on public.telegram_chats (org_id) where disconnected_at is null;

-- ─── telegram_link_tokens ────────────────────────────────────────────────────

create table if not exists public.telegram_link_tokens (
  token_hash        text primary key,
  org_id            uuid not null references public.organizations(id) on delete cascade,
  purpose           text not null check (purpose in ('link', 'group')),
  user_id           uuid references auth.users(id) on delete cascade,
  created_by        uuid not null references auth.users(id) on delete cascade,
  expires_at        timestamptz not null,
  used_at           timestamptz,
  used_by_telegram  bigint,
  created_at        timestamptz not null default now(),
  constraint telegram_link_tokens_user check (purpose <> 'link' or user_id is not null)
);
create index if not exists telegram_link_tokens_org_idx on public.telegram_link_tokens (org_id, created_at desc);

-- ─── telegram_updates ────────────────────────────────────────────────────────

create table if not exists public.telegram_updates (
  update_id         bigint primary key,
  telegram_user_id  bigint,
  chat_id           bigint,
  kind              text,
  status            text not null default 'processing' check (status in ('processing', 'done', 'ignored', 'failed')),
  error             text,
  received_at       timestamptz not null default now(),
  finished_at       timestamptz
);
create index if not exists telegram_updates_user_time_idx on public.telegram_updates (telegram_user_id, received_at desc);

-- ─── telegram_conversations ──────────────────────────────────────────────────

create table if not exists public.telegram_conversations (
  chat_id           bigint not null,
  telegram_user_id  bigint not null,
  org_id            uuid references public.organizations(id) on delete cascade,
  state             jsonb not null default '{}'::jsonb,
  updated_at        timestamptz not null default now(),
  primary key (chat_id, telegram_user_id)
);

-- ─── pulse_checkins ──────────────────────────────────────────────────────────

create table if not exists public.pulse_checkins (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  employee_id  uuid references public.employees(id) on delete set null,
  pulse_date   date not null,
  channel      text not null check (channel ~ '^[a-z][a-z0-9_]{1,23}$'),
  status       text not null default 'asked' check (status in ('asked', 'answered', 'skipped')),
  question     text,
  response     text,
  action_ids   uuid[] not null default '{}',
  asked_at     timestamptz not null default now(),
  answered_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, user_id, pulse_date)
);
create index if not exists pulse_checkins_org_date_idx on public.pulse_checkins (org_id, pulse_date desc);

comment on table public.pulse_checkins is
  'Daily Pulse: Buddy asked a person how their day went, on some channel, and what they said and what it led to (ai_actions ids).';

-- ─── updated_at ──────────────────────────────────────────────────────────────

do $mig$
declare t text;
begin
  foreach t in array array['org_telegram', 'telegram_links', 'telegram_chats', 'pulse_checkins'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I for each row execute function app.touch_updated_at()', t, t);
  end loop;
end $mig$;

-- ─── Row-level security ──────────────────────────────────────────────────────
-- Server-only tables: RLS on, no policy, no grant to client roles.

do $mig$
declare t text;
begin
  foreach t in array array['org_telegram', 'telegram_links', 'telegram_chats', 'telegram_link_tokens',
                           'telegram_updates', 'telegram_conversations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $mig$;

comment on table public.telegram_links is 'Server-only. A Telegram account linked to a StartupBuddy user in one company; never a grant by itself.';
comment on table public.telegram_link_tokens is 'Server-only. One-time link/group tokens; only the SHA-256 of the token is stored.';

alter table public.pulse_checkins enable row level security;
alter table public.pulse_checkins force row level security;
drop policy if exists pulse_checkins_select on public.pulse_checkins;
create policy pulse_checkins_select on public.pulse_checkins
  for select to authenticated
  using (app.is_member(org_id) and (user_id = auth.uid() or app.is_admin(org_id)));
revoke all on public.pulse_checkins from anon;
revoke insert, update, delete, truncate on public.pulse_checkins from authenticated;
grant select on public.pulse_checkins to authenticated;
grant all on public.pulse_checkins to service_role;
