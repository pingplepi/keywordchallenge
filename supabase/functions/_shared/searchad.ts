export class SearchAdError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const keywordKey = (value: string) => value.replace(/\s/g, '').toUpperCase();
function bounds(value: unknown): [number, number] | null {
  if (typeof value === 'string' && /^<\s*10$/.test(value)) return [0, 9];
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 999999999 ? [n, n] : null;
}
export async function fetchVolumes(credentials: any, hints: string[]) {
  const timestamp = String(Date.now());
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(credentials.secretKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.GET./keywordstool`));
  const signature = btoa(String.fromCharCode(...new Uint8Array(signed)));
  const url = new URL('https://api.searchad.naver.com/keywordstool');
  url.searchParams.set('hintKeywords', hints.map(keywordKey).join(','));
  url.searchParams.set('showDetail', '0');
  const response = await fetch(url, { headers: { 'X-Timestamp': timestamp, 'X-API-KEY': credentials.apiKey,
    'X-Customer': credentials.customerId, 'X-Signature': signature }, signal: AbortSignal.timeout(20_000), redirect: 'error' });
  if ([401, 403].includes(response.status)) throw new SearchAdError(response.status, '검색광고 API 인증에 실패했습니다. 고객 ID와 API 키의 권한을 확인해 주세요.');
  if (response.status === 429) throw new SearchAdError(429, '검색광고 API 요청 제한으로 잠시 후 다시 시도합니다.');
  if (!response.ok) throw new SearchAdError(response.status, `검색광고 API가 요청을 처리하지 못했습니다. (${response.status})`);
  const body = await response.json();
  const list = Array.isArray(body) ? body : body.keywordList;
  if (!Array.isArray(list)) throw new SearchAdError(502, '검색광고 응답 형식이 변경되었습니다.');
  const rows = new Map();
  for (const item of list) {
    const pc = bounds(item.monthlyPcQcCnt), mobile = bounds(item.monthlyMobileQcCnt);
    if (typeof item.relKeyword !== 'string' || !pc || !mobile) continue;
    const keyword_key = keywordKey(item.relKeyword);
    rows.set(keyword_key, { keyword_key, keyword: item.relKeyword, pc_min: pc[0], pc_max: pc[1],
      mobile_min: mobile[0], mobile_max: mobile[1], collected_at: new Date().toISOString(), available: true });
  }
  // A missing result is unknown, never a zero search count.
  for (const name of hints) if (!rows.has(keywordKey(name))) rows.set(keywordKey(name), {
    keyword_key: keywordKey(name), keyword: name, pc_min: null, pc_max: null, mobile_min: null, mobile_max: null,
    collected_at: new Date().toISOString(), available: false,
  });
  return [...rows.values()];
}
