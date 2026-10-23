const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = value => value == null ? '—' : Number(value).toLocaleString('ko-KR');
const rank = value => value > 0 ? `${num(value)}위` : '—';
const date = value => value ? new Date(value).toLocaleString('ko-KR', {timeZone:'Asia/Seoul',dateStyle:'medium',timeStyle:'short'}) : '—';
const volume = row => row.volume_min == null ? '미수집' : row.volume_min === row.volume_max ? num(row.volume_min) : `${num(row.volume_min)}–${num(row.volume_max)}`;
const empty = message => `<div class="strategy-empty">${esc(message)}</div>`;
const table = (head, body) => `<div class="table-wrap"><table class="tbl strategy-table"><thead><tr>${head.map(v=>`<th>${v}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
const delta = row => row.gain > 0 ? `<span class="change-up">▲ ${num(row.gain)}</span>` : row.gain < 0 ? `<span class="change-down">▼ ${num(-row.gain)}</span>` : row.current_rank && !row.previous_rank ? '<span class="change-up">순위 진입</span>' : !row.current_rank && row.previous_rank ? '<span class="change-down">순위 미확인</span>' : '유지';

export function createStrategy(client) {
  let user = null, profile = null, data = null, fields = [], version = 0, contextVersion = 0, detailVersion = 0, searchVersion = 0, page = 1, mover = 'up', timer;
  const records = new Map();
  $('strategyView').innerHTML = `
    <div class="strategy-heading"><div><p class="eyebrow">YOUR DAILY KEYWORD BRIEF</p><h1>키온 대시보드</h1><p id="strategySubtitle" class="muted">오늘 집중할 키워드를 한눈에 확인하세요.</p></div><a id="strategyManageLink" class="button button-light" href="#accountView" hidden>인플홈 관리 ↗</a></div>
    <div id="strategyEmpty" class="panel strategy-welcome" aria-live="polite" aria-busy="true"><h2 id="strategyWelcomeTitle">연결 정보를 불러오고 있어요.</h2><p id="strategyWelcomeDescription" class="muted">잠시만 기다려 주세요.</p><a id="strategyConnect" class="button" href="#accountView" hidden>인플홈 연결하기</a><button id="strategyRetry" class="button" hidden>다시 불러오기</button><p id="strategyWelcomeNote" class="muted small" hidden>처음 한 번 연결하면 다음 로그인부터 내 대시보드가 바로 열립니다.</p></div>
    <div id="strategyContent" hidden>
      <div class="strategy-context"><div><span id="strategyProfile" class="profile-chip"></span><span id="strategyDate" class="muted small"></span></div><div class="strategy-controls"><label>분야<select id="strategyField"><option value="__mine__">내 주요 분야</option><option value="">모든 분야</option></select></label><button id="strategyRefresh" class="button button-quiet">새로고침</button></div></div>
      <p id="strategyError" class="message error" role="status" hidden></p>
      <div class="strategy-stats">
        <button class="panel metric" data-filter="all"><span>전체 키챌</span><strong id="metricMarket">—</strong><small id="metricMarketNote">선택한 분야 기준</small></button>
        <button class="panel metric" data-filter="joined"><span>내 참여 키챌</span><strong id="metricJoined">—</strong><small>참여한 키워드 확인 ↗</small></button>
        <button class="panel metric metric-green" data-filter="top3"><span>TOP 3</span><strong id="metricTop3">—</strong><small>상위 순위를 유지 중인 키워드</small></button>
        <button class="panel metric metric-purple" data-filter="near"><span>4~10위 공략</span><strong id="metricNear">—</strong><small>TOP 3 진입을 노릴 키워드 ↗</small></button>
      </div>
      <section class="panel strategy-panel" id="strategyAttack"><div class="section-heading"><div><p class="eyebrow">NEXT BEST ACTION</p><h2>오늘의 공략 <span class="count-chip">TOP 10</span></h2><p class="muted">4~10위 키워드에서 순위·변화·참여자 수·콘텐츠 수·확인된 검색량을 함께 고려합니다.</p></div></div><div id="strategyAttacks"></div><details class="score-note"><summary>공략 순위는 어떻게 정하나요?</summary><p>TOP3에 가까운 순위에 가장 높은 비중을 두고, 이전보다 상승한 키워드·참여자가 적은 키워드·등록 콘텐츠가 적은 키워드를 가산합니다. 월 검색량이 수집된 경우 검색량도 반영합니다. 추천은 순위 상승을 보장하지 않습니다.</p></details></section>
      <section class="panel strategy-panel"><div class="section-heading"><div><p class="eyebrow">RANK HISTORY</p><h2>순위 변화</h2><p id="strategyComparison" class="muted"></p></div><span class="chart-legend"><i></i> TOP3 <i class="near"></i> 4~10위</span></div><div id="strategyTrend"></div><div id="strategyChanges"></div></section>
      <section class="panel strategy-panel"><div class="section-heading"><div><p class="eyebrow">DAILY MOVEMENT</p><h2>오늘의 순위변동</h2><p class="muted">가장 최근 수집일과 그 이전 수집일을 비교합니다.</p></div></div><div id="strategyMovementStats" class="movement-stats"></div><div class="movement-tabs" role="group" aria-label="순위변동 종류"><button data-mover="up" class="active">상승 TOP10</button><button data-mover="down">하락 TOP10</button><button data-mover="new_top3">신규 TOP3</button><button data-mover="left_top3">TOP3 이탈</button></div><div id="strategyMovers"></div></section>
      <details id="strategyDetails" class="panel strategy-panel strategy-details"><summary><div><h2>전체 키챌 목록 · 상세필터</h2><p class="muted">분야 · 참여 상태 · 참여자 수 · 내 순위 · 등록 콘텐츠 · 월 검색량</p></div><span class="count-chip">펼치기 / 접기</span></summary>
        <div class="detail-filters"><label class="wide-filter">키챌명 검색<input id="detailQuery" type="search" maxlength="100" placeholder="찾고 싶은 키워드를 입력하세요" /></label><label>분야<select id="detailField"><option value="">모든 분야</option></select></label><label>참여 상태<select id="detailStatus"><option value="all">전체</option><option value="joined">참여 전체</option><option value="top3">TOP3</option><option value="near">4~10위 공략</option><option value="unjoined">미참여 / 기록 없음</option><option value="unranked">참여 · 순위 미확인</option></select></label></div>
        <div class="range-filters">${[['p','참여자 수'],['r','내 순위'],['c','등록 콘텐츠'],['v','월 검색량']].map(([key,label])=>`<fieldset><legend>${label}</legend><div><input id="detail${key}min" type="number" min="${key==='r'?1:0}" max="999999999" placeholder="최소" aria-label="${label} 최소" /><span>~</span><input id="detail${key}max" type="number" min="${key==='r'?1:0}" max="999999999" placeholder="최대" aria-label="${label} 최대" /></div></fieldset>`).join('')}</div>
        <div class="detail-toolbar"><strong id="detailCount" aria-live="polite"></strong><div><select id="detailSort" aria-label="상세 목록 정렬"><option value="rank">내 순위순</option><option value="volume_desc">월 검색량 높은순</option><option value="volume_asc">월 검색량 낮은순</option><option value="participants_asc">참여자 적은순</option><option value="participants_desc">참여자 많은순</option><option value="contents_desc">등록 콘텐츠 많은순</option><option value="name">이름순</option></select><button id="detailReset" class="button button-light">필터 초기화</button></div></div>
        <div id="strategyDetailRows"></div><div class="pagination"><button id="detailPrev" class="button button-light">이전</button><span id="detailPage"></span><button id="detailNext" class="button button-light">다음</button></div>
        <p class="catalog-footnote">검색량을 모르는 키워드는 ‘미수집’으로 표시하며, 검색량 범위 필터에서는 제외합니다. 미참여는 참여 가능 여부를 뜻하지 않습니다.</p>
      </details>
      <section class="panel strategy-panel"><div class="section-heading"><div><p class="eyebrow">NEW CONTENT OPPORTUNITIES</p><h2>검색량 높은 미참여 TOP10</h2><p id="strategyVolumeNote" class="muted"></p></div></div><div id="strategyDemand"></div></section>
    </div>
    <dialog id="keywordDialog" class="keyword-dialog"><div class="dialog-head"><p class="eyebrow">KEYWORD DETAIL</p><button id="closeKeyword" class="button button-light" aria-label="키워드 상세 닫기">닫기</button></div><div id="keywordDetail"></div></dialog>`;

  function remember(rows) { for (const row of rows || []) records.set(row.keyword_id, {...records.get(row.keyword_id),...row}); }
  const keywordButton = row => `<button class="keyword-button" data-keyword="${esc(row.keyword_id)}">${esc(row.name)}</button>`;
  function movementTable(rows) {
    remember(rows);
    if (!rows?.length) return empty('이 조건에 해당하는 순위 변동이 없습니다.');
    return table(['키챌명','분야','이전','최근','변화'],rows.map(row=>`<tr><td>${keywordButton(row)}</td><td>${esc(row.field || '—')}</td><td>${rank(row.previous_rank)}</td><td><strong>${rank(row.current_rank)}</strong></td><td>${delta(row)}</td></tr>`).join(''));
  }
  function renderMovers() {
    document.querySelectorAll('[data-mover]').forEach(button=>{button.classList.toggle('active',button.dataset.mover===mover);button.setAttribute('aria-pressed',String(button.dataset.mover===mover));});
    $('strategyMovers').innerHTML = data?.movement ? movementTable(data.movement.movers[mover]) : empty('비교할 이전 날짜의 수집 기록이 없습니다. 다음 날짜의 수집부터 표시됩니다.');
  }
  function trend() {
    const rows = data.timeline;
    if (!rows?.length) return empty('전체 수집이 완료되면 일별 이력이 저장됩니다.');
    const width=800,height=150,pad=28,max=Math.max(1,...rows.flatMap(r=>[r.top3,r.near]));
    const x=i=>rows.length===1?width/2:pad+i*(width-2*pad)/(rows.length-1), y=v=>height-pad-v*(height-2*pad)/max;
    const line=key=>rows.map((r,i)=>`${x(i)},${y(r[key])}`).join(' ');
    return `<div class="history-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="날짜별 TOP3 및 4~10위 키워드 수"><path d="M${pad} ${height-pad}H${width-pad}" stroke="#e8e5ef"/>${['top3','near'].map((key,k)=>`<polyline points="${line(key)}" fill="none" stroke="${k?'#b9a7ed':'#7256d8'}" stroke-width="3"/>${rows.map((r,i)=>`<circle cx="${x(i)}" cy="${y(r[key])}" r="4" fill="${k?'#b9a7ed':'#7256d8'}"><title>${r.snapshot_date} · ${key==='top3'?'TOP3':'4~10위'} ${r[key]}개</title></circle>`).join('')}`).join('')}</svg><div class="chart-dates"><span>${esc(rows[0].snapshot_date)}</span><span>${rows.length===1?'첫 기록 · 일별 비교 대기':esc(rows.at(-1).snapshot_date)}</span></div></div>`;
  }
  function render() {
    if(data.field && !Array.from($('strategyField').options).some(option=>option.value===data.field)) {
      $('strategyField').add(new Option(data.field,data.field));$('detailField').add(new Option(data.field,data.field));
    }
    $('strategyField').value=data.field;
    $('strategyDate').textContent=`${date(data.collected_at)} 수집 기준`;
    $('metricMarket').textContent=num(data.total);$('metricJoined').textContent=num(data.joined);
    $('metricTop3').textContent=num(data.top3);$('metricNear').textContent=num(data.near);
    $('metricMarketNote').textContent=`${data.field||'모든 분야'} · 전 분야 ${num(data.total_all)}개`;
    remember(data.attacks);remember(data.demand);
    $('strategyAttacks').innerHTML=data.attacks.length?table(['우선','키챌명','분야','참여자','월 검색량','내 순위','공략 이유'],data.attacks.map((row,i)=>{
      const reasons=[row.current_rank<=6?`TOP3까지 ${row.current_rank-3}계단`:'TOP10 진입 · 순위 개선 후보'];
      if(row.previous_rank>row.current_rank)reasons.push(`${row.previous_rank-row.current_rank}계단 상승`);
      if(row.challenge_count<=2)reasons.push(`등록 콘텐츠 ${row.challenge_count}개 · 보완 후보`);
      return `<tr><td><span class="priority-number">${i+1}</span></td><td>${keywordButton(row)}</td><td>${esc(row.field)}</td><td>${num(row.participant_count)}</td><td>${volume(row)}</td><td><strong class="rank-mid">${rank(row.current_rank)}</strong></td><td class="reason">${reasons.map(esc).join(' · ')}</td></tr>`;
    }).join('')):empty('선택한 분야에 현재 4~10위 키워드가 없습니다.');
    $('strategyComparison').textContent=data.previous_date?`${data.previous_date} → ${data.current_date} · 실제 저장된 날짜 기준`:`${data.current_date} 첫 기준 저장 · 이전 날짜의 기록이 쌓이면 변화를 비교합니다.`;
    $('strategyTrend').innerHTML=trend();
    $('strategyChanges').innerHTML=data.movement?movementTable(data.movement.changes.slice(0,10)):empty('이전 날짜 데이터가 없어 순위 변화는 아직 계산하지 않습니다.');
    $('strategyMovementStats').innerHTML=[['비교 키챌','compared'],['상승','up'],['하락','down'],['신규 TOP3','new_top3'],['TOP3 이탈','left_top3']].map(([label,key])=>`<div><span>${label}</span><strong>${num(data.movement?.[key])}</strong></div>`).join('');
    renderMovers();
    $('strategyVolumeNote').textContent=`검색량이 확인된 ${num(data.volume_covered)} / ${num(data.total)}개 키워드에서 미참여 후보를 찾습니다. 네이버 검색광고의 월 PC+모바일 검색량 기준입니다.`;
    $('strategyDemand').innerHTML=!data.complete?empty('참여 키워드를 끝까지 수집해야 미참여 후보를 정확히 구분할 수 있습니다.'):data.demand.length?table(['우선','키챌명','분야','월 검색량','참여자','추천 이유'],data.demand.map((row,i)=>`<tr><td>${i+1}</td><td>${keywordButton(row)}</td><td>${esc(row.field)}</td><td><strong>${volume(row)}</strong></td><td>${num(row.participant_count)}</td><td class="reason">미참여 · 확인된 검색량 상위${row.participant_count!==null?` · 참여자 ${num(row.participant_count)}명`:''}</td></tr>`).join('')):empty(data.volume_covered?'검색량이 확인된 미참여 후보가 아직 없습니다.':'월 검색량 수집을 기다리고 있습니다. 관리자 연결이 완료되면 실제 검색량으로 채워집니다.');
  }
  async function refresh() {
    if(!profile||!user)return;
    const v=++version, id=profile.influencerId;
    $('strategyError').hidden=true;$('strategyRefresh').disabled=true;
    try{
      const {data:response,error}=await client.rpc('keychallenge_strategy',{p_influencer_id:id,p_field:$('strategyField').value});
      if(v!==version)return;if(error)throw error;
      data=response;render();$('detailField').value=data.field;page=1;
      if($('strategyDetails').open)await search();
    }catch(error){if(v===version){$('strategyError').textContent=`대시보드를 불러오지 못했습니다: ${error.message}`;$('strategyError').hidden=false;}}
    finally{if(v===version)$('strategyRefresh').disabled=false;}
  }
  async function search() {
    if(!profile)return;
    const v=++searchVersion;
    const filters={query:$('detailQuery').value.trim(),field:$('detailField').value,status:$('detailStatus').value,sort:$('detailSort').value,page};
    for(const k of ['p','r','c','v'])for(const bound of ['min','max']){
      const input=$(`detail${k}${bound}`);if(input.value!==''){
        if(!input.validity.valid||!Number.isInteger(Number(input.value))){$('strategyDetailRows').innerHTML=empty('상세필터에는 0 이상의 정수를 입력해 주세요.');return;}
        filters[k+bound]=Number(input.value);
      }
    }
    for(const k of ['p','r','c','v'])if(filters[k+'min']!=null&&filters[k+'max']!=null&&filters[k+'min']>filters[k+'max']){
      $('strategyDetailRows').innerHTML=empty('최소값이 최대값보다 큽니다. 범위를 확인해 주세요.');return;
    }
    $('detailCount').textContent='검색 중…';$('detailPrev').disabled=true;$('detailNext').disabled=true;
    const {data:response,error}=await client.rpc('keychallenge_detailed_keywords',{p_influencer_id:profile.influencerId,p_filters:filters});
    if(v!==searchVersion)return;
    if(error){$('detailCount').textContent='불러오기 실패';$('strategyDetailRows').innerHTML=empty(`목록을 불러오지 못했습니다: ${error.message}`);return;}
    remember(response.items);
    const pages=Math.max(1,Math.ceil(response.total/50));$('detailCount').textContent=`${num(response.total)}개 키챌`;
    $('detailPage').textContent=`${num(page)} / ${num(pages)} 페이지`;$('detailPrev').disabled=page<=1;$('detailNext').disabled=page>=pages;
    $('strategyDetailRows').innerHTML=response.items.length?table(['키챌명','분야','참여자','월 검색량','내 순위','등록 콘텐츠','상태'],response.items.map(row=>`<tr><td>${keywordButton(row)}</td><td>${esc(row.field)}</td><td>${num(row.participant_count)}</td><td title="${row.volume_collected_at?esc(date(row.volume_collected_at)):'검색량 미수집'}">${volume(row)}</td><td><strong>${rank(row.current_rank)}</strong></td><td>${num(row.challenge_count)}개</td><td><span class="join-badge ${row.joined?'is-joined':''}">${row.joined?(row.current_rank<=3&&row.current_rank?'TOP3':row.current_rank<=10&&row.current_rank?'4~10위':'참여'):data?.complete?'미참여':'기록 없음'}</span></td></tr>`).join('')):empty('조건에 맞는 키워드가 없습니다.');
  }
  async function detail(id) {
    const row=records.get(id);if(!row||!profile)return;
    const keywordId=id,profileId=profile.influencerId,v=++detailVersion;
    $('keywordDetail').innerHTML=`<h2>${esc(row.name)}</h2><p class="muted">${esc(row.field||'')} · ${esc(profileId)} 수집 기준</p><div class="keyword-mini-stats"><div>참여자<strong>${num(row.participant_count)}</strong></div><div>월 검색량<strong>${volume(row)}</strong></div><div>현재 순위<strong>${rank(row.current_rank)}</strong></div><div>등록 콘텐츠<strong>${num(row.challenge_count)}</strong></div></div><h3>최근 일별 순위</h3><div id="keywordHistory">불러오는 중…</div><a class="button button-light" target="_blank" rel="noreferrer" href="https://search.naver.com/search.naver?where=influencer&query=${encodeURIComponent(row.name)}">네이버에서 키워드 보기 ↗</a>`;
    $('keywordDialog').showModal();
    const {data:history,error}=await client.rpc('keychallenge_keyword_history',{p_influencer_id:profileId,p_keyword_id:keywordId});
    if(v!==detailVersion)return;
    if(!error&&profile?.influencerId===profileId&&$('keywordDialog').open)$('keywordHistory').innerHTML=history.length?`<div class="history-pills">${history.map(h=>`<div><small>${esc(h.date)}</small><strong>${rank(h.rank)}</strong></div>`).join('')}</div>`:empty('저장된 일별 이력이 없습니다.');
    else if(error&&$('keywordDialog').open)$('keywordHistory').textContent='순위 이력을 불러오지 못했습니다.';
  }
  $('strategyView').addEventListener('click',event=>{
    const key=event.target.closest('[data-keyword]');if(key)void detail(key.dataset.keyword);
    const tab=event.target.closest('[data-mover]');if(tab){mover=tab.dataset.mover;renderMovers();}
    const metric=event.target.closest('[data-filter]');if(metric){$('detailStatus').value=metric.dataset.filter;page=1;const opened=$('strategyDetails').open;$('strategyDetails').open=true;if(opened)void search();$('strategyDetails').scrollIntoView({behavior:'smooth',block:'start'});}
  });
  $('closeKeyword').addEventListener('click',()=>$('keywordDialog').close());
  $('strategyRetry').addEventListener('click',()=>window.location.reload());
  $('strategyRefresh').addEventListener('click',refresh);$('strategyField').addEventListener('change',refresh);
  $('strategyDetails').addEventListener('toggle',()=>{if($('strategyDetails').open)void search();});
  const debounced=()=>{clearTimeout(timer);timer=setTimeout(()=>{page=1;void search();},300);};
  for(const id of ['detailQuery',...['p','r','c','v'].flatMap(k=>[`detail${k}min`,`detail${k}max`])])$(id).addEventListener('input',debounced);
  for(const id of ['detailField','detailStatus','detailSort'])$(id).addEventListener('change',()=>{page=1;void search();});
  $('detailReset').addEventListener('click',()=>{for(const id of ['detailQuery',...['p','r','c','v'].flatMap(k=>[`detail${k}min`,`detail${k}max`])])$(id).value='';$('detailField').value=data?.field||'';$('detailStatus').value='all';$('detailSort').value='rank';page=1;void search();});
  $('detailPrev').addEventListener('click',()=>{if(page>1){page--;void search();}});$('detailNext').addEventListener('click',()=>{page++;void search();});
  return {refresh,async setContext(nextUser,nextProfile,{loading=false,loadError=false}={}){
    const context=++contextVersion;
    const changed=profile?.influencerId!==nextProfile?.influencerId||user?.id!==nextUser?.id;
    user=nextUser;profile=nextProfile;version++;searchVersion++;detailVersion++;
    $('strategyView').hidden=false;$('strategyEmpty').hidden=!!profile;$('strategyContent').hidden=!profile;
    $('strategyManageLink').hidden=!profile;
    if($('keywordDialog').open)$('keywordDialog').close();
    if(!profile){
      data=null;records.clear();
      $('strategySubtitle').textContent=user?'인플홈을 연결하고 나만의 키워드 대시보드를 시작하세요.':'오늘 집중할 키워드를 한눈에 확인하세요.';
      $('strategyEmpty').setAttribute('aria-busy',String(loading));
      $('strategyConnect').hidden=loading||loadError;
      $('strategyRetry').hidden=!loadError;
      $('strategyWelcomeNote').hidden=loading||loadError||!user;
      $('strategyWelcomeTitle').textContent=loading?'연결 정보를 불러오고 있어요.':loadError?'연결 정보를 불러오지 못했어요.':user?'인플홈 연결하기':'내 키워드 챌린지를 한곳에서 관리하세요.';
      $('strategyWelcomeDescription').textContent=loading?'잠시만 기다려 주세요.':loadError?'잠시 후 다시 불러와 주세요.':user?'내 네이버 인플홈 주소를 처음 한 번만 입력해 주세요. 참여 키워드와 순위를 자동으로 불러와 대시보드를 채워 드립니다.':'로그인하거나 가입한 뒤 인플홈을 연결해 주세요.';
      $('strategyConnect').textContent=user?'인플홈 연결하기':'로그인 · 가입하기';
      return;
    }
    $('strategyProfile').textContent=profile.influencerId;$('strategySubtitle').textContent='참여 현황부터 다음 공략까지, 매일 쌓이는 내 키워드 기록.';
    if(!fields.length){const {data:info,error}=await client.rpc('keychallenge_catalog_info');if(context!==contextVersion)return;if(!error)fields=info.fields||[];}
    if(changed||$('strategyField').options.length===2){const options=fields.map(f=>`<option value="${esc(f.field)}">${esc(f.field)}</option>`).join('');$('strategyField').innerHTML='<option value="__mine__">내 주요 분야</option><option value="">모든 분야</option>'+options;$('detailField').innerHTML='<option value="">모든 분야</option>'+options;records.clear();}
    await refresh();
  }};
}

export function connectSearchAd(client,onSaved) {
  let user=null,canManageApi=false,version=0;
  async function status(){
    const v=++version,uid=user?.id;
    canManageApi=false;$('searchadSettings').hidden=true;
    if(!uid)return;
    const {data:role,error:roleError}=await client.from('keychallenge_admins').select('can_manage_api').eq('user_id',uid).maybeSingle();
    if(v!==version||user?.id!==uid)return;
    if(roleError||role?.can_manage_api!==true)return;
    canManageApi=true;$('searchadSettings').hidden=false;
    const {data,error}=await client.from('keychallenge_searchad_status').select('configured,enabled,last_success_at,last_error').eq('singleton',true).maybeSingle();
    if(v!==version||user?.id!==uid||error||!data)return;
    $('searchadState').textContent=data.configured?(data.enabled?'연결됨 · 검색량 자동 수집 켜짐':'연결됨 · 검색량 수집 일시 중지'):'검색광고 연결 대기';
    $('searchadPause').hidden=!data.enabled;
    $('searchadStatus').textContent=data.last_error|| (data.last_success_at?`최근 검색량 수집 · ${date(data.last_success_at)}`:'운영자 계정으로 한 번 연결하면 모든 사용자가 검색량을 볼 수 있습니다.');
  }
  async function call(body){const uid=user?.id;if(!uid||!canManageApi)throw new Error('API 연결 설정을 변경할 권한이 없습니다.');const {data:{session}}=await client.auth.getSession();if(!session||session.user.id!==uid||user?.id!==uid)throw new Error('다시 로그인해 주세요.');const r=await fetch(`${window.APP_CONFIG.SUPABASE_URL}/functions/v1/keychallenge-searchad`,{method:'POST',headers:{apikey:window.APP_CONFIG.SUPABASE_ANON_KEY,Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});const result=await r.json();if(!r.ok)throw new Error(result.error||'연결을 저장하지 못했습니다.');return result;}
  $('searchadForm').addEventListener('submit',async event=>{event.preventDefault();$('searchadSave').disabled=true;$('searchadStatus').textContent='검색광고 연결과 실제 검색량을 확인하고 있습니다…';try{
    const result=await call({customerId:$('searchadCustomer').value,apiKey:$('searchadApi').value,secretKey:$('searchadSecret').value});
    $('searchadApi').value='';$('searchadSecret').value='';await status();$('searchadStatus').textContent=`연결을 저장했습니다. ${num(result.measured)}개 결과를 반영했고, 나머지는 서버에서 순차 수집합니다.`;void onSaved();
  }catch(error){$('searchadStatus').textContent=error.message;}finally{$('searchadSave').disabled=false;}});
  $('searchadPause').addEventListener('click',async()=>{try{await call({action:'pause'});await status();}catch(error){$('searchadStatus').textContent=error.message;}});
  return {status,setUser(next){
    if(user?.id!==next?.id){version++;canManageApi=false;$('searchadSettings').hidden=true;$('searchadForm').reset();$('searchadStatus').textContent='';}
    user=next;if(user)void status();
  }};
}
