/* 花费 · Zheng — service worker（独立 app，勿与 portfolio 共用）
   策略：页面/脚本永远拿线上最新，只有断网才用缓存兜底；图标才长期缓存。
   传了新 index.html → 刷新一次就是新版，不会卡旧缓存。 */
const CACHE = 'hua-zheng-v8';
const ICONS = ['icon-192.png', 'icon-512.png', 'icon-180.png', 'manifest.json'];

self.addEventListener('install', (e) => {
  // 立刻激活新版，不等旧标签页关闭
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ICONS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // API / 非 GET：永不缓存，直接放行走网络
  if (url.pathname.includes('/api/') || req.method !== 'GET') return;

  // 页面 + index.html + sw 相关：network-first（永远优先线上最新）
  const isPage = req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('index.html');
  if (isPage) {
    e.respondWith(
      fetch(req, { cache: 'no-store' })
        .then((res) => {
          caches.open(CACHE).then((c) => c.put('index.html', res.clone()));
          return res;
        })
        .catch(() => caches.match('index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // 图标 / manifest：cache-first（这些不变，缓存省流量）
  if (ICONS.some((n) => url.pathname.endsWith(n))) {
    e.respondWith(caches.match(req).then((c) => c || fetch(req)));
    return;
  }

  // 其它（比如 Google 字体）：网络优先，失败回缓存
  e.respondWith(fetch(req).then((res) => {
    if (res.ok && (url.host.includes('gstatic') || url.host.includes('googleapis'))) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  }).catch(() => caches.match(req)));
});
