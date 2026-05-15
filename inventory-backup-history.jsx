// inventory-backup-history.jsx
// 재고 파일 다운/업로드 이력 + 파일 보존 + 데이터 손실 방지
//
// 기능:
// 1. 모든 다운로드/업로드 파일을 IndexedDB에 보관 (시간별 이력)
// 2. 언제든 과거 파일 재다운로드
// 3. 일일 자동 전체 백업 (prods + payments + hist 등)
// 4. 데이터 형식 변경 시 보호 (안전한 마이그레이션)
//
// 데이터 저장:
// - localStorage: jamsa_inv_backup_history (메타데이터 리스트, 마지막 200건)
// - IndexedDB: jamsaBackups store (실제 파일 Blob, 무제한)

import React, { useEffect, useState } from "react";

const META_KEY = "jamsa_inv_backup_history";
const DB_NAME = "jamsaBackups";
const STORE = "files";
const AUTO_BACKUP_KEY = "jamsa_inv_last_auto_backup";

// ─── IndexedDB ─────────────────────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putBlob(id, blob, meta) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ id, blob, meta, savedAt: new Date().toISOString() });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function getBlob(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const r = tx.objectStore(STORE).get(id);
    r.onsuccess = () => { db.close(); resolve(r.result); };
    r.onerror = () => { db.close(); reject(r.error); };
  });
}

async function deleteBlob(id) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => { db.close(); resolve(); };
  });
}

// ─── 메타데이터 ────────────────────────────────────────────────────
function loadMeta() {
  try { return JSON.parse(localStorage.getItem(META_KEY) || "[]"); }
  catch (e) { return []; }
}
function saveMeta(list) {
  try { localStorage.setItem(META_KEY, JSON.stringify(list.slice(0, 200))); } catch (e) {}
}

// ─── 외부 API ──────────────────────────────────────────────────────
export async function logFileEvent({ kind, filename, blob, summary, by }) {
  // kind: "download" | "upload" | "auto_snapshot"
  const id = "f_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  const meta = {
    id,
    kind,
    filename,
    mime: blob.type || "application/octet-stream",
    size: blob.size,
    at: new Date().toISOString(),
    by: by || "system",
    summary: summary || "",
  };
  try {
    await putBlob(id, blob, meta);
    const list = loadMeta();
    list.unshift(meta);
    saveMeta(list);
    return meta;
  } catch (e) {
    console.warn("[backup] putBlob failed:", e.message);
    // IndexedDB 실패 시 메타만 기록 (file 없이)
    const list = loadMeta();
    list.unshift({ ...meta, _failed: true });
    saveMeta(list);
    return meta;
  }
}

export async function downloadHistoryFile(id) {
  const rec = await getBlob(id);
  if (!rec || !rec.blob) { alert("파일을 찾을 수 없습니다 (IndexedDB에 없음)"); return; }
  const url = URL.createObjectURL(rec.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = rec.meta?.filename || `backup_${id}.bin`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (e) {} }, 200);
}

export async function deleteHistoryFile(id) {
  await deleteBlob(id);
  const list = loadMeta().filter(m => m.id !== id);
  saveMeta(list);
}

export function getHistory() { return loadMeta(); }

// ─── 자동 일일 백업 ────────────────────────────────────────────────
export async function maybeAutoBackup(curUserName) {
  try {
    const last = localStorage.getItem(AUTO_BACKUP_KEY);
    const today = new Date().toISOString().slice(0, 10);
    if (last === today) return null;

    const snapshot = {
      version: 1,
      createdAt: new Date().toISOString(),
      by: curUserName || "system",
      data: {},
    };
    const keys = [
      "jamsa_inv_prods", "jamsa_inv_products", "jamsa_inv_hist", "jamsa_payments",
      "jamsa_requisitions", "jamsa_product_intel", "jamsa_log_photos",
      "jamsa_zone_schedule_tasks", "jamsa_zonePhotos", "jamsa_zone_photos",
      "jamsa_facilities", "jamsa_facActions", "jamsa_fac_actions", "jamsa_fac_inspections", "jamsa_zones",
      "jamsa_categories", "jamsa_locations", "jamsa_storage_sections",
      "jamsa_worklogs", "jamsa_worklog_active_checks", "jamsa_worklog_staff",
      "jamsa_incidents", "jamsa_daily_checks", "jamsa_audit_log",
      "jamsa_warehouse_models", "jamsa_custom_zones",
    ];
    keys.forEach(k => {
      const v = localStorage.getItem(k);
      if (v) snapshot.data[k] = JSON.parse(v);
    });

    const json = JSON.stringify(snapshot);
    const blob = new Blob([json], { type: "application/json" });
    await logFileEvent({
      kind: "auto_snapshot",
      filename: `잠사_자동백업_${today}.json`,
      blob,
      summary: `${Object.keys(snapshot.data).length}개 데이터 키 · ${Math.round(blob.size / 1024)}KB`,
      by: curUserName || "system",
    });
    localStorage.setItem(AUTO_BACKUP_KEY, today);
    return today;
  } catch (e) {
    console.warn("[autoBackup] failed:", e);
    return null;
  }
}

// ─── 수동 전체 백업 ────────────────────────────────────────────────
export async function manualFullBackup(curUserName) {
  const today = new Date().toISOString();
  const snapshot = { version: 1, createdAt: today, by: curUserName || "user", data: {} };
  const allKeys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("jamsa_") && !k.includes("sb_session") && !k.includes("auto_backup")) {
      allKeys.push(k);
    }
  }
  allKeys.forEach(k => {
    const v = localStorage.getItem(k);
    if (v) {
      try { snapshot.data[k] = JSON.parse(v); }
      catch (e) { snapshot.data[k] = v; }
    }
  });
  const json = JSON.stringify(snapshot);
  const blob = new Blob([json], { type: "application/json" });
  await logFileEvent({
    kind: "manual_backup",
    filename: `잠사_전체백업_${today.slice(0,10)}_${today.slice(11,16).replace(":","")}.json`,
    blob,
    summary: `${allKeys.length}개 데이터 키 · ${Math.round(blob.size / 1024)}KB`,
    by: curUserName || "user",
  });
  // 즉시 다운로드도
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `잠사_전체백업_${today.slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (e) {} }, 200);
  return allKeys.length;
}

// ─── 백업에서 복원 ─────────────────────────────────────────────────
export async function restoreFromBackup(snapshot, options = { merge: true }) {
  if (!snapshot || !snapshot.data) throw new Error("잘못된 백업 파일");
  let restored = 0, skipped = 0;
  Object.entries(snapshot.data).forEach(([key, value]) => {
    try {
      if (options.merge) {
        // 머지: 현재 데이터가 비어있을 때만 덮어쓰기 (보수적)
        const current = localStorage.getItem(key);
        if (!current || current === "[]" || current === "{}") {
          localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
          restored++;
        } else {
          skipped++;
        }
      } else {
        // 전체 덮어쓰기
        localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
        restored++;
      }
    } catch (e) { console.warn("restore key failed:", key, e); }
  });
  return { restored, skipped };
}

// ─── UI: 이력 패널 (모달용) ────────────────────────────────────────
export function BackupHistoryPanel({ curUserName }) {
  const [list, setList] = useState(() => loadMeta());
  const [busy, setBusy] = useState(false);

  const refresh = () => setList(loadMeta());

  const onDownload = async (id) => {
    setBusy(true);
    try { await downloadHistoryFile(id); }
    finally { setBusy(false); }
  };
  const onDelete = async (id) => {
    if (!confirm("이 백업 파일을 삭제할까요?")) return;
    await deleteHistoryFile(id);
    refresh();
  };
  const onManualBackup = async () => {
    setBusy(true);
    try {
      const n = await manualFullBackup(curUserName);
      alert(`✅ ${n}개 데이터 키 백업 완료 (다운로드 + 이력에 저장)`);
      refresh();
    } catch (e) { alert("백업 실패: " + e.message); }
    finally { setBusy(false); }
  };
  const onRestoreFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!confirm(`"${file.name}" 백업에서 복원합니다.\n현재 비어있는 데이터에만 덮어씁니다 (안전 머지 모드). 계속할까요?`)) return;
    setBusy(true);
    try {
      const text = await file.text();
      const snapshot = JSON.parse(text);
      const { restored, skipped } = await restoreFromBackup(snapshot, { merge: true });
      alert(`✅ 복원: ${restored}건 · 건너뜀(데이터 있음): ${skipped}건\n새로고침하면 반영됩니다.`);
    } catch (e) { alert("복원 실패: " + e.message); }
    finally { setBusy(false); }
  };
  const onRestoreFromHistory = async (id) => {
    if (!confirm("이 백업으로 복원할까요? (현재 비어있는 데이터에만 덮어씁니다)")) return;
    setBusy(true);
    try {
      const rec = await getBlob(id);
      if (!rec) throw new Error("파일 없음");
      const text = await rec.blob.text();
      const snapshot = JSON.parse(text);
      const { restored, skipped } = await restoreFromBackup(snapshot, { merge: true });
      alert(`✅ 복원: ${restored}건 · 건너뜀: ${skipped}건\n새로고침하세요.`);
    } catch (e) { alert("복원 실패: " + e.message); }
    finally { setBusy(false); }
  };

  const kindMeta = {
    download:      { icon: "📥", label: "다운로드", color: "#3b82f6" },
    upload:        { icon: "📤", label: "업로드",   color: "#10b981" },
    auto_snapshot: { icon: "🛡️", label: "자동백업", color: "#7c3aed" },
    manual_backup: { icon: "💾", label: "수동백업", color: "#dc2626" },
  };

  return (
    <div style={{padding:12,background:"#fff",border:"2px solid #c7d2fe",borderRadius:10,marginTop:10}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8,gap:8,flexWrap:"wrap"}}>
        <div>
          <div style={{fontSize:13,fontWeight:900,color:"#3730a3"}}>📚 파일 이력 + 데이터 보호</div>
          <div style={{fontSize:10,color:"#64748b",marginTop:2}}>업로드/다운로드 파일 자동 보관 + 매일 1회 자동 백업</div>
        </div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          <button type="button" onClick={onManualBackup} disabled={busy}
            style={{padding:"6px 12px",background:"#dc2626",color:"#fff",border:"none",borderRadius:6,fontSize:11,fontWeight:700,cursor:busy?"wait":"pointer"}}>
            💾 지금 전체 백업
          </button>
          <label style={{padding:"6px 12px",background:"#fff",color:"#dc2626",border:"1px solid #dc2626",borderRadius:6,fontSize:11,fontWeight:700,cursor:"pointer"}}>
            📂 백업 복원
            <input type="file" accept=".json" onChange={onRestoreFile} style={{display:"none"}}/>
          </label>
        </div>
      </div>

      <div style={{fontSize:10,color:"#64748b",marginBottom:6}}>총 {list.length}건 (최신순)</div>

      {list.length === 0 ? (
        <div style={{padding:14,textAlign:"center",fontSize:11,color:"#94a3b8",background:"#f8fafc",borderRadius:6}}>
          아직 이력이 없습니다. 양식을 받거나 파일을 업로드하면 자동으로 기록됩니다.
        </div>
      ) : (
        <div style={{maxHeight:200,overflowY:"auto",border:"1px solid #e5e7eb",borderRadius:6}}>
          {list.map(m => {
            const meta = kindMeta[m.kind] || { icon:"📄", label:m.kind, color:"#64748b" };
            return (
              <div key={m.id} style={{padding:"6px 10px",borderBottom:"1px solid #f1f5f9",display:"flex",alignItems:"center",gap:8,fontSize:11}}>
                <span style={{fontSize:18}}>{meta.icon}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:700,color:"#0f172a",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{m.filename}</div>
                  <div style={{fontSize:9,color:"#64748b"}}>
                    <span style={{padding:"1px 5px",background:meta.color+"22",color:meta.color,borderRadius:3,fontWeight:700,marginRight:4}}>{meta.label}</span>
                    {new Date(m.at).toLocaleString("ko-KR")} · {m.by} · {Math.round((m.size||0)/1024)}KB
                    {m.summary && ` · ${m.summary}`}
                    {m._failed && <span style={{color:"#dc2626",fontWeight:700}}> · ⚠️ 파일 저장 실패 (메타만)</span>}
                  </div>
                </div>
                {(m.kind === "auto_snapshot" || m.kind === "manual_backup") && !m._failed && (
                  <button type="button" onClick={()=>onRestoreFromHistory(m.id)} disabled={busy}
                    style={{padding:"4px 8px",background:"#fef3c7",color:"#92400e",border:"none",borderRadius:4,fontSize:10,fontWeight:700,cursor:"pointer"}}
                    title="이 백업으로 복원 (안전 머지)">
                    ♻️ 복원
                  </button>
                )}
                {!m._failed && (
                  <button type="button" onClick={()=>onDownload(m.id)} disabled={busy}
                    style={{padding:"4px 8px",background:"#3b82f6",color:"#fff",border:"none",borderRadius:4,fontSize:10,fontWeight:700,cursor:"pointer"}}>
                    📥 받기
                  </button>
                )}
                <button type="button" onClick={()=>onDelete(m.id)}
                  style={{padding:"4px 6px",background:"#fee2e2",color:"#dc2626",border:"none",borderRadius:4,fontSize:10,cursor:"pointer"}}>
                  🗑️
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
