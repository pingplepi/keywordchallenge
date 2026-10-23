import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { BlogError, SearchStoppedError, recentPosts, searchBlog, postIdentity, titleQueries } from '../_shared/blog.ts';

const db = createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
const reply = (status:number,value:unknown) => new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
async function data(query:any) { const result=await query; if(result.error)throw new Error('Database operation failed'); return result.data; }
const worker = (action:string,job:any=null,payload:any={}) => data(db.rpc('keychallenge_blog_worker',{p_action:action,p_user:job?.user_id||null,p_lease:job?.lease_token||null,p_data:payload}));
const budget = (action='status') => data(db.rpc('keychallenge_blog_search_budget',{p_action:action}));

Deno.serve(async req => {
  if(req.method!=='POST') return reply(405,{error:'Method not allowed'});
  const token=req.headers.get('x-keychallenge-token');
  if(!token || !/^[a-f0-9]{64}$/.test(token))return reply(401,{error:'Unauthorized'});
  let job:any=null;
  try {
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))].map(n=>n.toString(16).padStart(2,'0')).join('');
    const auth=await data(db.from('keychallenge_sync_auth').select('token_hash').eq('singleton',true).single());
    if(hash!==auth.token_hash)return reply(401,{error:'Unauthorized'});
    const started=Date.now();
    job=await worker('claim'); if(!job)return reply(200,{idle:true});
    if(job.phase==='rss')job=await worker('feed',job,await recentPosts(job.blog_id));
    const availability=await budget();
    if(availability?.allowed!==true){await worker('quota',job,availability||{});return reply(200,{collected:true,search:'paused'});}
    const credentials=await data(db.rpc('keychallenge_blog_credentials'));
    if(!credentials){await worker('quota',job,{message:'검색 API 연결 확인을 기다리고 있습니다.'});return reply(200,{collected:true,search:'waiting_connection'});}
    let count=0;
    while(job.pending_ids.length && count<6 && Date.now()-started<45000){
      const post=await data(db.from('keychallenge_blog_posts').select('post_id,title').eq('user_id',job.user_id).eq('blog_id',job.blog_id).eq('post_id',job.pending_ids[0]).single());
      const evidence:any[]=[]; let status='unconfirmed',error:string|null=null;
      try {
        for(const query of titleQueries(post.title)){
          // Never call Naver unless the shared counter transaction has committed.
          const reservation=await budget('reserve');
          if(reservation?.allowed!==true){await worker('quota',job,reservation||{});return reply(200,{deferred:true});}
          if(!(Date.now()<Date.parse(reservation.valid_before))){
            await worker('quota',job,{retry_at:new Date(Date.now()+300000).toISOString(),message:'호출 예약 시간이 지나 잠시 후 검색 점검을 다시 진행합니다.'});
            return reply(200,{deferred:true});
          }
          const items=await searchBlog(credentials,query);
          const found=items.some((item:any)=>{const identity=postIdentity(item.link);return identity?.blogId===job.blog_id&&identity?.postId===post.post_id;});
          evidence.push({query,sort:'sim',start:1,limit:100,returned:items.length,matched:found,checked_at:new Date().toISOString()});
          if(found){status='found';break;}
        }
        if(!evidence.length)throw new BlogError('검색에 사용할 제목을 확인하지 못했습니다.');
      } catch(e) {
        if(e instanceof SearchStoppedError){
          const stopped=await budget(e.reason);
          await worker('quota',job,stopped);
          return reply(200,{deferred:true});
        }
        if(!(e instanceof BlogError))throw e;
        status='error';error=e instanceof BlogError?e.message:'검색 노출을 확인하지 못했습니다. 다음 갱신 때 다시 확인합니다.';
      }
      job=await worker('check',job,{post_id:post.post_id,status,evidence,error});count++;
    }
    await worker(job.pending_ids.length?'yield':'finish',job);
    return reply(200,{processed:count,pending:job.pending_ids.length});
  } catch(e) {
    if(job)try{await worker('fail',job,{error:e instanceof BlogError?e.message:'수집을 완료하지 못했습니다. 잠시 후 자동으로 재시도합니다.'});}catch{/* A changed blog or expired lease cannot commit results. */}
    return reply(503,{error:'Blog refresh could not be completed'});
  }
});
