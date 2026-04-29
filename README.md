# 한국잠사박물관 통합관리 시스템 — Vercel + Supabase

> React 12,550줄 통합관리 시스템을 Supabase Postgres에 영구 저장하고 Vercel에 HTTPS로 배포

## 🎯 아키텍처

```
브라우저 (HTTPS)
    │
    ├─ Vercel Edge: 정적 패널 (HTML + React 빌드)
    └─ Vercel Functions: /api/* (Node.js)
            │
            └─ Supabase
                ├─ Auth (이메일/비밀번호 + JWT)
                ├─ Postgres + RLS (kv_store 테이블)
                ├─ jsonb GIN 인덱스 (고속 검색)
                └─ 감사 로그 (audit_logs)
```

## 🔒 보안 체크리스트

| 영역 | 적용된 보안 |
|------|------------|
| HTTPS | Vercel 자동 (Strict-Transport-Security 헤더) |
| 인증 | Supabase Auth JWT + 세션 자동 갱신 |
| 권한 | Row Level Security + 역할별 (admin/manager/inspector/viewer) |
| API 인증 | 모든 `/api/data/*`에 Bearer 토큰 필수 |
| Rate Limit | IP당 분당 120회 |
| CSP 헤더 | script/style/connect 출처 제한 |
| 입력 검증 | 키 형식 (`jamsa_[a-z0-9_-]+`) + 크기 (5MB) |
| Service Key | 서버 전용, 클라이언트 절대 노출 안 됨 |
| 감사 로그 | 모든 KV_PUT/KV_DELETE 자동 기록 (IP/UA 포함) |
| CORS | ALLOWED_ORIGINS 환경변수로 화이트리스트 |

## 🚀 30분 배포 가이드

### 1단계: Supabase 프로젝트 생성 (5분)

1. [supabase.com](https://supabase.com) 가입 → **New Project**
2. 이름: `jamsa-museum`, Region: **Northeast Asia (Seoul)**, DB 비밀번호 설정
3. 프로젝트 생성 후 좌측 메뉴 → **SQL Editor** → **New Query**
4. `supabase/schema.sql` 전체 복사 → 붙여넣기 → **Run** ▶️
5. 좌측 **Authentication** → **Providers** → **Email** 활성화 (Confirm email 끄면 즉시 가입 가능)

### 2단계: 환경변수 확보 (2분)

좌측 **Project Settings** → **API**에서 복사:

```
SUPABASE_URL              = https://xxxxx.supabase.co
SUPABASE_ANON_KEY         = eyJhbGc... (anon public key)
SUPABASE_SERVICE_ROLE_KEY = eyJhbGc... (service_role secret) ← 절대 GitHub에 올리지 말 것
```

### 3단계: GitHub 저장소 생성 (5분)

```bash
cd jamsa_vercel
git init
git add .
git commit -m "initial: jamsa integrated panel"
git branch -M main
git remote add origin https://github.com/YOUR_USER/jamsa-panel.git
git push -u origin main
```

`.gitignore`에 `.env`가 있으니 시크릿이 올라갈 일 없습니다.

### 4단계: Vercel 배포 (5분)

1. [vercel.com](https://vercel.com) 가입 → **Add New** → **Project**
2. GitHub 저장소 import
3. **Environment Variables** 탭에서 3개 변수 추가:
   ```
   SUPABASE_URL              = (Supabase URL)
   SUPABASE_ANON_KEY         = (anon key)
   SUPABASE_SERVICE_ROLE_KEY = (service role key)
   ORG_ID                    = jamsa
   ```
4. **Deploy** ▶️ — 약 1분 후 `https://your-project.vercel.app` 발급

### 5단계: 첫 사용자 가입 (3분)

1. 배포된 URL 접속 → 로그인 화면
2. **계정 만들기** → 이메일/비밀번호 (8자 이상)
3. 첫 가입자는 자동으로 **admin** 역할 부여 (트리거)
4. Supabase Dashboard → **Authentication** → **Users**에서 확인

### 6단계: 추가 사용자 초대 (선택)

추가 사용자도 같은 화면에서 가입 → 자동 `viewer` 역할.

권한 변경은 Supabase **SQL Editor**에서:

```sql
update memberships set role = 'manager'
where user_id = (select id from auth.users where email = 'user@example.com');
```

역할: `admin` (모두 가능) > `manager` (CRUD 가능) > `inspector` (insert/update만) > `viewer` (read only)

---

## 📁 프로젝트 구조

```
jamsa_vercel/
├── api/
│   ├── data/[key].js        # KV CRUD (GET/PUT/DELETE)
│   ├── keys.js              # 컬렉션 목록
│   ├── search.js            # 검색
│   ├── stats.js             # 통계
│   └── config.js            # 클라이언트 설정 노출
├── lib/
│   └── auth.js              # JWT 검증 + Rate limit + 감사로그
├── public/
│   ├── index.html           # UI
│   └── app.bundle.js        # React 빌드 (자동 생성)
├── supabase/
│   └── schema.sql           # DB 스키마 + RLS + 함수
├── source.jsx               # React 12,550줄 (수정 가능)
├── entry.jsx                # 엔트리 + Supabase Auth
├── package.json
├── vercel.json
├── .env.example
├── .gitignore
└── README.md
```

## 🔧 로컬 개발

```bash
# 1. 설치
npm install

# 2. .env 생성 (env.example 복사 후 값 채우기)
cp .env.example .env

# 3. Vercel CLI로 로컬 실행 (Functions 포함)
npx vercel dev
# → http://localhost:3000

# 또는 빌드만
npm run build
# 정적 패널만 보려면: npx serve public
```

## 🧪 API 테스트

```bash
# 토큰 받기 (Supabase Auth)
TOKEN=$(curl -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"yourpw"}' \
  | jq -r .access_token)

# 데이터 저장
curl -X PUT https://your-project.vercel.app/api/data/jamsa_inv_prods \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '[{"id":"p1","name":"테스트 제품","qty":10}]'

# 데이터 조회
curl https://your-project.vercel.app/api/data/jamsa_inv_prods \
  -H "Authorization: Bearer $TOKEN"

# 검색
curl "https://your-project.vercel.app/api/search?q=테스트" \
  -H "Authorization: Bearer $TOKEN"
```

## 🔐 보안 운영 가이드

### 비밀번호 정책
Supabase Dashboard → Authentication → Policies → Password requirements

### MFA 활성화 (강력 권장)
Authentication → Providers → MFA를 활성화하면 TOTP 가능

### 비밀번호 재설정
사용자가 잊은 경우: 로그인 화면에 "비밀번호 찾기" 추가하거나 SQL로 강제 리셋

### 감사 로그 조회
```sql
select created_at, user_email, action, resource, ip_address
from audit_logs
where org_id = 'jamsa'
order by created_at desc
limit 100;
```

### Service Role Key 유출 시
즉시 Supabase Dashboard → Settings → API → **Reset service_role key** → Vercel 환경변수 갱신 → 재배포

## 📊 데이터 마이그레이션 (기존 localStorage → Supabase)

기존 8899 로컬 패널 사용자가 데이터를 Supabase로 옮기려면:

1. 로컬 패널에서 F12 콘솔 열기
2. `await window.forceSyncToBackend()` 실행 → 로컬 → 8899 백엔드 sync
3. Vercel 배포된 새 URL 접속 → 로그인 → F12 콘솔
4. localStorage에 같은 jamsa_* 데이터를 채운 후 페이지 새로고침
   → entry.jsx의 `localStorage.setItem` hook이 자동으로 Supabase로 push

또는 `data/jamsa_*.json` 파일들을 직접 Supabase에 INSERT:

```sql
insert into kv_store (org_id, key, value)
values ('jamsa', 'jamsa_inv_prods', '[...JSON 내용...]'::jsonb)
on conflict (org_id, key) do update set value = excluded.value;
```

## 🐛 트러블슈팅

| 증상 | 원인 / 해결 |
|------|-----|
| 401 missing_token | 로그아웃 상태 — 다시 로그인 |
| 403 not_a_member | memberships 테이블에 사용자 없음 — `handle_new_user()` 트리거 동작 확인 |
| 403 insufficient_role | 역할 권한 부족 — SQL로 role 업그레이드 |
| 429 rate_limit_exceeded | 분당 120회 초과 — 1분 대기 또는 lib/auth.js의 RATE_MAX 조정 |
| RLS infinite recursion | RLS 정책 재귀 — schema.sql 재실행 |
| Vercel 빌드 실패 | npm install 실패 — Node 버전 18+ 확인 |
| 검색 결과 없음 | jsonb GIN 인덱스 미생성 — schema.sql 재실행 |

## 📦 정적 패널만 빠르게 미리보기

```bash
npm run build
npx serve public -p 3000
# http://localhost:3000 (단, /api/* 동작 안 함 — Vercel CLI 필요)
```
