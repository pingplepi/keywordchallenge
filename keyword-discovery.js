const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=v=>Number(v||0).toLocaleString('ko-KR');
const range=(a,b)=>a==null?'미확인':a===b?num(a):num(a)+'–'+num(b);
const date=v=>v?new Date(v).toLocaleDateString('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric'}):'미확인';
const key=v=>v.replace(/\s/g,'').toUpperCase();
const topics={
  '여행':{'국내여행':['국내여행','제주여행','서울여행'],'세계여행':['해외여행','일본여행','동남아여행'],'베트남·나트랑':['베트남여행','나트랑여행','나트랑마사지'],'일본':['일본여행','오사카여행','후쿠오카여행'],'제주':['제주여행','제주맛집','제주숙소']},
  '뷰티':{'스킨케어':['스킨케어','선크림','수분크림'],'메이크업':['메이크업','쿠션팩트','립틴트'],'헤어':['헤어케어','샴푸','헤어스타일']},
  '패션':{'코디':['데일리룩','여성코디','남성코디'],'패션 아이템':['운동화','가방','액세서리']},
  '푸드':{'집밥':['집밥메뉴','반찬','레시피'],'베이킹':['홈베이킹','쿠키만들기','빵만들기'],'외식':['맛집추천','브런치','카페추천']},
  '리빙':{'살림':['청소','수납정리','생활용품'],'인테리어':['인테리어','가구','집꾸미기']},
  '육아':{'육아 생활':['육아용품','이유식','아기장난감'],'아이와 함께':['아이랑가볼만한곳','키즈카페','육아놀이']},
  'IT테크':{'디지털 기기':['스마트폰','노트북','태블릿'],'생활 기술':['스마트워치','무선이어폰','AI활용']},
  '자동차':{'차량 선택':['전기차','중고차','패밀리카'],'차량 관리':['자동차용품','세차','타이어']},
  '경제/비즈니스':{'생활 경제':['적금','연말정산','가계부'],'사업':['창업','마케팅','스마트스토어']},
  '생활건강':{'건강 습관':['건강관리','스트레칭','수면'],'식생활':['건강식단','영양제','단백질']},
  '운동/레저':{'운동':['러닝','헬스','필라테스'],'아웃도어':['등산','캠핑','자전거']},
  '도서':{'책과 독서':['책추천','독서','독서모임']},
  '문화/예술':{'문화생활':['전시회','뮤지컬','공연']},
  '게임':{'게임':['모바일게임','PC게임','콘솔게임']},
  '동물/펫':{'반려동물':['강아지용품','고양이용품','반려동물']},
  '어학/교육':{'공부':['영어공부','자격증','학습법']},
  '직접 입력':{'내 주제':[]}
};
export function createTopicDiscovery(client,{root,onSaved=()=>{}}){
  let user=null,settings=null,epoch=0,sequence=0,controller=null,all=[],titles=[],postCount=0,tab='direct';
  const saved=new Set();
  const direct=[...root.querySelectorAll(':scope > section')];
  const nav=document.createElement('div');nav.className='opportunity-tabs discovery-search-tabs';nav.setAttribute('role','tablist');nav.setAttribute('aria-label','키워드 찾는 방법');
  nav.innerHTML='<button type="button" role="tab" id="directKeywordTab" aria-controls="directKeywordPanel" aria-selected="true">직접 검색</button><button type="button" role="tab" id="topicKeywordTab" aria-controls="topicKeywordPanel" aria-selected="false" tabindex="-1">주제별 추천</button>';
  const directPanel=document.createElement('div');directPanel.id='directKeywordPanel';directPanel.setAttribute('role','tabpanel');directPanel.setAttribute('aria-labelledby','directKeywordTab');direct.forEach(el=>directPanel.append(el));root.append(nav,directPanel);
  const panel=document.createElement('section');panel.id='topicKeywordPanel';panel.className='panel work-panel topic-discovery';panel.hidden=true;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby','topicKeywordTab');
  panel.innerHTML='<h2>주제별 인기 키워드 TOP 20</h2><p class="muted">관심 주제를 고르고, 검색량이 높은 연관 키워드를 찾아보세요.</p><form data-topic-form><div class="work-filters"><label>분야<select data-topic-field>'+Object.keys(topics).map(x=>'<option>'+esc(x)+'</option>').join('')+'</select></label><label>세부 주제<select data-topic-subject></select></label></div><label>대표 키워드 · 최대 3개<input data-topic-seeds maxlength="100" required placeholder="예: 나트랑여행, 나트랑마사지, 나트랑숙소" /></label><p class="muted small">쉼표로 구분해 수정할 수 있습니다. 각 키워드는 30자 이내로 입력해 주세요.</p><button class="button" data-topic-submit>인기 키워드 찾기</button></form><p class="catalog-footnote">대표 키워드별 검색광고 연관어를 합쳐 중복을 제거합니다. 주제 전체의 검색 순위는 아니며, 최근 30일 안에 조회한 결과는 함께 재사용합니다. 새 조회는 최대 3회이며 기존 키워드 검색 한도를 적용합니다.</p><p class="message" data-topic-status role="status">주제를 선택한 뒤 버튼을 눌러 주세요.</p><div data-topic-result hidden><div class="work-filters"><label>결과 안에서 찾기<input data-topic-filter type="search" maxlength="100" placeholder="예: 숙소" /></label><label class="topic-toggle"><input type="checkbox" data-topic-new checked />최근 글 제목에 없는 키워드 우선</label></div><p class="muted small" data-topic-summary></p><div class="opportunity-grid" data-topic-cards></div></div>';
  root.append(panel);const $=s=>panel.querySelector(s);
  function choose(value,focus=false){tab=value;const topic=value==='topic';panel.hidden=!topic;directPanel.hidden=topic;for(const [id,on] of [['directKeywordTab',!topic],['topicKeywordTab',topic]]){const b=nav.querySelector('#'+id);b.setAttribute('aria-selected',String(on));b.tabIndex=on?0:-1;if(on&&focus)b.focus();}}
  nav.addEventListener('click',e=>{const b=e.target.closest('[role="tab"]');if(b)choose(b.id==='topicKeywordTab'?'topic':'direct');});
  nav.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();choose(e.key==='Home'?'direct':e.key==='End'?'topic':tab==='topic'?'direct':'topic',true);}});
  function seeds(){ $('[data-topic-seeds]').value=topics[$('[data-topic-field]').value][$('[data-topic-subject]').value].join(', '); }
  function subjects(){const v=$('[data-topic-field]').value;$('[data-topic-subject]').innerHTML=Object.keys(topics[v]).map(x=>'<option>'+esc(x)+'</option>').join('');seeds();}
  $('[data-topic-field]').addEventListener('change',subjects);$('[data-topic-subject]').addEventListener('change',seeds);subjects();
  function render(){
    const filter=key($('[data-topic-filter]').value),prefer=$('[data-topic-new]').checked;
    const candidates=all.filter(r=>r.available&&r.volume_min!=null&&key(r.keyword).includes(filter)).map(r=>({...r,matched:postCount?titles.some(t=>t.includes(r.keyword_key)):null}));
    candidates.sort((a,b)=>(prefer?Number(a.matched===true)-Number(b.matched===true):0)||b.volume_min-a.volume_min||a.keyword.localeCompare(b.keyword,'ko'));
    const rows=candidates.slice(0,20);
    $('[data-topic-summary]').textContent='후보 '+num(candidates.length)+'개 중 '+num(rows.length)+'개 · '+(postCount?'최근 글 '+postCount+'편의 제목과 비교':'글 수집 전 · 작성 여부 비교 전')+' · '+(prefer?'제목에 없는 후보를 먼저, 그 안에서 검색량순':'월 검색량순');
    $('[data-topic-cards]').innerHTML=rows.length?rows.map(r=>'<article class="opportunity-card"><span class="opportunity-participation '+(r.matched===false?'is-new':'')+'">'+(r.matched===false?'최근 글 제목에 없음':r.matched?'최근 글 제목에 포함':'작성 여부 비교 전')+'</span><h3>'+esc(r.keyword)+'</h3><dl class="opportunity-metrics"><div><dt>월 검색량 합계</dt><dd>'+range(r.volume_min,r.volume_max)+'</dd></div><div><dt>PC / 모바일</dt><dd class="topic-device-volume">'+range(r.pc_min,r.pc_max)+' / '+range(r.mobile_min,r.mobile_max)+'</dd></div></dl><p class="muted small">연관어 기준: '+r.seeds.map(esc).join(', ')+'</p><div class="opportunity-card-footer"><small class="muted">'+date(r.collected_at)+' 조회 · 월 검색량</small><button class="button button-light" data-topic-save="'+esc(r.keyword_key)+'" '+(saved.has(r.keyword_key)?'disabled':'')+'>'+(saved.has(r.keyword_key)?'보관됨 ✓':'보관함 담기')+'</button></div></article>').join(''):'<div class="work-empty">조건에 맞는 검색량 데이터가 없습니다. 대표 키워드나 결과 필터를 바꿔 보세요.</div>';
  }
  $('[data-topic-filter]').addEventListener('input',render);$('[data-topic-new]').addEventListener('change',render);
  $('[data-topic-form]').addEventListener('submit',async e=>{
    e.preventDefault();if(!user)return;const hints=[...new Map($('[data-topic-seeds]').value.split(',').map(x=>x.trim()).filter(Boolean).map(x=>[key(x),x])).values()];
    if(!hints.length||hints.length>3||hints.some(x=>x.length>30||/[\u0000-\u001f\u007f]/.test(x))){$('[data-topic-status]').textContent='대표 키워드를 1~3개, 각각 30자 이내로 입력해 주세요.';return;}
    const g=epoch,v=++sequence;controller?.abort();controller=new AbortController();$('[data-topic-submit]').disabled=true;$('[data-topic-result]').hidden=true;$('[data-topic-status]').textContent='연관 키워드와 월 검색량을 모으고 있어요…';
    let failures=[],completed=0;const merged=new Map();
    try{
      const {data:{session}}=await client.auth.getSession();if(g!==epoch||v!==sequence)return;if(!session||session.user.id!==user.id)throw Error('다시 로그인해 주세요.');
      titles=[];postCount=0;
      if(settings?.blog_id){const posts=await client.from('keychallenge_blog_posts').select('title').eq('user_id',user.id).eq('blog_id',settings.blog_id).order('published_at',{ascending:false,nullsFirst:false}).order('first_seen_at',{ascending:false}).limit(50);if(g!==epoch||v!==sequence)return;if(posts.error)throw Error('최근 글을 비교하지 못했습니다. 잠시 후 다시 시도해 주세요.');titles=(posts.data||[]).map(p=>key(p.title));postCount=titles.length;}
      for(const hint of hints){
        if(g!==epoch||v!==sequence)return;
        const response=await fetch(window.APP_CONFIG.SUPABASE_URL+'/functions/v1/keychallenge-keyword-search',{method:'POST',signal:controller.signal,headers:{apikey:window.APP_CONFIG.SUPABASE_ANON_KEY,Authorization:'Bearer '+session.access_token,'Content-Type':'application/json'},body:JSON.stringify({query:hint})});
        const result=await response.json();if(g!==epoch||v!==sequence)return;
        if(!response.ok){failures.push(hint+': '+(result.error||'조회 실패'));if([401,403,429,503].includes(response.status))break;continue;}
        completed++;for(const item of result.items||[]){const old=merged.get(item.keyword_key);if(!old)merged.set(item.keyword_key,{...item,collected_at:item.collected_at||result.collected_at,seeds:[hint]});else{old.seeds.push(hint);if(Date.parse(item.collected_at)>Date.parse(old.collected_at))Object.assign(old,item);}}
      }
      all=[...merged.values()];$('[data-topic-filter]').value='';$('[data-topic-result]').hidden=false;render();
      $('[data-topic-status]').textContent=completed+' / '+hints.length+'개 대표 키워드 조회 완료'+(failures.length?' · 일부 결과만 표시합니다. '+failures.join(' / '):' · 검색량은 PC·모바일 합계이며 실시간 순위가 아닙니다.');
    }catch(error){if(g===epoch&&v===sequence&&error.name!=='AbortError')$('[data-topic-status]').textContent=error.message||'추천을 불러오지 못했습니다.';}
    finally{if(g===epoch&&v===sequence)$('[data-topic-submit]').disabled=false;}
  });
  panel.addEventListener('click',async e=>{const b=e.target.closest('[data-topic-save]');if(!b||b.disabled||!user)return;const row=all.find(r=>r.keyword_key===b.dataset.topicSave);if(!row)return;const g=epoch;b.disabled=true;try{const result=await client.rpc('keychallenge_save_blog_keyword',{p_keyword:row.keyword});if(g!==epoch)return;if(result.error)throw result.error;saved.add(row.keyword_key);render();onSaved();}catch(error){if(g===epoch){b.disabled=false;$('[data-topic-status]').textContent=error.message||'보관하지 못했습니다.';}}});
  return {direct:()=>choose('direct'),setContext(next,nextSettings){epoch++;sequence++;controller?.abort();user=next;settings=nextSettings;all=[];titles=[];postCount=0;saved.clear();$('[data-topic-result]').hidden=true;$('[data-topic-submit]').disabled=false;$('[data-topic-status]').textContent='주제를 선택한 뒤 버튼을 눌러 주세요.';$('[data-topic-field]').value=Object.hasOwn(topics,settings?.interest)?settings.interest:'여행';subjects();choose('direct');}};
}
export function createPersonalKeywords(client,{root,onSaved=()=>{}}){
  let user=null,profile=null,epoch=0,request=0,data=null,loading=false;const saved=new Set();
  root.className='personal-keywords';root.innerHTML='<div class="section-heading"><div><p class="eyebrow">PERSONAL KEYWORDS</p><h2>나에게 맞는 키워드</h2><p class="muted">성과 기록과 최근 글의 주제를 바탕으로 다음 글감을 찾아보세요.</p></div><button class="button button-light" data-personal-refresh>추천 새로고침</button></div><p class="message" role="status" data-personal-status></p><div data-personal-basis></div><div class="opportunity-grid" data-personal-cards></div><details class="score-note opportunity-method"><summary>맞춤 추천 기준과 데이터 범위</summary><p>최근 30일 안의 인플홈 수집과 최대 7개 날짜의 순위 기록에서 TOP10 키챌을 찾습니다. 이는 키워드 챌린지 순위이며 블로그 통합검색 순위가 아닙니다.</p><p>해당 키챌에 등록한 글과 최근 수집한 글 최대 50편의 제목에서 반복되는 표현을 비교합니다. 블로그의 노출 확인은 글 제목 검색 결과로, 특정 키워드의 상위 노출을 뜻하지 않습니다.</p><p>관심 분야의 최근 30일 검색량이 있는 키챌 목록에서 관련 후보를 찾고, 수집한 글 제목과 참여 목록에 이미 있는 키워드는 제외합니다. 연결 표현·확인 기록·키챌 참여자 대비 수요를 참고한 확장 추천이며, 노출 가능성을 보장하거나 점수로 예측하지 않습니다. 본문과 과거 전체 글을 비교한 결과는 아닙니다.</p><p>저장된 데이터만 사용하므로 검색 노출 점검 횟수와 검색광고 새 조회 한도를 차감하지 않습니다.</p></details>';
  const $=s=>root.querySelector(s);
  function render(){if(!data)return;
    $('[data-personal-basis]').innerHTML='<p class="opportunity-summary">'+esc(data.field||'관심 분야 미설정')+' · 최근 글 '+num(data.post_count)+'편 · 연결 후보 '+num(data.candidate_count)+'개</p>'+(data.strengths.length?'<div class="personal-evidence"><h3>좋은 순위가 확인된 키챌</h3><p class="muted small">'+(data.history_days?date(data.history_start)+'~'+date(data.history_end)+' · '+num(data.history_days)+'개 날짜 기록과 최근 수집 비교':'최근 인플홈 수집 기준')+' · 키챌 순위</p><ul>'+data.strengths.map(s=>'<li><strong>'+esc(s.keyword)+'</strong><span>기간 내 최고 '+num(s.best_rank)+'위 · 최근 '+(s.current_rank?num(s.current_rank)+'위':'미확인')+'</span></li>').join('')+'</ul></div>':'<p class="analysis-note">최근 키챌 TOP10 기록이 없어, 최근 글의 주제와 제목 검색 노출 확인 기록으로 추천합니다.</p>')+(data.exposed_posts?'<p class="muted small">최근 제목 검색으로 노출 확인된 글 '+num(data.exposed_posts)+'편을 참고했습니다.</p>':'');
    $('[data-personal-cards]').innerHTML=data.items.length?data.items.map(r=>'<article class="opportunity-card"><span class="count-chip">'+esc(r.travel_scope||r.field)+'</span><h3>'+esc(r.keyword)+'</h3><dl class="opportunity-metrics"><div><dt>월 검색량</dt><dd>'+range(r.volume_min,r.volume_max)+'</dd></div><div><dt>키챌 참여자</dt><dd>'+(r.participant_count==null?'미확인':num(r.participant_count))+'</dd></div></dl><ul class="opportunity-reasons">'+r.reasons.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul><div class="opportunity-card-footer"><small class="muted">'+date(r.collected_at)+' 검색량 기준</small><button class="button button-light" data-personal-save="'+esc(r.keyword_key)+'" '+(r.saved||saved.has(r.keyword_key)?'disabled':'')+'>'+(r.saved||saved.has(r.keyword_key)?'보관됨 ✓':'보관함 담기')+'</button></div></article>').join(''):'<div class="work-empty">'+(!data.field?'내 설정에서 관심 분야를 선택해 주세요.':!data.post_count&&!data.strengths.length?'블로그 글이나 인플홈 순위가 수집되면 맞춤 후보를 보여드립니다.':'현재 기록과 연결되는 새 후보가 아직 충분하지 않습니다. 주제별 추천에서 다른 글감을 찾아보세요.')+' <a href="#keywordSearchView">키워드 검색 ↗</a></div>';
  }
  async function load(){if(!user||!profile||loading)return;const g=epoch,v=++request;loading=true;$('[data-personal-refresh]').disabled=true;$('[data-personal-status]').textContent='내 기록에서 추천 근거를 찾고 있어요…';try{const result=await client.rpc('keychallenge_personalized_keywords',{p_influencer_id:profile.influencerId||null,p_field:'__mine__'});if(g!==epoch||v!==request)return;if(result.error)throw result.error;data=result.data;render();$('[data-personal-status]').textContent='';}catch(error){if(g===epoch&&v===request)$('[data-personal-status]').textContent='맞춤 추천을 불러오지 못했습니다. 다시 불러와 주세요.';}finally{if(g===epoch&&v===request){loading=false;$('[data-personal-refresh]').disabled=false;}}}
  $('[data-personal-refresh]').addEventListener('click',load);
  root.addEventListener('click',async e=>{const b=e.target.closest('[data-personal-save]');if(!b||b.disabled||!user)return;const row=data?.items.find(r=>r.keyword_key===b.dataset.personalSave);if(!row)return;const g=epoch;b.disabled=true;try{const result=await client.rpc('keychallenge_save_blog_keyword',{p_keyword:row.keyword});if(g!==epoch)return;if(result.error)throw result.error;saved.add(row.keyword_key);render();onSaved(row);}catch(error){if(g===epoch){b.disabled=false;$('[data-personal-status]').textContent=error.message||'보관하지 못했습니다.';}}});
  return {load,setContext(next,p){epoch++;request++;user=next;profile=p;data=null;loading=false;saved.clear();$('[data-personal-refresh]').disabled=false;$('[data-personal-status]').textContent='';$('[data-personal-basis]').innerHTML='';$('[data-personal-cards]').innerHTML='';}};
}
