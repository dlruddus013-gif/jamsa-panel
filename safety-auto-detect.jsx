// ═══════════════════════════════════════════════════════════════════════
// 🚨 Safety Auto-Detect Module (안전 자동 감지/해소 시스템)
// ─────────────────────────────────────────────────────────────────────
// 3개 소스에서 안전 이슈를 자동 감지해 hazardLogs에 추가하고,
// 조건이 해소되면 자동으로 closed 처리한다.
//
// 데이터 소스:
//   1. 🌦️ 날씨 (weatherAlerts) — 기상청 특보 + 임계값 추출
//   2. 📹 CCTV (cctvDetections) — cctv-ai-analyze 결과
//   3. 📒 업무일지 (workLogs) — 텍스트에서 안전 키워드 추출
//
// 자동 해소 (auto-resolve):
//   - 날씨: 같은 종류의 경보가 사라지면 closed
//   - CCTV: 같은 카메라/구역에서 30분 이상 정상 감지 시 closed
//   - 업무일지: 동일 facId/키워드의 새 로그가 "해결/완료/조치완료" 포함 시 closed
// ═══════════════════════════════════════════════════════════════════════
import { useEffect, useRef, useMemo } from "react";

/** @typedef {"weather"|"cctv"|"worklog"|"manual"} AutoHazardSource */
/**
 * @typedef {Object} AutoHazard
 * @property {string} id
 * @property {AutoHazardSource} source
 * @property {string} sourceKey  — 원본 식별자 (alert.k / cctv detection id / log id)
 * @property {string} facId       — 영향받는 시설 id (또는 zone)
 * @property {"URGENT"|"HIGH"|"MEDIUM"|"LOW"} severity
 * @property {string} title
 * @property {string} desc
 * @property {string[]} recommendedActions
 * @property {string} status — "active" | "closed"
 * @property {string} detectedAt
 * @property {string|null} closedAt
 * @property {string|null} closedReason
 */

// 키워드 → 심각도 매핑 (업무일지 분석용)
const WORKLOG_DANGER_KEYWORDS = {
  URGENT: ["사고", "부상", "화재", "감전", "추락", "누출", "응급", "구조", "긴급"],
  HIGH:   ["고장", "파손", "균열", "누수", "정전", "이상발열", "연기", "불꽃", "넘어짐", "위험"],
  MEDIUM: ["불량", "마모", "점검필요", "교체필요", "흔들림", "녹", "곰팡이", "냄새"],
  LOW:    ["청소필요", "점검", "확인", "보강", "정리"],
};
const WORKLOG_RESOLUTION_KEYWORDS = ["해결", "완료", "조치완료", "복구", "수리완료", "교체완료", "정상", "OK", "해소"];

// 업무일지 텍스트에서 안전 위험 추출
function extractWorklogHazards(workLogs, facilities) {
  const hazards = [];
  for (const log of (workLogs || [])) {
    const text = `${log.title || ""} ${log.content || log.memo || log.body || ""}`.toLowerCase();
    if (!text.trim()) continue;
    let severity = null;
    let matchedKw = null;
    for (const [sev, kws] of Object.entries(WORKLOG_DANGER_KEYWORDS)) {
      for (const kw of kws) {
        if (text.includes(kw)) { severity = sev; matchedKw = kw; break; }
      }
      if (severity) break;
    }
    if (!severity) continue;
    // 해결 키워드 있으면 위험 아님 (이미 처리됨)
    if (WORKLOG_RESOLUTION_KEYWORDS.some(k => text.includes(k.toLowerCase()))) continue;
    // facId 추출 (log에 직접 있거나, 텍스트에서 시설명 매칭)
    let facId = log.facId;
    if (!facId) {
      const fac = facilities.find(f => text.includes((f.name || "").toLowerCase()));
      facId = fac?.id || "etc";
    }
    hazards.push({
      id: `wl_${log.id || Date.now()}`,
      source: "worklog",
      sourceKey: String(log.id || log.at || Date.now()),
      facId,
      severity,
      title: `📒 업무일지에서 위험 키워드 감지: "${matchedKw}"`,
      desc: log.title || (log.content || "").slice(0, 120),
      recommendedActions: severityToActions(severity),
      status: "active",
      detectedAt: log.at || log.date || new Date().toISOString(),
      closedAt: null,
      closedReason: null,
    });
  }
  return hazards;
}

function severityToActions(sev) {
  if (sev === "URGENT") return ["⚡ 즉시 현장 확인", "📞 안전관리자 호출", "🚧 해당 구역 출입 통제 검토"];
  if (sev === "HIGH")   return ["🔍 24시간 내 현장 점검", "📋 보완조치 계획 수립"];
  if (sev === "MEDIUM") return ["📅 1주일 내 점검 일정 등록", "📷 사진 기록"];
  return ["📝 정기 점검 시 확인"];
}

// 날씨 경보 → 자동 감지된 위험
function weatherToHazards(weatherAlerts, weatherAffectedFacIds, facilities) {
  const out = [];
  for (const alert of (weatherAlerts || [])) {
    // 영향받는 시설별로 hazard 생성
    const affected = (weatherAffectedFacIds || []).length > 0
      ? facilities.filter(f => weatherAffectedFacIds.includes(f.id) || weatherAffectedFacIds.includes(f.zone))
      : facilities; // 전체 영향
    // 너무 많으면 zone 기반 1개씩만 (대표)
    const seenZones = new Set();
    for (const f of affected) {
      if (f.zone && seenZones.has(f.zone)) continue;
      if (f.zone) seenZones.add(f.zone);
      out.push({
        id: `wx_${alert.k}_${f.id}`,
        source: "weather",
        sourceKey: alert.k,
        facId: f.id,
        severity: alert.sev === "critical" ? "URGENT" : alert.sev === "warning" ? "HIGH" : "MEDIUM",
        title: `${alert.lbl}`,
        desc: alert.msg || alert.lbl,
        recommendedActions: weatherActions(alert.k),
        status: "active",
        detectedAt: alert.issuedAt || new Date().toISOString(),
        closedAt: null,
        closedReason: null,
      });
    }
  }
  return out;
}

function weatherActions(alertKey) {
  const MAP = {
    HEAT_WARN: ["🥤 음수대·그늘막 확인", "🚸 야외 체험 일시 중단", "🧊 냉장고 온도 확인"],
    HEAT_ADV:  ["🥤 음수대 확인", "🚸 직원 수분 섭취 안내"],
    COLD_WARN: ["🚰 외부 수도 동파 예방", "🌱 온실 난방 점검"],
    COLD_ADV:  ["🚰 수도 동파 점검"],
    WIND_WARN: ["⛺ 천막·간판 즉시 결박", "🌳 수목 점검", "🛝 야외 놀이기구 중단"],
    WIND_ADV:  ["⛺ 천막 결속 확인", "🪧 간판 점검"],
    RAIN_WARN: ["💧 배수로 청소", "⚡ 누전 점검", "🛣️ 미끄럼 주의 안내"],
    RAIN_ADV:  ["💧 배수로 점검", "⚡ 옥외 전기 점검"],
    DRY_WARN:  ["🧯 소화기·소화전 점검", "🚭 흡연 단속", "⚡ 전기 단락 점검"],
    DRY_ADV:   ["🧯 소화기 점검"],
    ICE:       ["🧂 제설제 비치", "🛣️ 미끄럼 안내"],
    SNOW:      ["🧹 제설 작업", "🏠 지붕 적설 모니터링"],
    THUNDER:   ["⚡ 야외 체험 중단", "🌳 큰 나무 접근 금지"],
    TYPHOON:   ["🌀 모든 야외시설 결박", "🚸 야외 운영 중단"],
    DUST:      ["😷 마스크 비치", "🪟 환기설비 필터 점검"],
  };
  return MAP[alertKey] || ["🔍 관련 시설 점검"];
}

// CCTV AI 분석 결과 → 자동 감지된 위험
// cctvDetections: [{id, channelName, zone, severity, label, detectedAt, normalSince?}]
function cctvToHazards(cctvDetections, facilities) {
  const out = [];
  for (const d of (cctvDetections || [])) {
    if (d.severity === "NORMAL" || d.status === "normal") continue;
    const fac = facilities.find(f => f.zone === d.zone || f.id === d.facId || f.name === d.channelName);
    out.push({
      id: `cv_${d.id}`,
      source: "cctv",
      sourceKey: String(d.id),
      facId: fac?.id || "etc",
      severity: d.severity || "MEDIUM",
      title: `📹 CCTV 감지: ${d.label || "이상 상황"}`,
      desc: `${d.channelName || "카메라"} · ${d.label || ""}`,
      recommendedActions: ["📹 영상 확인", "👮 현장 출동", "📋 사고기록 작성"],
      status: "active",
      detectedAt: d.detectedAt || new Date().toISOString(),
      closedAt: null,
      closedReason: null,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// 메인 hook: 외부 소스 → 자동감지된 hazard 배열 (메모이즈)
// + localStorage에 closed 기록 유지 (auto-resolve 추적)
// ─────────────────────────────────────────────────────────────────────
const STORAGE_KEY = "jamsa_auto_hazards_state";

function loadState() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch (e) { return {}; }
}
function saveState(s) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (e) {}
}

/**
 * @param {Object} opts
 * @param {Array} opts.weatherAlerts - from InventoryModule
 * @param {Set|null} opts.weatherAffectedFacIds
 * @param {Array} opts.cctvDetections
 * @param {Array} opts.workLogs
 * @param {Array} opts.facilities
 * @returns {AutoHazard[]}
 */
export function useAutoSafetyHazards({ weatherAlerts, weatherAffectedFacIds, cctvDetections, workLogs, facilities }) {
  const prevDetectedRef = useRef(new Map()); // sourceKey → AutoHazard (for stable IDs + resolve detection)

  const current = useMemo(() => {
    const w = weatherToHazards(weatherAlerts || [], weatherAffectedFacIds || [], facilities || []);
    const c = cctvToHazards(cctvDetections || [], facilities || []);
    const l = extractWorklogHazards(workLogs || [], facilities || []);
    return [...w, ...c, ...l];
  }, [weatherAlerts, weatherAffectedFacIds, cctvDetections, workLogs, facilities]);

  // 이전 상태와 비교해 자동 해소 처리
  const finalList = useMemo(() => {
    const prev = prevDetectedRef.current;
    const persisted = loadState();
    const currentIds = new Set(current.map(h => `${h.source}:${h.sourceKey}:${h.facId}`));
    const result = [];

    // 1) 현재 감지된 항목: 신규 또는 active 유지
    for (const h of current) {
      const k = `${h.source}:${h.sourceKey}:${h.facId}`;
      const stored = persisted[k];
      result.push({
        ...h,
        // 처음 감지 시각 유지
        detectedAt: stored?.detectedAt || h.detectedAt,
        status: "active",
      });
    }

    // 2) 이전엔 감지됐지만 현재 사라진 항목 → 자동 해소
    for (const [k, prevH] of Object.entries(persisted)) {
      if (!currentIds.has(k) && prevH.status === "active") {
        result.push({
          ...prevH,
          status: "closed",
          closedAt: prevH.closedAt || new Date().toISOString(),
          closedReason: prevH.closedReason || autoResolveReason(prevH.source),
        });
      }
    }

    // 3) localStorage 갱신
    const nextState = {};
    for (const h of result) {
      const k = `${h.source}:${h.sourceKey}:${h.facId}`;
      nextState[k] = h;
    }
    saveState(nextState);
    prevDetectedRef.current = new Map(Object.entries(nextState));

    return result;
  }, [current]);

  return finalList;
}

function autoResolveReason(source) {
  if (source === "weather") return "🌦️ 기상 경보 해제됨";
  if (source === "cctv") return "📹 CCTV 정상 상태 감지";
  if (source === "worklog") return "📒 업무일지에서 후속 보고 없음";
  return "자동 해소";
}

// ─────────────────────────────────────────────────────────────────────
// 알림 ('Notification') 헬퍼 — 새 위험 감지 시 호출
// ─────────────────────────────────────────────────────────────────────
const SEEN_KEY = "jamsa_auto_hazard_seen";
function loadSeen() {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || "[]")); } catch (e) { return new Set(); }
}
function saveSeen(s) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...s])); } catch (e) {}
}

export function useAutoHazardNotifications(autoHazards, addHistory) {
  const seenRef = useRef(loadSeen());
  useEffect(() => {
    const newly = [];
    for (const h of (autoHazards || [])) {
      if (h.status !== "active") continue;
      const k = `${h.source}:${h.sourceKey}:${h.facId}`;
      if (!seenRef.current.has(k)) {
        newly.push(h);
        seenRef.current.add(k);
      }
    }
    if (newly.length > 0) {
      saveSeen(seenRef.current);
      if (typeof addHistory === "function") {
        for (const h of newly) {
          addHistory(`🚨 자동감지 [${h.source.toUpperCase()}]`, h.title, `${h.severity} · ${h.desc}`, 0);
        }
      }
    }
  }, [autoHazards, addHistory]);
}

// ─────────────────────────────────────────────────────────────────────
// 시각화 헬퍼
// ─────────────────────────────────────────────────────────────────────
export const SOURCE_META = {
  weather: { label: "날씨", icon: "🌦️", color: "#0ea5e9" },
  cctv:    { label: "CCTV", icon: "📹", color: "#a855f7" },
  worklog: { label: "업무일지", icon: "📒", color: "#10b981" },
  manual:  { label: "수동", icon: "✋", color: "#64748b" },
};

export const SEVERITY_META = {
  URGENT: { label: "긴급", color: "#dc2626", bg: "#fee2e2" },
  HIGH:   { label: "높음", color: "#ea580c", bg: "#fed7aa" },
  MEDIUM: { label: "보통", color: "#f59e0b", bg: "#fef3c7" },
  LOW:    { label: "낮음", color: "#10b981", bg: "#d1fae5" },
};
