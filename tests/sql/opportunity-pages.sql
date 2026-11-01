-- Run in a transaction with an authenticated test user and ROLLBACK afterwards.
-- Verifies both dashboards using the test user's own profile, posts and saved list.
-- The temporary save is rolled back with a subtransaction as well.
do $test$
declare
  influencer text; mode text; kind text; call_sql text; old jsonb; first_page jsonb;
  second_page jsonb; last_page jsonb; filtered jsonb; after_save jsonb;
  total integer; chosen_keyword text;
begin
  select influencer_id into influencer from public.keychallenge_profiles
    where user_id=(select auth.uid()) order by updated_at desc limit 1;
  if influencer is null then raise exception 'An owned influencer profile is required for this regression'; end if;
  foreach mode in array array['influencer','blogger'] loop
    if mode='influencer' then
      old:=public.keychallenge_keyword_opportunities(influencer,'__mine__');
      call_sql:=format('select public.keychallenge_keyword_opportunities_page(%L,''__mine__'',$1,$2,$3)',influencer);
    else
      old:=public.keychallenge_blogger_keyword_opportunities();
      call_sql:='select public.keychallenge_blogger_keyword_opportunities_page($1,$2,$3)';
    end if;
    foreach kind in array array['blue','longtail','red'] loop
      execute call_sql into first_page using kind,1,false;
      if first_page->kind is distinct from old->kind or first_page->'counts' is distinct from old->'counts' then
        raise exception '% %: classification or first-page order changed',mode,kind;
      end if;
      total:=(first_page->'counts'->>kind)::integer;
      execute call_sql into second_page using kind,2,false;
      if total>10 and exists(select 1 from jsonb_array_elements(first_page->kind) a
        join jsonb_array_elements(second_page->kind) b on a->>'keyword_key'=b->>'keyword_key') then
        raise exception '% %: pages overlap',mode,kind;
      end if;
      execute call_sql into last_page using kind,100000,false;
      if (last_page->>'page')::integer<>greatest(1,ceil(total/10.0)::integer)
        or jsonb_array_length(last_page->kind)<>(case when total=0 then 0 else (total-1)%10+1 end) then
        raise exception '% %: last-page clamp or size incorrect',mode,kind;
      end if;
      execute call_sql into filtered using kind,1,true;
      if exists(select 1 from jsonb_array_elements(filtered->kind) x where (x->>'saved')::boolean)
        or filtered->'total_counts' is distinct from first_page->'counts'
        or (filtered->'counts'->>kind)::integer>total then
        raise exception '% %: saved filter or counts incorrect',mode,kind;
      end if;
      if jsonb_array_length(filtered->kind)>0 then
        begin
          chosen_keyword:=filtered->kind->0->>'name';
          perform public.keychallenge_save_blog_keyword(chosen_keyword);
          execute call_sql into after_save using kind,1,true;
          if (after_save->'counts'->>kind)::integer<>(filtered->'counts'->>kind)::integer-1
            or exists(select 1 from jsonb_array_elements(after_save->kind) x where x->>'name'=chosen_keyword)
            or jsonb_array_length(after_save->kind)<>least(10,(after_save->'counts'->>kind)::integer) then
            raise exception '% %: saved candidate was not removed and replaced',mode,kind;
          end if;
          raise exception using errcode='KYT01',message='rollback temporary save';
        exception when sqlstate 'KYT01' then null;
        end;
      end if;
    end loop;
    begin
      execute call_sql using 'invalid',0,true;
      raise exception 'Invalid page accepted';
    exception when raise_exception then
      if sqlerrm<>'추천 페이지 조건을 확인해 주세요.' then raise; end if;
    end;
  end loop;
end $test$;
select 'Both modes: all 3 categories, unchanged classification, distinct pages, final page, saved filtering, refill and input validation passed' as result;
