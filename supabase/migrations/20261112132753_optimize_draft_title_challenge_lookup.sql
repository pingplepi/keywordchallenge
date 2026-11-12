CREATE OR REPLACE FUNCTION public.keychallenge_draft_title(p_title text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
with recursive input as (
  select public.keychallenge_keyword_key(left(trim(p_title),200)) as title
), tokens as materialized (
  select word,pos from regexp_split_to_table(upper(left(trim(p_title),200)), '[^가-힣A-Z0-9]+') with ordinality t(word,pos)
  where word<>''
), words as (
  select distinct word from tokens
), fields as materialized (select field from public.keychallenge_my_challenge_fields()),
catalog as materialized (
  select k.name,k.field,max(k.participant_count) as participants,public.keychallenge_keyword_key(k.name) as key
  from public.keychallenge_catalog_items k join fields using(field)
  where k.catalog_id=(select catalog_id from public.keychallenge_catalog_publication) group by k.name,k.field
), fragments as materialized (
  select word,pos from public.keychallenge_title_fragments(left(trim(p_title),200))
), candidate_catalog as materialized (
  select c.*
  from catalog c
  where length(c.key)>=2
    and exists (
      select 1 from fragments f
      where starts_with(c.key,left(f.word,least(3,length(f.word))))
    )
), matched_prefix(key,pos,used) as (
  select distinct c.key,t.pos,length(t.word)
  from candidate_catalog c join fragments t on starts_with(c.key,t.word)
  union
  select m.key,t.pos,m.used+length(t.word)
  from matched_prefix m join fragments t on t.pos>m.pos
  where m.used<length(m.key) and starts_with(substr(m.key,m.used+1),t.word)
), coverage_tokens as materialized (
  select distinct f.pos,substr(f.word,start_at,n) as fragment,(n<length(f.word)) as is_partial
  from fragments f
  cross join lateral generate_series(2,length(f.word)) n
  cross join lateral generate_series(1,length(f.word)-n+1) start_at
),
coverage_terms as (
  select c.name,c.field,c.key,t.pos,max(length(t.fragment)) as covered_length,
    bool_or(t.fragment in ('체험','투어')) as explicit_action,
    bool_and(t.is_partial) as partial_fragment
  from candidate_catalog c
  join coverage_tokens t on strpos(c.key,t.fragment)>0
  group by c.name,c.field,c.key,t.pos
),
coverage_hits as (
  select name,field,key from coverage_terms
  group by name,field,key
  having sum(covered_length)>=max(length(key))
    and (max(length(key))>=5 or bool_or(explicit_action))
    and (not bool_or(partial_fragment) or count(*)<=2)
),
included as materialized (
  select c.* from catalog c where
    (c.key in (select word from words)
      or c.key in (select key from matched_prefix where used=length(key))
      or exists(select 1 from coverage_hits h where h.key=c.key and h.name=c.name and h.field=c.field))
    and (length(c.key)>1 or c.key in (select word from words))
), anchors as (
  select word from words union select key from included
), focus as (
  select w.word from words w join included i on i.key=w.word and i.field='여행'
  where length(w.word)>=2 and w.word not in ('여행','마사지','호텔','맛집','숙소','공항','후기','추천')
  order by strpos((select title from input),w.word),length(w.word) desc limit 1
), related as (
  select c.name,c.field,c.participants,array_agg(a.word order by length(a.word) desc,a.word) as terms
  from catalog c join anchors a on length(a.word)>=2 and strpos(c.key,a.word)>0
  where a.word not in ('후기','추천','리뷰','정리','방법','여행','방문','하는','위한','다녀온','사용')
    and not exists(select 1 from included i where i.key=c.key)
  and not exists(select 1 from focus f where strpos(c.key,f.word)=0)
    and not exists(select 1 from regexp_matches(c.key,'([0-9]+월)','g') m where strpos((select title from input),m[1])=0)
  group by c.name,c.field,c.participants
  order by count(*) desc,max(length(a.word)) desc,c.participants desc nulls last,length(c.name),c.name,c.field limit 8
)
select jsonb_build_object('fields',array(select field from fields),
  'included',coalesce((select jsonb_agg(jsonb_build_object('name',name,'field',field) order by length(name) desc,name,field) from included),'[]'),
  'related',coalesce((select jsonb_agg(to_jsonb(r) order by cardinality(terms) desc,length(terms[1]) desc,participants desc nulls last,length(name),name,field) from related r),'[]'));
$function$
