/**
 * Minew 게이트웨이 수신 + 조회 API
 *
 * 동일 로직 3경로 매핑:
 *   POST /minew
 *   POST /api/minew
 *   POST /api/beacon
 *   POST /webhook/minew
 */
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const db = require("../db");
const { normalizeMinewPayload, rssiLabel } = require("../services/normalizeMinewPayload");
const { describeIdentity, MAJOR_TO_DEPT } = require("../services/beaconLocationMapper");

const router = express.Router();

const LOG_DIR = path.resolve(__dirname, "..", "..", "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
function logError(scope, err, extra = {}) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    scope,
    error: err?.message || String(err),
    stack: err?.stack,
    ...extra,
  }) + "\n";
  try { fs.appendFileSync(path.join(LOG_DIR, "error.log"), line); } catch (_) {}
}

// ─── 메인 수신 ───────────────────────────────────────────────────
async function ingest(req, res) {
  const ctx = {
    receivedAt: new Date().toISOString(),
    clientIp: (req.headers["x-forwarded-for"] || req.ip || req.connection.remoteAddress || "").toString().split(",")[0].trim(),
    userAgent: req.headers["user-agent"] || null,
    contentType: req.headers["content-type"] || null,
    rawText: typeof req.body === "string" ? req.body : JSON.stringify(req.body),
  };

  // 배열로 들어오는 경우 (다건) 각각 처리
  const payloads = Array.isArray(req.body) ? req.body : [req.body];
  const results = [];

  for (const payload of payloads) {
    try {
      const { packet, events } = normalizeMinewPayload(payload, ctx);

      // 패킷 저장
      const packet_id = db.insertPacket(packet);

      // 이벤트별 tag_id 자동 해석 + 저장
      const eventIds = [];
      for (const e of events) {
        e.packet_id = packet_id;
        e.tag_id = db.resolveAndMergeTagId(e);
        try {
          eventIds.push(db.insertEvent(e));
        } catch (err) {
          logError("insertEvent", err, { event: e });
        }
        // 콘솔 즉시 출력 — 게이트웨이 작동 여부 한눈에
        const id = describeIdentity(e);
        console.log(
          `[수신] gw=${e.gateway_mac} beacon=${e.beacon_mac} ` +
          `type=${e.packet_type} rssi=${e.rssi ?? "-"} ` +
          `${e.tag_id ? `tag=${e.tag_id}` : `[미등록] ${id.label}`}` +
          `${e.battery_mv ? ` batt=${e.battery_mv}mV` : ""}`
        );
      }

      results.push({
        ok: true,
        packet_id,
        event_count: events.length,
        event_ids: eventIds,
        tag_ids: [...new Set(events.map(e => e.tag_id).filter(Boolean))],
      });
    } catch (err) {
      logError("ingest", err, { payload });
      results.push({ ok: false, error: err.message });
    }
  }

  res.json(Array.isArray(req.body) ? { results } : results[0]);
}

router.post("/minew", ingest);
router.post("/api/minew", ingest);
router.post("/webhook/minew", ingest);
router.post("/api/beacon", ingest);

// ─── 조회 API ─────────────────────────────────────────────────────
router.get("/api/health", (_req, res) => {
  res.json({ ok: true, status: "ok", time: new Date().toISOString() });
});

router.get("/api/events/recent", (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const events = db.listRecentEvents({
    limit,
    gateway_mac: req.query.gateway_mac,
    tag_id: req.query.tag_id,
  }).map(e => ({
    ...e,
    rssi_status: rssiLabel(e.rssi),
    identity: describeIdentity(e),
  }));
  res.json({ ok: true, count: events.length, events });
});

router.get("/api/tags", (_req, res) => {
  const tags = db.listTags().map(t => ({
    ...t,
    rssi_status: rssiLabel(t.rssi_recent),
    department_meta: MAJOR_TO_DEPT[t.major] || null,
  }));
  res.json({ ok: true, count: tags.length, tags });
});

router.get("/api/gateways", (_req, res) => {
  res.json({ ok: true, gateways: db.listGateways() });
});

router.get("/api/dashboard-summary", (_req, res) => {
  res.json({ ok: true, ...db.dashboardSummary() });
});

router.get("/api/major-map", (_req, res) => {
  res.json({ ok: true, mapping: MAJOR_TO_DEPT });
});

module.exports = router;
