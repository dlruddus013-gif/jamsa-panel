// safety-cctv-nvr.jsx
// SmartPSS / VMS Client / Dahua NVR / Hikvision / ONVIF 등록 + 통합 패널
// PC에 SmartPSS·VMS가 켜져 있어도 그 자체는 브라우저로 스트림이 안 오므로,
// (1) NVR 자체 HTTP 스냅샷 URL을 사용하거나
// (2) PC에 작은 브릿지 서버(jamsa-cctv-bridge)를 띄워 프록시한다.
//
// 이 페이지에서 NVR 등록 → 스냅샷 URL 자동 생성 →
// localStorage(jamsa_cctv_nvr_configs)에 저장 →
// 기존 CctvLiveOverlay가 자동으로 폴링.

import React, { useEffect, useMemo, useState } from "react";

const NVR_BRANDS = {
  dahua: {
    label: "Dahua (SmartPSS)",
    icon: "📷",
    color: "#3b82f6",
    snapshotUrl: (cfg, ch) =>
      `http://${cfg.username}:${cfg.password}@${cfg.host}:${cfg.port||80}/cgi-bin/snapshot.cgi?channel=${ch}`,
    rtspUrl: (cfg, ch, sub = false) =>
      `rtsp://${cfg.username}:${cfg.password}@${cfg.host}:${cfg.rtspPort||554}/cam/realmonitor?channel=${ch}&subtype=${sub?1:0}`,
    notes: "Dahua NVR/카메라는 기본 HTTP 80, RTSP 554. 'Web Service'를 'Allow' 설정. SmartPSS 사용자명/비번 동일.",
  },
  hikvision: {
    label: "Hikvision",
    icon: "📹",
    color: "#dc2626",
    snapshotUrl: (cfg, ch) =>
      `http://${cfg.username}:${cfg.password}@${cfg.host}:${cfg.port||80}/ISAPI/Streaming/channels/${ch}01/picture`,
    rtspUrl: (cfg, ch, sub = false) =>
      `rtsp://${cfg.username}:${cfg.password}@${cfg.host}:${cfg.rtspPort||554}/Streaming/Channels/${ch}0${sub?2:1}`,
    notes: "Hikvision ISAPI 호환. iVMS-4200과 동일 자격증명. ISAPI HTTP 활성화 필요.",
  },
  vms_generic: {
    label: "VMS Client (Dahua 호환)",
    icon: "🎥",
    color: "#10b981",
    snapshotUrl: (cfg, ch) =>
      `http://${cfg.username}:${cfg.password}@${cfg.host}:${cfg.port||9000}/cgi-bin/snapshot.cgi?channel=${ch}`,
    rtspUrl: (cfg, ch, sub = false) =>
      `rtsp://${cfg.username}:${cfg.password}@${cfg.host}:${cfg.rtspPort||554}/cam/realmonitor?channel=${ch}&subtype=${sub?1:0}`,
    notes: "스크린샷의 VMS Client (port 9000) — Dahua 프로토콜 호환. SmartPSS와 동일 NVR 가리킬 가능성 높음.",
  },
  onvif: {
    label: "ONVIF 표준",
    icon: "🌐",
    color: "#8b5cf6",
    snapshotUrl: (cfg) =>
      `http://${cfg.host}:${cfg.port||80}/onvif/snapshot?ProfileToken=Profile_1`,
    rtspUrl: (cfg) => `rtsp://${cfg.username}:${cfg.password}@${cfg.host}:${cfg.rtspPort||554}/onvif1`,
    notes: "ONVIF Profile S 호환 카메라. Snapshot URI는 카메라마다 다를 수 있어 ONVIF Device Manager로 확인 권장.",
  },
  custom: {
    label: "직접 입력 (Custom)",
    icon: "⚙️",
    color: "#64748b",
    snapshotUrl: (cfg, ch) => (cfg.customSnapshotTemplate || "").replace("{ch}", ch).replace("{host}", cfg.host).replace("{user}", cfg.username).replace("{pass}", cfg.password),
    rtspUrl: (cfg, ch) => (cfg.customRtspTemplate || "").replace("{ch}", ch).replace("{host}", cfg.host).replace("{user}", cfg.username).replace("{pass}", cfg.password),
    notes: "사용자 정의 URL 템플릿. {host}, {user}, {pass}, {ch} 치환자 사용.",
  },
};

const STORAGE_KEY = "jamsa_cctv_nvr_configs";
const DEFAULT_BRIDGE = "https://cctv.thejamsa.com";  // 클라우드 브릿지 기본값

function useLS(key, init) {
  const [v, setV] = useState(() => {
    try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(init)); } catch (e) { return init; }
  });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }, [key, v]);
  return [v, setV];
}

export function CctvNvrConfigPage({ facilities = [] }) {
  const [configs, setConfigs] = useLS(STORAGE_KEY, []);
  const [editing, setEditing] = useState(null);
  const [showSetup, setShowSetup] = useState(false);
  const [testResults, setTestResults] = useState({});

  // 현재 브리지 서버 URL (기본: 클라우드 cctv.thejamsa.com)
  const [bridgeUrl, setBridgeUrl] = useState(() => {
    try {
      const saved = localStorage.getItem("jamsa_cctv_snap_server");
      return saved || DEFAULT_BRIDGE;
    } catch (e) { return DEFAULT_BRIDGE; }
  });
  // 초기 마운트 시 localStorage에 기본값이 없으면 자동 저장
  useEffect(() => {
    try {
      if (!localStorage.getItem("jamsa_cctv_snap_server")) {
        localStorage.setItem("jamsa_cctv_snap_server", DEFAULT_BRIDGE);
      }
    } catch (e) {}
  }, []);
  const saveBridgeUrl = (url) => {
    try { localStorage.setItem("jamsa_cctv_snap_server", url); setBridgeUrl(url); } catch (e) {}
  };
  const resetToCloud = () => saveBridgeUrl(DEFAULT_BRIDGE);

  // 모든 채널 펼치기
  const allChannels = useMemo(() => {
    const out = [];
    configs.forEach(c => {
      const brand = NVR_BRANDS[c.brand] || NVR_BRANDS.custom;
      (c.channels || []).forEach(ch => {
        out.push({
          configId: c.id,
          configName: c.name,
          brand: c.brand,
          brandMeta: brand,
          ch: ch.ch,
          name: ch.name || `CH${ch.ch}`,
          snapshotUrl: brand.snapshotUrl(c, ch.ch),
          rtspUrl: brand.rtspUrl(c, ch.ch),
        });
      });
    });
    return out;
  }, [configs]);

  const addOrUpdate = (cfg) => {
    setConfigs(prev => {
      if (cfg.id && prev.some(c => c.id === cfg.id)) {
        return prev.map(c => c.id === cfg.id ? cfg : c);
      }
      return [{ ...cfg, id: cfg.id || `nvr_${Date.now()}` }, ...prev];
    });
    setEditing(null);
  };

  const remove = (id) => {
    if (!confirm("이 NVR 설정을 삭제할까요?")) return;
    setConfigs(prev => prev.filter(c => c.id !== id));
  };

  const testSnapshot = async (configId, ch, url) => {
    setTestResults(prev => ({ ...prev, [`${configId}_${ch}`]: { loading: true } }));
    try {
      // 브리지 경유 URL로 변환 (jamsa_cctv_snap_server가 설정돼 있으면)
      let testUrl = url;
      if (bridgeUrl) {
        // 브릿지가 /api/snap/:ch 형식의 프록시를 제공한다고 가정
        testUrl = `${bridgeUrl.replace(/\/+$/, "")}/api/snap/${ch}?t=${Date.now()}`;
      }
      const res = await fetch(testUrl, { mode: "no-cors", cache: "no-store" }).catch(e => null);
      // no-cors mode는 status 0이지만 네트워크 도달은 성공한 것으로 간주
      setTestResults(prev => ({ ...prev, [`${configId}_${ch}`]: { loading: false, ok: !!res, status: res?.status || "no-cors" } }));
    } catch (e) {
      setTestResults(prev => ({ ...prev, [`${configId}_${ch}`]: { loading: false, ok: false, error: e.message } }));
    }
  };

  return (
    <div className="space-y-4 p-4">
      {/* 헤더 */}
      <div style={{padding:14,background:"linear-gradient(135deg,#1e40af,#0ea5e9)",color:"#fff",borderRadius:12}}>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h2 style={{fontSize:18,fontWeight:900,margin:0}}>📡 NVR / VMS / SmartPSS 통합</h2>
            <div style={{fontSize:11,opacity:0.9,marginTop:4}}>
              PC에 켜진 SmartPSS · VMS Client · Dahua NVR · Hikvision · ONVIF 카메라를
              잠사박물관 패널의 실시간 CCTV 오버레이에 연결합니다.
            </div>
          </div>
          <button onClick={()=>setShowSetup(s=>!s)}
            style={{padding:"8px 14px",background:"rgba(255,255,255,0.2)",color:"#fff",border:"1px solid rgba(255,255,255,0.4)",borderRadius:8,fontWeight:700,fontSize:12,cursor:"pointer"}}>
            {showSetup ? "📕 가이드 닫기" : "📖 연동 가이드"}
          </button>
        </div>
      </div>

      {showSetup && <SetupGuide bridgeUrl={bridgeUrl} saveBridgeUrl={saveBridgeUrl}/>}

      {/* 브릿지 서버 상태 */}
      {(() => {
        const isCloud = bridgeUrl && /thejamsa\.com|jamsa\.com/.test(bridgeUrl);
        const isLocal = bridgeUrl && /(localhost|127\.0\.0\.1|192\.168|10\.|172\.)/.test(bridgeUrl);
        return (
          <div style={{padding:10,background:isCloud?"#dbeafe":(bridgeUrl?"#dcfce7":"#fef3c7"),border:`1px solid ${isCloud?"#93c5fd":(bridgeUrl?"#86efac":"#fde68a")}`,borderRadius:8,display:"flex",alignItems:"center",gap:8,fontSize:12,flexWrap:"wrap"}}>
            <span style={{fontSize:20}}>{isCloud?"☁️":(bridgeUrl?"🖥️":"⚠️")}</span>
            <div style={{flex:1,minWidth:200}}>
              <div style={{fontWeight:800,color:isCloud?"#1e40af":(bridgeUrl?"#065f46":"#92400e")}}>
                {isCloud ? "☁️ 클라우드 브릿지" : (isLocal ? "🖥️ 로컬 브릿지" : "브릿지")}: {bridgeUrl || "미설정"}
              </div>
              <div style={{fontSize:10,color:isCloud?"#1e3a8a":(bridgeUrl?"#047857":"#a16207"),marginTop:2}}>
                {isCloud
                  ? "클라우드 서버 경유로 NVR 스냅샷을 받습니다. 박물관 PC에 별도 설치 불필요. 24/7 안정적."
                  : (isLocal
                    ? "박물관 PC의 로컬 브릿지 사용 중. PC가 켜져 있어야 작동."
                    : "직접 NVR 접속은 CORS/Mixed Content로 차단됨. 브릿지 권장 (위 가이드).")}
              </div>
            </div>
            <input value={bridgeUrl} onChange={e=>saveBridgeUrl(e.target.value)}
              placeholder={DEFAULT_BRIDGE}
              style={{padding:"6px 10px",border:"1px solid #cbd5e1",borderRadius:6,fontSize:11,width:240}}/>
            {!isCloud && (
              <button onClick={resetToCloud}
                style={{padding:"6px 10px",background:"#3b82f6",color:"#fff",border:"none",borderRadius:6,fontSize:10,fontWeight:700,cursor:"pointer"}}
                title="클라우드 기본값으로 복원">
                ☁️ 클라우드로
              </button>
            )}
          </div>
        );
      })()}

      {/* 액션 */}
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div style={{fontSize:13,fontWeight:700}}>등록된 NVR/VMS ({configs.length})</div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          <AutoImportButton bridgeUrl={bridgeUrl} configs={configs} setConfigs={setConfigs}/>
          <DiscoverButton bridgeUrl={bridgeUrl} configs={configs} setConfigs={setConfigs} setEditing={setEditing}/>
          <button onClick={()=>setEditing({brand:"dahua",port:80,rtspPort:554,channels:[{ch:1,name:"CH1"}]})}
            style={{padding:"8px 14px",background:"#0ea5e9",color:"#fff",border:"none",borderRadius:8,fontWeight:700,fontSize:12,cursor:"pointer"}}>
            ＋ NVR 추가
          </button>
        </div>
      </div>

      {/* NVR 목록 */}
      {configs.length === 0 ? (
        <div style={{padding:30,textAlign:"center",border:"2px dashed #cbd5e1",borderRadius:10,color:"#94a3b8"}}>
          <div style={{fontSize:36,marginBottom:8}}>📡</div>
          <div style={{fontSize:13,fontWeight:700,color:"#475569"}}>등록된 NVR/VMS가 없습니다</div>
          <div style={{fontSize:11,marginTop:4}}>＋ NVR 추가 버튼으로 시작하세요</div>
        </div>
      ) : (
        <div style={{display:"grid",gap:10}}>
          {configs.map(c => {
            const brand = NVR_BRANDS[c.brand] || NVR_BRANDS.custom;
            return (
              <div key={c.id} style={{padding:12,background:"#fff",border:`2px solid ${brand.color}33`,borderRadius:10}}>
                <div className="flex items-start gap-3 mb-2">
                  <span style={{fontSize:28}}>{brand.icon}</span>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:14,fontWeight:900,color:"#0f172a"}}>{c.name || "(이름 없음)"}</div>
                    <div style={{fontSize:10,color:brand.color,fontWeight:700,marginTop:1}}>{brand.label}</div>
                    <div style={{fontSize:10,color:"#64748b",marginTop:2,fontFamily:"monospace"}}>{c.username}@{c.host}:{c.port}{c.rtspPort?` (RTSP ${c.rtspPort})`:""}</div>
                  </div>
                  <div style={{display:"flex",gap:4}}>
                    <button onClick={()=>setEditing(c)} style={{padding:"4px 8px",fontSize:10,background:"#f1f5f9",border:"none",borderRadius:5,cursor:"pointer",fontWeight:700}}>수정</button>
                    <button onClick={()=>remove(c.id)} style={{padding:"4px 8px",fontSize:10,background:"#fee2e2",color:"#dc2626",border:"none",borderRadius:5,cursor:"pointer",fontWeight:700}}>🗑️</button>
                  </div>
                </div>
                {/* 채널 목록 */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:6,marginTop:8}}>
                  {(c.channels||[]).map(ch => {
                    const url = brand.snapshotUrl(c, ch.ch);
                    const rtsp = brand.rtspUrl(c, ch.ch);
                    const tr = testResults[`${c.id}_${ch.ch}`];
                    return (
                      <div key={ch.ch} style={{padding:8,background:"#f8fafc",borderRadius:6,fontSize:10}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                          <span style={{fontWeight:800,color:brand.color}}>📹 {ch.name || `CH${ch.ch}`}</span>
                          <div style={{display:"flex",gap:4}}>
                            <button onClick={()=>testSnapshot(c.id, ch.ch, url)}
                              style={{padding:"2px 6px",fontSize:9,background:"#dbeafe",color:"#1e40af",border:"none",borderRadius:4,cursor:"pointer",fontWeight:700}}>
                              {tr?.loading ? "⏳" : tr?.ok ? "✅" : "🧪 테스트"}
                            </button>
                          </div>
                        </div>
                        <div style={{fontSize:9,color:"#64748b",wordBreak:"break-all",lineHeight:1.4}}>
                          <div><strong>스냅:</strong> {url.replace(/:[^:@\/]+@/, ":***@")}</div>
                          <div style={{marginTop:2}}><strong>RTSP:</strong> {rtsp.replace(/:[^:@\/]+@/, ":***@")}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{marginTop:8,padding:8,background:brand.color+"11",borderRadius:6,fontSize:9,color:brand.color}}>
                  💡 {brand.notes}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 통합 채널 요약 */}
      {allChannels.length > 0 && (
        <div style={{padding:10,background:"#eff6ff",border:"1px solid #bfdbfe",borderRadius:8,fontSize:11,color:"#1e40af"}}>
          📊 <strong>총 {allChannels.length}개 채널</strong>이 등록되어 있습니다.
          통합지도 → CCTV 라이브 오버레이에서 자동 표시됩니다.
          {!bridgeUrl && <span style={{color:"#dc2626",fontWeight:700}}> ⚠️ 단, 브릿지 미설정 시 브라우저가 직접 NVR에 접속할 수 없습니다.</span>}
        </div>
      )}

      {editing && (
        <NvrEditModal config={editing} onSave={addOrUpdate} onClose={()=>setEditing(null)}/>
      )}
    </div>
  );
}

// ─── 자동 등록: 브릿지 CONFIG에서 import ────────────────────────────
function AutoImportButton({ bridgeUrl, configs, setConfigs }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!bridgeUrl) { alert("⚠️ 먼저 로컬 브릿지 URL을 설정하세요 (위 입력란)."); return; }
    setBusy(true);
    try {
      const r = await fetch(`${bridgeUrl.replace(/\/+$/, "")}/api/config-snapshot`, { cache: "no-store" });
      const d = await r.json();
      if (!d.ok || !d.configs?.length) { alert("브릿지에 NVR 설정이 없습니다. jamsa-cctv-bridge.cjs의 CONFIG 섹션에 NVR 정보를 입력하세요."); return; }
      // 중복 제거 (host:port 기준)
      const existingKeys = new Set(configs.map(c => `${c.host}:${c.port}`));
      const toAdd = d.configs.filter(c => !existingKeys.has(`${c.host}:${c.port}`));
      if (toAdd.length === 0) { alert(`이미 모두 등록되어 있습니다 (${d.configs.length}개). 추가할 새 NVR이 없습니다.`); return; }
      if (!confirm(`📥 브릿지에서 ${toAdd.length}개 NVR (총 ${toAdd.reduce((s,c)=>s+c.channels.length,0)}개 채널)을 자동 등록할까요?`)) return;
      setConfigs(prev => [...toAdd, ...prev]);
      alert(`✅ ${toAdd.length}개 NVR 자동 등록 완료`);
    } catch (e) {
      alert(`❌ 자동 등록 실패: ${e.message}\n\n브릿지가 실행 중인지 확인하세요 (node jamsa-cctv-bridge.cjs).`);
    } finally { setBusy(false); }
  };
  return (
    <button onClick={run} disabled={busy}
      style={{padding:"8px 14px",background:"#10b981",color:"#fff",border:"none",borderRadius:8,fontWeight:700,fontSize:12,cursor:busy?"wait":"pointer",opacity:busy?0.7:1}}
      title="박물관 PC 브릿지의 CONFIG 설정을 한 번에 가져옵니다">
      {busy ? "⏳ 가져오는 중..." : "📥 브릿지 설정 자동 가져오기"}
    </button>
  );
}

// ─── 자동 등록: LAN 자동 스캔 ─────────────────────────────────────
function DiscoverButton({ bridgeUrl, configs, setConfigs, setEditing }) {
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState(null);
  const run = async () => {
    if (!bridgeUrl) { alert("⚠️ 먼저 로컬 브릿지 URL을 설정하세요."); return; }
    setBusy(true); setFound(null);
    try {
      const r = await fetch(`${bridgeUrl.replace(/\/+$/, "")}/api/discover`, { cache: "no-store" });
      const d = await r.json();
      if (!d.ok) { alert(`스캔 실패: ${d.error}`); return; }
      if (!d.devices?.length) { alert(`📡 ${d.subnet}.0/24 스캔 완료. 발견된 NVR 없음.`); return; }
      setFound(d);
    } catch (e) {
      alert(`❌ 스캔 실패: ${e.message}`);
    } finally { setBusy(false); }
  };
  const register = (dev) => {
    if (configs.some(c => c.host === dev.host && c.port === dev.port)) {
      alert("이미 등록된 NVR입니다.");
      return;
    }
    // 발견된 정보로 편집 모달 자동 채움
    setEditing({
      brand: dev.brand === 'unknown' ? 'dahua' : dev.brand,
      name: `${dev.brand?.toUpperCase()} NVR (${dev.host})`,
      host: dev.host,
      port: dev.port,
      rtspPort: 554,
      username: "admin",
      password: "",
      channels: [{ch:1,name:"CH1"}],
    });
    setFound(null);
  };
  return (
    <>
      <button onClick={run} disabled={busy}
        style={{padding:"8px 14px",background:"#8b5cf6",color:"#fff",border:"none",borderRadius:8,fontWeight:700,fontSize:12,cursor:busy?"wait":"pointer",opacity:busy?0.7:1}}
        title="LAN 전체를 스캔하여 NVR/카메라를 자동 감지">
        {busy ? "🔍 스캔 중... (1~2분)" : "🔍 LAN 자동 검색"}
      </button>
      {found && (
        <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.6)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:14}}>
          <div style={{background:"#fff",borderRadius:12,maxWidth:600,width:"100%",maxHeight:"80vh",overflowY:"auto",padding:18}}>
            <div className="flex justify-between items-center mb-3">
              <h3 style={{fontSize:15,fontWeight:900}}>🔍 LAN 스캔 결과 ({found.devices.length}대 발견)</h3>
              <button onClick={()=>setFound(null)} style={{background:"none",border:"none",fontSize:20,color:"#94a3b8",cursor:"pointer"}}>✕</button>
            </div>
            <div style={{fontSize:11,color:"#64748b",marginBottom:10}}>
              스캔 대상: {found.subnet}.0/24 ({found.scanned}개 포트). 등록하려면 해당 NVR 클릭.
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {found.devices.map((d, i) => {
                const isRegistered = configs.some(c => c.host === d.host && c.port === d.port);
                const brandColor = NVR_BRANDS[d.brand]?.color || "#64748b";
                return (
                  <div key={i} style={{padding:10,border:`2px solid ${brandColor}33`,borderRadius:8,display:"flex",alignItems:"center",gap:10}}>
                    <span style={{fontSize:24}}>{NVR_BRANDS[d.brand]?.icon || "📡"}</span>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontWeight:800,fontSize:12,color:brandColor}}>{NVR_BRANDS[d.brand]?.label || d.brand} {d.suggested && <span style={{fontSize:9,color:"#94a3b8"}}>(추정)</span>}</div>
                      <div style={{fontSize:10,color:"#475569",fontFamily:"monospace"}}>{d.host}:{d.port} · 신뢰도 {Math.round((d.confidence||0)*100)}%</div>
                      {d.hint && <div style={{fontSize:9,color:"#94a3b8"}}>{d.hint}</div>}
                    </div>
                    {isRegistered ? (
                      <span style={{padding:"4px 10px",fontSize:10,background:"#dcfce7",color:"#065f46",borderRadius:5,fontWeight:700}}>✓ 등록됨</span>
                    ) : (
                      <button onClick={()=>register(d)} style={{padding:"5px 12px",fontSize:11,background:brandColor,color:"#fff",border:"none",borderRadius:5,cursor:"pointer",fontWeight:700}}>
                        ＋ 등록
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{marginTop:12,padding:8,background:"#eff6ff",border:"1px solid #bfdbfe",borderRadius:6,fontSize:10,color:"#1e40af"}}>
              💡 발견된 NVR을 클릭하면 자격증명 입력 모달이 자동으로 열립니다.<br/>
              SmartPSS/VMS에 사용한 동일한 계정을 입력하세요.
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── 등록/수정 모달 ────────────────────────────────────────────────
function NvrEditModal({ config, onSave, onClose }) {
  const [f, setF] = useState(config);
  const set = (k, v) => setF(prev => ({...prev, [k]: v}));
  const addChannel = () => {
    const next = [...(f.channels||[]), { ch: (f.channels?.length||0)+1, name: "" }];
    set("channels", next);
  };
  const updateChannel = (i, patch) => {
    set("channels", (f.channels||[]).map((c,j) => j===i ? {...c, ...patch} : c));
  };
  const removeChannel = (i) => {
    set("channels", (f.channels||[]).filter((_,j)=>j!==i));
  };
  const brand = NVR_BRANDS[f.brand] || NVR_BRANDS.custom;

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.6)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:14}}>
      <div style={{background:"#fff",borderRadius:12,maxWidth:680,width:"100%",maxHeight:"90vh",overflowY:"auto",padding:18}}>
        <div className="flex justify-between items-center mb-3">
          <h3 style={{fontSize:15,fontWeight:900}}>{config.id?"NVR 수정":"＋ 새 NVR/VMS 등록"}</h3>
          <button onClick={onClose} style={{background:"none",border:"none",fontSize:20,color:"#94a3b8",cursor:"pointer"}}>✕</button>
        </div>

        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <Field label="이름 *"><Inp value={f.name||""} onChange={v=>set("name",v)} placeholder="예: 본관 NVR (Dahua)"/></Field>
          <Field label="제조사/프로토콜">
            <select value={f.brand} onChange={e=>set("brand",e.target.value)}
              style={{width:"100%",padding:"8px 10px",border:"1px solid #e5e7eb",borderRadius:6,fontSize:12}}>
              {Object.entries(NVR_BRANDS).map(([k,v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
            </select>
          </Field>
          <Field label="호스트(IP) *"><Inp value={f.host||""} onChange={v=>set("host",v)} placeholder="192.168.0.100"/></Field>
          <Field label="HTTP 포트"><Inp type="number" value={f.port||80} onChange={v=>set("port",Number(v))}/></Field>
          <Field label="RTSP 포트"><Inp type="number" value={f.rtspPort||554} onChange={v=>set("rtspPort",Number(v))}/></Field>
          <Field label="사용자명"><Inp value={f.username||""} onChange={v=>set("username",v)} placeholder="admin"/></Field>
          <Field label="비밀번호"><Inp type="password" value={f.password||""} onChange={v=>set("password",v)}/></Field>
          {f.brand === "custom" && (
            <>
              <Field label="스냅샷 URL 템플릿">
                <Inp value={f.customSnapshotTemplate||""} onChange={v=>set("customSnapshotTemplate",v)}
                  placeholder="http://{user}:{pass}@{host}/snap?ch={ch}"/>
              </Field>
              <Field label="RTSP URL 템플릿">
                <Inp value={f.customRtspTemplate||""} onChange={v=>set("customRtspTemplate",v)}
                  placeholder="rtsp://{user}:{pass}@{host}/ch{ch}"/>
              </Field>
            </>
          )}
        </div>

        <div style={{marginTop:14}}>
          <div className="flex justify-between items-center mb-2">
            <span style={{fontSize:11,fontWeight:800,color:"#475569"}}>📹 채널 ({(f.channels||[]).length})</span>
            <button onClick={addChannel} style={{padding:"4px 10px",fontSize:10,background:"#dbeafe",color:"#1e40af",border:"none",borderRadius:5,cursor:"pointer",fontWeight:700}}>＋ 채널 추가</button>
          </div>
          <div style={{maxHeight:200,overflowY:"auto",border:"1px solid #e5e7eb",borderRadius:6}}>
            {(f.channels||[]).map((c, i) => (
              <div key={i} style={{display:"grid",gridTemplateColumns:"60px 1fr 60px",gap:6,padding:6,borderBottom:"1px solid #f1f5f9",alignItems:"center"}}>
                <input type="number" value={c.ch} onChange={e=>updateChannel(i,{ch:Number(e.target.value)})}
                  style={{padding:"4px 6px",border:"1px solid #e5e7eb",borderRadius:4,fontSize:11}}/>
                <input value={c.name||""} onChange={e=>updateChannel(i,{name:e.target.value})}
                  placeholder={`CH${c.ch} 이름`}
                  style={{padding:"4px 8px",border:"1px solid #e5e7eb",borderRadius:4,fontSize:11}}/>
                <button onClick={()=>removeChannel(i)} style={{padding:"4px",fontSize:10,background:"#fee2e2",color:"#dc2626",border:"none",borderRadius:4,cursor:"pointer"}}>🗑️</button>
              </div>
            ))}
          </div>
        </div>

        <div style={{marginTop:10,padding:8,background:brand.color+"11",borderRadius:6,fontSize:10,color:brand.color,lineHeight:1.5}}>
          💡 <strong>{brand.label}:</strong> {brand.notes}
        </div>

        <div style={{display:"flex",gap:6,justifyContent:"flex-end",marginTop:14}}>
          <button onClick={onClose} style={{padding:"8px 14px",background:"#f1f5f9",border:"none",borderRadius:6,fontWeight:700,fontSize:12,cursor:"pointer"}}>취소</button>
          <button onClick={()=>{
            if (!f.name?.trim()) return alert("이름은 필수입니다");
            if (!f.host?.trim()) return alert("호스트(IP)는 필수입니다");
            onSave(f);
          }}
            style={{padding:"8px 14px",background:"#0ea5e9",color:"#fff",border:"none",borderRadius:6,fontWeight:700,fontSize:12,cursor:"pointer"}}>
            💾 저장
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 연동 가이드 ────────────────────────────────────────────────────
function SetupGuide({ bridgeUrl, saveBridgeUrl }) {
  return (
    <div style={{padding:14,background:"#fff",border:"2px solid #0ea5e9",borderRadius:10,fontSize:12,lineHeight:1.7}}>
      <h3 style={{fontSize:14,fontWeight:900,color:"#0c4a6e",marginBottom:8}}>📖 SmartPSS / VMS / NVR 연동 가이드</h3>

      {/* 클라우드 권장 안내 */}
      <div style={{padding:12,background:"linear-gradient(135deg,#dbeafe,#bfdbfe)",border:"2px solid #3b82f6",borderRadius:8,marginBottom:10}}>
        <div style={{fontSize:13,fontWeight:900,color:"#1e3a8a",marginBottom:4}}>☁️ 권장: 클라우드 브릿지 사용</div>
        <div style={{fontSize:11,color:"#1e40af",lineHeight:1.6}}>
          <strong>{DEFAULT_BRIDGE}</strong>이 이미 설정되어 있습니다.
          박물관 PC에 별도 설치 없이 즉시 사용 가능합니다.
          NVR이 인터넷에 노출되어 있거나 박물관 네트워크가 VPN/포트포워딩으로 클라우드와 연결되어 있어야 작동합니다.
        </div>
        <div style={{marginTop:8,display:"flex",gap:6,alignItems:"center"}}>
          <span style={{fontSize:10,fontWeight:700,color:"#1e40af"}}>현재 브릿지:</span>
          <code style={{padding:"3px 8px",background:"#fff",borderRadius:4,fontSize:11,fontWeight:700,color:"#0c4a6e"}}>{bridgeUrl}</code>
        </div>
      </div>

      <Section icon="1️⃣" title="브라우저는 RTSP를 직접 재생할 수 없습니다" body={
        <>
          SmartPSS·VMS Client는 RTSP 스트림을 받아 디코딩하는 <strong>네이티브 Windows 앱</strong>이라
          브라우저(잠사 패널)에서 직접 스트림을 받을 수 없습니다. 두 가지 우회 방법:
          <ul style={{paddingLeft:18,marginTop:4}}>
            <li><strong>(A) HTTP 스냅샷 URL 직접 사용:</strong> Dahua/Hikvision은 HTTP로 JPG를 직접 제공.
              CORS·Mixed Content 차단 때문에 같은 네트워크 + HTTP 사이트일 때만 작동.</li>
            <li><strong>(B) 로컬 브릿지 서버 사용 (권장):</strong> 박물관 PC에 작은 Node.js 스크립트를
              띄워 NVR과 브라우저 사이에서 프록시. CORS·인증 모두 해결.</li>
          </ul>
        </>
      }/>

      <Section icon="2️⃣" title="(선택) 로컬 브릿지 설치 — 클라우드 사용 불가 시" body={
        <>
          박물관 PC(SmartPSS가 켜진 동일 PC)에서 다음 단계:
          <ol style={{paddingLeft:18,marginTop:4}}>
            <li>Node.js 설치 (<a href="https://nodejs.org" target="_blank" style={{color:"#0ea5e9"}}>nodejs.org</a>) — LTS 버전</li>
            <li>아래 스크립트를 <code>jamsa-cctv-bridge.cjs</code>로 저장:</li>
          </ol>
          <div style={{margin:"6px 0",padding:8,background:"#dcfce7",border:"1px solid #86efac",borderRadius:6,display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:20}}>⬇️</span>
            <div style={{flex:1,fontSize:10,color:"#065f46"}}>
              <strong>스크립트 다운로드:</strong> 아래 코드를 직접 복사하거나
            </div>
            <a href="/jamsa-cctv-bridge.cjs" download
              style={{padding:"6px 12px",background:"#10b981",color:"#fff",textDecoration:"none",borderRadius:5,fontSize:11,fontWeight:700}}>
              📥 jamsa-cctv-bridge.cjs 받기
            </a>
          </div>
          <pre style={{background:"#0f172a",color:"#e2e8f0",padding:10,borderRadius:6,fontSize:10,overflow:"auto",marginTop:6}}>{`// jamsa-cctv-bridge.cjs (Dahua/Hikvision/ONVIF 스냅샷 프록시)
const http = require('http');
const https = require('https');

const PORT = 5555;
const CONFIG = {
  // NVR 목록 (잠사 패널의 NVR 설정과 동일하게 입력)
  nvrs: [
    {
      brand: 'dahua', host: '192.168.0.100', port: 80, rtspPort: 554,
      username: 'admin', password: 'YOUR_PASS',
      channels: { 1: 'CH1', 2: 'CH2', /* ... */ }
    },
  ],
};

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const m = req.url.match(/^\\/api\\/snap\\/(\\d+)/);
  if (!m) {
    if (req.url === '/api/status') {
      return res.end(JSON.stringify({ ok:true, channels: Object.keys(CONFIG.nvrs[0].channels||{}) }));
    }
    res.statusCode = 404; return res.end('not found');
  }
  const ch = parseInt(m[1], 10);
  const nvr = CONFIG.nvrs[0];
  const url = nvr.brand === 'dahua'
    ? \`http://\${nvr.host}:\${nvr.port}/cgi-bin/snapshot.cgi?channel=\${ch}\`
    : \`http://\${nvr.host}:\${nvr.port}/ISAPI/Streaming/channels/\${ch}01/picture\`;
  const auth = 'Basic ' + Buffer.from(\`\${nvr.username}:\${nvr.password}\`).toString('base64');
  http.get(url, { headers: { Authorization: auth } }, upstream => {
    res.setHeader('Content-Type', 'image/jpeg');
    upstream.pipe(res);
  }).on('error', e => { res.statusCode = 502; res.end(e.message); });
}).listen(PORT, () => console.log('CCTV bridge: http://localhost:' + PORT));`}</pre>
          <ol start={3} style={{paddingLeft:18,marginTop:6}}>
            <li>NVR 정보 입력 후 터미널에서: <code style={{background:"#f1f5f9",padding:"2px 6px"}}>node jamsa-cctv-bridge.cjs</code></li>
            <li>아래 입력란에 <strong>http://localhost:5555</strong> (또는 박물관 PC LAN IP) 입력</li>
          </ol>
          <div style={{marginTop:8,display:"flex",gap:6,alignItems:"center"}}>
            <span style={{fontSize:10,fontWeight:700,color:"#475569"}}>브릿지 URL:</span>
            <input value={bridgeUrl} onChange={e=>saveBridgeUrl(e.target.value)}
              placeholder="http://localhost:5555"
              style={{flex:1,padding:"6px 10px",border:"1px solid #cbd5e1",borderRadius:6,fontSize:11}}/>
          </div>
        </>
      }/>

      <Section icon="3️⃣" title="NVR 등록 + 자동 연동" body={
        <>
          위 "＋ NVR 추가" 버튼으로 SmartPSS/VMS와 동일한 자격증명 입력:
          <ul style={{paddingLeft:18,marginTop:4}}>
            <li><strong>Dahua (SmartPSS):</strong> NVR IP, port 80, 채널 16개 (또는 실제 수)</li>
            <li><strong>VMS Client:</strong> 디바이스 시리얼(C6CSGW4...), port 9000, 동일 자격</li>
            <li><strong>채널명:</strong> SmartPSS에서 보이는 이름(외부매표소, 누에쉼터 등) 그대로</li>
          </ul>
          등록 후 통합지도 → 우상단 CCTV 라이브 패널에 자동 표시되며,
          🔴 항시작동 모드 켜면 24/7 동작합니다.
        </>
      }/>

      <Section icon="❓" title="문제 해결" body={
        <ul style={{paddingLeft:18,marginTop:4}}>
          <li><strong>스냅샷 안 옴:</strong> 브릿지 콘솔 로그 확인. NVR Web Service 활성화 상태 확인.</li>
          <li><strong>"Mixed Content" 차단:</strong> jamsa-panel은 HTTPS, NVR은 HTTP → 반드시 브릿지 경유.</li>
          <li><strong>SmartPSS 끄지 마세요:</strong> NVR 자체는 SmartPSS 없이도 응답하지만, 일부 NVR은 동시접속 제한이 있어 SmartPSS 끈 상태로 테스트 권장.</li>
          <li><strong>VMS Client port 9000:</strong> 디바이스 직접 연결 모드. NVR이 자체 호스팅하는 HTTP 서버 포트. 브릿지에서 host:9000으로 접속.</li>
        </ul>
      }/>
    </div>
  );
}

function Section({ icon, title, body }) {
  return (
    <div style={{padding:10,background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:8,marginTop:8}}>
      <div style={{fontSize:12,fontWeight:800,color:"#0f172a",marginBottom:4}}>{icon} {title}</div>
      <div style={{fontSize:11,color:"#475569"}}>{body}</div>
    </div>
  );
}

function Field({ label, children }) {
  return <div><label style={{display:"block",fontSize:10,fontWeight:700,color:"#64748b",marginBottom:4}}>{label}</label>{children}</div>;
}
function Inp({ value, onChange, placeholder, type="text" }) {
  return <input type={type} value={value||""} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
    style={{width:"100%",padding:"8px 10px",border:"1px solid #e5e7eb",borderRadius:6,fontSize:12}}/>;
}
