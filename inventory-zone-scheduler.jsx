// inventory-zone-scheduler.jsx
// 재고 구역 월간 스케줄러 — AI 분석 (정리/재고절감/계절관리) → 캘린더 → 일일 체크리스트 (사진 인증)
//
// 동작:
//  1. 등록된 구역(=재고 위치, 예: 수장고, 온실창고, ...)마다
//     - 정리 필요성 (item density, low/zero stock 비율 등)
//     - 재고 절감 필요성 (qty > minQty*2 항목 수)
//     - 계절별 관리 용이성 (월별 카테고리 적합도)
//     을 0~100 점수로 산출.
//  2. 각 구역의 최고 점수 항목을 월간 캘린더의 적절한 날짜에 배치.
//  3. 캘린더에서 날짜 클릭 → 해당일 체크리스트 모달 → 사진 1~2장 업로드로 완료 처리.
//  4. localStorage(jamsa_zone_schedule_tasks)에 영속화.

import React, { useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "jamsa_zone_schedule_tasks";

const TASK_TYPES = {
  organize: { icon: "🧹", label: "정리", color: "#3b82f6", bg: "#dbeafe" },
  reduce:   { icon: "📉", label: "재고절감", color: "#dc2626", bg: "#fee2e2" },
  seasonal: { icon: "🍂", label: "계절관리", color: "#10b981", bg: "#dcfce7" },
};

const SEASONAL_HINTS = {
  // 월 → 점검 포인트
  1:  { focus: "동파 방지·결로", catBoost: ["박물관용품","체험용품"] },
  2:  { focus: "해빙 누수 점검", catBoost: ["하우스용","박물관용품"] },
  3:  { focus: "체험 시즌 준비", catBoost: ["체험용품","바닥재료"] },
  4:  { focus: "방충망·살균 시작", catBoost: ["하우스용","생필품"] },
  5:  { focus: "성수기 준비 정점", catBoost: ["체험용품","바닥재료"] },
  6:  { focus: "장마 대비 방수", catBoost: ["하우스용","박물관용품"] },
  7:  { focus: "냉방·해충 관리", catBoost: ["생필품","하우스용"] },
  8:  { focus: "고온 대비·재고 회전", catBoost: ["생필품","체험용품"] },
  9:  { focus: "성수기 후 정리", catBoost: ["체험용품"] },
  10: { focus: "월동 준비 시작", catBoost: ["하우스용","박물관용품"] },
  11: { focus: "보온재·동파 점검", catBoost: ["하우스용"] },
  12: { focus: "연말 재고 정산", catBoost: ["박물관용품","체험용품"] },
};

// ─── 분석 로직 ─────────────────────────────────────────────────────
function analyzeZone(zoneName, items, month) {
  const total = items.length;
  if (total === 0) {
    return { organize: 0, reduce: 0, seasonal: 0, items, total: 0, summary: "재고 없음" };
  }
  const zeroCount = items.filter(p => (p.qty || 0) === 0).length;
  const lowCount  = items.filter(p => (p.minQty || 0) > 0 && (p.qty || 0) <= p.minQty).length;
  const overstock = items.filter(p => (p.minQty || 0) > 0 && (p.qty || 0) > p.minQty * 2);
  const noPhoto   = items.filter(p => !(p.photos && p.photos.length)).length;
  const noSubLoc  = items.filter(p => !p.subLoc).length;

  // 정리 필요성: 위치 미지정·사진 없음·0재고 항목 비율
  const organizeScore = Math.min(100, Math.round(
    (zeroCount / total) * 35 +
    (noPhoto / total) * 25 +
    (noSubLoc / total) * 25 +
    Math.min(total / 30, 1) * 15  // 항목 수 자체가 많으면 +
  ));

  // 재고 절감: 과잉재고 항목 수 + 평균 초과율
  const overRatio = overstock.length ? overstock.reduce((s,p)=>s+((p.qty||0)/Math.max(1,(p.minQty||1)*2)),0)/overstock.length : 0;
  const reduceScore = Math.min(100, Math.round(
    (overstock.length / total) * 60 +
    Math.min(overRatio - 1, 2) * 20
  ));

  // 계절 관리: 해당 월 추천 카테고리 매칭 + 부족 항목 비율
  const hint = SEASONAL_HINTS[month] || { catBoost: [] };
  const matchCount = items.filter(p => hint.catBoost.includes(p.cat)).length;
  const seasonalScore = Math.min(100, Math.round(
    (matchCount / total) * 50 +
    (lowCount / total) * 30 +
    20 // 베이스
  ));

  const summary = [
    zeroCount && `0재고 ${zeroCount}`,
    lowCount && `부족 ${lowCount}`,
    overstock.length && `과잉 ${overstock.length}`,
  ].filter(Boolean).join(" · ") || "양호";

  return {
    organize: organizeScore,
    reduce: reduceScore,
    seasonal: seasonalScore,
    items, total, zeroCount, lowCount, overstock: overstock.length, noPhoto, noSubLoc,
    seasonalFocus: hint.focus,
    summary,
  };
}

// ─── 월간 태스크 생성 ───────────────────────────────────────────────
function generateMonthlyTasks(prods, zones, year, month) {
  // zones: ["수장고", "온실창고", ...] (LOCS) or zone objects
  const zoneNames = zones.map(z => typeof z === "string" ? z : z.name).filter(Boolean);
  const daysInMonth = new Date(year, month, 0).getDate();
  const tasks = [];

  zoneNames.forEach((zName, idx) => {
    const items = prods.filter(p =>
      p.loc === zName || p.subLoc === zName || Object.keys(p.locs || {}).includes(zName)
    );
    const a = analyzeZone(zName, items, month);
    if (a.total === 0) return;

    const candidates = [
      { type: "organize", score: a.organize, day: 5 + (idx * 3) % (daysInMonth - 8) },
      { type: "reduce",   score: a.reduce,   day: 15 + (idx * 4) % (daysInMonth - 16) },
      { type: "seasonal", score: a.seasonal, day: 25 + (idx % 4) },
    ];

    candidates.forEach(c => {
      if (c.score < 30) return; // 임계치 미만은 스킵
      const day = Math.min(Math.max(1, c.day), daysInMonth);
      const date = `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
      const meta = TASK_TYPES[c.type];
      tasks.push({
        id: `zsched_${year}${month}${day}_${zName}_${c.type}`.replace(/\s+/g,"_"),
        date,
        zone: zName,
        type: c.type,
        title: `${meta.icon} ${zName} — ${meta.label}`,
        score: c.score,
        priority: c.score >= 70 ? "high" : c.score >= 50 ? "medium" : "low",
        desc: buildDescription(c.type, a, month),
        checklist: buildChecklist(c.type, a, zName),
        analysis: { organize: a.organize, reduce: a.reduce, seasonal: a.seasonal, summary: a.summary, focus: a.seasonalFocus },
        status: "pending",
        beforePhoto: null,
        afterPhoto: null,
        completedAt: null,
        completedBy: null,
        memo: "",
        generatedAt: new Date().toISOString(),
      });
    });
  });

  return tasks.sort((a,b) => a.date.localeCompare(b.date));
}

function buildDescription(type, a, month) {
  const hint = SEASONAL_HINTS[month] || {};
  switch (type) {
    case "organize":
      return `정리 점수 ${a.organize}점. 위치 미지정 ${a.noSubLoc}건, 사진 없음 ${a.noPhoto}건, 0재고 ${a.zeroCount}건.`;
    case "reduce":
      return `재고 절감 점수 ${a.reduce}점. 과잉재고 ${a.overstock}건 — 사용처 확보 또는 발주 보류 검토.`;
    case "seasonal":
      return `${month}월 계절 관리: ${hint.focus || "정기 점검"}. 부족 ${a.lowCount}건 확인.`;
    default:
      return "";
  }
}

function buildChecklist(type, a, zoneName) {
  const base = [];
  switch (type) {
    case "organize":
      base.push("선반/구역별 라벨 확인 및 보정");
      base.push("0재고/만료 항목 정리·폐기");
      base.push("위치 미지정 항목 subLoc 입력");
      base.push("사진 없는 항목 대표사진 1장 촬영");
      if (a.total > 20) base.push("대형 구역 — 구역 내부 사진 2장 (전·후) 촬영");
      break;
    case "reduce":
      base.push(`과잉재고 ${a.overstock}건 사용 계획 수립`);
      base.push("발주 보류 항목 표시");
      base.push("유통기한/노후 항목 우선 소진 계획");
      base.push("필요 시 타 구역 이동 검토");
      break;
    case "seasonal":
      base.push("계절 점검 포인트 현장 확인");
      base.push("부족 항목 발주 요청 작성");
      base.push("보관 환경(온·습도) 점검");
      base.push("계절 적합 카테고리 진열 위치 조정");
      break;
  }
  return base.map((t,i) => ({ id: `${i}`, text: t, done: false }));
}

// ─── 메인 컴포넌트 ─────────────────────────────────────────────────
export function ZoneScheduler({ prods = [], locs = [], zones = [], onClose, curUser }) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [tasks, setTasks] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); }
    catch (e) { return []; }
  });
  const [selDate, setSelDate] = useState(null);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks)); } catch (e) {}
  }, [tasks]);

  const allZoneNames = useMemo(() => {
    const s = new Set(locs);
    zones.forEach(z => { if (z.name) s.add(z.name); });
    return Array.from(s);
  }, [locs, zones]);

  const monthTasks = useMemo(() => {
    const prefix = `${year}-${String(month).padStart(2,"0")}`;
    return tasks.filter(t => t.date.startsWith(prefix));
  }, [tasks, year, month]);

  const regenerate = () => {
    if (monthTasks.length > 0 && !confirm(`이번 달 기존 ${monthTasks.length}건을 덮어쓸까요? (완료된 항목은 유지)`)) return;
    const fresh = generateMonthlyTasks(prods, allZoneNames, year, month);
    const completed = monthTasks.filter(t => t.status === "done");
    const completedKeys = new Set(completed.map(t => `${t.date}_${t.zone}_${t.type}`));
    const merged = fresh.filter(t => !completedKeys.has(`${t.date}_${t.zone}_${t.type}`));
    const others = tasks.filter(t => !t.date.startsWith(`${year}-${String(month).padStart(2,"0")}`));
    setTasks([...others, ...merged, ...completed]);
    alert(`✅ ${merged.length}건 생성 (완료 ${completed.length}건 유지)`);
  };

  const upsertTask = (id, patch) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t));
  };
  const deleteTask = (id) => {
    if (!confirm("이 일정을 삭제할까요?")) return;
    setTasks(prev => prev.filter(t => t.id !== id));
  };

  // 오늘 알림
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;
  const todayTasks = tasks.filter(t => t.date === todayStr && t.status !== "done");

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.6)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:14}}>
      <div style={{background:"#fff",borderRadius:14,maxWidth:1100,width:"100%",maxHeight:"94vh",overflowY:"auto",display:"flex",flexDirection:"column"}}>
        {/* 헤더 */}
        <div style={{padding:"14px 18px",background:"linear-gradient(135deg,#0ea5e9,#3b82f6)",color:"#fff",borderRadius:"14px 14px 0 0",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
          <div>
            <h2 style={{fontSize:16,fontWeight:900,margin:0}}>📅 구역별 월간 스케줄러 (AI 분석)</h2>
            <div style={{fontSize:11,opacity:0.9,marginTop:3}}>정리 · 재고절감 · 계절관리를 구역마다 자동 분석 + 캘린더 배치 + 사진 인증</div>
          </div>
          <button onClick={onClose} style={{background:"rgba(255,255,255,0.2)",border:"none",color:"#fff",fontSize:18,padding:"4px 12px",borderRadius:6,cursor:"pointer"}}>✕</button>
        </div>

        {/* 오늘 알림 배너 */}
        {todayTasks.length > 0 && (
          <div style={{padding:"10px 18px",background:"#fef3c7",borderBottom:"1px solid #fde68a",display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:18}}>🔔</span>
            <div style={{flex:1,fontSize:12,color:"#92400e"}}>
              <strong>오늘({todayStr}) 미완료 점검 {todayTasks.length}건:</strong>{" "}
              {todayTasks.slice(0,3).map(t => t.title.replace(/^[^\s]+\s/,"")).join(", ")}
              {todayTasks.length > 3 && ` 외 ${todayTasks.length-3}건`}
            </div>
            <button onClick={()=>setSelDate(todayStr)}
              style={{padding:"5px 12px",fontSize:11,background:"#f59e0b",color:"#fff",border:"none",borderRadius:6,fontWeight:700,cursor:"pointer"}}>
              체크리스트 열기
            </button>
          </div>
        )}

        {/* 컨트롤 */}
        <div style={{padding:"10px 18px",borderBottom:"1px solid #e5e7eb",display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          <button onClick={()=>{ const m = month === 1 ? (setYear(year-1), 12) : month-1; setMonth(m); }}
            style={{padding:"6px 12px",background:"#f1f5f9",border:"none",borderRadius:6,cursor:"pointer",fontWeight:700}}>‹</button>
          <strong style={{fontSize:15,minWidth:120,textAlign:"center"}}>{year}년 {month}월</strong>
          <button onClick={()=>{ const m = month === 12 ? (setYear(year+1), 1) : month+1; setMonth(m); }}
            style={{padding:"6px 12px",background:"#f1f5f9",border:"none",borderRadius:6,cursor:"pointer",fontWeight:700}}>›</button>
          <button onClick={()=>{ const d = new Date(); setYear(d.getFullYear()); setMonth(d.getMonth()+1); }}
            style={{padding:"6px 12px",fontSize:11,background:"#eef2ff",border:"none",borderRadius:6,cursor:"pointer",fontWeight:700,color:"#3730a3"}}>오늘</button>
          <div style={{flex:1}}/>
          <span style={{fontSize:11,color:"#64748b"}}>이번 달: {monthTasks.length}건 · 완료 {monthTasks.filter(t=>t.status==="done").length}건</span>
          <button onClick={regenerate}
            style={{padding:"8px 14px",background:"linear-gradient(135deg,#7c3aed,#3b82f6)",color:"#fff",border:"none",borderRadius:6,fontWeight:700,fontSize:12,cursor:"pointer"}}>
            🤖 AI 분석 → 일정 생성
          </button>
        </div>

        {/* 본문: 캘린더 + 사이드 분석 */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 320px",gap:0,flex:1,minHeight:0}}>
          <CalendarGrid year={year} month={month} tasks={monthTasks} onPickDate={setSelDate} />
          <ZoneAnalysisPanel prods={prods} zones={allZoneNames} month={month} />
        </div>

        {/* 일자 체크리스트 모달 */}
        {selDate && (
          <DayChecklistModal
            date={selDate}
            tasks={tasks.filter(t => t.date === selDate)}
            onUpdate={upsertTask}
            onDelete={deleteTask}
            onClose={()=>setSelDate(null)}
            curUser={curUser}
          />
        )}
      </div>
    </div>
  );
}

// ─── 캘린더 그리드 ──────────────────────────────────────────────────
function CalendarGrid({ year, month, tasks, onPickDate }) {
  const first = new Date(year, month-1, 1);
  const startDay = first.getDay(); // 0=일
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells = [];
  for (let i = 0; i < startDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const todayStr = new Date().toISOString().slice(0,10);

  return (
    <div style={{padding:14,overflow:"auto"}}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:4,fontSize:10,fontWeight:700,color:"#64748b",marginBottom:6,textAlign:"center"}}>
        {["일","월","화","수","목","금","토"].map((d,i)=><div key={d} style={{color:i===0?"#dc2626":i===6?"#3b82f6":"#64748b"}}>{d}</div>)}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:4}}>
        {cells.map((d, i) => {
          if (!d) return <div key={i} style={{minHeight:80,background:"#fafafa",borderRadius:6}}/>;
          const dateStr = `${year}-${String(month).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
          const dayTasks = tasks.filter(t => t.date === dateStr);
          const dayOfWeek = (startDay + d - 1) % 7;
          const isToday = dateStr === todayStr;
          const doneCount = dayTasks.filter(t => t.status === "done").length;
          return (
            <button key={i} onClick={()=>onPickDate(dateStr)}
              style={{minHeight:80,padding:6,background:isToday?"#eff6ff":"#fff",border:isToday?"2px solid #3b82f6":"1px solid #e5e7eb",borderRadius:6,cursor:"pointer",textAlign:"left",display:"flex",flexDirection:"column",gap:3}}>
              <div style={{fontSize:11,fontWeight:800,color:dayOfWeek===0?"#dc2626":dayOfWeek===6?"#3b82f6":"#0f172a"}}>{d}</div>
              {dayTasks.slice(0,3).map(t => (
                <div key={t.id} style={{fontSize:9,padding:"2px 4px",background:TASK_TYPES[t.type].bg,color:TASK_TYPES[t.type].color,borderRadius:3,textDecoration:t.status==="done"?"line-through":"none",opacity:t.status==="done"?0.6:1,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                  {TASK_TYPES[t.type].icon} {t.zone}
                </div>
              ))}
              {dayTasks.length > 3 && <div style={{fontSize:9,color:"#94a3b8"}}>+{dayTasks.length-3}</div>}
              {dayTasks.length > 0 && (
                <div style={{fontSize:9,color:"#64748b",marginTop:"auto"}}>{doneCount}/{dayTasks.length}</div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── 사이드 분석 패널 ──────────────────────────────────────────────
function ZoneAnalysisPanel({ prods, zones, month }) {
  const analyses = useMemo(() => {
    return zones.map(z => {
      const items = prods.filter(p => p.loc === z || p.subLoc === z || Object.keys(p.locs||{}).includes(z));
      return { zone: z, ...analyzeZone(z, items, month) };
    }).filter(a => a.total > 0).sort((a,b) => (b.organize+b.reduce+b.seasonal) - (a.organize+a.reduce+a.seasonal));
  }, [prods, zones, month]);

  return (
    <div style={{borderLeft:"1px solid #e5e7eb",padding:14,overflow:"auto",background:"#fafbfc"}}>
      <div style={{fontSize:12,fontWeight:900,marginBottom:8,color:"#0f172a"}}>📊 구역별 점수 ({month}월)</div>
      <div style={{fontSize:10,color:"#64748b",marginBottom:10}}>
        ⚠️ 점수가 높을수록 우선 점검 필요. AI가 자동으로 캘린더에 배치합니다.
      </div>
      {analyses.length === 0 && <div style={{fontSize:11,color:"#94a3b8",textAlign:"center",padding:20}}>분석할 구역이 없습니다.</div>}
      {analyses.map(a => (
        <div key={a.zone} style={{padding:10,marginBottom:8,background:"#fff",border:"1px solid #e5e7eb",borderRadius:8}}>
          <div style={{fontSize:12,fontWeight:800,color:"#0f172a",marginBottom:2}}>📍 {a.zone}</div>
          <div style={{fontSize:9,color:"#64748b",marginBottom:6}}>{a.total}품 · {a.summary}</div>
          <ScoreBar label="정리" value={a.organize} color="#3b82f6"/>
          <ScoreBar label="재고절감" value={a.reduce} color="#dc2626"/>
          <ScoreBar label="계절관리" value={a.seasonal} color="#10b981"/>
          {a.seasonalFocus && <div style={{fontSize:9,color:"#047857",marginTop:4,fontStyle:"italic"}}>🍂 {a.seasonalFocus}</div>}
        </div>
      ))}
    </div>
  );
}

function ScoreBar({ label, value, color }) {
  return (
    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
      <span style={{fontSize:9,color:"#475569",width:46,fontWeight:700}}>{label}</span>
      <div style={{flex:1,height:6,background:"#f1f5f9",borderRadius:3,overflow:"hidden"}}>
        <div style={{width:`${value}%`,height:"100%",background:color,borderRadius:3}}/>
      </div>
      <span style={{fontSize:9,fontWeight:800,color,width:24,textAlign:"right"}}>{value}</span>
    </div>
  );
}

// ─── 일자 체크리스트 모달 ───────────────────────────────────────────
function DayChecklistModal({ date, tasks, onUpdate, onDelete, onClose, curUser }) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.7)",zIndex:10000,display:"flex",alignItems:"center",justifyContent:"center",padding:14}}>
      <div style={{background:"#fff",borderRadius:12,maxWidth:720,width:"100%",maxHeight:"90vh",overflowY:"auto"}}>
        <div style={{padding:14,borderBottom:"1px solid #e5e7eb",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <h3 style={{fontSize:15,fontWeight:900,margin:0}}>📋 {date} 점검 체크리스트 ({tasks.length}건)</h3>
          <button onClick={onClose} style={{background:"none",border:"none",fontSize:20,color:"#94a3b8",cursor:"pointer"}}>✕</button>
        </div>
        <div style={{padding:14}}>
          {tasks.length === 0 && (
            <div style={{textAlign:"center",padding:30,color:"#94a3b8"}}>
              <div style={{fontSize:40,marginBottom:8}}>📭</div>
              <div style={{fontSize:13}}>이 날짜에 예정된 점검이 없습니다.</div>
            </div>
          )}
          {tasks.map(t => <TaskCard key={t.id} task={t} onUpdate={onUpdate} onDelete={onDelete} curUser={curUser}/>)}
        </div>
      </div>
    </div>
  );
}

function TaskCard({ task, onUpdate, onDelete, curUser }) {
  const meta = TASK_TYPES[task.type];
  const isDone = task.status === "done";

  const handlePhoto = (which) => (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      onUpdate(task.id, { [which]: reader.result });
    };
    reader.readAsDataURL(file);
  };

  const toggleItem = (idx) => {
    const next = task.checklist.map((it,i) => i === idx ? { ...it, done: !it.done } : it);
    onUpdate(task.id, { checklist: next });
  };

  const markDone = () => {
    if (!task.afterPhoto) {
      if (!confirm("'후' 사진 없이 완료 처리할까요?")) return;
    }
    onUpdate(task.id, {
      status: "done",
      completedAt: new Date().toISOString(),
      completedBy: curUser?.name || "사용자",
    });
  };

  const reopen = () => onUpdate(task.id, { status: "pending", completedAt: null, completedBy: null });

  const checkedCount = task.checklist.filter(it => it.done).length;
  const pct = task.checklist.length ? Math.round(checkedCount / task.checklist.length * 100) : 0;

  return (
    <div style={{padding:12,border:`2px solid ${meta.color}33`,borderRadius:10,marginBottom:10,background:isDone?"#f0fdf4":"#fff"}}>
      <div style={{display:"flex",alignItems:"flex-start",gap:8,marginBottom:8}}>
        <span style={{fontSize:24}}>{meta.icon}</span>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:13,fontWeight:900,color:"#0f172a"}}>{task.title}</div>
          <div style={{fontSize:10,color:"#64748b",marginTop:2}}>
            <span style={{padding:"1px 6px",background:meta.bg,color:meta.color,borderRadius:4,fontWeight:700,marginRight:4}}>{meta.label}</span>
            <span style={{padding:"1px 6px",background:task.priority==="high"?"#fee2e2":task.priority==="medium"?"#fef3c7":"#f1f5f9",color:task.priority==="high"?"#991b1b":task.priority==="medium"?"#92400e":"#475569",borderRadius:4,fontWeight:700}}>
              우선순위: {task.priority==="high"?"높음":task.priority==="medium"?"중간":"낮음"}
            </span>
            <span style={{marginLeft:6}}>점수: {task.score}</span>
          </div>
          <div style={{fontSize:11,color:"#475569",marginTop:4}}>{task.desc}</div>
        </div>
        {isDone && <span style={{padding:"3px 8px",background:"#dcfce7",color:"#065f46",borderRadius:5,fontSize:10,fontWeight:800}}>✅ 완료</span>}
        <button onClick={()=>onDelete(task.id)} style={{padding:"3px 6px",background:"#fee2e2",color:"#dc2626",border:"none",borderRadius:4,fontSize:10,cursor:"pointer"}}>🗑️</button>
      </div>

      {/* 진행률 */}
      <div style={{margin:"8px 0"}}>
        <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"#64748b",marginBottom:3}}>
          <span>체크 진행률</span><span style={{fontWeight:800}}>{checkedCount}/{task.checklist.length} ({pct}%)</span>
        </div>
        <div style={{height:6,background:"#f1f5f9",borderRadius:3,overflow:"hidden"}}>
          <div style={{width:`${pct}%`,height:"100%",background:meta.color,borderRadius:3,transition:"width 0.3s"}}/>
        </div>
      </div>

      {/* 체크리스트 */}
      <div style={{marginBottom:10}}>
        {task.checklist.map((it, i) => (
          <label key={it.id} style={{display:"flex",alignItems:"center",gap:6,padding:"4px 0",fontSize:11,cursor:"pointer",color:it.done?"#94a3b8":"#0f172a",textDecoration:it.done?"line-through":"none"}}>
            <input type="checkbox" checked={it.done} onChange={()=>toggleItem(i)} disabled={isDone}/>
            {it.text}
          </label>
        ))}
      </div>

      {/* 사진 (전·후) */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
        <PhotoSlot label="조치 전" url={task.beforePhoto} onChange={handlePhoto("beforePhoto")} onClear={()=>onUpdate(task.id,{beforePhoto:null})} disabled={isDone}/>
        <PhotoSlot label="조치 후" url={task.afterPhoto} onChange={handlePhoto("afterPhoto")} onClear={()=>onUpdate(task.id,{afterPhoto:null})} disabled={isDone}/>
      </div>

      {/* 메모 */}
      <textarea value={task.memo||""} onChange={e=>onUpdate(task.id,{memo:e.target.value})} disabled={isDone}
        placeholder="조치 메모 (선택)"
        style={{width:"100%",padding:"6px 8px",border:"1px solid #e5e7eb",borderRadius:5,fontSize:11,resize:"vertical",minHeight:40}}/>

      <div style={{display:"flex",justifyContent:"flex-end",gap:6,marginTop:8}}>
        {!isDone ? (
          <button onClick={markDone}
            style={{padding:"7px 16px",background:meta.color,color:"#fff",border:"none",borderRadius:6,fontWeight:700,fontSize:12,cursor:"pointer"}}>
            ✅ 완료 처리
          </button>
        ) : (
          <>
            <span style={{fontSize:10,color:"#065f46",alignSelf:"center"}}>완료 · {task.completedBy} · {new Date(task.completedAt).toLocaleString("ko-KR")}</span>
            <button onClick={reopen}
              style={{padding:"6px 12px",background:"#f1f5f9",border:"none",borderRadius:5,fontSize:11,cursor:"pointer"}}>
              재오픈
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function PhotoSlot({ label, url, onChange, onClear, disabled }) {
  return (
    <div style={{border:"1px dashed #cbd5e1",borderRadius:6,padding:6,background:"#fafafa"}}>
      <div style={{fontSize:10,fontWeight:700,color:"#64748b",marginBottom:4}}>{label}</div>
      {url ? (
        <div style={{position:"relative"}}>
          <img src={url} alt={label} style={{width:"100%",height:100,objectFit:"cover",borderRadius:4}}/>
          {!disabled && (
            <button onClick={onClear}
              style={{position:"absolute",top:4,right:4,background:"rgba(220,38,38,0.9)",color:"#fff",border:"none",borderRadius:4,fontSize:10,padding:"2px 6px",cursor:"pointer"}}>
              ✕
            </button>
          )}
        </div>
      ) : (
        <label style={{display:"flex",alignItems:"center",justifyContent:"center",height:100,cursor:disabled?"not-allowed":"pointer",fontSize:11,color:"#94a3b8"}}>
          {disabled ? "(잠김)" : "📷 사진 추가"}
          <input type="file" accept="image/*" capture="environment" onChange={onChange} disabled={disabled} style={{display:"none"}}/>
        </label>
      )}
    </div>
  );
}

// ─── 오늘 알림 위젯 (다른 페이지에서 가져다 쓸 수 있음) ──────────────
export function ZoneScheduleTodayBanner({ onOpen }) {
  const [todayTasks, setTodayTasks] = useState([]);
  useEffect(() => {
    try {
      const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      const today = new Date().toISOString().slice(0,10);
      setTodayTasks(all.filter(t => t.date === today && t.status !== "done"));
    } catch (e) {}
  }, []);
  if (todayTasks.length === 0) return null;
  return (
    <div style={{padding:"8px 14px",background:"#fef3c7",border:"1px solid #fde68a",borderRadius:8,display:"flex",alignItems:"center",gap:10,fontSize:11,marginBottom:8}}>
      <span style={{fontSize:16}}>🔔</span>
      <div style={{flex:1,color:"#92400e"}}>
        <strong>오늘 점검 {todayTasks.length}건</strong> · {todayTasks.slice(0,2).map(t=>t.zone).join(", ")}
        {todayTasks.length > 2 && ` 외`}
      </div>
      <button onClick={onOpen}
        style={{padding:"4px 10px",fontSize:10,background:"#f59e0b",color:"#fff",border:"none",borderRadius:5,fontWeight:700,cursor:"pointer"}}>
        열기
      </button>
    </div>
  );
}
