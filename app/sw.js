// 오프라인에서도 앱이 열리도록 앱 껍데기를 캐시한다. 기록 데이터는 IndexedDB에 있으므로 여기서 다루지 않는다.
const VERSION = 'seojae-v4';
const SHELL = ['./', './index.html', './styles.css', './config.js', './manifest.webmanifest', './icons/icon.svg',
  './js/app.js', './js/morph.js', './js/util.js', './js/store.js', './js/sync.js', './js/ai.js', './js/net.js', './js/export.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'no-store' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Supabase API는 캐시하지 않는다
  if (url.pathname.includes('/rest/v1/') || url.pathname.includes('/auth/v1/') || url.pathname.includes('/functions/v1/')) return;
  // 글꼴은 캐시 우선
  if (/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net/.test(url.host)) {
    e.respondWith(caches.open(VERSION).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  // 앱 파일은 네트워크 우선(최신 버전, 브라우저 HTTP 캐시도 건너뜀), 실패할 때만 캐시
  e.respondWith(fetch(req, { cache: 'no-store' }).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
});
