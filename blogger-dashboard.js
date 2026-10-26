import { createKeywordOpportunities } from './keyword-opportunities.js';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const count = value => Number(value || 0).toLocaleString('ko-KR');
const date = value => value ? new Date(value).toLocaleDateString('ko-KR', {timeZone:'Asia/Seoul',month:'numeric',day:'numeric'}) : '—';
const queryDate = value => value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleDateString('sv-SE', {timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).replaceAll('-','/') : '미조회';
const volume = row => row.volume_min == null ? '미확인' : row.volume_min === row.volume_max ? count(row.volume_min) : `${count(row.volume_min)}–${count(row.volume_max)}`;
const empty = text => `<div class="work-empty">${esc(text)}</div>`;

export function createBloggerDashboard(client, {notify, onSearch}) {
  const root = $('bloggerView');
  let user = null, settings = null, contextKey = '', generation = 0;
  let data = null, visible = false, loading = false, loadedAt = 0, reloadAfter = false;
  let refreshTimer=null,polling=false,pollAttempts=0,readVersion=0;
  let attackRanking=null,attackRankingLoading=false,attackRankingRequest=0;
  const saving = new Set();

  root.innerHTML = `<div class="work-heading"><div><p class="eyebrow">YOUR NEXT STORY</p><h1>키온 대시보드</h1><p class="muted">오늘 쓸 글감을 고르고, 내 경험과 관점으로 풀어보세요.</p></div><button class="button button-light" data-discovery-action="refresh">추천 새로고침</button></div>
    <div id="discoveryStatus" class="message" role="status"></div><div id="discoveryOverview"></div><section id="bloggerOpportunities" class="panel work-panel"></section><div id="discoveryBody"></div>`;

  const opportunities=createKeywordOpportunities(client,{
    rootId:'bloggerOpportunities',mode:'blogger',onDetail:onSearch,
    onSaved(){loadedAt=0;void load(false);}
  });

  function actions(row) {
    return `<div class="discovery-row-actions"><button class="button button-light" data-discovery-action="save" data-keyword="${esc(row.keyword)}" ${row.saved?'disabled':''}>${row.saved?'보관됨 ✓':'글감 보관'}</button></div>`;
  }
  function idea(row, index) {
    const reasons = [row.saved ? '내가 보관한 관심 키워드' : '관심 분야의 검색량 상위 후보', data.post_count ? '수집된 글 제목에 없는 키워드' : '글 수집 전 · 작성 여부 미비교'];
    return `<tr><td><div class="discovery-idea-name"><span class="priority-number">${index+1}</span><strong>${esc(row.keyword)}</strong></div></td><td>${esc(row.field || '미지정')}</td><td><strong>${volume(row)}</strong></td><td>${queryDate(row.collected_at)}</td><td class="reason">${reasons.map(esc).join('<br>')}</td><td>${actions(row)}</td></tr>`;
  }
  function metric(label, value, detail, target, type='') {
    const attr = target.startsWith('#') ? `href="${target}"` : `type="button" data-discovery-action="jump" data-section="${target}"`;
    const tag = target.startsWith('#') ? 'a' : 'button';
    return `<${tag} ${attr} class="panel metric ${type}"><span>${label}</span><strong>${count(value)}<span class="discovery-unit">개</span></strong><small>${detail}</small></${tag}>`;
  }

  function topKeywordsContent(){return `<div class="work-section-title"><div><p class="eyebrow">KEYWORD OPPORTUNITIES</p><h2>검색량 높은 새 글감 <span class="count-chip">TOP10</span></h2></div><a href="#keywordSearchView">다른 키워드 찾기 ↗</a></div><p class="muted discovery-description">${data.post_count?'수집된 글 제목에서 찾지 못한 후보를 월 검색량순으로 보여드립니다.':'아직 글을 수집하지 않아, 관심 분야의 검색량 높은 후보를 보여드립니다.'}</p>
      <p class="message" role="status" aria-live="polite">${esc(volumeRefreshMessage())}</p><ol class="discovery-opportunities">${data.opportunities.length?data.opportunities.map((row,index)=>`<li><span class="priority-number">${index+1}</span><div class="discovery-keyword"><strong>${esc(row.keyword)}</strong><small class="muted">${esc(row.field || '내 보관함')} · 검색량 수집 ${date(row.collected_at)}</small></div><div class="discovery-volume"><strong>${volume(row)}</strong><small>월 검색량</small></div><button class="button button-light" data-discovery-action="save" data-keyword="${esc(row.keyword)}" ${row.saved?'disabled':''}>${row.saved?'보관됨 ✓':'글감 보관'}</button></li>`).join(''):''}</ol>
      ${!data.opportunities.length?empty('최근 30일 내 검색량이 확인된 추천 후보가 없습니다. 관심 분야를 확인하거나 키워드 검색에서 새로운 글감을 찾아보세요.'):''}
      <p class="catalog-footnote">추천은 공용 목록의 관심 분야 키워드와 내 보관함을 기준으로 합니다. 제목에 없더라도 과거에 작성했을 수 있습니다.</p>`;}
  function attackRankingContent(){
    const rows=attackRanking?.items||[];
    const table=rows.length?`<div class="table-wrap blogger-attack-table"><table class="tbl strategy-table"><thead><tr><th>우선</th><th>키워드</th><th>분야</th><th>참여자</th><th>월 검색량</th><th>점수</th><th>공략 이유</th></tr></thead><tbody>${rows.map((row,index)=>`<tr><td><span class="priority-number">${index+1}</span></td><td><strong class="blogger-attack-keyword">${esc(row.keyword)}</strong></td><td>${esc(row.field||'관심 분야')}</td><td>${count(row.participant_count)}명</td><td>${volume(row)}</td><td><strong>${count(row.score)}점</strong></td><td class="reason">${[row.reasons?.[0],row.reasons?.[3]].filter(Boolean).map(esc).join(' · ')}</td></tr>`).join('')}</tbody></table></div>`:'';
      return `<section class="panel work-panel" id="discoveryRanking"><div class="section-heading"><div><p class="eyebrow">TODAY’S KEYWORD ATTACK</p><h2>오늘의 키워드 공략 <span class="count-chip">TOP10</span></h2><p class="muted">내 블로그 주제와의 적합도, 최신 관심도, 키챌 경쟁 여지, 아직 다루지 않은 정도를 함께 반영합니다.</p></div><span class="count-chip">${esc(data.day.replaceAll('-','/'))} 기준</span></div>${attackRankingLoading&&!attackRanking?'<p class="message">공략 후보를 불러오는 중…</p>':table||empty('최근 글 제목에 없는 공략 후보가 없습니다. 관심 분야를 설정하거나 글 수집 후 다시 확인해 주세요.')}<details class="score-note"><summary>공략 순위는 어떻게 정하나요?</summary><p>점수는 적합도 30%(관심 분야와 최근 글 주제 연결), 최신 관심도 25%(월 검색량), 경쟁 여지 25%(참여자 대비 수요와 참여자 수), 미다룸 정도 20%(최근 글 제목과 연결된 주제 글 수)를 반영합니다.</p><p>검색량은 최근 30일 내 수집한 네이버 월간 수치라 상승·하락 추세는 포함하지 않습니다. 추천은 검색 노출이나 순위 상승을 보장하지 않습니다.</p></details></section>`;
  }
  function renderAttackRanking(){const host=$('discoveryAttackRanking');if(host)host.innerHTML=attackRankingContent();}
  async function loadAttackRanking(generationAtRequest=generation){
    const request=++attackRankingRequest;attackRanking=null;attackRankingLoading=true;renderAttackRanking();
    try{const result=await client.rpc('keychallenge_blogger_keyword_attack_top10');if(generationAtRequest!==generation||request!==attackRankingRequest)return;if(result.error)throw result.error;attackRanking=result.data;}
    catch{if(generationAtRequest===generation&&request===attackRankingRequest)attackRanking=null;}
    finally{if(generationAtRequest===generation&&request===attackRankingRequest){attackRankingLoading=false;renderAttackRanking();}}
  }
  function volumeRefreshMessage(){const refresh=data?.volume_refresh;if(!refresh)return '검색량의 수집 날짜를 확인해 주세요.';if(refresh.status==='fresh')return data.opportunities.length?'오늘 수집한 월 검색량을 반영했습니다.':'확인할 검색량 후보가 없습니다.';if(refresh.status==='disabled')return '검색량 자동 갱신이 일시 중지되어 마지막 수집값을 보여드립니다.';if(refresh.status==='error')return '검색량을 갱신하지 못해 마지막 수집값을 보여드립니다. 관리자가 수집 상태를 확인해야 합니다.';if(pollAttempts>=40)return '검색량 갱신이 계속되고 있습니다. 다음 접속 때 결과를 자동으로 반영합니다.';if(refresh.status==='refreshing')return '추천 후보의 검색량을 갱신 중입니다. 완료되면 이 목록에 자동으로 반영됩니다.';return '최근 검색량을 아직 확인하지 못해 마지막 수집값을 보여드립니다.';}
function stopVolumePoll(){if(refreshTimer!==null){clearTimeout(refreshTimer);refreshTimer=null;}}
function renderTopKeywords(){const section=$('discoveryTopKeywords');if(section)section.innerHTML=topKeywordsContent();}
function scheduleVolumePoll(){stopVolumePoll();if(!visible||document.hidden||!data||data.volume_refresh?.status!=='refreshing'||pollAttempts>=40)return;const g=generation;refreshTimer=setTimeout(async()=>{refreshTimer=null;if(g!==generation||!visible||document.hidden)return;if(loading||polling){scheduleVolumePoll();return;}polling=true;pollAttempts++;const version=++readVersion;try{const result=await client.rpc('keychallenge_blogger_discovery_fresh',{p_enqueue:true});if(g!==generation||version!==readVersion)return;if(result.error)throw result.error;data.opportunities=result.data.opportunities;data.volume_refresh=result.data.volume_refresh;data.post_count=result.data.post_count;renderTopKeywords();}catch{if(g===generation&&version===readVersion)renderTopKeywords();}finally{if(g===generation){polling=false;scheduleVolumePoll();}}},15000);}
  function render() {
    const interest = data.interest || '관심 분야 미설정';
    const baseline = data.post_count ? `수집된 글 ${count(data.post_count)}편의 제목과 비교` : '글 수집 전 · 분야 기반 추천';
    $('discoveryOverview').innerHTML = `
      <div class="discovery-context"><div><span class="profile-chip">${esc(interest)}</span><span class="muted small">${baseline}</span></div><a href="#accountView">관심 분야 변경 ↗</a></div>
      ${!data.interest || data.interest==='기타' ? '<div class="analysis-note">내 설정에서 구체적인 관심 분야를 선택하면 분야별 추천을 받을 수 있습니다. 지금은 보관한 키워드에서 글감을 찾습니다. <a href="#accountView">분야 선택하기 ↗</a></div>' : ''}
      <div class="strategy-stats work-stats discovery-stats">
        ${metric('보관 중인 글감',data.saved_count,'내가 저장한 키워드','#savedKeywordsView')}
        ${metric('새 글감 후보',data.opportunity_count,data.post_count?'추천 후보 중 글 제목에 없는 키워드':'글 수집 전 · 작성 여부 비교 전','discoveryRanking','metric-purple')}
      </div>
      <div id="discoveryAttackRanking">${attackRankingContent()}</div>
      `;
    $('discoveryBody').innerHTML = `
      <section id="discoveryIdeas" class="panel work-panel"><div class="work-section-title"><div><p class="eyebrow">TODAY’S IDEAS</p><h2>오늘의 추천 글감 <span class="count-chip">TOP10</span></h2></div><a href="#keywordSearchView">다른 키워드 찾기 ↗</a></div><p class="muted discovery-description">관심 분야와 보관한 키워드에서 고른 오늘의 글감입니다. 검색량 조회 일자와 추천 이유를 함께 확인하세요.</p>${data.ideas.length?`<div class="table-wrap discovery-ideas-table" tabindex="0" role="region" aria-label="오늘의 추천 글감 표"><table class="tbl strategy-table"><thead><tr>${['글감','분야','월 검색량','조회 일자','추천 이유','보관'].map(label=>`<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${data.ideas.map(idea).join('')}</tbody></table></div><p class="catalog-footnote">조회 일자는 네이버 월 검색량을 수집한 날짜입니다. 순번은 오늘의 추천 순서이며 월 검색량순은 아닙니다.</p>`:empty('아직 추천할 글감이 없습니다. 관심 분야를 선택하거나 키워드 검색에서 글감을 보관해 주세요.')}</section>

      <section id="discoveryTopKeywords" class="panel work-panel">${topKeywordsContent()}</section>
      <details class="discovery-method"><summary>추천 기준과 데이터 범위</summary><p>관심 분야의 검색량 높은 키워드 최대 300개와 내 보관함을 후보로 사용합니다. 수집된 글 제목에 키워드가 포함되어 있으면 추천에서 제외합니다. 공백과 영문 대소문자를 정리한 단순 제목 비교이며, 글 본문이나 블로그 전체 이력을 분석한 결과는 아닙니다.</p><p>오늘의 추천은 후보 중 상위 30개에서 한국시간 날짜별로 최대 10개를 고릅니다. 후보가 적으면 확보된 개수만 표시합니다. 순번은 오늘의 추천 목록 순서이며 월 검색량순은 아닙니다. 보관 키워드를 우선 후보에 넣으며, 검색량은 최근 30일 안에 조회한 네이버 검색광고 PC·모바일 합계입니다. 검색량을 확인하지 않은 보관 글감은 ‘미확인’으로 표시합니다.</p><p>접속하거나 대시보드를 열면 오늘 확인하지 않은 추천 후보의 검색량을 우선 갱신합니다. 오늘 수집한 검색량은 회원들이 함께 재사용하며, 갱신이 끝나면 TOP 10에 자동으로 반영됩니다. 매일 오전 4시 15분부터 분야별 검색량 상위 후보도 순차 갱신합니다. 검색량은 네이버가 제공하는 월 단위 수치입니다. 검색 노출 점검 횟수는 차감되지 않습니다.</p></details>`;
  }
  async function load(refreshOpportunities=true) {
    if (!user || settings?.mode !== 'blogger') return;
    if (loading) { reloadAfter = true; return; }
    const g = generation, version=++readVersion;
    stopVolumePoll();pollAttempts=0;
    if(refreshOpportunities)void opportunities.load();
    loading = true; reloadAfter = false;
    root.querySelector('[data-discovery-action="refresh"]').disabled = true;
    $('discoveryStatus').textContent = '내 관심 분야의 추천 글감을 불러오는 중…';
    $('discoveryBody').setAttribute('aria-busy','true');
    try {
      const result = await client.rpc('keychallenge_blogger_discovery_fresh',{p_enqueue:true});
      if (g !== generation) return;
      if (result.error) throw result.error;
      data = result.data; loadedAt = Date.now(); render(); void loadAttackRanking(g); scheduleVolumePoll();
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
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopVolumePoll();else if(visible&&!loading){if(Date.now()-loadedAt>60000)void load(false);else scheduleVolumePoll();}});
  return {
    setContext(nextUser,nextSettings) {
      const key = JSON.stringify([nextUser?.id,nextSettings?.mode,nextSettings?.blog_id,nextSettings?.interest]);
      user = nextUser; settings = nextSettings;
      opportunities.setContext(user,settings);
      if (key === contextKey) return;
      contextKey = key; generation++; attackRankingRequest++; attackRanking=null; attackRankingLoading=false; readVersion++; stopVolumePoll();polling=false;pollAttempts=0;data = null; loadedAt = 0; loading = false; reloadAfter = false; saving.clear();
      $('discoveryOverview').innerHTML = ''; $('discoveryBody').innerHTML = ''; $('discoveryStatus').textContent = '';
      root.querySelector('[data-discovery-action="refresh"]').disabled = false;
    },
    invalidate() { loadedAt = 0; },
    show(page) {
      const entering = !visible && page === 'bloggerView';
      visible = page === 'bloggerView';
      if(!visible)stopVolumePoll();
      if (visible && !loading && (entering || !data || Date.now()-loadedAt>60000)) void load();
    }
  };
}
