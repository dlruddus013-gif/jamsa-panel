// beacon-gateway.jsx
// 비콘 + 게이트웨이 통합 관리
//
// 기능:
//  1. Web Bluetooth API로 BLE 비콘 직접 스캔/연결 (Chrome/Android)
//  2. 비콘 UUID/MAC ↔ 구역 매핑 등록 (localStorage)
//  3. 실시간 RSSI 모니터 + 거리 추정 + 가장 가까운 비콘 표시
//  4. Minew G1 등 외부 게이트웨이 webhook URL 안내
//  5. 게이트웨이 → 패널 실시간 연동 테스트
//  6. 연결 상태 종합 진단

import React, { useEffect, useMemo, useRef, useState } from "react";
import { BeaconAlertRulesPanel, evaluateAndTrigger } from "./beacon-alert-rules.jsx";
import { processDetectionBatch } from "./presence-log-engine.js";

const REG_KEY = "jamsa_beacons";          // 등록된 비콘 (UUID → zone)
const HIST_KEY = "jamsa_beacon_history";  // 감지 이력 (최근 N건)
const GATEWAY_KEY = "jamsa_gateway_config"; // 게이트웨이 설정

// ─── 저장 헬퍼 ──────────────────────────────────────────────────────
function loadReg() { try { return JSON.parse(localStorage.getItem(REG_KEY) || "{}"); } catch (e) { return {}; } }
function saveReg(d) { try { localStorage.setItem(REG_KEY, JSON.stringify(d)); } catch (e) {} }
function loadHist() { try { return JSON.parse(localStorage.getItem(HIST_KEY) || "[]"); } catch (e) { return []; } }
function saveHist(arr) { try { localStorage.setItem(HIST_KEY, JSON.stringify(arr.slice(0, 300))); } catch (e) {} }
function loadGw() { try { return JSON.parse(localStorage.getItem(GATEWAY_KEY) || "{}"); } catch (e) { return {}; } }
function saveGw(d) { try { localStorage.setItem(GATEWAY_KEY, JSON.stringify(d)); } catch (e) {} }

// RSSI → 거리 추정 (txPower=-59 기준 경로손실 모델, 단위: m)
export function rssiToDistance(rssi, txPower = -59) {
  if (!rssi || rssi === 0) return null;
  const ratio = rssi / txPower;
  if (ratio < 1) return Math.pow(ratio, 10);
  return 0.89976 * Math.pow(ratio, 7.7095) + 0.111;
}

// ─── 메인 모달 ─────────────────────────────────────────────────────
export function BeaconGatewayModal({ onClose, zones = [], curUser }) {
  const [tab, setTab] = useState("scan");
  const [reg, setRegState] = useState(loadReg);
  const [hist, setHistState] = useState(loadHist);
  const [gw, setGwState] = useState(() => ({
    webhookUrl: typeof window !== "undefined" ? `${window.location.origin}/api/beacon-webhook` : "",
    gatewaySerial: "",
    gatewayLocation: "",
    ...loadGw(),
  }));
  const [bleSupported, setBleSupported] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [detected, setDetected] = useState([]); // 현재 스캔에서 발견된 비콘들
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [manualBeacon, setManualBeacon] = useState({ id: "", name: "", zone: "" });
  const [liveRssi, setLiveRssi] = useState({}); // {id: rssi}
  const [testResult, setTestResult] = useState(null);
  const watchersRef = useRef([]);

  useEffect(() => { setBleSupported(typeof navigator !== "undefined" && !!navigator.bluetooth); }, []);

  // 백엔드 webhook 도착 이벤트 폴링 — scan/gateway/test 탭 어디서나
  const [recentWebhook, setRecentWebhook] = useState(null);
  useEffect(() => {
    if (tab !== "gateway" && tab !== "scan" && tab !== "test") return;
    let stop = false;
    const poll = async () => {
      try {
        const r = await fetch("/api/beacon-webhook?recent=1", { cache: "no-store" });
        if (r.ok) {
          const d = await r.json();
          if (!stop && d.last) {
            setRecentWebhook(d.last);
            // 게이트웨이가 보낸 비콘들을 detected 목록에 자동 추가/갱신
            const payload = d.last.payload || {};
            const obj = payload.obj || payload.beacons || payload.advertisements || payload.data || [];
            if (Array.isArray(obj) && obj.length > 0) {
              setDetected(prev => {
                const next = [...prev];
                obj.forEach(b => {
                  const id = b.mac || b.uuid || b.id || b.macAddress;
                  if (!id) return;
                  const name = b.name || b.deviceName || `Beacon-${String(id).slice(-6)}`;
                  const rssi = b.rssi != null ? Number(b.rssi) : null;
                  const idx = next.findIndex(x => x.id === id);
                  const entry = { id, name, uuid: id, rssi, connected: false, fromGateway: true, lastSeen: Date.now() };
                  if (idx >= 0) next[idx] = { ...next[idx], ...entry };
                  else next.unshift(entry);

                  // 🔔 비콘 알림 규칙 평가 → SMS 자동 발송
                  try {
                    evaluateAndTrigger(
                      { id, name, rssi },
                      { beaconReg: loadReg(), zones: zones || [] }
                    );
                  } catch (err) {
                    console.warn("[beacon-alert] eval failed:", err);
                  }
                });
                return next;
              });
            }
            // 📋 presence_log 생성 — 게이트웨이↔스팟 매핑이 있으면 자동 기록
            try {
              const gws = payload.gatewaySerial || payload.gateway || d.last.gateway;
              processDetectionBatch({
                gatewaySerial: gws,
                beacons: Array.isArray(obj) ? obj : [],
              });
            } catch (err) {
              console.warn("[presence-log] batch failed:", err);
            }
          }
        }
      } catch (e) {}
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => { stop = true; clearInterval(id); };
  }, [tab]);

  const updateReg = (patch) => {
    const next = { ...reg, ...patch };
    setRegState(next); saveReg(next);
  };
  const updateGw = (patch) => {
    const next = { ...gw, ...patch };
    setGwState(next); saveGw(next);
  };
  const addHist = (entry) => {
    const next = [{ id: Date.now() + Math.random(), at: new Date().toISOString(), ...entry }, ...hist];
    setHistState(next); saveHist(next);
  };

  // ── BLE 단일 비콘 페어링 (필터로 비콘만 표시) ──────────────────
  const [scanFilter, setScanFilter] = useState("beacon"); // "beacon" | "all"
  const scanOnce = async () => {
    if (!navigator.bluetooth) return alert("Bluetooth 미지원\nChrome (Android) 또는 데스크톱 Chrome/Edge 사용");
    setScanning(true);
    try {
      // 비콘 모드: 일반적 비콘 이름 prefix + Eddystone 서비스 필터 (잡음 제거)
      const reqOpts = scanFilter === "beacon" ? {
        filters: [
          { namePrefix: "Minew" }, { namePrefix: "iBKS" }, { namePrefix: "B-Fon" },
          { namePrefix: "Beacon" }, { namePrefix: "iB" }, { namePrefix: "MS" },
          { namePrefix: "Eddystone" }, { namePrefix: "Kontakt" }, { namePrefix: "Estimote" },
          { namePrefix: "HC-" }, { namePrefix: "JM-" },
          { services: ["0000feaa-0000-1000-8000-00805f9b34fb"] }, // Eddystone
          { services: ["0000fff0-0000-1000-8000-00805f9b34fb"] }, // Common beacon service
        ],
        optionalServices: ["battery_service", "device_information"],
      } : {
        acceptAllDevices: true,
        optionalServices: ["battery_service", "device_information", "0000feaa-0000-1000-8000-00805f9b34fb"],
      };
      const device = await navigator.bluetooth.requestDevice(reqOpts);
      const beacon = {
        id: device.id,
        name: device.name || `Beacon-${device.id?.slice(0, 6)}`,
        uuid: device.id,
        rssi: null,
        connected: false,
      };
      setDetected(prev => [beacon, ...prev.filter(b => b.id !== beacon.id)]);
      addHist({ kind: "scan", beaconId: beacon.id, beaconName: beacon.name });

      // GATT 연결 시도 → live RSSI는 어렵지만 연결 자체로 검증
      try {
        const server = await device.gatt.connect();
        beacon.connected = true;
        setDetected(prev => prev.map(b => b.id === beacon.id ? { ...b, connected: true } : b));
        // 연결 해제 감지
        device.addEventListener("gattserverdisconnected", () => {
          setDetected(prev => prev.map(b => b.id === beacon.id ? { ...b, connected: false } : b));
        });
        addHist({ kind: "connect", beaconId: beacon.id, beaconName: beacon.name });
      } catch (e) {
        // 연결 실패해도 detected는 유지
        addHist({ kind: "connect_fail", beaconId: beacon.id, error: e.message });
      }
    } catch (e) {
      if (e.name !== "NotFoundError") alert("스캔 오류: " + e.message);
    } finally { setScanning(false); }
  };

  // ── BLE 연속 스캔 (Bluetooth LE Scan API — 일부 기기만) ─────────
  const watchAdvertising = async () => {
    if (!navigator.bluetooth?.requestLEScan) {
      const enable = confirm(
        "⚠️ 연속 스캔 미지원\n\n" +
        "Chrome flags 활성화 필요:\n" +
        "1. 새 탭에서 chrome://flags/#enable-experimental-web-platform-features 열기\n" +
        "2. Enabled 선택 → Relaunch\n" +
        "3. 이 페이지 새로고침\n\n" +
        "💡 활성화가 어려우시면 '수동 등록' 버튼으로 비콘 UUID 직접 입력 가능합니다.\n" +
        "💡 또는 게이트웨이(Minew G1)를 사용하면 모든 비콘이 자동으로 수집됩니다.\n\n" +
        "Chrome flags 페이지를 지금 열까요?"
      );
      if (enable) {
        try {
          window.open("chrome://flags/#enable-experimental-web-platform-features", "_blank");
        } catch (e) {
          alert("브라우저 주소창에 직접 입력:\nchrome://flags/#enable-experimental-web-platform-features");
        }
      }
      return;
    }
    setScanning(true);
    try {
      const scan = await navigator.bluetooth.requestLEScan({ acceptAllAdvertisements: true });
      watchersRef.current.push(scan);
      const handler = (event) => {
        const id = event.device.id;
        const name = event.device.name || `Beacon-${id?.slice(0,6)}`;
        const rssi = event.rssi;
        setDetected(prev => {
          const ex = prev.find(b => b.id === id);
          if (ex) return prev.map(b => b.id === id ? { ...b, rssi, name } : b);
          return [{ id, name, rssi, uuid: id }, ...prev];
        });
        setLiveRssi(prev => ({ ...prev, [id]: rssi }));
        // 🔔 알림 규칙 평가
        try {
          evaluateAndTrigger({ id, name, rssi }, { beaconReg: loadReg(), zones: zones || [] });
        } catch (err) { /* silent */ }
      };
      navigator.bluetooth.addEventListener("advertisementreceived", handler);
      watchersRef.current.push({ stop: () => navigator.bluetooth.removeEventListener("advertisementreceived", handler) });
      addHist({ kind: "watch_start" });
    } catch (e) {
      alert("연속 스캔 실패: " + e.message);
      setScanning(false);
    }
  };
  const stopWatch = () => {
    watchersRef.current.forEach(w => { try { w.stop?.(); } catch (e) {} });
    watchersRef.current = [];
    setScanning(false);
    addHist({ kind: "watch_stop" });
  };
  useEffect(() => () => stopWatch(), []);

  // ── 비콘을 구역에 등록/매핑 ──────────────────────────────────────
  const assignZone = (beaconId, beaconName, zoneName) => {
    updateReg({ [beaconId]: { name: beaconName, zone: zoneName, registeredAt: new Date().toISOString(), registeredBy: curUser?.name || "system" } });
  };
  const unregister = (beaconId) => {
    const next = { ...reg };
    delete next[beaconId];
    setRegState(next); saveReg(next);
  };

  // ── 게이트웨이 연동 실시간 테스트 ────────────────────────────────
  const testGateway = async () => {
    setTestResult({ status: "testing" });
    try {
      // 1. webhook URL ping
      const r = await fetch(`${gw.webhookUrl}?ping=1`, { cache: "no-store" });
      const ok1 = r.ok;
      // 2. 모의 데이터 전송
      const r2 = await fetch(gw.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gatewaySerial: gw.gatewaySerial || "TEST_GW",
          beacons: [{ uuid: "TEST_BEACON_1", rssi: -65, name: "테스트 비콘" }],
          timestamp: new Date().toISOString(),
          test: true,
        }),
      });
      setTestResult({
        status: r2.ok ? "ok" : "error",
        pingOk: ok1,
        sendOk: r2.ok,
        sendStatus: r2.status,
        time: new Date().toISOString(),
      });
    } catch (e) {
      setTestResult({ status: "error", error: e.message, time: new Date().toISOString() });
    }
  };

  // 가장 가까운 비콘 (RSSI 가장 큼 = 가장 가까움)
  const nearest = useMemo(() => {
    if (detected.length === 0) return null;
    const withRssi = detected.filter(b => b.rssi != null);
    if (withRssi.length === 0) return detected[0];
    return withRssi.reduce((max, b) => (b.rssi > max.rssi ? b : max), withRssi[0]);
  }, [detected]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.7)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 14 }}>
      <div style={{ background: "#fff", borderRadius: 14, maxWidth: 1100, width: "100%", maxHeight: "94vh", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "14px 18px", background: "linear-gradient(135deg,#0ea5e9,#7c3aed)", color: "#fff", borderRadius: "14px 14px 0 0", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 900, margin: 0 }}>📡 비콘 · 게이트웨이 통합 관리</h2>
            <div style={{ fontSize: 11, opacity: 0.9, marginTop: 3 }}>BLE 직접 스캔 + Minew G1 게이트웨이 연동 + 실시간 테스트</div>
          </div>
          <button type="button" onClick={onClose} style={{ background: "rgba(255,255,255,0.2)", border: "none", color: "#fff", fontSize: 18, padding: "4px 12px", borderRadius: 6, cursor: "pointer" }}>✕</button>
        </div>

        <div style={{ padding: "6px 14px", borderBottom: "1px solid #e5e7eb", display: "flex", gap: 4, flexShrink: 0, overflowX: "auto" }}>
          {[
            { id: "scan", label: "📡 비콘 스캔" },
            { id: "registry", label: `🗂️ 등록 (${Object.keys(reg).length})` },
            { id: "gateway", label: "🌐 게이트웨이" },
            { id: "alerts", label: "🔔 자동 알림" },
            { id: "test", label: "🧪 실시간 테스트" },
            { id: "guide", label: "📚 연동 가이드" },
          ].map(t => (
            <button key={t.id} type="button" onClick={() => setTab(t.id)}
              style={{ padding: "7px 14px", background: tab === t.id ? "#0ea5e9" : "transparent", color: tab === t.id ? "#fff" : "#475569", border: "none", borderRadius: 6, fontWeight: 700, fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" }}>
              {t.label}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 16, background: "#fafbfc" }}>
          {/* 스캔 */}
          {tab === "scan" && (
            <div>
              {!bleSupported && (
                <div style={{ padding: 12, background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, marginBottom: 10, fontSize: 12, color: "#991b1b" }}>
                  ⚠️ 이 브라우저는 Web Bluetooth를 지원하지 않습니다. <strong>Chrome (Android) 또는 데스크톱 Chrome/Edge</strong>를 사용하세요. iOS Safari는 미지원이며 게이트웨이 모드로 사용하세요.
                </div>
              )}
              <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
                <button type="button" onClick={scanOnce} disabled={!bleSupported || scanning}
                  style={{ padding: "8px 16px", background: "#0ea5e9", color: "#fff", border: "none", borderRadius: 6, fontWeight: 700, fontSize: 12, cursor: bleSupported ? "pointer" : "not-allowed", opacity: bleSupported ? 1 : 0.5 }}>
                  📡 1회 스캔 (페어링)
                </button>
                <select value={scanFilter} onChange={e => setScanFilter(e.target.value)}
                  style={{ padding: "8px 10px", fontSize: 11, border: "1px solid #cbd5e1", borderRadius: 6, background: "#fff", cursor: "pointer" }}
                  title="페어링 다이얼로그에 표시될 기기 필터">
                  <option value="beacon">🎯 비콘만 (Minew/iBKS/Eddystone 등)</option>
                  <option value="all">📋 전체 기기 (잡음 많음)</option>
                </select>
                {!scanning ? (
                  <button type="button" onClick={watchAdvertising} disabled={!bleSupported}
                    style={{ padding: "8px 16px", background: "#10b981", color: "#fff", border: "none", borderRadius: 6, fontWeight: 700, fontSize: 12, cursor: bleSupported ? "pointer" : "not-allowed", opacity: bleSupported ? 1 : 0.5 }}>
                    🔄 연속 스캔 시작 (실시간 RSSI)
                  </button>
                ) : (
                  <button type="button" onClick={stopWatch}
                    style={{ padding: "8px 16px", background: "#dc2626", color: "#fff", border: "none", borderRadius: 6, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
                    ⏹️ 스캔 중지
                  </button>
                )}
                <button type="button" onClick={() => setShowManualEntry(s => !s)}
                  style={{ padding: "8px 16px", background: "#fff", color: "#7c3aed", border: "1px solid #c4b5fd", borderRadius: 6, fontWeight: 700, fontSize: 12, cursor: "pointer", marginLeft: "auto" }}>
                  ✏️ 수동 등록
                </button>
              </div>

              {/* 수동 비콘 등록 */}
              {showManualEntry && (
                <div style={{ padding: 12, marginBottom: 10, background: "#f5f3ff", border: "1px solid #c4b5fd", borderRadius: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: "#5b21b6", marginBottom: 6 }}>✏️ 수동 비콘 등록 (자동 스캔 불가 시)</div>
                  <div style={{ fontSize: 10, color: "#6b21a8", marginBottom: 8 }}>제조사 라벨에 적힌 UUID/MAC 주소를 직접 입력하세요. iOS Safari, 연속 스캔 미지원 환경 등에서 사용.</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 6 }}>
                    <input value={manualBeacon.id} onChange={e => setManualBeacon({...manualBeacon, id: e.target.value})}
                      placeholder="UUID 또는 MAC (예: AA:BB:CC:11:22:33)"
                      style={{ padding: "6px 10px", border: "1px solid #c4b5fd", borderRadius: 5, fontSize: 11, fontFamily: "monospace" }}/>
                    <input value={manualBeacon.name} onChange={e => setManualBeacon({...manualBeacon, name: e.target.value})}
                      placeholder="비콘 이름 (예: 수장고 정문)"
                      style={{ padding: "6px 10px", border: "1px solid #c4b5fd", borderRadius: 5, fontSize: 11 }}/>
                    <select value={manualBeacon.zone} onChange={e => setManualBeacon({...manualBeacon, zone: e.target.value})}
                      style={{ padding: "6px 10px", border: "1px solid #c4b5fd", borderRadius: 5, fontSize: 11 }}>
                      <option value="">구역 선택</option>
                      {zones.map(z => <option key={z.id || z} value={z.name || z}>{z.name || z}</option>)}
                    </select>
                    <button type="button" onClick={() => {
                      if (!manualBeacon.id.trim()) return alert("UUID/MAC 입력 필수");
                      const beacon = { id: manualBeacon.id.trim(), name: manualBeacon.name || `수동-${manualBeacon.id.slice(0,6)}`, uuid: manualBeacon.id.trim(), rssi: null, connected: false, manual: true };
                      setDetected(prev => [beacon, ...prev.filter(b => b.id !== beacon.id)]);
                      if (manualBeacon.zone) assignZone(beacon.id, beacon.name, manualBeacon.zone);
                      addHist({ kind: "manual_add", beaconId: beacon.id, beaconName: beacon.name });
                      setManualBeacon({ id: "", name: "", zone: "" });
                    }}
                      style={{ padding: "6px 14px", background: "#7c3aed", color: "#fff", border: "none", borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>＋ 추가</button>
                  </div>
                </div>
              )}

              {nearest && (
                <div style={{ padding: 14, background: "linear-gradient(135deg,#dbeafe,#fff)", border: "2px solid #3b82f6", borderRadius: 10, marginBottom: 10 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "#1e40af", marginBottom: 4 }}>📍 가장 가까운 비콘</div>
                  <div style={{ fontSize: 16, fontWeight: 900, color: "#0f172a" }}>{nearest.name}</div>
                  <div style={{ fontSize: 11, color: "#475569", marginTop: 4 }}>
                    {nearest.rssi != null && <>RSSI <strong style={{ color: "#0f172a" }}>{nearest.rssi} dBm</strong> · 추정 거리 <strong>{rssiToDistance(nearest.rssi)?.toFixed(1)}m</strong></>}
                    {nearest.rssi == null && <>RSSI 미측정 (연속 스캔 시작 필요)</>}
                    {nearest.connected && <span style={{ marginLeft: 6, padding: "1px 6px", background: "#dcfce7", color: "#065f46", borderRadius: 3, fontSize: 10, fontWeight: 800 }}>✓ 연결됨</span>}
                  </div>
                </div>
              )}

              <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 6, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span>🔍 감지된 비콘 ({detected.length})</span>
                <span style={{ fontSize: 9, fontWeight: 600, color: "#10b981" }}>🌐 게이트웨이 자동 수신 5초마다 갱신</span>
              </div>
              {detected.length === 0 ? (
                <div style={{ padding: 20, textAlign: "center", color: "#94a3b8", fontSize: 12, background: "#fff", borderRadius: 6 }}>
                  <div>아직 감지된 비콘이 없습니다</div>
                  <div style={{ fontSize: 10, marginTop: 6, color: "#475569" }}>
                    💡 웹 Bluetooth는 클릭 페어링이 필요합니다.<br/>
                    Minew G1 게이트웨이를 연동하면 여기에 자동으로 표시됩니다.
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {detected.map(b => {
                    const isReg = reg[b.id];
                    const dist = b.rssi != null ? rssiToDistance(b.rssi) : null;
                    const sigBars = b.rssi == null ? 0 : b.rssi > -60 ? 4 : b.rssi > -75 ? 3 : b.rssi > -85 ? 2 : 1;
                    return (
                      <div key={b.id} style={{ padding: 10, background: "#fff", border: `1px solid ${isReg ? "#86efac" : "#e5e7eb"}`, borderRadius: 8, display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                          {[4,3,2,1].map(level => (
                            <div key={level} style={{ width: 14, height: 3, background: sigBars >= level ? "#10b981" : "#e5e7eb", borderRadius: 1 }}/>
                          ))}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 800, color: "#0f172a" }}>
                            {b.name}
                            {b.fromGateway && <span style={{ marginLeft: 6, padding: "1px 5px", background: "#fef3c7", color: "#92400e", borderRadius: 3, fontSize: 9, fontWeight: 800 }}>🌐 게이트웨이</span>}
                            {b.connected && <span style={{ marginLeft: 6, padding: "1px 5px", background: "#dcfce7", color: "#065f46", borderRadius: 3, fontSize: 9, fontWeight: 800 }}>✓ 연결</span>}
                            {isReg && <span style={{ marginLeft: 6, padding: "1px 5px", background: "#dbeafe", color: "#1e40af", borderRadius: 3, fontSize: 9, fontWeight: 800 }}>📍 {isReg.zone}</span>}
                          </div>
                          <div style={{ fontSize: 10, color: "#64748b", fontFamily: "monospace" }}>
                            {b.id} {b.rssi != null && `· ${b.rssi}dBm · ~${dist?.toFixed(1)}m`}
                          </div>
                        </div>
                        <select value={isReg?.zone || ""} onChange={e => assignZone(b.id, b.name, e.target.value)}
                          style={{ padding: "4px 8px", fontSize: 10, border: "1px solid #e5e7eb", borderRadius: 4 }}>
                          <option value="">구역 미배정</option>
                          {zones.map(z => <option key={z.id || z} value={z.name || z}>{z.icon || ""} {z.name || z}</option>)}
                        </select>
                        {isReg && (
                          <button type="button" onClick={() => unregister(b.id)}
                            style={{ padding: "3px 8px", background: "#fee2e2", color: "#dc2626", border: "none", borderRadius: 4, fontSize: 10, cursor: "pointer", fontWeight: 700 }}>해제</button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* 등록된 비콘 목록 */}
          {tab === "registry" && (
            <div>
              <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8 }}>등록된 비콘은 게이트웨이가 감지할 때 자동으로 해당 구역으로 분류됩니다.</div>
              {Object.keys(reg).length === 0 ? (
                <div style={{ padding: 20, textAlign: "center", color: "#94a3b8", fontSize: 12, background: "#fff", borderRadius: 6 }}>등록된 비콘이 없습니다. "스캔" 탭에서 등록하세요.</div>
              ) : (
                Object.entries(reg).map(([id, info]) => (
                  <div key={id} style={{ padding: 10, marginBottom: 6, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 6, display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                    <span style={{ fontSize: 18 }}>📡</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 800 }}>{info.name} <span style={{ padding: "1px 5px", background: "#dbeafe", color: "#1e40af", borderRadius: 3, fontSize: 9 }}>📍 {info.zone}</span></div>
                      <div style={{ fontSize: 9, color: "#94a3b8", fontFamily: "monospace" }}>{id}</div>
                      <div style={{ fontSize: 9, color: "#94a3b8" }}>{new Date(info.registeredAt).toLocaleString("ko-KR")} · {info.registeredBy}</div>
                    </div>
                    <button type="button" onClick={() => unregister(id)}
                      style={{ padding: "3px 8px", background: "#fee2e2", color: "#dc2626", border: "none", borderRadius: 4, fontSize: 10, cursor: "pointer", fontWeight: 700 }}>🗑️</button>
                  </div>
                ))
              )}
            </div>
          )}

          {/* 게이트웨이 */}
          {tab === "gateway" && (
            <div>
              <div style={{ padding: 12, background: "linear-gradient(135deg,#ede9fe,#fff)", border: "1px solid #c4b5fd", borderRadius: 10, marginBottom: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 900, color: "#5b21b6", marginBottom: 4 }}>🌐 게이트웨이 webhook URL</div>
                <div style={{ fontSize: 11, color: "#475569", marginBottom: 8 }}>Minew G1, 현승코리아 B-Fon 등의 게이트웨이 설정에서 이 URL을 입력하세요.</div>
                <div style={{ display: "flex", gap: 4 }}>
                  <input value={gw.webhookUrl} onChange={e => updateGw({ webhookUrl: e.target.value })}
                    style={{ flex: 1, padding: "8px 10px", border: "1px solid #c4b5fd", borderRadius: 5, fontSize: 11, fontFamily: "monospace" }}/>
                  <button type="button" onClick={() => { navigator.clipboard?.writeText(gw.webhookUrl); alert("복사됨"); }}
                    style={{ padding: "8px 12px", background: "#7c3aed", color: "#fff", border: "none", borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>📋 복사</button>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 700, color: "#64748b" }}>게이트웨이 시리얼</label>
                  <input value={gw.gatewaySerial} onChange={e => updateGw({ gatewaySerial: e.target.value })}
                    placeholder="예: G1-12345"
                    style={{ width: "100%", padding: "6px 10px", border: "1px solid #e5e7eb", borderRadius: 5, fontSize: 11, marginTop: 4 }}/>
                </div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 700, color: "#64748b" }}>게이트웨이 설치 위치</label>
                  <input value={gw.gatewayLocation} onChange={e => updateGw({ gatewayLocation: e.target.value })}
                    placeholder="예: 본관 천장"
                    style={{ width: "100%", padding: "6px 10px", border: "1px solid #e5e7eb", borderRadius: 5, fontSize: 11, marginTop: 4 }}/>
                </div>
              </div>

              <div style={{ padding: 12, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 6 }}>📥 최근 게이트웨이 데이터 수신</div>
                {recentWebhook ? (
                  <div style={{ padding: 8, background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 5, fontSize: 11 }}>
                    <div style={{ fontWeight: 700, color: "#065f46" }}>✅ 수신 시각: {new Date(recentWebhook.receivedAt).toLocaleString("ko-KR")}</div>
                    <pre style={{ fontSize: 10, color: "#475569", marginTop: 4, maxHeight: 200, overflow: "auto" }}>{JSON.stringify(recentWebhook.payload, null, 2)}</pre>
                  </div>
                ) : (
                  <div style={{ padding: 14, textAlign: "center", color: "#94a3b8", fontSize: 11 }}>아직 수신된 데이터 없음 (게이트웨이 설정 후 자동 표시)</div>
                )}
              </div>

              {/* Minew G1 + TagCloud 특화 설정 안내 */}
              <div style={{ padding: 14, background: "linear-gradient(135deg,#eff6ff,#dcfce7)", border: "2px solid #10b981", borderRadius: 10 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
                  <div style={{ fontSize: 13, fontWeight: 900, color: "#065f46" }}>📡 Minew G1 + TagCloud 자동 연동 (5분)</div>
                  <a href="/minew-g1-setup.svg" target="_blank" rel="noreferrer"
                    style={{ padding: "5px 10px", background: "#10b981", color: "#fff", borderRadius: 5, fontSize: 11, fontWeight: 700, textDecoration: "none" }}>
                    📥 인포그래픽 가이드 보기
                  </a>
                </div>
                <ol style={{ paddingLeft: 18, fontSize: 11, lineHeight: 1.8, color: "#0f172a", margin: 0 }}>
                  <li><strong>tagcloud.minew.com 로그인</strong> (admin 권한 필요)</li>
                  <li>좌측 메뉴 → <strong>Devices</strong> → 게이트웨이 클릭</li>
                  <li>상세 페이지 → <strong>Data Forwarding</strong> / <strong>3rd Party</strong> / <strong>Webhook</strong> 메뉴 클릭
                    <br/>(G1 펌웨어에 따라 메뉴명 다름)
                  </li>
                  <li><strong>＋ Add Webhook</strong> 또는 <strong>＋ Add Endpoint</strong> 클릭</li>
                  <li>URL 입력: <code style={{ background: "#fff", padding: "2px 6px", borderRadius: 3, fontFamily: "monospace", fontWeight: 700 }}>{gw.webhookUrl}</code></li>
                  <li>Method: <strong>POST</strong>, Content-Type: <strong>application/json</strong></li>
                  <li>Authorization / API Key: <strong>비워두기</strong> (공개 webhook)</li>
                  <li><strong>Save</strong> → 1분 내 위쪽 "최근 데이터 수신" 영역에 JSON 자동 표시</li>
                </ol>
                <div style={{ marginTop: 10, padding: 8, background: "#fff", borderRadius: 5, fontSize: 10, color: "#065f46" }}>
                  💡 <strong>호환 자동:</strong> Minew G1의 <code>{`{ gw_mac, obj: [{mac, rssi, ...}] }`}</code> 포맷 자동 인식.
                  TagCloud는 그대로 작동, 잠사 패널이 추가로 받음 (이중 모니터링).
                </div>
                <div style={{ marginTop: 6, padding: 8, background: "#fef3c7", borderRadius: 5, fontSize: 10, color: "#92400e" }}>
                  ⚠️ <strong>대안</strong>: TagCloud 메뉴에 webhook 옵션이 없으면 게이트웨이 IP 직접 접속 (http://192.168.x.x → admin/minew123 → Application Settings → HTTP Push)
                </div>
              </div>
            </div>
          )}

          {/* 자동 알림 규칙 */}
          {tab === "alerts" && (
            <BeaconAlertRulesPanel zones={zones} beaconReg={reg} />
          )}

          {/* 실시간 테스트 */}
          {tab === "test" && (
            <div>
              <div style={{ padding: 14, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, marginBottom: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 900, marginBottom: 8 }}>🧪 종합 연동 진단</div>
                <button type="button" onClick={testGateway}
                  style={{ width: "100%", padding: "10px 16px", background: "linear-gradient(135deg,#10b981,#0ea5e9)", color: "#fff", border: "none", borderRadius: 6, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
                  🚀 지금 테스트 실행
                </button>
                {testResult && (
                  <div style={{ marginTop: 10, padding: 10, background: testResult.status === "ok" ? "#dcfce7" : testResult.status === "testing" ? "#fef3c7" : "#fee2e2", border: `1px solid ${testResult.status === "ok" ? "#86efac" : testResult.status === "testing" ? "#fde68a" : "#fca5a5"}`, borderRadius: 6, fontSize: 11 }}>
                    {testResult.status === "testing" && "⏳ 테스트 중..."}
                    {testResult.status === "ok" && <>
                      <div style={{ fontWeight: 800, color: "#065f46" }}>✅ 연동 정상</div>
                      <div>Webhook ping: {testResult.pingOk ? "✓" : "✗"} · 데이터 전송: {testResult.sendOk ? "✓" : "✗"} (HTTP {testResult.sendStatus})</div>
                      <div style={{ fontSize: 10, color: "#475569", marginTop: 2 }}>{new Date(testResult.time).toLocaleString("ko-KR")}</div>
                    </>}
                    {testResult.status === "error" && <>
                      <div style={{ fontWeight: 800, color: "#991b1b" }}>❌ 실패</div>
                      <div>{testResult.error || `HTTP ${testResult.sendStatus}`}</div>
                    </>}
                  </div>
                )}
              </div>

              <div style={{ padding: 14, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 6 }}>📜 최근 활동 ({hist.length})</div>
                <div style={{ maxHeight: 240, overflowY: "auto" }}>
                  {hist.length === 0 ? (
                    <div style={{ padding: 12, textAlign: "center", color: "#94a3b8", fontSize: 11 }}>활동 없음</div>
                  ) : hist.slice(0, 30).map(h => (
                    <div key={h.id} style={{ padding: "4px 6px", borderBottom: "1px solid #f1f5f9", fontSize: 10, color: "#475569" }}>
                      <span style={{ color: "#94a3b8" }}>{new Date(h.at).toLocaleTimeString("ko-KR")}</span>
                      <span style={{ marginLeft: 6, padding: "1px 5px", background: "#f1f5f9", borderRadius: 3, fontWeight: 700 }}>{h.kind}</span>
                      <span style={{ marginLeft: 6 }}>{h.beaconName || ""} {h.error ? `· ${h.error}` : ""}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* 연동 가이드 */}
          {tab === "guide" && (
            <div>
              <div style={{ padding: 14, background: "linear-gradient(135deg,#eff6ff,#fef3c7)", border: "1px solid #fde68a", borderRadius: 10, marginBottom: 10 }}>
                <div style={{ fontSize: 14, fontWeight: 900, color: "#0f172a", marginBottom: 6 }}>📚 비콘 + 게이트웨이 연동 5단계</div>
                <div style={{ fontSize: 11, color: "#475569", marginBottom: 8 }}>아래 이미지로 자세한 인포그래픽도 확인 가능합니다.</div>
                <a href="/beacon-setup.svg" target="_blank" rel="noreferrer"
                  style={{ display: "inline-block", padding: "8px 16px", background: "#0ea5e9", color: "#fff", borderRadius: 6, fontSize: 11, fontWeight: 700, textDecoration: "none" }}>
                  📥 연동 인포그래픽 보기 (SVG)
                </a>
              </div>

              {[
                { n: 1, icon: "🛒", title: "장비 구매", desc: "Minew G1 게이트웨이 (~7만원) + BLE 비콘 4~6개 (개당 7천원~3만원). 박물관 면적이 넓으면 게이트웨이 2~3대." },
                { n: 2, icon: "📍", title: "게이트웨이 설치", desc: "전원 콘센트 근처 천장/벽 (1.5m 이상). LAN 케이블 또는 Wi-Fi 연결. 박물관 중앙에 1대, 각 동별 1대 권장." },
                { n: 3, icon: "🎯", title: "비콘 부착", desc: "구역마다 1~2개 비콘 부착. 양면테이프로 간단 고정. 위치: 천장/벽/전시대 옆 (50cm~2m 높이)." },
                { n: 4, icon: "🌐", title: "게이트웨이 설정", desc: "게이트웨이 관리자 페이지 접속 → webhook URL에 위 게이트웨이 탭의 URL 입력 → 저장." },
                { n: 5, icon: "🧪", title: "테스트", desc: "이 모달 → 실시간 테스트 → '지금 테스트 실행' 클릭 → ✅ 연동 정상 확인. 비콘 근처로 이동하면 게이트웨이가 자동 감지." },
              ].map(s => (
                <div key={s.n} style={{ padding: 12, marginBottom: 8, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, display: "flex", gap: 10, alignItems: "flex-start" }}>
                  <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, borderRadius: "50%", background: "#0ea5e9", color: "#fff", fontWeight: 900, fontSize: 13 }}>{s.n}</div>
                  <div style={{ fontSize: 22 }}>{s.icon}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: "#0f172a" }}>{s.title}</div>
                    <div style={{ fontSize: 11, color: "#475569", lineHeight: 1.5, marginTop: 2 }}>{s.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
