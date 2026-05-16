// Jamsa <-> OKPOS local bridge.
// Run on the museum main POS PC. It receives browser events from jamsa-panel
// and keeps a durable local queue until an OKPOS write adapter is configured.

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");

const PORT = Number(process.env.JAMSA_OKPOS_BRIDGE_PORT || 5566);
const OKPOS_EXE = process.env.JAMSA_OKPOS_EXE || "C:\\_OKPOS\\BIN\\OKPos.exe";
const OKPOS_DB = process.env.JAMSA_OKPOS_DB || "C:\\_OKPOS\\DATA\\OKPOS.FDB";
const DATA_DIR = process.env.JAMSA_OKPOS_BRIDGE_DIR || path.join(process.env.ProgramData || os.tmpdir(), "Jamsa", "okpos-bridge");
const QUEUE_FILE = path.join(DATA_DIR, "usage-events.jsonl");
const ERROR_FILE = path.join(DATA_DIR, "errors.jsonl");

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function json(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(raw),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(raw);
}

function appendJsonl(file, value) {
  ensureDir();
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("payload_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(new Error("invalid_json")); }
    });
    req.on("error", reject);
  });
}

function queueCount() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return 0;
    const raw = fs.readFileSync(QUEUE_FILE, "utf8").trim();
    return raw ? raw.split(/\r?\n/).length : 0;
  } catch (e) {
    return null;
  }
}

function isProcessRunning(name) {
  try {
    const out = childProcess.execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Get-Process -Name '${name.replace(/\.exe$/i, "")}' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id`,
    ], { windowsHide: true, encoding: "utf8" });
    return Boolean(String(out || "").trim());
  } catch (e) {
    return false;
  }
}

function serviceStatus(name) {
  try {
    return childProcess.execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Get-Service -Name '${name}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Status`,
    ], { windowsHide: true, encoding: "utf8" }).trim() || "Unknown";
  } catch (e) {
    return "Unknown";
  }
}

function startOkpos() {
  if (!fs.existsSync(OKPOS_EXE)) return { ok: false, message: "OKPOS executable not found", path: OKPOS_EXE };
  childProcess.spawn(OKPOS_EXE, {
    cwd: path.dirname(OKPOS_EXE),
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  }).unref();
  return { ok: true, message: "OKPOS start requested", path: OKPOS_EXE };
}

function bridgeStatus() {
  return {
    ok: true,
    bridge: "jamsa-okpos-bridge",
    port: PORT,
    dataDir: DATA_DIR,
    queueFile: QUEUE_FILE,
    queueCount: queueCount(),
    okpos: {
      exe: OKPOS_EXE,
      exeExists: fs.existsSync(OKPOS_EXE),
      running: isProcessRunning("OKPos.exe"),
      db: OKPOS_DB,
      dbExists: fs.existsSync(OKPOS_DB),
      firebird: serviceStatus("FirebirdServerDefaultInstance"),
    },
    adapter: {
      mode: process.env.JAMSA_OKPOS_ADAPTER || "queue-only",
      directDbWriteEnabled: process.env.JAMSA_OKPOS_DIRECT_DB_WRITE === "1",
    },
    checkedAt: new Date().toISOString(),
  };
}

async function handleUsage(req, res) {
  const payload = await readJson(req);
  const event = {
    id: payload.id || `okpos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    receivedAt: new Date().toISOString(),
    status: "queued",
    payload,
  };

  if (!payload.type) return json(res, 400, { ok: false, message: "missing type" });
  if (!payload.visitorId && !payload.orderId && !payload.code && !payload.productName) {
    return json(res, 400, { ok: false, message: "missing usage identity" });
  }

  if (process.env.JAMSA_OKPOS_AUTO_START === "1" && !isProcessRunning("OKPos.exe")) {
    event.okposStart = startOkpos();
  }

  // Direct OKPOS DB write is intentionally disabled until a vendor-approved
  // table/procedure mapping is supplied. The queue keeps every online usage
  // event durable so no use record is lost while mapping is finalized.
  appendJsonl(QUEUE_FILE, event);
  json(res, 200, {
    ok: true,
    queued: true,
    id: event.id,
    queueCount: queueCount(),
    message: "온라인 사용처리 이벤트가 OKPOS 브릿지 대기열에 저장되었습니다.",
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return json(res, 200, { ok: true });
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, bridgeStatus());
    if (req.method === "POST" && url.pathname === "/okpos/start") return json(res, 200, startOkpos());
    if (req.method === "POST" && url.pathname === "/okpos/usage") return handleUsage(req, res);
    json(res, 404, { ok: false, message: "not_found" });
  } catch (e) {
    appendJsonl(ERROR_FILE, { at: new Date().toISOString(), error: e.message || String(e) });
    json(res, 500, { ok: false, message: e.message || String(e) });
  }
});

ensureDir();
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[jamsa-okpos-bridge] listening http://127.0.0.1:${PORT}`);
  console.log(`[jamsa-okpos-bridge] queue ${QUEUE_FILE}`);
});
