import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createCatalog } from './catalog.js';

const config = window.APP_CONFIG || {};
const byId = (id) => document.getElementById(id);
const views = { setup: byId('setupView'), auth: byId('authView'), app: byId('appView') };
let supabase;
let session = null;
let authMode = 'signin';
let profiles = new Map();
let activeId = '';
let collectionController = null;
let catalog;
let sessionVersion = 0;
let refreshSchedule = null;
let refreshViewVersion = 0;

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
  const version = ++sessionVersion;
  const changedUser = session?.user.id !== nextSession?.user.id;
  session = nextSession;
  if (changedUser) {
    profiles.clear();
    activeId = '';
    collectionController?.abort();
    byId('dashboard').hidden = true;
    byId('collectorGuide').hidden = true;
    renderTabs();
  }
  if (!session) {
    profiles.clear();
    activeId = '';
    showView('auth');
    void catalog?.setContext(null, null);
    return;
  }
  showView('app');
  byId('accountEmail').textContent = session.user.email || '로그인됨';
  void catalog?.setContext(session.user, profiles.get(activeId) || null);
  await loadProfiles(version);
}

async function loadProfiles(version = sessionVersion) {
  const { data, error } = await supabase.from('keychallenge_profiles')
    .select('influencer_id, owner_id, payload, updated_at')
    .eq('user_id', session.user.id)
    .order('updated_at', { ascending: false });
  if (version !== sessionVersion) return;
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
  const savingUserId = session?.user.id;
  if (!savingUserId) throw new Error('로그인 후 저장해 주세요.');
  const { error } = await supabase.from('keychallenge_profiles').upsert({
    user_id: savingUserId,
    influencer_id: id,
    owner_id: payload.ownerId == null ? null : String(payload.ownerId),
    payload,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,influencer_id' });
  if (error) throw error;
  if (session?.user.id !== savingUserId) return;
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
  void renderRefreshSettings();
  void catalog?.setContext(session?.user || null, profiles.get(activeId));
}

const koreanTime = (value) => new Date(value).toLocaleString('ko-KR', {
  timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short',
});

async function loadRefreshSchedule() {
  const { data, error } = await supabase.from('keychallenge_refresh_schedule')
    .select('enabled,daily_hour,timezone').eq('singleton', true).single();
  refreshSchedule = error ? null : data;
}

async function renderRefreshSettings() {
  const version = ++refreshViewVersion;
  const id = activeId;
  const userId = session?.user.id;
  byId('refreshSettings').hidden = true;
  if (!id || !userId || !refreshSchedule) return;
  const { data, error } = await supabase.from('keychallenge_profiles')
    .select('auto_refresh_enabled,scheduled_status,scheduled_error,last_scheduled_at')
    .eq('user_id', userId).eq('influencer_id', id).maybeSingle();
  if (version !== refreshViewVersion || id !== activeId || userId !== session?.user.id || error || !data) return;
  const enabled = refreshSchedule.enabled && data.auto_refresh_enabled;
  byId('refreshSettings').hidden = false;
  byId('autoRefreshToggle').checked = data.auto_refresh_enabled;
  byId('autoRefreshToggle').disabled = !refreshSchedule.enabled;
  byId('refreshBadge').textContent = enabled ? '예약 켜짐' : '예약 꺼짐';
  const next = new Date();
  next.setUTCHours(19, 0, 0, 0);
  if (next <= new Date()) next.setUTCDate(next.getUTCDate() + 1);
  byId('refreshNext').textContent = enabled ? `다음 예약 · ${koreanTime(next)}부터` : '예약 수집이 꺼져 있습니다. 위 버튼으로 직접 수집할 수 있습니다.';
  const last = profiles.get(id)?.collectedAt;
  byId('refreshLast').textContent = `${last ? `현재 데이터 · ${koreanTime(last)}` : ''}${data.last_scheduled_at ? ` · 최근 예약 완료 ${koreanTime(data.last_scheduled_at)}` : ''}`;
  const labels = { waiting: '다음 예약 시간에 자동 갱신합니다.', queued: '예약 수집 대기 중입니다.', running: '서버에서 수집 중입니다. 화면을 닫아도 계속 진행됩니다.', succeeded: '예약 수집을 완료했습니다.', retrying: '일시적인 오류로 잠시 후 다시 시도합니다. 기존 데이터는 유지됩니다.', failed: '이번 예약 수집을 완료하지 못했습니다. 기존 데이터를 유지하고 다음 예약에 다시 시도합니다.', skipped: '최근 직접 수집한 데이터 또는 변경한 예약 설정을 유지했습니다.' };
  byId('refreshStatus').textContent = enabled ? (labels[data.scheduled_status] || '') : '';
  byId('refreshStatus').className = `message ${data.scheduled_status === 'failed' ? 'error' : ''}`;
}

async function toggleAutoRefresh() {
  const userId = session?.user.id;
  const id = activeId;
  if (!userId || !id) return;
  const enabled = byId('autoRefreshToggle').checked;
  byId('autoRefreshToggle').disabled = true;
  const { error } = await supabase.from('keychallenge_profiles').update({ auto_refresh_enabled: enabled })
    .eq('user_id', userId).eq('influencer_id', id);
  if (userId !== session?.user.id) return;
  if (error) notify('예약 설정을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.', true);
  else notify(`${id}의 매일 자동 갱신을 ${enabled ? '켰습니다' : '껐습니다'}.`);
  await renderRefreshSettings();
}

function rankIsValid(value) { return value !== null && value !== '' && Number.isFinite(Number(value)) && Number(value) > 0; }
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

async function collectPage(influencerId, cursor, signal) {
  const response = await fetch(`${config.SUPABASE_URL}/functions/v1/keychallenge-collect`, {
    method: 'POST', signal,
    headers: { apikey: config.SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ influencerId, cursor }),
  });
  let result;
  try { result = await response.json(); }
  catch { throw new Error('수집 서버의 응답을 읽지 못했습니다. 잠시 후 다시 시도해 주세요.'); }
  if (response.status === 401) throw new Error('로그인이 만료되었습니다. 다시 로그인한 뒤 수집해 주세요.');
  if (!response.ok) throw new Error(result.error || '자동 수집에 실패했습니다. 잠시 후 다시 시도해 주세요.');
  return result;
}

async function startCollection() {
  if (collectionController) return;
  if (!session) return notify('로그인 후 수집해 주세요.', true);
  const id = normalizeId(byId('influencerInput').value).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{0,99}$/.test(id)) {
    return notify('올바른 네이버 인플루언서 ID 또는 인플홈 주소를 입력해 주세요.', true);
  }
  const controller = new AbortController();
  const userId = session.user.id;
  collectionController = controller;
  byId('collectButton').disabled = true;
  byId('collectButton').textContent = '자동 수집 중…';
  byId('influencerInput').disabled = true;
  byId('collectorGuide').hidden = false;
  byId('cancelCollectionButton').hidden = false;
  byId('cancelCollectionButton').disabled = false;
  byId('collectorStatus').textContent = '인플홈 확인 중';
  byId('collectionProgress').max = 1;
  byId('collectionProgress').value = 0;
  byId('collectionProgressText').textContent = `${id}의 공개 참여 목록을 확인하고 있습니다.`;
  byId('notice').hidden = true;
  try {
    let cursor = null;
    let ownerId = null;
    let total = null;
    let collectedAt;
    const rows = new Map();
    const cursors = new Set();
    while (true) {
      controller.signal.throwIfAborted();
      if (session?.user.id !== userId) throw new DOMException('Session changed', 'AbortError');
      const page = await collectPage(id, cursor, controller.signal);
      const validTotal = Number.isInteger(page.total) && page.total >= 0 && page.total <= 200000;
      if (page.influencerId !== id || !Array.isArray(page.items)
          || (!validTotal && !(total !== null && page.total === null))) {
        throw new Error('목록 형식이 변경되어 수집을 완료하지 못했습니다.');
      }
      ownerId ??= page.ownerId;
      total ??= page.total;
      if (ownerId !== page.ownerId || (page.total !== null && total !== page.total)) {
        throw new Error('수집 중 네이버 목록이 변경되었습니다. 다시 수집해 주세요.');
      }
      for (const item of page.items) rows.set(String(item.id), item);
      collectedAt = page.collectedAt;
      byId('collectorStatus').textContent = '키워드 수집 중';
      byId('collectionProgress').max = Math.max(total, 1);
      byId('collectionProgress').value = rows.size;
      byId('collectionProgressText').textContent = `${rows.size.toLocaleString()} / ${total.toLocaleString()}개 키워드`;
      cursor = page.nextCursor;
      if (cursor === null || cursor === '') break;
      if (!page.items.length || cursors.has(cursor) || cursors.size >= 2000 || rows.size > total) {
        throw new Error('네이버 목록을 끝까지 읽지 못했습니다. 잠시 후 다시 수집해 주세요.');
      }
      cursors.add(cursor);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (rows.size !== total) throw new Error('일부 키워드가 누락되어 저장하지 않았습니다. 잠시 후 다시 수집해 주세요.');
    controller.signal.throwIfAborted();
    if (session?.user.id !== userId) throw new DOMException('Session changed', 'AbortError');
    byId('collectorStatus').textContent = '내 계정에 저장 중';
    byId('cancelCollectionButton').disabled = true;
    await saveProfile({ version: '3.1', source: 'naver-public', influencerId: id, ownerId, total, collectedAt, items: [...rows.values()] });
    if (session?.user.id !== userId) return;
    byId('collectionProgress').value = Math.max(total, 1);
    byId('collectorStatus').textContent = '자동 수집 완료';
    byId('collectionProgressText').textContent = `${total.toLocaleString()}개 키워드가 저장되었습니다. 전체 목록에서 내 참여 여부를 비교할 수 있습니다.`;
    notify(`${id}의 키워드 ${total.toLocaleString()}개를 자동 수집해 저장했습니다.`);
  } catch (error) {
    if (session?.user.id === userId) {
      const cancelled = controller.signal.aborted || error.name === 'AbortError';
      byId('collectorStatus').textContent = cancelled ? '수집 취소됨' : '수집을 완료하지 못했습니다';
      byId('collectionProgressText').textContent = '이전에 저장한 데이터는 그대로 유지됩니다.';
      notify(cancelled ? '수집을 취소했습니다.' : error.message, !cancelled);
    }
  } finally {
    if (collectionController === controller) {
      collectionController = null;
      byId('collectButton').disabled = false;
      byId('collectButton').textContent = '자동 수집 시작';
      byId('influencerInput').disabled = false;
      byId('cancelCollectionButton').hidden = true;
    }
  }
}

function exportBackup() {
  const backup = { version: '3.0', exportedAt: new Date().toISOString(), profiles: Object.fromEntries(profiles) };
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
      const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } });
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
  catalog = createCatalog(supabase);
  void catalog.initialize();
  await loadRefreshSchedule();
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
  collectionController?.abort();
  const { error } = await supabase.auth.signOut();
  if (error) notify(error.message, true);
});
byId('collectButton').addEventListener('click', startCollection);
byId('cancelCollectionButton').addEventListener('click', () => collectionController?.abort());
byId('autoRefreshToggle').addEventListener('change', toggleAutoRefresh);
byId('exportButton').addEventListener('click', exportBackup);
byId('importInput').addEventListener('change', importFiles);
for (const id of ['searchInput', 'rankFilter', 'sortSelect']) byId(id).addEventListener('input', renderTable);
initialize();
