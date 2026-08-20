-- CubeStats schema. Paste into Supabase dashboard > SQL Editor > New query
-- and run. Safe to re-run: every statement is guarded.
--
-- Row Level Security is the entire access-control model here. The anon key
-- ships in the browser bundle by design; these policies are what keep one
-- user's solves invisible to another.

-- ---------------------------------------------------------------- sessions
create table if not exists public.sessions (
  id          uuid primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  event       text not null,
  goal_ms     integer,
  color       smallint,
  created_at  timestamptz not null,
  updated_at  timestamptz not null,
  deleted     boolean not null default false
);

-- ------------------------------------------------------------------ solves
create table if not exists public.solves (
  id          uuid primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  session_id  uuid not null references public.sessions(id) on delete cascade,
  scramble    text not null default '',
  time_ms     integer not null,
  penalty     text not null default 'none'
                check (penalty in ('none', 'plus2', 'dnf')),
  -- null = recorded before parity tracking was on; {} = measured as clean.
  -- The distinction matters: treating untracked as clean would bias the
  -- no-parity mean that every parity comparison is measured against.
  parity      text[],
  created_at  timestamptz not null,
  updated_at  timestamptz not null,
  deleted     boolean not null default false
);

-- Pull queries filter on updated_at within a user; stats read by session.
create index if not exists sessions_user_updated
  on public.sessions (user_id, updated_at);
create index if not exists solves_user_updated
  on public.solves (user_id, updated_at);
create index if not exists solves_user_session
  on public.solves (user_id, session_id);

-- --------------------------------------------------------------------- RLS
alter table public.sessions enable row level security;
alter table public.solves   enable row level security;

-- Separate policy per command. `using` governs which existing rows are
-- visible or touchable; `with check` governs what a row may become, which is
-- what stops a client writing rows attributed to someone else.
drop policy if exists sessions_select on public.sessions;
create policy sessions_select on public.sessions
  for select using (auth.uid() = user_id);

drop policy if exists sessions_insert on public.sessions;
create policy sessions_insert on public.sessions
  for insert with check (auth.uid() = user_id);

drop policy if exists sessions_update on public.sessions;
create policy sessions_update on public.sessions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists sessions_delete on public.sessions;
create policy sessions_delete on public.sessions
  for delete using (auth.uid() = user_id);

drop policy if exists solves_select on public.solves;
create policy solves_select on public.solves
  for select using (auth.uid() = user_id);

drop policy if exists solves_insert on public.solves;
create policy solves_insert on public.solves
  for insert with check (auth.uid() = user_id);

drop policy if exists solves_update on public.solves;
create policy solves_update on public.solves
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists solves_delete on public.solves;
create policy solves_delete on public.solves
  for delete using (auth.uid() = user_id);
