-- Dashboard field selection is a view filter; never update member preferences.
-- New RPC names avoid ambiguous PostgREST overloads. Existing callers stay compatible.
CREATE OR REPLACE FUNCTION public.keychallenge_blogger_discovery_for_field(p_field text DEFAULT '__mine__'::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
 with member as materialized (
   select blog_id, case when p_field is null or p_field='__mine__' then interest else p_field end as interest from public.keychallenge_members where user_id=(select auth.uid())
 ), saved as materialized (
   select keyword,keyword_key,folder,notes,updated_at from public.keychallenge_blog_keywords
   where user_id=(select auth.uid()) and not archived
 ), posts as materialized (
   select p.title,public.keychallenge_keyword_key(p.title) as title_key,p.post_id,p.blog_id,
     p.last_result,p.previous_result,p.last_result_at
   from public.keychallenge_blog_posts p
   where p.user_id=(select auth.uid()) and p.blog_id=(select blog_id from member)
 ), catalog_candidates as materialized (
   -- Bound the more expensive title comparison to 300 measured candidates in the chosen field.
   select k.name as keyword,public.keychallenge_keyword_key(k.name) as keyword_key,k.field,
     v.volume_min,v.volume_max,v.collected_at
   from public.keychallenge_catalog_items k
   join public.keychallenge_search_volumes v on v.keyword_key=public.keychallenge_keyword_key(k.name)
     and v.available and v.volume_min is not null and v.collected_at >= now()-interval '30 days'
   where k.catalog_id=(select catalog_id from public.keychallenge_catalog_publication)
     and (p_field='' or k.field=case (select interest from member) when '문화/예술' then '공연/전시/예술' else (select interest from member) end)
     and length(k.name)<=100
   order by v.volume_min desc,v.volume_max desc,k.name,k.keyword_id limit 300
 ), candidates as (
   select c.keyword,c.keyword_key,c.field,c.volume_min,c.volume_max,c.collected_at,
     false as saved,''::text as folder,''::text as notes,null::timestamptz as updated_at
   from catalog_candidates c
   union all
   select s.keyword,s.keyword_key,f.field,v.volume_min,v.volume_max,v.collected_at,
     true,s.folder,s.notes,s.updated_at
   from saved s left join lateral (
     select min(k.field) as field from public.keychallenge_catalog_items k
     where k.catalog_id=(select catalog_id from public.keychallenge_catalog_publication)
       and public.keychallenge_keyword_key(k.name)=s.keyword_key
       and (p_field is null or p_field in ('','__mine__') or k.field=case p_field when '문화/예술' then '공연/전시/예술' else p_field end)
   ) f on true left join public.keychallenge_search_volumes v on v.keyword_key=s.keyword_key
     and v.available and v.volume_min is not null and v.collected_at>=now()-interval '30 days'
   where p_field is null or p_field in ('','__mine__') or f.field is not null
 ), unique_candidates as materialized (
   select distinct on(keyword_key) * from candidates
   where keyword_key<>'' order by keyword_key,saved desc,field nulls last
 ), opportunities as materialized (
   select c.* from unique_candidates c where not exists(
     select 1 from posts p where position(c.keyword_key in p.title_key)>0
   )
 ), top_opportunities as (
   select * from opportunities where volume_min is not null
   order by volume_min desc,volume_max desc,keyword_key limit 10
 ), idea_pool as (
   select * from opportunities order by saved desc,volume_min desc nulls last,updated_at desc nulls last,keyword_key limit 30
 ), ideas as (
   select * from idea_pool
   order by md5(keyword_key || (now() at time zone 'Asia/Seoul')::date::text),keyword_key limit 10
 ), changes as materialized (
   select title,post_id,blog_id,last_result,previous_result,last_result_at,
     case when last_result='found' and previous_result is null then 'first_found'
       when last_result='found' then 'found' else 'unconfirmed' end as change
   from posts where last_result_at>=(((now() at time zone 'Asia/Seoul')::date-6)::timestamp at time zone 'Asia/Seoul')
     and ((last_result='found' and (previous_result is null or previous_result='unconfirmed'))
       or (last_result='unconfirmed' and previous_result='found'))
 ), recent_saved as (
   select s.keyword,s.folder,s.notes,s.updated_at,v.volume_min,v.volume_max,v.collected_at,
     exists(select 1 from posts p where position(s.keyword_key in p.title_key)>0) as title_matched
   from saved s left join public.keychallenge_search_volumes v on v.keyword_key=s.keyword_key
     and v.available and v.volume_min is not null and v.collected_at>=now()-interval '30 days'
   order by s.updated_at desc,s.keyword_key limit 5
 )
 select jsonb_build_object(
   'interest',(select interest from member),'blog_id',(select blog_id from member),
   'day',(now() at time zone 'Asia/Seoul')::date,
   'post_count',(select count(*) from posts),'candidate_count',(select count(*) from unique_candidates),
   'saved_count',(select count(*) from saved),'opportunity_count',(select count(*) from opportunities),
   'new_found_count',(select count(*) from changes where last_result='found'),
   'unconfirmed_change_count',(select count(*) from changes where last_result='unconfirmed'),
   'ideas',coalesce((select jsonb_agg(to_jsonb(x)) from ideas x),'[]'::jsonb),
   'opportunities',coalesce((select jsonb_agg(to_jsonb(x) order by x.volume_min desc,x.volume_max desc,x.keyword_key) from top_opportunities x),'[]'::jsonb),
   'changes',coalesce((select jsonb_agg(to_jsonb(x) order by x.last_result_at desc,x.post_id) from (
     select * from changes order by last_result_at desc,post_id limit 6)x),'[]'::jsonb),
   'recent_saved',coalesce((select jsonb_agg(to_jsonb(x) order by x.updated_at desc,x.keyword) from recent_saved x),'[]'::jsonb)
 );
$function$
;
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
  ), catalog as materialized (
    select k.keyword_id,k.name,k.field,k.participant_count,
      public.keychallenge_keyword_key(k.name) as keyword_key,
      v.volume_min,v.volume_max,v.collected_at as volume_collected_at
    from public.keychallenge_catalog_items k
    join public.keychallenge_search_volumes v
      on v.keyword_key=public.keychallenge_keyword_key(k.name) and v.available
    where (p_field='' or (chosen<>'' and k.field=chosen))
      and k.catalog_id=(select catalog_id from public.keychallenge_catalog_publication)
      and v.volume_min>=10 and k.participant_count is not null
      and v.collected_at between now()-interval '30 days' and now()+interval '5 minutes'
      and catalog_time between now()-interval '30 days' and now()+interval '5 minutes'
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
CREATE OR REPLACE FUNCTION keychallenge_discovery_private.blogger_discovery_fresh_for_field(p_field text DEFAULT '__mine__'::text, p_enqueue boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  payload := public.keychallenge_blogger_discovery_for_field(p_field);
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
    insert into keychallenge_discovery_private.volume_requests(keyword_key,keyword,required_after,requested_at,priority)
    select distinct on (r.key) r.key,r.keyword,v_day,now(),0 from jsonb_to_recordset(needed) r(key text,keyword text) order by r.key,r.keyword
    on conflict(keyword_key) do update set keyword=excluded.keyword,required_after=excluded.required_after,requested_at=excluded.requested_at,priority=0
      where volume_requests.required_after<excluded.required_after or volume_requests.priority>0;
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
end $function$
;
create or replace function public.keychallenge_blogger_discovery_fresh_for_field(p_field text default '__mine__', p_enqueue boolean default true)
returns jsonb language sql security invoker set search_path='' as $$
 select keychallenge_discovery_private.blogger_discovery_fresh_for_field(p_field,p_enqueue);
$$;

-- Keep the original entry points as wrappers around the shared implementation.
create or replace function public.keychallenge_blogger_discovery()
returns jsonb language sql stable security invoker set search_path='' as $$
 select public.keychallenge_blogger_discovery_for_field('__mine__');
$$;
create or replace function public.keychallenge_blogger_keyword_attack_top10()
returns jsonb language sql stable security invoker set search_path='' as $$
 select public.keychallenge_blogger_attack_for_field('__mine__');
$$;
create or replace function keychallenge_discovery_private.blogger_discovery_fresh(p_enqueue boolean default true)
returns jsonb language sql security definer set search_path='' as $$
 select keychallenge_discovery_private.blogger_discovery_fresh_for_field('__mine__',p_enqueue);
$$;
revoke all on function public.keychallenge_blogger_discovery_for_field(text),
 public.keychallenge_blogger_attack_for_field(text),
 public.keychallenge_blogger_discovery_fresh_for_field(text,boolean),
 keychallenge_discovery_private.blogger_discovery_fresh_for_field(text,boolean) from public,anon;
grant execute on function public.keychallenge_blogger_discovery_for_field(text),
 public.keychallenge_blogger_attack_for_field(text),
 public.keychallenge_blogger_discovery_fresh_for_field(text,boolean),
 keychallenge_discovery_private.blogger_discovery_fresh_for_field(text,boolean) to authenticated;
notify pgrst,'reload schema';

