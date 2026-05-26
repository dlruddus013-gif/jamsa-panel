// /api/presence-cctv-analyze
// 비콘 감지 → CCTV 분석 결과 로그 (logger 엔드포인트)
//
// 실제 분석은 클라이언트가 수행 (CCTV 서버 LAN 접근 필요):
//   1) 브라우저가 v_active_cctv_tracking 폴링 (30초)
//   2) 각 활성 presence 에 대해 CCTV 스냅샷 fetch + /api/cctv-ai-analyze 호출
//   3) 결과를 이 엔드포인트로 POST → presence_cctv_snapshots 행 추가
//
// GET  ?presence_event_id=N  : 해당 이벤트의 스냅샷 전체 시계열 반환
// POST { presence_event_id, event_type, snapshot_url, ai_summary, ai_detail,
//        ai_actions, ai_changed_from, ai_confidence, ai_elapsed_ms,
//        cctv_channel, dwell_sec, tick_seq, rssi }
//   → presence_cctv_snapshots 에 삽입
//   → 행동변화(behavior_change) 자동 감지: ai_summary 가 직전 행과 다르면 event_type 강제 변경

const SUPA_URL  = process.env.SUPABASE_URL;
const SUPA_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

async function supaFetch(path, opts = {}) {
  const url = `${SUPA_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPA_KEY,
      "Authorization": `Bearer ${SUPA_KEY}`,
      "Prefer": opts.method === "POST" ? "return=representation" : "",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`supabase ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.json();
}

function safeParseBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch (e) {} }
  return {};
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (!SUPA_URL || !SUPA_KEY) {
    return res.status(500).json({ ok: false, error: "SUPABASE_URL/KEY 미설정" });
  }

  // ───── GET : 진단 + 시계열 조회 ─────
  if (req.method === "GET") {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const eventId = url.searchParams.get("presence_event_id");
    if (eventId) {
      try {
        const rows = await supaFetch(
          `presence_cctv_snapshots?presence_event_id=eq.${eventId}&order=occurred_at.asc`,
          { method: "GET" }
        );
        return res.status(200).json({ ok: true, snapshots: rows });
      } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
      }
    }
    // 최근 활성 추적 목록
    try {
      const active = await supaFetch("v_active_cctv_tracking?order=entered_at.desc&limit=30", { method: "GET" });
      return res.status(200).json({ ok: true, active });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  const body = safeParseBody(req);
  if (!body.presence_event_id) {
    return res.status(400).json({ ok: false, error: "presence_event_id_required" });
  }

  try {
    // 직전 스냅샷의 ai_summary 조회 (변화 감지용)
    let prevSummary = null;
    let lastTickSeq = 0;
    try {
      const prev = await supaFetch(
        `presence_cctv_snapshots?presence_event_id=eq.${body.presence_event_id}&order=occurred_at.desc&limit=1`,
        { method: "GET" }
      );
      if (Array.isArray(prev) && prev.length > 0) {
        prevSummary = prev[0].ai_summary || null;
        lastTickSeq = prev[0].tick_seq || 0;
      }
    } catch (e) { /* ignore */ }

    // 이벤트 종류 결정
    let eventType = body.event_type || "tick_30s";
    const eventTypesAllowed = new Set(["entry","tick_30s","behavior_change","exit","manual"]);
    if (!eventTypesAllowed.has(eventType)) eventType = "tick_30s";

    // 30s tick 인데 ai_summary 가 직전과 다르면 → behavior_change 로 승격
    if (
      eventType === "tick_30s" && body.ai_summary && prevSummary &&
      body.ai_summary.trim() !== prevSummary.trim() &&
      simHashDiffer(body.ai_summary, prevSummary)
    ) {
      eventType = "behavior_change";
    }

    const payload = {
      presence_event_id: body.presence_event_id,
      staff_id:        body.staff_id || null,
      staff_name:      body.staff_name || null,
      beacon_uuid:     body.beacon_uuid || null,
      zone_id:         body.zone_id || null,
      zone_name:       body.zone_name || null,
      gateway_serial:  body.gateway_serial || null,
      cctv_channel:    body.cctv_channel || null,
      event_type:      eventType,
      tick_seq:        Number.isFinite(body.tick_seq) ? body.tick_seq : (lastTickSeq + 1),
      dwell_sec:       body.dwell_sec || null,
      snapshot_url:    body.snapshot_url || null,
      snapshot_b64:    body.snapshot_b64 || null,
      ai_provider:     body.ai_provider || "auto",
      ai_summary:      body.ai_summary || null,
      ai_detail:       body.ai_detail || null,
      ai_actions:      body.ai_actions || null,
      ai_changed_from: eventType === "behavior_change" ? prevSummary : null,
      ai_confidence:   body.ai_confidence || null,
      ai_elapsed_ms:   body.ai_elapsed_ms || null,
      rssi:            body.rssi || null,
      raw:             body.raw || null,
      occurred_at:     body.occurred_at || new Date().toISOString(),
    };

    const inserted = await supaFetch("presence_cctv_snapshots", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    return res.status(200).json({
      ok: true,
      snapshot: Array.isArray(inserted) ? inserted[0] : inserted,
      eventType,
      promoted: eventType === "behavior_change" && body.event_type !== "behavior_change",
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// 같은 의미인데 표현이 살짝 다른 경우는 변화로 간주하지 않도록 간단한 토큰 비교
function simHashDiffer(a, b) {
  const norm = (s) => (s || "").toLowerCase().replace(/[.,!?()\[\]"'·]/g, " ").replace(/\s+/g, " ").trim();
  const A = new Set(norm(a).split(" ").filter(w => w.length > 1));
  const B = new Set(norm(b).split(" ").filter(w => w.length > 1));
  if (A.size === 0 || B.size === 0) return true;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  const jaccard = common / (A.size + B.size - common);
  return jaccard < 0.55;  // 55% 이하 일치 → 변화로 본다
}
