// ════════════════════════════════════════════════════════════
//  실시간 위치 추적 + 행동 분석 + 일과별 로그 패널
//  - 구역별 게이트웨이 지정 UI
//  - BLE 비콘 감지 실시간 표시
//  - 구역별 인원 + CCTV 연동
//  - 일과별 로그 (ZONE_ENTER / ZONE_DWELL / ZONE_EXIT / IDLE_ALERT)
// ════════════════════════════════════════════════════════════
import React, { useState, useEffect, useRef, useMemo } from "react";
import { getPresenceLogs, analyzeLogWithCctv, buildPerEmployeeWorklog } from "./presence-log-engine.js";

const COLLAPSED_KEY = "jamsa_presence_panel_collapsed";
const GW_MAP_LOCAL_KEY = "jamsa_gateway_zone_map"; // Supabase 미연결 시 localStorage 폴백

const loadGwMapLocal = () => {
  try { return JSON.parse(localStorage.getItem(GW_MAP_LOCAL_KEY) || "[]"); }
  catch (e) { return []; }
};
const saveGwMapLocal = (rows) => {
  try { localStorage.setItem(GW_MAP_LOCAL_KEY, JSON.stringify(rows || [])); }
  catch (e) {}
};

const pad = (n) => String(n).padStart(2, "0");
const fmtTimeFull = (iso) => {
  if (!iso) return "--:--:--";
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const fmtDateTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const sinceText = (iso) => {
  if (!iso) return "—";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s/60)}분 전`;
  if (s < 86400) return `${Math.floor(s/3600)}시간 전`;
  return `${Math.floor(s/86400)}일 전`;
};
const sinceMin = (iso) => {
  if (!iso) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
};
const getCctvUrl = (channel) => {
  try {
    const base = (localStorage.getItem("jamsa_cctv_guard_url") || "").replace(/\/+$/, "");
    if (!base) return null;
    if (channel == null) return base;
    return `${base}/?channel=${channel}`;
  } catch (e) { return null; }
};

const ACTIVITY_META = {
  CHECK_IN:    { icon: "🚪", color: "#34d399", label: "출근" },
  CHECK_OUT:   { icon: "🚪", color: "#94a3b8", label: "퇴근" },
  ZONE_ENTER:  { icon: "📍", color: "#60a5fa", label: "구역 입장" },
  ZONE_EXIT:   { icon: "↗",  color: "#fbbf24", label: "구역 이탈" },
  ZONE_DWELL:  { icon: "⏱",  color: "#a78bfa", label: "구역 체류" },
  TRANSIT:     { icon: "🚶", color: "#fbbf24", label: "이동중" },
  IDLE_ALERT:  { icon: "⚠",  color: "#f87171", label: "장기 미감지" },
};

// ────────────────────────────────────────────────────────────
//  메인 패널
// ────────────────────────────────────────────────────────────
export function PresenceTrackingPanel() {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === "1"; } catch (e) { return false; }
  });
  const toggleCollapse = () => setCollapsed(v => {
    const next = !v;
    try { localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0"); } catch (e) {}
    return next;
  });

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [presence, setPresence] = useState([]);     // v_current_presence
  const [occupancy, setOccupancy] = useState([]);   // v_zone_occupancy
  const [activity, setActivity] = useState([]);     // v_daily_activity
  const [gwMap, setGwMap]       = useState([]);     // gateway_zone_map
  const [filter, setFilter]     = useState("all");  // all / ZONE_ENTER / ZONE_DWELL / IDLE_ALERT
  const [showGwEditor, setShowGwEditor] = useState(false);
  const [now, setNow] = useState(Date.now());
  // 비콘 게이트웨이 인프라 (beacon_gateways + v_gateway_status + staff_beacons)
  const [gatewayInfra, setGatewayInfra] = useState([]);
  const [staffBeacons, setStaffBeacons] = useState([]);
  const [showStaffBind, setShowStaffBind] = useState(false);
  const [editingGwId, setEditingGwId] = useState(null);
  // CCTV 자동 추적 — 각 활성 presence_event 별 입장/30s/변화/퇴장 스냅샷 시계열
  const [cctvSnapshotsByEvent, setCctvSnapshotsByEvent] = useState({}); // { [presence_event_id]: [{...row}] }
  const [cctvTrackingOn, setCctvTrackingOn] = useState(() => {
    try { return localStorage.getItem("jamsa_cctv_auto_track") !== "0"; } catch (e) { return true; }
  });
  const [expandedEventId, setExpandedEventId] = useState(null);
  const cctvTickRef = useRef({}); // { [presence_event_id]: lastTickAt }
  // 비콘→스팟 감지 로그 (localStorage 기반, Supabase 없어도 작동)
  const [localLogs, setLocalLogs] = useState(() => getPresenceLogs());
  // 새 감지 이벤트 수신 시 로그 갱신
  useEffect(() => {
    const onLog = () => setLocalLogs(getPresenceLogs());
    window.addEventListener("jamsa:presence-log", onLog);
    window.addEventListener("jamsa:presence-log-updated", onLog);
    return () => {
      window.removeEventListener("jamsa:presence-log", onLog);
      window.removeEventListener("jamsa:presence-log-updated", onLog);
    };
  }, []);
  const [analyzingLogId, setAnalyzingLogId] = useState(null);

  // 오늘 감지 로그를 직원별 업무일지로 자동 변환 → jamsa_worklogs 에 저장
  const generateDailyWorklogsFromPresence = (logs) => {
    if (!logs || logs.length === 0) {
      alert("아직 비콘 감지 로그가 없습니다.\n게이트웨이가 비콘을 감지해야 일지가 생성됩니다.");
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const groups = buildPerEmployeeWorklog(today);
    if (groups.length === 0) {
      alert("오늘 감지된 직원이 없습니다.\n(비콘이 직원과 매칭돼 있어야 일지가 생성됩니다 — 직원 관리에서 beacon_id 확인)");
      return;
    }
    let existing = [];
    try { existing = JSON.parse(localStorage.getItem("jamsa_worklogs") || "[]"); } catch (e) {}
    const newEntries = groups.map(g => ({
      id: "wl-presence-" + today + "-" + (g.authorId || g.author).replace(/\s+/g, "_"),
      at: new Date().toISOString(),
      cycle: "DAILY",
      period: today,
      date: today,
      author: g.author,
      authorId: g.authorId || null,
      dept: null,
      items: g.items.map(it => ({ at: it.at, content: it.content })),
      generalNote: g.generalNote,
      signature: "",
      aiGenerated: true,
      aiMeta: { source: "presence-tracking", logCount: g.items.length },
    }));
    // id 기준 중복 제거 (덮어쓰기)
    const byId = new Map(existing.map(e => [e.id, e]));
    newEntries.forEach(e => byId.set(e.id, e));
    const merged = Array.from(byId.values()).sort((a, b) => (b.at || "").localeCompare(a.at || ""));
    try { localStorage.setItem("jamsa_worklogs", JSON.stringify(merged)); }
    catch (e) { alert("저장 실패: " + e.message); return; }
    alert(`✓ ${newEntries.length}명의 일지를 생성했습니다.\n근무일지 모듈에서 확인하세요.`);
  };

  // CCTV AI 분석 트리거 — 1건 log 에 대해
  const runAnalysisForLog = async (logId) => {
    setAnalyzingLogId(logId);
    try {
      const updated = await analyzeLogWithCctv(logId, (ch) => {
        // CCTV 스냅샷 URL — 기본은 cctv 서버
        let base = "";
        try { base = (localStorage.getItem("jamsa_cctv_snap_server") || "").replace(/\/+$/, ""); } catch (e) {}
        if (!base) base = location.protocol === "https:" ? "https://cctv.thejamsa.com" : "http://localhost:5556";
        return `${base}/snapshot?channel=${ch}`;
      });
      if (!updated) {
        alert("AI 분석 실패 — CCTV 서버가 꺼져있거나 채널이 없습니다.\n(CCTV 서버 가동 후 다시 시도)");
      }
    } catch (e) {
      alert("분석 오류: " + e.message);
    } finally {
      setAnalyzingLogId(null);
    }
  };

  const supabaseRef = useRef(null);
  const channelRef  = useRef(null);

  // 시계 (체류시간 카운트 업)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(id);
  }, []);

  // Supabase 클라이언트 가져오기
  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    // 즉시 localStorage 매핑 로드 (Supabase 연결 전에라도 매핑은 표시)
    const localRows = loadGwMapLocal();
    if (localRows.length > 0) setGwMap(localRows);

    const tryGetSb = () => {
      if (cancelled) return;
      const sb = (typeof window !== "undefined") ? window.__supabase : null;
      if (sb) {
        supabaseRef.current = sb;
        loadAll(sb);
        subscribeRealtime(sb);
      } else if (tries++ < 12) {
        setTimeout(tryGetSb, 300);
      } else {
        // Supabase 미연결 — localStorage 매핑만 사용
        setLoading(false);
        if (localRows.length === 0) {
          setErr("Supabase 미연결 — 게이트웨이 매핑은 로컬에 저장됩니다");
        }
      }
    };
    tryGetSb();
    return () => {
      cancelled = true;
      if (channelRef.current && supabaseRef.current) {
        try { supabaseRef.current.removeChannel(channelRef.current); } catch (e) {}
      }
    };
  }, []);

  async function loadAll(sb) {
    setLoading(true); setErr(null);
    try {
      const [pres, occ, act, gw, infra, sbsb] = await Promise.all([
        sb.from("v_current_presence").select("*"),
        sb.from("v_zone_occupancy").select("*"),
        sb.from("v_daily_activity").select("*").limit(100),
        sb.from("gateway_zone_map").select("*").order("zone_name"),
        // 신규: 비콘 게이트웨이 인프라 (정찬주 전무 통보분 — 9곳)
        sb.from("v_gateway_status").select("*"),
        sb.from("staff_beacons").select("id, staff_id, beacon_uuid, beacon_label, issued_at, returned_at").is("returned_at", null),
      ]);
      if (pres.error) throw pres.error;
      setPresence(pres.data || []);
      setOccupancy(occ.data || []);
      setActivity(act.data || []);
      // Supabase + localStorage 병합 — gateway_serial 기준 (Supabase 우선)
      const localRows = loadGwMapLocal();
      const sbRows = gw.data || [];
      const sbSerials = new Set(sbRows.map(r => r.gateway_serial));
      const merged = [...sbRows, ...localRows.filter(r => !sbSerials.has(r.gateway_serial))];
      setGwMap(merged);
      // 병합본을 localStorage 에도 미러링 (오프라인 대비)
      saveGwMapLocal(merged);
      // 게이트웨이 인프라 (없으면 빈 배열 — 테이블 미적용 환경 호환)
      setGatewayInfra(infra?.data || []);
      setStaffBeacons(sbsb?.data || []);
    } catch (e) {
      setErr(e?.message || String(e));
      // Supabase 실패 시 localStorage 만 사용
      const localRows = loadGwMapLocal();
      if (localRows.length > 0) setGwMap(localRows);
    } finally { setLoading(false); }
  }

  // ───── 게이트웨이 인프라 액션 ─────
  // BASE_ZONES + 사용자 커스텀 zone 모두 합쳐서 드롭다운 옵션 추출
  const allSpotsForPicker = useMemo(() => {
    const base = (typeof window !== "undefined" && Array.isArray(window.__jamsaBaseZones))
      ? window.__jamsaBaseZones : [];
    let custom = [];
    try { custom = JSON.parse(localStorage.getItem("jamsa_custom_zones") || "[]"); } catch (e) {}
    let zc = {};
    try { zc = JSON.parse(localStorage.getItem("jamsa_zone_customizations") || "{}"); } catch (e) {}
    const merged = [...base, ...custom].filter(z => !zc[z.id]?._deleted);
    return merged.map(z => ({
      id: z.id,
      name: zc[z.id]?.name || z.name,
      icon: zc[z.id]?.icon || z.icon || "📍",
      lat: z.lat, lng: z.lng,
    }));
  }, [now]);

  // CCTV 채널 자동 추천 (스팟 변경 시 gateway_zone_map 에 자동 입력)
  const autoCctvForSpot = (spotId) => {
    if (!spotId) return null;
    try {
      const zc = JSON.parse(localStorage.getItem("jamsa_zone_customizations") || "{}");
      const userChs = zc[spotId]?.cctvChannels;
      if (Array.isArray(userChs) && userChs.length > 0) return userChs[0];
      const cm = JSON.parse(localStorage.getItem("jamsa_cctv_zone_map") || "{}");
      if (Array.isArray(cm[spotId]) && cm[spotId].length > 0) return cm[spotId][0];
      const auto = (typeof window !== "undefined") ? window.__jamsaCctvAutoMap : null;
      if (auto && Array.isArray(auto[spotId]) && auto[spotId].length > 0) return auto[spotId][0];
    } catch (e) {}
    return null;
  };

  // gateway_zone_map 자동 동기화 — beacon_gateways 의 serial+spot 이 바뀌면
  // 기존 presence-tracking 트리거가 정상 동작하도록 zone_map 도 같이 업데이트
  async function syncGatewayZoneMap(serial, spotId, spotName) {
    const sb = supabaseRef.current;
    if (!sb || !serial || !spotId) return;
    const cctvCh = autoCctvForSpot(spotId);
    try {
      await sb.from("gateway_zone_map").upsert({
        gateway_serial: serial,
        zone_id:        spotId,
        zone_name:      spotName,
        cctv_channel:   cctvCh,
        dwell_threshold_min: 2,
        updated_at:     new Date().toISOString(),
      }, { onConflict: "gateway_serial" });
    } catch (e) {
      console.warn("[gateway-zone-map sync]", e.message);
    }
  }

  const updateGwStatus = async (id, newStatus) => {
    const sb = supabaseRef.current;
    if (!sb) return alert("Supabase 미연결");
    const row = gatewayInfra.find(g => g.id === id);
    const patch = { install_status: newStatus, updated_at: new Date().toISOString() };
    if (newStatus === "active" && !row?.installed_at) {
      patch.installed_at = new Date().toISOString();
    }
    const { error } = await sb.from("beacon_gateways").update(patch).eq("id", id);
    if (error) alert("저장 실패: " + error.message);
    else loadAll(sb);
  };

  const updateGwSerial = async (id, serial) => {
    const sb = supabaseRef.current;
    if (!sb) return alert("Supabase 미연결");
    const row = gatewayInfra.find(g => g.id === id);
    const trimmed = (serial || "").trim();
    const { error } = await sb.from("beacon_gateways")
      .update({ gateway_serial: trimmed || null, updated_at: new Date().toISOString() }).eq("id", id);
    if (error) { alert("저장 실패: " + error.message); return; }
    // 스팟이 매핑돼 있으면 gateway_zone_map 도 함께 갱신
    if (trimmed && row?.spot_id) {
      await syncGatewayZoneMap(trimmed, row.spot_id, row.spot_name);
    }
    setEditingGwId(null);
    loadAll(sb);
  };

  const updateGwSpot = async (id, spotId) => {
    const sb = supabaseRef.current;
    if (!sb) return alert("Supabase 미연결");
    const row = gatewayInfra.find(g => g.id === id);
    const spot = allSpotsForPicker.find(s => s.id === spotId);
    if (!spot) return;
    const patch = {
      spot_id:   spot.id,
      spot_name: spot.name,
      lat:       spot.lat || row?.lat || null,
      lng:       spot.lng || row?.lng || null,
      updated_at: new Date().toISOString(),
    };
    const { error } = await sb.from("beacon_gateways").update(patch).eq("id", id);
    if (error) { alert("저장 실패: " + error.message); return; }
    // 시리얼이 있으면 gateway_zone_map 도 함께 갱신
    if (row?.gateway_serial) {
      await syncGatewayZoneMap(row.gateway_serial, spot.id, spot.name);
    }
    loadAll(sb);
  };

  const gwInfraSummary = useMemo(() => {
    const active   = gatewayInfra.filter(g => g.install_status === "active");
    const planned  = gatewayInfra.filter(g => g.install_status === "planned");
    const offline  = gatewayInfra.filter(g => g.install_status === "offline" || g.install_status === "maintenance");
    const online   = active.filter(g => g.live_status === "online").length;
    const detections24h = gatewayInfra.reduce((s, g) => s + (g.detections_24h || 0), 0);
    return { active, planned, offline, online, detections24h, total: gatewayInfra.length };
  }, [gatewayInfra]);

  // ───── CCTV 자동 추적 ─────
  // 활성 presence_events 마다 30초 주기로 스냅샷 + AI 분석 + 로그
  // (입장 직후의 entry 행은 DB 트리거가 자동 생성, 여기서는 30s/변화/퇴장 분석)
  const cctvSnapServer = () => {
    try {
      const v = (localStorage.getItem("jamsa_cctv_snap_server") || "").replace(/\/+$/, "");
      if (v) return v;
    } catch (e) {}
    return location.protocol === "https:" ? "https://cctv.thejamsa.com" : "http://localhost:5556";
  };

  // CCTV 스냅샷 fetch → base64 (브라우저가 LAN/원격 CCTV 서버에 접근)
  async function fetchCctvSnapshotAsBase64(channel) {
    if (channel == null) return null;
    const base = cctvSnapServer();
    const url = `${base}/snapshot?channel=${channel}&_=${Date.now()}`;
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) return null;
      const blob = await r.blob();
      return await new Promise((resolve) => {
        const fr = new FileReader();
        fr.onloadend = () => resolve(fr.result);
        fr.onerror = () => resolve(null);
        fr.readAsDataURL(blob);
      });
    } catch (e) {
      return null;
    }
  }

  // 한 presence_event 에 대해 1회 분석 + 로깅
  async function runCctvAnalysisForPresence(p, eventType = "tick_30s") {
    if (!p || !p.presence_event_id) return null;
    if (p.cctv_channel == null) return null;

    const t0 = Date.now();
    const snapUrl = `${cctvSnapServer()}/snapshot?channel=${p.cctv_channel}`;
    let aiSummary = null, aiDetail = null, aiActions = null, aiConfidence = null;
    let snapshotB64 = null;

    // 1) 스냅샷 fetch
    snapshotB64 = await fetchCctvSnapshotAsBase64(p.cctv_channel);

    // 2) AI 분석 (스냅샷 fetch 성공한 경우만)
    if (snapshotB64) {
      try {
        const ar = await fetch("/api/cctv-ai-analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ch: p.cctv_channel,
            zone: p.zone_name,
            image: snapshotB64,
            context: `직원 ${p.staff_name || p.beacon_uuid || "익명"} · 입장 후 ${p.dwell_sec_now || 0}초 경과`,
          }),
        });
        const ad = await ar.json().catch(() => ({}));
        if (ad?.ok || ad?.result) {
          const r = ad.result || ad;
          aiSummary = r.summary || null;
          aiDetail  = r.detail  || null;
          aiActions = r.objects || (r.actionRequired ? [{ kind: "action", label: r.actionRequired }] : null);
          aiConfidence = r.peopleConfidence ?? null;
        }
      } catch (e) {
        aiSummary = `(AI 분석 실패: ${e.message})`;
      }
    } else {
      aiSummary = "(CCTV 스냅샷 fetch 실패 — CCTV 서버 가동 확인)";
    }

    // 3) 로그 저장 (자동으로 behavior_change 승격 판단)
    try {
      const lr = await fetch("/api/presence-cctv-analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          presence_event_id: p.presence_event_id,
          staff_id:        p.staff_id,
          staff_name:      p.staff_name,
          beacon_uuid:     p.beacon_uuid,
          zone_id:         p.zone_id,
          zone_name:       p.zone_name,
          gateway_serial:  p.gateway_serial,
          cctv_channel:    p.cctv_channel,
          event_type:      eventType,
          dwell_sec:       p.dwell_sec_now || null,
          snapshot_url:    snapUrl,
          snapshot_b64:    null, // 작은 썸네일만 저장하고 싶으면 별도 리사이즈 필요
          ai_provider:     "auto",
          ai_summary:      aiSummary,
          ai_detail:       aiDetail,
          ai_actions:      aiActions,
          ai_confidence:   aiConfidence,
          ai_elapsed_ms:   Date.now() - t0,
        }),
      });
      const ld = await lr.json().catch(() => ({}));
      return ld.snapshot || null;
    } catch (e) {
      console.warn("[cctv-presence-log]", e.message);
      return null;
    }
  }

  // 각 active presence 의 스냅샷 시계열을 불러옴
  const loadSnapshotsForEvent = async (presenceEventId) => {
    const sb = supabaseRef.current;
    if (!sb) return;
    const { data } = await sb.from("presence_cctv_snapshots")
      .select("*")
      .eq("presence_event_id", presenceEventId)
      .order("occurred_at", { ascending: true });
    setCctvSnapshotsByEvent(prev => ({ ...prev, [presenceEventId]: data || [] }));
  };

  // 30초 주기 자동 추적 루프
  useEffect(() => {
    if (!cctvTrackingOn) return;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      const sb = supabaseRef.current;
      if (!sb) return;

      try {
        const { data: actives } = await sb.from("v_active_cctv_tracking").select("*");
        if (!actives || actives.length === 0) return;

        const now = Date.now();
        for (const p of actives) {
          // CCTV 채널이 없는 건 스킵
          if (p.cctv_channel == null) continue;
          const lastAt = cctvTickRef.current[p.presence_event_id] || 0;
          // 직전 분석 후 28초 이상 지났으면 새 tick
          if (now - lastAt < 28000) continue;
          cctvTickRef.current[p.presence_event_id] = now;
          const inserted = await runCctvAnalysisForPresence(p, "tick_30s");
          if (inserted && !cancelled) {
            await loadSnapshotsForEvent(p.presence_event_id);
          }
        }
      } catch (e) {
        console.warn("[cctv-tracker tick]", e.message);
      }
    };

    // 즉시 1회 + 30초 간격
    tick();
    const id = setInterval(tick, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [cctvTrackingOn, presence.length]);

  // presence 가 추가/제거되면 그 이벤트의 스냅샷도 같이 로드
  useEffect(() => {
    presence.forEach(p => {
      const eventId = p.presence_event_id || p.id;
      if (eventId && !(eventId in cctvSnapshotsByEvent)) {
        loadSnapshotsForEvent(eventId);
      }
    });
  }, [presence]);

  function subscribeRealtime(sb) {
    if (channelRef.current) return;
    try {
      channelRef.current = sb.channel("presence-tracking-home")
        .on("postgres_changes", { event: "*", schema: "public", table: "beacon_detections" }, () => {
          // 감지마다 다시 로드 (가벼움)
          loadAll(sb);
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "presence_events" }, () => loadAll(sb))
        .on("postgres_changes", { event: "*", schema: "public", table: "activity_log" }, () => loadAll(sb))
        .on("postgres_changes", { event: "*", schema: "public", table: "beacon_gateways" }, () => loadAll(sb))
        .on("postgres_changes", { event: "*", schema: "public", table: "staff_beacons"   }, () => loadAll(sb))
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "presence_cctv_snapshots" }, (payload) => {
          const eventId = payload?.new?.presence_event_id;
          if (eventId) loadSnapshotsForEvent(eventId);
        })
        .subscribe();
    } catch (e) {}
  }

  const filteredActivity = useMemo(() => {
    if (filter === "all") return activity;
    return activity.filter(a => a.activity_type === filter);
  }, [activity, filter]);

  const stats = useMemo(() => ({
    presentNow: presence.length,
    zonesActive: occupancy.length,
    eventsToday: activity.filter(a => {
      const d = new Date(a.occurred_at);
      const t = new Date(); t.setHours(0,0,0,0);
      return d >= t;
    }).length,
    idleAlerts: activity.filter(a => a.activity_type === "IDLE_ALERT").length,
  }), [presence, occupancy, activity]);

  if (collapsed) {
    return (
      <div onClick={toggleCollapse}
        data-jamsa-collapsed-banner
        style={{ cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between",
                 padding: "10px 20px", background: "linear-gradient(90deg, #1e1b4b 0%, #7c3aed 100%)", color: "#fff", borderBottom: "1px solid rgba(0,0,0,0.2)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontSize: 22 }}>📡</div>
          <div>
            <div data-banner-title style={{ fontSize: 13, fontWeight: 800 }}>
              실시간 위치 추적 · 행동 분석 · 게이트웨이 인프라
              <span style={{ marginLeft: 8, fontSize: 10, padding: "2px 7px", borderRadius: 4, background: "rgba(34,197,94,0.25)" }}>
                📡 {gwInfraSummary.active.length}/{gwInfraSummary.total} 가동
              </span>
              <span style={{ marginLeft: 4, fontSize: 10, padding: "2px 7px", borderRadius: 4, background: "rgba(255,255,255,0.18)" }}>
                현장 {stats.presentNow}명 · 오늘 {stats.eventsToday}건
                {stats.idleAlerts > 0 && <> · ⚠ {stats.idleAlerts}</>}
              </span>
            </div>
            <div data-banner-sub style={{ fontSize: 10, opacity: 0.85, marginTop: 2 }}>클릭하면 펼쳐집니다 ▾</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: "#0b1220", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
      {/* 헤더 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 20px",
        background: "linear-gradient(90deg, #1e1b4b 0%, #7c3aed 100%)", color: "#fff" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontSize: 22 }}>📡</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 800 }}>
              실시간 위치 추적 · 행동 분석 · 게이트웨이 인프라
              <span style={{ marginLeft: 8, fontSize: 10, padding: "2px 7px", borderRadius: 4, background: "rgba(255,255,255,0.18)" }}>
                GATEWAY · BEACON · ZONE · CCTV · LOG
              </span>
            </div>
            <div style={{ fontSize: 10, opacity: 0.85, marginTop: 2 }}>
              {gwInfraSummary.total > 0
                ? `📡 게이트웨이 ${gwInfraSummary.active.length}/${gwInfraSummary.total} 가동 (온라인 ${gwInfraSummary.online}) · 휴대비콘 ${staffBeacons.length}개 · 현장 ${stats.presentNow}명 · 24h 감지 ${gwInfraSummary.detections24h.toLocaleString()}건`
                : "구역별 게이트웨이 비콘 감지 → 자동 행동 추론 → CCTV 연동 → 실시간 일과 로그"}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <button onClick={() => setShowStaffBind(true)}
            title="직원에게 휴대 비콘 매핑"
            style={{ padding: "6px 12px", background: "linear-gradient(135deg,#0891b2,#0e7490)", border: "1px solid rgba(255,255,255,0.25)", borderRadius: 6, fontSize: 11, fontWeight: 700, color: "#fff", cursor: "pointer" }}>
            👥 직원-비콘 매핑 <span style={{ fontSize: 9, opacity: 0.85 }}>({staffBeacons.length})</span>
          </button>
          <button onClick={() => setShowGwEditor(true)}
            style={{ padding: "6px 12px", background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.25)", borderRadius: 6, fontSize: 11, fontWeight: 700, color: "#fff", cursor: "pointer" }}>
            ⚙ Zone 매핑 <span style={{ fontSize: 9, opacity: 0.7 }}>({gwMap.length})</span>
          </button>
          <button onClick={() => generateDailyWorklogsFromPresence(localLogs)}
            title="오늘 비콘 감지 로그를 직원별 업무일지로 자동 생성"
            style={{ padding: "6px 12px", background: "linear-gradient(135deg,#7c3aed,#0891b2)", border: "1px solid rgba(255,255,255,0.25)", borderRadius: 6, fontSize: 11, fontWeight: 700, color: "#fff", cursor: "pointer" }}>
            📝 직원별 일지 생성
          </button>
          <button onClick={() => loadAll(supabaseRef.current)}
            title="수동 새로고침"
            style={{ padding: "6px 10px", background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 6, fontSize: 11, color: "#fff", cursor: "pointer" }}>
            ⟳
          </button>
          <button onClick={toggleCollapse}
            style={{ padding: "6px 10px", background: "rgba(15,23,42,0.35)", border: "1px solid rgba(255,255,255,0.25)", borderRadius: 6, fontSize: 11, fontWeight: 700, color: "#fff", cursor: "pointer" }}>
            ▴ 접기
          </button>
        </div>
      </div>

      {/* 본문 */}
      {loading ? (
        <div style={{ padding: 30, textAlign: "center", color: "#64748b", fontSize: 12 }}>⏳ 데이터 불러오는 중...</div>
      ) : (err && gwMap.length === 0) ? (
        <div style={{ padding: 16, fontSize: 12, color: "#fca5a5", background: "rgba(220,38,38,0.1)" }}>
          ⚠ {err}
          <div style={{ marginTop: 6, color: "#94a3b8", fontSize: 11 }}>
            게이트웨이 매핑은 <strong>로컬에 저장</strong>되므로 Supabase 없이도 사용 가능합니다.
            상단의 <strong>⚙ 게이트웨이 매핑</strong> 버튼을 눌러 추가하세요.
          </div>
        </div>
      ) : (
        <div>
          {err && (
            <div style={{ padding: "6px 16px", fontSize: 10, color: "#fbbf24", background: "rgba(245,158,11,0.08)", borderBottom: "1px solid rgba(245,158,11,0.2)" }}>
              ⚠ {err} · 로컬 매핑 {gwMap.length}건 표시 중
            </div>
          )}

          {/* ─── 비콘 게이트웨이 인프라 (정찬주 전무 통보분 + 사용자 등록분) ─── */}
          {gatewayInfra.length > 0 && (
            <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.08)",
              background: "linear-gradient(180deg,rgba(15,76,117,0.18) 0%,rgba(11,18,32,0) 100%)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: "#93c5fd", letterSpacing: ".1em", textTransform: "uppercase" }}>
                    📡 비콘 게이트웨이 인프라
                  </span>
                  <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 3, background: "rgba(34,197,94,0.2)", color: "#86efac", fontWeight: 700 }}>
                    {gwInfraSummary.active.length} 가동
                  </span>
                  <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 3, background: "rgba(251,191,36,0.2)", color: "#fbbf24", fontWeight: 700 }}>
                    {gwInfraSummary.planned.length} 예정
                  </span>
                  {gwInfraSummary.offline.length > 0 && (
                    <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 3, background: "rgba(220,38,38,0.2)", color: "#fca5a5", fontWeight: 700 }}>
                      {gwInfraSummary.offline.length} 오프라인
                    </span>
                  )}
                </div>
                <span style={{ fontSize: 9, color: "#64748b" }}>
                  카드의 스팟 드롭다운을 바꾸면 zone_map 자동 동기화 · 시리얼 클릭하면 인라인 편집
                </span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 8 }}>
                {gatewayInfra.map(g => (
                  <GatewayInfraCard key={g.id} g={g}
                    spots={allSpotsForPicker}
                    isEditing={editingGwId === g.id}
                    onStartEdit={() => setEditingGwId(g.id)}
                    onCancelEdit={() => setEditingGwId(null)}
                    onUpdateSerial={(v) => updateGwSerial(g.id, v)}
                    onUpdateSpot={(spotId) => updateGwSpot(g.id, spotId)}
                    onUpdateStatus={(s) => updateGwStatus(g.id, s)}
                  />
                ))}
              </div>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "280px 1fr 360px", gap: 0 }}>
          {/* ─── (1) 구역별 인원 + CCTV ─── */}
          <div style={{ padding: "12px 14px", borderRight: "1px solid rgba(255,255,255,0.06)" }}>
            <SectionTitle>🗺 구역별 현장 인원</SectionTitle>
            {occupancy.length === 0 && gwMap.length === 0 ? (
              <EmptyHint>
                게이트웨이가 아직 매핑되지 않았습니다.
                <br/><br/>
                <button onClick={() => setShowGwEditor(true)}
                  style={{ marginTop: 8, padding: "5px 12px", background: "#7c3aed", color: "#fff", border: "none", borderRadius: 4, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                  + 첫 매핑 추가
                </button>
              </EmptyHint>
            ) : (
              <>
                {gwMap.map(gw => {
                  const occ = occupancy.find(o => o.zone_id === gw.zone_id);
                  const count = occ?.people_count || 0;
                  const names = occ?.people_names || [];
                  const cctvUrl = getCctvUrl(gw.cctv_channel) || gw.cctv_url;
                  return (
                    <div key={gw.gateway_serial}
                      style={{ marginBottom: 8, padding: 10, borderRadius: 6,
                        background: count > 0 ? "rgba(124,58,237,0.12)" : "rgba(255,255,255,0.03)",
                        border: `1px solid ${count > 0 ? "rgba(167,139,250,0.35)" : "rgba(255,255,255,0.05)"}` }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#f1f5f9" }}>{gw.zone_name}</div>
                        <span style={{ fontSize: 11, padding: "1px 7px", borderRadius: 3, background: count > 0 ? "rgba(167,139,250,0.3)" : "rgba(148,163,184,0.2)", color: count > 0 ? "#ddd6fe" : "#94a3b8", fontFamily: "ui-monospace,monospace" }}>{count}명</span>
                      </div>
                      <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 6, fontFamily: "ui-monospace,monospace" }}>
                        GW {gw.gateway_serial.slice(0, 16)}{gw.gateway_serial.length > 16 ? "…" : ""}
                        {gw.cctv_channel != null && <> · ch{gw.cctv_channel}</>}
                      </div>
                      {count > 0 && (
                        <div style={{ fontSize: 11, color: "#cbd5e1", marginBottom: 6, lineHeight: 1.4 }}>
                          {names.slice(0, 5).join(", ")}
                          {names.length > 5 && <> 외 {names.length - 5}</>}
                        </div>
                      )}
                      {cctvUrl && (
                        <a href={cctvUrl} target="_blank" rel="noopener"
                          style={{ display: "inline-block", padding: "3px 9px", borderRadius: 4, background: "linear-gradient(135deg,#0891b2,#059669)", color: "#fff", fontSize: 10, fontWeight: 700, textDecoration: "none" }}>
                          📹 CCTV 보기 ↗
                        </a>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </div>

          {/* ─── (2) 일과별 로그 (메인) ─── */}
          <div style={{ padding: "12px 14px", borderRight: "1px solid rgba(255,255,255,0.06)", maxHeight: 560, overflowY: "auto" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <SectionTitle>📋 일과별 행동 로그 (실시간)</SectionTitle>
              <div style={{ display: "flex", gap: 4 }}>
                {[
                  ["all", "전체"],
                  ["ZONE_ENTER", "입장"],
                  ["ZONE_DWELL", "체류"],
                  ["ZONE_EXIT", "이동"],
                  ["IDLE_ALERT", "⚠"],
                ].map(([k, label]) => (
                  <button key={k} onClick={() => setFilter(k)}
                    style={{ padding: "3px 8px", borderRadius: 3, fontSize: 10, fontWeight: 700, cursor: "pointer",
                      background: filter === k ? "#7c3aed" : "rgba(255,255,255,0.05)",
                      color: filter === k ? "#fff" : "#94a3b8",
                      border: filter === k ? "1px solid #a78bfa" : "1px solid rgba(255,255,255,0.08)" }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {/* ── 비콘 감지 로그 (localStorage, Supabase 없어도 작동) ── */}
            {localLogs.length > 0 && (
              <div style={{ marginBottom: 14, padding: 8, background: "rgba(124,58,237,0.08)", border: "1px solid rgba(124,58,237,0.2)", borderRadius: 6 }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: "#a78bfa", marginBottom: 6, display: "flex", justifyContent: "space-between" }}>
                  <span>📡 비콘 감지 ({localLogs.length}건, 최근 20개)</span>
                  <button onClick={() => { if (confirm("감지 로그를 모두 비우시겠습니까?")) { localStorage.removeItem("jamsa_presence_logs"); setLocalLogs([]); } }}
                    style={{ background: "transparent", border: "1px solid rgba(167,139,250,0.3)", color: "#c4b5fd", borderRadius: 3, padding: "1px 6px", fontSize: 9, cursor: "pointer" }}>비우기</button>
                </div>
                {localLogs.slice(0, 20).map(log => (
                  <div key={log.id} style={{ padding: "6px 0", borderBottom: "1px dotted rgba(255,255,255,0.05)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
                      <span style={{ color: "#a78bfa", fontFamily: "ui-monospace,monospace", fontSize: 10 }}>
                        {fmtDateTime(log.at)}
                      </span>
                      <span style={{ color: "#f1f5f9", fontWeight: 700 }}>
                        {log.employeeName || log.beaconName || "비콘 미배정"}
                      </span>
                      <span style={{ color: "#64748b" }}>→</span>
                      <span style={{ color: "#34d399", fontWeight: 700 }}>{log.zoneName}</span>
                      {log.cctvChannel != null && (
                        <span style={{ marginLeft: "auto", display: "flex", gap: 4, alignItems: "center" }}>
                          <span style={{ fontSize: 10, color: "#67e8f9", background: "rgba(8,145,178,0.2)", padding: "1px 6px", borderRadius: 3, fontWeight: 700 }}>CH{log.cctvChannel}</span>
                          {!log.aiAnalysis && (
                            <button onClick={() => runAnalysisForLog(log.id)}
                              disabled={analyzingLogId === log.id}
                              style={{ background: "linear-gradient(135deg,#7c3aed,#0891b2)", color: "#fff", border: "none", borderRadius: 3, padding: "2px 8px", fontSize: 10, fontWeight: 700, cursor: analyzingLogId === log.id ? "wait" : "pointer" }}>
                              {analyzingLogId === log.id ? "분석 중..." : "🤖 AI 분석"}
                            </button>
                          )}
                        </span>
                      )}
                    </div>
                    {log.aiAnalysis && (
                      <div style={{ marginTop: 4, padding: 6, background: "rgba(0,0,0,0.25)", borderLeft: `3px solid ${log.aiAnalysis.level === "DANGER" ? "#ef4444" : log.aiAnalysis.level === "WARNING" ? "#f59e0b" : "#10b981"}`, borderRadius: 3, fontSize: 11, lineHeight: 1.5 }}>
                        <div style={{ fontSize: 9, color: "#a78bfa", fontWeight: 700, marginBottom: 2 }}>
                          🤖 AI 행동 분석 · {log.aiAnalysis.level || "?"} · {log.aiAnalysis.category || ""}
                        </div>
                        <div style={{ color: "#e2e8f0" }}>{log.aiAnalysis.summary}</div>
                        {log.aiAnalysis.detail && log.aiAnalysis.detail !== log.aiAnalysis.summary && (
                          <div style={{ color: "#94a3b8", marginTop: 4, fontSize: 10 }}>{log.aiAnalysis.detail}</div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {filteredActivity.length === 0 ? (
              localLogs.length === 0 ? (
                <EmptyHint>
                  아직 로그가 없습니다 — 게이트웨이가 비콘을 감지하면 자동 기록됩니다
                  <br/><br/>
                  <small style={{ color: "#64748b" }}>
                    💡 매핑은 <strong>⚙ 게이트웨이 매핑</strong>에서 추가하세요.<br/>
                    💡 BLE 게이트웨이가 <code style={{ background: "rgba(255,255,255,0.05)", padding: "1px 4px", borderRadius: 2 }}>/api/beacon-webhook</code> 으로 비콘을 쏘면 자동 기록.
                  </small>
                </EmptyHint>
              ) : null
            ) : (
              <div>
                {filteredActivity.map(a => {
                  const meta = ACTIVITY_META[a.activity_type] || { icon: "•", color: "#94a3b8", label: a.activity_type };
                  const cctvUrl = a.cctv_channel != null ? getCctvUrl(a.cctv_channel) : null;
                  return (
                    <div key={a.id}
                      style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 0", borderBottom: "1px dotted rgba(255,255,255,0.05)" }}>
                      <div style={{ width: 26, height: 26, borderRadius: 13, background: `${meta.color}22`, color: meta.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, flexShrink: 0 }}>
                        {meta.icon}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#f1f5f9", letterSpacing: "-0.01em" }}>
                          {a.staff_name || "비콘 미배정"}
                          <span style={{ marginLeft: 6, color: meta.color, fontSize: 9, padding: "1px 6px", borderRadius: 3, background: `${meta.color}18`, fontWeight: 800 }}>{meta.label}</span>
                          {a.dept_name && <span style={{ marginLeft: 6, color: "#64748b", fontWeight: 400, fontSize: 10 }}>· {a.dept_name}</span>}
                        </div>
                        <div style={{ fontSize: 11, color: "#cbd5e1", marginTop: 2, lineHeight: 1.4 }}>
                          {a.inferred_behavior}
                        </div>
                        <div style={{ fontSize: 10, color: "#64748b", marginTop: 3, fontFamily: "ui-monospace,monospace", display: "flex", gap: 8, alignItems: "center" }}>
                          <span>{a.occurred_time}</span>
                          {a.zone_name && <span>· {a.zone_name}</span>}
                          {a.rssi != null && <span>· RSSI {a.rssi}</span>}
                          {a.duration_sec != null && <span>· {Math.floor(a.duration_sec/60)}분</span>}
                          {cctvUrl && (
                            <a href={cctvUrl} target="_blank" rel="noopener"
                              style={{ marginLeft: "auto", padding: "2px 7px", borderRadius: 3, background: "rgba(8,145,178,0.2)", color: "#67e8f9", fontSize: 10, fontWeight: 700, textDecoration: "none" }}>
                              📹 ch{a.cctv_channel} ↗
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ─── (3) 현재 위치 + CCTV 자동 추적 (각 직원) ─── */}
          <div style={{ padding: "12px 14px", maxHeight: 560, overflowY: "auto", background: "rgba(15,23,42,0.4)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <SectionTitle>📍 직원별 현재 위치 + CCTV 행동 분석</SectionTitle>
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, color: "#94a3b8", cursor: "pointer", userSelect: "none" }}>
                <input type="checkbox" checked={cctvTrackingOn}
                  onChange={e => {
                    setCctvTrackingOn(e.target.checked);
                    try { localStorage.setItem("jamsa_cctv_auto_track", e.target.checked ? "1" : "0"); } catch (_) {}
                  }}
                  style={{ accentColor: "#0891b2" }} />
                <span>30s 자동 추적</span>
              </label>
            </div>

            {presence.length === 0 ? (
              <EmptyHint>
                현재 감지되는 비콘 없음
                <br/><br/>
                <span style={{ fontSize: 10 }}>
                  💡 비콘이 게이트웨이에 잡히면<br/>
                  자동으로 CCTV 캡쳐 + AI 분석 시작 (입장/30s/변화/퇴장)
                </span>
              </EmptyHint>
            ) : (
              presence.map(p => {
                const eventId = p.presence_event_id || p.id;
                const cctvUrl = getCctvUrl(p.cctv_channel);
                const dwell = Math.floor((Date.now() - new Date(p.entered_at).getTime()) / 60000);
                const snaps = cctvSnapshotsByEvent[eventId] || [];
                const lastSnap = snaps[snaps.length - 1];
                const isExpanded = expandedEventId === eventId;
                return (
                  <div key={eventId || p.staff_id || p.beacon_uuid}
                    style={{ padding: 10, marginBottom: 6, borderRadius: 6, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#f1f5f9" }}>
                        {p.staff_name || <em style={{ color: "#fbbf24" }}>익명비콘 {(p.beacon_uuid||"").slice(0,8)}</em>}
                      </div>
                      <span style={{ fontSize: 10, fontFamily: "ui-monospace,monospace", color: "#a78bfa", fontWeight: 700 }}>
                        {dwell}분째
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: "#cbd5e1", marginBottom: 4 }}>
                      📍 <strong>{p.zone_name}</strong>
                      {p.dept_name && <span style={{ color: "#94a3b8", marginLeft: 4 }}>({p.dept_name})</span>}
                    </div>
                    <div style={{ fontSize: 10, color: "#64748b", fontFamily: "ui-monospace,monospace", marginBottom: 6 }}>
                      입장 {fmtDateTime(p.entered_at)} · RSSI {p.max_rssi ?? "—"} · 감지 {p.detection_count}회
                    </div>

                    {/* CCTV 추적 진행 — 입장/30s/변화/퇴장 스냅샷 시계열 */}
                    {snaps.length > 0 && (
                      <div style={{ marginTop: 6, padding: 7, background: "rgba(8,145,178,0.08)", borderRadius: 5, border: "1px solid rgba(8,145,178,0.2)" }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
                          <span style={{ fontSize: 9, fontWeight: 800, color: "#67e8f9", letterSpacing: ".05em" }}>
                            📹 CCTV 행동 추적 ({snaps.length})
                          </span>
                          <button onClick={() => setExpandedEventId(isExpanded ? null : eventId)}
                            style={{ background: "transparent", border: "1px solid rgba(103,232,249,0.3)", color: "#67e8f9", borderRadius: 3, padding: "1px 7px", fontSize: 9, cursor: "pointer", fontWeight: 700 }}>
                            {isExpanded ? "▴ 접기" : "▾ 전체 보기"}
                          </button>
                        </div>
                        {/* 항상 보이는 마지막 분석 결과 */}
                        {lastSnap && (
                          <div style={{ display: "flex", alignItems: "flex-start", gap: 7 }}>
                            <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, fontWeight: 700,
                              background: lastSnap.event_type === "entry" ? "rgba(34,197,94,0.25)"
                                : lastSnap.event_type === "behavior_change" ? "rgba(251,191,36,0.25)"
                                : lastSnap.event_type === "exit" ? "rgba(220,38,38,0.25)"
                                : "rgba(148,163,184,0.2)",
                              color: lastSnap.event_type === "entry" ? "#86efac"
                                : lastSnap.event_type === "behavior_change" ? "#fbbf24"
                                : lastSnap.event_type === "exit" ? "#fca5a5"
                                : "#cbd5e1",
                              flexShrink: 0,
                            }}>
                              {lastSnap.event_type === "entry" ? "입장"
                                : lastSnap.event_type === "behavior_change" ? "변화"
                                : lastSnap.event_type === "exit" ? "퇴장"
                                : `30s #${lastSnap.tick_seq ?? 0}`}
                            </span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 10, color: "#e0f2fe", lineHeight: 1.4 }}>
                                {lastSnap.ai_summary || "(분석 대기 중)"}
                              </div>
                              <div style={{ fontSize: 9, color: "#64748b", marginTop: 2, fontFamily: "ui-monospace,monospace" }}>
                                {fmtTimeFull(lastSnap.occurred_at)}
                              </div>
                            </div>
                          </div>
                        )}
                        {/* 펼침 시 전체 시계열 */}
                        {isExpanded && (
                          <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px dashed rgba(103,232,249,0.2)" }}>
                            {snaps.map((s, i) => (
                              <div key={s.id || i} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "flex-start" }}>
                                {s.snapshot_url && (
                                  <img src={s.snapshot_url} loading="lazy" alt=""
                                    style={{ width: 48, height: 36, objectFit: "cover", borderRadius: 3, border: "1px solid rgba(255,255,255,0.1)", flexShrink: 0, background: "#0f172a" }}
                                    onError={(e) => { e.target.style.display = "none"; }} />
                                )}
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: 9, color: "#94a3b8", fontFamily: "ui-monospace,monospace", display: "flex", gap: 5, alignItems: "center", marginBottom: 1 }}>
                                    <span style={{ fontSize: 8, padding: "0px 4px", borderRadius: 2, fontWeight: 700,
                                      background: s.event_type === "entry" ? "rgba(34,197,94,0.2)" : s.event_type === "behavior_change" ? "rgba(251,191,36,0.2)" : s.event_type === "exit" ? "rgba(220,38,38,0.2)" : "rgba(148,163,184,0.15)",
                                      color: s.event_type === "entry" ? "#86efac" : s.event_type === "behavior_change" ? "#fbbf24" : s.event_type === "exit" ? "#fca5a5" : "#94a3b8" }}>
                                      {s.event_type === "entry" ? "IN" : s.event_type === "behavior_change" ? "Δ" : s.event_type === "exit" ? "OUT" : `t${s.tick_seq ?? 0}`}
                                    </span>
                                    <span>{fmtTimeFull(s.occurred_at)}</span>
                                    {s.dwell_sec != null && <span>· {Math.floor(s.dwell_sec/60)}m{s.dwell_sec%60}s</span>}
                                  </div>
                                  <div style={{ fontSize: 10, color: "#cbd5e1", lineHeight: 1.4 }}>
                                    {s.ai_summary || "(분석 결과 없음)"}
                                  </div>
                                  {s.ai_changed_from && (
                                    <div style={{ fontSize: 8, color: "#fbbf24", marginTop: 1, fontStyle: "italic" }}>
                                      ⤴ 이전: "{s.ai_changed_from.slice(0, 50)}..."
                                    </div>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    <div style={{ marginTop: 6, display: "flex", gap: 4 }}>
                      {cctvUrl && (
                        <a href={cctvUrl} target="_blank" rel="noopener"
                          style={{ display: "inline-block", padding: "3px 9px", borderRadius: 4, background: "linear-gradient(135deg,#0891b2,#059669)", color: "#fff", fontSize: 10, fontWeight: 700, textDecoration: "none" }}>
                          📹 CCTV ch{p.cctv_channel} ↗
                        </a>
                      )}
                      {p.cctv_channel != null && (
                        <button onClick={async () => {
                          const inserted = await runCctvAnalysisForPresence({ ...p, presence_event_id: eventId, dwell_sec_now: dwell*60 }, "manual");
                          if (inserted) loadSnapshotsForEvent(eventId);
                        }}
                          style={{ padding: "3px 9px", borderRadius: 4, background: "rgba(124,58,237,0.3)", color: "#c4b5fd", border: "1px solid rgba(167,139,250,0.4)", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>
                          ⚡ 지금 분석
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
          </div>
        </div>
      )}

      {/* 게이트웨이 매핑 모달 */}
      {showGwEditor && (
        <GatewayZoneEditor
          sb={supabaseRef.current}
          current={gwMap}
          onClose={() => setShowGwEditor(false)}
          onSaved={() => { setShowGwEditor(false); loadAll(supabaseRef.current); }}
        />
      )}

      {/* 직원-비콘 매핑 모달 */}
      {showStaffBind && (
        <StaffBeaconBindingModal
          sb={supabaseRef.current}
          current={staffBeacons}
          onClose={() => setShowStaffBind(false)}
          onChanged={() => loadAll(supabaseRef.current)}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  비콘 게이트웨이 인프라 카드 (스팟 매칭 드롭다운 내장)
// ────────────────────────────────────────────────────────────
function GatewayInfraCard({ g, spots, isEditing, onStartEdit, onCancelEdit, onUpdateSerial, onUpdateSpot, onUpdateStatus }) {
  const liveColor =
    g.live_status === "online"     ? "#22c55e" :
    g.live_status === "idle"       ? "#fbbf24" :
    g.live_status === "offline"    ? "#ef4444" :
    g.install_status === "planned" ? "#94a3b8" :
                                     "#64748b";
  const liveLabel =
    g.live_status === "online"     ? "온라인" :
    g.live_status === "idle"       ? "유휴" :
    g.live_status === "offline"    ? "오프라인" :
    g.live_status === "never_seen" ? "신호 없음" :
    g.install_status === "planned" ? "설치 대기" :
                                     g.install_status;
  const cardBorder = g.install_status === "active"
    ? "rgba(34,197,94,0.35)"
    : g.install_status === "planned"
      ? "rgba(251,191,36,0.35)"
      : "rgba(220,38,38,0.35)";

  return (
    <div style={{
      padding: "8px 10px", borderRadius: 6,
      background: "rgba(255,255,255,0.04)",
      border: `1px solid ${cardBorder}`,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: liveColor,
            boxShadow: g.live_status === "online" ? "0 0 8px rgba(34,197,94,0.6)" : "none" }} />
          <strong style={{ fontSize: 12, fontWeight: 700, color: "#f1f5f9" }}>{g.spot_name}</strong>
          {g.is_outdoor && (
            <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: "rgba(96,165,250,0.2)", color: "#93c5fd" }}>
              야외
            </span>
          )}
        </div>
        <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: `${liveColor}22`, color: liveColor, fontWeight: 700 }}>
          {liveLabel}
        </span>
      </div>

      {/* 스팟 매칭 드롭다운 */}
      <div style={{ marginBottom: 5 }}>
        <label style={{ display: "block", fontSize: 9, color: "#64748b", fontWeight: 700, marginBottom: 2 }}>📍 스팟 매칭</label>
        <select value={g.spot_id || ""} onChange={(e) => onUpdateSpot(e.target.value)}
          style={{ width: "100%", padding: "3px 6px", background: "#0f172a", color: "#f1f5f9",
            border: "1px solid rgba(255,255,255,0.15)", borderRadius: 3, fontSize: 11, cursor: "pointer" }}>
          {!spots.find(s => s.id === g.spot_id) && g.spot_id && (
            <option value={g.spot_id}>⚠ {g.spot_name} (미정의 스팟)</option>
          )}
          {spots.map(s => (
            <option key={s.id} value={s.id}>{s.icon} {s.name}</option>
          ))}
        </select>
      </div>

      {/* 시리얼 (인라인 편집) */}
      <div style={{ fontSize: 10, color: "#94a3b8", fontFamily: "ui-monospace,monospace", marginBottom: 5 }}>
        {isEditing ? (
          <input
            defaultValue={g.gateway_serial || ""}
            placeholder="GW-XXXX-XXXXXX"
            onBlur={(e) => onUpdateSerial(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onUpdateSerial(e.target.value); if (e.key === "Escape") onCancelEdit(); }}
            autoFocus
            style={{ width: "100%", padding: "3px 6px", background: "#0f172a", color: "#f1f5f9",
              border: "1px solid #475569", borderRadius: 3, fontSize: 10, fontFamily: "ui-monospace,monospace" }}
          />
        ) : (
          <span onClick={onStartEdit} style={{ cursor: "pointer" }} title="클릭하면 시리얼 편집">
            GW: {g.gateway_serial || <em style={{ color: "#fbbf24" }}>(미등록 — 클릭해 입력)</em>}
            {g.detections_24h > 0 && <span style={{ color: "#86efac", marginLeft: 4 }}>· 24h {g.detections_24h.toLocaleString()}</span>}
          </span>
        )}
      </div>

      {/* 상태 토글 버튼 */}
      <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
        {["active","planned","offline","maintenance"].filter(s => s !== g.install_status).map(s => {
          const lbl = s === "active" ? "→ 가동" : s === "planned" ? "→ 예정" : s === "offline" ? "→ 오프" : "→ 점검";
          return (
            <button key={s} onClick={() => onUpdateStatus(s)}
              style={{ padding: "2px 7px", fontSize: 9, fontWeight: 700, cursor: "pointer",
                background: "rgba(255,255,255,0.06)", color: "#cbd5e1",
                border: "1px solid rgba(255,255,255,0.15)", borderRadius: 3 }}>
              {lbl}
            </button>
          );
        })}
      </div>

      {g.notes && (
        <div style={{ marginTop: 5, fontSize: 9, color: "#64748b", lineHeight: 1.4 }}>
          {g.notes}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  직원-비콘 매핑 모달
// ────────────────────────────────────────────────────────────
function StaffBeaconBindingModal({ sb, current, onClose, onChanged }) {
  const [staffList, setStaffList] = useState([]);
  const [staffId, setStaffId] = useState("");
  const [beaconUuid, setBeaconUuid] = useState("");
  const [beaconLabel, setBeaconLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!sb) return;
    // staff 테이블에는 role 컬럼이 없음 — dept_id 사용. 이름 정렬 유지
    sb.from("staff").select("id, name, dept_id, is_part_time, active").eq("active", true).order("name")
      .then(({ data, error }) => {
        if (error) console.warn("[staff list]", error.message);
        setStaffList(data || []);
      });
  }, [sb]);

  const add = async () => {
    if (!staffId || !beaconUuid) { setErr("직원 + 비콘 UUID 필수"); return; }
    if (!sb) { setErr("Supabase 미연결"); return; }
    setSaving(true); setErr(null);
    const { error } = await sb.from("staff_beacons").insert({
      staff_id: Number(staffId),
      beacon_uuid: beaconUuid.trim(),
      beacon_label: beaconLabel.trim() || null,
    });
    setSaving(false);
    if (error) { setErr(error.message); return; }
    setBeaconUuid(""); setBeaconLabel(""); setStaffId("");
    onChanged && onChanged();
  };

  const returnBeacon = async (id) => {
    if (!confirm("이 비콘을 반납 처리하시겠습니까?")) return;
    if (!sb) { alert("Supabase 미연결"); return; }
    const { error } = await sb.from("staff_beacons")
      .update({ returned_at: new Date().toISOString() }).eq("id", id);
    if (error) { alert(error.message); return; }
    onChanged && onChanged();
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 9999,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "#0f172a", borderRadius: 10, maxWidth: 640, width: "100%",
        maxHeight: "85vh", display: "flex", flexDirection: "column", overflow: "hidden",
        color: "#f1f5f9", border: "1px solid #334155" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid #334155",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          background: "linear-gradient(135deg,#0891b2,#0e7490)" }}>
          <strong style={{ fontSize: 14 }}>👥 직원 ↔ 비콘 매핑</strong>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#fff", fontSize: 18, cursor: "pointer" }}>✕</button>
        </div>

        <div style={{ padding: 16, overflowY: "auto" }}>
          {/* 신규 등록 폼 */}
          <div style={{ padding: 12, background: "rgba(255,255,255,0.04)", borderRadius: 6, marginBottom: 14, border: "1px solid #334155" }}>
            <div style={{ fontSize: 11, fontWeight: 800, marginBottom: 8, color: "#93c5fd" }}>+ 새 매핑 추가</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
              <select value={staffId} onChange={e => setStaffId(e.target.value)}
                style={{ padding: 6, background: "#1e293b", color: "#f1f5f9", border: "1px solid #475569", borderRadius: 4, fontSize: 11 }}>
                <option value="">— 직원 선택 ({staffList.length}명) —</option>
                {staffList.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.name}{s.is_part_time ? " (알바)" : ""}{s.dept_id ? ` · dept#${s.dept_id}` : ""}
                  </option>
                ))}
              </select>
              <input type="text" value={beaconLabel} onChange={e => setBeaconLabel(e.target.value)}
                placeholder="라벨 (선택, 예: BEACON-A1)"
                style={{ padding: 6, background: "#1e293b", color: "#f1f5f9", border: "1px solid #475569", borderRadius: 4, fontSize: 11 }} />
            </div>
            <input type="text" value={beaconUuid} onChange={e => setBeaconUuid(e.target.value)}
              placeholder="비콘 MAC/UUID (예: AC:23:3F:11:22:33)"
              style={{ width: "100%", padding: 6, background: "#1e293b", color: "#f1f5f9", border: "1px solid #475569", borderRadius: 4, fontSize: 11, fontFamily: "monospace", marginBottom: 8 }} />
            <button onClick={add} disabled={saving}
              style={{ padding: "6px 14px", background: "linear-gradient(135deg,#0891b2,#0e7490)", color: "#fff", border: "none", borderRadius: 4, fontSize: 11, fontWeight: 700, cursor: saving ? "wait" : "pointer" }}>
              {saving ? "저장 중..." : "+ 등록"}
            </button>
            {err && <div style={{ marginTop: 6, color: "#fca5a5", fontSize: 10 }}>{err}</div>}
          </div>

          <div style={{ fontSize: 11, fontWeight: 800, marginBottom: 8, color: "#cbd5e1" }}>
            현재 휴대중 ({current.length})
          </div>
          {current.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: "#64748b", fontSize: 11 }}>
              등록된 비콘이 없습니다. 위에서 추가하세요.
            </div>
          ) : (
            current.map(b => {
              const s = staffList.find(x => x.id === b.staff_id);
              return (
                <div key={b.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: 10, marginBottom: 6, background: "rgba(255,255,255,0.04)", borderRadius: 5, border: "1px solid #334155" }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700 }}>
                      {s?.name || `직원#${b.staff_id}`}
                      {b.beacon_label && <span style={{ marginLeft: 6, fontSize: 9, padding: "1px 6px", borderRadius: 3, background: "rgba(167,139,250,0.2)", color: "#c4b5fd" }}>{b.beacon_label}</span>}
                    </div>
                    <div style={{ fontSize: 9, color: "#94a3b8", fontFamily: "monospace", marginTop: 2 }}>
                      {b.beacon_uuid} · 발급 {new Date(b.issued_at).toLocaleDateString("ko-KR")}
                    </div>
                  </div>
                  <button onClick={() => returnBeacon(b.id)}
                    style={{ padding: "4px 10px", background: "rgba(220,38,38,0.2)", color: "#fca5a5", border: "1px solid rgba(220,38,38,0.4)", borderRadius: 4, fontSize: 10, fontWeight: 700, cursor: "pointer" }}>
                    반납
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  보조 컴포넌트
// ────────────────────────────────────────────────────────────
function SectionTitle({ children }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 800, color: "#a78bfa", letterSpacing: ".12em", textTransform: "uppercase", marginBottom: 8 }}>
      {children}
    </div>
  );
}
function EmptyHint({ children }) {
  return (
    <div style={{ padding: "20px 8px", textAlign: "center", color: "#64748b", fontSize: 11, lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
//  게이트웨이 ↔ 구역 매핑 에디터
// ────────────────────────────────────────────────────────────
function GatewayZoneEditor({ sb, current, onClose, onSaved }) {
  const [rows, setRows] = useState(() => current.map(r => ({ ...r })));
  const [newRow, setNewRow] = useState({ gateway_serial: "", zone_id: "", zone_name: "", cctv_channel: "", dwell_threshold_min: 2 });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  // 사용자 정의 zone + BASE_ZONES 모두 합쳐서 드롭다운 옵션으로 노출
  // (source.jsx 에서 window.__jamsaBaseZones / __jamsaCctvAutoMap 로 노출)
  const allZones = useMemo(() => {
    const base = (typeof window !== "undefined" && Array.isArray(window.__jamsaBaseZones))
      ? window.__jamsaBaseZones : [];
    let custom = [];
    try { custom = JSON.parse(localStorage.getItem("jamsa_custom_zones") || "[]"); } catch (e) {}
    // _deleted 필터 + 중복 제거
    let zc = {};
    try { zc = JSON.parse(localStorage.getItem("jamsa_zone_customizations") || "{}"); } catch (e) {}
    const merged = [...base, ...custom].filter(z => !zc[z.id]?._deleted);
    // 사용자 커스텀 이름 적용
    return merged.map(z => ({
      id: z.id,
      name: zc[z.id]?.name || z.name,
      icon: zc[z.id]?.icon || z.icon || "📍",
    }));
  }, []);

  // CCTV_AUTO_MAP 으로 스팟 선택 시 기본 채널 자동 추천
  const autoCctvForZone = (zoneId) => {
    try {
      // 우선순위 ①: zoneCustomizations 의 cctvChannels (사용자 명시)
      const zc = JSON.parse(localStorage.getItem("jamsa_zone_customizations") || "{}");
      const userChs = zc[zoneId]?.cctvChannels;
      if (Array.isArray(userChs) && userChs.length > 0) return userChs[0];
      // ②: jamsa_cctv_zone_map (CCTV 편집에서 저장한 값)
      const cm = JSON.parse(localStorage.getItem("jamsa_cctv_zone_map") || "{}");
      if (Array.isArray(cm[zoneId]) && cm[zoneId].length > 0) return cm[zoneId][0];
      // ③: CCTV_AUTO_MAP (코드 기본값)
      const auto = (typeof window !== "undefined") ? window.__jamsaCctvAutoMap : null;
      if (auto && Array.isArray(auto[zoneId]) && auto[zoneId].length > 0) return auto[zoneId][0];
    } catch (e) {}
    return "";
  };

  // 구역 선택 시 zone_id / zone_name / cctv_channel 한 번에 설정
  const handlePickZone = (zoneId) => {
    if (!zoneId) {
      setNewRow({ ...newRow, zone_id: "", zone_name: "", cctv_channel: "" });
      return;
    }
    const z = allZones.find(x => x.id === zoneId);
    if (!z) return;
    setNewRow({
      ...newRow,
      zone_id: z.id,
      zone_name: z.name,
      cctv_channel: String(autoCctvForZone(z.id) || ""),
    });
  };

  // 감지된 게이트웨이 목록 (beacon_detections 에서 distinct)
  const [knownGws, setKnownGws] = useState([]);
  useEffect(() => {
    if (!sb) return;
    (async () => {
      try {
        const { data } = await sb
          .from("beacon_detections")
          .select("gateway_serial")
          .order("detected_at", { ascending: false })
          .limit(200);
        const uniq = Array.from(new Set((data||[]).map(d => d.gateway_serial).filter(Boolean)));
        setKnownGws(uniq);
      } catch (e) {}
    })();
  }, [sb]);

  const addRow = () => {
    if (!newRow.gateway_serial.trim() || !newRow.zone_name.trim()) {
      alert("게이트웨이 시리얼과 구역명을 입력하세요");
      return;
    }
    setRows([...rows, {
      ...newRow,
      zone_id: newRow.zone_id.trim() || `zone-${Date.now()}`,
      cctv_channel: newRow.cctv_channel ? Number(newRow.cctv_channel) : null,
    }]);
    setNewRow({ gateway_serial: "", zone_id: "", zone_name: "", cctv_channel: "", dwell_threshold_min: 2 });
  };

  const deleteRow = async (gateway_serial) => {
    if (!confirm(`'${gateway_serial}' 매핑을 삭제하시겠습니까?`)) return;
    if (sb) {
      const { error } = await sb.from("gateway_zone_map").delete().eq("gateway_serial", gateway_serial);
      if (error) { alert("삭제 실패: " + error.message); return; }
    }
    const next = rows.filter(r => r.gateway_serial !== gateway_serial);
    setRows(next);
    saveGwMapLocal(next); // localStorage 동기화
    onSaved && onSaved();
  };

  const saveAll = async () => {
    setSaving(true); setErr(null);
    try {
      const payload = rows.map(r => ({
        gateway_serial: r.gateway_serial,
        zone_id: r.zone_id,
        zone_name: r.zone_name,
        cctv_channel: r.cctv_channel === "" ? null : (r.cctv_channel == null ? null : Number(r.cctv_channel)),
        dwell_threshold_min: r.dwell_threshold_min || 2,
        notes: r.notes || null,
        updated_at: new Date().toISOString(),
      }));
      // localStorage 에 먼저 저장 (오프라인/Supabase 미연결 시에도 영구 유지)
      saveGwMapLocal(payload);
      // Supabase 가 연결돼 있으면 추가로 동기화
      if (sb) {
        const { error } = await sb.from("gateway_zone_map").upsert(payload, { onConflict: "gateway_serial" });
        if (error) throw error;
      }
      onSaved && onSaved();
    } catch (e) {
      setErr((e?.message || String(e)) + " (localStorage 에는 저장됨)");
    } finally { setSaving(false); }
  };

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 820, maxHeight: "85vh", background: "#0f172a", color: "#f1f5f9", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid rgba(255,255,255,0.08)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800 }}>⚙ 게이트웨이 ↔ 구역 매핑</div>
            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
              각 BLE 게이트웨이가 어떤 구역에 설치되어 있는지 + CCTV 채널 지정
            </div>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.15)", color: "#94a3b8", borderRadius: 4, padding: "4px 10px", cursor: "pointer" }}>✕</button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 18 }}>
          {/* 기존 매핑 */}
          <div style={{ fontSize: 11, fontWeight: 800, color: "#a78bfa", letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 8 }}>
            매핑된 게이트웨이 ({rows.length})
          </div>
          {rows.length === 0 ? (
            <div style={{ padding: 16, textAlign: "center", color: "#64748b", fontSize: 11 }}>아직 매핑된 게이트웨이가 없습니다</div>
          ) : (
            <div style={{ marginBottom: 18 }}>
              {rows.map((r, i) => (
                <div key={r.gateway_serial + i}
                  style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 0.8fr 0.5fr 32px", gap: 6, marginBottom: 6, padding: 8, background: "rgba(255,255,255,0.04)", borderRadius: 4, alignItems: "center" }}>
                  <input value={r.gateway_serial} onChange={(e) => {
                    const next = [...rows]; next[i].gateway_serial = e.target.value; setRows(next);
                  }} placeholder="게이트웨이 시리얼"
                    style={inputStyle} />
                  <select value={r.zone_id || ""}
                    onChange={(e) => {
                      const next = [...rows];
                      const z = allZones.find(x => x.id === e.target.value);
                      if (z) {
                        next[i].zone_id = z.id;
                        next[i].zone_name = z.name;
                        if (!next[i].cctv_channel) next[i].cctv_channel = String(autoCctvForZone(z.id) || "");
                      } else {
                        next[i].zone_id = "";
                        next[i].zone_name = "";
                      }
                      setRows(next);
                    }}
                    style={{ ...inputStyle, cursor: "pointer" }}>
                    <option value="">— 스팟 선택 —</option>
                    {allZones.map(z => (
                      <option key={z.id} value={z.id}>{z.icon} {z.name}</option>
                    ))}
                    {/* 기존에 저장된 zone_id 가 BASE/custom 에 없으면 유지 표시 */}
                    {r.zone_id && !allZones.find(x => x.id === r.zone_id) && (
                      <option value={r.zone_id}>⚠ {r.zone_name || r.zone_id} (구역 없음)</option>
                    )}
                  </select>
                  <input type="number" value={r.cctv_channel ?? ""} onChange={(e) => {
                    const next = [...rows]; next[i].cctv_channel = e.target.value; setRows(next);
                  }} placeholder="CCTV ch"
                    style={inputStyle} />
                  <input type="number" value={r.dwell_threshold_min || 2} onChange={(e) => {
                    const next = [...rows]; next[i].dwell_threshold_min = Number(e.target.value) || 2; setRows(next);
                  }} placeholder="체류분"
                    style={inputStyle} />
                  <button onClick={() => deleteRow(r.gateway_serial)}
                    style={{ background: "rgba(220,38,38,0.2)", color: "#fca5a5", border: "1px solid rgba(220,38,38,0.4)", borderRadius: 3, padding: "5px 0", cursor: "pointer", fontSize: 11 }}>✕</button>
                </div>
              ))}
            </div>
          )}

          {/* 새 매핑 추가 */}
          <div style={{ fontSize: 11, fontWeight: 800, color: "#34d399", letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 8 }}>
            + 새 매핑 추가
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 0.8fr 0.5fr auto", gap: 6, alignItems: "center", padding: 8, background: "rgba(52,211,153,0.05)", border: "1px dashed rgba(52,211,153,0.3)", borderRadius: 4 }}>
            <div>
              <input list="known-gws" value={newRow.gateway_serial}
                onChange={(e) => setNewRow({ ...newRow, gateway_serial: e.target.value })}
                placeholder="게이트웨이 시리얼" style={inputStyle} />
              <datalist id="known-gws">
                {knownGws.map(g => <option key={g} value={g} />)}
              </datalist>
            </div>
            <div>
              <select value={newRow.zone_id}
                onChange={(e) => handlePickZone(e.target.value)}
                style={{ ...inputStyle, cursor: "pointer" }}>
                <option value="">— 스팟 선택 —</option>
                {allZones.map(z => (
                  <option key={z.id} value={z.id}>{z.icon} {z.name}</option>
                ))}
              </select>
            </div>
            <input type="number" value={newRow.cctv_channel}
              onChange={(e) => setNewRow({ ...newRow, cctv_channel: e.target.value })}
              placeholder="CCTV ch" style={inputStyle} />
            <input type="number" value={newRow.dwell_threshold_min}
              onChange={(e) => setNewRow({ ...newRow, dwell_threshold_min: Number(e.target.value) || 2 })}
              placeholder="체류분" style={inputStyle} />
            <button onClick={addRow}
              style={{ padding: "6px 14px", background: "#10b981", color: "#0f172a", border: "none", borderRadius: 4, fontSize: 11, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap" }}>
              추가
            </button>
          </div>

          {knownGws.length > 0 && (
            <div style={{ marginTop: 14, padding: 10, background: "rgba(96,165,250,0.08)", border: "1px solid rgba(96,165,250,0.2)", borderRadius: 4, fontSize: 11, color: "#cbd5e1" }}>
              <strong style={{ color: "#93c5fd" }}>📡 최근 감지된 게이트웨이 ({knownGws.length})</strong>
              <div style={{ marginTop: 6, fontFamily: "ui-monospace,monospace", fontSize: 10, color: "#94a3b8", lineHeight: 1.6 }}>
                {knownGws.slice(0, 8).map(g => (
                  <span key={g} style={{ display: "inline-block", marginRight: 8 }}>
                    <code style={{ background: "rgba(255,255,255,0.05)", padding: "1px 5px", borderRadius: 3, color: "#93c5fd" }}>{g}</code>
                  </span>
                ))}
                {knownGws.length > 8 && <>… 외 {knownGws.length - 8}개</>}
              </div>
            </div>
          )}

          {err && (
            <div style={{ marginTop: 12, padding: 10, background: "rgba(220,38,38,0.1)", border: "1px solid rgba(220,38,38,0.3)", borderRadius: 4, fontSize: 11, color: "#fca5a5" }}>
              ⚠ {err}
            </div>
          )}
        </div>

        <div style={{ padding: "10px 18px", borderTop: "1px solid rgba(255,255,255,0.08)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 10, color: "#64748b" }}>
            저장 후 게이트웨이 webhook 으로 비콘 감지가 들어오면 자동으로 구역/CCTV가 연결됩니다
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={onClose}
              style={{ padding: "6px 14px", borderRadius: 4, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#cbd5e1", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
              닫기
            </button>
            <button onClick={saveAll} disabled={saving}
              style={{ padding: "6px 14px", borderRadius: 4, background: saving ? "#64748b" : "#7c3aed", color: "#fff", border: "none", fontSize: 11, fontWeight: 800, cursor: saving ? "wait" : "pointer" }}>
              {saving ? "저장 중..." : "전체 저장"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const inputStyle = {
  width: "100%", padding: "5px 8px", background: "#0b1220", border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 3, color: "#f1f5f9", fontSize: 11, fontFamily: "ui-monospace,monospace", outline: "none",
};
