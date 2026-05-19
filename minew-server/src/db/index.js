/**
 * SQLite (better-sqlite3) — gateway_packets / beacon_events / beacon_tags / tag_aliases
 * 추후 Postgres 이전 시 동일 인터페이스 유지.
 */
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const ROOT = path.resolve(__dirname, "..", "..");
const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = process.env.SQLITE_PATH || path.join(DATA_DIR, "minew.sqlite");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");

function init() {
  db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  // 시드 (없을 때만)
  const n = db.prepare("SELECT COUNT(*) AS n FROM beacon_tags").get().n;
  if (n === 0) {
    db.exec(fs.readFileSync(path.join(__dirname, "seed.sql"), "utf8"));
    console.log("[db] seed 적용 (TAG-0001 관리부 1번)");
  }
  console.log(`[db] OK — ${DB_PATH}`);
}

// ─── 패킷 ─────────────────────────────────────────────────────────
const _insertPacket = () => db.prepare(`
  INSERT INTO gateway_packets
    (received_at, client_ip, user_agent, content_type, gateway_mac, gateway_ip, seq, raw_payload)
  VALUES (@received_at, @client_ip, @user_agent, @content_type, @gateway_mac, @gateway_ip, @seq, @raw_payload)
`);
let _stmtPkt;
function insertPacket(p) {
  _stmtPkt = _stmtPkt || _insertPacket();
  return _stmtPkt.run(p).lastInsertRowid;
}

// ─── 이벤트 ───────────────────────────────────────────────────────
const _insertEvent = () => db.prepare(`
  INSERT INTO beacon_events
    (packet_id, received_at, gateway_ip, gateway_mac, beacon_mac, packet_type,
     uuid, major, minor, namespace, instance,
     rssi, rssi_at_xm, battery_mv, temperature, seq, tag_id, raw_adv)
  VALUES
    (@packet_id, @received_at, @gateway_ip, @gateway_mac, @beacon_mac, @packet_type,
     @uuid, @major, @minor, @namespace, @instance,
     @rssi, @rssi_at_xm, @battery_mv, @temperature, @seq, @tag_id, @raw_adv)
`);
let _stmtEvt;
function insertEvent(e) {
  _stmtEvt = _stmtEvt || _insertEvent();
  return _stmtEvt.run(e).lastInsertRowid;
}

// ─── 태그 / alias ────────────────────────────────────────────────
function findTagBy({ uuid, major, minor, namespace, instance, beacon_mac }) {
  // 1순위: ibeacon
  if (uuid && major != null && minor != null) {
    const v = `${uuid.toLowerCase()}:${major}:${minor}`;
    const a = db.prepare("SELECT tag_id FROM tag_aliases WHERE alias_type='ibeacon' AND alias_value=?").get(v);
    if (a) return a.tag_id;
    const t = db.prepare("SELECT tag_id FROM beacon_tags WHERE lower(uuid)=? AND major=? AND minor=? AND is_active=1").get(uuid.toLowerCase(), major, minor);
    if (t) return t.tag_id;
  }
  // 2순위: eddystone uid
  if (namespace && instance) {
    const v = `${namespace.toLowerCase()}:${instance.toLowerCase()}`;
    const a = db.prepare("SELECT tag_id FROM tag_aliases WHERE alias_type='eddystone_uid' AND alias_value=?").get(v);
    if (a) return a.tag_id;
    const t = db.prepare("SELECT tag_id FROM beacon_tags WHERE lower(namespace)=? AND lower(instance)=? AND is_active=1").get(namespace.toLowerCase(), instance.toLowerCase());
    if (t) return t.tag_id;
  }
  // 3순위: mac
  if (beacon_mac && beacon_mac !== "unknown") {
    const v = beacon_mac.toLowerCase();
    const a = db.prepare("SELECT tag_id FROM tag_aliases WHERE alias_type='beacon_mac' AND alias_value=?").get(v);
    if (a) return a.tag_id;
    const t = db.prepare("SELECT tag_id FROM beacon_tags WHERE lower(beacon_mac)=? AND is_active=1").get(v);
    if (t) return t.tag_id;
  }
  return null;
}

function upsertAlias(tag_id, alias_type, alias_value) {
  if (!tag_id || !alias_value) return;
  try {
    db.prepare("INSERT OR IGNORE INTO tag_aliases (tag_id, alias_type, alias_value) VALUES (?, ?, ?)")
      .run(tag_id, alias_type, String(alias_value).toLowerCase());
  } catch (_) {}
}

/**
 * 이벤트의 식별자를 보고 태그를 자동 매칭/병합한다.
 * - 매칭되는 tag 발견 → 그 tag_id 반환 + 새 식별자가 있으면 alias 추가
 * - 같은 beacon_mac이 다른 패킷에서 (uuid/maj/min)로 들어왔는데 alias가 없으면 자동 alias 추가 → 다음부터 같은 사람으로 묶임
 */
function resolveAndMergeTagId(e) {
  let tagId = findTagBy(e);
  if (!tagId) return null;

  // 같은 beacon_mac → ibeacon/eddystone alias 자동 학습
  if (e.beacon_mac && e.beacon_mac !== "unknown") {
    upsertAlias(tagId, "beacon_mac", e.beacon_mac);
  }
  if (e.uuid && e.major != null && e.minor != null) {
    upsertAlias(tagId, "ibeacon", `${e.uuid}:${e.major}:${e.minor}`);
  }
  if (e.namespace && e.instance) {
    upsertAlias(tagId, "eddystone_uid", `${e.namespace}:${e.instance}`);
  }
  // beacon_tags의 부족한 필드 보완 (한 번만 채우기)
  try {
    const t = db.prepare("SELECT * FROM beacon_tags WHERE tag_id=?").get(tagId);
    if (t) {
      const update = {};
      if (!t.beacon_mac && e.beacon_mac && e.beacon_mac !== "unknown") update.beacon_mac = e.beacon_mac;
      if (!t.uuid && e.uuid) { update.uuid = e.uuid; update.major = e.major; update.minor = e.minor; }
      if (!t.namespace && e.namespace) { update.namespace = e.namespace; update.instance = e.instance; }
      const keys = Object.keys(update);
      if (keys.length) {
        const setSql = keys.map(k => `${k}=@${k}`).join(", ");
        db.prepare(`UPDATE beacon_tags SET ${setSql}, updated_at=datetime('now') WHERE tag_id=@tag_id`)
          .run({ ...update, tag_id: tagId });
      }
    }
  } catch (_) {}
  return tagId;
}

// ─── 조회 ────────────────────────────────────────────────────────
function listRecentEvents({ limit = 100, gateway_mac, tag_id } = {}) {
  let sql = "SELECT * FROM beacon_events WHERE 1=1";
  const args = [];
  if (gateway_mac) { sql += " AND gateway_mac=?"; args.push(gateway_mac); }
  if (tag_id) { sql += " AND tag_id=?"; args.push(tag_id); }
  sql += " ORDER BY id DESC LIMIT ?";
  args.push(Math.min(Math.max(limit, 1), 5000));
  return db.prepare(sql).all(...args);
}

function listTags() {
  return db.prepare(`
    SELECT
      t.*,
      (SELECT MAX(received_at) FROM beacon_events e WHERE e.tag_id = t.tag_id) AS last_seen,
      (SELECT COUNT(*) FROM beacon_events e WHERE e.tag_id = t.tag_id) AS hits,
      (SELECT ROUND(AVG(rssi)) FROM beacon_events e WHERE e.tag_id = t.tag_id AND e.received_at > datetime('now','-5 minutes')) AS rssi_recent,
      (SELECT MAX(battery_mv) FROM beacon_events e WHERE e.tag_id = t.tag_id) AS battery_mv,
      (SELECT MAX(temperature) FROM beacon_events e WHERE e.tag_id = t.tag_id) AS temperature
    FROM beacon_tags t
    WHERE t.is_active = 1
    ORDER BY last_seen DESC NULLS LAST
  `).all();
}

function listGateways() {
  return db.prepare(`
    SELECT
      gateway_mac,
      gateway_ip,
      COUNT(*) AS packets,
      MAX(received_at) AS last_seen
    FROM gateway_packets
    GROUP BY gateway_mac, gateway_ip
    ORDER BY last_seen DESC
  `).all();
}

function dashboardSummary() {
  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM gateway_packets) AS packets,
      (SELECT COUNT(*) FROM beacon_events) AS events,
      (SELECT COUNT(DISTINCT gateway_mac) FROM gateway_packets) AS gateways,
      (SELECT COUNT(DISTINCT tag_id) FROM beacon_events WHERE tag_id IS NOT NULL) AS active_tags,
      (SELECT COUNT(DISTINCT beacon_mac) FROM beacon_events WHERE beacon_mac IS NOT NULL AND beacon_mac != 'unknown') AS unique_beacons,
      (SELECT MAX(received_at) FROM beacon_events) AS last_event_at
  `).get();
  const onlineCutoff = new Date(Date.now() - 5 * 60_000).toISOString();
  const online = db.prepare(`
    SELECT DISTINCT tag_id FROM beacon_events
    WHERE tag_id IS NOT NULL AND received_at >= ?
  `).all(onlineCutoff).map(r => r.tag_id);
  const unmappedRecent = db.prepare(`
    SELECT beacon_mac, uuid, major, minor, namespace, instance, MAX(received_at) AS last_seen
    FROM beacon_events
    WHERE tag_id IS NULL AND received_at >= datetime('now','-1 hour')
    GROUP BY beacon_mac, uuid, major, minor, namespace, instance
    ORDER BY last_seen DESC
    LIMIT 20
  `).all();
  return { ...totals, online_count: online.length, online_tags: online, unmapped_recent: unmappedRecent };
}

module.exports = {
  db, init,
  insertPacket, insertEvent,
  findTagBy, resolveAndMergeTagId, upsertAlias,
  listRecentEvents, listTags, listGateways, dashboardSummary,
};
