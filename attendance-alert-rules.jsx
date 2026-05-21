// attendance-alert-rules.jsx
// ─────────────────────────────────────────────────────────────────
//  출퇴근 이벤트 → SMS 자동 알림 (Ppurio /api/auto-alerts)
//
//  설정(localStorage):
//   jamsa_attendance_alert_config = {
//     enabled: true/false,
//     recipients: [{name, phone}],
//     events: { checkIn: true, checkOut: true, late: true, absent: true, longIdle: true },
//     standard: { hour: 9, minute: 0, graceMin: 10 },   // 정시 09:10 까지
//     longIdleMin: 480,                                  // 8시간 이상 활동 없으면
//     cooldownMin: 5,
//     deptFilter: 'all' | [deptId, ...],                 // 특정 부서만
//     staffFilter: 'all' | [staffId, ...],
//   }
//   jamsa_attendance_alert_log = 최근 200건
//   jamsa_attendance_alert_cooldown = { [ruleKey]: lastFiredAt }
// ─────────────────────────────────────────────────────────────────

import React, { useEffect, useMemo, useState } from "react";

const CONFIG_KEY    = "jamsa_attendance_alert_config";
const LOG_KEY       = "jamsa_attendance_alert_log";
const COOLDOWN_KEY  = "jamsa_attendance_alert_cooldown";
const LAST_EVAL_KEY = "jamsa_attendance_alert_last_eval"; // { absentDay: 'YYYY-MM-DD' } 일별 중복 평가 방지

const DEFAULT_CONFIG = {
  enabled: false,
  recipients: [],
  events: { checkIn: true, checkOut: true, late: true, absent: true, longIdle: false },
  standard: { hour: 9, minute: 0, graceMin: 10 },
  longIdleMin: 480,
  cooldownMin: 5,
  deptFilter: "all",
  staffFilter: "all",
  messages: {
    checkIn:  "[잠사] {name}({dept}) 출근 — {time}",
    checkOut: "[잠사] {name}({dept}) 퇴근 — {time} · 근무 {hours}시간",
    late:     "[잠사] ⚠ {name}({dept}) 지각 — {time} (정시 {standardTime} 초과 {lateMin}분)",
    absent:   "[잠사] 🚨 결근 알림 — {date} {names} 미출근 (영업일 기준)",
    longIdle: "[잠사] ⚠ {name}({dept}) 장기 부재 — {idleHours}시간 미감지",
  },
};

// ─── 저장/로드 ─────────────────────────────────────────────────────
export function loadAttendanceAlertConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const v = JSON.parse(raw);
    // 누락 키 보강
    return {
      ...DEFAULT_CONFIG, ...v,
      events:    { ...DEFAULT_CONFIG.events,    ...(v.events    || {}) },
      standard:  { ...DEFAULT_CONFIG.standard,  ...(v.standard  || {}) },
      messages:  { ...DEFAULT_CONFIG.messages,  ...(v.messages  || {}) },
    };
  } catch (e) { return { ...DEFAULT_CONFIG }; }
}
export function saveAttendanceAlertConfig(cfg) {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch (e) {}
}
export function loadAttendanceAlertLog() {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) || "[]"); } catch (e) { return []; }
}
function appendLog(entry) {
  try {
    const arr = loadAttendanceAlertLog();
    arr.unshift({ ...entry, id: Date.now() + Math.random(), at: new Date().toISOString() });
    localStorage.setItem(LOG_KEY, JSON.stringify(arr.slice(0, 200)));
  } catch (e) {}
}
function loadCooldown()      { try { return JSON.parse(localStorage.getItem(COOLDOWN_KEY) || "{}"); } catch (e) { return {}; } }
function saveCooldown(o)     { try { localStorage.setItem(COOLDOWN_KEY, JSON.stringify(o)); } catch (e) {} }
function loadLastEval()      { try { return JSON.parse(localStorage.getItem(LAST_EVAL_KEY) || "{}"); } catch (e) { return {}; } }
function saveLastEval(o)     { try { localStorage.setItem(LAST_EVAL_KEY, JSON.stringify(o)); } catch (e) {} }

function renderTemplate(tmpl, ctx) {
  return (tmpl || "").replace(/\{(\w+)\}/g, (_, k) => (ctx[k] != null ? String(ctx[k]) : `{${k}}`));
}

// ─── 발송기 (서버 호출) ────────────────────────────────────────────
async function fireSms(message, recipients, meta = {}) {
  if (!recipients || recipients.length === 0) {
    appendLog({ ...meta, message, ok: false, reason: "no_recipients" });
    return { ok: false, reason: "no_recipients" };
  }
  try {
    const res = await fetch("/api/auto-alerts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(typeof window !== "undefined" && window.__authToken ? { "Authorization": "Bearer " + window.__authToken } : {}),
      },
      body: JSON.stringify({
        type: "attendance",
        severity: meta.severity || "INFO",
        message,
        recipients,
        autoCall: true,
      }),
    });
    const data = await res.json().catch(() => ({}));
    appendLog({
      ...meta, message,
      recipients: recipients.map(r => r.phone),
      ok: !!data.ok,
      smsResults: data.smsResults || [],
      smsConfigured: data.smsConfigured,
    });
    return { ok: !!data.ok, ...data };
  } catch (e) {
    appendLog({ ...meta, message, ok: false, error: e.message });
    return { ok: false, error: e.message };
  }
}

// ─── 직원이 필터 통과하는지 ───────────────────────────────────────
function passesFilter(cfg, staff) {
  if (!staff) return false;
  if (cfg.deptFilter !== "all" && Array.isArray(cfg.deptFilter)) {
    if (!cfg.deptFilter.includes(staff.dept_id)) return false;
  }
  if (cfg.staffFilter !== "all" && Array.isArray(cfg.staffFilter)) {
    if (!cfg.staffFilter.includes(staff.id)) return false;
  }
  return true;
}

// ─── 트리거: 출근/퇴근 ─────────────────────────────────────────────
export async function triggerCheckInAlert({ staff, dept, attendanceRecord }) {
  const cfg = loadAttendanceAlertConfig();
  if (!cfg.enabled || !cfg.events.checkIn) return;
  if (!passesFilter(cfg, staff)) return;

  const inT = new Date(attendanceRecord?.checked_in_at || Date.now());
  const time = `${String(inT.getHours()).padStart(2, "0")}:${String(inT.getMinutes()).padStart(2, "0")}`;
  const ctx = {
    name: staff.name, dept: dept?.name || "",
    time, date: inT.toISOString().slice(0, 10),
  };
  const msg = renderTemplate(cfg.messages.checkIn, ctx);
  await fireSms(msg, cfg.recipients, { kind: "checkIn", staffId: staff.id, severity: "INFO" });

  // 지각 평가
  if (cfg.events.late) {
    const std = cfg.standard;
    const stdMin = std.hour * 60 + std.minute + (std.graceMin || 0);
    const inMin = inT.getHours() * 60 + inT.getMinutes();
    if (inMin > stdMin) {
      // 같은 직원/날짜 중복 방지
      const cooldown = loadCooldown();
      const key = `late:${staff.id}:${ctx.date}`;
      if (!cooldown[key]) {
        cooldown[key] = Date.now();
        saveCooldown(cooldown);
        const lateMin = inMin - (std.hour * 60 + std.minute);
        const lateMsg = renderTemplate(cfg.messages.late, {
          ...ctx,
          standardTime: `${String(std.hour).padStart(2, "0")}:${String(std.minute).padStart(2, "0")}`,
          lateMin,
        });
        await fireSms(lateMsg, cfg.recipients, { kind: "late", staffId: staff.id, severity: "WARNING" });
      }
    }
  }
}

export async function triggerCheckOutAlert({ staff, dept, attendanceRecord }) {
  const cfg = loadAttendanceAlertConfig();
  if (!cfg.enabled || !cfg.events.checkOut) return;
  if (!passesFilter(cfg, staff)) return;

  const outT = new Date(attendanceRecord?.checked_out_at || Date.now());
  const inT  = attendanceRecord?.checked_in_at ? new Date(attendanceRecord.checked_in_at) : outT;
  const time = `${String(outT.getHours()).padStart(2, "0")}:${String(outT.getMinutes()).padStart(2, "0")}`;
  const hoursVal = Math.max(0, (outT - inT) / 3600000);
  const ctx = {
    name: staff.name, dept: dept?.name || "",
    time, date: outT.toISOString().slice(0, 10),
    hours: hoursVal.toFixed(1),
  };
  const msg = renderTemplate(cfg.messages.checkOut, ctx);
  await fireSms(msg, cfg.recipients, { kind: "checkOut", staffId: staff.id, severity: "INFO" });
}

// ─── 결근 평가 (매일 한 번 실행 권장) ──────────────────────────────
export async function evaluateAbsent({ staffList, todayAttendance, depts }) {
  const cfg = loadAttendanceAlertConfig();
  if (!cfg.enabled || !cfg.events.absent) return;

  const today = new Date().toISOString().slice(0, 10);
  const lastEval = loadLastEval();
  if (lastEval.absentDay === today) return; // 오늘 이미 평가

  // 평일 09시 이후만
  const now = new Date();
  if (now.getDay() === 0 || now.getDay() === 6) return; // 주말 제외
  const earliestHour = (cfg.standard.hour || 9) + 1;
  if (now.getHours() < earliestHour) return;

  const checkedInIds = new Set(todayAttendance.map(a => a.staff_id));
  const absentees = staffList.filter(s => passesFilter(cfg, s) && !checkedInIds.has(s.id));
  if (absentees.length === 0) {
    lastEval.absentDay = today;
    saveLastEval(lastEval);
    return;
  }
  const names = absentees.map(s => {
    const dept = depts.find(d => d.id === s.dept_id)?.name || "";
    return dept ? `${s.name}(${dept})` : s.name;
  }).join(", ");
  const msg = renderTemplate(cfg.messages.absent, { date: today, names, count: absentees.length });
  await fireSms(msg, cfg.recipients, { kind: "absent", date: today, severity: "DANGER", count: absentees.length });
  lastEval.absentDay = today;
  saveLastEval(lastEval);
}

// ─── 장기 부재 평가 ───────────────────────────────────────────────
export async function evaluateLongIdle({ staffList, todayAttendance, depts }) {
  const cfg = loadAttendanceAlertConfig();
  if (!cfg.enabled || !cfg.events.longIdle) return;

  const now = Date.now();
  const thresholdMs = (cfg.longIdleMin || 480) * 60 * 1000;
  const cooldown = loadCooldown();
  const today = new Date().toISOString().slice(0, 10);

  for (const s of staffList) {
    if (!passesFilter(cfg, s)) continue;
    const recs = todayAttendance.filter(a => a.staff_id === s.id && !a.checked_out_at);
    if (recs.length === 0) continue;
    const lastIn = recs[0]?.checked_in_at;
    if (!lastIn) continue;
    const idleMs = now - new Date(lastIn).getTime();
    if (idleMs < thresholdMs) continue;
    const key = `longIdle:${s.id}:${today}`;
    if (cooldown[key]) continue;
    cooldown[key] = now;
    const dept = depts.find(d => d.id === s.dept_id)?.name || "";
    const idleHours = (idleMs / 3600000).toFixed(1);
    const msg = renderTemplate(cfg.messages.longIdle, { name: s.name, dept, idleHours });
    await fireSms(msg, cfg.recipients, { kind: "longIdle", staffId: s.id, severity: "WARNING" });
  }
  saveCooldown(cooldown);
}

// ─── 누적 중복 정리 도구 (1분 이내 같은 직원 중복 attendance 삭제) ─
// supabase client + today attendance array를 받아 중복 행 삭제, 삭제 결과 반환
export async function dedupeTodayAttendance(sb, today) {
  if (!sb || !Array.isArray(today)) return { ok: false, error: "no_data" };
  const byStaff = new Map();
  today.forEach(a => {
    const arr = byStaff.get(a.staff_id) || [];
    arr.push(a);
    byStaff.set(a.staff_id, arr);
  });
  const toDelete = [];
  for (const [, arr] of byStaff.entries()) {
    arr.sort((x, y) => new Date(x.checked_in_at) - new Date(y.checked_in_at));
    let lastKept = null;
    for (const rec of arr) {
      const t = new Date(rec.checked_in_at).getTime();
      if (lastKept && (t - lastKept) < 60_000) {
        // 60초 이내 중복 → 삭제 대상 (퇴근시각도 없는 거 우선)
        if (!rec.checked_out_at) toDelete.push(rec.id);
      } else {
        lastKept = t;
      }
    }
  }
  if (toDelete.length === 0) return { ok: true, deleted: 0 };
  const { error } = await sb.from("attendance").delete().in("id", toDelete);
  if (error) return { ok: false, error: error.message };
  return { ok: true, deleted: toDelete.length };
}

// ─────────────────────────────────────────────────────────────────
//  설정 UI 모달
// ─────────────────────────────────────────────────────────────────
export function AttendanceAlertConfigModal({ depts = [], staffList = [], onClose }) {
  const [cfg, setCfg] = useState(loadAttendanceAlertConfig);
  const [log, setLog] = useState(loadAttendanceAlertLog);
  const [view, setView] = useState("setup"); // setup | log

  useEffect(() => { saveAttendanceAlertConfig(cfg); }, [cfg]);

  const recipients = cfg.recipients || [];
  const addRecipient    = () => setCfg(c => ({ ...c, recipients: [...(c.recipients||[]), { name: "", phone: "" }] }));
  const removeRecipient = (i) => setCfg(c => ({ ...c, recipients: c.recipients.filter((_, j) => j !== i) }));
  const setRecipient    = (i, patch) => setCfg(c => ({ ...c, recipients: c.recipients.map((r, j) => j === i ? { ...r, ...patch } : r) }));

  const toggleEvent = (k) => setCfg(c => ({ ...c, events: { ...c.events, [k]: !c.events[k] } }));
  const setStd      = (patch) => setCfg(c => ({ ...c, standard: { ...c.standard, ...patch } }));

  const testFire = async (kind) => {
    if (recipients.length === 0) { alert("수신자 phone을 1명 이상 추가하세요."); return; }
    const sample = staffList[0] || { id: "TEST", name: "테스트", dept_id: null };
    const dept = depts.find(d => d.id === sample.dept_id) || null;
    const now = new Date();
    const tpls = {
      checkIn:  { msg: cfg.messages.checkIn,  ctx: { name: sample.name, dept: dept?.name||"", time: now.toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit"}), date: now.toISOString().slice(0,10) }, sev: "INFO" },
      checkOut: { msg: cfg.messages.checkOut, ctx: { name: sample.name, dept: dept?.name||"", time: now.toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit"}), date: now.toISOString().slice(0,10), hours: "8.0" }, sev: "INFO" },
      late:     { msg: cfg.messages.late,     ctx: { name: sample.name, dept: dept?.name||"", time: "09:25", standardTime: `${String(cfg.standard.hour).padStart(2,"0")}:${String(cfg.standard.minute).padStart(2,"0")}`, lateMin: 15, date: now.toISOString().slice(0,10) }, sev: "WARNING" },
      absent:   { msg: cfg.messages.absent,   ctx: { date: now.toISOString().slice(0,10), names: `${sample.name}(${dept?.name||""})`, count: 1 }, sev: "DANGER" },
      longIdle: { msg: cfg.messages.longIdle, ctx: { name: sample.name, dept: dept?.name||"", idleHours: "8.5" }, sev: "WARNING" },
    };
    const t = tpls[kind];
    if (!t) return;
    const res = await fireSms(renderTemplate(t.msg, t.ctx), recipients, { kind: `test_${kind}`, severity: t.sev });
    alert(res.ok ? `테스트(${kind}) 발송 성공 ✓` : `발송 실패: ${res.error || res.reason || "unknown"}`);
    setLog(loadAttendanceAlertLog());
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 10400, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: "100%", maxWidth: 640, maxHeight: "92vh", overflowY: "auto", background: "#0f172a", color: "#f1f5f9", borderRadius: 12, border: "1px solid rgba(255,255,255,0.12)" }}>
        <div style={{ padding: "14px 18px", background: "linear-gradient(135deg,#10b981,#0891b2)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 11, opacity: 0.9 }}>출퇴근 알림 규칙</div>
            <div style={{ fontSize: 16, fontWeight: 900 }}>🔔 출퇴근 자동 SMS 설정</div>
          </div>
          <button onClick={onClose} style={{ background: "rgba(255,255,255,0.2)", border: "none", color: "#fff", fontSize: 22, cursor: "pointer", width: 30, height: 30, borderRadius: "50%" }}>×</button>
        </div>

        <div style={{ padding: "8px 14px", borderBottom: "1px solid rgba(255,255,255,0.08)", display: "flex", gap: 6 }}>
          <button onClick={() => setView("setup")} style={tabBtn(view === "setup")}>⚙ 설정</button>
          <button onClick={() => { setView("log"); setLog(loadAttendanceAlertLog()); }} style={tabBtn(view === "log")}>📜 이력 ({log.length})</button>
        </div>

        {view === "setup" && (
          <div style={{ padding: 16 }}>
            {/* 활성화 토글 */}
            <label style={{ display: "flex", alignItems: "center", gap: 8, padding: 10, background: cfg.enabled ? "rgba(52,211,153,0.15)" : "rgba(255,255,255,0.04)", border: `1px solid ${cfg.enabled ? "rgba(52,211,153,0.35)" : "rgba(255,255,255,0.1)"}`, borderRadius: 6, cursor: "pointer", marginBottom: 12 }}>
              <input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg(c => ({ ...c, enabled: e.target.checked }))} style={{ accentColor: "#10b981", width: 18, height: 18 }} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 800, color: cfg.enabled ? "#6ee7b7" : "#94a3b8" }}>
                  {cfg.enabled ? "● 자동 알림 활성화" : "○ 자동 알림 비활성화"}
                </div>
                <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 2 }}>
                  활성화 시 출근/퇴근 버튼 클릭과 동시에 등록된 수신자 phone으로 SMS 발송 (Ppurio)
                </div>
              </div>
            </label>

            {/* 이벤트 토글 */}
            <Section title="📡 알림 이벤트">
              <Toggle label="출근 알림"    on={cfg.events.checkIn}  onClick={() => toggleEvent("checkIn")}  />
              <Toggle label="퇴근 알림"    on={cfg.events.checkOut} onClick={() => toggleEvent("checkOut")} />
              <Toggle label="지각 알림"    on={cfg.events.late}     onClick={() => toggleEvent("late")}     />
              <Toggle label="결근 알림"    on={cfg.events.absent}   onClick={() => toggleEvent("absent")}   />
              <Toggle label="장기 부재"    on={cfg.events.longIdle} onClick={() => toggleEvent("longIdle")} />
            </Section>

            {/* 정시 기준 */}
            <Section title="⏰ 정시 기준">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
                <Field label="시"><input type="number" min="0" max="23" value={cfg.standard.hour} onChange={e => setStd({ hour: parseInt(e.target.value)||9 })} style={input} /></Field>
                <Field label="분"><input type="number" min="0" max="59" value={cfg.standard.minute} onChange={e => setStd({ minute: parseInt(e.target.value)||0 })} style={input} /></Field>
                <Field label="허용(분)"><input type="number" min="0" max="60" value={cfg.standard.graceMin} onChange={e => setStd({ graceMin: parseInt(e.target.value)||0 })} style={input} /></Field>
              </div>
              <div style={{ fontSize: 10, color: "#64748b", marginTop: 4 }}>
                정시 {String(cfg.standard.hour).padStart(2,"0")}:{String(cfg.standard.minute).padStart(2,"0")} + 허용 {cfg.standard.graceMin}분 이후 출근 = 지각
              </div>
            </Section>

            {/* 수신자 */}
            <Section title={`📞 수신자 (${recipients.length}명)`}>
              {recipients.map((r, i) => (
                <div key={i} style={{ display: "flex", gap: 6, marginBottom: 4 }}>
                  <input value={r.name||""}  onChange={e => setRecipient(i, { name:  e.target.value })} placeholder="이름"   style={{ ...input, flex: "0 0 110px" }} />
                  <input value={r.phone||""} onChange={e => setRecipient(i, { phone: e.target.value })} placeholder="010-1234-5678" style={{ ...input, flex: 1, fontFamily: "ui-monospace,monospace" }} />
                  <button onClick={() => removeRecipient(i)} style={btnDanger}>×</button>
                </div>
              ))}
              <button onClick={addRecipient} style={btnDashed}>＋ 수신자 추가</button>
            </Section>

            {/* 메시지 템플릿 */}
            <Section title="✉ SMS 메시지 템플릿">
              <div style={{ fontSize: 9, color: "#94a3b8", marginBottom: 4 }}>변수: {"{name} {dept} {time} {date} {hours} {lateMin} {standardTime} {idleHours} {names} {count}"}</div>
              {Object.entries(cfg.messages).map(([k, v]) => (
                <div key={k} style={{ marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 2 }}>
                    <span style={{ fontSize: 10, color: "#94a3b8" }}>{k}</span>
                    <button onClick={() => testFire(k)} style={{ padding: "2px 8px", borderRadius: 3, background: "rgba(245,158,11,0.18)", color: "#fcd34d", border: "1px solid rgba(245,158,11,0.35)", fontSize: 9, fontWeight: 700, cursor: "pointer" }}>📨 테스트</button>
                  </div>
                  <input value={v} onChange={e => setCfg(c => ({ ...c, messages: { ...c.messages, [k]: e.target.value } }))} style={{ ...input, fontFamily: "ui-monospace,monospace", fontSize: 10 }} />
                </div>
              ))}
            </Section>

            <div style={{ marginTop: 12, padding: 10, background: "rgba(99,102,241,0.1)", border: "1px solid rgba(99,102,241,0.25)", borderRadius: 6, fontSize: 10, color: "#cbd5e1", lineHeight: 1.5 }}>
              💡 Vercel 환경변수 <code style={{ background: "rgba(0,0,0,0.3)", padding: "1px 5px", borderRadius: 3 }}>PPURIO_USERNAME / PPURIO_API_KEY / PPURIO_SENDER</code> 설정이 필요합니다. 미설정 시 이력에 "SMS 미설정" 표시.
            </div>
          </div>
        )}

        {view === "log" && (
          <div style={{ padding: 16 }}>
            {log.length === 0 ? (
              <div style={{ padding: 30, textAlign: "center", color: "#94a3b8", fontSize: 12 }}>아직 알림 이력 없음</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {log.map(e => (
                  <div key={e.id} style={{ padding: "7px 10px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 6, height: 6, borderRadius: 3, background: e.ok ? "#34d399" : "#f87171", flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, color: "#cbd5e1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.message}</div>
                      <div style={{ fontSize: 9, color: "#64748b", fontFamily: "ui-monospace,monospace", marginTop: 1 }}>
                        {new Date(e.at).toLocaleString("ko-KR")} · {e.kind} · {(e.recipients||[]).join(",")}
                        {e.smsConfigured === false && <span style={{ color: "#fbbf24" }}> · SMS env 미설정</span>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const input    = { width: "100%", padding: "6px 9px", borderRadius: 4, background: "#0b1220", border: "1px solid rgba(255,255,255,0.12)", color: "#f1f5f9", fontSize: 11 };
const btnDanger= { padding: "5px 10px", borderRadius: 4, background: "rgba(220,38,38,0.18)", border: "1px solid rgba(220,38,38,0.35)", color: "#fca5a5", fontSize: 11, fontWeight: 700, cursor: "pointer" };
const btnDashed= { padding: "6px 10px", borderRadius: 4, background: "rgba(255,255,255,0.04)", border: "1px dashed rgba(255,255,255,0.2)", color: "#cbd5e1", fontSize: 10, cursor: "pointer" };
const tabBtn   = (active) => ({ padding: "5px 10px", borderRadius: 4, background: active ? "rgba(16,185,129,0.2)" : "transparent", border: active ? "1px solid rgba(16,185,129,0.4)" : "1px solid rgba(255,255,255,0.08)", color: active ? "#6ee7b7" : "#94a3b8", fontSize: 10, fontWeight: 700, cursor: "pointer" });

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 12, padding: 10, background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 6 }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: "#94a3b8", letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}
function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: "#94a3b8", marginBottom: 2 }}>{label}</div>
      {children}
    </div>
  );
}
function Toggle({ label, on, onClick }) {
  return (
    <button onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 4, marginBottom: 4, marginRight: 4,
      background: on ? "rgba(52,211,153,0.15)" : "rgba(255,255,255,0.03)",
      border: on ? "1px solid rgba(52,211,153,0.35)" : "1px solid rgba(255,255,255,0.08)",
      color: on ? "#6ee7b7" : "#94a3b8", fontSize: 10, fontWeight: 700, cursor: "pointer",
    }}>
      <span>{on ? "✓" : "○"}</span><span>{label}</span>
    </button>
  );
}
