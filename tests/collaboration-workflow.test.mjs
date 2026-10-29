import test from 'node:test';
import assert from 'node:assert/strict';
import {extractMail,proposeChanges,mergeOutputs} from '../collaboration-workflow.js';
import {blankCollaboration} from '../collaboration-import.js';
import {validateExtraction} from '../supabase/functions/_shared/collaboration-ai-schema.js';
const now=new Date('2026-10-29T00:00:00Z');
const invitation=`안녕하세요! 예시블로거(홍길동)님.
트래블브랜드 김민수입니다.
지난번 저희 제품을 소개해주셔서 감사합니다.
당사 여행용 충전기 3구 제품이 리뉴얼되어 블로그 협업을 준비하고 있습니다.
제품 확인: https://example.com/product
실제 여행 중 사용하신 경험을 소개하는 콘텐츠를 생각하고 있어, 향후 약 3개월 내 해외여행 계획이 있으신지 여쭙고 싶습니다.
금번 제안은 제품 무료 제공과 원고료 5만 원이며, 현지 사용 경험을 담은 블로그 포스팅 1건을 요청드릴 예정입니다.
관심 있으시다면 아래 내용을 간단히 회신해주시면 감사하겠습니다.
1. 해외여행 예정 여부
2. 여행 국가와 대략적인 출국/귀국 시기
세부 일정과 콘텐츠 방향은 회신을 받은 뒤 조율 및 안내드리겠습니다.
트래블브랜드 김민수 드림`;
test('natural invitation extracts sender, cash, product and obligations, never invents dates',()=>{
 const r=extractMail(invitation,now);assert.equal(r.draft.company,'트래블브랜드');assert.equal(r.draft.contact,'김민수');assert.equal(r.draft.cash_fee,50000);assert.match(r.draft.products,/여행용 충전기 3구/);assert.equal(r.draft.deliverables.length,1);assert.equal(r.draft.publish_due,null);assert.equal(r.draft.visit_at,null);assert.equal(r.draft.required_links,'');assert.match(r.draft.memo,/example.com/);assert.match(r.draft.requirements,/출국\/귀국/);assert.equal(r.draft.reminder_enabled,false);
});
test('follow-up revisions preserve negotiated fees, dates, product and posted outputs',()=>{
 const old={...blankCollaboration(),id:'existing',title:'원래 협업명',cash_fee:200000,publish_due:'2026-11-20',products:'체험권',requirements:'원래 필수 조건',deliverables:[{id:'keep',kind:'blog',name:'블로그 글',status:'published',url:'https://example.com/post',due_on:'2026-11-20'}]};
 const result=extractMail('수정 요청입니다. 첫 문단의 제품명을 수정해 주세요.\n원고 제출일: 2026/11/15',now), {proposed}=proposeChanges(old,result);
 assert.equal(proposed.cash_fee,200000);assert.equal(proposed.publish_due,'2026-11-20');assert.equal(proposed.draft_due,'2026-11-15');assert.equal(proposed.status,'revision');assert.match(proposed.requirements,/원래 필수 조건/);assert.equal(proposed.deliverables[0].url,'https://example.com/post');
});
test('publishing permission is not publishing completion and cash receipt is not inferred',()=>{
 assert.equal(extractMail('검수 완료했습니다. 이제 발행해 주세요.',now).draft.status,'review');
 assert.equal(extractMail('포스팅을 발행했습니다.',now).draft.status,'published');
 const r=extractMail('원고료 10만원 입금했습니다.',now);assert.equal(r.stage,'settlement');assert.deepEqual(r.draft.payments,[]);
});
test('AI extraction rejects unsupported evidence, invalid dates and unsafe links',()=>{
 const source='원고료 15만원, 블로그 1건을 요청합니다.';
 const r=validateExtraction({summary:'제안',stage:'proposal',warnings:[],changes:[{field:'cash_fee',value:'150000',evidence:'원고료 15만원'},{field:'contact',value:'가짜',evidence:'없는 담당자'},{field:'publish_due',value:'2026-02-30',evidence:'블로그 1건'}],outputs:[{kind:'blog',name:'블로그 글',count:1,status:null,due_on:null,url:'javascript:alert(1)',evidence:'블로그 1건'}]},source);
 assert.equal(r.draft.cash_fee,150000);assert.equal(r.draft.contact,undefined);assert.equal(r.draft.publish_due,undefined);assert.equal(r.draft.deliverables[0].url,null);
});
test('output updates retain identity and leave separately tracked reels unchanged',()=>{
 const current=[{id:'a',kind:'blog',name:'후기',status:'writing',due_on:'2026-11-01',url:''},{id:'b',kind:'reels',name:'영상',status:'review',due_on:'2026-11-02',url:''}];
 const next=mergeOutputs(current,[{kind:'blog',match_name:'후기',name:'후기',status:'revision',due_on:null,url:null}]);
 assert.equal(next[0].id,'a');assert.equal(next[0].due_on,'2026-11-01');assert.equal(next[0].status,'revision');assert.deepEqual(next[1],current[1]);
});
test('AI unknown fields do not zero amounts or enable mail reminders',()=>{
 const old={...blankCollaboration(),title:'협업',cash_fee:250000,provided_value:100000,reminder_enabled:true};
 const r=validateExtraction({summary:'문구 수정',stage:'revision',warnings:[],changes:[{field:'requirements',value:'제품명 수정',evidence:'제품명 수정'}],outputs:[]},'제품명 수정 부탁드립니다.');
 const {proposed}=proposeChanges(old,r);assert.equal(proposed.cash_fee,250000);assert.equal(proposed.provided_value,100000);assert.equal(proposed.reminder_enabled,true);
});

test('ordinary prose ending in 입니다 is not a sender signature',()=>{const r=extractMail('검토한 원고의 수정 요청입니다.\n제품명은 최신 모델명으로 수정 부탁드립니다.',now);assert.equal(r.draft.company,'');assert.equal(r.draft.contact,'');});
