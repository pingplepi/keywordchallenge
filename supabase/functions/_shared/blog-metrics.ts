import { parseHTML } from 'npm:linkedom@0.18.12';

// Only article paragraphs and article photo elements are measured. Never execute page scripts.
export function measureBody(html: string) {
  const { document } = parseHTML(html);
  const roots = document.querySelectorAll('.se-main-container');
  if (roots.length !== 1) throw new Error('본문 영역을 구분하지 못했습니다. 이 글 형식은 아직 지원하지 않습니다.');
  const root = roots[0];
  for (const node of root.querySelectorAll('script,style,noscript,.se-documentTitle,.se-oglink,.se-placesMap,.se-video,.se-sticker,.se-formula')) node.remove();
  const paragraphs = [...root.querySelectorAll('.se-text-paragraph')];
  const photos = [...root.querySelectorAll('img.se-image-resource')].filter(img =>
    !!(img.getAttribute('data-lazy-src') || img.getAttribute('data-src') || img.getAttribute('src')));
  if (!paragraphs.length && !photos.length) throw new Error('집계할 본문 텍스트나 사진을 확인하지 못했습니다.');
  const text = paragraphs.map(p => (p.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g,'').replace(/\s+/gu,' ').trim()).filter(Boolean).join(' ');
  return {
    characters_with_spaces: [...text].length,
    characters_without_spaces: [...text.replace(/\s/gu,'')].length,
    images: photos.length,
    version: 1,
    scope: 'smarteditor_paragraphs_and_photos',
  };
}

async function publicBody(blogId: string, postId: string) {
  if (!/^[a-z0-9][a-z0-9_-]{1,49}$/.test(blogId) || !/^\d{1,30}$/.test(postId)) throw new Error('글 주소를 확인할 수 없습니다.');
  const url = new URL('https://blog.naver.com/PostView.naver');
  url.search = new URLSearchParams({blogId,logNo:postId,redirect:'Dlog',widgetTypeCall:'true',directAccess:'false'}).toString();
  const response = await fetch(url,{redirect:'error',signal:AbortSignal.timeout(12000),headers:{Accept:'text/html'}});
  if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) {
    await response.body?.cancel(); throw new Error('공개 본문에 연결하지 못했습니다. 글 공개 상태를 확인해 주세요.');
  }
  if (!response.body) throw new Error('본문 응답을 확인할 수 없습니다.');
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  try {
    while(true) {
      const part=await reader.read();if(part.done)break;
      size+=part.value.length;if(size>2000000)throw new Error('본문이 커서 집계하지 못했습니다.');
      chunks.push(part.value);
    }
  } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return new TextDecoder().decode(bytes);
}

export async function collectBodyMetrics(db: any) {
  const run = async (action:string,job:any=null,payload:any={}) => {
    const {data,error}=await db.rpc('keychallenge_blog_metrics_worker',{
      p_action:action,p_user:job?.user_id||null,p_blog:job?.blog_id||null,p_post:job?.post_id||null,p_lease:job?.lease_token||null,p_data:payload
    });
    if(error)throw new Error('Body metrics database operation failed');
    return data;
  };
  const started=Date.now();let processed=0;
  while(processed<4 && Date.now()-started<40000) {
    const job=await run('claim');if(!job)break;
    let result;
    try {result={status:'ready',title:job.title,metrics:measureBody(await publicBody(job.blog_id,job.post_id))};}
    catch(error) {
      const message=error instanceof Error?error.message:'';
      result={status:'unavailable',error:/^(본문|공개|글 주소|집계할)/.test(message)?message:'본문을 가져오지 못했습니다. 1시간 후 분석 화면을 열면 다시 시도합니다.'};
    }
    await run('finish',job,result);processed++;
  }
  return {processed};
}
