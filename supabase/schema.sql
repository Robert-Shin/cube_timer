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

-- Phase 1 owns these rules. `username` stays nullable although the app never
-- writes null: a `not null` here would make this file fail to re-run against any
-- pre-existing row that has one, and dailyClient already falls back to
-- 'anonymous'. The regex pins the charset AND makes leading, trailing, and
-- doubled spaces unrepresentable, so the client's trim-and-collapse is a
-- convenience rather than the only defence.
alter table public.profiles drop constraint if exists profiles_username_key;

alter table public.profiles drop constraint if exists profiles_username_format;
alter table public.profiles add constraint profiles_username_format
  check (username is null
         or (username ~ '^[A-Za-z0-9]+( [A-Za-z0-9]+)*$'
             and length(username) between 3 and 20));

-- Case-insensitively unique: impersonation by casing is a real hazard on a
-- public board. This subsumes the plain `unique` dropped above.
create unique index if not exists profiles_username_lower
  on public.profiles (lower(username));

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
  updated_at  timestamptz not null,
  published   boolean not null default false,
  primary key (user_id, event, utc_day)
);

-- `scramble` used to leak the day's shared scramble to anyone: a daily
-- challenge result is stored locally as an ordinary solve carrying that
-- scramble, and publishBestOfDay wrote it into this world-readable table. The
-- client now writes '' and nothing reads the column (fetchBoard selects only
-- user_id and time_ms). Dropping it removes the leak path entirely -- no
-- future write can reintroduce it if the column doesn't exist.
alter table public.daily_bests drop column if exists scramble;

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

-- Usernames are public so a board can name people, but only to a signed-in
-- caller -- the spec's decision is "who can read the board: anyone signed
-- in", not the general public holding the (by-design public) anon key.
-- `auth.uid() is not null` is used consistently here and below rather than
-- `to authenticated`, so every board-facing policy is greppable by the same
-- pattern.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (auth.uid() is not null);

drop policy if exists profiles_write on public.profiles;
create policy profiles_write on public.profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Row-level policy is not column-level: `using (true)` never leaked more than
-- `username` only because the table happened to have no other columns. Phase
-- 1 owns this table and will add columns, and each new one would go public
-- with no policy change to review. So belt-and-suspenders it with an
-- explicit column-level grant, replacing PostgREST's default table-wide
-- grant. Guarded so this block is safe to re-run.
--
-- opted_in is granted too, not withheld: profiles_write already lets the
-- owner read/write their own full row via `using/with check (auth.uid() =
-- user_id)`, so withholding the SELECT grant on this column would only break
-- that owner path while a non-owner still learns opted_in indirectly the
-- moment it flips a row's presence on the board (bests_select_board /
-- attempts_select_board are keyed off publication, which requires opted_in).
-- Granting it column-wide reveals nothing a signed-in caller can't already
-- infer from the board.
revoke all on public.profiles from anon;
revoke all on public.profiles from authenticated;
grant select (user_id, username, opted_in) on public.profiles to authenticated;
grant insert (user_id, username, opted_in) on public.profiles to authenticated;
grant update (user_id, username, opted_in) on public.profiles to authenticated;
grant delete on public.profiles to authenticated;

-- daily_scrambles: no policy at all. RLS with zero policies denies everything,
-- which is the intent. security definer functions bypass it.

drop policy if exists attempts_select_own on public.daily_attempts;
create policy attempts_select_own on public.daily_attempts
  for select using (auth.uid() = user_id);

-- A revealed-but-unsubmitted attempt stays private, so an unfinished solve is
-- not visible to anyone as a gap. Also requires a signed-in caller: the
-- board is for signed-in users only, per spec, not the public anon key.
drop policy if exists attempts_select_board on public.daily_attempts;
create policy attempts_select_board on public.daily_attempts
  for select using (auth.uid() is not null and published and submitted_at is not null);

-- No insert/update/delete policy: writes go only through the functions.

drop policy if exists bests_select_own on public.daily_bests;
create policy bests_select_own on public.daily_bests
  for select using (auth.uid() = user_id);

drop policy if exists bests_select_board on public.daily_bests;
create policy bests_select_board on public.daily_bests
  for select using (auth.uid() is not null and published);

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

  -- Confirmed before the commitment is written, not after: otherwise an
  -- event with no scramble burns the caller's one attempt slot for the day
  -- and hands back an empty result with no error. Checked here rather than
  -- against a hardcoded list of valid events -- that list already lives in
  -- the edge function, and duplicating it in SQL would be a second place to
  -- keep in sync.
  if not exists (
    select 1 from public.daily_scrambles
    where event = p_event and utc_day = v_day
  ) then
    raise exception 'no scramble for event % today', p_event;
  end if;

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
  -- A non-positive time passes the elapsed-time guard trivially (it's
  -- always less than any positive elapsed duration) and would land on the
  -- board as a record, corrupting its ordering. Reject it outright, before
  -- that guard even runs.
  if p_time_ms <= 0 then
    raise exception 'time_ms must be positive';
  end if;

  select * into v_attempt from public.daily_attempts
  where user_id = v_uid and event = p_event and utc_day = v_day;

  if not found then
    raise exception 'no attempt: reveal the scramble first';
  end if;
  if v_attempt.submitted_at is not null then
    -- Custom SQLSTATE, not just a message: the client decides "the first
    -- write won, stop retrying" from this, and matching on message text
    -- would silently retry forever the day the wording changed. This check
    -- is only the common-case fast path -- see the WHERE clause below for
    -- what actually enforces one-attempt-per-day against a race.
    raise exception 'already submitted' using errcode = 'CS001';
  end if;
  -- Impossible rather than merely suspicious: no solve can be longer than the
  -- wall clock since the scramble was handed out.
  if p_time_ms > extract(epoch from (now() - v_attempt.revealed_at)) * 1000 then
    raise exception 'submitted time exceeds elapsed time since reveal';
  end if;

  select coalesce(opted_in, false) into v_opted
  from public.profiles where user_id = v_uid;

  -- The check above reads a snapshot with no lock, so two concurrent calls
  -- can both pass it before either writes: Postgres serialises the two
  -- UPDATEs, but EvalPlanQual only re-checks the UPDATE's own WHERE clause,
  -- not the PL/pgSQL condition above it. Folding `submitted_at is null`
  -- into the WHERE makes the check and the write one atomic statement, so
  -- only the first of the two can ever match.
  update public.daily_attempts
  set submitted_at = now(),
      time_ms      = p_time_ms,
      penalty      = p_penalty,
      published    = coalesce(v_opted, false)
  where user_id = v_uid
    and event = p_event
    and utc_day = v_day
    and submitted_at is null;

  if not found then
    -- Lost the race, or a retry of a submission that already landed. Same
    -- SQLSTATE as the pre-check, so the client stops retrying either way.
    raise exception 'already submitted' using errcode = 'CS001';
  end if;
end;
$$;

revoke all on function public.reveal_daily(text) from public;
revoke all on function public.submit_daily(text, integer, text) from public;
grant execute on function public.reveal_daily(text) to authenticated;
grant execute on function public.submit_daily(text, integer, text) to authenticated;

-- ------------------------------------------------------------- friendships
-- Phase 3. Keyed on profiles(user_id), NOT auth.users(id): phase 1 moved
-- profile creation to username-claim time, so this foreign key makes it
-- structurally impossible to befriend someone who has not claimed a name,
-- with no check in application code.
create table if not exists public.friendships (
  requester   uuid not null references public.profiles(user_id) on delete cascade,
  addressee   uuid not null references public.profiles(user_id) on delete cascade,
  state       text not null check (state in ('pending', 'accepted')),
  created_at  timestamptz not null default now(),
  primary key (requester, addressee),
  check (requester <> addressee)
);

-- One row per UNORDERED pair, so rob->glen and glen->rob cannot both exist
-- as competing requests. The primary key alone does not give this: it treats
-- the two directions as different rows.
create unique index if not exists friendships_pair on public.friendships
  (least(requester, addressee), greatest(requester, addressee));

-- The practice calendar groups by created_at. The existing solve indexes are
-- (user_id, updated_at) for sync pulls and (user_id, session_id) for stats;
-- neither serves a date-range scan.
create index if not exists solves_user_created
  on public.solves (user_id, created_at) where not deleted;

-- "Are these two friends" is an OR over both column orders. Written exactly
-- once so the boundary condition can be attacked once rather than being
-- copy-pasted into each reader and drifting.
--
-- security definer deliberately: under the caller's own RLS this could only
-- ever see friendships the caller is party to, which happens to be sufficient
-- for today's callers but only by coincidence -- and relying on that
-- coincidence would make the helper unsafe the moment it is reused.
create or replace function public.are_friends(a uuid, b uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.friendships f
    where f.state = 'accepted'
      and ((f.requester = a and f.addressee = b)
        or (f.requester = b and f.addressee = a))
  );
$$;

-- No grant to authenticated (or anyone) follows, and none should be added.
-- This is an internal helper reached only from inside friend_calendar and
-- friend_stats, which run security definer as the function owner -- they
-- don't need an execute grant on are_friends to call it. A client able to
-- call it directly could pass two arbitrary uuids it has no relationship
-- to and learn whether those two strangers are friends, which is not
-- something any client needs to do.
revoke all on function public.are_friends(uuid, uuid) from public;

alter table public.friendships enable row level security;

-- You see only friendships you are part of.
drop policy if exists friend_select on public.friendships;
create policy friend_select on public.friendships for select
  using (auth.uid() in (requester, addressee));

-- You may only ever create a PENDING request, and only as yourself.
--
-- `state = 'pending'` is THE load-bearing clause of this feature. Without it
-- anyone could insert (me, victim, 'accepted') and read a stranger's entire
-- practice history without that person ever being asked.
drop policy if exists friend_insert on public.friendships;
create policy friend_insert on public.friendships for insert
  with check (auth.uid() = requester and state = 'pending');

-- Only the addressee may accept, and only pending -> accepted. `using` tests
-- the row as it was, `with check` the row as it would become: together they
-- stop a requester self-accepting, and stop an accepted row being flipped
-- back to pending and re-accepted to launder it.
drop policy if exists friend_accept on public.friendships;
create policy friend_accept on public.friendships for update
  using      (auth.uid() = addressee and state = 'pending')
  with check (auth.uid() = addressee and state = 'accepted');

-- Either party may walk away, from either state. Declining a request and
-- unfriending are deliberately the same operation: one path out, not two.
drop policy if exists friend_delete on public.friendships;
create policy friend_delete on public.friendships for delete
  using (auth.uid() in (requester, addressee));

-- Reading another user's solves is the one thing RLS cannot express, so it is
-- the only place security definer appears. RLS DOES NOT APPLY inside these
-- functions: the are_friends check IS the boundary, in full. Same posture as
-- reveal_daily. Both return NO ROWS when the caller is not an accepted
-- friend.

create or replace function public.friend_calendar(
  p_user uuid, p_event text, p_since date)
returns table (day date, solves int, day_best int)
language sql stable security definer set search_path = public as $$
  select
    (s.created_at at time zone 'UTC')::date as day,
    count(*)::int as solves,
    min(case when s.penalty = 'dnf' then null
             when s.penalty = 'plus2' then s.time_ms + 2000
             else s.time_ms end)::int as day_best
  from public.solves s
  join public.sessions n on n.id = s.session_id
  where s.user_id = p_user
    and n.event = p_event
    and not s.deleted
    and not n.deleted
    and (s.created_at at time zone 'UTC')::date >= p_since
    and public.are_friends(auth.uid(), p_user)
  group by 1
  order by 1;
$$;

create or replace function public.friend_stats(p_user uuid, p_event text)
returns table (total int, best_ms int, recent_ms int[])
language sql stable security definer set search_path = public as $$
  with mine as (
    select s.created_at,
           case when s.penalty = 'dnf' then null
                when s.penalty = 'plus2' then s.time_ms + 2000
                else s.time_ms end as eff
    from public.solves s
    join public.sessions n on n.id = s.session_id
    where s.user_id = p_user
      and n.event = p_event
      and not s.deleted
      and not n.deleted
      and public.are_friends(auth.uid(), p_user)
  ),
  recent as (
    -- Newest first, matching the order stats.ts expects: averageOf reads
    -- solves.slice(0, n) as the most recent n. -1 encodes a DNF, because an
    -- int[] cannot carry null through PostgREST reliably; the client maps it
    -- back before calling averageOf.
    select array_agg(coalesce(eff, -1) order by created_at desc) as arr
    from (select created_at, eff from mine order by created_at desc limit 12) t
  )
  -- The outer WHERE looks redundant with the are_friends check already
  -- baked into `mine` -- it is not. A scalar select list with no FROM
  -- clause always returns exactly one row, even when `mine` is empty: a
  -- non-friend caller would otherwise get back one row of (0, null, null)
  -- instead of the zero rows the design spec (and a later task's
  -- assertion) requires. This WHERE is what actually makes that true;
  -- `mine`'s filter alone is not enough because it only empties the
  -- aggregates, it doesn't remove the row.
  select
    (select count(*)::int from mine),
    (select min(eff)::int from mine),
    (select arr from recent)
  where public.are_friends(auth.uid(), p_user);
$$;

revoke all on function public.friend_calendar(uuid, text, date) from public;
revoke all on function public.friend_stats(uuid, text) from public;
grant execute on function public.friend_calendar(uuid, text, date) to authenticated;
grant execute on function public.friend_stats(uuid, text) to authenticated;
