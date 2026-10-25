-- Applied in production as add_topic_personalized_keyword_recommendations.
-- Preserve existing scoring and RLS; balance the travel candidates only.
CREATE OR REPLACE FUNCTION public.keychallenge_travel_scope(p_name text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $$
select case when public.keychallenge_keyword_key(p_name) ~ '세계여행|해외여행|일본|도쿄|오사카|교토|후쿠오카|삿포로|북해도|홋카이도|오키나와|나고야|히로시마|고베|나라여행|유후인|벳푸|대마도|베트남|나트랑|다낭|푸꾸옥|하노이|호치민|달랏|호이안|사파여행|태국|방콕|치앙마이|푸켓|파타야|코사무이|대만|타이베이|타이중|가오슝|지우펀|홍콩|마카오|중국|상하이|상해여행|베이징|칭다오|장가계|하이난|싱가포르|싱가폴|말레이시아|코타키나발루|쿠알라룸푸르|랑카위|페낭|인도네시아|발리|자카르타|필리핀|세부|보홀|보라카이|마닐라|팔라완|괌|사이판|하와이|미국|뉴욕|로스앤젤레스|라스베가스|샌프란시스코|캐나다|밴쿠버|토론토|프랑스|파리|니스여행|영국|런던|이탈리아|로마|베네치아|베니스|피렌체|밀라노|스페인|바르셀로나|마드리드|포르투갈|리스본|포르투여행|스위스|인터라켄|취리히|융프라우|독일|베를린|뮌헨|프랑크푸르트|체코|프라하|오스트리아|비엔나|잘츠부르크|헝가리|부다페스트|크로아티아|두브로브니크|그리스|산토리니|튀르키예|터키여행|이스탄불|두바이|몰디브|모리셔스|호주|시드니|멜버른|브리즈번|뉴질랜드|오클랜드|퀸스타운|몽골|울란바토르|라오스|루앙프라방|방비엥|캄보디아|앙코르와트|인도여행|네팔|스리랑카|이집트|모로코|남아공|멕시코|칸쿤|브라질|아르헨티나|페루|유럽|동남아|남미여행|북미여행|아프리카여행' then '세계여행' when public.keychallenge_keyword_key(p_name) ~ '국내여행|서울|부산|제주|서귀포|인천|대구|대전|광주|울산|세종|경기도|경기여행|강원|충청|충북|충남|전라|전북|전남|경상|경북|경남|수원|용인|성남|고양|파주|양주|양평|가평|남양주|의정부|동두천|포천|안성|안산|안양|광명|시흥|평택|하남|화성|김포|과천|구리|오산|의왕|여주|이천|강릉|속초|양양|동해|삼척|태백|춘천|원주|평창|홍천|인제|철원|화천|횡성|영월|정선|청주|충주|제천|단양|보은|괴산|증평|천안|아산|공주|보령|서산|논산|당진|부여|서천|청양|홍성|예산|태안|전주|군산|익산|정읍|남원|김제|완주|무주|장수|임실|순창|고창|부안|목포|여수|순천|광양|나주|담양|곡성|구례|고흥|보성|화순|장흥|강진|해남|영암|무안|함평|영광|장성|완도|진도|신안|포항|경주|김천|안동|구미|영주|영천|상주|문경|경산|의성|청송|영양|영덕|청도|고령|성주|칠곡|예천|봉화|울진|울릉|독도|창원|진주|통영|사천|김해|밀양|거제|양산|의령|함안|창녕|고성|남해|하동|산청|함양|거창|합천|한강|북촌|경복궁|덕수궁|청계천|해운대|광안리|성산일출봉|한라산|지리산|설악산' then '국내여행' else '여행 공통·기타' end $$;
REVOKE ALL ON FUNCTION public.keychallenge_travel_scope(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.keychallenge_travel_scope(text) TO authenticated;
DO $migration$
declare fn regprocedure; s text; source_cte text; priority text; blogger boolean;
begin
  foreach fn in array array['public.keychallenge_keyword_opportunities(text,text)'::regprocedure,'public.keychallenge_blogger_keyword_opportunities()'::regprocedure] loop
    s:=pg_get_functiondef(fn); blogger:=s like '%keychallenge_blogger_keyword_opportunities%';
    if position('scope_position' in s)>0 then continue; end if;
    s:=replace(s,'k.keyword_id,k.name,k.field,k.participant_count,',E'k.keyword_id,k.name,k.field,k.participant_count,\n      case when k.field=''여행'' then public.keychallenge_travel_scope(k.name) else null end as travel_scope,');
    source_cte:=case when blogger then 'personalized' else 'unique_candidates' end;
    priority:=case when blogger then 'case when title_matched=false then 0 when title_matched is null then 1 else 2 end, cardinality(related_terms) desc,' else '(field=mine) desc, case when participation=false then 0 when participation is null then 1 else 2 end,' end;
    s:=replace(s,'), ranked as (',E'), balanced as (\n    select c.*,row_number() over(partition by kind,coalesce(travel_scope,field) order by\n      '||priority||E' opportunity_score desc,volume_min desc,keyword_id) as scope_position\n    from '||source_cte||E' c\n  ), ranked as (');
    if blogger then
      s:=replace(s,'cardinality(related_terms) desc,opportunity_score desc',E'case when field=''여행'' then scope_position else 1 end,\n      cardinality(related_terms) desc,opportunity_score desc');
    else
      s:=replace(s,'      opportunity_score desc,volume_min desc,participant_count,name,keyword_id) as position,',E'      case when field=''여행'' then scope_position else 1 end,\n      opportunity_score desc,volume_min desc,participant_count,name,keyword_id) as position,');
    end if;
    s:=replace(s,'    from '||source_cte||E' c\n  ), cards as (',E'    from balanced c\n  ), cards as (');
    s:=replace(s,'''participant_count'',r.participant_count,','''travel_scope'',r.travel_scope,''participant_count'',r.participant_count,');
    if position('from balanced c' in s)=0 then raise exception 'Opportunity definition changed; review migration'; end if;
    execute s;
  end loop;
end $migration$;
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
  ), candidates as materialized (
    select distinct on(v.keyword_key) k.keyword_id,k.name,k.field,k.participant_count,v.keyword_key,v.volume_min,v.volume_max,v.collected_at
    from public.keychallenge_catalog_items k join public.keychallenge_search_volumes v on v.keyword_key=public.keychallenge_keyword_key(k.name)
    where k.catalog_id=(select catalog_id from public.keychallenge_catalog_publication) and coalesce(chosen,'')<>'' and k.field=chosen and v.available and v.volume_min>=10
      and v.collected_at between now()-interval '30 days' and now()+interval '5 minutes'
      and not exists(select 1 from posts p where position(v.keyword_key in p.title_key)>0)
      and not exists(select 1 from own_items o where o.keyword_key=v.keyword_key)
    order by v.keyword_key,k.keyword_id
  ), related as materialized (
    select c.*,h.terms,h.rank_backed,h.exposure_backed,h.frequency,c.volume_min::numeric/(coalesce(c.participant_count,999999)+1) demand_ratio
    from candidates c join lateral (
      select array_agg(t.token order by t.rank_backed desc,t.exposure_backed desc,t.frequency desc,t.token) terms,
        bool_or(t.rank_backed) rank_backed,bool_or(t.exposure_backed) exposure_backed,sum(t.frequency) frequency
      from tokens t where position(t.token in c.keyword_key)>0
    ) h on cardinality(h.terms)>0
  ), ranked as (
    select r.*,row_number() over(order by rank_backed desc,exposure_backed desc,cardinality(terms) desc,frequency desc,demand_ratio desc,volume_min desc,keyword_id) position from related r
  ), cards as (
    select r.position,jsonb_build_object('keyword',r.name,'keyword_id',r.keyword_id,'keyword_key',r.keyword_key,'field',r.field,
      'volume_min',r.volume_min,'volume_max',r.volume_max,'collected_at',r.collected_at,'participant_count',r.participant_count,
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
