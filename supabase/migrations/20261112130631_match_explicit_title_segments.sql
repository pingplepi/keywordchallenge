create or replace function public.keychallenge_blog_title_dashboard(p_query text, p_status text, p_page integer, p_review boolean, p_profile text)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $function$
with recursive
monitor as (
  select blog_id from public.keychallenge_blog_monitors
  where user_id=(select auth.uid())
),
all_posts as materialized (
  select p.*,public.keychallenge_keyword_key(p.title) as title_key
  from public.keychallenge_blog_posts p
  join monitor using(blog_id)
  where p.user_id=(select auth.uid())
    and strpos(lower(p.title),lower(left(p_query,100)))>0
    and (p_status='' or p.check_status=p_status)
),
ordered_posts as materialized (
  select p.*,
    row_number() over(order by p.published_at desc nulls last,p.first_seen_at desc,p.post_id desc) as rn,
    count(*) over() as total
  from all_posts p
),
base_paging as (
  select coalesce(max(total),0) as total,
    least(greatest(1,p_page),greatest(1,ceil(coalesce(max(total),0)/20.0)::integer)) as page
  from ordered_posts
),
posts as materialized (
  select o.*
  from ordered_posts o cross join base_paging b
  where p_review or o.rn between (b.page-1)*20+1 and b.page*20
),
profile as (
  select payload from public.keychallenge_profiles
  where user_id=(select auth.uid())
    and influencer_id=coalesce(nullif(p_profile,''),(select blog_id from monitor))
),
records as materialized (
  select x->>'id' as keyword_id,lower(c->>'url') as url
  from profile cross join lateral jsonb_array_elements(payload->'items') x
  left join lateral jsonb_array_elements(x->'contents') c on true
),
links as materialized (
  select keyword_id,case
    when url ~ '^https?://(m\.)?blog\.naver\.com/[a-z0-9_-]+/[0-9]+/?([?#]|$)'
      then substring(url from 'naver\.com/([a-z0-9_-]+/[0-9]+)')
    when url ~ '^https?://(m\.)?blog\.naver\.com/postview\.naver\?'
      then substring(url from '[?&]blogid=([a-z0-9_-]+)(&|#|$)') || '/' || substring(url from '[?&]logno=([0-9]+)(&|#|$)')
  end as identity
  from records
),
tokens as materialized (
  select p.post_id,t.word,t.pos
  from posts p
  cross join lateral public.keychallenge_title_fragments(left(p.title,500)) t
),
member_field as (
  select case interest when '문화/예술' then '공연/전시/예술' else interest end as field
  from public.keychallenge_members where user_id=(select auth.uid())
),
shared_fields(fields) as (values
  (array['패션','뷰티']), (array['IT테크','자동차']),
  (array['리빙','육아','생활건강']), (array['운동/레저','프로스포츠']),
  (array['방송/연예','대중음악','영화']), (array['공연/전시/예술','도서'])
),
allowed_fields as (
  select unnest(coalesce(s.fields,array[m.field])) as field
  from member_field m left join shared_fields s on m.field=any(s.fields)
),
catalog_all as materialized (
  select keyword_id,name,public.keychallenge_keyword_key(name) as key,
    max(participant_count) as participants
  from public.keychallenge_catalog_items
  where catalog_id=(select catalog_id from public.keychallenge_catalog_publication)
  group by keyword_id,name
),
catalog as materialized (
  select ca.*
  from catalog_all ca
  where exists (
    select 1 from public.keychallenge_catalog_items i
    where i.catalog_id=(select catalog_id from public.keychallenge_catalog_publication)
      and i.keyword_id=ca.keyword_id and i.name=ca.name
      and i.field in (select field from allowed_fields)
  )
),
coverage_tokens as materialized (
  select distinct t.post_id,t.pos,left(t.word,n) as fragment
  from tokens t
  cross join lateral generate_series(2,length(t.word)) n
),
candidate_catalog as materialized (
  select c.*
  from catalog c
  where length(c.key)>=2
    and exists (
      select 1 from coverage_tokens t
      where starts_with(c.key,t.fragment)
    )
),
starts as (
  select p.post_id,p.title_key,chars.initial
  from posts p
  cross join lateral (
    select distinct ch as initial
    from regexp_split_to_table(p.title_key,'') ch
  ) chars
),
prefixes as materialized (
  select distinct left(c.key,n) as prefix
  from candidate_catalog c
  cross join lateral generate_series(2,least(length(c.key),500)) n
),
sequences(post_id,pos,key) as (
  select t.post_id,t.pos,t.word
  from tokens t join prefixes p on p.prefix=t.word
  union
  select s.post_id,t.pos,p.prefix
  from sequences s
  join tokens t on t.post_id=s.post_id and t.pos>s.pos
  join prefixes p on p.prefix=s.key||t.word
),
coverage_terms as (
  select p.post_id,c.name,c.keyword_id,c.key,t.pos,
    max(length(t.fragment)) as covered_length,
    bool_or(t.fragment in ('체험','투어')) as explicit_action
  from posts p
  join candidate_catalog c on true
  join coverage_tokens t on t.post_id=p.post_id and strpos(c.key,t.fragment)>0
  group by p.post_id,c.name,c.keyword_id,c.key,t.pos
),
coverage_hits as (
  select post_id,name,keyword_id
  from coverage_terms
  group by post_id,name,keyword_id
  having sum(covered_length)>=max(length(key))
    and (max(length(key))>=5 or bool_or(explicit_action))
),
title_hits as (
  select s.post_id,c.name,c.keyword_id
  from starts s
  join catalog_all c on length(c.key)>=2 and left(c.key,1)=s.initial and strpos(s.title_key,c.key)>0
  union
  select s.post_id,c.name,c.keyword_id
  from sequences s join candidate_catalog c on c.key=s.key
  union
  select post_id,name,keyword_id from coverage_hits
),
matches as (
  select h.post_id,h.name,h.keyword_id,
    case
      when bool_or(l.identity=lower((select blog_id from monitor))||'/'||h.post_id) then 'same'
      when count(l.identity)>0 then 'other'
      when count(l.keyword_id)>0 then 'unknown'
      else 'candidate'
    end as status
  from title_hits h
  left join links l using(keyword_id)
  group by h.post_id,h.name,h.keyword_id
),
groups as (
  select post_id,
    jsonb_agg(jsonb_build_object('name',name,'status',status,'keyword_id',keyword_id::text)
      order by length(name) desc,name,keyword_id) as challenges,
    bool_or(status<>'same') as review
  from matches
  group by post_id
),
eligible as materialized (
  select p.*,g.challenges
  from posts p left join groups g using(post_id)
  where not p_review or g.review
),
review_paging as (
  select count(*) as total,
    least(greatest(1,p_page),greatest(1,ceil(count(*)/20.0)::integer)) as page
  from eligible
),
paging as (
  select
    case when p_review then r.total else b.total end as total,
    case when p_review then r.page else b.page end as page
  from base_paging b cross join review_paging r
),
rows as (
  select *
  from eligible
  order by published_at desc nulls last,first_seen_at desc,post_id desc
  limit 20
  offset case when p_review then (select (page-1)*20 from paging) else 0 end
)
select public.keychallenge_blog_dashboard(p_query,p_status,1) ||
  jsonb_build_object(
    'matched_total',(select total from paging),
    'page',(select page from paging),
    'items',coalesce((
      select jsonb_agg(to_jsonb(r)-'title_key'-'rn'-'total'
        order by published_at desc nulls last,first_seen_at desc,post_id desc)
      from rows r
    ),'[]'::jsonb)
  );
$function$;
revoke all on function public.keychallenge_blog_title_dashboard(text,text,integer,boolean,text) from public,anon;
grant execute on function public.keychallenge_blog_title_dashboard(text,text,integer,boolean,text) to authenticated;