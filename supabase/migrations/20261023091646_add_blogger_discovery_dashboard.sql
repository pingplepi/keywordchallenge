-- Read-only discovery: stored search volumes, own saved ideas and own blog observations.
-- No upstream API calls or private credential tables are involved.
create function public.keychallenge_blogger_discovery() returns jsonb
language sql stable security invoker set search_path = '' as $$
 with member as materialized (
   select blog_id, interest from public.keychallenge_members where user_id=(select auth.uid())
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
     and k.field=case (select interest from member) when '문화/예술' then '공연/전시/예술' else (select interest from member) end
     and length(k.name)<=100
   order by v.volume_min desc,v.volume_max desc,k.name,k.keyword_id limit 300
 ), candidates as (
   select c.keyword,c.keyword_key,c.field,c.volume_min,c.volume_max,c.collected_at,
     false as saved,''::text as folder,''::text as notes,null::timestamptz as updated_at
   from catalog_candidates c
   union all
   select s.keyword,s.keyword_key,null::text,v.volume_min,v.volume_max,v.collected_at,
     true,s.folder,s.notes,s.updated_at
   from saved s left join public.keychallenge_search_volumes v on v.keyword_key=s.keyword_key
     and v.available and v.volume_min is not null and v.collected_at>=now()-interval '30 days'
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
   order by md5(keyword_key || (now() at time zone 'Asia/Seoul')::date::text),keyword_key limit 3
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
$$;
revoke all on function public.keychallenge_blogger_discovery() from public,anon;
grant execute on function public.keychallenge_blogger_discovery() to authenticated;
comment on function public.keychallenge_blogger_discovery() is 'Own-blog content ideas using cached measured volumes. Title matching is limited to collected posts, not proof of unwritten topics or search rankings.';
