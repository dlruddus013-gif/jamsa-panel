# 챗봇 듀얼 AI 케이스 스터디 (2026-05-21)

`/api/chatbot` 엔드포인트 Claude + OpenAI 통합 후 24개 박물관 운영 시나리오로 테스트.
원본 데이터: `docs/case-study-output.json` (Before) / `docs/case-study-after.json` (After)

## 발견 (Before)

24/24 모두 consensus 호출. 다음 4가지 문제 발견.

| # | 문제 | 영향 |
|---|---|---|
| 1 | 사실/네비게이션 질문도 consensus 호출 ("재고관리 메뉴 어디?" → 두 모델 호출) | 비용 2배, 응답 8초 |
| 2 | Claude가 사실 질문 9건을 `category: "help"`로 잘못 분류, OpenAI는 정확 | consensus 결과 "disagree" 9건 발생 (가짜 분기) |
| 3 | similarity 평균 0.11 / 최대 0.35 — 한국어 토큰 매칭으로 0.55 임계값에선 "agree" 영원히 0건 | 모든 일치가 "partial"로만 표시 |
| 4 | Claude actions 평균 2.7개 vs OpenAI 1.2개 | OpenAI primary 선택 시 action 부족 |

### Before 분포

```
source: consensus 24건 (100%)
consensus 결과: partial 15 / disagree 9 / agree 0
응답 시간: 평균 7.6초 (max 13.5초)
사실 질문 카테고리 정확도: 1/10 (10%) — 9건이 "help"
```

## 적용한 개선

### A. auto 모드 라우팅 (chatbot.js)
```js
// 네비게이션 키워드 검출 → Claude 단독
isNavQuery = /(어디|메뉴 위치|어느 메뉴|위치\?|에서 (열|봐|확인|보)|어디(서|에|를)|페이지 (어디|위치))/

// 분석 키워드 → consensus
isAnalytical = /(왜|어떻게.*결정|차이|비교|평가|분석|판단|결정|우선순위|어느 게|장단점|선택)/

// 짧은 질문 (<20자) + 분석 키워드 없음 → Claude 단독
```

### B. similarity 임계값 0.55 → 0.30
한국어 답변에서 0.55는 사실상 도달 불가. 0.30이 의미적 일치 식별선.

### C. system prompt 카테고리 가이드 추가
```
8. category 분류는 반드시 모듈명으로. 메뉴 위치 질문이라도 "help"가 아니라:
   - "재고관리 메뉴 어디?" → inventory
   - "안전 캘린더 위치?" → maintenance
   - "CCTV 어디서 켜?" → facility
   - "사고 기록 어디?" → emergency
   - "보고서 어디?" → report
   "help"는 메타 질문(어떤 기능?, 도움말?)에만 사용
```

## After 결과

| 지표 | Before | After | Δ |
|---|---|---|---|
| consensus 호출 비율 | 24/24 (100%) | 11/24 (46%) | **-54%** |
| 사실 질문 카테고리 정확도 | 1/10 (10%) | 10/10 (100%) | **+90pt** |
| 사실 질문 응답 시간 (median) | ~7,600ms | ~4,176ms | **-45%** |
| 분석 질문 consensus 비율 | 100% | 89% (8/9) | 유지 |
| OpenAI API 호출 횟수 | 24 | 11 | **-54%** |

### After 분포

```
source: claude 12 / consensus 11 / error 1
- 사실 질문 10/10 → Claude 단독 (정확한 category)
- 분석 질문 8/9 → consensus (1건 timeout)
- 판단 질문 3/4 → consensus
consensus 결과: partial 10 / disagree 1
similarity: 평균 0.07 (한국어 어휘 다양성 한계)
```

### 사실 질문 카테고리 분류 — 100% 정확

```
Q: 재고관리 메뉴 어디?      → inventory   ✓ (이전 help)
Q: 안전관리 캘린더 어디서?   → maintenance ✓ (이전 help)
Q: 카메라 항시작동 어디서?   → facility    ✓ (이전 help)
Q: 사고 기록 등록 어디?      → emergency   ✓ (이전 help)
Q: AI 자동 일정 어디서?      → maintenance ✓ (이전 help)
Q: 종합 보고 메뉴 어디?      → report      ✓ (이전 help)
Q: 직원 출퇴근 페이지 어디?  → facility    ✓ (이전 help)
Q: OKPOS 매출 동기화 어디?   → report      ✓ (이전 report — 유지)
Q: Tapo 카메라 등록 어디?    → facility    ✓ (이전 help)
Q: 시설 평면도 어디서?       → facility    ✓ (이전 help)
```

## 남은 한계 (향후 과제)

1. **similarity 한국어 한계**: Jaccard 토큰 매칭으로는 의미적 동의 판정 어려움
   - 가능: category + confidence + answer length 결합 점수
   - 또는 임베딩 유사도 (text-embedding-3-small 추가 호출 — 비용 +)

2. **분석 질문 응답 시간 (10초)**: 두 모델 병렬이라 느린 쪽 기준
   - 가능: 5초 timeout 후 빠른 쪽만 사용 + 늦은 응답은 나중에 후처리

3. **timeout 1건 (60초)**: Vercel function maxDuration 도달
   - 가능: AbortController로 30초 cap + 자동 retry

## 권장 운영

- 매일 한 번 자동 케이스 스터디 실행 (Vercel Cron) → 모델/카테고리 분포 모니터링
- `/api/ai-status`에 평균 응답 시간 + 일치율 노출
- consensus disagree 발생 시 텔레그램 알림으로 인간 검토 유도

## 변경 이력

- `a42e6d8` feat: 챗봇 케이스 스터디 결과 반영 (auto 모드 개선)
- `ca9199b` fix: OpenAI 실패 시 Claude로 fallback
- `9e6e4ab` fix: chatbot mode downgrade
- `b0e0ac4` feat: 챗봇 듀얼 AI — Claude + OpenAI 종합 의견 (consensus 모드)
