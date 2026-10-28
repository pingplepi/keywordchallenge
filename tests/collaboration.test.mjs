import assert from 'node:assert/strict';
import test from 'node:test';
import {parseMoney,parseDate,extractCollaboration,blankCollaboration,outstanding,sumMoney} from '../collaboration-import.js';
import {monthDays,moveMonth,calendarEvents} from '../collaboration-calendar.js';
const now=new Date('2026-10-28T00:00:00Z');
test('cash fee and in-kind value stay separate',()=>{const x=extractCollaboration('업체명: 예시 브랜드\n협업명: 여행 체험\n제품 금액: 30만원\n원고료: 20만원\n발행 마감: 2026/11/15\n정산 예정일: 2026/12/01\n결과물: 블로그 1건, 릴스 1건',now).draft;assert.equal(x.provided_value,300000);assert.equal(x.cash_fee,200000);assert.equal(outstanding(x),200000);assert.equal(x.publish_due,'2026-11-15');assert.equal(x.payment_due,'2026-12-01');assert.deepEqual(x.deliverables.map(d=>d.kind),['blog','reels']);});
test('ambiguous prices and relative deadlines are not invented',()=>{assert.equal(parseMoney('협의 후 지급'),null);assert.equal(parseMoney('10~20만원'),null);assert.equal(parseDate('제품 수령 후 7일 이내',now),null);assert.equal(parseDate('2026/02/30',now),null);assert.equal(parseDate('11/05',now).assumedYear,true);assert.equal(parseMoney('₩200,000'),200000);assert.equal(parseMoney('2.5만원'),25000);});
test('spaces in Korean labels and Korean time are extracted',()=>{const x=extractCollaboration('협업 경로: 예시 대행사\n제공 제품: 체험권\n필수 키워드: 여행, 호텔\n원고 제출일: 2026-11-08\n방문 일시: 2026/11/01 오후 3시 30분',now).draft;assert.equal(x.channel,'예시 대행사');assert.equal(x.products,'체험권');assert.equal(x.keywords,'여행, 호텔');assert.equal(x.draft_due,'2026-11-08');assert.equal(x.visit_at,'2026-11-01T15:30:00+09:00');});
test('payments and expenses do not change provided value or inflate receipts',()=>{const x={...blankCollaboration(),cash_fee:200000,provided_value:500000,payments:[{amount:50000},{amount:100000}],expenses:[{amount:20000}]};assert.equal(sumMoney(x.payments),150000);assert.equal(outstanding(x),50000);assert.equal(sumMoney(x.payments)-sumMoney(x.expenses),130000);assert.equal(outstanding({...x,payments:[{amount:250000}]}),0);});
test('an import is only a draft, with reminders off and plain source text',()=>{const text='업체명: <script>alert(1)</script>\n원고료: 협의\n발행 마감: 방문 후 7일';const x=extractCollaboration(text,now);assert.equal(x.draft.source_text,text);assert.equal(x.draft.reminder_enabled,false);assert.ok(x.warnings.length>=3);assert.throws(()=>extractCollaboration('x'.repeat(50001),now));});
test('deductions settle cash without treating withheld money as a receipt',()=>{const x={...blankCollaboration(),cash_fee:200000,deductions:6600,payments:[{amount:193400}]};assert.equal(outstanding(x),0);assert.equal(sumMoney(x.payments),193400);});
test('multi-deliverable quantities and headings on separate lines',()=>{const x=extractCollaboration('업체명\n예시 브랜드\n원고료는 25만원\n발행 마감 2026/11/15\n결과물: 블로그 2건, 릴스 1건, 인스타 피드 1건',now).draft;assert.equal(x.company,'예시 브랜드');assert.equal(x.cash_fee,250000);assert.equal(x.publish_due,'2026-11-15');assert.equal(x.deliverables.length,4);assert.equal(x.deliverables[3].kind,'instagram');});
test('month grid handles leap days, six-week months and year transitions',()=>{
  const leap=monthDays('2024-02');assert.equal(leap[0].date,'2024-01-28');assert.equal(leap.at(-1).date,'2024-03-02');assert.equal(leap.filter(d=>d.inMonth).length,29);
  assert.equal(monthDays('2026-08').length,42);assert.equal(monthDays('2026-02').length,28);
  assert.equal(moveMonth('2026-12',1),'2027-01');assert.equal(moveMonth('2026-01',-1),'2025-12');
});
test('calendar uses Korean visit date and retains separate outputs and completed events',()=>{
  const row={...blankCollaboration(),status:'published',visit_at:'2026-10-28T16:30:00Z',draft_due:'2026-10-30',publish_due:'2026-11-01',deliverables:[{name:'블로그',due_on:'2026-11-01',status:'published'},{name:'릴스',due_on:'2026-11-01',status:'writing'}]};
  const events=calendarEvents(row);assert.equal(events[0].date,'2026-10-29');assert.equal(events[0].time,'01:30');assert.equal(events[0].done,true);
  assert.equal(events.filter(e=>e.date==='2026-11-01').length,3);assert.equal(events.find(e=>e.label==='릴스').done,false);
  assert.deepEqual(calendarEvents({...row,status:'cancelled'}),[]);assert.deepEqual(calendarEvents({...row,deleted_at:now.toISOString()}),[]);
});
test('settlement calendar reflects actual cash and deductions separately from provided value',()=>{
  const row={...blankCollaboration(),status:'completed',payment_due:'2026-11-01',cash_fee:200000,provided_value:500000,deductions:6600,payments:[{amount:193400}]};
  assert.equal(calendarEvents(row)[0].done,true);assert.equal(calendarEvents({...row,payments:[]})[0].done,false);
  assert.deepEqual(calendarEvents({...row,cash_fee:0}),[]);
});
