create or replace function keyon_collab_private.claim_mail() returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.keyon_collaboration_reminders; c public.keyon_collaborations; email text; lease_id uuid:=gen_random_uuid();
begin
 perform pg_advisory_xact_lock(77483321);
 if not exists(select 1 from keyon_collab_private.mail_settings where enabled and singleton) then return null; end if;
 -- Unknown SMTP outcome is not retried automatically: avoid duplicate reminder emails.
 update public.keyon_collaboration_reminders set state='failed',error='발송 결과를 확인하지 못했습니다.',lease=null where state='sending' and leased_at<now()-interval '10 minutes';
 if (select count(*) from public.keyon_collaboration_reminders where leased_at>=date_trunc('day',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul')>=200 then return null; end if;
 select x.* into r from public.keyon_collaboration_reminders x join public.keyon_collaborations source on source.id=x.collaboration_id
  where x.state='pending' and x.due_at<=now() and x.due_at>now()-interval '24 hours' and source.reminder_enabled and source.deleted_at is null and source.status<>'cancelled'
  and (select count(*) from public.keyon_collaboration_reminders z where z.user_id=x.user_id and z.leased_at>=date_trunc('day',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul')<10
  order by x.due_at for update of x skip locked limit 1;
 if not found then return null; end if;
 select u.email into email from auth.users u where u.id=r.user_id and u.email_confirmed_at is not null and u.deleted_at is null;
 if email is null then update public.keyon_collaboration_reminders set state='failed',error='인증된 회원 이메일이 필요합니다.' where id=r.id; return null; end if;
 select * into c from public.keyon_collaborations where id=r.collaboration_id;
 update public.keyon_collaboration_reminders set state='sending',attempts=attempts+1,lease=lease_id,leased_at=now() where id=r.id;
 return jsonb_build_object('id',r.id,'lease',lease_id,'email',email,'title',c.title,'company',c.company,'event',r.event_label,'target_at',r.target_at,'collaboration_id',c.id);
end $$;
