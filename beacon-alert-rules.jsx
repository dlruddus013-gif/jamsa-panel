// beacon-alert-rules.jsx
// ─────────────────────────────────────────────────────────────────
//  비콘 감지 이벤트 → 알림 규칙 평가 → Ppurio SMS 자동 발송
//
//  규칙 유형:
//   - unknown_beacon   : 등록되지 않은 비콘 감지 (보안)
//   - specific_beacon  : 특정 비콘이 감지될 때 (출근/도착)
//   - zone_enter       : 특정 비콘이 특정 zone에 진입
//   - zone_leave       : 특정 비콘이 특정 zone에서 이탈
//   - no_activity      : 특정 비콘이 N분간 미감지
//   - rssi_strong      : 매우 가까운 거리(RSSI ≥ -50)
//
//  데이터: localStorage `jamsa_beacon_alert_rules`, `jamsa_beacon_alert_log`,
//          `jamsa_beacon_last_seen` (비콘별 마지막 감지 시각/zone)
//  발송:   POST /api/auto-alerts  (autoCall=true)
// ─────────────────────────────────────────────────────────────────

import React, { useEffect, useMemo, useState } from "react";

export const ALERT_RULES_KEY  = "jamsa_beacon_alert_rules";
export const ALERT_LOG_KEY    = "jamsa_beacon_alert_log";
export const LAST_SEEN_KEY    = "jamsa_beacon_last_seen";   // { [beaconId]: { at, zoneId, rssi } }
export const COOLDOWN_KEY     = "jamsa_beacon_alert_cooldown"; // { [ruleId:beaconId]: at }

const DEFAULT_COOLDOWN_MIN = 5;
const DEFAULT_NO_ACTIVITY_MIN = 30;

// ─── 저장/로드 ─────────────────────────────────────────────────────
export function loadRules() {
  try { return JSON.parse(localStorage.getItem(ALERT_RULES_KEY) || "[]"); }
  catch (e) { return []; }
}
export function saveRules(rules) {
  try { localStorage.setItem(ALERT_RULES_KEY, JSON.stringify(rules)); } catch (e) {}
}
export function loadAlertLog() {
  try { return JSON.parse(localStorage.getItem(ALERT_LOG_KEY) || "[]"); }
  catch (e) { return []; }
}
function appendAlertLog(entry) {
  try {
    const arr = loadAlertLog();
    arr.unshift({ ...entry, id: Date.now() + Math.random(), at: new Date().toISOString() });
    localStorage.setItem(ALERT_LOG_KEY, JSON.stringify(arr.slice(0, 200)));
  } catch (e) {}
}
function loadLastSeen() {
  try { return JSON.parse(localStorage.getItem(LAST_SEEN_KEY) || "{}"); } catch (e) { return {}; }
}
function saveLastSeen(obj) {
  try { localStorage.setItem(LAST_SEEN_KEY, JSON.stringify(obj)); } catch (e) {}
}
function loadCooldown() {
  try { return JSON.parse(localStorage.getItem(COOLDOWN_KEY) || "{}"); } catch (e) { return {}; }
}
function saveCooldown(obj) {
  try { localStorage.setItem(COOLDOWN_KEY, JSON.stringify(obj)); } catch (e) {}
}

// ─── 발송기 (서버 호출) ────────────────────────────────────────────
async function fireAlert({ rule, beacon, zoneName, extra }) {
  const recipients = (rule.recipients || []).filter(r => r && r.phone);
  if (recipients.length === 0) return { ok: false, reason: "no_recipients" };
  const message = renderTemplate(rule.message, {
    name: beacon?.name || beacon?.id || "비콘",
    id:   beacon?.id || "-",
    zone: zoneName || rule.zoneName || "-",
    rssi: beacon?.rssi != null ? `${beacon.rssi}dBm` : "-",
    time: new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }),
    ...extra,
  });
  try {
    const res = await fetch("/api/auto-alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "beacon",
        zoneId: rule.zoneId || null,
        zoneName: zoneName || rule.zoneName || null,
        severity: rule.severity || "WARNING",
        message,
        recipients,
        autoCall: true,
        channelCh: rule.channelCh || null,
      }),
    });
    const data = await res.json().catch(() => ({}));
    appendAlertLog({
      ruleId: rule.id, ruleName: rule.name, condition: rule.condition,
      beaconId: beacon?.id, beaconName: beacon?.name, zoneName,
      message, recipients: recipients.map(r => r.phone),
      ok: !!data.ok, smsResults: data.smsResults || [],
      smsConfigured: data.smsConfigured,
    });
    return { ok: !!data.ok, ...data };
  } catch (e) {
    appendAlertLog({
      ruleId: rule.id, ruleName: rule.name, condition: rule.condition,
      beaconId: beacon?.id, beaconName: beacon?.name, zoneName, message,
      recipients: recipients.map(r => r.phone), ok: false, error: e.message,
    });
    return { ok: false, error: e.message };
  }
}

function renderTemplate(tmpl, ctx) {
  const t = tmpl || "[{time}] {zone} · {name} 비콘 이벤트 발생";
  return t.replace(/\{(\w+)\}/g, (_, k) => (ctx[k] != null ? String(ctx[k]) : `{${k}}`));
}

// ─── 규칙 평가 (한 비콘 감지마다 호출) ───────────────────────────────
//  beacon: { id, name, rssi, ... }
//  beaconReg: localStorage jamsa_beacons 의 등록 정보 { [beaconId]: { zone, name, ... } }
//  zones:  Array<{ id, name, ... }>
export function evaluateAndTrigger(beacon, { beaconReg = {}, zones = [] } = {}) {
  if (!beacon || !beacon.id) return [];
  const rules = loadRules().filter(r => r && r.enabled !== false);
  if (rules.length === 0) return [];

  const now = Date.now();
  const cooldown = loadCooldown();
  const lastSeen = loadLastSeen();
  const prev = lastSeen[beacon.id] || null;

  // 현재 비콘이 등록된 zone (있다면)
  const regEntry = beaconReg[beacon.id] || beaconReg[String(beacon.id).toUpperCase()] || null;
  const currentZoneId = regEntry?.zone || regEntry?.zoneId || null;
  const currentZone = currentZoneId ? zones.find(z => z.id === currentZoneId) : null;
  const currentZoneName = currentZone?.name || null;

  const fired = [];
  for (const rule of rules) {
    const cdKey = `${rule.id}:${beacon.id}`;
    const cdMs = (rule.cooldownMin ?? DEFAULT_COOLDOWN_MIN) * 60_000;
    const lastFired = cooldown[cdKey] || 0;
    if (now - lastFired < cdMs) continue;

    let match = false;
    let extra = {};
    switch (rule.condition) {
      case "unknown_beacon":
        // 등록 안 된 비콘
        match = !regEntry;
        break;
      case "specific_beacon":
        match = rule.beaconId && (beacon.id === rule.beaconId);
        break;
      case "zone_enter":
        // 직전 zone과 다르고 현재 zone이 규칙 지정 zone과 일치
        match = rule.zoneId && currentZoneId === rule.zoneId
                && (!prev || prev.zoneId !== rule.zoneId);
        break;
      case "zone_leave":
        // 직전 zone이 규칙 지정 zone이었는데 지금은 다른 곳
        match = rule.zoneId && prev?.zoneId === rule.zoneId
                && currentZoneId !== rule.zoneId;
        // zone_leave는 evaluateInactivity가 보강 (이 함수에서는 다른 zone 진입 시점에 트리거)
        break;
      case "rssi_strong":
        match = beacon.rssi != null && beacon.rssi >= (rule.rssiThreshold ?? -50);
        extra = { rssi: `${beacon.rssi}dBm` };
        break;
      // no_activity 는 별도 타이머에서 평가 (evaluateInactivity)
      default: match = false;
    }
    if (rule.beaconIdFilter && rule.beaconIdFilter !== beacon.id && rule.condition !== "specific_beacon") {
      // beaconIdFilter 가 있으면 그 비콘에만 적용
      match = false;
    }
    if (match) {
      cooldown[cdKey] = now;
      fired.push({ rule, beacon, zoneName: currentZoneName, extra });
    }
  }
  saveCooldown(cooldown);

  // 마지막 감지 정보 갱신
  lastSeen[beacon.id] = { at: now, zoneId: currentZoneId, rssi: beacon.rssi ?? null, name: beacon.name || null };
  saveLastSeen(lastSeen);

  // 발송 비동기 (await 안 함 — 감지 흐름 막지 않도록)
  fired.forEach(f => { fireAlert(f).catch(() => {}); });
  return fired;
}

// ─── 미감지(부재) 평가 — 1분마다 호출 ──────────────────────────────
export function evaluateInactivity({ beaconReg = {}, zones = [] } = {}) {
  const rules = loadRules().filter(r => r && r.enabled !== false && r.condition === "no_activity");
  if (rules.length === 0) return [];
  const now = Date.now();
  const cooldown = loadCooldown();
  const lastSeen = loadLastSeen();
  const fired = [];
  for (const rule of rules) {
    const thresholdMs = (rule.inactiveMinutes ?? DEFAULT_NO_ACTIVITY_MIN) * 60_000;
    const targets = rule.beaconId
      ? [rule.beaconId]
      : Object.keys(beaconReg); // 비콘 미지정 시 등록된 모든 비콘 대상
    for (const bid of targets) {
      const seen = lastSeen[bid];
      const lastAt = seen?.at || 0;
      if (now - lastAt < thresholdMs) continue;
      const cdKey = `${rule.id}:${bid}`;
      const cdMs = (rule.cooldownMin ?? DEFAULT_COOLDOWN_MIN) * 60_000;
      if (now - (cooldown[cdKey] || 0) < cdMs) continue;
      cooldown[cdKey] = now;
      const reg = beaconReg[bid] || {};
      const zoneName = zones.find(z => z.id === (reg.zone || reg.zoneId))?.name || null;
      fired.push({
        rule,
        beacon: { id: bid, name: reg.name || bid },
        zoneName,
        extra: { minutes: Math.floor((now - lastAt) / 60_000) },
      });
    }
  }
  saveCooldown(cooldown);
  fired.forEach(f => { fireAlert(f).catch(() => {}); });
  return fired;
}

// ─── 테스트 발송 (규칙 작성 후 검증용) ─────────────────────────────
export async function testFireRule(rule, beacon = { id: "TEST-BEACON", name: "테스트 비콘", rssi: -65 }) {
  return fireAlert({ rule, beacon, zoneName: rule.zoneName || "테스트 구역" });
}

// ─── 기본 규칙 프리셋 ──────────────────────────────────────────────
export const PRESET_RULES = [
  {
    name: "🚨 미등록 비콘 감지",
    condition: "unknown_beacon",
    severity: "WARNING",
    cooldownMin: 10,
    message: "[잠사 보안] 미등록 비콘 감지 — ID:{id} RSSI:{rssi} ({time})",
    recipients: [],
    enabled: true,
  },
  {
    name: "📡 가까운 비콘 감지 (RSSI ≥ -50)",
    condition: "rssi_strong",
    rssiThreshold: -50,
    severity: "INFO",
    cooldownMin: 15,
    message: "[잠사] {name} 비콘 근접 감지 (RSSI {rssi}) — {zone} ({time})",
    recipients: [],
    enabled: false,
  },
  {
    name: "⏰ 30분간 비콘 미감지",
    condition: "no_activity",
    inactiveMinutes: 30,
    severity: "WARNING",
    cooldownMin: 30,
    message: "[잠사] {name} 비콘 {minutes}분 미감지 — 마지막 위치 {zone} ({time})",
    recipients: [],
    enabled: false,
  },
];

// ─────────────────────────────────────────────────────────────────
//  규칙 관리 UI (간단한 모달)
// ─────────────────────────────────────────────────────────────────
export function BeaconAlertRulesPanel({ zones = [], beaconReg = {} }) {
  const [rules, setRules] = useState(loadRules);
  const [log, setLog] = useState(loadAlertLog);
  const [editing, setEditing] = useState(null); // 편집 중인 rule
  const [view, setView] = useState("rules"); // 'rules' | 'log'

  useEffect(() => {
    // 1분마다 부재 평가 + 로그 갱신
    const t = setInterval(() => {
      try { evaluateInactivity({ beaconReg, zones }); } catch (e) {}
      setLog(loadAlertLog());
    }, 60_000);
    return () => clearInterval(t);
  }, [JSON.stringify(beaconReg), JSON.stringify(zones)]);

  const reload = () => { setRules(loadRules()); setLog(loadAlertLog()); };

  const addPreset = (preset) => {
    const next = [...rules, { ...preset, id: "rule_" + Date.now() }];
    saveRules(next); setRules(next);
  };
  const removeRule = (id) => {
    if (!confirm("이 규칙을 삭제할까요?")) return;
    const next = rules.filter(r => r.id !== id);
    saveRules(next); setRules(next);
  };
  const toggleRule = (id) => {
    const next = rules.map(r => r.id === id ? { ...r, enabled: !(r.enabled !== false) } : r);
    saveRules(next); setRules(next);
  };
  const saveEditing = () => {
    if (!editing) return;
    if (!editing.name?.trim()) { alert("규칙 이름을 입력하세요"); return; }
    const exists = rules.some(r => r.id === editing.id);
    const next = exists ? rules.map(r => r.id === editing.id ? editing : r) : [...rules, editing];
    saveRules(next); setRules(next); setEditing(null);
  };
  const newRule = () => setEditing({
    id: "rule_" + Date.now(),
    name: "새 규칙",
    enabled: true,
    condition: "unknown_beacon",
    severity: "WARNING",
    cooldownMin: 5,
    recipients: [],
    message: "[잠사] {name} 비콘 이벤트 — {zone} ({time})",
  });
  const testRule = async (r) => {
    if ((r.recipients || []).length === 0) { alert("수신자 phone을 1개 이상 추가하세요"); return; }
    const res = await testFireRule(r);
    alert(res.ok ? "테스트 발송 성공 (SMS 결과는 로그 확인)" : "발송 실패: " + (res.error || res.reason || "unknown"));
    reload();
  };

  return (
    <div style={{ padding: 16, background: "#0f172a", color: "#f1f5f9", minHeight: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800 }}>🔔 비콘 감지 → 자동 문자 알림</div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 3 }}>
            비콘이 특정 조건으로 감지되면 등록된 phone으로 SMS 자동 발송 (Ppurio)
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => setView("rules")} style={tabBtn(view === "rules")}>📋 규칙 ({rules.length})</button>
          <button onClick={() => setView("log")} style={tabBtn(view === "log")}>📜 이력 ({log.length})</button>
        </div>
      </div>

      {view === "rules" && (
        <>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
            <button onClick={newRule} style={primaryBtn}>＋ 새 규칙</button>
            <span style={{ fontSize: 11, color: "#64748b", alignSelf: "center", marginLeft: 4 }}>프리셋:</span>
            {PRESET_RULES.map((p, i) => (
              <button key={i} onClick={() => addPreset(p)} style={chipBtn} title="이 프리셋을 규칙으로 추가">
                + {p.name}
              </button>
            ))}
          </div>

          {rules.length === 0 ? (
            <div style={emptyBox}>
              아직 등록된 규칙이 없습니다.<br />
              <span style={{ color: "#94a3b8" }}>프리셋을 추가하거나 ＋ 새 규칙을 만들어 보세요.</span>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {rules.map(r => (
                <RuleRow key={r.id} rule={r}
                  zones={zones}
                  onEdit={() => setEditing(r)}
                  onRemove={() => removeRule(r.id)}
                  onToggle={() => toggleRule(r.id)}
                  onTest={() => testRule(r)} />
              ))}
            </div>
          )}
        </>
      )}

      {view === "log" && (
        <AlertLogList log={log} onRefresh={reload} />
      )}

      {editing && (
        <RuleEditModal
          rule={editing}
          zones={zones}
          beaconReg={beaconReg}
          onChange={setEditing}
          onCancel={() => setEditing(null)}
          onSave={saveEditing}
        />
      )}
    </div>
  );
}

const tabBtn = (active) => ({
  padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: 800, cursor: "pointer",
  background: active ? "rgba(167,139,250,0.25)" : "transparent",
  border: active ? "1px solid rgba(167,139,250,0.5)" : "1px solid rgba(255,255,255,0.12)",
  color: active ? "#ddd6fe" : "#94a3b8",
});
const primaryBtn = { padding: "6px 12px", borderRadius: 6, background: "#10b981", color: "#0f172a", border: "none", fontSize: 12, fontWeight: 800, cursor: "pointer" };
const chipBtn = { padding: "5px 10px", borderRadius: 5, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", color: "#cbd5e1", fontSize: 11, cursor: "pointer" };
const emptyBox = { padding: 30, textAlign: "center", color: "#cbd5e1", fontSize: 13, background: "rgba(255,255,255,0.03)", border: "1px dashed rgba(255,255,255,0.1)", borderRadius: 8 };

function CONDITION_LABEL(c) {
  return {
    unknown_beacon:  "🚨 미등록 비콘 감지",
    specific_beacon: "📡 특정 비콘 감지",
    zone_enter:      "➡️ 구역 진입",
    zone_leave:      "⬅️ 구역 이탈",
    no_activity:     "⏰ 일정 시간 미감지",
    rssi_strong:     "📶 가까운 거리 (RSSI)",
  }[c] || c;
}

function RuleRow({ rule, zones, onEdit, onRemove, onToggle, onTest }) {
  const en = rule.enabled !== false;
  const recipients = rule.recipients || [];
  const zone = zones.find(z => z.id === rule.zoneId);
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "1fr auto", gap: 10, padding: 12,
      background: en ? "rgba(52,211,153,0.06)" : "rgba(255,255,255,0.03)",
      border: `1px solid ${en ? "rgba(52,211,153,0.25)" : "rgba(255,255,255,0.08)"}`,
      borderRadius: 8,
    }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: en ? "#f1f5f9" : "#64748b" }}>{rule.name}</span>
          <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 10, background: "rgba(167,139,250,0.2)", color: "#ddd6fe", fontWeight: 700 }}>
            {CONDITION_LABEL(rule.condition)}
          </span>
          {rule.severity && (
            <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 10,
              background: rule.severity === "DANGER" ? "rgba(220,38,38,0.25)" : rule.severity === "WARNING" ? "rgba(245,158,11,0.25)" : "rgba(59,130,246,0.25)",
              color: rule.severity === "DANGER" ? "#fca5a5" : rule.severity === "WARNING" ? "#fcd34d" : "#93c5fd",
              fontWeight: 700 }}>
              {rule.severity}
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: "#94a3b8", lineHeight: 1.5 }}>
          {rule.beaconId && <>비콘: <code style={{ background: "rgba(0,0,0,0.3)", padding: "1px 5px", borderRadius: 3 }}>{rule.beaconId}</code> · </>}
          {zone && <>구역: <strong style={{ color: "#cbd5e1" }}>{zone.name}</strong> · </>}
          {rule.inactiveMinutes != null && <>{rule.inactiveMinutes}분 미감지 · </>}
          {rule.rssiThreshold != null && <>RSSI ≥ {rule.rssiThreshold} · </>}
          쿨다운 {rule.cooldownMin || 5}분 · 수신자 {recipients.length}명
        </div>
        {recipients.length > 0 && (
          <div style={{ marginTop: 4, fontSize: 10, color: "#64748b", fontFamily: "ui-monospace,monospace" }}>
            📞 {recipients.map(r => (r.name ? `${r.name} ${r.phone}` : r.phone)).join(", ")}
          </div>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "stretch" }}>
        <button onClick={onToggle} style={{ padding: "4px 10px", borderRadius: 4, background: en ? "rgba(52,211,153,0.2)" : "rgba(100,116,139,0.2)", border: en ? "1px solid rgba(52,211,153,0.4)" : "1px solid rgba(100,116,139,0.4)", color: en ? "#6ee7b7" : "#94a3b8", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>
          {en ? "● 활성" : "○ 비활성"}
        </button>
        <button onClick={onEdit} style={{ padding: "4px 10px", borderRadius: 4, background: "rgba(99,102,241,0.2)", border: "1px solid rgba(99,102,241,0.4)", color: "#a5b4fc", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>✎ 편집</button>
        <button onClick={onTest} style={{ padding: "4px 10px", borderRadius: 4, background: "rgba(245,158,11,0.18)", border: "1px solid rgba(245,158,11,0.35)", color: "#fcd34d", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>📨 테스트</button>
        <button onClick={onRemove} style={{ padding: "4px 10px", borderRadius: 4, background: "rgba(220,38,38,0.18)", border: "1px solid rgba(220,38,38,0.35)", color: "#fca5a5", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>🗑 삭제</button>
      </div>
    </div>
  );
}

function AlertLogList({ log, onRefresh }) {
  if (log.length === 0) return <div style={emptyBox}>아직 발송 이력이 없습니다.</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: "#94a3b8" }}>최근 {log.length}건 (최대 200건 보관)</span>
        <button onClick={onRefresh} style={chipBtn}>↻ 새로고침</button>
      </div>
      {log.map(e => (
        <div key={e.id} style={{ padding: "8px 12px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: e.ok ? "#34d399" : "#f87171", flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, color: "#cbd5e1", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.message}</div>
            <div style={{ fontSize: 9, color: "#64748b", marginTop: 2, fontFamily: "ui-monospace,monospace" }}>
              {new Date(e.at).toLocaleString("ko-KR")} · {e.ruleName || "—"} · {(e.recipients || []).join(",")}
              {e.error && <span style={{ color: "#f87171" }}> · {e.error}</span>}
              {e.smsConfigured === false && <span style={{ color: "#fbbf24" }}> · SMS 미설정 (Ppurio env)</span>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function RuleEditModal({ rule, zones, beaconReg, onChange, onCancel, onSave }) {
  const set = (patch) => onChange({ ...rule, ...patch });
  const recipients = rule.recipients || [];
  const updRecipients = (arr) => set({ recipients: arr });
  const addRecipient = () => updRecipients([...recipients, { name: "", phone: "" }]);
  const removeRecipient = (i) => updRecipients(recipients.filter((_, j) => j !== i));
  const setRecipient = (i, patch) => updRecipients(recipients.map((r, j) => j === i ? { ...r, ...patch } : r));

  const beaconOptions = useMemo(() => Object.entries(beaconReg).map(([id, info]) => ({
    id, label: `${info?.name || id} ${id !== info?.name ? `(${id.slice(-8)})` : ""}`
  })), [beaconReg]);

  return (
    <div onClick={onCancel} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: "100%", maxWidth: 560, maxHeight: "92vh", overflowY: "auto", background: "#0f172a", color: "#f1f5f9", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, padding: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 12 }}>🔔 알림 규칙 편집</div>

        <Field label="규칙 이름">
          <input value={rule.name || ""} onChange={e => set({ name: e.target.value })} style={input} />
        </Field>

        <Field label="발생 조건">
          <select value={rule.condition} onChange={e => set({ condition: e.target.value })} style={input}>
            <option value="unknown_beacon">🚨 미등록 비콘 감지</option>
            <option value="specific_beacon">📡 특정 비콘 감지</option>
            <option value="zone_enter">➡️ 특정 구역 진입</option>
            <option value="zone_leave">⬅️ 특정 구역 이탈</option>
            <option value="no_activity">⏰ 일정 시간 미감지</option>
            <option value="rssi_strong">📶 가까운 거리 (RSSI)</option>
          </select>
        </Field>

        {(rule.condition === "specific_beacon" || rule.condition === "zone_enter" || rule.condition === "zone_leave" || rule.condition === "no_activity") && (
          <Field label="대상 비콘 (선택)">
            {beaconOptions.length > 0 ? (
              <select value={rule.beaconId || ""} onChange={e => set({ beaconId: e.target.value })} style={input}>
                <option value="">— 모든 등록된 비콘 —</option>
                {beaconOptions.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
              </select>
            ) : (
              <input value={rule.beaconId || ""} onChange={e => set({ beaconId: e.target.value })} placeholder="비콘 MAC 또는 UUID" style={input} />
            )}
          </Field>
        )}

        {(rule.condition === "zone_enter" || rule.condition === "zone_leave") && (
          <Field label="대상 구역">
            <select value={rule.zoneId || ""} onChange={e => {
              const z = zones.find(z => z.id === e.target.value);
              set({ zoneId: e.target.value, zoneName: z?.name || null });
            }} style={input}>
              <option value="">— 구역 선택 —</option>
              {zones.map(z => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>
          </Field>
        )}

        {rule.condition === "no_activity" && (
          <Field label="미감지 시간(분)">
            <input type="number" min="1" max="1440" value={rule.inactiveMinutes ?? 30} onChange={e => set({ inactiveMinutes: parseInt(e.target.value) || 30 })} style={input} />
          </Field>
        )}

        {rule.condition === "rssi_strong" && (
          <Field label="RSSI 임계값 (이상)">
            <input type="number" value={rule.rssiThreshold ?? -50} onChange={e => set({ rssiThreshold: parseInt(e.target.value) || -50 })} style={input} />
          </Field>
        )}

        <Field label="중요도">
          <select value={rule.severity || "WARNING"} onChange={e => set({ severity: e.target.value })} style={input}>
            <option value="INFO">INFO (정보)</option>
            <option value="WARNING">WARNING (주의)</option>
            <option value="DANGER">DANGER (위험)</option>
          </select>
        </Field>

        <Field label="쿨다운 (같은 비콘 반복 발송 방지, 분)">
          <input type="number" min="1" max="1440" value={rule.cooldownMin ?? 5} onChange={e => set({ cooldownMin: parseInt(e.target.value) || 5 })} style={input} />
        </Field>

        <Field label={`SMS 발송 메시지 템플릿 (사용 변수: {name} {id} {zone} {rssi} {time} ${rule.condition === "no_activity" ? "{minutes}" : ""})`}>
          <textarea value={rule.message || ""} onChange={e => set({ message: e.target.value })} rows={2} style={{ ...input, fontFamily: "ui-monospace,monospace", resize: "vertical" }} />
        </Field>

        <Field label={`수신자 (${recipients.length}명) · Ppurio SMS 발송`}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {recipients.map((r, i) => (
              <div key={i} style={{ display: "flex", gap: 6 }}>
                <input value={r.name || ""} onChange={e => setRecipient(i, { name: e.target.value })} placeholder="이름" style={{ ...input, flex: "0 0 110px" }} />
                <input value={r.phone || ""} onChange={e => setRecipient(i, { phone: e.target.value })} placeholder="010-1234-5678" style={{ ...input, flex: 1, fontFamily: "ui-monospace,monospace" }} />
                <button onClick={() => removeRecipient(i)} style={{ padding: "6px 10px", borderRadius: 5, background: "rgba(220,38,38,0.18)", border: "1px solid rgba(220,38,38,0.35)", color: "#fca5a5", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>×</button>
              </div>
            ))}
            <button onClick={addRecipient} style={{ padding: "6px 10px", borderRadius: 5, background: "rgba(255,255,255,0.06)", border: "1px dashed rgba(255,255,255,0.2)", color: "#cbd5e1", fontSize: 11, cursor: "pointer" }}>＋ 수신자 추가</button>
          </div>
        </Field>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 14, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
          <button onClick={onCancel} style={chipBtn}>취소</button>
          <button onClick={onSave} style={primaryBtn}>저장</button>
        </div>
      </div>
    </div>
  );
}

const input = {
  width: "100%", padding: "7px 10px", borderRadius: 5,
  background: "#0b1220", border: "1px solid rgba(255,255,255,0.12)",
  color: "#f1f5f9", fontSize: 12, fontFamily: "inherit",
};

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}
