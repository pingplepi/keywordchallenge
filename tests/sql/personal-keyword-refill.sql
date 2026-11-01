-- Execute in an authenticated user's transaction; ROLLBACK after the test.
-- Each temporary save is also rolled back inside its own subtransaction.
do $test$
declare
  influencer text; mode text; first_batch jsonb; filled jsonb; reloaded jsonb;
  original_keys text[]; kept_keys text[]; filled_keys text[]; selected_keyword text;
  baseline integer; candidate_total integer;
begin
  if (select auth.uid()) is null then raise exception 'Authenticated test session required'; end if;
  select influencer_id into influencer from public.keychallenge_profiles
    where user_id=(select auth.uid()) order by updated_at desc limit 1;
  if influencer is null then raise exception 'Owned influencer profile required'; end if;
  select count(*) into baseline from public.keychallenge_blog_keywords where user_id=(select auth.uid()) and not archived;
  foreach mode in array array['influencer','blogger'] loop
    first_batch:=public.keychallenge_personalized_keyword_batch(case when mode='influencer' then influencer end,'__mine__');
    candidate_total:=(first_batch->>'candidate_count')::integer;
    if candidate_total<11 then raise exception '%: needs at least 11 candidates',mode; end if;
    select array_agg(x->>'keyword_key' order by n) into original_keys from jsonb_array_elements(first_batch->'items') with ordinality a(x,n);
    selected_keyword:=first_batch->'items'->3->>'keyword';kept_keys:=array_remove(original_keys,original_keys[4]);
    begin
      perform public.keychallenge_save_blog_keyword(selected_keyword);
      filled:=public.keychallenge_personalized_keyword_batch(case when mode='influencer' then influencer end,'__mine__',original_keys,kept_keys,false);
      select array_agg(x->>'keyword_key' order by n) into filled_keys from jsonb_array_elements(filled->'items') with ordinality a(x,n);
      if cardinality(filled_keys)<>10 or filled_keys[1:9] is distinct from kept_keys
        or filled_keys[10]=any(original_keys) or (filled->>'candidate_count')::integer<>candidate_total-1 then
        raise exception '%: saved removal, retained order or replacement incorrect',mode;
      end if;
      if exists(select 1 from jsonb_array_elements(filled->'items') x join public.keychallenge_blog_keywords k on k.keyword_key=x->>'keyword_key'
        where k.user_id=(select auth.uid()) and not k.archived) then raise exception '%: saved keyword included',mode; end if;
      reloaded:=public.keychallenge_personalized_keyword_batch(case when mode='influencer' then influencer end,'__mine__');
      if exists(select 1 from jsonb_array_elements(reloaded->'items') x where x->>'keyword_key'=original_keys[4]) then
        raise exception '%: fresh visit returned saved keyword',mode;
      end if;
      raise exception using errcode='KYT01',message='rollback temporary save';
    exception when sqlstate 'KYT01' then null;
    end;
    if baseline<>(select count(*) from public.keychallenge_blog_keywords where user_id=(select auth.uid()) and not archived) then
      raise exception 'Temporary save not rolled back';
    end if;
  end loop;
end $test$;
select 'Both modes: saved exclusion, retained 9 keywords, next candidate, candidate count, new visit and rollback passed' as result;
