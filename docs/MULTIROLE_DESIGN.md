# 다중 이해관계자 인터페이스 — 설계 문서

> 버전: v1 (draft)
> 작성일: 2026-05-21
> 범위: 직원·팀장·관리자·대표·노무사·고객 6역할의 권한 분리 시스템

---

## 0. 설계 원칙

> **"볼 수 있는 사람"과 "봐야 하는 정보"를 분리한다.**

| 원칙 | 의미 |
|---|---|
| Privacy by default | 정밀 위치는 기본 미노출. 사유 입력 + 접근 로그 필수 |
| Need-to-know | 각 역할이 *직무 수행에 필요한* 데이터만 본다 |
| Auditable | 모든 민감 데이터 접근은 영구 로그로 추적 가능 |
| Defense in depth | 화면 분리 + API 권한 + DB(RLS) 3중 방어 |
| Consent-driven | 직원 동의 없으면 GPS·BLE 수집 즉시 중단 |
| Legal compliance | 위치정보법, 근로기준법, 개인정보보호법 명시 반영 |

---

## 1. 역할 정의

| 역할 키 | 역할명 | 직무 핵심 | 정밀 위치 |
|---|---|---|---|
| `staff`    | 직원   | 본인 출퇴근·정정·동의 관리 | 본인만 |
| `lead`     | 팀장   | 팀 운영 보드·예외 처리·근무표 | 미노출 (필요 시 관리자에게 요청) |
| `admin`    | 관리자 | 운영 예외 처리·권한 관리 | **사유 + 로그 후 열람** |
| `ceo`      | 대표   | 집계 KPI·리스크·컴플라이언스 | 미노출 (개인 단위 절대 금지) |
| `lawyer`   | 노무사 | 동의 이력·접근 로그·보존·감사 | 미노출 (로그만 조회) |
| `customer` | 고객   | 서비스 진행 상태 | 절대 미노출 |

### 1.1 권한 매트릭스

| 정보 항목 | 직원 | 팀장 | 관리자 | 대표 | 노무사 | 고객 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| 본인 출퇴근 상태 | ✓ | ✓ | ✓ | – | ✓ | – |
| 팀원 출퇴근 상태 | – | ✓ | ✓ | – | ✓ | – |
| 직원 실명 | 본인 | 팀원 | ✓ | – | ✓ | – |
| 익명 ID (`E-XXXX`) | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| 정밀 GPS 좌표 | 본인 | – | ⚠️ 사유 | – | – | – |
| 이동 경로 | – | – | ⚠️ 사유 | – | – | – |
| 집계 KPI | – | 팀 단위 | ✓ | ✓ | ✓ | – |
| 접근 로그 | – | – | ✓ | – | ✓ | – |
| 동의 이력 (직원) | 본인 | – | 요약 | – | ✓ | – |
| 서비스 진행 상태 (익명) | – | ✓ | ✓ | ✓ | ✓ | ✓ |

범례: ✓=항상, ⚠️=사유 입력 + 로그 필수, –=불가

---

## 2. 파일·디렉토리 구조 권장안

### 2.1 현 상태
- `source.jsx` (1.7MB) — 모든 React 컴포넌트 한 파일에 혼재
- `staff-checkin.html` / `staff-checkin-v2.html` — 직원용 모바일 페이지 (정적 HTML)
- `lib/auth.js` — `memberships.role` 검증 (admin|manager|inspector|viewer)

### 2.2 목표 구조

```
src/
  roles/
    staff/          # 직원 화면 (모바일 PWA 포함)
    lead/           # 팀장 화면 (예외 처리 큐)
    admin/          # 관리자 화면 (현 통합 대시보드 분리)
    ceo/            # 대표 화면 (KPI/리스크 전용)
    lawyer/         # 노무사 화면 (감사용)
    customer/       # 고객 포털 (서비스 상태만)
  shared/
    components/     # 권한 매트릭스, 사유 입력 모달, 동의 모달 등
    permissions/    # 권한 체크 헬퍼 (canViewPreciseLocation 등)
    anon/           # 익명 ID 발급·해제
  guards/
    RoleGate.jsx    # 역할별 라우트 보호
public/
  staff/            # 직원 PWA (현 staff-checkin.html 이전)
  customer/         # 고객 포털 (직원 자산과 완전 분리)
```

### 2.3 단기(Phase 1) 절충안 — source.jsx 분할 없이 진행
파일 분할은 큰 작업이라, **단기에는 source.jsx 내부에 새 컴포넌트만 추가**하고 `currentRole` 분기로 표시. 데모(`multirole-demo.html`)에서 검증된 UI를 그대로 옮김.

```
source.jsx 끝부분에 추가:
  function StaffOwnView({ userCtx })   { ... }   // 직원
  function TeamLeadView({ userCtx })    { ... }   // 팀장
  function CeoDashboard({ userCtx })    { ... }   // 대표
  function LawyerAuditView({ userCtx }) { ... }   // 노무사
  function CustomerPortal({ token })    { ... }   // 고객 (별도 라우트)

  // 현 IntegratedHomeDashboard = '관리자' 화면으로 분류
```

---

## 3. 데이터베이스 스키마 추가

기존 `memberships.role`은 `admin|manager|inspector|viewer` 4종. 6역할 대응 위해 확장.

### 3.1 `memberships.role` 확장

```sql
-- 기존 CHECK 제약 교체
alter table public.memberships drop constraint if exists memberships_role_check;
alter table public.memberships add constraint memberships_role_check
  check (role in ('staff','lead','admin','ceo','lawyer','customer'));

-- 기존 데이터 마이그레이션 (1회만)
update public.memberships set role = 'admin'   where role = 'admin';
update public.memberships set role = 'lead'    where role = 'manager';
update public.memberships set role = 'staff'   where role in ('inspector','viewer');
```

### 3.2 동의 기록 (`consent_records`)

```sql
create table if not exists public.consent_records (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.organizations(id),
  staff_id uuid not null references auth.users(id) on delete cascade,
  consent_version text not null,           -- 'v3.2' 등
  consent_text_hash text not null,         -- 동의 문구 SHA-256 (변조 방지)
  scope jsonb not null,                    -- ['gps','ble','work_hours_only']
  agreed_at timestamptz not null default now(),
  agreed_ip inet,
  agreed_user_agent text,
  withdrawn_at timestamptz,                -- 철회 시 채워짐
  withdraw_reason text,
  created_at timestamptz default now()
);

create index consent_records_staff_idx on public.consent_records (staff_id, agreed_at desc);
```

### 3.3 정밀 위치 접근 로그 (`location_access_log`)

```sql
create table if not exists public.location_access_log (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.organizations(id),
  accessed_at timestamptz not null default now(),
  actor_user_id uuid not null references auth.users(id),
  actor_role text not null,
  target_staff_id uuid not null references auth.users(id),
  reason_category text not null,           -- 'BLE_DEBUG','EMERGENCY','PAYROLL_VERIFY','CUSTOMER_ISSUE'
  reason_detail text not null check (char_length(reason_detail) >= 50),
  legal_basis text not null,
  data_returned jsonb,                     -- 무슨 데이터를 보여줬는지
  ip inet,
  user_agent text
);

create index lal_target_idx on public.location_access_log (target_staff_id, accessed_at desc);
create index lal_actor_idx  on public.location_access_log (actor_user_id, accessed_at desc);

-- 영구 보존 (RLS로 update/delete 차단)
```

### 3.4 정정 요청 (`attendance_corrections`)

```sql
create table if not exists public.attendance_corrections (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.organizations(id),
  staff_id uuid not null references auth.users(id),
  date date not null,
  field text not null check (field in ('check_in','check_out','break_time')),
  value_before time,
  value_after time not null,
  reason text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  reviewed_note text,
  created_at timestamptz default now()
);
```

### 3.5 고객 서비스 세션 (`service_sessions`)

```sql
-- 고객용 익명 토큰. 직원 ID 대신 이걸로만 조회 가능
create table if not exists public.service_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.organizations(id),
  customer_org text not null,              -- '청주시 시설관리공단'
  site_name text not null,                 -- '한국잠사박물관'
  scheduled_at timestamptz not null,
  scheduled_duration_min int not null,
  assigned_staff_count int default 0,      -- 인원 수만, 누구인지는 미공개
  status text not null default 'scheduled' -- scheduled/arrived/started/completed/delayed
    check (status in ('scheduled','arrived','started','completed','delayed','cancelled')),
  delay_min int default 0,
  issue_count int default 0,
  customer_view_token text unique not null  -- 고객이 이 토큰으로만 조회
);
```

---

## 4. Row Level Security (RLS) 정책

DB 레벨에서 권한 강제. 화면에서 빼먹어도 DB가 막아야 함.

### 4.1 staff_locations (정밀 위치) — 가장 민감

```sql
alter table public.staff_locations enable row level security;

-- 본인은 본인 위치 조회 가능
create policy "staff_own_location" on public.staff_locations
  for select using (auth.uid() = staff_id);

-- 관리자는 location_access_log에 사유 기록 후에만 (앱 코드에서 강제)
-- DB 레벨로는 admin 역할이면 SELECT 가능, 단 트리거로 access_log 자동 기록
create policy "admin_with_log" on public.staff_locations
  for select using (
    exists (
      select 1 from public.memberships m
      where m.user_id = auth.uid()
        and m.org_id = staff_locations.org_id
        and m.role in ('admin','lawyer')
    )
  );

-- INSERT/UPDATE/DELETE: 본인 또는 서버 service-role만
create policy "staff_own_insert" on public.staff_locations
  for insert with check (auth.uid() = staff_id);
```

### 4.2 location_access_log — 영구 보존

```sql
alter table public.location_access_log enable row level security;

-- 관리자·노무사는 조회 가능
create policy "audit_read" on public.location_access_log
  for select using (
    exists (select 1 from public.memberships m
            where m.user_id = auth.uid() and m.role in ('admin','lawyer'))
  );

-- INSERT는 service-role만 (앱 서버에서 직접 기록)
-- UPDATE/DELETE는 누구도 못함 (영구 보존)
revoke update, delete on public.location_access_log from public, authenticated;
```

### 4.3 consent_records

```sql
alter table public.consent_records enable row level security;

-- 본인은 본인 동의 이력 조회
create policy "consent_own" on public.consent_records
  for select using (auth.uid() = staff_id);

-- 관리자·노무사는 전체 조회
create policy "consent_audit" on public.consent_records
  for select using (
    exists (select 1 from public.memberships m
            where m.user_id = auth.uid() and m.role in ('admin','lawyer'))
  );

-- 철회는 본인만
create policy "consent_withdraw" on public.consent_records
  for update using (auth.uid() = staff_id)
  with check (auth.uid() = staff_id and withdrawn_at is not null);
```

### 4.4 attendance_corrections

```sql
alter table public.attendance_corrections enable row level security;

-- 본인 요청 조회 + 작성
create policy "corr_own" on public.attendance_corrections
  for all using (auth.uid() = staff_id)
  with check (auth.uid() = staff_id);

-- 팀장은 팀원 요청 조회
create policy "corr_lead" on public.attendance_corrections
  for select using (
    exists (select 1 from public.memberships m1
            join public.memberships m2 on m1.org_id = m2.org_id and m1.dept = m2.dept
            where m1.user_id = auth.uid() and m1.role = 'lead'
              and m2.user_id = attendance_corrections.staff_id)
  );

-- 관리자는 전체 + 승인
create policy "corr_admin" on public.attendance_corrections
  for all using (
    exists (select 1 from public.memberships m
            where m.user_id = auth.uid() and m.role = 'admin')
  );
```

### 4.5 service_sessions (고객용)

```sql
-- 고객은 customer_view_token으로만 익명 조회
-- → 별도 PostgREST 함수 또는 API endpoint로 처리, RLS는 staff용
```

---

## 5. 라우팅·인증 가드

### 5.1 역할별 진입점

| URL | 대상 역할 | 비고 |
|---|---|---|
| `/` (`index.html` → React) | admin, lead | 기본 대시보드 + 역할별 분기 |
| `/m`, `/staff-checkin` | staff | 모바일 PWA |
| `/ceo` | ceo | KPI 전용 |
| `/lawyer` | lawyer | 감사 전용 |
| `/customer/:token` | customer | 토큰 기반 익명 |
| `/roles` (현 데모) | 모두 | 시연용 |

### 5.2 권한 가드 헬퍼 (`shared/permissions/`)

```js
// shared/permissions/canDo.js
export const PERMISSIONS = {
  view_own_location:          ['staff','admin','lawyer'],
  view_team_attendance:       ['lead','admin','lawyer'],
  view_precise_location:      ['admin'],        // ⚠️ 사유 + 로그 필수
  approve_correction:         ['admin'],
  view_aggregate_kpi:         ['lead','admin','ceo','lawyer'],
  view_access_log:            ['admin','lawyer'],
  view_consent_records:       ['admin','lawyer'],
  view_anonymous_progress:    ['lead','admin','ceo','lawyer','customer'],
  generate_audit_package:     ['lawyer'],
};

export function canDo(role, action) {
  return (PERMISSIONS[action] || []).includes(role);
}
```

### 5.3 정밀 위치 열람 — 서버 미들웨어

```js
// api_handlers/precise-location.js
export async function handlePreciseLocationView(req, res) {
  const ctx = await requireAuth(req, res);
  if (!ctx) return; // requireAuth가 401 응답함

  // 역할 체크
  if (!canDo(ctx.role, 'view_precise_location')) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const { targetStaffId, reasonCategory, reasonDetail, legalBasis } = req.body;
  if (!reasonDetail || reasonDetail.length < 50) {
    return res.status(400).json({ error: 'reason_too_short' });
  }

  // 1) 접근 로그 INSERT (먼저!)
  await supabaseSvc.from('location_access_log').insert({
    actor_user_id: ctx.user.id,
    actor_role: ctx.role,
    target_staff_id: targetStaffId,
    reason_category: reasonCategory,
    reason_detail: reasonDetail,
    legal_basis: legalBasis,
    ip: req.headers['x-forwarded-for'],
    user_agent: req.headers['user-agent'],
  });

  // 2) 위치 조회
  const { data } = await supabaseSvc.from('staff_locations')
    .select('*').eq('staff_id', targetStaffId)
    .order('captured_at', { ascending: false }).limit(1);

  res.json({ location: data });
}
```

---

## 6. 법적 컴플라이언스 매핑

| 법령·조항 | 시스템 적용 위치 |
|---|---|
| **위치정보법 제18조** (개인위치정보 수집·이용·제공 동의) | `consent_records` 테이블 + 동의 모달에 6개 필수 항목 명시 |
| **위치정보법 제16조** (관리적 보호조치 — 취급자 지정·접근 통제·로그) | `location_access_log` 5년 보존 + RLS로 UPDATE/DELETE 차단 |
| **위치정보법 제24조** (사후 정보 제공·열람·정정 요구권) | 직원 화면에서 본인 동의 이력·위치 이력 조회 가능 |
| **근로기준법 제42조** (근로자 명부·계약 서류 3년 보존) | `memberships` + `attendance_corrections` 백업 정책 |
| **근로기준법 제48조** (임금대장 작성·보존) | 별도 임금대장 모듈 (현 범위 외) |
| **개인정보보호법 제29조** (안전조치 의무) | RLS + service-role 키 서버 전용 + 정밀 좌표 90일 후 파기 |

### 6.1 동의 문구 필수 항목 (v3.2)

1. 수집 항목: GPS 좌표, BLE 신호, 디바이스 ID
2. 수집 목적: 출퇴근 자동 인식, 근무지 이탈 방지, 비상 안전
3. 수집 시간: 근무 시작 1시간 전 ~ 종료 30분 후
4. 보유 기간: 원본 90일 / 집계 3년
5. 제3자 제공: 없음 (고객사에는 익명화 후)
6. 동의 거부 시 불이익: 없음 (수동 출근 대체)

---

## 7. 구현 단계 (Phasing)

8개 우선순위를 4 phase로 묶음.

### Phase 1 — 권한 분리 골격 (1주) ✅ 완료
**목표: 데모를 실제 코드에 통합. 권한 가드 동작.**
- ✅ `memberships.role` 6역할 마이그레이션 — `supabase/multirole_phase1.sql`
- ✅ `lib/auth.js`에 `normalizeRole()` + `canDo()` + `PERMISSIONS` 매트릭스
- ✅ `source.jsx`에 `normalizeRole6()` + 6색 역할 배지
- ✅ 현 통합 대시보드 = staff/lead/admin 진입점 (ceo/lawyer는 우회)
- ✅ `CeoDashboard` + `LawyerAuditView` 컴포넌트 신규
- ✅ 고객 포털 정적 페이지 `public/customer-portal.html` (Tier 1 + Tier 2 골격)
- ⏳ 사용자 작업: Supabase에서 `multirole_phase1.sql` 실행

### Phase 2 — 정밀 위치 접근 통제 (1주) ✅ 코드 작성 완료
**목표: 우선순위 3·4 (사유 입력 + 로그)**
- ✅ `location_access_log` 테이블 + RLS — `supabase/multirole_phase2.sql`
- ✅ `/api/precise-location` 엔드포인트 — `api_handlers/precise-location.js`
  · 사유 50자 검증 / category 5종 enum / 법적 근거 필수 / 로그 INSERT 먼저
- ✅ admin 사용자 클릭 팝업에 "정밀 위치 열람" 버튼 — `source.jsx`
- ✅ `PreciseLocationModal` 컴포넌트 (글자수 카운터 + 권한 가드)
- ✅ staff_locations RLS 보강 (본인 + admin/lawyer)
- ⏳ 사용자 작업: Supabase에서 `multirole_phase2.sql` 실행
- ⏳ 클라이언트의 직접 좌표 표시(L25987) 마스킹 — Phase 5

### Phase 3 — 동의·정정·고객 (2주) ✅ 코드 작성 완료
**목표: 우선순위 5·6**
- ✅ `consent_records` 테이블 + RLS (본인/admin/lawyer)
- ✅ `consent_text_hash` SHA-256 — 동의 문구 변조 방지
- ✅ ConsentModal v3.2 (6항목 + scope 선택)
- ✅ `attendance_corrections` + RLS (본인/lead 팀/admin 전체)
- ✅ CorrectionRequestModal + admin 승인 API
- ✅ `service_sessions` + `customer_otp_log` + `customer_org_members` (Tier 1·2·3)
- ✅ `get_session_by_token(text)` RPC (security definer, 90일 만료)
- ✅ customer-portal.html 실 API 연동 + 이슈 신고 POST
- ⏳ 일일 익명화 리포트 자동 발송 — Phase 4·5 인프라
- ⏳ 사용자 작업: Supabase에서 multirole_phase3.sql 실행

### Phase 4 — 감사·노무사 (1주) ✅ 코드 작성 완료
**목표: 우선순위 7·8**
- ✅ 노무사 화면 — `/api/audit-data` 실 DB fetch (consent/access/correction/retention/stats)
- ✅ `/api/audit-package` — JSON 페이로드 + SHA-256 해시 + audit_package_log INSERT
- ✅ `lawyer_recipients` + `audit_package_log` 테이블 + RLS
- ✅ dryRun 미리보기 / 실제 생성 분리
- ✅ `purge_expired_locations()` PostgreSQL 함수 — 90일 후 좌표 파기
- ✅ `scripts/retention_cron.mjs` — 외부 스케줄러용 cron 스크립트
- ⏳ 메일 발송 워커 (delivery_status=pending 픽업) — 별도 인프라
- ⏳ 사용자 작업: Supabase에서 multirole_phase4.sql 실행

---

## 8. 마이그레이션 전략

### 8.1 기존 사용자 영향 최소화
- 1단계: `memberships.role` 마이그레이션 SQL 실행 (영향 없음, role 매핑)
- 2단계: 신규 컬럼/테이블 추가 (DDL only, 데이터 영향 없음)
- 3단계: 화면 분기 추가 (기존 admin은 그대로 보임)
- 4단계: RLS 정책은 staging에서 충분히 검증 후 적용 (RLS 잘못 걸면 전체 다운)

### 8.2 롤백 플랜
- 각 phase commit을 revert 가능한 단위로
- RLS 정책은 `drop policy` 로 즉시 제거 가능
- `memberships.role` 마이그레이션은 백업 후 진행

### 8.3 테스트 시나리오
- 각 역할로 로그인 → 화면 정상 표시 확인
- staff 역할로 admin URL 접근 → 403
- admin이 사유 없이 정밀 위치 API 호출 → 400
- 사유 50자 미만 → 400
- 정상 사유 → 200 + `location_access_log` row 생성 확인
- lawyer가 로그 조회 → 모든 row 보임
- staff 본인이 본인 로그 조회 → 본인 관련만 보임

---

## 9. 의사결정 사항 (확정 — 2026-05-21)

| # | 항목 | 결정 |
|---|---|---|
| 1 | **고객 포털 인증** | **하이브리드** — 토큰 URL(기본) + OTP(민감 정보) + 정식 고객 계정(요청 시) **모두 지원** → §11.1 |
| 2 | 익명 ID (`E-XXXX`) 생성 규칙 | hashids 라이브러리 (staff_id seed, 박물관 단위 salt) |
| 3 | 정밀 위치 캐시 TTL | 매번 DB 조회 (추적성 우선, 캐시 X) |
| 4 | **노무사 계정 발급** | **하이브리드** — 외부 노무법인 직접 계정(실시간) + 정기 감사 패키지(자동 발송) **모두 지원** → §11.2 |
| 5 | CEO 화면 접근 시간 제한 | 차단 없음. 단, 업무시간 외 접근은 `audit_logs`에 별도 표시 |
| 6 | 감사 패키지 암호화 | zip 패스워드(기본) + 노무사 공개키 암호화(요청 시) — 둘 다 지원 |

---

## 10. 참고

### 10.1 관련 파일
- 데모: `public/multirole-demo.html` (`/roles`)
- 기존 인증: `lib/auth.js`
- 기존 스키마: `schema.sql`, `supabase/staff_*.sql`
- 기존 대시보드: `source.jsx` (`IntegratedHomeDashboard`)

### 10.2 외부 자료 (검증 필요)
- 위치정보법 시행령 동의 양식
- 한국인터넷진흥원(KISA) 개인위치정보 처리 가이드라인
- 노무사 협회 표준 근태 시스템 점검 체크리스트

### 10.3 다음 액션
설계 문서 검토 후 합의되면 **Phase 1** 부터 실제 코드 작업 시작.

---

## 11. 하이브리드 구조 상세 설계

> §9에서 "둘 다 가능"으로 결정된 항목의 구체 구현.

### 11.1 고객 포털 — 3단계 인증 동시 지원

**한 시스템에서 3가지 진입 경로를 모두 지원.** 고객사 상황에 맞게 선택.

```
                ┌─────────────────────────────────────────┐
                │     /customer/:token                    │
                │  (모든 진입 공통 시작점)                │
                └────────────────┬────────────────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
       ┌──────────┐       ┌──────────┐       ┌──────────┐
       │ Tier 1   │       │ Tier 2   │       │ Tier 3   │
       │ 토큰만   │       │ + OTP    │       │ 정식 계정│
       └──────────┘       └──────────┘       └──────────┘
       익명·즉시           민감 정보 조회       다회 방문·이력
       (기본)              시 1회 인증          관리 필요 시
```

#### Tier 1 — 토큰 URL만 (기본)
- 가장 간편. 링크만 클릭하면 진행 상태 확인 가능.
- 노출되는 정보: 도착/진행/완료, 익명 인원수, 지연 여부
- 별도 인증 없음. 토큰 자체가 인증.
- 토큰은 서비스 세션 1건당 발급, 90일 후 자동 만료.

#### Tier 2 — 토큰 + 이메일 OTP (민감 정보 열람 시 트리거)
- Tier 1 화면에서 "상세 리포트", "현장 사진", "이슈 상세" 등을 누르면 OTP 모달.
- 등록된 고객 이메일로 6자리 코드 발송, 10분 유효.
- 인증 후 같은 세션 동안은 재인증 없음.
- 사용 시나리오: 청주시 시설관리공단이 작업 결과 보고서를 보고 싶을 때.

#### Tier 3 — 정식 고객 계정 (요청 시 발급)
- 단골·다회 방문 고객사용. 로그인 후 모든 과거 세션 이력 조회.
- `memberships.role = 'customer'` 사용 (이미 §3.1에 포함).
- 본인 고객사가 발주한 세션만 보임 (RLS).

#### 스키마 추가

```sql
-- service_sessions 에 OTP 발송 대상 이메일 추가
alter table public.service_sessions add column if not exists
  customer_contact_email text;

-- OTP 발송 기록 (Tier 2)
create table if not exists public.customer_otp_log (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.service_sessions(id) on delete cascade,
  email text not null,
  code_hash text not null,                  -- SHA-256 (평문 저장 금지)
  purpose text not null,                    -- 'detail_view','photo_view'
  sent_at timestamptz default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  attempts int default 0
);
create index customer_otp_session_idx on public.customer_otp_log (session_id, sent_at desc);

-- 정식 고객 계정 ↔ 고객사 매핑 (Tier 3)
create table if not exists public.customer_org_members (
  user_id uuid references auth.users(id) on delete cascade,
  customer_org text not null,               -- service_sessions.customer_org 와 매칭
  is_primary boolean default false,
  created_at timestamptz default now(),
  primary key (user_id, customer_org)
);
```

#### RLS — service_sessions 고객 조회

```sql
alter table public.service_sessions enable row level security;

-- Tier 3: 로그인한 고객 계정은 본인 고객사 세션만
create policy "customer_account_view" on public.service_sessions
  for select using (
    exists (
      select 1 from public.customer_org_members com
      where com.user_id = auth.uid()
        and com.customer_org = service_sessions.customer_org
    )
  );

-- Tier 1·2: 토큰 기반 조회는 RPC 함수로 (auth 없이 호출)
create or replace function public.get_session_by_token(p_token text)
returns table (id uuid, status text, delay_min int, assigned_staff_count int, scheduled_at timestamptz)
language sql security definer as $$
  select id, status, delay_min, assigned_staff_count, scheduled_at
  from public.service_sessions
  where customer_view_token = p_token
    and created_at > now() - interval '90 days';
$$;

-- Tier 2: 상세 RPC 는 OTP 검증 후에만 server-side 에서 호출
```

### 11.2 노무사 접근 — 실시간 + 정기 패키지 동시 운영

**둘 다 운영.** 노무법인 사정에 따라 선택 가능.

```
   ┌──────────────────────────────┐
   │     노무사 접근 통로 2가지   │
   └───────────┬──────────────────┘
               │
       ┌───────┴───────┐
       ▼               ▼
   ┌────────┐    ┌────────────────┐
   │실시간  │    │정기 패키지      │
   │대시보드│    │(월 1회 자동)    │
   └────────┘    └────────────────┘
   웹 로그인      이메일 첨부 zip
   상시 조회      오프라인 보관
```

#### 경로 A — 실시간 대시보드 (외부 노무법인 계정 직접 발급)
- `memberships.role = 'lawyer'` 계정을 노무법인 담당자에게 발급.
- 시한부 토큰 옵션: `memberships.expires_at` 컬럼 추가, 계약 종료 시 자동 만료.
- 접근 시 매번 본인의 행위도 `audit_logs`에 기록 (감시자도 감시받음).
- 사용 시나리오: 분쟁 발생 시 즉시 들어와서 조사.

#### 경로 B — 정기 감사 패키지 (자동 발송)
- 매월 1일 새벽 03:00 cron 으로 전월 감사 패키지 생성.
- 포함: `consent_records`, `location_access_log`, `attendance_corrections`, `audit_logs` JSON + 요약 PDF + 무결성 해시.
- zip 패스워드(기본) 또는 노무사 공개키 암호화(옵션) 후 등록 이메일로 발송.
- 노무사가 별도 시스템 접근 없이도 오프라인 보관·검토 가능.
- 사용 시나리오: 정기 점검 / 노동청 자료 제출 / 분쟁 예방 검토.

#### 스키마 추가

```sql
-- 시한부 멤버십 (경로 A)
alter table public.memberships add column if not exists
  expires_at timestamptz;

-- 경로 B 발송 기록
create table if not exists public.audit_package_log (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.organizations(id),
  period_start date not null,
  period_end date not null,
  generated_at timestamptz default now(),
  recipient_email text not null,
  encryption_method text not null check (encryption_method in ('zip_password','pgp_pubkey')),
  package_sha256 text not null,             -- 발송본 무결성 증명
  delivered_at timestamptz,
  delivery_status text,                     -- 'sent','failed','bounced'
  unique (org_id, period_start, recipient_email)
);

-- 노무사 공개키 보관 (PGP 옵션)
create table if not exists public.lawyer_recipients (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.organizations(id),
  name text not null,
  email text not null,
  pgp_public_key text,                      -- 있으면 PGP, 없으면 zip 패스워드
  zip_password_hint text,                   -- 패스워드 전달 방법 메모
  active boolean default true,
  created_at timestamptz default now()
);
```

#### Cron 작업 (경로 B)

```js
// scripts/monthly_audit_package.js
// 매월 1일 03:00 실행 (vercel cron 또는 GitHub Actions)
async function generateMonthlyPackage(orgId, periodStart, periodEnd) {
  const data = {
    consent_records: await fetchConsentRecords(orgId, periodStart, periodEnd),
    location_access_log: await fetchAccessLog(orgId, periodStart, periodEnd),
    attendance_corrections: await fetchCorrections(orgId, periodStart, periodEnd),
    audit_logs: await fetchAuditLogs(orgId, periodStart, periodEnd),
  };
  const json = JSON.stringify(data, null, 2);
  const summary = await renderSummaryPdf(data);
  const hash = sha256(json + summary);

  for (const recipient of await fetchActiveLawyers(orgId)) {
    const pkg = recipient.pgp_public_key
      ? await encryptPgp([json, summary], recipient.pgp_public_key)
      : await zipWithPassword([json, summary], generatePassword());
    await sendEmail(recipient.email, pkg);
    await logDelivery(orgId, periodStart, recipient.email, hash);
  }
}
```

### 11.3 Phase 영향

§7 phase 계획 업데이트:

- **Phase 3** — `customer_otp_log`, `customer_org_members`, `get_session_by_token` RPC 추가. 고객 포털을 3 tier 모두 지원하는 UI로 구현.
- **Phase 4** — `audit_package_log`, `lawyer_recipients` 추가. 월간 cron 스크립트 작성. 노무사 화면에서 본인 계정 정보 + 발송된 패키지 이력 동시 확인.

추가 작업량: 각 phase에 약 2~3일 추가 (총 1주 정도 phase 3·4 길어짐).

---

## 10. 참고

### 10.1 관련 파일
- 데모: `public/multirole-demo.html` (`/roles`)
- 기존 인증: `lib/auth.js`
- 기존 스키마: `schema.sql`, `supabase/staff_*.sql`
- 기존 대시보드: `source.jsx` (`IntegratedHomeDashboard`)

### 10.2 외부 자료 (검증 필요)
- 위치정보법 시행령 동의 양식
- 한국인터넷진흥원(KISA) 개인위치정보 처리 가이드라인
- 노무사 협회 표준 근태 시스템 점검 체크리스트

### 10.3 다음 액션
설계 문서 검토 후 합의되면 **Phase 1** 부터 실제 코드 작업 시작.
