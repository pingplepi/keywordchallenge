create table if not exists public.keychallenge_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  influencer_id text not null check (length(influencer_id) between 1 and 100),
  owner_id text,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  updated_at timestamptz not null default now(),
  unique (user_id, influencer_id)
);

create index if not exists keychallenge_profiles_user_updated_idx
  on public.keychallenge_profiles (user_id, updated_at desc);

alter table public.keychallenge_profiles enable row level security;
alter table public.keychallenge_profiles force row level security;

drop policy if exists "Users can read their own keychallenge profiles" on public.keychallenge_profiles;
create policy "Users can read their own keychallenge profiles"
  on public.keychallenge_profiles for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own keychallenge profiles" on public.keychallenge_profiles;
create policy "Users can insert their own keychallenge profiles"
  on public.keychallenge_profiles for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own keychallenge profiles" on public.keychallenge_profiles;
create policy "Users can update their own keychallenge profiles"
  on public.keychallenge_profiles for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select, insert, update on public.keychallenge_profiles to authenticated;
revoke all on public.keychallenge_profiles from anon;

create table if not exists public.keychallenge_handoffs (
  token_hash text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  payload jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.keychallenge_handoffs enable row level security;
alter table public.keychallenge_handoffs force row level security;
revoke all on public.keychallenge_handoffs from anon, authenticated;
