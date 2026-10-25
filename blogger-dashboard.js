import { createKeywordOpportunities } from './keyword-opportunities.js';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const count = value => Number(value || 0).toLocaleString('ko-KR');
const date = value => value ? new Date(value).toLocaleDateString('ko-KR', {timeZone:'Asia/Seoul',month:'numeric',day:'numeric'}) : '—';
const volume = row => row.volume_min == null ? '미확인' : row.volume_min === row.volume_max ? count(row.volume_min) : `${count(row.volume_min)}–${count(row.volume_max)}`;
const empty = text => `<div class="work-empty">${esc(text)}</div>`;

function makeWritingGuide(row,style='questions') {
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
  const modes={questions:{label:'궁금증 해결',direction:'처음 알아보는 독자가 질문하는 순서대로 핵심 정보를 풀어보세요.',titles:[keyword+' 처음 알아볼 때｜'+p.focus,keyword+' 가이드｜미리 확인할 5가지',keyword+' 궁금한 점 정리와 준비 체크리스트']},experience:{label:'경험 정리',direction:'직접 경험한 경우 선택 이유, 실제 과정과 아쉬운 점을 구체적인 기록으로 채워보세요.',titles:[keyword+' 경험 정리｜선택한 이유와 실제 과정',keyword+' 직접 경험하며 알게 된 점과 아쉬운 점',keyword+' 기록｜다시 준비한다면 확인할 것']},compare:{label:'비교와 선택',direction:'실제로 확인한 선택지에 같은 기준을 적용하고, 독자의 상황에 따라 선택이 달라지는 이유를 설명해 보세요.',titles:[keyword+' 선택 가이드｜'+p.focus,keyword+' 비교 전 확인할 기준 5가지',keyword+' 나에게 맞게 고르는 방법']}};
  const mode=modes[style]||modes.questions;
  let sections=p.sections.map(x=>[...x]);
  if(style==='experience'){sections[0]=['선택한 이유와 경험 조건','이 주제를 고른 이유, 경험한 날짜와 상황을 먼저 적어보세요.'];sections[4]=['다시 한다면 바꿀 점','실제로 좋았던 점과 아쉬운 점을 근거와 함께 적고, 다음 사람에게 도움이 될 확인 사항을 정리해 보세요.'];}
  if(style==='compare'){sections[0]=['비교 대상과 조건 정하기','실제로 확인한 선택지와 날짜·옵션 등 비교 조건을 먼저 밝혀보세요.'];sections[4]=['상황별 선택 정리','예산·시간·목적 등 독자의 조건에 따라 어떤 기준을 우선할지 설명해 보세요.'];}
  return {keyword,style:mode.label,audience:p.audience,direction:mode.direction,titles:mode.titles,sections,questions:p.questions,materials:p.materials};
}

export function createBloggerDashboard(client, {notify, onSearch}) {
  const root = $('bloggerView');
  let user = null, settings = null, contextKey = '', generation = 0;
  let data = null, visible = false, loading = false, loadedAt = 0, reloadAfter = false;
  const saving = new Set();
  let guideKeyword='',guideStyle='questions';

  root.innerHTML = `<div class="work-heading"><div><p class="eyebrow">YOUR NEXT STORY</p><h1>키온 대시보드</h1><p class="muted">오늘 쓸 글감을 고르고, 제목부터 소제목까지 구성해 보세요.</p></div><button class="button button-light" data-discovery-action="refresh">추천 새로고침</button></div>
    <div id="discoveryStatus" class="message" role="status"></div><div id="discoveryOverview"></div><section id="bloggerOpportunities" class="panel work-panel"></section><div id="discoveryBody"></div>`;

  const opportunities=createKeywordOpportunities(client,{
    rootId:'bloggerOpportunities',mode:'blogger',onDetail:onSearch,
    onSaved(){loadedAt=0;void load(false);}
  });

  function actions(row) {
    return `<div class="work-card-actions"><button class="button button-light" data-discovery-action="guide" data-keyword="${esc(row.keyword)}">글 구성하기</button><button class="button button-quiet" data-discovery-action="save" data-keyword="${esc(row.keyword)}" ${row.saved?'disabled':''}>${row.saved?'보관됨 ✓':'글감 보관'}</button><button class="work-text-button" data-discovery-action="search" data-keyword="${esc(row.keyword)}">키워드 탐색으로</button></div>`;
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
    $('discoveryOverview').innerHTML = `
      <div class="discovery-context"><div><span class="profile-chip">${esc(interest)}</span><span class="muted small">${baseline}</span></div><a href="#accountView">관심 분야 변경 ↗</a></div>
      ${!data.interest || data.interest==='기타' ? '<div class="analysis-note">내 설정에서 구체적인 관심 분야를 선택하면 분야별 추천을 받을 수 있습니다. 지금은 보관한 키워드에서 글감을 찾습니다. <a href="#accountView">분야 선택하기 ↗</a></div>' : ''}
      <div class="strategy-stats work-stats discovery-stats">
        ${metric('보관 중인 글감',data.saved_count,'내가 저장한 키워드','#savedKeywordsView')}
        ${metric('새 글감 후보',data.opportunity_count,data.post_count?'추천 후보 중 글 제목에 없는 키워드':'글 수집 전 · 작성 여부 비교 전','discoveryIdeas','metric-purple')}
      </div>
      `;
    $('discoveryBody').innerHTML = `
      <section id="discoveryIdeas" class="panel work-panel"><div class="work-section-title"><div><p class="eyebrow">TODAY’S IDEAS</p><h2>오늘의 추천 글감 <span class="count-chip">${data.ideas.length}개</span></h2></div><span class="count-chip">${esc(data.day.replaceAll('-','/'))} 기준</span></div><p class="muted discovery-description">관심 분야와 보관한 키워드에서 글감을 고르고 ‘글 구성하기’를 눌러 보세요.</p><div class="work-keyword-grid">${data.ideas.length?data.ideas.map(idea).join(''):empty('아직 추천할 글감이 없습니다. 관심 분야를 선택하거나 키워드 검색에서 글감을 보관해 주세요.')}</div></section>

      <section id="discoveryWritingGuide" class="panel work-panel writing-guide" tabindex="-1"><div class="work-section-title"><div><p class="eyebrow">TODAY’S WRITING GUIDE</p><h2>오늘의 글쓰기 가이드</h2></div><button class="button button-light" data-discovery-action="guide-copy" ${data.ideas.length?'':'disabled'}>구성안 복사</button></div><p class="muted discovery-description">주제와 글 유형에 맞춘 구성 참고안입니다. 직접 확인한 경험과 자료로 내용을 채워보세요.</p>${data.ideas.length?'<div class="writing-guide-controls"><label>글감 선택<select data-writing-keyword>'+data.ideas.map(row=>'<option value="'+esc(row.keyword)+'">'+esc(row.keyword)+'</option>').join('')+'</select></label><label>글 유형<select data-writing-style><option value="questions">궁금증 해결</option><option value="experience">경험 정리</option><option value="compare">비교와 선택</option></select></label></div><div data-writing-output></div><p class="message" role="status" data-writing-status></p><label data-writing-fallback hidden>구성안 직접 복사<textarea data-writing-copytext readonly rows="10"></textarea></label>':empty('추천 글감이 생기면 제목 후보와 글 구성안을 보여드립니다. 관심 분야를 설정하거나 키워드 탐색에서 글감을 보관해 주세요.')}</section>
      <section class="panel work-panel"><div class="work-section-title"><div><p class="eyebrow">KEYWORD OPPORTUNITIES</p><h2>검색량 높은 새 글감 TOP 10</h2></div><a href="#keywordSearchView">다른 키워드 찾기 ↗</a></div><p class="muted discovery-description">${data.post_count?'수집된 글 제목에서 찾지 못한 후보를 월 검색량순으로 보여드립니다.':'아직 글을 수집하지 않아, 관심 분야의 검색량 높은 후보를 보여드립니다.'}</p>
      <ol class="discovery-opportunities">${data.opportunities.length?data.opportunities.map((row,index)=>`<li><span class="priority-number">${index+1}</span><div class="discovery-keyword"><strong>${esc(row.keyword)}</strong><small class="muted">${esc(row.field || '내 보관함')} · ${date(row.collected_at)} 조회</small></div><div class="discovery-volume"><strong>${volume(row)}</strong><small>월 검색량</small></div><button class="button button-light" data-discovery-action="save" data-keyword="${esc(row.keyword)}" ${row.saved?'disabled':''}>${row.saved?'보관됨 ✓':'글감 보관'}</button></li>`).join(''):''}</ol>
      ${!data.opportunities.length?empty('최근 30일 내 검색량이 확인된 추천 후보가 없습니다. 관심 분야를 확인하거나 키워드 검색에서 새로운 글감을 찾아보세요.'):''}
      <p class="catalog-footnote">추천은 공용 목록의 관심 분야 키워드와 내 보관함을 기준으로 합니다. 제목에 없더라도 과거에 작성했을 수 있습니다.</p></section>
      <details class="discovery-method"><summary>추천 기준과 데이터 범위</summary><p>관심 분야의 검색량 높은 키워드 최대 300개와 내 보관함을 후보로 사용합니다. 수집된 글 제목에 키워드가 포함되어 있으면 추천에서 제외합니다. 공백과 영문 대소문자를 정리한 단순 제목 비교이며, 글 본문이나 블로그 전체 이력을 분석한 결과는 아닙니다.</p><p>오늘의 추천은 후보 중 상위 30개에서 한국시간 날짜별로 최대 9개를 고릅니다. 후보가 적으면 확보된 개수만 표시합니다. 보관 키워드를 우선 후보에 넣으며, 검색량은 최근 30일 안에 조회한 네이버 검색광고 PC·모바일 합계입니다. 검색량을 확인하지 않은 보관 글감은 ‘미확인’으로 표시합니다.</p><p>대시보드는 저장된 데이터를 사용합니다. 새로고침해도 검색 노출 점검 횟수는 차감되지 않으며, 실제 점검은 내 블로그 분석의 버튼을 눌렀을 때만 실행됩니다.</p></details>`;
    renderGuide();
  }
  function selectedGuide(){
    const row=data?.ideas.find(row=>row.keyword===guideKeyword);
    return row?makeWritingGuide({...row,field:row.field||data.interest},guideStyle):null;
  }
  function renderGuide(){
    const output=root.querySelector('[data-writing-output]');if(!output)return;
    if(!data.ideas.some(row=>row.keyword===guideKeyword))guideKeyword=data.ideas[0]?.keyword||'';
    root.querySelector('[data-writing-keyword]').value=guideKeyword;root.querySelector('[data-writing-style]').value=guideStyle;
    const guide=selectedGuide();if(!guide)return;
    const list=items=>items.map(text=>'<li>'+esc(text)+'</li>').join('');
    output.innerHTML='<div class="writing-guide-context"><strong>'+esc(guide.keyword)+'</strong><span class="count-chip">'+esc(guide.style)+'</span><p><b>주요 독자</b> · '+esc(guide.audience)+'</p><p>'+esc(guide.direction)+'</p></div><div class="writing-guide-block"><h3>제목 후보</h3><ol>'+list(guide.titles)+'</ol></div><div class="writing-guide-block"><h3>추천 소제목과 담을 내용</h3><ol class="writing-outline">'+guide.sections.map(([title,note])=>'<li><strong>'+esc(title)+'</strong><p>'+esc(note)+'</p></li>').join('')+'</ol></div><div class="writing-guide-columns"><div class="writing-guide-block"><h3>독자가 궁금해할 질문</h3><ul>'+list(guide.questions)+'</ul></div><div class="writing-guide-block"><h3>준비할 자료</h3><ul>'+list(guide.materials)+'</ul></div></div>';
    root.querySelector('[data-writing-status]').textContent='';root.querySelector('[data-writing-fallback]').hidden=true;
  }
  function guideText(guide){return ['오늘의 글쓰기 가이드 · '+guide.keyword,'글 유형: '+guide.style,'주요 독자: '+guide.audience,guide.direction,'','제목 후보',...guide.titles.map((x,i)=>(i+1)+'. '+x),'','추천 소제목과 담을 내용',...guide.sections.map(([title,note],i)=>(i+1)+'. '+title+'\n'+note),'','독자가 궁금해할 질문',...guide.questions.map(x=>'• '+x),'','준비할 자료',...guide.materials.map(x=>'• '+x)].join('\n');}
  root.addEventListener('change',event=>{if(event.target.matches('[data-writing-keyword]')){guideKeyword=event.target.value;renderGuide();}if(event.target.matches('[data-writing-style]')){guideStyle=event.target.value;renderGuide();}});
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
      try{await navigator.clipboard.writeText(text);if(g===generation)root.querySelector('[data-writing-status]').textContent='구성안을 복사했습니다. 글쓰기 화면이나 메모에 붙여 넣어 사용하세요.';}
      catch{if(g===generation){const fallback=root.querySelector('[data-writing-fallback]'),input=root.querySelector('[data-writing-copytext]');fallback.hidden=false;input.value=text;input.focus();input.select();root.querySelector('[data-writing-status]').textContent='아래 구성안을 선택해 직접 복사해 주세요.';}}return;
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
      contextKey = key; generation++; guideKeyword='';guideStyle='questions';data = null; loadedAt = 0; loading = false; reloadAfter = false; saving.clear();
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
