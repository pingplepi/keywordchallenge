-- Parse each saved snapshot once, then join small rank relations to the catalogue.
-- Keep SECURITY INVOKER, ownership predicates and the existing RPC contract.
create or replace function public.keychallenge_dashboard_rows(p_influencer_id text default '',p_field text default '')
returns table(keyword_id text,name text,field text,category_id text,participant_count integer,volume_min integer,volume_max integer,
 volume_collected_at timestamptz,joined boolean,current_rank integer,challenge_count integer,previous_rank integer,previous_joined boolean)
language plpgsql stable security invoker set search_path='' as $$
declare payload jsonb; previous jsonb; v_profile_id uuid; current_day date;
begin
  if auth.uid() is not null and p_influencer_id<>'' then
    select p.id,p.payload into v_profile_id,payload
    from public.keychallenge_profiles p
    where p.user_id=(select auth.uid()) and p.influencer_id=p_influencer_id;
    if payload is not null then
      current_day:=((payload->>'collectedAt')::timestamptz at time zone 'Asia/Seoul')::date;
      select h.ranks into previous from public.keychallenge_profile_history h
      where h.profile_id=v_profile_id and h.user_id=(select auth.uid()) and h.snapshot_date<current_day
      order by h.snapshot_date desc limit 1;
    end if;
  end if;
  return query
  with own_items as materialized (
    select distinct on (x.item->>'id') x.item->>'id' as keyword_id,
      nullif(public.keychallenge_int(x.item->>'rank'),0) as current_rank,
      coalesce(public.keychallenge_int(x.item->>'challengeCount'),0) as challenge_count
    from jsonb_array_elements(coalesce(payload->'items','[]'::jsonb)) with ordinality x(item,position)
    where x.item->>'id' is not null
    order by x.item->>'id',x.position desc
  ), previous_items as materialized (
    select x.key as keyword_id,nullif(public.keychallenge_int(x.value->>'r'),0) as previous_rank
    from jsonb_each(coalesce(previous,'{}'::jsonb)) x
  ), catalog as materialized (
    select k.keyword_id,k.name,k.field,k.category_id,k.participant_count,
      public.keychallenge_keyword_key(k.name) as keyword_key
    from public.keychallenge_catalog_items k
    where k.catalog_id=(select catalog_id from public.keychallenge_catalog_publication)
      and (p_field='' or k.field=p_field)
  )
  select k.keyword_id,k.name,k.field,k.category_id,k.participant_count,
    v.volume_min,v.volume_max,v.collected_at,
    case when payload is null then null else o.keyword_id is not null end,
    o.current_rank,coalesce(o.challenge_count,0),b.previous_rank,b.keyword_id is not null
  from catalog k
  left join public.keychallenge_search_volumes v on v.keyword_key=k.keyword_key and v.available
  left join own_items o on o.keyword_id=k.keyword_id
  left join previous_items b on b.keyword_id=k.keyword_id;
end $$;

create or replace function public.keychallenge_strategy(p_influencer_id text,p_field text default '__mine__') returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare p public.keychallenge_profiles; field_name text:=p_field; current_day date; previous_day date; category text;
  previous jsonb; current_ranks jsonb; result jsonb; changes jsonb;
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
  with fields as materialized (select category_id,min(field) as field from public.keychallenge_catalog_items where catalog_id=(select catalog_id from public.keychallenge_catalog_publication) group by category_id),
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
  -- The timeline chart was replaced by keyword opportunities; no active client consumes it.
  -- Keep the response key for older clients without recomputing every historical snapshot.
  return result || jsonb_build_object('movement',case when previous_day is null then null else changes end,'timeline','[]'::jsonb,
    'complete',public.keychallenge_int(p.payload->>'total')=jsonb_array_length(p.payload->'items'));
end $$;
