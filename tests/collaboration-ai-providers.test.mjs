import test from 'node:test';
import assert from 'node:assert/strict';
import { checkProviderKey, analysisRequest, readAnalysis, analyzeWithProvider, validKey } from '../supabase/functions/_shared/collaboration-ai-providers.js';
const source='원고료 7만 원으로 진행하며 2026년 11월 12일까지 원고를 보내주세요.';
const extracted={summary:'원고료 및 제출일 확정',stage:'confirmed',changes:[{field:'cash_fee',value:'70000',evidence:'원고료 7만 원'},{field:'draft_due',value:'2026-11-12',evidence:'2026년 11월 12일까지 원고'}],outputs:[],warnings:[]};
const geminiBody={candidates:[{finishReason:'STOP',content:{parts:[{text:'This is private reasoning, not output',thought:true},{text:JSON.stringify(extracted)}]}}],usageMetadata:{promptTokenCount:120,candidatesTokenCount:80,thoughtsTokenCount:20}};
test('Gemini sends only to Google with schema, protected system instruction and bounded generation',()=>{
 const {url,init}=analysisRequest('gemini','fake-key-for-tests',source,null,'2026-10-29');
 assert.equal(new URL(url).hostname,'generativelanguage.googleapis.com');assert.ok(url.endsWith(':generateContent'));
 assert.equal(init.headers['x-goog-api-key'],'fake-key-for-tests');assert.equal(init.headers.Authorization,undefined);assert.ok(!url.includes('fake-key'));
 const body=JSON.parse(init.body);assert.equal(body.generationConfig.maxOutputTokens,6000);assert.equal(body.generationConfig.responseFormat.text.mimeType,'APPLICATION_JSON');
 assert.equal(body.generationConfig.responseFormat.text.schema.additionalProperties,false);assert.equal(body.tools,undefined);
 assert.equal(JSON.parse(body.contents[0].parts[0].text).new_source,source);assert.ok(body.systemInstruction.parts[0].text.includes('untrusted data'));
});
test('Gemini output excludes thoughts and uses shared evidence/date/amount validation',()=>{
 const parsed=readAnalysis('gemini',geminiBody,source);
 assert.equal(parsed.result.draft.cash_fee,70000);assert.equal(parsed.result.draft.draft_due,'2026-11-12');assert.deepEqual(parsed.usage,{input_tokens:120,output_tokens:100});
 const forged=structuredClone(geminiBody);forged.candidates[0].content.parts=[{text:JSON.stringify({...extracted,changes:[{field:'cash_fee',value:'900000',evidence:'not in mail'}]})}];
 assert.equal(readAnalysis('gemini',forged,source).result.draft.cash_fee,undefined);
});
test('Blocked, truncated, malformed Gemini replies never produce a saved draft',()=>{
 for(const body of [{...geminiBody,promptFeedback:{blockReason:'SAFETY'}},{...geminiBody,candidates:[{...geminiBody.candidates[0],finishReason:'MAX_TOKENS'}]},{candidates:[]},{candidates:[{finishReason:'STOP',content:{parts:[{text:'{incomplete'}]}}]}]){
  const parsed=readAnalysis('gemini',body,source);assert.ok(parsed.error);assert.equal(parsed.result,undefined);
 }
});
test('OpenAI response contract is preserved',()=>{
 const r=analysisRequest('openai','sk-test',source,{cash_fee:50000},'2026-10-29');const body=JSON.parse(r.init.body);
 assert.equal(r.url,'https://api.openai.com/v1/responses');assert.equal(body.store,false);assert.equal(body.text.format.strict,true);
 assert.equal(r.init.headers['x-goog-api-key'],undefined);assert.equal(r.init.headers.Authorization,'Bearer sk-test');
 assert.equal(readAnalysis('openai',{status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(extracted)}]}],usage:{input_tokens:1,output_tokens:2}},source).result.draft.cash_fee,70000);
});
test('Key check is metadata-only and never sends source or generates billable content',async()=>{
 let count=0;await checkProviderKey('gemini','AIza-test-12345678901234567890',async(url,init)=>{count++;assert.equal(init.method,undefined);assert.equal(init.body,undefined);assert.ok(!url.includes('generateContent'));return new Response('{}');});assert.equal(count,1);
 assert.equal(validKey('gemini','sk-test12345678901234567890123'),false);assert.equal(validKey('gemini','abc\nheader-injection-1234567890'),false);
 await assert.rejects(()=>checkProviderKey('unsupported','test'),/지원하지/);
});
test('Quota failures and network failures are not retried or sent to a second provider',async()=>{
 for(const fail of [async()=>new Response('{}',{status:429}),async()=>{throw new Error('network failed');}]){
  let calls=0;await assert.rejects(()=>analyzeWithProvider('gemini','fake-key',source,null,'2026-10-29',async(url)=>{calls++;assert.equal(new URL(url).hostname,'generativelanguage.googleapis.com');return fail();}));assert.equal(calls,1);
 }
});
