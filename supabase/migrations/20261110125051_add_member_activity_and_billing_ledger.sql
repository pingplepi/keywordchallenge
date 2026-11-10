-- Coarse member activity and an admin-entered payment/refund ledger.
-- Session IDs remain private; no password, token, IP address, or card data is stored.
create table keychallenge_membership_private.member_sessions (
  session_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  signed_in_at timestamptz,
  last_active_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index member_sessions_user_login_idx on keychallenge_membership_private.member_sessions(user_id,signed_in_at desc) where signed_in_at is not null;
create index member_sessions_user_activity_idx on keychallenge_membership_private.member_sessions(user_id,last_active_at desc);
alter table keychallenge_membership_private.member_sessions enable row level security;
revoke all on keychallenge_membership_private.member_sessions from public,anon,authenticated,service_role;

create table keychallenge_membership_private.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  paid_at timestamptz not null,
  amount_krw bigint not null check(amount_krw between 1 and 1000000000),
  service_starts_on date not null,
  service_ends_on date not null,
  transaction_reference text not null default '' check(length(transaction_reference)<=100),
  note text not null default '' check(length(note)<=1000),
  recorded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check(service_ends_on>=service_starts_on)
);
create index member_payments_user_date_idx on keychallenge_membership_private.payments(user_id,paid_at desc);
alter table keychallenge_membership_private.payments enable row level security;
revoke all on keychallenge_membership_private.payments from public,anon,authenticated,service_role;

create table keychallenge_membership_private.refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references keychallenge_membership_private.payments(id) on delete restrict,
  refunded_at timestamptz not null,
  amount_krw bigint not null check(amount_krw between 1 and 1000000000),
  reason text not null check(length(trim(reason)) between 1 and 300),
  recorded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index member_refunds_payment_date_idx on keychallenge_membership_private.refunds(payment_id,refunded_at desc);
alter table keychallenge_membership_private.refunds enable row level security;
revoke all on keychallenge_membership_private.refunds from public,anon,authenticated,service_role;

create table keychallenge_membership_private.billing_audit (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  payment_id uuid references keychallenge_membership_private.payments(id) on delete set null,
  action text not null check(action in ('payment_recorded','refund_recorded')),
  before_value jsonb,
  after_value jsonb not null,
  reason text not null check(length(trim(reason)) between 1 and 300),
  created_at timestamptz not null default now()
);
create index member_billing_audit_user_date_idx on keychallenge_membership_private.billing_audit(user_id,created_at desc);
alter table keychallenge_membership_private.billing_audit enable row level security;
revoke all on keychallenge_membership_private.billing_audit from public,anon,authenticated,service_role;

create or replace view keychallenge_membership_private.member_directory with(security_invoker=true) as
select u.id user_id,u.email,u.created_at joined_at,u.last_sign_in_at,u.email_confirmed_at,
  m.mode,m.blog_id,m.interest,coalesce(a.tier,'basic') assigned_tier,a.starts_on,a.expires_on,
  keychallenge_membership_private.effective_tier(a.tier,a.starts_on,a.expires_on) tier,
  case when a.tier='plus' and a.starts_on>(now() at time zone 'Asia/Seoul')::date then 'scheduled'
    when a.tier='plus' and a.expires_on<(now() at time zone 'Asia/Seoul')::date then 'expired'
    when a.tier='plus' then 'active' else 'basic' end membership_state,
  exists(select 1 from public.keychallenge_admins ad where ad.user_id=u.id) is_admin,
  coalesce(activity.login_count,0)::bigint login_count,activity.last_active_at
from auth.users u
left join public.keychallenge_members m on m.user_id=u.id
left join keychallenge_membership_private.accounts a on a.user_id=u.id
left join lateral (
  select count(*) filter(where signed_in_at is not null) login_count,max(last_active_at) last_active_at
  from keychallenge_membership_private.member_sessions s where s.user_id=u.id
) activity on true
where u.deleted_at is null;
revoke all on keychallenge_membership_private.member_directory from public,anon,authenticated,service_role;

create function public.keychallenge_record_member_activity(p_event text default 'active') returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); sid uuid; event_time timestamptz:=now();
begin
  if actor is null then raise exception using errcode='42501',message='로그인 후 이용해 주세요.'; end if;
  if p_event not in ('restore','signed_in','active') then raise exception '지원하지 않는 활동 기록 요청입니다.'; end if;
  begin sid:=nullif(auth.jwt()->>'session_id','')::uuid; exception when others then sid:=null; end;
  if sid is null then raise exception using errcode='42501',message='로그인 세션을 확인할 수 없습니다.'; end if;
  insert into keychallenge_membership_private.member_sessions(session_id,user_id,signed_in_at,last_active_at)
    values(sid,actor,case when p_event='signed_in' then event_time end,event_time)
    on conflict(session_id) do update set
      signed_in_at=coalesce(keychallenge_membership_private.member_sessions.signed_in_at,excluded.signed_in_at),
      last_active_at=case when keychallenge_membership_private.member_sessions.last_active_at<event_time-interval '1 minute'
        then event_time else keychallenge_membership_private.member_sessions.last_active_at end;
  return jsonb_build_object('ok',true);
end $$;
revoke all on function public.keychallenge_record_member_activity(text) from public,anon,authenticated,service_role;
grant execute on function public.keychallenge_record_member_activity(text) to authenticated;

create function public.keychallenge_admin_member_activity(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); result jsonb;
begin
  if actor is null or not exists(select 1 from public.keychallenge_admins where user_id=actor) then
    raise exception using errcode='42501',message='관리자만 회원 활동 기록을 확인할 수 있습니다.';
  end if;
  if p_user_id is null or not exists(select 1 from auth.users where id=p_user_id and deleted_at is null) then raise exception '회원을 찾지 못했습니다.'; end if;
  select jsonb_build_object(
    'login_count',count(*) filter(where signed_in_at is not null),
    'last_login_at',max(signed_in_at),'last_active_at',max(last_active_at),
    'sessions',coalesce((select jsonb_agg(jsonb_build_object('signed_in_at',x.signed_in_at,'last_active_at',x.last_active_at) order by x.last_active_at desc)
      from (select signed_in_at,last_active_at from keychallenge_membership_private.member_sessions where user_id=p_user_id order by last_active_at desc limit 20) x),'[]'::jsonb)
  ) into result from keychallenge_membership_private.member_sessions where user_id=p_user_id;
  return coalesce(result,jsonb_build_object('login_count',0,'last_login_at',null,'last_active_at',null,'sessions','[]'::jsonb));
end $$;
revoke all on function public.keychallenge_admin_member_activity(uuid) from public,anon,authenticated,service_role;
grant execute on function public.keychallenge_admin_member_activity(uuid) to authenticated;

create function public.keychallenge_member_billing(p_action text,p_input jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); target uuid; payment_key uuid; amount bigint; refunded bigint; payment_row keychallenge_membership_private.payments;
  paid_time timestamptz; refund_time timestamptz; starts_on date; ends_on date; reason text; reference text; note_text text; refund_row jsonb;
begin
  if actor is null or not exists(select 1 from auth.users where id=actor and deleted_at is null) then raise exception using errcode='42501',message='로그인 후 이용해 주세요.'; end if;
  if jsonb_typeof(p_input)<>'object' or p_input is null or length(p_input::text)>12000 then raise exception '요청 내용을 확인해 주세요.'; end if;
  if not exists(select 1 from public.keychallenge_admins where user_id=actor) then raise exception using errcode='42501',message='관리자만 결제·환불 내역을 관리할 수 있습니다.'; end if;
  if p_action='list' then
    target:=(p_input->>'user_id')::uuid;
    if target is null or not exists(select 1 from auth.users where id=target and deleted_at is null) then raise exception '회원을 찾지 못했습니다.'; end if;
    return jsonb_build_object('payments',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',p.id,'paid_at',p.paid_at,'amount_krw',p.amount_krw,'service_starts_on',p.service_starts_on,'service_ends_on',p.service_ends_on,
        'transaction_reference',p.transaction_reference,'note',p.note,
        'refund_total_krw',coalesce((select sum(r.amount_krw) from keychallenge_membership_private.refunds r where r.payment_id=p.id),0),
        'refunds',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'refunded_at',r.refunded_at,'amount_krw',r.amount_krw,'reason',r.reason) order by r.refunded_at desc,r.created_at desc)
          from keychallenge_membership_private.refunds r where r.payment_id=p.id),'[]'::jsonb)
      ) order by p.paid_at desc,p.created_at desc) from keychallenge_membership_private.payments p where p.user_id=target
    ),'[]'::jsonb));
  end if;
  if p_action='record_payment' then
    target:=(p_input->>'user_id')::uuid;
    if target is null or not exists(select 1 from auth.users where id=target and deleted_at is null) then raise exception '회원을 찾지 못했습니다.'; end if;
    if coalesce(p_input->>'amount_krw','')!~'^[0-9]{1,10}$' then raise exception '결제액은 1원 이상 정수로 입력해 주세요.'; end if;
    amount:=(p_input->>'amount_krw')::bigint;paid_time:=(p_input->>'paid_at')::timestamptz;
    starts_on:=(p_input->>'service_starts_on')::date;ends_on:=(p_input->>'service_ends_on')::date;
    reference:=coalesce(p_input->>'transaction_reference','');note_text:=coalesce(p_input->>'note','');reason:=trim(coalesce(p_input->>'reason',''));
    if amount not between 1 and 1000000000 or starts_on is null or ends_on is null or ends_on<starts_on
      or length(reference)>100 or length(note_text)>1000 or length(reason) not between 1 and 300 then raise exception '결제일, 결제액, 이용 기간, 기록 사유를 확인해 주세요.'; end if;
    insert into keychallenge_membership_private.payments(user_id,paid_at,amount_krw,service_starts_on,service_ends_on,transaction_reference,note,recorded_by)
      values(target,paid_time,amount,starts_on,ends_on,reference,note_text,actor) returning * into payment_row;
    insert into keychallenge_membership_private.billing_audit(actor_id,user_id,payment_id,action,after_value,reason)
      values(actor,target,payment_row.id,'payment_recorded',to_jsonb(payment_row)-'recorded_by',reason);
    return jsonb_build_object('ok',true,'payment_id',payment_row.id);
  end if;
  if p_action='record_refund' then
    payment_key:=(p_input->>'payment_id')::uuid;
    if coalesce(p_input->>'amount_krw','')!~'^[0-9]{1,10}$' then raise exception '환불액은 1원 이상 정수로 입력해 주세요.'; end if;
    amount:=(p_input->>'amount_krw')::bigint;refund_time:=(p_input->>'refunded_at')::timestamptz;reason:=trim(coalesce(p_input->>'reason',''));
    if amount not between 1 and 1000000000 or length(reason) not between 1 and 300 then raise exception '환불액과 기록 사유를 확인해 주세요.'; end if;
    select * into payment_row from keychallenge_membership_private.payments where id=payment_key for update;
    if not found then raise exception '결제 기록을 찾지 못했습니다.'; end if;
    select coalesce(sum(amount_krw),0) into refunded from keychallenge_membership_private.refunds where payment_id=payment_row.id;
    if refunded+amount>payment_row.amount_krw then raise exception '환불 누계가 결제액을 넘습니다. 남은 환불 가능액을 확인해 주세요.'; end if;
    insert into keychallenge_membership_private.refunds(payment_id,refunded_at,amount_krw,reason,recorded_by)
      values(payment_row.id,refund_time,amount,reason,actor)
      returning jsonb_build_object('id',id,'refunded_at',refunded_at,'amount_krw',amount_krw,'reason',reason) into refund_row;
    insert into keychallenge_membership_private.billing_audit(actor_id,user_id,payment_id,action,before_value,after_value,reason)
      values(actor,payment_row.user_id,payment_row.id,'refund_recorded',jsonb_build_object('refunded_total_krw',refunded),refund_row,reason);
    return jsonb_build_object('ok',true);
  end if;
  raise exception '지원하지 않는 결제 장부 요청입니다.';
end $$;
revoke all on function public.keychallenge_member_billing(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.keychallenge_member_billing(text,jsonb) to authenticated;

-- Customer activity logs expire after one year. Keep payment records separately
-- for transaction retention required by applicable law.
select cron.schedule('keychallenge-prune-member-activity','17 18 * * *',
  $job$delete from keychallenge_membership_private.member_sessions where last_active_at<now()-interval '1 year'$job$);
