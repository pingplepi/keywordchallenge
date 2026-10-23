-- Read-only recommendations from the published catalog, cached volumes and own profile.
-- No external API calls. Existing RLS and the existing save RPC remain authoritative.
create or replace function public.keychallenge_keyword_opportunities(
  p_influencer_id text, p_field text default '__mine__'
) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare
  profile public.keychallenge_profiles;
  catalog_time timestamptz;
  mine text := '';
  chosen text;
  complete boolean;
  result jsonb;
begin
  if (select auth.uid()) is null then raise exception '로그인 후 이용해 주세요.'; end if;
  if p_influencer_id is null or length(p_influencer_id)>100 or p_field is null or length(p_field)>100
    then raise exception '추천 조건을 확인해 주세요.'; end if;
  select * into profile from public.keychallenge_profiles
    where user_id=(select auth.uid()) and influencer_id=p_influencer_id;
  if profile.id is null then raise exception '인플홈을 먼저 연결해 주세요.'; end if;
  complete := coalesce(public.keychallenge_int(profile.payload->>'total') =
    jsonb_array_length(profile.payload->'items'),false);

  -- Infer the influencer's field from their own participation, as the dashboard does.
  select k.field into mine
  from (
    select x->>'categoryId' as category_id,count(*) as amount
    from jsonb_array_elements(profile.payload->'items') x
    group by x->>'categoryId'
  ) own_categories
  join (
    select category_id,min(field) as field from public.keychallenge_catalog_items
    where catalog_id=(select catalog_id from public.keychallenge_catalog_publication)
    group by category_id
  ) k using(category_id)
  order by amount desc,k.field limit 1;
  if mine is null then
    select case interest when '문화/예술' then '공연/전시/예술' when '기타' then '' else interest end
      into mine from public.keychallenge_members where user_id=(select auth.uid());
  end if;
  mine := coalesce(mine,'');
  chosen := case when p_field='__mine__' then mine else p_field end;
  select c.collected_at into catalog_time from public.keychallenge_catalogs c
    where c.id=(select catalog_id from public.keychallenge_catalog_publication);

  with market as materialized (
    select r.*,public.keychallenge_keyword_key(r.name) as keyword_key
    from public.keychallenge_dashboard_rows(p_influencer_id,chosen) r
    where length(r.name) between 1 and 100
  ), measured as materialized (
    select m.*,
      m.volume_min::numeric/(m.participant_count::numeric+1) as demand_ratio
    from market m
    where m.volume_min>=10 and m.participant_count is not null
      and m.volume_collected_at between now()-interval '30 days' and now()+interval '5 minutes'
      and catalog_time between now()-interval '30 days' and now()+interval '5 minutes'
  ), benchmarks as (
    select field,count(*) as sample_size,
      percentile_cont(0.5) within group(order by volume_min) as volume_median,
      percentile_cont(0.75) within group(order by volume_min) as volume_upper,
      percentile_cont(0.5) within group(order by participant_count) as participants_median,
      percentile_cont(0.75) within group(order by participant_count) as participants_upper,
      percentile_cont(0.75) within group(order by demand_ratio) as ratio_upper
    from measured group by field
  ), scored as materialized (
    select m.*,b.sample_size,b.volume_median,b.volume_upper,
      b.participants_median,b.participants_upper,b.ratio_upper,
      substring(m.name from '(아이랑|아이와|아기랑|아기와|부모님|가족여행|커플|초보자|초보|신혼|임산부|직장인|어린이|반려견동반|애견동반|강아지동반|당일치기|1박2일|2박3일|실내|야간|새벽|주말|비오는날|비오는|뚜벅이|대중교통|가성비|무료|저렴한|예약방법|예약하는법|사용방법|사용법|만드는법|만들기|레시피|준비물|비교|추천코스|여행코스|운동루틴|세탁방법|세탁법|보관방법|보관법|손질법|에어프라이어|전자레인지|노오븐|저탄수|저칼로리|무설탕|글루텐프리|민감성|건성피부|지성피부|여드름피부|10대|20대|30대|40대|50대|60대)') as intent_hint
    from measured m join benchmarks b using(field) where b.sample_size>=10
  ), classified as (
    select s.*,t.kind,
      case t.kind when 'blue' then s.demand_ratio
        when 'red' then s.volume_min::numeric
        else s.demand_ratio end as opportunity_score
    from scored s cross join (values('blue'),('longtail'),('red')) t(kind)
    where (t.kind='blue' and s.volume_min>=s.volume_median
      and s.participant_count<=s.participants_median and s.demand_ratio>=s.ratio_upper)
    or (t.kind='red' and s.volume_min>=s.volume_upper and s.participant_count>=s.participants_upper
      and s.participant_count>s.participants_median)
    or (t.kind='longtail' and s.volume_max<=s.volume_median and s.intent_hint is not null
      and char_length(replace(s.keyword_key,public.keychallenge_keyword_key(s.intent_hint),''))>=2)
  ), unique_candidates as (
    -- A keyword can have multiple catalog IDs. Recommend one per normalized name and tab.
    select distinct on(kind,keyword_key) c.*,
      case when c.joined then true when complete then false else null end as participation
    from classified c
    order by kind,keyword_key,(field=mine) desc,joined desc,opportunity_score desc,keyword_id
  ), ranked as (
    select c.*,row_number() over(partition by kind order by
      (field=mine) desc,
      case when participation=false then 0 when participation is null then 1 else 2 end,
      opportunity_score desc,volume_min desc,participant_count,name,keyword_id) as position,
      count(*) over(partition by kind) as candidate_count
    from unique_candidates c
  ), cards as (
    select r.kind,r.position,r.candidate_count,
      jsonb_build_object(
        'keyword_id',r.keyword_id,'keyword_key',r.keyword_key,'name',r.name,'field',r.field,
        'participant_count',r.participant_count,'volume_min',r.volume_min,'volume_max',r.volume_max,
        'volume_collected_at',r.volume_collected_at,'joined',r.participation,'current_rank',r.current_rank,
        'is_mine',r.field=mine,'intent_hint',r.intent_hint,
        'saved',exists(select 1 from public.keychallenge_blog_keywords k
          where k.user_id=(select auth.uid()) and k.keyword_key=r.keyword_key and not k.archived),
        'reasons',case r.kind
          when 'blue' then jsonb_build_array('분야 중간값 이상의 검색량','참여자 수는 분야 중간값 이하','참여자 대비 검색 수요가 분야 상위 25%')
          when 'red' then jsonb_build_array('검색량이 분야 상위 25%','참여자 수도 분야 상위 25% · 경쟁을 고려한 장기 공략')
          else jsonb_build_array('검색량이 분야 중간값 이하','‘'||r.intent_hint||'’ 표현으로 대상·목적·조건이 구체적')
        end
      ) as item
    from ranked r where position<=10
  )
  select jsonb_build_object(
    'field',chosen,'my_field',mine,'complete',complete,'catalog_collected_at',catalog_time,
    'total',(select count(*) from market),'measured',(select count(*) from measured),
    'blue',coalesce((select jsonb_agg(item order by position) from cards where kind='blue'),'[]'::jsonb),
    'longtail',coalesce((select jsonb_agg(item order by position) from cards where kind='longtail'),'[]'::jsonb),
    'red',coalesce((select jsonb_agg(item order by position) from cards where kind='red'),'[]'::jsonb),
    'counts',jsonb_build_object(
      'blue',coalesce((select max(candidate_count) from cards where kind='blue'),0),
      'longtail',coalesce((select max(candidate_count) from cards where kind='longtail'),0),
      'red',coalesce((select max(candidate_count) from cards where kind='red'),0))
  ) into result;
  return result;
end $$;
revoke all on function public.keychallenge_keyword_opportunities(text,text) from public,anon;
grant execute on function public.keychallenge_keyword_opportunities(text,text) to authenticated;

