// api/sms-send.js
// 뿌리오(Ppurio) SMS · LMS · 알림톡 발송
// 환경변수: PPURIO_ACCOUNT, PPURIO_API_KEY, PPURIO_SENDER (발신번호, 사전등록)
//          PPURIO_KAKAO_PROFILE_KEY (알림톡 사용 시), SUPABASE_SERVICE_ROLE_KEY (로그 저장)

import { createClient } from "@supabase/supabase-js";

const PPURIO_URL = "https://message.ppurio.com/v1/message";

// Supabase service-role 클라이언트 (RLS 우회해서 로그 기록)
function getSb() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  try { return createClient(url, key, { auth: { persistSession: false } }); }
  catch (e) { return null; }
}

async function callPpurio({ messageType, to, from, content, subject, kakao }) {
  const account = process.env.PPURIO_ACCOUNT;
  const apiKey = process.env.PPURIO_API_KEY;
  const defaultSender = process.env.PPURIO_SENDER;
  if (!account || !apiKey || !(from || defaultSender)) {
    return { ok: false, error: "ppurio_not_configured",
      message: "PPURIO_ACCOUNT / PPURIO_API_KEY / PPURIO_SENDER 환경변수 미설정" };
  }
  const auth = Buffer.from(`${account}:${apiKey}`).toString("base64");
  const body = {
    account, messageType: messageType || "SMS",
    from: (from || defaultSender).replace(/-/g, ""),
    to: to.replace(/-/g, ""),
    content,
  };
  if (messageType === "LMS" && subject) body.subject = subject;
  if (messageType === "AT" && kakao) {
    body.kakaoOptions = {
      senderKey: process.env.PPURIO_KAKAO_PROFILE_KEY,
      templateCode: kakao.templateCode,
      buttons: kakao.buttons || [],
    };
  }
  try {
    const r = await fetch(PPURIO_URL, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, status: r.status, error: data?.code || "ppurio_api_error",
        message: data?.description || data?.message || `HTTP ${r.status}` };
    }
    return { ok: true, messageKey: data?.messageKey || data?.refKey, raw: data };
  } catch (e) {
    return { ok: false, error: "network_error", message: e.message };
  }
}

async function safeBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch (e) {} }
  return new Promise(res => {
    const c = []; req.on("data", x => c.push(x));
    req.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString("utf-8"))); } catch (e) { res({}); } });
    req.on("error", () => res({}));
  });
}

export default async function handler(req, res) {
  // GET → status (키 설정 확인용)
  if (req.method === "GET") {
    return res.json({
      ok: true,
      configured: {
        account: !!process.env.PPURIO_ACCOUNT,
        api_key: !!process.env.PPURIO_API_KEY,
        sender: !!process.env.PPURIO_SENDER,
        kakao_profile: !!process.env.PPURIO_KAKAO_PROFILE_KEY,
        supabase_logging: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      },
      message: "POST { to, content, messageType?, subject?, kakao?, bookingId?, kind? } 로 발송",
    });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const body = await safeBody(req).catch(() => ({}));
  const { to, content, messageType, subject, kakao, bookingId, kind, facilityCode = "jp" } = body;
  if (!to || !content) {
    return res.status(400).json({ error: "missing_fields", message: "to + content 필수",
      received: { to: !!to, content: !!content } });
  }
  if (!/^0\d{1,2}-?\d{3,4}-?\d{4}$/.test(to.replace(/\s/g, ""))) {
    return res.status(400).json({ error: "invalid_phone", message: `유효한 휴대폰 번호 형식 아님: ${to}` });
  }
  if (content.length > 2000) {
    return res.status(400).json({ error: "content_too_long", message: "메시지는 2000자 이내" });
  }

  const t0 = Date.now();
  const result = await callPpurio({ messageType, to, from: body.from, content, subject, kakao });
  const elapsedMs = Date.now() - t0;

  // 로그 저장 (Supabase 가용 시)
  const sb = getSb();
  if (sb) {
    try {
      await sb.from("res_sms_logs").insert({
        facility_code: facilityCode,
        booking_id: bookingId || null,
        kind: kind || "manual",
        recipient: to,
        message_type: messageType || "SMS",
        content,
        subject: subject || null,
        status: result.ok ? "sent" : "failed",
        message_key: result.messageKey || null,
        error_code: result.error || null,
        error_message: result.message || null,
        elapsed_ms: elapsedMs,
        sent_at: new Date().toISOString(),
      });
    } catch (e) { console.warn("[sms-send] log save failed:", e.message); }
  }

  if (!result.ok) return res.status(result.status === 429 ? 429 : 502).json(result);
  return res.json({ ok: true, ...result, elapsedMs });
}
