CREATE OR REPLACE FUNCTION public.keychallenge_blogger_attack_for_field(p_field text DEFAULT '__mine__'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  member public.keychallenge_members;
  chosen text;
  catalog_time timestamptz;
  result jsonb;
begin
  if (select auth.uid()) is null then raise exception '로그인 후 이용해 주세요.'; end if;
  select * into member from public.keychallenge_members where user_id=(select auth.uid());
  if not found then raise exception '내 설정에서 블로그를 연결해 주세요.'; end if;
  if p_field is not null and p_field<>'__mine__' then member.interest:=p_field; end if;
  chosen:=case member.interest when '문화/예술' then '공연/전시/예술' when '기타' then '' else coalesce(member.interest,'') end;
  select c.collected_at into catalog_time from public.keychallenge_catalogs c
    where c.id=(select catalog_id from public.keychallenge_catalog_publication);

  with posts as materialized (
    select p.post_id,p.title,public.keychallenge_keyword_key(p.title) as title_key,p.published_at
    from public.keychallenge_blog_posts p
    where p.user_id=(select auth.uid()) and p.blog_id=member.blog_id and length(p.title)>0
    order by p.published_at desc nulls last,p.first_seen_at desc,p.post_id desc limit 50
  ), post_context as materialized (
    select count(*) as post_count from posts
  ), topic_tokens as materialized (
    select upper(token) as token,count(distinct p.post_id)::integer as post_count
    from posts p cross join lateral regexp_split_to_table(p.title,'[^가-힣a-zA-Z0-9]+') as words(token)
    where char_length(token) between 2 and 12 and token !~ '^[0-9]+$'
      and lower(token) not in ('추천','후기','리뷰','정보','정리','소개','블로그','포스팅','오늘','이번','정말',
        '좋은','있는','하는','맛있는','다녀온','다녀왔어요','내돈내산','체험단','솔직후기','가볼만한곳',
        '여행','맛집','사진','이야기','방법','사용','일상','방문','네이버','가격','할인','예약')
    group by upper(token)
  ), measured as materialized (
    select k.keyword_id,k.name,k.field,k.participant_count,
      public.keychallenge_keyword_key(k.name) as keyword_key,
      v.volume_min,v.volume_max,v.collected_at as volume_collected_at,
      row_number() over(partition by k.field order by v.volume_min desc,v.volume_max desc,k.keyword_id) as field_position
    from public.keychallenge_catalog_items k
    join public.keychallenge_search_volumes v
      on v.keyword_key=public.keychallenge_keyword_key(k.name) and v.available
    where (p_field='' or (chosen<>'' and k.field=chosen))
      and k.catalog_id=(select catalog_id from public.keychallenge_catalog_publication)
      and v.volume_min>=10 and k.participant_count is not null
      and v.collected_at between now()-interval '30 days' and now()+interval '5 minutes'
      and catalog_time between now()-interval '30 days' and now()+interval '5 minutes'
  ), catalog as materialized (
    -- Bound broad comparisons while keeping a pool from every field.
    select * from measured where coalesce(p_field,'__mine__')<>'' or field_position<=300
  ), candidates as materialized (
    select c.* from catalog c
    where not exists(select 1 from posts p where position(c.keyword_key in p.title_key)>0)
  ), saved_keywords as materialized (
    select b.keyword_key from public.keychallenge_blog_keywords b
    where b.user_id=(select auth.uid()) and not b.archived
  ), personalized as materialized (
    select c.*,pc.post_count,
      coalesce(t.related_terms,array[]::text[]) as related_terms,
      coalesce(t.related_post_count,0) as related_post_count,
      c.volume_min::numeric/(c.participant_count::numeric+1) as demand_ratio,
      (s.keyword_key is not null) as saved
    from candidates c cross join post_context pc
    left join lateral (
      select array_agg(x.token order by x.post_count desc,x.token) as related_terms,
        max(x.post_count) as related_post_count
      from (select token,post_count from topic_tokens
        where position(token in c.keyword_key)>0
        order by post_count desc,token limit 3) x
    ) t on true
    left join saved_keywords s on s.keyword_key=c.keyword_key
  ), scaled as (
    select p.*,
      case when count(*) over()<=1 then 50
        else 50+50*percent_rank() over(order by cardinality(related_terms)) end as fit_score,
      case when count(*) over()<=1 then 60
        else 100*percent_rank() over(order by volume_min) end as interest_score,
      case when count(*) over()<=1 then 60
        else 50*(percent_rank() over(order by demand_ratio)+percent_rank() over(order by participant_count desc)) end as competition_score,
      case when post_count=0 then 50
        else 100*(1-related_post_count::numeric/post_count) end as coverage_gap_score
    from personalized p
  ), ranked as (
    select s.*,
      round(fit_score*0.30+interest_score*0.25+competition_score*0.25+coverage_gap_score*0.20)::integer as score,
      row_number() over(order by
        round(fit_score*0.30+interest_score*0.25+competition_score*0.25+coverage_gap_score*0.20) desc,
        fit_score desc,interest_score desc,competition_score desc,keyword_id) as position
    from scaled s
  ), items as (
    select r.position,jsonb_build_object(
      'keyword_id',r.keyword_id,'keyword',r.name,'field',r.field,'volume_min',r.volume_min,'volume_max',r.volume_max,
      'volume_collected_at',r.volume_collected_at,'participant_count',r.participant_count,'score',r.score,
      'fit_score',round(r.fit_score)::integer,'interest_score',round(r.interest_score)::integer,
      'competition_score',round(r.competition_score)::integer,'coverage_gap_score',round(r.coverage_gap_score)::integer,
      'related_terms',r.related_terms,'saved',r.saved,
      'reasons',jsonb_build_array(
        case when cardinality(r.related_terms)>0 then '최근 글의 ‘'||r.related_terms[1]||'’ 표현과 연결'
          else '선택 분야 ‘'||r.field||'’의 키챌' end,
        '현재 월 검색량 '||to_char(r.volume_min,'FM999,999,999,990')||'회',
        '키챌 참여자 '||to_char(r.participant_count,'FM999,999,999,990')||'명 · 수요 대비 경쟁 여지',
        case when r.post_count=0 then '글 수집 전 · 작성 여부 비교 전'
          when r.related_post_count=0 then '최근 글 제목에 없고 연결된 주제 글도 없음'
          else '최근 글 제목에 없고 연관 표현 ‘'||r.related_terms[1]||'’이 나온 글 '||r.related_post_count||'편' end
      )
    ) as item
    from ranked r where r.position<=10
  )
  select jsonb_build_object(
    'field',nullif(chosen,''),'post_count',(select post_count from post_context),
    'catalog_collected_at',catalog_time,'candidate_count',(select count(*) from candidates),
    'items',coalesce((select jsonb_agg(item order by position) from items),'[]'::jsonb)
  ) into result;
  return result;
end $function$
;

