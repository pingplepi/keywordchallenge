import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import nodemailer from 'npm:nodemailer@10.2.1';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://keyon.vercel.app', 'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin', 'Cache-Control': 'no-store' };
const reply = (status:number, data:unknown) => new Response(JSON.stringify(data), { status, headers });
const escapeHtml = (s:unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
async function rpc(name:string, params = {}) { const {data,error} = await db.rpc(name,params); if(error) throw new Error('Database operation failed'); return data; }
const config = (action:string, data = {}) => rpc('keyon_collaboration_mail_config', {p_action:action,p_data:data});
function transport(credentials:{user:string,password:string}) {
  return nodemailer.createTransport({host:'smtp.gmail.com',port:465,secure:true,auth:{user:credentials.user,pass:credentials.password},connectionTimeout:12000,greetingTimeout:12000,socketTimeout:15000,tls:{minVersion:'TLSv1.2',rejectUnauthorized:true}});
}
function message(title:string, body:string) {
  return `<!doctype html><html lang="ko"><body style="margin:0;background:#f7f5fb;padding:32px 16px;font-family:Arial,sans-serif;color:#302b3b"><div style="max-width:560px;margin:auto;background:white;border-radius:18px;padding:32px"><div style="font-size:30px;font-weight:800">key<span style="color:#7654dc">:on</span></div><h1 style="font-size:22px;margin-top:28px">${escapeHtml(title)}</h1>${body}<p style="margin-top:28px"><a style="display:inline-block;padding:14px 22px;background:#7654dc;color:white;border-radius:10px;text-decoration:none;font-weight:bold" href="https://keyon.vercel.app/#collaborationView">협업 매니저 열기</a></p><p style="font-size:12px;color:#92889f;line-height:1.8;margin-top:32px">키온에서 직접 설정한 협업 알림입니다.<br>협업 매니저 → 해당 협업 → 일정·알림에서 수신을 해제할 수 있습니다.<br>© 2026 뷰티지니 그리고 핑플피. All rights reserved.</p></div></body></html>`;
}
Deno.serve(async req => {
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
  if(req.method!=='POST')return reply(405,{ok:false,message:'POST 요청이 필요합니다.'});
  let raw:string;
  try { raw=await req.text(); if(raw.length>4096)return reply(413,{ok:false,message:'요청이 너무 큽니다.'}); } catch { return reply(400,{ok:false,message:'요청을 읽을 수 없습니다.'}); }
  let body:any; try{body=JSON.parse(raw);}catch{return reply(400,{ok:false,message:'요청 형식을 확인해 주세요.'});}
  try {
    if(body.action==='dispatch') {
      const token=req.headers.get('x-keychallenge-token');
      if(!token||!/^[a-f0-9]{64}$/.test(token))return reply(401,{ok:false});
      const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))].map(n=>n.toString(16).padStart(2,'0')).join('');
      const auth=await db.from('keychallenge_sync_auth').select('token_hash').eq('singleton',true).single();
      if(auth.error||hash!==auth.data?.token_hash)return reply(401,{ok:false});
      const credentials=await config('read');if(!credentials)return reply(200,{ok:true,processed:0});
      const smtp=transport(credentials);let processed=0;const started=Date.now();
      try {
        while(processed<5&&Date.now()-started<35000) {
          const job=await rpc('keyon_collaboration_claim_mail');if(!job)break;
          const fresh=await db.from('keyon_collaboration_reminders').select('state').eq('id',job.id).eq('lease',job.lease).maybeSingle();
          if(fresh.error||fresh.data?.state!=='sending')continue;
          const date=new Date(job.target_at).toLocaleDateString('ko-KR',{timeZone:'Asia/Seoul',dateStyle:'long'});
          try {
            await smtp.sendMail({from:{name:'키온',address:credentials.user},to:job.email,messageId:`<collab-${job.id}@keyon.vercel.app>`,subject:`[키온] ${job.event} 일정 알림 · ${String(job.title).replace(/[\r\n]/g,' ').slice(0,100)}`,text:`${job.company || ''}\n${job.title}\n${job.event}: ${date}\n\n협업 매니저에서 일정과 진행 상황을 확인해 주세요.\nhttps://keyon.vercel.app/#collaborationView\n\n협업의 일정·알림에서 수신을 해제할 수 있습니다.`,html:message(`${job.event} 일정을 확인해 주세요`,`<p style="color:#81758e">${escapeHtml(job.company)}</p><p style="font-size:18px;font-weight:bold">${escapeHtml(job.title)}</p><p style="padding:18px;background:#f3eefc;border-radius:10px;line-height:1.8">${escapeHtml(job.event)}<br><strong>${escapeHtml(date)}</strong></p>`)});
            const done=await db.from('keyon_collaboration_reminders').update({state:'sent',sent_at:new Date().toISOString(),error:null}).eq('id',job.id).eq('lease',job.lease);
            if(done.error) return reply(500,{ok:false,message:'발송 결과 기록을 확인해야 합니다.'});
            processed++;
          } catch {
            await db.from('keyon_collaboration_reminders').update({state:'failed',error:'메일 전송에 실패했습니다. 운영자의 연결 확인이 필요합니다.'}).eq('id',job.id).eq('lease',job.lease);
            await config('error');break;
          }
        }
      }finally{smtp.close();}
      return reply(200,{ok:true,processed});
    }
    const token=req.headers.get('Authorization')?.replace(/^Bearer\s+/i,'');
    if(!token)return reply(401,{ok:false,message:'로그인이 필요합니다.'});
    const {data:{user},error}=await db.auth.getUser(token);
    if(error||!user?.email_confirmed_at||!user.email)return reply(401,{ok:false,message:'인증된 계정으로 로그인해 주세요.'});
    const role=await db.from('keychallenge_admins').select('can_manage_api').eq('user_id',user.id).maybeSingle();
    if(role.error||!role.data?.can_manage_api)return reply(403,{ok:false,message:'메일 연결 관리 권한이 없습니다.'});
    if(body.action==='save') {
      const sender=String(body.sender||'').trim().toLowerCase(),password=String(body.password||'').replace(/\s/g,'');
      if(!/^[a-z0-9._%+-]+@gmail\.com$/.test(sender)||!/^[a-zA-Z]{16}$/.test(password))return reply(200,{ok:false,message:'Gmail 주소와 16자리 Google 앱 비밀번호를 확인해 주세요.'});
      const smtp=transport({user:sender,password});
      try{await smtp.verify();}catch{return reply(200,{ok:false,message:'Gmail에 연결하지 못했습니다. 2단계 인증과 앱 비밀번호, 발신 주소를 확인해 주세요.'});}finally{smtp.close();}
      await config('save',{host:'smtp.gmail.com',user:sender,password});
      return reply(200,{ok:true});
    }
    if(body.action==='pause'){await config('pause');return reply(200,{ok:true});}
    if(body.action==='test') {
      const credentials=await config('read');if(!credentials)return reply(200,{ok:false,message:'메일 연결을 먼저 저장해 주세요.'});
      const smtp=transport(credentials);
      try{await smtp.sendMail({from:{name:'키온',address:credentials.user},to:user.email,subject:'[키온] 협업 리마인드 메일 연결 확인',text:'키온의 협업 알림 메일이 정상적으로 연결되었습니다. 협업 매니저의 일정·알림에서 원하는 일정을 설정해 주세요.\nhttps://keyon.vercel.app/#collaborationView',html:message('협업 알림 메일이 연결되었습니다','<p style="line-height:1.8">이 메일은 관리자님이 요청한 연결 확인 메일입니다.<br>협업 매니저에서 알림을 켜면 등록한 일정에 맞춰 안내해 드립니다.</p>')});}
      catch{return reply(200,{ok:false,message:'테스트 메일을 보내지 못했습니다. 연결 정보를 다시 확인해 주세요.'});}finally{smtp.close();}
      return reply(200,{ok:true});
    }
    return reply(400,{ok:false,message:'지원하지 않는 요청입니다.'});
  } catch {return reply(500,{ok:false,message:'메일 설정을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'});}
});
