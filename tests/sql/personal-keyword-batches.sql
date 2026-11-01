-- Run inside an authenticated test-user transaction (request.jwt.claim.sub set).
-- Requires collected posts/profile and at least one related candidate.
-- Read-only: no fixtures, member changes, API calls, or saved-keyword writes.
do $test$
declare
  influencer text;
  first_batch jsonb; second_batch jsonb; third_batch jsonb; background_batch jsonb;
  seen text[]; current_batch text[]; third_keys text[];
  candidates integer;
begin
  if (select auth.uid()) is null then raise exception 'Authenticated test session required'; end if;
  select influencer_id into influencer from public.keychallenge_profiles
    where user_id=(select auth.uid()) order by updated_at desc limit 1;
  first_batch:=public.keychallenge_personalized_keyword_batch(influencer,'__mine__');
  candidates:=(first_batch->>'candidate_count')::integer;
  if candidates<1 then raise exception 'Test user needs related keyword candidates'; end if;
  if first_batch->'items' is distinct from public.keychallenge_personalized_keywords(influencer,'__mine__')->'items' then
    raise exception 'Initial relevance order changed';
  end if;
  select array_agg(x->>'keyword_key') into seen from jsonb_array_elements(first_batch->'items') x;
  second_batch:=public.keychallenge_personalized_keyword_batch(influencer,'__mine__',seen,seen,true);
  if (second_batch->>'fresh_count')::integer<>least(10,greatest(candidates-cardinality(seen),0)) then
    raise exception 'Refresh did not prefer unseen candidates';
  end if;
  select array_agg(x->>'keyword_key') into current_batch from jsonb_array_elements(second_batch->'items') x;
  if cardinality(current_batch)<>(select count(distinct k) from unnest(current_batch) k) then raise exception 'Duplicate card'; end if;
  seen:=array(select distinct k from unnest(seen||current_batch) k);
  background_batch:=public.keychallenge_personalized_keyword_batch(influencer,'__mine__',seen,current_batch,false);
  if background_batch->'items' is distinct from second_batch->'items' then raise exception 'Background reload changed selected batch'; end if;
  third_batch:=public.keychallenge_personalized_keyword_batch(influencer,'__mine__',seen,current_batch,true);
  select array_agg(x->>'keyword_key') into third_keys from jsonb_array_elements(third_batch->'items') x;
  if (third_batch->>'fresh_count')::integer<>least(10,greatest(candidates-cardinality(seen),0)) then
    raise exception 'Later refresh repeated seen candidates too early';
  end if;
  if (third_batch->>'different_count')::integer<>least(10,greatest(candidates-cardinality(current_batch),0)) then
    raise exception 'Current batch repeated before older candidates';
  end if;
  if exists(select 1 from jsonb_array_elements(third_batch->'items') x
    where x->>'field' is distinct from first_batch->>'field' or jsonb_array_length(x->'reasons')<>3) then
    raise exception 'Field or recommendation evidence lost';
  end if;
  begin
    perform public.keychallenge_personalized_keyword_batch(influencer,'__mine__',array_fill('x'::text,array[501]));
    raise exception 'Unbounded recommendation history accepted';
  exception when raise_exception then
    if sqlerrm<>'추천 새로고침 조건을 확인해 주세요.' then raise; end if;
  end;
end $test$;
select 'Initial order, unseen-first rotation, stable background reload, field/evidence, and history limit passed' as result;
