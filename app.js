import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const config = window.APP_CONFIG || {};
const byId = (id) => document.getElementById(id);
const views = { setup: byId('setupView'), auth: byId('authView'), app: byId('appView') };
let supabase;
let session = null;
let authMode = 'signin';
let profiles = new Map();
let activeId = '';
let relayKey = '';
let allKeywords = [];

function showView(name) {
  for (const [key, element] of Object.entries(views)) element.hidden = key !== name;
  byId('accountBar').hidden = name !== 'app';
}

function notify(message, isError = false) {
  const node = byId('notice');
  node.textContent = message;
  node.classList.toggle('error', isError);
  node.hidden = false;
}

function setAuthMessage(message, kind = '') {
  const node = byId('authMessage');
  node.textContent = message;
  node.className = `message ${kind}`;
}

function normalizeId(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  if (input.includes('in.naver.com')) {
    try {
      const url = new URL(input.startsWith('http') ? input : `https://${input}`);
      if (url.hostname !== 'in.naver.com') return '';
      return url.pathname.split('/').filter(Boolean)[0] || '';
    } catch { return ''; }
  }
  return input.replace(/^\/+|\/+$/g, '').split(/[?#]/)[0];
}

async function onSessionChanged(nextSession) {
  session = nextSession;
  if (!session) {
    profiles.clear();
    activeId = '';
    showView('auth');
    return;
  }
  showView('app');
  byId('accountEmail').textContent = session.user.email || '로그인됨';
  await loadProfiles();
}

async function loadProfiles() {
  const { data, error } = await supabase.from('keychallenge_profiles')
    .select('influencer_id, owner_id, payload, updated_at')
    .order('updated_at', { ascending: false });
  if (error) {
    notify(`저장 데이터를 불러오지 못했습니다: ${error.message}`, true);
    return;
  }
  profiles = new Map((data || []).map((row) => [String(row.influencer_id), row.payload]));
  renderTabs();
  if (profiles.size) setActive(activeId && profiles.has(activeId) ? activeId : profiles.keys().next().value);
  else byId('dashboard').hidden = true;
}

async function saveProfile(payload) {
  if (!payload?.influencerId || !Array.isArray(payload.items)) throw new Error('저장할 데이터 형식이 올바르지 않습니다.');
  const id = String(payload.influencerId);
  const { error } = await supabase.from('keychallenge_profiles').upsert({
    user_id: session.user.id,
    influencer_id: id,
    owner_id: payload.ownerId == null ? null : String(payload.ownerId),
    payload,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,influencer_id' });
  if (error) throw error;
  profiles.set(id, payload);
  activeId = id;
  renderTabs();
  setActive(id);
}

function renderTabs() {
  byId('profileTabs').innerHTML = [...profiles.keys()].map((id) =>
    `<button class="profile-tab ${id === activeId ? 'active' : ''}" type="button" data-profile="${escapeAttr(id)}">${escapeHtml(id)}</button>`
  ).join('');
  byId('profileTabs').querySelectorAll('[data-profile]').forEach((button) => {
    button.addEventListener('click', () => setActive(button.dataset.profile));
  });
}

function setActive(id) {
  if (!profiles.has(id)) return;
  activeId = id;
  byId('influencerInput').value = id;
  byId('dashboard').hidden = false;
  renderTabs();
  renderTable();
}

function rankIsValid(value) { return value !== null && value !== '' && Number.isFinite(Number(value)); }
function rankValue(row) { return rankIsValid(row.rank) ? Number(row.rank) : Number.MAX_SAFE_INTEGER; }
function formatDate(value) { return value ? escapeHtml(String(value).slice(0, 10)) : '—'; }
function safeUrl(value) {
  try {
    const url = new URL(String(value));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function escapeAttr(value) { return escapeHtml(value).replace(/`/g, '&#96;'); }

function renderTable() {
  const payload = profiles.get(activeId);
  if (!payload) return;
  const items = Array.isArray(payload.items) ? payload.items : [];
  const ranked = items.filter((row) => rankIsValid(row.rank));
  byId('statId').textContent = activeId;
  byId('statTotal').textContent = items.length.toLocaleString();
  byId('statTop3').textContent = ranked.filter((row) => Number(row.rank) <= 3).length.toLocaleString();
  byId('statRanked').textContent = ranked.length.toLocaleString();

  const query = byId('searchInput').value.trim().toLocaleLowerCase();
  const filter = byId('rankFilter').value;
  const sort = byId('sortSelect').value;
  let rows = items.filter((row) => !query || String(row.name || '').toLocaleLowerCase().includes(query));
  if (filter === 'none') rows = rows.filter((row) => !rankIsValid(row.rank));
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
const Q=`query getParticipatedKeywords($input: ParticipatedKeywordsInput!, $paging: PagingInput!) { participatedKeywords(input:$input,paging:$paging) { items { ...ParticipatedKeywordViewWithChallenges __typename } paging { nextCursor total __typename } __typename }} fragment ParticipatedKeywordViewWithChallenges on ParticipatedKeywordView { ...ParticipatedKeywordView ownerId contents { ...ChallengeContent __typename } __typename } fragment ParticipatedKeywordView on ParticipatedKeywordView { categoryId id lastChallengedAt name rank viewCount challengeCount __typename } fragment ChallengeContent on ChallengeContent { id challengeId challengedAt url mobileUrl type title createdAt viewCount likeCount mediaCount description thumbnailUrl serviceType participated participatedAnotherKeyword dimmed __typename }`;
function ownerFromText(t){if(!t)return null;for(const re of [/"ownerId"\s*:\s*"?(\d{6,})"?/i,/\\"ownerId\\"\s*:\s*\\"?(\d{6,})/i,/ownerId%22%3A%22?(\d{6,})/i,/ownerId[^0-9]{0,20}(\d{6,})/i]){const m=t.match(re);if(m)return m[1]}return null}
function scanDoc(doc){for(const s of [...doc.querySelectorAll("script")]){const x=ownerFromText(s.textContent||"");if(x)return x}return ownerFromText(doc.documentElement?.innerHTML||"")}
async function fetchText(url){const r=await fetch(url,{credentials:"include"});if(!r.ok)throw new Error(`HTTP ${r.status} ${url}`);return await r.text()}
async function resolveOwnerId(){let x=scanDoc(document);if(x)return x;const base=`https://in.naver.com/${encodeURIComponent(influencerId)}/challenge?sortType=LAST_UPDATE`;const html=await fetchText(base);const doc=new DOMParser().parseFromString(html,"text/html");x=scanDoc(doc)||ownerFromText(html);if(x)return x;let href=[...document.querySelectorAll('a[href*="/challenge/keyword/"]')].map(a=>a.href).find(Boolean);if(!href)href=[...doc.querySelectorAll('a[href*="/challenge/keyword/"]')].map(a=>a.href).find(Boolean);if(href){const kh=await fetchText(href);const kd=new DOMParser().parseFromString(kh,"text/html");x=scanDoc(kd)||ownerFromText(kh);if(x)return x}throw new Error("ownerId 자동 탐색 실패. 인플홈의 키워드 챌린지 탭에서 다시 실행해 주세요.")}
async function collect(ownerId){let cursor=null,all=[],total=0;do{const paging={limit:20};if(cursor!==null)paging.cursor=String(cursor);const body={operationName:"getParticipatedKeywords",variables:{input:{sort:"LAST_UPDATE",ownerId:Number(ownerId)},paging},query:Q};const r=await fetch("https://in.naver.com/graphql",{method:"POST",headers:H,credentials:"include",body:JSON.stringify(body)});const txt=await r.text();if(!r.ok)throw new Error(`HTTP ${r.status}: ${txt.slice(0,300)}`);const j=JSON.parse(txt);if(j.errors)throw new Error(JSON.stringify(j.errors));const p=j?.data?.participatedKeywords;if(!p)throw new Error("participatedKeywords 응답 없음");all.push(...p.items);total=p.paging.total;cursor=p.paging.nextCursor??null;console.log(`[${influencerId}] ${all.length}/${total}`)}while(cursor);return{total,items:all}}
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

async function copyCollector() {
  const id = normalizeId(byId('influencerInput').value);
  if (!id) return notify('먼저 인플루언서 ID를 입력해 주세요.', true);
  if (!relayKey) {
    relayKey = randomToken();
    try { await callHandoff('create', { method: 'POST', payload: { token: relayKey } }); }
    catch (error) { relayKey = ''; return notify(`수집 연결을 준비하지 못했습니다: ${error.message}`, true); }
    pollForPayload(relayKey, id);
  }
  try {
    await navigator.clipboard.writeText(collectorCode(id, relayKey));
    notify('수집기를 복사했습니다. 네이버 인플홈 탭에서 개발자 도구 Snippets에 붙여넣어 실행하세요.');
  } catch (error) { notify(`클립보드 복사에 실패했습니다: ${error.message}`, true); }
}

async function pollForPayload(token, id) {
  byId('collectorStatus').textContent = '수집 결과 대기 중';
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (relayKey !== token || !session) return;
    try {
      const result = await callHandoff('read', { token });
      if (result.payload) {
        await saveProfile(result.payload);
        await callHandoff('consume', { method: 'POST', token });
        relayKey = '';
        byId('collectorStatus').textContent = '자동 저장 완료';
        notify(`${id} 데이터 ${result.payload.items.length.toLocaleString()}개를 계정에 저장했습니다.`);
        return;
      }
    } catch (error) {
      byId('collectorStatus').textContent = '수집 연결 확인 필요';
      notify(`수집 결과를 확인하지 못했습니다: ${error.message}`, true);
      return;
    }
  }
  if (relayKey === token) {
    relayKey = '';
    byId('collectorStatus').textContent = '연결 시간 초과';
    notify('수집 대기 시간이 끝났습니다. 다시 수집을 시작해 주세요.', true);
  }
}

function exportBackup() {
  const backup = { version: '2.0', exportedAt: new Date().toISOString(), profiles: Object.fromEntries(profiles), allKeywords };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'keychallenge-backup.json';
  link.click();
  URL.revokeObjectURL(link.href);
}

async function importFiles(event) {
  const files = [...(event.target.files || [])];
  let saved = 0;
  const failed = [];
  for (const file of files) {
    try {
      const data = JSON.parse(await file.text());
      const entries = data.profiles && typeof data.profiles === 'object'
        ? Object.values(data.profiles)
        : Array.isArray(data) ? data : [data];
      for (const payload of entries) {
        await saveProfile(payload);
        saved += 1;
      }
    } catch (error) { failed.push(`${file.name}: ${error.message}`); }
  }
  event.target.value = '';
  if (saved) notify(`${saved}개 인플루언서 데이터를 내 계정에 저장했습니다.${failed.length ? ` 실패: ${failed.join(' · ')}` : ''}`, failed.length > 0);
  else if (failed.length) notify(`가져오기에 실패했습니다: ${failed.join(' · ')}`, true);
}

function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('.auth-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.mode === mode));
  byId('authSubmit').textContent = mode === 'signin' ? '로그인' : '계정 만들기';
  byId('passwordInput').autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
  setAuthMessage('');
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const email = byId('emailInput').value.trim();
  const password = byId('passwordInput').value;
  byId('authSubmit').disabled = true;
  setAuthMessage(authMode === 'signin' ? '로그인 중…' : '계정을 만드는 중…');
  try {
    if (authMode === 'signin') {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      setAuthMessage('로그인했습니다.', 'success');
    } else {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
      if (data.session) setAuthMessage('계정이 만들어졌습니다.', 'success');
      else setAuthMessage('계정이 만들어졌습니다. 이메일 인증을 완료한 뒤 로그인해 주세요.', 'success');
    }
  } catch (error) { setAuthMessage(error.message, 'error'); }
  finally { byId('authSubmit').disabled = false; }
}

async function initialize() {
  if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY || config.SUPABASE_URL.includes('YOUR_')) {
    showView('setup');
    return;
  }
  supabase = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  const { data: { session: currentSession }, error } = await supabase.auth.getSession();
  if (error) notify(error.message, true);
  await onSessionChanged(currentSession);
  supabase.auth.onAuthStateChange((_event, nextSession) => {
    queueMicrotask(() => onSessionChanged(nextSession));
  });
}

document.querySelectorAll('.auth-tab').forEach((tab) => tab.addEventListener('click', () => setAuthMode(tab.dataset.mode)));
byId('authForm').addEventListener('submit', handleAuthSubmit);
byId('signOutButton').addEventListener('click', async () => {
  relayKey = '';
  const { error } = await supabase.auth.signOut();
  if (error) notify(error.message, true);
});
byId('collectButton').addEventListener('click', startCollection);
byId('openNaverButton').addEventListener('click', startCollection);
byId('copyCollectorButton').addEventListener('click', copyCollector);
byId('exportButton').addEventListener('click', exportBackup);
byId('importInput').addEventListener('change', importFiles);
for (const id of ['searchInput', 'rankFilter', 'sortSelect']) byId(id).addEventListener('input', renderTable);
initialize();
