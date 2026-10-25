-- Preserve all related candidates so relevance and volume sorting use the same complete cache.
alter table public.keychallenge_keyword_lookup_cache
  add column if not exists format_version integer not null default 1;
