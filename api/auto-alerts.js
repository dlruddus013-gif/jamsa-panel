// api/auto-alerts.js
// 자동 알림 시스템: 과밀/위험 감지 + 직원 자동 호출 + 알림 이력 관리

import { supabaseSvc } from '../lib/auth.js';

const PPURIO_USERNAME = process.env.PPURIO_USERNAME;
const PPURIO_API_KEY = process.env.PPURIO_API_KEY;
const PPURIO_SENDER = process.env.PPURIO_SENDER;

let ppurioTokenCache = null;
let ppurioTokenExpiry = 0;

async function getPpurioToken() {
  if (ppurioTokenCache && Date.now() < ppurioTokenExpiry) return ppurioTokenCache;
  if (!PPURIO_USERNAME || !PPURIO_API_KEY) return null;
  try {
    const auth = Buffer.from(`${PPURIO_USERNAME}:${PPURIO_API_KEY}`).toString('base64');
    const res = await fetch('https://message.ppurio.com/v1/token', {
      method: 'POST', headers: { Authorization: `Basic ${auth}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    ppurioTokenCache = data.token;
    ppurioTokenExpiry = Date.now() + (data.expired_in - 60) * 1000;
    return ppurioTokenCache;
  } catch (e) { return null; }
}

async function sendSms(token, to, message) {
  if (!token || !PPURIO_SENDER || !to) return { ok: false, reason: 'no_config' };
  try {
    const res = await fetch('https://message.ppurio.com/v1/message', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account: PPURIO_USERNAME, messageType: 'SMS',
        from: PPURIO_SENDER, content: message.slice(0, 90),
        targetCount: 1, targets: [{ to: to.replace(/[^0-9]/g, '') }],
      }),
    });
    const data = await res.json();
    return { ok: res.ok, data };
  } catch (e) { return { ok: false, error: e.message }; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ─── POST: 알림 트리거 ───
  if (req.method === 'POST') {
    try {
      const { type, zoneId, zoneName, severity, message, recipients, autoCall, channelCh, peopleCount } = req.body || {};
      if (!type) return res.status(400).json({ error: 'missing_type' });

      // 알림 이력 저장
      const alertRecord = {
        alert_type: type, // 'crowd' | 'fire' | 'medical' | 'manual' | 'lost'
        zone_id: zoneId || null,
        zone_name: zoneName || null,
        severity: severity || 'WARNING', // INFO | WARNING | DANGER
        message: message || `${zoneName || zoneId} ${type} 알림`,
        channel_ch: channelCh || null,
        people_count: peopleCount || null,
        auto_called: !!autoCall,
        recipients: recipients || [],
        created_at: new Date().toISOString(),
      };

      let alertId = null;
      if (supabaseSvc) {
        const { data, error } = await supabaseSvc.from('auto_alerts').insert(alertRecord).select('id').single();
        if (error) console.error('[auto-alerts]', error);
        alertId = data?.id;
      }

      // SMS 발송 (autoCall=true인 경우)
      const smsResults = [];
      if (autoCall && recipients && recipients.length > 0) {
        const token = await getPpurioToken();
        if (token) {
          for (const r of recipients) {
            const phone = typeof r === 'string' ? r : r.phone;
            const name = typeof r === 'object' ? r.name : '';
            if (!phone) continue;
            const smsMsg = `[잠사박물관 ${severity || '알림'}] ${alertRecord.message}${name ? ` ${name}님 확인 부탁드립니다.` : ''}`;
            const result = await sendSms(token, phone, smsMsg);
            smsResults.push({ phone, name, ok: result.ok });
            // 발송 시간 약간 텀
            await new Promise(r => setTimeout(r, 100));
          }
        }
      }

      res.status(200).json({
        ok: true, alertId,
        smsResults,
        smsConfigured: !!(PPURIO_USERNAME && PPURIO_API_KEY && PPURIO_SENDER),
      });
    } catch (e) {
      res.status(500).json({ error: 'internal_error', message: e.message });
    }
    return;
  }

  // ─── GET: 알림 이력 조회 ───
  if (req.method === 'GET') {
    try {
      if (!supabaseSvc) return res.status(200).json({ ok: true, alerts: [] });

      const range = req.query.range || 'today';
      const limit = parseInt(req.query.limit, 10) || 50;

      let q = supabaseSvc
        .from('auto_alerts')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (range === 'today') {
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        q = q.gte('created_at', todayStart.toISOString());
      } else if (range === 'week') {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        q = q.gte('created_at', weekAgo);
      }

      const { data, error } = await q;
      if (error) throw error;

      // 통계
      const stats = {
        total: (data || []).length,
        byType: {}, bySeverity: {}, autoCallCount: 0,
      };
      (data || []).forEach(a => {
        stats.byType[a.alert_type] = (stats.byType[a.alert_type] || 0) + 1;
        stats.bySeverity[a.severity] = (stats.bySeverity[a.severity] || 0) + 1;
        if (a.auto_called) stats.autoCallCount++;
      });

      res.status(200).json({ ok: true, alerts: data || [], stats });
    } catch (e) {
      res.status(500).json({ error: 'internal_error', message: e.message });
    }
    return;
  }

  res.status(405).json({ error: 'method_not_allowed' });
}
