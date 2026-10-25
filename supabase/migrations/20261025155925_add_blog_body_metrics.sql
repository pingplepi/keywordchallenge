-- Body statistics are private to the post owner; search quotas and search jobs are unchanged.
alter table public.keychallenge_blog_posts
 add column body_metrics_status text not null default 'pending' check (body_metrics_status in ('pending','queued','ready','unavailable')),
 add column body_metrics jsonb,
 add column body_metrics_at timestamptz,
 add column body_metrics_attempted_at timestamptz,
 add column body_metrics_title text,
 add column body_metrics_error text;

create table keychallenge_private.blog_metrics_jobs (
 user_id uuid not null, blog_id text not null, post_id text not null,
 queued_at timestamptz not null default now(), lease_token uuid, lease_until timestamptz,
 attempts integer not null default 0,
 primary key(user_id,blog_id,post_id),
 foreign key(user_id,blog_id,post_id) references public.keychallenge_blog_posts(user_id,blog_id,post_id) on delete cascade
);
revoke all on keychallenge_private.blog_metrics_jobs from public,anon,authenticated;
grant select,insert,update,delete on keychallenge_private.blog_metrics_jobs to service_role;

create function keychallenge_private.request_blog_metrics(p_post_ids text[]) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); m public.keychallenge_blog_monitors; n integer;
begin
 if uid is null then raise exception '로그인이 필요합니다.'; end if;
 if coalesce(array_length(p_post_ids,1),0) not between 1 and 20 then raise exception '최대 20개 글을 요청할 수 있습니다.'; end if;
 select * into m from public.keychallenge_blog_monitors where user_id=uid for update;
 if not found then return jsonb_build_object('queued',0); end if;
 with candidates as (
  select p.user_id,p.blog_id,p.post_id from public.keychallenge_blog_posts p
  where p.user_id=uid and p.blog_id=m.blog_id and p.post_id=any(p_post_ids)
   and (p.body_metrics_attempted_at is null or
    p.body_metrics_attempted_at < now()-case when p.body_metrics_status='unavailable' then interval '1 hour' else interval '24 hours' end)
 ), added as (
  insert into keychallenge_private.blog_metrics_jobs(user_id,blog_id,post_id)
   select * from candidates on conflict do nothing returning *
 )
 update public.keychallenge_blog_posts p set body_metrics_status='queued',body_metrics_error=null
 from added a where p.user_id=a.user_id and p.blog_id=a.blog_id and p.post_id=a.post_id;
 get diagnostics n=row_count;
 return jsonb_build_object('queued',n);
end $$;
revoke all on function keychallenge_private.request_blog_metrics(text[]) from public,anon;
grant execute on function keychallenge_private.request_blog_metrics(text[]) to authenticated;
create function public.keychallenge_request_blog_metrics(p_post_ids text[]) returns jsonb
language sql security invoker set search_path='' as $$ select keychallenge_private.request_blog_metrics(p_post_ids); $$;
revoke all on function public.keychallenge_request_blog_metrics(text[]) from public,anon;
grant execute on function public.keychallenge_request_blog_metrics(text[]) to authenticated;

create function public.keychallenge_blog_metrics_worker(p_action text,p_user uuid default null,p_blog text default null,p_post text default null,p_lease uuid default null,p_data jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare j keychallenge_private.blog_metrics_jobs; p public.keychallenge_blog_posts; m public.keychallenge_blog_monitors;
begin
 if p_action='claim' then
  with expired as (
   delete from keychallenge_private.blog_metrics_jobs where attempts>=3 and lease_until<now() returning *
  )
  update public.keychallenge_blog_posts p set body_metrics_status='unavailable',body_metrics_attempted_at=now(),
   body_metrics_error='본문 집계가 중단되었습니다. 1시간 후 분석 화면을 열면 다시 시도합니다.'
  from expired e where p.user_id=e.user_id and p.blog_id=e.blog_id and p.post_id=e.post_id;
  select q.* into j from keychallenge_private.blog_metrics_jobs q
   join public.keychallenge_blog_monitors m on m.user_id=q.user_id and m.blog_id=q.blog_id
   where (q.lease_until is null or q.lease_until<now()) and q.attempts<3
   order by q.queued_at,q.user_id,q.post_id limit 1 for update of q skip locked;
  if not found then return null; end if;
  update keychallenge_private.blog_metrics_jobs set lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',attempts=attempts+1
   where user_id=j.user_id and blog_id=j.blog_id and post_id=j.post_id returning * into j;
  select * into p from public.keychallenge_blog_posts where user_id=j.user_id and blog_id=j.blog_id and post_id=j.post_id;
  return to_jsonb(j)||jsonb_build_object('title',p.title);
 end if;
 -- Follow the monitor -> job -> post lock order used by other collectors.
 select * into m from public.keychallenge_blog_monitors where user_id=p_user and blog_id=p_blog for update;
 if not found then return jsonb_build_object('discarded',true); end if;
 select * into j from keychallenge_private.blog_metrics_jobs where user_id=p_user and blog_id=p_blog and post_id=p_post
  and lease_token=p_lease and lease_until>now() for update;
 if not found then raise exception 'Metrics lease expired'; end if;
 if p_action='finish' then
  if p_data->>'status'='ready' then
   if jsonb_typeof(p_data->'metrics') is distinct from 'object'
    or coalesce((p_data->'metrics'->>'characters_with_spaces')::integer,-1) not between 0 and 2000000
    or coalesce((p_data->'metrics'->>'characters_without_spaces')::integer,-1) not between 0 and (p_data->'metrics'->>'characters_with_spaces')::integer
    or coalesce((p_data->'metrics'->>'images')::integer,-1) not between 0 and 10000
    then raise exception 'Invalid body metrics'; end if;
   update public.keychallenge_blog_posts set body_metrics_status='ready',body_metrics=p_data->'metrics',
    body_metrics_at=now(),body_metrics_attempted_at=now(),body_metrics_title=left(p_data->>'title',500),body_metrics_error=null
    where user_id=j.user_id and blog_id=j.blog_id and post_id=j.post_id;
  elsif p_data->>'status'='unavailable' then
   update public.keychallenge_blog_posts set body_metrics_status='unavailable',body_metrics_attempted_at=now(),
    body_metrics_error=left(p_data->>'error',200)
    where user_id=j.user_id and blog_id=j.blog_id and post_id=j.post_id;
  else raise exception 'Invalid metrics status'; end if;
  delete from keychallenge_private.blog_metrics_jobs where user_id=j.user_id and blog_id=j.blog_id and post_id=j.post_id;
 else raise exception 'Invalid metrics action'; end if;
 return jsonb_build_object('saved',true);
end $$;
revoke all on function public.keychallenge_blog_metrics_worker(text,uuid,text,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.keychallenge_blog_metrics_worker(text,uuid,text,text,uuid,jsonb) to service_role;

create or replace function keychallenge_private.dispatch_blog() returns void
language plpgsql security invoker set search_path='' as $$
declare rss_slots integer; search_slots integer; metrics_slots integer; i integer; token text;
begin
 select least(count(*),2)::integer into rss_slots from public.keychallenge_blog_monitors
  where enabled and status in ('queued','running') and next_attempt_at<=now() and (lease_until is null or lease_until<now());
 select least(count(*),2)::integer into search_slots from public.keychallenge_blog_search_jobs
  where status in ('queued','running') and next_attempt_at<=now() and (lease_until is null or lease_until<now());
 select least(count(*),2)::integer into metrics_slots from keychallenge_private.blog_metrics_jobs q
  join public.keychallenge_blog_monitors m on m.user_id=q.user_id and m.blog_id=q.blog_id
  where q.lease_until is null or q.lease_until<now();
 if rss_slots+search_slots+metrics_slots=0 then return; end if;
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
 for i in 1..metrics_slots loop
  perform net.http_post(url:='https://vuatuabiueppcdbdootw.supabase.co/functions/v1/keychallenge-blog-sync',
   headers:=jsonb_build_object('Content-Type','application/json','x-keychallenge-token',token),
   body:='{"kind":"metrics"}'::jsonb,timeout_milliseconds:=90000);
 end loop;
end $$;
