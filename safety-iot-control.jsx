import React, { useEffect, useMemo, useState } from "react";

const CAT_META = {
  camera: { icon: "📷", label: "카메라", group: "보안", color: "#dc2626" },
  doorbell: { icon: "🔔", label: "도어벨", group: "보안", color: "#dc2626" },
  chime: { icon: "🔊", label: "차임", group: "보안", color: "#dc2626" },
  plug: { icon: "🔌", label: "스마트 플러그", group: "전원", color: "#f59e0b" },
  power_strip: { icon: "🔌", label: "멀티탭", group: "전원", color: "#f59e0b" },
  energy_meter: { icon: "⚡", label: "전력 측정", group: "전원", color: "#f59e0b" },
  light: { icon: "💡", label: "조명", group: "조명", color: "#fbbf24" },
  switch: { icon: "🎛️", label: "스위치", group: "조명", color: "#fbbf24" },
  motion_sensor: { icon: "🚶", label: "모션 센서", group: "센서", color: "#3b82f6" },
  contact_sensor: { icon: "🚪", label: "문열림 센서", group: "센서", color: "#3b82f6" },
  temperature_sensor: { icon: "🌡️", label: "온도 센서", group: "센서", color: "#06b6d4" },
  humidity_sensor: { icon: "💧", label: "습도 센서", group: "센서", color: "#06b6d4" },
  water_leak_sensor: { icon: "🌊", label: "누수 센서", group: "센서", color: "#0ea5e9" },
  button: { icon: "🔘", label: "버튼", group: "센서", color: "#8b5cf6" },
  hub: { icon: "📡", label: "허브", group: "기타", color: "#7c3aed" },
  ir_remote: { icon: "📡", label: "IR 리모컨", group: "기타", color: "#7c3aed" },
  robot_vacuum: { icon: "🤖", label: "Roborock 로봇", group: "로봇", color: "#10b981" },
};

const GROUP_ORDER = ["보안", "전원", "조명", "센서", "로봇", "기타"];
const API = (path, opts = {}) => (window.authFetch || fetch)(path, opts);

function useLocalStorageState(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }, [key, value]);
  return [value, setValue];
}

function normalizeDevice(d) {
  const state = d.currentState || d.current_state || {};
  return {
    ...d,
    zoneId: d.zoneId || d.zone_id || d.zone || "",
    rtspUrl: d.rtspUrl || d.rtsp_url || "",
    onvifUrl: d.onvifUrl || d.onvif_url || "",
    haEntityId: d.haEntityId || d.ha_entity_id || "",
    isOnline: Boolean(d.isOnline ?? d.is_online ?? state.online ?? d.online),
    currentState: state,
  };
}

function devicePayload(form) {
  return {
    name: form.name?.trim(),
    category: form.category,
    zoneId: form.zoneId || null,
    model: form.model || null,
    ip: form.ip || null,
    port: form.port ? Number(form.port) : null,
    rtspUrl: form.rtspUrl || null,
    onvifUrl: form.onvifUrl || null,
    username: form.username || null,
    password: form.password || null,
    haEntityId: form.haEntityId || null,
    notes: form.notes || null,
  };
}

export function SafetyIotControlPage({ facilities = [] }) {
  const [tab, setTab] = useState("devices");
  const [devices, setDevices] = useLocalStorageState("jamsa_iot_local_devices", []);
  const [settings, setSettings] = useLocalStorageState("jamsa_iot_bridge_settings", {
    tapoBridgeUrl: "",
    roborockBridgeUrl: "",
    homeAssistantUrl: "",
    homeAssistantToken: "",
    autoSync: false,
  });
  const [filter, setFilter] = useState({ category: "all", zone: "all", state: "all" });
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState("연동 대기");
  const [modal, setModal] = useState(null);

  const loadDevices = async () => {
    setLoading(true);
    try {
      const r = await API("/api/tapo-devices", { cache: "no-store" });
      const data = await r.json();
      if (data?.devices?.length) {
        setDevices(data.devices.map(normalizeDevice));
        setStatus(`클라우드 동기화 완료 · ${data.devices.length}대`);
      } else if (data?.fallback) {
        setStatus("Supabase 미설정 · 로컬 등록 기기 표시");
      } else {
        setStatus("등록된 기기 없음 · 연동 설정 또는 수동 등록 필요");
      }
    } catch (e) {
      setStatus(`API 연결 실패 · ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadDevices(); }, []);
  useEffect(() => {
    if (!settings.autoSync) return undefined;
    const id = setInterval(() => syncBridge(false), 60000);
    return () => clearInterval(id);
  }, [settings.autoSync, settings.tapoBridgeUrl, settings.roborockBridgeUrl, settings.homeAssistantUrl]);

  const saveDevice = async (form) => {
    const payload = devicePayload(form);
    if (!payload.name || !payload.category) {
      alert("기기명과 종류는 필수입니다.");
      return;
    }
    try {
      const isEdit = Boolean(form.id);
      const r = await API(isEdit ? `/api/tapo-devices?id=${encodeURIComponent(form.id)}` : "/api/tapo-devices", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (r.ok && data?.device) {
        await loadDevices();
      } else {
        upsertLocal({ ...form, ...payload, id: form.id || `local-${Date.now()}`, isOnline: false, source: "local" });
        setStatus("클라우드 저장 불가 · 로컬에 임시 저장됨");
      }
    } catch {
      upsertLocal({ ...form, ...payload, id: form.id || `local-${Date.now()}`, isOnline: false, source: "local" });
      setStatus("API 연결 실패 · 로컬에 임시 저장됨");
    }
    setModal(null);
  };

  const upsertLocal = (dev) => {
    setDevices(list => {
      const next = normalizeDevice(dev);
      return list.some(d => d.id === next.id) ? list.map(d => d.id === next.id ? next : d) : [next, ...list];
    });
  };

  const removeDevice = async (dev) => {
    if (!confirm(`${dev.name} 기기를 삭제할까요?`)) return;
    try {
      if (!String(dev.id).startsWith("local-")) {
        await API(`/api/tapo-devices?id=${encodeURIComponent(dev.id)}`, { method: "DELETE" });
      }
    } catch {}
    setDevices(list => list.filter(d => d.id !== dev.id));
  };

  const runCommand = async (dev, action, params = {}) => {
    try {
      const endpoint = dev.category === "robot_vacuum" ? "/api/roborock" : "/api/tapo-devices";
      const q = new URLSearchParams({ id: dev.id, action, ...params }).toString();
      const r = await API(`${endpoint}?${q}`, { method: "POST" });
      const data = await r.json();
      if (!r.ok || data?.error) throw new Error(data?.message || data?.error || `HTTP ${r.status}`);
      setStatus(`${dev.name} 명령 전송 완료 · ${action}`);
      loadDevices();
    } catch (e) {
      alert(`명령 전송 실패: ${e.message}`);
    }
  };

  const syncBridge = async (showAlert = true) => {
    const urls = [
      settings.tapoBridgeUrl && { kind: "Tapo", url: settings.tapoBridgeUrl },
      settings.roborockBridgeUrl && { kind: "Roborock", url: settings.roborockBridgeUrl },
      settings.homeAssistantUrl && { kind: "Home Assistant", url: settings.homeAssistantUrl, token: settings.homeAssistantToken },
    ].filter(Boolean);
    if (!urls.length) {
      setModal("settings");
      if (showAlert) alert("먼저 연동 설정에서 브리지 주소를 입력하세요.");
      return;
    }
    setSyncing(true);
    const collected = [];
    const errors = [];
    for (const item of urls) {
      try {
        const headers = item.token ? { Authorization: `Bearer ${item.token}` } : {};
        const base = item.url.replace(/\/+$/, "");
        const candidates = item.kind === "Home Assistant"
          ? [`${base}/api/states`]
          : [`${base}/api/devices`, `${base}/devices`];
        let found = [];
        for (const url of candidates) {
          try {
            const r = await fetch(url, { headers, cache: "no-store" });
            if (!r.ok) continue;
            const data = await r.json();
            const raw = Array.isArray(data) ? data : (data.devices || data.items || []);
            found = raw.map(x => bridgeToDevice(x, item.kind));
            break;
          } catch {}
        }
        collected.push(...found);
      } catch (e) {
        errors.push(`${item.kind}: ${e.message}`);
      }
    }
    if (collected.length) {
      setDevices(prev => mergeDevices(prev, collected));
      setStatus(`브리지 동기화 완료 · ${collected.length}대 수신`);
    } else {
      setStatus(errors.length ? `브리지 응답 없음 · ${errors.join(", ")}` : "브리지에서 가져온 기기가 없습니다");
    }
    setSyncing(false);
  };

  const filtered = useMemo(() => devices.map(normalizeDevice).filter(d => {
    if (filter.category !== "all" && d.category !== filter.category) return false;
    if (filter.zone !== "all" && d.zoneId !== filter.zone) return false;
    if (filter.state === "online" && !d.isOnline) return false;
    if (filter.state === "offline" && d.isOnline) return false;
    return true;
  }), [devices, filter]);

  const robots = filtered.filter(d => d.category === "robot_vacuum");
  const stats = {
    total: devices.length,
    online: devices.filter(d => normalizeDevice(d).isOnline).length,
    active: devices.filter(d => {
      const s = normalizeDevice(d).currentState;
      return s.power === "ON" || s.power_on || s.state === "cleaning";
    }).length,
    alert: devices.filter(d => normalizeDevice(d).currentState?.alert || normalizeDevice(d).currentState?.error_code).length,
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-cyan-200 bg-gradient-to-r from-cyan-50 to-blue-50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-black text-cyan-950">🔌 IoT 안전제어</h2>
            <div className="mt-1 text-xs text-cyan-700">Tapo, Roborock, Home Assistant 브리지를 연결해 기기 상태와 안전 자동화를 한 화면에서 관리합니다.</div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setModal("settings")} className="rounded-lg border border-cyan-200 bg-white px-3 py-2 text-xs font-black text-cyan-900">연동 설정</button>
            <button onClick={() => setModal("device")} className="rounded-lg bg-cyan-600 px-3 py-2 text-xs font-black text-white">기기 등록</button>
            <button onClick={() => syncBridge(true)} disabled={syncing} className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-black text-white disabled:opacity-50">{syncing ? "동기화 중" : "브리지 동기화"}</button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2">
        <KpiCard label="전체" value={stats.total} />
        <KpiCard label="온라인" value={stats.online} tone="green" />
        <KpiCard label="작동 중" value={stats.active} tone="blue" />
        <KpiCard label="알림" value={stats.alert} tone={stats.alert ? "red" : "gray"} />
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select value={filter.category} onChange={e => setFilter(f => ({ ...f, category: e.target.value }))} className="rounded border px-3 py-2">
          <option value="all">전체 종류</option>
          {Object.entries(CAT_META).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
        </select>
        <select value={filter.zone} onChange={e => setFilter(f => ({ ...f, zone: e.target.value }))} className="rounded border px-3 py-2">
          <option value="all">전체 구역</option>
          {facilities.map(f => <option key={f.id || f.name} value={f.id || f.name}>{f.name}</option>)}
        </select>
        <select value={filter.state} onChange={e => setFilter(f => ({ ...f, state: e.target.value }))} className="rounded border px-3 py-2">
          <option value="all">전체 상태</option>
          <option value="online">온라인</option>
          <option value="offline">오프라인</option>
        </select>
        <button onClick={loadDevices} disabled={loading} className="ml-auto rounded bg-gray-100 px-3 py-2 font-black">{loading ? "조회 중" : "새로고침"}</button>
      </div>

      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
        상태: <b className="text-slate-900">{status}</b>
        {settings.autoSync && <span className="ml-2 rounded bg-emerald-100 px-2 py-0.5 font-bold text-emerald-800">자동 동기화 ON</span>}
      </div>

      <div className="flex flex-wrap gap-1 border-b-2 border-gray-200">
        {[["devices", "📡 Tapo 기기"], ["robots", "🤖 Roborock 로봇"], ["automations", "⚙️ 자동화 프로그램"], ["emergency", "🚨 긴급 안전제어"]].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`rounded-t-lg px-4 py-2 text-xs font-black ${tab === k ? "bg-cyan-600 text-white" : "text-gray-600 hover:bg-gray-100"}`}>{l}</button>
        ))}
      </div>

      {tab === "devices" && <DeviceGrid devices={filtered} facilities={facilities} onEdit={d => setModal({ type: "device", device: d })} onDelete={removeDevice} onCommand={runCommand} />}
      {tab === "robots" && <RobotsTab robots={robots} onCommand={runCommand} />}
      {tab === "automations" && <AutomationsTab />}
      {tab === "emergency" && <EmergencyTab devices={devices} onCommand={runCommand} />}

      {modal === "settings" && <IntegrationModal settings={settings} onSave={v => { setSettings(v); setModal(null); }} onClose={() => setModal(null)} onTest={() => syncBridge(true)} />}
      {(modal === "device" || modal?.type === "device") && <DeviceModal device={modal?.device} facilities={facilities} onSave={saveDevice} onClose={() => setModal(null)} />}
    </div>
  );
}

function bridgeToDevice(x, kind) {
  const entity = x.entity_id || x.id || x.device_id || x.name;
  const attr = x.attributes || {};
  const domain = String(entity || "").split(".")[0];
  let category = x.category || "hub";
  if (kind === "Roborock" || domain === "vacuum") category = "robot_vacuum";
  else if (domain === "camera") category = "camera";
  else if (domain === "light") category = "light";
  else if (domain === "switch") category = "switch";
  else if (domain === "sensor") category = attr.device_class === "humidity" ? "humidity_sensor" : attr.device_class === "temperature" ? "temperature_sensor" : "motion_sensor";
  return normalizeDevice({
    id: `bridge-${kind}-${entity}`,
    name: x.name || attr.friendly_name || entity,
    category,
    model: x.model || attr.model || kind,
    zoneId: x.zoneId || x.zone_id || x.area_id || "",
    ip: x.ip || attr.ip || "",
    haEntityId: entity,
    isOnline: !["unavailable", "unknown", "offline"].includes(String(x.state || "").toLowerCase()),
    currentState: { ...(x.currentState || x.current_state || {}), state: x.state, online: true },
    source: kind,
  });
}

function mergeDevices(prev, incoming) {
  const map = new Map(prev.map(d => [d.id, normalizeDevice(d)]));
  incoming.forEach(d => map.set(d.id, normalizeDevice({ ...map.get(d.id), ...d })));
  return Array.from(map.values());
}

function DeviceGrid({ devices, facilities, onEdit, onDelete, onCommand }) {
  const grouped = useMemo(() => {
    const g = {};
    devices.forEach(d => {
      const meta = CAT_META[d.category] || CAT_META.hub;
      g[meta.group] = [...(g[meta.group] || []), d];
    });
    return g;
  }, [devices]);
  if (!devices.length) return <EmptyState title="조건에 맞는 기기가 없습니다" desc="연동 설정에서 브리지 주소를 넣거나, 기기 등록 버튼으로 직접 추가하세요." />;
  return <div className="space-y-4">
    {GROUP_ORDER.filter(g => grouped[g]?.length).map(group => (
      <section key={group}>
        <div className="mb-2 text-xs font-black text-gray-700">{group} · {grouped[group].length}대</div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {grouped[group].map(d => <DeviceCard key={d.id} device={d} facilities={facilities} onEdit={onEdit} onDelete={onDelete} onCommand={onCommand} />)}
        </div>
      </section>
    ))}
  </div>;
}

function DeviceCard({ device, facilities, onEdit, onDelete, onCommand }) {
  const meta = CAT_META[device.category] || CAT_META.hub;
  const zone = facilities.find(f => String(f.id) === String(device.zoneId))?.name || device.zoneId || "구역 미지정";
  const powerOn = device.currentState?.power === "ON" || device.currentState?.power_on;
  const canPower = ["plug", "power_strip", "light", "switch"].includes(device.category);
  return <div className="rounded-xl border-2 border-gray-200 bg-white p-3">
    <div className="flex items-start gap-3">
      <div className="text-3xl">{meta.icon}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="truncate text-sm font-black">{device.name || meta.label}</div>
          <span className={`h-2 w-2 rounded-full ${device.isOnline ? "bg-emerald-500" : "bg-gray-400"}`} />
        </div>
        <div className="truncate text-[10px] text-gray-500">{meta.label} · {device.model || "-"} · {zone}</div>
        <div className="mt-2 flex flex-wrap gap-1 text-[10px]">
          <Badge tone={device.isOnline ? "green" : "gray"}>{device.isOnline ? "온라인" : "오프라인"}</Badge>
          {device.source && <Badge>{device.source}</Badge>}
          {device.ip && <Badge>{device.ip}</Badge>}
          {device.haEntityId && <Badge>{device.haEntityId}</Badge>}
          {powerOn != null && <Badge tone={powerOn ? "green" : "gray"}>{powerOn ? "ON" : "OFF"}</Badge>}
        </div>
      </div>
    </div>
    <div className="mt-3 flex flex-wrap gap-1">
      {canPower && <button onClick={() => onCommand(device, "power_toggle")} className={`rounded px-3 py-1 text-[10px] font-black text-white ${powerOn ? "bg-red-600" : "bg-emerald-600"}`}>{powerOn ? "OFF" : "ON"}</button>}
      {device.category === "camera" && <button onClick={() => onCommand(device, "snapshot")} className="rounded bg-blue-600 px-3 py-1 text-[10px] font-black text-white">스냅샷</button>}
      <button onClick={() => onEdit(device)} className="rounded bg-gray-100 px-3 py-1 text-[10px] font-black">수정</button>
      <button onClick={() => onDelete(device)} className="rounded bg-red-50 px-3 py-1 text-[10px] font-black text-red-700">삭제</button>
    </div>
  </div>;
}

function RobotsTab({ robots, onCommand }) {
  if (!robots.length) return <EmptyState title="등록된 Roborock 로봇이 없습니다" desc="기기 등록에서 종류를 Roborock 로봇으로 선택하거나 브리지 동기화를 실행하세요." />;
  return <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
    {robots.map(r => {
      const s = r.currentState || {};
      return <div key={r.id} className="rounded-xl border-2 border-emerald-200 bg-white p-4">
        <div className="mb-3 flex items-center gap-3">
          <div className="text-4xl">🤖</div>
          <div className="flex-1"><div className="font-black">{r.name}</div><div className="text-xs text-gray-500">{r.model || "Roborock"} · {s.state || "대기"}</div></div>
          <Badge tone={r.isOnline ? "green" : "gray"}>{r.isOnline ? "온라인" : "오프라인"}</Badge>
        </div>
        <div className="mb-3 grid grid-cols-3 gap-2 text-center text-xs">
          <MiniStat label="배터리" value={`${s.battery_level ?? s.battery ?? 0}%`} />
          <MiniStat label="흡입" value={s.fan_speed || "balanced"} />
          <MiniStat label="상태" value={s.state || "idle"} />
        </div>
        <div className="grid grid-cols-4 gap-2">
          <RobotButton onClick={() => onCommand(r, "start")}>시작</RobotButton>
          <RobotButton onClick={() => onCommand(r, "pause")}>일시정지</RobotButton>
          <RobotButton onClick={() => onCommand(r, "return_home")}>복귀</RobotButton>
          <RobotButton onClick={() => onCommand(r, "find_robot")}>찾기</RobotButton>
        </div>
      </div>;
    })}
  </div>;
}

function AutomationsTab() {
  const [automations, setAutomations] = useState([]);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      const r = await API("/api/tapo-automations", { cache: "no-store" });
      const data = await r.json();
      setAutomations(data.automations?.length ? data.automations : data.templates || DEFAULT_AUTOMATIONS);
    } catch {
      setAutomations(DEFAULT_AUTOMATIONS);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  const toggle = async (a) => {
    const enabled = !a.enabled;
    setAutomations(list => list.map(x => x.id === a.id ? { ...x, enabled } : x));
    try {
      await API(`/api/tapo-automations?id=${encodeURIComponent(a.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
    } catch {}
  };
  if (loading) return <EmptyState title="자동화 불러오는 중" desc="등록된 안전 자동화와 템플릿을 확인하고 있습니다." />;
  return <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
    {automations.map(a => <div key={a.id} className={`rounded-xl border-2 p-3 ${a.enabled ? "border-cyan-300 bg-cyan-50" : "border-gray-200 bg-white"}`}>
      <div className="flex justify-between gap-2">
        <div><div className="text-sm font-black">{a.name}</div><div className="mt-1 text-[10px] text-gray-600">{a.description}</div></div>
        <Badge tone={a.severity === "critical" || a.severity === "danger" ? "red" : "blue"}>{a.severity || "normal"}</Badge>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs"><span className={a.enabled ? "font-black text-emerald-700" : "font-black text-gray-400"}>{a.enabled ? "활성" : "비활성"}</span><Toggle checked={!!a.enabled} onChange={() => toggle(a)} /></div>
    </div>)}
  </div>;
}

const DEFAULT_AUTOMATIONS = [
  { id: "opening_mode", name: "운영 시작 모드", description: "개장 시간에 조명과 필수 전원을 켭니다.", severity: "normal", enabled: false },
  { id: "closing_mode", name: "마감 모드", description: "조명 OFF, 카메라 야간 모드, 보안 감시를 활성화합니다.", severity: "normal", enabled: false },
  { id: "night_intrusion", name: "야간 침입 감지", description: "운영시간 외 모션 감지 시 카메라 녹화와 알림을 실행합니다.", severity: "danger", enabled: false },
  { id: "water_leak", name: "누수 대응", description: "누수 센서 감지 시 전원 차단과 담당자 알림을 실행합니다.", severity: "critical", enabled: false },
];

function EmergencyTab({ devices, onCommand }) {
  const controllable = devices.map(normalizeDevice).filter(d => ["plug", "power_strip", "light", "switch", "camera", "robot_vacuum"].includes(d.category));
  const runAll = async (label, predicate, action) => {
    if (!confirm(`${label}을 실행할까요? 대상 ${controllable.filter(predicate).length}대`)) return;
    for (const d of controllable.filter(predicate)) await onCommand(d, action);
  };
  return <div className="space-y-4">
    <div className="rounded-xl border-2 border-red-300 bg-red-50 p-4">
      <div className="text-sm font-black text-red-900">긴급 원클릭 안전제어</div>
      <div className="mt-1 text-xs text-red-700">실제 기기에 명령이 전송될 수 있으므로 현장 확인 후 사용하세요.</div>
    </div>
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <EmergencyButton icon="🔌" title="전체 전원 차단" desc="플러그/멀티탭/스위치 OFF" onClick={() => runAll("전체 전원 차단", d => ["plug", "power_strip", "switch"].includes(d.category), "power_toggle")} />
      <EmergencyButton icon="💡" title="비상 조명 ON" desc="조명 전체 켜기" onClick={() => runAll("비상 조명 ON", d => d.category === "light", "power_toggle")} />
      <EmergencyButton icon="📷" title="카메라 스냅샷" desc="카메라 현재 화면 저장 요청" onClick={() => runAll("카메라 스냅샷", d => d.category === "camera", "snapshot")} />
    </div>
  </div>;
}

function IntegrationModal({ settings, onSave, onClose, onTest }) {
  const [form, setForm] = useState(settings);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  return <Modal title="IoT 연동 설정" onClose={onClose}>
    <div className="grid gap-3 text-xs">
      <Field label="Tapo 브리지 주소" value={form.tapoBridgeUrl} onChange={v => set("tapoBridgeUrl", v)} placeholder="예: http://192.168.0.10:5577" />
      <Field label="Roborock 브리지 주소" value={form.roborockBridgeUrl} onChange={v => set("roborockBridgeUrl", v)} placeholder="예: http://192.168.0.10:5578" />
      <Field label="Home Assistant 주소" value={form.homeAssistantUrl} onChange={v => set("homeAssistantUrl", v)} placeholder="예: http://homeassistant.local:8123" />
      <Field label="Home Assistant Long-Lived Token" value={form.homeAssistantToken} onChange={v => set("homeAssistantToken", v)} placeholder="선택 사항" type="password" />
      <label className="flex items-center gap-2 rounded bg-slate-50 p-3 font-bold"><input type="checkbox" checked={!!form.autoSync} onChange={e => set("autoSync", e.target.checked)} /> 1분마다 자동 동기화</label>
      <div className="rounded border border-blue-200 bg-blue-50 p-3 text-[11px] text-blue-900">브리지는 박물관 PC 또는 같은 네트워크 장비에서 기기 목록을 JSON으로 내보내는 중계 프로그램입니다. 저장 후 브리지 동기화를 누르면 기기 목록이 이 화면에 연결됩니다.</div>
      <div className="flex justify-end gap-2"><button onClick={onClose} className="rounded bg-gray-100 px-4 py-2 font-black">취소</button><button onClick={onTest} className="rounded border px-4 py-2 font-black">연결 테스트</button><button onClick={() => onSave(form)} className="rounded bg-cyan-600 px-4 py-2 font-black text-white">저장</button></div>
    </div>
  </Modal>;
}

function DeviceModal({ device, facilities, onSave, onClose }) {
  const [form, setForm] = useState(normalizeDevice(device || { category: "plug", name: "", zoneId: "" }));
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  return <Modal title={device ? "기기 수정" : "기기 등록"} onClose={onClose}>
    <div className="grid grid-cols-2 gap-3 text-xs">
      <Field label="기기명" value={form.name || ""} onChange={v => set("name", v)} placeholder="예: 수장고 B-2 제습기 플러그" required />
      <label className="grid gap-1 font-bold">종류<select value={form.category} onChange={e => set("category", e.target.value)} className="rounded border px-3 py-2 font-normal">{Object.entries(CAT_META).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}</select></label>
      <label className="grid gap-1 font-bold">구역<select value={form.zoneId || ""} onChange={e => set("zoneId", e.target.value)} className="rounded border px-3 py-2 font-normal"><option value="">구역 미지정</option>{facilities.map(f => <option key={f.id || f.name} value={f.id || f.name}>{f.name}</option>)}</select></label>
      <Field label="모델" value={form.model || ""} onChange={v => set("model", v)} placeholder="예: Tapo P110" />
      <Field label="IP" value={form.ip || ""} onChange={v => set("ip", v)} placeholder="예: 192.168.0.50" />
      <Field label="Port" value={form.port || ""} onChange={v => set("port", v)} placeholder="예: 554" />
      <Field label="RTSP URL" value={form.rtspUrl || ""} onChange={v => set("rtspUrl", v)} placeholder="카메라 선택 시" />
      <Field label="HA Entity ID" value={form.haEntityId || ""} onChange={v => set("haEntityId", v)} placeholder="switch.storage_b2" />
      <Field label="계정" value={form.username || ""} onChange={v => set("username", v)} placeholder="선택 사항" />
      <Field label="비밀번호" value={form.password || ""} onChange={v => set("password", v)} placeholder="선택 사항" type="password" />
      <div className="col-span-2"><Field label="메모" value={form.notes || ""} onChange={v => set("notes", v)} placeholder="설치 위치, 담당자, 주의사항" /></div>
      <div className="col-span-2 flex justify-end gap-2"><button onClick={onClose} className="rounded bg-gray-100 px-4 py-2 font-black">취소</button><button onClick={() => onSave(form)} className="rounded bg-cyan-600 px-4 py-2 font-black text-white">저장</button></div>
    </div>
  </Modal>;
}

function Modal({ title, children, onClose }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
    <div className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-xl bg-white p-5 shadow-2xl">
      <div className="mb-4 flex items-center justify-between"><div className="text-lg font-black">{title}</div><button onClick={onClose} className="rounded bg-gray-100 px-3 py-1 font-black">×</button></div>
      {children}
    </div>
  </div>;
}

function Field({ label, value, onChange, placeholder, type = "text", required = false }) {
  return <label className="grid gap-1 font-bold">{label}{required && <span className="sr-only">필수</span>}<input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} className="rounded border px-3 py-2 font-normal" /></label>;
}

function KpiCard({ label, value, tone = "gray" }) {
  const cls = { gray: "border-gray-200 bg-gray-50 text-gray-800", green: "border-emerald-200 bg-emerald-50 text-emerald-900", blue: "border-blue-200 bg-blue-50 text-blue-900", red: "border-red-200 bg-red-50 text-red-900" }[tone];
  return <div className={`rounded-lg border p-3 text-center ${cls}`}><div className="text-[10px] font-bold opacity-70">{label}</div><div className="text-xl font-black">{value}</div></div>;
}

function MiniStat({ label, value }) {
  return <div className="rounded bg-gray-50 p-2"><div className="text-[9px] text-gray-500">{label}</div><div className="font-black">{value}</div></div>;
}

function Badge({ children, tone = "gray" }) {
  const cls = { gray: "bg-gray-100 text-gray-700", green: "bg-emerald-100 text-emerald-800", blue: "bg-blue-100 text-blue-800", red: "bg-red-100 text-red-800" }[tone];
  return <span className={`rounded px-2 py-0.5 text-[10px] font-black ${cls}`}>{children}</span>;
}

function Toggle({ checked, onChange }) {
  return <button onClick={() => onChange(!checked)} className={`relative h-5 w-10 rounded-full ${checked ? "bg-emerald-600" : "bg-gray-300"}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? "left-5" : "left-0.5"}`} /></button>;
}

function RobotButton({ children, onClick }) {
  return <button onClick={onClick} className="rounded bg-emerald-600 px-3 py-2 text-xs font-black text-white">{children}</button>;
}

function EmergencyButton({ icon, title, desc, onClick }) {
  return <button onClick={onClick} className="rounded-xl bg-red-600 p-4 text-left text-white hover:bg-red-700"><div className="mb-2 text-3xl">{icon}</div><div className="text-sm font-black">{title}</div><div className="mt-1 text-[10px] opacity-90">{desc}</div></button>;
}

function EmptyState({ title, desc }) {
  return <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center"><div className="text-sm font-black text-gray-700">{title}</div><div className="mt-2 text-xs text-gray-500">{desc}</div></div>;
}
