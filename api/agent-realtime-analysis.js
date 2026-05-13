// api/agent-realtime-analysis.js
// Browser-side operating data snapshot -> server-side agent analysis.

function countBy(items = [], getter = x => x) {
  return items.reduce((acc, item) => {
    const key = getter(item) || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function normalizeDate(value) {
  const t = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;
}

function buildFindings(snapshot = {}) {
  const facActions = Array.isArray(snapshot.facActions) ? snapshot.facActions : [];
  const inventory = Array.isArray(snapshot.inventory) ? snapshot.inventory : [];
  const requisitions = Array.isArray(snapshot.requisitions) ? snapshot.requisitions : [];
  const incidents = Array.isArray(snapshot.incidents) ? snapshot.incidents : [];
  const worklogs = Array.isArray(snapshot.worklogs) ? snapshot.worklogs : [];
  const auditLog = Array.isArray(snapshot.auditLog) ? snapshot.auditLog : [];

  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const openActions = facActions.filter(a => a.status !== "DONE" && a.status !== "완료");
  const urgentActions = openActions.filter(a => ["URGENT", "HIGH", "긴급"].includes(a.sev || a.severity || a.priority));
  const overdueActions = openActions.filter(a => a.due && normalizeDate(a.due) < now);
  const lowStock = inventory.filter(p => Number(p.qty ?? p.quantity ?? 0) <= Number(p.min ?? p.minQty ?? p.safeQty ?? 0));
  const zeroStock = inventory.filter(p => Number(p.qty ?? p.quantity ?? 0) <= 0);
  const activeReqs = requisitions.filter(r => !["DONE", "완료", "CANCELLED", "취소"].includes(r.status));
  const recentIncidents = incidents
    .filter(i => now - normalizeDate(i.at || i.date || i.createdAt) < 7 * 24 * 60 * 60 * 1000)
    .sort((a, b) => normalizeDate(b.at || b.date || b.createdAt) - normalizeDate(a.at || a.date || a.createdAt));
  const todayWorklog = worklogs.some(w => String(w.at || w.date || w.createdAt || "").slice(0, 10) === today);
  const recentAudits = auditLog.filter(a => now - normalizeDate(a.at || a.createdAt) < 24 * 60 * 60 * 1000);

  const findings = [];
  if (overdueActions.length) findings.push({ severity: "CRITICAL", area: "facility", title: "기한 초과 보완과제", detail: `${overdueActions.length}건이 기한을 넘겼습니다.`, action: "시설점검 탭에서 담당자와 완료 예정일을 즉시 확인하세요." });
  if (urgentActions.length) findings.push({ severity: "HIGH", area: "facility", title: "긴급 시설 조치", detail: `${urgentActions.length}건의 긴급/상위 보완과제가 열려 있습니다.`, action: "긴급 항목을 우선 처리하고 업무일지에 조치 근거를 남기세요." });
  if (zeroStock.length) findings.push({ severity: "CRITICAL", area: "inventory", title: "재고 0개 품목", detail: `${zeroStock.length}개 품목이 소진 상태입니다.`, action: "사용 예정 업무와 예약을 확인하고 대체품 또는 긴급 발주를 진행하세요." });
  if (lowStock.length) findings.push({ severity: "HIGH", area: "inventory", title: "최소수량 이하 재고", detail: `${lowStock.length}개 품목이 기준 이하입니다.`, action: "재고관리 탭에서 입고/품의 진행 상태를 확인하세요." });
  if (activeReqs.length) findings.push({ severity: "MEDIUM", area: "inventory", title: "진행 중 요청서", detail: `${activeReqs.length}건의 요청서가 열려 있습니다.`, action: "승인, 결제, 입고 단계 중 어디에서 멈췄는지 확인하세요." });
  if (recentIncidents.length) findings.push({ severity: "HIGH", area: "safety", title: "최근 안전 사고 기록", detail: `최근 7일 내 사고/아차사고 ${recentIncidents.length}건이 있습니다.`, action: "사고 장소 재점검과 재발 방지 보완과제를 연결하세요." });
  if (!todayWorklog) findings.push({ severity: "MEDIUM", area: "worklog", title: "오늘 업무일지 미작성", detail: "당일 운영 기록이 아직 저장되지 않았습니다.", action: "통합 업무일지에서 일간 점검표를 저장하세요." });
  if (recentAudits.length === 0) findings.push({ severity: "LOW", area: "audit", title: "최근 활동 기록 없음", detail: "24시간 내 주요 실행 로그가 없습니다.", action: "실제 조치 후 활동 기록과 업무일지를 남겨 운영 증빙을 유지하세요." });

  const critical = findings.filter(f => f.severity === "CRITICAL").length;
  const high = findings.filter(f => f.severity === "HIGH").length;
  const medium = findings.filter(f => f.severity === "MEDIUM").length;
  const riskScore = Math.min(100, critical * 30 + high * 18 + medium * 9 + findings.filter(f => f.severity === "LOW").length * 3);

  const status = riskScore >= 70 ? "CRITICAL" : riskScore >= 35 ? "WATCH" : "OK";
  const summary = status === "CRITICAL"
    ? "즉시 확인이 필요한 위험 신호가 있습니다."
    : status === "WATCH"
      ? "관찰 및 조치 확인이 필요한 항목이 있습니다."
      : "현재 주요 운영 신호는 안정적입니다.";

  return {
    status,
    riskScore,
    summary,
    counts: {
      openActions: openActions.length,
      urgentActions: urgentActions.length,
      overdueActions: overdueActions.length,
      inventoryItems: inventory.length,
      lowStock: lowStock.length,
      zeroStock: zeroStock.length,
      activeRequisitions: activeReqs.length,
      recentIncidents: recentIncidents.length,
      worklogs: worklogs.length,
      todayWorklog: !!todayWorklog,
      recentAudits: recentAudits.length,
    },
    findings,
    distribution: {
      actionsByStatus: countBy(facActions, a => a.status || "TODO"),
      inventoryByCategory: countBy(inventory, p => p.cat || p.category || "기타"),
      incidentsByType: countBy(incidents, i => i.type || "기타"),
    },
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "agent-realtime-analysis",
      mode: process.env.OPENAI_API_KEY ? "rules+ai-ready" : "rules",
      generatedAt: new Date().toISOString(),
    });
  }
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });

  try {
    const snapshot = req.body?.snapshot || req.body || {};
    const analysis = buildFindings(snapshot);
    return res.status(200).json({
      ok: true,
      source: "api/agent-realtime-analysis",
      generatedAt: new Date().toISOString(),
      sharedKey: "jamsa_agent_live_analysis",
      analysis,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "internal_error", message: e.message });
  }
}
