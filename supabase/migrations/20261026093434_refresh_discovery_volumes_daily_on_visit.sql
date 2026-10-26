
create schema if not exists keychallenge_discovery_private;
revoke all on schema keychallenge_discovery_private from public, anon;
grant usage on schema keychallenge_discovery_private to authenticated, service_role;

create table keychallenge_discovery_private.volume_requests (
  keyword_key text primary key check (length(keyword_key) between 1 and 100),
  keyword text not null check (length(keyword) between 1 and 100),
  required_after timestamptz not null,
  requested_at timestamptz not null default now()
);
alter table keychallenge_discovery_private.volume_requests enable row level security;
revoke all on keychallenge_discovery_private.volume_requests from public, anon, authenticated;
grant select on keychallenge_discovery_private.volume_requests to service_role;
create index discovery_volume_requests_day_idx on keychallenge_discovery_private.volume_requests(required_after);

create or replace function public.keychallenge_volume_candidates(p_limit integer default 5)
returns jsonb language plpgsql stable set search_path = '' as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit,5),1),5);
  v_day timestamptz := date_trunc('day',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
  urgent jsonb;
  fallback jsonb;
begin
  with ranked as materialized (
    select public.keychallenge_keyword_key(k.name) as key,k.name,v.collected_at,
      row_number() over(partition by k.field order by v.volume_min desc,v.volume_max desc,k.name,k.keyword_id) as position
    from public.keychallenge_catalog_items k
    join public.keychallenge_search_volumes v on v.keyword_key=public.keychallenge_keyword_key(k.name)
    where k.catalog_id=(select catalog_id from public.keychallenge_catalog_publication)
      and v.available and v.volume_min is not null and length(k.name) between 1 and 100
  ), priority as (
    select r.keyword_key as key,r.keyword as name,0 as priority,r.requested_at as ordered_at
    from keychallenge_discovery_private.volume_requests r
    left join public.keychallenge_search_volumes v on v.keyword_key=r.keyword_key
    where r.required_after>=v_day and (v.collected_at is null or v.collected_at<r.required_after)
    union all
    select key,name,1,collected_at from ranked where position<=100 and collected_at<v_day
  ), unique_priority as (
    select distinct on (key) key,name,priority,ordered_at from priority order by key,priority,ordered_at
  )
  select coalesce(jsonb_agg(to_jsonb(x)-'priority'-'ordered_at'),'[]') into urgent
  from (select * from unique_priority order by priority,ordered_at,key limit v_limit)x;
  if jsonb_array_length(urgent)>=v_limit then return urgent; end if;

  with preferred as (select distinct x->>'categoryId' as id from public.keychallenge_profiles p
    cross join lateral jsonb_array_elements(p.payload->'items') x),
  names as (
    select public.keychallenge_keyword_key(k.name) as key,min(k.name) as name,
      max(k.participant_count) as participants,bool_or(k.category_id in (select id from preferred)) as preferred
    from public.keychallenge_catalog_items k
    where k.catalog_id=(select catalog_id from public.keychallenge_catalog_publication)
      and length(k.name) between 1 and 100
    group by public.keychallenge_keyword_key(k.name)
  )
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into fallback from (
    select n.key,n.name from names n left join public.keychallenge_search_volumes v on v.keyword_key=n.key
    where (v.collected_at is null or v.collected_at<now()-interval '30 days')
      and not exists(select 1 from jsonb_array_elements(urgent) q where q->>'key'=n.key)
    order by (v.collected_at is null) desc,n.preferred desc,v.collected_at asc nulls first,n.participants desc nulls last,n.key
    limit v_limit-jsonb_array_length(urgent)
  )x;
  return urgent||fallback;
end $function$;
CREATE OR REPLACE FUNCTION public.keychallenge_store_search_volumes(p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare changed integer;
begin
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>5000 then raise exception 'Invalid volume batch'; end if;
  insert into public.keychallenge_search_volumes(keyword_key,keyword,pc_min,pc_max,mobile_min,mobile_max,collected_at,available)
  select r.keyword_key,r.keyword,r.pc_min,r.pc_max,r.mobile_min,r.mobile_max,r.collected_at,r.available
  from jsonb_to_recordset(p_rows) r(keyword_key text,keyword text,pc_min integer,pc_max integer,mobile_min integer,mobile_max integer,collected_at timestamptz,available boolean)
  where r.keyword_key=public.keychallenge_keyword_key(r.keyword) and (exists(
    select 1 from public.keychallenge_catalog_items k where k.catalog_id=(select catalog_id from public.keychallenge_catalog_publication)
      and public.keychallenge_keyword_key(k.name)=r.keyword_key) or exists(
    select 1 from keychallenge_discovery_private.volume_requests q where q.keyword_key=r.keyword_key))
  on conflict(keyword_key) do update set keyword=excluded.keyword,pc_min=excluded.pc_min,pc_max=excluded.pc_max,
    mobile_min=excluded.mobile_min,mobile_max=excluded.mobile_max,collected_at=excluded.collected_at,available=excluded.available
  where excluded.collected_at>=keychallenge_search_volumes.collected_at;
  get diagnostics changed = row_count;
  return changed;
end $function$;

create or replace function keychallenge_discovery_private.blogger_discovery_fresh(p_enqueue boolean default true)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare
  v_user uuid := auth.uid();
  v_day timestamptz := date_trunc('day',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
  payload jsonb;
  needed jsonb;
  added integer := 0;
  pending integer := 0;
  enabled boolean;
  job_status text;
  last_requested timestamptz;
  completed timestamptz;
  refresh_status text;
begin
  if v_user is null then raise exception '로그인이 필요합니다.' using errcode='42501'; end if;
  if not exists(select 1 from public.keychallenge_members where user_id=v_user) then
    raise exception '블로그 설정을 먼저 완료해 주세요.' using errcode='42501';
  end if;
  payload := public.keychallenge_blogger_discovery();
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into needed from (
    select distinct public.keychallenge_keyword_key(r.keyword) as key,r.keyword
    from jsonb_to_recordset(coalesce(payload->'opportunities','[]')||coalesce(payload->'ideas','[]')) r(keyword text)
    left join public.keychallenge_search_volumes v on v.keyword_key=public.keychallenge_keyword_key(r.keyword)
    where length(r.keyword) between 1 and 100 and (v.collected_at is null or v.collected_at<v_day)
  )x;
  pending := jsonb_array_length(needed);
  select coalesce((select s.enabled and s.configured from public.keychallenge_searchad_status s where singleton),false)
    and coalesce((select s.enabled from public.keychallenge_refresh_schedule s where singleton),false) into enabled;
  select status,completed_at into job_status,completed from public.keychallenge_sync_jobs where resource_key='volume';
  if pending>0 and enabled and coalesce(p_enqueue,false) then
    insert into keychallenge_discovery_private.volume_requests(keyword_key,keyword,required_after,requested_at)
    select distinct on (r.key) r.key,r.keyword,v_day,now() from jsonb_to_recordset(needed) r(key text,keyword text) order by r.key,r.keyword
    on conflict(keyword_key) do update set keyword=excluded.keyword,required_after=excluded.required_after,requested_at=excluded.requested_at
      where volume_requests.required_after<excluded.required_after;
    get diagnostics added = row_count;
    select max(q.requested_at) into last_requested from keychallenge_discovery_private.volume_requests q
      where exists(select 1 from jsonb_to_recordset(needed) r(key text) where r.key=q.keyword_key);
    -- One shared job; do not reset a running lease or bypass a failed job's retry policy.
    if (job_status is null or job_status not in ('failed','cancelled'))
      and (added>0 or (job_status='succeeded' and completed<last_requested)) then
      perform keychallenge_private.enqueue_volume();
    end if;
    select status into job_status from public.keychallenge_sync_jobs where resource_key='volume';
  end if;
  refresh_status := case when pending=0 then 'fresh' when not enabled then 'disabled'
    when job_status in ('failed','cancelled') then 'error'
    when job_status in ('queued','running') then 'refreshing' else 'stale' end;
  return payload || jsonb_build_object('volume_refresh',jsonb_build_object(
    'status',refresh_status,'pending',pending,'checked_at',now(),'day',(now() at time zone 'Asia/Seoul')::date,
    'oldest_top10_at',(select min((x->>'collected_at')::timestamptz) from jsonb_array_elements(payload->'opportunities') x)
  ));
end $function$;
revoke all on function keychallenge_discovery_private.blogger_discovery_fresh(boolean) from public,anon;
grant execute on function keychallenge_discovery_private.blogger_discovery_fresh(boolean) to authenticated;

create or replace function public.keychallenge_blogger_discovery_fresh(p_enqueue boolean default true)
returns jsonb language sql set search_path='' as $function$
  select keychallenge_discovery_private.blogger_discovery_fresh(p_enqueue);
$function$;
revoke all on function public.keychallenge_blogger_discovery_fresh(boolean) from public,anon;
grant execute on function public.keychallenge_blogger_discovery_fresh(boolean) to authenticated;
