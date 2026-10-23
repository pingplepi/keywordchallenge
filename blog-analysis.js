const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = n => Number(n||0).toLocaleString('ko-KR');
const stamp = v => v ? new Date(v).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',dateStyle:'medium',timeStyle:'short'}) : '아직 없음';
const date = v => v ? new Date(v).toLocaleDateString('ko-KR',{timeZone:'Asia/Seoul',month:'short',day:'numeric'}) : '날짜 미제공';
const labels = {pending:'확인 대기',found:'검색 확인',unconfirmed:'조회 범위에서 미확인',error:'조회 실패'};
const states = {queued:'글 수집 대기',running:'글 수집 중',succeeded:'글 수집 완료',failed:'수집 실패',paused:'자동 글 수집 꺼짐'};
const empty = message => `<div class="work-empty">${esc(message)}</div>`;
export function createBlogAnalysis(client) {
  let user=null,epoch=0,version=0,page=1,visible=false,pollTimer,filterTimer,busy=false,refreshing=false;
  $('blogAnalysisView').innerHTML=`<div class="work-heading"><div><p class="eyebrow">YOUR BLOG · AT A GLANCE</p><h1>내 블로그 분석</h1><p class="muted">최근 글은 매일 자동 수집하고, 검색 노출은 필요할 때 버튼으로 점검하세요.</p></div><a class="button button-light" href="#accountView">블로그 연결·설정 ↗</a></div>
    <p id="analysisMessage" class="message" role="status"></p>
    <div id="analysisContent" hidden>
      <section class="panel work-panel analysis-connection"><div class="analysis-collection-info"><div id="analysisIdentity" class="work-identity"></div><p id="analysisUpdated" class="muted small"></p><p class="muted small">글은 매일 자동으로 수집합니다. 이 화면을 열거나 새로고침하면 새 글도 가져옵니다.</p><p id="analysisSearchStatus" class="muted small" role="status"></p></div><div class="analysis-check-actions"><p id="analysisSearchSummary" class="small" aria-live="polite"></p><button id="blogCheckSearch" class="button">검색 노출 점검</button><small class="muted">최근 글 최대 20개 · 한국시간 자정 초기화</small></div></section>
      <div id="analysisNotice" class="analysis-note" role="status"></div>
      <div class="strategy-stats work-stats"><div class="panel metric"><span>수집한 글</span><strong id="analysisTotal">—</strong><small>연결 후 누적한 공개 글</small></div><div class="panel metric metric-green"><span>검색 확인</span><strong id="analysisFound">—</strong><small>최근 수집 글 최대 20개 기준</small></div><div class="panel metric metric-purple"><span>검색 재확인 필요</span><strong id="analysisUnconfirmed">—</strong><small>조회 범위에서 찾지 못한 글</small></div><div class="panel metric"><span>오늘 발견한 글</span><strong id="analysisNew">—</strong><small>발행일과 관계없이 첫 수집 기준</small></div></div>
      <div class="work-two-columns"><section class="panel work-panel"><div class="work-section-title"><h2>블로그 활동 흐름</h2><span class="count-chip">최근 28일</span></div><div id="analysisActivity"></div><p class="muted small">수집된 글의 발행일 기준입니다. 과거 글 전체 통계가 아닙니다.</p></section><section class="panel work-panel"><h2>오늘의 확인 사항</h2><div id="analysisTasks"></div><a class="analysis-keyword-link" href="#keywordSearchView">다음 글의 키워드 검색하기 ↗</a></section></div>
      <section class="panel work-panel"><div class="work-section-title"><h2>수집한 글과 검색 노출</h2><span id="analysisCount" class="muted small" aria-live="polite"></span></div><div class="work-filters analysis-filters"><label>글 제목 검색<input id="analysisQuery" type="search" maxlength="100" placeholder="수집된 글 제목에서 찾기" /></label><label>확인 상태<select id="analysisFilter"><option value="">전체 상태</option><option value="found">검색 확인</option><option value="unconfirmed">조회 범위에서 미확인</option><option value="pending">확인 대기</option><option value="error">조회 실패</option></select></label></div><div id="analysisRows"></div><div class="pagination"><button id="analysisPrev" class="button button-light">이전</button><span id="analysisPage"></span><button id="analysisNext" class="button button-light">다음</button></div>
      <details class="analysis-method"><summary>수집 범위와 검색 확인 기준</summary><p>매일 오전 4시 30분(한국시간)부터 공개 RSS의 최근 글을 수집합니다. 이 화면을 열거나 새로고침할 때도 새 글 수집을 요청하며, 짧은 시간의 반복 요청은 합쳐 처리합니다. 네이버 RSS 반영에 시간이 걸릴 수 있습니다. 처음 연결하면 RSS에서 제공하는 최근 글부터 누적하며, 공개·외부 공유 설정에 따라 수집 범위가 달라질 수 있습니다.</p><p>검색 노출 점검 버튼을 누르면 새 글을 먼저 가져온 뒤 최근 20개를 대상으로 제목과 제목의 앞부분을 검색하고, 검색어별 정확도순 최대 100개 결과에서 글 주소가 일치하는지 확인합니다. 검색어 하나에서 찾으면 확인을 마칩니다. 오래된 글의 상태는 마지막 확인 기록입니다.</p><p>‘조회 범위에서 미확인’은 검색 누락이나 저품질 확정이 아닙니다. 실제 통합검색 순위와도 다릅니다. 오류·연결 대기는 검색 미확인으로 집계하지 않습니다.</p><p>검색 노출 점검은 계정당 하루 3회이며 한국시간 자정에 초기화됩니다. 한 번 누르면 최근 글 최대 20개를 점검합니다. 글 수집과 화면 새로고침은 횟수를 사용하지 않습니다. 검색을 시작한 요청은 오류가 나도 1회에 포함되며, 진행 중인 요청의 중복 클릭은 추가로 차감하지 않습니다. 검색 점검은 키온 전체 회원 합산 하루 20,000회·월 600,000회 이내에서 진행합니다. 한도에 도달하거나 요청 후 1시간이 지나면 해당 요청을 종료하며, 나중에 버튼을 눌러 다시 요청해야 합니다. 검색 점검이 중지되어도 최근 글 수집과 기존 확인 기록은 유지됩니다.</p></details></section>
    </div>`;
  const admin=document.createElement('section');admin.className='searchad-settings';admin.innerHTML=`<p class="eyebrow">BLOG SEARCH CONNECTION</p><h2>블로그 검색 노출 점검 연결</h2><p class="muted">네이버 클라우드의 NAVER API HUB에서 ‘블로그 — NAVER Search Blog API’를 등록해 주세요. 기존 검색광고 API와 별도 연결입니다. 일반 회원은 블로그 주소만 등록하면 됩니다.</p>
    <p><a href="https://guide.ncloud-docs.com/docs/apihub-application" target="_blank" rel="noopener noreferrer">API HUB 등록·한도 설정 안내 ↗</a> · <a href="https://www.ncloud.com/product/applicationService/naverApiHub" target="_blank" rel="noopener noreferrer">현재 요금 확인 ↗</a></p>
    <div class="analysis-budget"><strong>무료 범위 내에서만 검색 점검</strong><p>키온 전체 회원 합산 <b>하루 20,000회 · 월 600,000회</b>를 넘겨 호출하지 않습니다. 오류가 난 호출도 사용량에 포함하며, 한도에 도달하면 검색 점검이 자동 중지됩니다. 기준 시간은 한국시간입니다.</p><p>네이버 콘솔의 Application → 한도 및 알림에서도 <b>일 20,000회 · 월 600,000회</b>로 설정해 주세요. 키온 전용 애플리케이션을 사용해야 다른 서비스의 호출과 섞이지 않습니다.</p><p>무료 제공 정책을 확인한 날부터 30일간 수동 점검을 사용할 수 있으며, 재확인하지 않으면 중지합니다. 검색 점검 중지 중에도 최근 글 수집과 기존 결과는 유지됩니다.</p><div id="blogApiUsage" aria-live="polite"></div></div>
    <span id="blogSearchConnection" class="status-pill">연결 확인 중</span>
    <form id="blogApiForm" autocomplete="off"><div class="admin-fields"><label>API HUB Client ID<input id="blogApiClientId" type="password" maxlength="256" required autocomplete="off" /></label><label>API HUB Client Secret<input id="blogApiClientSecret" type="password" maxlength="256" required autocomplete="off" /></label></div>
    <label class="analysis-confirm"><input id="blogApiFreeConfirmed" type="checkbox" required /><span>현재 검색 API의 무료 제공 범위가 위 한도 이상임을 확인했고, 네이버 콘솔에 일 20,000회·월 600,000회 한도를 설정했습니다. 이 애플리케이션은 키온에서만 사용합니다.</span></label>
    <button id="blogApiSave" class="button">연결 저장</button></form>
    <div class="analysis-admin-actions"><button id="blogApiConfirm" class="button button-light" hidden>무료 정책 재확인 · 사용 허용</button><button id="blogApiPause" class="button button-quiet" hidden>검색 점검 일시 중지</button></div><p id="blogApiMessage" class="message" role="status"></p>`;
  $('catalogAdmin').prepend(admin);
  function message(text,error=false){$('analysisMessage').textContent=text;$('analysisMessage').className=`message ${error?'error':''}`;}
  function schedule(active,nextAt=null){clearTimeout(pollTimer);if(!visible||!user||document.hidden)return;if(active)pollTimer=setTimeout(()=>void load(),10000);else if(nextAt&&nextAt>Date.now())pollTimer=setTimeout(()=>void load(),Math.min(2147483647,nextAt-Date.now()+1000));}
  function activity(data){
    const kstToday=new Date(Date.now()+9*60*60*1000).toISOString().slice(0,10);
    const weeks=Array.from({length:4},(_,i)=>{const end=new Date(`${kstToday}T00:00:00Z`);end.setUTCDate(end.getUTCDate()-(3-i)*7);const start=new Date(end);start.setUTCDate(start.getUTCDate()-6);return {start:start.toISOString().slice(0,10),end:end.toISOString().slice(0,10),count:0};});
    for(const item of data.days)for(const week of weeks)if(item.day>=week.start&&item.day<=week.end)week.count+=Number(item.count);
    const max=Math.max(1,...weeks.map(w=>w.count));
    $('analysisActivity').innerHTML=`<div class="analysis-summary"><div><small>최근 발행일</small><strong>${esc(date(data.latest_post))}</strong></div><div><small>최근 글의 평균 발행 간격</small><strong>${data.average_gap_days==null?'집계 대기':`${esc(data.average_gap_days)}일`}</strong></div></div><div class="analysis-bars">${weeks.map(w=>`<div><span>${esc(w.start.slice(5))}–${esc(w.end.slice(5))}</span><div class="analysis-bar-track"><i style="width:${Math.round(w.count/max*100)}%"></i></div><strong>${w.count}편</strong></div>`).join('')}</div>`;
  }
  function row(item,connected){
    const status=item.check_status;
    const label=status==='pending'?(connected?'점검 요청 대기':'검색 API 연결 대기'):labels[status];
    const url=`https://blog.naver.com/${encodeURIComponent(item.blog_id)}/${encodeURIComponent(item.post_id)}`;
    const evidence=(item.evidence||[]).map(e=>`<li><strong>${esc(e.query)}</strong><span>정확도순 최대 ${num(e.limit)}개 · 반환 ${num(e.returned)}개 · ${e.matched?'글 주소 일치':'글 주소 미확인'}</span></li>`).join('');
    const changed=status!=='error'&&item.previous_result&&item.previous_result!==item.last_result;
    return `<article class="analysis-post"><div class="analysis-post-heading"><div><a class="analysis-post-title" href="${url}" target="_blank" rel="noopener noreferrer">${esc(item.title)} ↗</a><p class="muted small">발행 ${esc(date(item.published_at))} · 첫 수집 ${esc(stamp(item.first_seen_at))}</p></div><span class="analysis-state ${status}">${esc(label)}</span></div>${changed?`<p class="analysis-change">이전 ${esc(labels[item.previous_result])} → 현재 ${esc(labels[item.last_result])}</p>`:''}${item.check_error?`<p class="message error">${esc(item.check_error)}</p>`:''}<details><summary>${item.checked_at?`확인 기록 · ${esc(stamp(item.checked_at))}`:'확인 기준 보기'}</summary>${evidence?`<ul class="analysis-evidence">${evidence}</ul>`:'<p class="muted small">검색 노출 점검 버튼을 누르면 새 글을 가져온 뒤 최근 글 최대 20개를 확인합니다. 하루 3회까지 요청할 수 있습니다.</p>'}${status==='error'&&item.last_result?`<p>마지막 정상 확인: ${esc(labels[item.last_result])} · ${esc(stamp(item.last_result_at))}</p>`:''}<p class="muted small">조회한 검색어와 범위의 결과입니다. 검색 누락 여부나 실제 통합검색 순위를 의미하지 않습니다.</p></details></article>`;
  }
  async function load(){
    if(!user||!visible)return;const g=epoch,v=++version;clearTimeout(pollTimer);
    try{
      const {data,error}=await client.rpc('keychallenge_blog_dashboard',{p_query:$('analysisQuery').value.trim(),p_status:$('analysisFilter').value,p_page:page});
      if(error)throw error;if(g!==epoch||v!==version)return;
      const m=data.monitor,connection=data.connection||{},connected=connection.configured&&connection.enabled,search=data.search_job;
      $('analysisContent').hidden=!m;
      if(!m){$('analysisMessage').innerHTML='<div class="panel work-panel"><h2>블로그 주소를 한 번만 연결하세요</h2><p>최근 글 자동 수집을 시작합니다. 검색 노출 점검은 연결 후 버튼으로 요청할 수 있습니다.</p><a class="button" href="#accountView">내 블로그 연결하기 ↗</a></div>';return;}
      message('');$('analysisIdentity').innerHTML=`<a class="profile-chip" href="https://blog.naver.com/${encodeURIComponent(m.blog_id)}" target="_blank" rel="noopener noreferrer">${esc(m.blog_title||m.blog_id)} ↗</a><span class="status-pill">${states[m.status]}</span>`;
      $('analysisUpdated').textContent=`최근 글 수집 ${stamp(m.rss_updated_at)} · 매일 오전 4:30부터 순차 갱신`;
      const notices=[];
      const waiting=connectionNotice(connection);
      const searchActive=search&&['queued','running'].includes(search.status)&&Date.parse(search.expires_at)>Date.now();
      const used=Number(data.daily_check_used||0),limit=Number(data.daily_check_limit||3),remaining=Math.max(0,limit-used);
      $('blogCheckSearch').disabled=busy||!!searchActive||!!waiting||!remaining;
      $('blogCheckSearch').textContent=searchActive?'검색 점검 진행 중':remaining?'검색 노출 점검':'오늘의 점검 완료';
      $('analysisSearchSummary').textContent='오늘 '+num(used)+' / '+num(limit)+'회 사용 · '+num(remaining)+'회 남음';
      $('analysisSearchStatus').textContent=searchActive?(search.phase==='rss'?'점검할 최신 글을 가져오고 있습니다…':('최근 글 '+num(search.total_count)+'개 중 '+num(search.completed_count)+'개 점검 중')):search?.last_error?search.last_error:search?.status==='succeeded'?('마지막 점검 '+stamp(search.completed_at)+' · '+num(search.completed_count)+'개 처리'):'검색 노출이 궁금할 때 버튼을 눌러 확인하세요.';
      if(!searchActive&&!remaining)$('analysisSearchStatus').textContent+=' 내일 다시 3회 이용할 수 있습니다.';
      if(waiting)notices.push(waiting+' 최근 글 수집과 기존 확인 기록은 계속 사용할 수 있습니다.');
      if(m.last_error)notices.push(m.last_error);
      if((m.status==='queued'||m.status==='running')&&!m.last_error)notices.push('새 글을 가져오고 있습니다. 글 수집은 검색 점검 횟수를 사용하지 않습니다.');
      if(m.rss_updated_at&&m.feed_count===0)notices.push('RSS에서 공개된 글을 찾지 못했습니다. 블로그 주소와 글의 공개·외부 공유 설정을 확인해 주세요.');
      $('analysisNotice').textContent=notices.join(' ');$('analysisNotice').hidden=!notices.length;
      for(const [id,key] of [['analysisTotal','total'],['analysisFound','found'],['analysisUnconfirmed','unconfirmed'],['analysisNew','new_today']])$(id).textContent=num(data[key]);
      activity(data);
      $('analysisTasks').innerHTML=`<div class="analysis-task"><span>검색 재확인 필요</span><strong>${num(data.unconfirmed)}편</strong></div><div class="analysis-task"><span>조회 실패</span><strong>${num(data.errors)}편</strong></div><div class="analysis-task"><span>확인 대기</span><strong>${num(data.pending)}편</strong></div><p class="muted small">최근 ${num(data.recent_total)}개 글 기준 · 수집 범위 ${esc(date(data.oldest_post))}–${esc(date(data.latest_post))}</p>`;
      $('analysisCount').textContent=`${num(data.matched_total)}개 글`;
      $('analysisRows').innerHTML=data.items.length?data.items.map(item=>row(item,connected)).join(''):empty(data.total?'조건에 맞는 글이 없습니다.':'최근 공개 글을 수집하면 여기에 자동으로 표시됩니다.');
      const pages=Math.max(1,Math.ceil(data.matched_total/20));$('analysisPage').textContent=`${page} / ${pages}`;$('analysisPrev').disabled=page<=1;$('analysisNext').disabled=page>=pages;
      const nextWake=[Date.parse(data.daily_check_reset_at),m.status==='queued'?Date.parse(m.next_attempt_at):0].filter(t=>t>Date.now());
      schedule(searchActive||m.status==='running'||(m.status==='queued'&&Date.parse(m.next_attempt_at)<=Date.now()+60000),nextWake.length?Math.min(...nextWake):0);
    }catch(error){if(g===epoch&&v===version){message('블로그 분석 정보를 불러오지 못했습니다. 잠시 후 다시 열어 주세요.',true);schedule(true);}}
  }
  async function openAnalysis(){
    if(!user||!visible||refreshing)return;
    const g=epoch;refreshing=true;let failed=false;
    try{
      await load();
      if(g!==epoch||!visible)return;
      const {error}=await client.rpc('keychallenge_blog_control');
      if(error)throw error;
    }catch{failed=true;}
    finally{if(g===epoch){refreshing=false;await load();if(failed&&visible)message('새 글 수집을 요청하지 못했습니다. 기존 글은 확인할 수 있으며, 매일 자동 수집은 계속됩니다.',true);}}
  }
  async function requestSearch(){
    if(!user||busy)return;const g=epoch;busy=true;let feedback='',failed=false;
    $('blogCheckSearch').disabled=true;
    try{
      const {data,error}=await client.rpc('keychallenge_request_blog_search');
      if(error)throw error;
      feedback=data.already_queued?'이미 요청한 검색 점검이 진행 중입니다.':'새 글을 가져온 뒤 최근 글 최대 20개의 검색 노출을 점검합니다. 잠시 후 결과가 표시됩니다.';
    }catch(e){feedback=e.message||'검색 점검을 요청하지 못했습니다.';failed=true;}
    finally{if(g===epoch){busy=false;await load();message(feedback,failed);}}
  }
  $('blogCheckSearch').addEventListener('click',()=>void requestSearch());
  $('analysisQuery').addEventListener('input',()=>{clearTimeout(filterTimer);filterTimer=setTimeout(()=>{page=1;void load();},300);});
  $('analysisFilter').addEventListener('change',()=>{page=1;void load();});
  $('analysisPrev').addEventListener('click',()=>{page=Math.max(1,page-1);void load();});$('analysisNext').addEventListener('click',()=>{page++;void load();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(pollTimer);else if(visible)void load();});
  function connectionNotice(data){
    if(!data?.configured)return '운영자의 네이버 API HUB 연결을 기다리고 있습니다.';
    if(!data.enabled)return data.stop_reason==='credentials'?'네이버 API HUB 연결 정보 확인이 필요해 검색 점검을 중지했습니다.':'운영자가 검색 점검을 일시 중지했습니다.';
    if(!data.provider_limits_confirmed||!data.free_confirmed_until||Date.parse(data.free_confirmed_until)<=Date.now())return '무료 제공 정책과 네이버 호출 한도를 다시 확인할 때까지 검색 점검을 중지합니다.';
    if(data.blocked_until&&Date.parse(data.blocked_until)>Date.now())return `공용 검색 한도 보호로 점검을 중지했습니다. 다시 요청 가능한 시각: ${stamp(data.blocked_until)}.`;
    return '';
  }
  async function adminRequest(payload){
    const g=epoch,uid=user?.id;
    const {data:{session}}=await client.auth.getSession();
    if(!session||g!==epoch||session.user.id!==uid)throw new Error('다시 로그인해 주세요.');
    const response=await fetch(`${window.APP_CONFIG.SUPABASE_URL}/functions/v1/keychallenge-blog-search`,{method:'POST',headers:{apikey:window.APP_CONFIG.SUPABASE_ANON_KEY,Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'설정을 불러오지 못했습니다.');
    return result;
  }
  async function connection(includeUsage=false){
    const g=epoch;if(!user)return;
    const {data,error}=await client.from('keychallenge_blog_search_status').select('*').eq('singleton',true).single();
    if(g!==epoch)return;
    $('blogSearchConnection').textContent=error?'연결 상태 확인 실패':connectionNotice(data)||'무료 한도 보호 · 수동 점검 사용 가능';
    $('blogApiPause').hidden=!data?.enabled;$('blogApiConfirm').hidden=!data?.configured;
    if(!includeUsage||error)return;
    try{
      const usage=await adminRequest({action:'status'});if(g!==epoch)return;
      $('blogApiUsage').innerHTML=`<div class="analysis-usage"><span>오늘 <b>${num(usage.daily_used)} / ${num(usage.daily_limit)}회</b></span><span>이번 달 <b>${num(usage.monthly_used)} / ${num(usage.monthly_limit)}회</b></span></div><p>무료 정책 재확인 기한: ${esc(stamp(usage.free_confirmed_until))}</p>${usage.message?`<p>${esc(usage.message)}${usage.retry_at?` 다시 요청 가능한 시각: ${esc(stamp(usage.retry_at))}`:''}</p>`:''}`;
    }catch(e){if(g===epoch)$('blogApiUsage').textContent=e.message;}
  }
  async function saveConnection(action){
    if(!user)return;const g=epoch;
    if(action!=='pause'&&!$('blogApiFreeConfirmed').checked){$('blogApiMessage').textContent='현재 무료 정책과 네이버 콘솔 한도 설정을 확인한 뒤 체크해 주세요.';return;}
    for(const id of ['blogApiSave','blogApiConfirm','blogApiPause'])$(id).disabled=true;
    $('blogApiMessage').textContent='설정을 저장하고 있습니다…';
    try{
      const payload={action,freePolicyConfirmed:$('blogApiFreeConfirmed').checked};
      if(action==='save'){payload.clientId=$('blogApiClientId').value.trim();payload.clientSecret=$('blogApiClientSecret').value.trim();}
      const result=await adminRequest(payload);if(g!==epoch)return;
      $('blogApiForm').reset();
      $('blogApiMessage').textContent=action==='pause'?'검색 점검을 일시 중지했습니다. 최근 글 수집은 계속됩니다.':action==='confirm'?(result.allowed?'무료 정책 확인을 갱신했습니다. 내 블로그 분석에서 필요할 때 검색 점검을 요청해 주세요.':result.message):'연결 정보를 저장했습니다. 내 블로그 분석에서 검색 노출 점검 버튼을 눌러 주세요.';
      await connection(true);
    }catch(e){if(g===epoch)$('blogApiMessage').textContent=e.message;}
    finally{if(g===epoch)for(const id of ['blogApiSave','blogApiConfirm','blogApiPause'])$(id).disabled=false;}
  }
  $('blogApiForm').addEventListener('submit',e=>{e.preventDefault();void saveConnection('save');});
  $('blogApiPause').addEventListener('click',()=>void saveConnection('pause'));
  $('blogApiConfirm').addEventListener('click',()=>void saveConnection('confirm'));
  return {setUser(next){if(user?.id===next?.id)return;user=next;epoch++;version++;page=1;busy=false;refreshing=false;clearTimeout(pollTimer);clearTimeout(filterTimer);$('analysisContent').hidden=true;$('analysisQuery').value='';$('analysisFilter').value='';$('blogApiForm').reset();$('blogApiMessage').textContent='';$('blogApiSave').disabled=false;$('blogApiPause').disabled=false;$('blogApiConfirm').disabled=false;$('blogApiUsage').textContent='';message('');if(user){void connection();if(visible)void openAnalysis();}},show(name){const wasVisible=visible;visible=name==='blogAnalysisView';if(visible){if(wasVisible)void load();else void openAnalysis();}else clearTimeout(pollTimer);if(name==='catalogAdmin')void connection(true);}};
}
