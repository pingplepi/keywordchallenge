import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { fetchVolumes, keywordKey, SearchAdError } from '../_shared/searchad.ts';
import { rankKeywords } from './ranking.js';
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
async function checked(query: any) { const result = await query; if (result.error) throw result.error; return result.data; }
Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers });
  if (request.method !== 'POST') return reply(405, { error: '지원하지 않는 요청입니다.' });
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
  if (!token) return reply(401, { error: '로그인 후 검색해 주세요.' });
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const { data: auth, error } = await db.auth.getUser(token);
    if (error || !auth.user) return reply(401, { error: '다시 로그인해 주세요.' });
    const raw = await request.text();
    if (raw.length > 1000) return reply(400, { error: '검색어는 100자 이내로 입력해 주세요.' });
    let body; try { body = JSON.parse(raw); } catch { return reply(400, { error: '검색어를 확인해 주세요.' }); }
    const query = typeof body?.query === 'string' ? body.query.trim() : '';
    if (!query || query.length > 100 || /[,\u0000-\u001f\u007f]/.test(query)) return reply(400, { error: '쉼표 없이 키워드 하나를 100자 이내로 입력해 주세요.' });
    const key = keywordKey(query);
    const sort = body.sort === 'volume' ? 'volume' : 'relevance';
    const cached = await checked(db.from('keychallenge_keyword_lookup_cache').select('items,collected_at,format_version').eq('keyword_key',key).maybeSingle());
    if (cached?.format_version === 2 && Date.parse(cached.collected_at) > Date.now()-30*86400000) return reply(200,{query,items:rankKeywords(query,cached.items,sort).slice(0,sort === 'volume' ? 200 : 100),sort,collected_at:cached.collected_at,cached:true});
    const settings = await checked(db.from('keychallenge_searchad_status').select('configured,enabled').eq('singleton',true).single());
    if (!settings.configured || !settings.enabled) return reply(503,{error:'검색량 연결이 잠시 중지되어 있습니다. 키워드는 보관함에 직접 저장할 수 있습니다.'});
    if (!await checked(db.rpc('keychallenge_claim_keyword_lookup',{p_user_id:auth.user.id}))) return reply(429,{error:'연속 조회 제한(분당 10회)에 도달했거나 관리자가 설정한 이용 한도에 도달했습니다. 잠시 후 다시 시도하거나 내 이용 등급을 확인해 주세요.'});
    const credentials = await checked(db.rpc('keychallenge_searchad_credentials'));
    if (!credentials) return reply(503,{error:'관리자가 검색량 연결을 완료해야 합니다.'});
    const fetched = await fetchVolumes(credentials,[query]);
    const rows = fetched.filter((r:any)=>r.keyword_key===key || r.available);
    // General keywords are intentionally not restricted to the influencer catalog.
    await checked(db.from('keychallenge_search_volumes').upsert(rows,{onConflict:'keyword_key'}));
    const stamp = new Date().toISOString();
    const items = rows.map((r:any)=>({...r,volume_min:r.available?r.pc_min+r.mobile_min:null,volume_max:r.available?r.pc_max+r.mobile_max:null}));
    await checked(db.from('keychallenge_keyword_lookup_cache').upsert({keyword_key:key,items,collected_at:stamp,format_version:2},{onConflict:'keyword_key'}));
    return reply(200,{query,items:rankKeywords(query,items,sort).slice(0,sort === 'volume' ? 200 : 100),sort,collected_at:stamp,cached:false});
  } catch (error) {
    return reply(error instanceof SearchAdError ? (error.status===429?429:502) : 503,
      {error:error instanceof SearchAdError ? error.message : '검색량을 불러오지 못했습니다. 잠시 후 다시 검색해 주세요.'});
  }
});
