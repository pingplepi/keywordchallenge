-- Keep the date-stable daily selection and show ten candidates in the dashboard.
do $migration$
declare
  definition text;
  old_limit text := 'order by md5(keyword_key || (now() at time zone ''Asia/Seoul'')::date::text),keyword_key limit 9';
  new_limit text := 'order by md5(keyword_key || (now() at time zone ''Asia/Seoul'')::date::text),keyword_key limit 10';
begin
  definition := pg_get_functiondef('public.keychallenge_blogger_discovery()'::regprocedure);
  if strpos(definition,old_limit)=0 then
    if strpos(definition,new_limit)>0 then return; end if;
    raise exception 'Expected daily idea selection was not found';
  end if;
  execute replace(definition,old_limit,new_limit);
end
$migration$;
