-- ============================================================================
-- 0069_buddy_operator.sql — Buddy as an operator: plans, channels, a timeline.
--
-- 0068 made ai_actions the log of every change the cofounder proposed. Buddy
-- now also proposes multi-step PLANS (one row, kind = 'plan', its steps in
-- args/preview/result), is reached from more than one surface (chat, a voice
-- call, a "Buddy noticed" card, and later Telegram or email), and keeps a
-- lifecycle timeline per action so it can say exactly what happened.
--
-- Every column is additive with a default, so the API keeps working on a
-- database without this migration (api/_lib/agent/actions.js strips these
-- fields when PostgREST reports them missing).
--
--   kind               'action' (one tool call) | 'plan' (several, one approval)
--   channel            where it was asked: chat | voice | insight | api | …
--   reason             Buddy's one-line why, grounded in the company's data
--   source             what prompted it, e.g. 'insight:overdue_invoice:<id>'
--   approval_required  always true today; recorded so an audit can prove it
--   edits              what the person changed on the card before approving
--   events             [{ at, status, note? }] — proposed, edited, approved,
--                      executing, completed | failed | partial, cancelled,
--                      undone, retried
--   parent_id          the action this one retries
--
-- Idempotent: safe to run more than once.
-- ============================================================================

alter table public.ai_actions add column if not exists kind              text not null default 'action';
alter table public.ai_actions add column if not exists channel           text not null default 'chat';
alter table public.ai_actions add column if not exists reason            text;
alter table public.ai_actions add column if not exists source            text;
alter table public.ai_actions add column if not exists approval_required boolean not null default true;
alter table public.ai_actions add column if not exists edits             jsonb;
alter table public.ai_actions add column if not exists events            jsonb not null default '[]'::jsonb;
alter table public.ai_actions add column if not exists parent_id         uuid references public.ai_actions(id) on delete set null;

do $mig$
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_actions_kind_check') then
    alter table public.ai_actions add constraint ai_actions_kind_check check (kind in ('action', 'plan'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_actions_channel_check') then
    alter table public.ai_actions add constraint ai_actions_channel_check check (channel ~ '^[a-z][a-z0-9_]{1,23}$');
  end if;
end $mig$;

create index if not exists ai_actions_org_status_idx on public.ai_actions (org_id, status, proposed_at desc);

comment on column public.ai_actions.kind is 'action = one tool call; plan = several steps approved together (steps in args/preview/result).';
comment on column public.ai_actions.channel is 'The surface the request came from: chat, voice, insight, api (later telegram, email).';
comment on column public.ai_actions.events is 'Lifecycle timeline: [{at, status, note}] — proposed, edited, approved, executing, completed/failed/partial, cancelled, undone, retried.';
