do $migration$
declare definition text;
begin
  definition := pg_get_functiondef('public.keychallenge_volume_candidates(integer)'::regprocedure);
  if position('if jsonb_array_length(urgent)>=v_limit then return urgent; end if;' in definition)=0 then
    raise exception 'Unexpected volume candidate function definition';
  end if;
  execute replace(definition,
    'if jsonb_array_length(urgent)>=v_limit then return urgent; end if;',
    'if jsonb_array_length(urgent)>=v_limit or exists(select 1 from public.keychallenge_searchad_status where last_success_at>=v_day) then return urgent; end if;');
end $migration$;
