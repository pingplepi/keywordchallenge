  else if (filter !== 'all') rows = rows.filter((row) => rankIsValid(row.rank) && Number(row.rank) <= Number(filter));
  rows.sort((a, b) => sort === 'recent'
    ? String(b.lastChallengedAt || '').localeCompare(String(a.lastChallengedAt || ''))
    : sort === 'contents'
      ? Number(b.challengeCount || 0) - Number(a.challengeCount || 0)
      : rankValue(a) - rankValue(b) || String(a.name || '').localeCompare(String(b.name || ''), 'ko'));


  if (!rows.length) {
    byId('keywordTable').innerHTML = '<div class="empty">조건에 맞는 키워드가 없습니다.</div>';
    return;
  }
  byId('keywordTable').innerHTML = `<table class="tbl"><thead><tr><th>키워드</th><th>현재 순위</th><th>등록 콘텐츠</th><th>최근 참여</th><th>최근 콘텐츠</th></tr></thead><tbody>${rows.map((row) => {
    const rank = rankIsValid(row.rank) ? Number(row.rank) : null;
    const latest = Array.isArray(row.contents) ? row.contents[0] : null;
    const title = String(latest?.title || '포스팅 보기');
    const contentUrl = safeUrl(latest?.url);
    const link = contentUrl ? `<a href="${escapeAttr(contentUrl)}" target="_blank" rel="noreferrer">${escapeHtml(title.length > 42 ? `${title.slice(0, 42)}…` : title)} ↗</a>` : '—';
    return `<tr><td><strong>${escapeHtml(row.name || row.id || '—')}</strong></td><td class="${rank && rank <= 3 ? 'rank-good' : rank && rank <= 10 ? 'rank-mid' : ''}">${rank ? `${rank.toLocaleString()}위` : '—'}</td><td>${Number(row.challengeCount || 0).toLocaleString()}개</td><td>${formatDate(row.lastChallengedAt)}</td><td>${link}</td></tr>`;
  }).join('')}</tbody></table>`;
}


function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}


function collectorCode(influencerId, token) {
  const endpoint = `${config.SUPABASE_URL}/functions/v1/keychallenge-handoff?action=submit`;
  return `const influencerId=${JSON.stringify(influencerId)};\nconst HANDOFF_TOKEN=${JSON.stringify(token)};\nconst HANDOFF_URL=${JSON.stringify(endpoint)};\nconst SUPABASE_ANON_KEY=${JSON.stringify(config.SUPABASE_ANON_KEY)};\n${COLLECTOR_SOURCE}`;
}


const COLLECTOR_SOURCE = String.raw`
const H={"accept":"*/*","content-type":"application/json","x-api-level":"11","inf-fe-version":"2026.09.16"};
const Q="query getParticipatedKeywords($input: ParticipatedKeywordsInput!, $paging: PagingInput!) { participatedKeywords(input:$input,paging:$paging) { items { ...ParticipatedKeywordViewWithChallenges __typename } paging { nextCursor total __typename } __typename }} fragment ParticipatedKeywordViewWithChallenges on ParticipatedKeywordView { ...ParticipatedKeywordView ownerId contents { ...ChallengeContent __typename } __typename } fragment ParticipatedKeywordView on ParticipatedKeywordView { categoryId id lastChallengedAt name rank viewCount challengeCount __typename } fragment ChallengeContent on ChallengeContent { id challengeId challengedAt url mobileUrl type title createdAt viewCount likeCount mediaCount description thumbnailUrl serviceType participated participatedAnotherKeyword dimmed __typename }";
function ownerFromText(t){if(!t)return null;for(const re of [/"ownerId"\s*:\s*"?(\d{6,})"?/i,/\\"ownerId\\"\s*:\s*\\"?(\d{6,})/i,/ownerId%22%3A%22?(\d{6,})/i,/ownerId[^0-9]{0,20}(\d{6,})/i]){const m=t.match(re);if(m)return m[1]}return null}
function scanDoc(doc){for(const s of [...doc.querySelectorAll("script")]){const x=ownerFromText(s.textContent||"");if(x)return x}return ownerFromText(doc.documentElement?.innerHTML||"")}
async function fetchText(url){const r=await fetch(url,{credentials:"include"});if(!r.ok)throw new Error("HTTP "+r.status+" "+url);return await r.text()}
async function resolveOwnerId(){let x=scanDoc(document);if(x)return x;const base="https://in.naver.com/"+encodeURIComponent(influencerId)+"/challenge?sortType=LAST_UPDATE";const html=await fetchText(base);const doc=new DOMParser().parseFromString(html,"text/html");x=scanDoc(doc)||ownerFromText(html);if(x)return x;let href=[...document.querySelectorAll('a[href*="/challenge/keyword/"]')].map(a=>a.href).find(Boolean);if(!href)href=[...doc.querySelectorAll('a[href*="/challenge/keyword/"]')].map(a=>a.href).find(Boolean);if(href){const kh=await fetchText(href);const kd=new DOMParser().parseFromString(kh,"text/html");x=scanDoc(kd)||ownerFromText(kh);if(x)return x}throw new Error("ownerId 자동 탐색 실패. 인플홈의 키워드 챌린지 탭에서 다시 실행해 주세요.")}
async function collect(ownerId){let cursor=null,all=[],total=0;do{const paging={limit:20};if(cursor!==null)paging.cursor=String(cursor);const body={operationName:"getParticipatedKeywords",variables:{input:{sort:"LAST_UPDATE",ownerId:Number(ownerId)},paging},query:Q};const r=await fetch("https://in.naver.com/graphql",{method:"POST",headers:H,credentials:"include",body:JSON.stringify(body)});const txt=await r.text();if(!r.ok)throw new Error("HTTP "+r.status+": "+txt.slice(0,300));const j=JSON.parse(txt);if(j.errors)throw new Error(JSON.stringify(j.errors));const p=j?.data?.participatedKeywords;if(!p)throw new Error("participatedKeywords 응답 없음");all.push(...p.items);total=p.paging.total;cursor=p.paging.nextCursor??null;console.log("["+influencerId+"] "+all.length+"/"+total)}while(cursor);return{total,items:all}}
function compact(items){return items.map(x=>({categoryId:x.categoryId,id:x.id,lastChallengedAt:x.lastChallengedAt,name:x.name,rank:x.rank,viewCount:x.viewCount,challengeCount:x.challengeCount,ownerId:x.ownerId,contents:Array.isArray(x.contents)&&x.contents.length?[{id:x.contents[0].id,challengeId:x.contents[0].challengeId,challengedAt:x.contents[0].challengedAt,url:x.contents[0].url,mobileUrl:x.contents[0].mobileUrl,title:x.contents[0].title,createdAt:x.contents[0].createdAt,serviceType:x.contents[0].serviceType}]:[]}))}
async function send(payload){const r=await fetch(HANDOFF_URL,{method:"POST",headers:{"content-type":"application/json","apikey":SUPABASE_ANON_KEY},body:JSON.stringify({token:HANDOFF_TOKEN,payload})});const text=await r.text();if(!r.ok)throw new Error("자동 전달 실패: "+text.slice(0,250));const result=JSON.parse(text);if(!result.saved)throw new Error("전달 결과 확인 실패");}
(async()=>{console.log("RANK COLLECTION START · "+influencerId);const ownerId=await resolveOwnerId();console.log("ownerId =",ownerId);const result=await collect(ownerId);const payload={version:"2.0",influencerId,ownerId,total:result.total,collectedAt:new Date().toISOString(),items:compact(result.items)};await send(payload);console.log("RANK COLLECTION SUCCESS · "+result.items.length+"/"+result.total+" · 대시보드로 전달 완료")})().catch(error=>console.error("RANK COLLECTION FAILED:",error));
`;


async function callHandoff(action, { method = 'GET', token, payload } = {}) {
  const url = new URL(`${config.SUPABASE_URL}/functions/v1/keychallenge-handoff`);
  url.searchParams.set('action', action);
  if (token) url.searchParams.set('token', token);
  const headers = { apikey: config.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
  const response = await fetch(url, { method, headers, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  const text = await response.text();
  let result = {};
  try { result = text ? JSON.parse(text) : {}; } catch { result = { error: text }; }
  if (!response.ok) throw new Error(result.error || `요청 실패 (${response.status})`);
  return result;
}


async function startCollection() {
  const id = normalizeId(byId('influencerInput').value);
  if (!id) return notify('올바른 네이버 인플루언서 ID 또는 인플홈 주소를 입력해 주세요.', true);
  activeId = id;
  byId('collectorGuide').hidden = false;
  byId('collectorStatus').textContent = '연결 준비 중';
  const naverTab = window.open(`https://in.naver.com/${encodeURIComponent(id)}/challenge?sortType=LAST_UPDATE`, '_blank');
  if (!naverTab) return notify('팝업이 차단되었습니다. 이 사이트의 팝업을 허용한 뒤 다시 눌러주세요.', true);
  naverTab.opener = null;
  relayKey = randomToken();
  try {
    await navigator.clipboard.writeText(collectorCode(id, relayKey));
    await callHandoff('create', { method: 'POST', payload: { token: relayKey } });
    byId('collectorStatus').textContent = '네이버 탭에서 수집기를 실행해 주세요';
    notify('수집기를 복사했습니다. 열린 네이버 탭에서 F12 → Sources → Snippets에 붙여넣고 Ctrl+Enter로 실행하세요.');
    pollForPayload(relayKey, id);
  } catch (error) {
    byId('collectorStatus').textContent = '연결 준비 실패';
    notify(`수집 연결을 준비하지 못했습니다: ${error.message}`, true);
  }
}
