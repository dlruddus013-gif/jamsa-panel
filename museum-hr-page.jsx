// museum-hr-page.jsx
// ============================================================================
// 잠사박물관 BLE 비콘 출근/HR 모듈 — Vercel 패널용 (shadcn 없이 plain Tailwind)
//
// public/hr.html 에서 hr-entry.jsx 가 이 컴포넌트를 마운트.
// Supabase 클라이언트는 window.__supabase 사용.
// 스키마: supabase/migrations/20260519_beacon_attendance.sql 적용 필요.
// ============================================================================
import React, { useEffect, useMemo, useState, useCallback } from "react";

export const JAMSA_BEACON_NAMESPACE = "00112233445566778899";

export const BEACON_DEPT_MAP = {
  0x01: { code: 0x01, name: "관리부",        color: "emerald", solid: "#10b981", bg: "#ecfdf5", text: "#047857", border: "#a7f3d0" },
  0x02: { code: 0x02, name: "시설부",        color: "blue",    solid: "#3b82f6", bg: "#eff6ff", text: "#1d4ed8", border: "#bfdbfe" },
  0x03: { code: 0x03, name: "외국인 노동자", color: "orange",  solid: "#f97316", bg: "#fff7ed", text: "#c2410c", border: "#fed7aa" },
};

function deptOf(code) {
  return BEACON_DEPT_MAP[code] || {
    code, name: `예비(0x${(code ?? 0).toString(16).padStart(2, "0").toUpperCase()})`,
    color: "slate", solid: "#64748b", bg: "#f8fafc", text: "#475569", border: "#cbd5e1",
  };
}

export function estimateDistance(rssi, txPowerAt1m) {
  if (rssi == null || !Number.isFinite(Number(rssi))) return null;
  const tx = Number.isFinite(Number(txPowerAt1m)) ? Number(txPowerAt1m) : -59;
  if (rssi === 0) return null;
  const ratio = Number(rssi) / tx;
  if (ratio < 1) return Math.round(Math.pow(ratio, 10) * 10) / 10;
  const d = 0.89976 * Math.pow(ratio, 7.7095) + 0.111;
  return Math.round(d * 10) / 10;
}

export function parseBeaconPayload(input) {
  let p;
  try { p = typeof input === "string" ? JSON.parse(input) : input; }
  catch (e) { return { ok: false, error: "JSON 파싱 실패: " + e.message }; }
  if (!p || typeof p !== "object") return { ok: false, error: "객체가 아닙니다" };

  const type = String(p.type || "").toLowerCase();
  if (type && type !== "uid" && type !== "ucid")
    return { ok: false, error: `type이 'uid'가 아닙니다 (받은 값: ${p.type})` };

  const ns = String(p.namespace || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (!ns) return { ok: false, error: "namespace가 비어있습니다" };
  if (ns !== JAMSA_BEACON_NAMESPACE)
    return { ok: false, error: `잠사 namespace가 아닙니다. expected=${JAMSA_BEACON_NAMESPACE}, got=${ns}` };

  const inst = String(p.instance || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (inst.length !== 12)
    return { ok: false, error: `instance는 12자리 hex여야 합니다 (받은 값: ${p.instance}, 길이 ${inst.length})` };

  const dept_code = parseInt(inst.slice(0, 2), 16);
  if (Number.isNaN(dept_code)) return { ok: false, error: "부서코드 파싱 실패" };
  const user_uid = inst.slice(2);
  const d = deptOf(dept_code);

  const rssi = p.rssi != null ? Number(p.rssi) : null;
  const rssi_at_xm = p.rssi_at_xm != null ? Number(p.rssi_at_xm) : null;

  return {
    ok: true,
    data: {
      type: "uid", namespace: ns, instance: inst,
      dept_code, dept_name: d.name, dept: d, user_uid,
      rssi: Number.isFinite(rssi) ? rssi : null,
      rssi_at_xm: Number.isFinite(rssi_at_xm) ? rssi_at_xm : null,
      mac: p.mac ? String(p.mac).toLowerCase() : null,
      tm: p.tm || null,
      estimated_distance_m: estimateDistance(rssi, rssi_at_xm),
    },
  };
}

function rssiLabel(rssi) {
  if (rssi == null) return { label: "측정안됨", solid: "#94a3b8" };
  if (rssi >= -40) return { label: "매우 가까움", solid: "#10b981" };
  if (rssi >= -55) return { label: "가까움",     solid: "#3b82f6" };
  if (rssi >= -70) return { label: "보통",       solid: "#f59e0b" };
  if (rssi >= -85) return { label: "약함",       solid: "#ef4444" };
  return { label: "이탈 가능성", solid: "#7f1d1d" };
}

function getSupabase() {
  if (typeof window !== "undefined" && window.__supabase) return window.__supabase;
  throw new Error("Supabase 클라이언트가 window.__supabase 에 없습니다.");
}

// ─── Plain UI primitives (shadcn 없이) ─────────────────────────────
function Card({ children, style, ...p }) {
  return <div {...p} style={{ background:"#fff", borderRadius:12, border:"1px solid #e5e7eb", boxShadow:"0 1px 2px rgba(0,0,0,.04)", ...style }}>{children}</div>;
}
function Badge({ children, color = "#475569", bg = "#f1f5f9" }) {
  return <span style={{ background:bg, color, fontSize:11, fontWeight:800, padding:"3px 8px", borderRadius:6, whiteSpace:"nowrap" }}>{children}</span>;
}
function SolidBadge({ children, color = "#475569" }) {
  return <span style={{ background:color, color:"#fff", fontSize:11, fontWeight:800, padding:"3px 8px", borderRadius:6, whiteSpace:"nowrap" }}>{children}</span>;
}
function Alert({ kind = "info", title, children }) {
  const c = kind === "error" ? { bg:"#fef2f2", bd:"#fecaca", tx:"#991b1b" }
        : kind === "warn"  ? { bg:"#fffbeb", bd:"#fde68a", tx:"#92400e" }
        :                    { bg:"#eff6ff", bd:"#bfdbfe", tx:"#1e40af" };
  return (
    <div style={{ background:c.bg, border:`1px solid ${c.bd}`, color:c.tx, padding:12, borderRadius:10 }}>
      {title && <div style={{ fontWeight:900, marginBottom:4 }}>{title}</div>}
      <div style={{ fontSize:13 }}>{children}</div>
    </div>
  );
}

// ─── 메인 ───────────────────────────────────────────────────────────
export default function MuseumHrPage() {
  const [tab, setTab] = useState("dashboard");
  const TABS = [
    { k: "dashboard", l: "📊 실시간 출근" },
    { k: "staff",     l: "👥 직원 관리" },
    { k: "register",  l: "📡 비콘 등록" },
    { k: "foreign",   l: "🌏 외국인 노동자" },
  ];
  return (
    <div style={{ maxWidth: 1280, margin:"0 auto", padding:20, fontFamily:"Pretendard, system-ui, sans-serif" }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:8, marginBottom:16 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:900, color:"#0f172a", margin:0 }}>🏛️ 잠사 인사·출근 (BLE 비콘)</h1>
          <div style={{ fontSize:12, color:"#64748b", marginTop:4 }}>Eddystone-UID 기반 자동 출근 · 부서별 실시간 모니터</div>
        </div>
        <Badge>NS {JAMSA_BEACON_NAMESPACE.slice(0,8)}…</Badge>
      </div>

      <div style={{ display:"flex", gap:4, background:"#f1f5f9", padding:4, borderRadius:10, marginBottom:16, flexWrap:"wrap" }}>
        {TABS.map(t => (
          <button key={t.k} onClick={()=>setTab(t.k)}
            style={{ flex:"1 1 160px", padding:"10px 14px", border:"none", borderRadius:8,
                     background: tab === t.k ? "#fff" : "transparent",
                     color: tab === t.k ? "#0f172a" : "#64748b",
                     fontSize:13, fontWeight:900, cursor:"pointer",
                     boxShadow: tab === t.k ? "0 1px 3px rgba(0,0,0,.08)" : "none" }}>
            {t.l}
          </button>
        ))}
      </div>

      <div style={{ display:"grid", gap:16 }}>
        {tab === "dashboard" && <AttendanceDashboard/>}
        {tab === "staff"     && <StaffList/>}
        {tab === "register"  && <BeaconRegister/>}
        {tab === "foreign"   && <ForeignWorkerTab/>}
      </div>
    </div>
  );
}

// ─── 1) 실시간 출근 ───────────────────────────────────────────────
function AttendanceDashboard() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const sb = getSupabase();
      const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { data, error } = await sb
        .from("attendance")
        .select(`id, checked_in_at, raw_rssi, estimated_distance_m, beacon_mac, dept_code,
                 staff:staff_id ( id, name, dept_code, beacon_instance, contract_type )`)
        .gte("checked_in_at", since)
        .order("checked_in_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      setRows(data || []);
      setError(null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const grouped = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      const dc = r.staff?.dept_code ?? r.dept_code ?? 0;
      if (!m.has(dc)) m.set(dc, []);
      m.get(dc).push(r);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [rows]);

  if (error) return <Alert kind="error" title="❌ 출근 데이터 로드 실패">{error}</Alert>;

  return (
    <div style={{ display:"grid", gap:16 }}>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(180px, 1fr))", gap:12 }}>
        {Object.values(BEACON_DEPT_MAP).map((d) => {
          const list = rows.filter(r => (r.staff?.dept_code ?? r.dept_code) === d.code);
          const unique = new Set(list.map(r => r.staff?.id).filter(Boolean)).size;
          return (
            <Card key={d.code} style={{ background:d.bg, border:`2px solid ${d.border}` }}>
              <div style={{ padding:14 }}>
                <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4 }}>
                  <span style={{ width:8, height:8, borderRadius:"50%", background:d.solid, display:"inline-block" }}/>
                  <span style={{ color:d.text, fontWeight:900, fontSize:14 }}>{d.name}</span>
                </div>
                <div style={{ fontSize:28, fontWeight:900, color:"#0f172a" }}>{unique}<span style={{ fontSize:13, fontWeight:700, color:"#64748b", marginLeft:4 }}>명</span></div>
                <div style={{ fontSize:11, color:"#64748b" }}>5분 내 감지 · 이벤트 {list.length}건</div>
              </div>
            </Card>
          );
        })}
      </div>

      <Card>
        <div style={{ padding:14, borderBottom:"1px solid #f1f5f9" }}>
          <div style={{ fontWeight:900, fontSize:14, color:"#0f172a" }}>실시간 출근 로그 (최근 5분)</div>
          <div style={{ fontSize:11, color:"#64748b", marginTop:2 }}>5초마다 자동 갱신 · 총 {rows.length}건</div>
        </div>
        <div style={{ padding:14 }}>
          {loading && rows.length === 0 ? (
            <div style={{ textAlign:"center", padding:30, color:"#94a3b8" }}>불러오는 중...</div>
          ) : rows.length === 0 ? (
            <div style={{ textAlign:"center", padding:30, color:"#94a3b8" }}>최근 감지된 직원이 없습니다.</div>
          ) : (
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                <thead style={{ background:"#f8fafc", color:"#475569" }}>
                  <tr>
                    {["시각","이름","부서","RSSI","거리","상태","비콘 MAC"].map(h =>
                      <th key={h} style={{ padding:"9px 10px", textAlign:"left", borderBottom:"1px solid #e5e7eb", fontWeight:800 }}>{h}</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {grouped.flatMap(([dc, list]) => {
                    const d = deptOf(dc);
                    return list.map((r, i) => {
                      const rl = rssiLabel(r.raw_rssi);
                      return (
                        <tr key={r.id} style={{ background: i === 0 ? d.bg : "transparent" }}>
                          <td style={{ padding:"8px 10px", borderBottom:"1px solid #f1f5f9", fontFamily:"monospace" }}>{new Date(r.checked_in_at).toLocaleTimeString("ko-KR")}</td>
                          <td style={{ padding:"8px 10px", borderBottom:"1px solid #f1f5f9", fontWeight:800 }}>{r.staff?.name || "(미등록)"}</td>
                          <td style={{ padding:"8px 10px", borderBottom:"1px solid #f1f5f9" }}><SolidBadge color={d.solid}>{d.name}</SolidBadge></td>
                          <td style={{ padding:"8px 10px", borderBottom:"1px solid #f1f5f9", fontFamily:"monospace" }}>{r.raw_rssi ?? "—"} dBm</td>
                          <td style={{ padding:"8px 10px", borderBottom:"1px solid #f1f5f9" }}>{r.estimated_distance_m != null ? `${r.estimated_distance_m}m` : "—"}</td>
                          <td style={{ padding:"8px 10px", borderBottom:"1px solid #f1f5f9" }}><SolidBadge color={rl.solid}>{rl.label}</SolidBadge></td>
                          <td style={{ padding:"8px 10px", borderBottom:"1px solid #f1f5f9", fontFamily:"monospace", color:"#64748b" }}>{r.beacon_mac || "—"}</td>
                        </tr>
                      );
                    });
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

// ─── 2) 직원 목록 ────────────────────────────────────────────────
function StaffList() {
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("all");

  const load = useCallback(async () => {
    try {
      const sb = getSupabase();
      const { data, error } = await sb.from("staff").select("*").order("dept_code", { ascending: true });
      if (error) throw error;
      setStaff(data || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = staff.filter(s => filter === "all" || String(s.dept_code) === filter);

  if (error) return <Alert kind="error" title="❌ 직원 데이터 로드 실패">{error}</Alert>;

  return (
    <Card>
      <div style={{ padding:14, borderBottom:"1px solid #f1f5f9", display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:8 }}>
        <div style={{ fontWeight:900, fontSize:14, color:"#0f172a" }}>전체 직원 ({filtered.length}명)</div>
        <div style={{ display:"flex", gap:4 }}>
          {[["all","전체"],["1","관리부"],["2","시설부"],["3","외국인"]].map(([k,l]) => (
            <button key={k} onClick={()=>setFilter(k)}
              style={{ padding:"6px 10px", border:"1px solid #cbd5e1", borderRadius:7, fontSize:11, fontWeight:800,
                       background: filter === k ? "#0f172a" : "#fff",
                       color:      filter === k ? "#fff"    : "#475569", cursor:"pointer" }}>{l}</button>
          ))}
        </div>
      </div>
      <div style={{ padding:14 }}>
        {loading ? <div style={{ textAlign:"center", padding:30, color:"#94a3b8" }}>로딩...</div> : (
          <div style={{ overflowX:"auto" }}>
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
              <thead style={{ background:"#f8fafc", color:"#475569" }}>
                <tr>{["이름","부서","계약유형","비콘 instance","비자(외국인)","연락처"].map(h =>
                  <th key={h} style={{ padding:"9px 10px", textAlign:"left", borderBottom:"1px solid #e5e7eb", fontWeight:800 }}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {filtered.map(s => {
                  const d = deptOf(s.dept_code);
                  return (
                    <tr key={s.id}>
                      <td style={{ padding:"8px 10px", borderBottom:"1px solid #f1f5f9", fontWeight:800 }}>{s.name}</td>
                      <td style={{ padding:"8px 10px", borderBottom:"1px solid #f1f5f9" }}>{s.dept_code ? <SolidBadge color={d.solid}>{d.name}</SolidBadge> : <span style={{ color:"#94a3b8" }}>미배정</span>}</td>
                      <td style={{ padding:"8px 10px", borderBottom:"1px solid #f1f5f9" }}>{s.contract_type || "—"}</td>
                      <td style={{ padding:"8px 10px", borderBottom:"1px solid #f1f5f9", fontFamily:"monospace", fontSize:11 }}>
                        {s.beacon_instance || <span style={{ color:"#e11d48" }}>미등록</span>}
                      </td>
                      <td style={{ padding:"8px 10px", borderBottom:"1px solid #f1f5f9" }}>{s.visa_type ? `${s.visa_type} · ${s.visa_expires_at || ""}` : "—"}</td>
                      <td style={{ padding:"8px 10px", borderBottom:"1px solid #f1f5f9" }}>{s.phone || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

// ─── 3) 비콘 등록 ────────────────────────────────────────────────
function BeaconRegister() {
  const [staff, setStaff] = useState([]);
  const [staffId, setStaffId] = useState("");
  const [raw, setRaw] = useState("");
  const [parsed, setParsed] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  const reloadStaff = useCallback(async () => {
    try {
      const sb = getSupabase();
      const { data } = await sb.from("staff").select("id,name,dept_code,beacon_instance").order("name");
      setStaff(data || []);
    } catch (_) {}
  }, []);

  useEffect(() => { reloadStaff(); }, [reloadStaff]);

  useEffect(() => {
    if (!raw.trim()) { setParsed(null); setError(null); return; }
    const r = parseBeaconPayload(raw);
    if (r.ok) { setParsed(r.data); setError(null); }
    else      { setParsed(null); setError(r.error); }
  }, [raw]);

  const save = async () => {
    if (!staffId) { setError("직원을 먼저 선택하세요"); return; }
    if (!parsed)  { setError("페이로드를 먼저 입력하세요"); return; }
    setSaving(true); setMsg(null); setError(null);
    try {
      const sb = getSupabase();
      const { error } = await sb.from("staff").update({
        beacon_namespace: parsed.namespace,
        beacon_instance:  parsed.instance,
        beacon_mac:       parsed.mac,
        dept_code:        parsed.dept_code,
      }).eq("id", staffId);
      if (error) throw error;
      const who = staff.find(s => String(s.id) === String(staffId))?.name;
      setMsg(`✓ ${who}님에게 비콘 등록 완료 (${parsed.dept_name})`);
      setRaw(""); setParsed(null);
      reloadStaff();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  const placeholder = `{
  "type": "uid",
  "namespace": "${JAMSA_BEACON_NAMESPACE}",
  "instance": "01000000000A",
  "rssi": -29,
  "rssi_at_xm": -24,
  "mac": "c300002a772a",
  "tm": "${new Date().toISOString()}"
}`;

  return (
    <Card>
      <div style={{ padding:14, borderBottom:"1px solid #f1f5f9" }}>
        <div style={{ fontWeight:900, fontSize:14, color:"#0f172a" }}>📡 비콘 등록 / 재등록</div>
        <div style={{ fontSize:11, color:"#64748b", marginTop:2 }}>
          직원 선택 → 비콘 페이로드(JSON) 붙여넣기 → 자동 파싱 → 등록
        </div>
      </div>
      <div style={{ padding:14, display:"grid", gap:14 }}>
        <div style={{ display:"grid", gap:14, gridTemplateColumns:"repeat(auto-fit, minmax(280px, 1fr))" }}>
          <div>
            <label style={{ fontSize:12, fontWeight:800, color:"#475569", display:"block", marginBottom:6 }}>1) 직원 선택</label>
            <select value={staffId} onChange={e=>setStaffId(e.target.value)}
              style={{ width:"100%", padding:"10px 12px", border:"1px solid #cbd5e1", borderRadius:8, fontSize:13, background:"#fff" }}>
              <option value="">— 선택 —</option>
              {staff.map(s => (
                <option key={s.id} value={String(s.id)}>
                  {s.name} {deptOf(s.dept_code).name} {s.beacon_instance ? `· 비콘:${s.beacon_instance.slice(-6)}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ fontSize:12, fontWeight:800, color:"#475569", display:"block", marginBottom:6 }}>2) 비콘 페이로드 (Eddystone-UID JSON)</label>
            <textarea rows={8} value={raw} onChange={e=>setRaw(e.target.value)} placeholder={placeholder}
              style={{ width:"100%", padding:10, border:"1px solid #cbd5e1", borderRadius:8, fontSize:11, fontFamily:"monospace", resize:"vertical" }}/>
          </div>
        </div>

        {error && <Alert kind="error" title="❌ 파싱/저장 오류">{error}</Alert>}

        {parsed && (
          <div style={{ background:parsed.dept.bg, border:`2px solid ${parsed.dept.border}`, borderRadius:10, padding:14 }}>
            <div style={{ color:parsed.dept.text, fontWeight:900, fontSize:14, marginBottom:8 }}>✓ 파싱 성공</div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(140px, 1fr))", gap:10, fontSize:12 }}>
              <div><div style={{ color:"#64748b", fontSize:10 }}>부서</div><SolidBadge color={parsed.dept.solid}>{parsed.dept_name} (0x{parsed.dept_code.toString(16).padStart(2,"0").toUpperCase()})</SolidBadge></div>
              <div><div style={{ color:"#64748b", fontSize:10 }}>개인 UID</div><div style={{ fontFamily:"monospace", fontSize:11 }}>{parsed.user_uid}</div></div>
              <div><div style={{ color:"#64748b", fontSize:10 }}>비콘 MAC</div><div style={{ fontFamily:"monospace", fontSize:11 }}>{parsed.mac || "—"}</div></div>
              <div><div style={{ color:"#64748b", fontSize:10 }}>RSSI</div><div>{parsed.rssi ?? "—"} dBm</div></div>
              <div><div style={{ color:"#64748b", fontSize:10 }}>RSSI@1m</div><div>{parsed.rssi_at_xm ?? "—"} dBm</div></div>
              <div><div style={{ color:"#64748b", fontSize:10 }}>추정 거리</div><div>{parsed.estimated_distance_m != null ? `${parsed.estimated_distance_m}m` : "—"}</div></div>
            </div>
          </div>
        )}

        {msg && <Alert title={msg}/>}

        <button onClick={save} disabled={saving || !staffId || !parsed}
          style={{ width:"100%", padding:"12px 16px", borderRadius:10, border:"none",
                   background: (!saving && staffId && parsed) ? "#0f172a" : "#cbd5e1",
                   color:"#fff", fontWeight:900, fontSize:14, cursor:(!saving && staffId && parsed) ? "pointer" : "not-allowed" }}>
          {saving ? "저장 중..." : "💾 비콘 등록"}
        </button>
      </div>
    </Card>
  );
}

// ─── 4) 외국인 노동자 ────────────────────────────────────────────
function ForeignWorkerTab() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const sb = getSupabase();
        const { data, error } = await sb.from("staff")
          .select("id, name, dept_code, contract_type, beacon_instance, visa_type, visa_expires_at, insurance_status, country, phone, hire_date")
          .eq("dept_code", 0x03)
          .order("visa_expires_at", { ascending: true });
        if (error) throw error;
        setList(data || []);
      } catch (e) { setError(e.message); }
      finally { setLoading(false); }
    })();
  }, []);

  const today = new Date();
  const expiryStatus = (iso) => {
    if (!iso) return { solid: "#94a3b8", label: "미입력" };
    const d = new Date(iso);
    const days = Math.ceil((d - today) / 864e5);
    if (days < 0)   return { solid: "#7f1d1d", label: `만료 (${Math.abs(days)}일 초과)` };
    if (days <= 30) return { solid: "#ef4444", label: `D-${days}` };
    if (days <= 90) return { solid: "#f59e0b", label: `${days}일 남음` };
    return            { solid: "#10b981", label: `${days}일 남음` };
  };

  if (error) return <Alert kind="error" title="로드 실패">{error}</Alert>;

  return (
    <div style={{ display:"grid", gap:14 }}>
      <Alert kind="warn" title="🌏 외국인 노동자 관리 (RLS: 관리부만 조회)">
        E-9(비전문취업) / H-2(방문취업) 비자 만료 + 4대보험 가입 상태 통합 관리. 비콘 부서 코드 = 0x03.
      </Alert>

      <Card>
        <div style={{ padding:14, borderBottom:"1px solid #f1f5f9" }}>
          <div style={{ fontWeight:900, fontSize:14, color:"#0f172a" }}>외국인 노동자 ({list.length}명)</div>
        </div>
        <div style={{ padding:14 }}>
          {loading ? <div style={{ textAlign:"center", padding:30, color:"#94a3b8" }}>로딩...</div>
          : list.length === 0 ? <div style={{ textAlign:"center", padding:30, color:"#94a3b8" }}>등록된 외국인 노동자가 없습니다.</div>
          : (
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                <thead style={{ background:"#f8fafc", color:"#475569" }}>
                  <tr>{["이름","국적","비자","만료일","4대보험","계약","비콘"].map(h =>
                    <th key={h} style={{ padding:"9px 10px", textAlign:"left", borderBottom:"1px solid #e5e7eb", fontWeight:800 }}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {list.map(s => {
                    const e = expiryStatus(s.visa_expires_at);
                    return (
                      <tr key={s.id}>
                        <td style={{ padding:"8px 10px", borderBottom:"1px solid #f1f5f9", fontWeight:800 }}>{s.name}</td>
                        <td style={{ padding:"8px 10px", borderBottom:"1px solid #f1f5f9" }}>{s.country || "—"}</td>
                        <td style={{ padding:"8px 10px", borderBottom:"1px solid #f1f5f9" }}><Badge>{s.visa_type || "—"}</Badge></td>
                        <td style={{ padding:"8px 10px", borderBottom:"1px solid #f1f5f9" }}>
                          <div style={{ fontSize:11, color:"#475569" }}>{s.visa_expires_at || "—"}</div>
                          <SolidBadge color={e.solid}>{e.label}</SolidBadge>
                        </td>
                        <td style={{ padding:"8px 10px", borderBottom:"1px solid #f1f5f9" }}>
                          {s.insurance_status === "active"
                            ? <SolidBadge color="#10b981">가입</SolidBadge>
                            : <Badge color="#92400e" bg="#fef3c7">미가입</Badge>}
                        </td>
                        <td style={{ padding:"8px 10px", borderBottom:"1px solid #f1f5f9" }}>{s.contract_type || "—"}</td>
                        <td style={{ padding:"8px 10px", borderBottom:"1px solid #f1f5f9", fontFamily:"monospace", fontSize:11 }}>
                          {s.beacon_instance ? s.beacon_instance.slice(-6) : <span style={{ color:"#e11d48" }}>미등록</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
