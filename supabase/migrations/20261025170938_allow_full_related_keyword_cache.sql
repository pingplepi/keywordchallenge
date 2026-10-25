-- The cache keeps the full related pool; only the API response is limited to 200.
alter table public.keychallenge_keyword_lookup_cache
  drop constraint keychallenge_keyword_lookup_cache_items_check;
alter table public.keychallenge_keyword_lookup_cache
  add constraint keychallenge_keyword_lookup_cache_items_check
  check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) <= 20000);
