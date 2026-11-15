import { createClient } from 'npm:@supabase/supabase-js@2.118.0';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
async function checked(query: any) { const result = await query; if (result.error) throw new Error('Database operation failed'); return result.data; }
function normalized(value: unknown) { return String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, '').toLocaleLowerCase('ko-KR'); }
function blogIdFromLink(value: unknown) {
  try {
    const url = new URL(String(value ?? ''));
    if (!['blog.naver.com', 'm.blog.naver.com'].includes(url.hostname)) return '';
    return (url.searchParams.get('blogId') || url.pathname.split('/').filter(Boolean)[0] || '').toLocaleLowerCase('ko-KR');
  } catch { return ''; }
}
Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers });
  if (request.method !== 'POST') return reply(405, { error: '지원하지 않는 요청입니다.' });
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
  if (!token) return reply(401, { error: '로그인 후 이용해 주세요.' });
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const { data: auth, error: authError } = await db.auth.getUser(token);
    if (authError || !auth.user) return reply(401, { error: '다시 로그인해 주세요.' });
    const raw = await request.text();
    if (raw.length > 1000) return reply(400, { error: '키워드는 100자 이내로 입력해 주세요.' });
    let body: any;
    try { body = JSON.parse(raw); } catch { return reply(400, { error: '키워드를 확인해 주세요.' }); }
    const keyword = typeof body?.keyword === 'string' ? body.keyword.trim() : '';
    if (!keyword || keyword.length > 100 || /[,\u0000-\u001f\u007f]/.test(keyword)) return reply(400, { error: '쉼표 없이 키워드 하나를 100자 이내로 입력해 주세요.' });

    const reservation = await checked(db.rpc('keychallenge_keyword_competition_reserve', { p_user_id: auth.user.id }));
    if (!reservation?.allowed) {
      if (reservation?.reason === 'user_daily_limit') return reply(429, { error: '오늘의 경쟁 확인 5회를 모두 사용했습니다.', used: reservation.used, limit: reservation.limit });
      return reply(503, { error: reservation?.message || '검색 한도 또는 운영자 설정으로 지금은 경쟁 확인을 할 수 없습니다.' });
    }

    const credentials = await checked(db.rpc('keychallenge_blog_credentials'));
    if (!credentials?.clientId || !credentials?.clientSecret) return reply(503, { error: '블로그 검색 연결을 사용할 수 없습니다.' });

    const url = new URL('https://naverapihub.apigw.ntruss.com/search/v1/blog');
    url.search = new URLSearchParams({ query: keyword, display: '20', start: '1', sort: 'sim', format: 'json' }).toString();
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'X-NCP-APIGW-API-KEY-ID': credentials.clientId, 'X-NCP-APIGW-API-KEY': credentials.clientSecret } });
    if (response.status === 429) {
      await db.rpc('keychallenge_blog_search_budget', { p_action: 'provider_quota' });
      return reply(503, { error: '네이버 검색 API의 호출 한도에 도달해 확인을 중지했습니다.' });
    }
    if (response.status === 401 || response.status === 403) {
      await db.rpc('keychallenge_blog_search_budget', { p_action: 'credentials' });
      return reply(503, { error: '네이버 검색 API 연결을 확인해 주세요.' });
    }
    if (!response.ok) { await response.body?.cancel(); return reply(503, { error: '블로그 검색 결과를 불러오지 못했습니다.' }); }
    const payload = await response.json();
    const items = Array.isArray(payload?.items) ? payload.items.slice(0, 20) : [];
    const key = normalized(keyword);
    const matchingTitles = items.filter((item: any) => normalized(item?.title).includes(key)).length;
    const cutoff = Date.now() - 90 * 86400000;
    const recentPosts = items.filter((item: any) => {
      const rawDate = String(item?.postdate ?? '');
      if (!/^\d{8}$/.test(rawDate)) return false;
      const time = Date.parse(rawDate.slice(0, 4) + '-' + rawDate.slice(4, 6) + '-' + rawDate.slice(6, 8) + 'T00:00:00+09:00');
      return Number.isFinite(time) && time >= cutoff;
    }).length;
    const member = await checked(db.from('keychallenge_members').select('blog_id').eq('user_id', auth.user.id).maybeSingle());
    const ownBlogId = String(member?.blog_id ?? '').toLocaleLowerCase('ko-KR');
    const ownIndex = ownBlogId ? items.findIndex((item: any) => blogIdFromLink(item?.link) === ownBlogId) : -1;
    const sampleCount = items.length;
    const signalScore = sampleCount ? 0.65 * matchingTitles / sampleCount + 0.35 * recentPosts / sampleCount : 0;
    const signal = !sampleCount ? '자료 부족' : signalScore <= 0.25 ? '낮음' : signalScore <= 0.6 ? '보통' : '높음';
    const reason = !sampleCount
      ? '상위 검색 결과를 충분히 모으지 못해 경쟁 신호를 판단할 수 없습니다.'
      : signal === '낮음'
        ? '상위 검색 결과에서 키워드를 직접 담은 제목과 최근 게시물이 적습니다.'
        : signal === '보통'
          ? '상위 검색 결과에 최근 게시물과 키워드를 담은 제목이 일부 있습니다.'
          : '상위 검색 결과에 최근 게시물과 키워드를 담은 제목이 많습니다.';
    return reply(200, {
      keyword, checked_at: new Date().toISOString(), total_results: Number(payload?.total || 0),
      sample_count: sampleCount, matching_titles: matchingTitles, recent_posts_90d: recentPosts,
      own_blog_rank: ownIndex < 0 ? null : ownIndex + 1, signal, reason,
      used_today: reservation.user_used, daily_limit: reservation.user_limit,
      source: 'NAVER Blog Search API · relevance sort · first 20 results',
      caveat: '블로그 검색 결과의 참고 신호이며 네이버 통합검색 노출 순위나 상위 노출을 보장하지 않습니다.'
    });
  } catch {
    return reply(503, { error: '경쟁 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' });
  }
});