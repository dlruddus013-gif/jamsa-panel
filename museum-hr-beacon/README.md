# 잠사박물관 BLE 비콘 근태 모듈 (`museum-hr.jsx`)

Eddystone-UID 비콘으로 직원 출입을 자동 기록하는 단일 JSX 모듈.
관리부 / 시설부 / 외국인 노동자(E-9·H-2 비자) 3개 부서 운영 기준.

## 1. 구성

```
museum-hr-beacon/
├── museum-hr.jsx                                # 메인 React 모듈
├── supabase/
│   └── migrations/
│       └── 20260519_beacon_attendance.sql       # 스키마 + RLS
└── README.md
```

## 2. 비콘 페이로드 규격

게이트웨이(Minew G1 · TP-Link Omada 등)가 다음 형태로 POST 해야 함:

```json
{
  "type": "uid",
  "namespace": "00112233445566778899",
  "instance":  "01000000000A",
  "rssi": -67,
  "rssi_at_xm": -59,
  "tm": "2026-05-19T09:01:23+09:00",
  "mac": "C3:00:00:00:00:0A"
}
```

- `namespace` (10 bytes hex, 20 chars) — 박물관 고정값
  `JAMSA_BEACON_NAMESPACE = "00112233445566778899"`
- `instance` (6 bytes hex, 12 chars) →
  - 앞 2자리 = `dept_code` (0x01 관리부 / 0x02 시설부 / 0x03 외국인 / 0x04~0xFF 예비)
  - 뒤 10자리 = `user_uid` (16진수, 사람 ID)

`parseBeaconPayload(json)` 함수가 모든 검증을 수행.

## 3. 설치

### 3.1 React 측

```bash
# 프로젝트 루트에 복사
cp museum-hr.jsx  src/modules/museum-hr.jsx
```

라우터에 추가:

```jsx
import MuseumHr from "@/modules/museum-hr.jsx";

<Route path="/hr" element={<MuseumHr />} />
```

전제: `window.__supabase` 가 Supabase 클라이언트로 초기화돼 있어야 함.

```js
// 앱 진입점
import { createClient } from "@supabase/supabase-js";
window.__supabase = createClient(URL, ANON_KEY);
```

shadcn 의존: `card / button / input / textarea / badge / tabs / select / table`.

### 3.2 Supabase 스키마

```bash
supabase db push   # 또는
psql "$DATABASE_URL" -f supabase/migrations/20260519_beacon_attendance.sql
```

스키마가 자동으로:
- `staff` 테이블에 `beacon_namespace / beacon_instance(UNIQUE) / dept_code / contract_type / visa_*` 추가
- `attendance` 테이블에 `raw_rssi / estimated_distance_m / beacon_mac` 추가
- `beacon_dept` 마스터 + 3개 기본 부서 삽입
- RLS 정책 활성화 (외국인 출근 기록은 관리부만 조회)
- 트리거로 `attendance.dept_code` 자동 채움

### 3.3 게이트웨이 → Supabase 적재

게이트웨이가 직접 Supabase REST에 푸시하거나, `minew-server` 에서
정규화 후 `attendance` insert 호출. service_role 키로 RLS 우회.

```js
// 예시 — minew-server adapter
await supa.from("attendance").insert({
  staff_id:             resolved.id,
  beacon_mac:           e.beacon_mac,
  beacon_namespace:     e.namespace,
  beacon_instance:      e.instance,
  raw_rssi:             e.rssi,
  estimated_distance_m: estimateDistance(e.rssi, e.rssi_at_xm),
  gateway_id:           e.gateway_mac,
});
```

## 4. UI

| 탭 | 기능 |
|----|------|
| 실시간 출근 현황 | 5초 폴링, 부서별 컬러 뱃지 (관리부 ▪ 시설부 ▪ 외국인) |
| 직원 목록      | 부서·계약유형·비콘등록여부 필터 |
| 비콘 등록      | 직원 선택 → 페이로드 붙여넣기 → 자동 파싱 → 등록 |
| 외국인 노동자  | E-9 / H-2 비자 만료일 + 상태 뱃지 (만료 30일 이내 경고) |

## 5. 거리 추정

`estimateDistance(rssi, tx_at_1m=-59)` — 로그 거리 손실 모델

```
ratio = rssi / tx
ratio < 1: d ≈ ratio^10
else:      d = 0.89976·ratio^7.7095 + 0.111
```

벽·간섭이 많은 박물관 환경에서는 ±1.5m 오차 정상.

## 6. 보안

- 외국인 노동자(`dept_code = 3`) 출근/개인정보 → **관리부만 조회**
- 일반 부서 직원 → 본인 + 본인 부서만
- 비콘 등록/수정 → 관리부 전용 (`current_user_is_admin_dept()`)
- `staff.auth_uid` 컬럼으로 Supabase Auth 사용자와 1:1 매칭

## 7. Windows 11 환경 메모

- 게이트웨이는 사내 LAN의 고정 IP에 두고 PC를 24/7 ON
- Supabase URL/Key는 `.env.local` → React 빌드 시 임베드 금지,
  런타임에 `window.__supabase` 주입 권장
- 한국어 폰트가 깨지면 시스템 로케일을 "한국어(대한민국)"으로

## 8. 라이선스 / 문의

내부용. 잠사박물관 IT 담당자에게 문의.
