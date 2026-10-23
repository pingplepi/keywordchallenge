const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = n => Number(n||0).toLocaleString('ko-KR');
const stamp = v => v ? new Date(v).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',dateStyle:'medium',timeStyle:'short'}) : '아직 없음';
const date = v => v ? new Date(v).toLocaleDateString('ko-KR',{timeZone:'Asia/Seoul',month:'short',day:'numeric'}) : '날짜 미제공';
const labels = {pending:'확인 대기',found:'검색 확인',unconfirmed:'조회 범위에서 미확인',error:'조회 실패'};
const states = {queued:'갱신 대기',running:'갱신 중',succeeded:'갱신 완료',failed:'수집 실패',paused:'자동 갱신 꺼짐'};
const empty = message => `<div class="work-empty">${esc(message)}</div>`;
export function createBlogAnalysis(client) {
  let user=null,epoch=0,version=0,page=1,visible=false,pollTimer,filterTimer,busy=false;
  $('blogAnalysisView').innerHTML=`<div class="work-heading"><div><p class="eyebrow">YOUR BLOG · AT A GLANCE</p><h1>내 블로그 분석</h1><p class="muted">새 글과 검색 노출 상태를 매일 자동으로 확인하세요.</p></div><a class="button button-light" href="#accountView">블로그 연결·설정 ↗</a></div>
    <p id="analysisMessage" class="message" role="status"></p>
    <div id="analysisContent" hidden>
      <section class="panel work-panel analysis-connection"><div><div id="analysisIdentity" class="work-identity"></div><p id="analysisUpdated" class="muted small"></p></div><div class="analysis-actions"><label class="analysis-toggle"><input id="blogAutoRefresh" type="checkbox" /> 매일 자동 갱신</label><button id="blogRefresh" class="button button-light">지금 갱신</button></div></section>
      <div id="analysisNotice" class="analysis-note" role="status"></div>
      <div class="strategy-stats work-stats"><div class="panel metric"><span>수집한 글</span><strong id="analysisTotal">—</strong><small>연결 후 누적한 공개 글</small></div><div class="panel metric metric-green"><span>검색 확인</span><strong id="analysisFound">—</strong><small>최근 수집 글 최대 20개 기준</small></div><div class="panel metric metric-purple"><span>검색 재확인 필요</span><strong id="analysisUnconfirmed">—</strong><small>조회 범위에서 찾지 못한 글</small></div><div class="panel metric"><span>오늘 발견한 글</span><strong id="analysisNew">—</strong><small>발행일과 관계없이 첫 수집 기준</small></div></div>
      <div class="work-two-columns"><section class="panel work-panel"><div class="work-section-title"><h2>블로그 활동 흐름</h2><span class="count-chip">최근 28일</span></div><div id="analysisActivity"></div><p class="muted small">수집된 글의 발행일 기준입니다. 과거 글 전체 통계가 아닙니다.</p></section><section class="panel work-panel"><h2>오늘의 확인 사항</h2><div id="analysisTasks"></div><a class="analysis-keyword-link" href="#keywordSearchView">다음 글의 키워드 검색하기 ↗</a></section></div>
      <section class="panel work-panel"><div class="work-section-title"><h2>수집한 글과 검색 노출</h2><span id="analysisCount" class="muted small" aria-live="polite"></span></div><div class="work-filters analysis-filters"><label>글 제목 검색<input id="analysisQuery" type="search" maxlength="100" placeholder="수집된 글 제목에서 찾기" /></label><label>확인 상태<select id="analysisFilter"><option value="">전체 상태</option><option value="found">검색 확인</option><option value="unconfirmed">조회 범위에서 미확인</option><option value="pending">확인 대기</option><option value="error">조회 실패</option></select></label></div><div id="analysisRows"></div><div class="pagination"><button id="analysisPrev" class="button button-light">이전</button><span id="analysisPage"></span><button id="analysisNext" class="button button-light">다음</button></div>
      <details class="analysis-method"><summary>수집 범위와 검색 확인 기준</summary><p>매일 오전 4시 30분(한국시간)부터 공개 RSS의 최근 글을 수집합니다. 처음 연결하면 RSS에서 제공하는 최근 글부터 누적하며, 공개·외부 공유 설정에 따라 수집 범위가 달라질 수 있습니다.</p><p>수집한 글 중 최근 20개를 대상으로 제목과 제목의 앞부분을 검색하고, 검색어별 정확도순 최대 100개 결과에서 글 주소가 일치하는지 확인합니다. 검색어 하나에서 찾으면 확인을 마칩니다. 오래된 글의 상태는 마지막 확인 기록입니다.</p><p>‘조회 범위에서 미확인’은 검색 누락이나 저품질 확정이 아닙니다. 실제 통합검색 순위와도 다릅니다. 오류·연결 대기는 검색 미확인으로 집계하지 않습니다.</p><p>수동 갱신은 1시간마다 가능합니다. 공용 검색 API의 일일 조회 한도에 도달하면 다음 날 이어서 확인합니다.</p></details></section>
    </div>`;
  const admin=document.createElement('section');admin.className='searchad-settings';admin.innerHTML=`<p class="eyebrow">BLOG SEARCH CONNECTION</p><h2>블로그 검색 노출 점검 연결</h2><p class="muted">네이버 개발자센터에서 애플리케이션의 사용 API에 ‘검색’을 추가해 주세요. 기존 검색광고 API와 별도 연결입니다. 일반 회원은 블로그 주소만 등록하면 됩니다.</p><p><a href="https://developers.naver.com/apps/#/register" target="_blank" rel="noopener noreferrer">네이버 개발자센터 애플리케이션 등록 ↗</a></p><span id="blogSearchConnection" class="status-pill">연결 확인 중</span><form id="blogApiForm" autocomplete="off"><div class="admin-fields"><label>Client ID<input id="blogApiClientId" type="password" maxlength="256" required autocomplete="off" /></label><label>Client Secret<input id="blogApiClientSecret" type="password" maxlength="256" required autocomplete="off" /></label></div><button id="blogApiSave" class="button">연결 저장 · 검색 점검 시작</button></form><button id="blogApiPause" class="button button-quiet" hidden>검색 점검 일시 중지</button><p id="blogApiMessage" class="message" role="status"></p>`;
  $('catalogAdmin').prepend(admin);
  function message(text,error=false){$('analysisMessage').textContent=text;$('analysisMessage').className=`message ${error?'error':''}`;}
  function schedule(active){clearTimeout(pollTimer);if(visible&&user&&!document.hidden&&active)pollTimer=setTimeout(()=>void load(),10000);}
  function activity(data){
    const kstToday=new Date(Date.now()+9*60*60*1000).toISOString().slice(0,10);
    const weeks=Array.from({length:4},(_,i)=>{const end=new Date(`${kstToday}T00:00:00Z`);end.setUTCDate(end.getUTCDate()-(3-i)*7);const start=new Date(end);start.setUTCDate(start.getUTCDate()-6);return {start:start.toISOString().slice(0,10),end:end.toISOString().slice(0,10),count:0};});
    for(const item of data.days)for(const week of weeks)if(item.day>=week.start&&item.day<=week.end)week.count+=Number(item.count);
    const max=Math.max(1,...weeks.map(w=>w.count));
    $('analysisActivity').innerHTML=`<div class="analysis-summary"><div><small>최근 발행일</small><strong>${esc(date(data.latest_post))}</strong></div><div><small>최근 글의 평균 발행 간격</small><strong>${data.average_gap_days==null?'집계 대기':`${esc(data.average_gap_days)}일`}</strong></div></div><div class="analysis-bars">${weeks.map(w=>`<div><span>${esc(w.start.slice(5))}–${esc(w.end.slice(5))}</span><div class="analysis-bar-track"><i style="width:${Math.round(w.count/max*100)}%"></i></div><strong>${w.count}편</strong></div>`).join('')}</div>`;
  }
  function row(item,connected){
    const status=item.check_status;
    const label=status==='pending'&&!connected?'검색 API 연결 대기':labels[status];
    const url=`https://blog.naver.com/${encodeURIComponent(item.blog_id)}/${encodeURIComponent(item.post_id)}`;
    const evidence=(item.evidence||[]).map(e=>`<li><strong>${esc(e.query)}</strong><span>정확도순 최대 ${num(e.limit)}개 · 반환 ${num(e.returned)}개 · ${e.matched?'글 주소 일치':'글 주소 미확인'}</span></li>`).join('');
    const changed=status!=='error'&&item.previous_result&&item.previous_result!==item.last_result;
    return `<article class="analysis-post"><div class="analysis-post-heading"><div><a class="analysis-post-title" href="${url}" target="_blank" rel="noopener noreferrer">${esc(item.title)} ↗</a><p class="muted small">발행 ${esc(date(item.published_at))} · 첫 수집 ${esc(stamp(item.first_seen_at))}</p></div><span class="analysis-state ${status}">${esc(label)}</span></div>${changed?`<p class="analysis-change">이전 ${esc(labels[item.previous_result])} → 현재 ${esc(labels[item.last_result])}</p>`:''}${item.check_error?`<p class="message error">${esc(item.check_error)}</p>`:''}<details><summary>${item.checked_at?`확인 기록 · ${esc(stamp(item.checked_at))}`:'확인 기준 보기'}</summary>${evidence?`<ul class="analysis-evidence">${evidence}</ul>`:'<p class="muted small">최근 글 최대 20개를 매일 순서대로 확인합니다. 검색 API 연결 후 조회가 시작됩니다.</p>'}${status==='error'&&item.last_result?`<p>마지막 정상 확인: ${esc(labels[item.last_result])} · ${esc(stamp(item.last_result_at))}</p>`:''}<p class="muted small">조회한 검색어와 범위의 결과입니다. 검색 누락 여부나 실제 통합검색 순위를 의미하지 않습니다.</p></details></article>`;
  }
  async function load(){
    if(!user||!visible)return;const g=epoch,v=++version;clearTimeout(pollTimer);
    try{
      const {data,error}=await client.rpc('keychallenge_blog_dashboard',{p_query:$('analysisQuery').value.trim(),p_status:$('analysisFilter').value,p_page:page});
      if(error)throw error;if(g!==epoch||v!==version)return;
      const m=data.monitor,connected=data.connection?.configured&&data.connection?.enabled;
      $('analysisContent').hidden=!m;
      if(!m){$('analysisMessage').innerHTML='<div class="panel work-panel"><h2>블로그 주소를 한 번만 연결하세요</h2><p>최근 글 자동 수집과 매일 검색 노출 점검을 시작합니다.</p><a class="button" href="#accountView">내 블로그 연결하기 ↗</a></div>';return;}
      message('');$('analysisIdentity').innerHTML=`<a class="profile-chip" href="https://blog.naver.com/${encodeURIComponent(m.blog_id)}" target="_blank" rel="noopener noreferrer">${esc(m.blog_title||m.blog_id)} ↗</a><span class="status-pill">${states[m.status]}</span>`;
      $('analysisUpdated').textContent=`최근 글 수집 ${stamp(m.rss_updated_at)} · 매일 오전 4:30부터 순차 갱신`;
      $('blogAutoRefresh').checked=m.enabled;$('blogAutoRefresh').disabled=busy;$('blogRefresh').disabled=busy||!m.enabled||['queued','running'].includes(m.status);
      const notices=[];
      if(!connected)notices.push('최근 글 수집은 사용할 수 있습니다. 검색 노출 점검은 운영자의 네이버 검색 API 연결을 기다리고 있습니다.');
      if(m.last_error)notices.push(m.last_error);
      if(m.status==='queued'||m.status==='running')notices.push('수집과 검색 점검을 순서대로 진행합니다. 잠시 후 자동으로 화면이 갱신됩니다.');
      if(m.rss_updated_at&&m.feed_count===0)notices.push('RSS에서 공개된 글을 찾지 못했습니다. 블로그 주소와 글의 공개·외부 공유 설정을 확인해 주세요.');
      $('analysisNotice').textContent=notices.join(' ');$('analysisNotice').hidden=!notices.length;
      for(const [id,key] of [['analysisTotal','total'],['analysisFound','found'],['analysisUnconfirmed','unconfirmed'],['analysisNew','new_today']])$(id).textContent=num(data[key]);
      activity(data);
      $('analysisTasks').innerHTML=`<div class="analysis-task"><span>검색 재확인 필요</span><strong>${num(data.unconfirmed)}편</strong></div><div class="analysis-task"><span>조회 실패 · 다음 갱신에 재시도</span><strong>${num(data.errors)}편</strong></div><div class="analysis-task"><span>확인 대기</span><strong>${num(data.pending)}편</strong></div><p class="muted small">최근 ${num(data.recent_total)}개 글 기준 · 수집 범위 ${esc(date(data.oldest_post))}–${esc(date(data.latest_post))}</p>`;
      $('analysisCount').textContent=`${num(data.matched_total)}개 글`;
      $('analysisRows').innerHTML=data.items.length?data.items.map(item=>row(item,connected)).join(''):empty(data.total?'조건에 맞는 글이 없습니다.':'최근 공개 글을 수집하면 여기에 자동으로 표시됩니다.');
      const pages=Math.max(1,Math.ceil(data.matched_total/20));$('analysisPage').textContent=`${page} / ${pages}`;$('analysisPrev').disabled=page<=1;$('analysisNext').disabled=page>=pages;
      schedule(['queued','running'].includes(m.status));
    }catch(error){if(g===epoch&&v===version){message('블로그 분석 정보를 불러오지 못했습니다. 잠시 후 다시 열어 주세요.',true);schedule(true);}}
  }
  async function control(enabled=null){if(!user||busy)return;const g=epoch;let feedback='',failed=false;busy=true;$('blogRefresh').disabled=true;$('blogAutoRefresh').disabled=true;try{
    const {error}=await client.rpc('keychallenge_blog_control',{p_enabled:enabled});if(error)throw error;feedback=enabled===false?'자동 갱신을 껐습니다.':'갱신을 예약했습니다. 잠시 후 수집이 시작됩니다.';
  }catch(e){feedback=e.message||'설정을 저장하지 못했습니다.';failed=true;}finally{if(g===epoch){busy=false;await load();message(feedback,failed);}}}
  $('blogRefresh').addEventListener('click',()=>void control());$('blogAutoRefresh').addEventListener('change',e=>void control(e.target.checked));
  $('analysisQuery').addEventListener('input',()=>{clearTimeout(filterTimer);filterTimer=setTimeout(()=>{page=1;void load();},300);});
  $('analysisFilter').addEventListener('change',()=>{page=1;void load();});
  $('analysisPrev').addEventListener('click',()=>{page=Math.max(1,page-1);void load();});$('analysisNext').addEventListener('click',()=>{page++;void load();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(pollTimer);else if(visible)void load();});
  async function connection(){const g=epoch;if(!user)return;const {data,error}=await client.from('keychallenge_blog_search_status').select('configured,enabled').eq('singleton',true).single();if(g!==epoch)return;$('blogSearchConnection').textContent=error?'연결 상태 확인 실패':data?.enabled?'검색 점검 연결됨':data?.configured?'검색 점검 일시 중지':'검색 API 연결 대기';$('blogApiPause').hidden=!data?.enabled;}
  async function saveConnection(action){if(!user)return;const g=epoch;$('blogApiSave').disabled=true;$('blogApiPause').disabled=true;$('blogApiMessage').textContent='연결 정보를 저장하고 있습니다…';try{
    const {data:{session}}=await client.auth.getSession();if(g!==epoch)return;if(!session)throw new Error('다시 로그인해 주세요.');
    const response=await fetch(`${window.APP_CONFIG.SUPABASE_URL}/functions/v1/keychallenge-blog-search`,{method:'POST',headers:{apikey:window.APP_CONFIG.SUPABASE_ANON_KEY,Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'},body:JSON.stringify(action==='pause'?{action}:{clientId:$('blogApiClientId').value.trim(),clientSecret:$('blogApiClientSecret').value.trim()})});
    const result=await response.json();if(g!==epoch)return;if(!response.ok)throw new Error(result.error||'연결을 저장하지 못했습니다.');$('blogApiForm').reset();$('blogApiMessage').textContent=action==='pause'?'검색 점검을 일시 중지했습니다. 최근 글 수집은 계속됩니다.':'연결했습니다. 등록된 블로그의 검색 노출을 순서대로 확인합니다.';await connection();
  }catch(e){if(g===epoch)$('blogApiMessage').textContent=e.message;}finally{if(g===epoch){$('blogApiSave').disabled=false;$('blogApiPause').disabled=false;}}}
  $('blogApiForm').addEventListener('submit',e=>{e.preventDefault();void saveConnection('save');});$('blogApiPause').addEventListener('click',()=>void saveConnection('pause'));
  return {setUser(next){if(user?.id===next?.id)return;user=next;epoch++;version++;page=1;busy=false;clearTimeout(pollTimer);clearTimeout(filterTimer);$('analysisContent').hidden=true;$('analysisQuery').value='';$('analysisFilter').value='';$('blogApiForm').reset();$('blogApiMessage').textContent='';$('blogApiSave').disabled=false;$('blogApiPause').disabled=false;message('');if(user){void connection();if(visible)void load();}},show(name){visible=name==='blogAnalysisView';if(visible)void load();else clearTimeout(pollTimer);if(name==='catalogAdmin')void connection();}};
}
