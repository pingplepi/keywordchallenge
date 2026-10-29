# Collaboration mail workflow

The collaboration manager accepts a new invitation or subsequent correspondence attached to an existing collaboration. Local extraction runs in the browser. Optional OpenAI analysis sends only the submitted text and selected current collaboration context after the member confirms the disclosure. PDF/DOCX text is extracted locally first; scanned PDFs and images require text.

Each import shows a selectable before/after comparison. Saving commits the reviewed collaboration and original message in one database transaction. Revision checks prevent stale edits, and per-collaboration source hashes prevent duplicate imports. Unknown fields never clear existing agreements. Requirements and references are appended; individual outputs retain IDs and existing links/deadlines when omitted. Original message text, extraction method, summary and actual applied changes are available in the owner-only mail history. Calendar and opted-in reminders use the existing schedule trigger.

## AI setup

API managers use 관리자 설정 → 협업 메일 AI 분석. Enter a dedicated OpenAI project API key and save. Keys are stored in Vault and never returned to browsers. A models endpoint check verifies access without a generation request; the project must separately have API billing available. Ordinary admins see usage only. Members do not supply keys.

The model is `gpt-5.6-terra`, using Responses API structured outputs with `store:false`, low reasoning and a 6,000 output-token cap. Source input is limited to 24,000 characters. A single request has a 90-second timeout with no automatic retries. Default limits: site 50/day and 300/month, each member 10/day, at least 30 seconds between requests (Korean calendar boundaries). Reservations are atomic and failed requests count. These are request limits, not a currency spending cap. OpenAI pricing and project billing apply separately. Pause stops new reservations; requests already submitted may finish.

## Deployment / checks

Apply `add_collaboration_mail_workflow`, deploy `keyon-collaboration-ai` plus its shared schema module, then publish the static build. The function verifies the bearer token with Auth before all actions and checks `keychallenge_admins.can_manage_api` for settings. Its service-only bridge is revoked from anon/authenticated roles. Private AI tables intentionally have no public RLS policies; they are service-only.

`node --test tests/*.test.mjs` covers invitation prose, ambiguous amounts/dates, sender-vs-recipient, follow-up preservation, publishing requests vs completion, separate output states and invalid AI evidence/links. Database checks exercised atomic rollback, duplicate retry, revision conflict, ownership isolation and quota reservation in a rolled-back transaction. Desktop/mobile UI was checked with local example fixtures; these fixtures are excluded from publication. An actual OpenAI completion requires the operator's key and has not been tested before connection.
