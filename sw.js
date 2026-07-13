/* 花费 · Zheng — service worker（版本号固定，不用再改）
   核心：页面(HTML)和脚本永远直接走网络 = 每次打开都是线上最新，
        所以你上传新 index.html，刷新一次就生效。
   只有「永不变的东西」才缓存：图标 + 背景图（/api/bg 的 URL 带版本号，换图 URL 就变）。 */
const CACHE = 'hua-zheng-static';
const ICONS = ['icon-192.png', 'icon-512.png', 'icon-180.png', 'manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // 原版用 addAll：任何一个图标 404，整个 install 就失败，SW 永远装不上。
      // 改成逐个 add，坏一个不影响其它。
      .then((c) => Promise.all(ICONS.map((n) => c.add(n).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;

  // chrome-extension: 之类的非 http 请求直接放行，不然 cache.put 会抛错
  if (!req.url.startsWith('http')) return;

  const url = new URL(req.url);

  // 背景图（v1.8）：URL 里带 &v=<版本>，同一个 URL 的内容永远不变 → 缓存优先。
  // 好处：断网也有背景；换图后 URL 变，自动重新下载。
  if (url.pathname === '/api/bg' && req.method === 'GET') {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(async (c) => {
            // 顺手清掉旧版本的背景图，不然换几次图就堆一堆
            const olds = await c.keys();
            for (const k of olds) {
              if (new URL(k.url).pathname === '/api/bg' && k.url !== req.url) c.delete(k);
            }
            c.put(req, copy);
          }).catch(() => {});
        }
        return res;
      }))
    );
    return;
  }

  // 其它 API / 非 GET：不缓存，直接放行
  if (url.pathname.includes('/api/') || req.method !== 'GET') return;

  // 跨域资源（unpkg 的 SheetJS、Google Fonts）交给浏览器自己管，别往 cache 里塞
  if (url.origin !== self.location.origin) return;

  // 图标 / manifest：这些永不变，缓存优先
  if (ICONS.some((n) => url.pathname.endsWith(n))) {
    e.respondWith(caches.match(req).then((c) => c || fetch(req)));
    return;
  }

  // 其它一律「网络优先」——HTML、JS 永远拿线上最新；只有断网才回退缓存。
  e.respondWith(
    fetch(req, { cache: 'no-store' })
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      // 原版兜底写 'index.html'（相对路径，深层路由匹配不上），改绝对路径
      .catch(() => caches.match(req).then((c) => c || caches.match('/index.html')))
  );
});
