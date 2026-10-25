-- Keep the existing authenticated/RLS scope and date-stable selection.
DO $migration$
DECLARE definition text; old_limit text := 'order by md5(keyword_key || (now() at time zone ''Asia/Seoul'')::date::text),keyword_key limit 3';
BEGIN
  definition := pg_get_functiondef('public.keychallenge_blogger_discovery()'::regprocedure);
  IF strpos(definition, old_limit) = 0 THEN
    IF strpos(definition, replace(old_limit, 'limit 3', 'limit 9')) > 0 THEN RETURN; END IF;
    RAISE EXCEPTION 'Expected daily idea selection was not found';
  END IF;
  EXECUTE replace(definition, old_limit, replace(old_limit, 'limit 3', 'limit 9'));
END
$migration$;
