// ═══════════════════════════════════════════════════════════════════════
// 🛡️ Safety Insurance & Calendar Module
// ─────────────────────────────────────────────────────────────────────
// 두 부가기능을 하나의 파일로 제공:
//   1. 📑 보험관리 — 보험 등록 + 청구 사례 + 처리 가능성 + 필요 보험 분석
//   2. 📅 안전관리 캘린더 — 월간 캘린더 + 점검/교육/훈련 일정 관리
// localStorage 키:
//   - jamsa_insurance_policies  (InsurancePolicy[])
//   - jamsa_insurance_claims    (InsuranceClaim[])
//   - jamsa_safety_calendar     (ScheduledEvent[])
// ═══════════════════════════════════════════════════════════════════════
import React, { useState, useMemo, useEffect } from "react";

// ─── 데이터 모델 ────────────────────────────────────────────────────
/**
 * @typedef {"LIABILITY"|"FIRE"|"WORKERS_COMP"|"FACILITY"|"VEHICLE"|"GROUP_ACCIDENT"|"PROPERTY"|"CYBER"|"OTHER"} InsuranceType
 */
export const INSURANCE_TYPES = {
  LIABILITY:       { label: "영업배상책임", icon: "🏛️", color: "#0ea5e9", covers: ["방문객 사고", "시설 이용 중 부상", "제3자 재산 손해"] },
  FIRE:            { label: "화재보험",     icon: "🔥", color: "#dc2626", covers: ["화재", "폭발", "낙뢰", "급배수 누수"] },
  WORKERS_COMP:    { label: "근로자재해",   icon: "👷", color: "#f59e0b", covers: ["직원 업무중 부상", "직업병"] },
  FACILITY:        { label: "시설소유관리자배상", icon: "🏢", color: "#3b82f6", covers: ["시설 결함으로 인한 사고", "관리 부실 사고"] },
  VEHICLE:         { label: "차량보험",     icon: "🚌", color: "#8b5cf6", covers: ["차량 사고", "셔틀버스 운영"] },
  GROUP_ACCIDENT:  { label: "단체상해",     icon: "🤝", color: "#10b981", covers: ["단체 관람객 상해", "체험 프로그램 사고"] },
  PROPERTY:        { label: "재산종합",     icon: "📦", color: "#a855f7", covers: ["전시품 손상", "기물 파손", "도난"] },
  CYBER:           { label: "사이버배상",   icon: "💻", color: "#0891b2", covers: ["개인정보 유출", "랜섬웨어"] },
  OTHER:           { label: "기타",         icon: "📋", color: "#64748b", covers: [] },
};

export const CLAIM_STATUS = {
  filed:     { label: "접수",     color: "#64748b", icon: "📩" },
  review:    { label: "심사 중",  color: "#f59e0b", icon: "🔍" },
  approved:  { label: "승인",     color: "#3b82f6", icon: "✅" },
  paid:      { label: "지급완료", color: "#10b981", icon: "💰" },
  rejected:  { label: "반려",     color: "#dc2626", icon: "❌" },
  withdrawn: { label: "철회",     color: "#94a3b8", icon: "↩️" },
};

// ─── Storage helpers ────────────────────────────────────────────────
const STORAGE = {
  policies: "jamsa_insurance_policies",
  claims:   "jamsa_insurance_claims",
  calendar: "jamsa_safety_calendar",
};
const load = (k, def=[]) => { try { return JSON.parse(localStorage.getItem(k) || JSON.stringify(def)); } catch (e) { return def; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
const uid = (p="") => `${p}${Date.now()}_${Math.floor(Math.random()*1000)}`;
const today = () => new Date().toISOString().slice(0,10);

// ═══════════════════════════════════════════════════════════════════════
// 📑 INSURANCE MANAGEMENT PAGE
// ═══════════════════════════════════════════════════════════════════════
export function InsuranceManagementPage({ incidents = [], facilities = [], curUser }) {
  const [tab, setTab] = useState("overview"); // overview | policies | claims | gap
  const [policies, setPolicies] = useState(load(STORAGE.policies));
  const [claims, setClaims] = useState(load(STORAGE.claims));
  useEffect(() => save(STORAGE.policies, policies), [policies]);
  useEffect(() => save(STORAGE.claims, claims), [claims]);

  const [showPolicyForm, setShowPolicyForm] = useState(null); // null | "new" | id
  const [showClaimForm, setShowClaimForm] = useState(null);

  const activePolicies = useMemo(() => policies.filter(p => {
    if (!p.periodEnd) return true;
    return new Date(p.periodEnd) >= new Date();
  }), [policies]);

  // 갱신 임박 보험 (30일 이내)
  const expiringSoon = useMemo(() => {
    const now = Date.now();
    return policies.filter(p => {
      if (!p.periodEnd) return false;
      const dt = new Date(p.periodEnd).getTime() - now;
      return dt > 0 && dt < 30 * 86400000;
    });
  }, [policies]);

  // 사고 → 처리 가능성 (보유 보험 중 covers에 매칭되는 키워드 검색)
  const feasibilityForIncident = (incident) => {
    if (!incident) return [];
    const text = `${incident.title || ""} ${incident.description || ""} ${incident.severity || ""}`.toLowerCase();
    const matched = [];
    for (const p of activePolicies) {
      const meta = INSURANCE_TYPES[p.type];
      if (!meta) continue;
      let score = 0;
      const reasons = [];
      for (const c of meta.covers) {
        if (text.includes(c.toLowerCase())) { score += 30; reasons.push(c); }
      }
      // 사고 유형별 추가 가중치
      if (/방문객|관람객|일반인/.test(text) && p.type === "LIABILITY") { score += 30; reasons.push("방문객 책임"); }
      if (/직원|근로자|업무/.test(text) && p.type === "WORKERS_COMP") { score += 40; reasons.push("직원 업무 관련"); }
      if (/화재|불|연기|폭발/.test(text) && p.type === "FIRE") { score += 50; reasons.push("화재 사고"); }
      if (/차량|버스|운전/.test(text) && p.type === "VEHICLE") { score += 40; reasons.push("차량 관련"); }
      if (/체험|단체|학교/.test(text) && p.type === "GROUP_ACCIDENT") { score += 30; reasons.push("단체 활동"); }
      if (score > 0) matched.push({ policy: p, score, reasons });
    }
    return matched.sort((a,b) => b.score - a.score);
  };

  // 필요 보험 분석 (현재 보유한 type을 제외한 권장 보험)
  const recommendedGap = useMemo(() => {
    const owned = new Set(activePolicies.map(p => p.type));
    const ESSENTIAL = ["LIABILITY", "FIRE", "WORKERS_COMP", "FACILITY", "GROUP_ACCIDENT"];
    return ESSENTIAL.filter(t => !owned.has(t)).map(t => ({ type: t, ...INSURANCE_TYPES[t] }));
  }, [activePolicies]);

  // 통계
  const stats = useMemo(() => {
    const totalCoverage = activePolicies.reduce((s,p) => s + (parseInt(p.coverage)||0), 0);
    const totalPremium = activePolicies.reduce((s,p) => s + (parseInt(p.premium)||0), 0);
    const claimsThisYear = claims.filter(c => c.filedAt?.slice(0,4) === today().slice(0,4));
    const totalPaid = claimsThisYear.filter(c=>c.status==="paid").reduce((s,c)=>s+(parseInt(c.amountPaid)||0), 0);
    return { policyCount: activePolicies.length, totalCoverage, totalPremium, claimCount: claims.length, claimsThisYear: claimsThisYear.length, totalPaid };
  }, [activePolicies, claims]);

  return (
    <div className="space-y-4">
      <div className="bg-gradient-to-r from-blue-50 to-cyan-50 border border-blue-200 rounded-xl p-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-base font-black text-blue-900">📑 보험 종합 관리</h2>
            <div className="text-xs text-blue-700 mt-1">등록 보험 · 청구 사례 · 처리 가능성 · 필요 보험 분석</div>
          </div>
          {expiringSoon.length > 0 && (
            <div className="px-3 py-2 bg-orange-100 border border-orange-300 rounded-lg text-xs font-bold text-orange-900">
              ⏰ 30일 내 만료: {expiringSoon.length}건
            </div>
          )}
        </div>
      </div>

      {/* 탭 */}
      <div className="flex gap-1 border-b-2 border-gray-200 flex-wrap">
        {[["overview","📊 개요"],["policies","📑 보유 보험 ("+policies.length+")"],["claims","📋 청구 사례 ("+claims.length+")"],["gap","🔍 필요 보험 분석"]].map(([k,l]) => (
          <button key={k} onClick={()=>setTab(k)}
            className={`px-4 py-2 text-xs font-bold rounded-t-lg ${tab===k?"bg-blue-600 text-white":"text-gray-600 hover:bg-gray-100"}`}>{l}</button>
        ))}
      </div>

      {tab === "overview" && (
        <OverviewTab stats={stats} expiringSoon={expiringSoon} incidents={incidents} claims={claims}
          feasibilityForIncident={feasibilityForIncident}
          onCreateClaim={(incident)=>setShowClaimForm({mode:"new", incident})}/>
      )}
      {tab === "policies" && (
        <PoliciesTab policies={policies} onEdit={(id)=>setShowPolicyForm(id)} onDelete={(id)=>{
          if(confirm("이 보험 항목을 삭제하시겠습니까?")) setPolicies(arr=>arr.filter(p=>p.id!==id));
        }} onCreate={()=>setShowPolicyForm("new")}/>
      )}
      {tab === "claims" && (
        <ClaimsTab claims={claims} policies={policies} incidents={incidents}
          onEdit={(id)=>setShowClaimForm(id)} onCreate={()=>setShowClaimForm({mode:"new"})}
          onDelete={(id)=>{ if(confirm("청구 기록 삭제?")) setClaims(arr=>arr.filter(c=>c.id!==id)); }}
          onStatusChange={(id, status)=>setClaims(arr=>arr.map(c=>c.id===id?{...c,status,updatedAt:new Date().toISOString()}:c))}/>
      )}
      {tab === "gap" && (
        <GapAnalysisTab recommended={recommendedGap} owned={activePolicies} facilities={facilities}/>
      )}

      {/* 보험 폼 모달 */}
      {showPolicyForm && (
        <PolicyFormModal
          policy={showPolicyForm === "new" ? null : policies.find(p => p.id === showPolicyForm)}
          onSave={(data)=>{
            if (showPolicyForm === "new") setPolicies(arr=>[{id:uid("ip_"),...data,createdAt:new Date().toISOString()},...arr]);
            else setPolicies(arr=>arr.map(p=>p.id===showPolicyForm?{...p,...data,updatedAt:new Date().toISOString()}:p));
            setShowPolicyForm(null);
          }}
          onClose={()=>setShowPolicyForm(null)}/>
      )}
      {showClaimForm && (
        <ClaimFormModal
          claim={typeof showClaimForm === "string" ? claims.find(c => c.id === showClaimForm) : null}
          defaultIncident={typeof showClaimForm === "object" ? showClaimForm.incident : null}
          policies={activePolicies}
          incidents={incidents}
          onSave={(data)=>{
            if (typeof showClaimForm === "string") setClaims(arr=>arr.map(c=>c.id===showClaimForm?{...c,...data,updatedAt:new Date().toISOString()}:c));
            else setClaims(arr=>[{id:uid("ic_"),...data,filedAt:data.filedAt||today(),status:data.status||"filed",createdAt:new Date().toISOString()},...arr]);
            setShowClaimForm(null);
          }}
          onClose={()=>setShowClaimForm(null)}/>
      )}
    </div>
  );
}

// ─── 개요 탭 ────────────────────────────────────────────────────────
function OverviewTab({ stats, expiringSoon, incidents, claims, feasibilityForIncident, onCreateClaim }) {
  // 최근 미처리 사고 (청구 기록 없는 것)
  const claimedIncidentIds = new Set(claims.map(c => c.incidentId).filter(Boolean));
  const unclaimedIncidents = incidents.filter(i => !claimedIncidentIds.has(i.id)).slice(0, 5);

  return (
    <div className="space-y-4">
      {/* KPI 카드 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="유효 보험" value={`${stats.policyCount}건`} color="blue"/>
        <KpiCard label="총 보장한도" value={`${(stats.totalCoverage/100000000).toFixed(1)}억`} color="green"/>
        <KpiCard label="연간 보험료" value={`${(stats.totalPremium/10000).toFixed(0)}만`} color="orange"/>
        <KpiCard label="올해 청구/지급" value={`${stats.claimsThisYear}건 / ${(stats.totalPaid/10000).toFixed(0)}만`} color="purple"/>
      </div>

      {/* 만료 임박 */}
      {expiringSoon.length > 0 && (
        <div className="bg-orange-50 border-2 border-orange-300 rounded-xl p-4">
          <div className="text-sm font-black text-orange-900 mb-2">⏰ 갱신 임박 (30일 이내) — {expiringSoon.length}건</div>
          <div className="space-y-2">
            {expiringSoon.map(p => {
              const meta = INSURANCE_TYPES[p.type] || INSURANCE_TYPES.OTHER;
              const daysLeft = Math.ceil((new Date(p.periodEnd) - Date.now()) / 86400000);
              return (
                <div key={p.id} className="flex items-center gap-2 text-xs">
                  <span style={{fontSize:18}}>{meta.icon}</span>
                  <span className="font-bold flex-1">{p.policyName}</span>
                  <span className="text-orange-700 font-bold">D-{daysLeft}</span>
                  <span className="text-gray-500">~{p.periodEnd}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 미처리 사고 → 보험 처리 가능성 */}
      {unclaimedIncidents.length > 0 && (
        <div className="bg-white border-2 border-gray-200 rounded-xl p-4">
          <div className="text-sm font-black text-gray-900 mb-3">🚨 미처리 사고 — 보험 처리 가능성 분석</div>
          <div className="space-y-3">
            {unclaimedIncidents.map(inc => {
              const matches = feasibilityForIncident(inc);
              const best = matches[0];
              return (
                <div key={inc.id} className="border border-gray-200 rounded-lg p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-bold text-gray-900">{inc.title || "사고 기록"}</div>
                      <div className="text-[10px] text-gray-500 mt-0.5">{inc.date || inc.at?.slice(0,10)} · {inc.severity || "—"}</div>
                    </div>
                    {best ? (
                      <button onClick={()=>onCreateClaim(inc)}
                        className="px-3 py-1.5 text-[10px] font-bold bg-blue-600 text-white rounded">
                        📩 청구 등록
                      </button>
                    ) : (
                      <span className="text-[10px] text-gray-400">매칭 보험 없음</span>
                    )}
                  </div>
                  {matches.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {matches.slice(0,2).map(m => {
                        const meta = INSURANCE_TYPES[m.policy.type] || INSURANCE_TYPES.OTHER;
                        const confidence = m.score >= 80 ? "높음" : m.score >= 50 ? "보통" : "낮음";
                        const cColor = m.score >= 80 ? "#10b981" : m.score >= 50 ? "#f59e0b" : "#94a3b8";
                        return (
                          <div key={m.policy.id} className="flex items-center gap-2 text-[10px] bg-gray-50 px-2 py-1 rounded">
                            <span>{meta.icon}</span>
                            <span className="font-bold">{m.policy.policyName}</span>
                            <span style={{color:cColor,fontWeight:800}}>가능성 {confidence} ({m.score}pt)</span>
                            <span className="text-gray-500 flex-1 truncate">{m.reasons.join(", ")}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function KpiCard({ label, value, color }) {
  const colors = {
    blue:"bg-blue-50 border-blue-200 text-blue-900",
    green:"bg-emerald-50 border-emerald-200 text-emerald-900",
    orange:"bg-orange-50 border-orange-200 text-orange-900",
    purple:"bg-violet-50 border-violet-200 text-violet-900",
  };
  return (
    <div className={`p-3 rounded-xl border-2 ${colors[color]}`}>
      <div className="text-[10px] font-bold opacity-70">{label}</div>
      <div className="text-lg font-black mt-1">{value}</div>
    </div>
  );
}

// ─── 보험 목록 탭 ───────────────────────────────────────────────────
function PoliciesTab({ policies, onCreate, onEdit, onDelete }) {
  if (policies.length === 0) {
    return (
      <div className="text-center py-12 border-2 border-dashed rounded-xl">
        <div className="text-4xl mb-3">📑</div>
        <div className="text-sm font-bold text-gray-700">등록된 보험이 없습니다</div>
        <button onClick={onCreate} className="mt-3 px-4 py-2 bg-blue-600 text-white text-xs font-bold rounded-lg">＋ 보험 등록</button>
      </div>
    );
  }
  return (
    <div>
      <div className="flex justify-end mb-3">
        <button onClick={onCreate} className="px-4 py-2 bg-blue-600 text-white text-xs font-bold rounded-lg">＋ 보험 등록</button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {policies.map(p => {
          const meta = INSURANCE_TYPES[p.type] || INSURANCE_TYPES.OTHER;
          const isActive = !p.periodEnd || new Date(p.periodEnd) >= new Date();
          return (
            <div key={p.id} className={`border-2 rounded-xl p-4 ${isActive?"border-gray-200 bg-white":"border-gray-200 bg-gray-50 opacity-70"}`}>
              <div className="flex items-start gap-3">
                <div className="text-3xl">{meta.icon}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-black text-gray-900">{p.policyName}</span>
                    <span className="px-2 py-0.5 rounded text-[9px] font-bold text-white" style={{background:meta.color}}>{meta.label}</span>
                    {!isActive && <span className="px-2 py-0.5 rounded text-[9px] font-bold bg-red-100 text-red-700">만료</span>}
                  </div>
                  <div className="text-[10px] text-gray-500 mt-1">{p.insurer || "보험사 미입력"} · 증권 {p.policyNumber || "—"}</div>
                  <div className="mt-2 grid grid-cols-2 gap-1 text-[10px]">
                    <div><span className="text-gray-500">보장한도</span> <span className="font-bold">{p.coverage ? `${(parseInt(p.coverage)/100000000).toFixed(2)}억` : "—"}</span></div>
                    <div><span className="text-gray-500">연 보험료</span> <span className="font-bold">{p.premium ? `${(parseInt(p.premium)/10000).toFixed(0)}만` : "—"}</span></div>
                    <div><span className="text-gray-500">기간</span> <span className="font-bold">{p.periodStart?.slice(2)} ~ {p.periodEnd?.slice(2) || "—"}</span></div>
                    <div><span className="text-gray-500">자기부담</span> <span className="font-bold">{p.deductible ? `${(parseInt(p.deductible)/10000).toFixed(0)}만` : "—"}</span></div>
                  </div>
                  {meta.covers?.length > 0 && (
                    <div className="mt-2 text-[10px] text-gray-600">
                      <span className="font-bold">보장:</span> {meta.covers.join(" · ")}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex gap-2 mt-3 justify-end">
                <button onClick={()=>onEdit(p.id)} className="px-3 py-1 text-[10px] bg-gray-100 text-gray-700 font-bold rounded">수정</button>
                <button onClick={()=>onDelete(p.id)} className="px-3 py-1 text-[10px] bg-red-50 text-red-600 font-bold rounded">삭제</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── 청구 사례 탭 ──────────────────────────────────────────────────
function ClaimsTab({ claims, policies, incidents, onEdit, onCreate, onDelete, onStatusChange }) {
  return (
    <div>
      <div className="flex justify-end mb-3">
        <button onClick={onCreate} className="px-4 py-2 bg-blue-600 text-white text-xs font-bold rounded-lg">＋ 청구 등록</button>
      </div>
      {claims.length === 0 ? (
        <div className="text-center py-12 border-2 border-dashed rounded-xl">
          <div className="text-4xl mb-3">📋</div>
          <div className="text-sm font-bold text-gray-700">등록된 청구 사례가 없습니다</div>
        </div>
      ) : (
        <div className="space-y-2">
          {claims.map(c => {
            const policy = policies.find(p => p.id === c.policyId);
            const incident = incidents.find(i => i.id === c.incidentId);
            const meta = policy ? (INSURANCE_TYPES[policy.type] || INSURANCE_TYPES.OTHER) : INSURANCE_TYPES.OTHER;
            const status = CLAIM_STATUS[c.status] || CLAIM_STATUS.filed;
            return (
              <div key={c.id} className="border-2 border-gray-200 rounded-xl p-3 bg-white">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span style={{fontSize:22}}>{meta.icon}</span>
                    <div>
                      <div className="text-sm font-black">{policy?.policyName || "(미연결)"}</div>
                      <div className="text-[10px] text-gray-500">{c.claimNumber ? `#${c.claimNumber} · ` : ""}{c.filedAt} 접수</div>
                    </div>
                  </div>
                  <select value={c.status} onChange={e=>onStatusChange(c.id, e.target.value)}
                    className="px-2 py-1 text-xs font-bold rounded border" style={{borderColor:status.color,color:status.color}}>
                    {Object.entries(CLAIM_STATUS).map(([k,v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
                  </select>
                </div>
                {incident && <div className="mt-1 text-[10px] bg-red-50 px-2 py-1 rounded inline-block">🚨 연결 사고: {incident.title}</div>}
                <div className="mt-2 text-xs text-gray-700">{c.description}</div>
                <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px]">
                  <div><span className="text-gray-500">청구액</span> <div className="font-bold">{c.amountClaimed ? `${(parseInt(c.amountClaimed)/10000).toFixed(0)}만원` : "—"}</div></div>
                  <div><span className="text-gray-500">지급액</span> <div className="font-bold text-emerald-600">{c.amountPaid ? `${(parseInt(c.amountPaid)/10000).toFixed(0)}만원` : "—"}</div></div>
                  <div><span className="text-gray-500">담당 손해사정</span> <div className="font-bold">{c.adjusterName || "—"}</div></div>
                  <div><span className="text-gray-500">연락처</span> <div className="font-bold">{c.adjusterPhone || "—"}</div></div>
                </div>
                <div className="flex gap-2 mt-3 justify-end">
                  <button onClick={()=>onEdit(c.id)} className="px-3 py-1 text-[10px] bg-gray-100 text-gray-700 font-bold rounded">수정</button>
                  <button onClick={()=>onDelete(c.id)} className="px-3 py-1 text-[10px] bg-red-50 text-red-600 font-bold rounded">삭제</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── 필요 보험 분석 탭 ─────────────────────────────────────────────
function GapAnalysisTab({ recommended, owned, facilities }) {
  return (
    <div className="space-y-4">
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-xs text-blue-900">
        💡 한국잠사박물관 운영 특성(체험·전시·야외시설·셔틀·식당·동물)을 고려한 필수 보험 권장 목록입니다. 보유 보험 외 권장되는 보험을 표시합니다.
      </div>

      <div>
        <div className="text-sm font-black text-gray-900 mb-2">✅ 보유 중인 핵심 보험 ({owned.length})</div>
        <div className="flex gap-2 flex-wrap">
          {owned.length === 0 && <span className="text-xs text-gray-400">등록된 보험 없음</span>}
          {owned.map(p => {
            const meta = INSURANCE_TYPES[p.type] || INSURANCE_TYPES.OTHER;
            return (
              <span key={p.id} className="px-3 py-1.5 rounded-full text-[11px] font-bold flex items-center gap-1" style={{background:meta.color+"22",color:meta.color}}>
                {meta.icon} {meta.label}
              </span>
            );
          })}
        </div>
      </div>

      <div>
        <div className="text-sm font-black text-gray-900 mb-2">🔍 권장되는 필요 보험 ({recommended.length})</div>
        {recommended.length === 0 ? (
          <div className="bg-emerald-50 border border-emerald-300 rounded-xl p-4 text-sm text-emerald-900 font-bold">
            ✅ 필수 보험을 모두 보유하고 있습니다.
          </div>
        ) : (
          <div className="space-y-2">
            {recommended.map(r => (
              <div key={r.type} className="border-2 border-orange-200 bg-orange-50 rounded-xl p-3">
                <div className="flex items-center gap-3">
                  <span style={{fontSize:28}}>{r.icon}</span>
                  <div className="flex-1">
                    <div className="text-sm font-black text-orange-900">{r.label}</div>
                    <div className="text-[10px] text-orange-700 mt-0.5">보장 범위: {r.covers.join(" · ")}</div>
                  </div>
                  <span className="px-2 py-0.5 rounded text-[9px] font-bold bg-orange-600 text-white">권장</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 text-[11px] text-gray-700 leading-relaxed">
        <div className="font-bold mb-1">💡 박물관/체험시설 필수 보험 (참고):</div>
        <ul className="list-disc pl-5 space-y-1">
          <li><strong>영업배상책임</strong> — 방문객 사고, 시설 이용 중 부상 (가장 우선순위 높음)</li>
          <li><strong>화재보험</strong> — 전시품/건물 화재 (재산 보호 핵심)</li>
          <li><strong>근로자재해</strong> — 직원 업무중 부상 (산재 외 추가 보장)</li>
          <li><strong>시설소유관리자배상</strong> — 시설 결함 사고 (구조물 노후화 대응)</li>
          <li><strong>단체상해</strong> — 체험 프로그램 단체 손님 (학교 단체 등)</li>
        </ul>
      </div>
    </div>
  );
}

// ─── 보험 등록/수정 모달 ───────────────────────────────────────────
function PolicyFormModal({ policy, onSave, onClose }) {
  const [form, setForm] = useState(policy || { type:"LIABILITY", policyName:"", insurer:"", policyNumber:"", coverage:"", deductible:"", premium:"", periodStart:today(), periodEnd:"", beneficiary:"", contactPhone:"", notes:"" });
  const set = (k,v) => setForm(f => ({...f, [k]:v}));
  return (
    <ModalShell title={policy?"보험 수정":"＋ 새 보험 등록"} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label="보험 종류">
            <select value={form.type} onChange={e=>set("type",e.target.value)} className="w-full px-2 py-1.5 border rounded text-xs">
              {Object.entries(INSURANCE_TYPES).map(([k,v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
            </select>
          </Field>
          <Field label="보험 상품명 *"><Inp value={form.policyName} onChange={v=>set("policyName",v)} placeholder="예: 잠사박물관 영업배상책임"/></Field>
          <Field label="보험사"><Inp value={form.insurer} onChange={v=>set("insurer",v)} placeholder="예: 삼성화재"/></Field>
          <Field label="증권번호"><Inp value={form.policyNumber} onChange={v=>set("policyNumber",v)}/></Field>
          <Field label="보장한도 (원)"><Inp type="number" value={form.coverage} onChange={v=>set("coverage",v)} placeholder="100000000"/></Field>
          <Field label="자기부담금 (원)"><Inp type="number" value={form.deductible} onChange={v=>set("deductible",v)} placeholder="500000"/></Field>
          <Field label="연 보험료 (원)"><Inp type="number" value={form.premium} onChange={v=>set("premium",v)} placeholder="1200000"/></Field>
          <Field label=""><span></span></Field>
          <Field label="시작일"><Inp type="date" value={form.periodStart} onChange={v=>set("periodStart",v)}/></Field>
          <Field label="만료일"><Inp type="date" value={form.periodEnd} onChange={v=>set("periodEnd",v)}/></Field>
          <Field label="피보험자"><Inp value={form.beneficiary} onChange={v=>set("beneficiary",v)} placeholder="(주)한국잠사플레이팜"/></Field>
          <Field label="담당자 연락처"><Inp value={form.contactPhone} onChange={v=>set("contactPhone",v)} placeholder="010-1234-5678"/></Field>
        </div>
        <Field label="메모"><textarea value={form.notes} onChange={e=>set("notes",e.target.value)} rows={2} className="w-full px-2 py-1.5 border rounded text-xs"/></Field>
      </div>
      <div className="flex gap-2 justify-end mt-4 pt-3 border-t">
        <button onClick={onClose} className="px-4 py-2 text-xs bg-gray-100 rounded font-bold">취소</button>
        <button onClick={()=>{ if(!form.policyName.trim()) return alert("보험 상품명 필수"); onSave(form); }}
          className="px-4 py-2 text-xs bg-blue-600 text-white rounded font-bold">저장</button>
      </div>
    </ModalShell>
  );
}

// ─── 청구 등록/수정 모달 ────────────────────────────────────────────
function ClaimFormModal({ claim, defaultIncident, policies, incidents, onSave, onClose }) {
  const [form, setForm] = useState(claim || {
    policyId: policies[0]?.id || "",
    incidentId: defaultIncident?.id || "",
    claimNumber: "", filedAt: today(), status: "filed",
    amountClaimed: "", amountPaid: "", payoutDate: "",
    description: defaultIncident ? `[연결 사고] ${defaultIncident.title || ""}\n${defaultIncident.description || ""}` : "",
    adjusterName: "", adjusterPhone: "",
  });
  const set = (k,v) => setForm(f => ({...f,[k]:v}));
  return (
    <ModalShell title={claim?"청구 수정":"＋ 청구 사례 등록"} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label="연결 보험 *">
            <select value={form.policyId} onChange={e=>set("policyId",e.target.value)} className="w-full px-2 py-1.5 border rounded text-xs">
              <option value="">선택...</option>
              {policies.map(p => <option key={p.id} value={p.id}>{INSURANCE_TYPES[p.type]?.icon} {p.policyName}</option>)}
            </select>
          </Field>
          <Field label="연결 사고">
            <select value={form.incidentId} onChange={e=>set("incidentId",e.target.value)} className="w-full px-2 py-1.5 border rounded text-xs">
              <option value="">(직접 입력)</option>
              {incidents.map(i => <option key={i.id} value={i.id}>{i.title || i.id}</option>)}
            </select>
          </Field>
          <Field label="청구번호"><Inp value={form.claimNumber} onChange={v=>set("claimNumber",v)}/></Field>
          <Field label="접수일"><Inp type="date" value={form.filedAt} onChange={v=>set("filedAt",v)}/></Field>
          <Field label="청구액 (원)"><Inp type="number" value={form.amountClaimed} onChange={v=>set("amountClaimed",v)}/></Field>
          <Field label="지급액 (원)"><Inp type="number" value={form.amountPaid} onChange={v=>set("amountPaid",v)}/></Field>
          <Field label="지급일"><Inp type="date" value={form.payoutDate} onChange={v=>set("payoutDate",v)}/></Field>
          <Field label="진행상태">
            <select value={form.status} onChange={e=>set("status",e.target.value)} className="w-full px-2 py-1.5 border rounded text-xs">
              {Object.entries(CLAIM_STATUS).map(([k,v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
            </select>
          </Field>
          <Field label="손해사정사 이름"><Inp value={form.adjusterName} onChange={v=>set("adjusterName",v)}/></Field>
          <Field label="손해사정사 연락처"><Inp value={form.adjusterPhone} onChange={v=>set("adjusterPhone",v)}/></Field>
        </div>
        <Field label="사건 설명"><textarea value={form.description} onChange={e=>set("description",e.target.value)} rows={3} className="w-full px-2 py-1.5 border rounded text-xs"/></Field>
      </div>
      <div className="flex gap-2 justify-end mt-4 pt-3 border-t">
        <button onClick={onClose} className="px-4 py-2 text-xs bg-gray-100 rounded font-bold">취소</button>
        <button onClick={()=>{ if(!form.policyId) return alert("연결 보험 선택 필수"); onSave(form); }}
          className="px-4 py-2 text-xs bg-blue-600 text-white rounded font-bold">저장</button>
      </div>
    </ModalShell>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// 📅 SAFETY CALENDAR PAGE
// ═══════════════════════════════════════════════════════════════════════
export const EVENT_TYPES = {
  inspection:    { label:"점검", color:"#3b82f6", icon:"🔍" },
  training:      { label:"교육", color:"#10b981", icon:"📚" },
  drill:         { label:"훈련", color:"#f59e0b", icon:"🚨" },
  maintenance:   { label:"정비", color:"#8b5cf6", icon:"🔧" },
  external_audit:{ label:"외부감사", color:"#dc2626", icon:"📋" },
  review:        { label:"검토회의", color:"#0891b2", icon:"💼" },
  other:         { label:"기타", color:"#64748b", icon:"📌" },
};

export function SafetyCalendarPage({ facilities = [], curUser, weatherAlerts = [] }) {
  const [events, setEvents] = useState(load(STORAGE.calendar));
  useEffect(() => save(STORAGE.calendar, events), [events]);

  const [viewMonth, setViewMonth] = useState(() => {
    const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [showForm, setShowForm] = useState(null); // null | {date} | id
  const [selectedDay, setSelectedDay] = useState(today());

  const monthEvents = useMemo(() => {
    const m = String(viewMonth.month + 1).padStart(2, "0");
    const prefix = `${viewMonth.year}-${m}`;
    return events.filter(e => e.date?.startsWith(prefix));
  }, [events, viewMonth]);

  const dayEvents = useMemo(() => events.filter(e => e.date === selectedDay), [events, selectedDay]);

  // 캘린더 그리드 생성
  const grid = useMemo(() => {
    const firstDay = new Date(viewMonth.year, viewMonth.month, 1);
    const lastDay = new Date(viewMonth.year, viewMonth.month + 1, 0);
    const startWeekday = firstDay.getDay();
    const totalDays = lastDay.getDate();
    const cells = [];
    for (let i = 0; i < startWeekday; i++) cells.push(null);
    for (let d = 1; d <= totalDays; d++) {
      const dateStr = `${viewMonth.year}-${String(viewMonth.month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
      cells.push({ day: d, date: dateStr, events: monthEvents.filter(e => e.date === dateStr) });
    }
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [viewMonth, monthEvents]);

  const isToday = (date) => date === today();

  const upsertEvent = (data) => {
    if (data.id) setEvents(arr => arr.map(e => e.id === data.id ? {...e, ...data, updatedAt: new Date().toISOString()} : e));
    else setEvents(arr => [{id:uid("ev_"), createdAt:new Date().toISOString(), ...data}, ...arr]);
  };
  const deleteEvent = (id) => { if(confirm("삭제?")) setEvents(arr => arr.filter(e => e.id !== id)); };
  const completeEvent = (id) => setEvents(arr => arr.map(e => e.id === id ? {...e, status:"completed", completedAt:new Date().toISOString()} : e));

  // 통계
  const stats = useMemo(() => {
    const scheduled = monthEvents.filter(e => e.status !== "completed" && e.status !== "cancelled").length;
    const completed = monthEvents.filter(e => e.status === "completed").length;
    const overdue = monthEvents.filter(e => e.status !== "completed" && e.status !== "cancelled" && e.date < today()).length;
    return { scheduled, completed, overdue, total: monthEvents.length };
  }, [monthEvents]);

  return (
    <div className="space-y-4">
      <div className="bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-200 rounded-xl p-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-base font-black text-emerald-900">📅 안전관리 캘린더</h2>
            <div className="text-xs text-emerald-700 mt-1">점검·교육·훈련 일정을 월간 캘린더로 관리합니다. 날씨 변동 시 위험 표시 자동 반영.</div>
          </div>
          <div className="flex gap-2 text-xs">
            <Kpi v={stats.scheduled} label="예정"/>
            <Kpi v={stats.completed} label="완료"/>
            <Kpi v={stats.overdue} label="지연" color={stats.overdue>0?"red":"gray"}/>
          </div>
        </div>
      </div>

      {/* 월 네비 */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2 items-center">
          <button onClick={()=>setViewMonth(m => m.month===0?{year:m.year-1,month:11}:{year:m.year,month:m.month-1})}
            className="px-3 py-1.5 bg-white border rounded font-bold">←</button>
          <div className="text-base font-black px-3">{viewMonth.year}년 {viewMonth.month+1}월</div>
          <button onClick={()=>setViewMonth(m => m.month===11?{year:m.year+1,month:0}:{year:m.year,month:m.month+1})}
            className="px-3 py-1.5 bg-white border rounded font-bold">→</button>
          <button onClick={()=>{ const d=new Date(); setViewMonth({year:d.getFullYear(),month:d.getMonth()}); setSelectedDay(today()); }}
            className="px-3 py-1.5 bg-blue-50 text-blue-700 border border-blue-300 rounded text-xs font-bold">오늘</button>
        </div>
        <button onClick={()=>setShowForm({mode:"new", date:selectedDay})}
          className="px-4 py-2 bg-emerald-600 text-white text-xs font-bold rounded-lg">＋ 일정 추가</button>
      </div>

      {/* 캘린더 그리드 */}
      <div className="bg-white border-2 border-gray-200 rounded-xl overflow-hidden">
        <div className="grid grid-cols-7 bg-gray-50 border-b">
          {["일","월","화","수","목","금","토"].map((d,i) => (
            <div key={d} className={`p-2 text-center text-xs font-bold ${i===0?"text-red-600":i===6?"text-blue-600":"text-gray-600"}`}>{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {grid.map((cell, i) => {
            if (!cell) return <div key={i} className="min-h-[90px] border-r border-b bg-gray-50"/>;
            const selected = cell.date === selectedDay;
            const todayCls = isToday(cell.date);
            const dow = (i % 7);
            return (
              <div key={cell.date}
                onClick={()=>setSelectedDay(cell.date)}
                className={`min-h-[90px] border-r border-b p-1.5 cursor-pointer transition ${selected?"bg-blue-50":"bg-white hover:bg-gray-50"}`}>
                <div className={`text-xs font-bold mb-1 ${todayCls?"text-blue-600":dow===0?"text-red-600":dow===6?"text-blue-600":"text-gray-700"}`}>
                  {cell.day}{todayCls && <span className="ml-1 px-1 py-0.5 bg-blue-600 text-white rounded text-[8px]">오늘</span>}
                </div>
                <div className="space-y-0.5">
                  {cell.events.slice(0,3).map(e => {
                    const meta = EVENT_TYPES[e.type] || EVENT_TYPES.other;
                    return (
                      <div key={e.id}
                        onClick={(ev)=>{ev.stopPropagation();setShowForm(e.id);}}
                        className="text-[9px] px-1 py-0.5 rounded truncate font-bold cursor-pointer"
                        style={{background:meta.color+"22",color:meta.color,textDecoration:e.status==="completed"?"line-through":"none",opacity:e.status==="completed"?0.5:1}}>
                        {meta.icon} {e.title}
                      </div>
                    );
                  })}
                  {cell.events.length > 3 && <div className="text-[8px] text-gray-500">+{cell.events.length-3}개 더</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 선택일 상세 */}
      <div className="bg-white border-2 border-gray-200 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-black">📌 {selectedDay} 일정 ({dayEvents.length})</div>
          <button onClick={()=>setShowForm({mode:"new", date:selectedDay})}
            className="px-3 py-1 bg-emerald-600 text-white text-[10px] font-bold rounded">＋ 추가</button>
        </div>
        {dayEvents.length === 0 ? (
          <div className="text-center py-6 text-xs text-gray-400">이 날짜에 등록된 일정이 없습니다</div>
        ) : (
          <div className="space-y-2">
            {dayEvents.map(e => {
              const meta = EVENT_TYPES[e.type] || EVENT_TYPES.other;
              const fac = facilities.find(f => f.id === e.facId);
              return (
                <div key={e.id} className="border rounded-lg p-2.5 flex items-start gap-2" style={{borderColor:meta.color+"55",background:meta.color+"08"}}>
                  <span style={{fontSize:20}}>{meta.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-black" style={{textDecoration:e.status==="completed"?"line-through":"none"}}>
                      {e.title}
                      <span className="ml-2 text-[9px] px-1.5 py-0.5 rounded" style={{background:meta.color,color:"#fff"}}>{meta.label}</span>
                      {e.status === "completed" && <span className="ml-1 text-[9px] px-1.5 py-0.5 bg-emerald-600 text-white rounded">완료</span>}
                    </div>
                    {(e.time || e.assignee || fac) && (
                      <div className="text-[10px] text-gray-600 mt-0.5">
                        {e.time && <>⏰ {e.time} </>}
                        {fac && <>📍 {fac.name} </>}
                        {e.assignee && <>👤 {e.assignee}</>}
                      </div>
                    )}
                    {e.description && <div className="text-[10px] text-gray-500 mt-1">{e.description}</div>}
                  </div>
                  <div className="flex flex-col gap-1">
                    {e.status !== "completed" && (
                      <button onClick={()=>completeEvent(e.id)} className="px-2 py-0.5 text-[9px] bg-emerald-600 text-white rounded font-bold">✓ 완료</button>
                    )}
                    <button onClick={()=>setShowForm(e.id)} className="px-2 py-0.5 text-[9px] bg-gray-100 rounded font-bold">수정</button>
                    <button onClick={()=>deleteEvent(e.id)} className="px-2 py-0.5 text-[9px] bg-red-50 text-red-600 rounded font-bold">🗑️</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showForm && (
        <EventFormModal
          event={typeof showForm === "string" ? events.find(e => e.id === showForm) : null}
          defaultDate={typeof showForm === "object" ? showForm.date : null}
          facilities={facilities} curUser={curUser}
          onSave={(data)=>{ upsertEvent({...data, id: typeof showForm === "string" ? showForm : undefined}); setShowForm(null); }}
          onClose={()=>setShowForm(null)}/>
      )}
    </div>
  );
}

function Kpi({ v, label, color="emerald" }) {
  const bg = { emerald:"bg-emerald-50 text-emerald-900 border-emerald-200", red:"bg-red-50 text-red-900 border-red-200", gray:"bg-gray-50 text-gray-700 border-gray-200" }[color] || "bg-gray-50 text-gray-700 border-gray-200";
  return <div className={`px-3 py-1.5 border rounded-lg ${bg}`}><span className="font-black">{v}</span> <span className="text-[10px]">{label}</span></div>;
}

function EventFormModal({ event, defaultDate, facilities, curUser, onSave, onClose }) {
  const [form, setForm] = useState(event || {
    date: defaultDate || today(),
    time: "10:00", duration: 60,
    type: "inspection",
    title: "", description: "",
    assignee: curUser?.name || "", facId: "",
    reminder: 60, recurring: "none", recurringUntil: "",
    status: "scheduled",
  });
  const set = (k,v) => setForm(f => ({...f,[k]:v}));
  return (
    <ModalShell title={event?"일정 수정":"＋ 새 일정 추가"} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label="날짜 *"><Inp type="date" value={form.date} onChange={v=>set("date",v)}/></Field>
          <Field label="시간"><Inp type="time" value={form.time} onChange={v=>set("time",v)}/></Field>
          <Field label="유형">
            <select value={form.type} onChange={e=>set("type",e.target.value)} className="w-full px-2 py-1.5 border rounded text-xs">
              {Object.entries(EVENT_TYPES).map(([k,v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
            </select>
          </Field>
          <Field label="시간(분)"><Inp type="number" value={form.duration} onChange={v=>set("duration",v)}/></Field>
        </div>
        <Field label="제목 *"><Inp value={form.title} onChange={v=>set("title",v)} placeholder="예: 누에과학관 월간 안전점검"/></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="담당자"><Inp value={form.assignee} onChange={v=>set("assignee",v)}/></Field>
          <Field label="장소(시설)">
            <select value={form.facId} onChange={e=>set("facId",e.target.value)} className="w-full px-2 py-1.5 border rounded text-xs">
              <option value="">선택...</option>
              {facilities.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </Field>
          <Field label="반복">
            <select value={form.recurring} onChange={e=>set("recurring",e.target.value)} className="w-full px-2 py-1.5 border rounded text-xs">
              <option value="none">없음</option>
              <option value="weekly">매주</option>
              <option value="monthly">매월</option>
              <option value="quarterly">매 분기</option>
              <option value="yearly">매년</option>
            </select>
          </Field>
          <Field label="알림 (분 전)">
            <select value={form.reminder} onChange={e=>set("reminder",Number(e.target.value))} className="w-full px-2 py-1.5 border rounded text-xs">
              <option value="0">없음</option>
              <option value="15">15분 전</option>
              <option value="60">1시간 전</option>
              <option value="1440">하루 전</option>
            </select>
          </Field>
        </div>
        <Field label="설명"><textarea value={form.description} onChange={e=>set("description",e.target.value)} rows={2} className="w-full px-2 py-1.5 border rounded text-xs"/></Field>
      </div>
      <div className="flex gap-2 justify-end mt-4 pt-3 border-t">
        <button onClick={onClose} className="px-4 py-2 text-xs bg-gray-100 rounded font-bold">취소</button>
        <button onClick={()=>{
          if (!form.title.trim()) return alert("제목 필수");
          // 반복 일정이면 12개월 미리 펼쳐서 저장
          if (form.recurring !== "none" && !form.id) {
            const occurrences = expandRecurring(form);
            occurrences.forEach(o => onSave(o));
          } else {
            onSave(form);
          }
        }}
          className="px-4 py-2 text-xs bg-emerald-600 text-white rounded font-bold">저장</button>
      </div>
    </ModalShell>
  );
}

function expandRecurring(form) {
  const out = [{ ...form }];
  const start = new Date(form.date);
  const step = { weekly: 7, monthly: 30, quarterly: 90, yearly: 365 }[form.recurring];
  if (!step) return out;
  for (let i = 1; i < 12; i++) {
    const d = new Date(start.getTime() + step * 86400000 * i);
    const date = d.toISOString().slice(0,10);
    out.push({ ...form, date, recurring: "none" }); // 펼친 인스턴스는 단발
  }
  return out;
}

// ─── 공용 모달 셸/필드 ────────────────────────────────────────────
function ModalShell({ title, children, onClose }) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.55)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:14}}>
      <div style={{background:"#fff",borderRadius:12,padding:18,maxWidth:560,width:"100%",maxHeight:"90vh",overflowY:"auto",boxShadow:"0 25px 60px rgba(0,0,0,0.3)"}}>
        <div className="flex justify-between items-center mb-3">
          <h3 className="text-sm font-black">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
function Field({ label, children }) {
  return <div><label className="block text-[10px] font-bold text-gray-500 mb-1">{label}</label>{children}</div>;
}
function Inp({ value, onChange, placeholder, type="text" }) {
  return <input type={type} value={value||""} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
    className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs"/>;
}
