-- Daily RSS for every linked blog; three manual search batches per account and KST day.
create table public.keychallenge_blog_check_usage (
 user_id uuid not null references auth.users(id) on delete cascade,
 usage_day date not null, checks integer not null default 0 check(checks between 0 and 3),
 primary key(user_id,usage_day)
);
alter table public.keychallenge_blog_check_usage enable row level security;
revoke all on public.keychallenge_blog_check_usage from public,anon,authenticated;
grant select on public.keychallenge_blog_check_usage to authenticated;
grant all on public.keychallenge_blog_check_usage to service_role;
create policy "Read own daily blog check usage" on public.keychallenge_blog_check_usage
 for select to authenticated using(user_id=(select auth.uid()));

alter table public.keychallenge_blog_search_jobs
 add column phase text not null default 'search' check(phase in ('rss','search')),
 add column counted_day date;

-- Existing disabled monitors also receive the requested daily default.
update public.keychallenge_blog_monitors set enabled=true,status='queued',phase='rss',pending_ids='[]',
 attempts=0,last_error=null,requested_at=now(),next_attempt_at=now(),lease_token=null,lease_until=null
 where not enabled or status='paused';

create or replace function keychallenge_private.blog_control(p_enabled boolean default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.keychallenge_blog_monitors; uid uuid:=auth.uid();
begin
 if uid is null then raise exception '로그인이 필요합니다.'; end if;
 select * into m from public.keychallenge_blog_monitors where user_id=uid for update;
 if not found then return jsonb_build_object('linked',false); end if;
 -- The legacy parameter remains compatible, but daily collection is always enabled.
 if m.enabled and m.status in ('queued','running') then return jsonb_build_object('queued',true,'already_queued',true); end if;
 if m.enabled and greatest(m.rss_updated_at,m.requested_at)>clock_timestamp()-interval '1 minute' then
  return jsonb_build_object('fresh',true);
 end if;
 update public.keychallenge_blog_monitors set enabled=true,status='queued',phase='rss',pending_ids='[]',attempts=0,last_error=null,
  requested_at=now(),next_attempt_at=now(),lease_token=null,lease_until=null where user_id=uid;
 return jsonb_build_object('queued',true);
end $$;
revoke all on function keychallenge_private.blog_control(boolean) from public,anon;
grant execute on function keychallenge_private.blog_control(boolean) to authenticated;

create or replace function keychallenge_private.reset_blog_search() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.blog_id is distinct from old.blog_id then
  update public.keychallenge_blog_search_jobs set blog_id=new.blog_id,status='idle',job_id=gen_random_uuid(),
   phase='rss',counted_day=null,requested_at=null,expires_at=null,completed_at=null,pending_ids='[]',current_post_id=null,reserved_queries='[]',
   lease_token=null,lease_until=null,total_count=0,completed_count=0,last_error=null where user_id=new.user_id;
 end if;
 return new;
end $$;
revoke all on function keychallenge_private.reset_blog_search() from public,anon,authenticated;
create or replace function keychallenge_private.request_blog_search() returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); m public.keychallenge_blog_monitors; j public.keychallenge_blog_search_jobs; used integer; d date;
begin
 if uid is null then raise exception '로그인이 필요합니다.'; end if;
 select * into m from public.keychallenge_blog_monitors where user_id=uid for update;
 if not found then raise exception '내 설정에서 블로그 주소를 먼저 등록해 주세요.'; end if;
 insert into public.keychallenge_blog_search_jobs(user_id,blog_id) values(uid,m.blog_id) on conflict(user_id) do nothing;
 select * into j from public.keychallenge_blog_search_jobs where user_id=uid for update;
 if j.status in ('queued','running') and j.expires_at>clock_timestamp() then
  return jsonb_build_object('queued',true,'already_queued',true);
 end if;
 d:=(clock_timestamp() at time zone 'Asia/Seoul')::date;
 select checks into used from public.keychallenge_blog_check_usage where user_id=uid and usage_day=d;
 if coalesce(used,0)>=3 then raise exception '오늘의 검색 점검 3회를 모두 사용했습니다. 한국시간 자정 이후 다시 이용해 주세요.'; end if;
 if not exists(select 1 from public.keychallenge_blog_search_status where singleton and configured and enabled
   and provider_limits_confirmed and free_confirmed_until>clock_timestamp() and (blocked_until is null or blocked_until<=clock_timestamp())) then
  raise exception '검색 API 연결 또는 무료 한도 보호로 현재 점검할 수 없습니다. 안내 메시지를 확인해 주세요.';
 end if;
 update public.keychallenge_blog_search_jobs set blog_id=m.blog_id,job_id=gen_random_uuid(),status='queued',phase='rss',counted_day=null,
  requested_at=now(),expires_at=now()+interval '1 hour',completed_at=null,next_attempt_at=now(),
  lease_token=null,lease_until=null,pending_ids='[]',current_post_id=null,reserved_queries='[]',
  total_count=0,completed_count=0,last_error=null where user_id=uid;
 return jsonb_build_object('queued',true,'refreshing',true,'daily_used',coalesce(used,0),'daily_limit',3);
end $$;
revoke all on function keychallenge_private.request_blog_search() from public,anon;
grant execute on function keychallenge_private.request_blog_search() to authenticated;

create or replace function public.keychallenge_blog_search_worker(p_action text,p_user uuid default null,p_job uuid default null,p_lease uuid default null,p_data jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare j public.keychallenge_blog_search_jobs; p public.keychallenge_blog_posts; reservation jsonb; q text; pid text; ids jsonb; d date; used integer;
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
 -- Match the monitor -> job -> post lock order used by profile changes and RSS.
 perform 1 from public.keychallenge_blog_monitors where user_id=p_user for update;
 select * into j from public.keychallenge_blog_search_jobs where user_id=p_user and job_id=p_job and lease_token=p_lease
  and lease_until>now() and expires_at>now() and status='running' for update;
 if not found then raise exception 'Search request lease expired'; end if;
 if not exists(select 1 from public.keychallenge_blog_monitors m where m.user_id=j.user_id and m.blog_id=j.blog_id) then raise exception 'Blog changed'; end if;
 if p_action='feed' then
  if j.phase<>'rss' or jsonb_typeof(p_data->'items') is distinct from 'array' or jsonb_array_length(p_data->'items')>100 then raise exception 'Invalid feed'; end if;
  insert into public.keychallenge_blog_posts(user_id,blog_id,post_id,title,published_at)
  select j.user_id,j.blog_id,r.post_id,r.title,r.published_at from jsonb_to_recordset(p_data->'items') r(post_id text,title text,published_at timestamptz)
  on conflict(user_id,blog_id,post_id) do update set title=excluded.title,published_at=coalesce(excluded.published_at,keychallenge_blog_posts.published_at),last_seen_at=now();
  update public.keychallenge_blog_monitors set rss_updated_at=now(),feed_count=jsonb_array_length(p_data->'items'),
   blog_title=left(p_data->>'title',200),last_error=null where user_id=j.user_id and blog_id=j.blog_id;
  select coalesce(jsonb_agg(post_id order by published_at desc nulls last,first_seen_at desc,post_id desc),'[]') into ids
   from (select * from public.keychallenge_blog_posts where user_id=j.user_id and blog_id=j.blog_id
    order by published_at desc nulls last,first_seen_at desc,post_id desc limit 20) p;
  update public.keychallenge_blog_search_jobs set phase='search',pending_ids=ids,total_count=jsonb_array_length(ids),
   lease_until=now()+interval '2 minutes' where user_id=j.user_id returning * into j;
 elsif p_action='next' then
  if j.phase<>'search' then raise exception 'Refresh posts before search'; end if;
  -- A crashed worker must not replay a search it already reserved.
  if j.current_post_id is not null and jsonb_array_length(j.reserved_queries)>0 then
   update public.keychallenge_blog_posts set check_status='error',checked_at=now(),
    check_error='이전 점검이 중단되어 결과를 확인하지 못했습니다. 남은 횟수 내에서 다시 점검할 수 있습니다.'
    where user_id=j.user_id and blog_id=j.blog_id and post_id=j.current_post_id;
  elsif j.current_post_id is not null then
   -- No call was reserved: retry this post after a worker interruption.
   j.pending_ids:=jsonb_build_array(j.current_post_id)||j.pending_ids;
  end if;
  j.current_post_id:=null; j.reserved_queries:='[]';
  while jsonb_array_length(j.pending_ids)>0 loop
   pid:=j.pending_ids->>0; j.pending_ids:=j.pending_ids-0;
   select * into p from public.keychallenge_blog_posts where user_id=j.user_id and blog_id=j.blog_id and post_id=pid;
   if found then
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
  -- Count a batch once, immediately before its first permitted Search API call.
  -- Usage is account-scoped and survives blog changes and reconnects.
  if j.counted_day is null then
   d:=(clock_timestamp() at time zone 'Asia/Seoul')::date;
   insert into public.keychallenge_blog_check_usage(user_id,usage_day) values(j.user_id,d) on conflict do nothing;
   select checks into used from public.keychallenge_blog_check_usage where user_id=j.user_id and usage_day=d for update;
   if used>=3 then
    return jsonb_build_object('allowed',false,'reason','account_daily_limit',
     'message','오늘의 검색 점검 3회를 모두 사용했습니다. 한국시간 자정 이후 다시 이용해 주세요.');
   end if;
  end if;
  reservation:=keychallenge_private.blog_search_budget('reserve');
  if coalesce((reservation->>'allowed')::boolean,false) then
   if j.counted_day is null then
    if d is distinct from (clock_timestamp() at time zone 'Asia/Seoul')::date then
     raise exception '날짜가 변경되었습니다. 검색 점검 버튼을 다시 눌러 주세요.';
    end if;
    update public.keychallenge_blog_check_usage set checks=checks+1 where user_id=j.user_id and usage_day=d;
    update public.keychallenge_blog_search_jobs set counted_day=d where user_id=j.user_id;
   end if;
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
  'search_eligible',(select count(*) from recent),
  'daily_check_used',coalesce((select checks from public.keychallenge_blog_check_usage
   where user_id=(select auth.uid()) and usage_day=(now() at time zone 'Asia/Seoul')::date),0),
  'daily_check_limit',3,
  'daily_check_reset_at',(((now() at time zone 'Asia/Seoul')::date+1)::timestamp at time zone 'Asia/Seoul'),
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


