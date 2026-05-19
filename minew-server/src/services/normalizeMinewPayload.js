/**
 * Minew 게이트웨이 HTTP POST → 정규화.
 * 핵심: adv[] 배열의 각 항목을 개별 beacon_event로 분리한다.
 *
 * 절대 혼동하지 않는 규칙:
 *   gateway_mac = data.gw (없으면 payload.gateway_mac, 그래도 없으면 'unknown')
 *   beacon_mac  = adv[i].mac (없으면 data.mac, payload.beacon_mac, payload.mac → 'unknown')
 *
 * 각 adv 항목의 type에 따라:
 *   - 'tlm'       → battery, temperature, rssi
 *   - 'uid'|'ucid' → namespace, instance (Eddystone)
 *   - 'ib'|'ibeacon' → uuid, major, minor (iBeacon)
 *   - 기타 → 그대로 raw_adv 저장
 *
 * payload 최상위에 uuid/major/minor가 잘못 들어와도 (Minew는 종종 그렇게 보냄),
 * adv 항목에 동일 값 있으면 adv 값이 우선 (정확).
 */

function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }
function asInt(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
function asFloat(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function asStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function pickStr(...vals) {
  for (const v of vals) { const s = asStr(v); if (s) return s; }
  return null;
}
function lowerHex(v) {
  const s = asStr(v);
  return s ? s.toLowerCase().replace(/[^0-9a-f]/g, "") || s.toLowerCase() : null;
}
function lowerMac(v) {
  const s = asStr(v);
  return s ? s.toLowerCase() : null;
}

/**
 * 단일 adv 항목을 정규화. 부족한 필드는 root context에서 보완.
 */
function normalizeOneAdv(advItem, ctx) {
  const a = isObj(advItem) ? advItem : {};
  const t = asStr(a.type)?.toLowerCase() || null;

  const beacon_mac = lowerMac(
    a.mac ?? a.macAddress ?? a.bleMac ?? ctx.beacon_mac_fallback ?? "unknown"
  );

  let uuid = null, major = null, minor = null, namespace = null, instance = null;
  let battery_mv = null, temperature = null;
  let packet_type = t || "custom";

  if (t === "ib" || t === "ibeacon" || t === "ibeacon_data") {
    uuid = lowerHex(a.uuid || ctx.root_uuid);
    major = asInt(a.major ?? ctx.root_major);
    minor = asInt(a.minor ?? ctx.root_minor);
    packet_type = "ibeacon";
  } else if (t === "uid" || t === "ucid") {
    namespace = lowerHex(a.namespace);
    instance  = lowerHex(a.instance);
    packet_type = t;
  } else if (t === "tlm") {
    battery_mv  = asInt(a.battery);
    temperature = asFloat(a.temperature);
    packet_type = "tlm";
  } else {
    // 알 수 없는 type — 가능한 필드 추출
    uuid       = lowerHex(a.uuid);
    major      = asInt(a.major);
    minor      = asInt(a.minor);
    namespace  = lowerHex(a.namespace);
    instance   = lowerHex(a.instance);
    battery_mv = asInt(a.battery);
    temperature= asFloat(a.temperature);
  }

  return {
    beacon_mac,
    packet_type,
    uuid, major, minor,
    namespace, instance,
    rssi: asInt(a.rssi ?? ctx.root_rssi),
    rssi_at_xm: asInt(a.rssi_at_xm),
    battery_mv,
    temperature,
    raw_adv: JSON.stringify(a),
  };
}

/**
 * 메인 정규화 — payload 1건 → { packet, events[] }
 *   packet: gateway_packets에 저장할 row
 *   events: adv[] 각각을 분리한 beacon_events row 배열
 */
function normalizeMinewPayload(payload, ctx = {}) {
  const root = isObj(payload) ? payload : {};
  const data = isObj(root.data) ? root.data : {};
  const adv  = Array.isArray(data.adv) ? data.adv : (Array.isArray(root.adv) ? root.adv : []);

  // 1) 게이트웨이 식별 — data.gw 절대 우선
  const gateway_mac = pickStr(data.gw, root.gateway_mac, "unknown");
  const gateway_ip  = pickStr(root.client_ip, root.gateway_ip, ctx.clientIp);
  const seq = asInt(data.seq ?? root.seq);
  const received_at = pickStr(root.received_at) || ctx.receivedAt || new Date().toISOString();

  // 2) 비콘 MAC 폴백 후보 — adv에 없을 때 사용
  // (gateway_mac과 같은 값이 들어와도 adv[].mac이 있으면 그걸 사용)
  const beacon_mac_fallback = pickStr(data.mac, root.beacon_mac, root.mac, "unknown");

  // 3) 패킷 row
  const packet = {
    received_at,
    client_ip: gateway_ip,
    user_agent: ctx.userAgent || null,
    content_type: ctx.contentType || null,
    gateway_mac: lowerMac(gateway_mac) || "unknown",
    gateway_ip,
    seq,
    raw_payload: ctx.rawText || JSON.stringify(payload ?? null),
  };

  // 4) adv 배열 분리 — 각 항목을 별도 이벤트로
  const advCtx = {
    beacon_mac_fallback,
    root_uuid: root.uuid,
    root_major: root.major,
    root_minor: root.minor,
    root_rssi: root.rssi,
  };

  let events;
  if (adv.length > 0) {
    events = adv.map(a => {
      const e = normalizeOneAdv(a, advCtx);
      return {
        packet_id: null,                                   // 호출자가 insertPacket 후 채움
        received_at,
        gateway_ip,
        gateway_mac: packet.gateway_mac,
        beacon_mac: e.beacon_mac,
        packet_type: e.packet_type,
        uuid: e.uuid, major: e.major, minor: e.minor,
        namespace: e.namespace, instance: e.instance,
        rssi: e.rssi,
        rssi_at_xm: e.rssi_at_xm,
        battery_mv: e.battery_mv,
        temperature: e.temperature,
        seq,
        tag_id: null,                                       // resolver가 채움
        raw_adv: e.raw_adv,
      };
    });
  } else {
    // adv 없을 때 — payload 최상위만으로 1건 생성 (테스트용 형태)
    const e = normalizeOneAdv({
      mac: beacon_mac_fallback,
      uuid: root.uuid, major: root.major, minor: root.minor,
      rssi: root.rssi,
      type: root.uuid ? "ib" : (root.namespace ? "uid" : null),
    }, advCtx);
    events = [{
      packet_id: null,
      received_at,
      gateway_ip,
      gateway_mac: packet.gateway_mac,
      beacon_mac: e.beacon_mac,
      packet_type: e.packet_type,
      uuid: e.uuid, major: e.major, minor: e.minor,
      namespace: e.namespace, instance: e.instance,
      rssi: e.rssi,
      rssi_at_xm: e.rssi_at_xm,
      battery_mv: e.battery_mv,
      temperature: e.temperature,
      seq,
      tag_id: null,
      raw_adv: JSON.stringify(root),
    }];
  }

  return { packet, events };
}

/** RSSI → 라벨 */
function rssiLabel(rssi) {
  if (rssi == null) return { label: "unknown", color: "#94a3b8" };
  if (rssi >= -40) return { label: "매우 가까움", color: "#10b981" };
  if (rssi >= -55) return { label: "가까움",     color: "#3b82f6" };
  if (rssi >= -70) return { label: "보통",       color: "#f59e0b" };
  if (rssi >= -85) return { label: "약함",       color: "#ef4444" };
  return                  { label: "이탈 가능성", color: "#7f1d1d" };
}

module.exports = { normalizeMinewPayload, rssiLabel };
