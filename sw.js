/* 花费 · Zheng — service worker
   壳缓存(cache-first) + 页面 network-first + API 永不缓存
   每次改版把 CACHE 版本号 +1，旧缓存会自动清掉 */
const CACHE = 'hua-zheng-v6';
const SHELL = [
  './',
  'index.html',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'icon-180.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // API / 数据请求：永远走网络，不缓存（数据必须新鲜）
  if (url.pathname.includes('/api/') || req.method !== 'GET') return;

  // 页面导航：network-first，失败回退缓存（离线也能打开 app 壳）
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put('index.html', copy));
        return res;
      }).catch(() => caches.match('index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // 其它静态资源（图标、字体等）：cache-first
  e.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (res.ok && (url.origin === location.origin || url.host.includes('gstatic') || url.host.includes('googleapis'))) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => cached))
  );
});
