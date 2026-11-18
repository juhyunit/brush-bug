// 오프라인용 캐시. 앱 파일을 바꾸면 CACHE 이름의 숫자를 올려 주세요.
const CACHE = 'brush-bugs-v1.0.0';
const CORE = [
  './',
  './index.html',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/vision_bundle.mjs',
];
const MODEL_RE = /face_landmarker\.task$/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(CORE))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.indexOf('brush-bugs-') === 0 && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function networkFirst(req) {
  return fetch(req)
    .then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    })
    .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || Response.error()));
}

function cacheFirst(req) {
  return caches.match(req).then((hit) => {
    if (hit) return hit;
    return fetch(req).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    });
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  const sameOrigin = url.origin === self.location.origin;
  const isModel = MODEL_RE.test(url.pathname);
  if (!sameOrigin && !isModel) return;

  // 화면/코드는 최신을 먼저, 큰 파일(wasm·모델)은 캐시를 먼저 씁니다
  const p = url.pathname;
  const fresh = req.mode === 'navigate' || p.endsWith('/') || p.endsWith('.html') || p.endsWith('app.js') || p.endsWith('.webmanifest');
  event.respondWith(fresh ? networkFirst(req) : cacheFirst(req));
});
