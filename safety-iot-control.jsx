// ═══════════════════════════════════════════════════════════════════════
// 🔌 IoT 안전제어 (Tapo + Roborock + 자동화 프로그램)
// ─────────────────────────────────────────────────────────────────────
// 안전관리 모듈에 IoT 기기 통합 패널 제공:
//   1. 📹 Tapo 기기 (카메라/플러그/조명/센서) - 상태 + ON/OFF + 그룹 제어
//   2. 🤖 Roborock 로봇청소기 - start/dock/find/스케줄
//   3. ⚙️ 자동화 프로그램 (16개 템플릿 + 사용자 정의)
//   4. 🚨 긴급 안전제어 (전체 전원 차단, 야간 순찰, 화재 대응)
//
// 백엔드:
//   GET  /api/tapo-devices
//   POST /api/tapo-devices/:id/command
//   GET  /api/tapo-automations
//   PATCH/api/tapo-automations/:id
//   GET  /api/roborock?id=:id
//   POST /api/roborock?id=:id&action=start|return_home|find_robot
// ═══════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useMemo, useRef } from "react";

// 카테고리 메타 (api/tapo-devices.js와 동일)
const CAT_META = {
  camera:           { icon:"📹", color:"#dc2626", label:"카메라", group:"보안" },
  doorbell:         { icon:"🔔", color:"#dc2626", label:"도어벨",  group:"보안" },
  chime:            { icon:"🎵", color:"#dc2626", label:"차임",    group:"보안" },
  plug:             { icon:"🔌", color:"#f59e0b", label:"콘센트",  group:"전원" },
  power_strip:      { icon:"🔌", color:"#f59e0b", label:"멀티탭",  group:"전원" },
  energy_meter:     { icon:"⚡", color:"#f59e0b", label:"전력측정", group:"전원" },
  light:            { icon:"💡", color:"#fbbf24", label:"조명",    group:"조명" },
  switch:           { icon:"🎚️", color:"#fbbf24", label:"스위치",  group:"조명" },
  motion_sensor:    { icon:"🚶", color:"#3b82f6", label:"모션센서", group:"센서" },
  contact_sensor:   { icon:"🚪", color:"#3b82f6", label:"개폐센서", group:"센서" },
  temperature_sensor:{ icon:"🌡️", color:"#06b6d4", label:"온도",   group:"센서" },
  humidity_sensor:  { icon:"💧", color:"#06b6d4", label:"습도",    group:"센서" },
  water_leak_sensor:{ icon:"💦", color:"#0ea5e9", label:"누수",    group:"센서" },
  button:           { icon:"🔘", color:"#8b5cf6", label:"버튼",    group:"센서" },
  hub:              { icon:"📡", color:"#7c3aed", label:"허브",    group:"기타" },
  ir_remote:        { icon:"📡", color:"#7c3aed", label:"IR 리모트", group:"기타" },
  robot_vacuum:     { icon:"🤖", color:"#10b981", label:"로봇청소기", group:"로봇" },
};

const GROUP_ORDER = ["보안", "전원", "조명", "센서", "로봇", "기타"];

const af = (path, opts = {}) => (window.authFetch || fetch)(path, opts);

// ─── 메인 페이지 ──────────────────────────────────────────────────
export function SafetyIotControlPage({ facilities = [], curUser }) {
  const [tab, setTab] = useState("devices"); // devices | robots | automations | emergency

  return (
    <div className="space-y-4">
      <div className="bg-gradient-to-r from-cyan-50 to-blue-50 border border-cyan-200 rounded-xl p-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-base font-black text-cyan-900">🔌 IoT 안전제어</h2>
            <div className="text-xs text-cyan-700 mt-1">
              Tapo 기기 · Roborock 로봇 · 자동화 프로그램 · 긴급 안전제어를 한 곳에서 관리합니다.
            </div>
          </div>
        </div>
      </div>

      <div className="flex gap-1 border-b-2 border-gray-200 flex-wrap">
        {[
          ["devices","📹 Tapo 기기"],
          ["robots","🤖 Roborock 로봇"],
          ["automations","⚙️ 자동화 프로그램"],
          ["emergency","🚨 긴급 안전제어"],
        ].map(([k,l]) => (
          <button key={k} onClick={()=>setTab(k)}
            className={`px-4 py-2 text-xs font-bold rounded-t-lg ${tab===k?"bg-cyan-600 text-white":"text-gray-600 hover:bg-gray-100"}`}>{l}</button>
        ))}
      </div>

      {tab === "devices" && <DevicesTab facilities={facilities}/>}
      {tab === "robots" && <RobotsTab/>}
      {tab === "automations" && <AutomationsTab/>}
      {tab === "emergency" && <EmergencyTab facilities={facilities}/>}
    </div>
  );
}

// ─── Tapo 기기 탭 ─────────────────────────────────────────────────
function DevicesTab({ facilities }) {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState({ category: "all", zone: "all", online: "all" });
  const [selected, setSelected] = useState(null);

  const fetchDevices = async () => {
    setLoading(true);
    try {
      const r = await af("/api/tapo-devices");
      const d = await r.json();
      if (d.fallback) { setDevices([]); setError("Tapo 백엔드 미설정 (Supabase 필요)"); }
      else { setDevices(d.devices || []); setError(null); }
    } catch (e) {
      setError(e.message);
    } finally { setLoading(false); }
  };
  useEffect(() => {
    fetchDevices();
    const id = setInterval(fetchDevices, 30000); // 30초 폴링
    return () => clearInterval(id);
  }, []);

  const filtered = useMemo(() => devices.filter(d => {
    if (filter.category !== "all" && d.category !== filter.category) return false;
    if (filter.zone !== "all" && d.zone !== filter.zone) return false;
    if (filter.online === "online" && !d.is_online) return false;
    if (filter.online === "offline" && d.is_online) return false;
    return true;
  }), [devices, filter]);

  const byGroup = useMemo(() => {
    const g = {};
    for (const d of filtered) {
      const cat = CAT_META[d.category] || CAT_META.hub;
      const grp = cat.group;
      if (!g[grp]) g[grp] = [];
      g[grp].push(d);
    }
    return g;
  }, [filtered]);

  const sendCommand = async (deviceId, command, params = {}) => {
    try {
      const r = await af(`/api/tapo-devices?id=${deviceId}&action=command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, ...params }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      fetchDevices();
    } catch (e) {
      alert(`❌ 명령 실패: ${e.message}`);
    }
  };

  const stats = useMemo(() => ({
    total: devices.length,
    online: devices.filter(d => d.is_online).length,
    on: devices.filter(d => d.current_state?.power_on).length,
    alert: devices.filter(d => d.current_state?.alert).length,
  }), [devices]);

  if (loading && devices.length === 0) {
    return <div className="text-center py-12 text-gray-500">⏳ Tapo 기기 로딩 중...</div>;
  }

  if (error && devices.length === 0) {
    return (
      <div className="text-center py-8">
        <div className="text-4xl mb-3">📹</div>
        <div className="text-sm font-bold text-gray-700 mb-2">Tapo 기기를 불러올 수 없습니다</div>
        <div className="text-xs text-gray-500 mb-3">{error}</div>
        <div className="bg-blue-50 border border-blue-200 rounded p-3 text-[11px] text-blue-900 max-w-xl mx-auto text-left">
          <strong>💡 설정 안내:</strong><br/>
          1. Vercel 환경변수에 <code>SUPABASE_URL</code>, <code>SUPABASE_SERVICE_ROLE_KEY</code> 등록<br/>
          2. <code>tapo_devices</code> 테이블 생성 (또는 Supabase 마이그레이션 실행)<br/>
          3. Tapo 브릿지 서버를 박물관 PC에 설치 → 기기 등록
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* KPI */}
      <div className="grid grid-cols-4 gap-2">
        <KpiCard label="전체" value={stats.total} color="gray"/>
        <KpiCard label="온라인" value={stats.online} color="green"/>
        <KpiCard label="작동 중" value={stats.on} color="blue"/>
        <KpiCard label="알림" value={stats.alert} color={stats.alert>0?"red":"gray"}/>
      </div>

      {/* 필터 */}
      <div className="flex gap-2 flex-wrap text-xs">
        <select value={filter.category} onChange={e=>setFilter(f=>({...f, category:e.target.value}))}
          className="px-2 py-1 border rounded">
          <option value="all">전체 종류</option>
          {Object.entries(CAT_META).map(([k,v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
        </select>
        <select value={filter.zone} onChange={e=>setFilter(f=>({...f, zone:e.target.value}))}
          className="px-2 py-1 border rounded">
          <option value="all">전체 구역</option>
          {facilities.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <select value={filter.online} onChange={e=>setFilter(f=>({...f, online:e.target.value}))}
          className="px-2 py-1 border rounded">
          <option value="all">전체 상태</option>
          <option value="online">🟢 온라인만</option>
          <option value="offline">⚫ 오프라인만</option>
        </select>
        <button onClick={fetchDevices} className="ml-auto px-3 py-1 bg-gray-100 rounded font-bold">🔄 새로고침</button>
      </div>

      {/* 그룹별 카드 */}
      {GROUP_ORDER.filter(g => byGroup[g]).map(grp => (
        <div key={grp}>
          <div className="text-xs font-black text-gray-700 mb-2">📂 {grp} ({byGroup[grp].length})</div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {byGroup[grp].map(d => (
              <DeviceCard key={d.id} device={d} facilities={facilities}
                onCommand={(cmd, params) => sendCommand(d.id, cmd, params)}
                onSelect={() => setSelected(d)}/>
            ))}
          </div>
        </div>
      ))}

      {filtered.length === 0 && (
        <div className="text-center py-8 text-gray-400 text-sm">조건에 맞는 기기가 없습니다</div>
      )}
    </div>
  );
}

function DeviceCard({ device, facilities, onCommand, onSelect }) {
  const meta = CAT_META[device.category] || CAT_META.hub;
  const isOn = device.current_state?.power_on;
  const isOnline = device.is_online;
  const fac = facilities.find(f => f.id === device.zone || f.zone === device.zone);
  const isTogglable = ["plug","power_strip","light","switch"].includes(device.category);

  return (
    <div className={`p-3 rounded-xl border-2 ${isOnline?"border-gray-200 bg-white":"border-gray-200 bg-gray-50 opacity-70"}`}>
      <div className="flex items-start gap-2">
        <div className="text-2xl">{meta.icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <div className="text-xs font-black truncate flex-1">{device.name || device.model || meta.label}</div>
            <span className={`w-2 h-2 rounded-full ${isOnline?"bg-emerald-500":"bg-gray-400"}`} title={isOnline?"온라인":"오프라인"}/>
          </div>
          <div className="text-[10px] text-gray-500 truncate">
            {meta.label} · {device.model || "—"} {fac && <>· {fac.name}</>}
          </div>
          {/* 상태 표시 */}
          <div className="mt-1.5 flex flex-wrap gap-1 text-[9px]">
            {device.current_state?.power_on != null && (
              <span className={`px-1.5 py-0.5 rounded font-bold ${isOn?"bg-emerald-100 text-emerald-800":"bg-gray-100 text-gray-600"}`}>
                {isOn ? "🟢 ON" : "⚫ OFF"}
              </span>
            )}
            {device.current_state?.power_w != null && (
              <span className="px-1.5 py-0.5 rounded font-bold bg-amber-100 text-amber-800">⚡ {device.current_state.power_w.toFixed(0)}W</span>
            )}
            {device.current_state?.temperature != null && (
              <span className="px-1.5 py-0.5 rounded font-bold bg-cyan-100 text-cyan-800">🌡️ {device.current_state.temperature}°</span>
            )}
            {device.current_state?.humidity != null && (
              <span className="px-1.5 py-0.5 rounded font-bold bg-cyan-100 text-cyan-800">💧 {device.current_state.humidity}%</span>
            )}
            {device.current_state?.brightness != null && (
              <span className="px-1.5 py-0.5 rounded font-bold bg-yellow-100 text-yellow-800">💡 {device.current_state.brightness}%</span>
            )}
            {device.current_state?.motion && (
              <span className="px-1.5 py-0.5 rounded font-bold bg-orange-100 text-orange-800">🚶 감지!</span>
            )}
            {device.current_state?.alert && (
              <span className="px-1.5 py-0.5 rounded font-bold bg-red-100 text-red-800 animate-pulse">⚠️ {device.current_state.alert}</span>
            )}
          </div>
        </div>
      </div>
      {/* 제어 버튼 */}
      <div className="mt-2 flex gap-1 flex-wrap">
        {isTogglable && isOnline && (
          <button onClick={()=>onCommand(isOn?"turn_off":"turn_on")}
            className={`flex-1 px-2 py-1 text-[10px] font-bold rounded ${isOn?"bg-red-600 text-white":"bg-emerald-600 text-white"}`}>
            {isOn ? "⚫ OFF" : "🟢 ON"}
          </button>
        )}
        {device.category === "camera" && isOnline && (
          <button onClick={()=>onCommand("snapshot")}
            className="flex-1 px-2 py-1 text-[10px] font-bold bg-blue-600 text-white rounded">📸 스냅샷</button>
        )}
        {device.category === "light" && isOnline && isOn && (
          <button onClick={()=>{ const b = prompt("밝기 (0-100)?", "70"); if (b) onCommand("set_brightness", {brightness:Number(b)}); }}
            className="px-2 py-1 text-[10px] font-bold bg-amber-500 text-white rounded">💡 밝기</button>
        )}
        <button onClick={onSelect} className="px-2 py-1 text-[10px] font-bold bg-gray-100 rounded">⋯</button>
      </div>
    </div>
  );
}

// ─── Roborock 탭 ──────────────────────────────────────────────────
function RobotsTab() {
  const [robots, setRobots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchRobots = async () => {
    setLoading(true);
    try {
      const r = await af("/api/tapo-devices?category=robot_vacuum");
      const d = await r.json();
      if (d.fallback) { setError("Roborock 백엔드 미설정"); setRobots([]); }
      else { setRobots(d.devices || []); setError(null); }
    } catch (e) {
      setError(e.message);
    } finally { setLoading(false); }
  };
  useEffect(() => {
    fetchRobots();
    const id = setInterval(fetchRobots, 15000);
    return () => clearInterval(id);
  }, []);

  const sendCmd = async (id, action, params = {}) => {
    try {
      const q = new URLSearchParams({ id, action, ...params }).toString();
      const r = await af(`/api/roborock?${q}`, { method: "POST" });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      alert(`✅ ${action} 명령 전송됨`);
      fetchRobots();
    } catch (e) {
      alert(`❌ ${e.message}`);
    }
  };

  if (loading && robots.length === 0) return <div className="text-center py-12 text-gray-500">⏳ 로봇 정보 로딩...</div>;

  if (error && robots.length === 0) {
    return (
      <div className="text-center py-8">
        <div className="text-4xl mb-3">🤖</div>
        <div className="text-sm font-bold text-gray-700 mb-2">등록된 로봇청소기가 없습니다</div>
        <div className="text-xs text-gray-500 mb-3">{error}</div>
        <div className="bg-emerald-50 border border-emerald-200 rounded p-3 text-[11px] text-emerald-900 max-w-xl mx-auto text-left">
          <strong>💡 Roborock 연동:</strong><br/>
          1. 박물관 PC에 Roborock 브릿지(Python 또는 Node.js) 설치<br/>
          2. Tapo 기기 관리에서 category=<code>robot_vacuum</code>으로 기기 등록<br/>
          3. 브릿지가 /api/roborock의 명령 큐를 폴링하여 실행
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {robots.map(r => {
        const state = r.current_state || {};
        const battery = state.battery ?? 0;
        const status = state.status || "unknown"; // idle | cleaning | docking | charging | error
        const statusMap = {
          idle: { label:"대기", color:"#64748b" },
          cleaning: { label:"청소 중", color:"#10b981" },
          docking: { label:"도킹 중", color:"#3b82f6" },
          charging: { label:"충전 중", color:"#f59e0b" },
          error: { label:"오류", color:"#dc2626" },
        };
        const st = statusMap[status] || statusMap.idle;
        return (
          <div key={r.id} className="p-4 bg-white border-2 border-gray-200 rounded-xl">
            <div className="flex items-start gap-3 mb-3">
              <div className="text-4xl">🤖</div>
              <div className="flex-1">
                <div className="text-sm font-black">{r.name || r.model}</div>
                <div className="text-[10px] text-gray-500">{r.model || "Roborock"} · {r.zone || "—"}</div>
              </div>
              <span className="px-3 py-1 rounded text-xs font-bold text-white" style={{background:st.color}}>{st.label}</span>
            </div>
            {/* 배터리 + 상태 */}
            <div className="grid grid-cols-3 gap-2 text-center mb-3">
              <div className="bg-gray-50 p-2 rounded">
                <div className="text-[9px] text-gray-500">배터리</div>
                <div className="text-sm font-black" style={{color: battery<20?"#dc2626":battery<50?"#f59e0b":"#10b981"}}>🔋 {battery}%</div>
              </div>
              <div className="bg-gray-50 p-2 rounded">
                <div className="text-[9px] text-gray-500">청소 면적</div>
                <div className="text-sm font-black">📐 {state.clean_area || 0}㎡</div>
              </div>
              <div className="bg-gray-50 p-2 rounded">
                <div className="text-[9px] text-gray-500">팬 속도</div>
                <div className="text-sm font-black">💨 {state.fan_speed || "balanced"}</div>
              </div>
            </div>
            {/* 명령 버튼 */}
            <div className="grid grid-cols-4 gap-2">
              <button onClick={()=>sendCmd(r.id, "start")} disabled={!r.is_online}
                className="px-3 py-2 text-xs font-bold bg-emerald-600 text-white rounded disabled:opacity-50">▶️ 시작</button>
              <button onClick={()=>sendCmd(r.id, "pause")} disabled={!r.is_online || status!=="cleaning"}
                className="px-3 py-2 text-xs font-bold bg-amber-500 text-white rounded disabled:opacity-50">⏸️ 일시정지</button>
              <button onClick={()=>sendCmd(r.id, "return_home")} disabled={!r.is_online}
                className="px-3 py-2 text-xs font-bold bg-blue-600 text-white rounded disabled:opacity-50">🏠 도킹</button>
              <button onClick={()=>sendCmd(r.id, "find_robot")} disabled={!r.is_online}
                className="px-3 py-2 text-xs font-bold bg-purple-600 text-white rounded disabled:opacity-50">📢 찾기</button>
              <button onClick={()=>{ const s = prompt("팬 속도 (silent|balanced|turbo|max)", state.fan_speed || "balanced"); if (s) sendCmd(r.id, "set_fan_speed", {speed:s}); }}
                disabled={!r.is_online} className="px-3 py-2 text-xs font-bold bg-gray-100 rounded disabled:opacity-50">💨 속도</button>
              <button onClick={()=>{ const seg = prompt("청소할 구역 ID (콤마 구분)", ""); if (seg) sendCmd(r.id, "clean_segment", {segment_id:seg}); }}
                disabled={!r.is_online} className="px-3 py-2 text-xs font-bold bg-gray-100 rounded disabled:opacity-50">📍 구역만</button>
              <button onClick={()=>sendCmd(r.id, "reset_consumable", {type:"filter"})}
                className="col-span-2 px-3 py-2 text-xs font-bold bg-gray-100 rounded">🔧 소모품 초기화</button>
            </div>
            {/* 마지막 청소 + 다음 예약 */}
            <div className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
              <div className="text-gray-600">
                <span className="font-bold">마지막 청소:</span> {state.last_clean_at ? new Date(state.last_clean_at).toLocaleString("ko-KR", {month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}) : "—"}
              </div>
              <div className="text-gray-600">
                <span className="font-bold">다음 예약:</span> {state.next_schedule || "—"}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── 자동화 프로그램 탭 ───────────────────────────────────────────
function AutomationsTab() {
  const [automations, setAutomations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchAutomations = async () => {
    setLoading(true);
    try {
      const r = await af("/api/tapo-automations");
      const d = await r.json();
      if (d.fallback) { setError("자동화 백엔드 미설정"); setAutomations([]); }
      else { setAutomations(d.automations || d.templates || []); setError(null); }
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { fetchAutomations(); }, []);

  const toggle = async (id, enabled) => {
    try {
      const r = await af(`/api/tapo-automations?id=${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      setAutomations(arr => arr.map(a => a.id === id ? {...a, enabled} : a));
    } catch (e) {
      alert(`❌ ${e.message}`);
    }
  };

  if (loading) return <div className="text-center py-12 text-gray-500">⏳ 자동화 프로그램 로딩...</div>;

  // 기본 16개 템플릿 (백엔드 미설정 시 표시용)
  const FALLBACK_TEMPLATES = [
    { id:"opening_mode", name:"🌅 운영 시작 모드", description:"매일 9시에 조명/카메라/플러그 자동 ON", severity:"normal", enabled:false },
    { id:"closing_mode", name:"🌙 운영 종료 모드", description:"매일 18시: 조명 OFF, 야간 모드 카메라 ON", severity:"normal", enabled:false },
    { id:"night_intrusion", name:"🚨 야간 침입 감지", description:"22-08시 모션 감지 → 즉시 SMS + 영상 저장", severity:"danger", enabled:false },
    { id:"water_leak", name:"💦 누수 감지 대응", description:"누수 센서 → 메인 전원 차단 + 알림", severity:"danger", enabled:false },
    { id:"fire_smoke", name:"🔥 화재/연기 감지", description:"화재 감지 → 전체 전원 차단 + 스피커 안내", severity:"critical", enabled:false },
    { id:"temp_high", name:"🌡️ 고온 경보", description:"실내 30도 초과 → 환기팬 ON, 매점 냉장고 점검", severity:"warning", enabled:false },
    { id:"humidity_high", name:"💧 고습도 대응", description:"습도 80% 초과 → 제습기 ON, 누에관 환기", severity:"warning", enabled:false },
    { id:"power_overload", name:"⚡ 전력 과부하 감지", description:"콘센트 1500W 초과 시 자동 차단", severity:"warning", enabled:false },
    { id:"motion_after_hours", name:"👤 운영시간 외 동선", description:"운영시간 외 박물관 내 동선 감지 → 알림", severity:"danger", enabled:false },
    { id:"door_left_open", name:"🚪 문 장시간 열림", description:"문이 10분 이상 열려 있으면 알림", severity:"warning", enabled:false },
    { id:"daily_clean", name:"🤖 일일 자동 청소", description:"매일 8시 로봇청소기 자동 시작", severity:"normal", enabled:false },
    { id:"low_battery", name:"🔋 센서 배터리 부족", description:"센서 배터리 20% 미만 → 교체 알림", severity:"normal", enabled:false },
    { id:"weather_storm", name:"🌪️ 기상 경보 대응", description:"강풍/호우 시 야외 조명 강화 + 안내방송", severity:"warning", enabled:false },
    { id:"presence_simulation", name:"🏠 부재중 시뮬레이션", description:"휴관일 조명 랜덤 ON/OFF (보안)", severity:"normal", enabled:false },
    { id:"emergency_light", name:"🆘 비상 조명", description:"화재/지진 시 전 비상등 100% 밝기", severity:"critical", enabled:false },
    { id:"energy_save", name:"♻️ 에너지 절약 모드", description:"사용 없는 구역 조명 30분 후 자동 OFF", severity:"normal", enabled:false },
  ];

  const list = automations.length > 0 ? automations : FALLBACK_TEMPLATES;
  const showFallbackNotice = error || automations.length === 0;

  return (
    <div className="space-y-3">
      {showFallbackNotice && (
        <div className="bg-amber-50 border border-amber-300 rounded p-3 text-xs text-amber-900">
          ⚠️ <strong>참고용 미리보기:</strong> 백엔드가 미설정되어 16개 기본 자동화 템플릿만 표시합니다.
          실제 활성화는 Tapo 백엔드 + Supabase 설정 후 가능합니다. {error && <span className="text-amber-700">({error})</span>}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {list.map(a => {
          const sevColors = {
            critical: { bg:"bg-red-50", border:"border-red-300", text:"text-red-900", chip:"bg-red-600 text-white" },
            danger:   { bg:"bg-orange-50", border:"border-orange-300", text:"text-orange-900", chip:"bg-orange-600 text-white" },
            warning:  { bg:"bg-yellow-50", border:"border-yellow-300", text:"text-yellow-900", chip:"bg-yellow-600 text-white" },
            normal:   { bg:"bg-blue-50", border:"border-blue-300", text:"text-blue-900", chip:"bg-blue-600 text-white" },
          };
          const c = sevColors[a.severity] || sevColors.normal;
          return (
            <div key={a.id} className={`p-3 rounded-xl border-2 ${a.enabled?c.border+" "+c.bg:"border-gray-200 bg-white"}`}>
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex-1">
                  <div className={`text-sm font-black ${a.enabled?c.text:"text-gray-900"}`}>{a.name}</div>
                  <div className="text-[10px] text-gray-600 mt-1">{a.description}</div>
                </div>
                <span className={`px-2 py-0.5 rounded text-[9px] font-bold ${c.chip}`}>{a.severity}</span>
              </div>
              <div className="flex items-center justify-between mt-2">
                <span className={`text-[10px] font-bold ${a.enabled?"text-emerald-600":"text-gray-400"}`}>
                  {a.enabled ? "🟢 활성" : "⚫ 비활성"}
                </span>
                <Toggle checked={!!a.enabled} onChange={(v)=>toggle(a.id, v)}/>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── 긴급 안전제어 탭 ──────────────────────────────────────────────
function EmergencyTab({ facilities }) {
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(false);

  const emergencyActions = [
    { id:"all_off", icon:"⚫", label:"전체 전원 차단", desc:"모든 콘센트/멀티탭 즉시 OFF", color:"bg-red-600", action:async()=>{
      const r = await af("/api/tapo-devices?category=plug&action=command", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({command:"turn_off",target:"all"})});
      return r.ok;
    }},
    { id:"all_lights_on", icon:"💡", label:"전 조명 100% ON", desc:"화재/지진 대피 시 모든 조명 최대 밝기", color:"bg-yellow-500", action:async()=>{
      const r = await af("/api/tapo-devices?category=light&action=command", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({command:"turn_on",target:"all",brightness:100})});
      return r.ok;
    }},
    { id:"camera_record_all", icon:"📹", label:"전 카메라 녹화 시작", desc:"모든 카메라 즉시 녹화 + 스냅샷 저장", color:"bg-purple-600", action:async()=>{
      const r = await af("/api/tapo-devices?category=camera&action=command", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({command:"start_recording",target:"all"})});
      return r.ok;
    }},
    { id:"night_patrol", icon:"🌙", label:"야간 순찰 모드", desc:"로봇청소기 순찰 + 카메라 야간모드 + 조명 30%", color:"bg-blue-700", action:async()=>{
      await af("/api/tapo-devices?category=camera&action=command", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({command:"set_mode",value:"night",target:"all"})});
      await af("/api/tapo-devices?category=light&action=command", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({command:"set_brightness",brightness:30,target:"all"})});
      return true;
    }},
    { id:"closing_mode", icon:"🔒", label:"폐관 모드", desc:"모든 조명 OFF, 카메라 야간모드, 보안 강화", color:"bg-gray-700", action:async()=>{
      await af("/api/tapo-devices?category=light&action=command", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({command:"turn_off",target:"all"})});
      await af("/api/tapo-devices?category=camera&action=command", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({command:"set_mode",value:"night",target:"all"})});
      return true;
    }},
    { id:"opening_mode", icon:"🌅", label:"개관 모드", desc:"조명 ON, 카메라 일반모드, 콘센트 작동", color:"bg-emerald-600", action:async()=>{
      await af("/api/tapo-devices?category=light&action=command", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({command:"turn_on",target:"all"})});
      await af("/api/tapo-devices?category=plug&action=command", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({command:"turn_on",target:"essential"})});
      return true;
    }},
  ];

  const runAction = async (act) => {
    setBusy(true);
    try {
      const ok = await act.action();
      alert(ok ? `✅ ${act.label} 실행 완료` : `⚠️ 일부 명령이 실패했습니다`);
    } catch (e) {
      alert(`❌ 실패: ${e.message}`);
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-red-50 border-2 border-red-300 rounded-xl p-4">
        <div className="text-sm font-black text-red-900 mb-1">🚨 긴급 원클릭 안전제어</div>
        <div className="text-xs text-red-700">버튼 클릭 시 확인 후 전체 IoT 기기에 즉시 명령이 전달됩니다. <strong>주의 깊게 사용하세요.</strong></div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {emergencyActions.map(a => (
          <button key={a.id} onClick={()=>setConfirming(a)} disabled={busy}
            className={`p-4 rounded-xl text-white text-left ${a.color} hover:opacity-90 disabled:opacity-50 transition`}>
            <div className="text-3xl mb-2">{a.icon}</div>
            <div className="text-sm font-black">{a.label}</div>
            <div className="text-[10px] opacity-90 mt-1">{a.desc}</div>
          </button>
        ))}
      </div>

      {/* 안전제어 시나리오 (자동화 트리거 매핑 안내) */}
      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <div className="text-sm font-black mb-3">🔗 자동화 ↔ 트리거 시나리오</div>
        <div className="space-y-2 text-xs">
          {[
            { trigger:"🔥 화재 감지", action:"전체 전원 차단 + 비상등 100% + 스피커 안내방송" },
            { trigger:"💦 누수 감지", action:"메인 전원 차단 + 관리자 즉시 알림" },
            { trigger:"🚶 운영시간 외 동선", action:"카메라 녹화 + 텔레그램/SMS 푸시" },
            { trigger:"💨 강풍주의보", action:"야외 조명 강화 + 천막 결속 점검 알림" },
            { trigger:"🌡️ 실내 30°↑", action:"환기팬 ON + 매점 냉장고 자동 점검" },
            { trigger:"⚡ 콘센트 1500W↑", action:"해당 콘센트 자동 차단 + 알림" },
          ].map((s,i) => (
            <div key={i} className="flex items-center gap-2 p-2 bg-gray-50 rounded">
              <span className="font-bold text-gray-900 w-40">{s.trigger}</span>
              <span className="text-gray-400">→</span>
              <span className="flex-1 text-gray-700">{s.action}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 text-[10px] text-gray-500">
          💡 위 시나리오는 "⚙️ 자동화 프로그램" 탭에서 활성화/비활성화할 수 있습니다.
        </div>
      </div>

      {/* 확인 모달 */}
      {confirming && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl p-5 max-w-sm w-full">
            <div className="text-4xl mb-3">{confirming.icon}</div>
            <div className="text-base font-black mb-2">{confirming.label}</div>
            <div className="text-xs text-gray-700 mb-4">{confirming.desc}</div>
            <div className="bg-amber-50 border border-amber-300 rounded p-2 text-[10px] text-amber-900 mb-4">
              ⚠️ 이 작업은 전체 IoT 기기에 영향을 줍니다. 진행하시겠습니까?
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={()=>setConfirming(null)} className="px-4 py-2 text-xs bg-gray-100 rounded font-bold">취소</button>
              <button onClick={()=>runAction(confirming)} disabled={busy}
                className={`px-4 py-2 text-xs text-white rounded font-bold ${confirming.color} disabled:opacity-50`}>
                {busy ? "⏳ 실행 중..." : "✅ 실행"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 헬퍼 ─────────────────────────────────────────────────────────
function Toggle({ checked, onChange }) {
  return (
    <button onClick={() => onChange(!checked)}
      className={`relative w-10 h-5 rounded-full transition ${checked?"bg-emerald-600":"bg-gray-300"}`}>
      <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition ${checked?"left-5":"left-0.5"}`}/>
    </button>
  );
}

function KpiCard({ label, value, color }) {
  const colors = {
    gray: "bg-gray-50 text-gray-700 border-gray-200",
    green: "bg-emerald-50 text-emerald-900 border-emerald-200",
    blue: "bg-blue-50 text-blue-900 border-blue-200",
    red: "bg-red-50 text-red-900 border-red-200",
  };
  return (
    <div className={`p-2 rounded-lg border ${colors[color] || colors.gray} text-center`}>
      <div className="text-[10px] font-bold opacity-70">{label}</div>
      <div className="text-lg font-black">{value}</div>
    </div>
  );
}
