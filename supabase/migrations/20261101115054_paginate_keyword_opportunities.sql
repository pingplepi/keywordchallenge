-- Browse every opportunity candidate in bounded pages; existing RPCs remain compatible.
-- Classification uses the full market. Saved filtering happens after classification,
-- before the existing deterministic, travel-balanced ordering.

CREATE OR REPLACE FUNCTION public.keychallenge_blogger_keyword_opportunities_page(p_kind text DEFAULT 'blue', p_page integer DEFAULT 1, p_hide_saved boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
declare
  member public.keychallenge_members;
  chosen text;
  catalog_time timestamptz;
  result jsonb;
begin
  if p_kind is null or p_kind not in ('blue','longtail','red') or p_page is null or p_page<1 or p_page>100000 or p_hide_saved is null then
    raise exception '추천 페이지 조건을 확인해 주세요.';
  end if;
  if (select auth.uid()) is null then raise exception '로그인 후 이용해 주세요.'; end if;
  select * into member from public.keychallenge_members where user_id=(select auth.uid());
  if not found then raise exception '내 설정에서 블로그를 연결해 주세요.'; end if;
  chosen:=case member.interest when '문화/예술' then '공연/전시/예술' when '기타' then '' else coalesce(member.interest,'') end;
  select c.collected_at into catalog_time from public.keychallenge_catalogs c
    where c.id=(select catalog_id from public.keychallenge_catalog_publication);

  with saved_keywords as materialized (
    select keyword_key from public.keychallenge_blog_keywords
    where user_id=(select auth.uid()) and not archived
  ), posts as materialized (
    select p.title,public.keychallenge_keyword_key(p.title) as title_key,p.published_at
    from public.keychallenge_blog_posts p
    where p.user_id=(select auth.uid()) and p.blog_id=member.blog_id and length(p.title)>0
    order by p.published_at desc nulls last,p.first_seen_at desc,p.post_id desc limit 50
  ), post_context as materialized (
    -- A newline keeps keywords from matching across two separate titles.
    select count(*) as post_count,coalesce(string_agg(title_key,chr(10)),'') as titles,
      min(published_at) as oldest_post_at,max(published_at) as newest_post_at
    from posts
  ), topic_tokens as materialized (
    -- Transparent lexical overlap, bounded before comparing with catalog candidates.
    select token,count(*) as frequency
    from posts p cross join lateral (
      select distinct lower(t) as token
      from regexp_split_to_table(p.title,'[^가-힣a-zA-Z0-9]+') t
    ) words
    where char_length(token) between 2 and 12 and token !~ '^[0-9]+$'
      and token not in ('추천','후기','리뷰','정보','정리','소개','블로그','포스팅','오늘','이번','정말',
        '좋은','있는','하는','있는곳','맛있는','다녀온','다녀왔어요','내돈내산','체험단','솔직후기',
        '가볼만한곳','여행','맛집','사진','이야기','방법','사용','일상','방문','네이버')
    group by token order by count(*) desc,char_length(token) desc,token limit 32
  ), catalog as materialized (
    select k.keyword_id,k.name,k.field,k.participant_count,
      k.travel_scope,
      public.keychallenge_keyword_key(k.name) as keyword_key
    from public.keychallenge_catalog_items k
    where chosen<>'' and k.field=chosen
      and k.catalog_id=(select catalog_id from public.keychallenge_catalog_publication)
      and length(k.name) between 1 and 100
  ), market as materialized (
    select k.*,v.volume_min,v.volume_max,v.collected_at as volume_collected_at
    from catalog k
    left join public.keychallenge_search_volumes v on v.keyword_key=k.keyword_key and v.available
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
  ), unique_candidates as materialized (
    select distinct on(kind,keyword_key) c.*
    from classified c order by kind,keyword_key,opportunity_score desc,keyword_id
  ), eligible as materialized (
    select c.*,(s.keyword_key is not null) as saved
    from unique_candidates c left join saved_keywords s using(keyword_key)
    where not p_hide_saved or s.keyword_key is null
  ), personalized as materialized (
    select c.*,pc.post_count,
      case when pc.post_count=0 then null else position(c.keyword_key in pc.titles)>0 end as title_matched,
      coalesce(h.hints,array[]::text[]) as related_terms
    from eligible c cross join post_context pc
    left join lateral (
      select array_agg(token order by frequency desc,char_length(token) desc,token) as hints
      from (select token,frequency from topic_tokens where position(token in c.keyword_key)>0
        order by frequency desc,char_length(token) desc,token limit 3) t
    ) h on true where c.kind=p_kind
  ), balanced as (
    select c.*,row_number() over(partition by kind,coalesce(travel_scope,field) order by
      case when title_matched=false then 0 when title_matched is null then 1 else 2 end, cardinality(related_terms) desc, opportunity_score desc,volume_min desc,keyword_id) as scope_position
    from personalized c
  ), ranked as materialized (
    select c.*,row_number() over(partition by kind order by
      case when title_matched=false then 0 when title_matched is null then 1 else 2 end,
      case when field='여행' then scope_position else 1 end,
      cardinality(related_terms) desc,opportunity_score desc,volume_min desc,
      participant_count,name,keyword_id) as position,
      count(*) over(partition by kind) as candidate_count
    from balanced c
  ), page_info as (
    select least(p_page,greatest(1,ceil(count(*)/10.0)::integer)) as page,
      greatest(1,ceil(count(*)/10.0)::integer) as total_pages
    from ranked
  ), cards as (
    select r.kind,r.position,r.candidate_count,
      jsonb_build_object(
        'keyword_id',r.keyword_id,'keyword_key',r.keyword_key,'name',r.name,'field',r.field,
        'travel_scope',r.travel_scope,'participant_count',r.participant_count,'volume_min',r.volume_min,'volume_max',r.volume_max,
        'volume_collected_at',r.volume_collected_at,'title_matched',r.title_matched,
        'is_mine',true,'related_terms',r.related_terms,
        'saved',r.saved,
        'reasons',jsonb_build_array('관심 분야 ‘'||chosen||'’의 키워드',
          case when r.title_matched=false then '최근 수집한 '||r.post_count||'편의 제목에 없는 키워드'
            when r.title_matched=true then '최근 글 제목에 포함 · 기존 글의 후속 주제로 검토'
            else '수집된 글이 없어 작성 여부 비교 전' end)
        || case when cardinality(r.related_terms)>0
          then jsonb_build_array('최근 글과 연결되는 표현: '||array_to_string(r.related_terms,', '))
          else '[]'::jsonb end
        || case r.kind
          when 'blue' then jsonb_build_array('분야 중간값 이상의 검색량 · 중간값 이하의 키챌 참여자','참여자 대비 검색 수요가 분야 상위 25%')
          when 'red' then jsonb_build_array('검색량과 키챌 참여자가 분야 상위 25% · 장기 공략 후보')
          else jsonb_build_array('검색량이 분야 중간값 이하','‘'||r.intent_hint||'’ 표현으로 대상·목적·조건이 구체적')
        end
      ) as item
    from ranked r cross join page_info pg where position>(pg.page-1)*10 and position<=pg.page*10
  )
  select jsonb_build_object(
    'kind',p_kind,'hide_saved',p_hide_saved,'page_size',10,
    'page',(select page from page_info),'total_pages',(select total_pages from page_info),
    'total_counts',jsonb_build_object(
      'blue',(select count(*) from unique_candidates where kind='blue'),
      'longtail',(select count(*) from unique_candidates where kind='longtail'),
      'red',(select count(*) from unique_candidates where kind='red')),
    'field',chosen,'my_field',chosen,'catalog_collected_at',catalog_time,
    'post_count',pc.post_count,'oldest_post_at',pc.oldest_post_at,'newest_post_at',pc.newest_post_at,
    'total',(select count(*) from market),'measured',(select count(*) from measured),
    'blue',coalesce((select jsonb_agg(item order by position) from cards where kind='blue'),'[]'::jsonb),
    'longtail',coalesce((select jsonb_agg(item order by position) from cards where kind='longtail'),'[]'::jsonb),
    'red',coalesce((select jsonb_agg(item order by position) from cards where kind='red'),'[]'::jsonb),
    'counts',jsonb_build_object(
      'blue',(select count(*) from eligible where kind='blue'),
      'longtail',(select count(*) from eligible where kind='longtail'),
      'red',(select count(*) from eligible where kind='red'))
  ) into result from post_context pc;
  return result;
end $function$;
REVOKE ALL ON FUNCTION public.keychallenge_blogger_keyword_opportunities_page(text,integer,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.keychallenge_blogger_keyword_opportunities_page(text,integer,boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.keychallenge_keyword_opportunities_page(p_influencer_id text, p_field text DEFAULT '__mine__', p_kind text DEFAULT 'blue', p_page integer DEFAULT 1, p_hide_saved boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
declare
  profile public.keychallenge_profiles;
  catalog_time timestamptz;
  mine text := '';
  chosen text;
  complete boolean;
  result jsonb;
begin
  if p_kind is null or p_kind not in ('blue','longtail','red') or p_page is null or p_page<1 or p_page>100000 or p_hide_saved is null then
    raise exception '추천 페이지 조건을 확인해 주세요.';
  end if;
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

  -- Join compact participation rows instead of looking up every catalog entry in a large JSON map.
  -- This avoids repeated JSON traversal and skips unused historical-rank calculations.
  with saved_keywords as materialized (
    select keyword_key from public.keychallenge_blog_keywords
    where user_id=(select auth.uid()) and not archived
  ), own_items as materialized (
    select distinct on (x->>'id') x->>'id' as keyword_id,
      nullif(public.keychallenge_int(x->>'rank'),0) as current_rank
    from jsonb_array_elements(profile.payload->'items') x
    where x->>'id' is not null
    order by x->>'id'
  ), catalog as materialized (
    select k.keyword_id,k.name,k.field,k.participant_count,
      k.travel_scope,
      public.keychallenge_keyword_key(k.name) as keyword_key
    from public.keychallenge_catalog_items k
    where k.catalog_id=(select catalog_id from public.keychallenge_catalog_publication)
      and (chosen='' or k.field=chosen) and length(k.name) between 1 and 100
  ), market as materialized (
    select k.*,v.volume_min,v.volume_max,v.collected_at as volume_collected_at,
      (o.keyword_id is not null) as joined,o.current_rank
    from catalog k
    left join public.keychallenge_search_volumes v on v.keyword_key=k.keyword_key and v.available
    left join own_items o on o.keyword_id=k.keyword_id
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
  ), eligible as materialized (
    select c.*,(s.keyword_key is not null) as saved
    from unique_candidates c left join saved_keywords s using(keyword_key)
    where not p_hide_saved or s.keyword_key is null
  ), balanced as (
    select c.*,row_number() over(partition by kind,coalesce(travel_scope,field) order by
      (field=mine) desc, case when participation=false then 0 when participation is null then 1 else 2 end, opportunity_score desc,volume_min desc,keyword_id) as scope_position
    from eligible c where c.kind=p_kind
  ), ranked as materialized (
    select c.*,row_number() over(partition by kind order by
      (field=mine) desc,
      case when participation=false then 0 when participation is null then 1 else 2 end,
      case when field='여행' then scope_position else 1 end,
      opportunity_score desc,volume_min desc,participant_count,name,keyword_id) as position,
      count(*) over(partition by kind) as candidate_count
    from balanced c
  ), page_info as (
    select least(p_page,greatest(1,ceil(count(*)/10.0)::integer)) as page,
      greatest(1,ceil(count(*)/10.0)::integer) as total_pages
    from ranked
  ), cards as (
    select r.kind,r.position,r.candidate_count,
      jsonb_build_object(
        'keyword_id',r.keyword_id,'keyword_key',r.keyword_key,'name',r.name,'field',r.field,
        'travel_scope',r.travel_scope,'participant_count',r.participant_count,'volume_min',r.volume_min,'volume_max',r.volume_max,
        'volume_collected_at',r.volume_collected_at,'joined',r.participation,'current_rank',r.current_rank,
        'is_mine',r.field=mine,'intent_hint',r.intent_hint,
        'saved',r.saved,
        'reasons',case r.kind
          when 'blue' then jsonb_build_array('분야 중간값 이상의 검색량','참여자 수는 분야 중간값 이하','참여자 대비 검색 수요가 분야 상위 25%')
          when 'red' then jsonb_build_array('검색량이 분야 상위 25%','참여자 수도 분야 상위 25% · 경쟁을 고려한 장기 공략')
          else jsonb_build_array('검색량이 분야 중간값 이하','‘'||r.intent_hint||'’ 표현으로 대상·목적·조건이 구체적')
        end
      ) as item
    from ranked r cross join page_info pg where position>(pg.page-1)*10 and position<=pg.page*10
  )
  select jsonb_build_object(
    'kind',p_kind,'hide_saved',p_hide_saved,'page_size',10,
    'page',(select page from page_info),'total_pages',(select total_pages from page_info),
    'total_counts',jsonb_build_object(
      'blue',(select count(*) from unique_candidates where kind='blue'),
      'longtail',(select count(*) from unique_candidates where kind='longtail'),
      'red',(select count(*) from unique_candidates where kind='red')),
    'field',chosen,'my_field',mine,'complete',complete,'catalog_collected_at',catalog_time,
    'total',(select count(*) from market),'measured',(select count(*) from measured),
    'blue',coalesce((select jsonb_agg(item order by position) from cards where kind='blue'),'[]'::jsonb),
    'longtail',coalesce((select jsonb_agg(item order by position) from cards where kind='longtail'),'[]'::jsonb),
    'red',coalesce((select jsonb_agg(item order by position) from cards where kind='red'),'[]'::jsonb),
    'counts',jsonb_build_object(
      'blue',(select count(*) from eligible where kind='blue'),
      'longtail',(select count(*) from eligible where kind='longtail'),
      'red',(select count(*) from eligible where kind='red'))
  ) into result;
  return result;
end $function$;
REVOKE ALL ON FUNCTION public.keychallenge_keyword_opportunities_page(text,text,text,integer,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.keychallenge_keyword_opportunities_page(text,text,text,integer,boolean) TO authenticated;
