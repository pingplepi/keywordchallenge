create table if not exists keychallenge_private.keyword_competition_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_day date not null,
  checks integer not null default 0 check (checks >= 0 and checks <= 5),
  primary key (user_id, usage_day)
);
alter table keychallenge_private.keyword_competition_usage enable row level security;
revoke all on keychallenge_private.keyword_competition_usage from public, anon, authenticated;
grant all on keychallenge_private.keyword_competition_usage to service_role;

create or replace function public.keychallenge_keyword_competition_reserve(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  local_day date := (clock_timestamp() at time zone 'Asia/Seoul')::date;
  used_count integer := 0;
  global_budget jsonb;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'Server access required';
  end if;
  if p_user_id is null then raise exception 'User required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || local_day::text, 0));
  select checks into used_count from keychallenge_private.keyword_competition_usage
    where user_id = p_user_id and usage_day = local_day for update;
  used_count := coalesce(used_count, 0);
  if used_count >= 5 then
    return jsonb_build_object('allowed',false,'reason','user_daily_limit','used',used_count,'limit',5);
  end if;
  global_budget := keychallenge_private.blog_search_budget('reserve');
  if coalesce((global_budget->>'allowed')::boolean, false) is not true then
    return global_budget || jsonb_build_object('user_used',used_count,'user_limit',5);
  end if;
  insert into keychallenge_private.keyword_competition_usage(user_id,usage_day,checks)
    values(p_user_id,local_day,1)
    on conflict(user_id,usage_day) do update set checks=keychallenge_private.keyword_competition_usage.checks+1
    returning checks into used_count;
  return global_budget || jsonb_build_object('user_used',used_count,'user_limit',5);
end
$function$;
revoke execute on function public.keychallenge_keyword_competition_reserve(uuid) from public, anon, authenticated;
grant execute on function public.keychallenge_keyword_competition_reserve(uuid) to service_role;