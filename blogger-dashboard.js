const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const count = value => Number(value || 0).toLocaleString('ko-KR');
const date = value => value ? new Date(value).toLocaleDateString('ko-KR', {timeZone:'Asia/Seoul',month:'numeric',day:'numeric'}) : '—';
const volume = row => row.volume_min == null ? '미확인' : row.volume_min === row.volume_max ? count(row.volume_min) : `${count(row.volume_min)}–${count(row.volume_max)}`;
const empty = text => `<div class="work-empty">${esc(text)}</div>`;

export function createBloggerDashboard(client, {notify, onSearch}) {
  const root = $('bloggerView');
  let user = null, settings = null, contextKey = '', generation = 0;
  let data = null, visible = false, loading = false, loadedAt = 0, reloadAfter = false;
  const saving = new Set();

  root.innerHTML = `<div class="work-heading"><div><p class="eyebrow">YOUR NEXT STORY</p><h1>키온 대시보드</h1><p class="muted">다음 글의 주제를 찾고, 내 글의 검색 확인 변화를 살펴보세요.</p></div><button class="button button-light" data-discovery-action="refresh">추천 새로고침</button></div>
    <div id="discoveryStatus" class="message" role="status"></div><div id="discoveryBody"></div>`;

  function actions(row) {
    return `<div class="work-card-actions"><button class="button button-quiet" data-discovery-action="save" data-keyword="${esc(row.keyword)}" ${row.saved?'disabled':''}>${row.saved?'보관됨 ✓':'글감 보관'}</button><button class="work-text-button" data-discovery-action="search" data-keyword="${esc(row.keyword)}">키워드 검색으로</button></div>`;
  }
  function idea(row, index) {
    const angles = [
      ['경험 정리', '직접 경험한 내용이 있다면 과정, 장단점, 미리 알면 좋은 점을 정리해 보세요.'],
      ['궁금증 해결', '처음 찾아보는 사람이 궁금해할 질문과 답을 중심으로 구성해 보세요.'],
      ['비교와 선택', '선택 기준과 확인할 사항을 비교해 독자의 결정을 도와주세요.']
    ];
    const [angle, description] = angles[index % angles.length];
    return `<article class="work-keyword-card discovery-idea"><div class="work-section-title"><span class="count-chip">${row.saved?'보관한 글감':esc(row.field || '관심 키워드')}</span><span class="discovery-angle">${angle}</span></div><h3>${esc(row.keyword)}</h3><p class="discovery-prompt">${description}</p><p class="work-volume">${volume(row)}<small>월 검색량 · ${row.collected_at?`${date(row.collected_at)} 조회`:'최근 조회 기록 없음'}</small></p><small class="muted">${data.post_count?'수집된 글 제목에서 이 키워드를 찾지 못했어요.':'글 수집 전으로, 관심 분야와 보관함에서 추천합니다.'}</small>${actions(row)}</article>`;
  }
  function metric(label, value, detail, target, type='') {
    const attr = target.startsWith('#') ? `href="${target}"` : `type="button" data-discovery-action="jump" data-section="${target}"`;
    const tag = target.startsWith('#') ? 'a' : 'button';
    return `<${tag} ${attr} class="panel metric ${type}"><span>${label}</span><strong>${count(value)}<span class="discovery-unit">개</span></strong><small>${detail}</small></${tag}>`;
  }
  function render() {
    const interest = data.interest || '관심 분야 미설정';
    const baseline = data.post_count ? `수집된 글 ${count(data.post_count)}편의 제목과 비교` : '글 수집 전 · 분야 기반 추천';
    const changed = data.changes.length ? data.changes.map(row => {
      const positive = row.last_result === 'found';
      const label = row.change === 'first_found' ? '처음 검색 확인' : positive ? '미확인 → 검색 확인' : '검색 확인 → 미확인';
      return `<div class="work-list-row discovery-change"><div><a href="https://blog.naver.com/${encodeURIComponent(row.blog_id)}/${encodeURIComponent(row.post_id)}" target="_blank" rel="noopener noreferrer"><strong>${esc(row.title)} ↗</strong></a><small>${date(row.last_result_at)} 점검 · ${row.change==='first_found'?'첫 확인 기록':'이전 점검 결과와 비교'}</small></div><span class="discovery-change-label ${positive?'change-up':'change-down'}">${label}</span></div>`;
    }).join('') : empty('최근 7일의 검색 확인 변화가 아직 없습니다. 내 블로그 분석에서 수동 점검하면 결과가 반영됩니다.');
    const saved = data.recent_saved.length ? data.recent_saved.map(row => `<div class="work-list-row"><span><strong>${esc(row.keyword)}</strong><small>${esc(row.folder || '미분류')} · ${data.post_count?(row.title_matched?'수집된 글 제목에 포함':'수집된 글 제목에 없음'):'글 수집 전'}</small>${row.notes?`<p class="discovery-saved-note">${esc(row.notes)}</p>`:''}</span><span class="discovery-saved-volume">${volume(row)}<small>월 검색량</small></span></div>`).join('') : empty('추천 글감의 ‘글감 보관’을 눌러 다음에 쓸 주제를 모아 보세요.');
    $('discoveryBody').innerHTML = `
      <div class="discovery-context"><div><span class="profile-chip">${esc(interest)}</span><span class="muted small">${baseline}</span></div><a href="#accountView">관심 분야 변경 ↗</a></div>
      ${!data.interest || data.interest==='기타' ? '<div class="analysis-note">내 설정에서 구체적인 관심 분야를 선택하면 분야별 추천을 받을 수 있습니다. 지금은 보관한 키워드에서 글감을 찾습니다. <a href="#accountView">분야 선택하기 ↗</a></div>' : ''}
      <div class="strategy-stats work-stats discovery-stats">
        ${metric('보관 중인 글감',data.saved_count,'내가 저장한 키워드','#savedKeywordsView')}
        ${metric('새 글감 후보',data.opportunity_count,data.post_count?'추천 후보 중 글 제목에 없는 키워드':'글 수집 전 · 작성 여부 비교 전','discoveryIdeas','metric-purple')}
        ${metric('새로 검색 확인',data.new_found_count,'최근 7일 · 첫 확인 포함','discoveryChanges','metric-green')}
        ${metric('미확인으로 변경',data.unconfirmed_change_count,'최근 7일 · 이전에는 확인된 글','discoveryChanges')}
      </div>
      <section id="discoveryIdeas" class="panel work-panel"><div class="work-section-title"><div><p class="eyebrow">TODAY’S IDEAS</p><h2>오늘의 추천 글감</h2></div><span class="count-chip">${esc(data.day.replaceAll('-','/'))} 기준</span></div><p class="muted discovery-description">관심 분야와 보관한 키워드에서 다음 글의 주제를 골라 보세요.</p><div class="work-keyword-grid">${data.ideas.length?data.ideas.map(idea).join(''):empty('아직 추천할 글감이 없습니다. 관심 분야를 선택하거나 키워드 검색에서 글감을 보관해 주세요.')}</div></section>
      <section class="panel work-panel"><div class="work-section-title"><div><p class="eyebrow">KEYWORD OPPORTUNITIES</p><h2>검색량 높은 새 글감 TOP 10</h2></div><a href="#keywordSearchView">다른 키워드 찾기 ↗</a></div><p class="muted discovery-description">${data.post_count?'수집된 글 제목에서 찾지 못한 후보를 월 검색량순으로 보여드립니다.':'아직 글을 수집하지 않아, 관심 분야의 검색량 높은 후보를 보여드립니다.'}</p>
      <ol class="discovery-opportunities">${data.opportunities.length?data.opportunities.map((row,index)=>`<li><span class="priority-number">${index+1}</span><div class="discovery-keyword"><strong>${esc(row.keyword)}</strong><small class="muted">${esc(row.field || '내 보관함')} · ${date(row.collected_at)} 조회</small></div><div class="discovery-volume"><strong>${volume(row)}</strong><small>월 검색량</small></div><button class="button button-light" data-discovery-action="save" data-keyword="${esc(row.keyword)}" ${row.saved?'disabled':''}>${row.saved?'보관됨 ✓':'글감 보관'}</button></li>`).join(''):''}</ol>
      ${!data.opportunities.length?empty('최근 30일 내 검색량이 확인된 추천 후보가 없습니다. 관심 분야를 확인하거나 키워드 검색에서 새로운 글감을 찾아보세요.'):''}
      <p class="catalog-footnote">추천은 공용 목록의 관심 분야 키워드와 내 보관함을 기준으로 합니다. 제목에 없더라도 과거에 작성했을 수 있습니다.</p></section>
      <div class="work-two-columns"><section id="discoveryChanges" class="panel work-panel"><div class="work-section-title"><h2>검색 확인 변화</h2><a href="#blogAnalysisView">내 글 점검하기 ↗</a></div><p class="muted discovery-description">최근 7일의 마지막 점검을 이전 결과와 비교합니다.</p>${changed}<p class="catalog-footnote">검색 결과에서 확인했는지를 보여줍니다. 검색 순위 변동이나 글 누락 판정은 아닙니다.</p></section>
      <section class="panel work-panel"><div class="work-section-title"><h2>다시 꺼내볼 보관 글감</h2><a href="#savedKeywordsView">보관함 전체 보기 ↗</a></div>${saved}</section></div>
      <details class="discovery-method"><summary>추천 기준과 데이터 범위</summary><p>관심 분야의 검색량 높은 키워드 최대 300개와 내 보관함을 후보로 사용합니다. 수집된 글 제목에 키워드가 포함되어 있으면 추천에서 제외합니다. 공백과 영문 대소문자를 정리한 단순 제목 비교이며, 글 본문이나 블로그 전체 이력을 분석한 결과는 아닙니다.</p><p>오늘의 추천은 후보 중 상위 30개에서 날짜별로 3개를 고릅니다. 보관 키워드를 우선 후보에 넣으며, 검색량은 최근 30일 안에 조회한 네이버 검색광고 PC·모바일 합계입니다. 검색량을 확인하지 않은 보관 글감은 ‘미확인’으로 표시합니다.</p><p>대시보드는 저장된 데이터를 사용합니다. 새로고침해도 검색 노출 점검 횟수는 차감되지 않으며, 실제 점검은 내 블로그 분석의 버튼을 눌렀을 때만 실행됩니다.</p></details>`;
  }
  async function load() {
    if (!user || settings?.mode !== 'blogger') return;
    if (loading) { reloadAfter = true; return; }
    const g = generation;
    loading = true; reloadAfter = false;
    root.querySelector('[data-discovery-action="refresh"]').disabled = true;
    $('discoveryStatus').textContent = '내 관심 분야의 추천 글감을 불러오는 중…';
    $('discoveryBody').setAttribute('aria-busy','true');
    try {
      const result = await client.rpc('keychallenge_blogger_discovery');
      if (g !== generation) return;
      if (result.error) throw result.error;
      data = result.data; loadedAt = Date.now(); render();
      $('discoveryStatus').textContent = '';
    } catch (error) {
      if (g !== generation) return;
      $('discoveryStatus').textContent = data ? '최신 추천을 불러오지 못해 이전 결과를 보여드립니다. 추천 새로고침으로 다시 시도해 주세요.' : '추천을 불러오지 못했습니다. 추천 새로고침으로 다시 시도해 주세요.';
    } finally {
      if (g === generation) {
        loading = false;
        root.querySelector('[data-discovery-action="refresh"]').disabled = false;
        $('discoveryBody').setAttribute('aria-busy','false');
        if (reloadAfter && visible) { reloadAfter = false; void load(); }
      }
    }
  }
  root.addEventListener('click', async event => {
    const button = event.target.closest('[data-discovery-action]');
    if (!button || button.disabled || !user) return;
    const action = button.dataset.discoveryAction;
    if (action === 'refresh') { void load(); return; }
    if (action === 'jump') { $(button.dataset.section)?.scrollIntoView({behavior:'smooth',block:'start'}); return; }
    if (action === 'search') { onSearch(button.dataset.keyword); return; }
    if (action !== 'save' || saving.has(button.dataset.keyword)) return;
    const keyword = button.dataset.keyword, g = generation;
    saving.add(keyword); button.disabled = true;
    try {
      const result = await client.rpc('keychallenge_save_blog_keyword',{p_keyword:keyword});
      if (g !== generation) return;
      if (result.error) throw result.error;
      root.querySelectorAll('[data-discovery-action="save"]').forEach(el => {
        if (el.dataset.keyword === keyword) { el.disabled = true; el.textContent = '보관됨 ✓'; }
      });
      notify('보관함에 저장했습니다.');
      loadedAt = 0; void load();
    } catch (error) {
      if (g === generation) { button.disabled = false; notify(error.message || '글감을 보관하지 못했습니다.',true); }
    } finally { if (g === generation) saving.delete(keyword); }
  });
  return {
    setContext(nextUser,nextSettings) {
      const key = JSON.stringify([nextUser?.id,nextSettings?.mode,nextSettings?.blog_id,nextSettings?.interest]);
      user = nextUser; settings = nextSettings;
      if (key === contextKey) return;
      contextKey = key; generation++; data = null; loadedAt = 0; loading = false; reloadAfter = false; saving.clear();
      $('discoveryBody').innerHTML = ''; $('discoveryStatus').textContent = '';
      root.querySelector('[data-discovery-action="refresh"]').disabled = false;
    },
    invalidate() { loadedAt = 0; },
    show(page) {
      const entering = !visible && page === 'bloggerView';
      visible = page === 'bloggerView';
      if (visible && !loading && (entering || !data || Date.now()-loadedAt>60000)) void load();
    }
  };
}
