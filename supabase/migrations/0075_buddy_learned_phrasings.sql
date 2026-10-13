-- ============================================================================
-- 0075_buddy_learned_phrasings.sql — a company's own way of saying things.
--
-- Buddy's local reader (api/_lib/agent/local) sometimes understands a message
-- but is not sure of it, and asks: "Did you mean unpaid invoices?". When the
-- person says yes, the SHAPE of what they said is kept here with the reading
-- it led to. Once the same shape has been confirmed twice, Buddy reads it
-- directly and stops asking (api/_lib/agent/local/learned.js).
--
-- A row holds no message content:
--
--   shape          the sentence with every record name replaced by {name},
--                  every email by {email} and every figure by #
--                  ("show {name} # invoice") — never a name, an amount or
--                  the words as typed
--   intent         the reading it was confirmed as (a fixed vocabulary)
--   confirmations  how many times a person said yes to it
--
-- A learned shape only settles a doubt the reader already had about its own
-- reading; it cannot make Buddy do anything the reader did not itself read,
-- and a change still goes through its confirm card. A shape the person later
-- calls wrong is deleted.
--
-- Rows are written through the caller's own session, so the policies below
-- are the boundary: a member reads and teaches their own company only.
--
-- The reader works without this table: it simply never learns.
--
-- Idempotent: safe to run more than once.
-- ============================================================================

create table if not exists public.buddy_learned_phrasings (
  id                bigint generated always as identity primary key,
  org_id            uuid not null references public.organizations(id) on delete cascade,
  shape             text not null check (length(shape) between 1 and 200),
  intent            text not null check (intent ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  confirmations     integer not null default 1 check (confirmations >= 1),
  last_confirmed_at timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  unique (org_id, shape)
);

create index if not exists buddy_learned_phrasings_org_idx
  on public.buddy_learned_phrasings (org_id);

alter table public.buddy_learned_phrasings enable row level security;

drop policy if exists buddy_learned_phrasings_select on public.buddy_learned_phrasings;
create policy buddy_learned_phrasings_select on public.buddy_learned_phrasings
  for select to authenticated
  using (app.is_member(org_id));

drop policy if exists buddy_learned_phrasings_insert on public.buddy_learned_phrasings;
create policy buddy_learned_phrasings_insert on public.buddy_learned_phrasings
  for insert to authenticated
  with check (app.is_member(org_id));

drop policy if exists buddy_learned_phrasings_update on public.buddy_learned_phrasings;
create policy buddy_learned_phrasings_update on public.buddy_learned_phrasings
  for update to authenticated
  using (app.is_member(org_id))
  with check (app.is_member(org_id));

drop policy if exists buddy_learned_phrasings_delete on public.buddy_learned_phrasings;
create policy buddy_learned_phrasings_delete on public.buddy_learned_phrasings
  for delete to authenticated
  using (app.is_member(org_id));

revoke all on public.buddy_learned_phrasings from anon;
grant select, insert, update, delete on public.buddy_learned_phrasings to authenticated;
grant all on public.buddy_learned_phrasings to service_role;

comment on table public.buddy_learned_phrasings is
  'Per company: sentence shapes (names and figures removed) a person confirmed, and the reading each led to. No message content.';
