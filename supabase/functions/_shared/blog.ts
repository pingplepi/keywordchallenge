import { XMLParser, XMLValidator } from 'npm:fast-xml-parser@5.3.0';

export class BlogError extends Error {}
export class SearchStoppedError extends BlogError {
  constructor(public reason: 'provider_quota' | 'credentials') {
    super(reason === 'provider_quota' ? '네이버의 호출 제한 응답으로 검색 점검을 중지했습니다.' : '관리자의 네이버 API HUB 연결 확인이 필요합니다.');
  }
}
export type SearchCredentials = { clientId: string; clientSecret: string };
export function plain(value: unknown): string {
  return String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => {
    const n = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  }).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '}[name] || ''))
    .replace(/\s+/g, ' ').trim();
}
export function postIdentity(value: unknown): { blogId: string; postId: string } | null {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol) || !['blog.naver.com', 'm.blog.naver.com'].includes(url.hostname) || url.username || url.password || url.port) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    const blogId = (url.searchParams.get('blogId') || parts[0] || '').toLowerCase();
    const postId = url.searchParams.get('logNo') || parts[1] || '';
    return /^[a-z0-9][a-z0-9_-]{1,49}$/.test(blogId) && /^\d{1,30}$/.test(postId) ? {blogId, postId} : null;
  } catch { return null; }
}
async function readBounded(response: Response, maximum = 2_000_000): Promise<string> {
  if (!response.body) throw new BlogError('응답 내용을 읽을 수 없습니다.');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      bytes += value.length;
      if (bytes > maximum) throw new BlogError('응답이 너무 커서 이번 수집을 중단했습니다.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const result = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(result);
}
export async function recentPosts(blogId: string) {
  if (!/^[a-z0-9][a-z0-9_-]{1,49}$/.test(blogId)) throw new BlogError('블로그 주소를 확인해 주세요.');
  let response: Response;
  try { response = await fetch(`https://rss.blog.naver.com/${encodeURIComponent(blogId)}.xml`, {redirect:'error', signal:AbortSignal.timeout(12000), headers:{Accept:'application/rss+xml, application/xml, text/xml'}}); }
  catch { throw new BlogError('블로그의 공개 글 목록에 연결하지 못했습니다. 블로그 주소와 RSS 공개 설정을 확인해 주세요.'); }
  if (!response.ok) throw new BlogError('공개 글 목록을 불러오지 못했습니다. 블로그 주소와 RSS 공개 설정을 확인해 주세요.');
  const source = await readBounded(response);
  if (/<!DOCTYPE|<!ENTITY/i.test(source) || XMLValidator.validate(source) !== true) throw new BlogError('공개 글 목록 형식이 올바르지 않아 기존 수집 내용을 유지했습니다.');
  const parsed = new XMLParser({ignoreAttributes:true,parseTagValue:false,processEntities:false}).parse(source);
  const channel = parsed?.rss?.channel;
  if (!channel || typeof channel !== 'object') throw new BlogError('RSS 목록을 확인할 수 없습니다. 블로그의 공개·외부 공유 설정을 확인해 주세요.');
  const raw = channel.item ? (Array.isArray(channel.item) ? channel.item : [channel.item]) : [];
  const unique = new Map<string, {post_id:string; title:string; published_at:string|null}>();
  for (const item of raw.slice(0,100)) {
    const id = postIdentity(plain(item.link)); const title = plain(item.title).slice(0,500);
    if (!id || id.blogId !== blogId || !title) continue;
    const date = Date.parse(item.pubDate || '');
    unique.set(id.postId, {post_id:id.postId,title,published_at:Number.isFinite(date) && date <= Date.now()+86400000 ? new Date(date).toISOString() : null});
  }
  if (raw.length && !unique.size) throw new BlogError('글 주소 형식을 확인할 수 없습니다. 블로그 ID가 변경되었다면 내 설정에서 주소를 갱신해 주세요.');
  return {title:plain(channel.title).slice(0,200),items:[...unique.values()]};
}
export async function searchBlog(credentials: SearchCredentials, query: string) {
  const url = new URL('https://naverapihub.apigw.ntruss.com/search/v1/blog');
  url.search = new URLSearchParams({query,display:'100',start:'1',sort:'sim',format:'json'}).toString();
  let response: Response;
  try { response = await fetch(url, {redirect:'error', signal:AbortSignal.timeout(10000), headers:{'X-NCP-APIGW-API-KEY-ID':credentials.clientId,'X-NCP-APIGW-API-KEY':credentials.clientSecret}}); }
  catch { throw new BlogError('검색 서비스에 연결하지 못했습니다. 다음 갱신 때 다시 확인합니다.'); }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status===429) throw new SearchStoppedError('provider_quota');
    if (response.status===401 || response.status===403) throw new SearchStoppedError('credentials');
    throw new BlogError('검색 서비스가 일시적으로 응답하지 않습니다.');
  }
  let result;
  try { result = JSON.parse(await readBounded(response)); } catch { throw new BlogError('검색 응답을 읽지 못했습니다. 다음 갱신 때 다시 확인합니다.'); }
  if (!Array.isArray(result.items) || result.items.some((item: any) => typeof item.link !== 'string')) throw new BlogError('검색 응답 형식이 변경되어 확인하지 못했습니다.');
  return result.items.slice(0,100);
}
export function titleQueries(title: string): string[] {
  const full = plain(title).slice(0,180);
  const simpler = full.replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim().split(' ').slice(0,6).join(' ');
  return [...new Set([full,simpler].filter(Boolean))];
}
