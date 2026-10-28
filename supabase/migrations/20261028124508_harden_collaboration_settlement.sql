alter table public.keyon_collaborations add column deductions numeric(14,0) not null default 0 check(deductions between 0 and cash_fee);
-- Deductions are entered explicitly; in-kind value never changes the cash balance.
create or replace function keyon_collab_private.after_collaboration() returns trigger language plpgsql security definer set search_path='' as $$
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
 if new.payment_due is not null and paid<new.cash_fee-new.deductions then events:=events||jsonb_build_array(jsonb_build_object('key','payment','label','정산 예정','at',new.payment_due::timestamp at time zone 'Asia/Seoul')); end if;
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

-- Expired slots are not sent as a backlog after a long outage.
create or replace function keyon_collab_private.dispatch_mail() returns void language plpgsql security definer set search_path='' as $$
begin
 update public.keyon_collaboration_reminders set state='failed',error='발송 가능한 시간이 지났습니다.' where state='pending' and due_at<now()-interval '24 hours';
 if not exists(select 1 from keyon_collab_private.mail_settings where singleton and enabled) then return; end if;
 if not exists(select 1 from public.keyon_collaboration_reminders where state='pending' and due_at<=now() and due_at>now()-interval '24 hours') then return; end if;
 perform net.http_post(url:='https://vuatuabiueppcdbdootw.supabase.co/functions/v1/keyon-collaboration-mail',
  headers:=jsonb_build_object('Content-Type','application/json','x-keychallenge-token',(select decrypted_secret from vault.decrypted_secrets where name='keychallenge_daily_sync_token')),body:='{"action":"dispatch"}'::jsonb,timeout_milliseconds:=55000);
end $$;
