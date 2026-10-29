-- Existing OpenAI keys and cumulative quotas remain intact when switching providers.
alter table keyon_collab_private.ai_settings
 add column provider text not null default 'openai' check(provider in ('openai','gemini')),
 add column gemini_paid_confirmed boolean not null default false;
alter table keyon_collab_private.ai_requests
 add column provider text not null default 'openai' check(provider in ('openai','gemini'));

create or replace function keyon_collab_private.ai_action(p_action text,p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare s keyon_collab_private.ai_settings; sid uuid; k text; uid uuid:=(p_data->>'user_id')::uuid; rid uuid:=(p_data->>'id')::uuid;
 day_start timestamptz:=date_trunc('day',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
 month_start timestamptz:=date_trunc('month',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
 daily_count integer; monthly_count integer; user_count integer; provider_name text; secret_name text;
begin
 select * into s from keyon_collab_private.ai_settings where singleton for update;
 provider_name:=case when p_action in ('save','read') then coalesce(p_data->>'provider','openai') else s.provider end;
 if provider_name not in ('openai','gemini') then raise exception '지원하지 않는 AI 제공업체입니다.'; end if;
 secret_name:='keyon_collaboration_'||provider_name;
 if p_action='save' then
  if provider_name='gemini' and coalesce((p_data->>'paid_project_confirmed')::boolean,false) is not true then
   raise exception 'Gemini 유료 프로젝트와 데이터 설정을 확인해 주세요.';
  end if;
  select id into sid from vault.secrets where name=secret_name;
  k:=nullif(p_data->>'api_key','');
  if k is not null then
   if sid is null then perform vault.create_secret(k,secret_name); else perform vault.update_secret(sid,k); end if;
  elsif sid is null then raise exception 'API 키를 입력해 주세요.'; end if;
  update keyon_collab_private.ai_settings set provider=provider_name,gemini_paid_confirmed=case when provider_name='gemini' then true else gemini_paid_confirmed end,enabled=true,daily_limit=(p_data->>'daily_limit')::integer,monthly_limit=(p_data->>'monthly_limit')::integer,updated_at=now() where singleton;
  return '{"ok":true}';
 elsif p_action='pause' then update keyon_collab_private.ai_settings set enabled=false,updated_at=now() where singleton; return '{"ok":true}';
 elsif p_action='read' then
  select decrypted_secret into k from vault.decrypted_secrets where name=secret_name; return jsonb_build_object('api_key',k,'provider',provider_name);
 elsif p_action='finish' then
  update keyon_collab_private.ai_requests set state=p_data->>'state',input_tokens=greatest(0,coalesce((p_data->>'input_tokens')::integer,0)),output_tokens=greatest(0,coalesce((p_data->>'output_tokens')::integer,0)) where id=rid and user_id=uid;
  return '{"ok":true}';
 end if;
 select count(*) filter(where created_at>=day_start),count(*),count(*) filter(where created_at>=day_start and user_id=uid)
 into daily_count,monthly_count,user_count from keyon_collab_private.ai_requests where created_at>=month_start;
 if p_action='status' then return jsonb_build_object('provider',s.provider,'gemini_paid_confirmed',s.gemini_paid_confirmed,'provider_configured',jsonb_build_object('openai',exists(select 1 from vault.secrets where name='keyon_collaboration_openai'),'gemini',exists(select 1 from vault.secrets where name='keyon_collaboration_gemini')),'enabled',s.enabled,'configured',exists(select 1 from vault.secrets where name=secret_name),'daily_limit',s.daily_limit,'monthly_limit',s.monthly_limit,'today',daily_count,'month',monthly_count,'user_today',user_count,'user_limit',10); end if;
 if p_action='reserve' then
  -- Bind consent and credentials under the same lock: never silently change recipient.
  if coalesce(p_data->>'provider','openai')<>s.provider then return '{"ok":false,"message":"AI 제공업체가 변경되었습니다. 가져오기 창을 다시 열어 전송 안내를 확인해 주세요."}'; end if;
  if s.provider='gemini' and not s.gemini_paid_confirmed then return '{"ok":false,"message":"운영자가 Gemini 유료 프로젝트 설정을 확인해야 합니다."}'; end if;
  if not s.enabled then return '{"ok":false,"message":"운영자가 AI 분석 연결을 켜야 사용할 수 있습니다."}'; end if;
  if exists(select 1 from keyon_collab_private.ai_requests where id=rid) then return '{"ok":false,"message":"이미 처리한 분석 요청입니다. 창을 다시 열어 결과를 확인하거나 새로 분석해 주세요."}'; end if;
  if daily_count>=s.daily_limit or monthly_count>=s.monthly_limit or user_count>=10 then return '{"ok":false,"message":"AI 분석 사용 한도에 도달했습니다. 기본 자동 분류를 이용해 주세요."}'; end if;
  if exists(select 1 from keyon_collab_private.ai_requests where user_id=uid and created_at>now()-interval '30 seconds') then return '{"ok":false,"message":"분석 요청 사이에는 30초 간격이 필요합니다."}'; end if;
  select decrypted_secret into k from vault.decrypted_secrets where name=secret_name;
  if k is null then return '{"ok":false,"message":"AI 연결이 필요합니다."}'; end if;
  insert into keyon_collab_private.ai_requests(id,user_id,provider) values(rid,uid,s.provider);
  return jsonb_build_object('ok',true,'api_key',k,'provider',s.provider);
 end if;
 raise exception 'Unsupported action';
end $$;

revoke all on function keyon_collab_private.ai_action(text,jsonb),public.keyon_collaboration_ai_action(text,jsonb) from public,anon,authenticated;
grant execute on function keyon_collab_private.ai_action(text,jsonb),public.keyon_collaboration_ai_action(text,jsonb) to service_role;
