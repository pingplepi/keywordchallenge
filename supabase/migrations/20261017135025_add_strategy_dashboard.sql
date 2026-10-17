create function public.keychallenge_int(value text) returns integer language sql immutable security invoker set search_path='' as $$
  select case when value ~ '^[0-9]{1,9}$' then value::integer else null end;
$$;
create function public.keychallenge_keyword_key(value text) returns text language sql immutable security invoker set search_path='' as $$
  select upper(regexp_replace(value,'\s','','g'));
$$;

create table public.keychallenge_profile_history (
  profile_id uuid not null references public.keychallenge_profiles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  snapshot_date date not null,
  collected_at timestamptz not null,
  total integer not null,
  ranks jsonb not null,
  primary key(profile_id,snapshot_date)
);
create index keychallenge_profile_history_user_idx on public.keychallenge_profile_history(user_id,profile_id,snapshot_date desc);
alter table public.keychallenge_profile_history enable row level security;
revoke all on public.keychallenge_profile_history from anon,authenticated;
grant select on public.keychallenge_profile_history to authenticated;
grant all on public.keychallenge_profile_history to service_role;
create policy "Read own daily ranking history" on public.keychallenge_profile_history
  for select to authenticated using(user_id=(select auth.uid()));

create function keychallenge_private.record_profile_history() returns trigger
language plpgsql security definer set search_path='' as $$
declare stamp timestamptz; day date; records jsonb; expected integer;
begin
  if auth.uid() is not null and auth.uid()<>new.user_id then raise exception 'Owner mismatch'; end if;
  if tg_op='UPDATE' and new.payload is not distinct from old.payload then return new; end if;
  expected := public.keychallenge_int(new.payload->>'total');
  if jsonb_typeof(new.payload->'items') is distinct from 'array' then return new; end if;
  if expected is null or expected<>jsonb_array_length(new.payload->'items') then return new; end if;
  begin stamp := (new.payload->>'collectedAt')::timestamptz; exception when others then return new; end;
  if stamp is null or stamp>now()+interval '10 minutes' then return new; end if;
  day := (stamp at time zone 'Asia/Seoul')::date;
  select coalesce(jsonb_object_agg(x->>'id',jsonb_build_object('r',nullif(public.keychallenge_int(x->>'rank'),0),
    'n',left(x->>'name',200),'c',x->>'categoryId','cc',public.keychallenge_int(x->>'challengeCount'))),'{}')
    into records from jsonb_array_elements(new.payload->'items') x where x->>'id' is not null;
  if (select count(*) from jsonb_object_keys(records))<>expected then return new; end if;
  insert into public.keychallenge_profile_history(profile_id,user_id,snapshot_date,collected_at,total,ranks)
    values(new.id,new.user_id,day,stamp,expected,records)
  on conflict(profile_id,snapshot_date) do update set collected_at=excluded.collected_at,total=excluded.total,ranks=excluded.ranks
    where keychallenge_profile_history.collected_at<=excluded.collected_at;
  delete from public.keychallenge_profile_history where profile_id=new.id and snapshot_date<day-31;
  return new;
end $$;
revoke all on function keychallenge_private.record_profile_history() from public,anon,authenticated;
create trigger keychallenge_profile_daily_history after insert or update of payload on public.keychallenge_profiles
  for each row execute function keychallenge_private.record_profile_history();
-- Seed only actual saved collection dates. There is no fabricated previous day.
insert into public.keychallenge_profile_history(profile_id,user_id,snapshot_date,collected_at,total,ranks)
select p.id,p.user_id,((p.payload->>'collectedAt')::timestamptz at time zone 'Asia/Seoul')::date,
  (p.payload->>'collectedAt')::timestamptz,public.keychallenge_int(p.payload->>'total'),
  (select coalesce(jsonb_object_agg(x->>'id',jsonb_build_object('r',nullif(public.keychallenge_int(x->>'rank'),0),
    'n',left(x->>'name',200),'c',x->>'categoryId','cc',public.keychallenge_int(x->>'challengeCount'))),'{}')
    from jsonb_array_elements(p.payload->'items') x where x->>'id' is not null)
from public.keychallenge_profiles p where public.keychallenge_int(p.payload->>'total')=jsonb_array_length(p.payload->'items')
  and p.payload->>'collectedAt' is not null;

create table public.keychallenge_search_volumes (
  keyword_key text primary key,
  keyword text not null,
  pc_min integer check(pc_min>=0), pc_max integer check(pc_max>=pc_min),
  mobile_min integer check(mobile_min>=0), mobile_max integer check(mobile_max>=mobile_min),
  volume_min integer generated always as (pc_min+mobile_min) stored,
  volume_max integer generated always as (pc_max+mobile_max) stored,
  collected_at timestamptz not null default now(),
  source text not null default '네이버 검색광고 키워드 도구',
  available boolean not null default true
);
alter table public.keychallenge_search_volumes enable row level security;
revoke all on public.keychallenge_search_volumes from anon,authenticated;
grant select on public.keychallenge_search_volumes to anon,authenticated;
grant all on public.keychallenge_search_volumes to service_role;
create policy "Public measured search volumes" on public.keychallenge_search_volumes for select to anon,authenticated using(true);
create index keychallenge_search_volumes_date_idx on public.keychallenge_search_volumes(collected_at);
create index keychallenge_catalog_items_keyword_key_idx on public.keychallenge_catalog_items(catalog_id,public.keychallenge_keyword_key(name));

create function public.keychallenge_dashboard_rows(p_influencer_id text default '',p_field text default '')
returns table(keyword_id text,name text,field text,category_id text,participant_count integer,volume_min integer,volume_max integer,
 volume_collected_at timestamptz,joined boolean,current_rank integer,challenge_count integer,previous_rank integer,previous_joined boolean)
language plpgsql stable security invoker set search_path='' as $$
declare payload jsonb; ranks jsonb:='{}'; before jsonb:='{}'; v_profile_id uuid; current_day date;
begin
  if auth.uid() is not null and p_influencer_id<>'' then
    select p.id,p.payload into v_profile_id,payload from public.keychallenge_profiles p where p.user_id=(select auth.uid()) and p.influencer_id=p_influencer_id;
    if payload is not null then
      select coalesce(jsonb_object_agg(x->>'id',x),'{}') into ranks from jsonb_array_elements(payload->'items') x where x->>'id' is not null;
      current_day := ((payload->>'collectedAt')::timestamptz at time zone 'Asia/Seoul')::date;
      select h.ranks into before from public.keychallenge_profile_history h where h.profile_id=v_profile_id
        and h.user_id=(select auth.uid()) and h.snapshot_date<current_day order by h.snapshot_date desc limit 1;
    end if;
  end if;
  return query select k.keyword_id,k.name,k.field,k.category_id,k.participant_count,v.volume_min,v.volume_max,v.collected_at,
    case when payload is null then null else ranks ? k.keyword_id end,
    nullif(public.keychallenge_int(ranks->k.keyword_id->>'rank'),0),coalesce(public.keychallenge_int(ranks->k.keyword_id->>'challengeCount'),0),
    nullif(public.keychallenge_int(before->k.keyword_id->>'r'),0),coalesce(before ? k.keyword_id,false)
  from public.keychallenge_catalog_items k left join public.keychallenge_search_volumes v
    on v.keyword_key=public.keychallenge_keyword_key(k.name) and v.available
  where k.catalog_id=(select catalog_id from public.keychallenge_catalog_publication)
    and (p_field='' or k.field=p_field);
end $$;
revoke all on function public.keychallenge_dashboard_rows(text,text) from public;
grant execute on function public.keychallenge_dashboard_rows(text,text) to anon,authenticated;

create function public.keychallenge_strategy(p_influencer_id text,p_field text default '__mine__') returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare p public.keychallenge_profiles; field_name text:=p_field; current_day date; previous_day date; category text;
  previous jsonb; current_ranks jsonb; result jsonb; changes jsonb; timeline jsonb;
begin
  select * into p from public.keychallenge_profiles where user_id=(select auth.uid()) and influencer_id=p_influencer_id;
  if p.id is null then raise exception '인플홈을 먼저 수집해 주세요.'; end if;
  if length(p_field)>100 then raise exception '분야를 확인해 주세요.'; end if;
  if field_name='__mine__' then
    select x->>'categoryId' into category from jsonb_array_elements(p.payload->'items') x group by x->>'categoryId' order by count(*) desc limit 1;
    select k.field into field_name from public.keychallenge_catalog_items k where k.catalog_id=(select catalog_id from public.keychallenge_catalog_publication)
      and k.category_id=category limit 1;
    field_name:=coalesce(field_name,'');
  end if;
  current_day:=((p.payload->>'collectedAt')::timestamptz at time zone 'Asia/Seoul')::date;
  select snapshot_date,ranks into previous_day,previous from public.keychallenge_profile_history
    where profile_id=p.id and user_id=(select auth.uid()) and snapshot_date<current_day order by snapshot_date desc limit 1;
  select coalesce(jsonb_object_agg(x->>'id',jsonb_build_object('r',nullif(public.keychallenge_int(x->>'rank'),0),'n',x->>'name','c',x->>'categoryId')),'{}')
    into current_ranks from jsonb_array_elements(p.payload->'items') x where x->>'id' is not null;
  with market as materialized (select * from public.keychallenge_dashboard_rows(p_influencer_id,field_name)),
  attacks as (select *, round(((11-current_rank)*10 + case when previous_rank>current_rank then least(previous_rank-current_rank,10)*2 else 0 end
    + case when volume_min is not null then least(ln(volume_min+1)*2,25) else 0 end
    + case when participant_count is not null then 12.0/(1+participant_count/100.0) else 0 end
    + case when challenge_count<=2 then 5 else 0 end)::numeric,1) as score
    from market where current_rank between 4 and 10),
  selected as (select * from attacks order by score desc,current_rank,name limit 10),
  demand as (select * from market where not joined and volume_min is not null and volume_max>0
    order by volume_min desc,participant_count asc nulls last,name limit 10)
  select jsonb_build_object('field',field_name,'current_date',current_day,'previous_date',previous_day,'collected_at',p.payload->>'collectedAt',
    'total_all',(select expected_count from public.keychallenge_catalogs where id=(select catalog_id from public.keychallenge_catalog_publication)),
    'total',(select count(*) from market),'joined',(select count(*) from market where joined),'top3',(select count(*) from market where current_rank between 1 and 3),
    'near',(select count(*) from market where current_rank between 4 and 10),'volume_covered',(select count(*) from market where volume_min is not null),
    'attacks',coalesce((select jsonb_agg(to_jsonb(selected)) from selected),'[]'),
    'demand',coalesce((select jsonb_agg(to_jsonb(demand)) from demand),'[]')) into result;
  with fields as (select category_id,min(field) as field from public.keychallenge_catalog_items where catalog_id=(select catalog_id from public.keychallenge_catalog_publication) group by category_id),
  joined_ranks as (select coalesce(a.key,b.key) as keyword_id,coalesce(a.value->>'n',b.value->>'n') as name,f.field,
    public.keychallenge_int(a.value->>'r') as current_rank,public.keychallenge_int(b.value->>'r') as previous_rank
    from jsonb_each(current_ranks) a full join jsonb_each(coalesce(previous,'{}')) b on a.key=b.key
    left join fields f on f.category_id=coalesce(a.value->>'c',b.value->>'c')
    where field_name='' or f.field=field_name),
  movement as materialized (select *,previous_rank-current_rank as gain,
    current_rank between 1 and 3 and (previous_rank is null or previous_rank>3) as new_top3,
    previous_rank between 1 and 3 and (current_rank is null or current_rank>3) as left_top3 from joined_ranks),
  all_changes as (select * from movement where current_rank is distinct from previous_rank order by abs(gain) desc nulls last,name limit 50),
  ups as (select * from movement where gain>0 order by gain desc,name limit 10),
  downs as (select * from movement where gain<0 order by gain,name limit 10),
  enters as (select * from movement where new_top3 order by current_rank,name limit 10),
  exits as (select * from movement where left_top3 order by previous_rank,name limit 10)
  select jsonb_build_object('compared',count(*) filter(where current_rank is not null and previous_rank is not null),
    'up',count(*) filter(where gain>0),'down',count(*) filter(where gain<0),
    'new_top3',count(*) filter(where new_top3),'left_top3',count(*) filter(where left_top3),
    'changes',coalesce((select jsonb_agg(to_jsonb(all_changes)) from all_changes),'[]'),
    'movers',jsonb_build_object('up',coalesce((select jsonb_agg(to_jsonb(ups)) from ups),'[]'),
      'down',coalesce((select jsonb_agg(to_jsonb(downs)) from downs),'[]'),
      'new_top3',coalesce((select jsonb_agg(to_jsonb(enters)) from enters),'[]'),
      'left_top3',coalesce((select jsonb_agg(to_jsonb(exits)) from exits),'[]'))) into changes from movement;
  with fields as (select category_id,min(field) as field from public.keychallenge_catalog_items where catalog_id=(select catalog_id from public.keychallenge_catalog_publication) group by category_id),
  days as (select h.snapshot_date,count(*) filter(where field_name='' or f.field=field_name) as joined,
    count(*) filter(where (field_name='' or f.field=field_name) and public.keychallenge_int(x.value->>'r') between 1 and 3) as top3,
    count(*) filter(where (field_name='' or f.field=field_name) and public.keychallenge_int(x.value->>'r') between 4 and 10) as near
    from public.keychallenge_profile_history h cross join lateral jsonb_each(h.ranks) x
    left join fields f on f.category_id=x.value->>'c'
    where h.profile_id=p.id and h.user_id=(select auth.uid()) group by h.snapshot_date order by h.snapshot_date)
  select coalesce(jsonb_agg(to_jsonb(days)),'[]') into timeline from days;
  return result || jsonb_build_object('movement',case when previous_day is null then null else changes end,'timeline',timeline,
    'complete',public.keychallenge_int(p.payload->>'total')=jsonb_array_length(p.payload->'items'));
end $$;
revoke all on function public.keychallenge_strategy(text,text) from public,anon;
grant execute on function public.keychallenge_strategy(text,text) to authenticated;

create function public.keychallenge_detailed_keywords(p_influencer_id text default '',p_filters jsonb default '{}') returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare q text:=coalesce(p_filters->>'query',''); f text:=coalesce(p_filters->>'field',''); st text:=coalesce(p_filters->>'status','all');
  sort text:=coalesce(p_filters->>'sort','rank'); page integer:=coalesce(public.keychallenge_int(p_filters->>'page'),1); answer jsonb;
begin
  if length(q)>100 or length(f)>100 or page<1 or page>4000 or st not in ('all','joined','unjoined','top3','near','unranked')
    or sort not in ('rank','volume_desc','volume_asc','participants_asc','participants_desc','contents_desc','name') then raise exception '검색 조건을 확인해 주세요.'; end if;
  with filtered as materialized (select * from public.keychallenge_dashboard_rows(p_influencer_id,f) r where
    (q='' or strpos(lower(name),lower(trim(q)))>0)
    and (st='all' or (st='joined' and joined) or (st='unjoined' and not joined) or (st='top3' and current_rank between 1 and 3)
      or (st='near' and current_rank between 4 and 10) or (st='unranked' and joined and current_rank is null))
    and (p_filters->>'pmin' is null or participant_count>=public.keychallenge_int(p_filters->>'pmin'))
    and (p_filters->>'pmax' is null or participant_count<=public.keychallenge_int(p_filters->>'pmax'))
    and (p_filters->>'rmin' is null or current_rank>=public.keychallenge_int(p_filters->>'rmin'))
    and (p_filters->>'rmax' is null or current_rank<=public.keychallenge_int(p_filters->>'rmax'))
    and (p_filters->>'cmin' is null or challenge_count>=public.keychallenge_int(p_filters->>'cmin'))
    and (p_filters->>'cmax' is null or challenge_count<=public.keychallenge_int(p_filters->>'cmax'))
    and (p_filters->>'vmin' is null or volume_min>=public.keychallenge_int(p_filters->>'vmin'))
    and (p_filters->>'vmax' is null or volume_max<=public.keychallenge_int(p_filters->>'vmax'))),
  rows as (select * from filtered order by
    case when sort='rank' then current_rank end asc nulls last,
    case when sort='volume_desc' then volume_min end desc nulls last,
    case when sort='volume_asc' then volume_min end asc nulls last,
    case when sort='participants_asc' then participant_count end asc nulls last,
    case when sort='participants_desc' then participant_count end desc nulls last,
    case when sort='contents_desc' then challenge_count end desc nulls last,name,keyword_id limit 50 offset (page-1)*50)
  select jsonb_build_object('total',(select count(*) from filtered),'items',coalesce((select jsonb_agg(to_jsonb(rows)) from rows),'[]')) into answer;
  return answer;
end $$;
revoke all on function public.keychallenge_detailed_keywords(text,jsonb) from public;
grant execute on function public.keychallenge_detailed_keywords(text,jsonb) to anon,authenticated;

create function public.keychallenge_keyword_history(p_influencer_id text,p_keyword_id text) returns jsonb
language sql stable security invoker set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('date',h.snapshot_date,'rank',h.ranks->p_keyword_id->'r') order by h.snapshot_date),'[]')
  from public.keychallenge_profile_history h join public.keychallenge_profiles p on p.id=h.profile_id
  where p.user_id=(select auth.uid()) and p.influencer_id=p_influencer_id and h.user_id=(select auth.uid());
$$;
revoke all on function public.keychallenge_keyword_history(text,text) from public,anon;
grant execute on function public.keychallenge_keyword_history(text,text) to authenticated;

create table public.keychallenge_searchad_status (
 singleton boolean primary key default true check(singleton), configured boolean not null default false,
 enabled boolean not null default false, last_success_at timestamptz, last_error text, updated_at timestamptz not null default now()
);
alter table public.keychallenge_searchad_status enable row level security;
revoke all on public.keychallenge_searchad_status from anon,authenticated;
grant select on public.keychallenge_searchad_status to authenticated;
grant all on public.keychallenge_searchad_status to service_role;
create policy "Admin search volume connection status" on public.keychallenge_searchad_status for select to authenticated
 using((select public.keychallenge_is_admin()));
insert into public.keychallenge_searchad_status(singleton) values(true);

grant usage on schema keychallenge_private to service_role;
create function keychallenge_private.searchad_credentials(p_value jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare secret_id uuid; value jsonb;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Server access required'; end if;
  select id into secret_id from vault.secrets where name='keychallenge_searchad_credentials';
  if p_value is not null then
    if secret_id is null then perform vault.create_secret(p_value::text,'keychallenge_searchad_credentials');
    else perform vault.update_secret(secret_id,p_value::text); end if;
    return jsonb_build_object('saved',true);
  end if;
  select decrypted_secret::jsonb into value from vault.decrypted_secrets where id=secret_id;
  return value;
end $$;
revoke all on function keychallenge_private.searchad_credentials(jsonb) from public,anon,authenticated;
grant execute on function keychallenge_private.searchad_credentials(jsonb) to service_role;
create function public.keychallenge_searchad_credentials(p_value jsonb default null) returns jsonb
language sql security invoker set search_path='' as $$ select keychallenge_private.searchad_credentials(p_value); $$;
revoke all on function public.keychallenge_searchad_credentials(jsonb) from public,anon,authenticated;
grant execute on function public.keychallenge_searchad_credentials(jsonb) to service_role;

alter table public.keychallenge_sync_jobs drop constraint keychallenge_sync_jobs_kind_check;
alter table public.keychallenge_sync_jobs add constraint keychallenge_sync_jobs_kind_check check(kind in ('profile','catalog','volume'));
create function keychallenge_private.enqueue_volume() returns void language plpgsql security invoker set search_path='' as $$
begin
  if not exists(select 1 from public.keychallenge_searchad_status where enabled and configured) then return; end if;
  insert into public.keychallenge_sync_jobs(resource_key,kind) values('volume','volume')
  on conflict(resource_key) do update set status='queued',state='{}',attempts=0,last_error=null,
    started_at=now(),updated_at=now(),completed_at=null,next_attempt_at=now(),lease_token=null,lease_until=null
    where keychallenge_sync_jobs.status in ('succeeded','failed','cancelled');
end $$;
revoke all on function keychallenge_private.enqueue_volume() from public,anon,authenticated;
grant execute on function keychallenge_private.enqueue_volume() to service_role;
create function public.keychallenge_enqueue_volume() returns void language sql security invoker set search_path='' as $$
 select keychallenge_private.enqueue_volume(); $$;
revoke all on function public.keychallenge_enqueue_volume() from public,anon,authenticated;
grant execute on function public.keychallenge_enqueue_volume() to service_role;
select cron.schedule('keychallenge-daily-search-volume','15 19 * * *','select keychallenge_private.enqueue_volume();');

create function public.keychallenge_volume_candidates(p_limit integer default 5) returns jsonb
language sql stable security invoker set search_path='' as $$
 with preferred as (select distinct x->>'categoryId' as id from public.keychallenge_profiles p
   cross join lateral jsonb_array_elements(p.payload->'items') x),
 names as (select public.keychallenge_keyword_key(k.name) as key,min(k.name) as name,
   max(k.participant_count) as participants,bool_or(k.category_id in (select id from preferred)) as preferred
   from public.keychallenge_catalog_items k where k.catalog_id=(select catalog_id from public.keychallenge_catalog_publication)
   group by public.keychallenge_keyword_key(k.name)),
 candidates as (select n.key,n.name from names n left join public.keychallenge_search_volumes v on v.keyword_key=n.key
   where v.collected_at is null or v.collected_at<now()-interval '30 days'
   order by (v.collected_at is null) desc,n.preferred desc,v.collected_at asc nulls first,n.participants desc nulls last,n.key
   limit least(greatest(p_limit,1),5))
 select coalesce(jsonb_agg(to_jsonb(candidates)),'[]') from candidates;
$$;
revoke all on function public.keychallenge_volume_candidates(integer) from public,anon,authenticated;
grant execute on function public.keychallenge_volume_candidates(integer) to service_role;
