-- Keep authentication sessions and observed product activity in separate records.
create table keychallenge_membership_private.member_activity (
  session_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_active_at timestamptz not null,
  created_at timestamptz not null default now()
);
insert into keychallenge_membership_private.member_activity(session_id,user_id,last_active_at,created_at)
  select session_id,user_id,last_active_at,created_at from keychallenge_membership_private.member_sessions;
create index member_activity_user_time_idx on keychallenge_membership_private.member_activity(user_id,last_active_at desc);
alter table keychallenge_membership_private.member_activity enable row level security;
revoke all on keychallenge_membership_private.member_activity from public,anon,authenticated,service_role;
create or replace view keychallenge_membership_private.member_directory with(security_invoker=true) as
select u.id user_id,u.email,u.created_at joined_at,u.last_sign_in_at,u.email_confirmed_at,
  m.mode,m.blog_id,m.interest,coalesce(a.tier,'basic') assigned_tier,a.starts_on,a.expires_on,
  keychallenge_membership_private.effective_tier(a.tier,a.starts_on,a.expires_on) tier,
  case when a.tier='plus' and a.starts_on>(now() at time zone 'Asia/Seoul')::date then 'scheduled'
    when a.tier='plus' and a.expires_on<(now() at time zone 'Asia/Seoul')::date then 'expired'
    when a.tier='plus' then 'active' else 'basic' end membership_state,
  exists(select 1 from public.keychallenge_admins ad where ad.user_id=u.id) is_admin,
  coalesce(logins.login_count,0)::bigint login_count,activity.last_active_at
from auth.users u
left join public.keychallenge_members m on m.user_id=u.id
left join keychallenge_membership_private.accounts a on a.user_id=u.id
left join lateral (
  select count(*) filter(where signed_in_at is not null) login_count,max(signed_in_at) last_login_at
  from keychallenge_membership_private.member_sessions s where s.user_id=u.id
) logins on true
left join lateral (
  select max(last_active_at) last_active_at from keychallenge_membership_private.member_activity x where x.user_id=u.id
) activity on true
where u.deleted_at is null;
revoke all on keychallenge_membership_private.member_directory from public,anon,authenticated,service_role;
alter table keychallenge_membership_private.member_sessions drop column last_active_at;

create or replace function public.keychallenge_record_member_activity(p_event text default 'active') returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); sid uuid; event_time timestamptz:=now();
begin
  if actor is null then raise exception using errcode='42501',message='로그인 후 이용해 주세요.'; end if;
  if p_event not in ('restore','signed_in','active') then raise exception '지원하지 않는 활동 기록 요청입니다.'; end if;
  begin sid:=nullif(auth.jwt()->>'session_id','')::uuid; exception when others then sid:=null; end;
  if sid is null then raise exception using errcode='42501',message='로그인 세션을 확인할 수 없습니다.'; end if;
  if p_event='signed_in' then
    insert into keychallenge_membership_private.member_sessions(session_id,user_id,signed_in_at)
      values(sid,actor,event_time)
      on conflict(session_id) do update set signed_in_at=coalesce(keychallenge_membership_private.member_sessions.signed_in_at,excluded.signed_in_at);
  end if;
  insert into keychallenge_membership_private.member_activity(session_id,user_id,last_active_at)
    values(sid,actor,event_time)
    on conflict(session_id) do update set last_active_at=event_time
      where keychallenge_membership_private.member_activity.last_active_at<event_time-interval '1 minute';
  return jsonb_build_object('ok',true);
end $$;
revoke all on function public.keychallenge_record_member_activity(text) from public,anon,authenticated,service_role;
grant execute on function public.keychallenge_record_member_activity(text) to authenticated;

create or replace function public.keychallenge_admin_member_activity(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); result jsonb;
begin
  if actor is null or not exists(select 1 from public.keychallenge_admins where user_id=actor) then
    raise exception using errcode='42501',message='관리자만 회원 활동 기록을 확인할 수 있습니다.';
  end if;
  if p_user_id is null or not exists(select 1 from auth.users where id=p_user_id and deleted_at is null) then raise exception '회원을 찾지 못했습니다.'; end if;
  select jsonb_build_object(
    'login_count',(select count(*) from keychallenge_membership_private.member_sessions where user_id=p_user_id and signed_in_at is not null),
    'last_login_at',(select max(signed_in_at) from keychallenge_membership_private.member_sessions where user_id=p_user_id),
    'last_active_at',(select max(last_active_at) from keychallenge_membership_private.member_activity where user_id=p_user_id),
    'sessions',coalesce((
      select jsonb_agg(jsonb_build_object('signed_in_at',x.signed_in_at,'last_active_at',x.last_active_at) order by coalesce(x.last_active_at,x.signed_in_at) desc)
      from (
        select activity_rows.* from (
          select s.signed_in_at,a.last_active_at from keychallenge_membership_private.member_sessions s
            left join keychallenge_membership_private.member_activity a on a.session_id=s.session_id and a.user_id=s.user_id
            where s.user_id=p_user_id
          union all
          select null::timestamptz,x.last_active_at from keychallenge_membership_private.member_activity x
            where x.user_id=p_user_id and not exists(select 1 from keychallenge_membership_private.member_sessions s where s.session_id=x.session_id)
        ) activity_rows order by coalesce(activity_rows.last_active_at,activity_rows.signed_in_at) desc limit 20
      ) x
    ),'[]'::jsonb)
  ) into result;
  return result;
end $$;
revoke all on function public.keychallenge_admin_member_activity(uuid) from public,anon,authenticated,service_role;
grant execute on function public.keychallenge_admin_member_activity(uuid) to authenticated;

select cron.unschedule(jobid) from cron.job where jobname='keychallenge-prune-member-activity';
select cron.schedule('keychallenge-prune-member-activity','17 18 * * *',
  'delete from keychallenge_membership_private.member_activity where last_active_at<now()-interval ''1 year''');
select cron.schedule('keychallenge-prune-member-sessions','18 18 * * *',
  'delete from keychallenge_membership_private.member_sessions where signed_in_at<now()-interval ''1 year''');
