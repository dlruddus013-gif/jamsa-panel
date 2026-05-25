// api/coupon-verify.js
// 경품 입장권 QR 검증 (매표소 스캔용)
// GET ?code=JP-2026-XXXX → 상태 조회
// POST { code, action: "use" } → 사용 처리 (한 번만 가능)

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

export default async function handler(req, res) {
  const sb = getSb();
  if (!sb) return res.status(500).json({ error: "supabase_not_configured" });

  // GET: 상태 조회
  if (req.method === "GET") {
    const code = req.query?.code;
    if (!code) return res.status(400).json({ error: "missing_code" });
    const { data, error } = await sb.from("res_coupons")
      .select("code, coupon_type, description, recipient_phone, recipient_name, " +
              "issued_at, expires_at, used, used_at, used_by")
      .eq("code", code).maybeSingle();
    if (error || !data) return res.status(404).json({ error: "coupon_not_found" });
    const now = new Date();
    const expired = data.expires_at && new Date(data.expires_at) < now;
    return res.json({
      ok: true, coupon: data,
      status: data.used ? "used" : (expired ? "expired" : "valid"),
      expired,
    });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const body = await safeBody(req);
  const { code, action, used_by } = body;
  if (!code || !action) return res.status(400).json({ error: "missing_fields" });

  if (action !== "use") return res.status(400).json({ error: "invalid_action", message: "action=use 만 지원" });

  // 사용 처리 — 한 번만 가능
  const { data: coupon, error } = await sb.from("res_coupons")
    .select("id, used, expires_at").eq("code", code).maybeSingle();
  if (error || !coupon) return res.status(404).json({ error: "coupon_not_found" });
  if (coupon.used) return res.status(409).json({ error: "already_used" });
  if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
    return res.status(410).json({ error: "expired" });
  }

  const { error: upErr } = await sb.from("res_coupons").update({
    used: true,
    used_at: new Date().toISOString(),
    used_by: used_by || "anonymous",
  }).eq("id", coupon.id);
  if (upErr) return res.status(500).json({ error: "update_failed", message: upErr.message });

  return res.json({ ok: true, code, used_at: new Date().toISOString() });
}
