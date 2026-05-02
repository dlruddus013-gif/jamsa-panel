// jamsa-sw.js — Service Worker
// 캐시 정책: 정적 자원만 캐시, API/동적 자원은 무조건 네트워크

const CACHE_NAME = 'jamsa-v2-2026-05-01';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(names => {
      return Promise.all(
        names.map(name => {
          if (name !== CACHE_NAME && name.startsWith('jamsa-')) {
            return caches.delete(name);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API 호출은 캐시 안 함 (실시간 데이터)
  if (url.pathname.startsWith('/api/')) {
    return; // 기본 fetch 동작
  }

  // app.bundle.js는 항상 새로 받기 (업데이트 보장)
  if (url.pathname === '/app.bundle.js' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // 기타 정적 자원은 cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      return cached || fetch(event.request).then(res => {
        // 같은 출처만 캐시
        if (res.ok && url.origin === self.location.origin) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return res;
      });
    }).catch(() => caches.match('/'))
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
