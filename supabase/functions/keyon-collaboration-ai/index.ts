import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { getProvider, checkProviderKey, analyzeWithProvider } from '../_shared/collaboration-ai-providers.js';
const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
const headers={'Content-Type':'application/json','Access-Control-Allow-Origin':'https://keyon.vercel.app','Access-Control-Allow-Headers':'authorization, apikey, x-client-info, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Cache-Control':'no-store','Vary':'Origin'};
const reply=(status:number,data:unknown)=>new Response(JSON.stringify(data),{status,headers});
async function action(name:string,data:Record<string,unknown>={}){const r=await db.rpc('keyon_collaboration_ai_action',{p_action:name,p_data:data});if(r.error)throw new Error('설정을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');return r.data;}
const uuid=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s);
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
 if(req.method!=='POST')return reply(405,{ok:false});
 let reserved=false,uid='',id='';
 try{
  const token=req.headers.get('Authorization')?.replace(/^Bearer\s+/i,'');if(!token)return reply(401,{ok:false,message:'로그인이 필요합니다.'});
  const auth=await db.auth.getUser(token);const user=auth.data.user;
  if(auth.error||!user?.email_confirmed_at)return reply(401,{ok:false,message:'이메일 인증 후 로그인해 주세요.'});uid=user.id;
  const raw=await req.text();if(raw.length>90000)return reply(413,{ok:false,message:'요청이 너무 큽니다.'});
  let body;try{body=JSON.parse(raw);}catch{return reply(400,{ok:false,message:'요청 형식을 확인해 주세요.'});}
  if(!body||typeof body!=='object')return reply(400,{ok:false});
  const role=await db.from('keychallenge_admins').select('can_manage_api').eq('user_id',uid).maybeSingle();
  if(role.error)throw new Error('권한을 확인하지 못했습니다.');
  const manage=role.data?.can_manage_api===true,admin=Boolean(role.data);
  if(body.action==='status'){
   const s=await action('status',{user_id:uid});
   return reply(200,{ok:true,enabled:s.enabled,configured:s.configured,can_manage:manage,is_admin:admin,user_today:s.user_today,user_limit:s.user_limit,...(admin?{today:s.today,month:s.month,daily_limit:s.daily_limit,monthly_limit:s.monthly_limit}:{}),provider:s.provider,model:getProvider(s.provider).model,...(manage?{provider_configured:s.provider_configured,gemini_paid_confirmed:s.gemini_paid_confirmed}:{})});
  }
  if(['save','pause'].includes(body.action)){
   if(!manage)return reply(403,{ok:false,message:'API 연결 관리 권한이 없습니다.'});
   if(body.action==='pause'){await action('pause');return reply(200,{ok:true});}
   const daily=Number(body.daily_limit),monthly=Number(body.monthly_limit),key=String(body.api_key||'').trim();
   if(!Number.isInteger(daily)||daily<1||daily>500||!Number.isInteger(monthly)||monthly<1||monthly>3000)return reply(200,{ok:false,message:'일 한도 1~500회, 월 한도 1~3,000회로 입력해 주세요.'});
   const provider=body.provider||'openai';getProvider(provider);
   if(provider==='gemini'&&body.paid_project_confirmed!==true)return reply(200,{ok:false,message:'협업 메일 보호를 위해 Gemini 유료 프로젝트와 데이터 설정을 먼저 확인해 주세요.'});
   const existing=key?null:await action('read',{provider});const checkKey=key||existing?.api_key;
   await checkProviderKey(provider,checkKey);
   await action('save',{provider,api_key:key,daily_limit:daily,monthly_limit:monthly,paid_project_confirmed:body.paid_project_confirmed===true});return reply(200,{ok:true});
  }
  if(body.action!=='analyze')return reply(400,{ok:false,message:'지원하지 않는 요청입니다.'});
  const source=typeof body.source==='string'?body.source.trim():'';
  if(!source||source.length>24000)return reply(200,{ok:false,message:'AI 분석은 한 번에 24,000자까지 가능합니다. 필요한 메일·가이드 부분을 나누어 추가해 주세요.'});
  if(!uuid(body.request_id)||body.consent!==true)return reply(400,{ok:false,message:'AI 전송 안내를 확인하고 다시 시도해 주세요.'});id=body.request_id;
  const provider=body.provider||'openai';getProvider(provider);
  let context=null;
  if(body.collaboration_id){
   if(!uuid(body.collaboration_id))return reply(400,{ok:false});
   const record=await db.from('keyon_collaborations').select('title,company,contact,products,cash_fee,provided_value,status,draft_due,publish_due,payment_due,visit_at,deliverables,requirements,keywords,required_links').eq('id',body.collaboration_id).eq('user_id',uid).is('deleted_at',null).maybeSingle();
   if(record.error||!record.data)return reply(404,{ok:false,message:'협업을 찾을 수 없습니다.'});context=record.data;
   context.requirements=context.requirements?.slice(0,4000);context.products=context.products?.slice(0,1000);
  }
  const reservation=await action('reserve',{user_id:uid,id,provider});if(!reservation.ok)return reply(200,reservation);reserved=true;
  const result=await analyzeWithProvider(reservation.provider,reservation.api_key,source,context,new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul'}).format(new Date()));
  await action('finish',{user_id:uid,id,state:result.error?'failed':'succeeded',...result.usage});reserved=false;
  if(result.error)throw new Error(result.error);
  return reply(200,{ok:true,result:result.result});
 }catch(e){if(reserved)try{await action('finish',{user_id:uid,id,state:'failed'});}catch{/* No secrets or source text in logs. */}
  const message=e instanceof Error&&e.message&&!/fetch|JSON|token|key|network/i.test(e.message)?e.message:'AI 분석 요청을 완료하지 못했습니다. 자동 재시도하지 않았습니다. 기본 자동 분류도 이용할 수 있습니다.';
  return reply(200,{ok:false,message});
 }
});
