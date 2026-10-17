create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
create schema if not exists keychallenge_private;
revoke all on schema keychallenge_private from public, anon, authenticated;

alter table public.keychallenge_profiles
  add column auto_refresh_enabled boolean not null default true,
  add column scheduled_status text not null default 'waiting',
  add column scheduled_error text,
  add column last_scheduled_at timestamptz;
alter table public.keychallenge_catalogs add column scheduled_snapshot boolean not null default false;
grant all on public.keychallenge_profiles, public.keychallenge_admins, public.keychallenge_catalogs,
  public.keychallenge_catalog_items, public.keychallenge_catalog_publication to service_role;

create table public.keychallenge_refresh_schedule (
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false,
  timezone text not null default 'Asia/Seoul',
  daily_hour integer not null default 4 check(daily_hour = 4),
  catalog_status text not null default 'waiting',
  catalog_error text,
  catalog_last_success_at timestamptz
);
alter table public.keychallenge_refresh_schedule enable row level security;
revoke all on public.keychallenge_refresh_schedule from anon, authenticated;
grant select on public.keychallenge_refresh_schedule to anon, authenticated;
grant all on public.keychallenge_refresh_schedule to service_role;
create policy "Read daily refresh schedule" on public.keychallenge_refresh_schedule
  for select to anon, authenticated using(true);
insert into public.keychallenge_refresh_schedule(singleton) values(true);

create table public.keychallenge_sync_auth (
  singleton boolean primary key default true check(singleton),
  token_hash text not null
);
alter table public.keychallenge_sync_auth enable row level security;
revoke all on public.keychallenge_sync_auth from public, anon, authenticated;
grant select on public.keychallenge_sync_auth to service_role;
-- The scheduler credential stays in Vault; no secret is embedded in source or cron text.
do $$ declare token text := encode(extensions.gen_random_bytes(32), 'hex'); begin
  perform vault.create_secret(token, 'keychallenge_daily_sync_token');
  insert into public.keychallenge_sync_auth(token_hash)
    values(encode(extensions.digest(token,'sha256'),'hex'));
end $$;

create table public.keychallenge_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  resource_key text not null unique,
  kind text not null check(kind in ('profile','catalog')),
  profile_id uuid references public.keychallenge_profiles(id) on delete cascade,
  status text not null default 'queued' check(status in ('queued','running','succeeded','failed','cancelled')),
  state jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  last_error text,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz
);
create index keychallenge_sync_jobs_due_idx on public.keychallenge_sync_jobs(next_attempt_at, updated_at)
  where status in ('queued','running');
create index keychallenge_sync_jobs_profile_idx on public.keychallenge_sync_jobs(profile_id);
alter table public.keychallenge_sync_jobs enable row level security;
revoke all on public.keychallenge_sync_jobs from public, anon, authenticated;
grant all on public.keychallenge_sync_jobs to service_role;

create function keychallenge_private.enqueue_daily() returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if not (select enabled from public.keychallenge_refresh_schedule where singleton) then return; end if;
  -- A job may resume across worker invocations, but never across more than one day.
  update public.keychallenge_sync_jobs set status='failed', last_error='수집 시간이 초과되었습니다.'
    where status in ('queued','running') and started_at < now() - interval '20 hours';
  insert into public.keychallenge_sync_jobs(resource_key,kind,profile_id)
    select 'profile:'||id, 'profile', id from public.keychallenge_profiles
    where auto_refresh_enabled and influencer_id ~ '^[a-z0-9][a-z0-9_.-]{0,99}$'
  on conflict(resource_key) do update set status='queued',state='{}',attempts=0,last_error=null,
    started_at=now(),updated_at=now(),completed_at=null,next_attempt_at=now(),lease_token=null,lease_until=null
    where keychallenge_sync_jobs.status in ('succeeded','failed','cancelled');
  insert into public.keychallenge_sync_jobs(resource_key,kind) values('catalog','catalog')
  on conflict(resource_key) do update set status='queued',state='{}',attempts=0,last_error=null,
    started_at=now(),updated_at=now(),completed_at=null,next_attempt_at=now(),lease_token=null,lease_until=null
    where keychallenge_sync_jobs.status in ('succeeded','failed','cancelled');
  update public.keychallenge_profiles p set scheduled_status='queued',scheduled_error=null
    where auto_refresh_enabled and exists(select 1 from public.keychallenge_sync_jobs j
      where j.profile_id=p.id and j.status in ('queued','running'));
  update public.keychallenge_refresh_schedule set catalog_status='queued',catalog_error=null where singleton;
end $$;
revoke all on function keychallenge_private.enqueue_daily() from public, anon, authenticated;

create function keychallenge_private.dispatch_sync() returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if not (select enabled from public.keychallenge_refresh_schedule where singleton) then return; end if;
  if not exists(select 1 from public.keychallenge_sync_jobs where
    status in ('queued','running') and next_attempt_at<=now()
    and (lease_until is null or lease_until<now())) then return; end if;
  perform net.http_post(
    url := 'https://vuatuabiueppcdbdootw.supabase.co/functions/v1/keychallenge-sync',
    headers := jsonb_build_object('Content-Type','application/json','x-keychallenge-token',
      (select decrypted_secret from vault.decrypted_secrets where name='keychallenge_daily_sync_token')),
    body := '{}'::jsonb, timeout_milliseconds := 90000);
end $$;
revoke all on function keychallenge_private.dispatch_sync() from public, anon, authenticated;

create function public.keychallenge_claim_sync_job() returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare job public.keychallenge_sync_jobs;
begin
  select * into job from public.keychallenge_sync_jobs
    where status in ('queued','running') and next_attempt_at<=now()
      and (lease_until is null or lease_until<now())
    order by case kind when 'profile' then 0 else 1 end,updated_at
    limit 1 for update skip locked;
  if not found then return null; end if;
  update public.keychallenge_sync_jobs set status='running', lease_token=gen_random_uuid(),
    lease_until=now()+interval '2 minutes',updated_at=now() where id=job.id returning * into job;
  return to_jsonb(job);
end $$;
revoke all on function public.keychallenge_claim_sync_job() from public, anon, authenticated;
grant execute on function public.keychallenge_claim_sync_job() to service_role;

create function public.keychallenge_finish_profile_sync(p_job uuid,p_lease uuid,p_payload jsonb,p_baseline timestamptz)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare job public.keychallenge_sync_jobs; changed integer;
begin
  select * into job from public.keychallenge_sync_jobs where id=p_job and lease_token=p_lease
    and status='running' and lease_until>now() for update;
  if not found then raise exception 'Worker lease expired'; end if;
  if job.kind<>'profile' or jsonb_typeof(p_payload->'items')<>'array'
    or jsonb_array_length(p_payload->'items')<>(p_payload->>'total')::integer then
    raise exception 'Incomplete profile'; end if;
  update public.keychallenge_profiles set payload=p_payload,owner_id=p_payload->>'ownerId',updated_at=now(),
    scheduled_status='succeeded',scheduled_error=null,last_scheduled_at=now()
    where id=job.profile_id and auto_refresh_enabled and updated_at=p_baseline
      and influencer_id=p_payload->>'influencerId';
  get diagnostics changed = row_count;
  update public.keychallenge_sync_jobs set status=case when changed=1 then 'succeeded' else 'cancelled' end,
    state='{}', completed_at=now(),updated_at=now(),lease_until=null,lease_token=null,last_error=null
    where id=p_job;
  if changed=0 then update public.keychallenge_profiles set scheduled_status='skipped',scheduled_error=null
    where id=job.profile_id; end if;
  return changed=1;
end $$;
revoke all on function public.keychallenge_finish_profile_sync(uuid,uuid,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.keychallenge_finish_profile_sync(uuid,uuid,jsonb,timestamptz) to service_role;

create function public.keychallenge_finish_catalog_sync(p_job uuid,p_lease uuid,p_catalog uuid,p_expected integer,p_difference integer,p_fields integer)
returns void language plpgsql security invoker set search_path = '' as $$
declare actual integer; fields integer; job public.keychallenge_sync_jobs;
begin
  select * into job from public.keychallenge_sync_jobs where id=p_job and lease_token=p_lease
    and status='running' and lease_until>now() for update;
  if not found or job.kind<>'catalog' then raise exception 'Worker lease expired'; end if;
  if (job.state->>'catalogId')::uuid is distinct from p_catalog then raise exception 'Snapshot mismatch'; end if;
  select count(*),count(distinct category_id) into actual,fields
    from public.keychallenge_catalog_items where catalog_id=p_catalog;
  if actual<>p_expected or actual<1 or actual>200000 or fields<>p_fields then
    raise exception 'Incomplete catalog'; end if;
  update public.keychallenge_catalogs set expected_count=actual,
    source_label='네이버 공개 키워드 목록 · 매일 자동 갱신'||case when p_difference>0
      then ' · 원본 표시 총계와 '||p_difference||'개 차이' else '' end,
    coverage=case when p_difference=0 then 'all' else 'partial' end
    where id=p_catalog and scheduled_snapshot;
  if not found then raise exception 'Scheduled snapshot required'; end if;
  insert into public.keychallenge_catalog_publication(singleton,catalog_id,published_at)
    values(true,p_catalog,now()) on conflict(singleton) do update set catalog_id=excluded.catalog_id,published_at=excluded.published_at;
  update public.keychallenge_sync_jobs set status='succeeded',state='{}',completed_at=now(),updated_at=now(),
    lease_until=null,lease_token=null,last_error=null where id=p_job;
  update public.keychallenge_refresh_schedule set catalog_status='succeeded',catalog_error=null,
    catalog_last_success_at=now() where singleton;
  -- Retain the three newest scheduled snapshots. Original/manual snapshots are preserved.
  delete from public.keychallenge_catalogs where scheduled_snapshot and id<>p_catalog
    and id not in (select id from public.keychallenge_catalogs where scheduled_snapshot order by created_at desc limit 3);
end $$;
revoke all on function public.keychallenge_finish_catalog_sync(uuid,uuid,uuid,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.keychallenge_finish_catalog_sync(uuid,uuid,uuid,integer,integer,integer) to service_role;

-- UTC 19:00 = next calendar day 04:00 in Asia/Seoul (no daylight saving).
select cron.schedule('keychallenge-daily-refresh','0 19 * * *','select keychallenge_private.enqueue_daily();');
select cron.schedule('keychallenge-refresh-worker','30 seconds','select keychallenge_private.dispatch_sync();');
