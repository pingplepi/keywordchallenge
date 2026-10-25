CREATE OR REPLACE FUNCTION public.keychallenge_personalized_keywords(p_influencer_id text DEFAULT NULL, p_field text DEFAULT '__mine__')
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path='' AS $function$
declare member public.keychallenge_members; profile public.keychallenge_profiles; chosen text; result jsonb;
begin
  if (select auth.uid()) is null then raise exception '로그인 후 이용해 주세요.'; end if;
  if length(coalesce(p_influencer_id,''))>100 or p_field is null or length(p_field)>100 then raise exception '추천 조건을 확인해 주세요.'; end if;
  select * into member from public.keychallenge_members where user_id=(select auth.uid());
  if p_influencer_id is not null then
    select * into profile from public.keychallenge_profiles where user_id=(select auth.uid()) and influencer_id=p_influencer_id;
    if profile.id is null then raise exception '연결된 인플홈을 확인해 주세요.'; end if;
  end if;
  chosen:=case when p_field='__mine__' then case member.interest when '문화/예술' then '공연/전시/예술' when '기타' then '' else coalesce(member.interest,'') end else p_field end;
  if chosen='' and p_field='__mine__' and profile.id is not null then
    select k.field into chosen from public.keychallenge_catalog_items k
    join (select x->>'categoryId' category_id,count(*) amount from jsonb_array_elements(profile.payload->'items') x group by 1) c using(category_id)
    where k.catalog_id=(select catalog_id from public.keychallenge_catalog_publication)
    group by k.field,c.amount order by c.amount desc,k.field limit 1;
  end if;
  with posts as materialized (
    select p.title,public.keychallenge_keyword_key(p.title) title_key,p.last_result='found' and p.last_result_at>=now()-interval '30 days' as found_recently
    from public.keychallenge_blog_posts p where p.user_id=(select auth.uid()) and p.blog_id=member.blog_id
    order by p.published_at desc nulls last,p.first_seen_at desc,p.post_id desc limit 50
  ), own_items as materialized (
    select x->>'id' keyword_id,x->>'name' name,public.keychallenge_keyword_key(x->>'name') keyword_key,
      nullif(public.keychallenge_int(x->>'rank'),0) current_rank,x->'contents' contents
    from jsonb_array_elements(coalesce(profile.payload->'items','[]')) x
  ), snapshots as materialized (
    select h.snapshot_date,h.ranks from public.keychallenge_profile_history h
    where h.user_id=(select auth.uid()) and h.profile_id=profile.id and h.collected_at>=now()-interval '30 days'
    order by h.snapshot_date desc limit 7
  ), historical as materialized (
    select r.key keyword_id,min(nullif(public.keychallenge_int(r.value->>'r'),0)) best_rank
    from snapshots s cross join lateral jsonb_each(s.ranks) r group by r.key
  ), strengths as materialized (
    select o.*,least(case when profile.updated_at>=now()-interval '30 days' then current_rank end,h.best_rank) best_rank
    from own_items o left join historical h using(keyword_id)
    where least(case when profile.updated_at>=now()-interval '30 days' then current_rank end,h.best_rank) between 1 and 10
    order by least(case when profile.updated_at>=now()-interval '30 days' then current_rank end,h.best_rank),o.keyword_id limit 30
  ), source_titles as materialized (
    select p.title,case when p.found_recently then 'exposure' else 'post' end kind from posts p
    union all select c->>'title','rank' from strengths s cross join lateral jsonb_array_elements(coalesce(s.contents,'[]')) c where length(c->>'title')>0
    union all select name,'rank' from strengths
  ), tokens as materialized (
    select upper(token) token,count(*) frequency,bool_or(kind='rank') rank_backed,bool_or(kind='exposure') exposure_backed
    from (select distinct title,kind,token from source_titles cross join lateral regexp_split_to_table(title,'[^가-힣a-zA-Z0-9]+') token) w
    where char_length(token) between 2 and 12 and token !~ '^[0-9]+$'
      and lower(token) not in ('추천','후기','리뷰','정보','정리','소개','블로그','포스팅','오늘','이번','정말','좋은','있는','하는','있는곳','맛있는','다녀온','다녀왔어요','내돈내산','체험단','솔직후기','가볼만한곳','여행','맛집','사진','이야기','방법','사용','일상','방문','네이버','가격','할인','코스','예약','호텔','숙소','공항','픽업','샌딩')
    group by upper(token) order by bool_or(kind='rank') desc,bool_or(kind='exposure') desc,count(*) desc,char_length(upper(token)) desc,upper(token) limit 40
  ), catalog_rows as materialized (
    select k.keyword_id,k.name,k.field,k.participant_count,public.keychallenge_keyword_key(k.name) keyword_key
    from public.keychallenge_catalog_items k
    where k.catalog_id=(select catalog_id from public.keychallenge_catalog_publication) and coalesce(chosen,'')<>'' and k.field=chosen
  ), post_context as materialized (
    select coalesce(string_agg(title_key,chr(10)),'') titles from posts
  ), candidates as materialized (
    select distinct on(k.keyword_key) k.*,v.volume_min,v.volume_max,v.collected_at
    from catalog_rows k join public.keychallenge_search_volumes v on v.keyword_key=k.keyword_key
    where v.available and v.volume_min>=10 and v.collected_at between now()-interval '30 days' and now()+interval '5 minutes'
    order by k.keyword_key,k.keyword_id
  ), related as materialized (
    select c.*,h.terms,h.rank_backed,h.exposure_backed,h.frequency,case when c.field='여행' then public.keychallenge_travel_scope(c.name) else c.field end travel_scope, c.volume_min::numeric/(coalesce(c.participant_count,999999)+1) demand_ratio
    from candidates c join lateral (
      select array_agg(t.token order by t.rank_backed desc,t.exposure_backed desc,t.frequency desc,t.token) terms,
        bool_or(t.rank_backed) rank_backed,bool_or(t.exposure_backed) exposure_backed,sum(t.frequency) frequency
      from tokens t where position(t.token in c.keyword_key)>0
    ) h on cardinality(h.terms)>0
    where not exists(select 1 from own_items o where o.keyword_key=c.keyword_key)
      and position(c.keyword_key in (select titles from post_context))=0
  ), balanced as (
    select r.*,row_number() over(partition by travel_scope order by rank_backed desc,exposure_backed desc,cardinality(terms) desc,frequency desc,demand_ratio desc,volume_min desc,keyword_id) scope_position from related r
  ), ranked as (
    select r.*,row_number() over(order by rank_backed desc,exposure_backed desc,case when field='여행' then scope_position else 1 end,cardinality(terms) desc,frequency desc,demand_ratio desc,volume_min desc,keyword_id) position from balanced r
  ), cards as (
    select r.position,jsonb_build_object('keyword',r.name,'keyword_id',r.keyword_id,'keyword_key',r.keyword_key,'field',r.field,
      'travel_scope',r.travel_scope,'volume_min',r.volume_min,'volume_max',r.volume_max,'collected_at',r.collected_at,'participant_count',r.participant_count,
      'saved',exists(select 1 from public.keychallenge_blog_keywords k where k.user_id=(select auth.uid()) and k.keyword_key=r.keyword_key and not k.archived),
      'reasons',jsonb_build_array(case when r.rank_backed then '키챌 TOP10 기록이 있는 글·키워드와 연결' when r.exposure_backed then '최근 제목 검색에서 노출 확인된 글과 연결' else '최근 작성한 글의 주제와 연결' end,
        '연결 표현: '||array_to_string(r.terms[1:3],', '),'최근 수집한 글 제목과 참여 키워드에 없는 확장 후보')) item from ranked r where position<=10
  )
  select jsonb_build_object('field',chosen,'post_count',(select count(*) from posts),'exposed_posts',(select count(*) from posts where found_recently),
    'source_terms',(select coalesce(jsonb_agg(token),'[]') from tokens),'profile_at',profile.updated_at,'history_days',(select count(*) from snapshots),
    'history_start',(select min(snapshot_date) from snapshots),'history_end',(select max(snapshot_date) from snapshots),
    'strengths',coalesce((select jsonb_agg(jsonb_build_object('keyword',name,'best_rank',best_rank,'current_rank',current_rank)) from (select * from strengths order by best_rank,keyword_id limit 5)s),'[]'),
    'candidate_count',(select count(*) from related),'items',coalesce((select jsonb_agg(item order by position) from cards),'[]')) into result;
  return result;
end $function$;
REVOKE ALL ON FUNCTION public.keychallenge_personalized_keywords(text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.keychallenge_personalized_keywords(text,text) TO authenticated;
