# Claude Code 세션 이어붙이는 법

## 📍 상황

이전에 Claude Code 터미널에서 `jamsa-panel` 작업하다가 창을 닫았을 때,
또는 새 컴퓨터/새 터미널에서 같은 작업을 이어서 하고 싶을 때 사용합니다.

스크린샷에 보였던 **"세션 재개됨"** 이 바로 이 기능이에요.

---

## 🔧 명령어 3종 세트

### ① 마지막 세션 바로 이어붙이기

가장 자주 쓰는 명령어입니다. **마지막으로 작업하던 세션**을 그대로 복구합니다.

```bash
cd C:\Users\pc\Downloads\jamsa-panel
claude --continue
```

또는 짧게:
```bash
claude -c
```

→ 이전 대화 내역 + Plan Mode 상태 + 변경된 파일까지 그대로 복구됩니다.

---

### ② 이전 세션 목록에서 골라서 복구

여러 세션 중 하나를 선택하고 싶을 때 사용합니다.

```bash
cd C:\Users\pc\Downloads\jamsa-panel
claude --resume
```

또는 짧게:
```bash
claude -r
```

실행하면 아래처럼 세션 목록이 나옵니다:

```
? 어느 세션을 이어붙일까요?
❯ 1. 2026-05-20 13:42  jamsa-panel  (BLE 비콘 출퇴근 스키마)
  2. 2026-05-20 11:15  jamsa-panel  (QR 코드 인쇄 PR)
  3. 2026-05-19 22:08  jamsa-panel  (Supabase RLS 정책)
  4. 2026-05-19 18:30  museum-hr    (직원 4유형 계약서)
```

방향키로 골라서 Enter → 그 시점부터 다시 시작.

---

### ③ 새 세션 시작 (기존 세션 무시)

처음부터 새로 시작하고 싶을 때.

```bash
cd C:\Users\pc\Downloads\jamsa-panel
claude
```

옵션 없이 그냥 `claude` 만 치면 새 세션이 만들어집니다.

---

## 📂 세션 저장 위치

Claude Code는 세션을 자동으로 저장합니다. 저장 위치:

```
C:\Users\pc\.claude\projects\
   └─ -C--Users-pc-Downloads-jamsa-panel\
       ├─ session-2026-05-20-134231.jsonl
       ├─ session-2026-05-20-111545.jsonl
       └─ ...
```

- 폴더 이름은 프로젝트 경로를 변환한 것입니다 (`/` → `-`)
- `.jsonl` 파일 하나가 세션 한 개
- 직접 열어서 대화 내역을 볼 수도 있어요 (JSON Lines 형식)

---

## 🎯 실전 워크플로우

### 시나리오 A: 점심 먹고 와서 이어 작업

```bash
# 컴퓨터 켜고
cd C:\Users\pc\Downloads\jamsa-panel
claude -c
```
→ 끝. 점심 먹기 전 그대로 이어집니다.

### 시나리오 B: 어제 작업 마무리 안 했는데 오늘 다시

```bash
cd C:\Users\pc\Downloads\jamsa-panel
claude --resume
# 화살표로 어제 세션 골라서 Enter
```

### 시나리오 C: 여러 프로젝트 동시 진행

각 프로젝트 폴더에서 따로 `claude -c` 하면 됩니다.
세션은 **프로젝트(폴더) 단위로 분리**되어 있어요.

```bash
# jamsa-panel 작업하다가
cd C:\Users\pc\Downloads\museum-hr
claude -c
# museum-hr 의 마지막 세션이 복구됨
```

---

## 💡 Pro Tip

### 1) Plan Mode 활용

복잡한 작업은 처음에 Plan Mode 로 진입하세요:
```
Shift + Tab → "auto-accept edits off · plan mode" 표시
```
계획 먼저 세우고 → 검토 후 → 실행. 세션 이어붙이면 계획도 같이 복구됩니다.

### 2) /clear 명령어

세션을 이어붙이긴 했는데 컨텍스트가 너무 길어졌을 때:
```
/clear
```
→ 대화 내역만 비우고 같은 작업 폴더에서 새로 시작.

### 3) /resume 슬래시 명령어

이미 Claude Code 안에 들어와 있을 때도:
```
/resume
```
→ 세션 목록 띄워서 다른 세션으로 점프 가능.

---

## ⚠️ 주의사항

1. **세션 저장은 자동**이지만, Claude Code 가 비정상 종료(블루스크린/강제 종료)되면 마지막 1~2 메시지가 누락될 수 있습니다.

2. **`.claude/projects/` 폴더는 백업** 해두는 게 좋아요. 작업 내역이 다 담겨있습니다.

3. **다른 컴퓨터로 옮길 때**는 `.claude/projects/[프로젝트폴더]` 를 복사하면 그 세션도 복구 가능.

4. **PR 이 병합된 후에도** 세션은 남아있어요. 같은 PR 의 후속 작업 (예: 추가 버그 수정) 시 그대로 이어붙이면 컨텍스트가 유지됩니다.

---

## 📚 자주 쓰는 명령어 정리

| 명령어 | 단축 | 용도 |
|---|---|---|
| `claude` | — | 새 세션 시작 |
| `claude --continue` | `claude -c` | 마지막 세션 이어붙이기 |
| `claude --resume` | `claude -r` | 세션 목록에서 선택 |
| `/clear` | — | 세션 내 대화만 비우기 |
| `/resume` | — | 세션 내에서 다른 세션 점프 |
| `/exit` | `Ctrl+D` | 세션 종료 (자동 저장됨) |
| `Shift+Tab` | — | Plan Mode 토글 |

---

**끝.** 이 가이드 + 출퇴근 화면 HTML + 직원 등록 SQL 세트로
잠사박물관 출퇴근 시스템 1차 구축이 완료됩니다.
