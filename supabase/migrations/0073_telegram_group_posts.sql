-- ============================================================================
-- 0073_telegram_group_posts.sql — Buddy may post in the company's Telegram group.
--
-- Two things, both on org_telegram (server-only, written by /api/telegram
-- after an owner/admin check):
--
--   group_posts      opt-in, default off: Buddy's own routine reminders and
--                    follow-ups about a task (due soon, due today, overdue,
--                    the follow-through kickoff) go to the team group, the
--                    person tagged, instead of their private chat.
--                    Escalations to the founder, "done" notices, approval
--                    notices, scheduled reminders and check reports stay
--                    private.
--   group_chat_ref   which connected group Buddy posts in. Null = the
--                    company's only connected group, if it has exactly one.
--                    Must be a group of THIS company (composite FK); a
--                    disconnected group is never posted to.
--
-- An owner/admin can also tell Buddy in the app to post a message to the
-- group (send_telegram_group_message); that does not need group_posts.
--
-- Idempotent: safe to run more than once.
-- ============================================================================

create unique index if not exists telegram_chats_id_org_key on public.telegram_chats (id, org_id);

alter table public.org_telegram add column if not exists group_posts boolean not null default false;
alter table public.org_telegram add column if not exists group_chat_ref uuid;

do $mig$
begin
  if not exists (select 1 from pg_constraint where conname = 'org_telegram_group_chat_fkey') then
    alter table public.org_telegram
      add constraint org_telegram_group_chat_fkey foreign key (group_chat_ref, org_id)
      references public.telegram_chats (id, org_id) on delete set null (group_chat_ref);
  end if;
end $mig$;

comment on column public.org_telegram.group_posts is
  'Buddy posts its routine task reminders and follow-ups in the team group (person tagged) instead of privately. Off by default.';
comment on column public.org_telegram.group_chat_ref is
  'The connected group Buddy posts in (telegram_chats.id of this company). Null = the only connected group.';
