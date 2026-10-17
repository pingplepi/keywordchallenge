# 키챌 대시보드

네이버 인플루언서의 모든 분야 키워드를 검색하고, 개인 참여 현황과 순위를 계정별로 저장하는 웹앱입니다. 공용 목록은 로그인 없이 검색할 수 있고, 개인 데이터는 Supabase Auth와 RLS를 통해 분리됩니다.

## 포함 기능

- 이메일/비밀번호 계정 생성과 로그인
- 로그인한 계정의 인플루언서별 키챌 데이터 저장
- 키워드 검색, 순위 필터, 정렬
- JSON 백업 내보내기와 가져오기
- 브라우저에서 실행하는 네이버 수집기와 일회성 결과 전달
- 분야·참여자 수·키워드 이름으로 전체 목록 검색 (서버 검색, 50개씩 페이지 표시)
- 내 인플홈 수집 결과와 키워드 ID를 비교하여 참여·미참여 및 순위 표시
- 관리자만 공용 목록 JSON 등록 가능, 업로드 완료 후 한 번에 공개
- 목록의 수집 범위·분야별 개수·기준일 표시

## 1. Supabase 설정

1. 본인 Supabase 조직에서 새 프로젝트를 만듭니다.
2. `supabase/migrations/`의 SQL 파일을 시간순으로 적용합니다. 기존 배포에는 새 마이그레이션만 적용합니다.
3. Authentication → URL Configuration에서 배포한 사이트 주소를 Site URL과 Redirect URLs에 등록합니다.
4. 프로젝트 URL과 공개용 anon key를 Vercel 프로젝트 환경 변수 `SUPABASE_URL`, `SUPABASE_ANON_KEY`로 등록합니다. 이 두 값은 브라우저에 포함됩니다. 테이블 접근은 RLS 정책이 보호하므로 service role key를 프런트엔드에 넣지 마세요.

계정 확인 이메일 기능은 Supabase Auth 설정에 따릅니다. 사용자는 인증 이메일을 확인한 뒤 로그인할 수 있습니다.

## 2. 결과 전달 Edge Function 배포

Supabase CLI로 로그인하고 프로젝트를 연결한 뒤:

```sh
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy keychallenge-handoff
```

Supabase가 제공하는 Edge Function 기본 환경 변수(SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY)를 사용합니다. `SUPABASE_SERVICE_ROLE_KEY`는 함수 런타임에만 있어야 하며, Vercel 환경 변수나 브라우저 코드에 추가하지 마세요.

수집기는 256비트 무작위 일회성 토큰으로 결과를 전달합니다. 데이터는 해시된 토큰으로 6분 동안만 대기하고, 해당 토큰을 만든 로그인 계정만 결과를 읽고 삭제할 수 있습니다. 함수는 수집기 요청을 받기 위해 `verify_jwt = false`로 설정되어 있으며, 제출 작업은 만료 시간과 무작위 토큰으로 제한됩니다.

## 3. Vercel 배포

1. 이 GitHub 저장소를 Vercel에 연결합니다.
2. Vercel Project Settings → Environment Variables에 `SUPABASE_URL`, `SUPABASE_ANON_KEY`를 추가합니다.
3. 빌드 명령은 `npm run build`, 출력 폴더는 `dist`입니다. [`vercel.json`](vercel.json)에 설정되어 있습니다.
4. 배포된 주소를 Supabase Auth의 Site URL 및 Redirect URLs에도 등록합니다.

환경 변수를 로컬에서 시험하려면 `.env.example`을 참고해 `.env`를 만들고, `npm run build`를 실행합니다. `.env`와 생성된 `dist/config.js`는 Git에 올리지 않습니다.

## 4. 데이터 수집

1. 배포된 사이트에서 계정을 만들고 로그인합니다.
2. 인플루언서 ID 또는 `in.naver.com/...` 주소를 입력한 뒤 수집을 시작합니다.
3. 열린 네이버 인플홈 탭에서 로그인 상태를 확인합니다.
4. 개발자 도구의 Sources → Snippets에서 클립보드의 수집기를 실행합니다(Ctrl+Enter).
5. 완료되면 해당 계정의 Supabase 데이터에 자동 저장됩니다.

네이버 서비스의 화면/API 동작이 바뀌면 수집기 코드를 다시 조정해야 할 수 있습니다. 이 도구는 네이버 공식 서비스가 아닙니다.

## 5. 관리자 지정

관리자도 사이트 계정으로 로그인합니다. 네이버 계정의 분야와는 관계가 없습니다.
`keychallenge_admins`에 등록된 사용자만 공용 목록을 등록할 수 있으며, 일반 사용자에게 이 테이블의 쓰기 권한은 없습니다.
이메일 인증을 완료한 사용자를 Supabase SQL Editor에서 지정합니다 (이메일은 실제 관리자 이메일로 바꾸세요).

```sql
insert into public.keychallenge_admins(user_id)
select id from auth.users
where lower(email) = lower('ADMIN_EMAIL_HERE') and email_confirmed_at is not null
on conflict(user_id) do nothing;
```

관리자 역할은 공용 목록 관리만 허용합니다. 다른 회원의 개인 수집 데이터를 볼 수 있는 권한을 부여하지 않습니다.

## 6. 전체 키워드 목록 갱신

Python 3의 기본 라이브러리로 네이버 공개 목록을 수집합니다. 로그인 쿠키를 사용하지 않으며 키워드 ID·이름·분야·참여자 수만 가져옵니다.

```sh
python3 scripts/fetch-naver-catalog.py /absolute/path/naver-catalog.json
```

1. 공개된 분야 목록을 가져온 뒤 각 분야를 순서대로 수집합니다.
2. 일반 목록과 별도 미션 목록을 합치고, 페이지마다 간격을 두어 수집합니다. 고유 ID 개수가 원본의 표시 총계와 다르면 최대 두 번 더 읽어 보완합니다. 계속 차이가 있으면 실제 제공된 목록을 보관하고 `coverage: partial`, 분야별 `discrepancies`, 출처 문구에 차이를 기록합니다. 누락 항목을 만들어 채우지 않습니다.
3. 완료된 분야는 같은 경로의 `.checkpoint.json`에 보관합니다. 중단 후 같은 출력 경로로 실행하면 이어받습니다. **새 기준일의 전체 갱신에는 새 출력 파일명을 사용하세요.**
4. 사이트에 관리자 계정으로 로그인 → ‘목록 관리’ → 생성된 JSON 선택 → 수집 범위와 기준일 확인 → 공개.

파일 형식은 `{ "source": "출처", "coverage": "all 또는 partial", "collectedAt": "ISO 날짜", "items": [...] }`입니다. 각 items 항목은 `id`, `name`, `field`, `fieldGroup`, `categoryId`, `participantCount`를 사용합니다. 기존 `allKeywords` 백업도 지원합니다. 출처의 완전성을 확인한 경우에만 `all`을 사용하세요.

업로드 중에는 이전 공개 목록을 유지합니다. 업로드가 끝나면 서버에서 행 개수를 확인한 뒤 공개 목록 포인터를 변경합니다. 이전 스냅샷과 미완료 업로드는 자동 삭제하지 않습니다. 필요할 때 관리자 데이터베이스 작업으로 정리하세요.

### 해석 범위

- 전체 목록은 수집 시점의 스냅샷입니다. 자동 주기 갱신은 아직 설정하지 않았습니다.
- 공개 API는 네이버가 변경할 수 있는 내부 인터페이스입니다. 응답 구조가 바뀌면 수집 스크립트를 조정해야 합니다.
- `challengeable`은 로그인 계정에 따라 달라질 수 있어 공용 목록에 저장하지 않습니다. 키워드 검색 가능 여부와 네이버에서 실제 참여 가능한 분야는 구분합니다.
- ‘미참여’와 순위는 마지막 개인 수집 데이터 기준입니다. 총개수를 확인할 수 없거나 일부만 저장한 데이터는 ‘기록 없음’으로 표시합니다.
