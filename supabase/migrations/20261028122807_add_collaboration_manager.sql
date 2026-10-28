create schema if not exists keyon_collab_private;
revoke all on schema keyon_collab_private from public, anon, authenticated;
grant usage on schema keyon_collab_private to authenticated, service_role;

create table public.keyon_collaborations (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 title text not null check (length(btrim(title)) between 1 and 160),
 company text not null default '' check(length(company)<=160),
 channel text not null default '' check(length(channel)<=160),
 contact text not null default '' check(length(contact)<=300),
 products text not null default '' check(length(products)<=3000),
 provided_value numeric(14,0) not null default 0 check(provided_value between 0 and 99999999999),
 cash_fee numeric(14,0) not null default 0 check(cash_fee between 0 and 99999999999),
 requirements text not null default '' check(length(requirements)<=10000),
 keywords text not null default '' check(length(keywords)<=2000),
 required_links text not null default '' check(length(required_links)<=4000),
 memo text not null default '' check(length(memo)<=10000),
 source_text text not null default '' check(length(source_text)<=50000),
 source_name text not null default '' check(length(source_name)<=300),
 visit_at timestamptz, draft_due date, publish_due date, payment_due date,
 status text not null default 'preparing' check(status in ('preparing','writing','submitted','review','revision','published','completed','cancelled')),
 deliverables jsonb not null default '[]', payments jsonb not null default '[]', expenses jsonb not null default '[]',
 reminder_enabled boolean not null default false,
 reminder_days integer not null default 1 check(reminder_days in (0,1,3,7)),
 reminder_hour integer not null default 9 check(reminder_hour between 0 and 23),
 deleted_at timestamptz, revision integer not null default 1,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(id,user_id)
);
create index keyon_collab_user_updated on public.keyon_collaborations(user_id,updated_at desc);
alter table public.keyon_collaborations enable row level security;
revoke all on public.keyon_collaborations from anon,authenticated;
grant select,insert,update on public.keyon_collaborations to authenticated;
grant all on public.keyon_collaborations to service_role;
create policy collab_read on public.keyon_collaborations for select to authenticated using(user_id=(select auth.uid()));
create policy collab_insert on public.keyon_collaborations for insert to authenticated with check(user_id=(select auth.uid()));
create policy collab_update on public.keyon_collaborations for update to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));

create table public.keyon_collaboration_history (
 id bigint generated always as identity primary key, collaboration_id uuid not null, user_id uuid not null,
 happened_at timestamptz not null default now(), action text not null, changes jsonb not null,
 foreign key(collaboration_id,user_id) references public.keyon_collaborations(id,user_id) on delete cascade
);
create index keyon_collab_history_owner on public.keyon_collaboration_history(user_id,collaboration_id,happened_at desc);
alter table public.keyon_collaboration_history enable row level security;
revoke all on public.keyon_collaboration_history from anon,authenticated;
grant select on public.keyon_collaboration_history to authenticated;
grant all on public.keyon_collaboration_history to service_role;
create policy collab_history_read on public.keyon_collaboration_history for select to authenticated using(user_id=(select auth.uid()));

create table public.keyon_collaboration_reminders (
 id uuid primary key default gen_random_uuid(), collaboration_id uuid not null, user_id uuid not null,
 event_key text not null, event_label text not null, target_at timestamptz not null, due_at timestamptz not null,
 lead_days integer not null, send_hour integer not null,
 state text not null default 'pending' check(state in ('pending','sending','sent','failed','cancelled')),
 attempts integer not null default 0, lease uuid, leased_at timestamptz, sent_at timestamptz, error text,
 created_at timestamptz not null default now(),
 foreign key(collaboration_id,user_id) references public.keyon_collaborations(id,user_id) on delete cascade,
 unique(collaboration_id,event_key,target_at,lead_days,send_hour)
);
create index keyon_collab_reminders_owner on public.keyon_collaboration_reminders(user_id,collaboration_id);
create index keyon_collab_reminders_due on public.keyon_collaboration_reminders(due_at) where state='pending';
alter table public.keyon_collaboration_reminders enable row level security;
revoke all on public.keyon_collaboration_reminders from anon,authenticated;
grant select on public.keyon_collaboration_reminders to authenticated;
grant all on public.keyon_collaboration_reminders to service_role;
create policy collab_reminders_read on public.keyon_collaboration_reminders for select to authenticated using(user_id=(select auth.uid()));

create function keyon_collab_private.validate_collaboration() returns trigger language plpgsql set search_path='' as $$
declare item jsonb; list jsonb; total numeric;
begin
 if tg_op='UPDATE' then
  if new.user_id<>old.user_id or new.id<>old.id then raise exception '소유자는 변경할 수 없습니다.'; end if;
  new.revision:=old.revision+1; new.created_at:=old.created_at;
 end if;
 new.updated_at:=now();
 if jsonb_typeof(new.deliverables)<>'array' or jsonb_array_length(new.deliverables)>20 then raise exception '결과물은 최대 20개까지 등록할 수 있습니다.'; end if;
 for item in select value from jsonb_array_elements(new.deliverables) loop
  if coalesce(item->>'id','')!~'^[a-f0-9-]{36}$' or length(coalesce(item->>'name','')) not between 1 and 160
    or coalesce(item->>'status','') not in ('preparing','writing','submitted','review','revision','published')
    or coalesce(item->>'kind','') not in ('blog','reels','instagram','youtube','other')
    or length(coalesce(item->>'url',''))>2000 then raise exception '결과물 형식을 확인해 주세요.'; end if;
  if coalesce(item->>'url','')<>'' and (item->>'url')!~*'^https?://' then raise exception '게시 링크는 http 또는 https 주소여야 합니다.'; end if;
  if coalesce(item->>'due_on','')<>'' then perform (item->>'due_on')::date; end if;
 end loop;
 if (select count(*)<>count(distinct value->>'id') from jsonb_array_elements(new.deliverables)) then raise exception '결과물 ID가 중복되었습니다.'; end if;
 foreach list in array array[new.payments,new.expenses] loop
  if jsonb_typeof(list)<>'array' or jsonb_array_length(list)>100 then raise exception '입금과 지출은 각각 최대 100건까지 등록할 수 있습니다.'; end if;
  total:=0;
  for item in select value from jsonb_array_elements(list) loop
   if coalesce(item->>'amount','')!~'^[0-9]{1,11}$' or (item->>'amount')::numeric>99999999999 or length(coalesce(item->>'memo',''))>500 then raise exception '금액과 메모를 확인해 주세요.'; end if;
   if coalesce(item->>'date','')='' then raise exception '입금·지출 날짜를 입력해 주세요.'; end if;
   perform (item->>'date')::date; total:=total+(item->>'amount')::numeric;
  end loop;
  if total>99999999999 then raise exception '합계 금액이 너무 큽니다.'; end if;
 end loop;
 return new;
end $$;
create trigger validate_keyon_collaboration before insert or update on public.keyon_collaborations for each row execute function keyon_collab_private.validate_collaboration();

create function keyon_collab_private.after_collaboration() returns trigger language plpgsql security definer set search_path='' as $$
declare events jsonb:='[]'; item jsonb; t timestamptz; due timestamptz; paid numeric; changes jsonb; keep_ids uuid[]:='{}'; rid uuid;
begin
 if tg_op='INSERT' then changes:=jsonb_build_object('status',new.status); else
  select coalesce(jsonb_object_agg(n.key,n.value),'{}') into changes from jsonb_each(to_jsonb(new)) n
   where n.key not in ('updated_at','revision','source_text','requirements','memo','contact','keywords','required_links') and n.value is distinct from to_jsonb(old)->n.key;
  changes:=changes||jsonb_build_object('edited',true);
 end if;
 insert into public.keyon_collaboration_history(collaboration_id,user_id,action,changes) values(new.id,new.user_id,case when tg_op='INSERT' then 'created' when new.deleted_at is not null then 'trashed' else 'updated' end,changes);
 if not new.reminder_enabled or new.deleted_at is not null or new.status='cancelled' then
  update public.keyon_collaboration_reminders set state='cancelled' where collaboration_id=new.id and state in ('pending','sending');
  return new;
 end if;
 if new.status not in ('published','completed') then
  if new.visit_at is not null then events:=events||jsonb_build_array(jsonb_build_object('key','visit','label','방문·예약','at',new.visit_at)); end if;
  if new.draft_due is not null and new.status in ('preparing','writing','revision') then events:=events||jsonb_build_array(jsonb_build_object('key','draft','label','원고 제출','at',new.draft_due::timestamp at time zone 'Asia/Seoul')); end if;
  if new.publish_due is not null then events:=events||jsonb_build_array(jsonb_build_object('key','publish','label','발행 마감','at',new.publish_due::timestamp at time zone 'Asia/Seoul')); end if;
  for item in select value from jsonb_array_elements(new.deliverables) loop
   if coalesce(item->>'due_on','')<>'' and item->>'status'<>'published' then events:=events||jsonb_build_array(jsonb_build_object('key','deliverable:'||(item->>'id'),'label',left(item->>'name',100)||' 발행','at',(item->>'due_on')::date::timestamp at time zone 'Asia/Seoul')); end if;
  end loop;
 end if;
 select coalesce(sum((value->>'amount')::numeric),0) into paid from jsonb_array_elements(new.payments);
 if new.payment_due is not null and paid<new.cash_fee then events:=events||jsonb_build_array(jsonb_build_object('key','payment','label','정산 예정','at',new.payment_due::timestamp at time zone 'Asia/Seoul')); end if;
 for item in select value from jsonb_array_elements(events) loop
  t:=(item->>'at')::timestamptz;
  due:=(((t at time zone 'Asia/Seoul')::date-new.reminder_days)::timestamp+make_interval(hours=>new.reminder_hour)) at time zone 'Asia/Seoul';
  select id into rid from public.keyon_collaboration_reminders where collaboration_id=new.id and event_key=item->>'key' and target_at=t and lead_days=new.reminder_days and send_hour=new.reminder_hour;
  if rid is not null then keep_ids:=array_append(keep_ids,rid); end if;
  -- Keep already scheduled reminders, but never create a past-due backlog.
  if due<=now() then continue; end if;
  insert into public.keyon_collaboration_reminders(collaboration_id,user_id,event_key,event_label,target_at,due_at,lead_days,send_hour)
   values(new.id,new.user_id,item->>'key',item->>'label',t,due,new.reminder_days,new.reminder_hour)
  on conflict(collaboration_id,event_key,target_at,lead_days,send_hour) do update
   set state=case when keyon_collaboration_reminders.state='cancelled' and keyon_collaboration_reminders.attempts=0 then 'pending' else keyon_collaboration_reminders.state end,
       due_at=excluded.due_at,event_label=excluded.event_label
  returning id into rid;
  keep_ids:=array_append(keep_ids,rid);
 end loop;
 update public.keyon_collaboration_reminders set state='cancelled' where collaboration_id=new.id and state in ('pending','sending') and not(id=any(keep_ids));
 return new;
end $$;
create trigger after_keyon_collaboration after insert or update on public.keyon_collaborations for each row execute function keyon_collab_private.after_collaboration();

create table keyon_collab_private.mail_settings(singleton boolean primary key default true check(singleton),enabled boolean not null default false,sender text,verified_at timestamptz,last_error text);
insert into keyon_collab_private.mail_settings(singleton) values(true);
alter table keyon_collab_private.mail_settings enable row level security;
revoke all on keyon_collab_private.mail_settings from public,anon,authenticated;
grant all on keyon_collab_private.mail_settings to service_role;

create function keyon_collab_private.mail_status() returns jsonb language plpgsql security definer set search_path='' as $$
declare can_manage boolean;
begin
 if auth.uid() is null then raise exception '로그인이 필요합니다.'; end if;
 select exists(select 1 from public.keychallenge_admins where user_id=auth.uid() and can_manage_api) into can_manage;
 return (select jsonb_build_object('enabled',enabled,'verified_at',verified_at,'can_manage',can_manage,'sender',case when can_manage then sender else null end,'last_error',case when can_manage then last_error else null end) from keyon_collab_private.mail_settings where singleton);
end $$;
create function public.keyon_collaboration_mail_status() returns jsonb language sql security invoker set search_path='' as $$select keyon_collab_private.mail_status()$$;
revoke all on function keyon_collab_private.mail_status(),public.keyon_collaboration_mail_status() from public,anon;
grant execute on function keyon_collab_private.mail_status(),public.keyon_collaboration_mail_status() to authenticated;

create function keyon_collab_private.mail_config(p_action text,p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare sid uuid; creds jsonb;
begin
 -- Only the Edge Function's service role can call this private credential bridge.
 if p_action='read' then select decrypted_secret::jsonb into creds from vault.decrypted_secrets where name='keyon_collaboration_smtp'; return creds;
 elsif p_action='save' then
  if p_data->>'host'<>'smtp.gmail.com' or p_data->>'user' !~ '^[A-Za-z0-9._%+-]+@gmail\.com$' or length(p_data->>'password')<>16 then raise exception 'Invalid mail configuration'; end if;
  select id into sid from vault.secrets where name='keyon_collaboration_smtp';
  if sid is null then perform vault.create_secret(p_data::text,'keyon_collaboration_smtp'); else perform vault.update_secret(sid,p_data::text); end if;
  update keyon_collab_private.mail_settings set enabled=true,sender=p_data->>'user',verified_at=now(),last_error=null where singleton;
 elsif p_action='pause' then update keyon_collab_private.mail_settings set enabled=false where singleton;
 elsif p_action='error' then update keyon_collab_private.mail_settings set enabled=false,last_error='메일 발송 연결을 다시 확인해 주세요.' where singleton;
 end if;
 return jsonb_build_object('ok',true);
end $$;
create function public.keyon_collaboration_mail_config(p_action text,p_data jsonb default '{}') returns jsonb language sql security invoker set search_path='' as $$select keyon_collab_private.mail_config(p_action,p_data)$$;
revoke all on function keyon_collab_private.mail_config(text,jsonb),public.keyon_collaboration_mail_config(text,jsonb) from public,anon,authenticated;
grant execute on function keyon_collab_private.mail_config(text,jsonb),public.keyon_collaboration_mail_config(text,jsonb) to service_role;

create function keyon_collab_private.claim_mail() returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.keyon_collaboration_reminders; c public.keyon_collaborations; email text; lease_id uuid:=gen_random_uuid();
begin
 perform pg_advisory_xact_lock(77483321);
 if not exists(select 1 from keyon_collab_private.mail_settings where enabled and singleton) then return null; end if;
 -- Unknown SMTP outcome is not retried automatically: avoid duplicate reminder emails.
 update public.keyon_collaboration_reminders set state='failed',error='발송 결과를 확인하지 못했습니다.',lease=null where state='sending' and leased_at<now()-interval '10 minutes';
 if (select count(*) from public.keyon_collaboration_reminders where leased_at>=date_trunc('day',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul')>=200 then return null; end if;
 select x.* into r from public.keyon_collaboration_reminders x join public.keyon_collaborations c on c.id=x.collaboration_id
  where x.state='pending' and x.due_at<=now() and x.due_at>now()-interval '24 hours' and c.reminder_enabled and c.deleted_at is null and c.status<>'cancelled'
  and (select count(*) from public.keyon_collaboration_reminders z where z.user_id=x.user_id and z.leased_at>=date_trunc('day',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul')<10
  order by x.due_at for update of x skip locked limit 1;
 if not found then return null; end if;
 select u.email into email from auth.users u where u.id=r.user_id and u.email_confirmed_at is not null and u.deleted_at is null;
 if email is null then update public.keyon_collaboration_reminders set state='failed',error='인증된 회원 이메일이 필요합니다.' where id=r.id; return null; end if;
 select * into c from public.keyon_collaborations where id=r.collaboration_id;
 update public.keyon_collaboration_reminders set state='sending',attempts=attempts+1,lease=lease_id,leased_at=now() where id=r.id;
 return jsonb_build_object('id',r.id,'lease',lease_id,'email',email,'title',c.title,'company',c.company,'event',r.event_label,'target_at',r.target_at,'collaboration_id',c.id);
end $$;
create function public.keyon_collaboration_claim_mail() returns jsonb language sql security invoker set search_path='' as $$select keyon_collab_private.claim_mail()$$;
revoke all on function keyon_collab_private.claim_mail(),public.keyon_collaboration_claim_mail() from public,anon,authenticated;
grant execute on function keyon_collab_private.claim_mail(),public.keyon_collaboration_claim_mail() to service_role;

create function keyon_collab_private.dispatch_mail() returns void language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from keyon_collab_private.mail_settings where singleton and enabled) then return; end if;
 if not exists(select 1 from public.keyon_collaboration_reminders where state='pending' and due_at<=now() and due_at>now()-interval '24 hours') then return; end if;
 perform net.http_post(url:='https://vuatuabiueppcdbdootw.supabase.co/functions/v1/keyon-collaboration-mail',
  headers:=jsonb_build_object('Content-Type','application/json','x-keychallenge-token',(select decrypted_secret from vault.decrypted_secrets where name='keychallenge_daily_sync_token')),body:='{"action":"dispatch"}'::jsonb,timeout_milliseconds:=55000);
end $$;
revoke all on function keyon_collab_private.dispatch_mail(),keyon_collab_private.after_collaboration(),keyon_collab_private.validate_collaboration() from public,anon,authenticated;
select cron.schedule('keyon-collaboration-reminders','*/5 * * * *','select keyon_collab_private.dispatch_mail()');
