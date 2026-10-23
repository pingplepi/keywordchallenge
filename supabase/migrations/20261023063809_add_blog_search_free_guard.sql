-- Reserve every outbound search before HTTP. Counters survive reconnects and errors.
alter table public.keychallenge_blog_search_status
 add column daily_limit integer not null default 20000 check(daily_limit between 1 and 20000),
 add column monthly_limit integer not null default 600000 check(monthly_limit between 1 and 600000),
 add column provider text not null default 'naver_api_hub' check(provider='naver_api_hub'),
 add column provider_limits_confirmed boolean not null default false,
 add column free_confirmed_until timestamptz,
 add column blocked_until timestamptz,
 add column stop_reason text;
alter table public.keychallenge_blog_search_usage add constraint blog_search_calls_nonnegative check(calls>=0);
-- A legacy connection must be replaced with an API HUB application and confirmed limits.
update public.keychallenge_blog_search_status set enabled=false,updated_at=now();

create function public.keychallenge_blog_search_budget(p_action text default 'status') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
 s public.keychallenge_blog_search_status;
 local_now timestamp; d date; month_start date; next_day timestamptz; next_month timestamptz;
 day_calls bigint; month_calls bigint; reason text; message text; retry_at timestamptz;
begin
 if p_action not in ('status','reserve','confirm','pause','provider_quota','credentials') then raise exception 'Unknown budget action'; end if;
 -- This lock serializes reservations across every worker and every user.
 select * into s from public.keychallenge_blog_search_status where singleton for update;
 if not found then raise exception 'Search limits unavailable'; end if;
 local_now:=clock_timestamp() at time zone 'Asia/Seoul'; d:=local_now::date;
 month_start:=date_trunc('month',local_now)::date;
 next_day:=((d+1)::timestamp at time zone 'Asia/Seoul')+interval '5 minutes';
 next_month:=((date_trunc('month',local_now)+interval '1 month') at time zone 'Asia/Seoul')+interval '5 minutes';
 if p_action='pause' then
  update public.keychallenge_blog_search_status set enabled=false,stop_reason='paused',updated_at=now() where singleton returning * into s;
 elsif p_action='confirm' then
  if not s.configured then raise exception 'Connect API HUB credentials first'; end if;
  update public.keychallenge_blog_search_status set enabled=true,provider_limits_confirmed=true,
   free_confirmed_until=now()+interval '30 days',updated_at=now(),
   stop_reason=case when blocked_until>now() then stop_reason else null end
   where singleton returning * into s;
  update public.keychallenge_blog_monitors set status='queued',phase='rss',pending_ids='[]',attempts=0,
   next_attempt_at=now(),requested_at=now(),last_error=null
   where enabled and status<>'running';
 elsif p_action='provider_quota' then
  update public.keychallenge_blog_search_status set blocked_until=greatest(coalesce(blocked_until,next_month),next_month),
   stop_reason='provider_quota',updated_at=now() where singleton returning * into s;
 elsif p_action='credentials' then
  update public.keychallenge_blog_search_status set enabled=false,stop_reason='credentials',updated_at=now() where singleton returning * into s;
 end if;
 select coalesce(sum(calls) filter(where usage_day=d),0),coalesce(sum(calls),0)
  into day_calls,month_calls from public.keychallenge_blog_search_usage where usage_day>=month_start and usage_day<=d;
 if not s.configured then reason:='unconfigured';
 elsif not s.enabled then reason:=case when s.stop_reason='credentials' then 'credentials' else 'paused' end;
 elsif not s.provider_limits_confirmed or s.free_confirmed_until is null or s.free_confirmed_until<=clock_timestamp() then reason:='confirmation';
 elsif s.blocked_until>clock_timestamp() then reason:=coalesce(s.stop_reason,'provider_quota'); retry_at:=s.blocked_until;
 elsif month_calls>=s.monthly_limit then reason:='monthly_limit'; retry_at:=next_month;
 elsif day_calls>=s.daily_limit then reason:='daily_limit'; retry_at:=next_day;
 end if;
 if reason in ('daily_limit','monthly_limit') then
  update public.keychallenge_blog_search_status set blocked_until=retry_at,stop_reason=reason,updated_at=now() where singleton;
 end if;
 message:=case reason
  when 'unconfigured' then '운영자의 네이버 API HUB 연결을 기다리고 있습니다.'
  when 'paused' then '운영자가 검색 점검을 일시 중지했습니다.'
  when 'credentials' then '네이버 API HUB 연결 정보를 확인할 때까지 검색 점검을 중지합니다.'
  when 'confirmation' then '운영자가 무료 제공 정책과 네이버 호출 한도를 다시 확인할 때까지 검색 점검을 중지합니다.'
  when 'provider_quota' then '네이버의 호출 제한 응답으로 이번 달 검색 점검을 중지합니다.'
  when 'daily_limit' then '오늘의 공용 검색 한도에 도달했습니다. 다음 날 한도 초기화 후 이어서 확인합니다.'
  when 'monthly_limit' then '이번 달 공용 검색 한도에 도달했습니다. 다음 달 한도 초기화 후 이어서 확인합니다.'
  else null end;
 if reason is null and p_action='reserve' then
  insert into public.keychallenge_blog_search_usage(usage_day,calls) values(d,1)
   on conflict(usage_day) do update set calls=keychallenge_blog_search_usage.calls+1;
  day_calls:=day_calls+1; month_calls:=month_calls+1;
 end if;
 return jsonb_build_object('allowed',reason is null,'reason',reason,'message',message,'retry_at',retry_at,
  'daily_used',day_calls,'monthly_used',month_calls,'daily_limit',s.daily_limit,'monthly_limit',s.monthly_limit,
  'configured',s.configured,'enabled',s.enabled,'free_confirmed_until',s.free_confirmed_until,
  'provider_limits_confirmed',s.provider_limits_confirmed,
  'valid_before',least(next_day-interval '5 minutes',s.free_confirmed_until,clock_timestamp()+interval '10 seconds'));
end $$;
revoke all on function public.keychallenge_blog_search_budget(text) from public,anon,authenticated;
grant execute on function public.keychallenge_blog_search_budget(text) to service_role;

create or replace function keychallenge_private.blog_credentials(p_value jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare secret_id uuid; value jsonb; s public.keychallenge_blog_search_status;
begin
 if p_value is not null then
  if coalesce(p_value->>'clientId','') !~ '^[A-Za-z0-9_-]{1,256}$'
   or coalesce(p_value->>'clientSecret','') !~ '^[A-Za-z0-9_-]{1,256}$'
   or p_value->>'provider' is distinct from 'naver_api_hub'
   or p_value->'freePolicyConfirmed' is distinct from 'true'::jsonb then raise exception 'Invalid connection or unconfirmed limits'; end if;
  select * into s from public.keychallenge_blog_search_status where singleton for update;
  if not found then raise exception 'Search limits unavailable'; end if;
  value:=jsonb_build_object('clientId',p_value->>'clientId','clientSecret',p_value->>'clientSecret');
  select id into secret_id from vault.secrets where name='keychallenge_blog_search_credentials';
  if secret_id is null then perform vault.create_secret(value::text,'keychallenge_blog_search_credentials');
  else perform vault.update_secret(secret_id,value::text); end if;
  update public.keychallenge_blog_search_status set configured=true,enabled=true,provider='naver_api_hub',
   provider_limits_confirmed=true,free_confirmed_until=now()+interval '30 days',updated_at=now(),
   stop_reason=case when blocked_until>now() then stop_reason else null end where singleton;
  update public.keychallenge_blog_monitors set status='queued',phase='rss',pending_ids='[]',attempts=0,
   next_attempt_at=now(),requested_at=now(),last_error=null where enabled and status<>'running';
  return '{"saved":true}';
 end if;
 if not exists(select 1 from public.keychallenge_blog_search_status where singleton and enabled and configured
  and provider_limits_confirmed and free_confirmed_until>now() and (blocked_until is null or blocked_until<=now())) then return null; end if;
 select decrypted_secret::jsonb into value from vault.decrypted_secrets where name='keychallenge_blog_search_credentials';
 return value;
end $$;
revoke all on function keychallenge_private.blog_credentials(jsonb) from public,anon,authenticated;
grant execute on function keychallenge_private.blog_credentials(jsonb) to service_role;

create or replace function public.keychallenge_blog_worker(p_action text,p_user uuid default null,p_lease uuid default null,p_data jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare m public.keychallenge_blog_monitors; d date:=(now() at time zone 'Asia/Seoul')::date; n integer; pid text;
begin
 if p_action='reserve' then
  return to_jsonb(coalesce((public.keychallenge_blog_search_budget('reserve')->>'allowed')::boolean,false));
 end if;
 if p_action='claim' then
  select * into m from public.keychallenge_blog_monitors where enabled and status in ('queued','running') and next_attempt_at<=now()
   and (lease_until is null or lease_until<now()) order by next_attempt_at,user_id limit 1 for update skip locked;
  if not found then return null; end if;
  update public.keychallenge_blog_monitors set status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes'
   where user_id=m.user_id returning * into m;
  return to_jsonb(m);
 end if;
 select * into m from public.keychallenge_blog_monitors where user_id=p_user and lease_token=p_lease and lease_until>now() and enabled and status='running' for update;
 if not found then raise exception 'Worker lease expired'; end if;
 if p_action='feed' then
  if jsonb_typeof(p_data->'items')<>'array' or jsonb_array_length(p_data->'items')>100 then raise exception 'Invalid feed'; end if;
  insert into public.keychallenge_blog_posts(user_id,blog_id,post_id,title,published_at)
  select m.user_id,m.blog_id,r.post_id,r.title,r.published_at from jsonb_to_recordset(p_data->'items') r(post_id text,title text,published_at timestamptz)
  on conflict(user_id,blog_id,post_id) do update set title=excluded.title,published_at=coalesce(excluded.published_at,keychallenge_blog_posts.published_at),last_seen_at=now();
  update public.keychallenge_blog_monitors set phase='search',rss_updated_at=now(),feed_count=jsonb_array_length(p_data->'items'),blog_title=left(p_data->>'title',200),
   pending_ids=coalesce((select jsonb_agg(post_id) from (select post_id from public.keychallenge_blog_posts where user_id=m.user_id and blog_id=m.blog_id order by published_at desc nulls last,first_seen_at desc,post_id desc limit 20) x),'[]'),
   attempts=0,last_error=null,lease_until=now()+interval '2 minutes' where user_id=m.user_id returning * into m;
 elsif p_action='check' then
  pid=m.pending_ids->>0;
  if pid is null or pid is distinct from p_data->>'post_id' or p_data->>'status' not in ('found','unconfirmed','error') then raise exception 'Invalid check'; end if;
  update public.keychallenge_blog_posts set check_status=p_data->>'status',checked_at=now(),evidence=p_data->'evidence',check_error=left(p_data->>'error',300),
   previous_result=case when p_data->>'status'='error' then previous_result else last_result end,
   last_result=case when p_data->>'status'='error' then last_result else p_data->>'status' end,
   last_result_at=case when p_data->>'status'='error' then last_result_at else now() end
   where user_id=m.user_id and blog_id=m.blog_id and post_id=pid;
  update public.keychallenge_blog_monitors set pending_ids=pending_ids-0,lease_until=now()+interval '2 minutes' where user_id=m.user_id returning * into m;
 elsif p_action='yield' then
  update public.keychallenge_blog_monitors set status='queued',lease_token=null,lease_until=null,next_attempt_at=now() where user_id=m.user_id returning * into m;
 elsif p_action='quota' then
  update public.keychallenge_blog_monitors set status='queued',lease_token=null,lease_until=null,
   next_attempt_at=greatest(coalesce((p_data->>'retry_at')::timestamptz,((d+1)::timestamp at time zone 'Asia/Seoul')+interval '5 minutes'),now()+interval '5 minutes'),
   last_error=left(coalesce(p_data->>'message','검색 점검을 일시 중지했습니다. 최근 글 수집은 계속됩니다.'),300) where user_id=m.user_id returning * into m;
 elsif p_action='finish' then
  update public.keychallenge_blog_monitors set status='succeeded',completed_at=now(),last_error=null,lease_token=null,lease_until=null,pending_ids='[]' where user_id=m.user_id returning * into m;
 elsif p_action='fail' then
  update public.keychallenge_blog_monitors set attempts=attempts+1,status=case when attempts>=2 then 'failed' else 'queued' end,
   last_error=left(p_data->>'error',300),next_attempt_at=now()+interval '5 minutes',lease_token=null,lease_until=null where user_id=m.user_id returning * into m;
 else raise exception 'Unknown worker action'; end if;
 return to_jsonb(m);
end $$;
revoke all on function public.keychallenge_blog_worker(text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.keychallenge_blog_worker(text,uuid,uuid,jsonb) to service_role;


-- Daily RSS collection continues even while search is deferred until next month.
create or replace function keychallenge_private.enqueue_blog_daily() returns void
language sql security invoker set search_path='' as $$
 update public.keychallenge_blog_monitors set status='queued',phase='rss',pending_ids='[]',attempts=0,last_error=null,
  requested_at=now(),next_attempt_at=now(),lease_token=null,lease_until=null
 where enabled and (lease_until is null or lease_until<now())
  and (status in ('succeeded','failed') or (status in ('queued','running') and
   (rss_updated_at is null or rss_updated_at<now()-interval '23 hours' or requested_at<now()-interval '25 hours')));
$$;
