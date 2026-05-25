// api/booking-create.js
// 예약 생성 시 자동으로:
//   1) res_bookings INSERT
//   2) 고객번호로 즉시 안내문자 (booking_confirm 큐)
//   3) D-14, D-1 자동 큐 등록 (scheduler 가 처리)
//   4) res_surveys 항목 생성 (방문 후 발송용, 토큰 부여)

import { createClient } from "@supabase/supabase-js";

function getSb() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function genToken(len = 16) {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let s = ""; for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function safeBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch (e) {} }
  return new Promise(res => {
    const c = []; req.on("data", x => c.push(x));
    req.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString("utf-8"))); } catch (e) { res({}); } });
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  const body = await safeBody(req);
  const {
    facility_code = "jp",
    group_name, category, booking_date,
    arrival_time, departure_time,
    students, teachers, phone, email, leader_name,
    channel, course, memo, agency_code,
    total_amount, created_by,
  } = body;

  if (!group_name || !booking_date) {
    return res.status(400).json({ error: "missing_fields", message: "group_name + booking_date 필수" });
  }

  const sb = getSb();
  if (!sb) return res.status(500).json({ error: "supabase_not_configured" });

  // 1) 예약 INSERT
  const { data: booking, error: bErr } = await sb.from("res_bookings").insert({
    facility_code, group_name, category, booking_date,
    arrival_time, departure_time, students, teachers,
    phone, email, leader_name, channel, course, memo,
    agency_code, total_amount, created_by,
    status: "확정",
  }).select("id, facility_code, booking_date, arrival_time, departure_time, group_name, students, teachers")
    .single();
  if (bErr) return res.status(500).json({ error: "booking_insert_failed", message: bErr.message });

  const queued = [];

  if (phone) {
    // 2) 안내문자 즉시 발송 큐 (지금)
    const { error: q1 } = await sb.from("res_sms_queue").insert({
      facility_code, booking_id: booking.id,
      template_code: "booking_confirm",
      recipient: phone,
      scheduled_at: new Date().toISOString(),
      variables: {
        group_name, date: booking_date,
        arrival: arrival_time || "10:00",
        departure: departure_time || "14:00",
        students, teachers,
      },
    });
    if (!q1) queued.push("booking_confirm");

    // 3) D-14 / D-1 큐는 scheduler 가 알아서 등록 (매시간 검색)
    //    여기서는 res_day_checkins 만 미리 placeholder 로 생성 (선택)
  }

  // 4) 만족도 설문 항목 생성 (방문 후 D+1 에 SMS 발송 큐로)
  if (phone) {
    const token = genToken();
    const visitDate = new Date(booking_date);
    const surveyDate = new Date(visitDate);
    surveyDate.setDate(visitDate.getDate() + 1); // 방문 다음날
    surveyDate.setHours(10, 0, 0, 0);

    const { data: surveyRow, error: surveyErr } = await sb.from("res_surveys").insert({
      facility_code, booking_id: booking.id,
      invite_token: token,
      invite_phone: phone,
    }).select("id").single();

    if (!surveyErr && surveyRow) {
      // 설문 발송 큐 등록
      await sb.from("res_sms_queue").insert({
        facility_code, booking_id: booking.id,
        template_code: "survey_invite",
        recipient: phone,
        scheduled_at: surveyDate.toISOString(),
        variables: { group_name, token },
      });
      queued.push("survey_invite");
    }
  }

  return res.json({
    ok: true,
    booking,
    queued,
    note: phone
      ? `안내문자 ${queued.length}건 큐 등록 (cron 이 발송 처리)`
      : "전화번호 미입력 — SMS 발송 건너뜀",
  });
}
