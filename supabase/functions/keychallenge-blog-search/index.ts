import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { BlogError, searchBlog } from '../_shared/blog.ts';
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
  if(body.action==='pause'){
   const {error}=await db.from('keychallenge_blog_search_status').update({enabled:false,updated_at:new Date().toISOString()}).eq('singleton',true);if(error)throw error;
   return reply(200,{enabled:false});
  }
  const credentials={clientId:String(body.clientId||'').trim(),clientSecret:String(body.clientSecret||'').trim()};
  if(!/^[A-Za-z0-9_-]{1,256}$/.test(credentials.clientId)||!/^[A-Za-z0-9_-]{1,256}$/.test(credentials.clientSecret))return reply(400,{error:'Client ID와 Client Secret을 확인해 주세요.'});
  await searchBlog(credentials,'네이버');
  const {error}=await db.rpc('keychallenge_blog_credentials',{p_value:credentials});if(error)throw error;
  return reply(200,{saved:true,enabled:true});
 }catch(e){return reply(e instanceof BlogError?400:503,{error:e instanceof BlogError?e.message:'검색 API 연결을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.'});}
});
