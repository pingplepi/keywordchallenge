create or replace function keychallenge_private.enqueue_daily() returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if not (select enabled from public.keychallenge_refresh_schedule where singleton) then return; end if;

  -- Expire jobs that have remained unfinished for more than one day.
  update public.keychallenge_sync_jobs set status='failed', last_error='수집 시간이 초과되었습니다.'
    where status in ('queued','running') and started_at < now() - interval '20 hours';

  -- Personal profile data now refreshes when a member signs in and their saved
  -- snapshot is older than six hours. Keep this daily job for the shared catalog only.
  update public.keychallenge_sync_jobs
    set status='cancelled', last_error='회원 로그인 시 자동 갱신으로 전환되었습니다.',
        completed_at=now(), updated_at=now(), lease_until=null, lease_token=null
    where kind='profile' and status='queued';
  update public.keychallenge_profiles
    set scheduled_status='skipped', scheduled_error=null
    where scheduled_status='queued';

  insert into public.keychallenge_sync_jobs(resource_key,kind) values('catalog','catalog')
  on conflict(resource_key) do update set status='queued',state='{}',attempts=0,last_error=null,
    started_at=now(),updated_at=now(),completed_at=null,next_attempt_at=now(),lease_token=null,lease_until=null
    where keychallenge_sync_jobs.status in ('succeeded','failed','cancelled');

  update public.keychallenge_refresh_schedule set catalog_status='queued',catalog_error=null where singleton;
end $$;
