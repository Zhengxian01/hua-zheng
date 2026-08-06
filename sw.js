/* Expenses — service worker（版本号固定，不用再改）
   核心：页面(HTML)和脚本永远直接走网络 = 每次打开都是线上最新，
        所以你上传新 index.html，刷新一次就生效。
   只有「永不变的东西」才缓存：图标 + 背景图（/api/bg 的 URL 带版本号，换图 URL 就变）。 */
const CACHE = 'expenses-static';
const ICONS = ['icon-192.png', 'icon-512.png', 'icon-180.png', 'manifest.json'];
/* v23.27 手账主题的字体改成**自托管**（以前是直连 fonts.googleapis.com）。
   放进 install 的预缓存：SW 装好的那一刻字体就在本地了 → 之后每次开机
   index.html 的 `font-display:optional` 一问就有 → **永远不会出现「先一种字再换另一种字」**。
   （只有装好之后的第一次开机例外，那时候 SW 还没收完，手账数字会是退路 serif。）
   ⚠️ 换字体档就换档名（或加版本后缀），不然旧的会一直被缓存着。 */
const FONTS = ['fraunces.woff2'];
const PRECACHE = ICONS.concat(FONTS);

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // 原版用 addAll：任何一个图标 404，整个 install 就失败，SW 永远装不上。
      // 改成逐个 add，坏一个不影响其它。
      .then((c) => Promise.all(PRECACHE.map((n) => c.add(n).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  /* ⚠️⚠️ v23.27 这一行以前是 `keys.filter((k) => k !== CACHE)` —— 也就是**除了 CACHE 以外全删**，
     而推送的设定（worker 网址 + token）就存在另一个 cache `expenses-push`（下面的 CONF）里。
     结果：每次 sw.js 有改动 → 重新 activate → **顺手把推送设定删掉**。
     症状不是「推送坏了」（那还好查），是推送照样会来、但内容退成兜底那句
     「有事项到时间了，打开看看」，看不到真正的事项标题 —— 而且下次开 App 时前端会无条件
     重写一次设定，它就自己好了。**会自己好的 bug 最难查**：你截图给人看的时候它已经正常了。
     以前很少踩到只是因为 sw.js 几乎不改；这一轮改了它，就必然会踩。
     现在明确写出「这两个 cache 都要留」，以后再加新 cache 记得也加进这个白名单。 */
  const KEEP = [CACHE, CONF];
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;

  // chrome-extension: 之类的非 http 请求直接放行，不然 cache.put 会抛错
  if (!req.url.startsWith('http')) return;

  const url = new URL(req.url);

  /* 背景图（v1.8）：URL 里带 &v=<版本>，同一个 URL 的内容永远不变 → 缓存优先。
     好处：断网也有背景；换图后 URL 变，自动重新下载。

     ⚠️⚠️ v23.28 真正的修：这里以前写 `if (res && res.ok)` —— 而**这一发永远是 opaque**。
     为什么：背景图是 CSS 的 `background-image:url(...)` 和 `<link rel=preload as=image>` 发出去的，
     这两种都是 **no-cors** 请求；worker 那边有没有回 CORS 头都没用，回应一律是 opaque
     （`status === 0`、`res.ok` 恒为 `false`）。
     → `res.ok` 永远不成立 → **一张都没存进去过**，而且完全不报错。
     这段注解写着「缓存优先」，实际上十几个版本以来它一次都没缓存成功过，
     全靠浏览器自己的 HTTP 磁盘缓存（worker 回 max-age=1年）在撑；
     那份缓存 iOS 说清就清，一清掉就变成「每次开 app 都现拉 600KB」＝ 卡好几秒。
     这跟下面 unpkg 那段特别标注的是**同一个坑**（Workbox 配方里 `statuses:[0,200]` 在处理的那个），
     v23.27 只在 unpkg 那边挡了，漏了这里。
     现在 `res.ok || res.type === 'opaque'` 都收 —— `cache.put()` 是可以存 opaque 的
     （只有 `cache.add()/addAll()` 不行，别搞混）。
     ⚠️ 别为了「不 opaque」去给 preload 加 crossorigin：CSS 那一发改不了，
        结果会变成 cors + no-cors 两份互不共用的缓存，只会更糟。 */
  if (url.pathname === '/api/bg' && req.method === 'GET') {
    e.respondWith(
      caches.open(CACHE).then((c) =>
        c.match(req).then((hit) => {
          if (hit) return hit;                       // 永不变的东西：直接给，零网络
          return fetch(req).then((res) => {
            if (res && (res.ok || res.type === 'opaque')) {
              const copy = res.clone();
              (async () => {
                // 顺手清掉旧版本的背景图，不然换几次图就堆一堆
                const olds = await c.keys();
                for (const k of olds) {
                  if (new URL(k.url).pathname === '/api/bg' && k.url !== req.url) await c.delete(k);
                }
                await c.put(req, copy);
              })().catch(() => {});
            }
            return res;
          }).catch(() => hit);                       // 断网又没缓存：让它自然失败，走兜底渐层
        })
      )
    );
    return;
  }

  // 其它 API / 非 GET：不缓存，直接放行
  if (url.pathname.includes('/api/') || req.method !== 'GET') return;

  /* ⚠️⚠️ v23.27 新增：**第三方静态资源自己收进来管**（以前这里一句「交给浏览器自己管」就放行了）。
     现在只剩 xlsx 一个第三方（字体已经改成自托管，见 FONTS）。
     unpkg 的 URL 里锁死了版本号（`xlsx@0.18.5`）＝ **内容永不变** → 纯缓存优先，成功载过一次之后
     一个请求都不发。好处：第一次在线导出过 Excel 之后，**断网也导得出真的 .xlsx**，不用退 CSV。

     ⚠️ 跨站资源多半是 **opaque**（`status 0`、`res.ok` 永远 false）——
        这里**绝对不能**照抄下面那条 `res.ok && res.type==='basic'`，照抄的话一份都存不进去，
        而且不会报错，只是永远没有缓存（＝这段等于没写）。这是 Workbox 官方配方里特别标注
        `statuses:[0,200]` 在处理的同一个坑。 */
  if (url.host === 'unpkg.com') {
    e.respondWith(
      caches.open(CACHE).then((c) =>
        c.match(req).then((hit) => {
          if (hit) return hit;                               // 永不变的东西：直接给
          return fetch(req).then((res) => {
            if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()).catch(() => {});
            return res;
          }).catch(() => hit);
        })
      )
    );
    return;
  }

  // 其余跨域资源：交给浏览器自己管，别往 cache 里塞
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
  if (PRECACHE.some((n) => url.pathname.endsWith(n))) {
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

const CONF = 'expenses-push';          // 前端把 {worker,token} 写这里，SW 读它

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
      await self.registration.showNotification('提醒', {
        body: '有事项到时间了，打开看看',
        icon: 'icon-192.png', badge: 'icon-192.png', tag: 'app-fallback',
      });
      return;
    }

    await Promise.all(items.map((it) =>
      self.registration.showNotification(it.title || '提醒', {
        body: it.body || '',
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        tag: 'app-ev-' + (it.id || Math.random()),   // 同一件事只留一个，不洗版
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
