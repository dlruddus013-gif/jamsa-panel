// ════════════════════════════════════════════════════════════
//  실시간 직원 출퇴근 + 위치 + CCTV + 행동로그 통합 패널
//  메인 홈 대시보드에 임베드되는 컴포넌트
// ════════════════════════════════════════════════════════════
import React, { useState, useEffect, useMemo, useRef } from "react";

const DEPT_CCTV_MAP_KEY = "jamsa_dept_cctv_map";   // { [dept_id]: channelNum }
const COLLAPSED_KEY     = "jamsa_attendance_panel_collapsed";

const pad = (n) => String(n).padStart(2, "0");
const fmtTime = (iso) => {
  if (!iso) return "--:--";
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fmtTimeFull = (iso) => {
  if (!iso) return "--:--:--";
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const sinceMinutes = (iso) => {
  if (!iso) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
};

// CCTV URL 생성 (jamsa_cctv_guard_url 우선)
function getCctvUrl(channel) {
  try {
    const base = (localStorage.getItem("jamsa_cctv_guard_url") || "").replace(/\/+$/, "");
    if (!base) return null;
    if (channel == null) return base;
    return `${base}/?channel=${channel}`;
  } catch (e) { return null; }
}

// 부서 → CCTV 채널 매핑
function loadDeptCctvMap() {
  try { return JSON.parse(localStorage.getItem(DEPT_CCTV_MAP_KEY) || "{}"); }
  catch (e) { return {}; }
}
function saveDeptCctvMap(map) {
  try { localStorage.setItem(DEPT_CCTV_MAP_KEY, JSON.stringify(map)); } catch (e) {}
}

// ────────────────────────────────────────────────────────────
//  메인 패널
// ────────────────────────────────────────────────────────────
export function StaffAttendanceLivePanel({ onAddFacAction }) {
  const [collapsed, setCollapsed]   = useState(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === "1"; } catch (e) { return false; }
  });
  const [loading, setLoading]       = useState(true);
  const [err, setErr]               = useState(null);
  const [depts, setDepts]           = useState([]);
  const [staffList, setStaffList]   = useState([]);
  const [today, setToday]           = useState([]);   // 오늘 attendance
  const [recent, setRecent]         = useState([]);   // 최근 행동 로그 (출근/퇴근 이벤트)
  const [deptCctv, setDeptCctv]     = useState(loadDeptCctvMap);
  const [selectedDept, setSelectedDept] = useState("all");
  const [logModalStaff, setLogModalStaff] = useState(null);
  const [editCctvDept, setEditCctvDept] = useState(null);
  const channelRef = useRef(null);
  const supabaseRef = useRef(null);

  const toggleCollapse = () => {
    setCollapsed(v => {
      const next = !v;
      try { localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0"); } catch (e) {}
      return next;
    });
  };

  // Supabase 클라이언트 가져오기 (entry.jsx 에서 window.__supabase 로 노출됨)
  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    const tryGetSb = () => {
      if (cancelled) return;
      const sb = (typeof window !== "undefined") ? window.__supabase : null;
      if (sb) {
        supabaseRef.current = sb;
        loadAll(sb);
        subscribeRealtime(sb);
      } else if (tries++ < 12) {
        // 최대 12회 (~3.6초) 재시도
        setTimeout(tryGetSb, 300);
      } else {
        setLoading(false);
        setErr("Supabase 클라이언트 미연결 (로컬 모드일 수 있음)");
      }
    };
    tryGetSb();
    return () => {
      cancelled = true;
      if (channelRef.current && supabaseRef.current) {
        try { supabaseRef.current.removeChannel(channelRef.current); } catch (e) {}
        channelRef.current = null;
      }
    };
  }, []);

  async function loadAll(sb) {
    setLoading(true);
    setErr(null);
    try {
      const today00 = new Date(); today00.setHours(0,0,0,0);
      const todayStr = today00.toISOString().slice(0,10);

      const [dRes, sRes, aRes, rRes] = await Promise.all([
        sb.from("beacon_dept").select("*").order("id"),
        sb.from("staff").select("*").order("name"),
        sb.from("attendance").select("*")
          .gte("checked_in_at", todayStr + "T00:00:00")
          .lte("checked_in_at", todayStr + "T23:59:59")
          .order("checked_in_at", { ascending: false }),
        sb.from("attendance").select("*, staff:staff_id(name,dept_id)")
          .order("checked_in_at", { ascending: false })
          .limit(30),
      ]);
      if (dRes.error) throw dRes.error;
      if (sRes.error) throw sRes.error;
      if (aRes.error) throw aRes.error;
      // rRes 의 error 는 무시 (스키마 차이 가능)
      setDepts(dRes.data || []);
      setStaffList(sRes.data || []);
      setToday(aRes.data || []);
      setRecent((rRes.data || []).filter(r => r && r.staff_id));
      setLoading(false);
    } catch (e) {
      console.warn("[live panel] load failed:", e);
      setErr(e?.message || String(e));
      setLoading(false);
    }
  }

  function subscribeRealtime(sb) {
    if (channelRef.current) return;
    try {
      channelRef.current = sb.channel("attendance-live-home")
        .on("postgres_changes", { event: "*", schema: "public", table: "attendance" }, () => {
          loadAll(sb);
        })
        .subscribe();
    } catch (e) { /* ignore */ }
  }

  // 통계
  const stats = useMemo(() => {
    const checkedIn  = new Set();
    const checkedOut = new Set();
    today.forEach(a => {
      checkedIn.add(a.staff_id);
      if (a.checked_out_at) checkedOut.add(a.staff_id);
    });
    return {
      total: staffList.length,
      in: checkedIn.size,
      working: checkedIn.size - checkedOut.size,
      out: checkedOut.size,
      absent: Math.max(0, staffList.length - checkedIn.size),
    };
  }, [staffList, today]);

  // 필터된 직원 (현재 근무중 + 출근완료 우선)
  const visibleStaff = useMemo(() => {
    const list = selectedDept === "all"
      ? staffList
      : staffList.filter(s => s.dept_id === selectedDept);
    // 정렬: 근무중 > 출근후퇴근 > 미출근, 그 다음 이름
    return list.map(s => {
      const att = today.filter(a => a.staff_id === s.id);
      const last = att[0]; // 정렬: checked_in_at desc
      const working = !!(last && !last.checked_out_at);
      return { staff: s, last, working };
    }).sort((a, b) => {
      const rank = (x) => x.working ? 0 : (x.last ? 1 : 2);
      const ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      return (a.staff.name || "").localeCompare(b.staff.name || "");
    });
  }, [staffList, today, selectedDept]);

  if (collapsed) {
    return (
      <div onClick={toggleCollapse}
        style={{
          cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 14, padding: "10px 20px",
          background: "linear-gradient(90deg, #0b3a2a 0%, #10b981 100%)",
          color: "#f0fdf4", borderBottom: "1px solid rgba(0,0,0,0.2)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontSize: 22 }}>👥</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 800 }}>
              실시간 출퇴근 · 위치 · CCTV · 행동로그
              <span style={{ marginLeft: 8, fontSize: 10, padding: "2px 7px", borderRadius: 4, background: "rgba(255,255,255,0.18)" }}>
                근무중 {stats.working} · 미출근 {stats.absent}
              </span>
            </div>
            <div style={{ fontSize: 10, opacity: 0.85, marginTop: 2 }}>클릭하면 펼쳐집니다 ▾</div>
          </div>
        </div>
        <a href="/attendance" target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}
          style={{ padding: "6px 12px", background: "rgba(15,23,42,0.35)", border: "1px solid rgba(255,255,255,0.25)", borderRadius: 6, fontSize: 11, fontWeight: 700, color: "#fff", textDecoration: "none", whiteSpace: "nowrap" }}>
          전체화면 ↗
        </a>
      </div>
    );
  }

  return (
    <div style={{ background: "#0b1220", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
      {/* ─── 헤더 ─── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 20px", background: "linear-gradient(90deg, #0b3a2a 0%, #10b981 100%)", color: "#f0fdf4" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontSize: 22, lineHeight: 1 }}>👥</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 800 }}>
              실시간 출퇴근 통합 모니터
              <span style={{ marginLeft: 8, fontSize: 10, padding: "2px 7px", borderRadius: 4, background: "rgba(255,255,255,0.18)" }}>HR · BLE · CCTV · LOG</span>
            </div>
            <div style={{ fontSize: 10, opacity: 0.85, marginTop: 2 }}>
              직원 출퇴근 · 위치(부서·비콘) · CCTV 연동 · 행동 로그
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <a href="/attendance" target="_blank" rel="noopener"
            style={{ padding: "6px 12px", background: "rgba(15,23,42,0.35)", border: "1px solid rgba(255,255,255,0.25)", borderRadius: 6, fontSize: 11, fontWeight: 700, color: "#fff", textDecoration: "none", whiteSpace: "nowrap" }}>
            전체화면 ↗
          </a>
          <button onClick={toggleCollapse}
            title="접기"
            style={{ padding: "6px 10px", background: "rgba(15,23,42,0.35)", border: "1px solid rgba(255,255,255,0.25)", borderRadius: 6, fontSize: 11, fontWeight: 700, color: "#fff", cursor: "pointer" }}>
            ▴ 접기
          </button>
        </div>
      </div>

      {/* ─── 본문 ─── */}
      {loading ? (
        <div style={{ padding: "30px 20px", color: "#64748b", fontSize: 12, textAlign: "center" }}>
          ⏳ Supabase 에서 출퇴근 데이터 불러오는 중...
        </div>
      ) : err ? (
        <div style={{ padding: "20px", color: "#fca5a5", fontSize: 12, background: "rgba(220,38,38,0.1)" }}>
          ⚠ 출퇴근 데이터 로드 실패: {err}
          <div style={{ marginTop: 6, color: "#94a3b8", fontSize: 11 }}>
            Supabase 로그인 상태이고 attendance_setup_all_in_one.sql 이 실행되었는지 확인하세요.
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 0 }}>
          {/* 좌측: 직원 카드 그리드 */}
          <div style={{ padding: "12px 16px 14px", borderRight: "1px solid rgba(255,255,255,0.06)" }}>
            {/* 통계 + 부서 탭 */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 10 }}>
              <DeptTab label="전체" count={staffList.length}
                active={selectedDept === "all"} onClick={() => setSelectedDept("all")} />
              {depts.map(d => (
                <DeptTab key={d.id} label={d.name}
                  count={staffList.filter(s => s.dept_id === d.id).length}
                  active={selectedDept === d.id}
                  onClick={() => setSelectedDept(d.id)} />
              ))}
              <div style={{ flex: 1 }} />
              <Pill text={`근무중 ${stats.working}`}    color="#34d399" />
              <Pill text={`퇴근 ${stats.out}`}          color="#94a3b8" />
              <Pill text={`미출근 ${stats.absent}`}     color="#fbbf24" />
            </div>

            {/* 카드 */}
            {visibleStaff.length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", color: "#64748b", fontSize: 12 }}>
                등록된 직원이 없습니다 — supabase/staff_seed.sql 실행 필요
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 8 }}>
                {visibleStaff.map(({ staff, last, working }) => (
                  <StaffMiniCard
                    key={staff.id}
                    staff={staff}
                    last={last}
                    working={working}
                    dept={depts.find(d => d.id === staff.dept_id)}
                    cctvCh={deptCctv[staff.dept_id]}
                    onCheckIn={async () => {
                      const sb = supabaseRef.current;
                      if (!sb) return;
                      const { error } = await sb.from("attendance").insert({ staff_id: staff.id, source: "manual" });
                      if (error) alert("출근 실패: " + error.message);
                    }}
                    onCheckOut={async () => {
                      const sb = supabaseRef.current;
                      if (!sb || !last) return;
                      const { error } = await sb.from("attendance")
                        .update({ checked_out_at: new Date().toISOString() })
                        .eq("id", last.id);
                      if (error) alert("퇴근 실패: " + error.message);
                    }}
                    onShowLog={() => setLogModalStaff(staff)}
                    onSetCctv={() => setEditCctvDept(staff.dept_id)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* 우측: 행동 로그 + 위치 요약 */}
          <div style={{ padding: "12px 16px 14px", maxHeight: 480, overflowY: "auto", background: "rgba(15,23,42,0.4)" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 8 }}>
              📋 실시간 행동 로그
            </div>
            {recent.length === 0 ? (
              <div style={{ padding: 12, color: "#64748b", fontSize: 11, textAlign: "center" }}>아직 기록 없음</div>
            ) : (
              <div>
                {recent.slice(0, 20).map(r => {
                  const nm = r.staff?.name || `#${r.staff_id}`;
                  const dpt = depts.find(d => d.id === r.staff?.dept_id);
                  const checkedOut = !!r.checked_out_at;
                  return (
                    <div key={r.id}
                      style={{ padding: "6px 0", borderBottom: "1px dotted rgba(255,255,255,0.06)", display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
                      <span style={{ width: 6, height: 6, borderRadius: 3, background: checkedOut ? "#94a3b8" : "#34d399", flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ color: "#f1f5f9", fontWeight: 600 }}>
                          {nm}
                          <span style={{ color: "#64748b", fontWeight: 400, marginLeft: 6 }}>
                            {dpt?.name || "-"}
                          </span>
                        </div>
                        <div style={{ color: "#94a3b8", fontSize: 10, fontFamily: "ui-monospace, monospace" }}>
                          출근 {fmtTimeFull(r.checked_in_at)}
                          {checkedOut && <> · 퇴근 {fmtTimeFull(r.checked_out_at)}</>}
                        </div>
                      </div>
                      <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 3, background: checkedOut ? "rgba(148,163,184,0.18)" : "rgba(52,211,153,0.2)", color: checkedOut ? "#cbd5e1" : "#6ee7b7", whiteSpace: "nowrap" }}>
                        {checkedOut ? "퇴근완료" : `근무중 ${sinceMinutes(r.checked_in_at)}분`}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            <div style={{ marginTop: 14, fontSize: 10, fontWeight: 700, color: "#94a3b8", letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 8 }}>
              📍 위치 (부서별 인원)
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 4 }}>
              {depts.map(d => {
                const here = visibleStaff.filter(x => x.staff.dept_id === d.id && x.working).length;
                const ch   = deptCctv[d.id];
                const cctvUrl = getCctvUrl(ch);
                return (
                  <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", background: "rgba(255,255,255,0.04)", borderRadius: 4 }}>
                    <span style={{ fontSize: 16 }}>📍</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#f1f5f9" }}>{d.name}</div>
                      <div style={{ fontSize: 10, color: "#94a3b8" }}>
                        근무중 <strong style={{ color: here > 0 ? "#34d399" : "#64748b" }}>{here}명</strong>
                        {ch != null && <> · CCTV ch{ch}</>}
                      </div>
                    </div>
                    {cctvUrl ? (
                      <a href={cctvUrl} target="_blank" rel="noopener" title={`CCTV 보기 (ch${ch})`}
                        style={{ padding: "3px 8px", borderRadius: 4, background: "linear-gradient(135deg,#0891b2,#059669)", color: "#fff", fontSize: 10, fontWeight: 700, textDecoration: "none" }}>
                        📹
                      </a>
                    ) : (
                      <button onClick={() => setEditCctvDept(d.id)} title="CCTV 채널 매핑"
                        style={{ padding: "3px 8px", borderRadius: 4, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#94a3b8", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>
                        ＋매핑
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* 행동 로그 모달 */}
      {logModalStaff && (
        <StaffLogModal
          staff={logModalStaff}
          dept={depts.find(d => d.id === logModalStaff.dept_id)}
          sb={supabaseRef.current}
          onClose={() => setLogModalStaff(null)}
          onAddFacAction={onAddFacAction}
        />
      )}

      {/* 부서 ↔ CCTV 채널 매핑 모달 */}
      {editCctvDept != null && (
        <DeptCctvEditModal
          dept={depts.find(d => d.id === editCctvDept)}
          currentCh={deptCctv[editCctvDept]}
          onSave={(ch) => {
            const next = { ...deptCctv };
            if (ch == null || ch === "") delete next[editCctvDept];
            else next[editCctvDept] = Number(ch);
            setDeptCctv(next);
            saveDeptCctvMap(next);
            setEditCctvDept(null);
          }}
          onCancel={() => setEditCctvDept(null)}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  보조 컴포넌트들
// ────────────────────────────────────────────────────────────

function DeptTab({ label, count, active, onClick }) {
  return (
    <button onClick={onClick}
      style={{ padding: "5px 12px", borderRadius: 6, border: "none", cursor: "pointer",
        fontSize: 11, fontWeight: 700,
        background: active ? "linear-gradient(135deg,#059669,#0891b2)" : "rgba(255,255,255,0.05)",
        color: active ? "#fff" : "#94a3b8",
      }}>
      {label} <span style={{ marginLeft: 4, opacity: 0.7, fontFamily: "ui-monospace,monospace" }}>{count}</span>
    </button>
  );
}

function Pill({ text, color }) {
  return (
    <span style={{ padding: "3px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700,
      background: "rgba(255,255,255,0.05)", color, border: `1px solid ${color}33` }}>{text}</span>
  );
}

function StaffMiniCard({ staff, last, working, dept, cctvCh, onCheckIn, onCheckOut, onShowLog, onSetCctv }) {
  const cctvUrl = getCctvUrl(cctvCh);
  const status = working ? "근무중"
                 : last  ? "퇴근완료"
                 : "미출근";
  const bg = working ? "linear-gradient(135deg, rgba(16,185,129,0.18), rgba(15,23,42,0.5))"
           : "rgba(30,41,59,0.6)";
  const border = working ? "1px solid rgba(52,211,153,0.4)" : "1px solid rgba(255,255,255,0.08)";
  return (
    <div style={{ background: bg, border, borderRadius: 8, padding: 10, position: "relative", overflow: "hidden" }}>
      {working && <div style={{ position: "absolute", top: 0, left: 0, bottom: 0, width: 3, background: "#34d399" }} />}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 3 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#f1f5f9", letterSpacing: "-0.01em" }}>{staff.name}</div>
        <span style={{ fontSize: 9, fontWeight: 700, color: working ? "#6ee7b7" : last ? "#94a3b8" : "#fbbf24" }}>{status}</span>
      </div>
      <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 6 }}>
        📍 {dept?.name || "미지정"} · {staff.beacon_id || "비콘 미배정"}
      </div>
      <div style={{ fontSize: 10, color: working ? "#34d399" : "#64748b", fontFamily: "ui-monospace,monospace", marginBottom: 8, minHeight: 14 }}>
        {working   ? `● 출근 ${fmtTime(last?.checked_in_at)}`
         : last    ? `퇴근 ${fmtTime(last?.checked_out_at)}`
         :           "—"}
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        {working ? (
          <button onClick={onCheckOut}
            style={{ flex: 1, padding: "5px", borderRadius: 4, background: "transparent", border: "1px solid #34d399", color: "#34d399", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>퇴근</button>
        ) : last ? (
          <button disabled
            style={{ flex: 1, padding: "5px", borderRadius: 4, background: "rgba(15,23,42,0.4)", border: "1px solid rgba(255,255,255,0.08)", color: "#64748b", fontSize: 11, fontWeight: 700, cursor: "not-allowed" }}>완료</button>
        ) : (
          <button onClick={onCheckIn}
            style={{ flex: 1, padding: "5px", borderRadius: 4, background: "#10b981", color: "#0f172a", border: "none", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>출근</button>
        )}
        {cctvUrl ? (
          <a href={cctvUrl} target="_blank" rel="noopener" title={`CCTV ch${cctvCh}`}
            style={{ padding: "5px 7px", borderRadius: 4, background: "linear-gradient(135deg,#0891b2,#059669)", color: "#fff", fontSize: 11, fontWeight: 700, textDecoration: "none", display: "inline-flex", alignItems: "center" }}>📹</a>
        ) : (
          <button onClick={onSetCctv} title="CCTV 채널 매핑"
            style={{ padding: "5px 7px", borderRadius: 4, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", color: "#94a3b8", fontSize: 11, cursor: "pointer" }}>📹</button>
        )}
        <button onClick={onShowLog} title="개인 행동 로그"
          style={{ padding: "5px 7px", borderRadius: 4, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", color: "#94a3b8", fontSize: 11, cursor: "pointer" }}>📋</button>
      </div>
    </div>
  );
}

function StaffLogModal({ staff, dept, sb, onClose, onAddFacAction }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!sb) return;
    (async () => {
      try {
        const { data, error } = await sb.from("attendance").select("*")
          .eq("staff_id", staff.id)
          .order("checked_in_at", { ascending: false })
          .limit(50);
        if (error) throw error;
        setRows(data || []);
      } catch (e) {
        setErr(e?.message || String(e));
      } finally { setLoading(false); }
    })();
  }, [sb, staff.id]);

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 560, maxHeight: "80vh", background: "#0f172a", color: "#f1f5f9", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid rgba(255,255,255,0.08)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800 }}>📋 {staff.name} 행동 로그</div>
            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
              {dept?.name || "-"} · {staff.beacon_id || "비콘 미배정"} · {staff.phone || "연락처 없음"}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.15)", color: "#94a3b8", borderRadius: 4, padding: "4px 10px", cursor: "pointer", fontSize: 12 }}>✕</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "10px 18px" }}>
          {loading ? <div style={{ padding: 30, textAlign: "center", color: "#64748b", fontSize: 12 }}>⏳ 로딩...</div>
           : err ? <div style={{ padding: 12, color: "#fca5a5", fontSize: 12 }}>⚠ {err}</div>
           : rows.length === 0 ? <div style={{ padding: 30, textAlign: "center", color: "#64748b", fontSize: 12 }}>출퇴근 기록 없음</div>
           : (
            <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ color: "#94a3b8", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
                  <th style={{ textAlign: "left", padding: "6px 4px", fontWeight: 600 }}>날짜</th>
                  <th style={{ textAlign: "left", padding: "6px 4px", fontWeight: 600 }}>출근</th>
                  <th style={{ textAlign: "left", padding: "6px 4px", fontWeight: 600 }}>퇴근</th>
                  <th style={{ textAlign: "right", padding: "6px 4px", fontWeight: 600 }}>근무</th>
                  <th style={{ textAlign: "center", padding: "6px 4px", fontWeight: 600 }}>출처</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const ci = new Date(r.checked_in_at);
                  const co = r.checked_out_at ? new Date(r.checked_out_at) : null;
                  const hrs = co ? ((co - ci) / 3600000).toFixed(1) : "—";
                  const d = `${ci.getFullYear()}.${pad(ci.getMonth()+1)}.${pad(ci.getDate())}`;
                  return (
                    <tr key={r.id} style={{ borderBottom: "1px dotted rgba(255,255,255,0.05)" }}>
                      <td style={{ padding: "6px 4px", fontFamily: "ui-monospace,monospace", color: "#cbd5e1" }}>{d}</td>
                      <td style={{ padding: "6px 4px", fontFamily: "ui-monospace,monospace", color: "#34d399" }}>{fmtTimeFull(r.checked_in_at)}</td>
                      <td style={{ padding: "6px 4px", fontFamily: "ui-monospace,monospace", color: co ? "#94a3b8" : "#fbbf24" }}>{co ? fmtTimeFull(r.checked_out_at) : "근무중"}</td>
                      <td style={{ padding: "6px 4px", fontFamily: "ui-monospace,monospace", textAlign: "right", color: "#cbd5e1" }}>{hrs}h</td>
                      <td style={{ padding: "6px 4px", textAlign: "center", color: "#64748b", fontSize: 10 }}>{r.source || "manual"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div style={{ padding: "10px 18px", borderTop: "1px solid rgba(255,255,255,0.08)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {onAddFacAction && (
            <button onClick={() => {
              onAddFacAction({
                title: `${staff.name} 행동 점검 요청`,
                category: "HR",
                priority: "MEDIUM",
                memo: `직원 ${staff.name}(${dept?.name||"-"}) 의 출퇴근 패턴 점검 요청`,
              });
              alert("✓ 보완과제로 등록됨 — 시설점검 모듈에서 확인");
            }}
              style={{ padding: "6px 12px", borderRadius: 4, background: "rgba(251,191,36,0.15)", border: "1px solid rgba(251,191,36,0.3)", color: "#fde68a", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
              + 보완과제 등록
            </button>
          )}
          <button onClick={onClose}
            style={{ padding: "6px 14px", borderRadius: 4, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#cbd5e1", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}

function DeptCctvEditModal({ dept, currentCh, onSave, onCancel }) {
  const [val, setVal] = useState(currentCh ?? "");
  if (!dept) return null;
  return (
    <div onClick={onCancel}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 360, background: "#0f172a", color: "#f1f5f9", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, padding: 18 }}>
        <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 4 }}>📹 CCTV 채널 매핑</div>
        <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 14 }}>{dept.name} → CCTV 채널 번호</div>
        <input type="number" min="1" max="64" value={val}
          onChange={(e) => setVal(e.target.value)}
          placeholder="예: 1, 2, 3..."
          style={{ width: "100%", padding: "10px 12px", background: "#0b1220", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, color: "#f1f5f9", fontSize: 13, fontFamily: "ui-monospace,monospace" }}
        />
        <div style={{ marginTop: 10, fontSize: 10, color: "#64748b", lineHeight: 1.5 }}>
          상단 바의 <strong style={{ color: "#cbd5e1" }}>📹 CCTV 관제</strong> 버튼에 설정한 URL의 <code style={{ color: "#34d399" }}>?channel=N</code> 으로 이동합니다.
          비워두면 매핑 해제.
        </div>
        <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end", gap: 6 }}>
          <button onClick={onCancel}
            style={{ padding: "6px 12px", borderRadius: 4, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#cbd5e1", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>취소</button>
          <button onClick={() => onSave(val)}
            style={{ padding: "6px 14px", borderRadius: 4, background: "#10b981", color: "#0f172a", border: "none", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>저장</button>
        </div>
      </div>
    </div>
  );
}
