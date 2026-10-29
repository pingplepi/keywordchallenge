-- One publication reminder owns all unfinished outputs due on the same KST date.
-- Snapshots retain the included event keys, so splitting a sent group cannot resend it.
alter table public.keyon_collaboration_reminders add column event_items jsonb not null default '[]'
 check(jsonb_typeof(event_items)='array' and jsonb_array_length(event_items)<=21);
update public.keyon_collaboration_reminders
 set event_items=jsonb_build_array(jsonb_build_object('key',event_key,'label',event_label));

-- Invoked by the existing privileged trigger, never by a member-facing API.
create function keyon_collab_private.sync_reminders(c public.keyon_collaborations)
returns void language plpgsql security invoker set search_path='' as $$
declare events jsonb:='[]'; grouped_items jsonb; details jsonb; item jsonb; t timestamptz; due timestamptz; paid numeric; keep_ids uuid[]:='{}'; rid uuid;
begin
 if not c.reminder_enabled or c.deleted_at is not null or c.status='cancelled' then
  update public.keyon_collaboration_reminders set state='cancelled' where collaboration_id=c.id and state in ('pending','sending');
  return;
 end if;
 if c.status not in ('published','completed') then
  if c.visit_at is not null then events:=events||jsonb_build_array(jsonb_build_object('key','visit','label','방문·예약','at',c.visit_at)); end if;
  if c.draft_due is not null and c.status in ('preparing','writing','revision') then events:=events||jsonb_build_array(jsonb_build_object('key','draft','label','원고 제출','at',c.draft_due::timestamp at time zone 'Asia/Seoul')); end if;
  if c.publish_due is not null then
   grouped_items:=jsonb_build_array(jsonb_build_object('key','publish','label','발행 마감'));
   for item in select value from jsonb_array_elements(c.deliverables) loop
    if nullif(item->>'due_on','')::date=c.publish_due and item->>'status'<>'published'
     and not exists(select 1 from public.keyon_collaboration_reminders r where r.collaboration_id=c.id
       and r.event_key='deliverable:'||(item->>'id') and r.target_at=c.publish_due::timestamp at time zone 'Asia/Seoul'
       and r.lead_days=c.reminder_days and r.send_hour=c.reminder_hour and r.attempts>0) then
     grouped_items:=grouped_items||jsonb_build_array(jsonb_build_object('key','deliverable:'||(item->>'id'),'label',left(item->>'name',160)||' 결과물 마감'));
    end if;
   end loop;
   events:=events||jsonb_build_array(jsonb_build_object('key','publish','label',case when jsonb_array_length(grouped_items)>1 then '발행·결과물 마감' else '발행 마감' end,'at',c.publish_due::timestamp at time zone 'Asia/Seoul','items',grouped_items));
  end if;
  for item in select value from jsonb_array_elements(c.deliverables) loop
   if coalesce(item->>'due_on','')<>'' and item->>'status'<>'published' and nullif(item->>'due_on','')::date is distinct from c.publish_due then events:=events||jsonb_build_array(jsonb_build_object('key','deliverable:'||(item->>'id'),'label',left(item->>'name',100)||' 발행','at',(item->>'due_on')::date::timestamp at time zone 'Asia/Seoul')); end if;
  end loop;
 end if;
 select coalesce(sum((value->>'amount')::numeric),0) into paid from jsonb_array_elements(c.payments);
 if c.payment_due is not null and paid<c.cash_fee-c.deductions then events:=events||jsonb_build_array(jsonb_build_object('key','payment','label','정산 예정','at',c.payment_due::timestamp at time zone 'Asia/Seoul')); end if;
 for item in select value from jsonb_array_elements(events) loop
  t:=(item->>'at')::timestamptz;
  details:=coalesce(item->'items',jsonb_build_array(jsonb_build_object('key',item->>'key','label',item->>'label')));
  -- A deadline already included in an attempted grouped mail is not sent again
  -- when a later edit splits it out. Unknown SMTP outcomes are held as before.
  if exists(select 1 from public.keyon_collaboration_reminders r where r.collaboration_id=c.id
    and r.event_key<>item->>'key' and r.target_at=t and r.lead_days=c.reminder_days and r.send_hour=c.reminder_hour
    and r.attempts>0 and r.event_items @> jsonb_build_array(jsonb_build_object('key',item->>'key'))) then continue; end if;
  due:=(((t at time zone 'Asia/Seoul')::date-c.reminder_days)::timestamp+make_interval(hours=>c.reminder_hour)) at time zone 'Asia/Seoul';
  select id into rid from public.keyon_collaboration_reminders where collaboration_id=c.id and event_key=item->>'key' and target_at=t and lead_days=c.reminder_days and send_hour=c.reminder_hour;
  if rid is not null then
   keep_ids:=array_append(keep_ids,rid);
   -- Keep a due/in-flight job's contents current for the worker's final read.
   -- Preserve sent/failed snapshots for history and duplicate prevention.
   update public.keyon_collaboration_reminders set event_label=item->>'label',event_items=details
    where id=rid and state in ('pending','sending');
  end if;
  -- Keep already scheduled reminders, but never create a past-due backlog.
  if due<=now() then continue; end if;
  insert into public.keyon_collaboration_reminders(collaboration_id,user_id,event_key,event_label,target_at,due_at,lead_days,send_hour,event_items)
   values(c.id,c.user_id,item->>'key',item->>'label',t,due,c.reminder_days,c.reminder_hour,details)
  on conflict(collaboration_id,event_key,target_at,lead_days,send_hour) do update
   set state=case when keyon_collaboration_reminders.state='cancelled' and keyon_collaboration_reminders.attempts=0 then 'pending' else keyon_collaboration_reminders.state end,
       due_at=excluded.due_at,
       event_label=case when keyon_collaboration_reminders.state in ('pending','sending') or keyon_collaboration_reminders.attempts=0 then excluded.event_label else keyon_collaboration_reminders.event_label end,
       event_items=case when keyon_collaboration_reminders.state in ('pending','sending') or keyon_collaboration_reminders.attempts=0 then excluded.event_items else keyon_collaboration_reminders.event_items end
  returning id into rid;
  keep_ids:=array_append(keep_ids,rid);
 end loop;
 update public.keyon_collaboration_reminders set state='cancelled' where collaboration_id=c.id and state in ('pending','sending') and not(id=any(keep_ids));
end $$;
revoke all on function keyon_collab_private.sync_reminders(public.keyon_collaborations) from public,anon,authenticated;
grant execute on function keyon_collab_private.sync_reminders(public.keyon_collaborations) to service_role;

create or replace function keyon_collab_private.after_collaboration() returns trigger
language plpgsql security definer set search_path='' as $$
declare changes jsonb;
begin
 if tg_op='INSERT' then changes:=jsonb_build_object('status',new.status); else
  select coalesce(jsonb_object_agg(n.key,n.value),'{}') into changes from jsonb_each(to_jsonb(new)) n
   where n.key not in ('updated_at','revision','source_text','requirements','memo','contact','keywords','required_links') and n.value is distinct from to_jsonb(old)->n.key;
  changes:=changes||jsonb_build_object('edited',true);
 end if;
 insert into public.keyon_collaboration_history(collaboration_id,user_id,action,changes) values(new.id,new.user_id,case when tg_op='INSERT' then 'created' when new.deleted_at is not null then 'trashed' else 'updated' end,changes);
 perform keyon_collab_private.sync_reminders(new);
 return new;
end $$;

-- Reconcile existing reservations without editing collaborations or adding history.
do $$
declare c public.keyon_collaborations;
begin
 for c in select * from public.keyon_collaborations where reminder_enabled and deleted_at is null for update loop
  perform keyon_collab_private.sync_reminders(c);
 end loop;
end $$;
