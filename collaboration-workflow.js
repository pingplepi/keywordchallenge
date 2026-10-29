import { blankCollaboration, extractCollaboration, parseMoney, parseDate, KINDS, STATUS } from './collaboration-import.js';

export const FIELD_LABELS = {title:'협업명',company:'업체명',channel:'협업 경로',contact:'담당자',products:'제공 제품·서비스',cash_fee:'약정 원고료',provided_value:'제품·서비스 제공가',requirements:'요청사항·수정 요청',keywords:'필수 키워드',required_links:'필수 삽입 링크',memo:'참고·확인할 사항',visit_at:'방문·예약일',draft_due:'원고 제출일',publish_due:'발행 마감일',payment_due:'정산 예정일',status:'진행 상태',deliverables:'결과물'};
export const STAGES = {proposal:'협업 제안',confirmed:'진행 확정',guide:'가이드',submitted:'원고 제출',revision:'수정 요청',approved:'발행 요청·승인',published:'발행 안내',settlement:'정산 안내',other:'협업 메일'};
const append = (old, next) => [...new Set([old, next].filter(Boolean))].join('\n');

// Local extraction is deliberately conservative. The AI path handles broader prose.
export function extractMail(text, now = new Date()) {
  const result=extractCollaboration(text,now), d=result.draft;
  const lines=text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const flat=text.replace(/\s+/g,' ');
  const fields=new Set(Object.keys(FIELD_LABELS).filter(k=>k!=='deliverables'&&k!=='status'&&d[k]));
  const put=(key,value,line)=>{if(value===null||value===undefined||value==='')return;d[key]=value;fields.add(key);result.evidence.push({field:FIELD_LABELS[key],line:String(line).slice(0,250)});};
  const sender=lines.map(s=>s.match(/^(.{2,60}?)\s+([가-힣]{2,4})(?:\s*(?:팀장|매니저|담당자|대리|과장))?\s*(?:입니다[.!]?|드림[.!]?|올림[.!]?)$/)).find(m=>m&&!/^(?:요청|수정|제안|안내|확인|문의|검수|완료|내용|사항|일정|전달|협업|가이드|확정)$/.test(m[2])&&!/검토한|원고의|수정 사항|다음과|아래와/.test(m[1]));
  if(sender){if(!d.company)put('company',sender[1],sender[0]);if(!d.contact)put('contact',sender[2],sender[0]);}
  const product=flat.match(/(?:당사|저희(?:의)?|이번)\s+(.{2,65}?)\s*(?:제품이|제품을)\s*(?:리뉴얼|제공|소개)/);
  if(!d.products&&product)put('products',product[1]+(/무료\s*제공/.test(flat)?' · 무료 제공':''),product[0]);
  const fee=flat.match(/(?:원고료|제작비)(?:는|은|를|가)?\s*(?:총\s*)?(\d[\d,]*(?:\.\d+)?\s*(?:억|천만|백만|십만|만|천)?\s*원)(?!\s*[~～])/);
  if(fee&&!/\d\s*[~～]\s*$/.test(flat.slice(Math.max(0,fee.index-5),fee.index)))put('cash_fee',parseMoney(fee[1]),fee[0]);
  // Retain conditions and response requests; never manufacture a date from a travel window.
  const requests=lines.filter(s=>/요청|회신|수정.{0,10}(?:부탁|사항)|필수|현지 사용|실제 여행|여행 국가|출국\/귀국/.test(s));
  if(requests.length)put('requirements',append(d.requirements,requests.join('\n')).slice(0,10000),requests[0]);
  const uncertain=lines.filter(s=>/약\s*\d+\s*개월|일정.{0,40}조율|일정.{0,40}추후|예정 없음/.test(s));
  const references=lines.filter(s=>/https?:\/\//.test(s)&&!/(?:필수|삽입|첨부)\s*(?:링크|URL)|본문.{0,12}(?:넣|삽입)/.test(s));
  if(uncertain.length||references.length)put('memo',[...uncertain,...references.map(s=>`참고 링크: ${s}`)].join('\n').slice(0,10000),uncertain[0]||references[0]);
  if(uncertain.length)result.warnings.push('조율 중인 일정은 달력에 넣지 않았습니다. 확정 메일을 받으면 이어서 추가해 주세요.');
  // Explicit dates next to an action, including dates written before the action.
  for(const [key,rx] of [['draft_due',/원고.{0,10}제출|초안.{0,10}(?:보내|전달|제출)/],['publish_due',/발행|업로드|포스팅.{0,10}(?:완료|까지)/],['payment_due',/정산|입금.{0,10}예정/]]){
    if(d[key])continue;
    const line=lines.find(s=>rx.test(s)&&/(?:20\d{2}[./년-]\s*)?\d{1,2}[./월-]\s*\d{1,2}/.test(s));
    if(line){const parsed=parseDate(line,now);if(parsed){put(key,parsed.date,line);if(parsed.assumedYear)result.warnings.push(`${FIELD_LABELS[key]}의 연도를 확인해 주세요.`);}}
  }
  const requested=lines.filter(s=>!/(?:지난번|이전|지난)\s/.test(s)&&!/(?:필요\s*없|제외|하지\s*않)/.test(s)&&/(?:요청|결과물|작성|제작|발행|포스팅|블로그\s*\d|릴스\s*\d)/.test(s)).join(' ');
  d.deliverables=d.deliverables.filter(o=>new RegExp(({blog:'블로그|포스팅',reels:'릴스|reels',instagram:'인스타',youtube:'유튜브|youtube',other:'기타'})[o.kind],'i').test(requested));
  if(d.deliverables.length)fields.add('deliverables');
  let stage='proposal';
  if(/수정\s*(?:사항|요청)|수정.{0,20}부탁/.test(flat)){stage='revision';put('status','revision',lines.find(s=>/수정/.test(s)));}
  else if(/발행(?:을|해|해도)?\s*(?:주세요|부탁|가능)|발행\s*승인/.test(flat)){stage='approved';put('status','review',lines.find(s=>/발행/.test(s)));}
  else if(/(?:발행|업로드)(?:을|를)?\s*(?:완료했습니다|완료하였습니다|했습니다|하였습니다)/.test(flat)){stage='published';put('status','published',lines.find(s=>/발행|업로드/.test(s)));}
  else if(/원고.{0,12}(?:잘\s*)?받았습니다|검수\s*중/.test(flat)){stage='submitted';put('status','review',lines.find(s=>/원고|검수/.test(s)));}
  else if(/원고.{0,12}(?:보냈습니다|전달드립니다|제출했습니다)/.test(flat)){stage='submitted';put('status','submitted',lines.find(s=>/원고/.test(s)));}
  else if(/진행.{0,15}(?:확정|하기로|하겠습니다)|합의한/.test(flat)){stage='confirmed';put('status','writing',lines.find(s=>/확정|합의|진행/.test(s)));}
  else if(/가이드/.test(flat))stage='guide';
  if(/입금(?:을)?\s*(?:했습니다|완료)|정산\s*완료/.test(flat)){stage='settlement';result.warnings.push('입금 안내는 메일 이력에만 남깁니다. 실제 입금 내역은 통장을 확인해 등록해 주세요.');}
  if(!d.title||/ 협업$/.test(d.title)){d.title=[d.company,d.products.split(' · ')[0]||'협업'].filter(Boolean).join(' ').slice(0,160);if(d.title)fields.add('title');}
  if(d.title)result.warnings=result.warnings.filter(s=>!s.includes('협업명을 입력'));
  if(fields.has('cash_fee'))result.warnings=result.warnings.filter(s=>!s.includes('현금 원고료를 찾지 못'));
  return {...result,fields:[...fields],stage,summary:`${STAGES[stage]} · ${d.company||'업체 확인 필요'}${fields.has('cash_fee')?` · 원고료 ${d.cash_fee.toLocaleString('ko-KR')}원`:''}`,method:'local'};
}

export function mergeOutputs(current,incoming){
  const list=structuredClone(current||[]), used=new Set();
  for(const next of incoming||[]){
    const i=list.findIndex((o,index)=>!used.has(index)&&o.kind===next.kind&&(next.match_name?o.name===next.match_name:true));
    if(i<0){if(list.length<20){list.push({id:crypto.randomUUID(),kind:next.kind,name:next.name||KINDS[next.kind],status:next.status||'preparing',due_on:next.due_on||'',url:next.url||''});used.add(list.length-1);}continue;}
    used.add(i);
    // An omitted state/date/link must never erase a previously recorded one.
    for(const key of ['status','due_on','url'])if(next[key]&&!(key==='status'&&next[key]==='preparing'))list[i][key]=next[key];
  }
  return list;
}
export function proposeChanges(current,result){
  const base=current||blankCollaboration(), proposed=structuredClone(base), changes=[];
  for(const key of result.fields||[]){
    if(!Object.hasOwn(FIELD_LABELS,key))continue;
    let next=result.draft[key];
    if(next===null||next===undefined||next==='')continue;
    if(key==='title'&&current?.title)continue;
    if(current&&result.method==='local'&&['company','contact'].includes(key)&&base[key])continue;
    if(key==='deliverables')next=mergeOutputs(base.deliverables,next);
    if(current&&['requirements','memo','keywords','required_links'].includes(key))next=append(base[key],next);
    if(JSON.stringify(base[key])===JSON.stringify(next))continue;
    proposed[key]=next;changes.push({key,label:FIELD_LABELS[key],before:base[key],after:next});
  }
  if(!current&&!proposed.title&&proposed.company){proposed.title=[proposed.company,proposed.products?.split(' · ')[0]||'협업'].join(' ').slice(0,160);changes.unshift({key:'title',label:FIELD_LABELS.title,before:'',after:proposed.title});}
  return {base,proposed,changes};
}
export function displayValue(key,value){
  if(value===null||value===undefined||value==='')return '미등록';
  if(['cash_fee','provided_value'].includes(key))return `${Number(value).toLocaleString('ko-KR')}원`;
  if(key==='status')return STATUS[value]||value;
  if(key==='deliverables')return value.map(o=>`${o.name} · ${STATUS[o.status]||'준비'}${o.due_on?` · ${o.due_on}`:''}${o.url?` · ${o.url}`:''}`).join('\n')||'미등록';
  return String(value);
}
