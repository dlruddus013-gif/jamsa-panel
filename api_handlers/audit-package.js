// 감사 패키지 생성 API — 설계 §11.2 경로 B
// POST /api/audit-package?action=generate  — 현재월 또는 지정 기간 패키지 생성
// GET  /api/audit-package                  — 발송 이력 조회
//
// 이메일 발송 자체는 외부 cron 또는 별도 인프라(notify-send 등)에서 처리.
// 여기서는 JSON 페이로드 + SHA-256 해시 + audit_package_log INSERT만 담당.

import crypto from 'node:crypto';
import { requireAuth, canDo, supabaseSvc, normalizeRole, audit } from '../lib/auth.js';

export default async function handler(req, res) {
  const ctx = await requireAuth(req, res);
  if (!ctx) return;
  const role = normalizeRole(ctx.role);
  if (!['admin', 'lawyer'].includes(role)) {
    return res.status(403).json({ ok: false, error: 'forbidden', detail: 'admin or lawyer required' });
  }

  if (req.method === 'GET') return listHistory(req, res, ctx);
  if (req.method === 'POST') return generate(req, res, ctx);
  return res.status(405).json({ ok: false, error: 'method_not_allowed' });
}

async function listHistory(req, res, ctx) {
  const { data, error } = await supabaseSvc
    .from('audit_package_log')
    .select('id, period_start, period_end, generated_at, recipient_email, recipient_name, encryption_method, package_sha256, package_size_bytes, delivered_at, delivery_status, payload_summary')
    .eq('org_id', ctx.orgId)
    .order('generated_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, history: data });
}

async function generate(req, res, ctx) {
  const { periodStart, periodEnd, dryRun } = req.body || {};
  // 기본: 전월 1일 ~ 전월 말일
  const now = new Date();
  const defaultStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
  const defaultEnd = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10);
  const ps = periodStart || defaultStart;
  const pe = periodEnd || defaultEnd;
  if (new Date(ps) > new Date(pe)) {
    return res.status(400).json({ ok: false, error: 'invalid_period' });
  }

  // 페이로드 수집
  const [consent, access, corrections, auditLogs] = await Promise.all([
    supabaseSvc.from('consent_records').select('*').eq('org_id', ctx.orgId).gte('agreed_at', ps).lt('agreed_at', addOneDay(pe)),
    supabaseSvc.from('location_access_log').select('*').eq('org_id', ctx.orgId).gte('accessed_at', ps).lt('accessed_at', addOneDay(pe)),
    supabaseSvc.from('attendance_corrections').select('*').eq('org_id', ctx.orgId).gte('created_at', ps).lt('created_at', addOneDay(pe)),
    supabaseSvc.from('audit_logs').select('*').eq('org_id', ctx.orgId).gte('created_at', ps).lt('created_at', addOneDay(pe)).limit(5000),
  ]);

  const payload = {
    org_id: ctx.orgId,
    period: { start: ps, end: pe },
    generated_at: new Date().toISOString(),
    generated_by: { user_id: ctx.user.id, email: ctx.user.email, role: ctx.role },
    consent_records: consent.data || [],
    location_access_log: access.data || [],
    attendance_corrections: corrections.data || [],
    audit_logs: auditLogs.data || [],
  };
  const summary = {
    consent_count: payload.consent_records.length,
    access_count: payload.location_access_log.length,
    correction_count: payload.attendance_corrections.length,
    audit_log_count: payload.audit_logs.length,
  };
  const json = JSON.stringify(payload, null, 2);
  const sizeBytes = Buffer.byteLength(json, 'utf8');
  const sha256 = crypto.createHash('sha256').update(json, 'utf8').digest('hex');

  if (dryRun) {
    return res.json({ ok: true, dryRun: true, sha256, sizeBytes, summary });
  }

  // 수신자 조회 후 각각 INSERT
  const { data: recipients, error: recErr } = await supabaseSvc
    .from('lawyer_recipients')
    .select('id, name, email, pgp_public_key')
    .eq('org_id', ctx.orgId)
    .eq('active', true);
  if (recErr) return res.status(500).json({ ok: false, error: recErr.message });
  if (!recipients || recipients.length === 0) {
    return res.status(400).json({ ok: false, error: 'no_active_recipients', hint: 'lawyer_recipients에 active=true 수신자 추가 필요' });
  }

  const inserted = [];
  for (const r of recipients) {
    const { data, error } = await supabaseSvc
      .from('audit_package_log')
      .insert({
        org_id: ctx.orgId,
        period_start: ps,
        period_end: pe,
        generated_by: ctx.user.id,
        recipient_email: r.email,
        recipient_name: r.name,
        encryption_method: r.pgp_public_key ? 'pgp_pubkey' : 'zip_password',
        package_sha256: sha256,
        package_size_bytes: sizeBytes,
        delivery_status: 'pending',
        payload_summary: summary,
      })
      .select('id')
      .single();
    if (!error) inserted.push({ id: data.id, email: r.email });
    // 실제 메일 발송은 별도 워커가 delivery_status='pending' 행을 픽업해서 처리
  }

  await audit(ctx, 'AUDIT_PACKAGE_GENERATE', 'audit_package_log', { period: { start: ps, end: pe }, summary, recipients: recipients.length });

  res.json({
    ok: true,
    period: { start: ps, end: pe },
    sha256, sizeBytes, summary,
    queuedRecipients: inserted,
    note: '발송은 외부 워커가 delivery_status=pending 행을 처리합니다. 인프라 미설정 시 pending 상태로 남습니다.',
  });
}

function addOneDay(dateStr) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}
