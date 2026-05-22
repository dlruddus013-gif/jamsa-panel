// presence-log-engine.js
// 비콘이 게이트웨이에 감지되면 → 어느 스팟인지 매핑 확인 → 직원/비콘 알바 매칭
// → presence_log 1건 생성 → (옵션) CCTV 분석 1회 트리거.
//
// localStorage keys
//   - jamsa_presence_logs     : [{id, at, gatewaySerial, zoneId, zoneName, cctvChannel,
//                                  beaconId, beaconName, employeeId?, employeeName?, rssi,
//                                  aiAnalysis?: {level, summary, category, analyzedAt}}]
//   - jamsa_gateway_zone_map  : [{gateway_serial, zone_id, zone_name, cctv_channel, ...}]
//   - jamsa_beacons           : { [uuid/mac]: {zone, name, employeeId?, employeeName?} }
//
// 외부 API
//   - getEffectiveCctvServerUrl() : CCTV 스냅샷 base URL (cctv 서버가 운영 중이어야 함)
//   - /api/cctv-ai-analyze        : POST {imageBase64, ch, zone} → {level, summary, ...}

const LOG_KEY  = "jamsa_presence_logs";
const GW_KEY   = "jamsa_gateway_zone_map";
const REG_KEY  = "jamsa_beacons";
const MAX_LOGS = 1000;
// 같은 (gateway, beacon) 쌍이 30초 이내에 반복 감지되면 1건으로 처리
const DEDUP_WINDOW_MS = 30_000;

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
  catch (e) { return fallback; }
}
function saveLogs(arr) {
  try { localStorage.setItem(LOG_KEY, JSON.stringify(arr.slice(0, MAX_LOGS))); }
  catch (e) { console.warn("[presence-log] save failed", e); }
}

export function getPresenceLogs() {
  return loadJson(LOG_KEY, []);
}
export function getGatewayZoneMap() {
  return loadJson(GW_KEY, []);
}

// 같은 (gateway, beacon) 쌍이 최근 윈도 안에 있으면 dedup
function _isDuplicate(logs, gatewaySerial, beaconId) {
  const now = Date.now();
  return logs.some(l =>
    l.gatewaySerial === gatewaySerial &&
    l.beaconId === beaconId &&
    (now - new Date(l.at).getTime()) < DEDUP_WINDOW_MS
  );
}

// 비콘 1건 감지 → log 1건 추가 (또는 dedup 시 null)
// detection: {gatewaySerial, beaconId, beaconName?, rssi?, at?}
export function recordDetection(detection) {
  if (!detection || !detection.gatewaySerial || !detection.beaconId) return null;
  const logs = getPresenceLogs();
  if (_isDuplicate(logs, detection.gatewaySerial, detection.beaconId)) return null;

  const gwMap = getGatewayZoneMap();
  const gw = gwMap.find(r => r.gateway_serial === detection.gatewaySerial);
  // 매핑 안 된 게이트웨이는 로그 안 남김 (스팸 방지) — 단 unknown 로그를 남기고 싶으면 여기 수정
  if (!gw) return null;

  const reg = loadJson(REG_KEY, {});
  const beaconInfo = reg[detection.beaconId] || reg[String(detection.beaconId).toUpperCase()] || {};

  const entry = {
    id: "p" + Date.now() + Math.random().toString(36).slice(2, 6),
    at: detection.at || new Date().toISOString(),
    gatewaySerial: detection.gatewaySerial,
    beaconId: detection.beaconId,
    beaconName: detection.beaconName || beaconInfo.name || `Beacon-${String(detection.beaconId).slice(-6)}`,
    employeeId: beaconInfo.employeeId || null,
    employeeName: beaconInfo.employeeName || beaconInfo.name || null,
    zoneId: gw.zone_id,
    zoneName: gw.zone_name,
    cctvChannel: gw.cctv_channel ?? null,
    rssi: detection.rssi ?? null,
  };

  const next = [entry, ...logs];
  saveLogs(next);
  // CustomEvent 발행 — UI 가 새 로그 알림 받음
  try { window.dispatchEvent(new CustomEvent("jamsa:presence-log", { detail: entry })); } catch (e) {}
  return entry;
}

// 한 detection batch 처리: payload 의 비콘 배열을 순회.
// shape: {gatewaySerial, beacons: [{uuid|mac, rssi, name}]}
export function processDetectionBatch(payload) {
  if (!payload) return [];
  const list = payload.beacons || payload.obj || payload.advertisements || [];
  if (!Array.isArray(list)) return [];
  const gatewaySerial = payload.gatewaySerial || payload.gateway || payload.gateway_serial;
  if (!gatewaySerial) return [];
  const created = [];
  for (const b of list) {
    const beaconId = b.mac || b.uuid || b.id;
    if (!beaconId) continue;
    const entry = recordDetection({
      gatewaySerial,
      beaconId,
      beaconName: b.name || b.deviceName,
      rssi: b.rssi != null ? Number(b.rssi) : null,
      at: b.ts ? new Date(b.ts).toISOString() : new Date().toISOString(),
    });
    if (entry) created.push(entry);
  }
  return created;
}

// (옵션) 1건의 presence_log 에 CCTV AI 분석을 수행하여 log 를 업데이트.
// 호출 측에서 명시적으로 호출 (자동 트리거하면 CCTV 서버 비가동 시 무거운 실패 반복).
//
// snapshotUrlGetter: (channel) => string  (없으면 기본 추정)
// 반환: 업데이트된 log 또는 null
export async function analyzeLogWithCctv(logId, snapshotUrlGetter) {
  const logs = getPresenceLogs();
  const idx = logs.findIndex(l => l.id === logId);
  if (idx < 0) return null;
  const log = logs[idx];
  if (!log.cctvChannel) return null;
  if (log.aiAnalysis) return log; // 이미 분석됨

  const baseUrl = (typeof snapshotUrlGetter === "function")
    ? snapshotUrlGetter(log.cctvChannel)
    : `/api/cctv-snapshot?channel=${log.cctvChannel}`;

  try {
    // 스냅샷 가져와 base64 변환
    const imgRes = await fetch(baseUrl, { cache: "no-store" });
    if (!imgRes.ok) throw new Error("snapshot HTTP " + imgRes.status);
    const blob = await imgRes.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
    const imageBase64 = String(dataUrl).split(",")[1];

    // AI 분석 API 호출
    const aiRes = await fetch("/api/cctv-ai-analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageBase64,
        ch: log.cctvChannel,
        zone: log.zoneName,
        context: log.employeeName
          ? `${log.employeeName}이(가) ${log.zoneName}에 진입한 직후 (RSSI ${log.rssi ?? '?'}) 의 영상입니다. 인물의 행동을 자세히 요약해주세요.`
          : `${log.zoneName} 진입 직후 영상 (RSSI ${log.rssi ?? '?'}). 활동 상태를 요약해주세요.`,
      }),
    });
    if (!aiRes.ok) throw new Error("AI HTTP " + aiRes.status);
    const ai = await aiRes.json();

    // 결과 머지
    const updated = {
      ...log,
      aiAnalysis: {
        level: ai.level || null,
        category: ai.category || null,
        summary: ai.summary || ai.detail || null,
        detail: ai.detail || null,
        score: ai.score ?? null,
        analyzedAt: new Date().toISOString(),
        provider: ai.provider || null,
        model: ai.model || null,
      },
    };
    const nextLogs = [...logs];
    nextLogs[idx] = updated;
    saveLogs(nextLogs);
    try { window.dispatchEvent(new CustomEvent("jamsa:presence-log-updated", { detail: updated })); } catch (e) {}
    return updated;
  } catch (e) {
    console.warn("[presence-log] AI analysis failed:", e?.message);
    return null;
  }
}

// 특정 날짜의 직원별 presence 로그를 시간순으로 묶어 worklog 항목 형식으로 변환
// 반환: [{authorId, author, items: [{at, content}], generalNote}]
export function buildPerEmployeeWorklog(dateISO) {
  const day = (dateISO || new Date().toISOString()).slice(0, 10);
  const logs = getPresenceLogs().filter(l => l.at?.slice(0, 10) === day && l.employeeName);
  // 직원별 그룹
  const byEmp = new Map();
  for (const l of logs.sort((a, b) => a.at.localeCompare(b.at))) {
    const key = l.employeeId || l.employeeName;
    if (!byEmp.has(key)) byEmp.set(key, { authorId: l.employeeId, author: l.employeeName, items: [] });
    const hhmm = l.at.slice(11, 16);
    const aiNote = l.aiAnalysis?.summary
      ? ` · AI: ${l.aiAnalysis.summary}`
      : "";
    byEmp.get(key).items.push({
      at: l.at,
      content: `${hhmm} ${l.zoneName} 진입${l.cctvChannel ? ` (CH${l.cctvChannel})` : ""}${aiNote}`,
      _logId: l.id,
    });
  }
  return Array.from(byEmp.values()).map(emp => ({
    ...emp,
    generalNote: `자동 생성 · ${day} 비콘 감지 ${emp.items.length}건 기반`,
  }));
}
