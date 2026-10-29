import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {createHash,webcrypto} from 'node:crypto';

// Run the actual mail handler with in-memory DB and SMTP replacements.
// No network clients or genuine mail credentials are available in this process.
const code=stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/keyon-collaboration-mail/index.ts',import.meta.url),'utf8').replace(/^import .*;\n/gm,''));
const token='a'.repeat(64), tokenHash=createHash('sha256').update(token).digest('hex');
const oldJob={id:'old-reminder',lease:'old-lease',email:'owner@example.test',company:'예약 검증',title:'[테스트] 일정 변경',event:'원고 제출',target_at:'2026-11-02T15:00:00Z',collaboration_id:'test-collaboration'};
const newJob={...oldJob,id:'new-reminder',lease:'new-lease',target_at:'2026-11-06T15:00:00Z'};

function harness({jobs=[],states={},sendError=false,recordError=false}={}){
 const sent=[],updates=[],configActions=[];let handler,claims=0,closed=0;
 const db={
  rpc:async(name,args)=>{
   if(name==='keyon_collaboration_mail_config'){
    configActions.push(args.p_action);
    return {data:args.p_action==='read'?{user:'sender@example.test',password:'test-placeholder'}:{ok:true},error:null};
   }
   assert.equal(name,'keyon_collaboration_claim_mail'); claims++;
   return {data:jobs.shift()??null,error:null};
  },
  from(table){
   let operation='read',data,filters={};
   const query={
    select(){return this;},
    update(value){operation='update';data=value;return this;},
    eq(key,value){filters[key]=value;return this;},
    async single(){assert.equal(table,'keychallenge_sync_auth');return {data:{token_hash:tokenHash},error:null};},
    async maybeSingle(){
     assert.equal(table,'keyon_collaboration_reminders');
     const row=states[filters.id];
     if(row?.error)return {data:null,error:new Error('read failed')};
     return {data:row?.lease===filters.lease?{...row}:null,error:null};
    },
    then(resolve,reject){
     assert.equal(operation,'update');
     updates.push({filters:{...filters},data:{...data}});
     return Promise.resolve({data:null,error:recordError?new Error('write failed'):null}).then(resolve,reject);
    }
   };
   return query;
  }
 };
 runInNewContext(code,{
  createClient:()=>db,
  nodemailer:{createTransport:()=>({
   async sendMail(mail){if(sendError)throw new Error('uncertain SMTP timeout');sent.push(mail);},
   close(){closed++;}
  })},
  Deno:{env:{get:()=> 'test-placeholder'},serve:fn=>handler=fn},
  Request,Response,TextEncoder,crypto:webcrypto,Date,console
 });
 return {sent,updates,configActions,get claims(){return claims;},get closed(){return closed;},
  async dispatch(){const response=await handler(new Request('https://example.test/',{method:'POST',headers:{'x-keychallenge-token':token},body:JSON.stringify({action:'dispatch'})}));return {status:response.status,body:await response.json()};}
 };
}

test('cancelled previous date is skipped; only the replacement date appears in mail',async()=>{
 const h=harness({jobs:[oldJob,newJob],states:{[oldJob.id]:{lease:oldJob.lease,state:'cancelled'},[newJob.id]:{lease:newJob.lease,state:'sending'}}});
 const out=await h.dispatch();
 assert.equal(out.status,200);assert.equal(out.body.processed,1);assert.equal(h.sent.length,1);
 const mail=h.sent[0];assert.match(mail.text,/2026년 11월 7일/);assert.match(mail.html,/2026년 11월 7일/);assert.doesNotMatch(mail.text,/11월 3일/);
 assert.equal(mail.to,'owner@example.test');assert.equal(mail.messageId,'<collab-new-reminder@keyon.vercel.app>');
 assert.equal(h.updates[0].filters.id,newJob.id);assert.equal(h.updates[0].filters.lease,newJob.lease);assert.equal(h.updates[0].data.state,'sent');
 const repeat=await h.dispatch();assert.equal(repeat.body.processed,0);assert.equal(h.sent.length,1);assert.equal(h.closed,2);
});

test('lost or superseded lease never sends the previous reminder',async()=>{
 const h=harness({jobs:[oldJob],states:{[oldJob.id]:{lease:'different-lease',state:'sending'}}});
 const out=await h.dispatch();assert.equal(out.body.processed,0);assert.equal(h.sent.length,0);assert.equal(h.updates.length,0);
});

test('failure to check the latest cancellation state prevents sending',async()=>{
 const h=harness({jobs:[oldJob],states:{[oldJob.id]:{error:true}}});
 const out=await h.dispatch();assert.equal(out.body.processed,0);assert.equal(h.sent.length,0);assert.equal(h.updates.length,0);
});

test('SMTP failure pauses sending rather than blindly retrying',async()=>{
 const h=harness({jobs:[newJob],states:{[newJob.id]:{lease:newJob.lease,state:'sending'}},sendError:true});
 await h.dispatch();assert.equal(h.claims,1);assert.equal(h.sent.length,0);assert.equal(h.updates[0].data.state,'failed');assert.ok(h.configActions.includes('error'));assert.equal(h.closed,1);
});

test('failure to record a successful send does not send the message again in the same run',async()=>{
 const h=harness({jobs:[newJob],states:{[newJob.id]:{lease:newJob.lease,state:'sending'}},recordError:true});
 const out=await h.dispatch();assert.equal(out.status,500);assert.equal(h.sent.length,1);assert.equal(h.claims,1);assert.equal(h.closed,1);
});

const bundled={...newJob,event:'발행·결과물 마감'};
const bundledItems=[{key:'publish',label:'발행 마감'},{key:'deliverable:blog',label:'블로그 포스팅 결과물 마감'},{key:'deliverable:reels',label:'릴스 결과물 마감'}];
test('publication and multiple same-day outputs are listed in one email and one send record',async()=>{
 const h=harness({jobs:[bundled],states:{[bundled.id]:{lease:bundled.lease,state:'sending',event_label:bundled.event,event_items:bundledItems,target_at:bundled.target_at}}});
 const out=await h.dispatch();assert.equal(out.body.processed,1);assert.equal(h.sent.length,1);assert.equal(h.updates.length,1);
 const mail=h.sent[0];assert.match(mail.subject,/발행·결과물 마감/);
 for(const item of bundledItems){assert.ok(mail.text.includes(item.label));assert.ok(mail.html.includes(item.label));}
 assert.equal((mail.html.match(/<li>/g)||[]).length,3);
 await h.dispatch();assert.equal(h.sent.length,1);
});
test('changed grouping is read again immediately before composing the mail',async()=>{
 const h=harness({jobs:[bundled],states:{[bundled.id]:{lease:bundled.lease,state:'sending',event_label:'발행 마감',event_items:[bundledItems[0]],target_at:bundled.target_at}}});
 await h.dispatch();assert.match(h.sent[0].subject,/발행 마감 일정/);assert.doesNotMatch(h.sent[0].text,/릴스|블로그 포스팅/);
});
test('different reminder dates or collaborations remain separate messages',async()=>{
 const another={...newJob,id:'another-reminder',lease:'another-lease',collaboration_id:'another-collaboration'};
 const h=harness({jobs:[oldJob,another],states:{[oldJob.id]:{lease:oldJob.lease,state:'sending'},[another.id]:{lease:another.lease,state:'sending'}}});
 const out=await h.dispatch();assert.equal(out.body.processed,2);assert.equal(h.sent.length,2);assert.notEqual(h.sent[0].messageId,h.sent[1].messageId);
});
test('result names and collaboration titles are escaped in the grouped HTML email',async()=>{
 const evil={...bundled,title:'<script>bad</script> 제목',company:'A & B'};
 const h=harness({jobs:[evil],states:{[evil.id]:{lease:evil.lease,state:'sending',event_items:[{key:'publish',label:'발행 마감'},{key:'deliverable:blog',label:'<img src=x onerror=alert(1)> 결과물'}]}}});
 await h.dispatch();assert.doesNotMatch(h.sent[0].html,/<script>|<img/);assert.match(h.sent[0].html,/&lt;img/);assert.match(h.sent[0].html,/A &amp; B/);
});
