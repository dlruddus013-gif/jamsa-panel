// ════════════════════════════════════════════════════════════
//  실시간 위치 추적 + 행동 분석 + 일과별 로그 패널
//  - 구역별 게이트웨이 지정 UI
//  - BLE 비콘 감지 실시간 표시
//  - 구역별 인원 + CCTV 연동
//  - 일과별 로그 (ZONE_ENTER / ZONE_DWELL / ZONE_EXIT / IDLE_ALERT)
// ════════════════════════════════════════════════════════════
import React, { useState, useEffect, useRef, useMemo } from "react";

const COLLAPSED_KEY = "jamsa_presence_panel_collapsed";
const GW_MAP_LOCAL_KEY = "jamsa_gateway_zone_map"; // Supabase 미연결 시 localStorage 폴백

const loadGwMapLocal = () => {
  try { return JSON.parse(localStorage.getItem(GW_MAP_LOCAL_KEY) || "[]"); }
  catch (e) { return []; }
};
const saveGwMapLocal = (rows) => {
  try { localStorage.setItem(GW_MAP_LOCAL_KEY, JSON.stringify(rows || [])); }
  catch (e) {}
};

const pad = (n) => String(n).padStart(2, "0");
const fmtTimeFull = (iso) => {
  if (!iso) return "--:--:--";
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const fmtDateTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const sinceText = (iso) => {
  if (!iso) return "—";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s/60)}분 전`;
  if (s < 86400) return `${Math.floor(s/3600)}시간 전`;
  return `${Math.floor(s/86400)}일 전`;
};
const sinceMin = (iso) => {
  if (!iso) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
};
const getCctvUrl = (channel) => {
  try {
    const base = (localStorage.getItem("jamsa_cctv_guard_url") || "").replace(/\/+$/, "");
    if (!base) return null;
    if (channel == null) return base;
    return `${base}/?channel=${channel}`;
  } catch (e) { return null; }
};

const ACTIVITY_META = {
  CHECK_IN:    { icon: "🚪", color: "#34d399", label: "출근" },
  CHECK_OUT:   { icon: "🚪", color: "#94a3b8", label: "퇴근" },
  ZONE_ENTER:  { icon: "📍", color: "#60a5fa", label: "구역 입장" },
  ZONE_EXIT:   { icon: "↗",  color: "#fbbf24", label: "구역 이탈" },
  ZONE_DWELL:  { icon: "⏱",  color: "#a78bfa", label: "구역 체류" },
  TRANSIT:     { icon: "🚶", color: "#fbbf24", label: "이동중" },
  IDLE_ALERT:  { icon: "⚠",  color: "#f87171", label: "장기 미감지" },
};

// ────────────────────────────────────────────────────────────
//  메인 패널
// ────────────────────────────────────────────────────────────
export function PresenceTrackingPanel() {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === "1"; } catch (e) { return false; }
  });
  const toggleCollapse = () => setCollapsed(v => {
    const next = !v;
    try { localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0"); } catch (e) {}
    return next;
  });

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [presence, setPresence] = useState([]);     // v_current_presence
  const [occupancy, setOccupancy] = useState([]);   // v_zone_occupancy
  const [activity, setActivity] = useState([]);     // v_daily_activity
  const [gwMap, setGwMap]       = useState([]);     // gateway_zone_map
  const [filter, setFilter]     = useState("all");  // all / ZONE_ENTER / ZONE_DWELL / IDLE_ALERT
  const [showGwEditor, setShowGwEditor] = useState(false);
  const [now, setNow] = useState(Date.now());

  const supabaseRef = useRef(null);
  const channelRef  = useRef(null);

  // 시계 (체류시간 카운트 업)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(id);
  }, []);

  // Supabase 클라이언트 가져오기
  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    // 즉시 localStorage 매핑 로드 (Supabase 연결 전에라도 매핑은 표시)
    const localRows = loadGwMapLocal();
    if (localRows.length > 0) setGwMap(localRows);

    const tryGetSb = () => {
      if (cancelled) return;
      const sb = (typeof window !== "undefined") ? window.__supabase : null;
      if (sb) {
        supabaseRef.current = sb;
        loadAll(sb);
        subscribeRealtime(sb);
      } else if (tries++ < 12) {
        setTimeout(tryGetSb, 300);
      } else {
        // Supabase 미연결 — localStorage 매핑만 사용
        setLoading(false);
        if (localRows.length === 0) {
          setErr("Supabase 미연결 — 게이트웨이 매핑은 로컬에 저장됩니다");
        }
      }
    };
    tryGetSb();
    return () => {
      cancelled = true;
      if (channelRef.current && supabaseRef.current) {
        try { supabaseRef.current.removeChannel(channelRef.current); } catch (e) {}
      }
    };
  }, []);

  async function loadAll(sb) {
    setLoading(true); setErr(null);
    try {
      const [pres, occ, act, gw] = await Promise.all([
        sb.from("v_current_presence").select("*"),
        sb.from("v_zone_occupancy").select("*"),
        sb.from("v_daily_activity").select("*").limit(100),
        sb.from("gateway_zone_map").select("*").order("zone_name"),
      ]);
      if (pres.error) throw pres.error;
      setPresence(pres.data || []);
      setOccupancy(occ.data || []);
      setActivity(act.data || []);
      // Supabase + localStorage 병합 — gateway_serial 기준 (Supabase 우선)
      const localRows = loadGwMapLocal();
      const sbRows = gw.data || [];
      const sbSerials = new Set(sbRows.map(r => r.gateway_serial));
      const merged = [...sbRows, ...localRows.filter(r => !sbSerials.has(r.gateway_serial))];
      setGwMap(merged);
      // 병합본을 localStorage 에도 미러링 (오프라인 대비)
      saveGwMapLocal(merged);
    } catch (e) {
      setErr(e?.message || String(e));
      // Supabase 실패 시 localStorage 만 사용
      const localRows = loadGwMapLocal();
      if (localRows.length > 0) setGwMap(localRows);
    } finally { setLoading(false); }
  }

  function subscribeRealtime(sb) {
    if (channelRef.current) return;
    try {
      channelRef.current = sb.channel("presence-tracking-home")
        .on("postgres_changes", { event: "*", schema: "public", table: "beacon_detections" }, () => {
          // 감지마다 다시 로드 (가벼움)
          loadAll(sb);
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "presence_events" }, () => loadAll(sb))
        .on("postgres_changes", { event: "*", schema: "public", table: "activity_log" }, () => loadAll(sb))
        .subscribe();
    } catch (e) {}
  }

  const filteredActivity = useMemo(() => {
    if (filter === "all") return activity;
    return activity.filter(a => a.activity_type === filter);
  }, [activity, filter]);

  const stats = useMemo(() => ({
    presentNow: presence.length,
    zonesActive: occupancy.length,
    eventsToday: activity.filter(a => {
      const d = new Date(a.occurred_at);
      const t = new Date(); t.setHours(0,0,0,0);
      return d >= t;
    }).length,
    idleAlerts: activity.filter(a => a.activity_type === "IDLE_ALERT").length,
  }), [presence, occupancy, activity]);

  if (collapsed) {
    return (
      <div onClick={toggleCollapse}
        style={{ cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between",
                 padding: "10px 20px", background: "linear-gradient(90deg, #1e1b4b 0%, #7c3aed 100%)", color: "#fff", borderBottom: "1px solid rgba(0,0,0,0.2)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontSize: 22 }}>📡</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 800 }}>
              실시간 위치 추적 · 행동 분석
              <span style={{ marginLeft: 8, fontSize: 10, padding: "2px 7px", borderRadius: 4, background: "rgba(255,255,255,0.18)" }}>
                현장 {stats.presentNow}명 · 오늘 이벤트 {stats.eventsToday}건
                {stats.idleAlerts > 0 && <> · ⚠ {stats.idleAlerts}</>}
              </span>
            </div>
            <div style={{ fontSize: 10, opacity: 0.85, marginTop: 2 }}>클릭하면 펼쳐집니다 ▾</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: "#0b1220", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
      {/* 헤더 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 20px",
        background: "linear-gradient(90deg, #1e1b4b 0%, #7c3aed 100%)", color: "#fff" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontSize: 22 }}>📡</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 800 }}>
              실시간 위치 추적 · 행동 분석 · 일과별 로그
              <span style={{ marginLeft: 8, fontSize: 10, padding: "2px 7px", borderRadius: 4, background: "rgba(255,255,255,0.18)" }}>
                BLE GATEWAY · ZONE · CCTV · LOG
              </span>
            </div>
            <div style={{ fontSize: 10, opacity: 0.85, marginTop: 2 }}>
              구역별 게이트웨이 비콘 감지 → 자동 행동 추론 → CCTV 연동 → 실시간 일과 로그
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button onClick={() => setShowGwEditor(true)}
            style={{ padding: "6px 12px", background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.25)", borderRadius: 6, fontSize: 11, fontWeight: 700, color: "#fff", cursor: "pointer" }}>
            ⚙ 게이트웨이 매핑 <span style={{ fontSize: 9, opacity: 0.7 }}>({gwMap.length})</span>
          </button>
          <button onClick={() => loadAll(supabaseRef.current)}
            title="수동 새로고침"
            style={{ padding: "6px 10px", background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 6, fontSize: 11, color: "#fff", cursor: "pointer" }}>
            ⟳
          </button>
          <button onClick={toggleCollapse}
            style={{ padding: "6px 10px", background: "rgba(15,23,42,0.35)", border: "1px solid rgba(255,255,255,0.25)", borderRadius: 6, fontSize: 11, fontWeight: 700, color: "#fff", cursor: "pointer" }}>
            ▴ 접기
          </button>
        </div>
      </div>

      {/* 본문 */}
      {loading ? (
        <div style={{ padding: 30, textAlign: "center", color: "#64748b", fontSize: 12 }}>⏳ 데이터 불러오는 중...</div>
      ) : (err && gwMap.length === 0) ? (
        <div style={{ padding: 16, fontSize: 12, color: "#fca5a5", background: "rgba(220,38,38,0.1)" }}>
          ⚠ {err}
          <div style={{ marginTop: 6, color: "#94a3b8", fontSize: 11 }}>
            게이트웨이 매핑은 <strong>로컬에 저장</strong>되므로 Supabase 없이도 사용 가능합니다.
            상단의 <strong>⚙ 게이트웨이 매핑</strong> 버튼을 눌러 추가하세요.
          </div>
        </div>
      ) : (
        <div>
          {err && (
            <div style={{ padding: "6px 16px", fontSize: 10, color: "#fbbf24", background: "rgba(245,158,11,0.08)", borderBottom: "1px solid rgba(245,158,11,0.2)" }}>
              ⚠ {err} · 로컬 매핑 {gwMap.length}건 표시 중
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "280px 1fr 360px", gap: 0 }}>
          {/* ─── (1) 구역별 인원 + CCTV ─── */}
          <div style={{ padding: "12px 14px", borderRight: "1px solid rgba(255,255,255,0.06)" }}>
            <SectionTitle>🗺 구역별 현장 인원</SectionTitle>
            {occupancy.length === 0 && gwMap.length === 0 ? (
              <EmptyHint>
                게이트웨이가 아직 매핑되지 않았습니다.
                <br/><br/>
                <button onClick={() => setShowGwEditor(true)}
                  style={{ marginTop: 8, padding: "5px 12px", background: "#7c3aed", color: "#fff", border: "none", borderRadius: 4, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                  + 첫 매핑 추가
                </button>
              </EmptyHint>
            ) : (
              <>
                {gwMap.map(gw => {
                  const occ = occupancy.find(o => o.zone_id === gw.zone_id);
                  const count = occ?.people_count || 0;
                  const names = occ?.people_names || [];
                  const cctvUrl = getCctvUrl(gw.cctv_channel) || gw.cctv_url;
                  return (
                    <div key={gw.gateway_serial}
                      style={{ marginBottom: 8, padding: 10, borderRadius: 6,
                        background: count > 0 ? "rgba(124,58,237,0.12)" : "rgba(255,255,255,0.03)",
                        border: `1px solid ${count > 0 ? "rgba(167,139,250,0.35)" : "rgba(255,255,255,0.05)"}` }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#f1f5f9" }}>{gw.zone_name}</div>
                        <span style={{ fontSize: 11, padding: "1px 7px", borderRadius: 3, background: count > 0 ? "rgba(167,139,250,0.3)" : "rgba(148,163,184,0.2)", color: count > 0 ? "#ddd6fe" : "#94a3b8", fontFamily: "ui-monospace,monospace" }}>{count}명</span>
                      </div>
                      <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 6, fontFamily: "ui-monospace,monospace" }}>
                        GW {gw.gateway_serial.slice(0, 16)}{gw.gateway_serial.length > 16 ? "…" : ""}
                        {gw.cctv_channel != null && <> · ch{gw.cctv_channel}</>}
                      </div>
                      {count > 0 && (
                        <div style={{ fontSize: 11, color: "#cbd5e1", marginBottom: 6, lineHeight: 1.4 }}>
                          {names.slice(0, 5).join(", ")}
                          {names.length > 5 && <> 외 {names.length - 5}</>}
                        </div>
                      )}
                      {cctvUrl && (
                        <a href={cctvUrl} target="_blank" rel="noopener"
                          style={{ display: "inline-block", padding: "3px 9px", borderRadius: 4, background: "linear-gradient(135deg,#0891b2,#059669)", color: "#fff", fontSize: 10, fontWeight: 700, textDecoration: "none" }}>
                          📹 CCTV 보기 ↗
                        </a>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </div>

          {/* ─── (2) 일과별 로그 (메인) ─── */}
          <div style={{ padding: "12px 14px", borderRight: "1px solid rgba(255,255,255,0.06)", maxHeight: 560, overflowY: "auto" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <SectionTitle>📋 일과별 행동 로그 (실시간)</SectionTitle>
              <div style={{ display: "flex", gap: 4 }}>
                {[
                  ["all", "전체"],
                  ["ZONE_ENTER", "입장"],
                  ["ZONE_DWELL", "체류"],
                  ["ZONE_EXIT", "이동"],
                  ["IDLE_ALERT", "⚠"],
                ].map(([k, label]) => (
                  <button key={k} onClick={() => setFilter(k)}
                    style={{ padding: "3px 8px", borderRadius: 3, fontSize: 10, fontWeight: 700, cursor: "pointer",
                      background: filter === k ? "#7c3aed" : "rgba(255,255,255,0.05)",
                      color: filter === k ? "#fff" : "#94a3b8",
                      border: filter === k ? "1px solid #a78bfa" : "1px solid rgba(255,255,255,0.08)" }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {filteredActivity.length === 0 ? (
              <EmptyHint>아직 로그가 없습니다 — 게이트웨이가 비콘을 감지하면 자동 기록됩니다</EmptyHint>
            ) : (
              <div>
                {filteredActivity.map(a => {
                  const meta = ACTIVITY_META[a.activity_type] || { icon: "•", color: "#94a3b8", label: a.activity_type };
                  const cctvUrl = a.cctv_channel != null ? getCctvUrl(a.cctv_channel) : null;
                  return (
                    <div key={a.id}
                      style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 0", borderBottom: "1px dotted rgba(255,255,255,0.05)" }}>
                      <div style={{ width: 26, height: 26, borderRadius: 13, background: `${meta.color}22`, color: meta.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, flexShrink: 0 }}>
                        {meta.icon}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#f1f5f9", letterSpacing: "-0.01em" }}>
                          {a.staff_name || "비콘 미배정"}
                          <span style={{ marginLeft: 6, color: meta.color, fontSize: 9, padding: "1px 6px", borderRadius: 3, background: `${meta.color}18`, fontWeight: 800 }}>{meta.label}</span>
                          {a.dept_name && <span style={{ marginLeft: 6, color: "#64748b", fontWeight: 400, fontSize: 10 }}>· {a.dept_name}</span>}
                        </div>
                        <div style={{ fontSize: 11, color: "#cbd5e1", marginTop: 2, lineHeight: 1.4 }}>
                          {a.inferred_behavior}
                        </div>
                        <div style={{ fontSize: 10, color: "#64748b", marginTop: 3, fontFamily: "ui-monospace,monospace", display: "flex", gap: 8, alignItems: "center" }}>
                          <span>{a.occurred_time}</span>
                          {a.zone_name && <span>· {a.zone_name}</span>}
                          {a.rssi != null && <span>· RSSI {a.rssi}</span>}
                          {a.duration_sec != null && <span>· {Math.floor(a.duration_sec/60)}분</span>}
                          {cctvUrl && (
                            <a href={cctvUrl} target="_blank" rel="noopener"
                              style={{ marginLeft: "auto", padding: "2px 7px", borderRadius: 3, background: "rgba(8,145,178,0.2)", color: "#67e8f9", fontSize: 10, fontWeight: 700, textDecoration: "none" }}>
                              📹 ch{a.cctv_channel} ↗
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ─── (3) 현재 위치 (각 직원) ─── */}
          <div style={{ padding: "12px 14px", maxHeight: 560, overflowY: "auto", background: "rgba(15,23,42,0.4)" }}>
            <SectionTitle>📍 직원별 현재 위치</SectionTitle>
            {presence.length === 0 ? (
              <EmptyHint>현재 감지되는 비콘 없음</EmptyHint>
            ) : (
              presence.map(p => {
                const cctvUrl = getCctvUrl(p.cctv_channel);
                const dwell = Math.floor((Date.now() - new Date(p.entered_at).getTime()) / 60000);
                return (
                  <div key={p.staff_id || p.beacon_uuid}
                    style={{ padding: 10, marginBottom: 6, borderRadius: 6, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#f1f5f9" }}>
                        {p.staff_name || `비콘 ${(p.beacon_uuid||"").slice(0,8)}`}
                      </div>
                      <span style={{ fontSize: 10, fontFamily: "ui-monospace,monospace", color: "#a78bfa", fontWeight: 700 }}>
                        {dwell}분째
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: "#cbd5e1", marginBottom: 4 }}>
                      📍 <strong>{p.zone_name}</strong>
                      {p.dept_name && <span style={{ color: "#94a3b8", marginLeft: 4 }}>({p.dept_name})</span>}
                    </div>
                    <div style={{ fontSize: 10, color: "#64748b", fontFamily: "ui-monospace,monospace", marginBottom: 6 }}>
                      입장 {fmtDateTime(p.entered_at)} · RSSI {p.max_rssi ?? "—"} · 감지 {p.detection_count}회
                    </div>
                    {cctvUrl && (
                      <a href={cctvUrl} target="_blank" rel="noopener"
                        style={{ display: "inline-block", padding: "3px 9px", borderRadius: 4, background: "linear-gradient(135deg,#0891b2,#059669)", color: "#fff", fontSize: 10, fontWeight: 700, textDecoration: "none" }}>
                        📹 CCTV ch{p.cctv_channel} ↗
                      </a>
                    )}
                  </div>
                );
              })
            )}
          </div>
          </div>
        </div>
      )}

      {/* 게이트웨이 매핑 모달 */}
      {showGwEditor && (
        <GatewayZoneEditor
          sb={supabaseRef.current}
          current={gwMap}
          onClose={() => setShowGwEditor(false)}
          onSaved={() => { setShowGwEditor(false); loadAll(supabaseRef.current); }}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  보조 컴포넌트
// ────────────────────────────────────────────────────────────
function SectionTitle({ children }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 800, color: "#a78bfa", letterSpacing: ".12em", textTransform: "uppercase", marginBottom: 8 }}>
      {children}
    </div>
  );
}
function EmptyHint({ children }) {
  return (
    <div style={{ padding: "20px 8px", textAlign: "center", color: "#64748b", fontSize: 11, lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  게이트웨이 ↔ 구역 매핑 에디터
// ────────────────────────────────────────────────────────────
function GatewayZoneEditor({ sb, current, onClose, onSaved }) {
  const [rows, setRows] = useState(() => current.map(r => ({ ...r })));
  const [newRow, setNewRow] = useState({ gateway_serial: "", zone_id: "", zone_name: "", cctv_channel: "", dwell_threshold_min: 2 });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  // 사용자 정의 zone (jamsa_custom_zones) 도 옵션으로 보여줌
  const customZones = useMemo(() => {
    try { return JSON.parse(localStorage.getItem("jamsa_custom_zones") || "[]"); }
    catch (e) { return []; }
  }, []);

  // 감지된 게이트웨이 목록 (beacon_detections 에서 distinct)
  const [knownGws, setKnownGws] = useState([]);
  useEffect(() => {
    if (!sb) return;
    (async () => {
      try {
        const { data } = await sb
          .from("beacon_detections")
          .select("gateway_serial")
          .order("detected_at", { ascending: false })
          .limit(200);
        const uniq = Array.from(new Set((data||[]).map(d => d.gateway_serial).filter(Boolean)));
        setKnownGws(uniq);
      } catch (e) {}
    })();
  }, [sb]);

  const addRow = () => {
    if (!newRow.gateway_serial.trim() || !newRow.zone_name.trim()) {
      alert("게이트웨이 시리얼과 구역명을 입력하세요");
      return;
    }
    setRows([...rows, {
      ...newRow,
      zone_id: newRow.zone_id.trim() || `zone-${Date.now()}`,
      cctv_channel: newRow.cctv_channel ? Number(newRow.cctv_channel) : null,
    }]);
    setNewRow({ gateway_serial: "", zone_id: "", zone_name: "", cctv_channel: "", dwell_threshold_min: 2 });
  };

  const deleteRow = async (gateway_serial) => {
    if (!confirm(`'${gateway_serial}' 매핑을 삭제하시겠습니까?`)) return;
    if (sb) {
      const { error } = await sb.from("gateway_zone_map").delete().eq("gateway_serial", gateway_serial);
      if (error) { alert("삭제 실패: " + error.message); return; }
    }
    const next = rows.filter(r => r.gateway_serial !== gateway_serial);
    setRows(next);
    saveGwMapLocal(next); // localStorage 동기화
    onSaved && onSaved();
  };

  const saveAll = async () => {
    setSaving(true); setErr(null);
    try {
      const payload = rows.map(r => ({
        gateway_serial: r.gateway_serial,
        zone_id: r.zone_id,
        zone_name: r.zone_name,
        cctv_channel: r.cctv_channel === "" ? null : (r.cctv_channel == null ? null : Number(r.cctv_channel)),
        dwell_threshold_min: r.dwell_threshold_min || 2,
        notes: r.notes || null,
        updated_at: new Date().toISOString(),
      }));
      // localStorage 에 먼저 저장 (오프라인/Supabase 미연결 시에도 영구 유지)
      saveGwMapLocal(payload);
      // Supabase 가 연결돼 있으면 추가로 동기화
      if (sb) {
        const { error } = await sb.from("gateway_zone_map").upsert(payload, { onConflict: "gateway_serial" });
        if (error) throw error;
      }
      onSaved && onSaved();
    } catch (e) {
      setErr((e?.message || String(e)) + " (localStorage 에는 저장됨)");
    } finally { setSaving(false); }
  };

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 820, maxHeight: "85vh", background: "#0f172a", color: "#f1f5f9", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid rgba(255,255,255,0.08)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800 }}>⚙ 게이트웨이 ↔ 구역 매핑</div>
            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
              각 BLE 게이트웨이가 어떤 구역에 설치되어 있는지 + CCTV 채널 지정
            </div>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.15)", color: "#94a3b8", borderRadius: 4, padding: "4px 10px", cursor: "pointer" }}>✕</button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 18 }}>
          {/* 기존 매핑 */}
          <div style={{ fontSize: 11, fontWeight: 800, color: "#a78bfa", letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 8 }}>
            매핑된 게이트웨이 ({rows.length})
          </div>
          {rows.length === 0 ? (
            <div style={{ padding: 16, textAlign: "center", color: "#64748b", fontSize: 11 }}>아직 매핑된 게이트웨이가 없습니다</div>
          ) : (
            <div style={{ marginBottom: 18 }}>
              {rows.map((r, i) => (
                <div key={r.gateway_serial + i}
                  style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 0.8fr 0.5fr 32px", gap: 6, marginBottom: 6, padding: 8, background: "rgba(255,255,255,0.04)", borderRadius: 4, alignItems: "center" }}>
                  <input value={r.gateway_serial} onChange={(e) => {
                    const next = [...rows]; next[i].gateway_serial = e.target.value; setRows(next);
                  }} placeholder="게이트웨이 시리얼"
                    style={inputStyle} />
                  <input value={r.zone_name} onChange={(e) => {
                    const next = [...rows]; next[i].zone_name = e.target.value;
                    if (!next[i].zone_id) next[i].zone_id = e.target.value.replace(/\s+/g, "-").toLowerCase();
                    setRows(next);
                  }} placeholder="구역명"
                    style={inputStyle} />
                  <input type="number" value={r.cctv_channel ?? ""} onChange={(e) => {
                    const next = [...rows]; next[i].cctv_channel = e.target.value; setRows(next);
                  }} placeholder="CCTV ch"
                    style={inputStyle} />
                  <input type="number" value={r.dwell_threshold_min || 2} onChange={(e) => {
                    const next = [...rows]; next[i].dwell_threshold_min = Number(e.target.value) || 2; setRows(next);
                  }} placeholder="체류분"
                    style={inputStyle} />
                  <button onClick={() => deleteRow(r.gateway_serial)}
                    style={{ background: "rgba(220,38,38,0.2)", color: "#fca5a5", border: "1px solid rgba(220,38,38,0.4)", borderRadius: 3, padding: "5px 0", cursor: "pointer", fontSize: 11 }}>✕</button>
                </div>
              ))}
            </div>
          )}

          {/* 새 매핑 추가 */}
          <div style={{ fontSize: 11, fontWeight: 800, color: "#34d399", letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 8 }}>
            + 새 매핑 추가
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 0.8fr 0.5fr auto", gap: 6, alignItems: "center", padding: 8, background: "rgba(52,211,153,0.05)", border: "1px dashed rgba(52,211,153,0.3)", borderRadius: 4 }}>
            <div>
              <input list="known-gws" value={newRow.gateway_serial}
                onChange={(e) => setNewRow({ ...newRow, gateway_serial: e.target.value })}
                placeholder="게이트웨이 시리얼" style={inputStyle} />
              <datalist id="known-gws">
                {knownGws.map(g => <option key={g} value={g} />)}
              </datalist>
            </div>
            <div>
              <input list="known-zones" value={newRow.zone_name}
                onChange={(e) => setNewRow({ ...newRow, zone_name: e.target.value })}
                placeholder="구역명 (예: 관리부 사무실)" style={inputStyle} />
              <datalist id="known-zones">
                {customZones.map(z => <option key={z.id} value={z.name} />)}
              </datalist>
            </div>
            <input type="number" value={newRow.cctv_channel}
              onChange={(e) => setNewRow({ ...newRow, cctv_channel: e.target.value })}
              placeholder="CCTV ch" style={inputStyle} />
            <input type="number" value={newRow.dwell_threshold_min}
              onChange={(e) => setNewRow({ ...newRow, dwell_threshold_min: Number(e.target.value) || 2 })}
              placeholder="체류분" style={inputStyle} />
            <button onClick={addRow}
              style={{ padding: "6px 14px", background: "#10b981", color: "#0f172a", border: "none", borderRadius: 4, fontSize: 11, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap" }}>
              추가
            </button>
          </div>

          {knownGws.length > 0 && (
            <div style={{ marginTop: 14, padding: 10, background: "rgba(96,165,250,0.08)", border: "1px solid rgba(96,165,250,0.2)", borderRadius: 4, fontSize: 11, color: "#cbd5e1" }}>
              <strong style={{ color: "#93c5fd" }}>📡 최근 감지된 게이트웨이 ({knownGws.length})</strong>
              <div style={{ marginTop: 6, fontFamily: "ui-monospace,monospace", fontSize: 10, color: "#94a3b8", lineHeight: 1.6 }}>
                {knownGws.slice(0, 8).map(g => (
                  <span key={g} style={{ display: "inline-block", marginRight: 8 }}>
                    <code style={{ background: "rgba(255,255,255,0.05)", padding: "1px 5px", borderRadius: 3, color: "#93c5fd" }}>{g}</code>
                  </span>
                ))}
                {knownGws.length > 8 && <>… 외 {knownGws.length - 8}개</>}
              </div>
            </div>
          )}

          {err && (
            <div style={{ marginTop: 12, padding: 10, background: "rgba(220,38,38,0.1)", border: "1px solid rgba(220,38,38,0.3)", borderRadius: 4, fontSize: 11, color: "#fca5a5" }}>
              ⚠ {err}
            </div>
          )}
        </div>

        <div style={{ padding: "10px 18px", borderTop: "1px solid rgba(255,255,255,0.08)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 10, color: "#64748b" }}>
            저장 후 게이트웨이 webhook 으로 비콘 감지가 들어오면 자동으로 구역/CCTV가 연결됩니다
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={onClose}
              style={{ padding: "6px 14px", borderRadius: 4, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#cbd5e1", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
              닫기
            </button>
            <button onClick={saveAll} disabled={saving}
              style={{ padding: "6px 14px", borderRadius: 4, background: saving ? "#64748b" : "#7c3aed", color: "#fff", border: "none", fontSize: 11, fontWeight: 800, cursor: saving ? "wait" : "pointer" }}>
              {saving ? "저장 중..." : "전체 저장"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const inputStyle = {
  width: "100%", padding: "5px 8px", background: "#0b1220", border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 3, color: "#f1f5f9", fontSize: 11, fontFamily: "ui-monospace,monospace", outline: "none",
};
