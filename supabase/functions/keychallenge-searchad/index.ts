import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { fetchVolumes, SearchAdError } from '../_shared/searchad.ts';
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers });
  if (request.method !== 'POST') return reply(405, { error: '지원하지 않는 요청입니다.' });
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
  if (!token) return reply(401, { error: '로그인이 필요합니다.' });
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  try {
    const { data: auth, error: authError } = await db.auth.getUser(token);
    if (authError || !auth.user) return reply(401, { error: '다시 로그인해 주세요.' });
    const { data: admin, error: roleError } = await db.from('keychallenge_admins').select('user_id,can_manage_api').eq('user_id', auth.user.id).maybeSingle();
    if (roleError || admin?.can_manage_api !== true) return reply(403, { error: '검색광고 API 연결 설정을 변경할 권한이 없습니다.' });
    const raw = await request.text();
    if (raw.length > 5000) return reply(400, { error: '입력 길이를 확인해 주세요.' });
    let body;
    try { body = JSON.parse(raw); } catch { return reply(400, { error: '입력 형식을 확인해 주세요.' }); }
    if (body.action === 'pause') {
      const { error } = await db.from('keychallenge_searchad_status').update({ enabled: false, updated_at: new Date().toISOString() }).eq('singleton', true);
      if (error) throw error;
      return reply(200, { saved: true, enabled: false });
    }
    const credentials = { customerId: String(body.customerId || '').trim(), apiKey: String(body.apiKey || '').trim(), secretKey: String(body.secretKey || '').trim() };
    if (!/^\d{1,20}$/.test(credentials.customerId) || [credentials.apiKey, credentials.secretKey].some(v => !v || v.length > 1024)) {
      return reply(400, { error: '고객 ID, API License, Secret Key를 모두 확인해 주세요.' });
    }
    const candidates = await db.rpc('keychallenge_volume_candidates', { p_limit: 5 });
    if (candidates.error) throw candidates.error;
    const hints = candidates.data?.length ? candidates.data.map((v: any) => v.name) : ['제주여행'];
    const rows = await fetchVolumes(credentials, hints);
    const saved = await db.rpc('keychallenge_searchad_credentials', { p_value: credentials });
    if (saved.error) throw saved.error;
    const stored = await db.rpc('keychallenge_store_search_volumes', { p_rows: rows });
    if (stored.error) throw stored.error;
    const configured = await db.from('keychallenge_searchad_status').update({ configured: true, enabled: true,
      last_error: null, last_success_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('singleton', true);
    if (configured.error) throw configured.error;
    const queued = await db.rpc('keychallenge_enqueue_volume');
    if (queued.error) throw queued.error;
    return reply(200, { saved: true, enabled: true, measured: stored.data });
  } catch (error) {
    // Credentials and upstream response bodies must never be logged or returned.
    return reply(error instanceof SearchAdError ? 400 : 503, { error: error instanceof SearchAdError ? error.message : '연결을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
  }
});
