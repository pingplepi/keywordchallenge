import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json','Cache-Control':'no-store'};
const reply=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers});
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers});
 if(req.method!=='POST')return reply(405,{error:'지원하지 않는 요청입니다.'});
 const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
 const token=req.headers.get('authorization')?.replace(/^Bearer /,'');
 if(!token)return reply(401,{error:'로그인이 필요합니다.'});
 try{
  const {data:auth,error:authError}=await db.auth.getUser(token);
  if(authError||!auth.user)return reply(401,{error:'다시 로그인해 주세요.'});
  const {data:admin,error:roleError}=await db.from('keychallenge_admins').select('user_id').eq('user_id',auth.user.id).maybeSingle();
  if(roleError||!admin)return reply(403,{error:'관리자만 검색 API를 연결할 수 있습니다.'});
  const raw=await req.text();if(raw.length>2000)return reply(400,{error:'입력 길이를 확인해 주세요.'});
  let body;try{body=JSON.parse(raw);}catch{return reply(400,{error:'입력 형식을 확인해 주세요.'});}
  if(!body||typeof body!=='object'||Array.isArray(body))return reply(400,{error:'입력 형식을 확인해 주세요.'});
  const action=body.action||'save';
  if(!['status','save','pause','confirm'].includes(action))return reply(400,{error:'지원하지 않는 설정입니다.'});
  if(['save','confirm'].includes(action)&&body.freePolicyConfirmed!==true)return reply(400,{error:'무료 제공 정책과 네이버 콘솔의 호출 한도를 확인해 주세요.'});
  if(action!=='save'){
   const {data,error}=await db.rpc('keychallenge_blog_search_budget',{p_action:action});if(error)throw error;
   return reply(200,data);
  }
  const credentials={clientId:String(body.clientId||'').trim(),clientSecret:String(body.clientSecret||'').trim()};
  if(!/^[A-Za-z0-9_-]{1,256}$/.test(credentials.clientId)||!/^[A-Za-z0-9_-]{1,256}$/.test(credentials.clientSecret))return reply(400,{error:'Client ID와 Client Secret을 확인해 주세요.'});
  // Saving does not call Naver or enqueue checks. Members request checks explicitly.
  const {error}=await db.rpc('keychallenge_blog_credentials',{p_value:{...credentials,provider:'naver_api_hub',freePolicyConfirmed:true}});if(error)throw error;
  return reply(200,{saved:true,enabled:true});
 }catch{return reply(503,{error:'검색 API 설정을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'});}
});
