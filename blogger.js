import { createBloggerDashboard } from './blogger-dashboard.js';
import { createTopicDiscovery } from './keyword-discovery.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = value => Number(value || 0).toLocaleString('ko-KR');
const empty = text => `<div class="work-empty">${esc(text)}</div>`;
const stamp = value => value ? new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',dateStyle:'medium',timeStyle:'short'}) : '—';
const range = (min,max) => min == null ? '미확인' : min===max ? number(min) : `${number(min)}–${number(max)}`;
const volume = row => range(row.volume_min,row.volume_max);
const heading = (eyebrow,title,description,actions='') => `<div class="work-heading"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p class="muted">${description}</p></div>${actions}</div>`;
function blogId(value) {
  const input=value.trim();
  if(/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,49}$/.test(input))return input.toLowerCase();
  let url; try{url=new URL(/^https?:\/\//i.test(input)?input:`https://${input}`);}catch{throw new Error('네이버 블로그 주소 또는 블로그 ID를 입력해 주세요.');}
  if(!['blog.naver.com','m.blog.naver.com'].includes(url.hostname)||url.username||url.password||url.port)throw new Error('blog.naver.com으로 시작하는 블로그 주소를 입력해 주세요.');
  const id=url.searchParams.get('blogId') || url.pathname.split('/').filter(Boolean)[0] || '';
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,49}$/.test(id))throw new Error('블로그 ID를 확인해 주세요.');
  return id.toLowerCase();
}
export function createBloggerWorkspace(client,{onMemberChange}) {
  let user=null,settings=null,loaded=false,generation=0,savedVersion=0,searchVersion=0;
  let savedPage=1,resultPage=1,results=[],resultQuery='',savedRecords=new Map();
  let toastTimer,searchController,dialogBusy=false;
  const dashboard=createBloggerDashboard(client,{notify,onSearch(keyword){topicDiscovery.direct();$('blogSearchQuery').value=keyword;location.hash='keywordSearchView';}});
  $('accountView').innerHTML=heading('YOUR WORKSPACE','내 작업 공간 설정','블로그 운영 방식에 맞는 대시보드를 선택하세요.')+'<p class="member-settings-link"><a href="#membershipView">내 이용 등급 · 사용량 보기 ↗</a><a href="/password-reset.html">비밀번호 재설정</a></p><div id="workspaceSettingsBody" class="panel work-panel" aria-live="polite">계정 설정을 불러오고 있습니다…</div>';
  $('keywordSearchView').innerHTML=heading('KEYWORD DISCOVERY','키워드 탐색','내게 맞는 글감부터 주제별 인기 키워드까지 한곳에서 찾아보세요.')+`
    <section class="panel work-panel"><form id="blogSearchForm" class="work-search-form"><label>검색할 키워드<input id="blogSearchQuery" type="search" maxlength="100" required placeholder="예: 제주 여행, 가을 코디, 집밥 메뉴" /></label><button id="blogSearchSubmit" class="button">검색량 조회</button></form><p class="muted small">네이버 검색광고의 최근 30일 PC·모바일 검색량입니다. ‘10 미만’ 응답은 범위로 표시합니다.</p><p id="blogSearchMessage" class="message" role="status">관련 키워드를 연관도순으로 찾아보세요. 기본·플러스는 일일 조회 한도 없이 이용할 수 있습니다.</p></section>
    <section id="blogSearchResultsPanel" class="panel work-panel" hidden><div class="work-section-title"><h2 id="blogSearchResultTitle">검색 결과</h2><span id="blogSearchDate" class="muted small"></span></div><div id="blogSearchResults"></div><div class="pagination"><button class="button button-light" data-work-action="result-prev">이전</button><span id="blogResultPage"></span><button class="button button-light" data-work-action="result-next">다음</button></div><p class="catalog-footnote">입력한 키워드를 먼저, 연관 키워드는 키온 연관도순으로 최대 200개 보여드립니다. 입력어와의 일치·포함 여부와 공통 표현을 기준으로 정렬하며 네이버 공식 연관도 점수는 아닙니다. 30일 이내 조회 결과는 재사용합니다.</p></section>`;
  const topicDiscovery=createTopicDiscovery(client,{root:$('keywordSearchView'),onSaved:()=>dashboard.invalidate()});
  $('savedKeywordsView').innerHTML=heading('YOUR IDEA LIBRARY','내 키워드 보관함','글감을 모아두고, 폴더와 메모로 정리하세요.','<button class="button" data-work-action="keyword-new">+ 키워드 직접 추가</button>')+`
    <section class="panel work-panel"><div class="work-filters"><label>키워드 찾기<input id="savedQuery" type="search" maxlength="100" placeholder="보관한 키워드 검색" /></label><label>폴더<select id="savedFolder"><option value="">모든 폴더</option></select></label><label>보기<select id="savedArchive"><option value="active">보관 중</option><option value="archived">보관 해제한 키워드</option></select></label></div><div class="work-section-title"><strong id="savedCount" aria-live="polite"></strong><a href="#keywordSearchView">키워드 더 찾기 ↗</a></div><div id="savedRows" class="work-keyword-grid"></div><div class="pagination"><button id="savedPrev" class="button button-light" data-work-action="saved-prev">이전</button><span id="savedPage"></span><button id="savedNext" class="button button-light" data-work-action="saved-next">다음</button></div></section>`;
  const dialog=document.createElement('dialog');dialog.id='workspaceDialog';dialog.className='keyword-dialog work-dialog';document.body.append(dialog);
  dialog.addEventListener('cancel',event=>{if(dialogBusy)event.preventDefault();});
  function notify(message,error=false){$('workspaceToast').textContent=message;$('workspaceToast').className=`workspace-toast ${error?'error':''}`;$('workspaceToast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('workspaceToast').hidden=true,6000);}
  async function checked(query){const result=await query;if(result.error)throw result.error;return result.data;}
  function settingsForm(){
    if(!loaded)return;
    $('workspaceSettingsBody').innerHTML=`<p class="eyebrow">${settings?'WORKSPACE SETTINGS':'WELCOME · 처음 한 번 설정'}</p><h2>${settings?'내 대시보드와 블로그':'어떤 방식으로 블로그를 운영하시나요?'}</h2><form id="memberForm"><div class="work-mode-options"><label><input type="radio" name="workspaceMode" value="blogger" ${settings?.mode!=='influencer'?'checked':''} /><span><strong>일반 블로거</strong><small>키워드 탐색 · 글감 보관 · 블로그 분석</small></span></label><label><input type="radio" name="workspaceMode" value="influencer" ${settings?.mode==='influencer'?'checked':''} /><span><strong>네이버 인플루언서</strong><small>키워드 챌린지 현황 · 순위 · 공략</small></span></label></div><div id="memberBlogFields"><label>네이버 블로그 주소<input id="memberBlog" maxlength="300" placeholder="https://blog.naver.com/내아이디" value="${settings?.blog_id?esc(`https://blog.naver.com/${settings.blog_id}`):''}" /></label><label>주로 다루는 분야<select id="memberInterest">${['','여행','뷰티','패션','푸드','리빙','육아','IT테크','자동차','경제/비즈니스','생활건강','운동/레저','도서','문화/예술','기타'].map(f=>`<option value="${esc(f)}" ${settings?.interest===f?'selected':''}>${f||'관심 분야 선택'}</option>`).join('')}</select></label><p class="muted small">블로그 주소를 연결하면 로그인할 때 공개된 최근 글을 자동으로 가져옵니다. 인플루언서도 함께 사용할 수 있습니다.</p></div><p id="memberInfluencerNote" class="muted" hidden>인플홈을 연결하면 참여 키워드와 순위를 볼 수 있습니다. 블로그 주소를 추가하면 내 블로그 분석도 함께 사용할 수 있습니다.</p><button id="memberSubmit" class="button">${settings?'설정 저장':'내 대시보드 시작하기'}</button><p id="memberMessage" class="message" role="status"></p></form>`;
    const change=()=>{const mode=$('memberForm').querySelector('input[name="workspaceMode"]:checked').value;$('memberBlogFields').hidden=false;$('memberBlog').required=mode==='blogger';$('memberInfluencerNote').hidden=mode!=='influencer';};
    $('memberForm').querySelectorAll('[name="workspaceMode"]').forEach(el=>el.addEventListener('change',change));change();
    $('memberForm').addEventListener('submit',async e=>{e.preventDefault();const g=generation;const mode=$('memberForm').querySelector('input[name="workspaceMode"]:checked').value;$('memberSubmit').disabled=true;try{
      const id=$('memberBlog').value.trim()?blogId($('memberBlog').value):null;
      const row=await checked(client.from('keychallenge_members').upsert({user_id:user.id,mode,blog_id:id,interest:$('memberInterest').value},{onConflict:'user_id'}).select().single());
      if(g!==generation)return;settings=row;topicDiscovery.setContext(user,settings);dashboard.setContext(user,settings);onMemberChange(settings);settingsForm();window.location.replace('#strategyView');notify('내 작업 공간을 저장했습니다.');
    }catch(error){if(g===generation)$('memberMessage').textContent=error.message;}finally{if(g===generation)$('memberSubmit').disabled=false;}});
  }
  async function loadSaved(){if(!user||!loaded)return;const v=++savedVersion,g=generation;$('savedCount').textContent='불러오는 중…';try{
    const result=await checked(client.rpc('keychallenge_blogger_saved',{p_query:$('savedQuery').value.trim(),p_folder:$('savedFolder').value,p_archived:$('savedArchive').value==='archived',p_page:savedPage}));if(g!==generation||v!==savedVersion)return;
    const old=$('savedFolder').value;$('savedFolder').innerHTML='<option value="">모든 폴더</option>'+result.folders.map(f=>`<option value="${esc(f)}">${esc(f)}</option>`).join('');$('savedFolder').value=old;
    savedRecords=new Map(result.items.map(row=>[row.id,row]));$('savedCount').textContent=`${number(result.total)}개 키워드`;
    $('savedRows').innerHTML=result.items.length?result.items.map(row=>`<article class="work-keyword-card"><div class="work-section-title"><h3>${esc(row.keyword)}</h3><span class="count-chip">${esc(row.folder||'미분류')}</span></div><p class="work-volume">${volume(row)}<small>월 검색량</small></p><p class="work-card-note">${esc(row.notes||'떠오르는 글감이나 작성 방향을 메모해 보세요.')}</p><small class="muted">${row.volume_collected_at?`${esc(stamp(row.volume_collected_at))} 검색량 조회`:'검색량 조회 전'}</small><div class="work-card-actions"><button class="button button-quiet" data-work-action="keyword-edit" data-id="${row.id}">메모·폴더</button><button class="work-text-button" data-work-action="keyword-archive" data-id="${row.id}">${row.archived?'다시 보관':'보관 해제'}</button></div></article>`).join(''):empty('아직 보관한 키워드가 없거나 검색 조건에 맞는 결과가 없습니다.');
    const pages=Math.max(1,Math.ceil(result.total/24));$('savedPage').textContent=`${savedPage} / ${pages}`;$('savedPrev').disabled=savedPage<=1;$('savedNext').disabled=savedPage>=pages;
  }catch(error){if(g===generation&&v===savedVersion){$('savedCount').textContent='불러오기 실패';$('savedRows').innerHTML=empty('보관함을 불러오지 못했습니다. 잠시 후 다시 열어 주세요.');}}}
  function renderResults(){
    const rows=results.slice((resultPage-1)*25,resultPage*25);$('blogSearchResultTitle').textContent=`‘${resultQuery}’ 검색 결과 · ${number(results.length)}개`;
    $('blogSearchResults').innerHTML=`<div class="table-wrap"><table class="tbl work-search-table"><thead><tr><th>키워드</th><th>PC</th><th>모바일</th><th>월 검색량 합계</th><th>보관</th></tr></thead><tbody>${rows.map(row=>`<tr><td><strong>${esc(row.keyword)}</strong></td><td>${range(row.pc_min,row.pc_max)}</td><td>${range(row.mobile_min,row.mobile_max)}</td><td><strong>${volume(row)}</strong></td><td><button class="button button-light" data-work-action="result-save" data-keyword="${esc(row.keyword)}">보관하기</button></td></tr>`).join('')}</tbody></table></div>`;
    const pages=Math.max(1,Math.ceil(results.length/25));$('blogResultPage').textContent=`${resultPage} / ${pages}`;document.querySelector('[data-work-action="result-prev"]').disabled=resultPage<=1;document.querySelector('[data-work-action="result-next"]').disabled=resultPage>=pages;
  }
  $('blogSearchForm').addEventListener('submit',async event=>{event.preventDefault();if(!user)return;const g=generation,v=++searchVersion;searchController?.abort();searchController=new AbortController();$('blogSearchSubmit').disabled=true;$('blogSearchResultsPanel').hidden=true;$('blogSearchMessage').textContent='월 검색량과 관련 키워드를 불러오고 있습니다…';try{
    const {data:{session}}=await client.auth.getSession();if(g!==generation)return;if(!session)throw new Error('다시 로그인해 주세요.');
    const response=await fetch(`${window.APP_CONFIG.SUPABASE_URL}/functions/v1/keychallenge-keyword-search`,{method:'POST',signal:searchController.signal,headers:{apikey:window.APP_CONFIG.SUPABASE_ANON_KEY,Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({query:$('blogSearchQuery').value.trim(),sort:'relevance'})});
    const result=await response.json();if(g!==generation||v!==searchVersion)return;if(!response.ok)throw new Error(result.error||'검색량을 불러오지 못했습니다.');results=result.items;resultQuery=result.query;resultPage=1;renderResults();$('blogSearchDate').textContent=`${stamp(result.collected_at)} 기준`;$('blogSearchResultsPanel').hidden=false;$('blogSearchMessage').textContent='키온 연관도순 · 마음에 드는 키워드를 보관함에 저장해 보세요.';
  }catch(error){if(g===generation&&v===searchVersion&&error.name!=='AbortError')$('blogSearchMessage').textContent=error.message;}finally{if(g===generation&&v===searchVersion)$('blogSearchSubmit').disabled=false;}});
  function openForm(title,body,save){
    dialog.innerHTML=`<div class="dialog-head"><h2>${title}</h2><button type="button" class="button button-light" data-work-action="dialog-close">닫기</button></div><form id="workspaceEditForm">${body}<p id="workspaceEditError" class="message error" role="status"></p><div class="work-card-actions"><button class="button" id="workspaceEditSave">저장</button><button type="button" class="button button-light" data-work-action="dialog-close">취소</button></div></form>`;
    dialogBusy=false;dialog.setAttribute('aria-label',title);dialog.showModal();$('workspaceEditForm').addEventListener('submit',async e=>{e.preventDefault();const g=generation;dialogBusy=true;dialog.querySelectorAll('button').forEach(button=>button.disabled=true);try{await save(new FormData(e.currentTarget),g);if(g!==generation)return;dialog.close();dashboard.invalidate();notify('저장했습니다.');await loadSaved();}catch(error){if(g===generation)$('workspaceEditError').textContent=error.message;}finally{if(g===generation){dialogBusy=false;dialog.querySelectorAll('button').forEach(button=>button.disabled=false);}}});
  }
  function keywordForm(id){const row=savedRecords.get(id);openForm(row?'키워드 메모·폴더':'키워드 직접 추가',`<label>키워드<input name="keyword" maxlength="100" required value="${esc(row?.keyword||'')}" ${row?'readonly':''} /></label><label>폴더<input name="folder" maxlength="60" placeholder="예: 가을 여행, 제품 리뷰" value="${esc(row?.folder||'')}" /></label><label>메모<textarea name="notes" maxlength="2000" rows="4" placeholder="작성하고 싶은 내용이나 아이디어">${esc(row?.notes||'')}</textarea></label>`,async(form,g)=>{
    const keyword=String(form.get('keyword')).trim();if(!keyword)throw new Error('키워드를 입력해 주세요.');
    const target=row||await checked(client.rpc('keychallenge_save_blog_keyword',{p_keyword:keyword}));if(g!==generation)return;
    await checked(client.from('keychallenge_blog_keywords').update({folder:String(form.get('folder')).trim(),notes:String(form.get('notes')).trim()}).eq('id',target.id).eq('user_id',user.id).select('id').single());savedPage=1;
  });}
  async function act(button){if(!user)return;const action=button.dataset.workAction,g=generation;try{
    if(action==='dialog-close'){if(!dialogBusy)dialog.close();return;}
    if(action==='retry-member'){await api.setUser(user,true);return;}
    if(action==='keyword-new'||action==='keyword-edit'){keywordForm(button.dataset.id);return;}
    if(action==='result-save'){button.disabled=true;await checked(client.rpc('keychallenge_save_blog_keyword',{p_keyword:button.dataset.keyword}));if(g!==generation)return;dashboard.invalidate();button.textContent='보관됨 ✓';notify('보관함에 저장했습니다.');return;}
    if(action==='keyword-archive'){
      const row=savedRecords.get(button.dataset.id);if(!row)return;button.disabled=true;
      await checked(client.from('keychallenge_blog_keywords').update({archived:!row.archived}).eq('id',row.id).eq('user_id',user.id).select('id').single());if(g!==generation)return;
      dashboard.invalidate();notify(row.archived?'복원했습니다.':'보관을 해제했습니다.');savedPage=1;await loadSaved();return;
    }
    if(action.startsWith('result-')){resultPage+=action==='result-next'?1:-1;renderResults();return;}
    if(action.startsWith('saved-')){savedPage=Math.max(1,savedPage+(action==='saved-next'?1:-1));await loadSaved();return;}
  }catch(error){if(g===generation){button.disabled=false;notify(error.message||'저장하지 못했습니다. 다시 시도해 주세요.',true);}}}
  document.addEventListener('click',e=>{const button=e.target.closest('[data-work-action]');if(button&&!button.disabled)void act(button);});
  let filterTimer; $('savedQuery').addEventListener('input',()=>{clearTimeout(filterTimer);filterTimer=setTimeout(()=>{savedPage=1;void loadSaved();},300);});
  for(const id of ['savedFolder','savedArchive'])$(id).addEventListener('change',()=>{savedPage=1;void loadSaved();});
  const api={async setUser(nextUser,force=false){
    if(!force&&loaded&&user?.id===nextUser?.id)return settings;
    const g=++generation;user=nextUser;settings=null;loaded=false;results=[];savedRecords.clear();searchController?.abort();searchVersion++;savedVersion++;clearTimeout(filterTimer);clearTimeout(toastTimer);
    dialogBusy=false;if(dialog.open)dialog.close();$('workspaceToast').hidden=true;$('blogSearchForm').reset();$('blogSearchSubmit').disabled=false;$('blogSearchMessage').textContent='키워드를 입력하면 관련 키워드도 함께 보여드립니다.';$('blogSearchResultsPanel').hidden=true;$('savedQuery').value='';$('savedFolder').innerHTML='<option value="">모든 폴더</option>';$('savedArchive').value='active';savedPage=1;$('savedRows').innerHTML='';
    topicDiscovery.setContext(user,null);dashboard.setContext(user,null);$('workspaceSettingsBody').textContent='계정 설정을 불러오고 있습니다…';
    if(!user){onMemberChange(null,false);return null;}
    try{const row=await checked(client.from('keychallenge_members').select('*').eq('user_id',user.id).maybeSingle());if(g!==generation)return null;settings=row;loaded=true;topicDiscovery.setContext(user,settings);dashboard.setContext(user,settings);settingsForm();onMemberChange(settings,true);return settings;}
    catch(error){if(g===generation){$('workspaceSettingsBody').innerHTML='<h2>설정을 불러오지 못했습니다.</h2><p class="muted">잠시 후 다시 불러와 주세요.</p><button class="button" data-work-action="retry-member">다시 불러오기</button>';onMemberChange(null,false);}return null;}
  },show(page){dashboard.show(page);topicDiscovery.show(page);if(!user||!loaded)return;if(page==='savedKeywordsView')void loadSaved();}};
  return api;
}
