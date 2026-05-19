# 잠사 비콘 엣지 서버 (beacon-edge-server)

비콘 게이트웨이(HTTP)가 보낸 비콘 수신 로그를 받아 저장·조회·실시간 표시하는 가벼운 엣지 서버.

**데이터 흐름**:
```
[비콘 태그] → (BLE 신호 송출)
              ↓
         [게이트웨이] → (HTTP POST)
                      ↓
                 [이 서버 :8088] → SQLite + JSONL + SSE
                                ↓
                          [대시보드/지도]
```

- TagCloud 연동 X — 게이트웨이가 직접 이 서버로 POST.
- 페이로드 형식이 확정되지 않아도 유연하게 수용 (모르는 필드는 raw_payload에 저장).
- 추후 MQTT/TCP 어댑터 추가 시 `storage.py`는 그대로 재사용.

---

## 빠른 시작

### 1. 설치
```bash
cd beacon-edge-server
pip install -r requirements.txt
```

### 2. 실행
```bash
# Linux/Mac
./run.sh

# Windows
run.bat

# 또는 직접
python -m uvicorn app.main:app --host 0.0.0.0 --port 8088
```

서버가 시작되면 콘솔에:
```
[beacon-edge] 서버 시작 — http://0.0.0.0:8088
[beacon-edge] 대시보드: http://0.0.0.0:8088/dashboard
[beacon-edge] POST 엔드포인트: http://0.0.0.0:8088/api/beacon/log
```

### 3. 동작 확인
브라우저: <http://localhost:8088/dashboard>

```bash
curl http://localhost:8088/health
# {"status":"ok","subscribers":0}
```

### 4. 테스트 데이터 1건 전송
```bash
curl -X POST http://localhost:8088/api/beacon/log \
  -H "Content-Type: application/json" \
  -d '{
    "gateway_id": "gate-01",
    "uuid": "test-uuid",
    "major": 1,
    "minor": 1,
    "rssi": -62
  }'
```

응답:
```json
{
  "ok": true,
  "received_at": "2026-...",
  "id": 1,
  "count": 1,
  "resolved": {"kind":"location","name":"전시실 1","major":1,"minor":1}
}
```

대시보드 새로고침하면 로그가 보임. 콘솔에도 `[수신]` 줄이 찍힘.

---

## 게이트웨이 설정

게이트웨이 관리 페이지에서 **HTTP Push URL**을 다음으로 설정:

```
http://<서버_IP>:8088/api/beacon/log
```

- 사내 LAN: `http://192.168.0.50:8088/api/beacon/log`
- 외부에서 접근하려면 포트포워딩 또는 reverse proxy 필요.

지원 페이로드 형식:
- `Content-Type: application/json` (단건 또는 `{ obj: [...] }` 다건)
- `Content-Type: application/x-www-form-urlencoded`
- `Content-Type: multipart/form-data`
- 형식 모르겠으면 그냥 보내도 됨 — raw_payload에 저장됨.

여러 게이트웨이가 다른 필드명을 써도 자동 매핑:

| 우리 표준 | 게이트웨이가 쓸 수 있는 이름 |
|---|---|
| `gateway_id` | gateway_id / gatewayId / gw_id / gw_mac / gmac / deviceMac |
| `mac` | mac / MAC / macAddress / mac_address / bleMac / device_mac |
| `major` / `minor` | major(Major) / minor(Minor) |
| `rssi` | rssi / RSSI |
| `tx_power` | tx_power / txPower / TxPower |
| `uuid` | uuid / UUID / Uuid |
| `beacon_id` | beacon_id / beaconId / id / tag_id |

게이트웨이가 다건을 묶어 보낼 때(`obj`, `beacons`, `data` 배열) 자동 분리해서 한 건씩 저장.

---

## API

### `GET /health`
서버 상태.
```json
{"status":"ok","subscribers":1}
```

### `POST /api/beacon/log`
**메인 수신 엔드포인트**. JSON/form/raw 모두 수용. 모르는 필드도 `raw_payload`로 저장.

### `GET /api/beacon/logs`
최근 로그 (최신순). Query:
- `limit` (기본 100, 최대 5000)
- `gateway_id`
- `major`
- `minor`
- `since` (ISO 8601)

```bash
curl "http://localhost:8088/api/beacon/logs?limit=20&gateway_id=gate-01"
```

### `GET /api/beacon/latest`
비콘별(beacon_id 또는 major/minor 키) 가장 최근 1건씩 — 지도/대시보드용.

### `GET /api/beacon/events` (SSE)
새 비콘 로그 발생 시 실시간 push. 폴링 백업도 동시 제공.

JavaScript 예:
```js
const es = new EventSource('http://localhost:8088/api/beacon/events');
es.addEventListener('beacon_log', e => {
  const rec = JSON.parse(e.data);
  console.log('new beacon:', rec);
});
```

### `GET /api/config/beacon_map`
현재 `config/beacon_map.json` 내용 반환.

---

## 데이터 모델

| 필드 | 타입 | 설명 |
|---|---|---|
| id | INTEGER | 자동 증가 |
| received_at | TEXT (ISO 8601 UTC) | 수신 시각 |
| gateway_id | TEXT | 게이트웨이 식별 |
| gateway_name | TEXT | 사람 친화 이름 |
| uuid | TEXT | iBeacon UUID 등 |
| mac | TEXT | 비콘 MAC |
| beacon_id | TEXT | 자체 ID |
| major / minor | INTEGER | iBeacon 식별 |
| rssi | REAL | 신호 강도 (dBm) |
| tx_power | REAL | 송신 전력 |
| source_ip | TEXT | 게이트웨이 IP |
| raw_payload | JSON TEXT | 원본 payload 전체 |

저장:
- `data/beacon_logs.sqlite` — 빠른 조회 + 인덱스 (`received_at`, `gateway_id`, `(major,minor)`, `beacon_id`)
- `data/beacon_logs.jsonl` — append-only 백업 (SQLite 손상 시 복구용)

---

## major/minor 매핑 (config/beacon_map.json)

비콘 식별 의미를 코드에 박지 않고 JSON 파일로 분리.

```json
{
  "locations": [
    { "major": 1, "minor": 1, "name": "전시실 1" },
    { "major": 1, "minor": 2, "name": "전시실 2" },
    { "major": 1, "minor": 3, "name": "체험실" }
  ],
  "staff": [
    { "major": 100, "minor": 1, "name": "직원 테스트 태그" }
  ]
}
```

- `locations`: 박물관/공간 비콘 그룹 (보통 major=1)
- `staff`: 직원 태그 (보통 major>=100)
- 수정 후 서버 재시작 없이 다음 요청에서 즉시 반영 (요청마다 파일 읽음).

API 응답의 `resolved` 필드로 매핑 결과 확인:
```json
{
  "id": 1,
  "major": 1, "minor": 2,
  "resolved": {"kind":"location","name":"전시실 2","major":1,"minor":2}
}
```

---

## 폴더 구조

```
beacon-edge-server/
├── app/
│   ├── __init__.py
│   ├── main.py        # FastAPI + 라우트
│   ├── models.py      # 페이로드 정규화 + 매핑 해석
│   ├── storage.py     # SQLite + JSONL
│   ├── schemas.py     # Pydantic
│   ├── config.py      # 경로/설정/매핑
│   └── realtime.py    # SSE 브로커
├── config/
│   └── beacon_map.json
├── data/              # 자동 생성
│   ├── beacon_logs.sqlite
│   └── beacon_logs.jsonl
├── static/
│   └── dashboard.html
├── requirements.txt
├── run.sh
├── run.bat
└── README.md
```

---

## 확장 계획

- **MQTT 어댑터**: `app/mqtt_adapter.py` 추가 → 메시지 수신 시 동일하게 `storage.insert()` 호출.
- **TCP raw socket**: `app/tcp_adapter.py` 추가 → 별도 포트.
- **여러 비콘맵**: `config/`에 zone별 분리, 환경변수로 선택.
- **지도 연동**: 잠사 패널의 `/api/beacon-webhook` 또는 통합지도에서 `latest` API를 polling.

---

## 트러블슈팅

- **포트 8088 충돌**: `PORT=8089 python -m uvicorn app.main:app ...` 환경변수로 변경.
- **방화벽**: Windows에서 `netsh advfirewall firewall add rule name="Beacon Edge" dir=in action=allow protocol=TCP localport=8088`.
- **JSON 파싱 실패**: raw_payload에 원본이 그대로 보관됨. `data/beacon_logs.jsonl` 확인.
- **콘솔에 `[수신]` 안 찍힘**: 게이트웨이가 다른 IP/포트로 보내고 있을 가능성. `tcpdump -i any port 8088` 또는 `netstat -an | grep 8088`로 확인.

---

## 자동 테스트 시퀀스

```bash
# 1. 서버 시작
./run.sh &

# 2. 헬스체크
curl http://localhost:8088/health

# 3. 단건 전송
curl -X POST http://localhost:8088/api/beacon/log \
  -H "Content-Type: application/json" \
  -d '{"gateway_id":"gate-01","major":1,"minor":1,"rssi":-62}'

# 4. 다건 (Minew G1 스타일)
curl -X POST http://localhost:8088/api/beacon/log \
  -H "Content-Type: application/json" \
  -d '{"gw_mac":"AC233F123456","obj":[
    {"mac":"AA:BB:CC:11:22:33","major":1,"minor":2,"rssi":-70},
    {"mac":"AA:BB:CC:11:22:34","major":100,"minor":1,"rssi":-85}
  ]}'

# 5. 조회
curl http://localhost:8088/api/beacon/logs?limit=5
curl http://localhost:8088/api/beacon/latest

# 6. 대시보드
open http://localhost:8088/dashboard   # Mac
xdg-open http://localhost:8088/dashboard   # Linux
start http://localhost:8088/dashboard   # Windows
```
