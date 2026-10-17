const $ = (id) => document.getElementById(id);
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);
const number = (value) => Number(value).toLocaleString('ko-KR');
const date = (value) => value ? new Date(value).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }) : '기준일 없음';

function text(value, label, max, optional = false) {
  if (value == null && optional) return null;
  if (!['string', 'number'].includes(typeof value)) throw new Error(`${label} 형식을 확인해 주세요.`);
  const result = String(value).trim();
  if ((!optional && !result) || result.length > max) throw new Error(`${label} 길이를 확인해 주세요.`);
  return result || null;
}

function parseCatalog(data) {
  const raw = Array.isArray(data) ? data : data.items || data.allKeywords;
  if (!Array.isArray(raw) || !raw.length || raw.length > 200000) {
    throw new Error('키워드 1~200,000개가 담긴 items 배열이 필요합니다.');
  }
  const ids = new Set();
  const fields = new Map();
  const items = raw.map((row, index) => {
    if (!row || typeof row !== 'object') throw new Error(`${index + 1}번째 키워드 형식이 잘못되었습니다.`);
    const id = text(row.id ?? row.keyword_id, '키워드 ID', 100);
    if (ids.has(id)) throw new Error(`중복된 키워드 ID가 있습니다: ${id}`);
    ids.add(id);
    const field = text(row.field || '미분류', '분야', 100);
    fields.set(field, (fields.get(field) || 0) + 1);
    const count = row.participantCount ?? row.participant_count ?? null;
    if (count !== null && (!Number.isInteger(count) || count < 0 || count > 2147483647)) {
      throw new Error(`${index + 1}번째 참여자 수를 확인해 주세요.`);
    }
    return {
      keyword_id: id, name: text(row.name, '키워드 이름', 200), field,
      field_group: text(row.fieldGroup ?? row.field_group, '상위 분야', 100, true),
      category_id: text(row.categoryId ?? row.category_id, '분야 ID', 100, true),
      participant_count: count,
    };
  });
  return { items, fields };
}

export function createCatalog(client) {
  let user = null;
  let profile = null;
  let isAdmin = false;
  let metadata = null;
  let page = 1;
  let searchVersion = 0;
  let contextVersion = 0;
  let pending = null;
  let busy = false;
  let timer;

  function adminMessage(message, error = false) {
    $('catalogImportMessage').textContent = message;
    $('catalogImportMessage').className = `message ${error ? 'error' : ''}`;
  }

  async function loadInfo() {
    const { data, error } = await client.rpc('keychallenge_catalog_info');
    if (error) throw error;
    metadata = data.catalog;
    $('catalogTotal').textContent = metadata ? number(metadata.total) : '0';
    $('catalogFieldCount').textContent = number(data.fields.length);
    $('catalogDate').textContent = metadata ? date(metadata.collected_at) : '등록 대기';
    $('catalogCoverage').textContent = metadata
      ? (metadata.coverage === 'all' ? '전체 분야 수집 목록' : '일부 수집 목록') : '목록 준비 중';
    $('catalogSource').textContent = metadata
      ? `${metadata.source_label} · 수집 기준 ${date(metadata.collected_at)}`
      : '관리자가 공용 키워드 목록을 등록하면 모든 사용자가 검색할 수 있습니다.';
    const previous = $('catalogField').value;
    $('catalogField').innerHTML = '<option value="">모든 분야</option>' + data.fields.map((f) =>
      `<option value="${escape(f.field)}">${escape(f.field)} (${number(f.count)})</option>`).join('');
    if (data.fields.some((f) => f.field === previous)) $('catalogField').value = previous;
  }

  async function search() {
    const version = ++searchVersion;
    $('catalogResults').setAttribute('aria-busy', 'true');
    $('catalogResultCount').textContent = '검색 중…';
    $('catalogPrev').disabled = true;
    $('catalogNext').disabled = true;
    try {
      const { data, error } = await client.rpc('keychallenge_search_catalog', {
        p_query: $('catalogSearch').value.trim(), p_field: $('catalogField').value,
        p_participation: $('catalogParticipation').value, p_influencer_id: profile?.influencerId || '',
        p_sort: $('catalogSort').value, p_page: page,
      });
      if (version !== searchVersion) return;
      if (error) throw error;
      $('catalogResultCount').textContent = `${number(data.total)}개 키워드`;
      const pages = Math.max(1, Math.ceil(data.total / 50));
      $('catalogPage').textContent = `${number(page)} / ${number(pages)} 페이지`;
      $('catalogPrev').disabled = page <= 1;
      $('catalogNext').disabled = page >= pages;
      $('catalogComparison').textContent = data.has_profile
        ? `${profile.influencerId} · ${date(data.profile_collected_at)} 수집 기준${data.profile_complete ? '' : ' · 일부 데이터일 수 있어 미참여 여부를 확정할 수 없습니다.'}`
        : '로그인 후 내 인플홈을 수집하면, 참여 여부와 순위를 함께 볼 수 있습니다.';
      if (!data.items.length) {
        $('catalogResults').innerHTML = `<div class="empty">${metadata ? '조건에 맞는 키워드가 없습니다. 검색어나 필터를 바꿔 보세요.' : '아직 공용 키워드 목록이 등록되지 않았습니다.'}</div>`;
        return;
      }
      $('catalogResults').innerHTML = `<table class="tbl catalog-table"><thead><tr><th>키워드</th><th>분야</th><th>참여자</th><th>내 참여 여부</th><th>내 순위</th></tr></thead><tbody>${data.items.map((row) => {
        const href = `https://search.naver.com/search.naver?where=influencer&query=${encodeURIComponent(row.name)}`;
        const status = row.joined === null ? '비교 전' : row.joined ? '참여' : data.profile_complete ? '미참여' : '기록 없음';
        const rank = Number(row.rank);
        return `<tr><td><a href="${escape(href)}" target="_blank" rel="noreferrer"><strong>${escape(row.name)}</strong> ↗</a></td><td>${escape(row.field)}</td><td>${row.participant_count === null ? '—' : `${number(row.participant_count)}명`}</td><td><span class="join-badge ${row.joined ? 'is-joined' : ''}">${status}</span></td><td>${row.joined && Number.isFinite(rank) && rank > 0 ? `${number(rank)}위` : '—'}</td></tr>`;
      }).join('')}</tbody></table>`;
    } catch (error) {
      if (version !== searchVersion) return;
      $('catalogResultCount').textContent = '검색을 완료하지 못했습니다';
      $('catalogResults').innerHTML = `<div class="empty">${escape(error.message)}<br />잠시 후 새로고침해 주세요.</div>`;
    } finally {
      if (version === searchVersion) $('catalogResults').setAttribute('aria-busy', 'false');
    }
  }

  async function setContext(nextUser, nextProfile) {
    const version = ++contextVersion;
    const changedUser = user?.id !== nextUser?.id;
    user = nextUser;
    profile = nextProfile;
    if (changedUser) {
      isAdmin = false;
      pending = null;
      $('catalogImportPreview').hidden = true;
      $('catalogPublish').disabled = true;
    }
    $('catalogParticipation').disabled = !profile;
    if (!profile) $('catalogParticipation').value = 'all';
    $('catalogAdmin').hidden = !isAdmin;
    $('adminNav').hidden = !isAdmin;
    $('adminBadge').hidden = !isAdmin;
    page = 1;
    void search();
    if (user) {
      const { data, error } = await client.rpc('keychallenge_is_admin');
      if (version !== contextVersion) return;
      isAdmin = !error && data === true;
      $('catalogAdmin').hidden = !isAdmin;
      $('adminNav').hidden = !isAdmin;
      $('adminBadge').hidden = !isAdmin;
    }
  }

  $('catalogSearch').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { page = 1; void search(); }, 300);
  });
  for (const id of ['catalogField', 'catalogParticipation', 'catalogSort']) {
    $(id).addEventListener('change', () => { page = 1; void search(); });
  }
  $('catalogPrev').addEventListener('click', () => { if (page > 1) { page--; void search(); } });
  $('catalogNext').addEventListener('click', () => { page++; void search(); });

  $('catalogFile').addEventListener('change', async (event) => {
    pending = null;
    $('catalogImportPreview').hidden = true;
    $('catalogPublish').disabled = true;
    const file = event.target.files?.[0];
    if (!file || !isAdmin || busy) return;
    try {
      if (file.size > 64 * 1024 * 1024) throw new Error('64MB 이하의 JSON 파일을 선택해 주세요.');
      const data = JSON.parse(await file.text());
      pending = parseCatalog(data);
      $('catalogImportSource').value = data.source || '관리자 등록 키워드 목록';
      $('catalogImportCoverage').value = data.coverage === 'all' ? 'all' : 'partial';
      const collected = data.collectedAt && new Date(data.collectedAt);
      $('catalogImportDate').value = collected && Number.isFinite(collected.getTime()) ? collected.toISOString().slice(0, 10) : '';
      pending.collectedAt = collected && Number.isFinite(collected.getTime()) ? collected.toISOString() : null;
      $('catalogPreviewSummary').textContent = `${number(pending.items.length)}개 키워드 · ${number(pending.fields.size)}개 분야`;
      $('catalogPreviewFields').textContent = [...pending.fields].map(([field, count]) => `${field} ${number(count)}개`).join(' · ');
      $('catalogImportPreview').hidden = false;
      $('catalogPublish').disabled = false;
      adminMessage('목록과 수집 범위를 확인한 뒤 공개하세요. 기존 목록은 새 목록의 업로드가 끝날 때까지 유지됩니다.');
    } catch (error) { pending = null; adminMessage(error.message, true); }
  });

  $('catalogImportForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!pending || !isAdmin || !user || busy) return;
    const uploadUser = user.id;
    const upload = pending;
    let published = false;
    busy = true;
    $('catalogImportControls').disabled = true;
    try {
      const source = text($('catalogImportSource').value, '출처', 160);
      const inputDate = $('catalogImportDate').value;
      if (!inputDate) throw new Error('목록 수집 기준일을 입력해 주세요.');
      const collectedAt = upload.collectedAt?.startsWith(inputDate) ? upload.collectedAt : new Date(`${inputDate}T00:00:00+09:00`).toISOString();
      const { data: created, error } = await client.from('keychallenge_catalogs').insert({
        source_label: source, coverage: $('catalogImportCoverage').value,
        collected_at: collectedAt, expected_count: upload.items.length, created_by: uploadUser,
      }).select('id').single();
      if (error) throw error;
      for (let offset = 0; offset < upload.items.length; offset += 500) {
        if (user?.id !== uploadUser) throw new Error('로그인 계정이 바뀌어 업로드를 중단했습니다.');
        const chunk = upload.items.slice(offset, offset + 500).map((item) => ({ ...item, catalog_id: created.id }));
        const { error: uploadError } = await client.from('keychallenge_catalog_items').insert(chunk);
        if (uploadError) throw uploadError;
        adminMessage(`공개 준비 중: ${number(Math.min(offset + 500, upload.items.length))} / ${number(upload.items.length)}개 업로드`);
      }
      if (user?.id !== uploadUser) throw new Error('로그인 계정이 바뀌었습니다.');
      const { error: publishError } = await client.rpc('keychallenge_publish_catalog', { p_catalog_id: created.id });
      if (publishError) throw publishError;
      published = true;
      adminMessage(`${number(upload.items.length)}개 키워드를 공개했습니다.`);
      pending = null;
      $('catalogFile').value = '';
      $('catalogImportPreview').hidden = true;
      $('catalogPublish').disabled = true;
      page = 1;
      await loadInfo();
      await search();
    } catch (error) {
      adminMessage(published ? `목록은 공개되었습니다. 화면을 새로고침해 주세요: ${error.message}` : `공개를 완료하지 못했습니다: ${error.message} · 새 파일로 다시 시도할 수 있습니다.`, true);
    } finally {
      busy = false;
      $('catalogImportControls').disabled = false;
    }
  });

  return {
    setContext,
    async initialize() {
      $('catalogView').hidden = false;
      try { await loadInfo(); await search(); }
      catch (error) {
        $('catalogSource').textContent = '목록을 불러오지 못했습니다.';
        $('catalogResults').textContent = error.message;
      }
    },
  };
}
