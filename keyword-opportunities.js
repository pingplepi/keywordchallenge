import { createPersonalKeywords } from './keyword-discovery.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = value => Number(value || 0).toLocaleString('ko-KR');
const date = value => value ? new Date(value).toLocaleDateString('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric'}) : '미확인';
const volume = row => row.volume_min === row.volume_max ? number(row.volume_min) : `${number(row.volume_min)}–${number(row.volume_max)}`;
const kinds = [
  ['blue','블루오션','수요에 비해 참여자가 적은 키워드부터 찾아보세요.'],
  ['longtail','롱테일','대상·목적·조건이 구체적이고 검색량이 비교적 적은 후보입니다.'],
  ['red','레드오션','검색량과 참여자가 모두 많은 키워드입니다. 경험과 콘텐츠를 쌓으며 장기적으로 검토해 보세요.']
];

export function createKeywordOpportunities(client, {remember=()=>{},onDetail,onSaved=()=>{},rootId='strategyOpportunities',mode='influencer'}) {
  const root = document.getElementById(rootId),blogger=mode==='blogger';
  const targetPage=blogger?'bloggerView':'strategyView';
  let contextKey='';
  root.classList.add('keyword-opportunities');
  let user=null,profile=null,context=0,request=0,active='blue',data=null,field='__mine__',loading=false,saveRevision=0,visible=false;
  const rows=new Map(),saving=new Set(),savedOverrides=new Map();
  root.innerHTML = `<div class="section-heading"><div><p class="eyebrow">KEYWORD OPPORTUNITIES</p><h2>키워드 기회 찾기</h2><p class="muted">${blogger?'관심 분야와 최근 글에서, 다음에 다룰 새로운 주제를 찾아보세요.':'내 분야의 미참여 키워드부터, 다음에 도전할 주제를 찾아보세요.'}</p></div><a class="button button-light" href="#savedKeywordsView">보관함 보기 ↗</a></div>
    <div class="opportunity-tabs" role="tablist" aria-label="추천 키워드 유형">${kinds.map(([id,label],i)=>`<button id="opportunityTab-${id}" type="button" role="tab" aria-selected="${i===0}" aria-controls="opportunityPanel" tabindex="${i===0?0:-1}" data-opportunity-tab="${id}">${label}<span data-opportunity-count="${id}"></span></button>`).join('')}</div>
    <div id="opportunityPanel" role="tabpanel" aria-labelledby="opportunityTab-blue" tabindex="0" aria-busy="true"><p id="opportunityDescription" class="muted opportunity-description"></p><p id="opportunitySummary" class="opportunity-summary"></p><p id="opportunityStatus" class="message opportunity-status" role="status"></p><div id="opportunityCards" class="opportunity-grid"></div></div>
    <details class="score-note opportunity-method"><summary>추천 기준과 데이터 범위</summary><p>같은 분야에서 최근 30일 안에 검색량과 참여자 수가 확인된 키워드 10개 이상을 비교합니다. 월 검색량은 네이버 검색광고 PC·모바일 합계이며, 최소 10회 이상 확인된 키워드를 사용합니다. 전체 키챌 목록의 수집일이 30일을 넘으면 추천을 보류합니다.</p><p>블루오션은 검색량이 분야 중간값 이상, 참여자가 중간값 이하이고 참여자 대비 검색 수요가 상위 25%인 후보입니다. 레드오션은 검색량과 참여자 수가 모두 상위 25%인 후보입니다.</p><p>롱테일은 ‘아이랑’, ‘당일치기’, ‘만드는법’ 등 대상·목적·조건 표현과 별도의 주제 표현이 있으며, 검색량이 분야 중간값 이하인 후보입니다. 표현 규칙으로 선별하므로 실제 검색 의도와 다를 수 있고, 다른 탭에도 포함될 수 있습니다.</p>${blogger?'<p>내 설정의 관심 분야에서 수집된 최근 글 최대 50편의 제목을 비교합니다. 제목에 키워드가 없는 후보를 먼저, 최근 글과 연결되는 표현이 있는 후보를 그다음으로 우선합니다. 각 탭에서 최대 10개를 보여드립니다.</p><p>공백과 영문 대소문자를 정리한 제목 포함 여부와 단어 비교입니다. 본문·과거 전체 글이나 의미가 비슷한 표현까지 확인한 결과는 아닙니다. 글이 아직 수집되지 않았다면 관심 분야만으로 추천하고 작성 여부는 비교 전으로 표시합니다.</p>':'<p>인플홈의 참여 기록으로 내 주요 분야를 추정합니다. 기록이 없으면 내 설정의 관심 분야를 참고합니다. 내 분야와 미참여 후보를 우선하고, 블루오션·롱테일은 참여자 대비 수요순, 레드오션은 검색량순으로 최대 10개를 보여드립니다. 참여 여부는 인플홈 수집 시점 기준입니다.</p>'}<p>여행 분야는 키워드의 지명·표현을 참고해 국내여행, 세계여행, 여행 공통·기타 후보를 번갈아 배치합니다. 공식 세부 분류가 아니며 일부 지명은 기타로 남을 수 있습니다. 같은 그룹 안에서는 기존 추천 순서를 유지합니다.</p><p>키챌 참여자 수를 활용한 참고용 분류이며 네이버 전체 검색 경쟁도나 상위 노출을 보장하는 지표는 아닙니다. 추천 조회와 보관은 저장된 데이터를 사용하며 검색 노출 점검 횟수를 차감하지 않습니다.</p></details>`;
  // Both dashboards exist in the DOM; keep tab IDs and ARIA references unique.
  root.querySelectorAll('[id]').forEach(element=>{element.id=rootId+'-'+element.id;});
  for(const attribute of ['aria-controls','aria-labelledby'])root.querySelectorAll('['+attribute+']').forEach(element=>{
    element.setAttribute(attribute,rootId+'-'+element.getAttribute(attribute));
  });
  const personalRoot=document.createElement('div');root.append(personalRoot);
  const personal=createPersonalKeywords(client,{root:personalRoot,onSaved});
  const $ = id => root.querySelector('#'+rootId+'-'+id);
  const message = (text,error=false) => { $('opportunityStatus').textContent=text; $('opportunityStatus').classList.toggle('error',error); };
  function syncTabs() {
    for (const [id] of kinds) {
      const button=$('opportunityTab-'+id),selected=id===active;
      button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;
      root.querySelector('[data-opportunity-count="'+id+'"]').textContent=data?` ${number(data.counts[id])}`:'';
    }
    $('opportunityPanel').setAttribute('aria-labelledby',rootId+'-opportunityTab-'+active);
    $('opportunityDescription').textContent=kinds.find(([id])=>id===active)[2];
  }
  function render() {
    syncTabs();
    $('opportunityPanel').setAttribute('aria-busy',String(loading));
    if(!data)return;
    const items=data[active] || [];
    const scope=data.field || (blogger?'관심 분야 미설정':data.my_field?`모든 분야 · ${data.my_field} 우선`:'모든 분야');
    const basis=blogger?(data.post_count?`최근 글 ${number(data.post_count)}편 · 제목에 없는 키워드 우선`:'글 수집 전 · 작성 여부 비교 전'):(data.complete?'미참여 우선':'참여 기록이 일부라 미참여 여부는 확인 전');
    $('opportunitySummary').textContent=`${scope} · 추천 후보 ${number(data.counts[active])}개 중 ${number(items.length)}개 · ${basis}`;
    $('opportunityCards').innerHTML=items.length?items.map(row=>{
      const saved=row.saved||savedOverrides.has(row.keyword_key),busy=saving.has(row.keyword_key);
      const isNew=blogger?row.title_matched===false:row.joined===false;
      const participation=blogger?(row.title_matched===false?'최근 글 제목에 없음':row.title_matched===true?'최근 글 제목에 포함':'작성 여부 비교 전'):row.joined===false?'미참여':row.joined===true?(row.current_rank?`참여 · ${number(row.current_rank)}위`:'참여'):'참여 확인 전';
      return `<article class="opportunity-card"><div class="opportunity-card-head"><span class="count-chip">${esc(row.travel_scope||row.field)}${row.is_mine?(blogger?' · 관심 분야':' · 내 분야'):''}</span><span class="opportunity-participation ${isNew?'is-new':''}">${participation}</span></div><h3><button type="button" class="keyword-button" data-opportunity-detail="${esc(row.keyword_id)}">${esc(row.name)}</button></h3><dl class="opportunity-metrics"><div><dt>월 검색량</dt><dd>${volume(row)}</dd></div><div><dt>키챌 참여자</dt><dd>${number(row.participant_count)}<small>명</small></dd></div></dl><ul class="opportunity-reasons">${row.reasons.map(reason=>`<li>${esc(reason)}</li>`).join('')}</ul><div class="opportunity-card-footer"><small class="muted">검색량 ${date(row.volume_collected_at)} · 참여자 ${date(data.catalog_collected_at)} 기준</small><button type="button" class="button button-light" data-opportunity-save="${esc(row.keyword_id)}" aria-label="${esc(row.name)} ${saved?'보관됨':'보관함 담기'}" ${saved||busy?'disabled':''}>${saved?'보관됨 ✓':busy?'저장 중…':'보관함 담기'}</button></div></article>`;
    }).join(''):blogger&&!data.field?'<div class="strategy-empty opportunity-empty">관심 분야를 선택하면 맞춤 키워드를 추천해 드립니다. <a href="#accountView">관심 분야 설정하기 ↗</a></div>':`<div class="strategy-empty opportunity-empty">${data.measured?'이 분야에서 해당 기준을 충족하는 후보가 아직 없습니다. 다른 탭이나 분야를 선택해 보세요.':'추천에 사용할 최신 검색량·참여자 데이터가 아직 충분하지 않습니다. 데이터가 갱신되면 후보가 표시됩니다.'}</div>`;
  }
  async function load(nextField=field) {
    if(!user||!profile||(blogger&&profile.mode!=='blogger'))return;
    void personal.load();
    const v=++request,g=context,startedAtRevision=saveRevision;field=nextField;loading=true;data=null;rows.clear();
    $('opportunityCards').innerHTML='';$('opportunitySummary').textContent='';
    syncTabs();$('opportunityPanel').setAttribute('aria-busy','true');message('저장된 데이터에서 추천 후보를 찾고 있어요…');
    try {
      const result=blogger?await client.rpc('keychallenge_blogger_keyword_opportunities'):await client.rpc('keychallenge_keyword_opportunities',{p_influencer_id:profile.influencerId,p_field:field});
      if(g!==context||v!==request)return;
      if(result.error)throw result.error;
      data=result.data;
      for(const [key,revision] of savedOverrides)if(revision<=startedAtRevision)savedOverrides.delete(key);
      for(const [id] of kinds)for(const row of data[id])rows.set(row.keyword_id,row);
      remember([...rows.values()]);message('');render();
    } catch(error) {
      if(g!==context||v!==request)return;
      message('추천을 불러오지 못했습니다. 다시 불러오기를 눌러 주세요.',true);
      $('opportunityCards').innerHTML='<div class="opportunity-empty"><button type="button" class="button button-light" data-opportunity-retry>다시 불러오기</button></div>';
    } finally {
      if(g===context&&v===request){loading=false;$('opportunityPanel').setAttribute('aria-busy','false');}
    }
  }
  function selectTab(id,focus=false) {
    if(!kinds.some(([key])=>key===id))return;
    active=id;render();if(!data)syncTabs();
    if(focus)$('opportunityTab-'+id).focus();
  }
  root.querySelector('[role="tablist"]').addEventListener('keydown',event=>{
    const index=kinds.findIndex(([id])=>id===active);
    let next;
    if(event.key==='ArrowRight')next=(index+1)%kinds.length;
    if(event.key==='ArrowLeft')next=(index+kinds.length-1)%kinds.length;
    if(event.key==='Home')next=0;
    if(event.key==='End')next=kinds.length-1;
    if(next!==undefined){event.preventDefault();selectTab(kinds[next][0],true);}
  });
  root.addEventListener('click',async event=>{
    const tab=event.target.closest('[data-opportunity-tab]');
    if(tab){selectTab(tab.dataset.opportunityTab);return;}
    if(event.target.closest('[data-opportunity-retry]')){void load();return;}
    const detail=event.target.closest('[data-opportunity-detail]');
    if(detail){const row=rows.get(detail.dataset.opportunityDetail);if(row)onDetail(blogger?row.name:row.keyword_id);return;}
    const button=event.target.closest('[data-opportunity-save]');
    if(!button||button.disabled||!user)return;
    const row=rows.get(button.dataset.opportunitySave);if(!row||saving.has(row.keyword_key))return;
    const g=context;saving.add(row.keyword_key);render();message('');
    try {
      const result=await client.rpc('keychallenge_save_blog_keyword',{p_keyword:row.name});
      if(g!==context)return;
      if(result.error)throw result.error;
      savedOverrides.set(row.keyword_key,++saveRevision);
      for(const item of rows.values())if(item.keyword_key===row.keyword_key)item.saved=true;
      message(`‘${row.name}’ 키워드를 보관함에 담았습니다.`);
      onSaved(row);
    } catch(error) {
      if(g===context)message(error.message||'보관하지 못했습니다. 다시 시도해 주세요.',true);
    } finally {
      if(g===context){saving.delete(row.keyword_key);render();}
    }
  });
  return {
    load,
    show(page) {
      const entering=!visible&&page===targetPage;visible=page===targetPage;
      if(entering&&data&&!loading)void load();
    },
    setContext(nextUser,nextProfile) {
      const key=JSON.stringify(blogger?[nextUser?.id,nextProfile?.mode,nextProfile?.blog_id,nextProfile?.interest]:[nextUser?.id,nextProfile?.influencerId]);
      user=nextUser;profile=nextProfile;
      if(key===contextKey)return;
      contextKey=key;personal.setContext(user,profile);
      context++;request++;data=null;loading=false;active='blue';field='__mine__';
      rows.clear();saving.clear();savedOverrides.clear();
      $('opportunityCards').innerHTML='';$('opportunitySummary').textContent='';message('');syncTabs();
    }
  };
}
