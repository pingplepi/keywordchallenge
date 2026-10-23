-- PostgreSQL repetition bounds stop at 255; validate the 256-character cap separately.
create or replace function keychallenge_private.blog_credentials(p_value jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare secret_id uuid; value jsonb; s public.keychallenge_blog_search_status;
begin
 if p_value is not null then
  if length(coalesce(p_value->>'clientId','')) not between 1 and 256
   or length(coalesce(p_value->>'clientSecret','')) not between 1 and 256
   or coalesce(p_value->>'clientId','') !~ '^[A-Za-z0-9_-]+$'
   or coalesce(p_value->>'clientSecret','') !~ '^[A-Za-z0-9_-]+$'
   or p_value->>'provider' is distinct from 'naver_api_hub'
   or p_value->'freePolicyConfirmed' is distinct from 'true'::jsonb then raise exception 'Invalid connection or unconfirmed limits'; end if;
  select * into s from public.keychallenge_blog_search_status where singleton for update;
  if not found then raise exception 'Search limits unavailable'; end if;
  value:=jsonb_build_object('clientId',p_value->>'clientId','clientSecret',p_value->>'clientSecret');
  select id into secret_id from vault.secrets where name='keychallenge_blog_search_credentials';
  if secret_id is null then perform vault.create_secret(value::text,'keychallenge_blog_search_credentials');
  else perform vault.update_secret(secret_id,value::text); end if;
  update public.keychallenge_blog_search_status set configured=true,enabled=true,provider='naver_api_hub',
   provider_limits_confirmed=true,free_confirmed_until=now()+interval '30 days',updated_at=now(),
   stop_reason=case when blocked_until>now() then stop_reason else null end where singleton;
  update public.keychallenge_blog_monitors set status='queued',phase='rss',pending_ids='[]',attempts=0,
   next_attempt_at=now(),requested_at=now(),last_error=null where enabled and status<>'running';
  return '{"saved":true}';
 end if;
 if not exists(select 1 from public.keychallenge_blog_search_status where singleton and enabled and configured
  and provider_limits_confirmed and free_confirmed_until>now() and (blocked_until is null or blocked_until<=now())) then return null; end if;
 select decrypted_secret::jsonb into value from vault.decrypted_secrets where name='keychallenge_blog_search_credentials';
 return value;
end $$;
revoke all on function keychallenge_private.blog_credentials(jsonb) from public,anon,authenticated;
grant execute on function keychallenge_private.blog_credentials(jsonb) to service_role;

