const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names={openai:'OpenAI',gemini:'Google Gemini'};
export function createCollaborationAI(client){
 const panel=document.createElement('section');panel.className='panel admin-panel collab-ai-admin';panel.hidden=true;document.getElementById('catalogAdmin').append(panel);
 let user=null,version=0,state=null,busy=false;
 async function invoke(body){const {data,error}=await client.functions.invoke('keyon-collaboration-ai',{body});if(error||!data?.ok)throw new Error(data?.message||'AI 연결 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');return data;}
 function providerFields(){
  const form=panel.querySelector('#collabAIForm');if(!form)return;
  const provider=form.elements.provider.value,gemini=provider==='gemini';
  const configured=state.provider_configured?.[provider]??(state.provider===provider&&state.configured);
  form.querySelector('[data-ai-key-label]').textContent=`${names[provider]} API 키`;
  form.elements.api_key.value='';form.elements.api_key.required=!configured;
  form.elements.api_key.placeholder=configured?'저장된 키 사용 · 바꿀 때만 입력':gemini?'Google AI Studio에서 발급한 키':'sk-…';
  form.querySelector('[data-ai-provider-help]').innerHTML=gemini?`
   <p class="muted small">Gemini API 사용료는 연결한 Google 프로젝트에 발생합니다. Pro 구독 크레딧은 Google에서 별도로 적용해야 합니다. 모델: Gemini 3.5 Flash-Lite.</p>
   <p><a href="https://aistudio.google.com/api-keys" target="_blank" rel="noopener noreferrer">Gemini API 키 만들기 ↗</a> · <a href="https://ai.google.dev/gemini-api/docs/pricing" target="_blank" rel="noopener noreferrer">Gemini 요금 확인 ↗</a></p>
   <details class="collab-ai-guide"><summary>Google AI Pro 크레딧 적용 · 연결 방법</summary><ol>
    <li>Pro를 구독한 계정으로 <a href="https://developers.google.com/program" target="_blank" rel="noopener noreferrer">Google Developer Program</a>에 가입·연결합니다.</li>
    <li><a href="https://me.developers.google.com/benefits" target="_blank" rel="noopener noreferrer">개발자 혜택(My Benefits)</a>에서 월 Google Cloud 크레딧을 확인하고 사용할 결제 계정에 적용합니다. Pro의 월 10달러 혜택은 계정 자격과 활성화 여부를 확인해 주세요.</li>
    <li>Google AI Studio의 Projects에서 키온 전용 프로젝트를 준비하고, 크레딧을 적용한 결제 계정에 연결합니다. 선불 계정은 최소 5달러 충전이 필요할 수 있으며, 충전 후 프로모션 크레딧부터 사용됩니다.</li>
    <li>같은 프로젝트의 API Keys에서 키를 만들어 이 칸에 입력합니다. 협업 메일에는 개인정보가 있으므로 유료 프로젝트를 사용하고 데이터 공유·학습 제공은 끕니다.</li>
    <li>AI Studio의 Spend에서 Monthly spend cap을 설정하고 Billing에서 잔액을 확인합니다. 원하지 않는 자동 충전을 피하려면 auto-reload를 끕니다. 한도 반영이 약 10분 늦을 수 있어 추가 사용료가 생길 수 있습니다.</li>
   </ol><p class="muted small">키온은 Google 크레딧을 대신 적용하거나 잔액·결제 상태를 조회하지 않습니다. 크레딧이 소진되면 선불 잔액 또는 연결된 결제 수단에 사용료가 발생할 수 있습니다. <a href="https://developers.google.com/profile/help/faq" target="_blank" rel="noopener noreferrer">크레딧 안내 ↗</a> · <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noopener noreferrer">결제·한도 안내 ↗</a></p></details>
   <label class="collab-checkbox collab-ai-paid"><input name="paid_project_confirmed" type="checkbox" required ${state.provider==='gemini'&&state.gemini_paid_confirmed?'checked':''} />유료 결제가 연결된 프로젝트이며, 협업 메일을 학습에 제공하는 데이터 공유를 사용하지 않음을 확인했습니다.</label>`:`
   <p class="muted small">OpenAI API 사용료는 운영자 계정에 별도로 발생하며 ChatGPT 구독과 별도입니다. 모델: ${esc(state.models?.openai||'gpt-5.6-terra')}.</p>
   <p><a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">OpenAI API 키 만들기 ↗</a> · <a href="https://developers.openai.com/api/docs/pricing" target="_blank" rel="noopener noreferrer">OpenAI 요금 확인 ↗</a></p>`;
 }
 function render(){
  panel.hidden=!user||!state?.is_admin;if(panel.hidden){panel.replaceChildren();return;}
  const selected=state.provider||'openai';
  panel.innerHTML=`<p class="eyebrow">COLLABORATION AI</p><h2>협업 메일 AI 분석</h2><p class="muted">메일·가이드에서 조건, 일정, 수정 요청을 찾아냅니다. 회원이 전송에 동의하고 ‘AI로 분석’을 눌렀을 때만 선택한 AI로 본문과 해당 협업의 현재 조건을 보냅니다.</p><span class="status-pill">${state.configured?`${names[selected]} · `:''}${state.enabled?'AI 분석 사용 가능':state.configured?'AI 분석 일시 중지':'AI 연결 대기'}</span><p>오늘 ${state.today} / ${state.daily_limit}회 · 이번 달 ${state.month} / ${state.monthly_limit}회 · 회원당 하루 10회</p>${state.can_manage?`<form id="collabAIForm" autocomplete="off"><div class="collab-form-grid"><label class="collab-span">AI 제공업체<select name="provider"><option value="gemini" ${selected==='gemini'?'selected':''}>Google Gemini</option><option value="openai" ${selected==='openai'?'selected':''}>OpenAI</option></select></label><label class="collab-span"><span data-ai-key-label></span><input name="api_key" type="password" autocomplete="new-password" maxlength="512" /></label><label>전체 일 분석 한도<input name="daily_limit" type="number" min="1" max="500" step="1" value="${state.daily_limit}" required /></label><label>전체 월 분석 한도<input name="monthly_limit" type="number" min="1" max="3000" step="1" value="${state.monthly_limit}" required /></label></div><div data-ai-provider-help></div><p class="muted small">실패한 요청도 횟수에 포함되며 한도에 도달하면 분석을 중단합니다. 제공업체를 바꿔도 누적 횟수는 유지합니다. 금액 한도가 아닌 요청 횟수 한도입니다.</p><div class="collab-actions"><button type="submit" class="button">연결 확인 · 저장</button>${state.enabled?'<button type="button" class="button button-quiet" data-ai-pause>AI 분석 일시 중지</button>':''}</div><p class="muted small">키는 제공업체별로 암호화 저장하고 다시 표시하지 않습니다. 연결 확인은 키·모델 접근 권한만 확인합니다. 결제 상태와 크레딧 적용은 제공업체에서 직접 확인해 주세요.</p></form>`:''}<p id="collabAIMessage" role="status"></p>`;
  providerFields();
 }
 async function load(){if(!user)return;const n=version;try{const s=await invoke({action:'status'});if(n===version){state=s;render();}}catch{if(n===version){state=null;render();}}}
 async function configure(action,values={}){if(busy)return;busy=true;const n=version;panel.querySelectorAll('button, input, select').forEach(b=>b.disabled=true);panel.querySelector('#collabAIMessage').textContent='연결 설정을 확인하고 있습니다…';try{await invoke({action,...values});if(n!==version)return;await load();const message=panel.querySelector('#collabAIMessage');if(message)message.textContent=action==='pause'?'AI 분석을 중지했습니다.':'키·모델 접근을 확인하고 설정을 저장했습니다. 크레딧 적용과 실제 분석은 별도로 확인해 주세요.';}catch(e){if(n===version){const message=panel.querySelector('#collabAIMessage');if(message)message.textContent=e.message;}}finally{busy=false;panel.querySelectorAll('button, input, select').forEach(b=>b.disabled=false);}}
 panel.addEventListener('submit',e=>{e.preventDefault();const f=e.target;void configure('save',{provider:f.elements.provider.value,api_key:f.elements.api_key.value.trim(),paid_project_confirmed:f.elements.paid_project_confirmed?.checked===true,daily_limit:Number(f.elements.daily_limit.value),monthly_limit:Number(f.elements.monthly_limit.value)});});
 panel.addEventListener('change',e=>{if(e.target.name==='provider')providerFields();});
 panel.addEventListener('click',e=>{if(e.target.closest('[data-ai-pause]'))void configure('pause');});
 return {get status(){return state;},load,setUser(next){version++;user=next;state=null;render();if(user)void load();},analyze:async(source,collaboration_id,provider)=>{try{const r=await invoke({action:'analyze',source,collaboration_id,provider,consent:true,request_id:crypto.randomUUID()});return r.result;}finally{void load();}}};
}
