// staff-sw.js - 잠사박물관 직원 PWA Service Worker
const CACHE_VERSION = 'jamsa-staff-v1';
const CACHE_FILES = [
  '/staff.html',
  '/staff-manifest.json',
  '/staff-icon-192.png',
  '/staff-icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(CACHE_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // API 요청은 항상 네트워크
  if (event.request.url.includes('/api/')) {
    return;
  }
  // 정적 파일은 캐시 우선
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});

// 푸시 알림 (사고 호출 등)
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: '알림', body: '새 알림' };
  event.waitUntil(
    self.registration.showNotification(data.title || '잠사박물관', {
      body: data.body || '',
      icon: '/staff-icon-192.png',
      badge: '/staff-icon-192.png',
      vibrate: [200, 100, 200],
      tag: 'incident',
      requireInteraction: true,
      actions: [
        { action: 'accept', title: '✅ 확인' },
        { action: 'dispatch', title: '🚑 출동' }
      ]
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow('/staff.html')
  );
});
