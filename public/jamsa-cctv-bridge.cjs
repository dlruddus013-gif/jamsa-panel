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

  res.statusCode = 404;
  res.end('not found. Endpoints: /api/status, /api/snap/:ch, /api/channels');
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
