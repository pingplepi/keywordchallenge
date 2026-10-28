import { blankCollaboration, extractCollaboration, readGuideFile, sumMoney, outstanding, STATUS, KINDS } from './collaboration-import.js';
import { EVENT_TYPES, monthDays, moveMonth, calendarEvents } from './collaboration-calendar.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = value => `${Number(value || 0).toLocaleString('ko-KR')}원`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dateOnly = value => value ? String(value).slice(0, 10).replaceAll('-', '/') : '—';
const kstDateTime = value => value ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)).replace(' ', 'T') : '';
const dateTime = value => value ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }) : '—';
const active = row => !['completed', 'cancelled'].includes(row.status);
const safeUrl = value => { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };
function eventsFor(row) {
  if (row.deleted_at || row.status === 'cancelled') return [];
  const events = [];
  if (active(row) && row.status !== 'published') {
    if (row.visit_at) events.push({ date: kstDateTime(row.visit_at).slice(0, 10), label: '방문·예약', time: kstDateTime(row.visit_at).slice(11) });
    if (row.draft_due && ['preparing', 'writing', 'revision'].includes(row.status)) events.push({ date: row.draft_due, label: '원고 제출' });
    if (row.publish_due) events.push({ date: row.publish_due, label: '발행 마감' });
    for (const d of row.deliverables || []) if (d.due_on && d.status !== 'published') events.push({ date: d.due_on, label: d.name });
  }
  if (row.payment_due && outstanding(row) > 0) events.push({ date: row.payment_due, label: '정산 예정' });
  return events.map(e => ({ ...e, row })).sort((a, b) => a.date.localeCompare(b.date));
}

export function createCollaborationManager(client) {
  const root = document.getElementById('collaborationView');
  const admin = document.createElement('section'); admin.className = 'panel admin-panel collab-mail-admin'; admin.hidden = true;
  document.getElementById('catalogAdmin').append(admin);
  const dialog = document.createElement('dialog'); dialog.className = 'collab-dialog'; dialog.setAttribute('aria-labelledby', 'collabDialogTitle'); document.body.append(dialog);
  let user = null, generation = 0, loaded = false, loading = false, rows = [], mail = null;
  let view = 'active', query = '', statusFilter = '', page = 1, notice = '', noticeError = false;
  let draft = null, evidence = [], warnings = [], history = [], reminders = [], tab = 'basic', dirty = false, busy = false, modalMode = '';
  let importSourceName = '', adminBusy = false;
  let reviewRequired = false, reviewConfirmed = false;
  let calendarMonth = today().slice(0, 7), calendarDay = today();
  const report = (message, error = false) => { notice = message; noticeError = error; render(); };

  async function load() {
    if (!user || loading) return;
    loading = true; const version = generation; render();
    try {
      const collected = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await client.from('keyon_collaborations').select('id,user_id,title,company,channel,contact,cash_fee,provided_value,deductions,status,visit_at,draft_due,publish_due,payment_due,deliverables,payments,expenses,deleted_at,revision,updated_at').order('updated_at', { ascending: false }).order('id').range(from, from + 999);
        if (error) throw error;
        if (version !== generation) return;
        collected.push(...data); if (data.length < 1000) break;
      }
      rows = collected; loaded = true; notice = ''; noticeError = false;
      await loadMail(version);
    } catch (error) { if (version === generation) { notice = `협업 목록을 불러오지 못했습니다. ${error.message || '다시 시도해 주세요.'}`; noticeError = true; } }
    finally { if (version === generation) { loading = false; render(); } }
  }
  async function loadMail(version = generation) {
    const { data, error } = await client.rpc('keyon_collaboration_mail_status');
    if (version !== generation) return;
    mail = error ? null : data; renderAdmin();
  }
  function render() {
    if (!user) { root.replaceChildren(); return; }
    const visible = rows.filter(r => !r.deleted_at), current = visible.filter(active), allEvents = visible.flatMap(eventsFor).sort((a,b) => a.date.localeCompare(b.date));
    const overdue = allEvents.filter(e => e.date < today()).length;
    root.innerHTML = `<div class="work-heading"><div><p class="eyebrow">COLLABORATION MANAGER</p><h1>협업 매니저</h1><p class="muted">제안부터 발행, 정산까지. 내 협업을 한곳에서 관리하세요.</p></div><div class="collab-actions"><button class="button button-light" data-action="import">메일·가이드 가져오기</button><button class="button" data-action="new">＋ 새 협업</button></div></div>
      <div class="collab-stats"><div class="panel"><span>진행 중인 협업</span><strong>${current.length}<small>건</small></strong><p>준비부터 발행까지</p></div><div class="panel"><span>확인할 일정</span><strong>${overdue}<small>건</small></strong><p>기한이 지난 미완료 일정</p></div><div class="panel"><span>미입금 원고료</span><strong>${won(visible.reduce((s,r) => s + outstanding(r), 0))}</strong><p>약정 원고료 − 공제액 − 입금액</p></div><div class="panel"><span>누적 현금 입금</span><strong>${won(visible.reduce((s,r) => s + sumMoney(r.payments), 0))}</strong><p>제품·서비스 제공가는 제외</p></div></div>
      <section class="panel collab-list-panel"><div class="collab-list-heading"><div class="collab-view-tabs" role="group" aria-label="협업 보기">${[['active','진행 중'],['schedule','일정 모아보기'],['history','완료·취소'],['trash','휴지통']].map(([key,label]) => `<button class="button ${view === key ? '' : 'button-light'}" data-view="${key}" aria-pressed="${view === key}">${label}</button>`).join('')}</div><button class="button button-quiet" data-action="refresh" ${loading ? 'disabled' : ''}>${loading ? '불러오는 중…' : '새로고침'}</button></div>
      <div class="collab-filters"><label>협업 찾기<input type="search" id="collabSearch" value="${esc(query)}" maxlength="100" placeholder="업체명, 협업명, 담당자 검색" /></label><label>진행 상태<select id="collabStatusFilter"><option value="">전체</option>${Object.entries(STATUS).map(([k,v]) => `<option value="${k}" ${k===statusFilter?'selected':''}>${v}</option>`).join('')}</select></label></div>
      <p class="collab-notice ${noticeError?'error':''}" role="status">${esc(notice)}</p><div id="collabListResults"></div></section>
      <section id="collabCalendar" class="panel collab-calendar-panel" aria-label="협업 일정 달력" ${['active','schedule'].includes(view)?'':'hidden'}></section>
      <p class="collab-footnote">협업 정보는 내 계정에만 저장됩니다. 현금 입금과 지출은 기록한 금액 기준이며, 제품·서비스 제공가와 합산하지 않습니다.</p>`;
    renderResults();
  }
  function renderResults() {
    const target = root.querySelector('#collabListResults'); if (!target) return;
    renderCalendar();
    const filtered = rows.filter(r => (view==='trash' ? Boolean(r.deleted_at) : !r.deleted_at && (view==='history' ? !active(r) : view==='schedule' || active(r)))
      && (!statusFilter || r.status===statusFilter) && `${r.company} ${r.title} ${r.contact} ${r.channel}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    if (loading && !loaded) { target.innerHTML = '<div class="collab-empty" aria-busy="true">협업 목록을 불러오고 있습니다.</div>'; return; }
    if (view === 'schedule') {
      target.innerHTML = '<p class="muted small">아래 달력에서 날짜를 선택하면 해당 일정을 모두 볼 수 있습니다. 완료한 일정도 함께 표시하며, 취소·휴지통 기록은 제외합니다.</p>'; return;
    }
    if (!filtered.length) {
      target.innerHTML = `<div class="collab-empty"><span class="collab-empty-mark" aria-hidden="true">✦</span><h2>${query || statusFilter ? '조건에 맞는 협업이 없어요' : view==='active' ? '첫 협업을 등록해 보세요' : '아직 기록이 없어요'}</h2><p>${view==='active' && !query && !statusFilter ? '협업 메일을 붙여넣거나 가이드 파일을 올리면<br>업체명·조건·일정·금액을 초안으로 정리해 드립니다.' : '등록한 협업의 진행 상태와 일정을 여기서 확인할 수 있습니다.'}</p>${view==='active'&&!query&&!statusFilter?'<button class="button button-light" data-action="import">메일·가이드로 시작하기</button>':''}</div>`; return;
    }
    const pages = Math.max(1, Math.ceil(filtered.length/20)); page = Math.min(page,pages);
    target.innerHTML = `<p class="muted small">${filtered.length}건의 협업</p><div class="table-wrap collab-table-wrap" tabindex="0" aria-label="협업 목록, 좁은 화면에서 좌우 스크롤"><table class="collab-table"><thead><tr><th>협업</th><th>진행 상태</th><th>결과물</th><th>다가오는 일정</th><th>제공가 · 지출</th><th>원고료 · 정산</th><th>관리</th></tr></thead><tbody>${filtered.slice((page-1)*20,page*20).map(r => {
      const e = eventsFor(r)[0], published = r.deliverables.filter(d => d.status==='published').length;
      return `<tr><td><button class="collab-title-button" data-open="${r.id}">${esc(r.title)}</button><span class="collab-cell-sub">${esc(r.company || '업체명 미입력')}${r.channel?` · ${esc(r.channel)}`:''}</span></td><td><span class="collab-badge collab-status-${r.status}">${STATUS[r.status]}</span></td><td><strong>${published} / ${r.deliverables.length}</strong><span class="collab-cell-sub">${r.deliverables.length?'발행 완료':'결과물 미등록'}</span></td><td>${e?`<span class="${e.date<today()?'collab-overdue':''}">${dateOnly(e.date)}</span><span class="collab-cell-sub">${esc(e.label)}</span>`:'<span class="muted">등록된 일정 없음</span>'}</td><td><span class="collab-money-line">제공가 <strong>${won(r.provided_value)}</strong></span><span class="collab-cell-sub">지출 ${won(sumMoney(r.expenses))}</span></td><td><strong>${won(r.cash_fee)}</strong><span class="collab-cell-sub ${outstanding(r)?'collab-overdue':''}">${outstanding(r)?`미입금 ${won(outstanding(r))}`:Number(r.cash_fee)>0?'입금 완료':'현금 원고료 없음'}</span></td><td><button class="button button-light" data-open="${r.id}">${view==='trash'?'기록 보기':'상세·수정'}</button></td></tr>`;
    }).join('')}</tbody></table></div><div class="pagination"><button class="button button-light" data-page="${page-1}" ${page<=1?'disabled':''}>이전</button><span>${page} / ${pages}</span><button class="button button-light" data-page="${page+1}" ${page>=pages?'disabled':''}>다음</button></div>`;
  }
  function renderCalendar(focusSelector = '') {
    const target = root.querySelector('#collabCalendar');
    if (!target || target.hidden) return;
    if (loading && !loaded) { target.innerHTML = '<p class="muted" aria-busy="true">달력을 불러오고 있습니다.</p>'; return; }
    const events = rows.filter(r => (!statusFilter || r.status===statusFilter) && `${r.company} ${r.title} ${r.contact} ${r.channel}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      .flatMap(calendarEvents).sort((a,b) => a.date.localeCompare(b.date) || (a.time||'').localeCompare(b.time||'') || a.row.title.localeCompare(b.row.title));
    const byDay = new Map();
    for (const event of events) { if (!byDay.has(event.date)) byDay.set(event.date, []); byDay.get(event.date).push(event); }
    const currentDay = today(), [year, month] = calendarMonth.split('-');
    const selected = byDay.get(calendarDay) || [];
    const monthCount = events.filter(e => e.date.startsWith(calendarMonth)).length;
    const shortDate = date => `${Number(date.slice(5,7))}월 ${Number(date.slice(8))}일`;
    target.innerHTML = `<div class="collab-calendar-heading"><div><p class="eyebrow">COLLABORATION CALENDAR</p><h2>협업 일정 달력</h2><p class="muted small">날짜를 눌러 일정을 확인하고, 협업을 열어 바로 수정하세요.</p></div><div class="collab-month-nav"><button type="button" class="button button-light" data-month="-1" aria-label="이전 달" ${calendarMonth==='1900-01'?'disabled':''}>‹</button><h3 aria-live="polite">${year}년 ${Number(month)}월</h3><button type="button" class="button button-light" data-month="1" aria-label="다음 달" ${calendarMonth==='2100-12'?'disabled':''}>›</button><button type="button" class="button button-quiet" data-calendar-today>오늘</button></div></div>
      <div class="collab-calendar-legend">${Object.entries(EVENT_TYPES).map(([key,label])=>`<span class="collab-event-tone-${key}"><i aria-hidden="true"></i>${label}</span>`).join('')}<span class="collab-calendar-complete">완료한 일정은 연하게 표시</span></div>
      <p class="collab-calendar-caption">이번 달 ${monthCount}건${query||statusFilter?' · 검색 조건 적용':''} · 한국시간 기준</p>
      <div class="collab-month-grid" role="group" aria-label="${year}년 ${Number(month)}월 달력">
        ${['일','월','화','수','목','금','토'].map((day,i)=>`<div class="collab-weekday ${i===0?'is-sunday':i===6?'is-saturday':''}">${day}</div>`).join('')}
        ${monthDays(calendarMonth).map(day=>{
          const daily = byDay.get(day.date) || [];
          return `<div class="collab-day ${day.inMonth?'':'is-outside'} ${day.date===currentDay?'is-today':''} ${day.date===calendarDay?'is-selected':''}">
            <button type="button" class="collab-day-select" data-calendar-day="${day.date}" aria-label="${dateOnly(day.date)}, 일정 ${daily.length}건${day.date===currentDay?', 오늘':''}" aria-pressed="${day.date===calendarDay}" ${day.date===currentDay?'aria-current="date"':''}><span>${day.day}</span><small>${daily.length?`${daily.length}건`:''}</small></button>
            <div class="collab-day-events">${daily.slice(0,3).map(event=>`<button type="button" class="collab-calendar-chip collab-event-tone-${event.type} ${event.done?'is-done':''}" data-open="${esc(event.row.id)}" title="${esc(`${event.label} · ${event.row.company || event.row.title} · ${event.row.title}${event.time?` · ${event.time}`:''}${event.done?' · 완료':''}`)}"><span class="collab-chip-type">${esc(event.time || EVENT_TYPES[event.type])}</span><span>${esc(event.row.company || event.row.title)}</span>${event.done?'<span class="collab-chip-done">완료</span>':''}</button>`).join('')}${daily.length>3?`<button type="button" class="collab-more-events" data-calendar-day="${day.date}">＋ ${daily.length-3}건 더 보기</button>`:''}</div>
            <div class="collab-day-dots" aria-hidden="true">${[...new Set(daily.map(e=>e.type))].map(type=>`<i class="collab-event-tone-${type}"></i>`).join('')}</div>
          </div>`;
        }).join('')}</div>
      <div class="collab-selected-day"><div class="collab-section-heading"><h3>${shortDate(calendarDay)} 일정 <span>${selected.length}건</span></h3><span class="muted small">협업을 누르면 상세 화면이 열립니다.</span></div>
      ${selected.length?`<div class="collab-calendar-list">${selected.map(event=>`<button type="button" class="collab-calendar-event ${event.done?'is-done':''}" data-open="${esc(event.row.id)}"><span class="collab-event-tone-${event.type}"><strong>${esc(EVENT_TYPES[event.type])}</strong>${event.time?`<small>${esc(event.time)}</small>`:''}</span><div><strong>${esc(event.row.title)}</strong><p>${esc(event.row.company || '업체명 미입력')}${event.type==='output'?` · ${esc(event.label)}`:''}</p></div><span class="${!event.done&&event.date<currentDay?'collab-overdue':''}">${event.done?'완료':event.date<currentDay?'기한 지남':event.date===currentDay?'오늘':'예정'} ↗</span></button>`).join('')}</div>`:'<p class="collab-calendar-no-events">등록된 일정이 없습니다. 협업의 일정·알림이나 결과물에서 날짜를 등록해 주세요.</p>'}</div>`;
    if (focusSelector) target.querySelector(focusSelector)?.focus({preventScroll:true});
  }
  function showDialog() { if (!dialog.open) dialog.showModal(); }
  async function loadEditor(id) {
    const version = generation; modalMode='loading'; dirty=false;
    dialog.innerHTML='<div class="collab-dialog-head"><h2 id="collabDialogTitle">협업 불러오기</h2><button class="button button-quiet" data-close>닫기</button></div><div class="collab-dialog-body"><p id="collabDialogMessage" role="status">협업 내용을 불러오고 있습니다…</p></div>';
    showDialog();
    const {data,error}=await client.from('keyon_collaborations').select('*').eq('id',id).single();
    if(version!==generation||modalMode!=='loading'||!dialog.open)return;
    if(error||!data){dialogMessage('협업 내용을 불러오지 못했습니다. 창을 닫고 다시 시도해 주세요.',true);return;}
    await openEditor(data);
  }
  function closeDialog(force = false) { if (busy) return; if (!force && dirty && !window.confirm('저장하지 않은 내용이 있습니다. 닫으시겠어요?')) return; dialog.close(); draft=null; modalMode=''; dirty=false; }
  function openImport() {
    modalMode='import'; draft=null; importSourceName=''; dirty=false; busy=false;
    dialog.innerHTML = `<div class="collab-dialog-head"><div><p class="eyebrow">START FROM YOUR BRIEF</p><h2 id="collabDialogTitle">메일·가이드 가져오기</h2></div><button class="button button-quiet" data-close aria-label="가져오기 닫기">닫기</button></div><div class="collab-dialog-body"><p class="muted">원문에서 항목을 찾아 초안을 채웁니다. 내용은 이 브라우저에서 분석하며, 저장하기 전에는 서버에 보내지 않습니다.</p><label class="collab-upload">가이드 파일<input id="collabImportFile" type="file" accept=".pdf,.docx,.txt,.md,.html,.htm,.eml" /><span>PDF·Word·텍스트·HTML · 최대 5MB, PDF 40페이지 · 스캔 이미지는 텍스트 필요</span></label><label>협업 메일 또는 가이드 내용<textarea id="collabImportText" rows="14" maxlength="50000" placeholder="예시&#10;업체명: 키온 여행&#10;협업명: 제주 숙박 체험&#10;제공 제품: 2박 숙박권&#10;원고료: 20만원&#10;발행 마감: 2026/11/15&#10;필수 키워드: 제주 숙소, 가족 여행&#10;결과물: 블로그 1건, 릴스 1건"></textarea></label><p class="muted small">연도 없는 날짜나 협의 중인 금액은 확인 표시가 나옵니다. 원본 파일 대신 추출한 텍스트를 협업 기록에 저장합니다.</p><p id="collabDialogMessage" role="status"></p></div><div class="collab-dialog-footer"><button class="button button-quiet" data-close>취소</button><button class="button" data-extract>자동 분류 · 초안 확인</button></div>`;
    showDialog();
  }
  async function openEditor(row = null, imported = null) {
    modalMode='editor'; draft=structuredClone(row || imported?.draft || blankCollaboration()); evidence=imported?.evidence || []; warnings=imported?.warnings || []; tab='basic'; history=[]; reminders=[]; dirty=!!imported; busy=false;
    reviewRequired=Boolean(imported); reviewConfirmed=false;
    if (!row && !draft.deliverables.length) draft.deliverables.push({id:crypto.randomUUID(),kind:'blog',name:'블로그 글',status:'preparing',due_on:'',url:''});
    renderEditor(); showDialog();
    if (row) {
      const version=generation, id=row.id;
      const results=await Promise.allSettled([
        client.from('keyon_collaboration_history').select('happened_at,action,changes').eq('collaboration_id',id).order('happened_at',{ascending:false}).limit(50),
        client.from('keyon_collaboration_reminders').select('event_label,due_at,state,sent_at,error').eq('collaboration_id',id).neq('state','cancelled').order('due_at',{ascending:false}).limit(50),
      ]);
      if(version!==generation || draft?.id!==id || modalMode!=='editor') return;
      history=results[0].status==='fulfilled'&&!results[0].value.error?results[0].value.data:[];
      reminders=results[1].status==='fulfilled'&&!results[1].value.error?results[1].value.data:[];
      if(tab==='notes'||tab==='schedule') { readForm(); renderEditor(); }
    }
  }
  const field = (name,label,type='text',max=160) => `<label>${label}<input name="${name}" type="${type}" value="${esc(draft[name] || '')}" maxlength="${max}" ${name==='title'?'required':''} /></label>`;
  const area = (name,label,rows=3,max=10000) => `<label>${label}<textarea name="${name}" rows="${rows}" maxlength="${max}">${esc(draft[name])}</textarea></label>`;
  function renderEditor() {
    const tabs=[['basic','기본 정보'],['terms','협업 조건'],['schedule','일정·알림'],['outputs','결과물'],['money','금액·정산'],['notes','메모·이력']];
    dialog.innerHTML=`<form id="collabForm"><div class="collab-dialog-head"><div><p class="eyebrow">${draft.id?'COLLABORATION DETAILS':'NEW COLLABORATION'}</p><h2 id="collabDialogTitle">${draft.id?esc(draft.title):'새 협업 등록'}</h2></div><button type="button" class="button button-quiet" data-close>닫기</button></div><div class="collab-editor-tabs" role="tablist" aria-label="협업 항목">${tabs.map(([key,label])=>`<button type="button" role="tab" id="collabTab-${key}" aria-controls="collabPane-${key}" aria-selected="${tab===key}" tabindex="${tab===key?'0':'-1'}" data-tab="${key}">${label}</button>`).join('')}</div><div class="collab-dialog-body">
      ${warnings.length?`<div class="collab-import-review"><strong>원문과 비교해 확인해 주세요</strong><ul>${warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul>${evidence.length?`<details><summary>자동 분류에 참고한 문구 ${evidence.length}개</summary>${evidence.map(e=>`<p><strong>${esc(e.field)}</strong> · ${esc(e.line)}</p>`).join('')}</details>`:''}</div>`:''}
      <section id="collabPane-basic" role="tabpanel" aria-labelledby="collabTab-basic" ${tab==='basic'?'':'hidden'}><div class="collab-form-grid">${field('title','협업명 *')}${field('company','업체명')}${field('channel','협업 경로 · 플랫폼 · 대행사')}${field('contact','담당자 · 연락처','text',300)}<label>전체 진행 상태<select name="status">${Object.entries(STATUS).map(([k,v])=>`<option value="${k}" ${draft.status===k?'selected':''}>${v}</option>`).join('')}</select></label></div><p class="muted small">완료·취소한 협업은 이력에 남습니다. 결과물별 진행 상황은 ‘결과물’에서 각각 변경할 수 있습니다.</p></section>
      <section id="collabPane-terms" role="tabpanel" aria-labelledby="collabTab-terms" ${tab==='terms'?'':'hidden'}>${area('products','제공받는 제품·서비스',3,3000)}${area('requirements','요청사항 · 가이드',5)}${area('keywords','필수 키워드 · 해시태그',2,2000)}${area('required_links','필수 삽입 링크',2,4000)}</section>
      <section id="collabPane-schedule" role="tabpanel" aria-labelledby="collabTab-schedule" ${tab==='schedule'?'':'hidden'}><div class="collab-form-grid"><label>방문·예약 일시<input type="datetime-local" name="visit_at" value="${esc(kstDateTime(draft.visit_at))}" /></label>${field('draft_due','원고 제출일','date')}${field('publish_due','발행 마감일','date')}${field('payment_due','정산 예정일','date')}</div><div class="collab-reminder-box"><label class="collab-checkbox"><input type="checkbox" name="reminder_enabled" ${draft.reminder_enabled?'checked':''} />내 이메일로 일정 리마인드 받기</label><p>받는 주소: <strong>${esc(user?.email)}</strong></p><div class="collab-form-grid"><label>알림 시점<select name="reminder_days">${[0,1,3,7].map(n=>`<option value="${n}" ${draft.reminder_days===n?'selected':''}>${n===0?'당일':`${n}일 전`}</option>`).join('')}</select></label><label>알림 시간 · 한국시간<select name="reminder_hour">${Array.from({length:24},(_,n)=>`<option value="${n}" ${draft.reminder_hour===n?'selected':''}>${String(n).padStart(2,'0')}:00</option>`).join('')}</select></label></div><p class="muted small">등록한 일정과 결과물 마감일에 한 번씩 안내합니다. 이미 지난 알림 시각은 소급 발송하지 않습니다. 발송은 설정한 시각부터 약 5분 간격으로 처리하며, 계정당 하루 10건까지입니다.</p><p class="${mail?.enabled?'collab-success':'collab-overdue'}">${mail?.enabled?'알림 메일 연결됨':mail===null?'알림 메일 연결 상태를 확인하지 못했습니다.': '운영자의 알림 메일 연결이 필요합니다. 연결 전에는 메일이 발송되지 않습니다.'}</p></div>${reminders.length?`<details><summary>알림 예약·발송 내역</summary><ul class="collab-log">${reminders.map(r=>`<li>${esc(r.event_label)} · ${dateTime(r.due_at)}<span>${({pending:'예약됨',sending:'발송 중',sent:'발송 완료',failed:'발송 실패'})[r.state]}${r.error?` · ${esc(r.error)}`:''}</span></li>`).join('')}</ul></details>`:''}</section>
      <section id="collabPane-outputs" role="tabpanel" aria-labelledby="collabTab-outputs" ${tab==='outputs'?'':'hidden'}><div class="collab-section-heading"><div><h3>결과물별 진행 상황</h3><p class="muted">블로그 글과 릴스를 각각 등록하고 게시 링크를 남겨 주세요.</p></div><button type="button" class="button button-light" data-add-output ${draft.deliverables.length>=20?'disabled':''}>＋ 결과물</button></div><div class="collab-output-list">${draft.deliverables.map((d,i)=>`<div class="collab-output-card" data-output="${i}"><div class="collab-section-heading"><strong>결과물 ${i+1}</strong><button type="button" class="button button-quiet" data-remove-output="${i}">삭제</button></div><div class="collab-form-grid"><label>종류<select data-key="kind">${Object.entries(KINDS).map(([k,v])=>`<option value="${k}" ${d.kind===k?'selected':''}>${v}</option>`).join('')}</select></label><label>결과물 이름<input data-key="name" value="${esc(d.name)}" maxlength="160" /></label><label>진행 상태<select data-key="status">${Object.entries(STATUS).filter(([k])=>!['completed','cancelled'].includes(k)).map(([k,v])=>`<option value="${k}" ${d.status===k?'selected':''}>${v}</option>`).join('')}</select></label><label>발행 마감일<input type="date" data-key="due_on" value="${esc(d.due_on)}" /></label><label class="collab-span">게시 링크<input type="url" data-key="url" value="${esc(d.url)}" maxlength="2000" placeholder="https://" /></label></div>${safeUrl(d.url)?`<a href="${esc(safeUrl(d.url))}" target="_blank" rel="noopener noreferrer">게시물 보기 ↗</a>`:''}</div>`).join('') || '<p class="muted">등록된 결과물이 없습니다. 위 버튼으로 추가해 주세요.</p>'}</div></section>
      <section id="collabPane-money" role="tabpanel" aria-labelledby="collabTab-money" ${tab==='money'?'':'hidden'}><div class="collab-form-grid"><label>약정 현금 원고료 · 원<input name="cash_fee" type="number" min="0" max="99999999999" step="1" value="${draft.cash_fee}" /></label><label>제품·서비스 제공가 · 원<input name="provided_value" type="number" min="0" max="99999999999" step="1" value="${draft.provided_value}" /></label></div><label class="collab-deduction">공제액 · 원천징수 등 · 원<input name="deductions" type="number" min="0" max="99999999999" step="1" value="${draft.deductions || 0}" /></label><p class="muted small">약정 원고료는 합의한 금액, 입금 내역은 실제 받은 금액을 적어 주세요. 원천징수 등 실제 공제된 금액은 공제액에 입력해 주세요. 세액은 자동 계산하지 않습니다.</p><div class="collab-money-summary" id="collabMoneySummary"></div>${ledgerHtml('payments','입금 내역')}${ledgerHtml('expenses','지출 내역')}<p class="muted small">제품·서비스 제공가는 현금 입금·미입금·현금 잔액 계산에 포함되지 않습니다.</p></section>
      <section id="collabPane-notes" role="tabpanel" aria-labelledby="collabTab-notes" ${tab==='notes'?'':'hidden'}>${area('memo','메모',5)}${draft.source_text?`<details><summary>가져온 원문${draft.source_name?` · ${esc(draft.source_name)}`:''}</summary><pre class="collab-source">${esc(draft.source_text)}</pre></details>`:''}<h3>변경 이력</h3><ul class="collab-log">${history.map(h=>`<li>${dateTime(h.happened_at)}<span>${historyLabel(h)}</span></li>`).join('') || '<li>저장 후 변경 이력이 기록됩니다.</li>'}</ul></section>
      <p id="collabDialogMessage" class="collab-dialog-message" role="status"></p></div>${reviewRequired?`<div class="collab-save-review"><strong>날짜와 금액은 저장 전에 꼭 확인해 주세요.</strong><p>자동 분류된 내용이 원문과 다를 수 있습니다.</p><div class="collab-review-actions"><button type="button" data-tab="schedule">일정 확인 ↗</button><button type="button" data-tab="money">금액 확인 ↗</button></div><label class="collab-checkbox"><input id="collabImportConfirmed" type="checkbox" required ${reviewConfirmed?'checked':''} />날짜와 금액을 원문과 비교해 확인했습니다.</label></div>`:''}<div class="collab-dialog-footer">${draft.id?`<button type="button" class="button button-quiet" data-trash>${draft.deleted_at?'휴지통에서 복원':'휴지통으로 이동'}</button>`:'<span></span>'}<div class="collab-actions"><button type="button" class="button button-quiet" data-close>취소</button><button type="submit" class="button">${draft.id?'변경 저장':'협업 저장'}</button></div></div></form>`;
    updateMoney();
  }
  function ledgerHtml(key,label) {
    return `<div class="collab-section-heading"><h3>${label}</h3><button type="button" class="button button-light" data-add-ledger="${key}" ${draft[key].length>=100?'disabled':''}>＋ ${key==='payments'?'입금':'지출'} 기록</button></div><div class="collab-ledger">${draft[key].map((p,i)=>`<div data-ledger="${key}" data-index="${i}" class="collab-ledger-row"><label>금액 · 원<input data-key="amount" type="number" min="0" max="99999999999" step="1" value="${p.amount}" /></label><label>날짜<input data-key="date" type="date" value="${esc(p.date)}" /></label><label>메모<input data-key="memo" value="${esc(p.memo)}" maxlength="500" /></label><button type="button" class="button button-quiet" data-remove-ledger="${key}:${i}" aria-label="${label} ${i+1} 삭제">삭제</button></div>`).join('') || `<p class="muted">등록된 ${label}이 없습니다.</p>`}</div>`;
  }
  function historyLabel(h) {
    if(h.action==='created') return '협업 등록'; if(h.action==='trashed') return '휴지통으로 이동';
    const labels={status:'진행 상태',title:'협업명',company:'업체명',cash_fee:'약정 원고료',provided_value:'제공가',deductions:'공제액',deliverables:'결과물',payments:'입금',expenses:'지출',visit_at:'방문 일정',draft_due:'원고 제출일',publish_due:'발행 마감일',payment_due:'정산 예정일',reminder_enabled:'알림',reminder_days:'알림 시점',reminder_hour:'알림 시간',deleted_at:'휴지통 상태'};
    return Object.keys(h.changes).filter(k=>labels[k]).map(k=>k==='status'?`상태: ${STATUS[h.changes[k]]||''}`:labels[k]).join(' · ') || '내용 수정';
  }
  function readForm() {
    const form=dialog.querySelector('#collabForm'); if(!form||!draft) return;
    for(const name of ['title','company','channel','contact','products','requirements','keywords','required_links','memo','status']) draft[name]=form.elements[name].value.trim();
    for(const name of ['cash_fee','provided_value','deductions','reminder_days','reminder_hour']) draft[name]=Number(form.elements[name].value||0);
    for(const name of ['draft_due','publish_due','payment_due']) draft[name]=form.elements[name].value||null;
    draft.visit_at=form.elements.visit_at.value?`${form.elements.visit_at.value}:00+09:00`:null;
    draft.reminder_enabled=form.elements.reminder_enabled.checked;
    dialog.querySelectorAll('[data-output]').forEach(node=>{ const d=draft.deliverables[Number(node.dataset.output)]; node.querySelectorAll('[data-key]').forEach(input=>d[input.dataset.key]=input.value.trim()); });
    dialog.querySelectorAll('[data-ledger]').forEach(node=>{ const d=draft[node.dataset.ledger][Number(node.dataset.index)]; node.querySelectorAll('[data-key]').forEach(input=>d[input.dataset.key]=input.dataset.key==='amount'?Number(input.value||0):input.value.trim()); });
  }
  function updateMoney() {
    const node=dialog.querySelector('#collabMoneySummary'); if(!node||!draft) return;
    node.innerHTML=`<div><span>실제 입금</span><strong>${won(sumMoney(draft.payments))}</strong></div><div><span>미입금</span><strong>${won(outstanding(draft))}</strong></div><div><span>지출</span><strong>${won(sumMoney(draft.expenses))}</strong></div><div><span>입금 − 지출</span><strong>${won(sumMoney(draft.payments)-sumMoney(draft.expenses))}</strong></div>`;
  }
  function dialogMessage(message,error=false) { const n=dialog.querySelector('#collabDialogMessage'); if(n){n.textContent=message;n.classList.toggle('error',error);} }
  function setBusy(value) { busy=value; dialog.querySelectorAll('button,input,textarea,select').forEach(n=>n.disabled=value); }
  async function save({trash=false}={}) {
    if(busy||!draft||!user) return;
    readForm();
    if(!trash&&reviewRequired&&!reviewConfirmed) {
      dialogMessage('저장 전에 날짜와 금액을 원문과 비교한 뒤 확인란에 체크해 주세요.',true);
      dialog.querySelector('#collabImportConfirmed')?.focus(); return;
    }
    const invalid=dialog.querySelector(':invalid');
    if(!trash&&invalid) { const pane=invalid.closest('[role="tabpanel"]'); if(pane) switchTab(pane.id.replace('collabPane-','')); invalid.reportValidity(); return; }
    if(draft.deliverables.some(d=>!d.name)){ switchTab('outputs'); dialogMessage('결과물 이름을 입력해 주세요.',true); return; }
    if([...draft.payments,...draft.expenses].some(p=>!p.date)){switchTab('money');dialogMessage('입금·지출 날짜를 입력해 주세요.',true);return;}
    const version=generation, id=draft.id, revision=draft.revision;
    const payload={}; for(const key of Object.keys(blankCollaboration())) payload[key]=draft[key];
    if(trash) payload.deleted_at=draft.deleted_at?null:new Date().toISOString();
    setBusy(true); dialogMessage('저장하고 있습니다…');
    try {
      const result=id?await client.from('keyon_collaborations').update(payload).eq('id',id).eq('revision',revision).select().maybeSingle():await client.from('keyon_collaborations').insert({...payload,user_id:user.id}).select().single();
      if(version!==generation) return;
      if(result.error) throw result.error;
      if(!result.data) throw new Error('다른 화면에서 이 기록이 변경되었습니다. 작성 내용을 복사해 둔 뒤 목록을 새로고침해 주세요.');
      rows=[result.data,...rows.filter(r=>r.id!==result.data.id)]; busy=false;dirty=false;closeDialog(true); report(trash?'협업 기록을 이동했습니다.':'협업을 저장했습니다.');
    } catch(error) { if(version===generation) dialogMessage(error.message||'저장하지 못했습니다. 다시 시도해 주세요.',true); }
    finally { if(version===generation) setBusy(false); }
  }
  function switchTab(key) {
    tab=key; dialog.querySelectorAll('[role="tabpanel"]').forEach(n=>n.hidden=n.id!==`collabPane-${key}`);
    dialog.querySelectorAll('[role="tab"]').forEach(n=>{n.setAttribute('aria-selected',String(n.dataset.tab===key));n.tabIndex=n.dataset.tab===key?0:-1;});
    dialog.querySelector('.collab-dialog-body')?.scrollTo({top:0});
  }
  function renderAdmin() {
    admin.hidden=!user||!mail?.can_manage; if(admin.hidden){admin.replaceChildren();return;}
    admin.innerHTML=`<p class="eyebrow">COLLABORATION EMAIL</p><h2>협업 리마인드 메일 연결</h2><p class="muted">협업 알림을 회원 본인의 인증 이메일로 보냅니다. 비밀번호 재설정 메일과 별도로 연결하며, 현재 발신 주소와 같은 Gmail을 사용할 수 있습니다.</p><span class="status-pill">${mail.enabled?'연결됨 · 예약 알림 사용 가능':'알림 메일 연결 대기'}</span><form id="collabMailForm" autocomplete="off"><div class="collab-form-grid"><label>Gmail 발신 주소<input type="email" name="sender" value="${esc(mail.sender||'keyon.auth@gmail.com')}" required /></label><label>Google 앱 비밀번호<input type="password" name="password" autocomplete="new-password" required minlength="16" maxlength="24" placeholder="16자리 앱 비밀번호" /></label></div><div class="collab-actions"><button type="submit" class="button">연결 확인 · 저장</button>${mail.enabled?'<button type="button" class="button button-light" data-mail-test>내 이메일로 테스트 발송</button><button type="button" class="button button-quiet" data-mail-pause>알림 메일 일시 중지</button>':''}</div></form><p class="muted small">앱 비밀번호는 암호화 저장하며 다시 표시하지 않습니다. 설정은 API 관리 권한이 있는 관리자만 변경할 수 있습니다. Gmail 발송 한도를 고려해 협업 알림은 전체 하루 200건 이내로 처리합니다.</p><p id="collabMailMessage" role="status">${esc(mail.last_error||'')}</p>`;
  }
  async function mailAction(action, credentials) {
    if(adminBusy) return; adminBusy=true;const version=generation;
    admin.querySelectorAll('button').forEach(b=>b.disabled=true);
    const msg=admin.querySelector('#collabMailMessage');msg.textContent=action==='save'?'메일 서버 연결을 확인하고 있습니다…':'처리 중입니다…';
    try {
      const {data,error}=await client.functions.invoke('keyon-collaboration-mail',{body:{action,...credentials}});
      if(version!==generation) return;
      if(error||!data?.ok) throw new Error(data?.message||'메일 연결을 확인하지 못했습니다. 발신 주소와 Google 앱 비밀번호를 확인해 주세요.');
      await loadMail(version); if(version!==generation)return;
      admin.querySelector('#collabMailMessage').textContent=action==='test'?'내 이메일로 테스트 메일을 보냈습니다. 받은편지함을 확인해 주세요.':action==='save'?'연결 확인 후 저장했습니다. 예약한 협업 알림에 사용됩니다.':'협업 알림 메일을 중지했습니다.';
    } catch(error) { if(version===generation){ const n=admin.querySelector('#collabMailMessage');n.textContent=error.message;n.classList.add('error');} }
    finally{adminBusy=false;admin.querySelectorAll('button').forEach(b=>b.disabled=false);}
  }

  root.addEventListener('click', e=>{
    const button=e.target.closest('button');if(!button)return;
    if(button.dataset.action==='new') void openEditor();
    if(button.dataset.action==='import') openImport();
    if(button.dataset.action==='refresh') void load();
    if(button.dataset.view){view=button.dataset.view;statusFilter='';page=1;render();}
    if(button.dataset.open){const row=rows.find(r=>r.id===button.dataset.open);if(row)void loadEditor(row.id);}
    if(button.dataset.page){page=Number(button.dataset.page);renderResults();}
    if(button.dataset.month){
      calendarMonth=moveMonth(calendarMonth,Number(button.dataset.month));
      calendarDay=calendarMonth===today().slice(0,7)?today():`${calendarMonth}-01`;
      renderCalendar(`[data-month="${button.dataset.month}"]`);
    }
    if(button.hasAttribute('data-calendar-today')){calendarDay=today();calendarMonth=calendarDay.slice(0,7);renderCalendar('[data-calendar-today]');}
    if(button.dataset.calendarDay){calendarDay=button.dataset.calendarDay;calendarMonth=calendarDay.slice(0,7);renderCalendar(`[data-calendar-day="${calendarDay}"]`);}

  });
  root.addEventListener('input',e=>{if(e.target.id==='collabSearch'){query=e.target.value;page=1;renderResults();}});
  root.addEventListener('change',e=>{if(e.target.id==='collabStatusFilter'){statusFilter=e.target.value;page=1;renderResults();}});
  dialog.addEventListener('cancel',e=>{e.preventDefault();closeDialog();});
  function resetImportReview() {
    reviewConfirmed=false;
    const checkbox=dialog.querySelector('#collabImportConfirmed'); if(checkbox) checkbox.checked=false;
  }
  dialog.addEventListener('input',e=>{
    dirty=true;
    if(modalMode!=='editor')return;
    if(e.target.id==='collabImportConfirmed') {reviewConfirmed=e.target.checked;dialogMessage('');}
    else if(['date','datetime-local','number'].includes(e.target.type)) resetImportReview();
    readForm();updateMoney();
  });
  dialog.addEventListener('change',async e=>{
    if(e.target.id!=='collabImportFile'||!e.target.files[0])return;
    const file=e.target.files[0],version=generation;setBusy(true);dialogMessage('파일에서 텍스트를 읽고 있습니다…');
    try{const text=await readGuideFile(file);if(version!==generation||modalMode!=='import')return;dialog.querySelector('#collabImportText').value=text;importSourceName=file.name;dirty=true;dialogMessage(`${file.name} · 내용을 읽었습니다. 아래에서 자동 분류를 눌러 주세요.`);}
    catch(error){if(version===generation)dialogMessage(error.message,true);}
    finally{if(version===generation)setBusy(false);}
  });
  dialog.addEventListener('submit',e=>{e.preventDefault();void save();});
  dialog.addEventListener('invalid',e=>{if(e.target.id==='collabImportConfirmed')dialogMessage('저장 전에 날짜와 금액을 원문과 비교한 뒤 확인란에 체크해 주세요.',true);const pane=e.target.closest('[role="tabpanel"]');if(pane)switchTab(pane.id.replace('collabPane-',''));},true);
  dialog.addEventListener('keydown',e=>{const n=e.target.closest('[role="tab"]');if(!n||!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const all=[...dialog.querySelectorAll('[role="tab"]')],i=all.indexOf(n),next=e.key==='Home'?0:e.key==='End'?all.length-1:(i+(e.key==='ArrowRight'?1:-1)+all.length)%all.length;switchTab(all[next].dataset.tab);all[next].focus();});
  dialog.addEventListener('click',e=>{
    const b=e.target.closest('button');if(!b||busy)return;
    if(b.hasAttribute('data-close')){closeDialog();return;}
    if(b.hasAttribute('data-extract')){try{const result=extractCollaboration(dialog.querySelector('#collabImportText').value);result.draft.source_name=importSourceName;void openEditor(null,result);}catch(error){dialogMessage(error.message,true);}return;}
    if(b.dataset.tab){readForm();switchTab(b.dataset.tab);return;}
    if(!draft)return; readForm();
    if(b.hasAttribute('data-add-output')||b.hasAttribute('data-remove-output')||b.dataset.addLedger||b.dataset.removeLedger)resetImportReview();
    if(b.hasAttribute('data-add-output')){draft.deliverables.push({id:crypto.randomUUID(),kind:'blog',name:'블로그 글',status:'preparing',due_on:draft.publish_due||'',url:''});dirty=true;renderEditor();}
    if(b.hasAttribute('data-remove-output')){draft.deliverables.splice(Number(b.dataset.removeOutput),1);dirty=true;renderEditor();}
    if(b.dataset.addLedger){draft[b.dataset.addLedger].push({id:crypto.randomUUID(),amount:0,date:today(),memo:''});dirty=true;renderEditor();}
    if(b.dataset.removeLedger){const [key,i]=b.dataset.removeLedger.split(':');draft[key].splice(Number(i),1);dirty=true;renderEditor();}
    if(b.hasAttribute('data-trash')){if(window.confirm(draft.deleted_at?'이 협업을 복원할까요?':'이 협업을 휴지통으로 옮길까요? 예약 알림도 중지되며 나중에 복원할 수 있습니다.'))void save({trash:true});}
  });
  admin.addEventListener('submit',e=>{e.preventDefault();const f=e.target;void mailAction('save',{sender:f.elements.sender.value.trim(),password:f.elements.password.value.replace(/\s/g,'')});});
  admin.addEventListener('click',e=>{if(e.target.closest('[data-mail-test]'))void mailAction('test');if(e.target.closest('[data-mail-pause]'))void mailAction('pause');});
  return {
    setUser(next){if(user?.id===next?.id)return;generation++;user=next;loaded=false;loading=false;rows=[];mail=null;busy=false;dirty=false;dialog.close();dialog.replaceChildren();draft=null;modalMode='';reviewRequired=false;reviewConfirmed=false;calendarDay=today();calendarMonth=calendarDay.slice(0,7);view='active';query='';statusFilter='';notice='';admin.replaceChildren();admin.hidden=true;render();if(user)void loadMail();},
    show(pageName){if(pageName==='collaborationView'&&user){if(!loaded&&!loading)void load();else render();}if(pageName==='catalogAdmin'&&user)void loadMail();},
  };
}
