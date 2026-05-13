// ═══════════════════════════════════════════════════════════════════════
// 📊 종합 보고서 + 🔔 알림 채널 (Reports & Notifications)
// ─────────────────────────────────────────────────────────────────────
// - 전체 발생로그(history/audit/incidents/facActions/autoHazards)에서
//   특이사항을 추출하고 시간대별 종합 보고서를 생성한다.
// - 텔레그램 / SMS / 카카오 / 이메일 / 웹훅으로 알림을 발송한다.
//
// 저장:
//   jamsa_notif_config   — 채널 설정 + 스케줄
//   jamsa_notif_history  — 발송 이력
// ═══════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useMemo, useRef } from "react";

// ─── Storage ───────────────────────────────────────────────────────
const NOTIF_CONFIG_KEY = "jamsa_notif_config";
const NOTIF_HISTORY_KEY = "jamsa_notif_history";
const DEFAULT_CONFIG = {
  channels: {
    telegram: { enabled: false, botToken: "", chatId: "", label: "텔레그램" },
    sms:      { enabled: false, provider: "solapi", apiKey: "", apiSecret: "", from: "", to: "", label: "SMS" },
    kakao:    { enabled: false, accessToken: "", label: "카카오 (나에게 보내기)" },
    email:    { enabled: false, to: "", from: "", label: "이메일" },
    webhook:  { enabled: false, url: "", label: "웹훅 (Slack/Discord 등)" },
  },
  schedule: {
    realtime: { enabled: true, severityMin: "URGENT" }, // 즉시 발송 (긴급 이상)
    hourly:   { enabled: false, hour: null },           // 매시간 종합
    daily:    { enabled: false, time: "18:00" },        // 매일 18시 종합
    weekly:   { enabled: false, day: 1, time: "09:00" }, // 매주 월요일
  },
  filters: {
    incidents: true,
    hazards: true,
    weather: true,
    inspections: true,
    actions: true,
  },
};

const load = (k, def) => { try { return JSON.parse(localStorage.getItem(k) || JSON.stringify(def)); } catch (e) { return def; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

// ─── Anomaly detection ────────────────────────────────────────────
// 전체 로그에서 "특이사항"을 추출
// - URGENT/HIGH 항목
// - 동일 시설/주제에서 같은 시간대 3건 이상 반복
// - 점검 누락 (예: 일일 점검이 어제 미수행)
// - 날씨 경보 발생
export function detectAnomalies({ hist, audit, incidents, facActions, autoHazards, dailyChecks }, since = null) {
  const sinceMs = since ? new Date(since).getTime() : 0;
  const anomalies = [];

  // 1) URGENT/HIGH facActions
  for (const a of (facActions || [])) {
    const at = new Date(a.createdAt || a.at || 0).getTime();
    if (at < sinceMs) continue;
    if (a.priority === "high" || a.sev === "URGENT" || a.sev === "HIGH") {
      anomalies.push({
        kind: "URGENT_ACTION",
        severity: a.priority === "high" || a.sev === "URGENT" ? "URGENT" : "HIGH",
        at: a.createdAt || a.at,
        title: a.title || "긴급 보완조치",
        detail: a.facId ? `시설: ${a.facId}` : "",
        source: "facActions",
      });
    }
  }

  // 2) Incidents (사고/아차사고)
  for (const i of (incidents || [])) {
    const at = new Date(i.date || i.at || 0).getTime();
    if (at < sinceMs) continue;
    anomalies.push({
      kind: "INCIDENT",
      severity: i.severity === "SEVERE" || i.severity === "MAJOR" ? "URGENT" : "HIGH",
      at: i.date || i.at,
      title: i.title || "사고 기록",
      detail: i.description?.slice(0, 100) || "",
      source: "incidents",
    });
  }

  // 3) 자동감지 hazard (active)
  for (const h of (autoHazards || [])) {
    if (h.status !== "active") continue;
    const at = new Date(h.detectedAt || 0).getTime();
    if (at < sinceMs) continue;
    anomalies.push({
      kind: "AUTO_HAZARD",
      severity: h.severity || "MEDIUM",
      at: h.detectedAt,
      title: h.title,
      detail: h.desc,
      source: h.source,
    });
  }

  // 4) 반복 패턴 — 동일 facId에서 24시간 내 3건 이상
  const byFac = {};
  for (const a of (facActions || [])) {
    const at = new Date(a.createdAt || a.at || 0).getTime();
    if (at < sinceMs || !a.facId) continue;
    byFac[a.facId] = (byFac[a.facId] || []).concat(a);
  }
  for (const [facId, items] of Object.entries(byFac)) {
    if (items.length >= 3) {
      anomalies.push({
        kind: "REPEATED_PATTERN",
        severity: "MEDIUM",
        at: items[items.length-1].createdAt || items[items.length-1].at,
        title: `반복 패턴 감지: ${facId}`,
        detail: `같은 시설에서 ${items.length}건 발생`,
        source: "pattern",
      });
    }
  }

  // 5) 점검 누락 (오늘 일일 점검 없음)
  const todayKey = new Date().toISOString().slice(0,10);
  const todayChecks = (dailyChecks || []).filter(c => (c.date || c.at || "").startsWith(todayKey));
  if (todayChecks.length === 0 && (dailyChecks || []).length > 0) {
    anomalies.push({
      kind: "MISSED_INSPECTION",
      severity: "MEDIUM",
      at: new Date().toISOString(),
      title: "오늘 일일 점검 미수행",
      detail: `${todayKey} 점검 기록 없음`,
      source: "checklist",
    });
  }

  return anomalies.sort((a,b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

// ─── 시간대별 집계 ─────────────────────────────────────────────────
// rangeHours: 직전 N시간 동안의 이벤트를 1시간 단위 또는 자동 단위로 버킷팅
export function generateTimeReport({ hist = [], audit = [], incidents = [], facActions = [], autoHazards = [], dailyChecks = [], rangeHours = 24 }) {
  const now = Date.now();
  const sinceMs = now - rangeHours * 3600000;
  const bucketSize = rangeHours <= 6 ? 1 : rangeHours <= 48 ? 1 : rangeHours <= 168 ? 6 : 24; // 시간 단위
  const bucketCount = Math.ceil(rangeHours / bucketSize);
  const buckets = Array.from({ length: bucketCount }, (_, i) => ({
    label: bucketLabel(now - (bucketCount - i) * bucketSize * 3600000, bucketSize),
    startMs: now - (bucketCount - i) * bucketSize * 3600000,
    counts: { hist:0, audit:0, incident:0, action:0, hazard:0, check:0 },
    items: [],
  }));

  function placeIn(evtMs, item) {
    if (evtMs < sinceMs || evtMs > now) return;
    const idx = Math.floor((evtMs - (now - rangeHours * 3600000)) / (bucketSize * 3600000));
    const b = buckets[Math.min(idx, buckets.length - 1)];
    if (!b) return;
    b.counts[item._kind] = (b.counts[item._kind] || 0) + 1;
    b.items.push(item);
  }

  for (const h of hist) placeIn(new Date(h.date || h.at || 0).getTime(), { _kind:"hist", ...h });
  for (const a of audit) placeIn(new Date(a.at || a.createdAt || 0).getTime(), { _kind:"audit", ...a });
  for (const i of incidents) placeIn(new Date(i.date || i.at || 0).getTime(), { _kind:"incident", ...i });
  for (const f of facActions) placeIn(new Date(f.createdAt || f.at || 0).getTime(), { _kind:"action", ...f });
  for (const h of autoHazards) placeIn(new Date(h.detectedAt || 0).getTime(), { _kind:"hazard", ...h });
  for (const c of dailyChecks) placeIn(new Date(c.date || c.at || 0).getTime(), { _kind:"check", ...c });

  const totals = buckets.reduce((acc, b) => {
    for (const [k,v] of Object.entries(b.counts)) acc[k] = (acc[k]||0) + v;
    return acc;
  }, {});

  return { buckets, totals, since: new Date(sinceMs).toISOString(), now: new Date(now).toISOString(), rangeHours };
}

function bucketLabel(ms, sizeHours) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  if (sizeHours >= 24) {
    const mm = String(d.getMonth()+1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${mm}/${dd}`;
  }
  return `${hh}시`;
}

// ─── 텍스트 포맷터 ─────────────────────────────────────────────────
export function formatReportMessage({ anomalies, report, label = "종합 보고" }) {
  const lines = [];
  lines.push(`🏛️ *한국잠사박물관 ${label}*`);
  lines.push(`📅 ${new Date().toLocaleString("ko-KR")}`);
  lines.push("");

  if (anomalies.length === 0) {
    lines.push("✅ 특이사항 없음");
  } else {
    lines.push(`🚨 *특이사항 ${anomalies.length}건*`);
    for (const a of anomalies.slice(0, 10)) {
      const ico = a.severity === "URGENT" ? "🔴" : a.severity === "HIGH" ? "🟠" : "🟡";
      lines.push(`${ico} ${a.title}`);
      if (a.detail) lines.push(`   ${a.detail}`);
    }
    if (anomalies.length > 10) lines.push(`   ... 외 ${anomalies.length - 10}건`);
  }

  if (report) {
    lines.push("");
    lines.push(`📊 *최근 ${report.rangeHours}시간 활동*`);
    lines.push(`사고 ${report.totals.incident||0} · 보완조치 ${report.totals.action||0} · 자동감지 ${report.totals.hazard||0} · 점검 ${report.totals.check||0} · 활동 ${report.totals.hist||0}`);
  }

  lines.push("");
  lines.push("💻 https://jamsa-panel.vercel.app");
  return lines.join("\n");
}

// ─── 발송 (서버 경유) ──────────────────────────────────────────────
export async function sendNotification({ channel, config, message }) {
  try {
    const fetcher = window.authFetch || ((p, o) => fetch(p, o));
    const res = await fetcher("/api/notify-send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, config, message }),
    });
    const data = await res.json();
    return { ok: res.ok && data.ok, ...data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── 메인 UI ───────────────────────────────────────────────────────
export function ReportsNotificationsPage({ hist = [], audit = [], incidents = [], facActions = [], autoHazards = [], dailyChecks = [], curUser }) {
  const [tab, setTab] = useState("report"); // report | channels | history
  const [config, setConfig] = useState(load(NOTIF_CONFIG_KEY, DEFAULT_CONFIG));
  const [history, setHistory] = useState(load(NOTIF_HISTORY_KEY, []));
  useEffect(() => save(NOTIF_CONFIG_KEY, config), [config]);
  useEffect(() => save(NOTIF_HISTORY_KEY, history), [history]);

  const [rangeHours, setRangeHours] = useState(24);
  const report = useMemo(() => generateTimeReport({ hist, audit, incidents, facActions, autoHazards, dailyChecks, rangeHours }), [hist, audit, incidents, facActions, autoHazards, dailyChecks, rangeHours]);
  const since = new Date(Date.now() - rangeHours * 3600000).toISOString();
  const anomalies = useMemo(() => detectAnomalies({ hist, audit, incidents, facActions, autoHazards, dailyChecks }, since), [hist, audit, incidents, facActions, autoHazards, dailyChecks, since]);

  const formattedMessage = useMemo(() => formatReportMessage({ anomalies, report, label: `${rangeHours}시간 종합 보고` }), [anomalies, report, rangeHours]);

  // 발송 핸들러
  const [sending, setSending] = useState(false);
  const sendNow = async (channelKeys) => {
    if (!channelKeys || channelKeys.length === 0) {
      channelKeys = Object.entries(config.channels).filter(([k,v]) => v.enabled).map(([k]) => k);
    }
    if (channelKeys.length === 0) { alert("⚠️ 활성화된 알림 채널이 없습니다. '알림 설정' 탭에서 채널을 켜주세요."); return; }
    setSending(true);
    const results = [];
    for (const key of channelKeys) {
      const ch = config.channels[key];
      if (!ch?.enabled) continue;
      const res = await sendNotification({ channel: key, config: ch, message: formattedMessage });
      results.push({ channel: key, ...res, at: new Date().toISOString() });
    }
    setHistory(arr => [{ id: Date.now(), at: new Date().toISOString(), message: formattedMessage, results }, ...arr].slice(0, 100));
    setSending(false);
    const okCount = results.filter(r => r.ok).length;
    const failCount = results.length - okCount;
    alert(`📨 발송 완료: ${okCount}건 성공${failCount > 0 ? ` / ${failCount}건 실패` : ""}`);
  };

  // 스케줄러 (실시간 / 시간별 / 일간 / 주간) — 클라이언트 setInterval
  useScheduleEffect({ config, anomalies, report, formattedMessage, onSent: (item) => setHistory(arr => [item, ...arr].slice(0, 100)) });

  return (
    <div className="space-y-4">
      <div className="bg-gradient-to-r from-purple-50 to-pink-50 border border-purple-200 rounded-xl p-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-base font-black text-purple-900">📊 종합 보고서 + 🔔 알림 채널</h2>
            <div className="text-xs text-purple-700 mt-1">전체 발생로그에서 특이사항을 추출해 시간대별 보고서를 만들고, 텔레그램·SMS·이메일·웹훅으로 자동 전송합니다.</div>
          </div>
        </div>
      </div>

      <div className="flex gap-1 border-b-2 border-gray-200">
        {[["report","📊 보고서"],["channels","🔔 알림 설정"],["history","📜 발송 이력"]].map(([k,l]) => (
          <button key={k} onClick={()=>setTab(k)}
            className={`px-4 py-2 text-xs font-bold rounded-t-lg ${tab===k?"bg-purple-600 text-white":"text-gray-600 hover:bg-gray-100"}`}>{l}</button>
        ))}
      </div>

      {tab === "report" && (
        <ReportTab report={report} anomalies={anomalies} message={formattedMessage}
          rangeHours={rangeHours} setRangeHours={setRangeHours}
          onSend={sendNow} sending={sending} config={config}/>
      )}
      {tab === "channels" && (
        <ChannelsTab config={config} setConfig={setConfig} onTest={async (channelKey) => {
          const testMsg = `🧪 테스트 메시지\n${new Date().toLocaleString("ko-KR")}\n한국잠사박물관 알림 채널 정상 작동 확인.`;
          const res = await sendNotification({ channel: channelKey, config: config.channels[channelKey], message: testMsg });
          alert(res.ok ? `✅ ${channelKey} 발송 성공` : `❌ 실패: ${res.error || res.message || "알 수 없음"}`);
        }}/>
      )}
      {tab === "history" && (
        <HistoryTab history={history} onClear={()=>{ if(confirm("이력 전체 삭제?")) setHistory([]); }}/>
      )}
    </div>
  );
}

// ─── 스케줄러 hook ─────────────────────────────────────────────────
function useScheduleEffect({ config, anomalies, report, formattedMessage, onSent }) {
  const sentRealtimeRef = useRef(new Set()); // 이미 발송한 anomaly 키
  const lastHourlyRef = useRef(0);
  const lastDailyRef = useRef("");
  const lastWeeklyRef = useRef("");

  useEffect(() => {
    const interval = setInterval(async () => {
      const enabledChannels = Object.entries(config.channels).filter(([k,v]) => v.enabled);
      if (enabledChannels.length === 0) return;

      const now = new Date();

      // 실시간: 새 URGENT/HIGH anomaly만
      if (config.schedule?.realtime?.enabled) {
        const sevMin = config.schedule.realtime.severityMin || "URGENT";
        const severityRank = { URGENT: 3, HIGH: 2, MEDIUM: 1, LOW: 0 };
        const minRank = severityRank[sevMin] ?? 3;
        for (const a of anomalies) {
          const rank = severityRank[a.severity] ?? 0;
          if (rank < minRank) continue;
          const key = `${a.kind}:${a.at}:${a.title}`;
          if (sentRealtimeRef.current.has(key)) continue;
          sentRealtimeRef.current.add(key);
          const msg = `🚨 *긴급 알림* ${a.severity}\n${a.title}\n${a.detail || ""}\n${new Date(a.at).toLocaleString("ko-KR")}`;
          const results = [];
          for (const [k, ch] of enabledChannels) {
            const r = await sendNotification({ channel: k, config: ch, message: msg });
            results.push({ channel: k, ...r, at: new Date().toISOString() });
          }
          onSent?.({ id: Date.now(), at: new Date().toISOString(), message: msg, results, type: "realtime" });
        }
      }

      // 매시간
      if (config.schedule?.hourly?.enabled && now.getMinutes() < 2) {
        const hourKey = now.toISOString().slice(0,13); // YYYY-MM-DDTHH
        if (lastHourlyRef.current !== hourKey) {
          lastHourlyRef.current = hourKey;
          const results = [];
          for (const [k, ch] of enabledChannels) {
            const r = await sendNotification({ channel: k, config: ch, message: formattedMessage });
            results.push({ channel: k, ...r });
          }
          onSent?.({ id: Date.now(), at: new Date().toISOString(), message: formattedMessage, results, type: "hourly" });
        }
      }

      // 매일 (지정 시간 ±2분)
      if (config.schedule?.daily?.enabled) {
        const [hh, mm] = (config.schedule.daily.time || "18:00").split(":").map(Number);
        if (now.getHours() === hh && Math.abs(now.getMinutes() - mm) < 2) {
          const dayKey = now.toISOString().slice(0,10);
          if (lastDailyRef.current !== dayKey) {
            lastDailyRef.current = dayKey;
            const results = [];
            for (const [k, ch] of enabledChannels) {
              const r = await sendNotification({ channel: k, config: ch, message: formattedMessage });
              results.push({ channel: k, ...r });
            }
            onSent?.({ id: Date.now(), at: new Date().toISOString(), message: formattedMessage, results, type: "daily" });
          }
        }
      }

      // 매주 (지정 요일 + 시간)
      if (config.schedule?.weekly?.enabled) {
        const targetDay = config.schedule.weekly.day ?? 1;
        const [hh, mm] = (config.schedule.weekly.time || "09:00").split(":").map(Number);
        if (now.getDay() === targetDay && now.getHours() === hh && Math.abs(now.getMinutes() - mm) < 2) {
          const weekKey = `${now.getFullYear()}-W${getWeek(now)}`;
          if (lastWeeklyRef.current !== weekKey) {
            lastWeeklyRef.current = weekKey;
            const results = [];
            for (const [k, ch] of enabledChannels) {
              const r = await sendNotification({ channel: k, config: ch, message: formattedMessage });
              results.push({ channel: k, ...r });
            }
            onSent?.({ id: Date.now(), at: new Date().toISOString(), message: formattedMessage, results, type: "weekly" });
          }
        }
      }
    }, 60 * 1000); // 매분 체크
    return () => clearInterval(interval);
  }, [config, anomalies, report, formattedMessage]);
}

function getWeek(d) {
  const onejan = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d - onejan) / 86400000 + onejan.getDay() + 1) / 7);
}

// ─── 보고서 탭 ─────────────────────────────────────────────────────
function ReportTab({ report, anomalies, message, rangeHours, setRangeHours, onSend, sending, config }) {
  const enabledChannels = Object.entries(config.channels).filter(([k,v]) => v.enabled);
  const maxBucketCount = Math.max(1, ...report.buckets.map(b => Object.values(b.counts).reduce((s,v)=>s+v, 0)));
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-bold text-gray-600">기간:</span>
        {[[6,"6h"],[24,"24h"],[72,"3일"],[168,"1주"],[720,"1개월"]].map(([h,l]) => (
          <button key={h} onClick={()=>setRangeHours(h)}
            className={`px-3 py-1 text-xs font-bold rounded ${rangeHours===h?"bg-purple-600 text-white":"bg-white border text-gray-600"}`}>{l}</button>
        ))}
      </div>

      {/* 특이사항 */}
      <div className="bg-white border-2 border-gray-200 rounded-xl p-4">
        <div className="text-sm font-black mb-3">🚨 특이사항 ({anomalies.length})</div>
        {anomalies.length === 0 ? (
          <div className="text-center py-6 text-xs text-emerald-700 bg-emerald-50 rounded">
            ✅ 최근 {rangeHours}시간 동안 특이사항 없음
          </div>
        ) : (
          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {anomalies.map((a, i) => {
              const colors = { URGENT:"bg-red-50 border-red-300 text-red-900", HIGH:"bg-orange-50 border-orange-300 text-orange-900", MEDIUM:"bg-yellow-50 border-yellow-300 text-yellow-900", LOW:"bg-gray-50 border-gray-300 text-gray-700" };
              return (
                <div key={i} className={`border-l-4 rounded px-3 py-2 ${colors[a.severity] || colors.LOW}`}>
                  <div className="flex items-center gap-2 text-xs font-bold">
                    <span>{a.severity === "URGENT" ? "🔴" : a.severity === "HIGH" ? "🟠" : "🟡"}</span>
                    <span className="flex-1">{a.title}</span>
                    <span className="text-[10px] opacity-70">{new Date(a.at).toLocaleString("ko-KR", {month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})}</span>
                  </div>
                  {a.detail && <div className="text-[10px] opacity-80 mt-0.5">{a.detail}</div>}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 시간대별 차트 */}
      <div className="bg-white border-2 border-gray-200 rounded-xl p-4">
        <div className="text-sm font-black mb-3">📊 시간대별 발생 추이</div>
        <div className="flex items-end gap-1 h-32 border-b border-l border-gray-200 p-1">
          {report.buckets.map((b, i) => {
            const total = Object.values(b.counts).reduce((s,v)=>s+v, 0);
            const hMax = (total / maxBucketCount) * 100;
            return (
              <div key={i} className="flex-1 flex flex-col items-center justify-end h-full group relative" title={`${b.label} · ${total}건`}>
                <div className="w-full flex flex-col justify-end" style={{height:`${hMax}%`}}>
                  {b.counts.incident > 0 && <div className="bg-red-500" style={{height:`${(b.counts.incident/total)*100}%`,minHeight:"2px"}}/>}
                  {b.counts.hazard > 0 && <div className="bg-orange-500" style={{height:`${(b.counts.hazard/total)*100}%`,minHeight:"2px"}}/>}
                  {b.counts.action > 0 && <div className="bg-blue-500" style={{height:`${(b.counts.action/total)*100}%`,minHeight:"2px"}}/>}
                  {b.counts.check > 0 && <div className="bg-emerald-500" style={{height:`${(b.counts.check/total)*100}%`,minHeight:"2px"}}/>}
                  {b.counts.hist > 0 && <div className="bg-gray-400" style={{height:`${(b.counts.hist/total)*100}%`,minHeight:"2px"}}/>}
                </div>
                <div className="text-[8px] text-gray-500 mt-1 truncate w-full text-center">{b.label}</div>
              </div>
            );
          })}
        </div>
        <div className="flex gap-3 mt-2 text-[10px]">
          <span><span className="inline-block w-3 h-3 bg-red-500 mr-1 align-middle"/>사고 {report.totals.incident||0}</span>
          <span><span className="inline-block w-3 h-3 bg-orange-500 mr-1 align-middle"/>자동감지 {report.totals.hazard||0}</span>
          <span><span className="inline-block w-3 h-3 bg-blue-500 mr-1 align-middle"/>보완조치 {report.totals.action||0}</span>
          <span><span className="inline-block w-3 h-3 bg-emerald-500 mr-1 align-middle"/>점검 {report.totals.check||0}</span>
          <span><span className="inline-block w-3 h-3 bg-gray-400 mr-1 align-middle"/>활동 {report.totals.hist||0}</span>
        </div>
      </div>

      {/* 보고서 미리보기 + 발송 */}
      <div className="bg-white border-2 border-gray-200 rounded-xl p-4">
        <div className="text-sm font-black mb-2">📝 발송될 메시지 미리보기</div>
        <pre className="text-[11px] bg-gray-50 p-3 rounded border whitespace-pre-wrap font-mono">{message}</pre>
        <div className="flex flex-wrap gap-2 mt-3 items-center justify-between">
          <div className="text-[10px] text-gray-500">
            {enabledChannels.length > 0
              ? `활성 채널: ${enabledChannels.map(([k,v]) => v.label).join(", ")}`
              : "⚠️ 활성 채널 없음 — 알림 설정 탭에서 채널을 켜세요"}
          </div>
          <div className="flex gap-2">
            <button onClick={()=>navigator.clipboard?.writeText(message).then(()=>alert("📋 클립보드 복사 완료"))}
              className="px-3 py-1.5 text-xs font-bold bg-gray-100 rounded">📋 복사</button>
            <button disabled={sending || enabledChannels.length===0} onClick={()=>onSend()}
              className="px-4 py-1.5 text-xs font-bold bg-purple-600 text-white rounded disabled:opacity-50">
              {sending ? "📤 발송 중..." : `📨 지금 발송 (${enabledChannels.length}채널)`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── 채널 설정 탭 ──────────────────────────────────────────────────
function ChannelsTab({ config, setConfig, onTest }) {
  const updateChannel = (key, patch) => {
    setConfig(c => ({ ...c, channels: { ...c.channels, [key]: { ...c.channels[key], ...patch } } }));
  };
  const updateSchedule = (key, patch) => {
    setConfig(c => ({ ...c, schedule: { ...c.schedule, [key]: { ...c.schedule[key], ...patch } } }));
  };

  return (
    <div className="space-y-4">
      {/* Telegram */}
      <ChannelCard title="💬 텔레그램" subtitle="권장 · 무료 · 즉시 설정" enabled={config.channels.telegram.enabled}
        onToggle={(v) => updateChannel("telegram", { enabled: v })}
        onTest={() => onTest("telegram")}>
        <Field label="Bot Token">
          <Inp value={config.channels.telegram.botToken} onChange={v => updateChannel("telegram", { botToken: v })}
            placeholder="123456:ABC... (@BotFather에서 발급)"/>
        </Field>
        <Field label="Chat ID">
          <Inp value={config.channels.telegram.chatId} onChange={v => updateChannel("telegram", { chatId: v })}
            placeholder="-100123... 또는 개인 ID"/>
        </Field>
        <details className="text-[10px] text-gray-600">
          <summary className="cursor-pointer font-bold">📖 설정 방법 (1분)</summary>
          <ol className="list-decimal pl-5 mt-2 space-y-1 leading-relaxed">
            <li>텔레그램에서 <strong>@BotFather</strong> 검색 → /newbot → 봇 이름 지정 → <strong>토큰 복사</strong></li>
            <li>방금 만든 봇과 채팅 시작 (아무 메시지 전송)</li>
            <li>브라우저에서 <code className="bg-gray-100 px-1">https://api.telegram.org/bot[토큰]/getUpdates</code> 접속</li>
            <li>"chat":&#123;"id": <strong>숫자</strong>&#125; 부분의 숫자가 Chat ID</li>
          </ol>
        </details>
      </ChannelCard>

      {/* SMS */}
      <ChannelCard title="📱 SMS (Solapi)" subtitle="국내 SMS · 유료 · API 키 필요" enabled={config.channels.sms.enabled}
        onToggle={(v) => updateChannel("sms", { enabled: v })}
        onTest={() => onTest("sms")}>
        <div className="grid grid-cols-2 gap-2">
          <Field label="API Key"><Inp value={config.channels.sms.apiKey} onChange={v => updateChannel("sms", { apiKey: v })} placeholder="NCSXX..."/></Field>
          <Field label="API Secret"><Inp value={config.channels.sms.apiSecret} onChange={v => updateChannel("sms", { apiSecret: v })} type="password"/></Field>
          <Field label="발신 번호"><Inp value={config.channels.sms.from} onChange={v => updateChannel("sms", { from: v })} placeholder="01012345678"/></Field>
          <Field label="수신 번호"><Inp value={config.channels.sms.to} onChange={v => updateChannel("sms", { to: v })} placeholder="01087654321"/></Field>
        </div>
        <div className="text-[10px] text-gray-600 mt-2">💡 <a href="https://solapi.com" target="_blank" className="text-blue-600 underline">solapi.com</a> 가입 → API Key 발급 → 발신번호 사전 등록 필요</div>
      </ChannelCard>

      {/* KakaoTalk */}
      <ChannelCard title="💛 카카오톡 (나에게 보내기)" subtitle="개인 발송 전용 · OAuth 필요" enabled={config.channels.kakao.enabled}
        onToggle={(v) => updateChannel("kakao", { enabled: v })}
        onTest={() => onTest("kakao")}>
        <Field label="Access Token (24h 유효)">
          <Inp value={config.channels.kakao.accessToken} onChange={v => updateChannel("kakao", { accessToken: v })} placeholder="kakao OAuth access token"/>
        </Field>
        <div className="text-[10px] text-gray-600 mt-2 leading-relaxed">
          ⚠️ 카카오 알림톡(비즈)은 사업자 등록이 필요해 복잡합니다.<br/>
          <strong>대안:</strong> "나에게 보내기" API 사용 — <a href="https://developers.kakao.com/console" target="_blank" className="text-blue-600 underline">카카오 디벨로퍼스</a>에서 앱 생성 후 talk_message 권한으로 OAuth 인증 → access token 발급.<br/>
          토큰은 24시간 유효하므로 자주 갱신 필요. <strong>장기 운영은 텔레그램 권장.</strong>
        </div>
      </ChannelCard>

      {/* Email */}
      <ChannelCard title="📧 이메일 (Resend)" subtitle="HTML 메일 · 무료 100통/일" enabled={config.channels.email.enabled}
        onToggle={(v) => updateChannel("email", { enabled: v })}
        onTest={() => onTest("email")}>
        <div className="grid grid-cols-2 gap-2">
          <Field label="수신 이메일"><Inp value={config.channels.email.to} onChange={v => updateChannel("email", { to: v })} placeholder="manager@example.com"/></Field>
          <Field label="발신 이메일"><Inp value={config.channels.email.from} onChange={v => updateChannel("email", { from: v })} placeholder="noreply@jamsa.kr"/></Field>
        </div>
        <div className="text-[10px] text-gray-600 mt-2">💡 서버 환경변수 <code>RESEND_API_KEY</code> 설정 필요 (관리자에게 요청)</div>
      </ChannelCard>

      {/* Webhook */}
      <ChannelCard title="🪝 웹훅 (Slack/Discord/n8n)" subtitle="가장 유연 · 어떤 서비스든" enabled={config.channels.webhook.enabled}
        onToggle={(v) => updateChannel("webhook", { enabled: v })}
        onTest={() => onTest("webhook")}>
        <Field label="Webhook URL">
          <Inp value={config.channels.webhook.url} onChange={v => updateChannel("webhook", { url: v })}
            placeholder="https://hooks.slack.com/services/... 또는 Discord webhook"/>
        </Field>
        <div className="text-[10px] text-gray-600 mt-2">💡 메시지는 POST 본문에 <code>&#123;text: "..."&#125;</code> 형태로 전송됩니다.</div>
      </ChannelCard>

      {/* 스케줄 */}
      <div className="bg-white border-2 border-gray-200 rounded-xl p-4">
        <div className="text-sm font-black mb-3">⏰ 발송 스케줄</div>
        <div className="space-y-3 text-xs">
          <ScheduleRow label="🚨 실시간 (긴급)" enabled={config.schedule.realtime.enabled}
            onToggle={(v) => updateSchedule("realtime", { enabled: v })}>
            <select value={config.schedule.realtime.severityMin || "URGENT"}
              onChange={e => updateSchedule("realtime", { severityMin: e.target.value })}
              className="ml-2 px-2 py-1 border rounded text-xs">
              <option value="URGENT">URGENT 이상만</option>
              <option value="HIGH">HIGH 이상</option>
              <option value="MEDIUM">MEDIUM 이상</option>
            </select>
          </ScheduleRow>
          <ScheduleRow label="🕐 매시간" enabled={config.schedule.hourly.enabled}
            onToggle={(v) => updateSchedule("hourly", { enabled: v })}/>
          <ScheduleRow label="📅 매일" enabled={config.schedule.daily.enabled}
            onToggle={(v) => updateSchedule("daily", { enabled: v })}>
            <input type="time" value={config.schedule.daily.time || "18:00"}
              onChange={e => updateSchedule("daily", { time: e.target.value })}
              className="ml-2 px-2 py-1 border rounded text-xs"/>
          </ScheduleRow>
          <ScheduleRow label="📆 매주" enabled={config.schedule.weekly.enabled}
            onToggle={(v) => updateSchedule("weekly", { enabled: v })}>
            <select value={config.schedule.weekly.day ?? 1} onChange={e => updateSchedule("weekly", { day: Number(e.target.value) })}
              className="ml-2 px-2 py-1 border rounded text-xs">
              {["일","월","화","수","목","금","토"].map((d,i) => <option key={i} value={i}>{d}요일</option>)}
            </select>
            <input type="time" value={config.schedule.weekly.time || "09:00"}
              onChange={e => updateSchedule("weekly", { time: e.target.value })}
              className="ml-2 px-2 py-1 border rounded text-xs"/>
          </ScheduleRow>
        </div>
        <div className="text-[10px] text-gray-500 mt-3 leading-relaxed">
          ⚠️ <strong>주의:</strong> 스케줄러는 패널이 브라우저에서 열려 있을 때만 동작합니다.
          24/7 무인 운영이 필요하면 Vercel Cron Jobs를 별도로 설정해주세요.
        </div>
      </div>
    </div>
  );
}

function ChannelCard({ title, subtitle, enabled, onToggle, onTest, children }) {
  return (
    <div className={`border-2 rounded-xl p-4 ${enabled?"border-purple-300 bg-purple-50/30":"border-gray-200 bg-white"}`}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-sm font-black">{title}</div>
          <div className="text-[10px] text-gray-600">{subtitle}</div>
        </div>
        <div className="flex gap-2">
          {enabled && <button onClick={onTest} className="px-3 py-1 text-[10px] font-bold bg-emerald-600 text-white rounded">🧪 테스트 발송</button>}
          <Toggle checked={enabled} onChange={onToggle}/>
        </div>
      </div>
      {enabled && <div className="space-y-2">{children}</div>}
    </div>
  );
}

function ScheduleRow({ label, enabled, onToggle, children }) {
  return (
    <div className="flex items-center gap-2">
      <Toggle checked={enabled} onChange={onToggle}/>
      <span className="font-bold flex-1">{label}</span>
      {enabled && children}
    </div>
  );
}

function Toggle({ checked, onChange }) {
  return (
    <button onClick={() => onChange(!checked)} className={`relative w-10 h-5 rounded-full transition ${checked?"bg-purple-600":"bg-gray-300"}`}>
      <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition ${checked?"left-5":"left-0.5"}`}/>
    </button>
  );
}

function Field({ label, children }) {
  return <div><label className="block text-[10px] font-bold text-gray-500 mb-1">{label}</label>{children}</div>;
}
function Inp({ value, onChange, placeholder, type="text" }) {
  return <input type={type} value={value||""} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
    className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs"/>;
}

// ─── 발송 이력 탭 ──────────────────────────────────────────────────
function HistoryTab({ history, onClear }) {
  if (history.length === 0) {
    return <div className="text-center py-12 text-gray-400 text-sm">발송 이력이 없습니다</div>;
  }
  return (
    <div>
      <div className="flex justify-end mb-2">
        <button onClick={onClear} className="px-3 py-1 text-[10px] bg-red-50 text-red-600 font-bold rounded">🗑️ 이력 삭제</button>
      </div>
      <div className="space-y-2">
        {history.map(h => (
          <div key={h.id} className="border-2 border-gray-200 rounded-xl p-3 bg-white">
            <div className="flex items-center justify-between text-[11px] mb-2">
              <span className="font-bold">{new Date(h.at).toLocaleString("ko-KR")}</span>
              <div className="flex gap-1">
                {h.results?.map((r, i) => (
                  <span key={i} className={`px-2 py-0.5 rounded text-[9px] font-bold ${r.ok?"bg-emerald-100 text-emerald-800":"bg-red-100 text-red-800"}`}>
                    {r.ok ? "✓" : "✗"} {r.channel}
                  </span>
                ))}
                {h.type && <span className="px-2 py-0.5 rounded text-[9px] font-bold bg-gray-100">{h.type}</span>}
              </div>
            </div>
            <pre className="text-[10px] bg-gray-50 p-2 rounded whitespace-pre-wrap font-mono max-h-24 overflow-y-auto">{h.message}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}
