// inventory-backup-history.jsx
// 재고 파일 다운/업로드 이력 + 파일 보존 + 데이터 손실 방지 (세분화 백업)
//
// 데이터 카테고리 (8개):
//  📦 재고 / 💳 결제·품의 / 🛡️ 안전 / 🏢 시설 / 📋 분류 / 📹 IoT·CCTV / 📝 업무일지 / 👥 사용자
// 각 카테고리별로 독립 백업/복원/주기/보관 정책.
//
// 자동 트리거: 변경 감지(debounce) / 임포트 직전 / 일일 / 변경 시 강제

import React, { useEffect, useMemo, useRef, useState } from "react";

const META_KEY = "jamsa_inv_backup_history";
const DB_NAME = "jamsaBackups";
const STORE = "files";
const AUTO_BACKUP_KEY = "jamsa_inv_last_auto_backup";
const POLICY_KEY = "jamsa_backup_policy";

// ─── 카테고리 정의 ─────────────────────────────────────────────────
export const BACKUP_CATEGORIES = {
  inventory: {
    label: "📦 재고",
    icon: "📦",
    color: "#3b82f6",
    bg: "#dbeafe",
    keys: ["jamsa_inv_prods", "jamsa_inv_hist", "jamsa_log_photos", "jamsa_inv_snapshots", "jamsa_inv_excel_backup"],
    desc: "제품·재고이력·로그사진",
  },
  payments: {
    label: "💳 결제·품의",
    icon: "💳",
    color: "#f59e0b",
    bg: "#fef3c7",
    keys: ["jamsa_payments", "jamsa_requisitions", "jamsa_product_intel"],
    desc: "카드·이체·품의·인텔리전스",
  },
  safety: {
    label: "🛡️ 안전관리",
    icon: "🛡️",
    color: "#dc2626",
    bg: "#fee2e2",
    keys: ["jamsa_facActions", "jamsa_insurances", "jamsa_safety_schedule", "jamsa_safety_reports", "jamsa_zone_schedule_tasks", "jamsa_auto_hazards", "jamsa_safety_drafts"],
    desc: "조치·보험·일정·자동감지",
  },
  facilities: {
    label: "🏢 시설·구역",
    icon: "🏢",
    color: "#10b981",
    bg: "#dcfce7",
    keys: ["jamsa_facilities", "jamsa_zones", "jamsa_zone_photos", "jamsa_zonePhotos", "jamsa_zone_layouts", "jamsa_storage_sections"],
    desc: "시설·구역·평면도·선반",
  },
  catalog: {
    label: "📋 분류·위치",
    icon: "📋",
    color: "#8b5cf6",
    bg: "#ede9fe",
    keys: ["jamsa_categories", "jamsa_locations", "jamsa_inv_cats", "jamsa_inv_locs"],
    desc: "카테고리·위치 정의",
  },
  iot: {
    label: "📹 IoT·CCTV",
    icon: "📹",
    color: "#06b6d4",
    bg: "#cffafe",
    keys: ["jamsa_cctv_nvr_configs", "jamsa_cctv_snap_server", "jamsa_cctv_local_bridge", "jamsa_iot_devices", "jamsa_automations", "jamsa_anthropic_model"],
    desc: "CCTV·NVR·자동화",
  },
  worklog: {
    label: "📝 업무일지",
    icon: "📝",
    color: "#0ea5e9",
    bg: "#e0f2fe",
    keys: ["jamsa_worklogs", "jamsa_recent_actions", "jamsa_search_history", "jamsa_chatbot_history"],
    desc: "업무일지·검색·챗봇",
  },
  users: {
    label: "👥 사용자",
    icon: "👥",
    color: "#64748b",
    bg: "#f1f5f9",
    keys: ["jamsa_users", "jamsa_user_settings", "jamsa_prod_sort"],
    desc: "사용자·권한·설정",
  },
};

// 카테고리에 속하지 않는 jamsa_* 키는 "기타"로 분류
function classifyKey(key) {
  for (const [cat, def] of Object.entries(BACKUP_CATEGORIES)) {
    if (def.keys.some(k => key === k || key.startsWith(k + "_"))) return cat;
  }
  return "etc";
}

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
  try { localStorage.setItem(META_KEY, JSON.stringify(list.slice(0, 500))); } catch (e) {}
}

// ─── 정책 ──────────────────────────────────────────────────────────
const DEFAULT_POLICY = {
  enabled: true,
  intervals: {
    inventory:  "1h",
    payments:   "1h",
    safety:     "6h",
    facilities: "1d",
    catalog:    "1d",
    iot:        "1d",
    worklog:    "6h",
    users:      "1d",
  },
  retentionDays: 30,
  pinKeepForever: true,
  triggerOnChange: true,
  triggerBeforeImport: true,
  cloudSync: false,
};

export function loadPolicy() {
  try {
    const saved = JSON.parse(localStorage.getItem(POLICY_KEY) || "null");
    return { ...DEFAULT_POLICY, ...(saved || {}), intervals: { ...DEFAULT_POLICY.intervals, ...(saved?.intervals || {}) } };
  } catch (e) { return DEFAULT_POLICY; }
}
export function savePolicy(p) {
  try { localStorage.setItem(POLICY_KEY, JSON.stringify(p)); } catch (e) {}
}

const INTERVAL_MS = { "5m": 5*60e3, "30m": 30*60e3, "1h": 60*60e3, "6h": 6*60*60e3, "1d": 24*60*60e3, "1w": 7*24*60*60e3, never: Infinity };
const INTERVAL_LABEL = { "5m": "5분", "30m": "30분", "1h": "1시간", "6h": "6시간", "1d": "1일", "1w": "1주", never: "비활성" };

// ─── 백업 만들기 ───────────────────────────────────────────────────
function snapshotKeys(keys) {
  const data = {};
  keys.forEach(k => {
    const v = localStorage.getItem(k);
    if (v !== null) {
      try { data[k] = JSON.parse(v); } catch (e) { data[k] = v; }
    }
  });
  return data;
}

export async function backupCategory(categoryId, opts = {}) {
  const def = BACKUP_CATEGORIES[categoryId];
  if (!def) throw new Error("알 수 없는 카테고리: " + categoryId);
  // 카테고리 키 + 접두사 매칭
  const allKeys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && classifyKey(k) === categoryId) allKeys.push(k);
  }
  const data = snapshotKeys(allKeys);
  const snapshot = {
    version: 2,
    category: categoryId,
    categoryLabel: def.label,
    createdAt: new Date().toISOString(),
    by: opts.by || "system",
    trigger: opts.trigger || "manual",
    keyCount: allKeys.length,
    data,
  };
  const json = JSON.stringify(snapshot);
  const blob = new Blob([json], { type: "application/json" });
  const date = new Date().toISOString();
  const meta = await logFileEvent({
    kind: opts.trigger === "auto" ? "auto_snapshot" : "manual_backup",
    category: categoryId,
    filename: `${categoryId}_${date.slice(0,10)}_${date.slice(11,16).replace(":","")}.json`,
    blob,
    summary: `${def.label} · ${allKeys.length}개 키 · ${Math.round(blob.size/1024)}KB`,
    by: opts.by || "system",
    pinned: opts.pinned || false,
  });
  return { meta, snapshot };
}

export async function backupAll(opts = {}) {
  const results = [];
  for (const catId of Object.keys(BACKUP_CATEGORIES)) {
    try { results.push(await backupCategory(catId, opts)); }
    catch (e) { console.warn("backup category failed:", catId, e); }
  }
  return results;
}

// ─── 파일 이벤트 로깅 ─────────────────────────────────────────────
export async function logFileEvent({ kind, filename, blob, summary, by, category, pinned }) {
  const id = "f_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  const meta = {
    id, kind, filename,
    mime: blob.type || "application/octet-stream",
    size: blob.size,
    at: new Date().toISOString(),
    by: by || "system",
    summary: summary || "",
    category: category || null,
    pinned: !!pinned,
  };
  try {
    await putBlob(id, blob, meta);
    const list = loadMeta();
    list.unshift(meta);
    saveMeta(list);
    return meta;
  } catch (e) {
    console.warn("[backup] putBlob failed:", e.message);
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

export async function togglePin(id) {
  const list = loadMeta();
  const idx = list.findIndex(m => m.id === id);
  if (idx < 0) return;
  list[idx] = { ...list[idx], pinned: !list[idx].pinned };
  saveMeta(list);
  // IndexedDB의 meta도 갱신
  try {
<<<<<<< HEAD
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
=======
    const rec = await getBlob(id);
    if (rec) {
      const db = await openDB();
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ ...rec, meta: { ...rec.meta, pinned: list[idx].pinned } });
      tx.oncomplete = () => db.close();
    }
  } catch (e) {}
>>>>>>> cd26e23 (feat(backup): granular category-based backup manager with auto policy)
}

// ─── 자동 보관 정리 (만료 백업 삭제, 핀은 보존) ─────────────────────
export async function purgeExpiredBackups() {
  const policy = loadPolicy();
  if (!policy.retentionDays || policy.retentionDays <= 0) return 0;
  const cutoff = Date.now() - policy.retentionDays * 24*60*60e3;
  const list = loadMeta();
  const toDelete = list.filter(m => {
    if (m.pinned && policy.pinKeepForever) return false;
    if (m.kind !== "auto_snapshot") return false; // 자동 백업만 정리
    return new Date(m.at).getTime() < cutoff;
  });
  for (const m of toDelete) {
    try { await deleteHistoryFile(m.id); } catch (e) {}
  }
  return toDelete.length;
}

// ─── 카테고리별 자동 백업 트리거 ───────────────────────────────────
export async function runAutoBackupsIfDue(curUserName) {
  const policy = loadPolicy();
  if (!policy.enabled) return [];
  const list = loadMeta();
  const now = Date.now();
  const done = [];
  for (const [catId] of Object.entries(BACKUP_CATEGORIES)) {
    const interval = policy.intervals[catId] || "1d";
    if (interval === "never") continue;
    const ms = INTERVAL_MS[interval];
    if (!ms || ms === Infinity) continue;
    const last = list.find(m => m.kind === "auto_snapshot" && m.category === catId);
    if (last && (now - new Date(last.at).getTime()) < ms) continue;
    try {
      const r = await backupCategory(catId, { trigger: "auto", by: curUserName || "auto" });
      done.push(r.meta);
    } catch (e) { console.warn("auto backup failed:", catId, e); }
  }
  if (done.length > 0) await purgeExpiredBackups();
  return done;
}

// 기존 maybeAutoBackup 인터페이스 호환 + 신규 정책 기반 실행
export async function maybeAutoBackup(curUserName) {
  // 정책 기반 카테고리별 자동 백업
  const done = await runAutoBackupsIfDue(curUserName);
  return done.length > 0 ? done.length : null;
}

// ─── 수동 전체 백업 (다운로드까지) ─────────────────────────────────
export async function manualFullBackup(curUserName) {
  const today = new Date().toISOString();
  const snapshot = { version: 2, type: "full", createdAt: today, by: curUserName || "user", data: {} };
  const allKeys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("jamsa_") && !k.includes("sb_session") && !k.includes("auto_backup")) {
      allKeys.push(k);
    }
  }
  allKeys.forEach(k => {
    const v = localStorage.getItem(k);
    if (v) { try { snapshot.data[k] = JSON.parse(v); } catch (e) { snapshot.data[k] = v; } }
  });
  const json = JSON.stringify(snapshot);
  const blob = new Blob([json], { type: "application/json" });
  await logFileEvent({
    kind: "manual_backup",
    filename: `잠사_전체백업_${today.slice(0,10)}_${today.slice(11,16).replace(":","")}.json`,
    blob,
    summary: `전체 ${allKeys.length}개 키 · ${Math.round(blob.size / 1024)}KB`,
    by: curUserName || "user",
    pinned: true,
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `잠사_전체백업_${today.slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (e) {} }, 200);
  return allKeys.length;
}

// ─── 복원 (선택적) ────────────────────────────────────────────────
export async function restoreFromBackup(snapshot, options = {}) {
  if (!snapshot || !snapshot.data) throw new Error("잘못된 백업 파일");
  const mode = options.mode || "merge"; // merge | overwrite
  const onlyKeys = options.onlyKeys || null; // 특정 키만
  const onlyCategories = options.onlyCategories || null; // 카테고리 필터
  let restored = 0, skipped = 0;
  Object.entries(snapshot.data).forEach(([key, value]) => {
    if (onlyKeys && !onlyKeys.includes(key)) return;
    if (onlyCategories) {
      const cat = classifyKey(key);
      if (!onlyCategories.includes(cat)) return;
    }
    try {
      if (mode === "merge") {
        const current = localStorage.getItem(key);
        if (!current || current === "[]" || current === "{}" || current === "null") {
          localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
          restored++;
        } else { skipped++; }
      } else {
        localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
        restored++;
      }
    } catch (e) { console.warn("restore key failed:", key, e); }
  });
  return { restored, skipped };
}

// ─── 백업 파일 미리보기 ────────────────────────────────────────────
export async function previewBackup(id) {
  const rec = await getBlob(id);
  if (!rec || !rec.blob) return null;
  try {
    const text = await rec.blob.text();
    const snapshot = JSON.parse(text);
    if (!snapshot.data) return { meta: rec.meta, error: "데이터 없음" };
    const byCategory = {};
    Object.keys(snapshot.data).forEach(k => {
      const cat = classifyKey(k);
      if (!byCategory[cat]) byCategory[cat] = { count: 0, keys: [] };
      byCategory[cat].count++;
      byCategory[cat].keys.push(k);
    });
    return { meta: rec.meta, snapshot, byCategory };
  } catch (e) {
    return { meta: rec.meta, error: e.message };
  }
}

// ─── UI: 통합 백업 관리자 모달 ──────────────────────────────────────
export function BackupManagerModal({ onClose, curUserName }) {
  const [tab, setTab] = useState("categories");
  const [list, setList] = useState(() => loadMeta());
  const [policy, setPolicyState] = useState(() => loadPolicy());
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [filter, setFilter] = useState({ kind: "all", category: "all", q: "" });

  const refresh = () => setList(loadMeta());

  const updatePolicy = (patch) => {
    const next = { ...policy, ...patch };
    setPolicyState(next);
    savePolicy(next);
  };
  const updateInterval = (cat, val) => {
    const next = { ...policy, intervals: { ...policy.intervals, [cat]: val } };
    setPolicyState(next);
    savePolicy(next);
  };

  const onBackupCategory = async (catId) => {
    setBusy(true);
    try {
      await backupCategory(catId, { by: curUserName, trigger: "manual" });
      refresh();
    } catch (e) { alert("백업 실패: " + e.message); }
    finally { setBusy(false); }
  };
  const onBackupAll = async () => {
    setBusy(true);
    try {
      const r = await backupAll({ by: curUserName, trigger: "manual" });
      alert(`✅ ${r.length}개 카테고리 백업 완료`);
      refresh();
    } catch (e) { alert("실패: " + e.message); }
    finally { setBusy(false); }
  };
  const onManualFull = async () => {
    setBusy(true);
    try {
      const n = await manualFullBackup(curUserName);
      alert(`✅ 전체 ${n}개 키 백업 + 다운로드 완료`);
      refresh();
    } catch (e) { alert("실패: " + e.message); }
    finally { setBusy(false); }
  };
  const onDownload = async (id) => {
    setBusy(true);
    try { await downloadHistoryFile(id); } finally { setBusy(false); }
  };
  const onDelete = async (id) => {
    if (!confirm("이 백업을 삭제할까요?")) return;
    await deleteHistoryFile(id); refresh();
  };
  const onPin = async (id) => {
    await togglePin(id); refresh();
  };
  const onPreview = async (id) => {
    setBusy(true);
    try { setPreview(await previewBackup(id)); }
    finally { setBusy(false); }
  };
  const onRestoreFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!confirm(`"${file.name}" 백업에서 복원합니다.\n(머지 모드: 비어있는 키만 덮어씀)`)) return;
    setBusy(true);
    try {
      const text = await file.text();
      const snapshot = JSON.parse(text);
      const { restored, skipped } = await restoreFromBackup(snapshot, { mode: "merge" });
      alert(`✅ 복원 ${restored}건 · 건너뜀 ${skipped}건\n새로고침하면 반영됩니다.`);
    } catch (e) { alert("복원 실패: " + e.message); }
    finally { setBusy(false); }
  };
  const onPurge = async () => {
    if (!confirm(`보관기간 ${policy.retentionDays}일 초과한 자동 백업을 정리합니다. (📌 핀 백업은 유지) 계속할까요?`)) return;
    setBusy(true);
    try {
      const n = await purgeExpiredBackups();
      alert(`✅ ${n}건 정리 완료`);
      refresh();
    } finally { setBusy(false); }
  };

  // 카테고리별 마지막 백업 + 다음 예정
  const catStatus = useMemo(() => {
    const m = {};
    Object.keys(BACKUP_CATEGORIES).forEach(cat => {
      const last = list.find(x => x.category === cat);
      const interval = policy.intervals[cat] || "1d";
      const ms = INTERVAL_MS[interval];
      const nextDue = last && ms !== Infinity ? new Date(new Date(last.at).getTime() + ms) : null;
      m[cat] = { last, interval, nextDue };
    });
    return m;
  }, [list, policy]);

  // 이력 필터링
  const filteredHistory = useMemo(() => {
    return list.filter(m => {
      if (filter.kind !== "all" && m.kind !== filter.kind) return false;
      if (filter.category !== "all" && m.category !== filter.category) return false;
      if (filter.q) {
        const q = filter.q.toLowerCase();
        if (!(`${m.filename} ${m.summary} ${m.by}`).toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [list, filter]);

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.7)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:14}}>
      <div style={{background:"#fff",borderRadius:14,maxWidth:1100,width:"100%",maxHeight:"94vh",display:"flex",flexDirection:"column"}}>
        <div style={{padding:"14px 18px",background:"linear-gradient(135deg,#dc2626,#7c3aed)",color:"#fff",borderRadius:"14px 14px 0 0",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
          <div>
            <h2 style={{fontSize:16,fontWeight:900,margin:0}}>🛡️ 데이터 백업 관리자</h2>
            <div style={{fontSize:11,opacity:0.9,marginTop:3}}>카테고리별 백업 · 자동 정책 · 선택적 복원 · 만료 정리</div>
          </div>
          <button type="button" onClick={onClose} style={{background:"rgba(255,255,255,0.2)",border:"none",color:"#fff",fontSize:18,padding:"4px 12px",borderRadius:6,cursor:"pointer"}}>✕</button>
        </div>

        <div style={{padding:"6px 14px",borderBottom:"1px solid #e5e7eb",display:"flex",gap:4,flexShrink:0,overflowX:"auto"}}>
          {[
            {id:"categories",label:"📦 카테고리별 백업"},
            {id:"policy",label:"⚙️ 자동 정책"},
            {id:"history",label:`📚 이력 (${list.length})`},
            {id:"restore",label:"♻️ 복원"},
          ].map(t => (
            <button key={t.id} type="button" onClick={()=>setTab(t.id)}
              style={{padding:"7px 14px",background:tab===t.id?"#7c3aed":"transparent",color:tab===t.id?"#fff":"#475569",border:"none",borderRadius:6,fontWeight:700,fontSize:12,cursor:"pointer",whiteSpace:"nowrap"}}>
              {t.label}
            </button>
          ))}
        </div>

        <div style={{flex:1,overflowY:"auto",padding:16,background:"#fafbfc"}}>
          {/* 카테고리별 백업 */}
          {tab==="categories" && (
            <div>
              <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap"}}>
                <button type="button" onClick={onBackupAll} disabled={busy}
                  style={{padding:"8px 16px",background:"linear-gradient(135deg,#7c3aed,#3b82f6)",color:"#fff",border:"none",borderRadius:6,fontWeight:700,fontSize:12,cursor:busy?"wait":"pointer"}}>
                  🚀 모든 카테고리 백업
                </button>
                <button type="button" onClick={onManualFull} disabled={busy}
                  style={{padding:"8px 16px",background:"#dc2626",color:"#fff",border:"none",borderRadius:6,fontWeight:700,fontSize:12,cursor:busy?"wait":"pointer"}}>
                  💾 전체 백업 + 다운로드
                </button>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:8}}>
                {Object.entries(BACKUP_CATEGORIES).map(([id, def]) => {
                  const st = catStatus[id];
                  return (
                    <div key={id} style={{padding:12,background:"#fff",border:`2px solid ${def.color}33`,borderRadius:10}}>
                      <div style={{display:"flex",alignItems:"flex-start",gap:8,marginBottom:6}}>
                        <span style={{fontSize:22}}>{def.icon}</span>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontSize:13,fontWeight:900,color:def.color}}>{def.label}</div>
                          <div style={{fontSize:10,color:"#64748b"}}>{def.desc}</div>
                        </div>
                      </div>
                      <div style={{fontSize:10,color:"#475569",marginBottom:6,lineHeight:1.5}}>
                        주기: <strong>{INTERVAL_LABEL[st.interval]||st.interval}</strong>
                        {st.last ? <> · 마지막: {new Date(st.last.at).toLocaleString("ko-KR")}</> : <> · <span style={{color:"#dc2626"}}>아직 없음</span></>}
                      </div>
                      <button type="button" onClick={()=>onBackupCategory(id)} disabled={busy}
                        style={{width:"100%",padding:"6px 10px",background:def.bg,color:def.color,border:`1px solid ${def.color}`,borderRadius:5,fontSize:11,fontWeight:700,cursor:busy?"wait":"pointer"}}>
                        📦 지금 백업
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 자동 정책 */}
          {tab==="policy" && (
            <div>
              <div style={{padding:12,background:"#fff",border:"1px solid #e5e7eb",borderRadius:8,marginBottom:12}}>
                <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,fontWeight:800,cursor:"pointer",marginBottom:8}}>
                  <input type="checkbox" checked={policy.enabled} onChange={e=>updatePolicy({enabled:e.target.checked})}/>
                  🤖 자동 백업 활성화
                </label>
                <div style={{fontSize:11,color:"#64748b",lineHeight:1.6}}>
                  앱 사용 중 카테고리별 주기에 따라 자동으로 백업합니다.
                </div>
              </div>

              <div style={{padding:12,background:"#fff",border:"1px solid #e5e7eb",borderRadius:8,marginBottom:12}}>
                <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>⏱️ 카테고리별 백업 주기</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:8}}>
                  {Object.entries(BACKUP_CATEGORIES).map(([id, def]) => (
                    <div key={id} style={{padding:8,background:def.bg,borderRadius:6}}>
                      <div style={{fontSize:11,fontWeight:700,color:def.color,marginBottom:4}}>{def.label}</div>
                      <select value={policy.intervals[id]||"1d"} onChange={e=>updateInterval(id,e.target.value)}
                        style={{width:"100%",padding:"5px 8px",border:`1px solid ${def.color}`,borderRadius:4,fontSize:11,background:"#fff"}}>
                        {Object.entries(INTERVAL_LABEL).map(([v,l]) => <option key={v} value={v}>{l} 마다</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{padding:12,background:"#fff",border:"1px solid #e5e7eb",borderRadius:8,marginBottom:12}}>
                <div style={{fontSize:13,fontWeight:800,marginBottom:8}}>🗑️ 보관 정책</div>
                <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,marginBottom:6}}>
                  자동 백업 보관 기간:
                  <input type="number" min="1" max="365" value={policy.retentionDays}
                    onChange={e=>updatePolicy({retentionDays:parseInt(e.target.value)||30})}
                    style={{width:70,padding:"4px 8px",border:"1px solid #e5e7eb",borderRadius:4}}/>
                  <span>일</span>
                </label>
                <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,marginBottom:6,cursor:"pointer"}}>
                  <input type="checkbox" checked={policy.pinKeepForever} onChange={e=>updatePolicy({pinKeepForever:e.target.checked})}/>
                  📌 핀 백업은 자동 만료 제외 (영구 보관)
                </label>
                <button type="button" onClick={onPurge} disabled={busy}
                  style={{marginTop:6,padding:"6px 12px",background:"#fee2e2",color:"#dc2626",border:"1px solid #dc2626",borderRadius:5,fontSize:11,fontWeight:700,cursor:"pointer"}}>
                  🧹 지금 만료 백업 정리
                </button>
              </div>

              <div style={{padding:12,background:"#fff",border:"1px solid #e5e7eb",borderRadius:8}}>
                <div style={{fontSize:13,fontWeight:800,marginBottom:8}}>🎯 자동 트리거</div>
                <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,marginBottom:4,cursor:"pointer"}}>
                  <input type="checkbox" checked={policy.triggerBeforeImport} onChange={e=>updatePolicy({triggerBeforeImport:e.target.checked})}/>
                  엑셀/CSV 임포트 직전 자동 백업
                </label>
                <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,cursor:"pointer"}}>
                  <input type="checkbox" checked={policy.triggerOnChange} onChange={e=>updatePolicy({triggerOnChange:e.target.checked})}/>
                  대량 변경(50건 이상) 감지 시 자동 백업
                </label>
              </div>
            </div>
          )}

          {/* 이력 */}
          {tab==="history" && (
            <div>
              <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}>
                <input value={filter.q} onChange={e=>setFilter({...filter,q:e.target.value})} placeholder="🔍 파일명/요약/작성자"
                  style={{flex:"1 1 180px",padding:"6px 10px",border:"1px solid #e5e7eb",borderRadius:5,fontSize:11}}/>
                <select value={filter.kind} onChange={e=>setFilter({...filter,kind:e.target.value})}
                  style={{padding:"6px 10px",border:"1px solid #e5e7eb",borderRadius:5,fontSize:11}}>
                  <option value="all">전체 유형</option>
                  <option value="auto_snapshot">🛡️ 자동</option>
                  <option value="manual_backup">💾 수동</option>
                  <option value="download">📥 다운로드</option>
                  <option value="upload">📤 업로드</option>
                </select>
                <select value={filter.category} onChange={e=>setFilter({...filter,category:e.target.value})}
                  style={{padding:"6px 10px",border:"1px solid #e5e7eb",borderRadius:5,fontSize:11}}>
                  <option value="all">전체 카테고리</option>
                  {Object.entries(BACKUP_CATEGORIES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
                </select>
              </div>
              <div style={{fontSize:10,color:"#64748b",marginBottom:6}}>{filteredHistory.length}건 표시</div>
              {filteredHistory.length === 0 ? (
                <div style={{padding:30,textAlign:"center",color:"#94a3b8",fontSize:12,background:"#fff",borderRadius:6}}>이력이 없습니다</div>
              ) : (
                <div style={{display:"flex",flexDirection:"column",gap:5}}>
                  {filteredHistory.map(m => {
                    const def = m.category ? BACKUP_CATEGORIES[m.category] : null;
                    return (
                      <div key={m.id} style={{padding:8,background:m.pinned?"#fffbeb":"#fff",border:m.pinned?"1px solid #fcd34d":"1px solid #e5e7eb",borderRadius:6,display:"flex",alignItems:"center",gap:8,fontSize:11}}>
                        <span style={{fontSize:18}}>{def?.icon || (m.kind==="auto_snapshot"?"🛡️":m.kind==="manual_backup"?"💾":m.kind==="download"?"📥":"📤")}</span>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontWeight:700,color:"#0f172a",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                            {m.pinned && "📌 "}{m.filename}
                          </div>
                          <div style={{fontSize:9,color:"#64748b"}}>
                            {def && <span style={{padding:"1px 5px",background:def.bg,color:def.color,borderRadius:3,fontWeight:700,marginRight:4}}>{def.label}</span>}
                            {new Date(m.at).toLocaleString("ko-KR")} · {m.by} · {Math.round((m.size||0)/1024)}KB
                            {m.summary && ` · ${m.summary}`}
                            {m._failed && <span style={{color:"#dc2626",fontWeight:700}}> · ⚠️ 파일 없음</span>}
                          </div>
                        </div>
                        {!m._failed && <button type="button" onClick={()=>onPreview(m.id)} disabled={busy}
                          style={{padding:"4px 8px",background:"#f1f5f9",color:"#475569",border:"none",borderRadius:4,fontSize:10,fontWeight:700,cursor:"pointer"}}>👁️ 보기</button>}
                        <button type="button" onClick={()=>onPin(m.id)}
                          style={{padding:"4px 8px",background:m.pinned?"#fef3c7":"#f1f5f9",color:m.pinned?"#92400e":"#475569",border:"none",borderRadius:4,fontSize:10,fontWeight:700,cursor:"pointer"}}
                          title={m.pinned?"핀 해제":"핀 (영구 보관)"}>
                          📌
                        </button>
                        {!m._failed && <button type="button" onClick={()=>onDownload(m.id)} disabled={busy}
                          style={{padding:"4px 8px",background:"#3b82f6",color:"#fff",border:"none",borderRadius:4,fontSize:10,fontWeight:700,cursor:"pointer"}}>📥 받기</button>}
                        <button type="button" onClick={()=>onDelete(m.id)} disabled={m.pinned}
                          style={{padding:"4px 6px",background:m.pinned?"#f1f5f9":"#fee2e2",color:m.pinned?"#94a3b8":"#dc2626",border:"none",borderRadius:4,fontSize:10,cursor:m.pinned?"not-allowed":"pointer"}}
                          title={m.pinned?"핀 해제 후 삭제 가능":"삭제"}>
                          🗑️
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* 복원 */}
          {tab==="restore" && (
            <RestoreTab list={list} onPreview={onPreview} onClose={()=>{}} curUserName={curUserName} onRestoreFile={onRestoreFile} refresh={refresh} preview={preview} setPreview={setPreview}/>
          )}

          {preview && tab !== "restore" && (
            <PreviewModal preview={preview} onClose={()=>setPreview(null)}/>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── 복원 탭 ───────────────────────────────────────────────────────
function RestoreTab({ list, onPreview, onRestoreFile, refresh, preview, setPreview, curUserName }) {
  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("merge");
  const [selectedCategories, setSelectedCategories] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const backups = list.filter(m => m.kind === "auto_snapshot" || m.kind === "manual_backup");

  useEffect(() => {
    if (selectedId) onPreview(selectedId);
    else setPreview(null);
  }, [selectedId]);

  const toggleCat = (c) => {
    const next = new Set(selectedCategories);
    if (next.has(c)) next.delete(c); else next.add(c);
    setSelectedCategories(next);
  };

  const doRestore = async () => {
    if (!preview?.snapshot) return alert("백업을 먼저 선택하세요");
    const onlyCategories = selectedCategories.size > 0 ? Array.from(selectedCategories) : null;
    if (!confirm(`${onlyCategories ? `[${onlyCategories.length}개 카테고리]` : "[전체]"} ${mode==="merge"?"머지(비어있는 키만)":"덮어쓰기(전체 덮어씀)"} 모드로 복원합니다. 계속할까요?`)) return;
    setBusy(true);
    try {
      const { restored, skipped } = await restoreFromBackup(preview.snapshot, { mode, onlyCategories });
      alert(`✅ 복원 ${restored}건 · 건너뜀 ${skipped}건\n새로고침하세요.`);
    } catch (e) { alert("실패: " + e.message); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <div style={{padding:10,background:"#fff7ed",border:"1px solid #fed7aa",borderRadius:6,fontSize:11,color:"#9a3412",marginBottom:10,lineHeight:1.6}}>
        💡 백업을 선택하면 미리보기가 표시되며, 카테고리를 골라서 부분 복원 가능합니다. 안전 머지 모드(기본)는 비어있는 키만 덮어씁니다.
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1.4fr",gap:10}}>
        {/* 백업 선택 */}
        <div style={{padding:8,background:"#fff",border:"1px solid #e5e7eb",borderRadius:6}}>
          <div style={{fontSize:12,fontWeight:800,marginBottom:6}}>📚 백업 선택 ({backups.length})</div>
          <div style={{marginBottom:6}}>
            <label style={{display:"block",padding:"6px 10px",background:"#fff",color:"#3b82f6",border:"1px dashed #3b82f6",borderRadius:5,fontSize:11,fontWeight:700,cursor:"pointer",textAlign:"center"}}>
              📂 외부 .json 파일에서 복원
              <input type="file" accept=".json" onChange={onRestoreFile} style={{display:"none"}}/>
            </label>
          </div>
          <div style={{maxHeight:340,overflowY:"auto"}}>
            {backups.length === 0 ? (
              <div style={{padding:20,textAlign:"center",fontSize:11,color:"#94a3b8"}}>백업 이력 없음</div>
            ) : backups.map(m => {
              const def = m.category ? BACKUP_CATEGORIES[m.category] : null;
              return (
                <button key={m.id} type="button" onClick={()=>setSelectedId(m.id)}
                  style={{width:"100%",padding:"6px 8px",border:"none",background:selectedId===m.id?"#eef2ff":"#fff",borderBottom:"1px solid #f1f5f9",cursor:"pointer",textAlign:"left",fontSize:10}}>
                  <div style={{fontWeight:700,color:"#0f172a"}}>
                    {m.pinned && "📌 "}{def?.icon||"💾"} {def?.label || (m.kind==="manual_backup"?"전체":"기타")}
                  </div>
                  <div style={{color:"#64748b",fontSize:9}}>{new Date(m.at).toLocaleString("ko-KR")} · {Math.round((m.size||0)/1024)}KB</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* 미리보기 + 복원 옵션 */}
        <div style={{padding:8,background:"#fff",border:"1px solid #e5e7eb",borderRadius:6}}>
          <div style={{fontSize:12,fontWeight:800,marginBottom:6}}>🎯 복원 옵션</div>
          {!preview && <div style={{padding:30,textAlign:"center",color:"#94a3b8",fontSize:11}}>왼쪽에서 백업을 선택하세요</div>}
          {preview && preview.error && <div style={{padding:10,color:"#dc2626"}}>⚠️ {preview.error}</div>}
          {preview && preview.snapshot && (
            <>
              <div style={{padding:8,background:"#f8fafc",borderRadius:5,marginBottom:8,fontSize:10,color:"#475569"}}>
                <div><strong>{preview.meta.filename}</strong></div>
                <div>생성: {new Date(preview.snapshot.createdAt).toLocaleString("ko-KR")} · {preview.snapshot.by}</div>
                <div>총 {Object.keys(preview.snapshot.data||{}).length}개 키</div>
              </div>

              <div style={{fontSize:11,fontWeight:700,marginBottom:4}}>복원할 카테고리 선택 (전체는 비워두기)</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4,marginBottom:8}}>
                {Object.entries(BACKUP_CATEGORIES).map(([id, def]) => {
                  const count = preview.byCategory?.[id]?.count || 0;
                  if (count === 0) return null;
                  const sel = selectedCategories.has(id);
                  return (
                    <label key={id} style={{display:"flex",alignItems:"center",gap:4,padding:5,background:sel?def.bg:"#fff",border:`1px solid ${sel?def.color:"#e5e7eb"}`,borderRadius:4,fontSize:10,cursor:"pointer"}}>
                      <input type="checkbox" checked={sel} onChange={()=>toggleCat(id)}/>
                      <span style={{color:def.color,fontWeight:700}}>{def.icon}{def.label.replace(/^.{1,2}\s/,"")}</span>
                      <span style={{marginLeft:"auto",color:"#64748b"}}>{count}</span>
                    </label>
                  );
                })}
              </div>

              <div style={{padding:8,background:"#fff7ed",border:"1px solid #fed7aa",borderRadius:5,marginBottom:8,fontSize:10}}>
                <label style={{display:"flex",alignItems:"center",gap:6,marginBottom:4,cursor:"pointer"}}>
                  <input type="radio" name="restoreMode" value="merge" checked={mode==="merge"} onChange={()=>setMode("merge")}/>
                  <strong>🛡️ 안전 머지</strong> — 비어있는 키만 채움 (기존 데이터 보존)
                </label>
                <label style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer"}}>
                  <input type="radio" name="restoreMode" value="overwrite" checked={mode==="overwrite"} onChange={()=>setMode("overwrite")}/>
                  <strong style={{color:"#dc2626"}}>⚠️ 전체 덮어쓰기</strong> — 기존 데이터 모두 교체
                </label>
              </div>

              <button type="button" onClick={doRestore} disabled={busy}
                style={{width:"100%",padding:"10px 16px",background:mode==="overwrite"?"#dc2626":"#10b981",color:"#fff",border:"none",borderRadius:6,fontWeight:700,fontSize:12,cursor:busy?"wait":"pointer"}}>
                {busy?"⏳ 복원 중...":`♻️ ${selectedCategories.size>0?`${selectedCategories.size}개 카테고리만 `:""}복원 실행`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── 미리보기 모달 ─────────────────────────────────────────────────
function PreviewModal({ preview, onClose }) {
  if (!preview) return null;
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.7)",zIndex:10001,display:"flex",alignItems:"center",justifyContent:"center",padding:14}}>
      <div style={{background:"#fff",borderRadius:10,maxWidth:600,width:"100%",maxHeight:"80vh",overflowY:"auto"}}>
        <div style={{padding:14,borderBottom:"1px solid #e5e7eb",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <h3 style={{fontSize:14,fontWeight:900,margin:0}}>👁️ 백업 미리보기</h3>
          <button type="button" onClick={onClose} style={{background:"none",border:"none",fontSize:18,cursor:"pointer",color:"#94a3b8"}}>✕</button>
        </div>
        <div style={{padding:14}}>
          <div style={{fontSize:11,color:"#475569",marginBottom:10}}>{preview.meta.filename}</div>
          {preview.error && <div style={{color:"#dc2626"}}>{preview.error}</div>}
          {preview.snapshot && (
            <>
              <div style={{fontSize:11,marginBottom:6}}>
                <strong>생성:</strong> {new Date(preview.snapshot.createdAt).toLocaleString("ko-KR")}<br/>
                <strong>작성자:</strong> {preview.snapshot.by}<br/>
                <strong>키 개수:</strong> {Object.keys(preview.snapshot.data||{}).length}
              </div>
              <div style={{fontSize:11,fontWeight:700,marginTop:10,marginBottom:4}}>카테고리별 분포:</div>
              {Object.entries(preview.byCategory || {}).map(([id, info]) => {
                const def = BACKUP_CATEGORIES[id];
                return (
                  <div key={id} style={{padding:6,marginBottom:4,background:def?def.bg:"#f1f5f9",borderRadius:4,fontSize:10}}>
                    <div style={{fontWeight:700,color:def?def.color:"#475569"}}>{def?.label || "기타"} ({info.count})</div>
                    <div style={{color:"#64748b",fontSize:9}}>{info.keys.join(", ")}</div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── 기존 패널 (모달 안에서 사용) — 인터페이스 호환 ──────────────────
export function BackupHistoryPanel({ curUserName }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{padding:12,background:"#fff",border:"2px solid #c7d2fe",borderRadius:10,marginTop:10}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,flexWrap:"wrap"}}>
        <div>
          <div style={{fontSize:13,fontWeight:900,color:"#3730a3"}}>🛡️ 데이터 백업 관리자</div>
          <div style={{fontSize:10,color:"#64748b",marginTop:2}}>카테고리별 백업 · 자동 정책 · 선택적 복원 · 만료 정리</div>
        </div>
        <button type="button" onClick={()=>setOpen(true)}
          style={{padding:"8px 14px",background:"linear-gradient(135deg,#dc2626,#7c3aed)",color:"#fff",border:"none",borderRadius:6,fontSize:12,fontWeight:700,cursor:"pointer"}}>
          🛡️ 백업 관리자 열기
        </button>
      </div>
      {open && <BackupManagerModal onClose={()=>setOpen(false)} curUserName={curUserName}/>}
    </div>
  );
}

