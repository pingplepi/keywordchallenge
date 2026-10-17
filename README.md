# 키챌 대시보드

네이버 인플루언서 키워드 챌린지 순위 데이터를 계정별로 저장하는 정적 웹앱입니다. 브라우저에서 계정을 만들고 로그인하며, Supabase Auth와 RLS를 통해 각 계정의 데이터가 분리됩니다.

## 포함 기능

- 이메일/비밀번호 계정 생성과 로그인
- 로그인한 계정의 인플루언서별 키챌 데이터 저장
- 키워드 검색, 순위 필터, 정렬
- JSON 백업 내보내기와 가져오기
- 브라우저에서 실행하는 네이버 수집기와 일회성 결과 전달

## 1. Supabase 설정

1. 본인 Supabase 조직에서 새 프로젝트를 만듭니다.
2. SQL Editor에서 [`supabase/migrations/202610170001_init_keychallenge.sql`](supabase/migrations/202610170001_init_keychallenge.sql)을 실행합니다.
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
