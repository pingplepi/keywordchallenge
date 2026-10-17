create function public.keychallenge_store_search_volumes(p_rows jsonb) returns integer
language plpgsql security invoker set search_path='' as $$
declare changed integer;
begin
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>5000 then raise exception 'Invalid volume batch'; end if;
  insert into public.keychallenge_search_volumes(keyword_key,keyword,pc_min,pc_max,mobile_min,mobile_max,collected_at,available)
  select r.keyword_key,r.keyword,r.pc_min,r.pc_max,r.mobile_min,r.mobile_max,r.collected_at,r.available
  from jsonb_to_recordset(p_rows) r(keyword_key text,keyword text,pc_min integer,pc_max integer,mobile_min integer,mobile_max integer,collected_at timestamptz,available boolean)
  where r.keyword_key=public.keychallenge_keyword_key(r.keyword) and exists(
    select 1 from public.keychallenge_catalog_items k where k.catalog_id=(select catalog_id from public.keychallenge_catalog_publication)
      and public.keychallenge_keyword_key(k.name)=r.keyword_key)
  on conflict(keyword_key) do update set keyword=excluded.keyword,pc_min=excluded.pc_min,pc_max=excluded.pc_max,
    mobile_min=excluded.mobile_min,mobile_max=excluded.mobile_max,collected_at=excluded.collected_at,available=excluded.available;
  get diagnostics changed = row_count;
  return changed;
end $$;
revoke all on function public.keychallenge_store_search_volumes(jsonb) from public,anon,authenticated;
grant execute on function public.keychallenge_store_search_volumes(jsonb) to service_role;
