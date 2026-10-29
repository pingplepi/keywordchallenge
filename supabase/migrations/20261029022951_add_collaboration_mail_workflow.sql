-- Mail originals are owner-only, and are committed with their reviewed collaboration changes.
create table public.keyon_collaboration_messages (
 id uuid primary key, collaboration_id uuid not null, user_id uuid not null default auth.uid(),
 created_at timestamptz not null default now(), source_text text not null check(length(source_text) between 1 and 50000),
 source_name text not null default '' check(length(source_name)<=300),
 source_hash text generated always as (md5(btrim(source_text))) stored,
 summary text not null default '' check(length(summary)<=1000), stage text not null default 'other' check(length(stage)<=40),
 method text not null check(method in ('local','ai')), applied_changes jsonb not null default '{}' check(jsonb_typeof(applied_changes)='object' and octet_length(applied_changes::text)<=150000),
 foreign key(collaboration_id,user_id) references public.keyon_collaborations(id,user_id) on delete cascade,
 unique(collaboration_id,source_hash)
);
create index keyon_collaboration_messages_owner on public.keyon_collaboration_messages(user_id,collaboration_id,created_at desc);
create index keyon_collaboration_messages_parent on public.keyon_collaboration_messages(collaboration_id,user_id);
alter table public.keyon_collaboration_messages enable row level security;
revoke all on public.keyon_collaboration_messages from anon,authenticated;
grant select,insert on public.keyon_collaboration_messages to authenticated;
grant all on public.keyon_collaboration_messages to service_role;
create policy own_messages_read on public.keyon_collaboration_messages for select to authenticated using(user_id=(select auth.uid()));
create policy own_messages_add on public.keyon_collaboration_messages for insert to authenticated with check(user_id=(select auth.uid()));

create function public.keyon_save_collaboration_message(p_id uuid,p_revision integer,p_payload jsonb,p_message jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare uid uuid:=auth.uid(); old_row public.keyon_collaborations; r public.keyon_collaborations; mid uuid:=(p_message->>'id')::uuid; existing uuid; clean jsonb; changes jsonb;
begin
 if uid is null then raise exception '로그인이 필요합니다.'; end if;
 perform pg_advisory_xact_lock(hashtextextended(uid::text,8721));
 select collaboration_id into existing from public.keyon_collaboration_messages where user_id=uid and id=mid;
 if existing is null and p_id is not null then
  select collaboration_id into existing from public.keyon_collaboration_messages where user_id=uid and collaboration_id=p_id and source_hash=md5(btrim(p_message->>'source_text'));
 end if;
 if existing is not null then
  select * into r from public.keyon_collaborations where id=existing and user_id=uid;
  return jsonb_build_object('row',to_jsonb(r),'duplicate',true);
 end if;
 if p_id is not null then
  select * into old_row from public.keyon_collaborations where id=p_id and user_id=uid and deleted_at is null for update;
  if not found then raise exception '협업을 찾을 수 없습니다.'; end if;
  if old_row.revision is distinct from p_revision then raise exception '다른 화면에서 변경되었습니다. 작성 내용을 복사한 뒤 다시 열어 주세요.'; end if;
 end if;
 select coalesce(jsonb_object_agg(key,value),'{}') into clean from jsonb_each(p_payload) where key=any(array['title','company','channel','contact','products','provided_value','cash_fee','deductions','requirements','keywords','required_links','memo','source_text','source_name','visit_at','draft_due','publish_due','payment_due','status','deliverables','payments','expenses','reminder_enabled','reminder_days','reminder_hour']);
 r:=jsonb_populate_record(old_row,clean);
 if p_id is null then
 insert into public.keyon_collaborations(user_id,title,company,channel,contact,products,provided_value,cash_fee,deductions,requirements,keywords,required_links,memo,source_text,source_name,visit_at,draft_due,publish_due,payment_due,status,deliverables,payments,expenses,reminder_enabled,reminder_days,reminder_hour) values(uid,r.title,r.company,r.channel,r.contact,r.products,r.provided_value,r.cash_fee,r.deductions,r.requirements,r.keywords,r.required_links,r.memo,r.source_text,r.source_name,r.visit_at,r.draft_due,r.publish_due,r.payment_due,r.status,r.deliverables,r.payments,r.expenses,r.reminder_enabled,r.reminder_days,r.reminder_hour) returning * into r;
 else
 update public.keyon_collaborations set title=r.title,company=r.company,channel=r.channel,contact=r.contact,products=r.products,provided_value=r.provided_value,cash_fee=r.cash_fee,deductions=r.deductions,requirements=r.requirements,keywords=r.keywords,required_links=r.required_links,memo=r.memo,source_text=r.source_text,source_name=r.source_name,visit_at=r.visit_at,draft_due=r.draft_due,publish_due=r.publish_due,payment_due=r.payment_due,status=r.status,deliverables=r.deliverables,payments=r.payments,expenses=r.expenses,reminder_enabled=r.reminder_enabled,reminder_days=r.reminder_days,reminder_hour=r.reminder_hour where id=p_id and user_id=uid returning * into r;
 end if;
 select coalesce(jsonb_object_agg(n.key,jsonb_build_object('before',to_jsonb(old_row)->n.key,'after',n.value)),'{}') into changes from jsonb_each(to_jsonb(r)) n
 where n.key not in ('id','user_id','source_text','source_name','created_at','updated_at','revision') and n.value is distinct from to_jsonb(old_row)->n.key;
 insert into public.keyon_collaboration_messages(id,collaboration_id,user_id,source_text,source_name,summary,stage,method,applied_changes)
 values(mid,r.id,uid,btrim(p_message->>'source_text'),coalesce(p_message->>'source_name',''),coalesce(p_message->>'summary',''),coalesce(p_message->>'stage','other'),p_message->>'method',changes);
 return jsonb_build_object('row',to_jsonb(r),'duplicate',false);
end $$;
revoke all on function public.keyon_save_collaboration_message(uuid,integer,jsonb,jsonb) from public,anon;
grant execute on function public.keyon_save_collaboration_message(uuid,integer,jsonb,jsonb) to authenticated;

create table keyon_collab_private.ai_settings (
 singleton boolean primary key default true check(singleton), enabled boolean not null default false,
 daily_limit integer not null default 50 check(daily_limit between 1 and 500), monthly_limit integer not null default 300 check(monthly_limit between 1 and 3000), updated_at timestamptz not null default now()
);
insert into keyon_collab_private.ai_settings(singleton) values(true);
create table keyon_collab_private.ai_requests (
 id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade, created_at timestamptz not null default now(),
 state text not null default 'started' check(state in ('started','succeeded','failed')),input_tokens integer not null default 0,output_tokens integer not null default 0
);
create index keyon_collab_ai_requests_time on keyon_collab_private.ai_requests(created_at);
create index keyon_collab_ai_requests_owner_time on keyon_collab_private.ai_requests(user_id,created_at);
alter table keyon_collab_private.ai_settings enable row level security;
alter table keyon_collab_private.ai_requests enable row level security;
revoke all on keyon_collab_private.ai_settings,keyon_collab_private.ai_requests from public,anon,authenticated;
grant all on keyon_collab_private.ai_settings,keyon_collab_private.ai_requests to service_role;

-- Service-role bridge only: Edge verifies the user and API-manager permission before calling it.
create function keyon_collab_private.ai_action(p_action text,p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare s keyon_collab_private.ai_settings; sid uuid; k text; uid uuid:=(p_data->>'user_id')::uuid; rid uuid:=(p_data->>'id')::uuid;
 day_start timestamptz:=date_trunc('day',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
 month_start timestamptz:=date_trunc('month',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
 daily_count integer; monthly_count integer; user_count integer;
begin
 select * into s from keyon_collab_private.ai_settings where singleton for update;
 if p_action='save' then
  select id into sid from vault.secrets where name='keyon_collaboration_openai';
  k:=nullif(p_data->>'api_key','');
  if k is not null then
   if sid is null then perform vault.create_secret(k,'keyon_collaboration_openai'); else perform vault.update_secret(sid,k); end if;
  elsif sid is null then raise exception 'API 키를 입력해 주세요.'; end if;
  update keyon_collab_private.ai_settings set enabled=true,daily_limit=(p_data->>'daily_limit')::integer,monthly_limit=(p_data->>'monthly_limit')::integer,updated_at=now() where singleton;
  return '{"ok":true}';
 elsif p_action='pause' then update keyon_collab_private.ai_settings set enabled=false,updated_at=now() where singleton; return '{"ok":true}';
 elsif p_action='read' then
  select decrypted_secret into k from vault.decrypted_secrets where name='keyon_collaboration_openai'; return jsonb_build_object('api_key',k);
 elsif p_action='finish' then
  update keyon_collab_private.ai_requests set state=p_data->>'state',input_tokens=greatest(0,coalesce((p_data->>'input_tokens')::integer,0)),output_tokens=greatest(0,coalesce((p_data->>'output_tokens')::integer,0)) where id=rid and user_id=uid;
  return '{"ok":true}';
 end if;
 select count(*) filter(where created_at>=day_start),count(*),count(*) filter(where created_at>=day_start and user_id=uid)
 into daily_count,monthly_count,user_count from keyon_collab_private.ai_requests where created_at>=month_start;
 if p_action='status' then return jsonb_build_object('enabled',s.enabled,'configured',exists(select 1 from vault.secrets where name='keyon_collaboration_openai'),'daily_limit',s.daily_limit,'monthly_limit',s.monthly_limit,'today',daily_count,'month',monthly_count,'user_today',user_count,'user_limit',10); end if;
 if p_action='reserve' then
  if not s.enabled then return '{"ok":false,"message":"운영자가 AI 분석 연결을 켜야 사용할 수 있습니다."}'; end if;
  if exists(select 1 from keyon_collab_private.ai_requests where id=rid) then return '{"ok":false,"message":"이미 처리한 분석 요청입니다. 창을 다시 열어 결과를 확인하거나 새로 분석해 주세요."}'; end if;
  if daily_count>=s.daily_limit or monthly_count>=s.monthly_limit or user_count>=10 then return '{"ok":false,"message":"AI 분석 사용 한도에 도달했습니다. 기본 자동 분류를 이용해 주세요."}'; end if;
  if exists(select 1 from keyon_collab_private.ai_requests where user_id=uid and created_at>now()-interval '30 seconds') then return '{"ok":false,"message":"분석 요청 사이에는 30초 간격이 필요합니다."}'; end if;
  select decrypted_secret into k from vault.decrypted_secrets where name='keyon_collaboration_openai';
  if k is null then return '{"ok":false,"message":"AI 연결이 필요합니다."}'; end if;
  insert into keyon_collab_private.ai_requests(id,user_id) values(rid,uid);
  return jsonb_build_object('ok',true,'api_key',k);
 end if;
 raise exception 'Unsupported action';
end $$;
create function public.keyon_collaboration_ai_action(p_action text,p_data jsonb default '{}') returns jsonb language sql security invoker set search_path='' as $$select keyon_collab_private.ai_action(p_action,p_data)$$;
revoke all on function keyon_collab_private.ai_action(text,jsonb),public.keyon_collaboration_ai_action(text,jsonb) from public,anon,authenticated;
grant execute on function keyon_collab_private.ai_action(text,jsonb),public.keyon_collaboration_ai_action(text,jsonb) to service_role;

create function public.keyon_collaboration_message_exists(p_id uuid,p_source text) returns boolean language sql security invoker set search_path='' as $$
 select exists(select 1 from public.keyon_collaboration_messages where collaboration_id=p_id and user_id=(select auth.uid()) and source_hash=md5(btrim(p_source)))
$$;
revoke all on function public.keyon_collaboration_message_exists(uuid,text) from public,anon;
grant execute on function public.keyon_collaboration_message_exists(uuid,text) to authenticated;
