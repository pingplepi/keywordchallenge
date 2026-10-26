import { createKeywordOpportunities } from './keyword-opportunities.js';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const count = value => Number(value || 0).toLocaleString('ko-KR');
const date = value => value ? new Date(value).toLocaleDateString('ko-KR', {timeZone:'Asia/Seoul',month:'numeric',day:'numeric'}) : '—';
const volume = row => row.volume_min == null ? '미확인' : row.volume_min === row.volume_max ? count(row.volume_min) : `${count(row.volume_min)}–${count(row.volume_max)}`;
const empty = text => `<div class="work-empty">${esc(text)}</div>`;

function writingTopic(row) {
  const keyword=String(row.keyword||'').trim(),field=String(row.field||'');
  const profiles=[
    {match:/예약방법|예약하는법|숲나들|국립공원공단|홈페이지/,audience:'공식 경로에서 예약 절차와 조건을 확인하려는 사람',focus:'예약 경로·절차·취소 조건',sections:[['공식 예약 경로','공식 홈페이지와 예약하려는 시설·서비스를 구분해 안내해 보세요.'],['예약 전 준비','이용 날짜, 인원, 계정 등 실제로 필요한 정보를 확인해 보세요.'],['예약 진행 순서','조회·선택·결제·확인 단계에서 헷갈리는 부분을 순서대로 설명해 보세요.'],['변경과 취소','변경 가능 여부, 취소 조건과 환불 안내의 확인 날짜를 넣어보세요.'],['예약 후 확인','예약 내역에서 확인할 내용과 이용 당일 준비물을 모아보세요.']],questions:['어느 공식 경로에서 예약하나요?','예약하기 전에 어떤 정보를 준비하나요?','예약 변경·취소 조건은 어디에서 확인하나요?'],materials:['공식 예약 안내와 확인 날짜','개인정보를 가린 직접 확인 화면','이용 조건·취소 규정의 출처']},
    {match:/마사지|스파|온천/,audience:'예약 전에 비용과 이용 조건을 확인하려는 방문자',focus:'가격·예약·이용 조건',sections:[['위치와 이동','출발 위치, 이동 수단, 픽업 가능 범위를 확인해 적어보세요.'],['가격과 포함 항목','코스별 가격, 시간, 추가 비용을 같은 기준으로 정리해 보세요.'],['예약과 취소','예약 경로, 변경·취소 조건과 확인 날짜를 넣어주세요.'],['이용 과정과 준비','방문부터 마무리까지의 순서, 준비물과 이용 제한을 확인해 보세요.'],['상황별 선택 포인트','혼자·가족·부모님 동반 등 독자의 상황별로 확인할 점을 정리해 보세요.']],questions:['추가로 내야 하는 비용이 있나요?','예약 전에 어떤 조건을 확인해야 하나요?','누구와 방문할 때 어떤 점을 살펴봐야 하나요?'],materials:['공식 가격표 또는 실제 결제 내역','예약·취소 안내와 확인 날짜','직접 촬영한 위치·공간 사진']},
    {match:/호텔|리조트|숙소|펜션|민박|캠핑|글램핑/,audience:'자신의 일정과 동행자에게 맞는 숙소를 찾는 사람',focus:'위치·객실·총비용',sections:[['위치와 주변 동선','주요 목적지까지의 이동 방법과 시간을 확인해 보세요.'],['객실과 이용 인원','객실 유형, 침구, 인원 기준과 실제 확인한 시설을 구분해 적어보세요.'],['숙박 총비용','예약 시점·숙박 날짜, 조식·인원 추가 요금을 함께 정리해 보세요.'],['예약 전 확인 사항','체크인·체크아웃, 취소 규정과 편의시설 운영 조건을 확인해 보세요.'],['어떤 여행에 맞을까','아이 동반, 휴식, 이동 편의 등 선택 기준별 장단점을 정리해 보세요.']],questions:['표시된 숙박비 외에 추가 비용이 있나요?','동행 인원에게 맞는 객실인가요?','일정에 필요한 교통·편의시설이 있나요?'],materials:['숙박 날짜와 객실명이 표시된 예약 자료','직접 촬영한 객실·시설 사진','공식 이용 규정과 확인 날짜']},
    {match:/비행기|항공|공항|기차|KTX|버스|교통|렌트|주차|택시|페리|배편/i,audience:'이동 수단과 경로를 정하려는 여행자',focus:'노선·요금·이동 순서',sections:[['출발과 도착','구간, 탑승 위치와 목적지 접근 방법을 적어보세요.'],['이동 수단 비교','소요 시간, 환승, 짐과 동행자를 고려해 비교해 보세요.'],['요금과 예매','확인한 날짜와 조건을 붙여 요금·예매 방법을 정리해 보세요.'],['실제 이동 순서','발권·탑승·환승·도착 순서대로 헷갈릴 지점을 설명해 보세요.'],['변경 상황과 주의점','취소 조건, 막차·운행 변경 확인 경로를 안내해 보세요.']],questions:['어디에서 타고 어디에서 내려야 하나요?','총비용과 예상 이동 시간은 어떻게 확인하나요?','짐이나 동행자에 따라 선택이 달라지나요?'],materials:['공식 노선·시간표와 확인 날짜','요금·수하물·취소 규정','직접 확인한 탑승 위치 사진']},
    {match:/카페|맛집|식당|브런치|뷔페|빵집|베이커리|디저트|성심당/,audience:'메뉴와 방문 조건을 보고 장소를 고르려는 사람',focus:'메뉴·가격·방문 팁',sections:[['위치와 방문 조건','방문 날짜, 위치, 확인한 운영시간·주차 정보를 넣어보세요.'],['메뉴와 가격','직접 주문한 메뉴와 공식 메뉴판 정보를 구분해 적어보세요.'],['맛과 양 또는 선택 기준','경험한 경우 맛·양·특징을 구체적인 표현으로 기록해 보세요.'],['공간과 이용 편의','좌석, 동행자, 대기·예약 관련 정보를 확인해 보세요.'],['방문 전 체크리스트','독자가 출발 전에 다시 확인할 정보를 짧게 모아보세요.']],questions:['어떤 메뉴를 어떤 기준으로 고르면 좋을까요?','가격과 양을 판단할 자료가 있나요?','주차·예약·대기는 어떻게 확인하나요?'],materials:['직접 촬영한 메뉴·공간 사진','방문 날짜와 주문·결제 기록','공식 운영 안내와 확인 날짜']},
    {match:/레시피|만들기|만드는법|요리|반찬|베이킹|볶음|찌개|조림|무침|국수|볶음밥/,audience:'재료를 준비해 직접 따라 해보려는 사람',focus:'재료·과정·실패 줄이는 팁',sections:[['완성 목표와 분량','몇 인분인지, 완성 맛과 식감이 어떤지 정리해 보세요.'],['재료와 도구','직접 사용한 양, 계량 기준과 필요한 도구를 적어보세요.'],['만드는 순서','불 조절, 시간, 상태 변화를 단계별로 나누어 보세요.'],['헷갈리는 지점','직접 겪은 문제와 바꿔본 방법을 구분해 적어보세요.'],['마무리와 활용','먹는 방법과 보관 정보는 확인한 근거를 바탕으로 적어보세요.']],questions:['재료의 양과 계량 기준은 무엇인가요?','단계가 잘 진행되는지 무엇으로 알 수 있나요?','처음 만들 때 헷갈리는 지점은 어디인가요?'],materials:['직접 사용한 재료와 계량 기록','과정별 사진','완성 사진과 실제 조리 시간']},
    {match:/날씨|기온|우기|건기/,audience:'여행 시기와 준비물을 결정하려는 사람',focus:'방문 시기·날씨 확인·준비물',sections:[['대상 시기와 지역','몇 월, 어느 지역을 다루는지 먼저 정해주세요.'],['확인한 날씨 자료','예보와 과거 관측 자료를 구분하고 출처·확인 날짜를 적어보세요.'],['일정에 미치는 영향','야외 활동과 이동에서 준비할 사항을 정리해 보세요.'],['옷차림과 준비물','경험 또는 확인 자료에 맞춰 준비 이유를 설명해 보세요.'],['출발 전 재확인','변동되는 예보와 현지 공지를 확인할 경로를 남겨보세요.']],questions:['어느 시기의 정보를 기준으로 하나요?','야외 일정에 어떤 준비가 필요한가요?','출발 직전 어디에서 다시 확인하나요?'],materials:['공식 예보·관측 자료의 출처와 날짜','해당 시기에 직접 찍은 사진이 있다면 참고','실제로 준비한 물품 목록']},
    {match:/전시|공연|축제|박물관|미술관|뮤지컬/,audience:'방문 또는 관람 일정을 준비하는 사람',focus:'일정·예매·관람 동선',sections:[['행사와 대상','행사명, 장소, 대상과 확인 날짜를 먼저 적어보세요.'],['일정과 예매','공식 일정, 가격과 예매·취소 조건을 확인해 보세요.'],['관람 순서','동선과 필요한 시간을 실제 경험과 안내 자료로 나누어 적어보세요.'],['인상적인 내용','직접 관람한 경우 기억에 남는 지점을 자신의 표현으로 적어보세요.'],['방문 전 준비','교통, 촬영 규정, 동행자별 준비할 점을 모아보세요.']],questions:['언제 어디에서 관람할 수 있나요?','예매 전 확인해야 할 조건은 무엇인가요?','방문 순서와 준비물은 어떻게 정하면 좋을까요?'],materials:['공식 일정·가격 안내','직접 확인한 예매 기록','촬영이 허용된 사진과 관람 메모']},
    {fields:/뷰티|패션|IT테크|자동차|리빙/,audience:'자신의 사용 목적에 맞는 제품이나 방법을 고르려는 사람',focus:'선택 기준·사용 조건·장단점',sections:[['사용 목적과 상황','누가 어떤 상황에서 찾는 주제인지 먼저 정해보세요.'],['핵심 선택 기준','규격·소재·기능 등 실제 비교할 기준을 골라보세요.'],['가격과 구성','확인 시점, 옵션과 구성품을 같은 기준으로 적어보세요.'],['직접 확인한 경험','사용 기간·조건, 장점과 아쉬운 점을 사실대로 구분해 보세요.'],['추천 대상과 확인 사항','어떤 사람에게 맞을지와 구매·이용 전 확인할 점을 정리해 보세요.']],questions:['어떤 사용 목적에 맞는 선택인가요?','같은 조건으로 비교할 기준은 무엇인가요?','직접 확인한 점과 확인이 필요한 점은 무엇인가요?'],materials:['정확한 제품명·옵션과 공식 정보','사용 조건과 직접 촬영한 사진','확인 날짜가 있는 가격·보증 안내']},
    {fields:/여행/,audience:'방문할 장소와 여행 동선을 정하려는 사람',focus:'위치·동선·방문 준비',sections:[['장소와 방문 시기','어디인지, 언제 방문했거나 알아본 정보인지 적어보세요.'],['가는 방법과 비용','교통, 입장·이용 비용과 확인 날짜를 정리해 보세요.'],['둘러볼 순서','직접 경험한 동선과 안내 자료를 구분해 순서를 잡아보세요.'],['사진으로 보여줄 포인트','직접 촬영한 장소·시설·풍경과 설명을 연결해 보세요.'],['방문 전 확인할 것','동행자, 운영시간, 준비물 등 출발 전 확인할 점을 모아보세요.']],questions:['어떤 일정이나 동행자에게 어울릴까요?','이동과 이용에 필요한 정보는 무엇인가요?','출발 전에 다시 확인해야 할 것은 무엇인가요?'],materials:['공식 위치·운영 안내와 확인 날짜','직접 촬영한 사진 또는 직접 만든 동선','실제 방문 기록이 있다면 시간·비용 메모']}
  ];
  const generic={audience:'이 주제를 처음 알아보고 다음 행동을 정하려는 사람',focus:'핵심 정보·확인 기준·실천 순서',sections:[['독자의 질문 정하기','이 글에서 답할 질문 한 가지와 대상 독자를 정해보세요.'],['기본 정보 확인','의미·조건·범위를 신뢰할 수 있는 자료로 확인해 보세요.'],['핵심 내용 구성','독자가 궁금해할 순서대로 내용을 세 부분으로 나누어 보세요.'],['근거와 실제 사례','직접 확인한 사례와 자료의 출처·날짜를 함께 정리해 보세요.'],['다음 행동 정리','독자가 글을 읽고 확인하거나 실행할 일을 마무리에 넣어보세요.']],questions:['이 글을 찾는 사람의 가장 큰 궁금증은 무엇인가요?','내가 직접 확인한 정보는 무엇인가요?','읽은 뒤 어떤 판단이나 행동에 도움이 되나요?'],materials:['직접 확인한 경험이나 사례 메모','참고 자료의 출처와 확인 날짜','설명에 도움이 되는 직접 만든 사진·표']};
  const p=profiles.find(p=>p.match?.test(keyword))||profiles.find(p=>p.fields?.test(field))||generic;
  return {keyword,field,...p};
}

function writingChoices(topic) {
  const travel=/여행/.test(topic.field)||(!topic.field||topic.field==='기타')&&/호텔|숙소|비행기|항공|공항|기차|KTX|해외여행/.test(topic.keyword);
  const cooking=/레시피|만들기|만드는법|요리|반찬|베이킹/.test(topic.keyword);
  const product=/뷰티|패션|IT테크|자동차|리빙/.test(topic.field);
  const readers=travel?[['first','처음 방문하는 사람','처음 준비할 때 놓치기 쉬운 조건'],['solo','혼자 여행하는 사람','혼자 이동·이용할 때의 편의와 제약'],['parents','부모님과 동행하는 사람','이동 부담·휴식·부모님의 선호'],['children','아이와 동행하는 사람','연령 조건·휴식·아이와 함께할 동선']]:cooking?[['first','처음 만들어보는 사람','처음 만들 때 헷갈리는 과정'],['family','가족과 함께 먹을 사람','먹는 사람의 취향·분량·식재료 조건'],['repeat','만들어본 경험이 있는 사람','기존 방법에서 바꾸어볼 부분'],['busy','짧은 시간에 준비할 사람','실제 준비 시간과 줄일 수 있는 과정']]:product?[['first','처음 구매·사용하는 사람','처음 선택할 때 확인할 기능과 조건'],['repeat','이미 사용해 본 사람','기존에 쓰던 것과 달라지는 점'],['gift','선물을 고르는 사람','받는 사람의 취향·사용 환경·교환 조건'],['similar','사용 환경이 비슷한 사람','사용 장소·기간·목적에 따른 차이']]:[['first','처음 알아보는 사람','처음 접할 때 헷갈리는 개념과 조건'],['compare','선택을 고민하는 사람','비교할 기준과 선택에 따른 차이'],['repeat','다시 시도하는 사람','이전 경험에서 바꾸고 싶은 부분'],['busy','시간이 부족한 사람','먼저 확인할 핵심과 필요한 시간']];
  const angles=[['cost','비용·시간과 선택 기준','확인한 비용·시간의 기준 날짜와 포함·제외 항목'],['process',travel?'예약·이용 과정':'준비·실행 과정','공식 절차와 직접 해본 과정을 구분한 자료'],['difference','예상과 달랐던 점','예상과 실제를 비교할 구체적인 조건·기록'],['choice','다시 선택한다면','선택의 장단점과 다시 확인해야 할 조건']];
  return {readers,angles};
}

function buildWritingGuide(topic,readerId,angleId,notes=[]) {
  const {readers,angles}=writingChoices(topic),reader=readers.find(x=>x[0]===readerId),angle=angles.find(x=>x[0]===angleId);
  if(!reader||!angle)return null;
  const keyword=topic.keyword;
  const prompts={cost:[keyword+'에 실제로 들었거나 확인한 비용·시간은 얼마였나요? 날짜와 조건도 적어보세요.','예상하지 못한 추가 비용이나 준비 시간이 있었나요? 없었다면 무엇을 확인했나요?','이 독자에게 비용·시간을 쓰더라도 챙기라고 권하고 싶은 것은 무엇인가요?'],process:[keyword+'을 준비하거나 이용할 때 가장 헷갈렸던 단계는 무엇인가요?','직접 해보고 알게 된 순서·준비물·주의점은 무엇인가요?','이 독자라면 어느 단계를 먼저 설명해 주고 싶나요?'],difference:[keyword+'을 알아보기 전에는 무엇을 예상했나요?','직접 확인한 결과는 어떻게 달랐나요? 그렇게 느낀 상황을 적어보세요.','이 독자에게는 그 차이가 어떤 의미가 있을까요?'],choice:[keyword+'을 고를 때 중요하게 본 기준과 다른 선택지는 무엇이었나요?','내 선택에서 좋았던 점과 아쉬웠던 점은 무엇인가요?','같은 독자의 상황에서 다시 선택한다면 유지하거나 바꿀 것은 무엇인가요?']};
  const questions=prompts[angleId];
  const answers=questions.map((_,i)=>String(notes[i]||'').trim().slice(0,600));
  const lead=answers.find(Boolean)||'';
  const headings={cost:['내 조건에서 확인한 비용·시간','추가로 들었던 것과 포함 항목','독자에게 권할 우선순위'],process:['가장 헷갈렸던 단계','내가 확인한 진행 순서','독자가 먼저 준비할 것'],difference:['가기 전·해보기 전의 예상','실제로 확인한 차이','이 독자에게 달라지는 판단'],choice:['선택할 때 중요했던 기준','직접 확인한 장점과 아쉬움','다시 선택할 때 바꿀 것']}[angleId];
  const titles=[keyword+' — '+reader[1]+'을 위한 '+angle[1],keyword+'에서 [내가 직접 확인한 핵심]을 이야기한다면'];
  if(lead)titles.unshift(keyword+' — '+(lead.length>55?lead.slice(0,55)+'…':lead));
  return {keyword,reader:reader[1],readerNeed:reader[2],angle:angle[1],questions,answers,lead,titles,sections:headings.map((heading,i)=>({heading,note:answers[i]||questions[i]})),checklist:[...topic.materials,reader[2]+'에 필요한 정보',angle[2]]};
}

export function createBloggerDashboard(client, {notify, onSearch}) {
  const root = $('bloggerView');
  let user = null, settings = null, contextKey = '', generation = 0;
  let data = null, visible = false, loading = false, loadedAt = 0, reloadAfter = false;
  const saving = new Set();
  let guideKeyword='';const guideDrafts=new Map();

  root.innerHTML = `<div class="work-heading"><div><p class="eyebrow">YOUR NEXT STORY</p><h1>키온 대시보드</h1><p class="muted">오늘 쓸 글감을 고르고, 내 경험과 관점으로 풀어보세요.</p></div><button class="button button-light" data-discovery-action="refresh">추천 새로고침</button></div>
    <div id="discoveryStatus" class="message" role="status"></div><div id="discoveryOverview"></div><section id="bloggerOpportunities" class="panel work-panel"></section><div id="discoveryBody"></div>`;

  const opportunities=createKeywordOpportunities(client,{
    rootId:'bloggerOpportunities',mode:'blogger',onDetail:onSearch,
    onSaved(){loadedAt=0;void load(false);}
  });

  function actions(row) {
    return `<div class="work-card-actions"><button class="button button-light" data-discovery-action="guide" data-keyword="${esc(row.keyword)}">내 관점으로 쓰기</button><button class="button button-quiet" data-discovery-action="save" data-keyword="${esc(row.keyword)}" ${row.saved?'disabled':''}>${row.saved?'보관됨 ✓':'글감 보관'}</button><button class="work-text-button" data-discovery-action="search" data-keyword="${esc(row.keyword)}">키워드 탐색으로</button></div>`;
  }
  function idea(row, index) {
    return `<article class="work-keyword-card discovery-idea"><div class="work-section-title"><span class="count-chip">${row.saved?'보관한 글감':esc(row.field || '관심 키워드')}</span></div><h3>${esc(row.keyword)}</h3><p class="discovery-prompt">독자와 관점을 고르고, 이 주제에서 직접 확인한 이야기를 떠올려 보세요.</p><p class="work-volume">${volume(row)}<small>월 검색량 · ${row.collected_at?`${date(row.collected_at)} 조회`:'최근 조회 기록 없음'}</small></p><small class="muted">${data.post_count?'수집된 글 제목에서 이 키워드를 찾지 못했어요.':'글 수집 전으로, 관심 분야와 보관함에서 추천합니다.'}</small>${actions(row)}</article>`;
  }
  function metric(label, value, detail, target, type='') {
    const attr = target.startsWith('#') ? `href="${target}"` : `type="button" data-discovery-action="jump" data-section="${target}"`;
    const tag = target.startsWith('#') ? 'a' : 'button';
    return `<${tag} ${attr} class="panel metric ${type}"><span>${label}</span><strong>${count(value)}<span class="discovery-unit">개</span></strong><small>${detail}</small></${tag}>`;
  }
  function render() {
    const interest = data.interest || '관심 분야 미설정';
    const baseline = data.post_count ? `수집된 글 ${count(data.post_count)}편의 제목과 비교` : '글 수집 전 · 분야 기반 추천';
    $('discoveryOverview').innerHTML = `
      <div class="discovery-context"><div><span class="profile-chip">${esc(interest)}</span><span class="muted small">${baseline}</span></div><a href="#accountView">관심 분야 변경 ↗</a></div>
      ${!data.interest || data.interest==='기타' ? '<div class="analysis-note">내 설정에서 구체적인 관심 분야를 선택하면 분야별 추천을 받을 수 있습니다. 지금은 보관한 키워드에서 글감을 찾습니다. <a href="#accountView">분야 선택하기 ↗</a></div>' : ''}
      <div class="strategy-stats work-stats discovery-stats">
        ${metric('보관 중인 글감',data.saved_count,'내가 저장한 키워드','#savedKeywordsView')}
        ${metric('새 글감 후보',data.opportunity_count,data.post_count?'추천 후보 중 글 제목에 없는 키워드':'글 수집 전 · 작성 여부 비교 전','discoveryIdeas','metric-purple')}
      </div>
      `;
    $('discoveryBody').innerHTML = `
      <section id="discoveryIdeas" class="panel work-panel"><div class="work-section-title"><div><p class="eyebrow">TODAY’S IDEAS</p><h2>오늘의 추천 글감 <span class="count-chip">${data.ideas.length}개</span></h2></div><span class="count-chip">${esc(data.day.replaceAll('-','/'))} 기준</span></div><p class="muted discovery-description">관심 분야와 보관한 키워드에서 글감을 고르고 ‘내 관점으로 쓰기’를 눌러 보세요.</p><div class="work-keyword-grid">${data.ideas.length?data.ideas.map(idea).join(''):empty('아직 추천할 글감이 없습니다. 관심 분야를 선택하거나 키워드 검색에서 글감을 보관해 주세요.')}</div></section>

      ${writingGuidePanel()}
      <section class="panel work-panel"><div class="work-section-title"><div><p class="eyebrow">KEYWORD OPPORTUNITIES</p><h2>검색량 높은 새 글감 TOP 10</h2></div><a href="#keywordSearchView">다른 키워드 찾기 ↗</a></div><p class="muted discovery-description">${data.post_count?'수집된 글 제목에서 찾지 못한 후보를 월 검색량순으로 보여드립니다.':'아직 글을 수집하지 않아, 관심 분야의 검색량 높은 후보를 보여드립니다.'}</p>
      <ol class="discovery-opportunities">${data.opportunities.length?data.opportunities.map((row,index)=>`<li><span class="priority-number">${index+1}</span><div class="discovery-keyword"><strong>${esc(row.keyword)}</strong><small class="muted">${esc(row.field || '내 보관함')} · ${date(row.collected_at)} 조회</small></div><div class="discovery-volume"><strong>${volume(row)}</strong><small>월 검색량</small></div><button class="button button-light" data-discovery-action="save" data-keyword="${esc(row.keyword)}" ${row.saved?'disabled':''}>${row.saved?'보관됨 ✓':'글감 보관'}</button></li>`).join(''):''}</ol>
      ${!data.opportunities.length?empty('최근 30일 내 검색량이 확인된 추천 후보가 없습니다. 관심 분야를 확인하거나 키워드 검색에서 새로운 글감을 찾아보세요.'):''}
      <p class="catalog-footnote">추천은 공용 목록의 관심 분야 키워드와 내 보관함을 기준으로 합니다. 제목에 없더라도 과거에 작성했을 수 있습니다.</p></section>
      <details class="discovery-method"><summary>추천 기준과 데이터 범위</summary><p>관심 분야의 검색량 높은 키워드 최대 300개와 내 보관함을 후보로 사용합니다. 수집된 글 제목에 키워드가 포함되어 있으면 추천에서 제외합니다. 공백과 영문 대소문자를 정리한 단순 제목 비교이며, 글 본문이나 블로그 전체 이력을 분석한 결과는 아닙니다.</p><p>오늘의 추천은 후보 중 상위 30개에서 한국시간 날짜별로 최대 9개를 고릅니다. 후보가 적으면 확보된 개수만 표시합니다. 보관 키워드를 우선 후보에 넣으며, 검색량은 최근 30일 안에 조회한 네이버 검색광고 PC·모바일 합계입니다. 검색량을 확인하지 않은 보관 글감은 ‘미확인’으로 표시합니다.</p><p>대시보드는 저장된 데이터를 사용합니다. 새로고침해도 검색 노출 점검 횟수는 차감되지 않으며, 실제 점검은 내 블로그 분석의 버튼을 눌렀을 때만 실행됩니다.</p></details>`;
    renderGuide();
  }
  function writingGuidePanel(){
  return `<section id="discoveryWritingGuide" class="panel work-panel writing-guide" tabindex="-1"><div class="work-section-title"><div><p class="eyebrow">TODAY’S WRITING GUIDE</p><h2>오늘의 글쓰기 가이드</h2></div><button class="button button-light" data-discovery-action="guide-copy" disabled>기획 메모 복사</button></div><p class="muted discovery-description">누구에게 어떤 이야기를 전할지 골라보세요. 직접 경험한 내용을 덧붙여 내 관점의 글을 준비합니다.</p>${data.ideas.length?'<div class="writing-guide-controls"><label>글감 선택<select data-writing-keyword>'+data.ideas.map(row=>'<option value="'+esc(row.keyword)+'">'+esc(row.keyword)+'</option>').join('')+'</select></label><label>누구에게 쓸까요?<select data-writing-reader><option value="">독자 선택</option></select></label><label>어떤 관점으로 쓸까요?<select data-writing-angle><option value="">관점 선택</option></select></label></div><div data-writing-output></div><p class="message" role="status" data-writing-status></p><label data-writing-fallback hidden>기획 메모 직접 복사<textarea data-writing-copytext readonly rows="10"></textarea></label>':empty('관심 분야를 설정하거나 키워드 탐색에서 글감을 보관하면 글쓰기 가이드를 시작할 수 있습니다.')}</section>`;
}
  function guideDraft(){
  if(!guideDrafts.has(guideKeyword))guideDrafts.set(guideKeyword,{reader:'',angle:'',variants:new Map()});
  return guideDrafts.get(guideKeyword);
}
  function guideVariant(){
  const draft=guideDraft(),key=draft.reader+'|'+draft.angle;
  if(!draft.variants.has(key))draft.variants.set(key,{notes:['','',''],checked:new Set()});
  return draft.variants.get(key);
}
  function selectedGuide(){
  const row=data?.ideas.find(row=>row.keyword===guideKeyword);if(!row)return null;
  const draft=guideDraft();
  return buildWritingGuide(writingTopic({...row,field:row.field||data.interest}),draft.reader,draft.angle,guideVariant().notes);
}
  function updateGuideReference(){
  const output=root.querySelector('[data-writing-reference]'),guide=selectedGuide();if(!output||!guide)return;
  output.innerHTML=(guide.lead?'<p class="writing-lead"><b>내 메모에서 꺼낸 이야기</b><br>'+esc(guide.lead)+'</p>':'<p class="muted small">경험 메모를 적으면 여기에 함께 표시됩니다. 실제로 확인한 내용으로 표현을 바꿔보세요.</p>')+'<h3>제목을 생각할 때 참고할 표현</h3><ul>'+guide.titles.map(text=>'<li>'+esc(text)+'</li>').join('')+'</ul><h3>이야기를 묶어볼 순서</h3><p class="muted small">필요한 부분만 고르고 순서도 자유롭게 바꿔보세요.</p><ol class="writing-outline">'+guide.sections.map(item=>'<li><strong>'+esc(item.heading)+'</strong><p>'+esc(item.note)+'</p></li>').join('')+'</ol>';
}
  function renderGuide(){
  const output=root.querySelector('[data-writing-output]');if(!output)return;
  if(!data.ideas.some(row=>row.keyword===guideKeyword))guideKeyword=data.ideas[0]?.keyword||'';
  const row=data.ideas.find(row=>row.keyword===guideKeyword);if(!row)return;
  const draft=guideDraft(),choices=writingChoices(writingTopic({...row,field:row.field||data.interest}));
  if(!choices.readers.some(x=>x[0]===draft.reader))draft.reader='';if(!choices.angles.some(x=>x[0]===draft.angle))draft.angle='';
  root.querySelector('[data-writing-keyword]').value=guideKeyword;
  const options=(label,items)=>'<option value="">'+label+'</option>'+items.map(x=>'<option value="'+esc(x[0])+'">'+esc(x[1])+'</option>').join('');
  const reader=root.querySelector('[data-writing-reader]'),angle=root.querySelector('[data-writing-angle]');reader.innerHTML=options('독자 선택',choices.readers);reader.value=draft.reader;angle.innerHTML=options('관점 선택',choices.angles);angle.value=draft.angle;
  const guide=selectedGuide();root.querySelector('[data-discovery-action="guide-copy"]').disabled=!guide;
  root.querySelector('[data-writing-status]').textContent='';root.querySelector('[data-writing-fallback]').hidden=true;
  if(!guide){output.innerHTML=empty('독자와 관점을 선택하면, 내 경험을 떠올릴 질문과 필요한 정보 체크리스트를 보여드립니다.');return;}
  const variant=guideVariant();
  output.innerHTML='<div class="writing-guide-context"><strong>'+esc(guide.keyword)+'</strong><span class="count-chip">'+esc(guide.angle)+'</span><p><b>이 글의 독자</b> · '+esc(guide.reader)+'</p><p>'+esc(guide.readerNeed)+'에 초점을 맞춰 이야기해 보세요.</p></div><div class="writing-guide-block"><h3>내 경험을 꺼내볼 질문</h3><p class="muted small">메모는 선택 사항입니다. 직접 경험하지 않았다면 확인한 자료와 출처를 적고, 경험담으로 표현하지 마세요.</p><div class="writing-prompts">'+guide.questions.map((question,i)=>'<label class="writing-prompt"><span>'+esc(question)+'</span><textarea data-writing-note="'+i+'" maxlength="600" rows="3" placeholder="짧게 적어도 좋아요. 직접 확인한 경험·조건·출처를 남겨보세요.">'+esc(variant.notes[i])+'</textarea></label>').join('')+'</div><p class="muted small writing-memory-note">메모와 체크는 글감·독자·관점별로 유지되며, 새로고침·로그아웃·내 설정 변경 시 초기화됩니다. 보관하려면 기획 메모를 복사해 주세요.</p></div><div class="writing-guide-block"><div class="work-section-title"><h3>필요한 정보 체크리스트</h3><span class="muted small" data-writing-check-count aria-live="polite">'+variant.checked.size+' / '+guide.checklist.length+' 확인</span></div><div class="writing-checklist">'+guide.checklist.map((item,i)=>'<label><input type="checkbox" data-writing-check="'+i+'" '+(variant.checked.has(i)?'checked':'')+'/><span>'+esc(item)+'</span></label>').join('')+'</div></div><details class="writing-reference"><summary>제목과 구성 참고안 펼쳐보기</summary><div data-writing-reference></div></details>';
  updateGuideReference();
}
  function guideText(guide){
  const variant=guideVariant();
  return ['오늘의 글쓰기 가이드 · '+guide.keyword,'독자: '+guide.reader,'관점: '+guide.angle,'독자에게 필요한 것: '+guide.readerNeed,'','내 경험과 확인한 자료',...guide.questions.flatMap((question,i)=>[(i+1)+'. '+question,guide.answers[i]||'(아직 작성한 메모 없음)','']),'필요한 정보 체크리스트',...guide.checklist.map((item,i)=>(variant.checked.has(i)?'[확인] ':'[확인 전] ')+item),'','제목 참고안 · 내 표현으로 바꾸어 사용',...guide.titles.map(x=>'• '+x),'','구성 참고안 · 순서와 내용은 자유롭게 선택',...guide.sections.map((item,i)=>(i+1)+'. '+item.heading+'\n'+item.note)].join('\n');
}
  root.addEventListener('change',event=>{const el=event.target;if(el.matches('[data-writing-keyword]')){guideKeyword=el.value;renderGuide();}else if(el.matches('[data-writing-reader]')){guideDraft().reader=el.value;renderGuide();}else if(el.matches('[data-writing-angle]')){guideDraft().angle=el.value;renderGuide();}else if(el.matches('[data-writing-check]')){const index=Number(el.dataset.writingCheck),guide=selectedGuide();if(!guide||!Number.isInteger(index)||index<0||index>=guide.checklist.length)return;const variant=guideVariant();if(el.checked)variant.checked.add(index);else variant.checked.delete(index);root.querySelector('[data-writing-check-count]').textContent=variant.checked.size+' / '+guide.checklist.length+' 확인';root.querySelector('[data-writing-status]').textContent='';root.querySelector('[data-writing-fallback]').hidden=true;}});
  root.addEventListener('input',event=>{const el=event.target;if(!el.matches('[data-writing-note]'))return;const index=Number(el.dataset.writingNote);if(!Number.isInteger(index)||index<0||index>2||!selectedGuide())return;guideVariant().notes[index]=el.value.slice(0,600);updateGuideReference();root.querySelector('[data-writing-status]').textContent='';root.querySelector('[data-writing-fallback]').hidden=true;});
  async function load(refreshOpportunities=true) {
    if (!user || settings?.mode !== 'blogger') return;
    if (loading) { reloadAfter = true; return; }
    const g = generation;
    if(refreshOpportunities)void opportunities.load();
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
    if(action==='guide'){guideKeyword=button.dataset.keyword;renderGuide();const section=$('discoveryWritingGuide');section.scrollIntoView({behavior:'smooth',block:'start'});section.focus({preventScroll:true});return;}
    if(action==='guide-copy'){
      const guide=selectedGuide();if(!guide)return;const text=guideText(guide),g=generation;
      try{await navigator.clipboard.writeText(text);if(g===generation)root.querySelector('[data-writing-status]').textContent='기획 메모를 복사했습니다. 글쓰기 화면이나 메모에 붙여 넣어 보관하세요.';}
      catch{if(g===generation){const fallback=root.querySelector('[data-writing-fallback]'),input=root.querySelector('[data-writing-copytext]');fallback.hidden=false;input.value=text;input.focus();input.select();root.querySelector('[data-writing-status]').textContent='아래 기획 메모를 선택해 직접 복사해 주세요.';}}return;
    }
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
      opportunities.setContext(user,settings);
      if (key === contextKey) return;
      contextKey = key; generation++; guideKeyword='';guideDrafts.clear();data = null; loadedAt = 0; loading = false; reloadAfter = false; saving.clear();
      $('discoveryOverview').innerHTML = ''; $('discoveryBody').innerHTML = ''; $('discoveryStatus').textContent = '';
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
