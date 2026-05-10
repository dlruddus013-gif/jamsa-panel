// api/safety-monthly-report.js
// 월간 안전 리포트 자동 생성
// - ANTHROPIC_API_KEY 있으면: Claude API로 인사이트 + 권고사항 생성
// - 없으면: 룰 기반 fallback으로 기본 리포트 생성 (404/500 대신 항상 결과 반환)

import { requireAuth } from '../lib/auth.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

export default async function handler(req, res) {
  const ctx = await requireAuth(req, res);
  if (!ctx) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  try {
    const {
      month,
      hazardLogs = [],
      incidents = [],
      completedActions = [],
      pendingActions = [],
      trainings = [],
      zoneRisks = [],
    } = req.body || {};

    const stats = {
      hazardCount: hazardLogs.length,
      incidentCount: incidents.length,
      completedActionCount: completedActions.length,
      pendingActionCount: pendingActions.length,
      trainingCount: trainings.length,
      topRiskZone: zoneRisks[0]?.zone || null,
      topRiskCount: zoneRisks[0]?.count || 0,
    };

    // 1) Claude API 사용 가능 시 AI 인사이트 생성
    if (ANTHROPIC_API_KEY) {
      try {
        const aiResult = await generateWithClaude({ month, hazardLogs, incidents, trainings, zoneRisks, stats });
        if (aiResult) {
          return res.status(200).json({
            ok: true,
            result: aiResult,
            generatedAt: new Date().toISOString(),
            source: 'claude',
          });
        }
      } catch (e) {
        console.warn('[safety-report] Claude failed, fallback to rule-based:', e.message);
      }
    }

    // 2) 룰 기반 폴백 (항상 200 반환)
    const result = generateRuleBased({ month, stats, hazardLogs, incidents, trainings, zoneRisks });
    return res.status(200).json({
      ok: true,
      result,
      generatedAt: new Date().toISOString(),
      source: ANTHROPIC_API_KEY ? 'rule_based_fallback' : 'rule_based',
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────
// Claude API 기반 리포트 생성
// ─────────────────────────────────────────────────────────────
async function generateWithClaude({ month, hazardLogs, incidents, trainings, zoneRisks, stats }) {
  const prompt = `당신은 한국잠사박물관 안전관리 전문가입니다. 아래 ${month} 월간 안전 데이터를 분석해 한국어로 JSON만 응답하세요 (코드블록/설명 금지).

데이터:
- 위험요소 ${stats.hazardCount}건, 사고 ${stats.incidentCount}건, 완료 조치 ${stats.completedActionCount}건, 미완료 조치 ${stats.pendingActionCount}건
- 교육 ${stats.trainingCount}건
- 위험 다발 구역: ${stats.topRiskZone || '없음'} (${stats.topRiskCount}건)
- 구역별 위험요소: ${JSON.stringify(zoneRisks.slice(0,5))}
- 최근 사고: ${JSON.stringify(incidents.slice(0,5).map(i => ({title:i.title, severity:i.severity, date:i.date})))}
- 최근 위험요소: ${JSON.stringify(hazardLogs.slice(0,5).map(h => ({type:h.type, severity:h.severity, facId:h.facId})))}

응답 JSON 스키마 (반드시 이 구조):
{
  "month": "${month}",
  "executiveSummary": "경영진 요약 2~3문장",
  "keyFindings": ["핵심 발견 3~5개"],
  "kpis": {
    "totalHazards": ${stats.hazardCount},
    "incidentCount": ${stats.incidentCount},
    "trainingCompletion": "예: 3회 또는 80%",
    "actionCompletionRate": "예: 85% 또는 —",
    "complianceScore": 0~100 정수
  },
  "topRiskZones": [{"zone":"구역명","count":숫자}],
  "recommendations": ["권고사항 4~6개"],
  "nextMonthFocus": "다음 달 집중 사항 1~2문장",
  "complianceStatus": "법규 준수 현황 1~2문장",
  "ceoMessage": "대표이사 메시지 1~2문장 (격려 + 안전 우선)"
}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Claude HTTP ${res.status}: ${errText.slice(0,200)}`);
    }
    const data = await res.json();
    const text = data?.content?.[0]?.text || '';
    // JSON 블록 추출 (모델이 코드블록으로 감싸도 처리)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('JSON not found in Claude response');
    const parsed = JSON.parse(jsonMatch[0]);
    return { ...parsed, stats };
  } finally {
    clearTimeout(t);
  }
}

// ─────────────────────────────────────────────────────────────
// 룰 기반 리포트 생성 (Claude 없어도 항상 동작)
// 프론트엔드(MonthlyReportCard) 스키마에 맞춰 반환:
//   executiveSummary, kpis{totalHazards,incidentCount,trainingCompletion,actionCompletionRate},
//   topRiskZones[{zone,count}], ceoMessage, complianceStatus, recommendations
// ─────────────────────────────────────────────────────────────
function generateRuleBased({ month, stats, hazardLogs, incidents, trainings, zoneRisks }) {
  const findings = [];
  const recommendations = [];
  const topRiskZones = zoneRisks.slice(0, 5).map(zr => ({ zone: zr.zone, count: zr.count }));

  if (stats.hazardCount === 0 && stats.incidentCount === 0) {
    findings.push("✅ 위험요소 및 사고 보고 없음 — 안전 지표 양호");
  } else {
    if (stats.hazardCount > 0) findings.push(`⚠️ 위험요소 ${stats.hazardCount}건 보고`);
    if (stats.incidentCount > 0) findings.push(`🚨 사고/아차사고 ${stats.incidentCount}건 발생`);
  }
  if (stats.pendingActionCount > 0) findings.push(`📋 미완료 조치 ${stats.pendingActionCount}건 — 후속 점검 필요`);

  if (stats.pendingActionCount > 0) recommendations.push(`📌 미완료 조치 ${stats.pendingActionCount}건을 다음 달 우선 처리`);
  if (stats.topRiskZone) recommendations.push(`🔍 ${stats.topRiskZone} 집중 점검 + 작업환경 재평가`);
  if (stats.incidentCount > 0) {
    recommendations.push("🚨 사고 원인 분석 회의 + 재발방지 대책 수립");
    recommendations.push("📝 전 직원 사고 사례 공유 교육 실시");
  }
  if (stats.trainingCount === 0) recommendations.push("📚 정기 안전교육 일정 수립 (월 1회 이상 권장)");
  if (recommendations.length < 4) recommendations.push("📋 정기 안전점검 체크리스트 검토 + 업데이트");

  // KPI 계산
  const totalActions = stats.completedActionCount + stats.pendingActionCount;
  const actionCompletionRate = totalActions === 0 ? "—" : `${Math.round((stats.completedActionCount/totalActions)*100)}%`;
  const trainingCompletion = stats.trainingCount > 0 ? `${stats.trainingCount}회` : "0회";

  // 컴플라이언스 점수
  let score = 100;
  score -= stats.incidentCount * 10;
  score -= stats.pendingActionCount * 3;
  score -= Math.min(stats.hazardCount * 2, 20);
  if (stats.trainingCount === 0) score -= 5;
  score = Math.max(40, Math.min(100, score));

  const complianceStatus = score >= 90
    ? `✅ 컴플라이언스 점수 ${score}/100 — 산업안전보건법 준수 양호`
    : score >= 70
      ? `⚠️ 컴플라이언스 점수 ${score}/100 — 일부 보완 필요 (미완료 조치, 교육 이수율 점검 권장)`
      : `🚨 컴플라이언스 점수 ${score}/100 — 즉시 개선 필요`;

  const ceoMessage = stats.incidentCount === 0 && stats.hazardCount === 0
    ? `${month} 한 달간 사고 없는 안전한 운영에 모든 직원의 노력에 감사드립니다. 다가오는 달도 작은 위험요소도 놓치지 않는 세심한 점검 부탁드립니다. — 한국잠사박물관`
    : `${month} 보고된 ${stats.hazardCount + stats.incidentCount}건의 안전 이슈를 해결하기 위해 함께 노력해 주셔서 감사합니다. 안전이 최우선이며, 작은 변화가 큰 사고를 막습니다. — 한국잠사박물관`;

  return {
    month,
    executiveSummary: stats.incidentCount === 0 && stats.hazardCount === 0
      ? `${month} 한 달간 사고·중대 위험요소 없이 안전하게 운영되었습니다. 예방 차원의 정기 점검과 교육은 지속 필요합니다.`
      : `${month} 위험요소 ${stats.hazardCount}건, 사고 ${stats.incidentCount}건 발생. ${stats.topRiskZone ? `특히 ${stats.topRiskZone} 구역 집중 점검 필요.` : '개별 조치 사항 우선 처리 필요.'} 미완료 조치 ${stats.pendingActionCount}건은 다음 달 최우선 과제입니다.`,
    keyFindings: findings.slice(0, 5),
    kpis: {
      totalHazards: stats.hazardCount,
      incidentCount: stats.incidentCount,
      trainingCompletion,
      actionCompletionRate,
      complianceScore: score,
    },
    topRiskZones,
    recommendations: recommendations.slice(0, 6),
    nextMonthFocus: stats.pendingActionCount > 0
      ? `미완료 조치 ${stats.pendingActionCount}건 우선 처리 + ${stats.topRiskZone || '주요 구역'} 정기 점검`
      : "정기 점검·교육 사이클 유지 + 사고 예방 지표 모니터링",
    complianceStatus,
    ceoMessage,
    stats,
  };
}
