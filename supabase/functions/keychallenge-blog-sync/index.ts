import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { BlogError, SearchStoppedError, recentPosts, searchBlog, postIdentity, titleQueries } from '../_shared/blog.ts';

const db = createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
const reply = (status:number,value:unknown) => new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
async function data(query:any) { const result=await query; if(result.error)throw new Error('Database operation failed'); return result.data; }
const rssWorker = (action:string,job:any=null,payload:any={}) => data(db.rpc('keychallenge_blog_worker',{p_action:action,p_user:job?.user_id||null,p_lease:job?.lease_token||null,p_data:payload}));
const searchWorker = (action:string,job:any=null,payload:any={}) => data(db.rpc('keychallenge_blog_search_worker',{p_action:action,p_user:job?.user_id||null,p_job:job?.job_id||null,p_lease:job?.lease_token||null,p_data:payload}));
const budget = (action='status') => data(db.rpc('keychallenge_blog_search_budget',{p_action:action}));

Deno.serve(async req => {
  if(req.method!=='POST')return reply(405,{error:'Method not allowed'});
  const token=req.headers.get('x-keychallenge-token');
  if(!token || !/^[a-f0-9]{64}$/.test(token))return reply(401,{error:'Unauthorized'});
  let job:any=null,kind='rss';
  try{
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))].map(n=>n.toString(16).padStart(2,'0')).join('');
    const auth=await data(db.from('keychallenge_sync_auth').select('token_hash').eq('singleton',true).single());
    if(hash!==auth.token_hash)return reply(401,{error:'Unauthorized'});
    const raw=await req.text();if(raw.length>1000)return reply(400,{error:'Invalid request'});
    const body=raw?JSON.parse(raw):{};
    kind=body.kind==='search'?'search':'rss';
    if(kind==='rss'){
      job=await rssWorker('claim');if(!job)return reply(200,{idle:true});
      job=await rssWorker('feed',job,await recentPosts(job.blog_id));
      await rssWorker('finish',job);
      return reply(200,{collected:true});
    }
    const started=Date.now();
    job=await searchWorker('claim');if(!job)return reply(200,{idle:true});
    if(job.phase==='rss')job=await searchWorker('feed',job,await recentPosts(job.blog_id));
    if(!job.pending_ids.length&&!job.current_post_id){
      await searchWorker('finish',job);return reply(200,{processed:0});
    }
    const availability=await budget();
    if(availability?.allowed!==true){await searchWorker('stop',job,availability||{});return reply(200,{stopped:true});}
    const credentials=await data(db.rpc('keychallenge_blog_credentials'));
    if(!credentials){await searchWorker('stop',job,{message:'검색 API 연결을 확인한 뒤 검색 점검 버튼을 다시 눌러 주세요.'});return reply(200,{stopped:true});}
    let count=0;
    while(count<6 && Date.now()-started<45000){
      job=await searchWorker('next',job);
      const post=job.post;if(!post)break;
      const evidence:any[]=[];let status='unconfirmed',error:string|null=null;
      try{
        for(const query of titleQueries(post.title)){
          // A live manual request, account daily quota and shared free budget must all allow this call.
          const reservation=await searchWorker('reserve',job,{post_id:post.post_id,query});
          if(reservation?.allowed!==true){await searchWorker('stop',job,reservation||{});return reply(200,{stopped:true});}
          if(!(Date.now()<Date.parse(reservation.valid_before))){
            await searchWorker('stop',job,{message:'호출 예약 시간이 지났습니다. 나중에 검색 점검 버튼을 다시 눌러 주세요.'});
            return reply(200,{stopped:true});
          }
          const items=await searchBlog(credentials,query);
          const found=items.some((item:any)=>{const identity=postIdentity(item.link);return identity?.blogId===job.blog_id&&identity?.postId===post.post_id;});
          evidence.push({query,sort:'sim',start:1,limit:100,returned:items.length,matched:found,checked_at:new Date().toISOString()});
          if(found){status='found';break;}
        }
        if(!evidence.length)throw new BlogError('검색에 사용할 제목을 확인하지 못했습니다.');
      }catch(e){
        if(e instanceof SearchStoppedError){
          const stopped=await budget(e.reason);
          await searchWorker('stop',job,stopped);
          return reply(200,{stopped:true});
        }
        if(!(e instanceof BlogError))throw e;
        status='error';error=e.message;
      }
      job=await searchWorker('check',job,{post_id:post.post_id,status,evidence,error});count++;
    }
    await searchWorker(job.pending_ids.length||job.current_post_id?'yield':'finish',job);
    return reply(200,{processed:count,pending:job.pending_ids.length});
  }catch(e){
    if(job)try{
      if(kind==='rss')await rssWorker('fail',job,{error:e instanceof BlogError?e.message:'글을 수집하지 못했습니다. 잠시 후 자동으로 다시 수집합니다.'});
      else await searchWorker('fail',job,{message:e instanceof BlogError?e.message:'검색 점검을 완료하지 못했습니다. 나중에 버튼을 눌러 다시 요청해 주세요.'});
    }catch{/* An expired request or changed blog cannot commit results. */}
    return reply(503,{error:'Blog operation could not be completed'});
  }
});
