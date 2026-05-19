# 🛰️ 잠사박물관 Minew 게이트웨이 수신 서버

BLE 비콘 + Minew 게이트웨이 → HTTP POST → 본 서버가 정규화/저장/대시보드 시각화.
**Node.js + Express + better-sqlite3.**

## 데이터 흐름

```
[비콘 (c300002a772a)]  BLE 신호 송출 (TLM + UID + iBeacon)
        ↓
[Minew G1 게이트웨이 (ac233fc21106)]  스캔
        ↓ HTTP POST { gw_mac, obj:[adv1, adv2, adv3] }
[이 서버 :3000]
   ├ gateway_packets      ← 원본 1행
   ├ beacon_events × N    ← adv[] 분리 (TLM 1행 + UID 1행 + iBeacon 1행)
   ├ tag_id 자동 해석     ← 모두 같은 사람으로 묶임 (TAG-0001)
   └ /dashboard            ← 실시간
```

## 빠른 시작

```bash
cd minew-server
npm install
cp .env.example .env       # 필요 시 PORT 변경
npm start
```

콘솔:
```
[db] OK — .../data/minew.sqlite
🛰️  Jamsa Minew Edge Server
📡  http://0.0.0.0:3000
📊  Dashboard: http://localhost:3000/dashboard
⬇️   POST 엔드포인트: /minew  /api/minew  /webhook/minew  /api/beacon
```

브라우저: <http://localhost:3000/dashboard>

## 테스트 (curl)

### iBeacon 단건 (요구사항 예시)
```bash
curl -X POST http://localhost:3000/api/minew \
  -H "Content-Type: application/json" \
  -d '{
    "received_at":"2026-05-19T15:17:40","client_ip":"192.168.100.184",
    "gateway_mac":"c300002a772a","beacon_mac":"c300002a772a","rssi":-28,
    "uuid":"e2c56db5dffb48d2b060d0f5a71096e0","major":101,"minor":1,
    "data":{"tm":"2026-05-19T06:14:36.368Z","gw":"ac233fc21106","seq":14385,
      "adv":[{"type":"tlm","battery":3171,"temperature":null,"mac":"c300002a772a","rssi":-28}]
    }
  }'
```

응답:
```json
{
  "ok": true,
  "packet_id": 1,
  "event_count": 1,
  "event_ids": [1],
  "tag_ids": ["TAG-0001"]
}
```

→ `data.gw="ac233fc21106"` 가 gateway_mac으로, `adv[0].mac="c300002a772a"` 가 beacon_mac으로 분리 저장됩니다.

### Minew 실제 포맷 — 다건 adv (TLM + UID 한 패킷)
```bash
curl -X POST http://localhost:3000/minew \
  -H "Content-Type: application/json" \
  -d '{
    "received_at":"2026-05-19T15:17:42","client_ip":"192.168.100.184",
    "gateway_mac":"c300002a772a","beacon_mac":"c300002a772a","rssi":-40,
    "data":{"tm":"2026-05-19T06:14:56.110Z","gw":"ac233fc21106","seq":14398,
      "adv":[
        {"type":"tlm","battery":3171,"temperature":30.0,"rssi":-40,"mac":"c300002a772a"},
        {"type":"uid","namespace":"00112233445566778899","instance":"000000000001","rssi":-40,"mac":"c300002a772a"}
      ]
    }
  }'
```

→ **이벤트 2개** 생성 (TLM 1개 + UID 1개), 둘 다 같은 `TAG-0001`로 자동 묶임.

### iBeacon ("ib" 타입)
```bash
curl -X POST http://localhost:3000/api/beacon \
  -H "Content-Type: application/json" \
  -d '{
    "data":{"gw":"ac233fc21106","seq":14399,
      "adv":[{"type":"ib","uuid":"e2c56db5dffb48d2b060d0f5a71096e0","major":101,"minor":1,"rssi":-41,"mac":"c300002a772a"}]
    }
  }'
```

## Minew 게이트웨이 설정

### 방법 A: 게이트웨이 웹 UI 직접
1. 라우터에서 Minew G1 IP 확인 (예: `192.168.100.184`)
2. 브라우저로 `http://<게이트웨이IP>` 접속, 로그인 `admin / minew123`
3. **Application Settings** 또는 **HTTP Push**
4. URL 입력 (이 서버 PC IP 사용):
   ```
   http://<이서버PC_IP>:3000/api/minew
   ```
5. Method: **POST**, Content-Type: **application/json**, Auth: 비움
6. Save → 게이트웨이 재부팅 (약 1분)

### 방법 B: TagCloud 경유
1. tagcloud.minew.com 로그인
2. Devices → 게이트웨이 → **Data Forwarding / Webhook**
3. + Add Webhook → URL: `http://<이서버PC_IP>:3000/api/minew`

## 이 서버 PC IP 확인

**Windows**:
```cmd
ipconfig | findstr IPv4
```

**Linux/Mac**:
```bash
hostname -I
```

게이트웨이와 **같은 LAN/공유기**에 연결되어 있어야 접근 가능.

## 방화벽 — 포트 3000 허용

**Windows** (관리자 명령 프롬프트):
```cmd
netsh advfirewall firewall add rule name="Minew Edge 3000" dir=in action=allow protocol=TCP localport=3000
```

**Linux** (ufw):
```bash
sudo ufw allow 3000/tcp
```

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/minew` / `/api/minew` / `/webhook/minew` / `/api/beacon` | 게이트웨이 수신 (동일 로직) |
| GET | `/api/health` | 헬스체크 |
| GET | `/api/events/recent?limit=100&gateway_mac=&tag_id=` | 최근 이벤트 |
| GET | `/api/tags` | 등록된 태그 + 최근 RSSI/배터리 |
| GET | `/api/gateways` | 게이트웨이별 패킷 카운트 |
| GET | `/api/dashboard-summary` | 대시보드 카드 데이터 |
| GET | `/api/major-map` | major → 부서 매핑 |
| GET | `/dashboard` | 웹 대시보드 |

## 데이터 모델

### gateway_packets
| 컬럼 | 설명 |
|---|---|
| id | PK |
| received_at | ISO 8601 (서버 수신 시각) |
| client_ip | 게이트웨이 HTTP 출발 IP |
| gateway_mac | `data.gw` 우선 |
| seq | `data.seq` |
| raw_payload | JSON 원문 전체 |

### beacon_events (adv 배열 분리됨)
| 컬럼 | 설명 |
|---|---|
| packet_id | gateway_packets FK |
| beacon_mac | `adv[i].mac` 우선 |
| packet_type | `tlm` / `uid` / `ucid` / `ibeacon` / `ib` / `custom` |
| uuid · major · minor | iBeacon 식별자 |
| namespace · instance | Eddystone UID |
| rssi · rssi_at_xm | dBm |
| battery_mv | TLM (예: 3171 = 3.171V) |
| temperature | TLM (°C) |
| tag_id | 자동 매칭된 태그 ID (없으면 NULL) |
| raw_adv | 해당 adv 항목 JSON |

### beacon_tags (사람/장비 등록)
사람 1명 = 1행. `beacon_mac` + `uuid/major/minor` + `namespace/instance` 모두 보유 가능.

### tag_aliases (식별자 ↔ tag_id 다중 매핑)
같은 사람의 여러 식별자(MAC, iBeacon, Eddystone)를 같은 `tag_id`로 묶음.
**자동 학습**: 등록된 태그의 `beacon_mac`이 새 식별자(uuid/major/minor)로 신호 보내면 alias 자동 추가 → 다음부터 같은 사람으로 인식.

## tag_id 해석 우선순위

1. `uuid + major + minor` → `tag_aliases` 또는 `beacon_tags` 검색
2. `namespace + instance` → 동일
3. `beacon_mac` → 동일
4. 못 찾으면 NULL (`/dashboard`의 "미등록 식별자" 패널에 표시 → 수동 등록 권장)

## major → 부서 매핑

`src/services/beaconLocationMapper.js`:
```js
{
  101: "관리부",
  102: "시설부",
  103: "안내/매표",
  104: "체험/교육",
  105: "식당/매점",
  201: "내국인 단체",
  202: "외국인 단체",
  301: "장비/비품",
}
```

## RSSI 상태 라벨

| dBm 범위 | 상태 | 색상 |
|---|---|---|
| `>= -40` | 매우 가까움 | 🟢 |
| `-55 ~ -41` | 가까움 | 🔵 |
| `-70 ~ -56` | 보통 | 🟡 |
| `-85 ~ -71` | 약함 | 🔴 |
| `< -85` | 이탈 가능성 | ⚫ |

## 로그·데이터 위치

- DB: `minew-server/data/minew.sqlite` (WAL 모드)
- 에러 로그: `minew-server/logs/error.log`
- 환경설정: `minew-server/.env`

## 새 사람 등록

지금은 SQL 직접 (또는 추후 관리자 UI로 확장):

```sql
-- 예: 시설부 김철수
INSERT INTO beacon_tags (tag_id, owner_type, owner_name, department, role, beacon_mac, uuid, major, minor)
VALUES ('TAG-0002', 'staff', '김철수', '시설부', '직원',
        'aabbcc112233', 'e2c56db5dffb48d2b060d0f5a71096e0', 102, 1);

INSERT INTO tag_aliases (tag_id, alias_type, alias_value) VALUES
  ('TAG-0002', 'beacon_mac', 'aabbcc112233'),
  ('TAG-0002', 'ibeacon', 'e2c56db5dffb48d2b060d0f5a71096e0:102:1');
```

다음 수신부터 자동으로 `tag_id = TAG-0002`로 묶입니다.

## 잠사박물관 현장 테스트 권장 순서

1. 박물관 PC에서 `npm start` → http://localhost:3000/dashboard 열기
2. PC IP 확인 (예: 192.168.100.50)
3. 방화벽 포트 3000 허용
4. Minew G1 웹 UI 또는 TagCloud에서 webhook URL = `http://192.168.100.50:3000/api/minew` 설정
5. 1분 대기 → 대시보드의 "📡 게이트웨이" 패널에 새 행 등장 확인
6. 비콘을 게이트웨이 근처로 가져가서 "📜 실시간 수신 이벤트"에 TLM/UID/iBeacon 표시 확인
7. 미등록 식별자가 나타나면 SQL로 `beacon_tags` 추가 → 자동으로 활성 태그 목록에 사람 이름 표시
8. RSSI가 -55 이상으로 가까이 갈 때 "매우 가까움"/"가까움" 배지 확인

## 📶 TP-Link Omada AP 연동 (지원됨)

이 서버는 **TP-Link Omada BLE 스캐닝 AP**도 지원합니다. (EAP610, EAP620 HD, EAP650, EAP650-Wall, EAP670 등 BLE 스캔 지원 모델)

### TP-Link Omada 수신 경로
```
POST /tplink · /api/tplink · /webhook/tplink · /api/omada
POST /api/beacon-any   ← Minew/TP-Link 자동 감지
```

### 자동 매핑되는 TP-Link 필드
| 우리 표준 | TP-Link Omada 키 |
|---|---|
| `gateway_mac` | `deviceMac` / `ap_mac` / `ap` / `apMac` |
| `beacon_mac` | `scannedDevices[].mac` / `scans[].mac` / `beacon.mac` |
| `packet_type` | `advType` (iBeacon/Eddystone-UID/Eddystone-TLM → ibeacon/uid/tlm 자동 변환) |
| `uuid` / `major` / `minor` | iBeacon 표준 |
| `namespace` / `instance` | Eddystone UID |
| `rssi` | dBm |

### 방법 A — Omada Controller Webhook (가장 쉬움)
1. **Omada Controller** 로그인 (Cloud 또는 Self-hosted)
2. **Settings → Site → BLE Scanning** 활성화
3. **Notifications / Webhook** 메뉴
4. URL: `http://<이서버PC_IP>:3000/api/tplink`
5. Method: `POST`, Content-Type: `application/json`
6. Save → 1~2분 대기 → 대시보드 게이트웨이 패널에 EAP MAC 등장

### 방법 B — Omada Controller MQTT (대규모 권장)
1. `cd minew-server && npm install mqtt`
2. `.env` 추가:
   ```
   MQTT_URL=mqtt://192.168.0.10:1883
   MQTT_TOPIC=omada/ble/#
   MQTT_USERNAME=...
   MQTT_PASSWORD=...
   ```
3. Omada Controller → **Settings → Cloud Access → MQTT Broker** 설정
4. 서버 재시작 → 콘솔에 `[mqtt] ✓ 연결됨` 표시
5. 이후 자동 수신 (HTTP webhook 불필요)

### 테스트 curl (TP-Link 포맷)
```bash
curl -X POST http://localhost:3000/api/tplink \
  -H "Content-Type: application/json" \
  -d '{
    "deviceName":"EAP650-Office","deviceMac":"AA-BB-CC-11-22-33",
    "siteName":"잠사박물관","timestamp":1730000000,
    "scannedDevices":[
      {"mac":"DD:EE:FF:00:11:22","rssi":-65,"advType":"iBeacon",
       "uuid":"e2c56db5dffb48d2b060d0f5a71096e0","major":101,"minor":1},
      {"mac":"DD:EE:FF:00:11:22","rssi":-65,"advType":"Eddystone-UID",
       "namespace":"00112233445566778899","instance":"000000000001"}
    ]
  }'
```

### ⚠️ TP-Link 주의사항
- **일반 가정용 TP-Link AP는 BLE 스캔 기능이 없습니다.** Archer/Deco 시리즈 대부분 제외.
- **Omada 비즈니스 라인** 중에서도 spec sheet에 **"BLE Scanning"** 또는 **"Bluetooth Low Energy"** 명시된 모델만 가능.
- 확인 가능 모델 예시 (2024~2026 출시 기준):
  - EAP610 / EAP620 HD / EAP650 / EAP650-Wall / EAP670 / EAP683 LR
- 가능한지 의심되는 모델은 Omada Controller에서 **Settings → Site → BLE Scanning** 메뉴 존재 여부로 즉시 확인 가능.

## 권장 게이트웨이 비교

| 항목 | Minew G1 | TP-Link Omada EAP |
|---|---|---|
| 가격 | ~67,000원 (G1), ~253,000원 (G1-E) | 12만~30만원 (BLE 모델) |
| 전용 BLE 게이트웨이? | ✅ Yes | ❌ Wi-Fi AP 부가기능 |
| HTTP Push | ✅ 직접 | ✅ Controller 경유 |
| MQTT | ✅ 직접 | ✅ Controller 경유 |
| 추가 인프라 | 없음 | Omada Controller (소프트웨어 무료) |
| 기존 인프라 활용 | ❌ 별도 설치 | ✅ Wi-Fi AP 겸용 |
| 잠사 추천 | ✅ 빠른 시작용 | ✅ Wi-Fi 이미 Omada면 추가비용 0 |

→ **이미 Omada AP 설치되어 있으면 TP-Link 활용. 없으면 Minew G1 신규 구매가 더 빠름.**

## 폴더 구조

```
minew-server/
├── src/
│   ├── server.js                       Express 진입점
│   ├── routes/minewRoutes.js           수신 + 조회 API
│   ├── services/
│   │   ├── normalizeMinewPayload.js   adv[] 분리 + 필드 정규화
│   │   └── beaconLocationMapper.js    major → 부서
│   └── db/
│       ├── index.js                   SQLite + tag resolver
│       ├── schema.sql                 4테이블 정의
│       └── seed.sql                   TAG-0001 시드
├── public/
│   ├── dashboard.html
│   ├── dashboard.js
│   └── style.css
├── data/                              자동 생성 (gitignore)
├── logs/                              자동 생성 (gitignore)
├── .env.example
├── package.json
└── README.md
```

## 향후 확장

- **MQTT 어댑터**: `src/adapters/mqtt.js` 추가 → 동일하게 `normalizeMinewPayload` + `db.insertPacket/insertEvent` 호출
- **TCP raw socket**: `src/adapters/tcp.js`
- **Postgres 이전**: `db/index.js`만 교체 (인터페이스 동일)
- **잠사 패널 연동**: 매 수신마다 `https://jamsa-panel.vercel.app/api/beacon-webhook` 으로 forward
