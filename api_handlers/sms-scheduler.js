// api/sms-scheduler.js
// 단체예약 자동 SMS 발송 스케줄러 (Vercel Cron 트리거)
//
// 작업 4가지:
//   1) D-14 일정 공유  — 14일 후 예약 건 1회 발송
//   2) D-1 도착시간 재확인 — 1일 전 예약 건 1회 발송
//   3) 도착 10분 전 알림 — 당일 arrival_time - 10min 이 되면 발송
//   4) 큐 처리 — res_sms_queue 의 scheduled_at <= now 항목 발송
//
// 호출: GET /api/sms-scheduler?secret=... (vercel.json crons 가 매 시간 호출)
// 보안: CRON_SECRET 환경변수와 일치해야 작동

import { createClient } from "@supabase/supabase-js";

function getSb() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function render(template, vars) {
  return Object.entries(vars || {}).reduce(
    (s, [k, v]) => s.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "g"), v ?? ""),
    template
  );
}

// 뿌리오 직접 호출 (sms-send.js 와 중복 — 같은 함수 처리)
async function ppurio(to, content, subject, messageType = "SMS") {
  const account = process.env.PPURIO_ACCOUNT;
  const apiKey = process.env.PPURIO_API_KEY;
  const sender = process.env.PPURIO_SENDER;
  if (!account || !apiKey || !sender) return { ok: false, error: "ppurio_not_configured" };
  const auth = Buffer.from(`${account}:${apiKey}`).toString("base64");
  const body = { account, messageType, from: sender.replace(/-/g, ""),
    to: to.replace(/-/g, ""), content };
  if (subject) body.subject = subject;
  try {
    const r = await fetch("https://message.ppurio.com/v1/message", {
      method: "POST",
      headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    return r.ok
      ? { ok: true, messageKey: data?.messageKey || data?.refKey }
      : { ok: false, status: r.status, error: data?.code || "api_error", message: data?.description };
  } catch (e) {
    return { ok: false, error: "network", message: e.message };
  }
}

async function sendAndLog(sb, ctx) {
  // ctx: { facilityCode, bookingId, kind, recipient, content, subject?, messageType? }
  const t0 = Date.now();
  const r = await ppurio(ctx.recipient, ctx.content, ctx.subject, ctx.messageType);
  try {
    await sb.from("res_sms_logs").insert({
      facility_code: ctx.facilityCode,
      booking_id: ctx.bookingId,
      kind: ctx.kind,
      recipient: ctx.recipient,
      message_type: ctx.messageType || "SMS",
      content: ctx.content,
      subject: ctx.subject,
      status: r.ok ? "sent" : "failed",
      message_key: r.messageKey || null,
      error_code: r.error || null,
      error_message: r.message || null,
      elapsed_ms: Date.now() - t0,
    });
  } catch (e) {}
  return r;
}

async function processQueue(sb) {
  const now = new Date().toISOString();
  const { data: due } = await sb.from("res_sms_queue")
    .select("*").eq("status", "pending").lte("scheduled_at", now).limit(50);
  if (!due || due.length === 0) return { processed: 0 };
  // 템플릿 캐시
  const codes = [...new Set(due.map(q => q.template_code))];
  const { data: tmps } = await sb.from("res_sms_templates")
    .select("*").in("code", codes);
  const tmpMap = {};
  (tmps || []).forEach(t => { tmpMap[t.code] = t; });

  let ok = 0, fail = 0;
  for (const q of due) {
    const tmp = tmpMap[q.template_code];
    if (!tmp) {
      await sb.from("res_sms_queue").update({
        status: "failed", last_error: `template not found: ${q.template_code}`,
        attempt_count: (q.attempt_count || 0) + 1,
      }).eq("id", q.id);
      fail++; continue;
    }
    const content = render(tmp.template, q.variables || {});
    const subject = tmp.subject ? render(tmp.subject, q.variables || {}) : null;
    const r = await sendAndLog(sb, {
      facilityCode: q.facility_code, bookingId: q.booking_id,
      kind: q.template_code, recipient: q.recipient,
      content, subject, messageType: tmp.message_type,
    });
    await sb.from("res_sms_queue").update({
      status: r.ok ? "sent" : "failed",
      sent_at: r.ok ? new Date().toISOString() : null,
      last_error: r.ok ? null : (r.message || r.error),
      attempt_count: (q.attempt_count || 0) + 1,
    }).eq("id", q.id);
    if (r.ok) ok++; else fail++;
  }
  return { processed: due.length, sent: ok, failed: fail };
}

// 예약별로 D-14 / D-1 / 도착10분전 큐 생성 (중복은 UNIQUE constraint 가 막음)
async function scheduleUpcoming(sb) {
  const today = new Date();
  const dPlus14 = new Date(today); dPlus14.setDate(today.getDate() + 14);
  const dPlus1  = new Date(today); dPlus1.setDate(today.getDate() + 1);
  const todayStr = today.toISOString().slice(0, 10);
  const d14Str = dPlus14.toISOString().slice(0, 10);
  const d1Str = dPlus1.toISOString().slice(0, 10);

  // D-14: 정확히 14일 후 예약
  const { data: d14Bookings } = await sb.from("res_bookings")
    .select("id, facility_code, group_name, booking_date, arrival_time, departure_time, students, teachers, phone")
    .eq("booking_date", d14Str).eq("status", "확정").not("phone", "is", null);
  let scheduled = 0;
  for (const b of (d14Bookings || [])) {
    const token = "t" + Math.random().toString(36).slice(2, 10);
    const { error } = await sb.from("res_sms_queue").insert({
      facility_code: b.facility_code, booking_id: b.id,
      template_code: "d14_reminder",
      recipient: b.phone,
      scheduled_at: new Date().toISOString(),  // 즉시 발송 큐
      variables: {
        group_name: b.group_name, date: b.booking_date,
        arrival: b.arrival_time, departure: b.departure_time,
        students: b.students, teachers: b.teachers, token,
      },
    });
    if (!error) scheduled++;
  }

  // D-1: 정확히 1일 후 예약
  const { data: d1Bookings } = await sb.from("res_bookings")
    .select("id, facility_code, group_name, booking_date, arrival_time, departure_time, phone")
    .eq("booking_date", d1Str).eq("status", "확정").not("phone", "is", null);
  for (const b of (d1Bookings || [])) {
    const token = "t" + Math.random().toString(36).slice(2, 10);
    const { error } = await sb.from("res_sms_queue").insert({
      facility_code: b.facility_code, booking_id: b.id,
      template_code: "d1_arrival_confirm",
      recipient: b.phone,
      scheduled_at: new Date().toISOString(),
      variables: {
        group_name: b.group_name, date: b.booking_date,
        arrival: b.arrival_time, departure: b.departure_time, token,
      },
    });
    if (!error) scheduled++;
    // 동시에 day_checkin 항목 생성 (exit_check 도 D-1 에 함께)
    await sb.from("res_day_checkins").upsert([
      { facility_code: b.facility_code, booking_id: b.id, check_type: "departure_check", scheduled_time: b.arrival_time },
      { facility_code: b.facility_code, booking_id: b.id, check_type: "exit_check", scheduled_time: b.departure_time },
    ], { onConflict: "booking_id,check_type" });
  }

  // 도착 10분 전: 오늘 예약 + arrival_time - 10min ≤ now < arrival_time
  const { data: todayBookings } = await sb.from("res_bookings")
    .select("id, facility_code, group_name, arrival_time, phone")
    .eq("booking_date", todayStr).eq("status", "확정").not("phone", "is", null);
  const nowMin = today.getHours() * 60 + today.getMinutes();
  for (const b of (todayBookings || [])) {
    if (!b.arrival_time) continue;
    const [h, m] = b.arrival_time.split(":").map(Number);
    const arrMin = h * 60 + m;
    if (arrMin - 10 <= nowMin && nowMin < arrMin) {
      // 이미 보낸 적 있는지 확인
      const { data: prev } = await sb.from("res_sms_logs")
        .select("id").eq("booking_id", b.id).eq("kind", "arrival_10min_estimate").limit(1);
      if (!prev || prev.length === 0) {
        const content = `[잠사박물관] ${b.group_name}님 도착 10분 전입니다. 정문 안내데스크에서 인사드리겠습니다.`;
        const r = await sendAndLog(sb, {
          facilityCode: b.facility_code, bookingId: b.id,
          kind: "arrival_10min_estimate", recipient: b.phone, content,
        });
        if (r.ok) scheduled++;
      }
    }
  }
  return { scheduled };
}

export default async function handler(req, res) {
  // 보안: CRON_SECRET 일치 확인 (Vercel Cron 은 헤더에 자동 포함)
  const expected = process.env.CRON_SECRET;
  const provided = req.query?.secret || req.headers["x-cron-secret"]
    || (req.headers["authorization"] || "").replace(/^Bearer\s+/, "");
  if (expected && provided !== expected) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const sb = getSb();
  if (!sb) return res.status(500).json({ error: "supabase_not_configured" });

  try {
    const [scheduled, processed] = await Promise.all([
      scheduleUpcoming(sb),
      processQueue(sb),
    ]);
    return res.json({
      ok: true, at: new Date().toISOString(),
      scheduled, processed,
    });
  } catch (e) {
    console.error("[sms-scheduler]", e);
    return res.status(500).json({ error: "internal", message: e.message });
  }
}
