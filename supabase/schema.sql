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

-- ---------------------------------------------------------------- profiles
-- Phase 1 owns the profile UI and any further columns; this guarded block is
-- the minimum the daily challenge needs to exist against.
create table if not exists public.profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  username    text unique,
  opted_in    boolean not null default false,
  created_at  timestamptz not null default now()
);

-- --------------------------------------------------- daily challenge tables
-- One row per event per UTC day, written only by the Edge Function's service
-- role. There is deliberately no select policy: a client that could read this
-- table could practise the scramble before committing to its attempt.
create table if not exists public.daily_scrambles (
  event       text not null,
  utc_day     date not null,
  scramble    text not null,
  created_at  timestamptz not null default now(),
  primary key (event, utc_day)
);

create table if not exists public.daily_attempts (
  user_id       uuid not null references auth.users(id) on delete cascade,
  event         text not null,
  utc_day       date not null,
  revealed_at   timestamptz not null default now(),
  submitted_at  timestamptz,
  time_ms       integer,
  penalty       text not null default 'none'
                  check (penalty in ('none', 'plus2', 'dnf')),
  published     boolean not null default false,
  primary key (user_id, event, utc_day)
);

create table if not exists public.daily_bests (
  user_id     uuid not null references auth.users(id) on delete cascade,
  event       text not null,
  utc_day     date not null,
  time_ms     integer not null,
  scramble    text not null default '',
  updated_at  timestamptz not null,
  published   boolean not null default false,
  primary key (user_id, event, utc_day)
);

create index if not exists daily_attempts_board
  on public.daily_attempts (event, utc_day, time_ms)
  where published and submitted_at is not null and penalty <> 'dnf';
create index if not exists daily_bests_board
  on public.daily_bests (event, utc_day, time_ms)
  where published;

alter table public.profiles        enable row level security;
alter table public.daily_scrambles enable row level security;
alter table public.daily_attempts  enable row level security;
alter table public.daily_bests     enable row level security;

-- Usernames are public so a board can name people. Nothing else is: the
-- email lives in auth.users, which PostgREST does not expose.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select using (true);

drop policy if exists profiles_write on public.profiles;
create policy profiles_write on public.profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- daily_scrambles: no policy at all. RLS with zero policies denies everything,
-- which is the intent. security definer functions bypass it.

drop policy if exists attempts_select_own on public.daily_attempts;
create policy attempts_select_own on public.daily_attempts
  for select using (auth.uid() = user_id);

-- A revealed-but-unsubmitted attempt stays private, so an unfinished solve is
-- not visible to anyone as a gap.
drop policy if exists attempts_select_board on public.daily_attempts;
create policy attempts_select_board on public.daily_attempts
  for select using (published and submitted_at is not null);

-- No insert/update/delete policy: writes go only through the functions.

drop policy if exists bests_select_own on public.daily_bests;
create policy bests_select_own on public.daily_bests
  for select using (auth.uid() = user_id);

drop policy if exists bests_select_board on public.daily_bests;
create policy bests_select_board on public.daily_bests
  for select using (published);

-- `not published or opted_in`: without this a client could publish its own
-- row by setting the column, bypassing the opt-in entirely.
drop policy if exists bests_write_own on public.daily_bests;
create policy bests_write_own on public.daily_bests
  for all using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (
      not published
      or exists (select 1 from public.profiles p
                 where p.user_id = auth.uid() and p.opted_in)
    )
  );

-- ------------------------------------------------------ challenge functions
-- security definer: these run as the owner and bypass RLS, which is the only
-- way to hand out a scramble and record the commitment in one transaction.
-- search_path is pinned so a caller cannot shadow a referenced object.

create or replace function public.reveal_daily(p_event text)
returns table (scramble text, revealed_at timestamptz, submitted boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_day date := (now() at time zone 'utc')::date;
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;

  -- Opting in governs publication, not participation: someone may take the
  -- daily privately, so this deliberately does not check profiles.opted_in.

  insert into public.daily_attempts (user_id, event, utc_day)
  values (v_uid, p_event, v_day)
  on conflict (user_id, event, utc_day) do nothing;

  return query
  select s.scramble, a.revealed_at, a.submitted_at is not null
  from public.daily_attempts a
  join public.daily_scrambles s
    on s.event = a.event and s.utc_day = a.utc_day
  where a.user_id = v_uid and a.event = p_event and a.utc_day = v_day;
end;
$$;

create or replace function public.submit_daily(
  p_event text, p_time_ms integer, p_penalty text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_day date := (now() at time zone 'utc')::date;
  v_attempt public.daily_attempts%rowtype;
  v_opted boolean;
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;
  if p_penalty not in ('none', 'plus2', 'dnf') then
    raise exception 'unknown penalty %', p_penalty;
  end if;

  select * into v_attempt from public.daily_attempts
  where user_id = v_uid and event = p_event and utc_day = v_day;

  if not found then
    raise exception 'no attempt: reveal the scramble first';
  end if;
  if v_attempt.submitted_at is not null then
    -- Custom SQLSTATE, not just a message: the client decides "the first
    -- write won, stop retrying" from this, and matching on message text
    -- would silently retry forever the day the wording changed.
    raise exception 'already submitted' using errcode = 'CS001';
  end if;
  -- Impossible rather than merely suspicious: no solve can be longer than the
  -- wall clock since the scramble was handed out.
  if p_time_ms > extract(epoch from (now() - v_attempt.revealed_at)) * 1000 then
    raise exception 'submitted time exceeds elapsed time since reveal';
  end if;

  select coalesce(opted_in, false) into v_opted
  from public.profiles where user_id = v_uid;

  update public.daily_attempts
  set submitted_at = now(),
      time_ms      = p_time_ms,
      penalty      = p_penalty,
      published    = coalesce(v_opted, false)
  where user_id = v_uid and event = p_event and utc_day = v_day;
end;
$$;

revoke all on function public.reveal_daily(text) from public;
revoke all on function public.submit_daily(text, integer, text) from public;
grant execute on function public.reveal_daily(text) to authenticated;
grant execute on function public.submit_daily(text, integer, text) to authenticated;
