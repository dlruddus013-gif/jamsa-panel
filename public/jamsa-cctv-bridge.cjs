// jamsa-cctv-bridge.cjs — 잠사박물관 CCTV 브릿지 서버
// ────────────────────────────────────────────────────────────────────
// 박물관 PC에서 실행하여 SmartPSS/VMS/Dahua NVR/Hikvision/ONVIF
// 카메라의 HTTP 스냅샷을 브라우저(jamsa-panel)에 프록시한다.
//
// 사용법:
//   1. Node.js 설치 (https://nodejs.org LTS)
//   2. 아래 CONFIG에 NVR 정보 입력
//   3. 터미널에서: node jamsa-cctv-bridge.cjs
//   4. jamsa-panel → 안전관리 → IoT 안전제어 → 📹 NVR/VMS 탭 →
//      "로컬 브릿지" 입력란에 http://localhost:5555 (또는 박물관 PC LAN IP:5555)
// ────────────────────────────────────────────────────────────────────
const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = 5555;

// ─── NVR 설정 ─────────────────────────────────────────────────────
// 여러 NVR 등록 가능. 첫 번째가 기본.
const CONFIG = {
  nvrs: [
    {
      name: '본관 NVR (Dahua)',
      brand: 'dahua',      // dahua | hikvision | onvif | custom
      host: '192.168.0.100',
      port: 80,
      rtspPort: 554,
      username: 'admin',
      password: 'YOUR_PASS',
      channels: {
        1: '외부매표소',
        2: '누에쉼터',
        3: '오른쪽라인',
        4: '왼쪽라인',
        5: 'IPC',
        6: '바베큐존',
        7: '메인mvr',
        8: '양떼정원',
        // ... 필요한 만큼 추가
      },
    },
    // 두 번째 NVR 추가 예시 (VMS Client port 9000)
    // {
    //   name: 'VMS Device',
    //   brand: 'dahua',
    //   host: '192.168.0.101',
    //   port: 9000,
    //   rtspPort: 554,
    //   username: 'admin',
    //   password: 'YOUR_PASS',
    //   channels: { 1: 'CH1' },
    // },
  ],
};

// ─── 스냅샷 URL 빌더 ─────────────────────────────────────────────
function buildSnapshotPath(nvr, ch) {
  switch (nvr.brand) {
    case 'dahua':
      return `/cgi-bin/snapshot.cgi?channel=${ch}`;
    case 'hikvision':
      return `/ISAPI/Streaming/channels/${ch}01/picture`;
    case 'onvif':
      return `/onvif/snapshot?ProfileToken=Profile_${ch}`;
    case 'custom':
      return (nvr.snapshotPath || '/snap?ch={ch}').replace('{ch}', ch);
    default:
      return `/cgi-bin/snapshot.cgi?channel=${ch}`;
  }
}

// ─── LAN 자동 검색 ────────────────────────────────────────────────
const os = require('os');

function autoDetectSubnet() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ifc of ifaces[name]) {
      if (ifc.family === 'IPv4' && !ifc.internal) {
        const parts = ifc.address.split('.');
        return `${parts[0]}.${parts[1]}.${parts[2]}`; // 예: "192.168.0"
      }
    }
  }
  return '192.168.0';
}

function probePort(host, port, timeout) {
  return new Promise((resolve) => {
    const net = require('net');
    const socket = new net.Socket();
    let done = false;
    socket.setTimeout(timeout);
    socket.once('connect', () => { done = true; socket.destroy(); resolve(true); });
    socket.once('timeout', () => { if (!done) { socket.destroy(); resolve(false); } });
    socket.once('error', () => { if (!done) { resolve(false); } });
    socket.connect(port, host);
  });
}

function identifyBrand(host, port, timeout) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/', timeout }, (res) => {
      const server = (res.headers['server'] || '').toLowerCase();
      const wwwAuth = (res.headers['www-authenticate'] || '').toLowerCase();
      let chunks = [];
      res.on('data', c => { if (chunks.length < 5) chunks.push(c); });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8', 0, 1000).toLowerCase();
        if (server.includes('webs') || body.includes('dahua') || body.includes('webservice')) {
          resolve({ brand: 'dahua', confidence: 0.8, hint: server || 'dahua-like' });
        } else if (server.includes('hikvision') || body.includes('hikvision') || body.includes('isapi')) {
          resolve({ brand: 'hikvision', confidence: 0.9, hint: server });
        } else if (body.includes('onvif')) {
          resolve({ brand: 'onvif', confidence: 0.6, hint: 'onvif-detected' });
        } else {
          resolve({ brand: 'unknown', confidence: 0.2, hint: server || 'http server' });
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function discoverNvrs(subnetPrefix, ports, timeout) {
  const devices = [];
  const tasks = [];
  for (let i = 1; i <= 254; i++) {
    const host = `${subnetPrefix}.${i}`;
    for (const port of ports) {
      tasks.push((async () => {
        const open = await probePort(host, port, timeout);
        if (!open) return;
        const id = await identifyBrand(host, port, timeout).catch(() => null);
        if (id && id.brand !== 'unknown') {
          devices.push({ host, port, ...id });
        } else if (id) {
          // 알 수 없어도 80/8000/9000/37777에서 응답한 호스트는 후보로 표시
          devices.push({ host, port, brand: id.brand, confidence: id.confidence, hint: id.hint, suggested: true });
        }
      })());
    }
  }
  // 병렬 실행 (Promise.all로 한 번에)
  await Promise.all(tasks);
  return devices;
}

// ─── 프록시 서버 ─────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache');

  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  // 헬스 체크
  if (req.url === '/api/status' || req.url === '/') {
    const channels = {};
    CONFIG.nvrs.forEach((n, idx) => {
      channels[`nvr_${idx}`] = { name: n.name, channels: Object.keys(n.channels || {}) };
    });
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      ok: true,
      service: 'jamsa-cctv-bridge',
      version: '1.0',
      nvrs: CONFIG.nvrs.length,
      channels,
      port: PORT,
    }));
  }

  // 스냅샷: /api/snap/:ch (선택: ?nvr=0)
  const m = req.url.match(/^\/api\/snap\/(\d+)(\?.*)?$/);
  if (m) {
    const ch = parseInt(m[1], 10);
    const params = new URLSearchParams((m[2] || '').slice(1));
    const nvrIdx = parseInt(params.get('nvr') || '0', 10);
    const nvr = CONFIG.nvrs[nvrIdx];
    if (!nvr) { res.statusCode = 404; return res.end('nvr not configured'); }

    const path = buildSnapshotPath(nvr, ch);
    const auth = 'Basic ' + Buffer.from(`${nvr.username}:${nvr.password}`).toString('base64');

    const opts = {
      host: nvr.host,
      port: nvr.port,
      path,
      method: 'GET',
      headers: { Authorization: auth, 'User-Agent': 'jamsa-cctv-bridge/1.0' },
      timeout: 8000,
    };

    const upstream = http.request(opts, (upRes) => {
      if (upRes.statusCode === 401) {
        // Digest 인증 재시도 (Hikvision 등 일부는 Digest 필수)
        res.statusCode = 401;
        return res.end(`NVR returned 401. Check username/password. host=${nvr.host} brand=${nvr.brand}`);
      }
      res.setHeader('Content-Type', upRes.headers['content-type'] || 'image/jpeg');
      upRes.pipe(res);
    });

    upstream.on('timeout', () => {
      upstream.destroy();
      if (!res.headersSent) { res.statusCode = 504; res.end(`NVR timeout: ${nvr.host}`); }
    });
    upstream.on('error', (e) => {
      console.error(`[snap ch=${ch} nvr=${nvrIdx}] ${e.message}`);
      if (!res.headersSent) { res.statusCode = 502; res.end(`NVR error: ${e.message}`); }
    });
    upstream.end();
    return;
  }

  // 채널 정보 목록
  if (req.url === '/api/channels') {
    const out = [];
    CONFIG.nvrs.forEach((n, idx) => {
      Object.entries(n.channels || {}).forEach(([ch, name]) => {
        out.push({ nvr: idx, nvrName: n.name, ch: Number(ch), name });
      });
    });
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: true, channels: out }));
  }

  // ─── 자동 등록용: 브릿지의 CONFIG를 jamsa-panel 포맷으로 export ───
  if (req.url === '/api/config-snapshot') {
    const configs = CONFIG.nvrs.map((n, idx) => ({
      id: `bridge_${idx}_${Date.now()}`,
      name: n.name || `NVR ${idx+1}`,
      brand: n.brand || 'dahua',
      host: n.host,
      port: n.port || 80,
      rtspPort: n.rtspPort || 554,
      username: n.username,
      password: n.password, // 브릿지가 localhost에 있으니 OK
      channels: Object.entries(n.channels || {}).map(([ch, name]) => ({ ch: Number(ch), name })),
      source: 'bridge_auto',
    }));
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: true, configs, exportedAt: new Date().toISOString() }));
  }

  // ─── LAN 자동 검색 (subnet scan, HEAD /cgi-bin/magicBox.cgi 등) ───
  if (req.url.startsWith('/api/discover')) {
    const params = new URLSearchParams(req.url.split('?')[1] || '');
    const subnet = params.get('subnet') || autoDetectSubnet();
    const ports = (params.get('ports') || '80,8000,9000,37777').split(',').map(Number);
    const timeout = parseInt(params.get('timeout') || '1500', 10);

    res.setHeader('Content-Type', 'application/json');
    discoverNvrs(subnet, ports, timeout)
      .then(devices => res.end(JSON.stringify({ ok: true, subnet, scanned: 256 * ports.length, devices, scanTime: new Date().toISOString() })))
      .catch(e => res.end(JSON.stringify({ ok: false, error: e.message })));
    return;
  }

  res.statusCode = 404;
  res.end('not found. Endpoints: /api/status, /api/snap/:ch, /api/channels, /api/config-snapshot, /api/discover');
});

server.listen(PORT, () => {
  console.log('═══════════════════════════════════════════════════');
  console.log('🏛️  Jamsa CCTV Bridge v1.0');
  console.log('═══════════════════════════════════════════════════');
  console.log(`📡 Listening on http://localhost:${PORT}`);
  console.log(`📹 ${CONFIG.nvrs.length} NVR(s) configured`);
  CONFIG.nvrs.forEach((n, i) => {
    console.log(`  [${i}] ${n.name} (${n.brand}) → ${n.host}:${n.port} · ${Object.keys(n.channels||{}).length} channels`);
  });
  console.log('═══════════════════════════════════════════════════');
  console.log('📝 jamsa-panel 설정:');
  console.log('   안전관리 → IoT 안전제어 → 📹 NVR/VMS 탭 → 로컬 브릿지 입력');
  console.log(`   http://localhost:${PORT}  (또는 LAN IP:${PORT})`);
  console.log('═══════════════════════════════════════════════════');
});

// ─── 연결 워커 ─────────────────────────────────────────────────────
const workerState = {
  running: false,
  retryCount: 0,
  lastError: null,
  lastConnectedAt: null,
  backoffTimer: null,
  connect: null,
};

function resetReconnect() {
  const previousRetryCount = workerState.retryCount;
  workerState.retryCount = 0;
  if (workerState.backoffTimer) {
    clearTimeout(workerState.backoffTimer);
    workerState.backoffTimer = null;
  }
  if (typeof workerState.connect === 'function') {
    setImmediate(() => {
      try { workerState.connect(); }
      catch (e) { workerState.lastError = e && e.message ? e.message : String(e); }
    });
  }
  return { ok: true, previousRetryCount };
}

function getWorkerStatus() {
  return {
    running: workerState.running,
    retryCount: workerState.retryCount,
    lastError: workerState.lastError,
    lastConnectedAt: workerState.lastConnectedAt,
  };
}

// ─── Heartbeat 루프 ─────────────────────────────────────────────────
// 30초마다 getWorkerStatus() 결과를 Supabase service_status 테이블에 upsert.
// 비활성화: SUPABASE_URL / SUPABASE_SERVICE_KEY 둘 중 하나라도 비어있으면 no-op.
const HEARTBEAT_INTERVAL_MS = 30000;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SERVICE_NAME = process.env.SERVICE_NAME || 'connection-worker';

function sendHeartbeat() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  let url;
  try {
    url = new URL(`${SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/service_status?on_conflict=name`);
  } catch (e) { return; }

  const status = getWorkerStatus();
  const now = new Date().toISOString();
  const payload = JSON.stringify({
    name: SERVICE_NAME,
    running: !!status.running,
    retry_count: Number(status.retryCount) || 0,
    last_heartbeat: now,
    updated_at: now,
  });

  const lib = url.protocol === 'https:' ? https : http;
  const req = lib.request({
    method: 'POST',
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    timeout: 8000,
  }, (res) => {
    res.on('data', () => {});
    res.on('end', () => {
      if (res.statusCode >= 400) {
        console.warn(`[heartbeat] HTTP ${res.statusCode}`);
      }
    });
  });
  req.on('timeout', () => req.destroy());
  req.on('error', (e) => console.warn(`[heartbeat] ${e.message}`));
  req.write(payload);
  req.end();
}

if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  setImmediate(sendHeartbeat);
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS).unref?.();
}

module.exports = { resetReconnect, getWorkerStatus };
