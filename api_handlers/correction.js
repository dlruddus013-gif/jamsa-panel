// 출퇴근 정정 요청 API — 설계 §3.4, §4.4
// GET    /api/correction              — scope=mine|team|all (역할별)
// POST   /api/correction              — 본인 요청 생성
// PATCH  /api/correction?id=...       — admin 승인/반려

import { requireAuth, audit, supabaseSvc, normalizeRole } from '../lib/auth.js';

export default async function handler(req, res) {
  const ctx = await requireAuth(req, res);
  if (!ctx) return;
  if (req.method === 'GET') return list(req, res, ctx);
  if (req.method === 'POST') return create(req, res, ctx);
  if (req.method === 'PATCH') return review(req, res, ctx);
  return res.status(405).json({ ok: false, error: 'method_not_allowed' });
}

async function list(req, res, ctx) {
  const role = normalizeRole(ctx.role);
  const scope = req.query.scope || 'mine';

  let q = supabaseSvc.from('attendance_corrections')
    .select('id, staff_id, date, field, value_before, value_after, reason, status, reviewed_by, reviewed_at, reviewed_note, created_at')
    .eq('org_id', ctx.orgId)
    .order('created_at', { ascending: false })
    .limit(200);

  if (scope === 'mine') {
    q = q.eq('staff_id', ctx.user.id);
  } else if (scope === 'team' && role === 'lead') {
    // lead: 같은 부서 직원 요청만
    const { data: meMem } = await supabaseSvc
      .from('memberships').select('dept').eq('user_id', ctx.user.id).eq('org_id', ctx.orgId).single();
    if (meMem?.dept) {
      const { data: teamMems } = await supabaseSvc
        .from('memberships').select('user_id').eq('org_id', ctx.orgId).eq('dept', meMem.dept);
      const teamIds = (teamMems || []).map(m => m.user_id);
      if (teamIds.length === 0) return res.json({ ok: true, corrections: [] });
      q = q.in('staff_id', teamIds);
    } else {
      return res.json({ ok: true, corrections: [] });
    }
  } else if (scope === 'all' && (role === 'admin' || role === 'lawyer')) {
    // 전체 조회
  } else if (scope !== 'mine') {
    return res.status(403).json({ ok: false, error: 'forbidden', detail: `scope=${scope} requires higher role` });
  }

  const { data, error } = await q;
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, corrections: data });
}

async function create(req, res, ctx) {
  const { date, field, valueBefore, valueAfter, reason } = req.body || {};
  if (!date || !field || !valueAfter || !reason) {
    return res.status(400).json({ ok: false, error: 'missing_fields', required: ['date','field','valueAfter','reason'] });
  }
  if (!['check_in','check_out','break_time'].includes(field)) {
    return res.status(400).json({ ok: false, error: 'invalid_field' });
  }
  if (typeof reason !== 'string' || reason.trim().length < 10) {
    return res.status(400).json({ ok: false, error: 'reason_too_short', minLength: 10 });
  }

  const { data, error } = await supabaseSvc
    .from('attendance_corrections')
    .insert({
      org_id: ctx.orgId,
      staff_id: ctx.user.id,
      date, field,
      value_before: valueBefore || null,
      value_after: valueAfter,
      reason: reason.trim(),
    })
    .select('id, status, created_at')
    .single();
  if (error) return res.status(500).json({ ok: false, error: error.message });

  await audit(ctx, 'CORRECTION_REQUEST', `attendance_corrections:${data.id}`, { date, field, valueBefore, valueAfter });
  res.json({ ok: true, id: data.id, status: data.status, createdAt: data.created_at });
}

async function review(req, res, ctx) {
  const role = normalizeRole(ctx.role);
  if (role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'forbidden', detail: 'admin only' });
  }
  const correctionId = req.query.id;
  const { decision, note } = req.body || {};
  if (!correctionId) return res.status(400).json({ ok: false, error: 'id_required' });
  if (!['approved','rejected'].includes(decision)) {
    return res.status(400).json({ ok: false, error: 'invalid_decision' });
  }

  const { data, error } = await supabaseSvc
    .from('attendance_corrections')
    .update({
      status: decision,
      reviewed_by: ctx.user.id,
      reviewed_at: new Date().toISOString(),
      reviewed_note: note || null,
    })
    .eq('id', correctionId)
    .eq('org_id', ctx.orgId)
    .eq('status', 'pending')
    .select('id, status, reviewed_at')
    .single();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!data) return res.status(404).json({ ok: false, error: 'not_found_or_not_pending' });

  await audit(ctx, `CORRECTION_${decision.toUpperCase()}`, `attendance_corrections:${correctionId}`, { note });
  res.json({ ok: true, id: data.id, status: data.status, reviewedAt: data.reviewed_at });
}
