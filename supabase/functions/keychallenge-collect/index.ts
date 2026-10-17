import { createClient } from 'npm:@supabase/supabase-js@2.118.0';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};
const sourceHeaders = {
  'content-type': 'application/json',
  'x-api-level': '11',
  'inf-fe-version': '2026.09.16',
};
const query = `query getParticipatedKeywords($input: ParticipatedKeywordsInput!, $paging: PagingInput!) {
  participatedKeywords(input: $input, paging: $paging) {
    items {
      categoryId id lastChallengedAt name rank viewCount challengeCount ownerId
      contents { id title url challengedAt createdAt serviceType }
    }
    paging { nextCursor total }
  }
}`;

class CollectionError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: cors });
}

async function sourceJson(url: string, body?: unknown) {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET', headers: sourceHeaders,
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(25_000), redirect: 'error',
  });
  if (response.status === 404) throw new CollectionError(404, '인플홈을 찾지 못했습니다. 주소나 아이디를 확인해 주세요.');
  if (response.status === 429) throw new CollectionError(429, '네이버 요청이 잠시 제한되었습니다. 잠시 후 다시 수집해 주세요.');
  if (!response.ok) throw new CollectionError(502, '지금은 네이버의 공개 목록을 가져올 수 없습니다. 잠시 후 다시 시도해 주세요.');
  const result = await response.json();
  if (result?.errors?.length) throw new CollectionError(502, '네이버 목록 응답을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  return result;
}

function compact(row: Record<string, any>, ownerId: number) {
  if (!row || row.id == null || !row.name || String(row.ownerId) !== String(ownerId)) {
    throw new CollectionError(502, '인플홈 정보와 수집 결과가 일치하지 않아 수집을 중단했습니다.');
  }
  const latest = Array.isArray(row.contents) ? row.contents[0] : null;
  return {
    id: String(row.id), categoryId: String(row.categoryId), name: String(row.name),
    ownerId: String(ownerId), lastChallengedAt: row.lastChallengedAt,
    rank: Number.isFinite(row.rank) && row.rank > 0 ? row.rank : null,
    viewCount: row.viewCount, challengeCount: row.challengeCount,
    contents: latest ? [{
      id: String(latest.id), title: latest.title, url: latest.url,
      challengedAt: latest.challengedAt, createdAt: latest.createdAt,
      serviceType: latest.serviceType,
    }] : [],
  };
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (request.method !== 'POST') return json(405, { error: '지원하지 않는 요청입니다.' });
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return json(401, { error: '로그인 후 수집해 주세요.' });
  try {
    const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.auth.getUser(auth.slice(7));
    if (error || !data.user) return json(401, { error: '로그인이 만료되었습니다. 다시 로그인해 주세요.' });
    // Only public Naver data is read. No Naver cookies or service-role key are used.
    const raw = await request.text();
    if (raw.length > 2048) return json(400, { error: '요청 내용을 확인해 주세요.' });
    let body;
    try { body = JSON.parse(raw); } catch { return json(400, { error: '요청 형식이 올바르지 않습니다.' }); }
    const id = typeof body?.influencerId === 'string' ? body.influencerId.toLowerCase() : '';
    const cursor = body?.cursor == null ? null : String(body.cursor);
    if (!/^[a-z0-9][a-z0-9_.-]{0,99}$/.test(id) || (cursor !== null && !/^\d{1,30}$/.test(cursor))) {
      return json(400, { error: '인플루언서 아이디를 확인해 주세요.' });
    }
    const space = await sourceJson(`https://gw.in.naver.com/home/api/v1/space-by-url-id?urlId=${encodeURIComponent(id)}`);
    if (String(space.urlId).toLowerCase() !== id || !Number.isSafeInteger(space.ownerId) || space.ownerId <= 0) {
      throw new CollectionError(404, '해당 주소의 인플홈 정보를 확인하지 못했습니다.');
    }
    const result = await sourceJson('https://in.naver.com/graphql', {
      operationName: 'getParticipatedKeywords', query,
      variables: {
        input: { sort: 'LAST_UPDATE', ownerId: space.ownerId },
        paging: { limit: 100, ...(cursor !== null ? { cursor } : {}) },
      },
    });
    const page = result?.data?.participatedKeywords;
    // Naver includes the total on the first page and returns null on later pages.
    const total = page?.paging?.total;
    const validTotal = Number.isInteger(total) && total >= 0 && total <= 200000;
    if (!Array.isArray(page?.items) || !page?.paging || page.items.length > 100
        || (!validTotal && !(cursor !== null && total === null))) {
      throw new CollectionError(502, '네이버의 목록 형식이 변경되어 수집할 수 없습니다.');
    }
    return json(200, {
      influencerId: id, ownerId: String(space.ownerId),
      total, items: page.items.map((row: Record<string, any>) => compact(row, space.ownerId)),
      nextCursor: page.paging.nextCursor == null ? null : String(page.paging.nextCursor),
      collectedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof CollectionError) return json(error.status, { error: error.message });
    if (error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name)) {
      return json(504, { error: '네이버 응답이 늦어 수집을 중단했습니다. 잠시 후 다시 시도해 주세요.' });
    }
    console.error('keychallenge-collect failed', error instanceof Error ? error.name : 'UnknownError');
    return json(502, { error: '수집 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
  }
});
