// jamsa-sw.js — Service Worker
// 캐시 정책: 정적 자원만 캐시, API/동적 자원은 무조건 네트워크
// 🆕 백그라운드 위치 추적: periodicsync + sync 이벤트 (체크인 상태일 때)

const CACHE_NAME = 'jamsa-v6-2026-05-21-bg-track';
const STATIC_ASSETS = [
  '/manifest.json',
];  // index.html은 절대 캐시 안 함 (항상 최신)

// IndexedDB 헬퍼 — 메인 페이지가 저장한 마지막 위치/세션을 SW가 읽기
const DB_NAME = 'jamsa_bg_track';
const DB_VER = 1;
const STORE = 'session';

function openDb(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key){
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const r = tx.objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbSet(key, val){
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(names => {
      return Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)));
    }).then(() => self.clients.claim()).then(() => {
      return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        clients.forEach(client => {
          try { client.postMessage({ type: 'SW_UPDATED', version: CACHE_NAME }); } catch (e) {}
        });
      });
    })
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) {
    return;
  }
  if (url.pathname === '/'
      || url.pathname.endsWith('.html')
      || url.pathname.endsWith('.js')
      || url.pathname === '/staff-checkin'
      || url.pathname === '/staff-checkin-v2'
      || url.pathname === '/attendance'
      || url.pathname === '/m'
      || url.pathname === '/m2') {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).catch(() => caches.match(event.request))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then(cached => {
      return cached || fetch(event.request).then(res => {
        if (res.ok && url.origin === self.location.origin) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return res;
      });
    }).catch(() => null)
  );
});

// ─── 🆕 백그라운드 위치 전송 (메인 페이지가 putState로 저장한 정보 사용) ───
async function sendBackgroundLocation(reason){
  try {
    const session = await idbGet('session');
    if (!session || !session.staffId || !session.lastPos) return false;

    // 체크인 상태가 아니면 전송 안 함 (퇴근 후 전송 방지)
    if (session.working === false) return false;

    // 마지막 위치가 너무 오래된 경우 (15분 이상) — 신선도 표시
    const ageMs = Date.now() - (session.lastPos.t || 0);
    const stale = ageMs > 15 * 60 * 1000;

    const body = {
      staffId: session.staffId,
      staffName: session.staffName || '익명',
      dept: session.dept || null,
      lat: session.lastPos.lat,
      lng: session.lastPos.lng,
      accuracy: session.lastPos.accuracy,
      source: 'mobile_bg_' + (reason || 'sync'),
      role: 'staff',
      timestamp: new Date().toISOString(),
      stale,
      ageMs,
    };
    const res = await fetch('/api/staff-location-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    });
    await idbSet('last_bg_send', { at: Date.now(), reason, ok: res.ok, stale });
    return res.ok;
  } catch (e) {
    try { await idbSet('last_bg_send', { at: Date.now(), reason, error: e.message }); } catch(_) {}
    return false;
  }
}

// Periodic Background Sync (Chrome 80+, PWA 설치 시 ~15분 간격)
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'staff-location-sync') {
    event.waitUntil(sendBackgroundLocation('periodic'));
  }
});

// One-shot Background Sync (네트워크 복귀/명시적 트리거)
self.addEventListener('sync', (event) => {
  if (event.tag === 'staff-location-sync' || event.tag === 'staff-location-flush') {
    event.waitUntil(sendBackgroundLocation('sync'));
  }
});

// 메인 페이지 ↔ SW 메시지: 세션/위치 갱신
self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'PUT_SESSION') {
    event.waitUntil(idbSet('session', msg.session));
  } else if (msg.type === 'CLEAR_SESSION') {
    event.waitUntil(idbSet('session', { working: false }));
  } else if (msg.type === 'FLUSH_NOW') {
    event.waitUntil(sendBackgroundLocation('flush_now'));
  }
});

// 푸시 알림
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let data = {};
  try { data = event.data.json(); } catch (e) { data = { title: '알림', body: event.data.text() }; }
  event.waitUntil(
    self.registration.showNotification(data.title || '잠사박물관', {
      body: data.body || '',
      icon: '/manifest.json',
      badge: '/manifest.json',
      data: data.url || '/',
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data || '/'));
});
