-- Recent public posts only. Search results are observations, never an indexing verdict.
create table public.keychallenge_blog_monitors (
 user_id uuid primary key references auth.users(id) on delete cascade,
 blog_id text not null check(blog_id ~ '^[a-z0-9][a-z0-9_-]{1,49}$'),
 enabled boolean not null default true,
 status text not null default 'queued' check(status in ('queued','running','succeeded','failed','paused')),
 phase text not null default 'rss', pending_ids jsonb not null default '[]',
 requested_at timestamptz not null default now(), next_attempt_at timestamptz not null default now(),
 lease_token uuid, lease_until timestamptz, attempts integer not null default 0,
 rss_updated_at timestamptz, completed_at timestamptz, last_error text,
 feed_count integer not null default 0, blog_title text,
 created_at timestamptz not null default now()
);
create index keychallenge_blog_monitors_due on public.keychallenge_blog_monitors(next_attempt_at) where status in ('queued','running');
create table public.keychallenge_blog_posts (
 user_id uuid not null references auth.users(id) on delete cascade,
 blog_id text not null, post_id text not null check(post_id ~ '^[0-9]{1,30}$'),
 title text not null check(length(title)<=500), published_at timestamptz,
 first_seen_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
 check_status text not null default 'pending' check(check_status in ('pending','found','unconfirmed','error')),
 checked_at timestamptz, last_result text, previous_result text, last_result_at timestamptz,
 evidence jsonb not null default '[]', check_error text,
 primary key(user_id,blog_id,post_id)
);
create index keychallenge_blog_posts_recent on public.keychallenge_blog_posts(user_id,blog_id,published_at desc nulls last,first_seen_at desc);
create table public.keychallenge_blog_search_status (
 singleton boolean primary key default true check(singleton), configured boolean not null default false,
 enabled boolean not null default false, updated_at timestamptz not null default now()
);
insert into public.keychallenge_blog_search_status(singleton) values(true);
create table public.keychallenge_blog_search_usage (
 usage_day date primary key, calls integer not null default 0
);
do $$ declare t text; begin
 foreach t in array array['keychallenge_blog_monitors','keychallenge_blog_posts','keychallenge_blog_search_status','keychallenge_blog_search_usage'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;
grant select on public.keychallenge_blog_monitors,public.keychallenge_blog_posts,public.keychallenge_blog_search_status to authenticated;
create policy "Read own blog monitor" on public.keychallenge_blog_monitors for select to authenticated using(user_id=(select auth.uid()));
create policy "Read own blog posts" on public.keychallenge_blog_posts for select to authenticated using(user_id=(select auth.uid()));
create policy "Read connection availability" on public.keychallenge_blog_search_status for select to authenticated using(true);

create function keychallenge_private.connect_blog_monitor() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.blog_id is null then delete from public.keychallenge_blog_monitors where user_id=new.user_id; return new; end if;
 insert into public.keychallenge_blog_monitors(user_id,blog_id) values(new.user_id,new.blog_id)
 on conflict(user_id) do update set blog_id=excluded.blog_id,enabled=true,status='queued',phase='rss',pending_ids='[]',
 requested_at=now(),next_attempt_at=now(),lease_token=null,lease_until=null,attempts=0,rss_updated_at=null,
 completed_at=null,last_error=null,feed_count=0,blog_title=null
 where keychallenge_blog_monitors.blog_id is distinct from excluded.blog_id;
 return new;
end $$;
revoke all on function keychallenge_private.connect_blog_monitor() from public,anon,authenticated;
create trigger connect_blog_monitor after insert or update of blog_id on public.keychallenge_members for each row execute function keychallenge_private.connect_blog_monitor();
insert into public.keychallenge_blog_monitors(user_id,blog_id) select user_id,blog_id from public.keychallenge_members where blog_id is not null;

create function keychallenge_private.blog_control(p_enabled boolean default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.keychallenge_blog_monitors; uid uuid:=auth.uid();
begin
 if uid is null then raise exception '로그인이 필요합니다.'; end if;
 select * into m from public.keychallenge_blog_monitors where user_id=uid for update;
 if not found then raise exception '내 설정에서 블로그 주소를 먼저 등록해 주세요.'; end if;
 if p_enabled is false then
  update public.keychallenge_blog_monitors set enabled=false,status='paused',lease_token=null,lease_until=null where user_id=uid;
 elsif p_enabled is true and not m.enabled then
  update public.keychallenge_blog_monitors set enabled=true,status='queued',phase='rss',pending_ids='[]',attempts=0,last_error=null,
   requested_at=now(),next_attempt_at=now(),lease_token=null,lease_until=null where user_id=uid;
 elsif p_enabled is null then
  if not m.enabled then raise exception '자동 갱신을 켠 뒤 다시 요청해 주세요.'; end if;
  if m.status in ('queued','running') then return jsonb_build_object('queued',true); end if;
  if m.requested_at>now()-interval '1 hour' then raise exception '수동 갱신은 1시간마다 요청할 수 있습니다. 매일 자동으로도 갱신됩니다.'; end if;
  update public.keychallenge_blog_monitors set status='queued',phase='rss',pending_ids='[]',attempts=0,last_error=null,
   requested_at=now(),next_attempt_at=now(),lease_token=null,lease_until=null where user_id=uid;
 end if;
 return jsonb_build_object('saved',true);
end $$;
revoke all on function keychallenge_private.blog_control(boolean) from public,anon;
grant usage on schema keychallenge_private to authenticated;
grant execute on function keychallenge_private.blog_control(boolean) to authenticated;
create function public.keychallenge_blog_control(p_enabled boolean default null) returns jsonb
language sql security invoker set search_path='' as $$ select keychallenge_private.blog_control(p_enabled); $$;
revoke all on function public.keychallenge_blog_control(boolean) from public,anon;
grant execute on function public.keychallenge_blog_control(boolean) to authenticated;

create function public.keychallenge_blog_dashboard(p_query text default '',p_status text default '',p_page integer default 1) returns jsonb
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

-- Vault is accessible only through this service-role entry point.
create function keychallenge_private.blog_credentials(p_value jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare secret_id uuid; value jsonb;
begin
 if p_value is not null then
  if length(p_value->>'clientId') not between 1 and 256 or length(p_value->>'clientSecret') not between 1 and 256
   or not(p_value ? 'clientId' and p_value ? 'clientSecret') then raise exception 'Invalid credentials'; end if;
  select id into secret_id from vault.secrets where name='keychallenge_blog_search_credentials';
  if secret_id is null then perform vault.create_secret(p_value::text,'keychallenge_blog_search_credentials');
  else perform vault.update_secret(secret_id,p_value::text); end if;
  update public.keychallenge_blog_search_status set configured=true,enabled=true,updated_at=now() where singleton;
  update public.keychallenge_blog_monitors set status='queued',phase='rss',pending_ids='[]',attempts=0,next_attempt_at=now(),last_error=null
   where enabled and status not in ('queued','running');
  return '{"saved":true}';
 end if;
 if not exists(select 1 from public.keychallenge_blog_search_status where singleton and enabled and configured) then return null; end if;
 select decrypted_secret::jsonb into value from vault.decrypted_secrets where name='keychallenge_blog_search_credentials';
 return value;
end $$;
revoke all on function keychallenge_private.blog_credentials(jsonb) from public,anon,authenticated;
grant usage on schema keychallenge_private to service_role;
grant execute on function keychallenge_private.blog_credentials(jsonb) to service_role;
create function public.keychallenge_blog_credentials(p_value jsonb default null) returns jsonb
language sql security invoker set search_path='' as $$ select keychallenge_private.blog_credentials(p_value); $$;
revoke all on function public.keychallenge_blog_credentials(jsonb) from public,anon,authenticated;
grant execute on function public.keychallenge_blog_credentials(jsonb) to service_role;

create function public.keychallenge_blog_worker(p_action text,p_user uuid default null,p_lease uuid default null,p_data jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare m public.keychallenge_blog_monitors; d date:=(now() at time zone 'Asia/Seoul')::date; n integer; pid text;
begin
 if p_action='reserve' then
  insert into public.keychallenge_blog_search_usage(usage_day,calls) values(d,1)
  on conflict(usage_day) do update set calls=keychallenge_blog_search_usage.calls+1 where keychallenge_blog_search_usage.calls<20000 returning calls into n;
  return to_jsonb(n is not null);
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
   next_attempt_at=((d+1)::timestamp at time zone 'Asia/Seoul')+interval '5 minutes',last_error='오늘의 공용 검색 조회 한도에 도달해 다음 날 이어서 확인합니다.' where user_id=m.user_id returning * into m;
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

create function keychallenge_private.enqueue_blog_daily() returns void
language sql security invoker set search_path='' as $$
 update public.keychallenge_blog_monitors set status='queued',phase='rss',pending_ids='[]',attempts=0,last_error=null,
  requested_at=now(),next_attempt_at=now(),lease_token=null,lease_until=null
 where enabled and (status in ('succeeded','failed') or (status in ('queued','running') and requested_at<now()-interval '25 hours'));
$$;
create function keychallenge_private.dispatch_blog() returns void
language plpgsql security invoker set search_path='' as $$
declare slots integer; i integer;
begin
 select least(count(*),3)::integer into slots from public.keychallenge_blog_monitors where enabled and status in ('queued','running') and next_attempt_at<=now() and (lease_until is null or lease_until<now());
 for i in 1..slots loop
  perform net.http_post(url:='https://vuatuabiueppcdbdootw.supabase.co/functions/v1/keychallenge-blog-sync',
   headers:=jsonb_build_object('Content-Type','application/json','x-keychallenge-token',(select decrypted_secret from vault.decrypted_secrets where name='keychallenge_daily_sync_token')),
   body:='{}'::jsonb,timeout_milliseconds:=90000);
 end loop;
end $$;
revoke all on function keychallenge_private.enqueue_blog_daily(),keychallenge_private.dispatch_blog() from public,anon,authenticated;
-- 04:30 KST. Only pending work invokes the worker.
select cron.schedule('keychallenge-blog-daily','30 19 * * *','select keychallenge_private.enqueue_blog_daily();');
select cron.schedule('keychallenge-blog-worker','* * * * *','select keychallenge_private.dispatch_blog();');
