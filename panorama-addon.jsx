// ═══════════════════════════════════════════════════════════════════════
// 🌐 Panorama Floorplan Add-on (파노라마 기반 평면도 보조 생성)
// ─────────────────────────────────────────────────────────────────────
// 부가기능 모듈 — 기존 핵심(지도/예약/티켓/문자알림/고객동선/대시보드)을
// 그대로 두고, 관리자가 파노라마 사진으로 평면도 초안을 생성·검토·반영.
//
// 아키텍처:
//   - 데이터: localStorage (jamsa_pano_addons)
//   - 분석: PanoramaAnalysisService 인터페이스 + MockPanoramaAnalysisService
//     → 추후 OpenCV/COLMAP/RoomPlan 어댑터로 교체 가능
//   - 통합: 기존 ZoneLayoutModal에서 "초안 가져오기"로 import
// ═══════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useMemo, useRef } from "react";

/** @typedef {"draft"|"uploading"|"analyzing"|"review_required"|"imported"|"failed"} AddonStatus */
/** @typedef {"unknown"|"estimated"|"calibrated"} ScaleStatus */
/** @typedef {"green"|"yellow"|"red"} ConfidenceLevel */
/** @typedef {"wall"|"door"|"window"|"room"|"entrance"|"restroom"|"emergency_exit"|"store"|"restaurant"|"staff_only_area"} ObjectType */

/**
 * @typedef {Object} PanoramaAddon
 * @property {string} id
 * @property {string} floorMapId — 연결된 zone id (기존 ZONES 또는 customZones)
 * @property {string} title
 * @property {string} zoneName
 * @property {AddonStatus} status
 * @property {ScaleStatus} scaleStatus
 * @property {ConfidenceLevel} confidence
 * @property {string} createdBy
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {boolean} approved — 관리자 승인 여부
 * @property {boolean} publicVisible
 * @property {PanoramaImage[]} images
 * @property {CalibrationPoint[]} calibrations
 * @property {DraftObject[]} draftObjects
 * @property {ImportLog[]} importLogs
 */

/**
 * @typedef {Object} PanoramaImage
 * @property {string} id
 * @property {string} imageUrl — base64 dataURL
 * @property {string} capturePointName — 예: "키즈카페 입구"
 * @property {number} cameraHeightCm
 * @property {number} headingDeg
 * @property {number} sortOrder
 * @property {boolean} isBlurProcessed
 * @property {Object} metadata
 * @property {string} createdAt
 */

/**
 * @typedef {Object} CalibrationPoint
 * @property {string} id
 * @property {string} imageId
 * @property {string} label — 예: "출입문 폭"
 * @property {number} realDistanceM
 * @property {string} memo
 * @property {string} createdAt
 */

/**
 * @typedef {Object} DraftObject
 * @property {string} id
 * @property {ObjectType} objectType
 * @property {string} name
 * @property {number} x — % (0-100, 평면도 캔버스 기준)
 * @property {number} y
 * @property {number} widthM
 * @property {number} heightM
 * @property {number} rotationDeg
 * @property {number} confidenceScore — 0~1
 * @property {boolean} publicVisible
 * @property {boolean} staffOnly
 * @property {Object} metadata
 */

/**
 * @typedef {Object} ImportLog
 * @property {string} id
 * @property {string} floorMapId
 * @property {number} importedObjectCount
 * @property {string} importedBy
 * @property {string} createdAt
 */

const STORAGE_KEY = "jamsa_pano_addons";

// ─────────────────────────────────────────────────────────────────────
// Storage helpers
// ─────────────────────────────────────────────────────────────────────
export function loadAddons() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); }
  catch (e) { return []; }
}
export function saveAddons(arr) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
}
function uid() { return `pa_${Date.now()}_${Math.floor(Math.random()*1000)}`; }

// ─────────────────────────────────────────────────────────────────────
// Confidence calculation (룰 기반 MVP)
// ─────────────────────────────────────────────────────────────────────
export function calculateConfidence(addon) {
  const imgN = addon.images?.length || 0;
  const calN = addon.calibrations?.length || 0;
  const objN = addon.draftObjects?.length || 0;
  if (imgN === 0 || addon.status === "failed") return "red";
  if (imgN >= 3 && calN >= 1 && addon.zoneName && objN >= 3) return "green";
  if (imgN >= 1 && objN >= 1) return "yellow";
  return "red";
}

export const CONFIDENCE_MSG = {
  green: "✅ 실사용 가능성이 높은 초안입니다. 관리자 확인 후 반영하세요.",
  yellow: "⚠️ 구조는 참고 가능하지만 치수 보정이 필요합니다.",
  red: "🛑 자동 생성 신뢰도가 낮습니다. 사진 추가 또는 수동 편집을 권장합니다.",
};

// ─────────────────────────────────────────────────────────────────────
// PanoramaAnalysisService — 인터페이스
// 향후 OpenCVPanoramaAnalysisService 등으로 교체 가능
// ─────────────────────────────────────────────────────────────────────
export class PanoramaAnalysisService {
  /** @param {PanoramaAddon} addon @returns {Promise<DraftObject[]>} */
  async analyzePanoramas(addon) { throw new Error("not implemented"); }
  async detectWalls(image) { throw new Error("not implemented"); }
  async detectDoors(image) { throw new Error("not implemented"); }
  async estimateRoomBoundary(images) { throw new Error("not implemented"); }
  async generateDraftFloorplan(addon) { throw new Error("not implemented"); }
  calculateConfidence(addon) { return calculateConfidence(addon); }
  exportToFloorplanObjects(draftObjects) { return draftObjects; }
}

// ─────────────────────────────────────────────────────────────────────
// MockPanoramaAnalysisService — 더미 결과 생성기 (MVP)
// 사진 개수 + 기준치수 + 구역명에 따라 합리적인 객체 5~10개 생성
// ─────────────────────────────────────────────────────────────────────
export class MockPanoramaAnalysisService extends PanoramaAnalysisService {
  async analyzePanoramas(addon) {
    // 약간의 처리 지연 시뮬레이션 (UI에서 진행 상태 보이려고)
    await new Promise(r => setTimeout(r, 800 + addon.images.length * 300));
    return this.generateDraftFloorplan(addon);
  }

  async generateDraftFloorplan(addon) {
    const objs = [];
    const baseConf = addon.calibrations?.length > 0 ? 0.78 : 0.55;
    const zone = addon.zoneName || "구역";

    // 외벽 4개 (사각형 가정 — MVP)
    objs.push({ id: uid(), objectType:"wall", name:`${zone} 북측 외벽`, x:5, y:5, widthM:10, heightM:0.2, rotationDeg:0, confidenceScore: baseConf, publicVisible:true, staffOnly:false, metadata:{side:"N"} });
    objs.push({ id: uid(), objectType:"wall", name:`${zone} 동측 외벽`, x:95, y:50, widthM:0.2, heightM:8, rotationDeg:90, confidenceScore: baseConf, publicVisible:true, staffOnly:false, metadata:{side:"E"} });
    objs.push({ id: uid(), objectType:"wall", name:`${zone} 남측 외벽`, x:5, y:95, widthM:10, heightM:0.2, rotationDeg:0, confidenceScore: baseConf, publicVisible:true, staffOnly:false, metadata:{side:"S"} });
    objs.push({ id: uid(), objectType:"wall", name:`${zone} 서측 외벽`, x:5, y:50, widthM:0.2, heightM:8, rotationDeg:90, confidenceScore: baseConf, publicVisible:true, staffOnly:false, metadata:{side:"W"} });

    // 출입구 1개 (남측 중앙)
    objs.push({ id: uid(), objectType:"entrance", name:`${zone} 주출입구`, x:48, y:93, widthM:1.2, heightM:0.2, rotationDeg:0, confidenceScore: baseConf+0.05, publicVisible:true, staffOnly:false, metadata:{} });

    // 사진 개수에 따라 추가 객체
    const imgN = addon.images?.length || 0;
    if (imgN >= 2) {
      // 화장실
      objs.push({ id: uid(), objectType:"restroom", name:`${zone} 화장실`, x:15, y:15, widthM:2.5, heightM:3, rotationDeg:0, confidenceScore: baseConf-0.1, publicVisible:true, staffOnly:false, metadata:{} });
      // 문 1개
      objs.push({ id: uid(), objectType:"door", name:"화장실 문", x:23, y:18, widthM:0.9, heightM:0.1, rotationDeg:0, confidenceScore: baseConf, publicVisible:true, staffOnly:false, metadata:{width_m_calibrated:!!addon.calibrations?.length} });
    }
    if (imgN >= 3) {
      // 비상구
      objs.push({ id: uid(), objectType:"emergency_exit", name:`${zone} 비상구`, x:90, y:8, widthM:1.0, heightM:0.2, rotationDeg:0, confidenceScore: baseConf, publicVisible:true, staffOnly:false, metadata:{} });
      // 직원전용 창고
      objs.push({ id: uid(), objectType:"staff_only_area", name:`${zone} 직원창고`, x:75, y:20, widthM:3, heightM:3, rotationDeg:0, confidenceScore: baseConf-0.05, publicVisible:false, staffOnly:true, metadata:{} });
      // 창문 2개
      objs.push({ id: uid(), objectType:"window", name:"동측 창문", x:96, y:30, widthM:0.1, heightM:1.5, rotationDeg:90, confidenceScore: baseConf-0.1, publicVisible:true, staffOnly:false, metadata:{} });
    }
    if (imgN >= 4) {
      objs.push({ id: uid(), objectType:"room", name:`${zone} 휴게공간`, x:50, y:50, widthM:4, heightM:4, rotationDeg:0, confidenceScore: baseConf-0.1, publicVisible:true, staffOnly:false, metadata:{} });
    }

    return objs;
  }
}

// 기본 서비스 (앞으로 교체)
let _service = new MockPanoramaAnalysisService();
export function getAnalysisService() { return _service; }
export function setAnalysisService(svc) { _service = svc; }

// ─────────────────────────────────────────────────────────────────────
// Object type → 한글 라벨 + 컬러 + 아이콘
// ─────────────────────────────────────────────────────────────────────
export const OBJ_META = {
  wall:            { label:"벽",       icon:"🧱", color:"#475569", fillColor:"#cbd5e1" },
  door:            { label:"문",       icon:"🚪", color:"#92400e", fillColor:"#fde68a" },
  window:          { label:"창문",     icon:"🪟", color:"#0369a1", fillColor:"#bae6fd" },
  room:            { label:"공간",     icon:"🏢", color:"#3b82f6", fillColor:"#dbeafe" },
  entrance:        { label:"출입구",   icon:"🚶", color:"#10b981", fillColor:"#a7f3d0" },
  restroom:        { label:"화장실",   icon:"🚻", color:"#a855f7", fillColor:"#e9d5ff" },
  emergency_exit:  { label:"비상구",   icon:"🆘", color:"#dc2626", fillColor:"#fecaca" },
  store:           { label:"매점",     icon:"🛒", color:"#f59e0b", fillColor:"#fef3c7" },
  restaurant:      { label:"식당",     icon:"🍽️", color:"#ea580c", fillColor:"#fed7aa" },
  staff_only_area: { label:"직원전용", icon:"🔒", color:"#64748b", fillColor:"#e5e7eb" },
};

// ─────────────────────────────────────────────────────────────────────
// 메인 컴포넌트: PanoramaAddonPage
// ─────────────────────────────────────────────────────────────────────
export function PanoramaAddonPage({ zones, curUser, onImportToZone, isMaster }) {
  const [addons, setAddons] = useState(loadAddons());
  const [selId, setSelId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  const refresh = () => setAddons(loadAddons());
  const persist = (arr) => { saveAddons(arr); setAddons(arr); };

  if (!isMaster) {
    return (
      <div style={{padding:40,textAlign:"center",color:"#94a3b8"}}>
        🔒 이 부가기능은 <strong>최종관리자(master)</strong>만 사용 가능합니다.
      </div>
    );
  }

  const sel = addons.find(a => a.id === selId);

  return (
    <div style={{padding:"14px 18px",fontFamily:"inherit"}}>
      {!sel ? (
        <>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:8}}>
            <div>
              <h2 style={{fontSize:18,fontWeight:900,color:"#0f172a",margin:0}}>🌐 파노라마 평면도 생성 <span style={{fontSize:11,padding:"2px 8px",background:"#fef3c7",color:"#92400e",borderRadius:6,marginLeft:6,fontWeight:700}}>부가기능</span></h2>
              <div style={{fontSize:11,color:"#64748b",marginTop:4}}>파노라마 사진을 바탕으로 평면도 초안을 생성하는 보조 기능입니다. 실제 치수는 기준 치수 입력 후 보정해야 합니다.</div>
            </div>
            <button onClick={()=>setShowCreate(true)}
              style={{padding:"9px 16px",background:"linear-gradient(135deg,#0ea5e9,#1e40af)",color:"#fff",border:"none",borderRadius:8,fontWeight:700,fontSize:13,cursor:"pointer"}}>
              ＋ 새 초안 프로젝트
            </button>
          </div>

          <AddonList addons={addons} onSelect={setSelId} onDelete={(id)=>{
            if (!confirm("이 초안 프로젝트를 삭제하시겠습니까?")) return;
            persist(addons.filter(a => a.id !== id));
          }}/>

          {showCreate && (
            <CreateAddonModal zones={zones} curUser={curUser} onCreate={(addon)=>{
              const next = [addon, ...addons];
              persist(next);
              setShowCreate(false);
              setSelId(addon.id);
            }} onClose={()=>setShowCreate(false)}/>
          )}
        </>
      ) : (
        <AddonDetail addon={sel} zones={zones} curUser={curUser} onImportToZone={onImportToZone}
          onBack={()=>{ setSelId(null); refresh(); }}
          onUpdate={(patch)=>{
            const next = addons.map(a => a.id === sel.id ? {...a, ...patch, updatedAt: new Date().toISOString()} : a);
            persist(next);
          }}/>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// 목록 카드
// ─────────────────────────────────────────────────────────────────────
function AddonList({ addons, onSelect, onDelete }) {
  if (addons.length === 0) {
    return (
      <div style={{padding:50,textAlign:"center",border:"2px dashed #cbd5e1",borderRadius:10,color:"#94a3b8"}}>
        <div style={{fontSize:36,marginBottom:8}}>🌐</div>
        <div style={{fontSize:13,fontWeight:700,color:"#475569"}}>아직 생성된 파노라마 초안이 없습니다.</div>
        <div style={{fontSize:11,marginTop:4}}>"＋ 새 초안 프로젝트" 버튼으로 시작하세요.</div>
      </div>
    );
  }
  return (
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:10}}>
      {addons.map(a => {
        const conf = a.confidence || calculateConfidence(a);
        return (
          <div key={a.id} style={{padding:12,background:"#fff",border:"1px solid #e5e7eb",borderRadius:10,cursor:"pointer",transition:"all 0.15s"}}
            onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-2px)";e.currentTarget.style.boxShadow="0 6px 16px rgba(0,0,0,0.08)";}}
            onMouseLeave={e=>{e.currentTarget.style.transform="translateY(0)";e.currentTarget.style.boxShadow="none";}}
            onClick={()=>onSelect(a.id)}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:6}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:13,fontWeight:800,color:"#0f172a",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{a.title}</div>
                <div style={{fontSize:10,color:"#64748b",marginTop:2}}>📍 {a.zoneName}</div>
              </div>
              <button onClick={(e)=>{e.stopPropagation();onDelete(a.id);}}
                style={{padding:"3px 6px",fontSize:10,background:"transparent",color:"#dc2626",border:"none",cursor:"pointer"}}>🗑️</button>
            </div>
            <div style={{display:"flex",gap:5,marginTop:8,flexWrap:"wrap",fontSize:9}}>
              <Badge label={STATUS_LABEL[a.status] || a.status} color={STATUS_COLOR[a.status] || "#64748b"}/>
              <Badge label={SCALE_LABEL[a.scaleStatus] || a.scaleStatus} color={a.scaleStatus==="calibrated"?"#10b981":a.scaleStatus==="estimated"?"#f59e0b":"#94a3b8"}/>
              <Badge label={`📷 ${a.images?.length || 0}장`} color="#64748b"/>
              <Badge label={`🏷️ ${a.draftObjects?.length || 0}개체`} color="#64748b"/>
              <Badge label={CONF_DOT[conf]} color={CONF_COLOR[conf]}/>
            </div>
            <div style={{fontSize:9,color:"#94a3b8",marginTop:6}}>{new Date(a.updatedAt).toLocaleString("ko-KR")}</div>
            {a.approved && <div style={{marginTop:4,fontSize:9,color:"#10b981",fontWeight:700}}>✅ 승인됨{a.publicVisible?" · 고객 공개":" · 비공개"}</div>}
          </div>
        );
      })}
    </div>
  );
}

const STATUS_LABEL = { draft:"초안", uploading:"업로드중", analyzing:"분석중", review_required:"검토필요", imported:"반영완료", failed:"실패" };
const STATUS_COLOR = { draft:"#64748b", uploading:"#3b82f6", analyzing:"#a855f7", review_required:"#f59e0b", imported:"#10b981", failed:"#dc2626" };
const SCALE_LABEL = { unknown:"스케일 미확정", estimated:"스케일 추정", calibrated:"스케일 보정됨" };
const CONF_DOT = { green:"신뢰도 높음", yellow:"보정필요", red:"신뢰도 낮음" };
const CONF_COLOR = { green:"#10b981", yellow:"#f59e0b", red:"#dc2626" };

function Badge({ label, color }) {
  return <span style={{padding:"2px 7px",borderRadius:6,background:color+"22",color,fontWeight:700,fontSize:9}}>{label}</span>;
}

// ─────────────────────────────────────────────────────────────────────
// 신규 초안 생성 모달
// ─────────────────────────────────────────────────────────────────────
function CreateAddonModal({ zones, curUser, onCreate, onClose }) {
  const [title, setTitle] = useState("");
  const [zoneName, setZoneName] = useState("");
  const [floorMapId, setFloorMapId] = useState(zones[0]?.id || "");

  return (
    <ModalShell title="🌐 새 파노라마 초안 프로젝트" onClose={onClose}>
      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        <div>
          <Lbl>프로젝트 제목 *</Lbl>
          <Inp value={title} onChange={setTitle} placeholder="예: 키즈카페 파노라마 초안"/>
        </div>
        <div>
          <Lbl>연결 구역 (기존 평면도에 반영 시 사용)</Lbl>
          <select className="sel" value={floorMapId} onChange={e=>setFloorMapId(e.target.value)} style={{width:"100%",padding:9,border:"1px solid #e5e7eb",borderRadius:6,fontSize:13}}>
            {zones.map(z => <option key={z.id} value={z.id}>{z.icon} {z.name}</option>)}
          </select>
        </div>
        <div>
          <Lbl>구역명 *</Lbl>
          <Inp value={zoneName} onChange={setZoneName} placeholder="예: 키즈카페, 박물관 전시실, 누에쉼터, 매점, 식당"/>
        </div>
      </div>
      <div style={{display:"flex",gap:6,justifyContent:"flex-end",marginTop:14,paddingTop:10,borderTop:"1px solid #e5e7eb"}}>
        <button className="btn bs" onClick={onClose}>취소</button>
        <button className="btn bp" onClick={()=>{
          if (!title.trim() || !zoneName.trim()) return alert("제목과 구역명은 필수입니다");
          const now = new Date().toISOString();
          onCreate({
            id: uid(), floorMapId, title: title.trim(), zoneName: zoneName.trim(),
            status:"draft", scaleStatus:"unknown", confidence:"red",
            createdBy: curUser?.name || "관리자", createdAt: now, updatedAt: now,
            approved: false, publicVisible: false,
            images:[], calibrations:[], draftObjects:[], importLogs:[],
          });
        }}>＋ 생성</button>
      </div>
    </ModalShell>
  );
}

// ─────────────────────────────────────────────────────────────────────
// 상세 페이지: 업로드 + 보정 + 분석 + 검토 + 반영
// ─────────────────────────────────────────────────────────────────────
function AddonDetail({ addon, zones, curUser, onImportToZone, onBack, onUpdate }) {
  const [tab, setTab] = useState(addon.draftObjects?.length > 0 ? "review" : "upload"); // upload | calib | analyze | review
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState(0);
  const [analyzeError, setAnalyzeError] = useState(null);

  const onUploadImages = (files) => {
    const promises = Array.from(files).map(f => new Promise(resolve => {
      const r = new FileReader();
      r.onload = e => resolve({
        id: uid(), imageUrl: e.target.result,
        capturePointName: f.name.replace(/\.[^.]+$/, ""),
        cameraHeightCm: 150, headingDeg: 0,
        sortOrder: (addon.images?.length || 0),
        isBlurProcessed: false, metadata:{ size:f.size, type:f.type },
        createdAt: new Date().toISOString(),
      });
      r.readAsDataURL(f);
    }));
    Promise.all(promises).then(imgs => {
      onUpdate({ images: [...(addon.images||[]), ...imgs], status:"draft" });
    });
  };

  const removeImage = (imgId) => onUpdate({ images: addon.images.filter(i => i.id !== imgId) });

  const updateImage = (imgId, patch) => onUpdate({ images: addon.images.map(i => i.id===imgId ? {...i, ...patch} : i) });

  const addCalibration = (cal) => {
    const next = [...(addon.calibrations||[]), { id:uid(), ...cal, createdAt:new Date().toISOString() }];
    onUpdate({ calibrations: next, scaleStatus: "calibrated" });
  };
  const removeCalibration = (cid) => {
    const next = (addon.calibrations||[]).filter(c => c.id !== cid);
    onUpdate({ calibrations: next, scaleStatus: next.length > 0 ? "calibrated" : "unknown" });
  };

  const runAnalysis = async () => {
    if ((addon.images?.length || 0) === 0) { alert("먼저 사진을 업로드하세요"); return; }
    setAnalyzing(true); setAnalyzeError(null); setAnalyzeProgress(10);
    onUpdate({ status:"analyzing" });
    try {
      const ticker = setInterval(() => setAnalyzeProgress(p => Math.min(p + 8, 88)), 200);
      const svc = getAnalysisService();
      const objects = await svc.analyzePanoramas(addon);
      clearInterval(ticker);
      setAnalyzeProgress(100);
      const updated = { ...addon, draftObjects: objects, status:"review_required" };
      const conf = calculateConfidence(updated);
      onUpdate({ draftObjects: objects, status:"review_required", confidence: conf });
      setTab("review");
    } catch (e) {
      setAnalyzeError(e.message);
      onUpdate({ status:"failed" });
    } finally {
      setAnalyzing(false);
    }
  };

  const updateDraftObj = (oid, patch) => {
    onUpdate({ draftObjects: addon.draftObjects.map(o => o.id===oid ? {...o, ...patch} : o) });
  };
  const deleteDraftObj = (oid) => {
    if (!confirm("이 객체를 삭제하시겠습니까?")) return;
    onUpdate({ draftObjects: addon.draftObjects.filter(o => o.id !== oid) });
  };

  const importToZone = (includeStaffOnly) => {
    const targetZone = zones.find(z => z.id === addon.floorMapId);
    if (!targetZone) { alert("연결된 구역을 찾을 수 없습니다"); return; }
    const objs = (addon.draftObjects||[]).filter(o => includeStaffOnly ? true : (o.publicVisible && !o.staffOnly));
    if (objs.length === 0) { alert("가져올 객체가 없습니다"); return; }
    if (!confirm(`"${targetZone.name}" 구역에 ${objs.length}개 객체를 추가하시겠습니까? (기존 객체는 보존됩니다)`)) return;
    onImportToZone(targetZone, objs, addon);
    const log = { id:uid(), floorMapId: targetZone.id, importedObjectCount: objs.length, importedBy: curUser?.name || "관리자", createdAt: new Date().toISOString() };
    onUpdate({
      status:"imported", approved: true,
      importLogs: [...(addon.importLogs||[]), log],
    });
    alert(`✅ "${targetZone.name}" 구역에 ${objs.length}개 객체가 추가되었습니다.`);
  };

  return (
    <div>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14,flexWrap:"wrap"}}>
        <button onClick={onBack} style={{padding:"6px 12px",background:"#fff",border:"1px solid #e5e7eb",borderRadius:6,cursor:"pointer",fontSize:11,fontWeight:700}}>← 목록</button>
        <div style={{flex:1,minWidth:0}}>
          <h2 style={{fontSize:16,fontWeight:900,color:"#0f172a",margin:0}}>{addon.title}</h2>
          <div style={{fontSize:11,color:"#64748b",marginTop:2}}>📍 {addon.zoneName} · {STATUS_LABEL[addon.status]} · {SCALE_LABEL[addon.scaleStatus]}</div>
        </div>
      </div>

      <div style={{padding:10,background: CONF_COLOR[addon.confidence||"red"]+"15", border:`1px solid ${CONF_COLOR[addon.confidence||"red"]}`,borderRadius:8,marginBottom:12,fontSize:11,color: CONF_COLOR[addon.confidence||"red"], fontWeight:700}}>
        {CONFIDENCE_MSG[addon.confidence || "red"]}
      </div>

      {/* Tabs */}
      <div style={{display:"flex",gap:4,borderBottom:"2px solid #e5e7eb",marginBottom:12,flexWrap:"wrap"}}>
        {[["upload","📷 사진 업로드"],["calib","📏 기준 치수"],["analyze","🤖 초안 생성"],["review","🗺️ 검토 & 반영"]].map(([k,l]) => (
          <button key={k} onClick={()=>setTab(k)}
            style={{padding:"8px 14px",border:"none",background:tab===k?"#3b5bdb":"transparent",color:tab===k?"#fff":"#475569",fontWeight:700,fontSize:12,borderRadius:"8px 8px 0 0",cursor:"pointer"}}>
            {l}
          </button>
        ))}
      </div>

      {tab === "upload" && (
        <UploadTab addon={addon} onUpload={onUploadImages} onRemove={removeImage} onUpdateImage={updateImage}/>
      )}
      {tab === "calib" && (
        <CalibrationTab addon={addon} onAdd={addCalibration} onRemove={removeCalibration}/>
      )}
      {tab === "analyze" && (
        <AnalyzeTab addon={addon} analyzing={analyzing} progress={analyzeProgress} error={analyzeError}
          onAnalyze={runAnalysis} onSwitchToManual={()=>setTab("review")}/>
      )}
      {tab === "review" && (
        <ReviewTab addon={addon} zones={zones}
          onUpdateObj={updateDraftObj} onDeleteObj={deleteDraftObj}
          onImport={importToZone} onReanalyze={runAnalysis} analyzing={analyzing}
          onApprove={()=>onUpdate({approved:true})} onReject={()=>onUpdate({approved:false, publicVisible:false})}
          onTogglePublic={()=>onUpdate({publicVisible: !addon.publicVisible})}/>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Tab: 사진 업로드
// ─────────────────────────────────────────────────────────────────────
function UploadTab({ addon, onUpload, onRemove, onUpdateImage }) {
  return (
    <div>
      <label style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"24px",background:"#fff",border:"2px dashed #93c5fd",borderRadius:10,cursor:"pointer",color:"#1e40af",marginBottom:12}}>
        <div style={{fontSize:32}}>🌄</div>
        <div style={{fontSize:13,fontWeight:800,marginTop:6}}>파노라마 사진 업로드 (여러 장 가능)</div>
        <div style={{fontSize:10,color:"#64748b",marginTop:3}}>폰 카메라의 파노라마 모드로 찍은 사진 권장</div>
        <input type="file" accept="image/*" multiple capture="environment" style={{display:"none"}}
          onChange={e=>onUpload(e.target.files)}/>
      </label>

      {addon.images?.length > 0 && (
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:10}}>
          {addon.images.map(img => (
            <div key={img.id} style={{padding:8,background:"#fff",border:"1px solid #e5e7eb",borderRadius:8}}>
              <div style={{position:"relative",height:100,overflow:"hidden",borderRadius:6,background:"#f1f5f9"}}>
                <img src={img.imageUrl} alt={img.capturePointName} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
              </div>
              <input value={img.capturePointName} onChange={e=>onUpdateImage(img.id,{capturePointName:e.target.value})}
                placeholder="촬영 위치명 (예: 키즈카페 입구)"
                style={{width:"100%",padding:"5px 8px",fontSize:11,border:"1px solid #e5e7eb",borderRadius:5,marginTop:6}}/>
              <div style={{display:"flex",gap:4,marginTop:4,fontSize:10}}>
                <input type="number" value={img.cameraHeightCm} onChange={e=>onUpdateImage(img.id,{cameraHeightCm:Number(e.target.value)})}
                  placeholder="카메라높이(cm)" style={{flex:1,padding:"3px 6px",fontSize:10,border:"1px solid #e5e7eb",borderRadius:4}}/>
                <input type="number" value={img.headingDeg} onChange={e=>onUpdateImage(img.id,{headingDeg:Number(e.target.value)})}
                  placeholder="방향(°)" style={{flex:1,padding:"3px 6px",fontSize:10,border:"1px solid #e5e7eb",borderRadius:4}}/>
                <button onClick={()=>onRemove(img.id)} style={{padding:"3px 6px",fontSize:10,background:"#fff",border:"1px solid #fca5a5",color:"#dc2626",borderRadius:4,cursor:"pointer"}}>🗑️</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{marginTop:12,padding:10,background:"#eff6ff",border:"1px solid #bfdbfe",borderRadius:6,fontSize:10,color:"#1e40af",lineHeight:1.5}}>
        💡 <strong>팁:</strong> 각 구역의 입구·중앙·복도 등 다양한 지점에서 3장 이상 찍으면 정확도가 높아집니다.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Tab: 기준 치수 (스케일 보정)
// ─────────────────────────────────────────────────────────────────────
function CalibrationTab({ addon, onAdd, onRemove }) {
  const [label, setLabel] = useState("");
  const [imgId, setImgId] = useState(addon.images?.[0]?.id || "");
  const [dist, setDist] = useState("");
  const [memo, setMemo] = useState("");

  return (
    <div>
      <div style={{padding:12,background:"#fff",border:"1px solid #e5e7eb",borderRadius:8,marginBottom:10}}>
        <div style={{fontSize:12,fontWeight:800,color:"#0f172a",marginBottom:8}}>＋ 기준 치수 추가</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,fontSize:11}}>
          <div>
            <Lbl>대상 사진</Lbl>
            <select value={imgId} onChange={e=>setImgId(e.target.value)} style={{width:"100%",padding:8,border:"1px solid #e5e7eb",borderRadius:6,fontSize:11}}>
              <option value="">전체 적용</option>
              {(addon.images||[]).map(i => <option key={i.id} value={i.id}>{i.capturePointName}</option>)}
            </select>
          </div>
          <div>
            <Lbl>라벨</Lbl>
            <Inp value={label} onChange={setLabel} placeholder="예: 출입문 폭, 타일 한 칸"/>
          </div>
          <div>
            <Lbl>실제 거리 (m)</Lbl>
            <Inp value={dist} onChange={setDist} placeholder="0.9" type="number" step="0.01"/>
          </div>
          <div>
            <Lbl>메모 (선택)</Lbl>
            <Inp value={memo} onChange={setMemo} placeholder="기타 정보"/>
          </div>
        </div>
        <button onClick={()=>{
          if (!label.trim() || !dist) return alert("라벨과 거리는 필수");
          onAdd({ imageId:imgId, label:label.trim(), realDistanceM:Number(dist), memo:memo.trim() });
          setLabel(""); setDist(""); setMemo("");
        }}
          style={{marginTop:8,padding:"7px 14px",background:"#3b5bdb",color:"#fff",border:"none",borderRadius:6,fontWeight:700,fontSize:11,cursor:"pointer"}}>
          기준 치수 등록
        </button>
      </div>

      {(addon.calibrations||[]).length === 0 ? (
        <div style={{padding:20,textAlign:"center",color:"#94a3b8",fontSize:12,background:"#f8fafc",borderRadius:8}}>
          아직 기준 치수가 없습니다. 출입문 폭(0.9m), 타일 한 칸(0.6m) 등을 등록해주세요.
        </div>
      ) : (
        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          {addon.calibrations.map(c => {
            const img = addon.images?.find(i => i.id === c.imageId);
            return (
              <div key={c.id} style={{padding:10,background:"#fff",border:"1px solid #e5e7eb",borderRadius:6,display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:18}}>📏</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12,fontWeight:700,color:"#0f172a"}}>{c.label} <span style={{color:"#10b981"}}>= {c.realDistanceM}m</span></div>
                  <div style={{fontSize:10,color:"#64748b"}}>{img ? `📷 ${img.capturePointName}` : "전체 적용"}{c.memo ? ` · ${c.memo}` : ""}</div>
                </div>
                <button onClick={()=>onRemove(c.id)} style={{padding:"4px 8px",fontSize:10,background:"#fff",border:"1px solid #fca5a5",color:"#dc2626",borderRadius:4,cursor:"pointer"}}>삭제</button>
              </div>
            );
          })}
        </div>
      )}

      <div style={{marginTop:12,padding:10,background:"#fef3c7",border:"1px solid #fcd34d",borderRadius:6,fontSize:10,color:"#92400e",lineHeight:1.5}}>
        💡 <strong>스케일 미확정:</strong> 기준 치수가 없으면 평면도 객체의 실제 크기는 추정값입니다. 표준 출입문 폭(0.9m)이라도 등록하시면 정확도가 향상됩니다.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Tab: 초안 생성 (Mock 분석)
// ─────────────────────────────────────────────────────────────────────
function AnalyzeTab({ addon, analyzing, progress, error, onAnalyze, onSwitchToManual }) {
  const ready = (addon.images?.length || 0) > 0;
  return (
    <div style={{padding:14,background:"#fff",border:"1px solid #e5e7eb",borderRadius:8}}>
      <div style={{textAlign:"center",padding:"20px 0"}}>
        <div style={{fontSize:36,marginBottom:8}}>🤖</div>
        <div style={{fontSize:14,fontWeight:800,color:"#0f172a"}}>파노라마 → 평면도 초안 생성</div>
        <div style={{fontSize:11,color:"#64748b",marginTop:4,maxWidth:480,margin:"4px auto 0"}}>
          현재는 <strong>Mock 분석기</strong>가 동작 중입니다. 사진 개수 + 기준 치수 + 구역명을 바탕으로 합리적인 객체 5~10개를 생성합니다.
          향후 OpenCV/COLMAP/RoomPlan 등 실제 AI 분석기로 교체 가능합니다.
        </div>

        {analyzing ? (
          <div style={{margin:"20px auto",maxWidth:400}}>
            <div style={{height:8,background:"#e5e7eb",borderRadius:4,overflow:"hidden"}}>
              <div style={{height:"100%",width:`${progress}%`,background:"linear-gradient(90deg,#3b82f6,#8b5cf6)",transition:"width 0.2s"}}/>
            </div>
            <div style={{marginTop:8,fontSize:11,color:"#475569"}}>분석 중... {progress}%</div>
          </div>
        ) : (
          <button onClick={onAnalyze} disabled={!ready}
            style={{marginTop:14,padding:"10px 22px",background:ready?"linear-gradient(135deg,#3b82f6,#1e40af)":"#cbd5e1",color:"#fff",border:"none",borderRadius:8,fontWeight:700,fontSize:13,cursor:ready?"pointer":"not-allowed"}}>
            {ready ? "🚀 초안 생성 시작" : "📷 먼저 사진을 업로드하세요"}
          </button>
        )}

        {error && (
          <div style={{margin:"14px auto",padding:10,maxWidth:400,background:"#fef2f2",border:"1px solid #fecaca",borderRadius:6,fontSize:11,color:"#991b1b"}}>
            ⚠️ 분석 실패: {error}
            <button onClick={onAnalyze} style={{display:"block",margin:"8px auto 0",padding:"5px 12px",background:"#dc2626",color:"#fff",border:"none",borderRadius:5,fontSize:10,cursor:"pointer"}}>다시 시도</button>
            <button onClick={onSwitchToManual} style={{display:"block",margin:"6px auto 0",padding:"5px 12px",background:"#fff",color:"#64748b",border:"1px solid #cbd5e1",borderRadius:5,fontSize:10,cursor:"pointer"}}>수동 편집으로 진행</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Tab: 검토 & 반영
// ─────────────────────────────────────────────────────────────────────
function ReviewTab({ addon, zones, onUpdateObj, onDeleteObj, onImport, onReanalyze, analyzing, onApprove, onReject, onTogglePublic }) {
  const targetZone = zones.find(z => z.id === addon.floorMapId);
  const objs = addon.draftObjects || [];
  const stats = useMemo(() => {
    const byType = {};
    for (const o of objs) byType[o.objectType] = (byType[o.objectType]||0) + 1;
    return byType;
  }, [objs]);

  if (objs.length === 0) {
    return (
      <div style={{padding:30,textAlign:"center",color:"#94a3b8",background:"#f8fafc",borderRadius:8}}>
        아직 초안이 생성되지 않았습니다. 상단 "🤖 초안 생성" 탭에서 분석을 실행하세요.
      </div>
    );
  }

  return (
    <div style={{display:"grid",gridTemplateColumns:"1fr 320px",gap:12}}>
      {/* 좌: 평면도 캔버스 */}
      <div style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:8,padding:10}}>
        <div style={{fontSize:11,fontWeight:700,color:"#475569",marginBottom:6}}>📐 생성된 평면도 초안 ({objs.length}개체)</div>
        <FloorplanCanvas objs={objs}/>
        {/* 통계 */}
        <div style={{display:"flex",gap:6,marginTop:8,flexWrap:"wrap"}}>
          {Object.entries(stats).map(([t,n]) => (
            <span key={t} style={{padding:"2px 7px",background:OBJ_META[t]?.fillColor||"#f1f5f9",color:OBJ_META[t]?.color||"#475569",borderRadius:6,fontSize:10,fontWeight:700}}>
              {OBJ_META[t]?.icon || "•"} {OBJ_META[t]?.label || t} {n}
            </span>
          ))}
        </div>
      </div>

      {/* 우: 객체 목록 + 액션 */}
      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        <div style={{padding:10,background:"#fff",border:"1px solid #e5e7eb",borderRadius:8}}>
          <div style={{fontSize:11,fontWeight:700,color:"#475569",marginBottom:6}}>📋 객체 목록</div>
          <div style={{maxHeight:300,overflowY:"auto"}}>
            {objs.map(o => (
              <div key={o.id} style={{padding:"6px 8px",borderBottom:"1px solid #f1f5f9",display:"flex",alignItems:"center",gap:6,fontSize:11}}>
                <span style={{fontSize:14}}>{OBJ_META[o.objectType]?.icon}</span>
                <div style={{flex:1,minWidth:0}}>
                  <input value={o.name} onChange={e=>onUpdateObj(o.id,{name:e.target.value})}
                    style={{width:"100%",padding:"2px 4px",border:"1px solid transparent",fontSize:11,fontWeight:600,background:"transparent"}}
                    onFocus={e=>e.target.style.border="1px solid #cbd5e1"}
                    onBlur={e=>e.target.style.border="1px solid transparent"}/>
                  <div style={{fontSize:9,color:"#94a3b8"}}>
                    {o.widthM.toFixed(1)}×{o.heightM.toFixed(1)}m · 신뢰도 {Math.round(o.confidenceScore*100)}%
                  </div>
                </div>
                <button onClick={()=>onUpdateObj(o.id,{staffOnly:!o.staffOnly,publicVisible:o.staffOnly})}
                  title={o.staffOnly?"직원전용":"공개"}
                  style={{padding:"2px 5px",fontSize:9,background:o.staffOnly?"#fef3c7":"#dbeafe",color:o.staffOnly?"#92400e":"#1e40af",border:"none",borderRadius:4,cursor:"pointer",fontWeight:700}}>
                  {o.staffOnly ? "🔒" : "🌐"}
                </button>
                <button onClick={()=>onDeleteObj(o.id)} style={{padding:"2px 5px",fontSize:10,background:"transparent",border:"none",color:"#dc2626",cursor:"pointer"}}>🗑️</button>
              </div>
            ))}
          </div>
        </div>

        <div style={{padding:10,background:"#eff6ff",border:"1px solid #bfdbfe",borderRadius:8}}>
          <div style={{fontSize:11,fontWeight:800,color:"#1e40af",marginBottom:8}}>📤 기존 지도에 가져오기</div>
          <div style={{fontSize:10,color:"#475569",marginBottom:8}}>대상 구역: <strong>{targetZone?.name || "(없음)"}</strong></div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            <button onClick={()=>onImport(false)}
              style={{padding:"8px 12px",background:"#3b5bdb",color:"#fff",border:"none",borderRadius:6,fontSize:11,fontWeight:700,cursor:"pointer"}}>
              👥 고객 공개 객체만 가져오기
            </button>
            <button onClick={()=>onImport(true)}
              style={{padding:"8px 12px",background:"#fff",color:"#1e40af",border:"1px solid #1e40af",borderRadius:6,fontSize:11,fontWeight:700,cursor:"pointer"}}>
              🔓 직원전용 포함 전체 가져오기
            </button>
          </div>
          <div style={{marginTop:8,padding:6,background:"#fff",borderRadius:4,fontSize:9,color:"#64748b",lineHeight:1.4}}>
            가져온 객체는 ZoneLayoutModal의 마커로 추가됩니다. 기존 객체는 보존됩니다.
          </div>
        </div>

        <div style={{padding:10,background:"#fff",border:"1px solid #e5e7eb",borderRadius:8}}>
          <div style={{fontSize:11,fontWeight:800,color:"#0f172a",marginBottom:6}}>🛡️ 승인 & 공개</div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            <button onClick={onApprove} style={{padding:"5px 10px",fontSize:10,background:addon.approved?"#10b981":"#fff",color:addon.approved?"#fff":"#10b981",border:"1px solid #10b981",borderRadius:4,cursor:"pointer",fontWeight:700}}>
              {addon.approved ? "✅ 승인됨" : "승인"}
            </button>
            <button onClick={onReject} style={{padding:"5px 10px",fontSize:10,background:"#fff",color:"#dc2626",border:"1px solid #fca5a5",borderRadius:4,cursor:"pointer",fontWeight:700}}>반려</button>
            <button onClick={onTogglePublic} style={{padding:"5px 10px",fontSize:10,background:addon.publicVisible?"#3b82f6":"#fff",color:addon.publicVisible?"#fff":"#3b82f6",border:"1px solid #3b82f6",borderRadius:4,cursor:"pointer",fontWeight:700}}>
              {addon.publicVisible ? "👥 고객 공개됨" : "고객 비공개"}
            </button>
          </div>
        </div>

        <button onClick={onReanalyze} disabled={analyzing}
          style={{padding:"7px 12px",background:"#fff",color:"#64748b",border:"1px solid #cbd5e1",borderRadius:6,fontSize:11,cursor:analyzing?"wait":"pointer"}}>
          🔄 다시 분석
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// 평면도 SVG 캔버스 (객체 위치 시각화)
// ─────────────────────────────────────────────────────────────────────
function FloorplanCanvas({ objs }) {
  return (
    <svg viewBox="0 0 100 100" style={{width:"100%",height:340,background:"#f8fafc",border:"1px solid #e5e7eb",borderRadius:6}}>
      {objs.map(o => {
        const meta = OBJ_META[o.objectType] || OBJ_META.wall;
        if (o.objectType === "wall") {
          return <rect key={o.id} x={o.x} y={o.y} width={o.widthM > o.heightM ? o.widthM*1.5 : 0.5} height={o.heightM > o.widthM ? o.heightM*1.2 : 0.5} fill={meta.color} opacity="0.7"/>;
        }
        return (
          <g key={o.id}>
            <rect x={o.x-2} y={o.y-2} width="4" height="4" fill={meta.fillColor} stroke={meta.color} strokeWidth="0.3" opacity={o.staffOnly?0.4:0.8} rx="0.3"/>
            <text x={o.x} y={o.y+0.7} fontSize="2" textAnchor="middle" fill={meta.color}>{meta.icon}</text>
            <text x={o.x} y={o.y+5} fontSize="1.6" textAnchor="middle" fill="#0f172a" style={{pointerEvents:"none"}}>{o.name.slice(0,8)}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Helpers (모달/입력 셸)
// ─────────────────────────────────────────────────────────────────────
function ModalShell({ title, children, onClose }) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.55)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:14}}>
      <div style={{background:"#fff",borderRadius:12,padding:18,maxWidth:520,width:"100%",maxHeight:"90vh",overflowY:"auto",boxShadow:"0 25px 60px rgba(0,0,0,0.3)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <h3 style={{fontSize:15,fontWeight:900,color:"#0f172a",margin:0}}>{title}</h3>
          <button onClick={onClose} style={{background:"transparent",border:"none",fontSize:18,color:"#94a3b8",cursor:"pointer"}}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
function Lbl({ children }) { return <label style={{display:"block",fontSize:10,fontWeight:700,color:"#64748b",marginBottom:4}}>{children}</label>; }
function Inp({ value, onChange, placeholder, type="text", step }) {
  return <input type={type} step={step} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
    style={{width:"100%",padding:"7px 10px",border:"1px solid #e5e7eb",borderRadius:6,fontSize:12,fontFamily:"inherit"}}/>;
}

// ─────────────────────────────────────────────────────────────────────
// 통합 헬퍼: ZoneLayoutModal로 import할 때 호출되는 mapper
// DraftObject → ZoneLayoutModal.markers 형식으로 변환
// ─────────────────────────────────────────────────────────────────────
export function draftObjectsToMarkers(draftObjects) {
  return draftObjects.map((o, i) => ({
    id: `pa_${o.id}`,
    x: Math.max(0, Math.min(100, o.x)),
    y: Math.max(0, Math.min(100, o.y)),
    label: `${OBJ_META[o.objectType]?.icon || "📍"} ${o.name}`,
    productIds: [],
    view: "plan",
    metadata: {
      source: "panorama_addon",
      objectType: o.objectType,
      confidenceScore: o.confidenceScore,
      staffOnly: o.staffOnly,
      publicVisible: o.publicVisible,
    },
  }));
}
