/* CheatingGuard Service Worker
 * - 최초 설치 시 필수 파일 캐싱 (오프라인 실행)
 * - 버전이 바뀌면 이전 'cheatingguard-static-' 캐시만 삭제 (IndexedDB 사용자 데이터는 건드리지 않음)
 * - 외부 서버로 어떤 요청도 보내지 않음 (같은 출처 GET 요청만 처리)
 */
const VERSION = '1.6.0';
const CACHE = 'cheatingguard-static-v' + VERSION;
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/styles.css',
  './js/app.js',
  './js/capability-check.js',
  './js/bluetooth-detector.js',
  './js/optical-detector.js',
  './js/vision-detector.js',
  './js/vision-worker.js',
  './js/processors.js',
  './js/image-processing.js',
  './js/sensor-detector.js',
  './js/fusion-engine.js',
  './js/database.js',
  './js/storage.js',
  './js/notification.js',
  './js/spycam-detector.js',
  './js/radio-analyzer.js',
  './js/integrated-review.js',
  './js/finder.js',
  './js/mag-anomaly.js',
  './js/native-bridge.js',
  './data/spycam-db.json',
  './icons/nav-spycam.svg',
  './data/glasses-db.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/nav-home.svg',
  './icons/nav-ble.svg',
  './icons/nav-optical.svg',
  './icons/nav-vision.svg',
  './icons/nav-settings.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 개별 캐싱: 일부 실패해도 나머지는 저장하고, 완료 여부는 CHECK_CACHE로 정확히 보고
    await Promise.all(ASSETS.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res.ok) await cache.put(url, res);
      } catch (_) {}
    }));
    // 최초 설치는 즉시 활성화, 업데이트는 사용자가 '지금 적용'을 누를 때 활성화
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('cheatingguard-static-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'CHECK_CACHE') {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      const missing = [];
      for (const url of ASSETS) if (!(await cache.match(url))) missing.push(url);
      const port = event.ports && event.ports[0];
      const msg = { version: VERSION, cache: CACHE, total: ASSETS.length, missing, complete: missing.length === 0 };
      if (port) port.postMessage(msg);
      // 누락 파일은 다시 시도
      if (missing.length) {
        for (const url of missing) {
          try { const res = await fetch(new Request(url, { cache: 'reload' })); if (res.ok) await cache.put(url, res); } catch (_) {}
        }
      }
    })());
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 페이지 이동: 네트워크 우선 → 실패 시 캐시된 index.html
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        return res;
      } catch (_) {
        const cache = await caches.open(CACHE);
        return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  // 기본 데이터베이스: 캐시 우선 + 백그라운드 갱신 (같은 버전 안에서 수정본 반영)
  if (/\/data\/(glasses|spycam)-db\.json$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const key = './data/' + url.pathname.split('/').pop();
      const cached = await cache.match(key);
      const net = fetch(req).then((res) => { if (res.ok) cache.put(key, res.clone()); return res; }).catch(() => null);
      return cached || (await net) || Response.error();
    })());
    return;
  }

  // 정적 파일: 캐시 우선
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const res = await fetch(req);
      return res;
    } catch (_) {
      return Response.error();
    }
  })());
});
