do $migration$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'keychallenge_private'
      and tablename = 'keyword_competition_usage'
      and policyname = 'No direct access to keyword competition usage'
  ) then
    create policy "No direct access to keyword competition usage"
      on keychallenge_private.keyword_competition_usage
      for all using (false) with check (false);
  end if;
end
$migration$;