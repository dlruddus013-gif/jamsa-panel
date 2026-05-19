/**
 * MQTT 어댑터 — TP-Link Omada Controller가 BLE 스캔 데이터를 MQTT 브로커로 push할 때 사용.
 *
 * 활성화: .env에 MQTT_URL 설정
 *   MQTT_URL=mqtt://broker.local:1883
 *   MQTT_TOPIC=omada/ble/#                (선택, 기본값)
 *   MQTT_USERNAME=...                     (선택)
 *   MQTT_PASSWORD=...                     (선택)
 *
 * 의존성: `mqtt` 패키지 (optional — 필요할 때만 설치)
 *   npm install mqtt
 */
const fs = require("node:fs");
const path = require("node:path");
const db = require("../db");
const { normalizeMinewPayload } = require("../services/normalizeMinewPayload");
const { normalizeTpLinkPayload, looksLikeTpLink } = require("../services/normalizeTpLinkPayload");

function logError(scope, err, extra = {}) {
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), scope, error: err?.message || String(err), ...extra }) + "\n";
    fs.appendFileSync(path.resolve(__dirname, "..", "..", "logs", "error.log"), line);
  } catch (_) {}
}

function start() {
  const url = process.env.MQTT_URL;
  if (!url) return null; // 미설정이면 비활성화

  let mqtt;
  try { mqtt = require("mqtt"); }
  catch (e) {
    console.warn("[mqtt] 'mqtt' 패키지가 없습니다. 'npm install mqtt' 후 다시 시작하세요. MQTT 어댑터 비활성화.");
    return null;
  }

  const topic = process.env.MQTT_TOPIC || "omada/ble/#";
  const opts = {
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    reconnectPeriod: 5000,
  };

  console.log(`[mqtt] 연결 중 — ${url} → topic="${topic}"`);
  const client = mqtt.connect(url, opts);

  client.on("connect", () => {
    console.log("[mqtt] ✓ 연결됨");
    client.subscribe(topic, (err) => {
      if (err) console.error("[mqtt] subscribe 실패:", err.message);
      else console.log(`[mqtt] 구독: ${topic}`);
    });
  });

  client.on("error", (err) => console.error("[mqtt] error:", err.message));
  client.on("reconnect", () => console.log("[mqtt] 재연결 시도..."));

  client.on("message", (recvTopic, message) => {
    const rawText = message.toString();
    let payload;
    try { payload = JSON.parse(rawText); }
    catch (_) { payload = { raw_text: rawText, topic: recvTopic }; }

    const ctx = {
      receivedAt: new Date().toISOString(),
      clientIp: `mqtt://${recvTopic}`,
      userAgent: "mqtt-client",
      contentType: "application/json",
      rawText,
    };

    try {
      const normalize = looksLikeTpLink(payload) ? normalizeTpLinkPayload : normalizeMinewPayload;
      const { packet, events, source } = normalize(payload, ctx);

      const packet_id = db.insertPacket(packet);
      for (const e of events) {
        e.packet_id = packet_id;
        e.tag_id = db.resolveAndMergeTagId(e);
        try { db.insertEvent(e); } catch (err) { logError("mqtt insertEvent", err); }
        console.log(`[mqtt:${source || "minew"}] topic=${recvTopic} beacon=${e.beacon_mac} rssi=${e.rssi ?? "-"} ${e.tag_id ? `tag=${e.tag_id}` : "[미등록]"}`);
      }
    } catch (err) {
      logError("mqtt message", err, { topic: recvTopic, rawText: rawText.slice(0, 500) });
    }
  });

  return client;
}

module.exports = { start };
