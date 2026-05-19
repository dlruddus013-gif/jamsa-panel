/**
 * 게이트웨이 HTTP 수신 + 조회 API
 *
 * 수신 경로 (모두 동일 로직 — 들어온 payload 형태로 자동 분기):
 *   POST /minew · /api/minew · /webhook/minew · /api/beacon  → Minew 우선
 *   POST /tplink · /api/tplink · /webhook/tplink              → TP-Link Omada 우선
 *   POST /api/beacon-any                                       → 완전 자동 감지
 */
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const db = require("../db");
const { normalizeMinewPayload, rssiLabel } = require("../services/normalizeMinewPayload");
const { normalizeTpLinkPayload, looksLikeTpLink } = require("../services/normalizeTpLinkPayload");
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

/** 자동 감지: payload 모양 보고 normalizer 선택 */
function pickNormalizer(payload, hint) {
  // 명시 힌트 우선
  if (hint === "tplink") return normalizeTpLinkPayload;
  if (hint === "minew")  return normalizeMinewPayload;
  // 자동
  if (looksLikeTpLink(payload)) return normalizeTpLinkPayload;
  return normalizeMinewPayload; // 기본
}

// ─── 메인 수신 ───────────────────────────────────────────────────
function makeIngest(hint) {
  return async function ingest(req, res) {
    const ctx = {
      receivedAt: new Date().toISOString(),
      clientIp: (req.headers["x-forwarded-for"] || req.ip || req.connection.remoteAddress || "").toString().split(",")[0].trim(),
      userAgent: req.headers["user-agent"] || null,
      contentType: req.headers["content-type"] || null,
      rawText: typeof req.body === "string" ? req.body : JSON.stringify(req.body),
    };

    const payloads = Array.isArray(req.body) ? req.body : [req.body];
    const results = [];

    for (const payload of payloads) {
      try {
        const normalizer = pickNormalizer(payload, hint);
        const { packet, events, source } = normalizer(payload, ctx);

        const packet_id = db.insertPacket(packet);
        const eventIds = [];
        for (const e of events) {
          e.packet_id = packet_id;
          e.tag_id = db.resolveAndMergeTagId(e);
          try { eventIds.push(db.insertEvent(e)); }
          catch (err) { logError("insertEvent", err, { event: e }); }

          const id = describeIdentity(e);
          const srcTag = source === "tplink" ? "[tplink]" : "[minew]";
          console.log(
            `${srcTag} gw=${e.gateway_mac} beacon=${e.beacon_mac} ` +
            `type=${e.packet_type} rssi=${e.rssi ?? "-"} ` +
            `${e.tag_id ? `tag=${e.tag_id}` : `[미등록] ${id.label}`}` +
            `${e.battery_mv ? ` batt=${e.battery_mv}mV` : ""}`
          );
        }

        results.push({
          ok: true,
          source: source || "minew",
          packet_id,
          event_count: events.length,
          event_ids: eventIds,
          tag_ids: [...new Set(events.map(e => e.tag_id).filter(Boolean))],
        });
      } catch (err) {
        logError("ingest", err, { payload, hint });
        results.push({ ok: false, error: err.message });
      }
    }

    res.json(Array.isArray(req.body) ? { results } : results[0]);
  };
}

// Minew 경로 (기본 normalizer = minew, 단 TP-Link 패턴 자동 감지)
const ingestMinew = makeIngest(null);
router.post("/minew", ingestMinew);
router.post("/api/minew", ingestMinew);
router.post("/webhook/minew", ingestMinew);
router.post("/api/beacon", ingestMinew);

// TP-Link 명시 경로 (강제 tplink normalizer)
const ingestTpLink = makeIngest("tplink");
router.post("/tplink", ingestTpLink);
router.post("/api/tplink", ingestTpLink);
router.post("/webhook/tplink", ingestTpLink);
router.post("/api/omada", ingestTpLink);

// 완전 자동 감지 (어떤 형식이든)
router.post("/api/beacon-any", makeIngest(null));

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
