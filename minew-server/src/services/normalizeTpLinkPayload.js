/**
 * TP-Link Omada EAP (EAP610/EAP620 HD/EAP650 등 BLE 스캐닝 지원 모델)
 * → BLE 스캔 데이터 정규화.
 *
 * TP-Link Omada는 모델/펌웨어/연동방식(SDN webhook · MQTT · HTTP push)에 따라
 * payload 키가 다양함. 알려진 형태들을 모두 흡수.
 *
 * 알려진 패턴 1 — Omada SDN BLE Scanning Webhook:
 *   {
 *     "deviceName": "EAP650-Office",
 *     "deviceMac": "AA-BB-CC-11-22-33",         // 게이트웨이 AP MAC
 *     "siteName": "잠사박물관",
 *     "timestamp": 1730000000,
 *     "scannedDevices": [
 *       { "mac": "DD:EE:FF:00:11:22", "rssi": -65,
 *         "advType": "iBeacon", "uuid": "...", "major": 1, "minor": 2 },
 *       { "mac": "DD:EE:FF:00:11:23", "rssi": -78,
 *         "advType": "Eddystone-UID", "namespace": "...", "instance": "..." }
 *     ]
 *   }
 *
 * 알려진 패턴 2 — Omada MQTT 메시지 (topic: omada/ble/<apMac>):
 *   { "ap": "AA-BB-CC-11-22-33", "scans": [ {...}, ... ] }
 *
 * 알려진 패턴 3 — 단건:
 *   { "ap_mac": "...", "beacon": { "mac": "...", "rssi": -60, "uuid": "..." } }
 *
 * 본 함수는 어떤 패턴이 와도 살아남고, Minew normalizer와 동일한 출력
 * (gateway_packets row 1개 + beacon_events row N개)을 반환한다.
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
function asStr(v) { if (v == null) return null; const s = String(v).trim(); return s || null; }
function pickStr(...vs) { for (const v of vs) { const s = asStr(v); if (s) return s; } return null; }
function lowerMac(v) {
  const s = asStr(v);
  if (!s) return null;
  return s.toLowerCase().replace(/[-_]/g, ":"); // Omada가 dash 구분자로 보내는 경우 통일
}
function lowerHex(v) {
  const s = asStr(v);
  if (!s) return null;
  return s.toLowerCase().replace(/[^0-9a-f]/g, "") || s.toLowerCase();
}

/** TP-Link 패턴인지 빠르게 감지 */
function looksLikeTpLink(root) {
  if (!isObj(root)) return false;
  return (
    root.deviceMac != null ||
    root.deviceName != null ||
    root.scannedDevices != null ||
    root.ap_mac != null ||
    root.ap != null && (Array.isArray(root.scans) || isObj(root.beacon))
  );
}

/**
 * advType 정규화: TP-Link는 "iBeacon" "Eddystone-UID" "Eddystone-TLM" 등 사용
 */
function normalizeAdvType(t) {
  if (!t) return null;
  const s = String(t).toLowerCase().replace(/[-_\s]/g, "");
  if (s.includes("ibeacon")) return "ibeacon";
  if (s.includes("eddystoneuid") || s === "uid")  return "uid";
  if (s.includes("eddystoneurl") || s === "url")  return "url";
  if (s.includes("eddystonetlm") || s === "tlm")  return "tlm";
  return s;
}

/** 단일 scanned device → 표준 event */
function normalizeScan(scan, gw) {
  if (!isObj(scan)) scan = {};
  const advType = normalizeAdvType(scan.advType || scan.type || scan.adv_type);
  const beacon_mac = lowerMac(scan.mac || scan.macAddress || scan.bleMac || scan.beacon_mac);

  let uuid = null, major = null, minor = null;
  let namespace = null, instance = null;
  let battery_mv = null, temperature = null;
  let packet_type = advType || "custom";

  if (advType === "ibeacon") {
    uuid  = lowerHex(scan.uuid || scan.UUID || scan.proximityUUID);
    major = asInt(scan.major);
    minor = asInt(scan.minor);
    packet_type = "ibeacon";
  } else if (advType === "uid") {
    namespace = lowerHex(scan.namespace || scan.namespaceId);
    instance  = lowerHex(scan.instance  || scan.instanceId);
    packet_type = "uid";
  } else if (advType === "tlm") {
    battery_mv  = asInt(scan.battery || scan.batteryVoltage || scan.battery_mv);
    temperature = asFloat(scan.temperature);
    packet_type = "tlm";
  } else {
    // 알 수 없는 type — 추출 가능한 모든 필드
    uuid       = lowerHex(scan.uuid);
    major      = asInt(scan.major);
    minor      = asInt(scan.minor);
    namespace  = lowerHex(scan.namespace);
    instance   = lowerHex(scan.instance);
    battery_mv = asInt(scan.battery);
  }

  return {
    packet_id: null,
    received_at: gw.received_at,
    gateway_ip: gw.gateway_ip,
    gateway_mac: gw.gateway_mac,
    beacon_mac: beacon_mac || "unknown",
    packet_type,
    uuid, major, minor,
    namespace, instance,
    rssi: asInt(scan.rssi),
    rssi_at_xm: asInt(scan.rssi_at_xm || scan.txPower || scan.tx_power),
    battery_mv,
    temperature,
    seq: asInt(scan.seq) || gw.seq,
    tag_id: null,
    raw_adv: JSON.stringify(scan),
  };
}

/**
 * 메인 함수 — Minew normalizer와 같은 시그니처/리턴.
 */
function normalizeTpLinkPayload(payload, ctx = {}) {
  const root = isObj(payload) ? payload : {};

  // gateway_mac 우선순위 (TP-Link 키 다양함)
  const gateway_mac = lowerMac(
    root.deviceMac || root.ap_mac || root.ap || root.apMac || root.gateway_mac
  ) || "unknown";

  const gateway_ip = pickStr(root.deviceIp, root.ap_ip, root.client_ip, ctx.clientIp);

  const received_at = pickStr(root.received_at) || ctx.receivedAt || new Date().toISOString();
  const seq = asInt(root.seq || root.sequence || root.timestamp);

  const packet = {
    received_at,
    client_ip: gateway_ip,
    user_agent: ctx.userAgent || null,
    content_type: ctx.contentType || null,
    gateway_mac,
    gateway_ip,
    seq,
    raw_payload: ctx.rawText || JSON.stringify(payload ?? null),
  };

  // 스캔 배열 위치 — 모든 알려진 키
  const scans = (
    Array.isArray(root.scannedDevices) ? root.scannedDevices :
    Array.isArray(root.scans) ? root.scans :
    Array.isArray(root.beacons) ? root.beacons :
    Array.isArray(root.devices) ? root.devices :
    isObj(root.beacon) ? [root.beacon] :
    []
  );

  const gwCtx = { received_at, gateway_ip, gateway_mac, seq };

  let events;
  if (scans.length > 0) {
    events = scans.map(s => normalizeScan(s, gwCtx));
  } else {
    // 단건 fallback — 최상위에 직접 비콘 필드가 있는 경우
    events = [normalizeScan(root, gwCtx)];
  }

  return { packet, events, source: "tplink" };
}

module.exports = { normalizeTpLinkPayload, looksLikeTpLink };
