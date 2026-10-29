# Collaboration mail workflow

The collaboration manager accepts a new invitation or subsequent correspondence attached to an existing collaboration. Local extraction runs in the browser. Optional OpenAI or Google Gemini analysis sends only the submitted text and selected current collaboration context after the member confirms the disclosure. PDF/DOCX text is extracted locally first; scanned PDFs and images require text.

Each import shows a selectable before/after comparison. Saving commits the reviewed collaboration and original message in one database transaction. Revision checks prevent stale edits, and per-collaboration source hashes prevent duplicate imports. Unknown fields never clear existing agreements. Requirements and references are appended; individual outputs retain IDs and existing links/deadlines when omitted. Original message text, extraction method, summary and actual applied changes are available in the owner-only mail history. Calendar and opted-in reminders use the existing schedule trigger.

## AI setup

API managers use 관리자 설정 → 협업 메일 AI 분석. Select a provider, enter a dedicated project API key and save. Keys are stored in Vault and never returned to browsers. A models endpoint check verifies access without a generation request; the project must separately have API billing available. Ordinary admins see usage only. Members do not supply keys.

The OpenAI model is `gpt-5.6-terra`, using Responses API structured outputs with `store:false`, low reasoning and a 6,000 output-token cap. Source input is limited to 24,000 characters. A single request has a 90-second timeout with no automatic retries. Default limits: site 50/day and 300/month, each member 10/day, at least 30 seconds between requests (Korean calendar boundaries). Reservations are atomic and failed requests count. These are request limits, not a currency spending cap. OpenAI pricing and project billing apply separately. Pause stops new reservations; requests already submitted may finish.

## Deployment / checks

Apply `add_collaboration_mail_workflow`, deploy `keyon-collaboration-ai` plus its shared schema and provider modules, then publish the static build. The function verifies the bearer token with Auth before all actions and checks `keychallenge_admins.can_manage_api` for settings. Its service-only bridge is revoked from anon/authenticated roles. Private AI tables intentionally have no public RLS policies; they are service-only.

`node --test tests/*.test.mjs` covers invitation prose, ambiguous amounts/dates, sender-vs-recipient, follow-up preservation, publishing requests vs completion, separate output states and invalid AI evidence/links. Database checks exercised atomic rollback, duplicate retry, revision conflict, ownership isolation and quota reservation in a rolled-back transaction. Desktop/mobile UI was checked with local example fixtures; these fixtures are excluded from publication. An actual OpenAI completion requires the operator's key and has not been tested before connection.

## Gemini 연결 (2026-10-29)

관리자 설정 → 협업 메일 AI 분석에서 Google Gemini 또는 OpenAI를 선택한다. `can_manage_api` 운영자만 키/제공업체/한도를 변경하고, 나머지 관리자는 사용 횟수만 본다. Gemini는 `gemini-3.5-flash-lite`, LOW thinking, 출력 최대 6,000토큰으로 문맥을 추출한다. 요청마다 24,000자 제한, 사이트 일/월 한도, 회원당 하루 10회, 요청 간 30초를 유지한다. 비용이 발생하는 재시도나 다른 제공업체로의 자동 전환은 없다.

- 제공업체별 Vault 이름을 분리한다(`keyon_collaboration_openai`, `keyon_collaboration_gemini`). API 응답/화면/로그에 키를 반환하지 않는다.
- 회원이 동의한 제공업체를 요청에 고정하고 DB 예약 잠금 안에서 현재 설정과 비교한다. 그 사이 운영자가 제공업체를 변경했다면 전송하지 않고 동의를 다시 받는다. 구버전 화면은 OpenAI 동의로 간주하여 Gemini로 보내지 않는다.
- 제공업체 변경은 누적 한도를 초기화하지 않는다. 실패한 호출도 횟수에 포함되며 요청 이력에는 제공업체와 토큰 수만 추가한다. 분석 원문은 별도의 기존 소유자 전용 메일 이력에 저장한다.
- 연결 확인은 `models.get` 메타데이터 요청이다. 실제 분석/결제/크레딧을 검증하거나 사용료가 드는 텍스트 생성을 실행하지 않는다.
- Gemini API 무료 계층에는 협업 메일의 개인정보를 보내지 않는다. 운영자는 유료 결제가 연결된 프로젝트 및 데이터 공유/학습 제공 해제를 확인한다. 키만으로 이 결제 상태를 서버에서 검증할 수는 없다.

### 운영자 크레딧 적용 순서

1. Pro를 구독한 Google 계정으로 [Google Developer Program](https://developers.google.com/program)을 연결한다.
2. [My Benefits](https://me.developers.google.com/benefits)에서 월 Google Cloud 크레딧 혜택을 활성화하고 사용할 결제 계정에 적용한다. Google AI Pro는 월 $10 혜택을 안내하지만, 본인의 자격/활성화 상태와 실제 적용 내역을 확인해야 한다.
3. [AI Studio](https://aistudio.google.com/)의 Projects에서 키온 전용 프로젝트를 준비하고 위 결제 계정에 연결한다. 선불 계정은 최초 최소 $5 충전이 필요할 수 있다. 양수 선불 잔액이 있어야 적격 프로모션 크레딧부터 사용된다.
4. 같은 프로젝트의 [API Keys](https://aistudio.google.com/api-keys)에서 새 키를 만든다. 키온 관리자 설정에서 Gemini를 선택하고 직접 입력한다. 키를 채팅/저장소에 보내지 않는다.
5. AI Studio의 Spend → Monthly spend cap에서 예산을 설정하고 Billing에서 잔액 및 크레딧 적용을 확인한다. 자동 충전을 원하지 않으면 auto-reload를 끈다. 프로젝트 한도에는 약 10분 반영 지연이 있어 초과 사용료가 발생할 수 있다. 키온의 횟수 제한도 금액/무료 보장 한도가 아니다.
6. 키온에서 ‘연결 확인 · 저장’ 후, 협업 매니저에서 불필요한 개인정보를 제거한 예시 메일로 ‘AI로 분석’을 1회 실행해 결과를 확인한다. 날짜/금액 검토 후 저장하는 기존 절차는 동일하다.

키온에서는 크레딧을 직접 적용하거나 Google 결제 잔액을 확인하지 않는다. 실제 키 연결과 분석 호출은 운영자가 키를 등록한 뒤 확인한다.

공식 근거: [Pro 혜택](https://support.google.com/googleone/answer/14534406?hl=ko), [크레딧 FAQ](https://developers.google.com/profile/help/faq), [결제 및 지출 한도](https://ai.google.dev/gemini-api/docs/billing), [API 키](https://ai.google.dev/gemini-api/docs/api-key), [데이터 처리](https://ai.google.dev/gemini-api/terms), [Flash-Lite 모델](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite), [구조화 출력](https://ai.google.dev/gemini-api/docs/generate-content/structured-output).

검증: 제공업체별 요청/응답, 오류·중단 응답, 자동 재시도 없음, 근거 검증을 포함한 Node 테스트 24개 통과. DB 트랜잭션 후 롤백으로 제공업체 불일치 차단, 키 분리, 변경 후 누적 한도, 실패 요청 집계, 일반 회원/익명 역할 접근 차단 확인. AI 비공개 테이블은 RLS 무정책·권한 회수로 서비스 전용이다. 기존의 다른 테이블에 대한 advisor 항목은 이번 변경 범위에 포함하지 않는다.
