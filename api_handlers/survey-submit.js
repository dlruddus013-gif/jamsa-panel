// api/survey-submit.js
// 만족도 설문 응답 저장 + 경품 입장권 자동 발급
// 토큰 기반 anon 접근 — 고객이 SMS 링크로 직접 응답

import { createClient } from "@supabase/supabase-js";

function getSb() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function safeBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch (e) {} }
  return new Promise(res => {
    const c = []; req.on("data", x => c.push(x));
    req.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString("utf-8"))); } catch (e) { res({}); } });
  });
}

// 경품 코드 생성: JP-2026-A1B2C3D4
function generateCouponCode(facilityCode) {
  const year = new Date().getFullYear();
  const fac = (facilityCode || "JP").toUpperCase();
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 헷갈리는 0,1,I,O 제외
  let suffix = "";
  for (let i = 0; i < 8; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
  return `${fac}-${year}-${suffix}`;
}

export default async function handler(req, res) {
  // GET: 토큰으로 설문 조회 (설문 페이지 초기 로딩)
  if (req.method === "GET") {
    const token = req.query?.token;
    if (!token) return res.status(400).json({ error: "missing_token" });
    const sb = getSb();
    if (!sb) return res.status(500).json({ error: "supabase_not_configured" });
    const { data, error } = await sb.from("res_surveys")
      .select(`id, facility_code, booking_id, invite_token, responded_at, coupon_issued_id,
               res_bookings(group_name, booking_date)`)
      .eq("invite_token", token).maybeSingle();
    if (error) return res.status(500).json({ error: "db_error", message: error.message });
    if (!data) return res.status(404).json({ error: "survey_not_found" });
    return res.json({
      ok: true,
      survey: {
        id: data.id,
        facility_code: data.facility_code,
        booking_id: data.booking_id,
        groupName: data.res_bookings?.group_name,
        bookingDate: data.res_bookings?.booking_date,
        alreadyResponded: !!data.responded_at,
        couponIssued: !!data.coupon_issued_id,
      },
    });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const body = await safeBody(req);
  const { token, rating_overall, rating_program, rating_staff, rating_facility,
    nps, comments, improvement_suggestions, would_revisit, agreed_to_marketing } = body;

  if (!token) return res.status(400).json({ error: "missing_token" });
  // 평점 유효성 (1-5)
  for (const [field, val] of Object.entries({ rating_overall, rating_program, rating_staff, rating_facility })) {
    if (val != null && (val < 1 || val > 5 || !Number.isInteger(val))) {
      return res.status(400).json({ error: "invalid_rating", message: `${field}: 1~5 정수` });
    }
  }
  if (nps != null && (nps < 0 || nps > 10 || !Number.isInteger(nps))) {
    return res.status(400).json({ error: "invalid_nps", message: "nps: 0~10 정수" });
  }
  if (!rating_overall) {
    return res.status(400).json({ error: "missing_rating", message: "rating_overall 필수" });
  }

  const sb = getSb();
  if (!sb) return res.status(500).json({ error: "supabase_not_configured" });

  // 설문 조회
  const { data: survey, error: sErr } = await sb.from("res_surveys")
    .select("id, facility_code, booking_id, responded_at, coupon_issued_id, invite_phone")
    .eq("invite_token", token).maybeSingle();
  if (sErr || !survey) return res.status(404).json({ error: "survey_not_found" });
  if (survey.responded_at) {
    return res.status(409).json({ error: "already_responded",
      message: "이미 응답 완료된 설문입니다", couponIssued: !!survey.coupon_issued_id });
  }

  // 응답 저장
  const responded_at = new Date().toISOString();
  const { error: upErr } = await sb.from("res_surveys").update({
    rating_overall, rating_program, rating_staff, rating_facility,
    nps, comments, improvement_suggestions, would_revisit,
    agreed_to_marketing: !!agreed_to_marketing,
    responded_at,
  }).eq("id", survey.id);
  if (upErr) return res.status(500).json({ error: "survey_save_failed", message: upErr.message });

  // 경품 자동 발급 — 평점 3점 이상 시
  let couponCode = null;
  if (rating_overall >= 3) {
    couponCode = generateCouponCode(survey.facility_code);
    const expires = new Date(); expires.setMonth(expires.getMonth() + 6); // 6개월 유효
    const qrPayload = `https://jamsa-panel.vercel.app/coupon/${couponCode}`;
    const { data: coupon, error: cErr } = await sb.from("res_coupons").insert({
      facility_code: survey.facility_code,
      code: couponCode, qr_payload: qrPayload,
      coupon_type: "free_admission",
      description: "만족도 설문 참여 무료 입장권 1매",
      booking_id: survey.booking_id, survey_id: survey.id,
      recipient_phone: survey.invite_phone,
      issued_at: responded_at,
      expires_at: expires.toISOString(),
    }).select("id").single();
    if (!cErr && coupon) {
      await sb.from("res_surveys").update({ coupon_issued_id: coupon.id }).eq("id", survey.id);
    }
  }

  return res.json({
    ok: true,
    submitted_at: responded_at,
    couponCode,
    couponUrl: couponCode ? `https://jamsa-panel.vercel.app/coupon/${couponCode}` : null,
  });
}
