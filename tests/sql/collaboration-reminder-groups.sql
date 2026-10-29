-- Run against an isolated/empty reminder queue. Every fixture is rolled back.
-- No dispatch HTTP calls, SMTP credentials, or real email sends are used.
begin;
set local statement_timeout='20s';
set local lock_timeout='3s';
create temporary table grouped_results(scenario text primary key) on commit drop;
do $test$
declare
 uid uuid; cid uuid:=gen_random_uuid(); other_id uuid:=gen_random_uuid(); legacy_id uuid:=gen_random_uuid();
 blog_id uuid:=gen_random_uuid(); reels_id uuid:=gen_random_uuid(); extra_id uuid:=gen_random_uuid(); done_id uuid:=gen_random_uuid(); undated_id uuid:=gen_random_uuid();
 base date:=(now() at time zone 'Asia/Seoul')::date+14;
 outputs jsonb; job jsonb; group_id uuid; row_before jsonb; history_before bigint; c public.keyon_collaborations;
begin
 if exists(select 1 from public.keyon_collaboration_reminders) then raise exception 'Use an isolated empty reminder queue'; end if;
 select a.user_id into uid from public.keychallenge_admins a join auth.users u on u.id=a.user_id
  where a.can_manage_api and u.email_confirmed_at is not null and u.deleted_at is null limit 1;
 if uid is null then raise exception 'A confirmed test owner is required'; end if;
 perform set_config('request.jwt.claim.sub',uid::text,true);
 outputs:=jsonb_build_array(
  jsonb_build_object('id',blog_id,'kind','blog','name','블로그 리뷰','status','preparing','url','','due_on',base),
  jsonb_build_object('id',reels_id,'kind','reels','name','여행 릴스','status','writing','url','','due_on',base),
  jsonb_build_object('id',extra_id,'kind','other','name','별도 결과물','status','review','url','','due_on',base+1),
  jsonb_build_object('id',done_id,'kind','blog','name','이미 발행한 글','status','published','url','','due_on',base),
  jsonb_build_object('id',undated_id,'kind','other','name','날짜 미정','status','preparing','url','','due_on',''));
 insert into public.keyon_collaborations(id,user_id,title,publish_due,deliverables,reminder_enabled,reminder_days,reminder_hour)
 values(cid,uid,'[롤백 검증] 같은 날의 마감',base,outputs,true,3,8);
 select id into group_id from public.keyon_collaboration_reminders where collaboration_id=cid and event_key='publish';
 if (select count(*) from public.keyon_collaboration_reminders where collaboration_id=cid and state='pending')<>2
 or not exists(select 1 from public.keyon_collaboration_reminders where id=group_id and event_label='발행·결과물 마감' and jsonb_array_length(event_items)=3
   and event_items @> jsonb_build_array(jsonb_build_object('key','deliverable:'||blog_id,'label','블로그 리뷰 결과물 마감'),jsonb_build_object('key','deliverable:'||reels_id,'label','여행 릴스 결과물 마감'))
   and due_at=((base-3)::timestamp+interval '8 hours') at time zone 'Asia/Seoul') then raise exception 'Grouped reservation incorrect'; end if;
 insert into grouped_results values('같은 날 발행·블로그·릴스는 한 건, 다른 날짜는 별도, 발행 완료·날짜 미정 제외');

 update public.keyon_collaboration_reminders set due_at=now()-interval '10 seconds' where id=group_id;
 job:=public.keyon_collaboration_claim_mail();
 if job->>'id' is distinct from group_id::text or public.keyon_collaboration_claim_mail() is not null
 or (select count(*) from public.keyon_collaboration_reminders where collaboration_id=cid and leased_at is not null)<>1 then raise exception 'Group claimed more than once'; end if;
 insert into grouped_results values('묶음은 한 번만 선점하고 메일 한 통으로 사용량 집계');

 outputs:=jsonb_set(outputs,'{1,due_on}',to_jsonb((base+2)::text));
 update public.keyon_collaborations set deliverables=outputs where id=cid;
 if not exists(select 1 from public.keyon_collaboration_reminders where id=group_id and state='sending' and jsonb_array_length(event_items)=2)
 or (select count(*) from public.keyon_collaboration_reminders where collaboration_id=cid and state='pending')<>2 then raise exception 'In-flight contents not refreshed'; end if;
 insert into grouped_results values('발송 직전 결과물 날짜 변경 시 기존 묶음에서 제외하고 새 날짜로 분리');

 update public.keyon_collaboration_reminders set state='sent',sent_at=now() where id=group_id;
 update public.keyon_collaborations set publish_due=base+3 where id=cid;
 if exists(select 1 from public.keyon_collaboration_reminders where collaboration_id=cid and event_key='deliverable:'||blog_id and state in ('pending','sending'))
 or not exists(select 1 from public.keyon_collaboration_reminders where id=group_id and state='sent' and jsonb_array_length(event_items)=2) then raise exception 'Sent group split duplicated a deadline'; end if;
 update public.keyon_collaborations set publish_due=base where id=cid;
 if (select count(*) from public.keyon_collaboration_reminders where collaboration_id=cid and event_key='publish' and state in ('pending','sending'))<>0 then raise exception 'Sent publication requeued'; end if;
 insert into grouped_results values('이미 보낸 묶음의 마감은 분리하거나 이전 날짜로 되돌려도 재발송하지 않음');
 update public.keyon_collaborations set reminder_enabled=false where id=cid;

 insert into public.keyon_collaborations(id,user_id,title,publish_due,deliverables,reminder_enabled)
 values(other_id,uid,'[롤백 검증] 다른 협업',base,outputs,true);
 if not exists(select 1 from public.keyon_collaboration_reminders where collaboration_id=other_id and event_key='publish' and state='pending' and jsonb_array_length(event_items)=2) then raise exception 'Different collaboration suppressed'; end if;
 update public.keyon_collaborations set publish_due=null where id=other_id;
 if not exists(select 1 from public.keyon_collaboration_reminders where collaboration_id=other_id and event_key='deliverable:'||blog_id and state='pending')
 or exists(select 1 from public.keyon_collaboration_reminders where collaboration_id=other_id and event_key='publish' and state='pending') then raise exception 'Removing publication lost output schedule'; end if;
 update public.keyon_collaborations set publish_due=base where id=other_id;
 if (select count(*) from public.keyon_collaboration_reminders where collaboration_id=other_id and target_at=base::timestamp at time zone 'Asia/Seoul' and state='pending')<>1 then raise exception 'Rejoining date duplicates'; end if;
 insert into grouped_results values('다른 협업은 독립적으로 예약하며 발행일 삭제·복원 시 결과물 알림 분리·재결합');
 update public.keyon_collaborations set status='published' where id=other_id;
 if exists(select 1 from public.keyon_collaboration_reminders where collaboration_id=other_id and state in ('pending','sending')) then raise exception 'Publishing left reminder'; end if;
 insert into grouped_results values('협업 발행 완료 시 묶음과 별도 결과물 알림 모두 취소');

 outputs:=jsonb_set(outputs,'{1,due_on}',to_jsonb(base::text));
 insert into public.keyon_collaborations(id,user_id,title,publish_due,deliverables,reminder_enabled)
 values(legacy_id,uid,'[롤백 검증] 기존 예약 재구성',base,outputs,true);
 -- Represent pre-migration individual reservations alongside the publication.
 insert into public.keyon_collaboration_reminders(collaboration_id,user_id,event_key,event_label,target_at,due_at,lead_days,send_hour,event_items)
 select legacy_id,uid,'deliverable:'||x.id,x.label,base::timestamp at time zone 'Asia/Seoul',((base-1)::timestamp+interval '9 hours') at time zone 'Asia/Seoul',1,9,
  jsonb_build_array(jsonb_build_object('key','deliverable:'||x.id,'label',x.label))
 from (values(blog_id,'블로그 리뷰 발행'),(reels_id,'여행 릴스 발행')) x(id,label);
 select * into c from public.keyon_collaborations where id=legacy_id;
 row_before:=to_jsonb(c);
 select count(*) into history_before from public.keyon_collaboration_history where collaboration_id=legacy_id;
 perform keyon_collab_private.sync_reminders(c);
 if (select count(*) from public.keyon_collaboration_reminders where collaboration_id=legacy_id and target_at=base::timestamp at time zone 'Asia/Seoul' and state='pending')<>1
 or (select count(*) from public.keyon_collaboration_reminders where collaboration_id=legacy_id and event_key like 'deliverable:%' and state='cancelled')<>2 then raise exception 'Legacy duplicates survived'; end if;
 if row_before is distinct from (select to_jsonb(src) from public.keyon_collaborations src where id=legacy_id)
 or history_before<>(select count(*) from public.keyon_collaboration_history where collaboration_id=legacy_id) then raise exception 'Reconcile changed collaboration'; end if;
 insert into grouped_results values('기존 개별 예약을 묶음으로 전환하며 협업 내용·수정 이력은 유지');

 if has_function_privilege('anon','keyon_collab_private.sync_reminders(public.keyon_collaborations)','execute')
 or has_function_privilege('authenticated','keyon_collab_private.sync_reminders(public.keyon_collaborations)','execute')
 or has_function_privilege('authenticated','public.keyon_collaboration_claim_mail()','execute') then raise exception 'Private mail scheduler exposed'; end if;
 insert into grouped_results values('일반 회원은 예약 조정·메일 선점 함수를 직접 실행할 수 없음');
end $test$;
select scenario,'PASS' as result from grouped_results order by scenario;
rollback;
