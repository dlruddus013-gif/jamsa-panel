// product-intelligence.jsx
// 제품 인텔리전스 — 사진/AI분석/연락이력/품의/절감/담당자 통합 누적 히스토리
//
// 기능:
//  1. 사진 업로드 시 AI 자동 분석 (최저가/관리요령/원가)
//  2. 담당자·판매자 등록 (연락처 포함)
//  3. 통화/카톡 내용 텍스트 + 스크린샷/파일 첨부
//  4. 기존 품의서를 제품ID로 자동 연결 (날짜순)
//  5. 지출 절감 메모/항목 누적
//  6. 모든 이벤트를 날짜순 통합 타임라인으로 표시
//
// 데이터: localStorage(jamsa_product_intel) = { [prodId]: { stakeholders, comms, savings, aiCache, customEvents } }
// 활동로그(addH 결과)·품의(requisitions)는 props로 받아 머지.

import React, { useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "jamsa_product_intel";

function loadAll() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
  catch (e) { return {}; }
}
function saveAll(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) {}
}

function getIntel(prodId) {
  const all = loadAll();
  return all[prodId] || {
    stakeholders: { manager: null, seller: null },  // {name, role, phone, email, kakao, memo}
    comms: [],         // {id, at, kind:"call|kakao|email|memo", direction:"in|out", with:"manager|seller|other", subject, text, attachments:[{type,name,dataUrl}], by}
    savings: [],       // {id, at, title, amount, reason, by}
    aiCache: null,     // {at, lowestPrice, care, cost}
    customEvents: [],  // {id, at, type, title, desc, by}
    lastUpdated: null,
  };
}
function setIntel(prodId, patch) {
  const all = loadAll();
  all[prodId] = { ...getIntel(prodId), ...patch, lastUpdated: new Date().toISOString() };
  saveAll(all);
  return all[prodId];
}

// ─── 메인 모달 ─────────────────────────────────────────────────────
export function ProductIntelligenceModal({ product, hist = [], requisitions = [], payments = [], curUser, onClose, onTriggerAI }) {
  const [intel, setIntelState] = useState(() => getIntel(product.id));
  const [tab, setTab] = useState("timeline");

  const update = (patch) => setIntelState(setIntel(product.id, patch));

  // 이 제품 관련 활동로그
  const productHist = useMemo(() => hist.filter(h => h.pn === product.name), [hist, product.name]);
  // 이 제품 관련 품의서
  const productReqs = useMemo(() => {
    return requisitions.filter(r => {
      if (r.productId === product.id) return true;
      if (r.productName === product.name) return true;
      if (Array.isArray(r.items) && r.items.some(it => it.productId === product.id || it.name === product.name)) return true;
      return false;
    });
  }, [requisitions, product]);
  // 이 제품 관련 결제
  const productPayments = useMemo(() => {
    return payments.filter(p => p.productId === product.id || p.productName === product.name);
  }, [payments, product]);

  // 통합 타임라인 생성 (모든 이벤트 날짜순)
  const timeline = useMemo(() => {
    const events = [];
    productHist.forEach(h => events.push({
      kind: "hist", at: h.date, icon: actIcon(h.act), title: `[${h.act}] ${h.det || ""}`,
      sub: `${h.user || "시스템"}${h.q ? ` · 수량 ${h.q}` : ""}`,
      color: actColor(h.act),
    }));
    productReqs.forEach(r => events.push({
      kind: "req", at: r.createdAt || r.date, icon: "📝", title: `품의: ${r.title || r.itemName || "(제목 없음)"}`,
      sub: `${r.status || "작성"} · ${r.amount ? r.amount.toLocaleString() + "원" : ""} · ${r.requester || ""}`,
      color: "#f59e0b", raw: r,
    }));
    productPayments.forEach(p => events.push({
      kind: "pay", at: p.date || p.paidAt, icon: "💳", title: `결제: ${p.method || "—"} ${p.amount ? p.amount.toLocaleString() + "원" : ""}`,
      sub: `${p.vendor || ""} · ${p.memo || ""}`,
      color: "#06b6d4",
    }));
    (intel.comms || []).forEach(c => events.push({
      kind: "comm", at: c.at, icon: commIcon(c.kind), title: `${commLabel(c.kind)} ${c.direction==="in"?"수신":c.direction==="out"?"발신":""}: ${c.subject || "(제목 없음)"}`,
      sub: `${c.with === "manager" ? "담당자" : c.with === "seller" ? "판매자" : "기타"} · ${c.text?.slice(0,60) || ""}`,
      color: "#8b5cf6", raw: c,
    }));
    (intel.savings || []).forEach(s => events.push({
      kind: "saving", at: s.at, icon: "💰", title: `절감: ${s.title}${s.amount ? ` (-${s.amount.toLocaleString()}원)` : ""}`,
      sub: s.reason || "",
      color: "#10b981", raw: s,
    }));
    (intel.customEvents || []).forEach(e => events.push({
      kind: "custom", at: e.at, icon: "📌", title: e.title, sub: e.desc, color: "#475569", raw: e,
    }));
    if (intel.aiCache?.at) events.push({
      kind: "ai", at: intel.aiCache.at, icon: "🤖", title: "AI 분석 실행", sub: "최저가/관리/원가 갱신", color: "#7c3aed",
    });
    return events.sort((a,b) => String(b.at||"").localeCompare(String(a.at||"")));
  }, [productHist, productReqs, productPayments, intel]);

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.7)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:14}}>
      <div style={{background:"#fff",borderRadius:14,maxWidth:1000,width:"100%",maxHeight:"94vh",display:"flex",flexDirection:"column"}}>
        {/* 헤더 */}
        <div style={{padding:"14px 18px",background:"linear-gradient(135deg,#5b21b6,#3b82f6)",color:"#fff",borderRadius:"14px 14px 0 0",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
          <div>
            <h2 style={{fontSize:16,fontWeight:900,margin:0}}>🧠 {product.name} — 통합 인텔리전스</h2>
            <div style={{fontSize:11,opacity:0.9,marginTop:3}}>
              [{product.code}] · {product.cat} · {product.loc} · 재고 {product.qty} · 누적 이벤트 {timeline.length}건
            </div>
          </div>
          <button onClick={onClose} style={{background:"rgba(255,255,255,0.2)",border:"none",color:"#fff",fontSize:18,padding:"4px 12px",borderRadius:6,cursor:"pointer"}}>✕</button>
        </div>

        {/* 탭 */}
        <div style={{padding:"6px 14px",borderBottom:"1px solid #e5e7eb",display:"flex",gap:4,flexShrink:0,overflowX:"auto"}}>
          {[
            {id:"timeline",label:`📜 통합 타임라인 (${timeline.length})`},
            {id:"ai",label:"🤖 AI 분석"},
            {id:"people",label:"👤 담당자·판매자"},
            {id:"comms",label:`💬 통화·카톡 (${(intel.comms||[]).length})`},
            {id:"savings",label:`💰 절감 (${(intel.savings||[]).length})`},
            {id:"req",label:`📝 품의서 (${productReqs.length})`},
          ].map(t => (
            <button key={t.id} onClick={()=>setTab(t.id)}
              style={{padding:"7px 12px",background:tab===t.id?"#7c3aed":"transparent",color:tab===t.id?"#fff":"#475569",border:"none",borderRadius:6,fontWeight:700,fontSize:11,cursor:"pointer",whiteSpace:"nowrap"}}>
              {t.label}
            </button>
          ))}
        </div>

        {/* 본문 */}
        <div style={{flex:1,overflowY:"auto",padding:16,background:"#fafbfc"}}>
          {tab==="timeline" && <TimelineTab events={timeline} product={product}/>}
          {tab==="ai" && <AIAnalysisTab product={product} intel={intel} update={update} onTriggerAI={onTriggerAI}/>}
          {tab==="people" && <PeopleTab intel={intel} update={update}/>}
          {tab==="comms" && <CommsTab intel={intel} update={update} curUser={curUser}/>}
          {tab==="savings" && <SavingsTab intel={intel} update={update} curUser={curUser}/>}
          {tab==="req" && <RequisitionTab reqs={productReqs} payments={productPayments}/>}
        </div>
      </div>
    </div>
  );
}

// ─── 탭: 통합 타임라인 ──────────────────────────────────────────────
function TimelineTab({ events, product }) {
  if (events.length === 0) {
    return (
      <div style={{textAlign:"center",padding:40,color:"#94a3b8"}}>
        <div style={{fontSize:48,marginBottom:8}}>📭</div>
        <div style={{fontSize:13,fontWeight:700}}>아직 누적된 이벤트가 없습니다</div>
        <div style={{fontSize:11,marginTop:4}}>다른 탭에서 담당자/통화/AI분석 등을 추가하면 여기에 표시됩니다</div>
      </div>
    );
  }

  // 날짜별 그룹화
  const groups = {};
  events.forEach(e => {
    const d = String(e.at || "").slice(0,10) || "미상";
    if (!groups[d]) groups[d] = [];
    groups[d].push(e);
  });
  const dates = Object.keys(groups).sort((a,b)=>b.localeCompare(a));

  return (
    <div>
      <div style={{padding:10,background:"#eff6ff",border:"1px solid #bfdbfe",borderRadius:8,fontSize:11,color:"#1e40af",marginBottom:12}}>
        💡 <strong>처음 보시나요?</strong> 이 제품의 모든 이력(입출고·품의·통화·AI분석·절감·결제)이 날짜순으로 누적됩니다.
        총 {events.length}건 · 최초 {String(events[events.length-1]?.at||"").slice(0,10)} ~ 최신 {String(events[0]?.at||"").slice(0,10)}
      </div>
      {dates.map(d => (
        <div key={d} style={{marginBottom:14}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
            <div style={{padding:"3px 10px",background:"#0f172a",color:"#fff",borderRadius:12,fontSize:11,fontWeight:800}}>{d}</div>
            <div style={{flex:1,height:1,background:"#e5e7eb"}}/>
            <span style={{fontSize:10,color:"#94a3b8"}}>{groups[d].length}건</span>
          </div>
          {groups[d].map((e, i) => (
            <div key={i} style={{display:"flex",gap:10,padding:"8px 10px",background:"#fff",border:"1px solid #e5e7eb",borderRadius:6,marginBottom:4}}>
              <span style={{fontSize:18}}>{e.icon}</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12,fontWeight:700,color:e.color}}>{e.title}</div>
                {e.sub && <div style={{fontSize:10,color:"#64748b",marginTop:2}}>{e.sub}</div>}
              </div>
              <div style={{fontSize:9,color:"#94a3b8",alignSelf:"flex-start"}}>{String(e.at||"").slice(11,16)}</div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ─── 탭: AI 분석 ───────────────────────────────────────────────────
function AIAnalysisTab({ product, intel, update, onTriggerAI }) {
  const [busy, setBusy] = useState(false);
  const cache = intel.aiCache;

  const runAnalysis = async () => {
    if (!product.photos?.length && !product.name) { alert("사진 또는 이름이 필요합니다."); return; }
    setBusy(true);
    try {
      let result = null;
      if (onTriggerAI) result = await onTriggerAI(product);
      if (!result) {
        // 폴백: 룰 기반 추정
        result = ruleFallback(product);
      }
      update({ aiCache: { ...result, at: new Date().toISOString() } });
      alert("✅ AI 분석 완료");
    } catch (e) {
      alert("❌ 분석 실패: " + e.message);
    } finally { setBusy(false); }
  };

  return (
    <div style={{display:"flex",flexDirection:"column",gap:12}}>
      <div style={{display:"flex",alignItems:"center",gap:8,padding:12,background:"#fff",border:"1px solid #e5e7eb",borderRadius:8}}>
        <span style={{fontSize:24}}>🤖</span>
        <div style={{flex:1}}>
          <div style={{fontSize:13,fontWeight:800}}>Claude AI 기반 자동 분석</div>
          <div style={{fontSize:11,color:"#64748b"}}>최저가 비교 · 관리요령 · 원가 분석을 한 번에</div>
        </div>
        <button onClick={runAnalysis} disabled={busy}
          style={{padding:"8px 16px",background:"linear-gradient(135deg,#7c3aed,#3b82f6)",color:"#fff",border:"none",borderRadius:6,fontWeight:700,fontSize:12,cursor:busy?"wait":"pointer",opacity:busy?0.7:1}}>
          {busy ? "⏳ 분석 중..." : "🚀 분석 실행"}
        </button>
      </div>

      {!cache && (
        <div style={{padding:30,textAlign:"center",background:"#fff",border:"1px dashed #cbd5e1",borderRadius:8,color:"#94a3b8"}}>
          <div style={{fontSize:36,marginBottom:6}}>🧪</div>
          <div style={{fontSize:12}}>분석을 실행하면 여기에 결과가 표시됩니다.</div>
        </div>
      )}

      {cache && (
        <>
          <div style={{fontSize:10,color:"#64748b",textAlign:"right"}}>
            마지막 분석: {new Date(cache.at).toLocaleString("ko-KR")}
          </div>

          <AICard icon="💰" title="최저가 비교 분석" color="#dc2626" bg="#fef2f2" content={cache.lowestPrice}/>
          <AICard icon="🧹" title="관리 요령" color="#10b981" bg="#dcfce7" content={cache.care}/>
          <AICard icon="📊" title="원가 분석" color="#3b82f6" bg="#dbeafe" content={cache.cost}/>
        </>
      )}
    </div>
  );
}

function AICard({ icon, title, color, bg, content }) {
  if (!content) return null;
  return (
    <div style={{padding:12,background:bg,border:`1px solid ${color}33`,borderRadius:8}}>
      <div style={{fontSize:12,fontWeight:800,color,marginBottom:6}}>{icon} {title}</div>
      {typeof content === "string" ? (
        <div style={{fontSize:11,color:"#0f172a",whiteSpace:"pre-wrap",lineHeight:1.5}}>{content}</div>
      ) : Array.isArray(content) ? (
        <ul style={{margin:0,paddingLeft:18,fontSize:11,color:"#0f172a",lineHeight:1.7}}>
          {content.map((item,i)=>(
            <li key={i}>{typeof item==="string"?item:JSON.stringify(item)}</li>
          ))}
        </ul>
      ) : (
        <pre style={{margin:0,fontSize:10,whiteSpace:"pre-wrap"}}>{JSON.stringify(content,null,2)}</pre>
      )}
    </div>
  );
}

function ruleFallback(product) {
  return {
    lowestPrice: [
      `현재 시세: ${product.marketPrice?.avg ? product.marketPrice.avg.toLocaleString()+"원" : "정보 없음"} (자동 추정)`,
      "추천 비교처: 쿠팡, 11번가, 오피스디포, B2B몰",
      "대량 구매 시 5~15% 할인 협상 가능 카테고리",
    ],
    care: [
      "건조하고 직사광선이 닿지 않는 곳에 보관",
      "월 1회 위치별 재고 점검 및 사진 갱신",
      product.cat === "체험용품" ? "행사 후 즉시 점검 및 청결 유지" : "정기 청소·먼지 제거",
    ],
    cost: [
      `현재 보유 가치 추정: ${(product.qty * (product.marketPrice?.avg || 0)).toLocaleString()}원`,
      product.qty > (product.minQty||0)*2 ? "⚠️ 과잉재고 — 발주 보류 검토" : "재고 수준 양호",
      "대안 공급사 발굴 시 단가 절감 가능",
    ],
  };
}

// ─── 탭: 담당자·판매자 ─────────────────────────────────────────────
function PeopleTab({ intel, update }) {
  const setPerson = (key, value) => {
    update({ stakeholders: { ...intel.stakeholders, [key]: value } });
  };

  return (
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <PersonCard
        icon="👨‍💼" title="내부 담당자" color="#3b82f6"
        person={intel.stakeholders.manager}
        onChange={p=>setPerson("manager", p)}
      />
      <PersonCard
        icon="🏪" title="외부 판매자" color="#f59e0b"
        person={intel.stakeholders.seller}
        onChange={p=>setPerson("seller", p)}
        extra="vendor"
      />
    </div>
  );
}

function PersonCard({ icon, title, color, person, onChange, extra }) {
  const p = person || {};
  const set = (k,v) => onChange({ ...p, [k]: v });
  return (
    <div style={{padding:12,background:"#fff",border:`2px solid ${color}33`,borderRadius:10}}>
      <div style={{fontSize:13,fontWeight:900,color,marginBottom:10}}>{icon} {title}</div>
      <Field label="이름"><Inp value={p.name||""} onChange={v=>set("name",v)}/></Field>
      <Field label="역할/직책"><Inp value={p.role||""} onChange={v=>set("role",v)} placeholder={extra==="vendor"?"예: 거래처 대표":"예: 시설팀 주임"}/></Field>
      <Field label="📞 전화"><Inp value={p.phone||""} onChange={v=>set("phone",v)} placeholder="010-0000-0000"/></Field>
      <Field label="✉️ 이메일"><Inp value={p.email||""} onChange={v=>set("email",v)}/></Field>
      <Field label="💬 카카오 ID"><Inp value={p.kakao||""} onChange={v=>set("kakao",v)}/></Field>
      {extra==="vendor" && <Field label="🏢 사업자/회사"><Inp value={p.company||""} onChange={v=>set("company",v)}/></Field>}
      <Field label="메모"><textarea value={p.memo||""} onChange={e=>set("memo",e.target.value)} style={inputStyle} rows={2}/></Field>
      <div style={{display:"flex",gap:6,marginTop:8}}>
        {p.phone && <a href={`tel:${p.phone}`} style={{flex:1,padding:"6px",textAlign:"center",background:"#dbeafe",color:"#1e40af",borderRadius:5,fontSize:11,fontWeight:700,textDecoration:"none"}}>📞 전화</a>}
        {p.phone && <a href={`sms:${p.phone}`} style={{flex:1,padding:"6px",textAlign:"center",background:"#dcfce7",color:"#065f46",borderRadius:5,fontSize:11,fontWeight:700,textDecoration:"none"}}>💬 문자</a>}
        {p.email && <a href={`mailto:${p.email}`} style={{flex:1,padding:"6px",textAlign:"center",background:"#fef3c7",color:"#92400e",borderRadius:5,fontSize:11,fontWeight:700,textDecoration:"none"}}>✉️ 메일</a>}
      </div>
    </div>
  );
}

// ─── 탭: 통화/카톡 ──────────────────────────────────────────────────
function CommsTab({ intel, update, curUser }) {
  const [draft, setDraft] = useState({ kind: "call", direction: "out", with: "seller", subject: "", text: "", attachments: [] });

  const add = () => {
    if (!draft.subject && !draft.text) { alert("제목 또는 내용 입력"); return; }
    const newEntry = {
      id: "comm_" + Date.now(),
      at: new Date().toISOString(),
      ...draft,
      by: curUser?.name || "사용자",
    };
    update({ comms: [newEntry, ...(intel.comms||[])] });
    setDraft({ kind: "call", direction: "out", with: "seller", subject: "", text: "", attachments: [] });
  };

  const remove = (id) => {
    if (!confirm("삭제할까요?")) return;
    update({ comms: (intel.comms||[]).filter(c => c.id !== id) });
  };

  const handleFile = (e) => {
    const files = Array.from(e.target.files || []);
    Promise.all(files.map(f => new Promise(res => {
      const reader = new FileReader();
      reader.onload = () => res({ type: f.type, name: f.name, dataUrl: reader.result });
      reader.readAsDataURL(f);
    }))).then(att => setDraft(d => ({ ...d, attachments: [...d.attachments, ...att] })));
    e.target.value = "";
  };

  return (
    <div>
      {/* 입력 폼 */}
      <div style={{padding:12,background:"#fff",border:"2px solid #8b5cf633",borderRadius:10,marginBottom:14}}>
        <div style={{fontSize:13,fontWeight:900,color:"#5b21b6",marginBottom:10}}>📝 새 통화·카톡 기록</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:8}}>
          <Field label="유형">
            <select value={draft.kind} onChange={e=>setDraft({...draft,kind:e.target.value})} style={inputStyle}>
              <option value="call">📞 통화</option>
              <option value="kakao">💬 카카오톡</option>
              <option value="sms">📱 문자</option>
              <option value="email">✉️ 이메일</option>
              <option value="memo">📝 메모</option>
            </select>
          </Field>
          <Field label="방향">
            <select value={draft.direction} onChange={e=>setDraft({...draft,direction:e.target.value})} style={inputStyle}>
              <option value="out">📤 발신</option>
              <option value="in">📥 수신</option>
            </select>
          </Field>
          <Field label="대상">
            <select value={draft.with} onChange={e=>setDraft({...draft,with:e.target.value})} style={inputStyle}>
              <option value="seller">🏪 판매자</option>
              <option value="manager">👨‍💼 담당자</option>
              <option value="other">기타</option>
            </select>
          </Field>
        </div>
        <Field label="제목"><Inp value={draft.subject} onChange={v=>setDraft({...draft,subject:v})} placeholder="예: 가격 협상 / 납기 확인"/></Field>
        <Field label="내용 (전사 또는 요약)">
          <textarea value={draft.text} onChange={e=>setDraft({...draft,text:e.target.value})} style={{...inputStyle,minHeight:80,resize:"vertical"}}
            placeholder="대화 내용 전체 또는 핵심 요약을 입력하세요. 카톡 내용 그대로 붙여넣기 가능."/>
        </Field>
        <Field label="첨부 (카톡 캡처/녹음/파일)">
          <input type="file" multiple accept="image/*,audio/*,.pdf,.txt" onChange={handleFile} style={{fontSize:11}}/>
        </Field>
        {draft.attachments.length > 0 && (
          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:6}}>
            {draft.attachments.map((a,i)=>(
              <div key={i} style={{padding:4,background:"#f1f5f9",borderRadius:5,fontSize:10,display:"flex",alignItems:"center",gap:4}}>
                {a.type.startsWith("image/") ? <img src={a.dataUrl} style={{width:30,height:30,objectFit:"cover",borderRadius:3}}/> : <span>📎</span>}
                <span>{a.name}</span>
                <button onClick={()=>setDraft({...draft,attachments:draft.attachments.filter((_,j)=>j!==i)})}
                  style={{background:"none",border:"none",cursor:"pointer",color:"#dc2626"}}>✕</button>
              </div>
            ))}
          </div>
        )}
        <button onClick={add} style={{marginTop:10,padding:"8px 16px",background:"#7c3aed",color:"#fff",border:"none",borderRadius:6,fontWeight:700,fontSize:12,cursor:"pointer",width:"100%"}}>
          💾 기록 추가
        </button>
      </div>

      {/* 목록 */}
      {(intel.comms||[]).length === 0 ? (
        <div style={{textAlign:"center",padding:30,color:"#94a3b8"}}>아직 기록이 없습니다.</div>
      ) : (
        (intel.comms||[]).map(c => (
          <div key={c.id} style={{padding:10,background:"#fff",border:"1px solid #e5e7eb",borderRadius:8,marginBottom:8}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:6}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:11,fontWeight:800,color:"#0f172a"}}>
                  {commIcon(c.kind)} {commLabel(c.kind)} · {c.direction==="in"?"수신":"발신"} · {c.with==="manager"?"담당자":c.with==="seller"?"판매자":"기타"}
                </div>
                <div style={{fontSize:13,fontWeight:700,color:"#1e293b",marginTop:3}}>{c.subject || "(제목 없음)"}</div>
                <div style={{fontSize:11,color:"#475569",marginTop:4,whiteSpace:"pre-wrap"}}>{c.text}</div>
                {c.attachments?.length > 0 && (
                  <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:6}}>
                    {c.attachments.map((a,i)=>(
                      <a key={i} href={a.dataUrl} download={a.name} style={{textDecoration:"none"}}>
                        {a.type.startsWith("image/") ?
                          <img src={a.dataUrl} style={{width:60,height:60,objectFit:"cover",borderRadius:5,border:"1px solid #e5e7eb"}}/>
                          : <div style={{padding:6,background:"#f1f5f9",borderRadius:5,fontSize:10,color:"#475569"}}>📎 {a.name}</div>
                        }
                      </a>
                    ))}
                  </div>
                )}
                <div style={{fontSize:9,color:"#94a3b8",marginTop:6}}>{new Date(c.at).toLocaleString("ko-KR")} · {c.by}</div>
              </div>
              <button onClick={()=>remove(c.id)} style={{padding:"3px 8px",background:"#fee2e2",color:"#dc2626",border:"none",borderRadius:4,fontSize:10,cursor:"pointer"}}>🗑️</button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ─── 탭: 절감 ──────────────────────────────────────────────────────
function SavingsTab({ intel, update, curUser }) {
  const [draft, setDraft] = useState({ title: "", amount: "", reason: "" });

  const add = () => {
    if (!draft.title) { alert("제목 입력"); return; }
    const e = {
      id: "sav_" + Date.now(),
      at: new Date().toISOString(),
      title: draft.title,
      amount: parseInt(draft.amount) || 0,
      reason: draft.reason,
      by: curUser?.name || "사용자",
    };
    update({ savings: [e, ...(intel.savings||[])] });
    setDraft({ title: "", amount: "", reason: "" });
  };
  const remove = (id) => {
    if (!confirm("삭제할까요?")) return;
    update({ savings: (intel.savings||[]).filter(s => s.id !== id) });
  };

  const total = (intel.savings||[]).reduce((s,e)=>s+(e.amount||0), 0);

  return (
    <div>
      <div style={{padding:12,background:"linear-gradient(135deg,#dcfce7,#bbf7d0)",borderRadius:8,marginBottom:14,display:"flex",alignItems:"center",gap:10}}>
        <span style={{fontSize:24}}>💰</span>
        <div style={{flex:1}}>
          <div style={{fontSize:11,color:"#065f46",fontWeight:700}}>누적 절감액</div>
          <div style={{fontSize:20,fontWeight:900,color:"#047857"}}>{total.toLocaleString()}원</div>
        </div>
        <div style={{fontSize:11,color:"#065f46"}}>{(intel.savings||[]).length}건</div>
      </div>

      <div style={{padding:12,background:"#fff",border:"1px solid #e5e7eb",borderRadius:8,marginBottom:14}}>
        <div style={{fontSize:12,fontWeight:800,marginBottom:8}}>＋ 절감 항목 추가</div>
        <Field label="제목"><Inp value={draft.title} onChange={v=>setDraft({...draft,title:v})} placeholder="예: 대안 공급사 발굴"/></Field>
        <Field label="절감액 (원)"><Inp type="number" value={draft.amount} onChange={v=>setDraft({...draft,amount:v})}/></Field>
        <Field label="사유"><textarea value={draft.reason} onChange={e=>setDraft({...draft,reason:e.target.value})} style={{...inputStyle,minHeight:50}}/></Field>
        <button onClick={add} style={{marginTop:8,padding:"8px 16px",background:"#10b981",color:"#fff",border:"none",borderRadius:6,fontWeight:700,fontSize:12,cursor:"pointer",width:"100%"}}>
          💾 절감 기록 추가
        </button>
      </div>

      {(intel.savings||[]).map(s => (
        <div key={s.id} style={{padding:10,background:"#fff",border:"1px solid #e5e7eb",borderRadius:8,marginBottom:8,display:"flex",justifyContent:"space-between",gap:8}}>
          <div style={{flex:1}}>
            <div style={{fontSize:12,fontWeight:800}}>{s.title}</div>
            <div style={{fontSize:14,fontWeight:900,color:"#047857",marginTop:2}}>-{(s.amount||0).toLocaleString()}원</div>
            {s.reason && <div style={{fontSize:10,color:"#64748b",marginTop:4}}>{s.reason}</div>}
            <div style={{fontSize:9,color:"#94a3b8",marginTop:4}}>{new Date(s.at).toLocaleString("ko-KR")} · {s.by}</div>
          </div>
          <button onClick={()=>remove(s.id)} style={{padding:"3px 8px",background:"#fee2e2",color:"#dc2626",border:"none",borderRadius:4,fontSize:10,cursor:"pointer",alignSelf:"flex-start"}}>🗑️</button>
        </div>
      ))}
    </div>
  );
}

// ─── 탭: 품의서 ────────────────────────────────────────────────────
function RequisitionTab({ reqs, payments }) {
  if (reqs.length === 0 && payments.length === 0) {
    return <div style={{textAlign:"center",padding:30,color:"#94a3b8"}}>이 제품과 연결된 품의/결제가 없습니다.</div>;
  }
  return (
    <div>
      <div style={{fontSize:12,fontWeight:800,marginBottom:8}}>📝 연결된 품의서 ({reqs.length})</div>
      {reqs.map(r => (
        <div key={r.id} style={{padding:10,background:"#fff",border:"1px solid #e5e7eb",borderRadius:8,marginBottom:6}}>
          <div style={{fontSize:12,fontWeight:800}}>{r.title || r.itemName || "(제목 없음)"}</div>
          <div style={{fontSize:10,color:"#64748b",marginTop:2}}>
            {r.createdAt?.slice(0,10) || r.date} · {r.status || "작성"} · {r.amount ? r.amount.toLocaleString()+"원" : ""} · {r.requester || ""}
          </div>
        </div>
      ))}
      {payments.length > 0 && <>
        <div style={{fontSize:12,fontWeight:800,margin:"14px 0 8px"}}>💳 연결된 결제 ({payments.length})</div>
        {payments.map(p => (
          <div key={p.id} style={{padding:10,background:"#fff",border:"1px solid #e5e7eb",borderRadius:8,marginBottom:6}}>
            <div style={{fontSize:12,fontWeight:800}}>{p.method || "결제"} · {p.amount ? p.amount.toLocaleString()+"원" : ""}</div>
            <div style={{fontSize:10,color:"#64748b",marginTop:2}}>
              {String(p.date||p.paidAt||"").slice(0,10)} · {p.vendor || ""} · {p.memo || ""}
            </div>
          </div>
        ))}
      </>}
    </div>
  );
}

// ─── 유틸 ──────────────────────────────────────────────────────────
function actIcon(act) {
  const m = { "추가":"➕", "입고":"📥", "출고":"📤", "조정":"⚖️", "삭제":"🗑️", "수정":"✏️" };
  return m[act] || "📝";
}
function actColor(act) {
  const m = { "추가":"#3b82f6", "입고":"#10b981", "출고":"#dc2626", "조정":"#8b5cf6", "삭제":"#6b7280", "수정":"#f59e0b" };
  return m[act] || "#475569";
}
function commIcon(k) {
  return { call:"📞", kakao:"💬", sms:"📱", email:"✉️", memo:"📝" }[k] || "💬";
}
function commLabel(k) {
  return { call:"통화", kakao:"카카오톡", sms:"문자", email:"이메일", memo:"메모" }[k] || k;
}

const inputStyle = {
  width:"100%", padding:"7px 9px", border:"1px solid #e5e7eb", borderRadius:5, fontSize:12, fontFamily:"inherit",
};

function Field({ label, children }) {
  return (
    <div style={{marginBottom:8}}>
      <label style={{display:"block",fontSize:10,fontWeight:700,color:"#64748b",marginBottom:3}}>{label}</label>
      {children}
    </div>
  );
}
function Inp({ value, onChange, placeholder, type="text" }) {
  return <input type={type} value={value||""} onChange={e=>onChange(e.target.value)} placeholder={placeholder} style={inputStyle}/>;
}
