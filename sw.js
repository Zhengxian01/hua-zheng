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

  /* ⚠️⚠️ v9.7 改（原本这里写「图标 / manifest：这些永不变，缓存优先」）：
     图标**现在会变了** —— logo 改用 icon-192.png，你在 GitHub 换照片就是换这个档。
     原本是 `caches.match(req).then(c => c || fetch(req))` = **纯缓存优先**
     → 换了照片，App 左上角那颗 logo 会**永远卡在旧的**，因为它根本不会再去问一次。
     （SW 只有在 sw.js 本身改动时才重新 install → 才会重抓图标。）

     现在改成 stale-while-revalidate：
       ① 有缓存 → **立刻回缓存**（0 延迟，不会因为这个卡）
       ② 同时在背景偷偷抓一份新的，写回缓存
       ③ 下次开 App 就是新照片
     代价：每次开多一个请求（76KB，而且浏览器自己的 HTTP 缓存还会挡掉大部分）。
     换来「换照片不用改 sw.js、不用清缓存」。 */
  if (ICONS.some((n) => url.pathname.endsWith(n))) {
    e.respondWith(
      caches.open(CACHE).then((c) =>
        c.match(req).then((hit) => {
          const fresh = fetch(req).then((res) => {
            if (res && res.ok) c.put(req, res.clone()).catch(() => {});
            return res;
          }).catch(() => hit);          // 断网 → 用缓存那份
          return hit || fresh;          // 有缓存就先给，背景照样更新
        })
      )
    );
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

/* ════════════════════════════════════════════════════════════════════
   v8.7 推送通知（以上的逻辑一行都没动，这里是纯新增）

   ⚠️ iOS 前提：必须「加入主画面」并从那个图示开，Safari 分页永远收不到。

   为什么用「不带内容的推送」：
   带内容的话要照 RFC 8291 做 aes128gcm 加密，一大坨还容易出错。
   不带内容 → Worker 只要签个 VAPID JWT 就能推 → SW 收到後自己回头拿资料。
   代价：SW 要能拿到 token → 前端订阅时写进 CONF 这个 cache，SW 再读出来。

   ⚠️ Apple 规定：每一次 push 都「必须」弹出一个通知，不然会被判定滥用、
   连续几次之後直接把你的订阅停掉。所以就算拿资料失败，也一定要弹一个兜底的。
   ════════════════════════════════════════════════════════════════════ */

const CONF = 'hua-zheng-push';          // 前端把 {worker,token} 写这里，SW 读它

async function pushConf() {
  try {
    const c = await caches.open(CONF);
    const r = await c.match('/__push_conf');
    if (!r) return null;
    return await r.json();
  } catch (e) { return null; }
}

self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let items = [];
    try {
      const conf = await pushConf();
      if (conf && conf.worker && conf.token) {
        const r = await fetch(
          `${conf.worker}/api/push/due?token=${encodeURIComponent(conf.token)}`,
          { cache: 'no-store' }
        );
        if (r.ok) {
          const j = await r.json();
          items = Array.isArray(j.items) ? j.items : [];
        }
      }
    } catch (err) { /* 拿不到就走底下的兜底 */ }

    if (!items.length) {
      // ⚠️ 兜底：Apple 要求每次 push 都得弹一个，不弹会被停订阅
      await self.registration.showNotification('花费 · 提醒', {
        body: '有事项到时间了，打开看看',
        icon: 'icon-192.png', badge: 'icon-192.png', tag: 'hz-fallback',
      });
      return;
    }

    await Promise.all(items.map((it) =>
      self.registration.showNotification(it.title || '提醒', {
        body: it.body || '',
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        tag: 'hz-ev-' + (it.id || Math.random()),   // 同一件事只留一个，不洗版
        data: { day: it.day || null },
        requireInteraction: false,
      })
    ));
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const day = e.notification.data && e.notification.data.day;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // 已经开着就直接聚焦，别再开一个
    for (const c of all) {
      if ('focus' in c) {
        await c.focus();
        if (day && c.postMessage) c.postMessage({ type: 'open-day', day });
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(day ? `./?day=${day}` : './');
  })());
});
