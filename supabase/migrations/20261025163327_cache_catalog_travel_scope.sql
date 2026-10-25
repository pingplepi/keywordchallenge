-- Reuse travel classification across dashboard requests; keep generation automatic on catalog ingestion.
GRANT EXECUTE ON FUNCTION public.keychallenge_travel_scope(text) TO service_role;
ALTER TABLE public.keychallenge_catalog_items ADD COLUMN travel_scope text GENERATED ALWAYS AS
(case when field='여행' then public.keychallenge_travel_scope(name) else null end) STORED;
DO $migration$
declare fn regprocedure; s text;
begin
  foreach fn in array array['public.keychallenge_keyword_opportunities(text,text)'::regprocedure,'public.keychallenge_blogger_keyword_opportunities()'::regprocedure] loop
    s:=pg_get_functiondef(fn);
    s:=replace(s,'case when k.field=''여행'' then public.keychallenge_travel_scope(k.name) else null end as travel_scope','k.travel_scope');
    execute s;
  end loop;
  s:=pg_get_functiondef('public.keychallenge_personalized_keywords(text,text)'::regprocedure);
  s:=replace(s,'k.keyword_id,k.name,k.field,k.participant_count,public.keychallenge_keyword_key(k.name) keyword_key','k.keyword_id,k.name,k.field,k.participant_count,k.travel_scope,public.keychallenge_keyword_key(k.name) keyword_key');
  s:=replace(s,'case when c.field=''여행'' then public.keychallenge_travel_scope(c.name) else c.field end travel_scope,','');
  execute s;
end $migration$;
ANALYZE public.keychallenge_catalog_items;
