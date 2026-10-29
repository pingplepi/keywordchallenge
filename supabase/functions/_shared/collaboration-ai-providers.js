import { MODEL, SCHEMA, INSTRUCTIONS, validateExtraction } from './collaboration-ai-schema.js';

export const PROVIDERS = Object.freeze({
  openai: { label: 'OpenAI', model: MODEL },
  gemini: { label: 'Google Gemini', model: 'gemini-3.5-flash-lite' },
});
export function getProvider(name) {
  if (!Object.hasOwn(PROVIDERS, name)) throw new Error('지원하지 않는 AI 제공업체입니다.');
  return PROVIDERS[name];
}
export function validKey(provider, key) {
  getProvider(provider);
  // Accept both Google standard and newer authorization keys; validate access remotely.
  return typeof key === 'string' && (provider === 'openai'
    ? /^sk-[A-Za-z0-9_-]{20,500}$/.test(key)
    : /^[A-Za-z0-9_.:-]{20,512}$/.test(key) && !key.startsWith('sk-'));
}
function modelURL(provider) {
  const { model } = getProvider(provider);
  return provider === 'gemini' ? `https://generativelanguage.googleapis.com/v1beta/models/${model}` : `https://api.openai.com/v1/models/${model}`;
}
function authHeaders(provider, key) {
  return provider === 'gemini' ? { 'x-goog-api-key': key } : { Authorization: `Bearer ${key}` };
}
export async function checkProviderKey(provider, key, fetcher = fetch) {
  const { label } = getProvider(provider);
  if (!validKey(provider, key)) throw new Error(`${label} API 키를 확인해 주세요.`);
  const response = await fetcher(modelURL(provider), { headers: authHeaders(provider, key), signal: AbortSignal.timeout(15000) });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`${label} 키 또는 모델 접근 권한을 확인하지 못했습니다. 해당 프로젝트의 키와 API 권한을 확인해 주세요.`);
}
export function analysisRequest(provider, key, source, context, today) {
  const { model } = getProvider(provider);
  const input = JSON.stringify({ korean_today: today, existing_collaboration: context, new_source: source });
  const body = provider === 'gemini' ? {
    systemInstruction: { parts: [{ text: INSTRUCTIONS }] },
    contents: [{ role: 'user', parts: [{ text: input }] }],
    generationConfig: { maxOutputTokens: 6000, candidateCount: 1, thinkingConfig: { thinkingLevel: 'LOW' }, responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: SCHEMA } } },
  } : {
    model, store: false, instructions: INSTRUCTIONS, input, reasoning: { effort: 'low' }, max_output_tokens: 6000,
    text: { format: { type: 'json_schema', name: 'collaboration_mail', strict: true, schema: SCHEMA } },
  };
  return {
    url: provider === 'gemini' ? `${modelURL(provider)}:generateContent` : 'https://api.openai.com/v1/responses',
    init: { method: 'POST', headers: { ...authHeaders(provider, key), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) },
  };
}
const tokens = n => Number.isFinite(n) ? Math.min(2147483647, Math.max(0, Math.trunc(n))) : 0;
export function readAnalysis(provider, body, source) {
  getProvider(provider);
  const gemini = provider === 'gemini', candidate = body.candidates?.[0];
  const usage = gemini
    ? { input_tokens: tokens(body.usageMetadata?.promptTokenCount), output_tokens: tokens((body.usageMetadata?.candidatesTokenCount || 0) + (body.usageMetadata?.thoughtsTokenCount || 0)) }
    : { input_tokens: tokens(body.usage?.input_tokens), output_tokens: tokens(body.usage?.output_tokens) };
  if (gemini ? body.promptFeedback?.blockReason || candidate?.finishReason !== 'STOP' : body.status !== 'completed') {
    return { usage, error: '분석 결과를 끝까지 받지 못했습니다. 내용을 나누어 다시 시도해 주세요.' };
  }
  const output = gemini
    ? candidate.content?.parts?.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('')
    : body.output?.flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('');
  try { return { usage, result: validateExtraction(JSON.parse(output), source) }; }
  catch { return { usage, error: '분석 결과를 확인하지 못했습니다. 내용을 나누어 다시 시도해 주세요.' }; }
}
export async function analyzeWithProvider(provider, key, source, context, today, fetcher = fetch) {
  const { label } = getProvider(provider);
  const { url, init } = analysisRequest(provider, key, source, context, today);
  // One charged request only. Never retry or fall back to another data recipient.
  const response = await fetcher(url, init);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 429
      ? `${label} 사용 한도나 결제 잔액을 확인해 주세요. 자동 재시도하지 않았습니다.`
      : `${label} 분석 요청에 실패했습니다. 운영자가 API 키와 프로젝트 설정을 확인해 주세요.`);
  }
  return readAnalysis(provider, await response.json(), source);
}
