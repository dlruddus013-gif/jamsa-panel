-- 1) 게이트웨이 HTTP POST 원본 패킷 (1요청 = 1행)
CREATE TABLE IF NOT EXISTS gateway_packets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,           -- ISO 8601 (서버 수신 시각)
  client_ip TEXT,
  user_agent TEXT,
  content_type TEXT,
  gateway_mac TEXT,                    -- data.gw 우선
  gateway_ip TEXT,                     -- client_ip 또는 payload.client_ip
  seq INTEGER,
  raw_payload TEXT                     -- JSON 원문
);
CREATE INDEX IF NOT EXISTS idx_pkt_received ON gateway_packets(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_pkt_gateway  ON gateway_packets(gateway_mac);
CREATE INDEX IF NOT EXISTS idx_pkt_seq      ON gateway_packets(gateway_mac, seq);

-- 2) 정규화된 비콘 이벤트 (adv 배열의 각 항목 = 1행)
CREATE TABLE IF NOT EXISTS beacon_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  packet_id INTEGER REFERENCES gateway_packets(id),
  received_at TEXT NOT NULL,
  gateway_ip TEXT,
  gateway_mac TEXT,
  beacon_mac TEXT,
  packet_type TEXT,                    -- 'tlm' | 'uid' | 'ucid' | 'ibeacon' | 'ib' | 'custom'
  uuid TEXT,
  major INTEGER,
  minor INTEGER,
  namespace TEXT,
  instance TEXT,
  rssi INTEGER,
  rssi_at_xm INTEGER,
  battery_mv INTEGER,
  temperature REAL,
  seq INTEGER,
  tag_id TEXT,                         -- resolver가 채움
  raw_adv TEXT                         -- 해당 adv 항목 원본 JSON
);
CREATE INDEX IF NOT EXISTS idx_evt_received ON beacon_events(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_evt_gateway  ON beacon_events(gateway_mac);
CREATE INDEX IF NOT EXISTS idx_evt_beacon   ON beacon_events(beacon_mac);
CREATE INDEX IF NOT EXISTS idx_evt_majmin   ON beacon_events(major, minor);
CREATE INDEX IF NOT EXISTS idx_evt_nsinst   ON beacon_events(namespace, instance);
CREATE INDEX IF NOT EXISTS idx_evt_tag      ON beacon_events(tag_id);

-- 3) 태그 = 사람/장비 1명. 하나의 tag_id는 여러 식별자(uuid/maj/min + ns/inst + mac)를 가질 수 있음
CREATE TABLE IF NOT EXISTS beacon_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_id TEXT UNIQUE NOT NULL,         -- 'TAG-0001' 등 시스템 ID
  owner_type TEXT,                     -- staff | visitor | equipment
  owner_name TEXT,
  department TEXT,
  role TEXT,
  beacon_mac TEXT,
  uuid TEXT,
  major INTEGER,
  minor INTEGER,
  namespace TEXT,
  instance TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tag_mac    ON beacon_tags(beacon_mac);
CREATE INDEX IF NOT EXISTS idx_tag_majmin ON beacon_tags(major, minor);
CREATE INDEX IF NOT EXISTS idx_tag_nsinst ON beacon_tags(namespace, instance);

-- 4) alias = tag_id ↔ 식별자 매핑 (한 사람 = 여러 식별자)
CREATE TABLE IF NOT EXISTS tag_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_id TEXT NOT NULL,
  alias_type TEXT NOT NULL,            -- 'beacon_mac' | 'ibeacon' | 'eddystone_uid'
  alias_value TEXT NOT NULL,           -- 'aa:bb:cc:...' | 'uuid:major:minor' | 'namespace:instance'
  first_seen_at TEXT DEFAULT (datetime('now')),
  UNIQUE(alias_type, alias_value)
);
CREATE INDEX IF NOT EXISTS idx_alias_tag   ON tag_aliases(tag_id);
CREATE INDEX IF NOT EXISTS idx_alias_value ON tag_aliases(alias_type, alias_value);
