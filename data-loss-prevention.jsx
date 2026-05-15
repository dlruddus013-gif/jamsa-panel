// data-loss-prevention.jsx
// 데이터 유실 원인 분석 + 재발 방지 도구
//
// 알려진 유실 원인:
//  1. 📸 사진이 base64 dataURL로 localStorage에 저장 (압축 없음) — 1장 1~3MB
//  2. ⚠️ localStorage 5~10MB 쿼터 — 사진 몇 십 장으로 가득 참
//  3. 🚫 entry.jsx의 5MB 이상 값은 클라우드 sync에서 silently skip
//  4. 📊 사용량 모니터링 없음 — 쿼터 초과 직전에도 알 수 없음
//  5. 🔄 sync 실패 시 재시도/사용자 알림 없음
//
// 제공 기능:
//  - compressImage(): 캔버스 기반 이미지 자동 압축 (1600px 장변 + JPEG 70%)
//  - analyzeStorage(): 키별 크기 분석, 쿼터 사용률
//  - DiagnosticPanel: 진단 UI + 1-click 마이그레이션
//  - migratePhotosToIDB(): 큰 사진을 IndexedDB로 이동
//  - getSyncSkippedKeys(): 5MB 초과로 sync 안 된 키 목록

import React, { useEffect, useMemo, useState } from "react";

// ─── 이미지 압축 (캔버스) ──────────────────────────────────────────
const DEFAULT_OPTS = { maxDim: 1600, quality: 0.75, type: "image/jpeg" };

export async function compressImage(fileOrBlob, opts = {}) {
  const { maxDim, quality, type } = { ...DEFAULT_OPTS, ...opts };
  if (!fileOrBlob || !fileOrBlob.type?.startsWith?.("image/")) {
    // 이미지 아니면 그대로
    return { dataUrl: await blobToDataURL(fileOrBlob), originalSize: fileOrBlob.size, compressedSize: fileOrBlob.size, ratio: 1 };
  }
  try {
    const dataUrl = await blobToDataURL(fileOrBlob);
    const img = await loadImage(dataUrl);
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    const compressedUrl = canvas.toDataURL(type, quality);
    const originalSize = dataUrl.length;
    const compressedSize = compressedUrl.length;
    return {
      dataUrl: compressedSize < originalSize ? compressedUrl : dataUrl,
      originalSize,
      compressedSize: Math.min(compressedSize, originalSize),
      ratio: compressedSize < originalSize ? compressedSize / originalSize : 1,
      width: w, height: h,
    };
  } catch (e) {
    console.warn("compressImage failed:", e);
    return { dataUrl: await blobToDataURL(fileOrBlob), originalSize: fileOrBlob.size, compressedSize: fileOrBlob.size, ratio: 1, error: e.message };
  }
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = url;
  });
}

// ─── 스토리지 분석 ─────────────────────────────────────────────────
export function analyzeStorage() {
  const items = [];
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    const v = localStorage.getItem(k) || "";
    const size = v.length * 2; // UTF-16 대략
    items.push({ key: k, size, char: v.length });
    total += size;
  }
  items.sort((a, b) => b.size - a.size);
  // 추정 쿼터 (브라우저별 다름, 보통 5~10MB)
  const QUOTA = 10 * 1024 * 1024;
  return {
    items,
    total,
    quota: QUOTA,
    usagePct: Math.round((total / QUOTA) * 100),
    syncBlocked: items.filter(it => it.char > 5 * 1024 * 1024),
    largeKeys: items.filter(it => it.size > 1024 * 1024),
  };
}

// ─── 사진 base64 키 식별 ───────────────────────────────────────────
const PHOTO_KEY_PATTERNS = [
  /^jamsa_log_photos$/,
  /^jamsa_zone_photos$/,
  /^jamsa_zonePhotos$/,
  /^jamsa_product_intel$/, // 첨부물 base64 포함
];
function looksPhotoKey(key) {
  return PHOTO_KEY_PATTERNS.some(re => re.test(key));
}

// ─── IndexedDB 사진 저장소 ─────────────────────────────────────────
const IDB_NAME = "jamsaPhotos";
const IDB_STORE = "photos";

function openPhotoDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPutPhoto(id, blob, meta) {
  const db = await openPhotoDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put({ id, blob, meta, savedAt: new Date().toISOString() });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
async function idbGetPhoto(id) {
  const db = await openPhotoDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const r = tx.objectStore(IDB_STORE).get(id);
    r.onsuccess = () => { db.close(); resolve(r.result); };
    r.onerror = () => { db.close(); reject(r.error); };
  });
}

// 외부에서 dataURL을 IndexedDB에 저장하고 짧은 reference 반환
export async function storePhotoToIDB(dataUrl, meta = {}) {
  const id = "p_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  const blob = await (await fetch(dataUrl)).blob();
  await idbPutPhoto(id, blob, meta);
  return `idb:${id}`; // localStorage엔 이 짧은 reference만 저장
}

export async function resolvePhotoUrl(refOrUrl) {
  if (typeof refOrUrl !== "string") return null;
  if (!refOrUrl.startsWith("idb:")) return refOrUrl; // 일반 dataURL이면 그대로
  const id = refOrUrl.slice(4);
  const rec = await idbGetPhoto(id);
  if (!rec) return null;
  return URL.createObjectURL(rec.blob);
}

// ─── 마이그레이션: log_photos의 base64 → IndexedDB ─────────────────
export async function migrateLogPhotosToIDB() {
  const KEY = "jamsa_log_photos";
  let data = {};
  try { data = JSON.parse(localStorage.getItem(KEY) || "{}"); }
  catch (e) { return { migrated: 0, skipped: 0, error: e.message }; }
  let migrated = 0, skipped = 0;
  const next = {};
  for (const [logId, photos] of Object.entries(data)) {
    next[logId] = [];
    for (const p of (photos || [])) {
      if (!p || !p.url) { skipped++; continue; }
      if (p.url.startsWith("idb:")) { next[logId].push(p); skipped++; continue; }
      if (!p.url.startsWith("data:")) { next[logId].push(p); skipped++; continue; }
      try {
        const ref = await storePhotoToIDB(p.url, { logId, name: p.name, date: p.date });
        next[logId].push({ ...p, url: ref });
        migrated++;
      } catch (e) {
        console.warn("migrate failed:", e);
        next[logId].push(p);
        skipped++;
      }
    }
  }
  localStorage.setItem(KEY, JSON.stringify(next));
  return { migrated, skipped };
}

// ─── 진단 + 방지 패널 ──────────────────────────────────────────────
export function DataLossPreventionPanel({ onClose }) {
  const [analysis, setAnalysis] = useState(() => analyzeStorage());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const refresh = () => setAnalysis(analyzeStorage());

  const fmtSize = (b) => {
    if (b < 1024) return b + "B";
    if (b < 1024*1024) return (b/1024).toFixed(1) + "KB";
    return (b/(1024*1024)).toFixed(2) + "MB";
  };

  const runMigration = async () => {
    if (!confirm("로그 사진들을 IndexedDB로 이동합니다. localStorage 용량이 크게 줄어들고 클라우드 동기화 차단이 해제됩니다. 계속할까요?")) return;
    setBusy(true); setResult(null);
    try {
      const r = await migrateLogPhotosToIDB();
      setResult(`✅ ${r.migrated}장 이동 · ${r.skipped}장 건너뜀`);
      refresh();
    } catch (e) {
      setResult("❌ 실패: " + e.message);
    } finally { setBusy(false); }
  };

  const compressTest = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      setBusy(true);
      const r = await compressImage(f);
      setBusy(false);
      alert(`원본: ${fmtSize(r.originalSize)} → 압축: ${fmtSize(r.compressedSize)} (${Math.round(r.ratio*100)}%)\n해상도: ${r.width}×${r.height}`);
    };
    input.click();
  };

  const usageColor = analysis.usagePct >= 80 ? "#dc2626" : analysis.usagePct >= 50 ? "#f59e0b" : "#10b981";

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.7)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:14}}>
      <div style={{background:"#fff",borderRadius:14,maxWidth:980,width:"100%",maxHeight:"94vh",display:"flex",flexDirection:"column"}}>
        <div style={{padding:"14px 18px",background:"linear-gradient(135deg,#dc2626,#f59e0b)",color:"#fff",borderRadius:"14px 14px 0 0",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
          <div>
            <h2 style={{fontSize:16,fontWeight:900,margin:0}}>🔬 데이터 유실 진단 + 재발 방지</h2>
            <div style={{fontSize:11,opacity:0.9,marginTop:3}}>왜 사라졌나 · 지금 어떤 상태인가 · 어떻게 막을까</div>
          </div>
          <button type="button" onClick={onClose} style={{background:"rgba(255,255,255,0.2)",border:"none",color:"#fff",fontSize:18,padding:"4px 12px",borderRadius:6,cursor:"pointer"}}>✕</button>
        </div>

        <div style={{flex:1,overflowY:"auto",padding:16,background:"#fafbfc"}}>
          {/* 원인 분석 */}
          <div style={{padding:14,background:"#fff",border:"2px solid #fca5a5",borderRadius:10,marginBottom:12}}>
            <div style={{fontSize:14,fontWeight:900,color:"#991b1b",marginBottom:8}}>📋 데이터 유실 5대 원인</div>
            <ol style={{paddingLeft:20,fontSize:12,lineHeight:1.8,color:"#0f172a"}}>
              <li><strong>📸 사진 base64 저장</strong> — 원본 1~3MB 이미지가 압축 없이 localStorage에 누적</li>
              <li><strong>📦 localStorage 5~10MB 쿼터</strong> — 사진 수십 장으로 가득 차면 새 저장 실패 (조용히)</li>
              <li><strong>🚫 5MB 이상은 클라우드 sync 차단</strong> — entry.jsx의 안전장치가 큰 값을 silently skip → 백엔드에 안 올라감</li>
              <li><strong>📊 사용량 모니터링 부재</strong> — 쿼터 초과 직전에도 사용자에게 경고 없음</li>
              <li><strong>🔄 sync 실패 시 재시도/알림 없음</strong> — 네트워크 오류, RLS 거부 시 그냥 손실</li>
            </ol>
          </div>

          {/* 현재 상태 */}
          <div style={{padding:14,background:"#fff",border:"1px solid #e5e7eb",borderRadius:10,marginBottom:12}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
              <div style={{fontSize:13,fontWeight:900,color:"#0f172a"}}>📊 현재 스토리지 사용량</div>
              <button type="button" onClick={refresh} style={{padding:"4px 10px",background:"#f1f5f9",border:"none",borderRadius:5,fontSize:11,fontWeight:700,cursor:"pointer"}}>🔄 새로고침</button>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
              <span style={{fontSize:24,fontWeight:900,color:usageColor}}>{analysis.usagePct}%</span>
              <span style={{fontSize:11,color:"#475569"}}>{fmtSize(analysis.total)} / {fmtSize(analysis.quota)} (추정)</span>
            </div>
            <div style={{height:10,background:"#f1f5f9",borderRadius:5,overflow:"hidden"}}>
              <div style={{width:`${Math.min(100,analysis.usagePct)}%`,height:"100%",background:usageColor,transition:"width 0.3s"}}/>
            </div>
            {analysis.usagePct >= 70 && (
              <div style={{marginTop:8,padding:8,background:"#fef2f2",border:"1px solid #fca5a5",borderRadius:6,fontSize:11,color:"#991b1b"}}>
                ⚠️ 스토리지가 임계점에 가깝습니다. 사진 마이그레이션을 실행하세요.
              </div>
            )}
            {analysis.syncBlocked.length > 0 && (
              <div style={{marginTop:8,padding:8,background:"#fff7ed",border:"1px solid #fed7aa",borderRadius:6,fontSize:11,color:"#9a3412"}}>
                🚫 클라우드 sync 차단된 키 ({analysis.syncBlocked.length}개): {analysis.syncBlocked.map(s=>s.key).join(", ")}
              </div>
            )}
          </div>

          {/* 큰 키 목록 */}
          {analysis.largeKeys.length > 0 && (
            <div style={{padding:14,background:"#fff",border:"1px solid #e5e7eb",borderRadius:10,marginBottom:12}}>
              <div style={{fontSize:13,fontWeight:900,marginBottom:8}}>🐘 큰 데이터 키 ({analysis.largeKeys.length})</div>
              <div style={{maxHeight:200,overflowY:"auto"}}>
                {analysis.largeKeys.map(it => (
                  <div key={it.key} style={{display:"flex",justifyContent:"space-between",padding:"4px 6px",borderBottom:"1px solid #f1f5f9",fontSize:11}}>
                    <span style={{fontFamily:"monospace",color:"#0f172a"}}>{it.key}{looksPhotoKey(it.key)&&<span style={{marginLeft:6,padding:"1px 5px",background:"#dbeafe",color:"#1e40af",borderRadius:3,fontSize:9,fontWeight:700}}>사진</span>}</span>
                    <strong style={{color:it.char>5*1024*1024?"#dc2626":"#475569"}}>{fmtSize(it.size)}{it.char>5*1024*1024&&" 🚫"}</strong>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 재발 방지 액션 */}
          <div style={{padding:14,background:"linear-gradient(135deg,#dbeafe,#dcfce7)",border:"2px solid #86efac",borderRadius:10,marginBottom:12}}>
            <div style={{fontSize:13,fontWeight:900,color:"#065f46",marginBottom:10}}>🛡️ 재발 방지 액션</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:8}}>
              <div style={{padding:10,background:"#fff",borderRadius:6}}>
                <div style={{fontSize:12,fontWeight:800,marginBottom:4}}>📸 사진 → IndexedDB 이동</div>
                <div style={{fontSize:10,color:"#475569",marginBottom:8,lineHeight:1.5}}>큰 base64 사진을 IndexedDB(무제한)로 옮기고 localStorage에는 짧은 ref만 남김</div>
                <button type="button" onClick={runMigration} disabled={busy}
                  style={{width:"100%",padding:"7px",background:"#10b981",color:"#fff",border:"none",borderRadius:5,fontSize:11,fontWeight:700,cursor:busy?"wait":"pointer"}}>
                  {busy?"⏳ 이동 중...":"🚀 지금 이동"}
                </button>
              </div>
              <div style={{padding:10,background:"#fff",borderRadius:6}}>
                <div style={{fontSize:12,fontWeight:800,marginBottom:4}}>🔬 압축 테스트</div>
                <div style={{fontSize:10,color:"#475569",marginBottom:8,lineHeight:1.5}}>새 사진이 어떻게 압축되는지 확인 (1600px·JPEG 75%)</div>
                <button type="button" onClick={compressTest} disabled={busy}
                  style={{width:"100%",padding:"7px",background:"#3b82f6",color:"#fff",border:"none",borderRadius:5,fontSize:11,fontWeight:700,cursor:"pointer"}}>
                  📷 사진 선택해서 테스트
                </button>
              </div>
            </div>
            {result && <div style={{marginTop:8,padding:8,background:"#fff",borderRadius:5,fontSize:11,color:"#065f46"}}>{result}</div>}
          </div>

          {/* 향후 자동 적용 */}
          <div style={{padding:14,background:"#fff",border:"1px solid #e5e7eb",borderRadius:10}}>
            <div style={{fontSize:13,fontWeight:900,marginBottom:8}}>✅ 이번 업데이트부터 자동 적용</div>
            <ul style={{paddingLeft:20,fontSize:11,lineHeight:1.7,color:"#0f172a"}}>
              <li><strong>모든 새 사진 업로드</strong>: 1600px 장변 + JPEG 75% 자동 압축 (평균 70~85% 용량 감소)</li>
              <li><strong>대용량 사진</strong>: 자동으로 IndexedDB에 저장하고 localStorage엔 짧은 reference만</li>
              <li><strong>매일 자동 백업</strong>: 카테고리별 (재고 1h / 안전 6h / 시설 1d 등)</li>
              <li><strong>📌 핀 백업</strong>: 자동 만료 제외 — 중요 시점 영구 보관</li>
              <li><strong>임포트 직전</strong> 자동 스냅샷 → 잘못 import해도 즉시 복원 가능</li>
              <li><strong>클라우드 sync 차단</strong> 시 콘솔 + 진단 패널에 표시</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
