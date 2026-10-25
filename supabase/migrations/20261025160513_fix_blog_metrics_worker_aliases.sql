create or replace function public.keychallenge_blog_metrics_worker(p_action text,p_user uuid default null,p_blog text default null,p_post text default null,p_lease uuid default null,p_data jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare j keychallenge_private.blog_metrics_jobs; post_row public.keychallenge_blog_posts; monitor_row public.keychallenge_blog_monitors;
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
  select * into post_row from public.keychallenge_blog_posts where user_id=j.user_id and blog_id=j.blog_id and post_id=j.post_id;
  return to_jsonb(j)||jsonb_build_object('title',post_row.title);
 end if;
 -- Follow the monitor -> job -> post lock order used by other collectors.
 select * into monitor_row from public.keychallenge_blog_monitors where user_id=p_user and blog_id=p_blog for update;
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
