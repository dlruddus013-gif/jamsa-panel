# BLE 출퇴근 시스템 적용 메모

**적용일:** 2026-05-19
**소스 ZIP:** `files - 2026-05-19T222931.828.zip`
**원본 파일:** `02_출퇴근화면_다크.html` + `잠사_출퇴근시스템_v2_다크테마.zip`

---

## ✅ 추가/변경된 파일

| 위치 | 내용 |
|---|---|
| `public/attendance.html` | 다크 테마 출퇴근 화면 (Supabase v2 CDN 사용 단일 HTML) |
| `supabase/staff_seed.sql` | 직원 명단 일괄 등록 SQL (UPSERT, 부서/비콘/비자 포함) |
| `vercel.json` | `/attendance` → `/attendance.html` rewrite 추가 |
| `docs/CLAUDE_CODE_SESSION_GUIDE.md` | Claude Code 세션 이어붙이기 가이드 (참고용) |
| `docs/ATTENDANCE_APPLY_NOTES.md` | 이 문서 |

---

## 🚀 배포 후 접근 URL

```
https://jamsa-panel.vercel.app/attendance
```

처음 1회만 우측 상단에서 Supabase ANON KEY 입력 → 이후 브라우저 localStorage 에 저장.

> URL 은 이미 `https://ewxquecxsxsfhyzfaaci.supabase.co` 로 채워져 있음.

---

## 📋 사전 준비 (DB 스키마)

이미 적용되어 있어야 하는 테이블/뷰:

- `public.staff` — 직원 마스터
- `public.attendance` — 출퇴근 기록
- `public.beacon_dept` — 부서 마스터 (관리부 / 시설부 / 외국인)
- `public.absence_records` — 결근 기록
- `public.v_attendance_today` — 오늘 출퇴근 뷰
- `public.v_foreign_workers` — 외국인 직원 비자 뷰
- `public.v_work_hours` — 근무시간 집계 뷰
- `public.v_daily_summary` — 일별 요약 뷰

> 이전 세션에서 `20260520_all_in_one.sql` 로 적용 완료 상태로 가정.

---

## 🧑‍💼 직원 등록 절차

1. `supabase/staff_seed.sql` 열기
2. INSERT VALUES 의 7명 예시 → 실제 직원 정보로 교체
3. Supabase SQL Editor:
   https://supabase.com/dashboard/project/ewxquecxsxsfhyzfaaci/sql/new
4. 붙여넣기 → Run
5. `/attendance` 새로고침하면 직원 카드 표시

---

## ⚠️ RLS 주의

`attendance` 테이블에 anon 키로 INSERT 가 안 되면 토스트로 "출근 실패" 뜸.

해결 1) Supabase Dashboard → Authentication → Policies → attendance:
```sql
create policy "anon insert attendance" on public.attendance
  for insert with check (true);
create policy "anon select attendance today" on public.attendance
  for select using (true);
```

해결 2) 내부망 전용이면 RLS 자체 비활성화 (보안 약화 주의).

---

## 🔄 향후 통합 (선택)

- [ ] `source.jsx` 안의 React 네비게이션에 "출퇴근" 메뉴 추가 → 새 탭 또는 iframe 으로 `/attendance` 임베드
- [ ] `attendance.html` 의 setup 화면을 jamsa-panel `/api/config` 자동 호출로 대체 (ANON KEY 입력 생략)
- [ ] `auto_close_stale_attendance` RPC 를 Supabase cron 으로 매일 자정 실행
- [ ] 외국인 비자 만료 임박 시 Ppurio 알림톡 자동 발송
