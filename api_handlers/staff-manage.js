// api/staff-manage.js
// 직원/알바 관리 CRUD (인증된 사용자만 사용 가능, service-role로 RLS 우회)

import { requireAuth, audit, supabaseSvc } from '../lib/auth.js';

export default async function handler(req, res) {
  const ctx = await requireAuth(req, res);
  if (!ctx) return;

  if (!supabaseSvc) {
    return res.status(500).json({ error: 'supabase_not_configured' });
  }

  try {
    // ─── GET: 직원/알바 전체 조회 (active 옵션 필터) ───
    if (req.method === 'GET') {
      const onlyActive = req.query?.active !== 'false';
      let q = supabaseSvc.from('staff').select('*').order('is_part_time').order('dept_id').order('name');
      if (onlyActive) q = q.eq('active', true);
      const { data, error } = await q;
      if (error) throw error;
      return res.json({ ok: true, staff: data || [] });
    }

    // ─── POST: 신규 직원/알바 추가 ───
    if (req.method === 'POST') {
      const {
        name, dept_id, phone, beacon_id, is_part_time, hired_at, contract_end, memo,
      } = req.body || {};
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: 'name_required' });
      }
      const record = {
        name: name.trim(),
        dept_id: dept_id || null,
        phone: phone || null,
        beacon_id: beacon_id || null,
        is_part_time: !!is_part_time,
        hired_at: hired_at || new Date().toISOString().slice(0,10),
        contract_end: contract_end || null,
        memo: memo || null,
        active: true,
      };
      // 같은 이름이 있으면 upsert (active=true로 갱신)
      const { data, error } = await supabaseSvc.from('staff')
        .upsert(record, { onConflict: 'name' })
        .select().single();
      if (error) throw error;
      audit(ctx, 'staff_create', String(data.id), { name: data.name, is_part_time: data.is_part_time });
      return res.json({ ok: true, staff: data });
    }

    // ─── PATCH: 직원 정보 수정 (id 또는 name 으로) ───
    if (req.method === 'PATCH') {
      const { id, name, ...patch } = req.body || {};
      if (!id && !name) return res.status(400).json({ error: 'id_or_name_required' });
      const allowed = ['name','dept_id','phone','beacon_id','unique_uid','wifi_mac','gps_device_id','card_uid',
                       'is_part_time','hired_at','contract_end','active','memo',
                       'visa_type','visa_expiry'];
      const cleanPatch = {};
      for (const k of allowed) {
        if (k in patch) cleanPatch[k] = patch[k];
      }
      if (Object.keys(cleanPatch).length === 0) {
        return res.status(400).json({ error: 'no_fields_to_update' });
      }
      let q = supabaseSvc.from('staff').update(cleanPatch);
      if (id) q = q.eq('id', id);
      else q = q.eq('name', name);
      const { data, error } = await q.select().single();
      if (error) throw error;
      audit(ctx, 'staff_update', String(data.id), { fields: Object.keys(cleanPatch) });
      return res.json({ ok: true, staff: data });
    }

    // ─── DELETE: 직원 비활성 또는 완전 삭제 ───
    //   ?hard=1 이면 실제 DELETE, 아니면 active=false 처리
    if (req.method === 'DELETE') {
      const id = req.query?.id || req.body?.id;
      const name = req.query?.name || req.body?.name;
      const hard = req.query?.hard === '1' || req.body?.hard === true;
      if (!id && !name) return res.status(400).json({ error: 'id_or_name_required' });

      if (hard) {
        let q = supabaseSvc.from('staff').delete();
        if (id) q = q.eq('id', id); else q = q.eq('name', name);
        const { error } = await q;
        if (error) throw error;
        audit(ctx, 'staff_delete_hard', String(id || name), {});
        return res.json({ ok: true, deleted: true });
      } else {
        let q = supabaseSvc.from('staff').update({ active: false });
        if (id) q = q.eq('id', id); else q = q.eq('name', name);
        const { data, error } = await q.select().single();
        if (error) throw error;
        audit(ctx, 'staff_deactivate', String(data.id), {});
        return res.json({ ok: true, staff: data });
      }
    }

    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    console.error('[staff-manage]', e);
    return res.status(500).json({ error: 'internal_error', message: e.message });
  }
}
