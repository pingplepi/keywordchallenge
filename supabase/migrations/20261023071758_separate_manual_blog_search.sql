-- RSS and user-requested search have separate queues. No cron job creates search requests.
alter table public.keychallenge_blog_posts add column last_search_attempt_at timestamptz;
update public.keychallenge_blog_posts set last_search_attempt_at=checked_at where checked_at is not null;
create table public.keychallenge_blog_search_jobs (
 user_id uuid primary key references public.keychallenge_blog_monitors(user_id) on delete cascade,
 blog_id text not null, job_id uuid not null default gen_random_uuid(),
 status text not null default 'idle' check(status in ('idle','queued','running','succeeded','stopped','failed')),
 requested_at timestamptz, expires_at timestamptz, completed_at timestamptz,
 next_attempt_at timestamptz not null default now(), lease_token uuid, lease_until timestamptz,
 pending_ids jsonb not null default '[]' check(jsonb_typeof(pending_ids)='array' and jsonb_array_length(pending_ids)<=20),
 current_post_id text, reserved_queries jsonb not null default '[]' check(jsonb_typeof(reserved_queries)='array' and jsonb_array_length(reserved_queries)<=2),
 total_count integer not null default 0, completed_count integer not null default 0, last_error text
);
alter table public.keychallenge_blog_search_jobs enable row level security;
revoke all on public.keychallenge_blog_search_jobs from public,anon,authenticated;
grant select on public.keychallenge_blog_search_jobs to authenticated;
grant all on public.keychallenge_blog_search_jobs to service_role;
create policy "Read own requested blog checks" on public.keychallenge_blog_search_jobs
 for select to authenticated using(user_id=(select auth.uid()));
create index keychallenge_blog_search_jobs_due on public.keychallenge_blog_search_jobs(next_attempt_at)
 where status in ('queued','running');

create function keychallenge_private.reset_blog_search() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.blog_id is distinct from old.blog_id then
  update public.keychallenge_blog_search_jobs set blog_id=new.blog_id,status='idle',job_id=gen_random_uuid(),
   requested_at=null,expires_at=null,completed_at=null,pending_ids='[]',current_post_id=null,reserved_queries='[]',
   lease_token=null,lease_until=null,total_count=0,completed_count=0,last_error=null where user_id=new.user_id;
 end if;
 return new;
end $$;
revoke all on function keychallenge_private.reset_blog_search() from public,anon,authenticated;
create trigger reset_blog_search after update of blog_id on public.keychallenge_blog_monitors
 for each row execute function keychallenge_private.reset_blog_search();

create function keychallenge_private.request_blog_search() returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); m public.keychallenge_blog_monitors; j public.keychallenge_blog_search_jobs; ids jsonb;
begin
 if uid is null then raise exception '로그인이 필요합니다.'; end if;
 select * into m from public.keychallenge_blog_monitors where user_id=uid for update;
 if not found then raise exception '내 설정에서 블로그 주소를 먼저 등록해 주세요.'; end if;
 if not exists(select 1 from public.keychallenge_blog_search_status where singleton and configured and enabled
   and provider_limits_confirmed and free_confirmed_until>now() and (blocked_until is null or blocked_until<=now())) then
  raise exception '검색 API 연결 또는 무료 한도 보호로 현재 점검할 수 없습니다. 안내 메시지를 확인해 주세요.';
 end if;
 insert into public.keychallenge_blog_search_jobs(user_id,blog_id) values(uid,m.blog_id) on conflict(user_id) do nothing;
 select * into j from public.keychallenge_blog_search_jobs where user_id=uid for update;
 if j.status in ('queued','running') and j.expires_at>now() then return jsonb_build_object('queued',true,'already_queued',true); end if;
 if j.requested_at>now()-interval '1 hour' then raise exception '검색 점검 요청은 1시간마다 가능합니다. 최근 결과를 확인해 주세요.'; end if;
 select coalesce(jsonb_agg(post_id order by published_at desc nulls last,first_seen_at desc,post_id desc),'[]') into ids
 from (select * from public.keychallenge_blog_posts where user_id=uid and blog_id=m.blog_id
   order by published_at desc nulls last,first_seen_at desc,post_id desc limit 20) p
 where coalesce(last_search_attempt_at,checked_at) is null or coalesce(last_search_attempt_at,checked_at)<=now()-interval '24 hours';
 if jsonb_array_length(ids)=0 then raise exception '점검할 글이 없습니다. 최근 글 20개 중 24시간 내 점검한 글은 제외합니다.'; end if;
 update public.keychallenge_blog_search_jobs set blog_id=m.blog_id,job_id=gen_random_uuid(),status='queued',
  requested_at=now(),expires_at=now()+interval '1 hour',completed_at=null,next_attempt_at=now(),
  lease_token=null,lease_until=null,pending_ids=ids,current_post_id=null,reserved_queries='[]',
  total_count=jsonb_array_length(ids),completed_count=0,last_error=null where user_id=uid;
 return jsonb_build_object('queued',true,'total',jsonb_array_length(ids));
end $$;
revoke all on function keychallenge_private.request_blog_search() from public,anon;
grant execute on function keychallenge_private.request_blog_search() to authenticated;
create function public.keychallenge_request_blog_search() returns jsonb
language sql security invoker set search_path='' as $$ select keychallenge_private.request_blog_search(); $$;
revoke all on function public.keychallenge_request_blog_search() from public,anon;
grant execute on function public.keychallenge_request_blog_search() to authenticated;

create function keychallenge_private.blog_search_budget(p_action text default 'status') returns jsonb
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
  when 'daily_limit' then '오늘의 공용 검색 한도에 도달했습니다. 다음 날 한도 초기화 후 검색 점검 버튼으로 다시 요청해 주세요.'
  when 'monthly_limit' then '이번 달 공용 검색 한도에 도달했습니다. 다음 달 한도 초기화 후 검색 점검 버튼으로 다시 요청해 주세요.'
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
revoke all on function keychallenge_private.blog_search_budget(text) from public,anon,authenticated;
grant execute on function keychallenge_private.blog_search_budget(text) to service_role;


create or replace function public.keychallenge_blog_search_budget(p_action text default 'status') returns jsonb
language plpgsql security invoker set search_path='' as $$
begin
 if p_action='reserve' then
  return jsonb_build_object('allowed',false,'reason','manual_only','message','검색 노출 점검 버튼으로 요청한 작업만 실행할 수 있습니다.');
 end if;
 return keychallenge_private.blog_search_budget(p_action);
end $$;
revoke all on function public.keychallenge_blog_search_budget(text) from public,anon,authenticated;
grant execute on function public.keychallenge_blog_search_budget(text) to service_role;


create function public.keychallenge_blog_search_worker(p_action text,p_user uuid default null,p_job uuid default null,p_lease uuid default null,p_data jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare j public.keychallenge_blog_search_jobs; p public.keychallenge_blog_posts; reservation jsonb; q text; pid text;
begin
 if p_action='claim' then
  select * into j from public.keychallenge_blog_search_jobs where status in ('queued','running')
   and next_attempt_at<=now() and (lease_until is null or lease_until<now())
   order by next_attempt_at,user_id limit 1 for update skip locked;
  if not found then return null; end if;
  if j.expires_at<=now() or not exists(select 1 from public.keychallenge_blog_monitors m where m.user_id=j.user_id and m.blog_id=j.blog_id) then
   update public.keychallenge_blog_search_jobs set status='stopped',pending_ids='[]',current_post_id=null,reserved_queries='[]',
    lease_token=null,lease_until=null,last_error='요청 유효 시간이 지났습니다. 필요할 때 검색 점검 버튼을 다시 눌러 주세요.'
    where user_id=j.user_id;
   return null;
  end if;
  update public.keychallenge_blog_search_jobs set status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes'
   where user_id=j.user_id returning * into j;
  return to_jsonb(j);
 end if;
 select * into j from public.keychallenge_blog_search_jobs where user_id=p_user and job_id=p_job and lease_token=p_lease
  and lease_until>now() and expires_at>now() and status='running' for update;
 if not found then raise exception 'Search request lease expired'; end if;
 if not exists(select 1 from public.keychallenge_blog_monitors m where m.user_id=j.user_id and m.blog_id=j.blog_id) then raise exception 'Blog changed'; end if;
 if p_action='next' then
  -- A crashed worker must not replay a search it already reserved.
  if j.current_post_id is not null and jsonb_array_length(j.reserved_queries)>0 then
   update public.keychallenge_blog_posts set check_status='error',checked_at=now(),
    check_error='이전 점검이 중단되어 결과를 확인하지 못했습니다. 같은 글은 24시간 뒤 다시 점검할 수 있습니다.'
    where user_id=j.user_id and blog_id=j.blog_id and post_id=j.current_post_id;
  end if;
  j.current_post_id:=null; j.reserved_queries:='[]';
  while jsonb_array_length(j.pending_ids)>0 loop
   pid:=j.pending_ids->>0; j.pending_ids:=j.pending_ids-0;
   select * into p from public.keychallenge_blog_posts where user_id=j.user_id and blog_id=j.blog_id and post_id=pid;
   if found and (coalesce(p.last_search_attempt_at,p.checked_at) is null or coalesce(p.last_search_attempt_at,p.checked_at)<=now()-interval '24 hours') then
    j.current_post_id:=pid; exit;
   end if;
  end loop;
  update public.keychallenge_blog_search_jobs set pending_ids=j.pending_ids,current_post_id=j.current_post_id,reserved_queries='[]',
   lease_until=now()+interval '2 minutes' where user_id=j.user_id returning * into j;
  return to_jsonb(j)||jsonb_build_object('post',case when j.current_post_id is null then null else jsonb_build_object('post_id',p.post_id,'title',p.title) end);
 elsif p_action='reserve' then
  q:=p_data->>'query';
  if j.current_post_id is null or p_data->>'post_id' is distinct from j.current_post_id or q is null or length(q) not between 1 and 180 then raise exception 'Invalid search request'; end if;
  if jsonb_array_length(j.reserved_queries)>=2 or j.reserved_queries ? q then
   return jsonb_build_object('allowed',false,'message','중복 검색 요청을 차단했습니다. 기존 결과를 확인해 주세요.');
  end if;
  select * into p from public.keychallenge_blog_posts where user_id=j.user_id and blog_id=j.blog_id and post_id=j.current_post_id for update;
  if not found then raise exception 'Post no longer exists'; end if;
  if jsonb_array_length(j.reserved_queries)=0 and coalesce(p.last_search_attempt_at,p.checked_at)>now()-interval '24 hours' then
   return jsonb_build_object('allowed',false,'message','24시간 이내 같은 글의 중복 점검을 차단했습니다.');
  end if;
  reservation:=keychallenge_private.blog_search_budget('reserve');
  if coalesce((reservation->>'allowed')::boolean,false) then
   update public.keychallenge_blog_posts set last_search_attempt_at=now() where user_id=j.user_id and blog_id=j.blog_id and post_id=j.current_post_id;
   update public.keychallenge_blog_search_jobs set reserved_queries=reserved_queries||jsonb_build_array(q),lease_until=now()+interval '2 minutes' where user_id=j.user_id;
  end if;
  return reservation;
 elsif p_action='check' then
  if j.current_post_id is null or p_data->>'post_id' is distinct from j.current_post_id or p_data->>'status' not in ('found','unconfirmed','error')
   or jsonb_typeof(p_data->'evidence') is distinct from 'array' or jsonb_array_length(p_data->'evidence')>2 then raise exception 'Invalid search result'; end if;
  update public.keychallenge_blog_posts set check_status=p_data->>'status',checked_at=now(),evidence=p_data->'evidence',check_error=left(p_data->>'error',300),
   previous_result=case when p_data->>'status'='error' then previous_result else last_result end,
   last_result=case when p_data->>'status'='error' then last_result else p_data->>'status' end,
   last_result_at=case when p_data->>'status'='error' then last_result_at else now() end
   where user_id=j.user_id and blog_id=j.blog_id and post_id=j.current_post_id;
  update public.keychallenge_blog_search_jobs set current_post_id=null,reserved_queries='[]',completed_count=completed_count+1,
   lease_until=now()+interval '2 minutes' where user_id=j.user_id returning * into j;
 elsif p_action='yield' then
  update public.keychallenge_blog_search_jobs set status='queued',lease_token=null,lease_until=null,next_attempt_at=now()
   where user_id=j.user_id returning * into j;
 elsif p_action='finish' then
  if j.current_post_id is not null or jsonb_array_length(j.pending_ids)>0 then raise exception 'Search request unfinished'; end if;
  update public.keychallenge_blog_search_jobs set status='succeeded',completed_at=now(),last_error=null,lease_token=null,lease_until=null
   where user_id=j.user_id returning * into j;
 elsif p_action in ('stop','fail') then
  if j.current_post_id is not null and jsonb_array_length(j.reserved_queries)>0 then
   update public.keychallenge_blog_posts set check_status='error',checked_at=now(),
    check_error=left(coalesce(p_data->>'message','점검이 중단되었습니다. 기존 확인 결과를 유지합니다.'),300)
    where user_id=j.user_id and blog_id=j.blog_id and post_id=j.current_post_id;
  end if;
  update public.keychallenge_blog_search_jobs set status=case when p_action='stop' then 'stopped' else 'failed' end,
   last_error=left(coalesce(p_data->>'message','점검을 완료하지 못했습니다. 나중에 버튼을 눌러 다시 요청해 주세요.'),300),
   pending_ids='[]',current_post_id=null,reserved_queries='[]',lease_token=null,lease_until=null,completed_at=now()
   where user_id=j.user_id returning * into j;
 else raise exception 'Unknown search worker action'; end if;
 return to_jsonb(j);
end $$;
revoke all on function public.keychallenge_blog_search_worker(text,uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.keychallenge_blog_search_worker(text,uuid,uuid,uuid,jsonb) to service_role;

-- PostgreSQL repetition bounds stop at 255; validate the 256-character cap separately.
create or replace function keychallenge_private.blog_credentials(p_value jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare secret_id uuid; value jsonb; s public.keychallenge_blog_search_status;
begin
 if p_value is not null then
  if length(coalesce(p_value->>'clientId','')) not between 1 and 256
   or length(coalesce(p_value->>'clientSecret','')) not between 1 and 256
   or coalesce(p_value->>'clientId','') !~ '^[A-Za-z0-9_-]+$'
   or coalesce(p_value->>'clientSecret','') !~ '^[A-Za-z0-9_-]+$'
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
  return '{"saved":true}';
 end if;
 if not exists(select 1 from public.keychallenge_blog_search_status where singleton and enabled and configured
  and provider_limits_confirmed and free_confirmed_until>now() and (blocked_until is null or blocked_until<=now())) then return null; end if;
 select decrypted_secret::jsonb into value from vault.decrypted_secrets where name='keychallenge_blog_search_credentials';
 return value;
end $$;
revoke all on function keychallenge_private.blog_credentials(jsonb) from public,anon,authenticated;
grant execute on function keychallenge_private.blog_credentials(jsonb) to service_role;


create or replace function public.keychallenge_blog_dashboard(p_query text default '',p_status text default '',p_page integer default 1) returns jsonb
language sql stable security invoker set search_path='' as $$
 with m as(select * from public.keychallenge_blog_monitors where user_id=(select auth.uid())),
 all_posts as materialized(select p.* from public.keychallenge_blog_posts p,m where p.user_id=(select auth.uid()) and p.blog_id=m.blog_id),
 recent as(select * from all_posts order by published_at desc nulls last,first_seen_at desc,post_id desc limit 20),
 filtered as(select * from all_posts where (p_query='' or strpos(lower(title),lower(left(p_query,100)))>0)
  and (p_status='' or check_status=p_status)),
 rows as(select * from filtered order by published_at desc nulls last,first_seen_at desc,post_id desc limit 20 offset (least(greatest(p_page,1),10000)-1)*20),
 daily as(select (published_at at time zone 'Asia/Seoul')::date as day,count(*) as count from all_posts where published_at>=(((now() at time zone 'Asia/Seoul')::date-27)::timestamp at time zone 'Asia/Seoul') group by 1),
 intervals as(select published_at-lag(published_at) over(order by published_at) gap from recent where published_at is not null)
 select jsonb_build_object('monitor',(select to_jsonb(m)-'lease_token'-'lease_until'-'pending_ids' from m),
  'search_job',(select to_jsonb(j)-'lease_token'-'lease_until'-'pending_ids'-'reserved_queries'-'current_post_id' from public.keychallenge_blog_search_jobs j where user_id=(select auth.uid())),
  'search_eligible',(select count(*) from recent where coalesce(last_search_attempt_at,checked_at) is null or coalesce(last_search_attempt_at,checked_at)<=now()-interval '24 hours'),
  'search_recheck_at',(select min(coalesce(last_search_attempt_at,checked_at)+interval '24 hours') from recent where coalesce(last_search_attempt_at,checked_at)>now()-interval '24 hours'),
  'connection',(select to_jsonb(s) from public.keychallenge_blog_search_status s where singleton),
  'total',(select count(*) from all_posts),'matched_total',(select count(*) from filtered),
  'recent_total',(select count(*) from recent),'found',(select count(*) from recent where check_status='found'),
  'unconfirmed',(select count(*) from recent where check_status='unconfirmed'),'pending',(select count(*) from recent where check_status='pending'),
  'errors',(select count(*) from recent where check_status='error'),
  'new_today',(select count(*) from all_posts where first_seen_at>=(date_trunc('day',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul')),
  'latest_post',(select max(published_at) from all_posts),'oldest_post',(select min(published_at) from all_posts),
  'average_gap_days',(select round(avg(extract(epoch from gap))/86400,1) from intervals where gap>interval '0 seconds'),
  'days',coalesce((select jsonb_agg(to_jsonb(daily) order by day) from daily),'[]'),
  'items',coalesce((select jsonb_agg(to_jsonb(rows)) from rows),'[]'));
$$;
revoke all on function public.keychallenge_blog_dashboard(text,text,integer) from public,anon;
grant execute on function public.keychallenge_blog_dashboard(text,text,integer) to authenticated;


-- Retire all automatic search work; RSS and past search results are preserved.
update public.keychallenge_blog_monitors set phase='rss',pending_ids='[]',lease_token=null,lease_until=null,
 status=case when enabled and status in ('queued','running') then 'queued' else status end,
 next_attempt_at=now(),last_error=null where phase<>'rss' or status in ('queued','running');

create or replace function public.keychallenge_blog_worker(p_action text,p_user uuid default null,p_lease uuid default null,p_data jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare m public.keychallenge_blog_monitors;
begin
 if p_action='reserve' then return 'false'::jsonb; end if;
 if p_action='claim' then
  select * into m from public.keychallenge_blog_monitors where enabled and status in ('queued','running') and next_attempt_at<=now()
   and (lease_until is null or lease_until<now()) order by next_attempt_at,user_id limit 1 for update skip locked;
  if not found then return null; end if;
  update public.keychallenge_blog_monitors set status='running',phase='rss',pending_ids='[]',lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes'
   where user_id=m.user_id returning * into m;
  return to_jsonb(m);
 end if;
 select * into m from public.keychallenge_blog_monitors where user_id=p_user and lease_token=p_lease and lease_until>now() and enabled and status='running' for update;
 if not found then raise exception 'Worker lease expired'; end if;
 if p_action='feed' then
  if jsonb_typeof(p_data->'items') is distinct from 'array' or jsonb_array_length(p_data->'items')>100 then raise exception 'Invalid feed'; end if;
  insert into public.keychallenge_blog_posts(user_id,blog_id,post_id,title,published_at)
  select m.user_id,m.blog_id,r.post_id,r.title,r.published_at from jsonb_to_recordset(p_data->'items') r(post_id text,title text,published_at timestamptz)
  on conflict(user_id,blog_id,post_id) do update set title=excluded.title,published_at=coalesce(excluded.published_at,keychallenge_blog_posts.published_at),last_seen_at=now();
  update public.keychallenge_blog_monitors set phase='rss',pending_ids='[]',rss_updated_at=now(),feed_count=jsonb_array_length(p_data->'items'),
   blog_title=left(p_data->>'title',200),attempts=0,last_error=null,lease_until=now()+interval '2 minutes' where user_id=m.user_id returning * into m;
 elsif p_action in ('finish','quota') then
  update public.keychallenge_blog_monitors set status='succeeded',completed_at=now(),last_error=null,lease_token=null,lease_until=null,pending_ids='[]'
   where user_id=m.user_id returning * into m;
 elsif p_action='fail' then
  update public.keychallenge_blog_monitors set attempts=attempts+1,status=case when attempts>=2 then 'failed' else 'queued' end,
   last_error=left(p_data->>'error',300),next_attempt_at=now()+interval '5 minutes',lease_token=null,lease_until=null
   where user_id=m.user_id returning * into m;
 else raise exception 'RSS worker does not perform search'; end if;
 return to_jsonb(m);
end $$;
revoke all on function public.keychallenge_blog_worker(text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.keychallenge_blog_worker(text,uuid,uuid,jsonb) to service_role;

create or replace function keychallenge_private.enqueue_blog_daily() returns void
language sql security invoker set search_path='' as $$
 update public.keychallenge_blog_monitors set status='queued',phase='rss',pending_ids='[]',attempts=0,last_error=null,
  requested_at=now(),next_attempt_at=now(),lease_token=null,lease_until=null
 where enabled and (lease_until is null or lease_until<now())
  and (status in ('succeeded','failed') or (status in ('queued','running') and
   (rss_updated_at is null or rss_updated_at<now()-interval '23 hours' or requested_at<now()-interval '25 hours')));
$$;

create or replace function keychallenge_private.dispatch_blog() returns void
language plpgsql security invoker set search_path='' as $$
declare rss_slots integer; search_slots integer; i integer; token text;
begin
 select least(count(*),2)::integer into rss_slots from public.keychallenge_blog_monitors
  where enabled and status in ('queued','running') and next_attempt_at<=now() and (lease_until is null or lease_until<now());
 select least(count(*),2)::integer into search_slots from public.keychallenge_blog_search_jobs
  where status in ('queued','running') and next_attempt_at<=now() and (lease_until is null or lease_until<now());
 if rss_slots+search_slots=0 then return; end if;
 select decrypted_secret into token from vault.decrypted_secrets where name='keychallenge_daily_sync_token';
 for i in 1..rss_slots loop
  perform net.http_post(url:='https://vuatuabiueppcdbdootw.supabase.co/functions/v1/keychallenge-blog-sync',
   headers:=jsonb_build_object('Content-Type','application/json','x-keychallenge-token',token),
   body:='{"kind":"rss"}'::jsonb,timeout_milliseconds:=90000);
 end loop;
 for i in 1..search_slots loop
  perform net.http_post(url:='https://vuatuabiueppcdbdootw.supabase.co/functions/v1/keychallenge-blog-sync',
   headers:=jsonb_build_object('Content-Type','application/json','x-keychallenge-token',token),
   body:='{"kind":"search"}'::jsonb,timeout_milliseconds:=90000);
 end loop;
end $$;
revoke all on function keychallenge_private.enqueue_blog_daily(),keychallenge_private.dispatch_blog() from public,anon,authenticated;
