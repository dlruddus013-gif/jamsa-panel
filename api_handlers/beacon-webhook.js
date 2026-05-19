// /api/beacon-webhook — Minew G1, 현승코리아 B-Fon 등 BLE 게이트웨이 수신 엔드포인트
//
// POST: 게이트웨이가 감지한 비콘 데이터 수신
// GET ?ping=1: 헬스체크
// GET ?recent=1: 최근 수신 데이터 1건 조회 (테스트용)

const _recentByGateway = new Map(); // 메모리 캐시 (서버리스 cold start 시 리셋)
let _lastReceived = null;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(204).end();

  // 헬스체크
  if (req.method === "GET") {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.searchParams.get("ping") === "1") {
      return res.status(200).json({ ok: true, service: "jamsa-beacon-webhook", time: new Date().toISOString() });
    }
    if (url.searchParams.get("recent") === "1") {
      return res.status(200).json({ ok: true, last: _lastReceived });
    }
    return res.status(200).json({
      ok: true,
      service: "jamsa-beacon-webhook",
      gateways: Array.from(_recentByGateway.keys()),
      docs: "POST { gatewaySerial, beacons: [{uuid, rssi, name}], timestamp } to register beacon detections",
    });
  }

  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method not allowed" });

  try {
    let payload = req.body;
    if (typeof payload === "string") { try { payload = JSON.parse(payload); } catch (e) {} }
    if (!payload || typeof payload !== "object") return res.status(400).json({ ok: false, error: "invalid body" });

    const gw = payload.gatewaySerial || payload.gateway || payload.gw || payload.gw_mac || payload.deviceMac || payload.gmac || "unknown";
    // Minew G1 포맷: payload.obj 배열, 각 항목 { mac, rssi, ts, type, data, name? }
    const rawBeacons = payload.beacons || payload.advertisements || payload.data || payload.obj || payload.devices || [];
    const beacons = Array.isArray(rawBeacons) ? rawBeacons.map(b => ({
      uuid: b.uuid || b.id || b.mac || b.macAddress || b.bleMac || b.device_mac,
      mac: b.mac || b.macAddress || b.bleMac || b.device_mac || b.uuid,
      name: b.name || b.deviceName || null,
      rssi: b.rssi != null ? Number(b.rssi) : null,
      txPower: b.txPower || b.tx_power || null,
      type: b.type || null,
      data: b.data || b.adv || null,
      ts: b.ts || b.timestamp || null,
      raw: b,
    })) : [];
    const ts = payload.timestamp || payload.ts || new Date().toISOString();

    _recentByGateway.set(gw, { at: new Date().toISOString(), payload, beaconCount: Array.isArray(beacons) ? beacons.length : 0 });
    _lastReceived = { receivedAt: new Date().toISOString(), gateway: gw, payload };

    // Supabase 자동 저장 (service_role 우선, 없으면 anon RLS 정책에 의지)
    try {
      const supaUrl = process.env.SUPABASE_URL;
      const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
      if (supaUrl && supaKey && Array.isArray(beacons) && beacons.length > 0) {
        const rows = beacons.map(b => ({
          gateway_serial: gw,
          beacon_uuid: b.uuid || b.mac,
          beacon_name: b.name || null,
          rssi: b.rssi,
          tx_power: b.txPower || null,
          raw: b.raw || b,
          detected_at: typeof ts === "number" ? new Date(ts * (ts < 1e12 ? 1000 : 1)).toISOString() : ts,
        })).filter(r => r.beacon_uuid);
        if (rows.length > 0) {
          const res = await fetch(`${supaUrl}/rest/v1/beacon_detections`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "apikey": supaKey,
              "Authorization": `Bearer ${supaKey}`,
              "Prefer": "return=minimal",
            },
            body: JSON.stringify(rows),
          });
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            console.warn("[beacon-webhook] supabase insert failed:", res.status, txt.slice(0, 200));
          }
        }
      }
    } catch (e) {
      // DB 저장 실패해도 200 반환 (게이트웨이가 재시도하지 않도록)
      console.warn("[beacon-webhook] supabase insert failed:", e.message);
    }

    return res.status(200).json({
      ok: true,
      received: Array.isArray(beacons) ? beacons.length : 0,
      gateway: gw,
      test: !!payload.test,
    });
  } catch (e) {
    console.error("[beacon-webhook]", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
