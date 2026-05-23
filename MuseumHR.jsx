// (was "use client" — Next.js directive removed; this bundle is plain React via esbuild)

import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

/* ============================================================
   한국잠사플레이팜 농업회사법인(주) — 직원관리 통합 시스템
   MuseumHR.jsx — jamsa-panel 통합 버전 (다크 테마 + Supabase)
   ─────────────────────────────────────────────────────────────
   1) 대시보드   2) 직원관리   3) 출퇴근(BLE)   4) 위치추적
   5) CCTV      6) 급여       7) 근무스케줄    8) 업무체크리스트
   9) 업무일지  10) 근로계약서 (4유형 + 서명 + 노동청 export)
   ============================================================ */

/* ─── 상수 데이터 ─── */
const ROLES = ["관장","학예사","안내해설사","매표원","교육강사","시설관리","행정직원"];
const DEPARTMENTS = ["전시운영팀","교육체험팀","행정지원팀","시설관리팀"];
const WAGE_TYPES = ["월급","시급","일급"];

const initialEmployees = [
  { id:1, name:"김민수", role:"학예사",     dept:"전시운영팀", phone:"010-1234-5678", wageType:"월급", wage:3200000, startDate:"2023-03-01", status:"active", probation:false, beacon:"AC:23:3F:A1:01", empType:"정규직" },
  { id:2, name:"이서연", role:"안내해설사", dept:"전시운영팀", phone:"010-2345-6789", wageType:"시급", wage:12000,   startDate:"2024-06-15", status:"active", probation:false, beacon:"AC:23:3F:A1:02", empType:"정규직" },
  { id:3, name:"박지훈", role:"교육강사",   dept:"교육체험팀", phone:"010-3456-7890", wageType:"시급", wage:15000,   startDate:"2024-01-10", status:"active", probation:false, beacon:"AC:23:3F:A1:03", empType:"정규직" },
  { id:4, name:"최유진", role:"매표원",     dept:"전시운영팀", phone:"010-4567-8901", wageType:"시급", wage:10500,   startDate:"2025-01-02", status:"active", probation:true,  beacon:"AC:23:3F:A1:04", empType:"초단시간" },
  { id:5, name:"정하은", role:"행정직원",   dept:"행정지원팀", phone:"010-5678-9012", wageType:"월급", wage:2800000, startDate:"2023-09-01", status:"active", probation:false, beacon:"AC:23:3F:A1:05", empType:"정규직" },
  { id:6, name:"강도윤", role:"시설관리",   dept:"시설관리팀", phone:"010-6789-0123", wageType:"월급", wage:2900000, startDate:"2022-05-10", status:"active", probation:false, beacon:"AC:23:3F:A1:06", empType:"정규직" },
  { id:7, name:"윤서아", role:"안내해설사", dept:"전시운영팀", phone:"010-7890-1234", wageType:"시급", wage:11000,   startDate:"2024-11-20", status:"leave",  probation:false, beacon:"AC:23:3F:A1:07", empType:"단시간" },
];

/* 박물관 구역 */
const ZONES = [
  { id:"lobby",      name:"로비/매표소",   x:12, y:72, w:22, h:20, color:"#f59e0b" },
  { id:"perm1",      name:"상설전시 1관", x:38, y:10, w:26, h:35, color:"#6366f1" },
  { id:"perm2",      name:"상설전시 2관", x:38, y:50, w:26, h:35, color:"#8b5cf6" },
  { id:"silkworm",   name:"누에쉘터",     x:68, y:10, w:24, h:30, color:"#22c55e" },
  { id:"sheep",      name:"양떼정원",     x:68, y:45, w:24, h:25, color:"#eab308" },
  { id:"sled",       name:"썰매장",       x:68, y:74, w:24, h:18, color:"#06b6d4" },
  { id:"office",     name:"사무실",       x:5,  y:30, w:14, h:25, color:"#64748b" },
  { id:"storage",    name:"수장고",       x:5,  y:60, w:14, h:12, color:"#ef4444" },
];

const CONTRACT_TYPES = [
  { id:"regular",   label:"정규직 (월급제)",     desc:"주 40시간 · 4대보험 · 연차" },
  { id:"partShort", label:"초단시간 (주 15h 미만)", desc:"산재만 · 주휴/연차 미적용" },
  { id:"part",      label:"단시간 (주 15h 이상)",   desc:"주휴수당 · 비례 연차" },
  { id:"onCall",    label:"호출형/간헐근로",      desc:"월 최소보장 · 시급제" },
];

const TABS = [
  { id:"dashboard", icon:"📊", label:"대시보드" },
  { id:"employees", icon:"👥", label:"직원관리" },
  { id:"attendance",icon:"🕐", label:"출퇴근" },
  { id:"location",  icon:"📍", label:"위치추적" },
  { id:"cctv",      icon:"📹", label:"CCTV" },
  { id:"payroll",   icon:"💰", label:"급여" },
  { id:"schedule",  icon:"📅", label:"근무스케줄" },
  { id:"checklist", icon:"✅", label:"업무체크리스트" },
  { id:"worklog",   icon:"📝", label:"업무일지" },
  { id:"contract",  icon:"📜", label:"근로계약서" },
];

/* ─── 디자인 토큰 (jamsa-panel 다크 테마 + 실크 골드 액센트) ─── */
const T = {
  cream:"#0f172a", paper:"#1e293b", line:"#334155", ink:"#f1f5f9",
  silk:"#c9a96e", silkD:"#a8864a", silkL:"#e8d5a3",
  leaf:"#86efac", mulberry:"#c4b5fd", gold:"#fbbf24",
  ok:"#22c55e", warn:"#f59e0b", err:"#ef4444", info:"#60a5fa", muted:"#94a3b8",
};

const fontFamily = `"Noto Serif KR","Nanum Myeongjo",ui-serif,Georgia,serif`;
const sansFamily = `"Pretendard","Noto Sans KR",-apple-system,system-ui,sans-serif`;

/* ─── 유틸 ─── */
const fmt = n => (n||0).toLocaleString("ko-KR");
const fmtKRW = n => "₩" + fmt(n);
const todayISO = () => new Date().toISOString().slice(0,10);
const pad = n => String(n).padStart(2,"0");

/* ─── Supabase 클라이언트 ───
   jamsa-panel은 entry.jsx의 /api/config 응답으로 supabase를 이미 만들어 둠.
   1순위: window.__supabase (이미 인증·세션 셋업된 인스턴스 재사용 — 가장 좋음)
   2순위: window.__SUPABASE_URL/KEY 가 있으면 직접 createClient
   둘 다 없으면 null → 시드 데이터(로컬 모드)로 동작
   ⚠️ 모듈 import 시점엔 entry.jsx의 boot()가 아직 안 끝났을 수 있어 window.__supabase가 비어있음.
   → 컴포넌트 첫 render에서 _ensureSupabase() 호출해서 채워넣는다. */
let supabase = null;
const _ensureSupabase = () => {
  if (supabase) return supabase;
  if (typeof window === "undefined") return null;
  if (window.__supabase) { supabase = window.__supabase; return supabase; }
  const url = window.__SUPABASE_URL || "";
  const key = window.__SUPABASE_KEY || "";
  if (url && key) {
    try { supabase = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } }); } catch (e) {}
  }
  return supabase;
};

/* DB row → 화면용 emp 객체 어댑터 */
const adaptRow = (r) => ({
  id: r.id, name: r.name, role: r.position || r.role || "직원",
  dept: r.department || r.dept || "운영팀",
  phone: r.phone || "-", email: r.email,
  wageType: r.monthly_salary ? "월급" : "시급",
  wage: r.monthly_salary || r.hourly_wage || r.wage || 0,
  startDate: r.hire_date || r.startDate || todayISO(),
  status: r.status || "active",
  probation: r.is_probation || r.probation || false,
  beacon: r.ble_mac || r.beacon || null,
  empType: r.employment_type || r.empType || "정규직",
});

/* 직원 데이터 훅 — Supabase 우선, 실패 시 로컬 시드 */
function useEmployees() {
  const [employees, setEmployees] = useState(initialEmployees);
  const [loading, setLoading] = useState(!!supabase);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!supabase) { setLoading(false); return; }
    let mounted = true;

    (async () => {
      // hr_employees 우선, 없으면 staff 시도
      let { data, error: e } = await supabase.from("hr_employees").select("*").order("id");
      if (e?.code === "42P01" || (!data && e)) {
        const r2 = await supabase.from("staff").select("*").order("id");
        data = r2.data; e = r2.error;
      }
      if (!mounted) return;
      if (e) { setError(e.message); setLoading(false); return; }
      if (data && data.length) setEmployees(data.map(adaptRow));
      setLoading(false);
    })();

    // 실시간 구독
    const channel = supabase.channel("hr_employees_realtime")
      .on("postgres_changes", { event:"*", schema:"public", table:"hr_employees" }, async () => {
        const { data } = await supabase.from("hr_employees").select("*").order("id");
        if (data && mounted) setEmployees(data.map(adaptRow));
      })
      .subscribe();

    return () => { mounted = false; supabase.removeChannel(channel); };
  }, []);

  const updateEmployee = useCallback(async (id, patch) => {
    setEmployees(prev => prev.map(e => e.id===id ? {...e, ...patch} : e));
    if (supabase) await supabase.from("hr_employees").update(patch).eq("id", id);
  }, []);

  return { employees, setEmployees, loading, error, updateEmployee };
}

/* 인증 훅 — jamsa-panel Supabase Auth 세션 재사용 */
function useAuth() {
  const [session, setSession] = useState(null);
  const [role, setRole] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!supabase) {
      // 개발 모드 — admin으로 가정
      setSession({ user: { email: "dev@local", user_metadata: { role: "admin" } } });
      setRole("admin"); setLoading(false); return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      const r = data.session?.user?.user_metadata?.role ||
                data.session?.user?.app_metadata?.role || "emp";
      setRole(r); setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      const r = s?.user?.user_metadata?.role || s?.user?.app_metadata?.role || "emp";
      setRole(r);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return { session, role, loading };
}

/* ─── 공통 컴포넌트 ─── */
const Card = ({children, style={}, hover=false, ...p}) => (
  <div {...p} style={{
    background:T.paper, border:`1px solid ${T.line}`, borderRadius:14,
    padding:18, boxShadow:"0 1px 2px rgba(58,46,31,0.04)",
    transition:"all .2s", ...style
  }}>{children}</div>
);

const Btn = ({children, kind="primary", onClick, disabled, style={}, size="md"}) => {
  const styles = {
    primary:  { bg:T.silk,    fg:"#fff",   bd:T.silk },
    secondary:{ bg:T.cream,   fg:T.ink,    bd:T.line },
    danger:   { bg:T.err,     fg:"#fff",   bd:T.err },
    ghost:    { bg:"transparent", fg:T.ink, bd:"transparent" },
    success:  { bg:T.ok,      fg:"#fff",   bd:T.ok },
  };
  const s = styles[kind];
  const sz = size==="sm"?{p:"6px 12px",f:12}:size==="lg"?{p:"12px 22px",f:14}:{p:"9px 16px",f:13};
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding:sz.p, fontSize:sz.f, fontWeight:600, borderRadius:8,
      background:s.bg, color:s.fg, border:`1px solid ${s.bd}`,
      cursor:disabled?"not-allowed":"pointer", opacity:disabled?0.4:1,
      fontFamily:sansFamily, transition:"all .15s", ...style
    }}>{children}</button>
  );
};

const Badge = ({children, color=T.silk, bg}) => (
  <span style={{
    display:"inline-block", padding:"3px 9px", fontSize:11, fontWeight:600,
    borderRadius:99, background:bg||(color+"20"), color, border:`1px solid ${color}40`
  }}>{children}</span>
);

const Stat = ({label, value, sub, color=T.ink, icon}) => (
  <Card style={{display:"flex", flexDirection:"column", gap:6}}>
    <div style={{display:"flex", justifyContent:"space-between", alignItems:"center"}}>
      <span style={{fontSize:12, color:T.muted, fontWeight:500}}>{label}</span>
      {icon && <span style={{fontSize:18}}>{icon}</span>}
    </div>
    <div style={{fontSize:26, fontWeight:700, color, fontFamily:fontFamily}}>{value}</div>
    {sub && <div style={{fontSize:11, color:T.muted}}>{sub}</div>}
  </Card>
);

/* ============================================================
   메인 컴포넌트 — jamsa-panel 통합 버전
   ============================================================ */
export default function MuseumHR({ onClose, userCtx = null } = {}) {
  // entry.jsx의 boot()가 window.__supabase 를 셋업한 뒤에 첫 render가 일어남.
  // 모듈 import 시점엔 비어있던 supabase let을 여기서 채워준다.
  _ensureSupabase();
  const [tab, setTab] = useState("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const { employees, updateEmployee, loading, error } = useEmployees();
  const { session: sbSession, role: sbRole, loading: authLoading } = useAuth();
  const [selectedEmpId, setSelectedEmpId] = useState(null);

  // 🌉 패널의 로컬 currentUser 와 Supabase Auth 세션을 통합한 단일 인증 상태.
  //   - Supabase 세션이 있으면 그걸 1순위 (RLS-protected 쿼리 가능)
  //   - 없으면 패널 currentUser 를 가짜 세션으로 승격 (시드 데이터 fallback)
  //   - 둘 다 없으면 진짜로 비로그인 → 로그인 안내
  const session = sbSession || (userCtx ? {
    user: {
      email: userCtx.email || `${userCtx.login || "user"}@local`,
      user_metadata: { role: userCtx.role === "ADMIN" || userCtx.role === "admin" ? "admin" : (userCtx.role || "staff").toLowerCase() },
    },
    _isPanelLocalSession: true, // 표식 — 실제 Supabase 세션 아님
  } : null);
  const userRole = sbRole || (userCtx?.role === "ADMIN" || userCtx?.role === "admin" ? "admin" : null);

  const today = new Date();
  const todayStr = `${today.getFullYear()}년 ${today.getMonth()+1}월 ${today.getDate()}일 ${["일","월","화","수","목","금","토"][today.getDay()]}요일`;

  if (authLoading || loading) {
    return (
      <div style={{padding:60, textAlign:"center", color:T.muted, fontFamily:sansFamily, background:T.cream, minHeight:"100vh"}}>
        <div style={{fontSize:32, marginBottom:10}}>👥</div>
        <div>직원관리 시스템 로딩 중...</div>
        {error && <div style={{color:T.err, marginTop:14, fontSize:12}}>{error} — 로컬 데이터로 폴백</div>}
      </div>
    );
  }

  // 진짜로 어떤 세션도 없을 때만 로그인 안내 (패널 currentUser 도 없는 경우)
  if (!session) {
    return (
      <div style={{padding:60, textAlign:"center", color:T.ink, fontFamily:sansFamily, background:T.cream, minHeight:"100vh"}}>
        <div style={{fontSize:48, marginBottom:14}}>🔐</div>
        <h2 style={{fontFamily:fontFamily}}>로그인이 필요합니다</h2>
        <p style={{color:T.muted, marginBottom:20}}>잠사박물관 관리 시스템에 먼저 로그인해주세요.</p>
        <a href="/#home" style={{
          padding:"10px 22px", background:T.silk, color:"#fff", textDecoration:"none",
          borderRadius:8, fontWeight:600, fontSize:14, display:"inline-block"
        }}>홈으로 가기</a>
      </div>
    );
  }

  const moduleComponents = {
    dashboard:  <DashboardModule employees={employees}/>,
    employees:  <EmployeesModule employees={employees} updateEmployee={updateEmployee} selectedId={selectedEmpId} setSelectedId={setSelectedEmpId}/>,
    attendance: <AttendanceModule employees={employees}/>,
    location:   <LocationModule employees={employees}/>,
    cctv:       <CCTVModule/>,
    payroll:    <PayrollModule employees={employees}/>,
    schedule:   <ScheduleModule employees={employees}/>,
    checklist:  <ChecklistModule employees={employees}/>,
    worklog:    <WorklogModule employees={employees}/>,
    contract:   <ContractModule employees={employees} session={session} userRole={userRole}/>,
  };

  return (
    <div style={{
      display:"flex", height:"100vh", background:T.cream, color:T.ink,
      fontFamily:sansFamily, fontSize:13, overflow:"hidden"
    }}>
      {/* ── 사이드바 ── */}
      <aside style={{
        width: sidebarOpen?220:64,
        background:"linear-gradient(180deg, #020617 0%, #0f172a 100%)",
        color:"#fff", display:"flex", flexDirection:"column",
        transition:"width .2s", borderRight:`1px solid ${T.line}`
      }}>
        <div style={{padding:"22px 18px", borderBottom:`1px solid ${T.line}`}}>
          <div style={{fontSize:20, fontFamily:fontFamily}}>🪲</div>
          {sidebarOpen && (
            <>
              <div style={{fontSize:14, fontWeight:700, marginTop:6, color:T.silkL}}>한국잠사플레이팜</div>
              <div style={{fontSize:10, color:"rgba(232,213,163,0.6)", marginTop:2}}>직원관리 #hr</div>
            </>
          )}
        </div>
        <nav style={{flex:1, padding:"10px 8px", overflow:"auto"}}>
          {TABS.map(t => {
            const active = tab===t.id;
            return (
              <button key={t.id} onClick={()=>{setTab(t.id); setSelectedEmpId(null);}} style={{
                width:"100%", display:"flex", alignItems:"center", gap:12,
                padding:"11px 14px", margin:"2px 0", border:"none", cursor:"pointer",
                borderRadius:8, fontSize:13, fontWeight:active?600:400,
                background:active?"rgba(201,169,110,0.18)":"transparent",
                color:active?T.silkL:"rgba(255,255,255,0.6)",
                justifyContent:sidebarOpen?"flex-start":"center",
                fontFamily:sansFamily, transition:"all .15s",
                borderLeft:active?`3px solid ${T.silk}`:"3px solid transparent",
              }}>
                <span style={{fontSize:16}}>{t.icon}</span>
                {sidebarOpen && <span>{t.label}</span>}
              </button>
            );
          })}
        </nav>
        {onClose && sidebarOpen && (
          <button onClick={onClose} style={{
            margin:"0 12px 8px", padding:"10px", border:`1px solid ${T.line}`,
            borderRadius:8, background:"transparent", color:T.silkL,
            cursor:"pointer", fontSize:12, fontFamily:sansFamily,
          }}>← 메인으로</button>
        )}
        <button onClick={()=>setSidebarOpen(s=>!s)} style={{
          margin:12, padding:"8px", border:`1px solid ${T.line}`,
          borderRadius:6, background:"transparent", color:"rgba(255,255,255,0.5)",
          cursor:"pointer", fontSize:11, fontFamily:sansFamily,
        }}>{sidebarOpen?"◀ 접기":"▶"}</button>
      </aside>

      {/* ── 메인 영역 ── */}
      <main style={{flex:1, display:"flex", flexDirection:"column", overflow:"hidden"}}>
        <header style={{
          padding:"18px 32px", display:"flex", justifyContent:"space-between", alignItems:"center",
          background:T.paper, borderBottom:`1px solid ${T.line}`
        }}>
          <div>
            <h1 style={{fontSize:20, fontWeight:700, margin:0, fontFamily:fontFamily, color:T.silkL}}>
              {TABS.find(t=>t.id===tab)?.label}
            </h1>
            <p style={{fontSize:12, color:T.muted, margin:"3px 0 0"}}>{todayStr}</p>
          </div>
          <div style={{display:"flex", alignItems:"center", gap:14}}>
            {supabase
              ? <Badge color={T.ok}>☁️ Supabase 연결</Badge>
              : <Badge color={T.warn}>💾 로컬 모드</Badge>}
            <Badge color={userRole==="admin"?T.silkD:T.info}>
              {userRole==="admin"?"🔧 관리자":"👤 직원"}
            </Badge>
            <div style={{display:"flex", alignItems:"center", gap:10}}>
              <div style={{
                width:36, height:36, borderRadius:10,
                background:`linear-gradient(135deg, ${T.silk}, ${T.silkL})`,
                display:"flex", alignItems:"center", justifyContent:"center",
                color:"#0f172a", fontWeight:700, fontSize:13
              }}>{(session?.user?.email||"관")[0].toUpperCase()}</div>
              <div>
                <div style={{fontSize:13, fontWeight:600, color:T.ink}}>{session?.user?.email||"관리자"}</div>
                <div style={{fontSize:11, color:T.muted}}>한국잠사플레이팜</div>
              </div>
            </div>
          </div>
        </header>
        <div style={{flex:1, overflow:"auto", padding:"24px 32px"}}>
          {moduleComponents[tab]}
        </div>
      </main>
    </div>
  );
}

/* ============================================================
   모듈 1) 대시보드
   ============================================================ */
function DashboardModule({employees}) {
  const active = employees.filter(e=>e.status==="active").length;
  const totalWage = employees.filter(e=>e.wageType==="월급").reduce((s,e)=>s+e.wage, 0);
  const probation = employees.filter(e=>e.probation).length;

  return (
    <div style={{display:"flex", flexDirection:"column", gap:18}}>
      {/* KPI */}
      <div style={{display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:14}}>
        <Stat label="전체 직원" value={`${employees.length}명`} sub={`재직 ${active}명 · 휴직 ${employees.length-active}명`} icon="👥" color={T.silkD}/>
        <Stat label="오늘 출근" value={`${active-1}/${active}`} sub="1명 연차" icon="🕐" color={T.ok}/>
        <Stat label="이번달 인건비(고정)" value={fmtKRW(totalWage)} sub="시급/일급 제외" icon="💰" color={T.gold}/>
        <Stat label="수습기간" value={`${probation}명`} sub="3개월 이내 평가" icon="📋" color={T.warn}/>
      </div>

      {/* 주요 KPI 차트 */}
      <div style={{display:"grid", gridTemplateColumns:"2fr 1fr", gap:14}}>
        <Card>
          <h3 style={{margin:"0 0 14px", fontSize:15, fontFamily:fontFamily}}>📊 주간 출근 현황</h3>
          <div style={{display:"flex", alignItems:"flex-end", gap:12, height:160, padding:"0 8px"}}>
            {["월","화","수","목","금","토","일"].map((d,i)=>{
              const h = [85,92,88,95,80,65,40][i];
              return (
                <div key={d} style={{flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:6}}>
                  <div style={{fontSize:11, color:T.muted, fontWeight:600}}>{h}%</div>
                  <div style={{
                    width:"100%", height:`${h*1.4}px`,
                    background:`linear-gradient(180deg, ${T.silk}, ${T.silkD})`,
                    borderRadius:"6px 6px 0 0", boxShadow:"inset 0 -3px 0 rgba(0,0,0,0.1)"
                  }}/>
                  <div style={{fontSize:12, color:T.ink, fontWeight:500}}>{d}</div>
                </div>
              );
            })}
          </div>
        </Card>
        <Card>
          <h3 style={{margin:"0 0 14px", fontSize:15, fontFamily:fontFamily}}>🏢 부서별 인원</h3>
          {DEPARTMENTS.map(d=>{
            const cnt = employees.filter(e=>e.dept===d).length;
            const pct = Math.round(cnt/employees.length*100);
            return (
              <div key={d} style={{marginBottom:10}}>
                <div style={{display:"flex", justifyContent:"space-between", fontSize:12, marginBottom:4}}>
                  <span>{d}</span><span style={{color:T.muted}}>{cnt}명 ({pct}%)</span>
                </div>
                <div style={{height:6, background:T.line, borderRadius:3, overflow:"hidden"}}>
                  <div style={{width:`${pct}%`, height:"100%", background:T.silk}}/>
                </div>
              </div>
            );
          })}
        </Card>
      </div>

      {/* 알림 */}
      <Card>
        <h3 style={{margin:"0 0 12px", fontSize:15, fontFamily:fontFamily}}>🔔 오늘의 알림</h3>
        <div style={{display:"flex", flexDirection:"column", gap:8}}>
          {[
            { t:"08:42", c:"김민수 출근 (BLE 비콘 자동기록)",   color:T.ok },
            { t:"09:15", c:"윤서아 연차 사용 중 — 5/24까지",   color:T.info },
            { t:"10:30", c:"최유진 수습기간 종료 D-7 — 평가 필요", color:T.warn },
            { t:"11:45", c:"5월 급여명세서 자동 발송 예정 (5/25)", color:T.silkD },
          ].map((a,i)=>(
            <div key={i} style={{
              display:"flex", alignItems:"center", gap:14, padding:"10px 12px",
              background:T.cream, borderRadius:8, borderLeft:`3px solid ${a.color}`
            }}>
              <span style={{fontSize:11, color:T.muted, fontFamily:"ui-monospace", minWidth:40}}>{a.t}</span>
              <span style={{fontSize:13}}>{a.c}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/* ============================================================
   모듈 2) 직원관리
   ============================================================ */
function EmployeesModule({employees, updateEmployee, selectedId, setSelectedId}) {
  const [filter, setFilter] = useState("all");
  const filtered = filter==="all" ? employees : employees.filter(e=>e.dept===filter);
  const selected = employees.find(e=>e.id===selectedId);

  if (selected) return <EmployeeDetail emp={selected} onBack={()=>setSelectedId(null)}/>;

  return (
    <div>
      <div style={{display:"flex", justifyContent:"space-between", marginBottom:16, alignItems:"center"}}>
        <div style={{display:"flex", gap:8}}>
          {["all", ...DEPARTMENTS].map(d=>(
            <Btn key={d} kind={filter===d?"primary":"secondary"} size="sm" onClick={()=>setFilter(d)}>
              {d==="all"?"전체":d}
            </Btn>
          ))}
        </div>
        <Btn kind="primary">+ 직원 등록</Btn>
      </div>

      <div style={{display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))", gap:14}}>
        {filtered.map(emp=>(
          <Card key={emp.id} hover onClick={()=>setSelectedId(emp.id)} style={{cursor:"pointer"}}>
            <div style={{display:"flex", gap:12, alignItems:"center", marginBottom:12}}>
              <div style={{
                width:48, height:48, borderRadius:12,
                background:`linear-gradient(135deg, ${T.silk}, ${T.silkL})`,
                display:"flex", alignItems:"center", justifyContent:"center",
                color:"#fff", fontWeight:700, fontSize:18, fontFamily:fontFamily
              }}>{emp.name[0]}</div>
              <div style={{flex:1}}>
                <div style={{fontSize:15, fontWeight:700}}>{emp.name}</div>
                <div style={{fontSize:11, color:T.muted}}>{emp.role} · {emp.dept}</div>
              </div>
              <Badge color={emp.status==="active"?T.ok:T.warn}>
                {emp.status==="active"?"재직":"휴직"}
              </Badge>
            </div>
            <div style={{display:"flex", flexDirection:"column", gap:6, fontSize:12, color:T.muted}}>
              <div>📞 {emp.phone}</div>
              <div>💰 {emp.wageType} {emp.wageType==="월급"?fmtKRW(emp.wage):fmtKRW(emp.wage)+"/시간"}</div>
              <div>📅 입사 {emp.startDate}</div>
              <div>🏷️ {emp.empType} {emp.probation && <Badge color={T.warn}>수습</Badge>}</div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function EmployeeDetail({emp, onBack}) {
  const [sub, setSub] = useState("info");
  const subs = [
    { id:"info",    label:"기본정보" },
    { id:"attend",  label:"출퇴근 이력" },
    { id:"pay",     label:"급여 내역" },
    { id:"contract",label:"근로계약" },
    { id:"memo",    label:"관리 메모" },
  ];

  return (
    <div>
      <Btn kind="ghost" size="sm" onClick={onBack}>← 목록으로</Btn>
      <Card style={{marginTop:14, marginBottom:16}}>
        <div style={{display:"flex", gap:20, alignItems:"center"}}>
          <div style={{
            width:80, height:80, borderRadius:18,
            background:`linear-gradient(135deg, ${T.silk}, ${T.silkD})`,
            display:"flex", alignItems:"center", justifyContent:"center",
            color:"#fff", fontWeight:700, fontSize:32, fontFamily:fontFamily
          }}>{emp.name[0]}</div>
          <div style={{flex:1}}>
            <h2 style={{margin:0, fontSize:22, fontFamily:fontFamily}}>{emp.name}</h2>
            <div style={{fontSize:13, color:T.muted, marginTop:4}}>{emp.role} · {emp.dept} · {emp.empType}</div>
          </div>
          <div style={{display:"flex", gap:24}}>
            {[
              { l:"출근율", v:"96%", c:T.ok },
              { l:"이번달 근무", v:"152h", c:T.info },
              { l:"잔여 연차", v:"11일", c:T.silkD },
              { l:"지각", v:"0회", c:T.muted },
            ].map(s=>(
              <div key={s.l} style={{textAlign:"center"}}>
                <div style={{fontSize:22, fontWeight:700, color:s.c, fontFamily:fontFamily}}>{s.v}</div>
                <div style={{fontSize:11, color:T.muted, marginTop:2}}>{s.l}</div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <div style={{display:"flex", gap:6, marginBottom:16, borderBottom:`1px solid ${T.line}`}}>
        {subs.map(s=>(
          <button key={s.id} onClick={()=>setSub(s.id)} style={{
            padding:"10px 18px", border:"none", background:"transparent",
            fontSize:13, fontWeight:sub===s.id?700:500, cursor:"pointer",
            color:sub===s.id?T.silkD:T.muted,
            borderBottom:`2px solid ${sub===s.id?T.silk:"transparent"}`,
            fontFamily:sansFamily,
          }}>{s.label}</button>
        ))}
      </div>

      <Card>
        {sub==="info" && (
          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:24}}>
            <div>
              <h4 style={{margin:"0 0 10px", color:T.silkD, fontFamily:fontFamily}}>인적 정보</h4>
              {[
                ["전화번호", emp.phone],
                ["이메일", `${emp.name}@jamsa.kr`],
                ["입사일", emp.startDate],
                ["고용형태", emp.empType],
                ["비콘 MAC", emp.beacon],
              ].map(([k,v])=>(
                <div key={k} style={{display:"flex", padding:"8px 0", borderBottom:`1px dotted ${T.line}`}}>
                  <span style={{width:100, color:T.muted, fontSize:12}}>{k}</span>
                  <span style={{fontSize:13}}>{v}</span>
                </div>
              ))}
            </div>
            <div>
              <h4 style={{margin:"0 0 10px", color:T.silkD, fontFamily:fontFamily}}>이번주 스케줄</h4>
              {["월 09:00-18:00", "화 09:00-18:00", "수 휴무", "목 09:00-18:00", "금 09:00-18:00", "토 10:00-17:00", "일 휴무"].map((s,i)=>(
                <div key={i} style={{padding:"6px 0", fontSize:13}}>{s}</div>
              ))}
            </div>
          </div>
        )}
        {sub==="attend" && <p style={{color:T.muted}}>최근 30일 출퇴근 기록과 히트맵이 표시됩니다.</p>}
        {sub==="pay" && (
          <div>
            <h4 style={{margin:"0 0 12px", fontFamily:fontFamily}}>2026년 5월 급여 명세</h4>
            <table style={{width:"100%", fontSize:13, borderCollapse:"collapse"}}>
              <tbody>
                {[
                  ["기본급", emp.wage, "지급"],
                  ["식대 (비과세)", 200000, "지급"],
                  ["국민연금 (4.5%)", -Math.round(emp.wage*0.045), "공제"],
                  ["건강보험 (3.545%)", -Math.round(emp.wage*0.03545), "공제"],
                  ["고용보험 (0.9%)", -Math.round(emp.wage*0.009), "공제"],
                  ["소득세 (간이)", -Math.round(emp.wage*0.03), "공제"],
                  ["지방소득세", -Math.round(emp.wage*0.003), "공제"],
                ].map(([k,v,t])=>(
                  <tr key={k} style={{borderBottom:`1px dotted ${T.line}`}}>
                    <td style={{padding:"8px 0"}}>{k}</td>
                    <td style={{padding:"8px 0", textAlign:"right", color:v<0?T.err:T.ink}}>
                      {v<0?"-":""}{fmtKRW(Math.abs(v))}
                    </td>
                    <td style={{padding:"8px 0", textAlign:"right", color:T.muted, fontSize:11}}>{t}</td>
                  </tr>
                ))}
                <tr style={{background:T.cream, fontWeight:700}}>
                  <td style={{padding:"12px 8px"}}>실수령액</td>
                  <td style={{padding:"12px 8px", textAlign:"right", color:T.silkD, fontSize:16}}>
                    {fmtKRW(emp.wage + 200000 - Math.round(emp.wage*0.083))}
                  </td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        {sub==="contract" && (
          <div>
            <Badge color={T.ok}>● 체결 완료</Badge>
            <p style={{marginTop:10}}>계약 유형: <strong>{emp.empType}</strong></p>
            <p>계약기간: {emp.startDate} ~ 무기한</p>
            <p>4대보험: 국민연금 · 건강 · 고용 · 산재 모두 가입</p>
            <Btn kind="secondary" size="sm" style={{marginTop:10}}>계약서 다시 보기</Btn>
          </div>
        )}
        {sub==="memo" && (
          <div>
            <textarea placeholder="관리 메모 작성..." style={{
              width:"100%", minHeight:120, padding:12, border:`1px solid ${T.line}`,
              borderRadius:8, fontFamily:sansFamily, fontSize:13, resize:"vertical"
            }}/>
            <div style={{marginTop:10, display:"flex", justifyContent:"flex-end"}}>
              <Btn kind="primary" size="sm">저장</Btn>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ============================================================
   모듈 3) 출퇴근 (BLE 비콘)
   ============================================================ */
function AttendanceModule({employees}) {
  const [view, setView] = useState("today");
  const [logs, setLogs] = useState([
    { emp:"김민수", in:"08:42", out:"-",     status:"근무중", src:"BLE" },
    { emp:"이서연", in:"08:55", out:"-",     status:"근무중", src:"BLE" },
    { emp:"박지훈", in:"09:01", out:"-",     status:"근무중", src:"BLE" },
    { emp:"최유진", in:"09:12", out:"-",     status:"지각",   src:"BLE" },
    { emp:"정하은", in:"08:30", out:"-",     status:"근무중", src:"BLE" },
    { emp:"강도윤", in:"08:00", out:"-",     status:"근무중", src:"BLE" },
    { emp:"윤서아", in:"-",     out:"-",     status:"연차",   src:"-" },
  ]);

  return (
    <div>
      <div style={{display:"flex", gap:8, marginBottom:16}}>
        {[{id:"today",l:"오늘 출퇴근"},{id:"weekly",l:"주간 통계"},{id:"beacon",l:"BLE 비콘 시스템"}].map(v=>(
          <Btn key={v.id} kind={view===v.id?"primary":"secondary"} size="sm" onClick={()=>setView(v.id)}>{v.l}</Btn>
        ))}
      </div>

      {view==="today" && (
        <Card>
          <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14}}>
            <h3 style={{margin:0, fontSize:15, fontFamily:fontFamily}}>📅 {todayISO()} 출근 현황</h3>
            <Badge color={T.ok}>● BLE 게이트웨이 3대 연결</Badge>
          </div>
          <table style={{width:"100%", fontSize:13, borderCollapse:"collapse"}}>
            <thead>
              <tr style={{borderBottom:`2px solid ${T.line}`, color:T.muted, fontSize:11}}>
                <th style={{padding:"10px", textAlign:"left"}}>직원</th>
                <th style={{padding:"10px", textAlign:"left"}}>출근</th>
                <th style={{padding:"10px", textAlign:"left"}}>퇴근</th>
                <th style={{padding:"10px", textAlign:"left"}}>상태</th>
                <th style={{padding:"10px", textAlign:"left"}}>기록 방식</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l,i)=>(
                <tr key={i} style={{borderBottom:`1px solid ${T.line}`}}>
                  <td style={{padding:"12px 10px", fontWeight:600}}>{l.emp}</td>
                  <td style={{padding:"12px 10px", color:T.ok, fontFamily:"ui-monospace"}}>{l.in}</td>
                  <td style={{padding:"12px 10px", color:T.muted, fontFamily:"ui-monospace"}}>{l.out}</td>
                  <td style={{padding:"12px 10px"}}>
                    <Badge color={l.status==="근무중"?T.ok:l.status==="지각"?T.warn:l.status==="연차"?T.info:T.muted}>
                      {l.status}
                    </Badge>
                  </td>
                  <td style={{padding:"12px 10px", fontSize:11, color:T.muted}}>{l.src}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {view==="weekly" && (
        <div style={{display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:14}}>
          <Stat label="정상 출근율" value="94.3%" sub="지난주 대비 +2.1%" color={T.ok}/>
          <Stat label="평균 근무시간" value="8.4h" sub="주 41.5시간" color={T.info}/>
          <Stat label="연장근로 총합" value="6.2h" sub="3명 발생" color={T.warn}/>
        </div>
      )}

      {view==="beacon" && (
        <Card>
          <h3 style={{margin:"0 0 12px", fontFamily:fontFamily}}>📡 BLE 비콘 출퇴근 시스템</h3>
          <p style={{color:T.muted, fontSize:13, marginBottom:14}}>
            게이트웨이가 직원 비콘 신호를 감지하면 자동으로 출퇴근이 기록됩니다.
          </p>
          <div style={{display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:12, marginBottom:14}}>
            {[
              { name:"GW-01 정문 매표소",  s:"online",  emp:5, rssi:"-45dBm" },
              { name:"GW-02 직원 후문",    s:"online",  emp:1, rssi:"-52dBm" },
              { name:"GW-03 양떼정원",     s:"online",  emp:0, rssi:"—" },
            ].map(g=>(
              <Card key={g.name} style={{padding:14, background:T.cream}}>
                <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8}}>
                  <strong style={{fontSize:13}}>{g.name}</strong>
                  <Badge color={T.ok}>● 온라인</Badge>
                </div>
                <div style={{fontSize:12, color:T.muted}}>감지 비콘: {g.emp}개</div>
                <div style={{fontSize:12, color:T.muted}}>신호: {g.rssi}</div>
              </Card>
            ))}
          </div>
          <Card style={{background:T.cream, padding:14}}>
            <strong style={{fontSize:13}}>💡 운영 가이드</strong>
            <ul style={{margin:"8px 0 0", paddingLeft:20, fontSize:12, lineHeight:1.8, color:T.muted}}>
              <li>직원 7명 × 비콘 태그(MinewTech E8) ≈ 14만원</li>
              <li>게이트웨이 3대(MinewTech G1) ≈ 24만원</li>
              <li>WiFi → FastAPI 서버로 RSSI 데이터 수신 → 출퇴근 자동 기록</li>
            </ul>
          </Card>
        </Card>
      )}
    </div>
  );
}

/* ============================================================
   모듈 4) 위치추적
   ============================================================ */
/* ===== presence-log-engine 헬퍼 — localStorage 직접 접근 ===== */
function _hrGetPresenceLogs() {
  try { return JSON.parse(localStorage.getItem("jamsa_presence_logs") || "[]"); }
  catch (e) { return []; }
}
function _hrGetGatewayMap() {
  try { return JSON.parse(localStorage.getItem("jamsa_gateway_zone_map") || "[]"); }
  catch (e) { return []; }
}
function _hrGetBaseZones() {
  return (typeof window !== "undefined" && window.__jamsaBaseZones) || [];
}
function _hrTimeHM(iso) {
  if (!iso) return "—";
  try { const d = new Date(iso); return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; }
  catch (e) { return "—"; }
}
function _hrDurationLabel(ms) {
  if (!ms || ms < 0) return "0분";
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}분`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
}
function _hrEmpColors(n) {
  // 안정적인 직원별 색상
  const palette = ["#ef4444","#3b82f6","#22c55e","#f59e0b","#8b5cf6","#06b6d4","#ec4899","#10b981","#f97316"];
  return palette[n % palette.length];
}

function LocationModule({ employees }) {
  // ─── 라이브 데이터: presence logs + 게이트웨이 매핑 ───
  const [logs, setLogs] = useState(() => _hrGetPresenceLogs());
  const [baseZones, setBaseZones] = useState(() => _hrGetBaseZones());
  const [selectedEmpKey, setSelectedEmpKey] = useState(null);
  const [tick, setTick] = useState(0); // 강제 리렌더 (현재시각 변경)
  const refreshLogs = useCallback(() => setLogs(_hrGetPresenceLogs()), []);

  useEffect(() => {
    // 비콘이 새로 감지되거나 AI 분석 결과가 갱신되면 즉시 반영
    const onPresence = () => refreshLogs();
    window.addEventListener("jamsa:presence-log", onPresence);
    window.addEventListener("jamsa:presence-log-updated", onPresence);
    // baseZones는 source.jsx가 mount 후 늦게 세팅할 수 있으므로 한 번 더 체크
    const zt = setTimeout(() => setBaseZones(_hrGetBaseZones()), 300);
    // 10초마다 폴링 (이벤트 누락 백업) + 60초마다 현재시각 기준 dwell 재계산
    const lt = setInterval(refreshLogs, 10000);
    const tt = setInterval(() => setTick(t => t + 1), 60000);
    return () => {
      window.removeEventListener("jamsa:presence-log", onPresence);
      window.removeEventListener("jamsa:presence-log-updated", onPresence);
      clearTimeout(zt); clearInterval(lt); clearInterval(tt);
    };
  }, [refreshLogs]);

  // ─── 오늘 날짜 로그만 ───
  const todayPrefix = new Date().toISOString().slice(0, 10);
  const todayLogs = useMemo(
    () => logs.filter(l => l.at && l.at.startsWith(todayPrefix)),
    [logs, todayPrefix]
  );

  // ─── 직원별 동선 집계 (시간순) ───
  // key = employeeId || beaconId (등록 안 된 비콘도 보여줌)
  const trajectories = useMemo(() => {
    const m = {};
    // todayLogs는 최신순으로 들어있으므로 reverse로 시간순
    for (const log of [...todayLogs].reverse()) {
      const key = log.employeeId || `beacon:${log.beaconId}`;
      const name = log.employeeName || log.beaconName || `비콘-${String(log.beaconId).slice(-4)}`;
      if (!m[key]) m[key] = { key, name, employeeId: log.employeeId, beaconId: log.beaconId, points: [] };
      m[key].points.push({
        at: log.at,
        zoneId: log.zoneId,
        zoneName: log.zoneName,
        cctvChannel: log.cctvChannel,
        rssi: log.rssi,
        aiAnalysis: log.aiAnalysis,
      });
    }
    return m;
  }, [todayLogs]);
  const trajList = useMemo(() => Object.values(trajectories), [trajectories]);

  // 선택 직원 자동 — 첫 진입 시 가장 최근 활동
  useEffect(() => {
    if (selectedEmpKey || trajList.length === 0) return;
    const mostRecent = trajList
      .map(tr => ({ tr, last: tr.points[tr.points.length - 1] }))
      .sort((a, b) => new Date(b.last.at) - new Date(a.last.at))[0];
    if (mostRecent) setSelectedEmpKey(mostRecent.tr.key);
  }, [trajList, selectedEmpKey]);

  // ─── 현재 구역별 인원 (각 직원의 가장 최근 로그) ───
  const occupancy = useMemo(() => {
    const m = {};
    trajList.forEach(tr => {
      const last = tr.points[tr.points.length - 1];
      if (!last || !last.zoneId) return;
      // 30분 이상 신호 없으면 "퇴장"으로 간주
      const ageMin = (Date.now() - new Date(last.at).getTime()) / 60000;
      if (ageMin > 30) return;
      const zid = last.zoneId;
      if (!m[zid]) m[zid] = { zoneId: zid, zoneName: last.zoneName, employees: [] };
      m[zid].employees.push({ key: tr.key, name: tr.name });
    });
    return m;
  }, [trajList, tick]);

  // ─── 선택 직원 분석 (체류시간/이동거리/패턴) ───
  const analysis = useMemo(() => {
    if (!selectedEmpKey) return null;
    const tr = trajectories[selectedEmpKey];
    if (!tr || tr.points.length === 0) return null;
    const dwell = {}; // zoneName -> ms
    for (let i = 0; i < tr.points.length; i++) {
      const cur = tr.points[i];
      const next = tr.points[i + 1];
      const startMs = new Date(cur.at).getTime();
      const endMs = next ? new Date(next.at).getTime() : Date.now();
      const span = Math.max(0, endMs - startMs);
      dwell[cur.zoneName] = (dwell[cur.zoneName] || 0) + span;
    }
    const totalMs = Object.values(dwell).reduce((a, b) => a + b, 0);
    const transitions = Math.max(0, tr.points.length - 1);
    const dwellSorted = Object.entries(dwell).sort((a, b) => b[1] - a[1]);
    const dangers = tr.points.filter(p => p.aiAnalysis?.level === "DANGER").length;
    const warnings = tr.points.filter(p => p.aiAnalysis?.level === "WARNING").length;
    return {
      first: tr.points[0],
      last: tr.points[tr.points.length - 1],
      totalMs, transitions,
      zonesVisited: Object.keys(dwell).length,
      dwellSorted, // [[zoneName, ms], ...]
      dangers, warnings,
    };
  }, [selectedEmpKey, trajectories, tick]);

  // ─── SVG 좌표 변환 — BASE_ZONES의 lat/lng를 0-100% 로 정규화 ───
  const projection = useMemo(() => {
    if (!baseZones || baseZones.length === 0) return null;
    const lats = baseZones.map(z => z.lat).filter(v => typeof v === "number");
    const lngs = baseZones.map(z => z.lng).filter(v => typeof v === "number");
    if (lats.length === 0) return null;
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const padLat = (maxLat - minLat) * 0.12 || 0.0005;
    const padLng = (maxLng - minLng) * 0.12 || 0.0005;
    const sw = { lat: minLat - padLat, lng: minLng - padLng };
    const ne = { lat: maxLat + padLat, lng: maxLng + padLng };
    return {
      project: (lat, lng) => ({
        x: ((lng - sw.lng) / (ne.lng - sw.lng)) * 100,
        y: 100 - ((lat - sw.lat) / (ne.lat - sw.lat)) * 100, // y 뒤집기
      }),
      zoneByName: (name) => baseZones.find(z => z.name === name || z.id === name),
      zoneById: (id) => baseZones.find(z => z.id === id),
    };
  }, [baseZones]);

  // 통합지도로 포커스 이벤트 dispatch
  const focusOnMainMap = (zoneId, zoneName) => {
    try {
      window.dispatchEvent(new CustomEvent("jamsa:focus-zone", { detail: { zoneId, zoneName } }));
      // 사용자가 #home 으로 갈 수 있도록 살짝 힌트
      if (!window.confirm(`통합지도에서 "${zoneName || zoneId}" 위치로 이동할까요?`)) return;
      window.location.hash = "home";
    } catch (e) {}
  };

  const selectedTraj = selectedEmpKey ? trajectories[selectedEmpKey] : null;
  const selectedColor = selectedEmpKey ? _hrEmpColors(trajList.findIndex(t => t.key === selectedEmpKey)) : T.silk;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 16 }}>
      {/* ─── 왼쪽: 실시간 동선 맵 + 분석 카드 ─── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Card style={{ padding: 0, overflow: "hidden", background: T.paper }}>
          <div style={{ padding: 14, borderBottom: `1px solid ${T.line}`, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <div>
              <strong style={{ fontFamily: fontFamily, fontSize: 14 }}>🗺️ 박물관 실시간 동선 맵</strong>
              <div style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>
                BLE 게이트웨이 + presence-log 엔진 · 통합지도와 동일 좌표계
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: T.muted }}>오늘 로그 {todayLogs.length}건 · 활성 {Object.keys(occupancy).length}구역</span>
              <button onClick={refreshLogs}
                style={{ padding: "4px 10px", fontSize: 11, fontWeight: 700, background: T.cream, color: T.silkL, border: `1px solid ${T.line}`, borderRadius: 6, cursor: "pointer" }}>
                ↻ 새로고침
              </button>
              <a href="#home"
                style={{ padding: "4px 10px", fontSize: 11, fontWeight: 700, background: T.silkD, color: "#fff", borderRadius: 6, textDecoration: "none" }}>
                통합지도 열기 →
              </a>
            </div>
          </div>
          <div style={{ position: "relative", height: 460, background: T.cream }}>
            {(!projection || trajList.length === 0) ? (
              <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: T.muted, textAlign: "center", padding: 24 }}>
                <div style={{ fontSize: 40, marginBottom: 8 }}>📡</div>
                {!projection ? (
                  <>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>통합지도 데이터 로딩 중...</div>
                    <div style={{ fontSize: 11, marginTop: 6 }}>통합지도 한 번 열고 다시 와주세요 (BASE_ZONES 초기화 후 연동됩니다)</div>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>오늘 감지된 BLE 신호 없음</div>
                    <div style={{ fontSize: 11, marginTop: 6, lineHeight: 1.6 }}>
                      통합지도 → BLE 게이트웨이 매핑이 설정되어 있고<br/>
                      비콘이 감지되면 자동으로 여기 표시됩니다.
                    </div>
                  </>
                )}
              </div>
            ) : (
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
                {/* 1. 모든 스팟 마커 */}
                {baseZones.map(z => {
                  const p = projection.project(z.lat, z.lng);
                  const occ = occupancy[z.id];
                  const cnt = occ?.employees?.length || 0;
                  return (
                    <g key={z.id} onClick={() => focusOnMainMap(z.id, z.name)} style={{ cursor: "pointer" }}>
                      <circle cx={p.x} cy={p.y} r={cnt > 0 ? 2.4 : 1.6}
                        fill={cnt > 0 ? (z.color || T.silk) : "transparent"}
                        stroke={z.color || T.silk} strokeWidth="0.5" opacity={cnt > 0 ? 1 : 0.45} />
                      <text x={p.x} y={p.y - 3} fontSize="2" fill={T.ink} textAnchor="middle" opacity="0.8">
                        {z.icon || ""} {z.name}
                      </text>
                      {cnt > 0 && (
                        <text x={p.x} y={p.y + 0.7} fontSize="1.8" fill="#fff" textAnchor="middle" fontWeight="900">{cnt}</text>
                      )}
                    </g>
                  );
                })}
                {/* 2. 선택 직원 동선 (시간순 polyline + 노드) */}
                {selectedTraj && selectedTraj.points.length > 0 && (() => {
                  const pts = selectedTraj.points
                    .map(p => {
                      const z = projection.zoneById(p.zoneId) || projection.zoneByName(p.zoneName);
                      if (!z || typeof z.lat !== "number") return null;
                      const proj = projection.project(z.lat, z.lng);
                      return { ...p, x: proj.x, y: proj.y };
                    })
                    .filter(Boolean);
                  if (pts.length === 0) return null;
                  return (
                    <g>
                      <polyline
                        points={pts.map(p => `${p.x},${p.y}`).join(" ")}
                        fill="none" stroke={selectedColor} strokeWidth="0.7"
                        strokeDasharray="1.6,0.9" strokeLinecap="round" strokeLinejoin="round" />
                      {pts.map((p, i) => (
                        <g key={i}>
                          <circle cx={p.x} cy={p.y} r="1.5" fill={selectedColor} stroke="#fff" strokeWidth="0.35" />
                          <text x={p.x} y={p.y - 2.3} fontSize="1.6" fill={selectedColor} textAnchor="middle" fontWeight="700">
                            {_hrTimeHM(p.at)}
                          </text>
                        </g>
                      ))}
                      {/* 현재 위치 펄스 */}
                      {(() => {
                        const last = pts[pts.length - 1];
                        return (
                          <circle cx={last.x} cy={last.y} r="2.6" fill={selectedColor} opacity="0.5">
                            <animate attributeName="r" values="2.6;5;2.6" dur="2s" repeatCount="indefinite" />
                            <animate attributeName="opacity" values="0.5;0.1;0.5" dur="2s" repeatCount="indefinite" />
                          </circle>
                        );
                      })()}
                    </g>
                  );
                })()}
              </svg>
            )}
          </div>
        </Card>

        {/* ─── 선택 직원 평가/분석 카드 ─── */}
        {selectedTraj && analysis && (
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <h4 style={{ margin: 0, fontSize: 13, fontFamily: fontFamily, color: T.silkL }}>
                📊 {selectedTraj.name} — 오늘 활동 분석
              </h4>
              <span style={{ fontSize: 10, color: T.muted }}>{todayPrefix}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, marginBottom: 12 }}>
              <HrLocStat label="총 체류" value={_hrDurationLabel(analysis.totalMs)} color={T.silk} />
              <HrLocStat label="이동 횟수" value={`${analysis.transitions}회`} color={T.info} />
              <HrLocStat label="방문 구역" value={`${analysis.zonesVisited}곳`} color={T.leaf} />
              <HrLocStat label="첫 감지" value={_hrTimeHM(analysis.first.at)} color={T.gold} />
            </div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: T.muted, marginBottom: 4 }}>구역별 체류시간 (Top 5)</div>
              {analysis.dwellSorted.slice(0, 5).map(([zone, ms]) => {
                const pct = analysis.totalMs > 0 ? (ms / analysis.totalMs) * 100 : 0;
                return (
                  <div key={zone} style={{ marginBottom: 4 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 2 }}>
                      <span style={{ color: T.ink }}>{zone}</span>
                      <span style={{ color: T.muted }}>{_hrDurationLabel(ms)} · {pct.toFixed(0)}%</span>
                    </div>
                    <div style={{ height: 4, background: T.cream, borderRadius: 2, overflow: "hidden" }}>
                      <div style={{ width: `${pct}%`, height: "100%", background: selectedColor }} />
                    </div>
                  </div>
                );
              })}
            </div>
            {(analysis.dangers > 0 || analysis.warnings > 0) && (
              <div style={{ padding: 8, background: analysis.dangers > 0 ? "#7f1d1d" : "#78350f", borderRadius: 6, fontSize: 11, color: "#fff" }}>
                ⚠️ CCTV AI 알림 — 위험 {analysis.dangers}건 · 경고 {analysis.warnings}건 (오늘)
              </div>
            )}
            <div style={{ fontSize: 10, color: T.muted, marginTop: 8, lineHeight: 1.7 }}>
              마지막 감지 <strong>{_hrTimeHM(analysis.last.at)}</strong> @ <strong>{analysis.last.zoneName}</strong>
              {analysis.last.cctvChannel != null && ` (CH${analysis.last.cctvChannel})`}
              {analysis.last.rssi != null && ` · RSSI ${analysis.last.rssi}`}
            </div>
          </Card>
        )}
      </div>

      {/* ─── 오른쪽: 직원 선택 + 구역별 인원 + 최근 이벤트 ─── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Card>
          <h4 style={{ margin: "0 0 10px", fontSize: 13, fontFamily: fontFamily }}>
            👥 직원 동선 선택 <span style={{ fontSize: 10, color: T.muted, fontWeight: 400 }}>({trajList.length}명)</span>
          </h4>
          {trajList.length === 0 ? (
            <div style={{ fontSize: 11, color: T.muted, padding: "16px 0", textAlign: "center" }}>오늘 감지된 직원 없음</div>
          ) : trajList.map((tr, i) => {
            const color = _hrEmpColors(i);
            const last = tr.points[tr.points.length - 1];
            const ageMin = (Date.now() - new Date(last.at).getTime()) / 60000;
            const isLive = ageMin < 30;
            return (
              <button key={tr.key} onClick={() => setSelectedEmpKey(tr.key)} style={{
                width: "100%", display: "flex", alignItems: "center", gap: 10,
                padding: "8px 10px", border: "none", cursor: "pointer",
                background: selectedEmpKey === tr.key ? T.cream : "transparent", borderRadius: 6,
                marginBottom: 3, fontFamily: sansFamily, fontSize: 12,
              }}>
                <span style={{ width: 10, height: 10, borderRadius: "50%", background: color, boxShadow: isLive ? `0 0 6px ${color}` : "none" }} />
                <div style={{ flex: 1, textAlign: "left", minWidth: 0 }}>
                  <div style={{ color: T.ink, fontWeight: 600 }}>{tr.name}</div>
                  <div style={{ color: T.muted, fontSize: 10 }}>
                    {_hrTimeHM(last.at)} · {last.zoneName}
                  </div>
                </div>
                {isLive && <Badge color={T.ok}>활성</Badge>}
                {selectedEmpKey === tr.key && <span style={{ color: color, fontSize: 14 }}>▸</span>}
              </button>
            );
          })}
        </Card>

        <Card>
          <h4 style={{ margin: "0 0 10px", fontSize: 13, fontFamily: fontFamily }}>
            📍 구역별 현재 인원 <span style={{ fontSize: 10, color: T.muted, fontWeight: 400 }}>(30분 이내)</span>
          </h4>
          {baseZones.length === 0 ? (
            <div style={{ fontSize: 11, color: T.muted }}>BASE_ZONES 로딩 중...</div>
          ) : baseZones.map(z => {
            const occ = occupancy[z.id];
            const cnt = occ?.employees?.length || 0;
            return (
              <div key={z.id}
                onClick={() => focusOnMainMap(z.id, z.name)}
                style={{ display: "flex", justifyContent: "space-between", padding: "6px 4px", fontSize: 12, borderBottom: `1px dotted ${T.line}`, cursor: "pointer", opacity: cnt > 0 ? 1 : 0.5 }}>
                <span><span style={{ color: z.color || T.silk }}>●</span> {z.icon || ""} {z.name}</span>
                <span style={{ color: cnt > 0 ? T.silkL : T.muted, fontWeight: cnt > 0 ? 700 : 400 }}>
                  {cnt > 0 ? `${cnt}명` : "—"}
                </span>
              </div>
            );
          })}
        </Card>

        <Card>
          <h4 style={{ margin: "0 0 8px", fontSize: 13, fontFamily: fontFamily }}>🕐 최근 이벤트</h4>
          {todayLogs.slice(0, 8).map(log => (
            <div key={log.id} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 11, borderBottom: `1px dotted ${T.line}` }}>
              <span style={{ color: T.muted }}>{_hrTimeHM(log.at)}</span>
              <span style={{ color: T.ink, flex: 1, marginLeft: 8, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {log.employeeName || log.beaconName} → {log.zoneName}
              </span>
            </div>
          ))}
          {todayLogs.length === 0 && (
            <div style={{ fontSize: 11, color: T.muted, padding: "8px 0", textAlign: "center" }}>아직 감지된 이벤트 없음</div>
          )}
        </Card>
      </div>
    </div>
  );
}

/* 작은 통계 카드 (LocationModule 전용 — 기존 Stat 와 분리) */
function HrLocStat({ label, value, color }) {
  return (
    <div style={{ padding: 8, background: T.cream, borderRadius: 6, border: `1px solid ${T.line}` }}>
      <div style={{ fontSize: 9, color: T.muted, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 800, color: color || T.ink, fontFamily: fontFamily }}>{value}</div>
    </div>
  );
}

/* ============================================================
   모듈 5) CCTV
   ============================================================ */
function CCTVModule() {
  const [grid, setGrid] = useState(16);
  const [selected, setSelected] = useState(0);
  const channels = Array.from({length:47}, (_,i)=>({
    id:i+1, name:`CH${pad(i+1)}`, nvr:`NVR${Math.floor(i/8)+1}`, status:Math.random()>0.05?"online":"offline"
  }));

  return (
    <div>
      <div style={{display:"flex", justifyContent:"space-between", marginBottom:14, alignItems:"center"}}>
        <div style={{display:"flex", gap:8}}>
          {[1,4,9,16,25,36].map(g=>(
            <Btn key={g} kind={grid===g?"primary":"secondary"} size="sm" onClick={()=>setGrid(g)}>{g}분할</Btn>
          ))}
        </div>
        <div style={{display:"flex", gap:14, alignItems:"center"}}>
          <Badge color={T.ok}>● 온라인 {channels.filter(c=>c.status==="online").length}</Badge>
          <Badge color={T.err}>● 오프라인 {channels.filter(c=>c.status==="offline").length}</Badge>
          <span style={{fontSize:11, color:T.muted}}>총 {channels.length}채널 · 6 NVR</span>
        </div>
      </div>

      <div style={{
        display:"grid",
        gridTemplateColumns:`repeat(${Math.ceil(Math.sqrt(grid))},1fr)`,
        gap:4, background:"#0a0a0a", padding:6, borderRadius:10
      }}>
        {channels.slice(0,grid).map(ch=>(
          <div key={ch.id} onClick={()=>setSelected(ch.id-1)} style={{
            aspectRatio:"16/9", background:"#1a1a1a", borderRadius:4,
            position:"relative", overflow:"hidden", cursor:"pointer",
            border:selected===ch.id-1?`2px solid ${T.silk}`:"2px solid transparent",
          }}>
            {ch.status==="online" ? (
              <>
                <div style={{
                  position:"absolute", inset:0,
                  background:`linear-gradient(135deg, #1a3a5c 0%, #0d1e2f 50%, #1a3a5c 100%)`,
                  display:"flex", alignItems:"center", justifyContent:"center",
                  color:"rgba(255,255,255,0.2)", fontSize:24,
                }}>📹</div>
                <div style={{position:"absolute", top:4, left:6, fontSize:10, color:"#0ff", fontWeight:600}}>{ch.name}</div>
                <div style={{position:"absolute", top:4, right:6, width:6, height:6, borderRadius:"50%", background:T.err, animation:"pulse 1s infinite"}}/>
                <div style={{position:"absolute", bottom:4, left:6, fontSize:9, color:"rgba(255,255,255,0.5)"}}>{ch.nvr}</div>
              </>
            ) : (
              <div style={{display:"flex", alignItems:"center", justifyContent:"center", height:"100%", color:"#666", fontSize:11}}>
                {ch.name} OFFLINE
              </div>
            )}
          </div>
        ))}
      </div>

      <Card style={{marginTop:14}}>
        <h4 style={{margin:"0 0 10px", fontFamily:fontFamily}}>🤖 AI 영상분석 알림</h4>
        <div style={{display:"flex", flexDirection:"column", gap:6, fontSize:12}}>
          <div style={{padding:"8px 12px", background:T.cream, borderRadius:6, borderLeft:`3px solid ${T.warn}`}}>
            <strong>10:32</strong> CH03 누에쉘터 — 5분 이상 정지 객체 감지 (전시품 응시 추정)
          </div>
          <div style={{padding:"8px 12px", background:T.cream, borderRadius:6, borderLeft:`3px solid ${T.info}`}}>
            <strong>10:45</strong> CH12 양떼정원 — 동시 8명 이상 밀집 감지
          </div>
          <div style={{padding:"8px 12px", background:T.cream, borderRadius:6, borderLeft:`3px solid ${T.ok}`}}>
            <strong>11:20</strong> CH01 정문 — 차량 진입 OCR: 87가1234
          </div>
        </div>
      </Card>
    </div>
  );
}

/* ============================================================
   모듈 6) 급여
   ============================================================ */
function PayrollModule({employees}) {
  const [month, setMonth] = useState("2026-05");
  const totalPay = employees.reduce((s,e)=>s+(e.wageType==="월급"?e.wage:e.wage*160), 0);
  const totalInsurance = Math.round(totalPay*0.083);

  return (
    <div>
      <div style={{display:"flex", justifyContent:"space-between", marginBottom:16}}>
        <input type="month" value={month} onChange={e=>setMonth(e.target.value)}
          style={{padding:"8px 12px", border:`1px solid ${T.line}`, borderRadius:8, fontSize:13, fontFamily:sansFamily}}/>
        <div style={{display:"flex", gap:8}}>
          <Btn kind="secondary" size="md">📊 임금명세서 일괄 생성</Btn>
          <Btn kind="primary" size="md">💸 일괄 이체</Btn>
        </div>
      </div>

      <div style={{display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:14, marginBottom:16}}>
        <Stat label="총 지급액" value={fmtKRW(totalPay)} icon="💰" color={T.silkD}/>
        <Stat label="4대보험 (회사부담)" value={fmtKRW(totalInsurance)} icon="🛡️" color={T.info}/>
        <Stat label="실수령액 합계" value={fmtKRW(totalPay-totalInsurance)} icon="💳" color={T.ok}/>
        <Stat label="이체 대기" value={`${employees.length}건`} icon="📋" color={T.warn}/>
      </div>

      <Card>
        <h3 style={{margin:"0 0 14px", fontFamily:fontFamily}}>💼 직원별 급여 명세 ({month})</h3>
        <table style={{width:"100%", fontSize:13, borderCollapse:"collapse"}}>
          <thead>
            <tr style={{borderBottom:`2px solid ${T.line}`, color:T.muted, fontSize:11}}>
              <th style={{padding:"10px", textAlign:"left"}}>직원</th>
              <th style={{padding:"10px", textAlign:"right"}}>기본급</th>
              <th style={{padding:"10px", textAlign:"right"}}>수당</th>
              <th style={{padding:"10px", textAlign:"right"}}>국민연금</th>
              <th style={{padding:"10px", textAlign:"right"}}>건강보험</th>
              <th style={{padding:"10px", textAlign:"right"}}>고용보험</th>
              <th style={{padding:"10px", textAlign:"right"}}>소득세</th>
              <th style={{padding:"10px", textAlign:"right", color:T.silkD}}>실수령액</th>
            </tr>
          </thead>
          <tbody>
            {employees.map(e=>{
              const base = e.wageType==="월급"?e.wage:e.wage*160;
              const allow = 200000;
              const npn = Math.round(base*0.045);
              const hi = Math.round(base*0.03545);
              const ei = Math.round(base*0.009);
              const tax = Math.round(base*0.03);
              const net = base+allow-npn-hi-ei-tax;
              return (
                <tr key={e.id} style={{borderBottom:`1px solid ${T.line}`}}>
                  <td style={{padding:"10px", fontWeight:600}}>{e.name}</td>
                  <td style={{padding:"10px", textAlign:"right"}}>{fmt(base)}</td>
                  <td style={{padding:"10px", textAlign:"right"}}>{fmt(allow)}</td>
                  <td style={{padding:"10px", textAlign:"right", color:T.err}}>-{fmt(npn)}</td>
                  <td style={{padding:"10px", textAlign:"right", color:T.err}}>-{fmt(hi)}</td>
                  <td style={{padding:"10px", textAlign:"right", color:T.err}}>-{fmt(ei)}</td>
                  <td style={{padding:"10px", textAlign:"right", color:T.err}}>-{fmt(tax)}</td>
                  <td style={{padding:"10px", textAlign:"right", fontWeight:700, color:T.silkD}}>{fmt(net)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

/* ============================================================
   모듈 7) 근무스케줄
   ============================================================ */
function ScheduleModule({employees}) {
  const [month, setMonth] = useState(new Date());
  const daysInMonth = new Date(month.getFullYear(), month.getMonth()+1, 0).getDate();
  const firstDay = new Date(month.getFullYear(), month.getMonth(), 1).getDay();

  return (
    <div>
      <div style={{display:"flex", justifyContent:"space-between", marginBottom:16, alignItems:"center"}}>
        <div style={{display:"flex", gap:10, alignItems:"center"}}>
          <Btn kind="ghost" size="sm" onClick={()=>setMonth(new Date(month.getFullYear(), month.getMonth()-1))}>◀</Btn>
          <h3 style={{margin:0, fontFamily:fontFamily, fontSize:18}}>
            {month.getFullYear()}년 {month.getMonth()+1}월
          </h3>
          <Btn kind="ghost" size="sm" onClick={()=>setMonth(new Date(month.getFullYear(), month.getMonth()+1))}>▶</Btn>
        </div>
        <Btn kind="primary" size="md">📋 패턴 일괄 적용</Btn>
      </div>

      <Card style={{padding:0, overflow:"hidden"}}>
        <div style={{display:"grid", gridTemplateColumns:"repeat(7,1fr)", background:T.cream, borderBottom:`1px solid ${T.line}`}}>
          {["일","월","화","수","목","금","토"].map((d,i)=>(
            <div key={d} style={{
              padding:12, textAlign:"center", fontWeight:700, fontSize:12,
              color:i===0?T.err:i===6?T.info:T.ink,
              borderRight:i<6?`1px solid ${T.line}`:"none"
            }}>{d}</div>
          ))}
        </div>
        <div style={{display:"grid", gridTemplateColumns:"repeat(7,1fr)"}}>
          {Array.from({length:firstDay}).map((_,i)=><div key={"e"+i} style={{minHeight:90, background:T.cream+"50"}}/>)}
          {Array.from({length:daysInMonth}).map((_,i)=>{
            const day = i+1;
            const dow = (firstDay+i)%7;
            const isToday = day===new Date().getDate() && month.getMonth()===new Date().getMonth();
            return (
              <div key={day} style={{
                minHeight:90, padding:6, borderRight:`1px solid ${T.line}`,
                borderTop:`1px solid ${T.line}`,
                background:isToday?T.silkL+"30":"transparent"
              }}>
                <div style={{
                  fontSize:12, fontWeight:isToday?700:500,
                  color:dow===0?T.err:dow===6?T.info:T.ink,
                  marginBottom:4
                }}>{day}{isToday && <span style={{marginLeft:4, fontSize:9, color:T.silkD}}>오늘</span>}</div>
                {dow!==0 && (
                  <div style={{display:"flex", flexDirection:"column", gap:2}}>
                    <div style={{fontSize:10, padding:"2px 4px", background:T.silk+"30", borderRadius:3, color:T.silkD}}>김민수 09-18</div>
                    <div style={{fontSize:10, padding:"2px 4px", background:T.info+"20", borderRadius:3, color:T.info}}>이서연 09-18</div>
                    {dow!==6 && <div style={{fontSize:10, padding:"2px 4px", background:T.ok+"20", borderRadius:3, color:T.ok}}>+3명</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

/* ============================================================
   모듈 8) 업무체크리스트
   ============================================================ */
function ChecklistModule({employees}) {
  const [items, setItems] = useState([
    { id:1, time:"08:30", task:"전시실 개장 점검 (조명/온습도)", assignee:"강도윤", done:true,  zone:"상설1관" },
    { id:2, time:"08:45", task:"매표 단말기 시재 확인", assignee:"최유진", done:true,  zone:"매표소" },
    { id:3, time:"09:00", task:"누에쉘터 사료 급여 및 청소", assignee:"박지훈", done:true,  zone:"누에쉘터" },
    { id:4, time:"09:30", task:"양떼정원 양 5두 건강 체크", assignee:"강도윤", done:false, zone:"양떼정원" },
    { id:5, time:"10:00", task:"오늘 단체예약 확인 (3건/72명)", assignee:"정하은", done:false, zone:"사무실" },
    { id:6, time:"13:00", task:"썰매장 안전 점검", assignee:"강도윤", done:false, zone:"썰매장" },
    { id:7, time:"17:30", task:"마감 시재 정산 및 보고", assignee:"최유진", done:false, zone:"매표소" },
    { id:8, time:"18:00", task:"전 구역 CCTV 정상 작동 확인", assignee:"강도윤", done:false, zone:"전체" },
  ]);

  const toggle = id => setItems(items.map(i=>i.id===id?{...i, done:!i.done}:i));
  const doneCount = items.filter(i=>i.done).length;

  return (
    <div>
      <Card style={{marginBottom:14}}>
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"center"}}>
          <div>
            <h3 style={{margin:0, fontFamily:fontFamily, fontSize:16}}>오늘의 업무 진행률</h3>
            <p style={{margin:"4px 0 0", color:T.muted, fontSize:12}}>{doneCount}/{items.length} 완료</p>
          </div>
          <div style={{position:"relative", width:80, height:80}}>
            <svg viewBox="0 0 36 36" style={{transform:"rotate(-90deg)"}}>
              <circle cx="18" cy="18" r="16" fill="none" stroke={T.line} strokeWidth="3"/>
              <circle cx="18" cy="18" r="16" fill="none" stroke={T.silk} strokeWidth="3"
                strokeDasharray={`${doneCount/items.length*100} 100`} strokeLinecap="round"/>
            </svg>
            <div style={{
              position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center",
              fontSize:18, fontWeight:700, color:T.silkD, fontFamily:fontFamily
            }}>{Math.round(doneCount/items.length*100)}%</div>
          </div>
        </div>
      </Card>

      <Card>
        <div style={{display:"flex", flexDirection:"column", gap:8}}>
          {items.map(item=>(
            <div key={item.id} style={{
              display:"flex", alignItems:"center", gap:14, padding:"12px 14px",
              background:item.done?T.cream:T.paper, border:`1px solid ${T.line}`,
              borderRadius:8, opacity:item.done?0.6:1,
              textDecoration:item.done?"line-through":"none"
            }}>
              <input type="checkbox" checked={item.done} onChange={()=>toggle(item.id)}
                style={{width:18, height:18, accentColor:T.silk, cursor:"pointer"}}/>
              <span style={{fontSize:12, color:T.muted, fontFamily:"ui-monospace", minWidth:50}}>{item.time}</span>
              <span style={{flex:1, fontSize:13}}>{item.task}</span>
              <Badge color={T.silkD}>{item.assignee}</Badge>
              <Badge color={T.info}>{item.zone}</Badge>
            </div>
          ))}
        </div>
        <div style={{marginTop:14, display:"flex", gap:8}}>
          <input type="text" placeholder="+ 업무 추가..." style={{
            flex:1, padding:"10px 12px", border:`1px solid ${T.line}`, borderRadius:8,
            fontSize:13, fontFamily:sansFamily
          }}/>
          <Btn kind="primary" size="md">추가</Btn>
        </div>
      </Card>
    </div>
  );
}

/* ============================================================
   모듈 9) 업무일지
   ============================================================ */
function WorklogModule({employees}) {
  const [logs] = useState([
    { id:1, date:"2026-05-23", emp:"김민수", title:"신규 전시 기획안 검토",
      content:"5월 28일 개막 예정인 '실크로드의 비단' 특별전 기획안을 검토했습니다. 전시 동선과 패널 디자인은 좋으나 4번 섹션의 텍스트 분량이 과다해 보임. 학예팀 회의에서 조정 예정.",
      grade:"A", reviewer:"AI 자동검수" },
    { id:2, date:"2026-05-23", emp:"이서연", title:"단체 해설 진행 (청주 햇살어린이집)",
      content:"오전 10시 30분 28명 단체 어린이 해설 진행. 누에 한살이 체험 코너에서 반응이 매우 좋았음. 다만 2개 그룹으로 나눠 진행하니 시간이 빠듯함. 다음에는 1시간 30분 예약 권장.",
      grade:"A", reviewer:"AI 자동검수" },
    { id:3, date:"2026-05-23", emp:"강도윤", title:"양떼정원 양 건강 이상 발견",
      content:"5두 중 2번째 양(이름:민트)이 사료 섭취 저조. 활동량도 평소보다 적음. 수의사 연락 필요.",
      grade:"B", reviewer:"AI 자동검수", urgent:true },
  ]);

  return (
    <div>
      <div style={{display:"flex", justifyContent:"space-between", marginBottom:14, alignItems:"center"}}>
        <h3 style={{margin:0, fontFamily:fontFamily}}>📝 업무일지</h3>
        <Btn kind="primary">+ 일지 작성</Btn>
      </div>

      <div style={{display:"flex", flexDirection:"column", gap:12}}>
        {logs.map(log=>(
          <Card key={log.id} style={{borderLeft:`4px solid ${log.urgent?T.err:T.silk}`}}>
            <div style={{display:"flex", justifyContent:"space-between", marginBottom:10, alignItems:"center"}}>
              <div style={{display:"flex", gap:10, alignItems:"center"}}>
                <strong style={{fontSize:14, fontFamily:fontFamily}}>{log.title}</strong>
                {log.urgent && <Badge color={T.err}>⚠️ 긴급</Badge>}
              </div>
              <div style={{display:"flex", gap:8, alignItems:"center", fontSize:11, color:T.muted}}>
                <span>{log.date}</span><span>·</span>
                <Badge color={T.silkD}>{log.emp}</Badge>
              </div>
            </div>
            <p style={{margin:"0 0 12px", fontSize:13, lineHeight:1.7, color:"#4a3e2f"}}>{log.content}</p>
            <div style={{
              padding:"10px 12px", background:T.cream, borderRadius:6,
              fontSize:12, display:"flex", justifyContent:"space-between", alignItems:"center"
            }}>
              <span style={{color:T.muted}}>🤖 {log.reviewer}</span>
              <Badge color={log.grade==="A"?T.ok:log.grade==="B"?T.warn:T.err}>
                평가 {log.grade}
              </Badge>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

/* ============================================================
   모듈 10) 근로계약서
   ============================================================ */
function ContractModule({employees, session, userRole}) {
  // jamsa-panel 세션에서 권한 받아옴 (자체 로그인 제거)
  const isAdmin = userRole === "admin";
  const myEmpId = useMemo(() => {
    if (isAdmin) return null;
    const myEmail = session?.user?.email;
    return employees.find(e => e.email === myEmail)?.id || null;
  }, [isAdmin, session, employees]);

  const [stage, setStage] = useState(isAdmin ? "list" : "contract");
  const [empId, setEmpId] = useState(isAdmin ? null : myEmpId);
  const [type, setType] = useState("regular");
  const [sectionChecks, setSectionChecks] = useState({});
  const [signature, setSignature] = useState(null);
  const [email, setEmail] = useState(session?.user?.email || "");
  const [logs, setLogs] = useState([]);

  // Supabase에서 계약 로그 로드
  useEffect(() => {
    if (!supabase) return;
    (async () => {
      const { data } = await supabase
        .from("hr_contract_logs")
        .select("*").order("created_at", { ascending: false }).limit(50);
      if (data) setLogs(data.map(l => ({
        id: l.id, date: l.date || l.created_at?.slice(0,10),
        emp: l.employee_name, action: l.action, status: l.status,
      })));
    })();
  }, []);

  const SECTIONS_BY_TYPE = {
    regular:   ["사업장","근로자","근로기간","근로시간","임금구성","임금계산","임금지급","유급휴일","연차","사회보험","기타조건","최종동의"],
    partShort: ["사업장","근로자","근로기간","근로시간","임금","임금지급","사회보험(산재만)","기타조건","최종동의"],
    part:      ["사업장","근로자","근로기간","근로시간","임금","임금지급","주휴(비례)","연차(비례)","사회보험","기타조건","최종동의"],
    onCall:    ["사업장","근로자","호출조건","최소보장","임금","임금지급","사회보험","기타조건","최종동의"],
  };

  // 직원으로 로그인했는데 emp 정보가 없을 때
  if (!isAdmin && !myEmpId) {
    return (
      <Card style={{textAlign:"center", padding:40}}>
        <div style={{fontSize:36}}>🔍</div>
        <h3 style={{fontFamily:fontFamily, marginTop:14}}>직원 정보 매칭 실패</h3>
        <p style={{color:T.muted, fontSize:13}}>
          로그인된 이메일({session?.user?.email})로 등록된 직원 정보가 없습니다.<br/>
          관리자에게 문의해주세요.
        </p>
      </Card>
    );
  }

  /* ── 직원 목록 (관리자만) ── */
  if (stage==="list" && isAdmin) {
    return (
      <div>
        <div style={{display:"flex", justifyContent:"space-between", marginBottom:14}}>
          <h3 style={{margin:0, fontFamily:fontFamily, color:T.silkL}}>📜 근로계약서 관리</h3>
        </div>
        <div style={{display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))", gap:12, marginBottom:18}}>
          {employees.map(e=>(
            <Card key={e.id} hover onClick={()=>{setEmpId(e.id); setStage("contract");}} style={{cursor:"pointer"}}>
              <div style={{display:"flex", alignItems:"center", gap:10}}>
                <div style={{
                  width:40, height:40, borderRadius:10,
                  background:`linear-gradient(135deg, ${T.silk}, ${T.silkL})`,
                  color:"#0f172a", display:"flex", alignItems:"center", justifyContent:"center",
                  fontWeight:700, fontFamily:fontFamily
                }}>{e.name[0]}</div>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700, color:T.ink}}>{e.name}</div>
                  <div style={{fontSize:11, color:T.muted}}>{e.empType} · {e.role}</div>
                </div>
                <Badge color={T.ok}>체결</Badge>
              </div>
            </Card>
          ))}
        </div>

        <Card>
          <h4 style={{margin:"0 0 12px", fontFamily:fontFamily, color:T.silkL}}>📋 처리 로그</h4>
          {logs.length === 0 ? (
            <div style={{padding:20, textAlign:"center", color:T.muted, fontSize:13}}>
              아직 처리된 계약서가 없습니다
            </div>
          ) : (
            <table style={{width:"100%", fontSize:13, borderCollapse:"collapse"}}>
              <thead>
                <tr style={{borderBottom:`2px solid ${T.line}`, color:T.muted, fontSize:11}}>
                  <th style={{padding:"8px", textAlign:"left"}}>날짜</th>
                  <th style={{padding:"8px", textAlign:"left"}}>직원</th>
                  <th style={{padding:"8px", textAlign:"left"}}>처리 내역</th>
                  <th style={{padding:"8px", textAlign:"left"}}>상태</th>
                </tr>
              </thead>
              <tbody>
                {logs.map(l=>(
                  <tr key={l.id} style={{borderBottom:`1px solid ${T.line}`}}>
                    <td style={{padding:"10px 8px", fontFamily:"ui-monospace", fontSize:11}}>{l.date}</td>
                    <td style={{padding:"10px 8px"}}><Badge color={T.silkD}>{l.emp}</Badge></td>
                    <td style={{padding:"10px 8px"}}>{l.action}</td>
                    <td style={{padding:"10px 8px"}}><Badge color={T.ok}>{l.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div style={{marginTop:12, display:"flex", justifyContent:"flex-end", gap:8}}>
            <Btn kind="secondary" size="sm">📥 노동청 제출용 다운로드</Btn>
            <Btn kind="secondary" size="sm">📑 처리 대장 출력</Btn>
          </div>
        </Card>
      </div>
    );
  }

  /* ── 계약서 작성 ── */
  if (stage==="contract") {
    const emp = employees.find(e=>e.id===empId);
    if (!emp) return <div style={{color:T.muted, padding:20}}>직원 정보를 찾을 수 없습니다.</div>;
    const sections = SECTIONS_BY_TYPE[type];
    const allChecked = sections.every(s=>sectionChecks[s]);

    return (
      <ContractWrite
        emp={emp} type={type} setType={setType}
        sections={sections}
        sectionChecks={sectionChecks} setSectionChecks={setSectionChecks}
        allChecked={allChecked}
        onSign={()=>setStage("sign")}
        onBack={()=>{
          if (isAdmin) setStage("list");
          else setEmpId(null);
        }}
        showBack={isAdmin}
      />
    );
  }

  /* ── 서명 단계 ── */
  if (stage==="sign") {
    return <ContractSignature emp={employees.find(e=>e.id===empId)}
      onComplete={(sig)=>{setSignature(sig); setStage("email");}}
      onBack={()=>setStage("contract")}/>;
  }

  /* ── 이메일 발송 ── */
  if (stage==="email") {
    return <ContractEmail emp={employees.find(e=>e.id===empId)} email={email} setEmail={setEmail}
      onSend={async ()=>{
        const emp = employees.find(e=>e.id===empId);
        const logEntry = {
          id: Date.now(), date: todayISO(), emp: emp.name,
          action: `${CONTRACT_TYPES.find(c=>c.id===type).label} 계약서 체결 → 서명 → 이메일 발송`,
          status: "완료"
        };
        setLogs([logEntry, ...logs]);

        // Supabase에 기록
        if (supabase) {
          await supabase.from("hr_contract_logs").insert({
            employee_id: emp.id, employee_name: emp.name,
            contract_type: type, action: logEntry.action,
            status: "완료", email: email, signature_data: signature,
            created_by: session?.user?.id,
          });
        }
        setStage("done");
      }}/>;
  }

  /* ── 완료 ── */
  if (stage==="done") {
    return (
      <Card style={{textAlign:"center", padding:60}}>
        <div style={{fontSize:72, marginBottom:14}}>✅</div>
        <h2 style={{fontFamily:fontFamily, color:T.silkL}}>근로계약서 체결 완료</h2>
        <p style={{color:T.muted, fontSize:13, marginBottom:24}}>
          서명된 계약서가 {email}으로 발송되었습니다.<br/>
          처리 내역이 Supabase에 자동 저장되었습니다.
        </p>
        <Btn kind="primary" onClick={()=>{
          setStage(isAdmin?"list":"contract");
          if (isAdmin) setEmpId(null);
          setSectionChecks({}); setSignature(null);
        }}>
          {isAdmin?"목록으로":"확인"}
        </Btn>
      </Card>
    );
  }

  return null;
}

function ContractLogin_DEPRECATED() { return null; }

function ContractWrite({emp, type, setType, sections, sectionChecks, setSectionChecks, allChecked, onSign, onBack, showBack=true}) {
  const checkedCount = Object.values(sectionChecks).filter(Boolean).length;

  return (
    <div>
      <div style={{display:"flex", justifyContent:"space-between", marginBottom:14, alignItems:"center"}}>
        {showBack ? <Btn kind="ghost" size="sm" onClick={onBack}>← 뒤로</Btn> : <span/>}
        <div>
          <strong>{emp.name}</strong> <span style={{color:T.muted, fontSize:12}}>· {emp.role}</span>
        </div>
        <Badge color={allChecked?T.ok:T.warn}>
          {checkedCount}/{sections.length} 확인
        </Badge>
      </div>

      {/* 계약 유형 선택 */}
      <Card style={{marginBottom:14}}>
        <h4 style={{margin:"0 0 10px", fontFamily:fontFamily}}>계약 유형 선택</h4>
        <div style={{display:"grid", gridTemplateColumns:"repeat(2,1fr)", gap:10}}>
          {CONTRACT_TYPES.map(t=>(
            <button key={t.id} onClick={()=>{setType(t.id); setSectionChecks({});}} style={{
              padding:14, border:`2px solid ${type===t.id?T.silk:T.line}`,
              borderRadius:10, background:type===t.id?T.silkL+"30":T.paper,
              cursor:"pointer", textAlign:"left", fontFamily:sansFamily
            }}>
              <strong style={{fontSize:13, color:T.silkD}}>{t.label}</strong>
              <div style={{fontSize:11, color:T.muted, marginTop:4}}>{t.desc}</div>
            </button>
          ))}
        </div>
      </Card>

      {/* 계약서 조항 */}
      <Card>
        <h3 style={{margin:"0 0 16px", fontFamily:fontFamily, color:T.silkD}}>
          한국잠사플레이팜 농업회사법인(주) 근로계약서 — {CONTRACT_TYPES.find(c=>c.id===type).label}
        </h3>
        <p style={{fontSize:12, color:T.muted, marginBottom:16}}>
          (이하 "갑")과 (이하 "을")은 다음과 같이 근로계약을 체결한다.
        </p>

        {sections.map((sec,i)=>(
          <div key={sec} style={{
            padding:14, marginBottom:10, border:`1px solid ${T.line}`,
            borderRadius:8, background:sectionChecks[sec]?T.ok+"08":T.paper
          }}>
            <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:8}}>
              <strong style={{fontSize:14, fontFamily:fontFamily}}>{i<sections.length-1?`제${i+1}조`:""} {sec}</strong>
              {sectionChecks[sec] && <Badge color={T.ok}>✓ 확인</Badge>}
            </div>
            <div style={{fontSize:12, color:"#4a3e2f", lineHeight:1.7, marginBottom:10}}>
              {getSectionContent(sec, type, emp)}
            </div>
            <label style={{display:"flex", alignItems:"center", gap:8, cursor:"pointer", padding:"6px 0"}}>
              <input type="checkbox" checked={!!sectionChecks[sec]}
                onChange={e=>setSectionChecks({...sectionChecks, [sec]:e.target.checked})}
                style={{width:16, height:16, accentColor:T.silk, cursor:"pointer"}}/>
              <span style={{fontSize:12, fontWeight:600, color:T.silkD}}>본 항목을 확인하였습니다</span>
            </label>
          </div>
        ))}

        {!allChecked && (
          <div style={{
            padding:12, background:T.warn+"15", borderRadius:8,
            color:T.warn, fontSize:12, fontWeight:600, marginBottom:12
          }}>
            ⚠️ {sections.length-checkedCount}개 항목 확인이 필요합니다
          </div>
        )}

        <Btn kind="primary" size="lg" disabled={!allChecked} onClick={onSign} style={{width:"100%"}}>
          {allChecked?"✍️ 서명하러 가기":"모든 항목을 확인해주세요"}
        </Btn>
      </Card>
    </div>
  );
}

function getSectionContent(sec, type, emp) {
  const C = {
    "사업장":"상호: 한국잠사플레이팜 농업회사법인(주) / 대표자: 이경연 / 소재지: 충북 청주시",
    "근로자":`성명: ${emp.name} / 연락처: ${emp.phone} / 직무: ${emp.role}`,
    "근로기간":type==="onCall"?"호출 발생 시 개별 통보 (월 최소 보장 시간 별도 명시)":"입사일부터 무기한 (수습기간 3개월)",
    "근로시간":type==="partShort"?"주 15시간 미만, 토·일 09:00~13:00 또는 별도 합의":"평일 09:00~18:00 (휴게 12:00~13:00, 주 40시간)",
    "호출조건":"갑이 필요 시 사전 24시간 전에 을에게 통보하며, 을의 수락에 의해 근로가 성립한다.",
    "최소보장":"월 최소 보장 시간: 30시간. 1회 호출 최소 근무: 4시간.",
    "임금":type==="regular"?`월 ${fmt(emp.wage)}원 (기본급)`:`시간당 ${fmt(emp.wage)}원 (2026년 최저시급 10,320원 이상)`,
    "임금구성":`기본급 ${fmt(emp.wage)}원 + 식대(비과세) 200,000원`,
    "임금계산":"월 209시간(주 40h+주휴 8h) × 시급 기준. 연장근로는 통상임금의 1.5배.",
    "임금지급":"매월 25일, 본인 명의 계좌로 이체",
    "유급휴일":"주 1회 유급 주휴일, 근로자의 날, 공휴일 (대체공휴일 포함)",
    "주휴(비례)":"주 15시간 이상 근무 시 소정근로시간 비례 주휴수당 산정",
    "연차":"근로기준법 제60조에 따라 1년 미만 매월 1일, 1년 이상 연 15일 부여",
    "연차(비례)":"근로기준법 제18조 제3항에 따른 비례 연차 부여",
    "사회보험":"국민연금, 건강보험, 고용보험, 산재보험 전체 가입",
    "사회보험(산재만)":"근로기준법 제18조 제3항에 따라 산재보험만 적용 (주휴/연차/퇴직금 미적용)",
    "기타조건":"1) 수습기간 3개월 / 2) 퇴직 시 1개월 전 통보 / 3) 영업 기밀 누설 금지 / 4) 회사 재산 임의 반출 금지 / 5) 상호 존중 / 6) 기타는 근로기준법 준수",
    "최종동의":"위 모든 조항에 대해 충분히 설명을 듣고 이해하였으며, 자유로운 의사에 따라 본 계약을 체결함에 동의합니다.",
  };
  return C[sec] || "본 항목의 내용을 충분히 확인하시기 바랍니다.";
}

function ContractSignature({emp, onComplete, onBack}) {
  const canvasRef = useRef(null);
  const [drawing, setDrawing] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);

  const start = (e) => {
    setDrawing(true);
    const c = canvasRef.current; const ctx = c.getContext("2d");
    const r = c.getBoundingClientRect();
    const x = ((e.touches?e.touches[0].clientX:e.clientX) - r.left) * (c.width/r.width);
    const y = ((e.touches?e.touches[0].clientY:e.clientY) - r.top) * (c.height/r.height);
    ctx.beginPath(); ctx.moveTo(x,y);
  };
  const draw = (e) => {
    if (!drawing) return;
    e.preventDefault();
    const c = canvasRef.current; const ctx = c.getContext("2d");
    const r = c.getBoundingClientRect();
    const x = ((e.touches?e.touches[0].clientX:e.clientX) - r.left) * (c.width/r.width);
    const y = ((e.touches?e.touches[0].clientY:e.clientY) - r.top) * (c.height/r.height);
    ctx.lineTo(x,y); ctx.lineWidth=2.5; ctx.strokeStyle=T.ink; ctx.lineCap="round"; ctx.stroke();
    setHasSignature(true);
  };
  const end = () => setDrawing(false);
  const clear = () => {
    const c = canvasRef.current; const ctx = c.getContext("2d");
    ctx.clearRect(0,0,c.width,c.height); setHasSignature(false);
  };

  return (
    <div>
      <Btn kind="ghost" size="sm" onClick={onBack}>← 뒤로</Btn>
      <Card style={{marginTop:14, textAlign:"center"}}>
        <h3 style={{fontFamily:fontFamily, color:T.silkD, marginTop:0}}>✍️ 서명</h3>
        <p style={{color:T.muted, fontSize:13}}>아래 박스 안에 본인 서명을 그려주세요</p>
        <div style={{
          margin:"20px auto", maxWidth:560, padding:14,
          background:T.cream, borderRadius:12, border:`2px dashed ${T.silk}`
        }}>
          <canvas ref={canvasRef} width="500" height="200"
            onMouseDown={start} onMouseMove={draw} onMouseUp={end} onMouseLeave={end}
            onTouchStart={start} onTouchMove={draw} onTouchEnd={end}
            style={{width:"100%", height:200, background:T.paper, borderRadius:8, cursor:"crosshair", touchAction:"none"}}/>
        </div>
        <p style={{fontSize:13}}>서명자: <strong>{emp.name}</strong> / 날짜: {todayISO()}</p>
        <div style={{display:"flex", gap:10, justifyContent:"center", marginTop:18}}>
          <Btn kind="secondary" onClick={clear}>지우기</Btn>
          <Btn kind="primary" disabled={!hasSignature}
            onClick={()=>onComplete(canvasRef.current.toDataURL())}>서명 완료 →</Btn>
        </div>
      </Card>
    </div>
  );
}

function ContractEmail({emp, email, setEmail, onSend}) {
  const [sending, setSending] = useState(false);
  return (
    <Card style={{maxWidth:500, margin:"40px auto", padding:32, textAlign:"center"}}>
      <div style={{fontSize:48}}>📧</div>
      <h2 style={{fontFamily:fontFamily, marginBottom:6}}>계약서 이메일 발송</h2>
      <p style={{color:T.muted, fontSize:13, marginBottom:20}}>
        {emp.name}님께 서명 완료된 계약서를 PDF로 발송합니다
      </p>
      <input type="email" value={email} onChange={e=>setEmail(e.target.value)}
        placeholder="이메일 주소 입력"
        style={{
          width:"100%", padding:"12px 16px", border:`1px solid ${T.line}`,
          borderRadius:8, fontSize:14, marginBottom:14, fontFamily:sansFamily, boxSizing:"border-box"
        }}/>
      <Btn kind="primary" size="lg" style={{width:"100%"}}
        disabled={!email||sending}
        onClick={()=>{
          setSending(true);
          setTimeout(()=>onSend(), 1200);
        }}>
        {sending?"발송 중...":"📤 발송하기"}
      </Btn>
    </Card>
  );
}
