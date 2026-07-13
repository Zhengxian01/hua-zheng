/* 花费 · Zheng — service worker（写一次，永不用再改）
   核心：页面(HTML)和脚本永远直接走网络 = 每次打开都是线上最新，
        所以你上传新 index.html，刷新一次就生效，不用改这个文件的版本号。
   只有图标这种永不变的东西才缓存（离线兜底 + 省流量）。 */
const CACHE = 'hua-zheng-static';   // 不用再动它
const ICONS = ['icon-192.png', 'icon-512.png', 'icon-180.png', 'manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ICONS)).then(() => self.skipWaiting()));
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

  // API / 非 GET：不缓存，直接放行
  if (url.pathname.includes('/api/') || req.method !== 'GET') return;

  // 图标 / manifest：这些永不变，缓存优先（离线也能显示图标）
  if (ICONS.some((n) => url.pathname.endsWith(n))) {
    e.respondWith(caches.match(req).then((c) => c || fetch(req)));
    return;
  }

  // 其它一律「网络优先」——HTML、JS、字体都永远拿线上最新；
  // 只有断网时才回退到最后一次成功的缓存。
  e.respondWith(
    fetch(req, { cache: 'no-store' })
      .then((res) => {
        // 顺手存一份，纯粹给断网兜底用（联网时永远不会用到这份）
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((c) => c || caches.match('index.html')))
  );
});
