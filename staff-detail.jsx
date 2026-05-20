// ════════════════════════════════════════════════════════════
//  직원 세부 미리보기 모달
//  - 식별자 (GPS / WiFi / 비콘 / 카드 / Unique UID) 인라인 편집
//  - 오늘 타임라인 (출근 → 구역 이동 → 퇴근)
//  - 스케줄 vs 실제 비교
//  - 행동 요약 + AI 평가 (점수 + 라벨)
//  - CCTV 채널별 미리보기 링크
//  - 주간 근무시간 그래프
// ════════════════════════════════════════════════════════════
import React, { useState, useEffect, useRef, useMemo } from "react";

const pad = (n) => String(n).padStart(2, "0");
const fmtTimeFull = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const fmtTimeHM = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.getFullYear()}.${pad(d.getMonth()+1)}.${pad(d.getDate())}`;
};
const fmtHours = (sec) => {
  if (sec == null) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
};
const DEFAULT_CCTV_BASE = (() => {
  try {
    if (typeof window !== "undefined" && window.location) {
      const h = window.location.hostname;
      if (h === "localhost" || h === "127.0.0.1" ||
          h.startsWith("192.168.") || h.startsWith("10.") ||
          /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) {
        return "http://localhost:5556";
      }
    }
  } catch (e) {}
  return "https://cctv.thejamsa.com";
})();
const _isValidCctvBase = (s) => {
  if (!s) return false;
  if (/jamsa-panel\.vercel\.app/i.test(s)) return false;
  if (/\/(404|not[-_]?found)/i.test(s)) return false;
  return /^https?:\/\//i.test(s) || s.startsWith("/");
};
const getCctvUrl = (channel) => {
  try {
    let base = (localStorage.getItem("jamsa_cctv_guard_url") || "").replace(/\/+$/, "");
    if (!_isValidCctvBase(base)) {
      if (base) { try { localStorage.removeItem("jamsa_cctv_guard_url"); } catch (e) {} }
      base = DEFAULT_CCTV_BASE;
    }
    if (channel == null) return base;
    return `${base}/?channel=${channel}`;
  } catch (e) { return DEFAULT_CCTV_BASE; }
};

const EVENT_META = {
  CHECK_IN:   { icon: "🚪", color: "#34d399", bg: "rgba(52,211,153,0.15)" },
  CHECK_OUT:  { icon: "🏁", color: "#94a3b8", bg: "rgba(148,163,184,0.15)" },
  ZONE_ENTER: { icon: "📍", color: "#60a5fa", bg: "rgba(96,165,250,0.15)" },
  ZONE_EXIT:  { icon: "↗",  color: "#fbbf24", bg: "rgba(251,191,36,0.15)" },
  ZONE_DWELL: { icon: "⏱",  color: "#a78bfa", bg: "rgba(167,139,250,0.15)" },
  IDLE_ALERT: { icon: "⚠",  color: "#f87171", bg: "rgba(248,113,113,0.15)" },
};

export function StaffDetailModal({ staff, dept, sb, onClose, onAddFacAction }) {
  const [tab, setTab] = useState("overview");
  const [summary, setSummary] = useState(null);   // v_staff_today_summary 1행
  const [timeline, setTimeline] = useState([]);   // v_staff_today_timeline
  const [weekly, setWeekly] = useState([]);       // v_work_hours 7일
  const [schedule, setSchedule] = useState([]);   // work_schedule (7요일)
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(false);  // 식별자 편집 모드
  const [editIds, setEditIds] = useState({
    unique_uid: staff.unique_uid || "",
    beacon_id:  staff.beacon_id  || "",
    gps_device_id: staff.gps_device_id || "",
    wifi_mac:   staff.wifi_mac   || "",
    card_uid:   staff.card_uid   || "",
    position:   staff.position   || "",
    phone:      staff.phone      || "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => { loadAll(); }, [staff.id]);

  async function loadAll() {
    if (!sb) return;
    setLoading(true); setErr(null);
    try {
      const today = new Date(); today.setHours(0,0,0,0);
      const tISO = today.toISOString();

      const [sumRes, tlRes, wkRes, schRes] = await Promise.all([
        sb.from("v_staff_today_summary").select("*").eq("staff_id", staff.id).maybeSingle(),
        sb.from("v_staff_today_timeline").select("*").eq("staff_id", staff.id),
        sb.from("attendance").select("*")
          .eq("staff_id", staff.id)
          .gte("checked_in_at", new Date(Date.now() - 7*24*3600*1000).toISOString())
          .order("checked_in_at", { ascending: false }),
        sb.from("work_schedule").select("*").eq("staff_id", staff.id).order("day_of_week"),
      ]);
      if (sumRes.error) console.warn("[summary]", sumRes.error.message);
      if (tlRes.error)  console.warn("[timeline]", tlRes.error.message);
      setSummary(sumRes.data || null);
      const sortedTl = (tlRes.data || []).sort((a,b) =>
        new Date(a.event_time).getTime() - new Date(b.event_time).getTime()
      );
      setTimeline(sortedTl);
      setWeekly(wkRes.data || []);
      setSchedule(schRes.data || []);
    } catch (e) {
      setErr(e?.message || String(e));
    } finally { setLoading(false); }
  }

  async function saveIdentity() {
    if (!sb) return;
    setSaving(true);
    try {
      const patch = {
        unique_uid:    editIds.unique_uid.trim() || null,
        beacon_id:     editIds.beacon_id.trim()  || null,
        gps_device_id: editIds.gps_device_id.trim() || null,
        wifi_mac:      editIds.wifi_mac.trim()   || null,
        card_uid:      editIds.card_uid.trim()   || null,
        position:      editIds.position.trim()   || null,
        phone:         editIds.phone.trim()      || null,
      };
      const { error } = await sb.from("staff").update(patch).eq("id", staff.id);
      if (error) throw error;
      // 로컬 staff 객체에도 반영
      Object.assign(staff, patch);
      setEditing(false);
      loadAll();
    } catch (e) {
      alert("저장 실패: " + (e.message || e));
    } finally { setSaving(false); }
  }

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 9999,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 16, backdropFilter: "blur(4px)" }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 880, maxHeight: "92vh", background: "#0f172a",
          color: "#f1f5f9", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12,
          overflow: "hidden", display: "flex", flexDirection: "column" }}>

        {/* ─── 헤더 ─── */}
        <div style={{ padding: "14px 20px", borderBottom: "1px solid rgba(255,255,255,0.08)",
          display: "flex", justifyContent: "space-between", alignItems: "flex-start",
          background: "linear-gradient(90deg, #0b3a2a 0%, #0f172a 100%)" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 40, height: 40, borderRadius: 20, background: "linear-gradient(135deg,#10b981,#0891b2)",
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 800 }}>
                {(staff.name || "?").charAt(0)}
              </div>
              <div>
                <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: "-0.015em" }}>{staff.name}</div>
                <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
                  {dept?.name || "부서 미지정"}
                  {staff.position && <> · {staff.position}</>}
                  {staff.phone && <> · {staff.phone}</>}
                </div>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {summary && (
              <EvalBadge score={summary.eval_score} label={summary.eval_label} />
            )}
            <button onClick={onClose}
              style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)",
                color: "#cbd5e1", borderRadius: 6, padding: "5px 12px", cursor: "pointer", fontSize: 13 }}>✕</button>
          </div>
        </div>

        {/* ─── 탭 ─── */}
        <div style={{ display: "flex", borderBottom: "1px solid rgba(255,255,255,0.08)", padding: "0 8px", background: "#0b1220" }}>
          {[
            ["overview", "📊 개요·평가"],
            ["timeline", "📋 오늘 타임라인"],
            ["identity", "🆔 식별자 등록"],
            ["schedule", "📅 근무 스케줄"],
            ["weekly",   "📈 주간 통계"],
          ].map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              style={{ padding: "10px 14px", background: "transparent", border: "none", cursor: "pointer",
                fontSize: 12, fontWeight: 700, color: tab === k ? "#34d399" : "#94a3b8",
                borderBottom: tab === k ? "2px solid #34d399" : "2px solid transparent" }}>
              {label}
            </button>
          ))}
        </div>

        {/* ─── 본문 ─── */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: "center", color: "#64748b", fontSize: 13 }}>⏳ 데이터 로드 중...</div>
          ) : err ? (
            <div style={{ padding: 20, color: "#fca5a5", fontSize: 12 }}>
              ⚠ {err}
              <div style={{ marginTop: 6, color: "#94a3b8", fontSize: 11 }}>
                staff_identity_schedule.sql 이 실행되지 않았을 수 있습니다.
              </div>
            </div>
          ) : (
            <>
              {tab === "overview" && <OverviewTab summary={summary} timeline={timeline} staff={staff} />}
              {tab === "timeline" && <TimelineTab timeline={timeline} />}
              {tab === "identity" && (
                <IdentityTab
                  staff={staff}
                  values={editIds}
                  setValues={setEditIds}
                  editing={editing}
                  setEditing={setEditing}
                  saving={saving}
                  onSave={saveIdentity}
                />
              )}
              {tab === "schedule" && <ScheduleTab staff={staff} schedule={schedule} sb={sb} onUpdated={loadAll} />}
              {tab === "weekly"   && <WeeklyTab weekly={weekly} />}
            </>
          )}
        </div>

        {/* ─── 푸터 ─── */}
        <div style={{ padding: "10px 18px", borderTop: "1px solid rgba(255,255,255,0.08)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 10, color: "#64748b" }}>
            데이터: Supabase · 실시간 업데이트 됨
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {onAddFacAction && (
              <button onClick={() => {
                onAddFacAction({
                  title: `${staff.name} 행동 점검 요청`,
                  category: "HR", priority: "MEDIUM",
                  memo: `평가 ${summary?.eval_label || ""}(${summary?.eval_score ?? "-"}점) · ${summary?.idle_alert_count ?? 0}건 미감지`,
                });
                alert("✓ 시설점검 모듈 보완과제로 등록됨");
              }}
                style={{ padding: "6px 12px", borderRadius: 4, background: "rgba(251,191,36,0.15)",
                  border: "1px solid rgba(251,191,36,0.3)", color: "#fde68a", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                + 보완과제 등록
              </button>
            )}
            <button onClick={onClose}
              style={{ padding: "6px 14px", borderRadius: 4, background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)", color: "#cbd5e1", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
              닫기
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  탭 1: 개요 + 평가
// ────────────────────────────────────────────────────────────
function OverviewTab({ summary, timeline, staff }) {
  const aiSummary = useMemo(() => buildAiSummary(summary, timeline), [summary, timeline]);

  if (!summary) return (
    <div style={{ padding: 20, color: "#94a3b8", fontSize: 12 }}>
      오늘 활동 데이터가 아직 없습니다.
    </div>
  );

  return (
    <div style={{ padding: "16px 20px" }}>
      {/* 핵심 지표 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 18 }}>
        <KpiCard label="출근"        value={fmtTimeHM(summary.first_in)}  color="#34d399" />
        <KpiCard label="총 근무"     value={`${summary.work_hours || 0}h`} color="#60a5fa" />
        <KpiCard label="구역 이동"   value={`${summary.zone_change_count}회`} color="#a78bfa" />
        <KpiCard label="미감지"      value={`${summary.idle_alert_count}건`}  color={summary.idle_alert_count > 0 ? "#f87171" : "#64748b"} />
      </div>

      {/* 스케줄 vs 실제 */}
      <SectionTitle>📅 스케줄 대비 실제</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 18 }}>
        <KpiCard label="예정 출근"  value={summary.scheduled_start ? String(summary.scheduled_start).slice(0,5) : "—"} color="#94a3b8" />
        <KpiCard label="실제 출근"  value={fmtTimeHM(summary.first_in)} color="#34d399" />
        <KpiCard label="지각"
          value={summary.late_minutes == null ? "—" : (summary.late_minutes === 0 ? "정시" : `+${summary.late_minutes}분`)}
          color={summary.late_minutes > 15 ? "#f87171" : summary.late_minutes > 0 ? "#fbbf24" : "#34d399"} />
      </div>

      {/* AI 요약 */}
      <SectionTitle>🤖 활동 요약 · 평가</SectionTitle>
      <div style={{ padding: 12, background: "rgba(124,58,237,0.08)", border: "1px solid rgba(167,139,250,0.25)",
        borderRadius: 6, fontSize: 12, lineHeight: 1.7, color: "#e2e8f0", marginBottom: 16 }}>
        {aiSummary.bullets.map((b, i) => <div key={i}>· {b}</div>)}
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px dashed rgba(255,255,255,0.1)", color: "#a78bfa", fontWeight: 700 }}>
          → 결론: {aiSummary.conclusion}
        </div>
      </div>

      {/* 식별자 상태 */}
      <SectionTitle>🆔 식별자 연결 상태</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6 }}>
        <IdentityChip label="UID"    ok={!!staff.unique_uid}    value={staff.unique_uid} />
        <IdentityChip label="비콘"   ok={!!staff.beacon_id}     value={staff.beacon_id} />
        <IdentityChip label="GPS"    ok={!!staff.gps_device_id} value={staff.gps_device_id} />
        <IdentityChip label="WiFi"   ok={!!staff.wifi_mac}      value={staff.wifi_mac} />
        <IdentityChip label="카드"   ok={!!staff.card_uid}      value={staff.card_uid} />
      </div>

      {/* 방문한 구역 */}
      {summary.zones_list && summary.zones_list.length > 0 && (
        <>
          <div style={{ height: 14 }} />
          <SectionTitle>📍 오늘 방문한 구역</SectionTitle>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {summary.zones_list.map((z, i) => (
              <span key={i} style={{ padding: "4px 10px", background: "rgba(96,165,250,0.12)",
                border: "1px solid rgba(96,165,250,0.3)", borderRadius: 14, fontSize: 11, fontWeight: 600, color: "#93c5fd" }}>
                📍 {z}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// AI 휴리스틱 요약
function buildAiSummary(s, timeline) {
  const bullets = [];
  let conclusion = "데이터 부족";

  if (!s) {
    return { bullets: ["오늘 활동 기록이 없습니다."], conclusion };
  }

  if (s.first_in) {
    if (s.late_minutes == null) {
      bullets.push(`출근 ${fmtTimeHM(s.first_in)} (예정 스케줄 미등록)`);
    } else if (s.late_minutes === 0) {
      bullets.push(`✓ 정시 출근 ${fmtTimeHM(s.first_in)}`);
    } else if (s.late_minutes <= 15) {
      bullets.push(`⚠ ${s.late_minutes}분 지각 (실제 ${fmtTimeHM(s.first_in)} / 예정 ${String(s.scheduled_start||"-").slice(0,5)})`);
    } else {
      bullets.push(`❌ ${s.late_minutes}분 지각 — 사유 확인 필요`);
    }
  } else {
    bullets.push("❌ 미출근");
  }

  if (s.work_hours) {
    bullets.push(`총 ${s.work_hours}시간 근무 (${s.session_count}회 세션)`);
  }

  if (s.zone_change_count > 0) {
    bullets.push(`${s.zones_visited}개 구역 ${s.zone_change_count}회 이동` +
      (s.last_zone ? ` · 마지막 위치 ${s.last_zone}` : ""));
  } else {
    bullets.push("구역 이동 기록 없음 (게이트웨이 비콘 매핑 확인 필요)");
  }

  if (s.idle_alert_count > 0) {
    bullets.push(`⚠ ${s.idle_alert_count}회 장기 미감지 발생`);
  }

  if (s.best_rssi != null) {
    const sig = s.best_rssi > -65 ? "양호" : s.best_rssi > -80 ? "보통" : "약함";
    bullets.push(`비콘 신호 ${sig} (최강 ${s.best_rssi} / 최약 ${s.worst_rssi})`);
  }

  // 결론
  if (!s.first_in) conclusion = "미출근";
  else if (s.idle_alert_count >= 3) conclusion = "주의 — 비콘 신호 단절 다발";
  else if (s.late_minutes > 30) conclusion = "주의 — 지각 사유 확인 필요";
  else if ((s.work_hours || 0) >= 7.5 && s.idle_alert_count === 0) conclusion = "정상 근무 (양호)";
  else if (s.work_hours) conclusion = "근무 중";
  else conclusion = "출근 직후";

  return { bullets, conclusion };
}

function EvalBadge({ score, label }) {
  if (!label) return null;
  const color =
    label.includes("이상") || label.includes("주의") ? "#f87171"
    : label.includes("지각") ? "#fbbf24"
    : label.includes("정상") || label.includes("양호") ? "#34d399"
    : "#94a3b8";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", marginRight: 6 }}>
      <div style={{ fontSize: 11, fontWeight: 800, color, padding: "3px 10px", borderRadius: 4,
        background: `${color}1f`, border: `1px solid ${color}55` }}>
        {label}
      </div>
      <div style={{ fontSize: 10, color: "#64748b", marginTop: 2, fontFamily: "ui-monospace,monospace" }}>
        평가 {score}/100
      </div>
    </div>
  );
}

function KpiCard({ label, value, color }) {
  return (
    <div style={{ padding: 10, background: "rgba(255,255,255,0.04)", borderRadius: 6, border: "1px solid rgba(255,255,255,0.06)" }}>
      <div style={{ fontSize: 10, color: "#94a3b8", letterSpacing: ".05em", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color, fontFamily: "ui-monospace,monospace" }}>{value}</div>
    </div>
  );
}

function IdentityChip({ label, ok, value }) {
  return (
    <div style={{ padding: 8, background: ok ? "rgba(52,211,153,0.1)" : "rgba(255,255,255,0.03)",
      border: ok ? "1px solid rgba(52,211,153,0.3)" : "1px solid rgba(255,255,255,0.06)",
      borderRadius: 4, textAlign: "center" }}>
      <div style={{ fontSize: 9, color: ok ? "#34d399" : "#64748b", fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", marginBottom: 2 }}>
        {ok ? "✓" : "○"} {label}
      </div>
      <div style={{ fontSize: 9, color: "#cbd5e1", fontFamily: "ui-monospace,monospace",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {value || "미등록"}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  탭 2: 타임라인
// ────────────────────────────────────────────────────────────
function TimelineTab({ timeline }) {
  if (timeline.length === 0) {
    return <div style={{ padding: 30, textAlign: "center", color: "#64748b", fontSize: 12 }}>오늘 활동 없음</div>;
  }
  return (
    <div style={{ padding: "16px 20px" }}>
      <SectionTitle>오늘 활동 타임라인 ({timeline.length}건)</SectionTitle>
      <div style={{ position: "relative" }}>
        <div style={{ position: "absolute", left: 14, top: 8, bottom: 8, width: 2, background: "rgba(255,255,255,0.08)" }} />
        {timeline.map((e, i) => {
          const meta = EVENT_META[e.event_type] || { icon: "•", color: "#94a3b8", bg: "rgba(148,163,184,0.1)" };
          const cctvUrl = e.cctv_channel != null ? getCctvUrl(e.cctv_channel) : null;
          return (
            <div key={i} style={{ display: "flex", gap: 12, marginBottom: 12, position: "relative" }}>
              <div style={{ width: 30, height: 30, borderRadius: 15, background: meta.bg,
                border: `2px solid ${meta.color}`, color: meta.color,
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700,
                flexShrink: 0, zIndex: 1 }}>
                {meta.icon}
              </div>
              <div style={{ flex: 1, padding: "6px 0" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: meta.color }}>{e.event_label}</span>
                  {e.zone_name && <span style={{ fontSize: 12, color: "#cbd5e1" }}>· {e.zone_name}</span>}
                  <span style={{ marginLeft: "auto", fontSize: 11, color: "#94a3b8", fontFamily: "ui-monospace,monospace" }}>
                    {fmtTimeFull(e.event_time)}
                  </span>
                </div>
                {e.inferred_behavior && (
                  <div style={{ fontSize: 11, color: "#94a3b8", lineHeight: 1.4 }}>
                    {e.inferred_behavior}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, marginTop: 4, fontSize: 10, color: "#64748b", fontFamily: "ui-monospace,monospace", alignItems: "center" }}>
                  {e.rssi != null && <span>RSSI {e.rssi}</span>}
                  {e.duration_sec != null && <span>· {Math.floor(e.duration_sec/60)}분</span>}
                  {cctvUrl && (
                    <button type="button"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        ev.preventDefault();
                        const w = window.open(cctvUrl, "_blank", "noopener");
                        if (!w) { try { location.href = cctvUrl; } catch (err) {} }
                      }}
                      style={{ marginLeft: "auto", padding: "2px 8px", borderRadius: 3,
                        background: "rgba(8,145,178,0.2)", color: "#67e8f9", fontWeight: 700,
                        border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: "inherit" }}>
                      📹 ch{e.cctv_channel} 미리보기 ↗
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  탭 3: 식별자 등록
// ────────────────────────────────────────────────────────────
function IdentityTab({ staff, values, setValues, editing, setEditing, saving, onSave }) {
  const fields = [
    { key: "unique_uid",    label: "🆔 마스터 UID",   placeholder: "내부 통합 ID (예: STF-0001)", help: "모든 식별자를 통합하는 마스터 키" },
    { key: "beacon_id",     label: "📡 BLE 비콘 UID", placeholder: "비콘 MAC 또는 UUID (예: AC:23:3F:AA:BB:CC)", help: "비콘 태그의 MAC 주소 또는 UUID — 게이트웨이가 감지하는 키" },
    { key: "gps_device_id", label: "📱 GPS 디바이스",  placeholder: "휴대폰 FCM 토큰 또는 IMEI", help: "위치 공유 앱의 디바이스 ID" },
    { key: "wifi_mac",      label: "📶 WiFi MAC",     placeholder: "휴대폰 WiFi MAC (예: 11:22:33:44:55:66)", help: "AP 접속 시 식별용" },
    { key: "card_uid",      label: "💳 카드 UID",      placeholder: "RFID/NFC 카드 시리얼", help: "출입 카드의 고유 UID" },
    { key: "position",      label: "🏷 직급/직책",    placeholder: "예: 관리자, 사원, 외국인 노동자" },
    { key: "phone",         label: "📞 연락처",       placeholder: "010-0000-0000" },
  ];

  return (
    <div style={{ padding: "16px 20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <SectionTitle>고유 식별자 등록</SectionTitle>
        {!editing ? (
          <button onClick={() => setEditing(true)}
            style={{ padding: "5px 14px", background: "#10b981", color: "#0f172a", border: "none",
              borderRadius: 4, fontSize: 12, fontWeight: 800, cursor: "pointer" }}>
            ✎ 편집
          </button>
        ) : (
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => setEditing(false)} disabled={saving}
              style={{ padding: "5px 12px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
                color: "#cbd5e1", borderRadius: 4, fontSize: 12, cursor: "pointer" }}>취소</button>
            <button onClick={onSave} disabled={saving}
              style={{ padding: "5px 14px", background: saving ? "#64748b" : "#10b981", color: "#0f172a",
                border: "none", borderRadius: 4, fontSize: 12, fontWeight: 800, cursor: saving ? "wait" : "pointer" }}>
              {saving ? "저장 중..." : "저장"}
            </button>
          </div>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
        {fields.map(f => (
          <div key={f.key}
            style={{ padding: 12, background: "rgba(255,255,255,0.03)", borderRadius: 6,
              border: `1px solid ${values[f.key] ? "rgba(52,211,153,0.25)" : "rgba(255,255,255,0.06)"}` }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: "#cbd5e1" }}>{f.label}</label>
              <span style={{ fontSize: 9, padding: "2px 8px", borderRadius: 3,
                background: values[f.key] ? "rgba(52,211,153,0.15)" : "rgba(148,163,184,0.15)",
                color: values[f.key] ? "#34d399" : "#94a3b8", fontWeight: 700 }}>
                {values[f.key] ? "✓ 등록됨" : "미등록"}
              </span>
            </div>
            {editing ? (
              <input value={values[f.key]}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                placeholder={f.placeholder}
                style={{ width: "100%", padding: "8px 10px", background: "#0b1220",
                  border: "1px solid rgba(255,255,255,0.15)", borderRadius: 4,
                  color: "#f1f5f9", fontSize: 12, fontFamily: f.key.includes("phone") ? "inherit" : "ui-monospace,monospace" }}
              />
            ) : (
              <div style={{ fontSize: 12, color: values[f.key] ? "#f1f5f9" : "#64748b",
                fontFamily: f.key.includes("phone") ? "inherit" : "ui-monospace,monospace", padding: "2px 0" }}>
                {values[f.key] || "—"}
              </div>
            )}
            {f.help && (
              <div style={{ fontSize: 10, color: "#64748b", marginTop: 5, lineHeight: 1.4 }}>{f.help}</div>
            )}
          </div>
        ))}
      </div>

      <div style={{ marginTop: 16, padding: 12, background: "rgba(96,165,250,0.06)", border: "1px solid rgba(96,165,250,0.2)",
        borderRadius: 6, fontSize: 11, color: "#cbd5e1", lineHeight: 1.6 }}>
        <strong style={{ color: "#93c5fd" }}>💡 식별자별 동작</strong>
        <ul style={{ margin: "6px 0 0 16px", padding: 0 }}>
          <li><strong>비콘 UID</strong>: 게이트웨이가 이 비콘 감지 → 자동 위치 추적 / 일과 로그 기록</li>
          <li><strong>GPS</strong>: 휴대폰 앱으로 위치 공유 (외근 시)</li>
          <li><strong>WiFi MAC</strong>: 사무실 AP 접속 시 자동 출근 처리 (옵션)</li>
          <li><strong>카드 UID</strong>: 출입문 RFID 리더 통과 시 출퇴근 기록</li>
        </ul>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  탭 4: 스케줄
// ────────────────────────────────────────────────────────────
function ScheduleTab({ staff, schedule, sb, onUpdated }) {
  const [rows, setRows] = useState(() => {
    // 0~6 요일 모두 채움
    const base = [
      { day_of_week: 0, label: "일" }, { day_of_week: 1, label: "월" },
      { day_of_week: 2, label: "화" }, { day_of_week: 3, label: "수" },
      { day_of_week: 4, label: "목" }, { day_of_week: 5, label: "금" },
      { day_of_week: 6, label: "토" },
    ];
    return base.map(b => {
      const existing = schedule.find(s => s.day_of_week === b.day_of_week);
      return {
        ...b,
        id: existing?.id || null,
        start_time: existing?.start_time || "",
        end_time:   existing?.end_time   || "",
        break_minutes: existing?.break_minutes ?? 60,
        is_active: existing?.is_active ?? true,
        schedule_type: existing?.schedule_type || "regular",
      };
    });
  });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!sb) return;
    setSaving(true);
    try {
      // 기존 스케줄 다 지우고 새로 insert (간단)
      await sb.from("work_schedule").delete().eq("staff_id", staff.id);
      const toInsert = rows
        .filter(r => r.is_active && r.start_time && r.end_time)
        .map(r => ({
          staff_id: staff.id,
          day_of_week: r.day_of_week,
          start_time: r.start_time,
          end_time:   r.end_time,
          break_minutes: r.break_minutes || 60,
          schedule_type: r.schedule_type || "regular",
          is_active: true,
        }));
      if (toInsert.length > 0) {
        const { error } = await sb.from("work_schedule").insert(toInsert);
        if (error) throw error;
      }
      alert("✓ 스케줄 저장됨");
      onUpdated && onUpdated();
    } catch (e) {
      alert("저장 실패: " + (e.message || e));
    } finally { setSaving(false); }
  };

  const applyWeekday = () => {
    setRows(rows.map(r => r.day_of_week >= 1 && r.day_of_week <= 5
      ? { ...r, start_time: "09:00", end_time: "18:00", break_minutes: 60, is_active: true }
      : r));
  };

  return (
    <div style={{ padding: "16px 20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <SectionTitle>주간 근무 스케줄</SectionTitle>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={applyWeekday}
            style={{ padding: "5px 12px", background: "rgba(96,165,250,0.15)", border: "1px solid rgba(96,165,250,0.3)",
              color: "#93c5fd", borderRadius: 4, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
            평일 09-18 일괄적용
          </button>
          <button onClick={save} disabled={saving}
            style={{ padding: "5px 14px", background: saving ? "#64748b" : "#10b981", color: "#0f172a",
              border: "none", borderRadius: 4, fontSize: 11, fontWeight: 800, cursor: saving ? "wait" : "pointer" }}>
            {saving ? "저장 중..." : "저장"}
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "60px 1fr 1fr 80px 60px", gap: 6, fontSize: 11, fontWeight: 700, color: "#94a3b8", padding: "0 8px", marginBottom: 4 }}>
        <div>요일</div><div>출근</div><div>퇴근</div><div>휴게(분)</div><div>활성</div>
      </div>
      {rows.map((r, i) => {
        const isWeekend = r.day_of_week === 0 || r.day_of_week === 6;
        return (
          <div key={r.day_of_week}
            style={{ display: "grid", gridTemplateColumns: "60px 1fr 1fr 80px 60px", gap: 6, marginBottom: 5,
              padding: 8, background: r.is_active ? (isWeekend ? "rgba(251,191,36,0.05)" : "rgba(52,211,153,0.05)") : "rgba(255,255,255,0.02)",
              border: `1px solid ${r.is_active ? (isWeekend ? "rgba(251,191,36,0.15)" : "rgba(52,211,153,0.15)") : "rgba(255,255,255,0.05)"}`,
              borderRadius: 4, alignItems: "center" }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: isWeekend ? "#fbbf24" : "#cbd5e1" }}>{r.label}</div>
            <input type="time" value={r.start_time}
              onChange={(e) => { const n = [...rows]; n[i].start_time = e.target.value; setRows(n); }}
              style={timeInputStyle} />
            <input type="time" value={r.end_time}
              onChange={(e) => { const n = [...rows]; n[i].end_time = e.target.value; setRows(n); }}
              style={timeInputStyle} />
            <input type="number" value={r.break_minutes}
              onChange={(e) => { const n = [...rows]; n[i].break_minutes = Number(e.target.value) || 0; setRows(n); }}
              style={timeInputStyle} />
            <label style={{ display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
              <input type="checkbox" checked={r.is_active}
                onChange={(e) => { const n = [...rows]; n[i].is_active = e.target.checked; setRows(n); }}
              />
            </label>
          </div>
        );
      })}
    </div>
  );
}

const timeInputStyle = {
  width: "100%", padding: "5px 8px", background: "#0b1220", border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 3, color: "#f1f5f9", fontSize: 12, fontFamily: "ui-monospace,monospace", outline: "none",
};

// ────────────────────────────────────────────────────────────
//  탭 5: 주간 통계
// ────────────────────────────────────────────────────────────
function WeeklyTab({ weekly }) {
  // 일자별 그룹
  const byDay = useMemo(() => {
    const m = new Map();
    weekly.forEach(a => {
      const d = new Date(a.checked_in_at);
      const key = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
      const hrs = a.checked_out_at
        ? (new Date(a.checked_out_at).getTime() - new Date(a.checked_in_at).getTime()) / 3600000
        : (Date.now() - new Date(a.checked_in_at).getTime()) / 3600000;
      m.set(key, (m.get(key) || 0) + hrs);
    });
    const arr = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
      const wd = ["일","월","화","수","목","금","토"][d.getDay()];
      arr.push({ key, label: `${pad(d.getMonth()+1)}/${pad(d.getDate())} ${wd}`, hours: m.get(key) || 0 });
    }
    return arr;
  }, [weekly]);

  const maxHrs = Math.max(8, ...byDay.map(d => d.hours));

  return (
    <div style={{ padding: "16px 20px" }}>
      <SectionTitle>최근 7일 근무시간</SectionTitle>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 200, padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
        {byDay.map(d => (
          <div key={d.key} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <div style={{ fontSize: 10, color: "#94a3b8", fontFamily: "ui-monospace,monospace" }}>{d.hours.toFixed(1)}h</div>
            <div style={{ width: "100%", maxWidth: 40, height: `${(d.hours / maxHrs) * 160}px`,
              background: d.hours >= 7.5 ? "linear-gradient(180deg,#34d399,#10b981)"
                       : d.hours > 0    ? "linear-gradient(180deg,#fbbf24,#f59e0b)"
                       : "rgba(255,255,255,0.05)",
              borderRadius: "4px 4px 0 0", minHeight: d.hours > 0 ? 4 : 2,
              transition: "height 0.3s" }} />
            <div style={{ fontSize: 10, color: "#64748b" }}>{d.label}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 12, fontSize: 11, color: "#94a3b8", textAlign: "right" }}>
        주간 합계: <strong style={{ color: "#34d399", fontFamily: "ui-monospace,monospace" }}>
          {byDay.reduce((s, d) => s + d.hours, 0).toFixed(1)}h
        </strong>
      </div>
    </div>
  );
}

function SectionTitle({ children }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 800, color: "#a78bfa", letterSpacing: ".12em",
      textTransform: "uppercase", marginBottom: 8 }}>
      {children}
    </div>
  );
}
