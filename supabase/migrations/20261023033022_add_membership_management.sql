-- Membership is independent of workspace type and administrator privileges.
-- Default limits preserve the existing free service: 100 new lookups/day,
-- ten upstream lookups/minute, and no cap on saved work or connected profiles.
create schema keychallenge_membership_private;
revoke all on schema keychallenge_membership_private from public,anon,authenticated;
grant usage on schema keychallenge_membership_private to authenticated,service_role;

create table keychallenge_membership_private.plans (
  code text primary key check(code in ('basic','plus')),
  daily_search integer check(daily_search between 0 and 1000000),
  saved_keywords integer check(saved_keywords between 0 and 1000000),
  publishing_plans integer check(publishing_plans between 0 and 1000000),
  influencer_profiles integer check(influencer_profiles between 0 and 1000000),
  revision integer not null default 1,
  updated_at timestamptz not null default now()
);
insert into keychallenge_membership_private.plans(code,daily_search) values('basic',100),('plus',100);
create table keychallenge_membership_private.accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tier text not null default 'basic' references keychallenge_membership_private.plans(code),
  starts_on date, expires_on date,
  admin_note text not null default '' check(length(admin_note)<=2000),
  revision integer not null default 1,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(tier<>'basic' or (starts_on is null and expires_on is null)),
  check(expires_on is null or (starts_on is not null and expires_on>=starts_on)),
  check(tier<>'plus' or starts_on is not null)
);
insert into keychallenge_membership_private.accounts(user_id) select id from auth.users where deleted_at is null;
create table keychallenge_membership_private.audit (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  action text not null check(action in ('member','limits')),
  tier text not null,
  before_value jsonb not null, after_value jsonb not null,
  reason text not null check(length(trim(reason)) between 1 and 300),
  created_at timestamptz not null default now()
);
create index membership_audit_member_date_idx on keychallenge_membership_private.audit(user_id,created_at desc);
create index membership_audit_actor_idx on keychallenge_membership_private.audit(actor_id);
create index membership_audit_date_idx on keychallenge_membership_private.audit(created_at desc);
create index membership_accounts_tier_idx on keychallenge_membership_private.accounts(tier,expires_on);
alter table keychallenge_membership_private.plans enable row level security;
alter table keychallenge_membership_private.accounts enable row level security;
alter table keychallenge_membership_private.audit enable row level security;
revoke all on all tables in schema keychallenge_membership_private from public,anon,authenticated,service_role;
revoke all on all sequences in schema keychallenge_membership_private from public,anon,authenticated,service_role;

create function keychallenge_membership_private.effective_tier(p_tier text,p_start date,p_end date) returns text
language sql stable security invoker set search_path='' as $$
  select case when p_tier='plus' and p_start<=(now() at time zone 'Asia/Seoul')::date
    and (p_end is null or p_end>=(now() at time zone 'Asia/Seoul')::date) then 'plus' else 'basic' end;
$$;
create function keychallenge_membership_private.limits_for(p_user uuid) returns keychallenge_membership_private.plans
language sql stable security invoker set search_path='' as $$
  select p.* from keychallenge_membership_private.plans p where p.code=coalesce((select
    keychallenge_membership_private.effective_tier(a.tier,a.starts_on,a.expires_on)
    from keychallenge_membership_private.accounts a where a.user_id=p_user),'basic');
$$;
create function keychallenge_membership_private.member_status(p_user uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('tier',l.code,'assigned_tier',coalesce(a.tier,'basic'),
    'starts_on',a.starts_on,'expires_on',a.expires_on,'revision',coalesce(a.revision,0),
    'state',case when a.tier='plus' and a.starts_on>(now() at time zone 'Asia/Seoul')::date then 'scheduled'
      when a.tier='plus' and a.expires_on<(now() at time zone 'Asia/Seoul')::date then 'expired'
      when l.code='plus' then 'active' else 'basic' end,
    'limits',jsonb_build_object('daily_search',l.daily_search,'saved_keywords',l.saved_keywords,
      'publishing_plans',l.publishing_plans,'influencer_profiles',l.influencer_profiles),
    'usage',jsonb_build_object('daily_search',coalesce((select u.day_count from public.keychallenge_keyword_lookup_usage u
      where u.user_id=p_user and u.usage_day=(now() at time zone 'Asia/Seoul')::date),0),
      'saved_keywords',(select count(*) from public.keychallenge_blog_keywords k where k.user_id=p_user and not k.archived),
      'publishing_plans',(select count(*) from public.keychallenge_blog_plans b where b.user_id=p_user and not b.archived),
      'influencer_profiles',(select count(*) from public.keychallenge_profiles p where p.user_id=p_user)))
  from keychallenge_membership_private.limits_for(p_user) l
  left join keychallenge_membership_private.accounts a on a.user_id=p_user;
$$;

-- No public view exposes auth.users or operator notes. Only the checked API below reads it.
create view keychallenge_membership_private.member_directory with(security_invoker=true) as
select u.id user_id,u.email,u.created_at joined_at,u.last_sign_in_at,u.email_confirmed_at,
  m.mode,m.blog_id,m.interest,coalesce(a.tier,'basic') assigned_tier,a.starts_on,a.expires_on,
  keychallenge_membership_private.effective_tier(a.tier,a.starts_on,a.expires_on) tier,
  case when a.tier='plus' and a.starts_on>(now() at time zone 'Asia/Seoul')::date then 'scheduled'
    when a.tier='plus' and a.expires_on<(now() at time zone 'Asia/Seoul')::date then 'expired'
    when a.tier='plus' then 'active' else 'basic' end membership_state,
  exists(select 1 from public.keychallenge_admins ad where ad.user_id=u.id) is_admin
from auth.users u left join public.keychallenge_members m on m.user_id=u.id
left join keychallenge_membership_private.accounts a on a.user_id=u.id where u.deleted_at is null;
revoke all on keychallenge_membership_private.member_directory from public,anon,authenticated,service_role;

-- This is the only client-callable privileged entry point. Every action checks
-- the authenticated user; all administrative actions check the existing DB role.
create function keychallenge_membership_private.api(p_action text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); target uuid; requested_tier text; effective text; start_day date; end_day date;
  note text; why text; expected_revision integer; before_row jsonb; after_row jsonb; output jsonb;
  account keychallenge_membership_private.accounts; limits keychallenge_membership_private.plans;
  query_text text; tier_filter text; page_number integer; limit_names text[]:=array['daily_search','saved_keywords','publishing_plans','influencer_profiles']; item text;
begin
  if actor is null or not exists(select 1 from auth.users where id=actor and deleted_at is null) then
    raise exception using errcode='42501',message='로그인 후 이용해 주세요.';
  end if;
  if jsonb_typeof(p_input)<>'object' or p_input is null or length(p_input::text)>12000 then raise exception '요청 내용을 확인해 주세요.'; end if;
  if p_action in ('self','can_connect') then
    insert into keychallenge_membership_private.accounts(user_id) values(actor) on conflict do nothing;
    if p_action='self' then return keychallenge_membership_private.member_status(actor); end if;
    select * into limits from keychallenge_membership_private.limits_for(actor);
    return jsonb_build_object('allowed',limits.influencer_profiles is null or
      exists(select 1 from public.keychallenge_profiles where user_id=actor and influencer_id=p_input->>'influencer_id') or
      (select count(*) from public.keychallenge_profiles where user_id=actor)<limits.influencer_profiles);
  end if;
  if not exists(select 1 from public.keychallenge_admins where user_id=actor) then
    raise exception using errcode='42501',message='관리자만 회원 정보를 관리할 수 있습니다.';
  end if;
  if p_action='list' then
    query_text:=left(coalesce(p_input->>'query',''),100);tier_filter:=coalesce(p_input->>'tier','');
    page_number:=least(greatest(coalesce((p_input->>'page')::integer,1),1),10000);
    with matches as materialized(select * from keychallenge_membership_private.member_directory d
      where (query_text='' or strpos(lower(coalesce(d.email,'')||' '||coalesce(d.blog_id,'')),lower(query_text))>0)
        and (tier_filter='' or d.tier=tier_filter or (tier_filter='expired' and d.membership_state='expired'))),
    page_rows as(select * from matches order by joined_at desc,user_id limit 25 offset (page_number-1)*25)
    select jsonb_build_object('total',(select count(*) from matches),'items',coalesce((select jsonb_agg(to_jsonb(page_rows)) from page_rows),'[]'),
      'summary',(select jsonb_build_object('total',count(*),'basic',count(*) filter(where tier='basic'),
        'plus',count(*) filter(where tier='plus'),'unconfirmed',count(*) filter(where email_confirmed_at is null)) from keychallenge_membership_private.member_directory),
      'plans',(select jsonb_agg(to_jsonb(p) order by p.code) from keychallenge_membership_private.plans p),
      'changes',coalesce((select jsonb_agg(to_jsonb(x)) from (select a.id,a.tier,a.before_value,a.after_value,a.reason,a.created_at,u.email actor
        from keychallenge_membership_private.audit a left join auth.users u on u.id=a.actor_id where a.action='limits' order by a.created_at desc,a.id desc limit 10) x),'[]')) into output;
    return output;
  end if;
  if p_action in ('detail','save_member') then
    target:=(p_input->>'user_id')::uuid;
    if target is null or not exists(select 1 from auth.users where id=target and deleted_at is null) then raise exception '회원을 찾지 못했습니다.'; end if;
    insert into keychallenge_membership_private.accounts(user_id) values(target) on conflict do nothing;
    if p_action='detail' then
      select to_jsonb(d) into output from keychallenge_membership_private.member_directory d where d.user_id=target;
      return jsonb_build_object('member',output,'membership',keychallenge_membership_private.member_status(target),
        'admin_note',(select admin_note from keychallenge_membership_private.accounts where user_id=target),
        'profiles',coalesce((select jsonb_agg(influencer_id order by influencer_id) from public.keychallenge_profiles where user_id=target),'[]'),
        'history',coalesce((select jsonb_agg(to_jsonb(x)) from (select a.id,a.tier,a.before_value,a.after_value,a.reason,a.created_at,u.email actor
          from keychallenge_membership_private.audit a left join auth.users u on u.id=a.actor_id where a.user_id=target order by a.created_at desc,a.id desc limit 30) x),'[]'));
    end if;
    requested_tier:=p_input->>'tier'; start_day:=nullif(p_input->>'starts_on','')::date;end_day:=nullif(p_input->>'expires_on','')::date;
    note:=coalesce(p_input->>'admin_note','');why:=trim(coalesce(p_input->>'reason',''));expected_revision:=(p_input->>'revision')::integer;
    if requested_tier is null or requested_tier not in ('basic','plus') or length(note)>2000 or length(why) not between 1 and 300 or expected_revision is null then raise exception '등급과 변경 사유를 확인해 주세요.'; end if;
    if requested_tier='basic' then start_day:=null;end_day:=null;
    elsif start_day is null or (end_day is not null and end_day<start_day) then raise exception '플러스 시작일과 만료일을 확인해 주세요.'; end if;
    select * into account from keychallenge_membership_private.accounts where user_id=target for update;
    if account.revision<>expected_revision then raise exception '다른 관리자가 변경한 내용이 있습니다. 회원 정보를 다시 열어 주세요.'; end if;
    before_row:=to_jsonb(account)-'created_at'-'updated_at';
    update keychallenge_membership_private.accounts set tier=requested_tier,starts_on=start_day,expires_on=end_day,admin_note=note,revision=revision+1,updated_at=now()
      where user_id=target returning to_jsonb(accounts)-'created_at'-'updated_at' into after_row;
    insert into keychallenge_membership_private.audit(actor_id,user_id,action,tier,before_value,after_value,reason)
      values(actor,target,'member',requested_tier,before_row,after_row,why);
    return jsonb_build_object('ok',true);
  end if;
  if p_action='save_limits' then
    requested_tier:=p_input->>'tier';why:=trim(coalesce(p_input->>'reason',''));expected_revision:=(p_input->>'revision')::integer;
    if requested_tier is null or requested_tier not in ('basic','plus') or length(why) not between 1 and 300 or expected_revision is null then raise exception '등급과 변경 사유를 확인해 주세요.'; end if;
    foreach item in array limit_names loop
      if not (p_input ? item) or (p_input->item<>'null'::jsonb and (jsonb_typeof(p_input->item)<>'number' or (p_input->>item)!~'^[0-9]{1,7}$' or (p_input->>item)::integer>1000000)) then
        raise exception '한도는 0~1,000,000 사이 정수 또는 제한 없음으로 입력해 주세요.';
      end if;
    end loop;
    select * into limits from keychallenge_membership_private.plans where code=requested_tier for update;
    if limits.revision<>expected_revision then raise exception '다른 관리자가 한도를 변경했습니다. 목록을 새로 불러와 주세요.'; end if;
    before_row:=to_jsonb(limits)-'updated_at';
    update keychallenge_membership_private.plans set daily_search=(p_input->>'daily_search')::integer,saved_keywords=(p_input->>'saved_keywords')::integer,
      publishing_plans=(p_input->>'publishing_plans')::integer,influencer_profiles=(p_input->>'influencer_profiles')::integer,
      revision=revision+1,updated_at=now() where code=requested_tier returning to_jsonb(plans)-'updated_at' into after_row;
    insert into keychallenge_membership_private.audit(actor_id,action,tier,before_value,after_value,reason) values(actor,'limits',requested_tier,before_row,after_row,why);
    return jsonb_build_object('ok',true);
  end if;
  raise exception '지원하지 않는 회원 관리 요청입니다.';
end $$;
create function public.keychallenge_membership(p_action text default 'self',p_input jsonb default '{}') returns jsonb
language sql security invoker set search_path='' as $$ select keychallenge_membership_private.api(p_action,p_input); $$;

-- Enforce capacity on writes, including direct REST calls and restores. A row
-- lock serializes additions per account; existing records remain editable.
create function keychallenge_membership_private.enforce_capacity() returns trigger
language plpgsql security definer set search_path='' as $$
declare limits keychallenge_membership_private.plans; maximum integer; used bigint; label text;
begin
  if auth.uid() is not null and auth.uid()<>new.user_id then raise exception using errcode='42501',message='본인 데이터만 저장할 수 있습니다.'; end if;
  if tg_op='UPDATE' and new.user_id<>old.user_id then raise exception '데이터 소유자를 변경할 수 없습니다.'; end if;
  if tg_table_name='keychallenge_profiles' then
    if tg_op='UPDATE' or exists(select 1 from public.keychallenge_profiles where user_id=new.user_id and influencer_id=new.influencer_id) then return new; end if;
  else
    if new.archived then return new; end if;
    if tg_op='UPDATE' and not old.archived then return new; end if;
    if tg_op='INSERT' and tg_table_name='keychallenge_blog_keywords' then
      if exists(select 1 from public.keychallenge_blog_keywords where user_id=new.user_id and keyword_key=public.keychallenge_keyword_key(new.keyword) and not archived) then return new; end if;
    end if;
  end if;
  insert into keychallenge_membership_private.accounts(user_id) values(new.user_id) on conflict do nothing;
  perform 1 from keychallenge_membership_private.accounts where user_id=new.user_id for update;
  select * into limits from keychallenge_membership_private.limits_for(new.user_id);
  if tg_table_name='keychallenge_blog_keywords' then
    maximum:=limits.saved_keywords;label:='보관 키워드';
    if maximum is null then return new; end if;
    select count(*) into used from public.keychallenge_blog_keywords where user_id=new.user_id and not archived;
  elsif tg_table_name='keychallenge_blog_plans' then
    maximum:=limits.publishing_plans;label:='발행 계획';
    if maximum is null then return new; end if;
    select count(*) into used from public.keychallenge_blog_plans where user_id=new.user_id and not archived;
  else
    maximum:=limits.influencer_profiles;label:='연결 인플홈';
    if maximum is null then return new; end if;
    select count(*) into used from public.keychallenge_profiles where user_id=new.user_id;
  end if;
  if used>=maximum then raise exception '% 한도(%개)에 도달했습니다. 내 이용 등급에서 한도를 확인해 주세요.',label,maximum; end if;
  return new;
end $$;
create trigger membership_capacity before insert or update on public.keychallenge_blog_keywords for each row execute function keychallenge_membership_private.enforce_capacity();
create trigger membership_capacity before insert or update on public.keychallenge_blog_plans for each row execute function keychallenge_membership_private.enforce_capacity();
create trigger membership_capacity before insert or update on public.keychallenge_profiles for each row execute function keychallenge_membership_private.enforce_capacity();

create function keychallenge_membership_private.claim_lookup(p_user_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare u public.keychallenge_keyword_lookup_usage; limits keychallenge_membership_private.plans;
  today_kst date:=(now() at time zone 'Asia/Seoul')::date; minute_bucket timestamptz:=date_trunc('minute',now());
begin
  insert into keychallenge_membership_private.accounts(user_id) values(p_user_id) on conflict do nothing;
  perform 1 from keychallenge_membership_private.accounts where user_id=p_user_id for update;
  select * into limits from keychallenge_membership_private.limits_for(p_user_id);
  insert into public.keychallenge_keyword_lookup_usage(user_id,usage_day,minute_start) values(p_user_id,today_kst,minute_bucket) on conflict do nothing;
  select * into u from public.keychallenge_keyword_lookup_usage where user_id=p_user_id for update;
  if u.usage_day<>today_kst then u.day_count:=0; end if;
  if u.minute_start<>minute_bucket then u.minute_count:=0; end if;
  if (limits.daily_search is not null and u.day_count>=limits.daily_search) or u.minute_count>=10 then return false; end if;
  update public.keychallenge_keyword_lookup_usage set usage_day=today_kst,day_count=u.day_count+1,minute_start=minute_bucket,minute_count=u.minute_count+1 where user_id=p_user_id;
  return true;
end $$;
create or replace function public.keychallenge_claim_keyword_lookup(p_user_id uuid) returns boolean
language sql security invoker set search_path='' as $$ select keychallenge_membership_private.claim_lookup(p_user_id); $$;

-- Private helpers and trigger functions are not callable by browser roles.
revoke all on all functions in schema keychallenge_membership_private from public,anon,authenticated,service_role;
grant execute on function keychallenge_membership_private.api(text,jsonb) to authenticated;
grant execute on function keychallenge_membership_private.claim_lookup(uuid) to service_role;
revoke all on function public.keychallenge_membership(text,jsonb) from public,anon,authenticated;
grant execute on function public.keychallenge_membership(text,jsonb) to authenticated;
revoke all on function public.keychallenge_claim_keyword_lookup(uuid) from public,anon,authenticated;
grant execute on function public.keychallenge_claim_keyword_lookup(uuid) to service_role;
