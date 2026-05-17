// jamsa-sw.js — Service Worker
// 캐시 정책: 정적 자원만 캐시, API/동적 자원은 무조건 네트워크

const CACHE_NAME = 'jamsa-v3-2026-05-17';  // 캐시 버전 bump — 충돌 마커 캐시 정리용
const STATIC_ASSETS = [
  '/manifest.json',
];  // index.html은 절대 캐시 안 함 (항상 최신)

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(names => {
      // 모든 이전 캐시 삭제 (jamsa-* 전부)
      return Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)));
    }).then(() => self.clients.claim()).then(() => {
      // 모든 클라이언트에게 "새 버전이 활성화됨" 알림 → 자동 새로고침
      return self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(client => client.postMessage({ type: 'SW_UPDATED', version: CACHE_NAME }));
      });
    })
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API 호출은 캐시 안 함 (실시간 데이터)
  if (url.pathname.startsWith('/api/')) {
    return; // 기본 fetch 동작
  }

  // HTML/번들은 항상 네트워크 우선 (캐시 폴백)
  if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/app.bundle.js') {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).catch(() => caches.match(event.request))
    );
    return;
  }

  // 기타 정적 자원은 cache-first
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

// 푸시 알림 (Ppurio 대신 FCM 쓸 때)
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

