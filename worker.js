/* ================================================================
   Expenses — Cloudflare Worker（配合 index.html v5.2）
   一个 Worker 干两件事：
     1) email(): 收 DBS/OCBC 转发邮件 → 解析 → 写进 D1 expenses
     2) fetch(): 给 PWA 提供 API（读/加/改/删 + 主题设置/背景图）
   绑定：Settings → Bindings → D1 database，Variable name = DB，选你自己建的 D1 database
   ⚡ v3.1 起：**不用再手动跑 SQL**。Worker 自己会建表 / 补列（见下面 ensureSchema）。
      你只要 Deploy 这个 Worker，第一个请求进来时它会把 schema 对齐好。
   ================================================================ */

/* 跟 PWA 里存在 localStorage 的存取码一模一样。
   ⚠️⚠️ v9.89：这行以前是写死的明文，而这个档在公开的 GitHub repo里 ——
   v9.82 把 Google 的 client_secret 清掉就是为了这个，唯独漏了这一把「整个数据库的钥匙」。
   现在改成优先读 Cloudflare Secret：Settings → Variables and Secrets → 加 APP_TOKEN。
   👉 设好 APP_TOKEN 之后，把下面 TOKEN_DEFAULT 清成 ""，GitHub 上就再也没有 token 了。
   （先留着旧值当 fallback，是为了让你「先部署、再设 secret」也不会整个 app 401 掉。） */
const TOKEN_DEFAULT = "";
const appToken = (env) => env.APP_TOKEN || TOKEN_DEFAULT;
const WORKER_VER = "v10.33";   // 改这个档就顺手 +1，方便对版本

// 背景图上限（解码后字节）。前端 compressImage 目标 260KB，这里留一倍余量。
const MAX_BG_BYTES = 600 * 1024;

/* ================================================================
   自动迁移（v3.1）
   以前每加一个功能都要你去 D1 Console 手贴一条 SQL —— 太蠢，而且忘了跑就 500。
   现在：worker 冷启动时自己对一次 schema。

   规矩：
   - 每加一条 DDL，就往 MIGRATIONS 末尾 push，并把 SCHEMA_VERSION +1。
   - 所有 DDL 必须**幂等**（IF NOT EXISTS；ALTER 报 duplicate column 直接吞掉）。
   - 只碰本 app 自己的表（expenses / merchant_rules / app_settings / inbox），
     **绝不碰 Portfolio 那个 app 的表**。
   - 版本号记在 app_settings 的 k='schema_version'。
   - 同一个 isolate 只跑一次（schemaOK），所以正常请求没有额外开销。
   ================================================================ */
/* ⚠️⚠️ v9.1 修：SCHEMA_VERSION **不准再手写**。
   迁移器是 `for (i = have; i < MIGRATIONS.length; i++)` —— 它拿版本号**当阵列 index**。
   所以 SCHEMA_VERSION 一旦 ≠ MIGRATIONS.length，中间那几条就会被整个跳过，
   而且跑完还会把版本号写成新的 → **永远不会补回来**，栏位永久缺失，
   症状是「存事项就 500：no such column」，但你完全看不出为什么。
   实际发生过：MIGRATIONS 28 条 / SCHEMA_VERSION 写 23 → rep_mod 和 notifs 两栏被跳过。
   现在自动推导，永远不可能再对不上。（定义在 MIGRATIONS 底下，不然 TDZ。） */
const MIGRATIONS = [
  // v1：设置表（主题 / 背景图 / 分类 / 定期账单 / 汇率缓存）
  `CREATE TABLE IF NOT EXISTS app_settings (
     k TEXT PRIMARY KEY, v TEXT NOT NULL,
     updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  // v2：子分类列
  /* ⚠️⚠️ v9.1 补：这两张表**从来没进过 MIGRATIONS**（早年是手动在 D1 console 建的）。
     后果：全新的 D1 会在下一条 `ALTER TABLE expenses` 就炸 —— 而且不是 duplicate column，
     所以不会被吞掉 → ensureSchema throw → **整个 worker 每一个请求都 500**。
     等于「D1 一旦要重建，App 直接死透」。备份还原也救不回来（没表可还原）。
     DDL 照 TECHNICAL_SUMMARY §4 一字不改。已存在的 DB：IF NOT EXISTS = 完全不动它。 */
  `CREATE TABLE IF NOT EXISTS expenses (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts TEXT NOT NULL,
     amount REAL NOT NULL,
     currency TEXT NOT NULL,
     merchant TEXT,
     card_last4 TEXT,
     source TEXT NOT NULL,
     raw TEXT,
     hash TEXT UNIQUE,
     created_at TEXT DEFAULT (datetime('now')),
     category TEXT,
     type TEXT DEFAULT 'expense'
   )`,
  `CREATE TABLE IF NOT EXISTS merchant_rules (
     merchant_key TEXT PRIMARY KEY,
     category TEXT NOT NULL,
     updated_at TEXT DEFAULT (datetime('now'))
   )`,
  `ALTER TABLE expenses ADD COLUMN sub TEXT`,
  // v3：收件箱（解析不出来的银行邮件）
  `CREATE TABLE IF NOT EXISTS inbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
     sender TEXT, subject TEXT, raw TEXT,
     status TEXT NOT NULL DEFAULT 'new')`,
  // v4：商家记忆升级 —— 除了分类，还记住「用户给这家取的名字」
  `ALTER TABLE merchant_rules ADD COLUMN display TEXT`,
  // v5：清掉通用名规则。以前 DBS 收款人抓不到 → 全部叫 "PayLah Transfer" →
  //     这条规则会让「所有 PayLah 转账」被套上同一个商家名/分类，是错的。
  `DELETE FROM merchant_rules WHERE UPPER(TRIM(merchant_key)) IN
     ('PAYLAH TRANSFER','PAYLAH WALLET','PAYLAH','TRANSFER','MANUAL','')`,
  // v6：收件箱升级 —— 现在**每一封**转发进来的邮件都会存，不只是解析失败的。
  //     kind = 'parsed'（读懂了，已经记账）/ 'unparsed'（读不懂，要你自己看）
  //     summary = 读懂了的话，记了什么（金额 · 商家）
  `ALTER TABLE inbox ADD COLUMN kind TEXT`,
  `ALTER TABLE inbox ADD COLUMN summary TEXT`,
  // 老资料补一下 kind（v6 之前存进去的都是解析失败的）
  `UPDATE inbox SET kind='unparsed' WHERE kind IS NULL`,
  `ALTER TABLE merchant_rules ADD COLUMN sub TEXT`,
  `CREATE TABLE IF NOT EXISTS events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     day TEXT NOT NULL,
     time TEXT,
     title TEXT NOT NULL,
     note TEXT,
     done INTEGER NOT NULL DEFAULT 0,
     created_at TEXT DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_events_day ON events(day)`,
  `ALTER TABLE events ADD COLUMN end_day TEXT`,
  `ALTER TABLE events ADD COLUMN end_time TEXT`,
  `ALTER TABLE events ADD COLUMN kind TEXT NOT NULL DEFAULT 'event'`,
  `ALTER TABLE events ADD COLUMN notify_min INTEGER`,
  /* v8.5 重复：⚠️ 只存「规则」，绝不生成上千笔记录。
     生日 = 1 笔（2026-05-26 + year/1）→ 日历翻到 2029 时前端现算出来。 */
  `ALTER TABLE events ADD COLUMN rep_type TEXT`,      // null | day | week | month | year
  `ALTER TABLE events ADD COLUMN rep_int INTEGER`,    // 每 N 天/周/月/年
  `ALTER TABLE events ADD COLUMN rep_days TEXT`,      // 只有 week 用：'0,3,5'（周日=0）
  `ALTER TABLE events ADD COLUMN rep_until TEXT`,     // 'YYYY-MM-DD'；null = 永远重复
  // v8.6 例外日：「只删这一天」→ 把那天记进来，展开时跳过。逗号分隔的 YYYY-MM-DD
  `ALTER TABLE events ADD COLUMN rep_ex TEXT`,
  // v8.7 推送订阅（一台装置一笔；endpoint 当主键 → 重复订阅自动覆盖，不会堆）
  `CREATE TABLE IF NOT EXISTS push_subs (
     endpoint TEXT PRIMARY KEY,
     p256dh TEXT,
     auth TEXT,
     created_at TEXT DEFAULT (datetime('now')),
     last_ok TEXT,
     fails INTEGER NOT NULL DEFAULT 0
   )`,
  /* ════ v9.0（SCHEMA_VERSION 22）════
     rep_mod：重复事项「只改这一次」的差异。JSON object，key = 规则算出来的那一天：
       {"2026-07-20":{"ti":"改过的标题","t":"14:00","et":"15:00","no":"备注","k":"reminder","nm":30,"nl":[30,1440]}}
       ⚠️ **故意不存日期**。「这一次改到别天」= 那天记进 rep_ex + 另外新增独立一笔，
          这样展开逻辑完全不用变（不然前后端两套算法都要反查「被移到哪去了」，风险大过收益）。
          代价：移动日期时会多出 1 笔记录 —— 只有 1 笔，不是文档担心的「复制大量 Event」。
     notifs：多重提醒。JSON array of 分钟数，例如 [1440,30] = 前1天 + 前30分钟。
       ⚠️ notify_min 一栏**保留不动**：旧资料只有它；notifs 是 null 时一律退回读它。 */
  `ALTER TABLE events ADD COLUMN rep_mod TEXT`,
  `ALTER TABLE events ADD COLUMN notifs TEXT`,
  /* ════ v9.1（SCHEMA_VERSION 23）Google Calendar 单向同步 ════
     src     null/'local' = 你自己建的（永远不会被同步/清理碰到）
             'gcal'       = Google 来的快取（Google 那边永远有本尊，删了可以再拉）
     ext_id  Google 那边的 event id · cal_id 来自哪一本日历
     url     会议链接（Meet / Zoom / Teams）· loc 地点
     ext_h   内容指纹 → 同步时用来比「这笔到底变了没」，一样就不写
             ⚠️ 这是为了保护 D1 的**每天 10 万笔写入**上限：
                傻傻全量重写 = 800 笔 × 开 50 次 App × 索引×2 ≈ 8 万笔/天 = 快撞顶。
                只写变动的 = 平常一天 0 笔。 */
  `ALTER TABLE events ADD COLUMN src TEXT`,
  `ALTER TABLE events ADD COLUMN ext_id TEXT`,
  `ALTER TABLE events ADD COLUMN cal_id TEXT`,
  `ALTER TABLE events ADD COLUMN url TEXT`,
  `ALTER TABLE events ADD COLUMN loc TEXT`,
  `ALTER TABLE events ADD COLUMN ext_h TEXT`,
  // 同一笔 Google 事项只能有一行 → 重复拉取自动 UPSERT，不会堆
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_events_ext ON events(cal_id, ext_id) WHERE ext_id IS NOT NULL`,
  /* ════ v9.6 ICS 订阅（假期 / NBA / 世界杯）════
     ⚠️ **完全重用 events 表**：src='ics' · cal_id=<订阅的 id> · ext_id=<VEVENT 的 UID>
        → 只读锁、📅 标记、ext_h diff、窗口清理、+N 日历 全部现成的，一行都不用重写。
     ⚠️ 一栏都不用加。订阅清单本身存 app_settings.k='ics'。 */
  /* ════ v9.72 人 vs 商家分类记忆 ════
     转账给朋友（PayLah「You paid X」/ TnG·Maybank「Transfer to X」）时，收款人名字
     不代表分类 —— 同一个朋友这次转餐费、下次转电影票。以前当商家硬记 → 老是猜错。
     is_hint=1 → 只是「上次的分类」当提示预填，绝不锁死；is_hint=0/NULL → 商家硬规则（旧行为）。 */
  `ALTER TABLE merchant_rules ADD COLUMN is_hint INTEGER DEFAULT 0`,
  /* ════ v9.89 事项自选颜色 ════
     以前颜色是拿 id 做 hash 自动分的（EV_COLORS 五色轮）—— 稳定，但不能选。
     现在多一栏 color：存 '#RRGGBB'。**null = 照旧走 hash**，所以既有的事项一个都不会变色。
     ⚠️ 只存在事项本体上（整个系列共用一个颜色），不进 rep_mod —— 「只改这一次」不改颜色。 */
  `ALTER TABLE events ADD COLUMN color TEXT`,
  /* ════ v9.99 收件箱 ↔ 支出 连结 ════
     收件箱多一栏 hashes：这封邮件解析出来的每一笔账的 hash（逗号包起来，例 ",dbs:123,paynow:456,"）。
     用途：删一笔账时能连到它的来源邮件、一起删（这才是真正的 sync）。
     旧资料 hashes=NULL → cron 会重新解析回填（见 scheduled 的 ⑤）。加一栏是安全的加法迁移。 */
  `ALTER TABLE inbox ADD COLUMN hashes TEXT`,
  /* ════ v10.19 退款抵扣支出（offset）════
     使用者概念：refund / 返现不该算成【收入】（否则支出还是虚高），而是从【总支出里减掉】。
     expenses.offset：1 = 这笔（收入）拿去抵扣支出、且不计进收入；0/NULL = 照旧。
     merchant_rules.offset：这家商家的收款默认要不要抵扣 → 记住，下一笔同商家自动带上（跟分类记忆同一套）。
     纯加法迁移，旧资料 NULL 视为 0，行为一个字不变。 */
  `ALTER TABLE expenses ADD COLUMN offset INTEGER DEFAULT 0`,
  /* ⚠️ 商家「默认抵扣」记忆**单独一张表**，不塞进 merchant_rules —— 那张表的 category 是 NOT NULL 且被
     支出分类器读；纯退款商家（没有支出记录）若为了记 offset 硬塞一个分类进去，日后这家真有支出会被
     误分类。独立表只记 merchant_key → offset，互不干扰。 */
  `CREATE TABLE IF NOT EXISTS offset_rules (
     merchant_key TEXT PRIMARY KEY,
     offset INTEGER NOT NULL DEFAULT 0,
     updated_at TEXT DEFAULT (datetime('now'))
   )`,
];
const SCHEMA_VERSION = MIGRATIONS.length;


/* ════════════════════════════════════════════════════════════════════
   v9.1 Google Calendar 单向同步（Google → 你。永远不写回去）

   四个关键决定（做之前量过，数字写在 TECHNICAL_SUMMARY §4.2）：

   ① **singleEvents=true** —— 让 Google 自己把重复事项摊平成一场一场。
      我们**绝不翻译 RRULE**。Google 会「每月第三个星期四」「每月最后一天」
      「BYSETPOS」这些，我们的 rep_* 装不下 —— 硬翻就是在猜，猜错了日历上少一场会，
      而且**不会报错**。摊平之后全部存成不重复的行：零翻译、零地雷，
      而且效能顺便解决（实测 10,000 笔摊平的事项翻月只要 8ms，因为根本不用算）。

   ② **不用 syncToken** —— Google 的额度是每天 100 万次，你一天最多用 150 次（0.015%）。
      syncToken 省的东西你根本不缺，却会 410 过期 → 同步**默默死掉**，你一个月后才发现。
      真正会炸的是 D1 的每天 10 万笔写入 → 所以省的地方在 ③，不在这里。

   ③ **整包拉，只写变动的** —— 用 ext_h（内容指纹）比对。平常一天写 0 笔。

   ④ **只碰 src='gcal'** —— 你自己建的事项，同步和清理**永远动不到一根寒毛**。
      Google 的只是快取（本尊在 Google），你自己建的没了就真的没了。
   ════════════════════════════════════════════════════════════════════ */

const GC_WIN_BACK_Y = 2;    // 过去 2 年
const GC_WIN_FWD_Y  = 3;    // 未来 3 年（共 5 年；实测 5 年 = D1 的 0.07%、翻月 8ms）

async function gcState(env) {
  const row = await env.DB.prepare("SELECT v FROM app_settings WHERE k='gcal'").first();
  if (!row) return { cals: {}, seen: [] };
  try { const o = JSON.parse(row.v); o.cals = o.cals || {}; o.seen = o.seen || []; return o; }
  catch (e) { return { cals: {}, seen: [] }; }
}
async function gcPut(env, obj) { await putSetting(env, "gcal", JSON.stringify(obj)); }

/* 同步窗口（SGT 挂钟）→ Google 要 RFC3339 */
function gcWindow() {
  const y = new Date(Date.now() + SGT).getUTCFullYear();
  return {
    lo: `${y - GC_WIN_BACK_Y}-01-01`,
    hi: `${y + GC_WIN_FWD_Y}-12-31`,
    timeMin: `${y - GC_WIN_BACK_Y}-01-01T00:00:00+08:00`,
    timeMax: `${y + GC_WIN_FWD_Y}-12-31T23:59:59+08:00`,
  };
}

/* 一次 Google API 呼叫。403 时把原因翻成人话 —— 「默默失败」是这套东西最大的敌人。 */
async function gcApi(env, path, params) {
  const tok = await gdAccessToken(env);
  const u = "https://www.googleapis.com/calendar/v3" + path + (params ? "?" + new URLSearchParams(params) : "");
  const r = await fetch(u, { headers: { Authorization: "Bearer " + tok } });
  if (r.ok) return await r.json();
  const body = await r.text();
  if (r.status === 403 && /insufficient|scope|permission/i.test(body)) {
    throw new Error("授权里没有日历权限 —— 要重新授权一次（Google Cloud 那边加好 calendar.readonly 之后，回设置页按「重新连接 Google」）");
  }
  if (r.status === 401) throw new Error("授权过期了，要重新连接 Google");
  if (r.status === 429 || (r.status === 403 && /rateLimit|usageLimits/i.test(body))) {
    throw new Error("被 Google 限速了，等一下再按同步");
  }
  throw new Error(`Google 回 ${r.status}：${body.slice(0, 160)}`);
}

/* 你有哪几本日历 */
async function gcCalendars(env) {
  const j = await gcApi(env, "/users/me/calendarList", { minAccessRole: "reader", maxResults: "250" });
  return (j.items || []).map((c) => ({
    id: c.id,
    name: c.summaryOverride || c.summary || c.id,
    primary: !!c.primary,
    color: c.backgroundColor || null,
  }));
}

/* ---- 时区：Google 给什么都好，进 D1 一律是新加坡挂钟 ----
   ⚠️ 这就是文档里 #4 那条我们本来跳过的。单向同步只要转一个方向，所以现在做很便宜。
   ⚠️ 全天事项：Google 的 end.date 是**不包含**那天的（2026-07-20 → end=2026-07-21 表示只有 20 号一天）。
      不减这一天，你每个全天事项都会多出一天 —— 这是抄 Google API 最经典的坑。 */
function gcWhen(ev) {
  const s = ev.start || {}, e = ev.end || {};
  if (s.date) {                                   // 全天
    const day = s.date;
    let end = e.date ? wDay(wIdx(e.date) - 1) : day;   // ← 减一天（exclusive → inclusive）
    if (end < day) end = day;
    return { day, time: null, end: end > day ? end : null, etime: null };
  }
  if (!s.dateTime) return null;
  const ms1 = Date.parse(s.dateTime);
  const ms2 = e.dateTime ? Date.parse(e.dateTime) : ms1 + 3600000;
  if (!Number.isFinite(ms1)) return null;
  const sgt = (ms) => {
    const d = new Date(ms + SGT);
    return { d: d.toISOString().slice(0, 10), t: d.toISOString().slice(11, 16) };
  };
  const a = sgt(ms1), b = sgt(ms2);
  return { day: a.d, time: a.t, end: b.d > a.d ? b.d : null, etime: b.t };
}

/* 会议链接：Meet 直接给；Zoom / Teams 藏在 conferenceData 或 location 里 */
function gcLink(ev) {
  if (ev.hangoutLink) return ev.hangoutLink;
  const eps = (ev.conferenceData && ev.conferenceData.entryPoints) || [];
  const v = eps.find((x) => x.entryPointType === "video" && x.uri);
  if (v) return v.uri;
  const hay = `${ev.location || ""} ${ev.description || ""}`;
  const m = hay.match(/https?:\/\/[^\s<>"']*(zoom\.us|teams\.microsoft\.com|meet\.google\.com|webex\.com)[^\s<>"']*/i);
  return m ? m[0] : null;
}

/* Google 的一笔 → 我们 events 表的一行 */
function gcRow(ev, calId) {
  const w = gcWhen(ev);
  if (!w) return null;
  const title = String(ev.summary || "(无标题)").trim().slice(0, 200);
  /* description 是 HTML（Zoom 那坨样板）→ 用现成的 htmlToLines 洗成纯文字 */
  let note = null;
  if (ev.description) {
    note = htmlToLines(String(ev.description)).join("\n").slice(0, 2000) || null;
  }
  const row = {
    day: w.day, time: w.time, end: w.end, etime: w.etime,
    title, note,
    loc: ev.location ? String(ev.location).slice(0, 300) : null,
    url: gcLink(ev),
    ext_id: ev.id, cal_id: calId,
    ext_h: "",                 /* ⚠️ 同上：先宣告，不要事后硬塞 */
  };
  row.ext_h = gcHash(row);
  return row;
}
/* 内容指纹：一样就不写 D1。用简单的 32-bit 滚动 hash（不是密码学用途，够用且快）。 */
function gcHash(r) {
  const s = [r.day, r.time, r.end, r.etime, r.title, r.note, r.loc, r.url].join("\u0001");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36) + "." + s.length.toString(36);
}

/* 拉一本日历的全部（会自动翻页） */
async function gcFetchAll(env, calId, win) {
  const out = [];
  let pageToken = null, guard = 0;
  do {
    const p = {
      singleEvents: "true",            // ← ①：Google 自己摊平，我们不碰 RRULE
      timeMin: win.timeMin, timeMax: win.timeMax,
      maxResults: "2500", orderBy: "startTime",
      fields: "nextPageToken,items(id,status,summary,description,location,start,end,hangoutLink,conferenceData/entryPoints)",
    };
    if (pageToken) p.pageToken = pageToken;
    const j = await gcApi(env, `/calendars/${encodeURIComponent(calId)}/events`, p);
    for (const ev of (j.items || [])) {
      if (ev.status === "cancelled") continue;
      const r = gcRow(ev, calId);
      if (r) out.push(r);
    }
    pageToken = j.nextPageToken || null;
  } while (pageToken && ++guard < 20);
  return out;
}

/* ════ 同步一本日历：整包拉 → 比对 → 只写变动的 ════ */
async function gcSyncCal(env, calId, win) {
  const fresh = await gcFetchAll(env, calId, win);
  /* ⚠️ 只捞这本日历的 gcal 行。src 条件是整套东西的安全绳，任何时候都不能拿掉。 */
  const cur = await env.DB.prepare(
    "SELECT id, ext_id, ext_h FROM events WHERE src='gcal' AND cal_id=?"
  ).bind(calId).all();
  const have = new Map();
  for (const x of (cur.results || [])) have.set(x.ext_id, x);

  let added = 0, updated = 0, same = 0;
  for (const r of fresh) {
    const old = have.get(r.ext_id);
    have.delete(r.ext_id);
    if (old && old.ext_h === r.ext_h) { same++; continue; }     // ← ③ 没变就不写
    if (old) {
      /* ⚠️ 只覆盖「内容」。kind / notify_min / notifs 是**你自己设的提醒**，
         同步一律不碰 —— 不然你设好的「前 15 分钟叫我」下次同步就被洗掉了。 */
      await env.DB.prepare(
        "UPDATE events SET day=?, time=?, end_day=?, end_time=?, title=?, note=?, loc=?, url=?, ext_h=? WHERE id=? AND src='gcal'"
      ).bind(r.day, r.time, r.end, r.etime, r.title, r.note, r.loc, r.url, r.ext_h, old.id).run();
      updated++;
    } else {
      await env.DB.prepare(
        `INSERT INTO events (day, time, title, note, end_day, end_time, kind, notify_min,
           src, ext_id, cal_id, url, loc, ext_h)
         VALUES (?, ?, ?, ?, ?, ?, 'event', NULL, 'gcal', ?, ?, ?, ?, ?)`
      ).bind(r.day, r.time, r.title, r.note, r.end, r.etime, r.ext_id, calId, r.url, r.loc, r.ext_h).run();
      added++;
    }
  }
  /* 剩在 have 里的 = Google 那边已经没了（或移出窗口）→ 删掉。同样只删 src='gcal'。 */
  let removed = 0;
  for (const x of have.values()) {
    await env.DB.prepare("DELETE FROM events WHERE id=? AND src='gcal'").bind(x.id).run();
    removed++;
  }
  return { added, updated, removed, same, total: fresh.length };
}

/* ════ 同步全部勾选的日历 ════ */
async function gcSync(env) {
  const t0 = Date.now();
  const st = await gcState(env);
  const on = Object.keys(st.cals || {}).filter((k) => st.cals[k]);
  const win = gcWindow();
  const sum = { added: 0, updated: 0, removed: 0, same: 0, total: 0, cals: on.length };
  try {
    for (const calId of on) {
      const r = await gcSyncCal(env, calId, win);
      sum.added += r.added; sum.updated += r.updated; sum.removed += r.removed;
      sum.same += r.same; sum.total += r.total;
    }
    /* 顺手清掉窗口外的旧快取（只清 gcal）。你自己建的一笔都不动。 */
    const del = await env.DB.prepare(
      "DELETE FROM events WHERE src='gcal' AND (day < ? OR day > ?)"
    ).bind(win.lo, win.hi).run();
    sum.pruned = (del.meta && del.meta.changes) || 0;
    /* 取消勾选的日历 → 把它的快取整本清掉 */
    const off = await env.DB.prepare(
      "SELECT DISTINCT cal_id FROM events WHERE src='gcal'"
    ).all();
    for (const x of (off.results || [])) {
      if (on.indexOf(x.cal_id) < 0) {
        await env.DB.prepare("DELETE FROM events WHERE src='gcal' AND cal_id=?").bind(x.cal_id).run();
      }
    }
    st.last_sync = sgIso();
    delete st.last_error; delete st.last_error_at;
    await gcPut(env, st);
    sum.ms = Date.now() - t0;
    return sum;
  } catch (e) {
    /* ⚠️ 失败一定要留痕迹给前端显示红字。「默默失败」= 你两个月后才发现日历停在旧的。 */
    st.last_error = e.message; st.last_error_at = sgIso();
    await gcPut(env, st);
    throw e;
  }
}


/* ════════════════════════════════════════════════════════════════════
   v9.6 ICS 订阅（新加坡假期 / NBA / 世界杯）

   我把真的档案抓下来看过才设计的，不是照文档猜：
     · Google 新加坡假期：277 件 · **RRULE = 0**（全摊平）· **没有 ETag 也没有 Last-Modified**
       → cache-control: no-cache, no-store  → 304 那招在这里**完全用不上**
     · calendarlabs NBA：65 件 · RRULE = 0 · **有 Last-Modified** → 304 可以用
   所以：**ETag / Last-Modified 有就用（→304 直接跳过），没有就整包拉 + ext_h 比对**
   （跟 Google Calendar 那边同一套。105KB 而已，一点都不贵。）

   ⚠️ 已知会咬人的坑，全部处理掉：
     ① ICS 每 75 字元**折行**，续行开头是空格/tab → 不先 unfold，标题会被切断
     ② `\,` `\;` `\n` `\\` 转义
     ③ 全天的 DTEND 是**不含**那天的（4号的假期写 DTEND=5号）→ 要减 1 天
        实测：DTSTART;VALUE=DATE:20211104 / DTEND;VALUE=DATE:20211105 = 只有 4 号一天
     ④ NBA 是 UTC（20241013T220000Z）→ 新加坡是隔天 06:00。**这是对的**，跟 ESPN 差一天很正常
     ⑤ TZID=Asia/Tokyo 这种要用 Intl 转
     ⑥ webcal:// → https:// · 只准 https · 挡内网 IP（SSRF）· 5MB 上限
   ════════════════════════════════════════════════════════════════════ */

const ICS_MAX_BYTES = 5 * 1024 * 1024;
const ICS_MAX_EVENTS = 5000;

async function icsState(env) {
  const row = await env.DB.prepare("SELECT v FROM app_settings WHERE k='ics'").first();
  if (!row) return { feeds: [] };
  try { const o = JSON.parse(row.v); o.feeds = Array.isArray(o.feeds) ? o.feeds : []; return o; }
  catch (e) { return { feeds: [] }; }
}
const icsPut = (env, o) => putSetting(env, "ics", JSON.stringify(o));

/* ---- ① unfold：把折行接回去。必须先做，不然什么都解析错 ---- */
function icsUnfold(text) {
  return String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "");
}
/* ---- ② 反转义 ---- */
function icsUnesc(v) {
  return String(v).replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}
/* 一行 → { name, params:{}, value } */
function icsLine(line) {
  const i = line.indexOf(":");
  if (i < 0) return null;
  const left = line.slice(0, i), value = line.slice(i + 1);
  const parts = left.split(";");
  const params = {};
  for (let k = 1; k < parts.length; k++) {
    const j = parts[k].indexOf("=");
    if (j > 0) params[parts[k].slice(0, j).toUpperCase()] = parts[k].slice(j + 1).replace(/^"|"$/g, "");
  }
  return { name: parts[0].toUpperCase(), params, value };
}

/* ---- ⑤ 时间 → 新加坡挂钟。三种格式都要吃 ---- */
function icsTime(v, params) {
  const val = String(v || "").trim();
  // 全天: 20211104
  if (/^\d{8}$/.test(val) && (params.VALUE === "DATE" || val.length === 8)) {
    return { allDay: true, day: `${val.slice(0,4)}-${val.slice(4,6)}-${val.slice(6,8)}` };
  }
  const m = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  const [, Y, Mo, D, h, mi, sec, z] = m;
  let ms;
  if (z) {
    ms = Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +sec);            // ④ UTC
  } else if (params.TZID) {
    // ⑤ 有时区名 → 用 Intl 反推该时区当下的 offset
    const guess = Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +sec);
    let off = 0;
    try {
      const dtf = new Intl.DateTimeFormat("en-US", { timeZone: params.TZID, hour12: false,
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const p = {}; for (const x of dtf.formatToParts(new Date(guess))) p[x.type] = x.value;
      const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour === "24" ? 0 : p.hour), +p.minute, +p.second);
      off = asUTC - guess;                                     // 该时区比 UTC 快多少
    } catch (e) { off = 0; }                                   // 不认得的时区 → 当 UTC，至少不炸
    ms = guess - off;
  } else {
    ms = Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +sec) - SGT;       // 浮动时间 → 当成本地(新加坡)
  }
  const d = new Date(ms + SGT);
  return { allDay: false, ms, day: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
}

/* ---- 解析整个档案 → VEVENT 阵列 ---- */
function icsParse(text) {
  const lines = icsUnfold(text).split("\n");
  /* ⚠️ 要写 JSDoc 型别：不然 `let cur = null` 会被 TS 窄化成 `null`，
     底下 cur.uid / cur.summary … 每一个都红字（TS2339 ×12）。跑起来没事，但编辑器满江红。 */
  /** @type {any[]} */ const out = [];
  /** @type {any} */ let cur = null;
  let inEv = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "BEGIN:VEVENT") { inEv = true; cur = { exdate: [] }; continue; }
    if (line === "END:VEVENT") { if (cur) out.push(cur); cur = null; inEv = false;
      if (out.length >= ICS_MAX_EVENTS) break; continue; }
    if (!inEv || !cur) continue;
    const L = icsLine(line);
    if (!L) continue;
    switch (L.name) {
      case "UID": cur.uid = L.value.trim(); break;
      case "SUMMARY": cur.summary = icsUnesc(L.value); break;
      case "DESCRIPTION": cur.desc = icsUnesc(L.value); break;
      case "LOCATION": cur.loc = icsUnesc(L.value); break;
      case "URL": cur.url = L.value.trim(); break;
      case "STATUS": cur.status = L.value.trim().toUpperCase(); break;
      case "DTSTART": cur.start = icsTime(L.value, L.params); break;
      case "DTEND": cur.end = icsTime(L.value, L.params); break;
      case "RRULE": cur.rrule = L.value.trim(); break;
      case "RECURRENCE-ID": cur.recId = icsTime(L.value, L.params); break;
      case "EXDATE":
        for (const v of L.value.split(",")) { const t = icsTime(v.trim(), L.params); if (t) cur.exdate.push(t.day); }
        break;
    }
  }
  return out;
}

/* ---- RRULE：只做算得准的。算不准的**大声讲**，绝不猜 ----
   ⚠️ 抓下来实测：新加坡假期 RRULE=0、NBA RRULE=0 → 你要订的那些根本用不到这段。
      这段是给「哪天你订到别人的私人日历」用的安全网。
   支援：FREQ(DAILY/WEEKLY/MONTHLY/YEARLY) · INTERVAL · BYDAY(星期几) · COUNT · UNTIL · EXDATE
   不支援：BYSETPOS(每月最后一个周五) · BYMONTHDAY=-1(每月最后一天) · BYWEEKNO · BYYEARDAY
           → 回 {unsupported:true}，只画第一次，并在设置页显示「⚠️ N 件规则太复杂」 */
const ICS_WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
function icsRRule(rule) {
  /** @type {Record<string,string>} */ const p = {};
  for (const kv of String(rule).split(";")) { const i = kv.indexOf("="); if (i > 0) p[kv.slice(0, i).toUpperCase()] = kv.slice(i + 1); }
  const freq = (p.FREQ || "").toUpperCase();
  if (["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].indexOf(freq) < 0) return { unsupported: true, why: "FREQ=" + freq };
  for (const bad of ["BYSETPOS", "BYWEEKNO", "BYYEARDAY", "BYHOUR", "BYMINUTE"]) if (p[bad]) return { unsupported: true, why: bad };
  if (p.BYMONTHDAY && /-/.test(p.BYMONTHDAY)) return { unsupported: true, why: "BYMONTHDAY=" + p.BYMONTHDAY };
  // BYDAY 带序号（3TH = 第三个星期四）→ 算不准
  if (p.BYDAY && /\d/.test(p.BYDAY)) return { unsupported: true, why: "BYDAY=" + p.BYDAY };
  const days = p.BYDAY ? p.BYDAY.split(",").map((d) => ICS_WD[d.trim().toUpperCase()]).filter((x) => x != null) : null;
  return {
    unsupported: false,
    t: freq === "DAILY" ? "day" : freq === "WEEKLY" ? "week" : freq === "MONTHLY" ? "month" : "year",
    i: Math.max(1, Math.min(99, parseInt(p.INTERVAL || "1", 10) || 1)),
    d: (days && days.length) ? days.sort() : null,
    count: p.COUNT ? Math.max(1, Math.min(2000, parseInt(p.COUNT, 10) || 0)) : null,
    until: p.UNTIL ? (icsTime(p.UNTIL, {}) || {}).day || null : null,
  };
}


/* ---- ⑥ 安全：只准 https、挡内网、webcal 自动换 ---- */
function icsUrl(raw) {
  let u = String(raw || "").trim();
  if (/^webcal:\/\//i.test(u)) u = "https://" + u.slice(9);
  if (/^http:\/\//i.test(u)) u = "https://" + u.slice(7);
  let p;
  try { p = new URL(u); } catch (e) { throw new Error("这不是一个有效的链接"); }
  if (p.protocol !== "https:") throw new Error("只收 https 的链接");
  const h = p.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") ||
      /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h === "[::1]" || h === "::1")
    throw new Error("不能用内网地址");
  return p.toString();
}

/* ---- 拉一个 feed。ETag/Last-Modified 有就用（→304 直接跳过）---- */
async function icsFetch(feed) {
  const url = icsUrl(feed.url);
  /** @type {Record<string,string>} */
  const h = {};
  if (feed.etag) h["If-None-Match"] = feed.etag;
  if (feed.lastmod) h["If-Modified-Since"] = feed.lastmod;
  const r = await fetch(url, { headers: h, cf: { cacheTtl: 0 } });
  if (r.status === 304) return { notModified: true };           // ← 0 bytes、0 解析、0 写入
  if (!r.ok) throw new Error(`对方回 ${r.status}`);
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  const len = parseInt(r.headers.get("content-length") || "0", 10);
  if (len && len > ICS_MAX_BYTES) throw new Error(`档案太大（${(len/1048576).toFixed(1)}MB），上限 5MB`);
  const text = await r.text();
  if (text.length > ICS_MAX_BYTES) throw new Error("档案太大，上限 5MB");
  if (!/BEGIN:VCALENDAR/i.test(text)) {
    throw new Error(ct.includes("html") ? "这个链接回的是网页，不是日历档（要 .ics 的那个）" : "这不是日历档");
  }
  return {
    text,
    etag: r.headers.get("etag") || null,
    lastmod: r.headers.get("last-modified") || null,
    name: (text.match(/^X-WR-CALNAME:(.+)$/mi) || [])[1] || null,
  };
}

/* ---- VEVENT → events 表的行（跟 Google 那边同一个形状）---- */
function icsRow(ev, feedId) {
  if (!ev.uid || !ev.start) return null;
  if (ev.status === "CANCELLED") return null;
  const st = ev.start;
  /** @type {any} */ let time = null;
  /** @type {any} */ let end = null;
  /** @type {any} */ let etime = null;
  let day = st.day;
  if (st.allDay) {
    // ③ DTEND 是**不含**那天的 → 减 1
    if (ev.end && ev.end.allDay) { const e = wDay(wIdx(ev.end.day) - 1); if (e > day) end = e; }
  } else {
    time = st.time;
    if (ev.end && !ev.end.allDay) { etime = ev.end.time; if (ev.end.day > day) end = ev.end.day; }
  }
  /* ⚠️ ext_h 要先宣告在字面量里，不要事后 row.ext_h= 硬塞 ——
     Cloudflare dashboard 的编辑器会跑 TypeScript 检查，事后加属性会红字
     TS2339: Property 'ext_h' does not exist on type '{...}'。跑起来没事，但看了心烦。 */
  const row = {
    day, time, end, etime,
    title: String(ev.summary || "(无标题)").trim().slice(0, 200),
    note: ev.desc ? String(ev.desc).slice(0, 2000) : null,
    loc: ev.loc ? String(ev.loc).slice(0, 300) : null,
    url: (ev.url && /^https?:\/\//i.test(ev.url)) ? ev.url : gcLink({ description: ev.desc, location: ev.loc }),
    ext_id: String(ev.uid).slice(0, 180),
    cal_id: feedId,
    ext_h: "",
  };
  row.ext_h = gcHash(row);
  return row;
}

/* ---- 一个 feed 的全部 VEVENT → 展开成一笔一笔（含 RRULE）---- */
function icsExpand(text, feedId, win) {
  const evs = icsParse(text);
  /** @type {any[]} */ const rows = [];
  let warn = 0;
  /** @type {Set<string>} */ const seen = new Set();
  /* RECURRENCE-ID = 某一次被改过 → 先收起来，展开时盖上去 */
  /** @type {Record<string, any>} */ const mods = {};
  for (const ev of evs) if (ev.recId && ev.uid) mods[ev.uid + "|" + ev.recId.day] = ev;
  for (const ev of evs) {
    if (ev.recId) continue;                          // 改过的那次，等下盖上去
    const base = icsRow(ev, feedId);
    if (!base) continue;
    if (!ev.rrule) {
      if (base.day >= win.lo && base.day <= win.hi && !seen.has(base.ext_id)) { seen.add(base.ext_id); rows.push(base); }
      continue;
    }
    const rr = icsRRule(ev.rrule);
    if (rr.unsupported) {
      /* ⚠️ 算不准 → **只画第一次** + 记一笔警告给设置页。绝不猜。 */
      warn++;
      if (base.day >= win.lo && base.day <= win.hi && !seen.has(base.ext_id)) { seen.add(base.ext_id); rows.push(base); }
      continue;
    }
    /* 用 worker 现成的 wOccur（跟你自己的重复事项同一套算法，不另外写一份） */
    const fake = { day: base.day, rep: { t: rr.t, i: rr.i, d: rr.d, until: rr.until, ex: ev.exdate } };
    let n = 0;
    for (const k of wOccur(fake, win.lo, win.hi)) {
      if (rr.count && n >= rr.count) break;
      n++;
      const m = mods[ev.uid + "|" + k];
      const o = m ? (icsRow(m, feedId) || base) : base;
      const shift = wIdx(k) - wIdx(base.day);
      const r2 = { ...o, day: k, end: o.end ? wDay(wIdx(o.end) + shift) : null,
        ext_id: (base.ext_id + "|" + k).slice(0, 180) };
      r2.ext_h = gcHash(r2);
      if (!seen.has(r2.ext_id)) { seen.add(r2.ext_id); rows.push(r2); }
      if (rows.length >= ICS_MAX_EVENTS) break;
    }
  }
  return { rows, warn };
}

/* ════ 同步一个 feed：整包拉（或 304 跳过）→ 比对 → 只写变动的 ════ */
async function icsSyncOne(env, feed, win) {
  const got = await icsFetch(feed);
  if (got.notModified) return { skipped: true, added: 0, updated: 0, removed: 0, same: 0 };
  const { rows, warn } = icsExpand(got.text, feed.id, win);
  /* ⚠️ src='ics' 是安全绳，任何时候都不能拿掉 —— 你自己建的事项永远碰不到 */
  const cur = await env.DB.prepare("SELECT id, ext_id, ext_h FROM events WHERE src='ics' AND cal_id=?").bind(feed.id).all();
  const have = new Map();
  for (const x of (cur.results || [])) have.set(x.ext_id, x);
  let added = 0, updated = 0, same = 0;
  for (const r of rows) {
    const old = have.get(r.ext_id);
    have.delete(r.ext_id);
    if (old && old.ext_h === r.ext_h) { same++; continue; }        // 没变就不写
    if (old) {
      /* 只覆盖内容。kind/notify_min/notifs = 你自己设的提醒，同步一律不碰 */
      await env.DB.prepare(
        "UPDATE events SET day=?, time=?, end_day=?, end_time=?, title=?, note=?, loc=?, url=?, ext_h=? WHERE id=? AND src='ics'"
      ).bind(r.day, r.time, r.end, r.etime, r.title, r.note, r.loc, r.url, r.ext_h, old.id).run();
      updated++;
    } else {
      await env.DB.prepare(
        `INSERT INTO events (day, time, title, note, end_day, end_time, kind, notify_min, src, ext_id, cal_id, url, loc, ext_h)
         VALUES (?, ?, ?, ?, ?, ?, 'event', NULL, 'ics', ?, ?, ?, ?, ?)`
      ).bind(r.day, r.time, r.title, r.note, r.end, r.etime, r.ext_id, feed.id, r.url, r.loc, r.ext_h).run();
      added++;
    }
  }
  let removed = 0;
  for (const x of have.values()) {
    await env.DB.prepare("DELETE FROM events WHERE id=? AND src='ics'").bind(x.id).run();
    removed++;
  }
  return { added, updated, removed, same, total: rows.length, warn,
           etag: got.etag, lastmod: got.lastmod, name: got.name };
}

/* ════ 同步全部勾选的订阅 ════ */
async function icsSync(env, force) {
  const st = await icsState(env);
  const win = gcWindow();
  const now = Date.now();
  const sum = { added: 0, updated: 0, removed: 0, same: 0, skipped: 0, feeds: 0 };
  for (const f of st.feeds) {
    if (!f.on) continue;
    /* ⚠️ 一天一次就够：假期一年才动一次、NBA 改期也不急。
       想立刻 → 按「立即同步」(force)。刚加进来的也会 force。 */
    if (!force && f.last_sync && now - Date.parse(f.last_sync) < 24 * 3600 * 1000) continue;
    sum.feeds++;
    try {
      const r = await icsSyncOne(env, f, win);
      if (r.skipped) { sum.skipped++; f.last_sync = sgIso(); delete f.last_error; continue; }
      sum.added += r.added; sum.updated += r.updated; sum.removed += r.removed; sum.same += r.same;
      f.etag = r.etag; f.lastmod = r.lastmod;
      f.n = r.total; f.warn = r.warn || 0;
      if (r.name && !f.custom) f.name = r.name.trim().slice(0, 60);
      f.last_sync = sgIso();
      delete f.last_error;
    } catch (e) {
      f.last_error = e.message; f.last_error_at = sgIso();
    }
  }
  /* 取消勾选 / 已删除的 → 把快取清掉（只清 src='ics'） */
  const on = new Set(st.feeds.filter((f) => f.on).map((f) => f.id));
  const rs = await env.DB.prepare("SELECT DISTINCT cal_id FROM events WHERE src='ics'").all();
  for (const x of (rs.results || [])) {
    if (!on.has(x.cal_id)) await env.DB.prepare("DELETE FROM events WHERE src='ics' AND cal_id=?").bind(x.cal_id).run();
  }
  await env.DB.prepare("DELETE FROM events WHERE src='ics' AND (day < ? OR day > ?)").bind(win.lo, win.hi).run();
  await icsPut(env, st);
  return sum;
}

/* ⚠️ 收件箱只留最近 3 个月 —— 邮件原文是最占地方的东西。
   每收一封信、每次 cron 都会顺手清一次。
   算笔账：一封 DBS 的 HTML 邮件截断后约 8KB，一个月 100 封 = 0.8MB，
   3 个月 ≈ 2.4MB。D1 免费额度 5GB，完全不用担心。 */
const INBOX_KEEP_MONTHS = 3;

/* 新加坡时间的「现在」。inbox 的 ts 一律存 SGT，
   这样 substr(ts,1,7) 分出来的月份 = 你看到的月份（存 UTC 的话，
   新加坡凌晨 0–8 点的信会被算到上个月，很容易搞混）。 */
function sgIso() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("Z", "+08:00");
}

/* ⚠️ 按**月份边界**清，不是按「3 个月前的今天」清。
   按天算的话：8 月 14 号往回推 3 个月 = 5 月 14 号 → 5 月下半月的信还留着
   → 月份按钮会变成「5月 6月 7月 8月」四个，跟「只留 3 个月」不符。
   按月份边界算：保留 本月 + 前 2 个月。
   一到 8 月 1 号，cutoff 自动变成 2026-06-01 → 5 月整个月被清掉
   → 按钮自动变成 6月 / 7月 / 8月。**全自动，没有任何硬编码。** */
function inboxCutoff() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth() - (INBOX_KEEP_MONTHS - 1);   // 本月 + 前 2 个月
  while (m < 0) { m += 12; y--; }
  return `${y}-${String(m + 1).padStart(2, "0")}-01`;  // "2026-06-01"
}
async function purgeInbox(env, backedUp) {
  try {
    /* v9.98 收件箱跟支出保留「同步」：开了数据保留 → 邮件也留一年（跟支出同一条 cutoff）；没开 → 维持默认 3 个月。
       ts 是 "YYYY-MM-DDT..." 开头，跟 "YYYY-MM-01" 做字符串比较是正确的。

       ⚠️ v10.4 补一道闸门（跟 purgeExpenses 同一条规矩）。
       这支有 5 个 call site，其中 3 个是「每收一封信就顺手清一次」。
       保留**关**的时候那样没问题 —— 3 个月的旧邮件本来就不进备份，删了也不心疼。
       保留**开**之后就不一样了：它删的是「刚好满一年」的邮件，而且可能在两次月度备份
       **之间**的任何一刻被触发 → 那封信永远进不了任何一份备份，直接人间蒸发。
       所以现在：
         保留开 → 只有「刚备份成功」那一次（backedUp=true）才真的删，其余一律跳过。
         保留关 → 完全维持原本行为（3 个月、随手清、不设闸门）。 */
    const st = await getRetention(env);
    if (st.on && !backedUp) return;   // 保留模式：等月度备份成功后那一次再删
    const cutoff = st.on ? expCutoff(st.months) : inboxCutoff();
    const r = await env.DB.prepare("DELETE FROM inbox WHERE ts < ?").bind(cutoff).run();
    if (r.meta && r.meta.changes) console.log("purged inbox rows:", r.meta.changes, "cutoff", cutoff);
  } catch (e) { console.log("purge failed:", e.message); }
}

/* ================= v9.97 数据保留（只留最近一年，旧的自动删）=================
   跟 inbox 的清理同一套「按月份边界」思路（见上面 inboxCutoff 的说明），
   但这删的是**真账**、不可逆 —— 所以比 inbox 多两道保险：
     ① 要用户在「Google Drive 备份」页**明确打开**开关（retention.on，默认关）。
     ② 只在「每月自动备份**成功之后**」才删 —— 删掉的那些一定已经在那份刚做好的备份里。
        没连 Drive / 备份失败 = 这个月不删，等下次。**绝不删没备份过的东西。**
   EXP_KEEP_MONTHS_DEFAULT=13：本月 + 前 12 个月。
   举例（用户的例子）：今年 4 月时 cutoff = 去年 4/1 → 去年 3 月及更早删掉、去年 4 月还留着（能跟今年 4 月同比）。*/
const EXP_KEEP_MONTHS_DEFAULT = 13;
function expCutoff(months) {
  const k = (months && months > 0) ? months : EXP_KEEP_MONTHS_DEFAULT;
  const d = new Date(Date.now() + 8 * 3600 * 1000);   // SGT
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth() - (k - 1);
  while (m < 0) { m += 12; y--; }
  return `${y}-${String(m + 1).padStart(2, "0")}-01`;   // 例 "2025-04-01"
}
async function getRetention(env) {
  try {
    const r = await env.DB.prepare("SELECT v FROM app_settings WHERE k='retention'").first();
    if (r) { const j = JSON.parse(r.v); return { on: !!j.on, months: (j.months > 0 ? j.months : EXP_KEEP_MONTHS_DEFAULT) }; }
  } catch (e) {}
  return { on: false, months: EXP_KEEP_MONTHS_DEFAULT };   // 默认：关。要用户自己在设置里打开。
}
/* backedUp=true 只由「月度备份刚成功」那条路传进来；其余（手动 run）会再自己确认一次有没有近两天的备份。 */
async function purgeExpenses(env, backedUp) {
  try {
    const st = await getRetention(env);
    if (!st.on) return { skipped: "off" };
    if (!backedUp) {
      const gd = await gdState(env);
      const fresh = gd && gd.refresh_token && gd.last_backup &&
                    (Date.now() - new Date(gd.last_backup).getTime()) < 2 * 86400000;
      if (!fresh) return { skipped: "no-fresh-backup" };   // 没有近 2 天的备份 → 不删
    }
    const cutoff = expCutoff(st.months);
    // ts 是 "YYYY-MM-DDT...+08:00"，跟 "YYYY-MM-01" 字符串比较正确
    const r = await env.DB.prepare("DELETE FROM expenses WHERE ts < ?").bind(cutoff).run();
    const deleted = (r.meta && r.meta.changes) || 0;
    await putSetting(env, "retention_last", JSON.stringify({ t: new Date().toISOString(), deleted, cutoff }));
    if (deleted) console.log("purged expenses:", deleted, "cutoff", cutoff);
    return { deleted, cutoff };
  } catch (e) { console.log("purgeExpenses failed:", e.message); return { error: e.message }; }
}

let schemaOK = false;   // 同一个 isolate 内只跑一次

async function ensureSchema(env) {
  if (schemaOK) return;
  try {
    // app_settings 是记版本号的地方，它必须先在。这条本身就是幂等的。
    await env.DB.prepare(MIGRATIONS[0]).run();

    let have = 0;
    try {
      const row = await env.DB.prepare("SELECT v FROM app_settings WHERE k='schema_version'").first();
      if (row) have = parseInt(row.v, 10) || 0;
    } catch (e) {}

    if (have >= SCHEMA_VERSION) { schemaOK = true; return; }

    /* ⚠️ v9.1 修：以前是 `let i = have` —— 拿版本号当 index 续跑。
       只要 SCHEMA_VERSION 跟 MIGRATIONS.length 对不上（历史上就对不上），中间那几条会被永久跳过。
       改成**一律从 0 跑**：每一条都是幂等的（CREATE IF NOT EXISTS / ALTER 撞了会被下面吞掉），
       代价是版本变动时多跑几十条 no-op —— 一次几毫秒，换「永远不会漏栏位」，非常划算。 */
    for (let i = 0; i < MIGRATIONS.length; i++) {
      try {
        await env.DB.prepare(MIGRATIONS[i]).run();
        console.log("migrated to v" + (i + 1));
      } catch (e) {
        // ALTER TABLE ... ADD COLUMN 在列已存在时会报错 —— 这是正常的（比如你以前手动跑过），吞掉。
        if (/duplicate column|already exists/i.test(e.message || "")) {
          console.log("migration v" + (i + 1) + " already applied, skipping");
        } else {
          throw e;   // 别的错误要炸出来，不然会带着坏 schema 继续跑
        }
      }
    }
    await putSetting(env, "schema_version", String(SCHEMA_VERSION));
    schemaOK = true;
  } catch (e) {
    console.log("ensureSchema FAILED:", e.message);
    // 不设 schemaOK → 下个请求还会再试一次
    throw e;
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });

/* ================================================================
   Google Drive 自动备份（v5.2）
   ----------------------------------------------------------------
   为什么不能用 Portfolio 那套：
     Portfolio 用的是浏览器端 GIS（Google Identity Services），拿到的是 access_token，
     1 小时就过期，**没有 refresh_token** → 你不开 app，Worker 就没法自己传 Drive。
   这里改用「OAuth 授权码流程 + access_type=offline」→ 拿得到 refresh_token
   → 存进 D1 → Worker 的 cron 就能自己刷新 access_token、自己传 Drive，
      **完全不需要你开 app**。

   需要两个 Worker Secret（Settings → Variables and Secrets）：
     GD_CLIENT_ID      Google Cloud 的 OAuth Client ID
     GD_CLIENT_SECRET  对应的 Client Secret
   授权信息存在 app_settings 的 k='gdrive'：{refresh_token, file_id, last_backup}
   ================================================================ */
const GD_SCOPE = "https://www.googleapis.com/auth/drive.file";   // 只能碰自己建的档，碰不到你别的文件
/* v9.1 Google Calendar：**只读**。
   ⚠️ 故意不要 .../auth/calendar（可读可写）—— 我们永远不写回 Google，
      多要一个权限只是多一个「万一 bug 了会毁掉你真日历」的风险。
   ⚠️ 复用 Drive 那个 OAuth client + 同一个 redirect_uri + 同一个 refresh_token。
      两个 scope 一起要 → 一个 refresh_token 通吃。旧的（只授权过 Drive 的）refresh_token
      **不含** calendar 权限 → 呼叫会 403 → 前端要提示「重新授权一次」。 */
const GC_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const GD_FILENAME = "花费备份.json";
const GD_FOLDER = "expense json";     // 备份就放这个资料夹里，永远只有一份档

/* ⚠️⚠️ 这两个是 Google OAuth 凭证，client_secret 相当于密码。
   **这个档案绝对不要传到公开的 GitHub repo**，只贴进 Cloudflare dashboard。
   万一泄漏了：Google Cloud → Credentials → 删掉这个 OAuth client → 重建一个即可。
   （更稳的做法是设成 Worker Secret：Settings → Variables and Secrets → 加
     GD_CLIENT_ID / GD_CLIENT_SECRET。设了的话下面这两个常量就会被忽略。）
   v9.82：真实值已从代码移除，只从 Cloudflare Secret 读（GitHub 上不再有 secret）。
   ⚠️ 必须在 Cloudflare 设好 GD_CLIENT_ID / GD_CLIENT_SECRET，否则 Google Drive 备份会停。 */
const GD_CLIENT_ID_DEFAULT = "";     // v9.82 已清空 → 去 Cloudflare Secret 设 GD_CLIENT_ID
const GD_CLIENT_SECRET_DEFAULT = ""; // v9.82 已清空 → 去 Cloudflare Secret 设 GD_CLIENT_SECRET
const gdId  = (env) => env.GD_CLIENT_ID     || GD_CLIENT_ID_DEFAULT;
const gdSec = (env) => env.GD_CLIENT_SECRET || GD_CLIENT_SECRET_DEFAULT;

async function gdState(env) {
  const row = await env.DB.prepare("SELECT v FROM app_settings WHERE k='gdrive'").first();
  if (!row) return {};
  try { return JSON.parse(row.v) || {}; } catch (e) { return {}; }
}
async function gdSave(env, obj) {
  await putSetting(env, "gdrive", JSON.stringify(obj));
}

/* 用 refresh_token 换一个新的 access_token（每次备份前做一次） */
async function gdAccessToken(env) {
  const st = await gdState(env);
  if (!st.refresh_token) throw new Error("Drive 还没授权");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: gdId(env),
      client_secret: gdSec(env),
      refresh_token: st.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const j = await r.json();
  if (!j.access_token) {
    // token 失效（多半是测试模式 7 天过期 / 被撤销）→ 记下来，让前端显示「需要重新连接」，不再静默做废
    st.last_error = j.error || "refresh_failed";
    st.last_error_at = new Date().toISOString();
    await gdSave(env, st);
    throw new Error("刷新 token 失败: " + JSON.stringify(j).slice(0, 200));
  }
  return j.access_token;
}

/* 把整个库打包成备份 JSON（跟前端「导出 JSON」的格式一模一样，可以互相恢复） */
async function buildBackup(env) {
  const ex = await env.DB.prepare(
    "SELECT id, ts, amount, currency, merchant, card_last4, source, raw, hash, category, sub, COALESCE(type,'expense') AS type FROM expenses ORDER BY ts DESC"
  ).all();
  const rl = await env.DB.prepare("SELECT merchant_key, category, display, sub, is_hint FROM merchant_rules").all();
  const rules = {};
  (rl.results || []).forEach((x) => { rules[x.merchant_key] = { c: x.category, d: x.display || null, s: x.sub || null, h: x.is_hint ? 1 : 0 }; });
  const cs = await env.DB.prepare("SELECT v FROM app_settings WHERE k='categories'").first();
  let categories = null;
  if (cs) { try { categories = JSON.parse(cs.v); } catch (e) {} }
  let events = [];
  try {   /* v6.9 事项也要备份。用 try 包着：万一迁移还没跑到，别让整个备份挂掉 */
    /* ⚠️ v9.1 备份只含**你自己建的**。Google 来的是快取（本尊在 Google，重连就回来），
             塞进备份只会让档案白白变大，还原时还可能跟当下的同步打架。 */
          const ev = await env.DB.prepare("SELECT id, day, time, title, note, end_day, end_time, kind, notify_min, notifs, rep_type, rep_int, rep_days, rep_until, rep_ex, rep_mod, color FROM events WHERE src IS NULL ORDER BY day").all();
    events = ev.results || [];
  } catch (e) { console.log("backup events skip:", e.message); }
  /* ⚠️ v10.4 收件箱进备份。以前完全没备份 → 保留一开，满一年的邮件是**真的没了**。
     为什么不无脑整包丢进来：`inbox.raw` 存的是截断到 8000 字的邮件原文（HTML），
     一个月上百封就是 1–2MB，13 个月 = 15–30MB。这份 JSON 是在 Worker 记忆体里
     `JSON.stringify(..., null, 2)` 整个拼出来的（128MB 上限），塞得下但很浪费，
     而且每月要往 Drive 推一份几十 MB 的档。

     所以按「丢了救不救得回来」分两级：
       · unparsed（读不到的）→ **留完整 raw**。这种没有对应的 expenses 行，
         raw 就是它唯一的存在证明，丢了就是丢一笔账。数量少，留得起。
       · parsed（已经记成账的）→ **不留 raw，只留元资料**（时间/寄件人/标题/摘要/hashes）。
         钱的部分早就在 expenses 里了；summary 写着「SGD 12.30 · 商家」，
         hashes 还能对回是哪几笔。丢的只是原始 HTML，不影响任何数字。

     ⚠️ 顺带更正一个容易搞错的地方：`expenses.raw` **不是**邮件原文，
     它是 `"DBS 12345"` 这种几十字节的来源标记（见各 parser 的 raw 栏）。
     完整原文从头到尾只存在 inbox.raw 这一处。 */
  let inbox = [];
  try {
    const ib = await env.DB.prepare(
      "SELECT id, ts, sender, subject, raw, status, kind, summary, hashes FROM inbox ORDER BY ts DESC"
    ).all();
    let rawBudget = 8 * 1024 * 1024;   // 未解析原文的总量上限 8MB，防呆用，正常远远用不到
    inbox = (ib.results || []).map((r) => {
      const o = { id: r.id, ts: r.ts, sender: r.sender, subject: r.subject,
                  status: r.status, kind: r.kind, summary: r.summary, hashes: r.hashes };
      if (r.kind !== "parsed" && r.raw) {
        if (rawBudget - r.raw.length >= 0) { o.raw = r.raw; rawBudget -= r.raw.length; }
        else o.raw_omitted = 1;         // 真的爆了才标记，还原时看得出来这封的原文没带到
      }
      return o;
    });
  } catch (e) { console.log("backup inbox skip:", e.message); }
  return {
    app: "expenses", version: 3, exportedAt: new Date().toISOString(), by: "worker-cron",
    expenses: ex.results || [], rules, categories, events, inbox,
  };
}

/* 找（或建）「expense json」这个资料夹。
   注意：scope 是 drive.file，所以搜索只看得到**这个 app 自己建的**东西 —— 
   你 Drive 里别的同名资料夹它看不见，也碰不到。 */
async function gdFolder(env, token, st) {
  const H = { Authorization: "Bearer " + token };

  // 已经记过 folder_id → 确认它还在（没被丢进垃圾桶）
  if (st.folder_id) {
    const chk = await fetch(
      `https://www.googleapis.com/drive/v3/files/${st.folder_id}?fields=id,trashed`, { headers: H });
    if (chk.ok) {
      const j = await chk.json();
      if (!j.trashed) return st.folder_id;
    }
    console.log("folder gone, recreating");
    st.folder_id = null;
  }

  // 搜一下（可能上次建过但没记住）
  const q = encodeURIComponent(
    `name='${GD_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const sr = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`, { headers: H });
  if (sr.ok) {
    const j = await sr.json();
    if (j.files && j.files.length) { st.folder_id = j.files[0].id; return st.folder_id; }
  }

  // 建一个
  const cr = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ name: GD_FOLDER, mimeType: "application/vnd.google-apps.folder" }),
  });
  const cj = await cr.json();
  if (!cj.id) throw new Error("建资料夹失败: " + JSON.stringify(cj).slice(0, 200));
  st.folder_id = cj.id;
  return cj.id;
}

/* 传上 Drive。
   第一次：在「expense json」资料夹里建档，记住 file_id。
   以后：一律 PATCH 覆盖同一个 file_id → **资料夹里永远只有一个档，不会越存越多**。 */
/* v6.7：任何备份失败都记进 last_error，前端才好显示「⚠️ 连接失效」。
   以前只有「刷新 token 失败」会记 → Drive API 没启用这类 403 会被静默吞掉，
   状态还显示「已连接」，用户以为好的（曾经中过这个）。 */
async function gdBackup(env) {
  try {
    return await gdBackupRun(env);
  } catch (e) {
    try {
      const st = await gdState(env);
      if (st.refresh_token) {
        st.last_error = (e && e.message ? e.message : String(e)).slice(0, 300);
        st.last_error_at = new Date().toISOString();
        await gdSave(env, st);
      }
    } catch (_) { /* 记录失败也不能盖掉原本的错误 */ }
    throw e;
  }
}

async function gdBackupRun(env) {
  const token = await gdAccessToken(env);
  const st = await gdState(env);
  const body = JSON.stringify(await buildBackup(env), null, 2);
  const H = { Authorization: "Bearer " + token };

  const folderId = await gdFolder(env, token, st);

  // 已经有 file_id → 直接覆盖（内容整个换掉，档名/位置都不变）
  if (st.file_id) {
    const r = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${st.file_id}?uploadType=media`,
      { method: "PATCH", headers: { ...H, "Content-Type": "application/json" }, body }
    );
    if (r.ok) {
      st.last_backup = new Date().toISOString();
      st.last_size = body.length;
      delete st.last_error; delete st.last_error_at;
      await gdSave(env, st);
      return { ok: true, mode: "overwrite", folder: GD_FOLDER, file_id: st.file_id, size: body.length };
    }
    console.log("drive update failed, will recreate:", r.status);   // 档被手动删了 → 掉下去重建
    st.file_id = null;
  }

  // 没有档（或档没了）→ 在资料夹里建一个
  const boundary = "----expenses" + crypto.randomUUID();
  const meta = JSON.stringify({ name: GD_FILENAME, mimeType: "application/json", parents: [folderId] });
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  const r2 = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
    method: "POST",
    headers: { ...H, "Content-Type": `multipart/related; boundary=${boundary}` },
    body: multipart,
  });
  const j2 = await r2.json();
  if (!j2.id) throw new Error("建档失败: " + JSON.stringify(j2).slice(0, 200));
  st.file_id = j2.id;
  st.last_backup = new Date().toISOString();
  st.last_size = body.length;
  delete st.last_error; delete st.last_error_at;
  await gdSave(env, st);
  return { ok: true, mode: "create", folder: GD_FOLDER, file_id: j2.id, size: body.length };
}

export default {
  /* ---------------- 定时任务（Cron）----------------
     在 dashboard 里配：Workers → expenses → Settings → Triggers → Cron Triggers
     加一条： 0 18 1 * *      ← 每月 1 号 UTC 18:00 = 新加坡时间 2 号 02:00
     不需要你开 app，Worker 自己会跑。 */
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      /* ⚠️ v8.7 起 cron 每 5 分钟跑一次（为了提醒），但备份只该每月 1 号做一次。
         所以这里要分开：推送每次都扫；备份只在 1 号的第一个小时跑。
         cron 跑在 Cloudflare 的机器上，跟用户手机的电池完全无关。 */
      try { await ensureSchema(env); } catch (e) { console.log("cron schema:", e.message); }

      // ① 提醒：每次都扫
      try {
        if (env.VAPID_PUBLIC && env.VAPID_PRIVATE) {
          const now = Date.now();
          const lastRow = await env.DB.prepare("SELECT v FROM app_settings WHERE k='push_last'").first();
          const last = lastRow ? Number(lastRow.v) : 0;
          // 上次扫到现在 = 窗口 → cron 漏跑也补得回来；但最多只往回看 30 分钟，不翻旧帐洗版
          const from = Math.max(last || now - 6 * 60000, now - 30 * 60000);
          const items = await dueReminders(env, from, now);
          if (items.length) {
            const r = await pushAll(env);
            console.log(`cron push: ${items.length} due → ${JSON.stringify(r)}`);
          }
          await putSetting(env, "push_last", String(now));
        }
      } catch (e) { console.log("cron push FAILED:", e.message); }

      /* ② 备份：一个月一次。
         判断法：「这个月做过了没」——做过就跳过，没做过就做。
         ⚠️ 不用「1 号 00 点那一小时」当条件：那样万一 Cloudflare 那一小时漏跑，
            这个月就整个没备份了。现在是「这个月的第一次 cron」就做 →
            正常情况就是 1 号 00:00；真的漏了，1 号 00:05 补、甚至 2 号补，
            一个月还是只会做一次（靠 backup_month 标记挡）。
         cron 每 5 分钟一次 = 一个月约 8640 次，其中只有 1 次会真的备份。 */
      try {
        const sgt = new Date(Date.now() + 8 * 3600 * 1000);
        const ym = sgt.toISOString().slice(0, 7);      // SGT 的「哪一年哪一月」
        const doneRow = await env.DB.prepare("SELECT v FROM app_settings WHERE k='backup_month'").first();
        if (!doneRow || doneRow.v !== ym) {
          /* ⚠️ v10.4 顺序修正：原本 purgeInbox 在 gdBackup **之前**。
             备份是「覆盖同一个 Drive 档」，所以那样等于：先把满一年的邮件删掉，
             再把删完的状态覆盖上去 → 那些邮件不但不在这一份里，连上一份也被盖掉了 = 永远没有备份。
             现在一律「先备份、成功了再删」，跟 purgeExpenses 同一条规矩。 */
          const r = await gdBackup(env);
          await putSetting(env, "backup_month", ym);   // 先备份成功才标记；失败下次 cron 会再试
          await purgeExpenses(env, true);               // v9.97：备份成功后才修剪旧账（删掉的都在这份刚做好的备份里）
          await purgeInbox(env, true);                  // v10.4：邮件同样等备份成功后才删
          console.log("cron backup ok:", JSON.stringify(r));
        }
      } catch (e) {
        console.log("cron backup FAILED:", e.message);
      }

      /* ③ v9.11 周报：每周一早 8 点 SGT 一次。
         ⚠️ 不加新 cron —— 挂在这个现成的「每 5 分钟」cron 上，照抄②备份的「守卫标记」法：
         周一、SGT ≥ 08:00、且 weekly_report_week 标记 ≠ 本周一 → 推一次、打标记。
         正常就是周一 08:00~08:05 那一格 cron 推出去；漏跑就下一格补；靠标记保证一周只一次。
         只有用户在设置里开了 weekly_report=1 才推。纯读 expenses 算汇总，绝不写账。 */
      try {
        const onRow = await env.DB.prepare("SELECT v FROM app_settings WHERE k='weekly_report'").first();
        if (onRow && onRow.v === "1") {
          const sgt = new Date(Date.now() + 8 * 3600000);
          if (sgt.getUTCDay() === 1 && sgt.getUTCHours() >= 8) {     // 周一、≥08:00 SGT
            const weekId = sgt.toISOString().slice(0, 10);           // 本周一那天当标记
            const done = await env.DB.prepare("SELECT v FROM app_settings WHERE k='weekly_report_week'").first();
            if (!done || done.v !== weekId) {
              const dg = await weeklyDigest(env);
              /* v10.27 记下这次推送的结果 → 自检里可以看「上一次早报推成功了吗」（使用者反馈：这周没收到，想在自检里看到）。
                 kind=cron 区分真周报 / test；hasData=false 表示上周没花钱→本来就不推（正常）；ok=收到的设备数，gone=失效被清掉的订阅数。 */
              const wl = { at: sgIso(), week: weekId, kind: "cron", hasData: !!dg.hasData };
              if (dg.hasData) {
                const catMap = await catNameMap(env);
                await putSetting(env, "weekly_pending", JSON.stringify({ title: "花费 · 上周速览", body: weeklyBody(dg, catMap) }));
                if (env.VAPID_PUBLIC && env.VAPID_PRIVATE) { const r = await pushAll(env); console.log("cron weekly push:", JSON.stringify(r)); wl.subs = r.subs; wl.ok = r.ok; wl.gone = r.gone; wl.codes = r.codes; wl.reason = r.reason; }
                else wl.nokey = true;   // 服务器没配 VAPID 密钥 → 根本发不出
              }
              await putSetting(env, "weekly_last", JSON.stringify(wl));
              await putSetting(env, "weekly_report_week", weekId);   // 就算没数据也打标，避免这周反复算
            }
          }
        }
      } catch (e) { console.log("cron weekly FAILED:", e.message); }

      /* ④ v9.16 每日体检：一天一次（守卫标记 health_day），**只在发现「静默会坏」的问题时**推你一条。
         走现有 5 分钟 cron，不加新 cron；正常一声不吭。app 打开时会用 /api/health 自己重算一遍显示。 */
      try {
        const sgt = new Date(Date.now() + 8 * 3600000);
        const dayId = sgt.toISOString().slice(0, 10);
        const done = await env.DB.prepare("SELECT v FROM app_settings WHERE k='health_day'").first();
        if (!done || done.v !== dayId) {
          const issues = [];
          try { const gd = await env.DB.prepare("SELECT v FROM app_settings WHERE k='gdrive'").first();
            if (gd) { const j = JSON.parse(gd.v);
              if (j && j.refresh_token && j.last_backup) {
                const age = (Date.now() - new Date(j.last_backup).getTime()) / 86400000;
                if (age > 35) issues.push(`备份已 ${Math.round(age)} 天没成功`);
              }
            }
          } catch (e) {}
          try { const sv = await env.DB.prepare("SELECT v FROM app_settings WHERE k='schema_version'").first();
            if (sv && parseInt(sv.v, 10) !== SCHEMA_VERSION) issues.push(`数据结构版本不对（${sv.v}≠${SCHEMA_VERSION}）`);
          } catch (e) {}
          try { const wr = await env.DB.prepare("SELECT v FROM app_settings WHERE k='weekly_report'").first();
            const ps = await env.DB.prepare("SELECT COUNT(*) n FROM push_subs").first();
            if (wr && wr.v === "1" && ps && ps.n === 0) issues.push("开了周报但没订阅通知（收不到）");
          } catch (e) {}
          if (issues.length && env.VAPID_PUBLIC && env.VAPID_PRIVATE) {
            await putSetting(env, "health_push", JSON.stringify({ title: "⚠️ 系统体检", body: issues.join(" · ") + "，打开 App 看设置 · 系统自检" }));
            await pushAll(env);
          }
          await putSetting(env, "health_day", dayId);
        }
      } catch (e) { console.log("cron health FAILED:", e.message); }

      /* ⑤ v9.99 一次性回填 inbox.hashes：把「已记录」但还没存 hash 的旧邮件重新解析出 hash，
         让删账时也能连到旧邮件一起删。每次 cron 处理一批（150 封），全部回填完 WHERE 就选不到、自动停。
         纯解析、绝不写账（用 parseRaw，不是 ingestRaw）。解析不出来的标 "-"，免得每轮重试同一封。 */
      try {
        const batch = await env.DB.prepare(
          "SELECT id, sender, raw FROM inbox WHERE kind='parsed' AND (hashes IS NULL OR hashes='') LIMIT 150").all();
        let n = 0;
        for (const row of (batch.results || [])) {
          let hs = "-";
          try { const list = hashList(parseRaw(row.raw || "", row.sender || "")); if (list) hs = list; } catch (e) {}
          await env.DB.prepare("UPDATE inbox SET hashes=? WHERE id=?").bind(hs, row.id).run();
          n++;
        }
        if (n) console.log("backfilled inbox hashes:", n);
      } catch (e) { console.log("hash backfill FAILED:", e.message); }
    })());
  },

  /* ---------------- 邮件入口 ---------------- */
  async email(message, env, ctx) {
    /* ═══ v10.13 最外层保险（这一整支以前**完全没有 try/catch**）═══
       Cloudflare Email Worker 的规矩：`email()` 一旦抛出未捕捉的错误，这封信就会被**拒收**，
       寄件人（＝你的 Gmail 自动转发）收到一封「Message blocked」退信 —— 而账这边什么都没有。
       以前只要 ensureSchema / D1 / 任何一支 parser 抛错，就是这个下场。
       现在：出错先尽最大努力把这封信塞进收件箱「读不到」，你至少看得见、还能按「重新识别」；
       连塞都塞不进去（D1 整个挂了）才把错误抛回去 —— 那时候退信反而是对的，
       因为静默吞掉才是最糟的（地基那条：绝不静默丢账）。 */
    let rawFull = "", from = "", subject = "", text = "";
    try {
    await ensureSchema(env);
    rawFull = await streamToText(message.raw);
    from = (message.from || "").toLowerCase();
    /* ⚠️⚠️ v10.12 这三行是这一轮的核心（下面整条分流链一个字都没动，只是喂进去的东西换了）：
       以前喂的是**整封 MIME 原文**（信头 + 可能是 base64 的正文）——
         · 信头排在正文前面 → 松正则先咬到信头（参考号抓成 "erences"，全部互撞 → 假重复）
         · 正文是 base64 时根本读不出金额 → 掉进「读不到」，还把信头当原文给你看（乱码）
       现在喂的是抽出来的可读正文；抽不动就原样退回原文，所以**绝不会比以前差**。
       标题单独接在前面：像「PayNow transfer made」这种关键词常常只在标题里，
       而标题没有数字/日期，不会污染金额、日期、参考号那几条正则。 */
    subject = decodeMimeWords((message.headers && message.headers.get("subject")) || "");
    text = mailText(rawFull);
    const raw = (subject ? subject + "\n" : "") + text;
    let rows = [];
    /* v10.10 NETS QR 放**第一位**：这封信正文里有 "OCBC"、页尾还可能有 "PayNow"，
       排在后面会被那两条分支先抢走（v9.93 踩过一模一样的坑：页尾一句 top up with PayNow
       就把整封卡消费信劫进 PayNow 分支）。isNetsQR 要求两个 NETS 专属字串同时出现，
       够窄，抢不到别人的信；放第一位则保证没人抢得走它。 */
    /* ⚠️⚠️ v10.13 这条链以前也是一串 `else if` = **认领即独占**，跟 parseRaw v10.13 修的是同一个病。
       实测（照片二那封 NETS 通知，表格排版把冒号放在值那一行）：`isNetsQR` 认领 → `parseNETS` 抓不到
       → 回 [] → **直接判死进「读不到」**，后面的 PayNow / OCBC 一支都没机会试。
       现在改成「门开了就试，抓不到就继续往下试」。顺序一个字没动，只会多认出账。
       ⚠️ 这条链**刻意不含**三支截图 parser（parsePayLahShot / parseTnGShot / parseMaybankShot）——
       parsePayLahShot 抓商家是 `You paid (.+)`，邮件里 "You paid" 常常自己一行 → 商家变空 →
       退回通用名，比 parseDBS 读 `To :` 差。截图那三支只在 parseRaw 那条链上。 */
    const chain = [
      [() => /DBS|digibank|POSB/i.test(raw) && /received\s+[A-Z]{3}\s*[\d,]+\.\d{2}\s+via\s+PayNow/i.test(raw), () => parseDBSPayNowIn(raw)],
      [() => isNetsQR(raw), () => parseNETS(raw)],
      [() => isPayNowTransfer(raw), () => parsePayNow(raw)],
      [() => /MariBank/i.test(raw) && (/received\s+a\s+refund/i.test(raw) || /Refunded\s*Amount/i.test(raw)), () => parseMariBankRefund(raw)],
      [() => /MariBank/i.test(raw) || from.includes("maribank"), () => parseMariBank(raw)],
      [() => /PayLah/i.test(raw) && /refund\s+transaction/i.test(raw), () => parsePayLahRefund(raw)],
      [() => raw.includes("PayLah") || from.includes("dbs"), () => parseDBS(raw)],
      [() => raw.includes("OCBC") && /deposit\s+(?:was\s+made|in\s+your\s+account)/i.test(raw), () => parseOCBCRefund(raw)],
      [() => raw.includes("OCBC") && /withdrawal\s+made|withdrawn\s+from\s+your\s+account/i.test(raw), () => parseOCBCWithdrawal(raw)],
      [() => raw.includes("OCBC") || from.includes("ocbc"), () => parseOCBC(raw)],
    ];
    for (const [hit, run] of chain) {
      let ok = false;
      try { ok = !!hit(); } catch (e) { ok = false; }
      if (!ok) continue;
      let r = [];
      try { r = /** @type {any} */ (run() || []); } catch (e) { console.log("parser threw:", e && e.message); r = []; }
      if (r.length) { rows = r; break; }
    }
    rows = dedupeRows(rows);   // v10.13 同封信内指纹重复的（plain + html 两份）先收干净，见 dedupeRows

    /* v6.0：**每一封**转发进来的邮件都存进 inbox（不再只存解析失败的）。
       你转的不只是消费提醒 —— 还有对账单、通知之类。现在全部都有记录，
       app 里分两个 tab：「已记录」= 读懂并且记了账的；「读不到」= 我没看懂的。 */
    const logMail = async (kind, summary, hashes) => {
      try {
        await env.DB.prepare(
          "INSERT INTO inbox (ts, sender, subject, raw, status, kind, summary, hashes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        /* v10.12 存的是**可读正文**（mailText），不再是整封 MIME。
           收件箱那个原文框以前给你看的是 Received / ARC-Seal 那堆信头 —— 没有任何用处。
           而且现在「你看到的」＝「parser 读到的」，下次再出事，你截的图就是我要查的东西。
           8000 字上限不动：正文比原文短很多，装得下的真内容反而变多了。 */
        ).bind(sgIso(), from, subject, text.slice(0, 8000),
               kind === "parsed" ? "done" : "new", kind, summary || null, hashes || null).run();
      } catch (e) { console.log("inbox insert failed:", e.message); }
      await purgeInbox(env);          // 顺手清掉 3 个月前的
    };

    // 一封都没解析出来
    if (!rows.length) {
      /* v11.05 挡转发回圈的垃圾：**解析不出交易（rows 已空）＋ 又是确定的退信** → 直接丢掉，不进 inbox。
         回圈时会产生一堆 mailer-daemon 退信 / delivery-status，全是垃圾，会灌爆「读不到」。
         ⚠️⚠️ 双保险，为什么绝不会误伤真账：真银行信**一定解析得出金额** → rows 非空 → 根本走不到这个分支；
              就算哪天有封真信没解析出来，它也**绝不会是** mailer-daemon 发的退信 / delivery-status 封装，
              → isBounce=false → 照旧进「读不到」让你看。所以「真金白银的信一封都不会被丢」。 */
      if (isBounce(from, rawFull)) {
        console.log("bounce/DSN dropped (not a bank txn):", from, subject);
        return;   // 静默丢弃系统退信
      }
      // 不是退信但读不懂 → 存进「读不到」，绝不静默丢账（铁律不变）
      await logMail("unparsed", unparsedNote(text));   // v10.13 读不到也把抓得到的重点写在清单上
      console.log("unparsed -> inbox:", from, subject);
      return;
    }

    let saved = 0;
    const notes = [];                 // v10.12 没记成的每一笔，各自写一句为什么
    for (const r of rows) {
      // 自动分类：先查商家记忆表，查不到留空由前端猜
      // v4.0：查商家记忆 —— 分类**和你给它取的名字**都套上
      /** @type {any} */ let category = null;
      /** @type {any} */ let subCat = null;
      try {
        const mk = merchantKey(r.merchant);
        const hit = isGeneric(mk) ? null : await env.DB.prepare(
          "SELECT category, display, sub, is_hint FROM merchant_rules WHERE merchant_key=?").bind(mk).first();
        if (hit) {
          /* ⚠️ v10.20 收入**不套**支出的分类记忆：收入和支出是**两套分开的分类**，商家记忆（merchant_rules）
             只为支出而记（rememberRule 对收入 return，从不写分类）。但同一个对手方可能既退过你钱（收入）
             又被你付过钱（支出）—— 那条支出留下的分类规则**绝不能**倒贴到这次收入上。改名（display）
             照样借用（把银行那串丑名字换成你取的名字，收入也想要），只有 category 挡住。
             （就算不挡，前端 catKey 也会把收入的分类重映到收入分类空间，这里挡住是让**存进库的那格**
             也干净、可测，彻底断掉「收入沾到支出分类」的念想。） */
          if (hit.category && r.type !== "income") category = hit.category;
          if (hit.display) r.merchant = hit.display;   // 银行那串丑名字 → 换成你取的名字
          /* v9.77 sub 只预填不锁：超市这种一家店多种 sub（衣服/包/鞋），进账时**不再自动套**上次的 sub
             —— 否则买包也被标成衣服。分类照锁（category 照常自动套），sub 改成「进账留空、
             你打开编辑时前端才用上次的 sub 当预填提示、随便改」。食物的 sub 仍按时间重算（下面那行）。 */
          /* v9.72 提示型规则（转账给人）：分类照样写进 category 当预填，
             「是提示还是硬规则」由前端读 /api/data 回的 rules[k].h 决定（编辑弹窗的开关默认值）。
             ⚠️ v9.89：这里本来有一行 `r.catIsHint = true` —— r 不会回给任何人、也没写进 expenses，
                全档没有第二个地方读它，是死赋值。删掉，免得下次有人以为后端真的分了两条路。 */
        }
      } catch (e) { console.log("rule lookup:", e.message); }
      if (category === FOOD_KEY) subCat = foodSub(r.ts);   // 餐饮：子分类永远按交易时间重算
      try {
        /* v11.05 type 以前写死 'expense'。现在读 r.type（parser 没设就默认 expense，现有 8 支行为不变；
           只有 parseMariBankRefund 会设 'income'）。用局部变量 rtype 绑，不写成 r.type ——
           这样静态检查器 §11 不会因此要求「每支 parser 都得有 type 栏位」而误报。 */
        const rtype = r.type === "income" ? "income" : "expense";
        const off = rtype === "income" ? await offsetForMerchant(env, r.merchant) : 0;   // v10.19 退款邮件：按这家的记忆自动带上「抵扣支出」
        const res = await env.DB.prepare(
          `INSERT OR IGNORE INTO expenses
           (ts, amount, currency, merchant, card_last4, source, raw, hash, type, category, sub, offset)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(r.ts, r.amount, r.currency, r.merchant, r.card_last4, r.source, r.raw, r.hash, rtype, category, subCat, off).run();
        if (res.meta && res.meta.changes) saved++;
        else notes.push(await skipNote(env, r));                      // v10.12 撞指纹 → 讲清楚撞到哪一笔
      } catch (e) { console.log("insert error", e.message); notes.push(errNote(r, e)); }
    }
    // 读懂了 → 存进「已记录」，并写清楚记了什么
    const summary = sumLine(rows, notes);
    /* v10.12 一笔都没存进去、而且是**抛错**（不是撞指纹）→ 记成「读不到」，红角标提醒你。
       照地基那条：绝不静默丢账 —— 存不进去还标「已记录」，等于骗自己。 */
    const hardFail = saved === 0 && notes.some((n) => n.indexOf("存不进去") >= 0);
    await logMail(hardFail ? "unparsed" : "parsed", summary, hashList(rows));

    console.log(`parsed=${rows.length} saved=${saved} from=${from}`);
    } catch (e) {
      console.log("email() FAILED:", (e && e.message) || e);
      try {
        await env.DB.prepare(
          "INSERT INTO inbox (ts, sender, subject, raw, status, kind, summary) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(sgIso(), from || "?", subject || "（收信时出错）",
               String(text || rawFull || "").slice(0, 8000), "new", "unparsed",
               "⚠️ 收信时程序出错，这封没记账：" + ((e && e.message) || e)).run();
      } catch (e2) {
        console.log("email() 保底写收件箱也失败:", (e2 && e2.message) || e2);
        throw e;   // 连收件箱都进不去 → 让它退信，你会收到 bounce，总好过悄无声息地不见
      }
    }
  },

  /* ---------------- API 入口 ---------------- */
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    try { await ensureSchema(env); }
    catch (e) { return json({ error: "schema migration failed: " + e.message }, 500); }

    const url = new URL(request.url);
    const path = url.pathname;

    /* ⚠️ Google 的 OAuth 回调**不会带我们的 token**（它只带 code + state），
       所以必须放在 token 校验**之前**处理，用 state 来验身份。
       放在后面的话，Google 一回来就被 401 拒掉，永远拿不到 refresh_token。 */
    if (path === "/api/gdrive/callback" && request.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const T = (msg, st) => new Response(msg, { status: st || 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      if (!safeEqual(state, appToken(env))) return T("state 不对，拒绝。", 403);
      if (!code) return T("Google 没给 code：" + (url.searchParams.get("error") || "?"), 400);
      try {
        const r = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: gdId(env),
            client_secret: gdSec(env),
            redirect_uri: url.origin + "/api/gdrive/callback",
            grant_type: "authorization_code",
          }),
        });
        const j = await r.json();
        if (!j.refresh_token) {
          return T("没拿到 refresh_token。多半是这个 Google 帐号之前已经授权过这个 app 了 —— " +
            "去 https://myaccount.google.com/permissions 把它移除，再重新授权一次。\n\n" +
            JSON.stringify(j).slice(0, 300), 400);
        }
        const st = await gdState(env);
        st.refresh_token = j.refresh_token;
        await gdSave(env, st);
        let extra = "";
        try { const b = await gdBackup(env); extra = `\n\n已经立刻备份了一份到「${GD_FOLDER}」资料夹（${b.size} 字节）。`; }
        catch (e) { extra = "\n\n（授权成功，但第一次备份失败：" + e.message + "）"; }
        return T(`✅ Google Drive 连好了！\n以后每月 1 号 Worker 会自己备份到「${GD_FOLDER}」资料夹，\n永远覆盖同一个档，不会越存越多。` + extra +
                 "\n\n可以关掉这个页面，回 app 了。");
      } catch (e) {
        return T("授权失败: " + e.message, 500);
      }
    }

    // token 校验（GET/DELETE 从 query，POST 从 body）
    let body = {};
    if (request.method === "POST") {
      /* v9.29 捷径记账：/api/paste 额外允许直接 POST **纯文字**（Content-Type 不是 JSON 时），
         token 走 URL query ?token=xxx。
         为什么：iOS 捷径的「Get Contents of URL」建 JSON body 要一格一格加 key，手机上极难操作；
         Request Body 选「File」直接丢文字变量就一步到位。原本的 JSON 形式完全不受影响。 */
      const ct = (request.headers.get("content-type") || "").toLowerCase();
      if (path === "/api/paste" && !ct.includes("json")) {
        try { body = { text: await request.text() }; } catch (e) { return json({ error: "bad body" }, 400); }
      } else {
        try { body = await request.json(); } catch (e) { return json({ error: "bad json" }, 400); }
        if (!body || typeof body !== "object") return json({ error: "bad json" }, 400);
      }
    }
    const token = body.token || url.searchParams.get("token");
    /* v10.7 修「门开着」：safeEqual("","")===true → 没设 APP_TOKEN 时空 token 会通过，整个 DB 全世界可读写。
       token 校验前先挡：没设 APP_TOKEN 一律 503，逼你先设好再用。
       （DEMO 是纯前端不打 worker，不受影响；gdrive/callback 在此门之前=公开，也不受影响。） */
    const _want = appToken(env);
    if (!_want) return json({ error: "APP_TOKEN not set — refusing all requests until a token is configured" }, 503);
    if (!safeEqual(token, _want)) return json({ error: "unauthorized" }, 401);

    try {
      /* ---- 读全部数据 + 商家规则 ---- */
      if (path === "/api/data" && request.method === "GET") {
        /* ⚠️ v9.94 SELECT 里拿掉了 `raw`。
           验证过：整个前端**从头到尾没读过 expenses.raw**（全档只有三处 .raw，
           两处是收件箱的 it.raw、一处是搜寻快取的 _qc.raw，都是别的东西）。
           18000 笔实测 raw 占回应体积 17% → 4.03MB 降到约 3.35MB，前端一行都不用改。
           ⚠️ 别顺手把 /api/import 和导出那边的 raw 也拿掉，那两个是备份用的，要留原文。 */
        /* v10.1 分月加载：since=只拉这天起（开机先拉最近几个月，小、快，把频宽让给背景照片）；
           before=只拉这天之前（背景补历史那一发）；两者都没有=整包（手动重载 / 备份走这条，向后相容）。
           ts 是 "YYYY-MM-DDT...+08:00"，跟 "YYYY-MM-01" 做字符串比较是正确的。 */
        const since = url.searchParams.get("since");
        const before = url.searchParams.get("before");
        const cols = "SELECT id, ts, amount, currency, merchant, card_last4, source, category, sub, COALESCE(type,'expense') AS type, COALESCE(offset,0) AS offset FROM expenses";   // v10.19 offset：退款抵扣支出旗标
        let ex;
        if (since)       ex = await env.DB.prepare(cols + " WHERE ts >= ? ORDER BY ts DESC").bind(since).all();
        else if (before) ex = await env.DB.prepare(cols + " WHERE ts <  ? ORDER BY ts DESC").bind(before).all();
        else             ex = await env.DB.prepare(cols + " ORDER BY ts DESC").all();
        /* 规则只在第一发（since / 整包）给；背景补历史那发（before）不用再传一次 */
        let rules = {};
        if (!before) {
          const rl = await env.DB.prepare("SELECT merchant_key, category, display, sub, is_hint FROM merchant_rules").all();
          (rl.results || []).forEach((x) => { rules[x.merchant_key] = { c: x.category, d: x.display || null, s: x.sub || null, h: x.is_hint ? 1 : 0 }; });
          // v10.19 商家「默认抵扣」记忆：合进同一个 rules 物件的 .o（前端预填 offset 开关用）
          const orl = await env.DB.prepare("SELECT merchant_key, offset FROM offset_rules WHERE offset=1").all();
          (orl.results || []).forEach((x) => { rules[x.merchant_key] = Object.assign(rules[x.merchant_key] || {}, { o: 1 }); });
        }
        return json({ expenses: ex.results || [], rules });
      }

      /* ---- 新增一笔（手动记账）---- */
      if (path === "/api/expense" && request.method === "POST") {
        const { ts, amount, currency, merchant, card_last4, source, type, category, sub, raw } = body;
        const amt = Number(amount);
        if (!ts) return json({ error: "ts required" }, 400);
        if (!Number.isFinite(amt)) return json({ error: "amount must be a number" }, 400);
        const kind = type === "income" ? "income" : "expense";
        const off = (kind === "income" && body.offset) ? 1 : 0;   // v10.19 只有收入能抵扣支出；支出恒 0
        const hash = "manual:" + ts + ":" + amt + ":" + crypto.randomUUID();
        const res = await env.DB.prepare(
          `INSERT INTO expenses (ts, amount, currency, merchant, card_last4, source, raw, hash, type, category, sub, offset)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(ts, amt, currency || "SGD", merchant || null, card_last4 || null, source || "manual",
               raw || "", hash, kind, category || null, sub || null, off).run();
        return json({ id: res.meta && res.meta.last_row_id });
      }

      /* ---- 整笔更新（改金额/分类/币种/备注/日期/类型）---- */
      if (path === "/api/update" && request.method === "POST") {
        const { id, amount, currency, category, sub, merchant, type, ts, orig_merchant, isPerson, lockPerson } = body;
        if (!id) return json({ error: "id required" }, 400);
        const amt = Number(amount);
        if (!Number.isFinite(amt)) return json({ error: "amount must be a number" }, 400);
        const kind = type === "income" ? "income" : "expense";
        const off = (kind === "income" && body.offset) ? 1 : 0;   // v10.19 支出恒 0；改成支出时 offset 自动清 0
        const res = await env.DB.prepare(
          "UPDATE expenses SET amount=?, currency=?, category=?, sub=?, merchant=?, type=?, ts=?, offset=? WHERE id=?"
        ).bind(amt, currency || "SGD", category || null, sub || null, merchant || null, kind, ts, off, id).run();
        if (!res.meta || !res.meta.changes) return json({ error: "not found" }, 404);
        /* v9.19 手动记录改付款方式：只有客户端明确发来 card_last4 才动它（现金=null / 'PayLah' / 卡号）。
           不发就不碰 → 银行邮件那些原本的卡号不受影响、向后兼容。 */
        if (Object.prototype.hasOwnProperty.call(body, "card_last4")) {
          await env.DB.prepare("UPDATE expenses SET card_last4=? WHERE id=?").bind(body.card_last4 || null, id).run();
        }
        await rememberRule(env, kind, merchant, category, orig_merchant, sub, { isPerson: !!isPerson, lockPerson: !!lockPerson, offset: off });
        return json({ ok: true });
      }

      /* ---- 删除 ---- */
      if (path === "/api/expense" && request.method === "DELETE") {
        const id = url.searchParams.get("id");
        if (!id) return json({ error: "id required" }, 400);
        const exp = await env.DB.prepare("SELECT hash FROM expenses WHERE id=?").bind(id).first();   // v9.99 删前先拿 hash
        await env.DB.prepare("DELETE FROM expenses WHERE id=?").bind(id).run();
        if (exp && exp.hash) await deleteSourceEmail(env, exp.hash);   // v9.99 连它的来源邮件一起删（sync）
        return json({ ok: true });
      }

      /* ============ v1.8 新增：主题设置 + 背景图（存 D1，不再存手机）============ */

      /* 读设置：GET /api/settings?token=
         回 { prefs:{theme,tp}|null, bgver:"2026-07-13 06:30:00"|null }
         注意：不回 base64，图走 /api/bg，不然每次开 app 都要拉几百 KB */
      if (path === "/api/settings" && request.method === "GET") {
        const rs = await env.DB.prepare(
          "SELECT k, v, updated_at FROM app_settings WHERE k IN ('theme_prefs','bg','categories','recurring','budgets','sub_ignore','weekly_report','pay_methods','pay_names')"
        ).all();
        let prefs = null, bgver = null, cats = null, rec = [], budgets = null, subignore = [], weekly = false, paymethods = [], paynames = {};
        (rs.results || []).forEach((row) => {
          if (row.k === "theme_prefs") { try { prefs = JSON.parse(row.v); } catch (e) {} }
          if (row.k === "categories") { try { cats = JSON.parse(row.v); } catch (e) {} }
          if (row.k === "recurring") { try { rec = JSON.parse(row.v) || []; } catch (e) {} }
          if (row.k === "budgets") { try { budgets = JSON.parse(row.v); } catch (e) {} }
          if (row.k === "sub_ignore") { try { subignore = JSON.parse(row.v) || []; } catch (e) {} }
          if (row.k === "weekly_report") { weekly = row.v === "1"; }
          if (row.k === "pay_methods") { try { paymethods = JSON.parse(row.v) || []; } catch (e) {} }
          if (row.k === "pay_names") { try { paynames = JSON.parse(row.v) || {}; } catch (e) {} }
          if (row.k === "bg" && row.v) bgver = row.updated_at;
        });
        return json({ prefs, bgver, cats, rec, budgets, subignore, weekly, paymethods, paynames });
      }

      /* ---- v6.9 日历事项（要做的事） ---- */
      if (path === "/api/events" && request.method === "GET") {
        const rs = await env.DB.prepare(
          "SELECT id, day, time, title, note, end_day, end_time, kind, notify_min, notifs, rep_type, rep_int, rep_days, rep_until, rep_ex, rep_mod, src, url, loc, cal_id, color FROM events ORDER BY day, COALESCE(time,'00:00')"
        ).all();
        const events = (rs.results || []).map((x) => ({
          id: x.id, day: x.day, time: x.time || null,
          title: x.title,
          /* v9.1 Google 来的不送 note —— Zoom 那坨样板占一笔的 56%，而且你只有点开才会看。
             要看 → /api/gcal/detail。（Cloudflare 会 gzip，其实差不多，但少解析一点总是好的） */
          note: (x.src === "gcal" || x.src === "ics") ? null : (x.note || null),
          src: x.src || null,                 // null = 你自己建的 · 'gcal' = Google 来的（只读）
          url: x.url || null,                 // 会议链接
          loc: x.loc || null,                 // 地点
          cal: x.cal_id || null,
          color: x.color || null,          // v9.89 自选颜色；null = 照旧按 id hash 自动配色
          end: x.end_day || null,          // v7.5 跨天：null = 就一天
          etime: x.end_time || null,       // v7.9 结束时间：null = 全天
          kind: x.kind || "event",         // v8.4 event = 不通知 · reminder = 要通知
          nmin: x.notify_min == null ? null : x.notify_min,   // 提前几分钟通知（旧栏位，留着兜底）
          nl: nlRead(x.notifs, x.notify_min),                 // v9.0 多重提醒：[1440,30]；旧资料自动退回 notify_min
          // v8.5 重复规则（只存规则，occurrence 由前端现算）
          rep: x.rep_type ? {
            t: x.rep_type,
            i: x.rep_int || 1,
            d: x.rep_days ? String(x.rep_days).split(",").filter(Boolean).map(Number) : null,
            until: x.rep_until || null,
            ex: x.rep_ex ? String(x.rep_ex).split(",").filter(Boolean) : null,   // v8.6 例外日
            mod: modRead(x.rep_mod),                                            // v9.0「只改这一次」
          } : null,
        }));
        return json({ events });
      }

      if (path === "/api/event" && request.method === "POST") {
        const day = String(body.day || "").slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: "day 格式要 YYYY-MM-DD" }, 400);
        const title = String(body.title || "").trim();
        if (!title) return json({ error: "标题不能空" }, 400);
        const hm = (v) => (v && /^\d{2}:\d{2}$/.test(String(v)) ? String(v) : null);
        let time = hm(body.time);          // null = 全天
        let etime = hm(body.etime);
        const note = body.note != null && String(body.note).trim() ? String(body.note).trim() : null;
        // v7.5 跨天：end_day 只在「真的比 day 晚」时才存，否则一律 null（= 就一天）
        let end = /^\d{4}-\d{2}-\d{2}$/.test(String(body.end || "")) ? String(body.end) : null;
        if (end && end <= day) end = null;
        // v7.9 全天 = 没有开始时间。没开始时间就不该有结束时间。
        if (!time) etime = null;
        // 同一天里结束不能早于等于开始 → 当成没填（前端也会挡，这里是最后一道）
        // ⚠️ `time &&` 是补上去的：上面那行 `if (!time) etime = null` 已经保证 time 是 null 时
        //    etime 也是 null（短路挡住了），所以行为完全没变。但那个依赖只有读过上一行才知道，
        //    TS 也看不懂（TS18047: 'time' is possibly 'null'）。写出来对人对机器都清楚。
        if (time && etime && !end && etime <= time) etime = null;
        // v8.4 event（默认）= 只是记录，不通知 · reminder = 要通知
        const kind = body.kind === "reminder" ? "reminder" : "event";
        // 提前几分钟通知；只有 reminder 才存。event 一律 null，免得留脏资料
        /** @type {any} */ let nmin = null;
        /** @type {any} */ let nlist = null;
        if (kind === "reminder") {
          // v9.0 多重提醒。前端传 nl:[1440,30]；没传就退回旧的单一 nmin
          const nl = nlClean(body.nl);
          if (nl.length) {
            nlist = JSON.stringify(nl);
            nmin = nl[nl.length - 1];        // ⚠️ 旧栏位存「最靠近事件的那个」→ 万一前端是旧版，行为跟以前一样
          } else {
            const n = Number(body.nmin);
            nmin = Number.isFinite(n) && n >= 0 && n <= 20160 ? Math.round(n) : 0;   // 上限 14 天
          }
        }
        // v8.5 重复规则：只收合法的，其余一律 null（不重复）。v9.0 起跟 /api/import 共用 repCols()
        const { rt, ri, rd, ru, rx, rm } = repCols(body.rep);
        /* v9.89 颜色：只收 #RRGGBB，其余（含空字串、'auto'）一律 null = 交回给自动配色。 */
        const color = /^#[0-9a-fA-F]{6}$/.test(String(body.color || "")) ? String(body.color) : null;
        if (body.id) {
          /* ⚠️ v9.1 Google 来的事项是**只读**的 —— 内容改了也没用（下次同步就被 Google 盖回去），
             改了反而让人以为改成功了。这里直接挡：只让你动「提醒」，那是你自己的东西，不会传回 Google。
             前端也会挡，这里是最后一道（万一有人直接打 API）。 */
          const own = await env.DB.prepare("SELECT src FROM events WHERE id=?").bind(body.id).first();
          if (own && (own.src === "gcal" || own.src === "ics")) {
            await env.DB.prepare(
              "UPDATE events SET kind=?, notify_min=?, notifs=? WHERE id=? AND (src='gcal' OR src='ics')"
            ).bind(kind, nmin, nlist, body.id).run();
            return json({ ok: true, id: body.id, gcal: true, note: "订阅来的事项只能改提醒，内容改不了" });
          }
          await env.DB.prepare(
            "UPDATE events SET day=?, time=?, title=?, note=?, end_day=?, end_time=?, kind=?, notify_min=?, notifs=?, rep_type=?, rep_int=?, rep_days=?, rep_until=?, rep_ex=?, rep_mod=?, color=? WHERE id=?"
          ).bind(day, time, title, note, end, etime, kind, nmin, nlist, rt, ri, rd, ru, rx, rm, color, body.id).run();
          return json({ ok: true, id: body.id });
        }
        const r = await env.DB.prepare(
          "INSERT INTO events (day, time, title, note, end_day, end_time, kind, notify_min, notifs, rep_type, rep_int, rep_days, rep_until, rep_ex, rep_mod, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(day, time, title, note, end, etime, kind, nmin, nlist, rt, ri, rd, ru, rx, rm, color).run();
        return json({ ok: true, id: r.meta && r.meta.last_row_id });
      }

      if (path === "/api/event" && request.method === "DELETE") {
        const id = url.searchParams.get("id");
        if (!id) return json({ error: "缺 id" }, 400);
        await env.DB.prepare("DELETE FROM events WHERE id=?").bind(id).run();
        return json({ ok: true });
      }

      /* ---- v8.7 推送 ---- */
      if (path === "/api/push/key" && request.method === "GET") {
        return json({ key: env.VAPID_PUBLIC || null, configured: !!(env.VAPID_PUBLIC && env.VAPID_PRIVATE) });
      }
      if (path === "/api/push/subscribe" && request.method === "POST") {
        const sub = body.sub;
        if (!sub || !sub.endpoint) return json({ error: "缺 subscription" }, 400);
        const k = (sub.keys || {});
        await env.DB.prepare(
          `INSERT INTO push_subs (endpoint, p256dh, auth) VALUES (?, ?, ?)
           ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, fails=0`
        ).bind(sub.endpoint, k.p256dh || null, k.auth || null).run();
        /* v10.29 幽灵装置自愈：iOS 每次「重装 / 系统悄悄换订阅」都会给一个**新 endpoint** → 旧的死订阅
           留在表里，一台手机就被数成好几台。新订阅进来时，顺手清掉「连推不动 ≥3 次」的旧订阅
           （刚 upsert 的这条 fails=0，绝不会误删自己；真·另一台手机的健康订阅 fails 会被成功推送清零，也不会中招）。 */
        await env.DB.prepare("DELETE FROM push_subs WHERE fails >= 3 AND endpoint != ?").bind(sub.endpoint).run();
        const n = await env.DB.prepare("SELECT COUNT(*) c FROM push_subs").first();
        return json({ ok: true, devices: n ? n.c : 1 });
      }
      if (path === "/api/push/unsubscribe" && request.method === "POST") {
        if (body.endpoint) await env.DB.prepare("DELETE FROM push_subs WHERE endpoint=?").bind(body.endpoint).run();
        return json({ ok: true });
      }
      /* SW 收到推送後回头拿「刚刚到期的」。窗口比 cron 宽一点，免得边界漏掉。 */
      if (path === "/api/push/due" && request.method === "GET") {
        const now = Date.now();
        const items = await dueReminders(env, now - 11 * 60000, now + 60000);
        /* v9.11 周报：cron 存下的 weekly_pending 一起带出去，然后清掉（一次性） */
        try {
          const wp = await env.DB.prepare("SELECT v FROM app_settings WHERE k='weekly_pending'").first();
          if (wp && wp.v) { const j = JSON.parse(wp.v); if (j && j.body) items.push({ id: "weekly", title: String(j.title || "花费 · 上周速览"), body: String(j.body), day: null }); await putSetting(env, "weekly_pending", ""); }
        } catch (e) {}
        /* v9.16 每日体检警报：cron 存的 health_push 一起带出去、清掉（一次性） */
        try {
          const hp = await env.DB.prepare("SELECT v FROM app_settings WHERE k='health_push'").first();
          if (hp && hp.v) { const j = JSON.parse(hp.v); if (j && j.body) items.push({ id: "health", title: String(j.title || "⚠️ 系统体检"), body: String(j.body), day: null }); await putSetting(env, "health_push", ""); }
        } catch (e) {}
        return json({ items });
      }
      if (path === "/api/push/status" && request.method === "GET") {
        const n = await env.DB.prepare("SELECT COUNT(*) c FROM push_subs").first();
        const last = await env.DB.prepare("SELECT v FROM app_settings WHERE k='push_last'").first();
        return json({
          configured: !!(env.VAPID_PUBLIC && env.VAPID_PRIVATE),
          keymatch: vapidKeymatch(env),   // v10.30 两把 VAPID 是不是一对（false=推不出去的真凶）
          /* v10.32 把 worker **实际用到**的 sub 摊出来（BadJwtToken 但 sub 已设时用它定位）：
             sub_set=worker 到底读没读到 VAPID_SUB（false=设错地方/名字打错/没部署，还在用占位）；
             sub_ok=格式对不对（必须 mailto: 或 https: 开头——只填裸邮箱少了 mailto: 是最常见的坑）；
             sub 直接回原值（是使用者自己的邮箱、且只回给带 token 的本人，不算泄漏）。 */
          sub_set: !!env.VAPID_SUB,
          sub: env.VAPID_SUB || null,
          sub_ok: /^(mailto:|https:\/\/)/i.test(env.VAPID_SUB || ""),
          devices: n ? n.c : 0,
          last_scan: last ? last.v : null,
        });
      }
      /* 测试用：立刻推一下，不用等 cron */
      if (path === "/api/push/test" && request.method === "POST") {
        if (!(env.VAPID_PUBLIC && env.VAPID_PRIVATE)) return json({ error: "还没设 VAPID 金钥" }, 400);
        const r = await pushAll(env);
        r.keymatch = vapidKeymatch(env);   // v10.30 顺带回「两把 VAPID 是不是一对」，前端好一口咬定原因
        /* ⚠️ pushAll 回的 `r.ok` 是「成功推给几台」的**数字**，不是 true/false。
           以前写 `json({ ok: true, ...r })` —— 那个 `ok: true` **永远会被 r.ok 盖掉**
           （TypeScript 的 TS2783 就是在讲这个）。前端也正是靠这个数字显示「已推给 N 台装置」。
           所以它「刚好能用」，但是个地雷：谁哪天改成 `{...r, ok:true}` → 前端就变「已推给 true 台装置」。
           拿掉那个死的 ok:true，语意才诚实。 */
        return json(r);
      }

      /* ---- v5.2 Google Drive ---- */

      /* ════ v9.6 ICS 订阅 ════ */
      if (path === "/api/ics/list" && request.method === "GET") {
        const st = await icsState(env);
        return json({ feeds: st.feeds.map((f) => ({ id: f.id, url: f.url, name: f.name, color: f.color,
          on: !!f.on, n: f.n || 0, warn: f.warn || 0, last_sync: f.last_sync || null, last_error: f.last_error || null })),
          window: gcWindow().lo + " → " + gcWindow().hi });
      }
      if (path === "/api/ics/add" && request.method === "POST") {
        let u;
        try { u = icsUrl(body.url); } catch (e) { return json({ ok: false, error: e.message }, 200); }
        const st = await icsState(env);
        if (st.feeds.some((f) => f.url === u)) return json({ ok: false, error: "这个订阅已经加过了" }, 200);
        if (st.feeds.length >= 12) return json({ ok: false, error: "最多 12 个订阅" }, 200);
        const id = "f" + Date.now().toString(36);
        const COLORS = ["#E7484F", "#0BA678", "#3B82F6", "#E7A33E", "#8B5CF6", "#EC4899", "#14B8A6", "#F97316"];
        const feed = { id, url: u, name: String(body.name || "").trim().slice(0, 60) || "新订阅",
          custom: !!(body.name || "").trim(), color: COLORS[st.feeds.length % COLORS.length], on: true };
        st.feeds.push(feed);
        await icsPut(env, st);
        /* 刚加进来 → 立刻同步一次，不用等明天 */
        try {
          const r = await icsSyncOne(env, feed, gcWindow());
          feed.n = r.total; feed.warn = r.warn || 0; feed.etag = r.etag; feed.lastmod = r.lastmod;
          if (r.name && !feed.custom) feed.name = r.name.trim().slice(0, 60);
          feed.last_sync = sgIso();
          await icsPut(env, st);
          return json({ ok: true, feed, added: r.added, warn: r.warn || 0 });
        } catch (e) {
          feed.last_error = e.message;
          await icsPut(env, st);
          return json({ ok: false, error: e.message, feed }, 200);
        }
      }
      if (path === "/api/ics/toggle" && request.method === "POST") {
        const st = await icsState(env);
        const f = st.feeds.find((x) => x.id === body.id);
        if (!f) return json({ error: "找不到" }, 404);
        f.on = !!body.on;
        await icsPut(env, st);
        if (f.on) { try { await icsSync(env, true); } catch (e) {} }
        else await env.DB.prepare("DELETE FROM events WHERE src='ics' AND cal_id=?").bind(f.id).run();
        return json({ ok: true });
      }
      if (path === "/api/ics/del" && request.method === "POST") {
        const st = await icsState(env);
        st.feeds = st.feeds.filter((x) => x.id !== body.id);
        await icsPut(env, st);
        await env.DB.prepare("DELETE FROM events WHERE src='ics' AND cal_id=?").bind(body.id).run();
        return json({ ok: true });
      }
      if (path === "/api/ics/sync" && request.method === "POST") {
        try { return json({ ok: true, ...(await icsSync(env, !!body.force)) }); }
        catch (e) { return json({ ok: false, error: e.message }, 200); }
      }

      /* ════ v9.1 Google Calendar ════ */

      /* 「测试连线」：只列日历清单，不同步。
         ⚠️ 这颗是故意先做的 —— 授权/scope 有没有搞对，按一下就知道，
            不用等整套做完才发现 Console 那边漏了一步。 */
      if (path === "/api/gcal/test" && request.method === "GET") {
        try {
          const cals = await gcCalendars(env);
          return json({ ok: true, count: cals.length, cals });
        } catch (e) { return json({ ok: false, error: e.message }, 200); }
      }

      /* 状态：连了没 / 有哪几本日历 / 勾了哪些 / 上次同步 / 上次错误 */
      if (path === "/api/gcal/status" && request.method === "GET") {
        const gd = await gdState(env);
        if (!gd.refresh_token) return json({ connected: false });
        const st = await gcState(env);
        let cals = [], err = null;
        try { cals = await gcCalendars(env); }
        catch (e) { err = e.message; }
        const seen = st.seen || [];
        const list = cals.map((c) => ({
          ...c,
          on: !!st.cals[c.id],
          /* 新出现的日历**预设不勾** —— 你去订个球队赛程，不该默默在日历上多出 300 场球。
             标 🆕 让你看得到，勾不勾你自己决定。 */
          fresh: seen.indexOf(c.id) < 0,
        }));
        return json({
          connected: true, cals: list,
          last_sync: st.last_sync || null,
          last_error: err || st.last_error || null,
          window: gcWindow().lo + " → " + gcWindow().hi,
        });
      }

      /* 存勾选：{ cals: {"xxx@gmail.com": true, "holiday@...": false} } */
      if (path === "/api/gcal/cals" && request.method === "POST") {
        if (!body.cals || typeof body.cals !== "object") return json({ error: "缺 cals" }, 400);
        const st = await gcState(env);
        st.cals = {};
        for (const k of Object.keys(body.cals)) if (body.cals[k]) st.cals[k] = true;
        /* 看过的记下来 → 下次再出现就不算「新的」了 */
        const seen = new Set(st.seen || []);
        for (const k of Object.keys(body.cals)) seen.add(k);
        st.seen = [...seen].slice(0, 200);
        await gcPut(env, st);
        return json({ ok: true, on: Object.keys(st.cals).length });
      }

      /* 同步。前端在「开 App / 回前台 / 每 5 分钟 / 按按钮」时打这支。 */
      if (path === "/api/gcal/sync" && request.method === "POST") {
        try {
          const r = await gcSync(env);
          return json({ ok: true, ...r });
        } catch (e) { return json({ ok: false, error: e.message }, 200); }
      }

      /* 会议详情：列表不带 description（Zoom 那坨样板占一笔的 56%），点开才拿。 */
      if (path === "/api/gcal/detail" && request.method === "GET") {
        const id = url.searchParams.get("id");
        if (!id) return json({ error: "缺 id" }, 400);
        const r = await env.DB.prepare(
          "SELECT id, title, note, loc, url, cal_id, src FROM events WHERE id=? AND (src='gcal' OR src='ics')"
        ).bind(id).first();
        return json({ ev: r || null });
      }

      /* ① 一次性授权：手机浏览器打开 /api/gdrive/auth?token=...
         → 跳到 Google 同意页 → 回到 /api/gdrive/callback → 拿到 refresh_token 存进 D1。
         关键是 access_type=offline + prompt=consent —— 少了这两个就拿不到 refresh_token。 */
      if (path === "/api/gdrive/auth" && request.method === "GET") {
        const redirect = url.origin + "/api/gdrive/callback";
        const p = new URLSearchParams({
          client_id: gdId(env),
          redirect_uri: redirect,
          response_type: "code",
          scope: GD_SCOPE + " " + GC_SCOPE,   // v9.1 一次把 Drive + Calendar 都要了
          include_granted_scopes: "true",     // 增量授权：不会把已经给过的 Drive 权限弄掉
          access_type: "offline",       // ← 没有这个就没有 refresh_token
          prompt: "consent",            // ← 没有这个，第二次授权 Google 不会再给 refresh_token
          state: appToken(env),         // 回调时用来验身份
        });
        return Response.redirect("https://accounts.google.com/o/oauth2/v2/auth?" + p, 302);
      }

      /* ③ 状态：连了没、上次什么时候备份的 */
      if (path === "/api/gdrive/status" && request.method === "GET") {
        const st = await gdState(env);
        return json({
          connected: !!st.refresh_token,
          last_backup: st.last_backup || null,
          file_id: st.file_id || null,
          size: st.last_size || 0,
          folder: GD_FOLDER,
          configured: !!(gdId(env) && gdSec(env)),
          last_error: st.last_error || null,
          last_error_at: st.last_error_at || null,
        });
      }

      /* ④ 手动立刻备份一次 */
      if (path === "/api/gdrive/backup" && request.method === "POST") {
        const r = await gdBackup(env);
        return json(r);
      }

      /* ④b 从 Drive 那份备份读回来（前端再走一次 import 去重恢复） */
      if (path === "/api/gdrive/restore" && request.method === "POST") {
        const st = await gdState(env);
        if (!st.refresh_token) return json({ error: "还没连接 Drive" }, 400);
        if (!st.file_id) return json({ error: "Drive 上还没有备份档" }, 400);
        const token = await gdAccessToken(env);
        const rr = await fetch(
          `https://www.googleapis.com/drive/v3/files/${st.file_id}?alt=media`,
          { headers: { Authorization: "Bearer " + token } }
        );
        if (!rr.ok) return json({ error: "读取 Drive 档失败: " + rr.status }, 502);
        /** @type {any} */ let backup = null;
        try { backup = await rr.json(); } catch (e) { return json({ error: "Drive 档不是有效 JSON" }, 502); }
        if (!backup || !Array.isArray(backup.expenses)) return json({ error: "Drive 档里没有 expenses" }, 502);
        return json({ ok: true, backup });
      }

      /* ⑤ 断开（把 refresh_token 删掉） */
      if (path === "/api/gdrive/disconnect" && request.method === "POST") {
        await env.DB.prepare("DELETE FROM app_settings WHERE k='gdrive'").run();
        return json({ ok: true });
      }

      /* ---- v3.0 汇率：GET /api/fx ----
         FX[c] = 1 单位 c 值多少 SGD。数据源 frankfurter.app（欧洲央行，免费无 key）。
         结果缓存在 app_settings k='fx'，12 小时内不重复去拉。 */
      if (path === "/api/fx" && request.method === "GET") {
        const cached = await env.DB.prepare("SELECT v, updated_at FROM app_settings WHERE k='fx'").first();
        if (cached) {
          try {
            const j = JSON.parse(cached.v);
            const age = Date.now() - new Date((cached.updated_at || "").replace(" ", "T") + "Z").getTime();
            /* ⚠️ v9.92 加过一个 `j.rates.CNY` 的硬条件，原因是：v9.91 加 CNY 那天 D1 里还躺着
               一份只有 {USD,MYR} 的旧缓存，不检查的话它会被当成「新鲜的」再用 12 小时，
               这段期间所有 CNY 消费都换算错，而且**不报错、不留痕**。
               ⚠️ v9.94 改成比对整份币种清单 —— 以后再加币种，这里永远不用再动。
               这就是那时候注解里写的「或改成比对一份币种清单」，现在做了。 */
            const fresh = j && j.rates && FX_WANT.every(c => typeof j.rates[c] === "number");
            if (fresh && age < 12 * 3600 * 1000) return json(j);
          } catch (e) {}
        }
        try {
          /* v9.94 一次把整份拉回来，不再每加一个币种就要改一次 code + 等缓存过期。
             数据源 frankfurter.app（欧洲央行）。⚠️ 它**没有** TWD / VND / MOP / BND —— 见 FX_FALLBACK。 */
          const r = await fetch("https://api.frankfurter.app/latest?from=SGD&to=" + FX_WANT.join(","));
          const d = await r.json();
          // frankfurter 回的是「1 SGD = x USD」，我们要的是反过来
          const rates = { ...FX_FALLBACK };
          if (d && d.rates) for (const c of FX_WANT) {
            if (typeof d.rates[c] === "number" && d.rates[c] > 0) rates[c] = 1 / d.rates[c];
          }
          const out = { date: d && d.date || null, rates };
          await putSetting(env, "fx", JSON.stringify(out));
          return json(out);
        } catch (e) {
          // 拉不到就把上次缓存的还回去；一次都没成功过就给保底值
          if (cached) { try { return json(JSON.parse(cached.v)); } catch (e2) {} }
          return json({ date: null, rates: { ...FX_FALLBACK }, stale: true });
        }
      }

      /* ---- v3.0 收件箱：GET /api/inbox ---- */
      /* GET /api/inbox?token=..&month=2026-07&kind=parsed|unparsed
         月份不给 → 默认最近的那个月。回传：
           items   这个月这个 tab 的邮件
           months  有邮件的月份清单（给前端做下拉）
           counts  这个月两个 tab 各几封 + 读不到的总数（红角标用） */
      if (path === "/api/inbox" && request.method === "GET") {
        /* v10.7 移除读路径上的 purgeInbox：cron 每 5 分钟已经在清、收信时也清，读时再清=白付一次
           getRetention +（可能）一次 DELETE，还跟下面 _ret 那次 getRetention 重复。清理交给 cron / 收信那两处。 */
        /* ═══ v9.95 badge=1：开机只要红角标那个数字 ═══
           以前前端开机那一发 loadInbox() 是**整包**回来的：
           raw 每封最多 8000 字 × LIMIT 400 = 最坏 3.05 MB，只为了显示一个数字。
           手机上光 r.json() 解析就是一次几百 ms 的长任务，正好压在开机刚画完那一刻。 */
        if (url.searchParams.get("badge") === "1") {
          const b0 = await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM inbox WHERE COALESCE(kind,'unparsed')='unparsed' AND status='new'").first();
          return json({ badge: (b0 && b0.n) || 0, badge_only: true, keep_months: INBOX_KEEP_MONTHS });
        }
        const kind = url.searchParams.get("kind") === "parsed" ? "parsed" : "unparsed";
        let month = url.searchParams.get("month") || "";
        if (!/^\d{4}-\d{2}$/.test(month)) month = "";

        // 每个月各几封 —— 前端的月份按钮上直接显示
        /* v10.5：月份清单跟着「数据保留」的实际窗口走。
           开了保留 → 邮件跟着账留约一年（getRetention.months），月份按钮就该显示这么多个；
           没开 → 维持默认 3 个月（INBOX_KEEP_MONTHS）。
           以前这里写死 LIMIT 3：保留开了、D1 里明明存着一年的邮件，前端却永远只拿得到最近 3 个按钮，
           第 4 个月起点都点不到 —— 就是这行的锅。_keepN 是整数（getRetention 已把 months 收成 >0 int），
           放进模板字串安全，无注入。 */
        const _ret = await getRetention(env);
        const _keepN = Math.max(1, _ret.on ? (_ret.months | 0) : INBOX_KEEP_MONTHS);
        const mo = await env.DB.prepare(
          `SELECT substr(ts,1,7) AS m, COUNT(*) AS n FROM inbox
           GROUP BY m ORDER BY m DESC LIMIT ${_keepN}`).all();
        // DESC 取「最近 3 个月」；下面挑默认月还用最新的（monthsDesc[0]）。
        const monthsDesc = (mo.results || []).map(x => ({ m: x.m, n: x.n }));
        // v9.83 显示顺序要「旧→新」（7月在左、8月在右），所以反转给前端。
        const months = monthsDesc.slice().reverse();
        // 选的月份已经被清掉了（或压根没有）→ 退回最新的那个月（注意用 monthsDesc[0] = 最新）
        if (month && !months.some(x => x.m === month)) month = "";
        if (!month) month = (monthsDesc[0] && monthsDesc[0].m) || sgIso().slice(0, 7);

        /* v9.68 一次回**这个月两个 tab** 的邮件（去掉 kind 过滤）。
           为什么：以前每切一次 tab（已记录↔读不到）都重发一次网络请求，
           手机上那个往返就是用户感觉到的延迟。数据量很小（同月、上限 400 = 下面那条 SQL 的 LIMIT），
           一次拿全 → 前端切 tab 纯内存过滤，零网络、瞬间切换。
           kind 参数保留相容（旧前端还能用），但现在两个 tab 都回。 */
        /* ═══ v9.95 lite=1：清单**一个字的原文都不回** ═══
           前端的清单已经不印预览了（那行印的本来就是 MIME 表头，没用），
           所以连 substr 预览都省掉：最坏 3.05 MB → 约 70 KB。
           真的要看原文是点开某一封的时候 —— 那时走下面 POST action:'raw' 单独拿那一封。
           ⚠️ 不带 lite 的旧前端行为**一个字没变**，照旧回 raw（新旧可以随便配）。 */
        const lite = url.searchParams.get("lite") === "1";
        const cols = lite
          ? "id, ts, sender, subject, status, kind, summary"
          : "id, ts, sender, subject, raw, status, kind, summary";
        /* v10.7 把「这个月的邮件 + 两 tab 计数 + 红角标」三条合成一次 D1 batch：原本 3 次串行往返 → 1 次。
           （month 依赖 mo：要先知道有哪些月才能定默认月，所以 mo 只能单独先跑，不进这个 batch。）
           batch 回传顺序 = 传入顺序，每项都是 {results,...}。 */
        const _b = await env.DB.batch([
          env.DB.prepare(`SELECT ${cols} FROM inbox WHERE substr(ts,1,7)=? ORDER BY id DESC LIMIT 400`).bind(month),
          env.DB.prepare("SELECT COALESCE(kind,'unparsed') AS k, COUNT(*) AS n FROM inbox WHERE substr(ts,1,7)=? GROUP BY k").bind(month),
          env.DB.prepare("SELECT COUNT(*) AS n FROM inbox WHERE COALESCE(kind,'unparsed')='unparsed' AND status='new'"),
        ]);
        const rs = _b[0];
        const counts = { parsed: 0, unparsed: 0 };
        ((_b[1] && _b[1].results) || []).forEach(x => { counts[x.k] = x.n; });
        const badgeN = (_b[2] && _b[2].results && _b[2].results[0] && _b[2].results[0].n) || 0;

        return json({
          items: rs.results || [], months, month, kind, counts,
          badge: badgeN,
          keep_months: _keepN,   // v10.5：报真实窗口（保留开=约一年、没开=3），前端提示文字才准
        });
      }
      /* POST /api/inbox { token, id, action:'done'|'delete'|'retry' } */
      if (path === "/api/inbox" && request.method === "POST") {
        const { id, action } = body;
        /* v11.05 一键清空「读不到」：删掉**当前这个月** kind='unparsed' 的占位邮件（不带 id）。
           ⚠️ 只删使用者正在看的那个月（month=YYYY-MM），不是所有月份 —— 用 substr(ts,1,7)=month
              跟 GET 那边同一把尺。没给合法 month 就拒绝，绝不误删别的月。
           ⚠️ 只删 unparsed —— parsed（已记录）碰都不碰。而且遵守 v10.4「删邮件不动明细」铁律：
              unparsed 本来就没有对应的 expenses 真账（就是因为读不懂才没记），所以删它零风险，一笔账都不会少。
           用 COALESCE(kind,'unparsed')='unparsed' 跟角标那条 SELECT 同尺（旧的 NULL kind 也算 unparsed）。 */
        if (action === "clear-unparsed") {
          const m = String(body.month || "");
          if (!/^\d{4}-\d{2}$/.test(m)) return json({ error: "month required (YYYY-MM)" }, 400);
          const r = await env.DB.prepare(
            "DELETE FROM inbox WHERE COALESCE(kind,'unparsed')='unparsed' AND substr(ts,1,7)=?").bind(m).run();
          return json({ ok: true, deleted: (r.meta && r.meta.changes) || 0 });
        }
        if (!id) return json({ error: "id required" }, 400);

        /* v9.66 重新识别：拿这条 inbox 的 raw 文字，重新丢回 ingestRaw 跑一次。
           用途：加了新 parser（例如新 app）之后，把以前「读不到」的旧账一键补回来。
           好处：raw 里本来就有完整资讯，比手动打准（日期/商家/去重 ref 都有）。
           读到了 → 记账 + 这条标 done + **删掉那条 unparsed 占位**（否则它会一直留在「读不到」）。
           去重照旧走 hash，重复按不会变两笔。 */
        /* v9.95 单封原文：清单走 lite（不回 raw）之後，点开某一封才来拿它的原文。 */
        if (action === "raw") {
          /* v10.12 顺手回这封信记出来的**指纹**（hashes）。
             用途：两封明明不同的账，如果指纹一样，就是被当成重复丢掉的 —— 你自己点开两封一对就知道，
             不用再靠谁「觉得」。这栏本来就存着，只是以前没人看得到。 */
          const row = await env.DB.prepare("SELECT raw, hashes FROM inbox WHERE id=?").bind(id).first();
          if (!row) return json({ error: "not found" }, 404);
          /* ⚠️ v10.13 **旧邮件**是 v10.12 以前存进来的，raw 那栏装的还是整封 MIME
             （Received / ARC-Seal 那一大坨）—— 点开看就是一片乱码，还会「找不到金额」。
             新邮件从收信那一刻起就只存可读正文了，但**旧的已经存在库里，不会自己变干净**。
             解法刻意选「读的时候才清」而不是「改库里的资料」：
               · 不动任何一个字节的历史资料（不可逆的事一律不做）
               · 旧邮件立刻变干净，连重新部署以前收的那些都一起受益
               · 重试(retry)走的仍是原始 raw，行为不变（那条路本来就会自己抽正文）
             不是 MIME 的（截图/粘贴/新邮件）原样回传，一个字节都不碰。 */
          /* v23.26：这里以前是 `looksLikeMime(_raw) ? mailText(_raw) : _raw` ——
             旧邮件被截断成「只有信头、没有空行」时 looksLikeMime 回 false，
             整条清洗被跳过，原样把 ARC-Seal 吐出去（就是你截图那个）。
             mailForView 多认一种「只剩信头的残骸」，抽不出正文就回一句人话。 */
          const _raw = String(row.raw || "");
          return json({ ok: true, raw: mailForView(_raw), hashes: row.hashes || "" });
        }
        if (action === "guess") {
          /* v9.67 只猜不记：给前端「用这封记一笔」预填用。回金额/日期/币种，用户在表单里改。 */
          const row = await env.DB.prepare("SELECT raw FROM inbox WHERE id=?").bind(id).first();
          if (!row || !row.raw) return json({ error: "not found" }, 404);
          /* v10.13 同上：旧邮件先抽正文再猜，否则 guessTxn 会从信头里捞到一堆没意义的数字。
             v23.26：改走 mailBodyOrNull —— 抽得到就用正文；只剩信头（旧邮件）就喂空字串，
             宁可回 null 让你自己打，也**绝不**从 ARC-Seal 的 base64 里捞出一个假金额预填给你。 */
          const _g = String(row.raw || "");
          const _gb = mailBodyOrNull(_g);
          const _gt = _gb !== null ? htmlToLines(_gb).join("\n") : (looksLikeMimeHead(_g) ? "" : _g);
          return json({ ok: true, guess: guessTxn(_gt) });
        }
        if (action === "retry") {
          const row = await env.DB.prepare("SELECT raw, ts, subject FROM inbox WHERE id=?").bind(id).first();
          if (!row || !row.raw) return json({ error: "not found" }, 404);
          /* v9.89 沿用原邮件的 ts 和标题 → 重试成功后那条记录还留在**它本来那个月**的收件箱里 */
          /* v10.12 标题也接在正文前面 —— 收信时 email() 就是这样喂的（标题里常有「PayNow transfer made」
             这种正文没有的关键词）。两条路必须喂一样的东西，否则「同一封信重试反而认不出来」。 */
          const r = await ingestRaw(env, (row.subject ? row.subject + "\n" : "") + (row.raw || ""),
                                    "🔁 重试", row.subject || "（重新识别）",
                                    { skipUnparsedLog: true, logTs: row.ts });
          if (r.saved > 0) {
            // 认出来了：ingestRaw 已另记一笔 parsed 收件箱，这条旧的 unparsed 就删掉，别留着碍眼
            await env.DB.prepare("DELETE FROM inbox WHERE id=?").bind(id).run();
          }
          return json({ ok: true, parsed: r.parsed, saved: r.saved, rows: r.rows });
        }

        if (action === "delete") await env.DB.prepare("DELETE FROM inbox WHERE id=?").bind(id).run();
        else await env.DB.prepare("UPDATE inbox SET status='done' WHERE id=?").bind(id).run();
        return json({ ok: true });
      }

      /* ---- v3.0 定期账单：POST /api/recurring { token, rec:[...] } ---- */
      if (path === "/api/recurring" && request.method === "POST") {
        const rec = body.rec;
        if (!Array.isArray(rec)) return json({ error: "rec required" }, 400);
        await putSetting(env, "recurring", JSON.stringify(rec));
        return json({ ok: true });
      }

      /* v2.0 存分类：POST /api/cats { token, cats:{expense:{...},income:{...}} } */
      if (path === "/api/cats" && request.method === "POST") {
        const cats = body.cats;
        if (!cats || typeof cats !== "object") return json({ error: "cats required" }, 400);
        await putSetting(env, "categories", JSON.stringify(cats));
        return json({ ok: true });
      }

      /* v6.3 存预算：POST /api/budgets { token, budgets:{catKey: monthlySGD} } */
      if (path === "/api/budgets" && request.method === "POST") {
        const budgets = body.budgets;
        if (!budgets || typeof budgets !== "object") return json({ error: "budgets required" }, 400);
        await putSetting(env, "budgets", JSON.stringify(budgets));
        return json({ ok: true });
      }

      /* v9.10 订阅侦测忽略名单：POST /api/subignore { token, subignore:[merchantKey...] }
         只存前端算出来的「这些商家不是订阅，别再提」名单。侦测本身是纯前端只读，绝不新增交易。 */
      if (path === "/api/subignore" && request.method === "POST") {
        const subignore = Array.isArray(body.subignore) ? body.subignore : null;
        if (!subignore) return json({ error: "subignore array required" }, 400);
        await putSetting(env, "sub_ignore", JSON.stringify(subignore));
        return json({ ok: true });
      }

      /* v9.11 周报开关：POST /api/weekly { token, on:true/false } */
      if (path === "/api/weekly" && request.method === "POST") {
        await putSetting(env, "weekly_report", body.on ? "1" : "0");
        return json({ ok: true });
      }

      /* v9.20 动态付款方式：POST /api/paymethods { token, list:[卡号...] } —— 用户手动加的付款方式。
         银行邮件来的卡号是从 expenses 现算的，不进这里；这里只存「手动加、还没交易过」的那些。 */
      if (path === "/api/paymethods" && request.method === "POST") {
        const list = Array.isArray(body.list) ? body.list.filter((x) => typeof x === "string" && x.trim()).slice(0, 50) : null;
        if (!list) return json({ error: "list array required" }, 400);
        await putSetting(env, "pay_methods", JSON.stringify(list));
        return json({ ok: true });
      }

      /* v9.23 付款方式改名：POST /api/paynames { token, names:{key:名字} } —— 只存显示名（一层贴纸），
         不动交易的 card_last4。删掉某个 key = 恢复原名。 */
      if (path === "/api/paynames" && request.method === "POST") {
        const names = (body.names && typeof body.names === "object" && !Array.isArray(body.names)) ? body.names : null;
        if (!names) return json({ error: "names object required" }, 400);
        const clean = {};
        for (const k of Object.keys(names).slice(0, 100)) {
          const v = names[k];
          if (v && typeof v === "object" && !Array.isArray(v)) {
            const o = {};
            if (typeof v.n === "string" && v.n.trim()) o.n = v.n.trim().slice(0, 40);
            if (typeof v.i === "string" && v.i.trim()) o.i = v.i.trim().slice(0, 12);
            if (o.n || o.i) clean[k] = o;
          } else if (typeof v === "string" && v.trim()) { clean[k] = { n: v.trim().slice(0, 40) }; }
        }
        await putSetting(env, "pay_names", JSON.stringify(clean));
        return json({ ok: true });
      }

      /* v9.11 立即测试推送：POST /api/weekly/test —— 不看星期几，马上算上周汇总并推一条。
         走的是跟真周报**一模一样**的路（存 weekly_pending → pushAll → SW 拿 /api/push/due），
         所以能测通整条链路。没订阅通知就 ok=0，前端会提示先开通知。 */
      if (path === "/api/weekly/test" && request.method === "POST") {
        const dg = await weeklyDigest(env);
        const catMap = await catNameMap(env);
        const dbody = dg.hasData ? weeklyBody(dg, catMap) : "上周没有支出记录 —— 这是一条测试推送，链路正常。";
        await putSetting(env, "weekly_pending", JSON.stringify({ title: "花费 · 上周速览（测试）", body: dbody }));
        let push = { subs: 0, ok: 0, gone: 0, codes: {}, reason: "" };
        const hasKey = !!(env.VAPID_PUBLIC && env.VAPID_PRIVATE);
        if (hasKey) { try { push = await pushAll(env); } catch (e) {} }
        // v10.27 测试推送也记进 weekly_last → 按了「立即发测试」就能在自检里立刻看到成不成；v10.28 带 codes；v10.30 带 reason（推送服务原话）
        await putSetting(env, "weekly_last", JSON.stringify({ at: sgIso(), kind: "test", hasData: !!dg.hasData, subs: push.subs || 0, ok: push.ok || 0, gone: push.gone || 0, codes: push.codes || {}, reason: push.reason || "", nokey: !hasKey }));
        return json({ ok: true, body: dbody, subs: push.subs || 0, sent: push.ok || 0, gone: push.gone || 0, codes: push.codes || {}, reason: push.reason || "", keymatch: vapidKeymatch(env) });
      }

      /* v6.3 商家记忆增改删：POST /api/rules
         { token, action:'save', merchant_key, category?, display? }  → upsert
         { token, action:'delete', merchant_key }                    → 删这条 */
      if (path === "/api/rules" && request.method === "POST") {
        const mk = merchantKey(body.merchant_key || "");
        if (!mk) return json({ error: "merchant_key required" }, 400);
        if (body.action === "delete") {
          await env.DB.prepare("DELETE FROM merchant_rules WHERE merchant_key=?").bind(mk).run();
          return json({ ok: true });
        }
        // save：category 是 NOT NULL，空则退回 'other'；display / sub 允许 null
        const cat = (body.category && String(body.category).trim()) || "other";
        const disp = body.display != null && String(body.display).trim() ? String(body.display).trim() : null;
        const sub = cat === FOOD_KEY ? null : (body.sub != null && String(body.sub).trim() ? String(body.sub).trim() : null);
        await env.DB.prepare(
          `INSERT INTO merchant_rules (merchant_key, category, display, sub) VALUES (?, ?, ?, ?)
           ON CONFLICT(merchant_key) DO UPDATE SET category=excluded.category, display=excluded.display, sub=excluded.sub`
        ).bind(mk, cat, disp, sub).run();
        return json({ ok: true });
      }

      /* v6.3 粘贴文字记账：POST /api/paste { token, text }
         把一段银行短信/邮件文字，走和转发邮件**一模一样**的管道：
         解析 → 存账（去重）→ 进收件箱存档。回 { parsed, saved, rows }。 */
      if (path === "/api/paste" && request.method === "POST") {
        const text = (body.text || "").toString();
        if (!text.trim()) return json({ error: "text required" }, 400);
        /* v9.29 来源标签：捷径截图记账在 URL 后面加 &src=shot，
           收件箱里就显示「📷 截图」，跟手动粘贴的短信分得开。不加照旧。 */
        const isShot = ((url.searchParams.get("src") || body.src || "") + "").toLowerCase() === "shot";
        const r = await ingestRaw(env, text,
          isShot ? "📷 截图" : "paste",
          isShot ? "（截图记账）" : "（粘贴）");
        return json({ ok: true, parsed: r.parsed, saved: r.saved, rows: r.rows });
      }

      /* v2.0 JSON 恢复：POST /api/import { token, expenses:[], rules:{}, categories:{} }
         只补不覆盖：靠 hash UNIQUE + INSERT OR IGNORE，同一笔再导也不会变两笔。 */
      if (path === "/api/import" && request.method === "POST") {
        const rows = Array.isArray(body.expenses) ? body.expenses : [];
        if (rows.length > 20000) return json({ error: "too many rows" }, 413);
        let added = 0, skipped = 0, bad = 0;

        const stmt = env.DB.prepare(
          `INSERT OR IGNORE INTO expenses
           (ts, amount, currency, merchant, card_last4, source, raw, hash, type, category, sub, offset)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const batch = [];
        for (const r of rows) {
          const amt = Number(r.amount);
          if (!r.ts || !Number.isFinite(amt)) { bad++; continue; }
          const kind = r.type === "income" ? "income" : "expense";
          // 备份里应该带 hash；万一没有（老档），用内容拼一个稳定的指纹，
          // 这样同一个档反复导入也只会进去一次。
          const hash = r.hash || `imp:${r.ts}:${amt}:${r.currency || "SGD"}:${r.merchant || ""}`;
          batch.push(stmt.bind(
            r.ts, amt, r.currency || "SGD", r.merchant || null, r.card_last4 || null,
            r.source || "manual", r.raw || "", hash, kind, r.category || null, r.sub || null,
            (kind === "income" && r.offset) ? 1 : 0
          ));
        }
        // D1 一次 batch 别塞太多，切成 50 一组
        for (let i = 0; i < batch.length; i += 50) {
          const res = await env.DB.batch(batch.slice(i, i + 50));
          res.forEach((x) => { if (x.meta && x.meta.changes) added++; else skipped++; });
        }

        // 商家记忆
        const rules = body.rules && typeof body.rules === "object" ? body.rules : {};
        for (const [k, v] of Object.entries(rules)) {
          if (!k || !v) continue;
          // 备份档可能是老格式（纯字符串 = 分类），也可能是新格式 {c,d,s}
          const cat = (typeof v === "string") ? v : v.c;
          const disp = (typeof v === "string") ? null : v.d;
          const sb = (typeof v === "string") ? null : (v.s || null);   // v6.9 修：以前没传，恢复后子分类记忆全丢
          if (!cat) continue;
          try { await putRule(env, k, cat, disp, sb); } catch (e) {}
        }
        // 分类
        if (body.categories && typeof body.categories === "object") {
          await putSetting(env, "categories", JSON.stringify(body.categories));
        }
        // v6.9 事项：没有 hash 列，用「天+时间+标题」当天然键去重 → 同一个档反复导入也不会变两条
        let evAdded = 0;
        if (Array.isArray(body.events)) {
          for (const e of body.events.slice(0, 5000)) {
            if (e.src === "gcal" || e.src === "ics") continue;   // 订阅来的是快取，不还原（重连/重订就回来）
            const day = String(e.day || "").slice(0, 10);
            const title = String(e.title || "").trim();
            if (!DAY_RE.test(day) || !title) continue;
            const time = HM_RE.test(String(e.time || "")) ? String(e.time) : null;
            try {
              const end = DAY_RE.test(String(e.end_day || e.end || "")) ? String(e.end_day || e.end) : null;
              /* ⚠️ v9.0 去重也要看重复规则：
                 「每周一 Gym」和某天一次性的「Gym」有可能同 day/time/title —— 以前会把后者当重复的吞掉。
                 现在把 rep_type 一起比：规则不同 = 不同的事。 */
              const repIn = repFromRow(e);
              const cols = repCols(repIn);
              const hit = await env.DB.prepare(
                "SELECT id FROM events WHERE day=? AND COALESCE(time,'')=COALESCE(?,'') AND title=? AND COALESCE(rep_type,'')=COALESCE(?,'')"
              ).bind(day, time, title, cols.rt).first();
              if (hit) continue;
              const et = HM_RE.test(String(e.end_time || e.etime || "")) ? String(e.end_time || e.etime) : null;
              const kd = e.kind === "reminder" ? "reminder" : "event";
              /* v9.0 多重提醒也要还原。备份是 notifs（JSON 字串）；前端形状是 nl（阵列）→ 两种都收。 */
              /** @type {any} */ let nl = null;
              /** @type {any} */ let nm = null;
              if (kd === "reminder") {
                let arr = Array.isArray(e.nl) ? e.nl : [];
                if (!arr.length && e.notifs) { try { arr = JSON.parse(e.notifs); } catch (err2) { arr = []; } }
                const c = nlClean(arr);
                if (c.length) { nl = JSON.stringify(c); nm = c[c.length - 1]; }
                else {
                  const n = Number(e.notify_min ?? e.nmin);
                  nm = Number.isFinite(n) && n >= 0 && n <= 20160 ? Math.round(n) : null;
                }
              }
              await env.DB.prepare(
                "INSERT INTO events (day, time, title, note, end_day, end_time, kind, notify_min, notifs, rep_type, rep_int, rep_days, rep_until, rep_ex, rep_mod, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
              ).bind(day, time, title, e.note || null, end && end > day ? end : null, time ? et : null, kd, nm, nl,
                     cols.rt, cols.ri, cols.rd, cols.ru, cols.rx, cols.rm,
                     /^#[0-9a-fA-F]{6}$/.test(String(e.color || "")) ? String(e.color) : null).run();   // v9.89 颜色也还原
              evAdded++;
            } catch (err) { console.log("import event skip:", err.message); }
          }
        }

        /* v10.4 收件箱还原。备份里有 inbox 才走（旧备份档没有这个栏位 → 整段跳过，向后相容）。
           inbox 没有 hash / UNIQUE 栏，所以用「ts + 寄件人 + 标题」当天然键去重
           —— 同一份档反复导入不会变两条。先把现有的键读成 Set，再只插缺的那些，
           避免每一封都往 D1 打一次 SELECT。 */
        let ibAdded = 0;
        if (Array.isArray(body.inbox) && body.inbox.length) {
          try {
            const key = (t, s, j) => String(t || "") + "|" + String(s || "") + "|" + String(j || "");
            const cur = await env.DB.prepare("SELECT ts, sender, subject FROM inbox").all();
            const seen = new Set((cur.results || []).map((r) => key(r.ts, r.sender, r.subject)));
            const stI = env.DB.prepare(
              "INSERT INTO inbox (ts, sender, subject, raw, status, kind, summary, hashes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            );
            const bat = [];
            for (const m of body.inbox.slice(0, 20000)) {
              if (!m || !/^\d{4}-\d{2}-\d{2}/.test(String(m.ts || ""))) continue;
              const k = key(m.ts, m.sender, m.subject);
              if (seen.has(k)) continue;
              seen.add(k);   // 同一份档里自己也可能有重复
              const kind = (m.kind === "parsed" || m.kind === "unparsed") ? m.kind : null;
              bat.push(stI.bind(
                String(m.ts), m.sender || null, m.subject || null,
                String(m.raw || "").slice(0, 8000),          // parsed 的备份本来就没带 raw → 存空字串
                m.status === "done" ? "done" : "new", kind, m.summary || null, m.hashes || null
              ));
            }
            for (let i = 0; i < bat.length; i += 50) {
              const res = await env.DB.batch(bat.slice(i, i + 50));
              res.forEach((x) => { if (x.meta && x.meta.changes) ibAdded++; });
            }
          } catch (err) { console.log("import inbox skip:", err.message); }
        }
        return json({ ok: true, added, skipped, bad, events_added: evAdded, inbox_added: ibAdded });
      }

      /* 存设置：POST /api/settings  { token, prefs:{theme,tp} } */
      if (path === "/api/settings" && request.method === "POST") {
        const prefs = body.prefs;
        if (!prefs || typeof prefs !== "object") return json({ error: "prefs required" }, 400);
        await putSetting(env, "theme_prefs", JSON.stringify(prefs));
        return json({ ok: true });
      }

      /* 存背景图：POST /api/bg  { token, data:"<base64 或整个 data:image/... URL>" }
         回 { ok:true, bgver }，前端拿 bgver 拼进图片 URL 当版本号 */
      if (path === "/api/bg" && request.method === "POST") {
        const data = body.data;
        if (typeof data !== "string" || !data) return json({ error: "data required" }, 400);
        const b64 = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
        const size = Math.floor(b64.replace(/=+$/, "").length * 3 / 4);
        if (size > MAX_BG_BYTES) {
          return json({ error: `图太大 ${Math.round(size / 1024)}KB（上限 ${MAX_BG_BYTES / 1024}KB）` }, 413);
        }
        await putSetting(env, "bg", b64);
        const row = await env.DB.prepare("SELECT updated_at FROM app_settings WHERE k='bg'").first();
        return json({ ok: true, bgver: row && row.updated_at, size });
      }

      /* 取背景图：GET /api/bg?token=&v=<bgver>
         直接回 JPEG 二进制。URL 带版本号 → 可以放心长缓存，换图 URL 就变。 */
      if (path === "/api/bg" && request.method === "GET") {
        const row = await env.DB.prepare("SELECT v FROM app_settings WHERE k='bg'").first();
        if (!row || !row.v) return json({ error: "no bg" }, 404);
        const bin = Uint8Array.from(atob(row.v), (c) => c.charCodeAt(0));
        return new Response(bin, {
          headers: {
            "Content-Type": "image/jpeg",
            "Cache-Control": "public, max-age=31536000, immutable",
            ...CORS,
          },
        });
      }

      /* 清除背景图：DELETE /api/bg?token= */
      if (path === "/api/bg" && request.method === "DELETE") {
        await env.DB.prepare("DELETE FROM app_settings WHERE k='bg'").run();
        return json({ ok: true });
      }

      /* 想确认 schema 到底跑没跑：浏览器开 /api/health?token=... 。v9.16 扩成完整体检（每项容错，绝不 500）。 */
      if (path === "/api/health" && request.method === "GET") {
        const g = async (sql) => { try { return await env.DB.prepare(sql).first(); } catch (e) { return null; } };
        const now = Date.now();
        const row = await g("SELECT v, updated_at FROM app_settings WHERE k='schema_version'");
        const cnt = await g("SELECT COUNT(*) AS n FROM expenses");
        const ib = await g("SELECT COUNT(*) AS n FROM inbox WHERE status='new'");
        const ev = await g("SELECT COUNT(*) AS n FROM events");
        const psub = await g("SELECT COUNT(*) AS n FROM push_subs");
        const pl = await g("SELECT v FROM app_settings WHERE k='push_last'");
        const bm = await g("SELECT v FROM app_settings WHERE k='backup_month'");
        const wr = await g("SELECT v FROM app_settings WHERE k='weekly_report'");
        let gauth = false, lastBackup = null;
        try { const gd = await g("SELECT v FROM app_settings WHERE k='gdrive'"); if (gd) { const j = JSON.parse(gd.v); gauth = !!(j && j.refresh_token); lastBackup = (j && j.last_backup) || null; } } catch (e) {}
        let icsFeeds = 0, icsErr = 0;
        try { const ic = await g("SELECT v FROM app_settings WHERE k='ics'"); if (ic) { const j = JSON.parse(ic.v); const arr = (j && j.feeds) || []; icsFeeds = arr.length; icsErr = arr.filter((f) => f.on && f.last_error).length; } } catch (e) {}
        const pushLastMs = pl ? Number(pl.v) : 0;
        let weeklyLast = null; try { const _wl = await g("SELECT v FROM app_settings WHERE k='weekly_last'"); if (_wl) weeklyLast = JSON.parse(_wl.v); } catch (e) {}   // v10.27 上一次周报推送结果，给自检看
        const _ret = await getRetention(env);
        let _retLast = null; try { const _rl = await g("SELECT v FROM app_settings WHERE k='retention_last'"); if (_rl) _retLast = JSON.parse(_rl.v); } catch (e) {}
        const _retReady = !!(gauth && lastBackup && (Date.now() - new Date(lastBackup).getTime()) < 40 * 86400000);
        return json({
          ok: true,
          /* v10.10：以前这里只回 schema_version（D1 迁移到第几条），**没有 worker 自己的版本**
             → app 永远发现不了「你只重新部署了 index.html，worker 还是旧的」。
             两个档本来就各自独立部署（见总纲开头），这种半套状态一定会发生，以前只能靠猜。 */
          worker_ver: WORKER_VER,
          schema_version: row ? parseInt(row.v, 10) : 0,
          expected: SCHEMA_VERSION,
          migrated_at: row ? row.updated_at : null,
          expenses: cnt ? cnt.n : 0,
          events: ev ? ev.n : 0,
          inbox_new: ib ? ib.n : 0,
          push_subs: psub ? psub.n : 0,
          push_last_ms: pushLastMs,
          cron_age_min: pushLastMs ? Math.round((now - pushLastMs) / 60000) : null,
          backup_month: bm ? bm.v : null,
          last_backup: lastBackup,
          google_auth: gauth,
          ics_feeds: icsFeeds,
          ics_errors: icsErr,
          weekly_report: wr ? wr.v === "1" : false,
          weekly_last: weeklyLast,          // v10.27 上一次早报推送：{at,kind,hasData,subs,ok,gone,nokey}｜null=还没推过
          server_now_ms: now,
          retention_on: _ret.on,
          retention_months: _ret.months,
          retention_last: _retLast,
          retention_cutoff: expCutoff(_ret.months),
          retention_ready: _retReady,
        });
      }

      /* ═══ v10.23 银行邮件解析自检（一键在 App 里跑）═══
         使用者要求：validation.mjs 那套没法在手机上跑（它读源码、跑 Playwright，是**部署前**的事），
         但「我的银行邮件到底解析对不对」这层——线上的 Worker 手上就有全部 13 支 parser——可以**一键跑**。
         这支端点拿一组**真实样本**喂进真的 parseRaw，比对 source/type/商家/金额，回 {ok, pass, total, fails}。
         ⚠️ 只读：纯解析，不碰 DB、不写账、不去重（跟收信那条链完全隔开，跑一百遍也不会多一笔账）。
         ⚠️ 样本要**跟 validation.mjs 的口径一致**：加了新 parser / 改了商家规则，两边一起加一行。 */
      if (path === "/api/selftest" && request.method === "GET") {
        /* [名字, 邮件, from, 期望source, 期望type, 期望商家, 期望金额] —— 全是真实样本 */
        const CASES = [
          ["OCBC 卡消费", `Dear Valued Customer\nWe wish to inform you that SGD3.80 was charged at 19:53 on 06-Aug-26 to your card (-3578) at SG MUYOO.\nOCBC`, "notifications@ocbc.com", "ocbc", "expense", "SG MUYOO", 3.8],
          ["OCBC 卡·网址名", `Dear Valued Customer\nWe wish to inform you that SGD9.90 was charged at 21:31 on 10-Aug-26 to your card (-3578) at www.anywheel.sg Singapore.\nOCBC`, "notifications@ocbc.com", "ocbc", "expense", "www.anywheel.sg Singapore", 9.9],
          ["OCBC 提款", `OCBC Bank\nAlert: Withdrawal Made\nA sum of SGD 60.46 has been withdrawn from your account (-857001) at 5:12 AM on 07 Aug 2026.`, "notifications@ocbc.com", "ocbc", "expense", "Alipay*RED Note", 60.46],
          ["OCBC 存款→Refund收入", `OCBC Alert: Deposit in your account\nA deposit was made in your account.\nTime of deposit: 5:23 AM\nAmount: SGD 6.42\nAccount that money was deposited in: (-857001)\nReference: 06/08/26\nOCBC`, "notifications@ocbc.com", "ocbc", "income", "Refund", 6.42],
          ["OCBC PayNow付款·数字开头名", `Dear Valued Customer\nThe following PayNow transfer has been made to 96SUPER GRADE PTE. LTD. using UEN 201323161C.\nDate\n: 09 Jul 2026\nTime\n: 20:59 PM SGT\nAmount\n: SGD 62.00\nReference number\n: 2607090114048000\nOCBC`, "notifications@ocbc.com", "paynow", "expense", "96SUPER GRADE PTE. LTD.", 62],
          ["DBS PayLah 消费", `DBS PayLah!\nTo : NTUC FAIRPRICE\nAmount : SGD 10.00\nDate & Time : 07 Aug 2026 12:41 (SGT)\nTransaction Ref : IP2608071241099`, "notify@dbs.com", "dbs", "expense", "NTUC FAIRPRICE", 10],
          ["DBS PayNow 收款→收入", `digibank Alerts\nYou have received SGD 30.00 via PayNow on 07 Aug 2026 17:18 SGT.\nFrom: CHAN YI SHENG\nTo: Your DBS account ending 7344\nDBS Bank Ltd`, "ibanking.alert@dbs.com", "dbs", "income", "CHAN YI SHENG", 30],
          ["PayLah 退款→收入", `Transaction Ref: 260810215418MC859446\nWe refer to your PayLah! refund transaction below.\nDate & Time: 10 Aug21:54 (SGT)\nAmount: SGD 0.70\nFrom: BCRS LTD\nTo: PayLah! Wallet\nDBS Bank Ltd`, "paylah@dbs.com", "dbs", "income", "BCRS LTD", 0.7],
          ["MariBank 付款", `MariBank\nYou have made a payment to Alipay*Taobao on your credit card ending 5831.\nTransaction Time:\n02 Aug 2026 16:51 SGT\nAmount:\nCNY 20.00`, "no-reply@maribank.sg", "maribank", "expense", "Alipay*Taobao", 20],
          ["MariBank 退款→收入", `MariBank\nYou have received a refund on 04 Aug 2026 18:57 SGT to your credit card ending 5831.\nMerchant Name:\nAlipay*RED Note\nRefunded Amount:\nCNY 5.00`, "no-reply@maribank.sg", "maribank", "income", "Alipay*RED Note", 5],
          ["NETS QR", `OCBC\nThe following NETS QR payment has been made:\nAmount : SGD 4.50\nDate : 04 Aug 2026\nTime : 01:16pm SGT\nTo : FU HUI COOKED FOOD\nReference number : 2608040116129894\nNETS merchant ID : 11169856600`, "notifications@ocbc.com", "paynow", "expense", "FU HUI COOKED FOOD", 4.5],
          ["PayNow 转人·数字环绕不串", `PayNow transfer\nThe following PayNow transfer has been made.\nDate : 14 Jul 2026\nTime : 13:22 PM SGT\nAmount : SGD 62.00\nTo : ALICE TAN\nFrom your account : 360 Account (-862001)\nReference number : 2607140116147079`, "notifications@ocbc.com", "paynow", "expense", "ALICE TAN", 62],
          ["Wise 卡消费截图", `01:18\nPending\n346.91 CNY\nWeixin Panduo Platform\nShopping\nIf the merchant doesn't claim this payment by August 21, 2026, we'll automatically return your money.\nTransaction details\nWhen\nAugust 12, 2026 at 01:03\nWhich card\nInfinite Canvas, 0977\nAuthorised via\nManual entry`, "paste", "wise", "expense", "Weixin Panduo Platform", 346.91],
        ];
        let pass = 0; const fails = [];
        for (const [n, raw, fr, wSrc, wType, wMerch, wAmt] of CASES) {
          let r = [];
          try { r = parseRaw(raw, fr) || []; } catch (e) { fails.push(`${n}｜解析抛错：${(e && e.message) || e}`); continue; }
          const x = r[0];
          if (!x) { fails.push(`${n}｜读不到（应是 ${wSrc}/${wType}/${wMerch}）`); continue; }
          const gt = x.type || "expense";
          /* ⚠️ Number(wAmt)：CASES 是「字串一堆 + 最后一个数字」的混型阵列，型别检查把 wAmt 推成 string|number，
             `x.amount - wAmt` 就报 ts(2363)（算术右边得是数字）。wAmt 本来就是数字，Number() 是**跑起来的空操作**，
             只为把型别钉成 number、消掉编辑器那条红。 */
          if (x.source === wSrc && gt === wType && x.merchant === wMerch && Math.abs(x.amount - Number(wAmt)) < 0.001) pass++;
          else fails.push(`${n}｜期望 ${wSrc}/${wType}/${wMerch}/${wAmt}，实得 ${x.source}/${gt}/${x.merchant}/${x.amount}`);
        }
        return json({ ok: fails.length === 0, pass, total: CASES.length, fails, worker_ver: WORKER_VER });
      }

      /* v9.97 数据保留：GET 看状态；POST {on,months} 存开关；POST {action:'run'} 立即备份并清理一次。
         token 已在上面的闸门验过（body.token 或 ?token=），这里的 body 也是那次解析好的，别再 request.json()。 */
      if (path === "/api/retention" && request.method === "GET") {
        const st = await getRetention(env);
        const gd = await gdState(env);
        const ready = !!(gd && gd.refresh_token && gd.last_backup && (Date.now() - new Date(gd.last_backup).getTime()) < 40 * 86400000);
        let last = null; try { const rl = await env.DB.prepare("SELECT v FROM app_settings WHERE k='retention_last'").first(); if (rl) last = JSON.parse(rl.v); } catch (e) {}
        return json({ ok: true, on: st.on, months: st.months, cutoff: expCutoff(st.months), ready, last });
      }
      if (path === "/api/retention" && request.method === "POST") {
        if (body.action === "run") {
          /* 手动清理：先备份一次，成功了才删（删掉的都在这份备份里）。没连 Drive / 备份失败 → 什么都不删。 */
          let bk; try { bk = await gdBackup(env); } catch (e) { return json({ ok: false, error: "备份没成功，没删任何东西：" + (e && e.message ? e.message : e) }); }
          const sgt = new Date(Date.now() + 8 * 3600 * 1000); await putSetting(env, "backup_month", sgt.toISOString().slice(0, 7));
          const r = await purgeExpenses(env, true);
          await purgeInbox(env, true);   // v9.98 邮件跟着一起清（同一条一年线）· v10.4 带 backedUp（上面刚备份成功）
          return json({ ok: true, backedUp: true, ...r });
        }
        const cur = await getRetention(env);
        const on = (typeof body.on === "boolean") ? body.on : cur.on;
        const months = (body.months > 0) ? Math.min(60, Math.floor(body.months)) : cur.months;
        await putSetting(env, "retention", JSON.stringify({ on, months }));
        return json({ ok: true, on, months, cutoff: expCutoff(months) });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      console.log("api error:", e.stack || e.message);
      return json({ error: e.message }, 500);
    }
  },
};

/* ================= 工具 ================= */

async function putSetting(env, k, v) {
  await env.DB.prepare(
    `INSERT INTO app_settings (k, v, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=datetime('now')`
  ).bind(k, v).run();
}

/* ⚠️ 通用名黑名单（v4.2）
   抓不到收款人时会退回 "PayLah Transfer" —— 每一笔都长一样。
   要是把它学进商家记忆，会变成「所有 PayLah 转账都自动叫某某店 + 某个分类」，张冠李戴。
   所以这些 key 一律：不学、不套用。 */
/* v9.87 通用名（解析不到真商家时的退路）——这些**绝不**写进商家记忆，否则所有交易共用一条规则。
   ⚠️ 关键 bug 修复：以前 "TNG TRANSFER" 不在这里 → TnG 抓不到商家就退回它 → 每笔 DuitNow QR 共用同一条规则
   → Cold Stone 被记成 DAISO。现在把 TnG / DuitNow QR / 各银行 DuitNow 名字全列进来。 */
const GENERIC = ["PAYLAH TRANSFER", "PAYLAH WALLET", "PAYLAH", "TRANSFER", "MANUAL", "",
  "TNG TRANSFER", "TNG", "DUITNOW QR", "DUITNOW", "PAYNOW TRANSFER", "PAYNOW",
  "PUBLIC BANK DUITNOW QR", "MALAYAN BANKING DUITNOW QR", "MAYBANK DUITNOW QR",
  "MARIBANK"];   // v9.91 MariBank 抓不到商家时的退路名
function isGeneric(key) { return GENERIC.indexOf((key || "").toUpperCase().trim()) >= 0; }

/* ===== 餐饮(Food)特殊逻辑 =====
   Food 是系统分类。它的子分类**不进商家记忆**，而是每次按交易时间(新加坡时区)重新算。
   06:00-11:59 早餐 / 12:00-14:59 午餐 / 15:00-17:29 下午茶 / 17:30-20:59 晚餐 / 21:00-05:59 宵夜 */
const FOOD_KEY = "food";
function foodSub(ts) {
  let d = new Date(ts);
  if (isNaN(d.getTime())) return "晚餐";   // ⚠️ 要 .getTime()：isNaN() 收的是数字，直接丢 Date 编辑器会报 TS2345
  const sgt = new Date(d.getTime() + 8 * 3600 * 1000);   // 转成 SGT 挂钟时间来读小时
  const mins = sgt.getUTCHours() * 60 + sgt.getUTCMinutes();
  if (mins >= 360 && mins <= 719) return "早餐";     // 06:00–11:59
  if (mins >= 720 && mins <= 899) return "午餐";     // 12:00–14:59
  if (mins >= 900 && mins <= 1049) return "下午茶";  // 15:00–17:29
  if (mins >= 1050 && mins <= 1259) return "晚餐";   // 17:30–20:59
  return "宵夜";                                     // 21:00–05:59
}

/* display = 用户给这家商家取的名字（可空）。传 null 时不覆盖已有的名字。 */
async function putRule(env, key, category, display, sub, isHint) {
  await env.DB.prepare(
    `INSERT INTO merchant_rules (merchant_key, category, display, sub, is_hint) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(merchant_key) DO UPDATE SET
       category=excluded.category,
       display=COALESCE(excluded.display, merchant_rules.display),
       sub=COALESCE(excluded.sub, merchant_rules.sub),
       is_hint=excluded.is_hint,
       updated_at=datetime('now')`
  ).bind(key, category, display || null, sub || null, isHint ? 1 : 0).run();
}

/* 只在「支出 + 有商家 + 有分类」时才记规则。
   原版 category 为空也会写，而 merchant_rules.category 是 NOT NULL →
   直接抛错变 500，前端以为保存失败。 */
/* v4.0：origMerchant = 这笔账原本的商家名（银行给的那串）。
   用它当 key，把「用户改成什么名字 + 归到什么分类」都记下来。
   下次同一家再来邮件，email() 就会自动套上名字和分类。 */
/* v10.19 商家「默认抵扣支出」记忆（退款/返现）：只进 offset_rules，跟分类记忆完全分开。 */
async function putOffset(env, key, off) {
  await env.DB.prepare(
    `INSERT INTO offset_rules (merchant_key, offset) VALUES (?, ?)
     ON CONFLICT(merchant_key) DO UPDATE SET offset=excluded.offset, updated_at=datetime('now')`
  ).bind(key, off ? 1 : 0).run();
}
async function offsetForMerchant(env, merchant) {
  const k = merchantKey(merchant);
  if (!k || isGeneric(k)) return 0;
  try { const r = await env.DB.prepare("SELECT offset FROM offset_rules WHERE merchant_key=?").bind(k).first(); return r && r.offset ? 1 : 0; }
  catch (e) { return 0; }
}

async function rememberRule(env, type, merchant, category, origMerchant, sub, opts) {
  /* v10.19 收入：不写分类记忆（收入/支出两套分类，别污染），只把「这家要不要抵扣支出」记进 offset_rules。
     记住原本那串（银行给的）和用户改的名字两个 key，跟分类记忆同样的双 key 策略。 */
  if (type === "income") {
    const off = opts && opts.offset ? 1 : 0;
    const base = origMerchant || merchant;
    for (const k of [merchantKey(base), merchantKey(merchant)]) {
      if (k && !isGeneric(k)) await putOffset(env, k, off);
    }
    return;
  }
  if (!category) return;
  if (category === FOOD_KEY) sub = null;   // 餐饮的子分类按时间算，绝不记进商家记忆
  const base = origMerchant || merchant;
  if (!base) return;
  /* v9.72 人 vs 商家：
     opts.lockPerson===true  → 用户明确要「记住这个名字的分类」→ 当硬规则（像商家）
     opts.isPerson===true    → 转账给人，没勾锁 → 写 is_hint=1（只当下次预填提示，不锁死）
     其他（商家）             → 硬规则，旧行为不变。 */
  const isHint = !!(opts && opts.isPerson && !opts.lockPerson);
  const display = (merchant && merchant !== base) ? merchant : null;
  const k1 = merchantKey(base);          // 银行原本那串 → 下次邮件进来自动套名字+分类
  const k2 = merchantKey(merchant);      // 用户取的新名字 → 手动记账打这个名字也能自动分类
  if (k1 && !isGeneric(k1)) await putRule(env, k1, category, display, sub, isHint);
  if (k2 && k2 !== k1 && !isGeneric(k2)) await putRule(env, k2, category, display, sub, isHint);
}

// 不早退的比较，别让人用响应时间试 token
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function streamToText(stream) {
  return await new Response(stream).text();
}

/* ════════ v8.7 Web Push（VAPID，不带内容）════════
   为什么不带内容：带的话要照 RFC 8291 做 aes128gcm 加密（ECDH + HKDF + AES-GCM），
   一大坨还容易出错。不带内容 → 只要签一个 VAPID JWT 就能推 → SW 收到自己回头 fetch。
   ⚠️ 需要两个 Secret：VAPID_PUBLIC（也编进前端）、VAPID_PRIVATE（JWK JSON，绝不进前端）。 */
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function vapidKey(env) {
  const jwk = JSON.parse(env.VAPID_PRIVATE);
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}
/* v10.30 确定性判断：VAPID_PUBLIC 跟 VAPID_PRIVATE **是不是同一对密钥**。
   P-256 私钥 JWK 里本来就带公钥坐标 x,y → 拼成未压缩公钥 0x04||x||y、base64url，就该等于 VAPID_PUBLIC。
   不相等 = 两个 Secret 不是一对（订阅用一把公钥、签名用另一把私钥）→ Apple 必回 403。回 true/false/null(私钥不是合法JWK)。
   ⚠️ 这是「以前能现在不能、我又没改」最可能的真凶：之前某次换过密钥、只更了一个 env。 */
function b64uToBytes(s) {
  let t = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const bin = atob(t); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function vapidKeymatch(env) {
  try {
    if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return null;
    const jwk = JSON.parse(env.VAPID_PRIVATE);
    if (!jwk.x || !jwk.y) return null;
    const x = b64uToBytes(jwk.x), y = b64uToBytes(jwk.y);
    if (x.length !== 32 || y.length !== 32) return null;
    const raw = new Uint8Array(65); raw[0] = 0x04; raw.set(x, 1); raw.set(y, 33);
    const norm = (v) => String(v || "").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return norm(b64u(raw)) === norm(env.VAPID_PUBLIC);
  } catch (e) { return null; }
}
/* VAPID JWT：aud = 推送服务的 origin，exp 最多 24h（Apple 会检查） */
async function vapidJWT(env, aud) {
  const header = b64u(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64u(new TextEncoder().encode(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUB || "mailto:admin@example.com",
  })));
  const data = new TextEncoder().encode(header + "." + payload);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await vapidKey(env), data);
  return header + "." + payload + "." + b64u(sig);   // WebCrypto 出来就是 raw r||s，正好是 JWS 要的
}
/* 推一下（不带内容）。回 {status, reason}：404/410 = 订阅死了要清掉；
   v10.30 非 2xx 时**把推送服务回的正文一起带回来** —— Apple 的 403 正文会写明是 `BadJwtToken`（JWT 声明/ sub 不对）
   还是 `InvalidToken`（密钥对不上），这两句话直接指向不同的修法，不用再靠猜。 */
async function pushOne(env, endpoint) {
  const aud = new URL(endpoint).origin;
  const jwt = await vapidJWT(env, aud);
  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      TTL: "600",                                   // 10 分钟内送不到就算了（提醒过时就没意义）
      Urgency: "high",
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC}`,
      "Content-Length": "0",
    },
  });
  let reason = "";
  if (r.status < 200 || r.status >= 300) { try { reason = ((await r.text()) || "").replace(/\s+/g, " ").trim().slice(0, 160); } catch (e) {} }
  return { status: r.status, reason };
}
async function pushAll(env) {
  const rs = await env.DB.prepare("SELECT endpoint FROM push_subs").all();
  const subs = rs.results || [];
  let ok = 0, gone = 0, reason = "";
  const codes = {};   // v10.28 记下推送服务回的状态码分布 → 前端好分辨「过期(410)/密钥不对(401/403)/其它」，把「发送失败」变成看得懂的原因
  for (const s of subs) {
    try {
      const res = await pushOne(env, s.endpoint);
      const st = res.status;
      if (st === 404 || st === 410) {               // 订阅已失效（app 被删/重装、iOS 悄悄换掉订阅）→ 清掉
        await env.DB.prepare("DELETE FROM push_subs WHERE endpoint=?").bind(s.endpoint).run();
        gone++; codes[st] = (codes[st] || 0) + 1;
      } else if (st >= 200 && st < 300) {
        await env.DB.prepare("UPDATE push_subs SET last_ok=datetime('now'), fails=0 WHERE endpoint=?").bind(s.endpoint).run();
        ok++;
      } else {
        await env.DB.prepare("UPDATE push_subs SET fails=fails+1 WHERE endpoint=?").bind(s.endpoint).run();
        codes[st] = (codes[st] || 0) + 1;
        if (!reason && res.reason) reason = res.reason;   // v10.30 留下推送服务的第一句错误正文（Apple 会写明 BadJwtToken / InvalidToken）
      }
    } catch (e) { console.log("push err:", e.message); codes.err = (codes.err || 0) + 1; if (!reason) reason = String((e && e.message) || "").slice(0, 160); }
  }
  return { subs: subs.length, ok, gone, codes, reason };
}

/* ════════ v9.0 多重提醒 + 「只改这一次」的读写 ════════
   ⚠️ 这四个 helper 的规则必须跟 index.html 里那份**一模一样**，改一边就要改另一边。
   设计原则：脏资料一律吞掉当没有，绝不让一笔坏 JSON 把整个日历弄挂。 */
const HM_RE = /^\d{2}:\d{2}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/* ⚠️ DAY_RE 只看长相：'2026-13-99'（13 月 99 号）照样通过。
   例外日 / mod 的 key 是**绝对日期**，塞进去的假日期永远匹配不到任何一次 → 变死资料，
   而且会一直躺在那一栏里越堆越大。isDay() 用来回转一次真的挡掉。 */
function isDay(v) {
  const t = String(v || "");
  if (!DAY_RE.test(t)) return false;
  const d = new Date(t + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t;
}
/* 提醒清单：只收 0..20160（14 天）的整数，去重、由远到近排、最多 5 个。
   由远到近 = [1440, 30]（前1天、前30分）→ 存进 notify_min 的是最后那个（最靠近事件的）。 */
function nlClean(v) {
  if (!Array.isArray(v)) return [];
  const set = new Set();
  for (const x of v) {
    const n = Number(typeof x === "object" && x ? x.m : x);
    if (Number.isFinite(n) && n >= 0 && n <= 20160) set.add(Math.round(n));
  }
  return [...set].sort((a, b) => b - a).slice(0, 5);
}
/* 读回来：notifs 是 null（旧资料）→ 退回 notify_min，行为跟 v8.x 完全一样 */
function nlRead(raw, fallbackMin) {
  if (raw) {
    try {
      const a = nlClean(JSON.parse(raw));
      if (a.length) return a;
    } catch (e) { /* 坏 JSON → 当没有 */ }
  }
  return fallbackMin == null ? [] : [Math.round(Number(fallbackMin) || 0)];
}
/* 「只改这一次」的差异表。允许覆写的栏位就这几个 —— 日期**不在里面**（见迁移那段的说明）。 */
const MOD_STR = { ti: 80, t: 5, et: 5, no: 200, k: 10 };
function modWrite(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out = {};
  let n = 0;
  for (const k of Object.keys(v)) {
    if (!isDay(k) || n >= 200) continue;            // 上限 200 天，免得这一栏无限长
    const src = v[k];
    if (!src || typeof src !== "object") continue;
    const m = {};
    if (typeof src.ti === "string" && src.ti.trim()) m.ti = src.ti.trim().slice(0, MOD_STR.ti);
    if (src.t === null || HM_RE.test(String(src.t || ""))) { if (src.t !== undefined) m.t = src.t || null; }
    if (src.et === null || HM_RE.test(String(src.et || ""))) { if (src.et !== undefined) m.et = src.et || null; }
    if (typeof src.no === "string") m.no = src.no.trim().slice(0, MOD_STR.no) || null;
    if (src.k === "reminder" || src.k === "event") m.k = src.k;
    if (src.nm != null) { const x = Number(src.nm); if (Number.isFinite(x) && x >= 0 && x <= 20160) m.nm = Math.round(x); }
    const nl = nlClean(src.nl);
    if (nl.length) m.nl = nl;
    if (Object.keys(m).length) { out[k] = m; n++; }
  }
  return n ? JSON.stringify(out) : null;
}
/* ════ v9.0 重复规则 → DB 那几栏。
   ⚠️ POST /api/event 和 /api/import **共用这一份**。
   以前 import 根本没处理 rep_*：备份还原回来，所有「每周 Gym」「生日」全部变成一次性事项，
   而且完全不报错 —— 你要等到翻下个月发现生日不见了才知道。这种 bug 最恶心。 */
const RT_OK = ["day", "week", "month", "year"];
function repCols(rep) {
  if (!rep || RT_OK.indexOf(rep.t) < 0) return { rt: null, ri: null, rd: null, ru: null, rx: null, rm: null };
  return {
    rt: rep.t,
    ri: Math.max(1, Math.min(99, Math.round(Number(rep.i) || 1))),
    rd: rep.t === "week" && Array.isArray(rep.d) && rep.d.length
      ? rep.d.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6).sort().join(",") : null,
    ru: isDay(rep.until) ? String(rep.until) : null,
    rx: Array.isArray(rep.ex) && rep.ex.length
      ? rep.ex.filter(isDay).join(",") || null : null,
    rm: modWrite(rep.mod),
  };
}
/* 备份档里的一笔可能是「DB 原始栏位」（rep_type / rep_ex …）也可能是「前端形状」（rep:{t,i,…}）
   —— 备份是前者，手动贴 JSON 可能是后者 → 两种都收。 */
function repFromRow(e) {
  if (e.rep && typeof e.rep === "object") return e.rep;
  if (!e.rep_type) return null;
  return {
    t: e.rep_type,
    i: e.rep_int || 1,
    d: e.rep_days ? String(e.rep_days).split(",").filter(Boolean).map(Number) : null,
    until: e.rep_until || null,
    ex: e.rep_ex ? String(e.rep_ex).split(",").filter(Boolean) : null,
    mod: modRead(e.rep_mod),
  };
}
function modRead(raw) {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return (o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length) ? o : null;
  } catch (e) { return null; }
}
/* 把「这一次」的差异盖上去 → 回传这一次真正的样子 */
function modApply(e, occDay) {
  const m = e.rep && e.rep.mod && e.rep.mod[occDay];
  if (!m) return e;
  const o = { ...e };
  if (m.ti) o.title = m.ti;
  if (m.t !== undefined) o.time = m.t;
  if (m.et !== undefined) o.etime = m.et;
  if (m.no !== undefined) o.note = m.no;
  if (m.k) o.kind = m.k;
  if (m.nm != null) o.notify_min = m.nm;
  if (m.nl && m.nl.length) o.nl = m.nl;
  return o;
}

/* ════════ v8.7 到期的提醒 ════════
   ⚠️ 重复事项的 occurrence 是「前端现算」的 → worker 这边必须有同一套算法，
   不然重复的提醒永远不会响。这份是 index.html 那份的移植版，改任何一边都要同步改另一边。 */
const SGT = 8 * 3600 * 1000;
const wIso = (ms) => new Date(ms + SGT).toISOString().slice(0, 10);
const wIdx = (k) => Math.round(Date.parse(k + "T00:00:00+08:00") / 86400000);
const wDay = (i) => wIso(i * 86400000 - SGT);
const wWd = (k) => ((wIdx(k) % 7) + 7 + 4) % 7;
const wAdd = (k, n) => wDay(wIdx(k) + n);
const wHm = (v) => { const p = String(v || "0:0").split(":"); return (+p[0] || 0) * 60 + (+p[1] || 0); };

function wOccur(e, from, to) {
  const r = e.rep;
  if (!r || !r.t) return (e.day >= from && e.day <= to) ? [e.day] : [];
  const out = [], int = Math.max(1, r.i || 1), until = r.until || null;
  const ex = r.ex && r.ex.length ? r.ex : null;
  const push = (k) => {
    if (k >= e.day && (!until || k <= until) && k >= from && k <= to && !(ex && ex.indexOf(k) >= 0) && out.length < 200) out.push(k);
  };
  if (r.t === "day") {
    let n = Math.max(0, Math.ceil((wIdx(from) - wIdx(e.day)) / int));
    for (; ; n++) { const k = wAdd(e.day, n * int); if (k > to || (until && k > until)) break; push(k); if (out.length >= 200) break; }
  } else if (r.t === "week") {
    const days = (r.d && r.d.length) ? r.d.slice().sort() : [wWd(e.day)];
    const anchor = wIdx(e.day) - wWd(e.day), step = int * 7;
    let n = Math.max(0, Math.floor((wIdx(from) - anchor) / step));
    for (; ; n++) { const wk = anchor + n * step; if (wk > wIdx(to)) break; days.forEach((d) => push(wDay(wk + d))); if (out.length >= 200) break; }
  } else {
    const y0 = +e.day.slice(0, 4), m0 = +e.day.slice(5, 7) - 1, d0 = +e.day.slice(8, 10);
    const stepM = (r.t === "year" ? 12 : 1) * int;
    const monthsTo = (+to.slice(0, 4) - y0) * 12 + (+to.slice(5, 7) - 1 - m0);
    for (let n = 0; ; n++) {
      const mm = n * stepM; if (mm > monthsTo + stepM) break;
      const dt = new Date(Date.UTC(y0, m0 + mm, 1)), y = dt.getUTCFullYear(), m = dt.getUTCMonth();
      const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      if (d0 > dim) continue;                       // 31 号在 2 月 → 跳过（跟前端一致）
      push(`${y}-${String(m + 1).padStart(2, "0")}-${String(d0).padStart(2, "0")}`);
      if (out.length >= 200) break;
    }
  }
  return out;
}
/* 算「这一次」该在什么时候通知（回传 epoch ms）。
   全天：基准点是当天 09:00（前端 NOTIFY_ALLDAY 就是这个约定）。 */
function wNotifyAt(e, occDay) {
  const base = Date.parse(occDay + "T" + (e.time || "09:00") + ":00+08:00");
  return base - (e.notify_min || 0) * 60000;
}
/* 「提前 N 分钟」→ 人话。放进 body 里，一眼知道这则是「前1天」还是「快到了」。 */
function wLead(m, timed) {
  if (m == null) return "";
  if (!timed) return m === 0 ? "" : (m === 1440 ? "前1天" : m === 2880 ? "前2天" : m === 10080 ? "前1周" : "");
  if (m === 0) return "现在";
  if (m < 60) return `还有 ${m} 分钟`;
  if (m < 1440) return `还有 ${m / 60} 小时`;
  return `还有 ${m / 1440} 天`;
}
/* 找出 (from, to] 这个窗口里该通知的。
   窗口是「上次扫到现在」→ cron 漏跑也能补上；但不翻超过 30 分钟的旧帐，免得洗版。 */
/* ============ ② v9.11 每周周报（挂现有 5 分钟 cron，不新增 cron） ============ */
function sgtDayKey(ts) { return new Date(new Date(ts).getTime() + 8 * 3600000).toISOString().slice(0, 10); }
/* ═══ v9.94 汇率清单（跟前端 FX_DEF / FX_APPROX 是同一份口径，改一边记得改另一边）═══
   FX_WANT   = 去 frankfurter 要哪些币。它支持的就这些，多写会整包 400。
               ⚠️ **没有 TWD / VND / MOP / BND**（ECB 不发布），所以它们不在这张清单里。
   FX_FALLBACK = 保底值。前四个是 ECB 拉不到时的垫底；TWD/VND/MOP/BND 是**永远**只有保底值。
               量级正确、不是实时，前端会在那笔的换算旁边标一个「约」。
   ⚠️ 为什么非要保底不可：前端 sgdOf() 查不到汇率时会退回 1:1 ——
      一笔 TWD 350 会被算成 S$350（实际约 S$14，虚报 25 倍），而且悄无声息。 */
const FX_WANT = ["USD","MYR","CNY","HKD","JPY","KRW","THB","EUR","GBP","AUD","NZD","CAD","CHF","PHP","IDR","INR"];
const FX_FALLBACK = { SGD: 1, USD: 1.35, MYR: 0.30, CNY: 0.18, HKD: 0.17, JPY: 0.0086, KRW: 0.00097,
  THB: 0.039, EUR: 1.46, GBP: 1.70, AUD: 0.87, NZD: 0.79, CAD: 0.96, CHF: 1.58, PHP: 0.023,
  IDR: 0.000082, INR: 0.0155, TWD: 0.041, VND: 0.000051, MOP: 0.167, BND: 1 };
/* 旧名保留：底下 fxRates() 还在用，别改动到它的呼叫点。 */
const FX_DEF = FX_FALLBACK;
async function fxRates(env) {
  try { const r = await env.DB.prepare("SELECT v FROM app_settings WHERE k='fx'").first();
    /* v9.92 合并不覆盖：缓存里缺的币种（刚加 CNY 那阵子就会缺）由 FX_DEF 补上，
       否则导出/报表那边 CNY 会被当成 1:1 换算。 */
    if (r) { const j = JSON.parse(r.v); if (j && j.rates) return { ...FX_DEF, ...j.rates }; } } catch (e) {}
  return { ...FX_DEF };
}
// v9.27 分类 key→中文名的内建默认（照抄前端 CAT_DEF/INC_DEF）。
// 作用：就算用户没自定义分类、或删过分类，周报也翻得出中文，不会漏英文 key。
const CAT_NAMES = {
  food: "餐饮", fruit: "水果", snack: "零食", beauty: "美妆", daily: "日用",
  shop: "购物", transport: "交通", fun: "娱乐", home: "家用", reno: "装修",
  travel: "旅游", health: "医疗", other: "其他",
  salary: "工资", bonus: "奖金", invest: "理财", incother: "其他",
};
async function catNameMap(env) {
  const m = { ...CAT_NAMES };                 // 先垫默认名
  try { const r = await env.DB.prepare("SELECT v FROM app_settings WHERE k='categories'").first();
    if (r) { const j = JSON.parse(r.v);
      // ⚠️ 前端存的是嵌套结构 {expense:{key:{n}}, income:{key:{n}}} —— 两层都要并进来。
      // （之前直接 for(k in j) 只遍历到 expense/income 两个壳，自定义/改名分类全翻不到 → 周报显示「其他」）
      for (const grp of [j.expense, j.income]) {
        if (grp && typeof grp === "object") for (const k in grp) if (grp[k] && grp[k].n) m[k] = grp[k].n;
      }
      // 向后兼容：万一是旧的扁平结构 {key:{n}}
      for (const k in j) if (j[k] && j[k].n) m[k] = j[k].n;
    }
  } catch (e) {}
  return m;
}
/* 上周（SGT 周一→周日）汇总 + 跟前一周比。只读 expenses，绝不写账。 */
async function weeklyDigest(env) {
  const sgt = new Date(Date.now() + 8 * 3600000);
  const dow = sgt.getUTCDay();                                  // 已 +8，用 UTC 读 = SGT 星期；0=日,1=一
  const todayIdx = Math.floor(sgt.getTime() / 86400000);
  const monIdx = todayIdx - ((dow + 6) % 7);                    // 本周一的天索引
  const dk = i => new Date(i * 86400000).toISOString().slice(0, 10);
  const lwStart = dk(monIdx - 7), lwEnd = dk(monIdx - 1);       // 上周一→上周日
  const monthStart = `${sgt.getUTCFullYear()}-${pad(sgt.getUTCMonth() + 1)}-01`;   // 当月1号（SGT）
  const rates = await fxRates(env);
  const sgd = r => { const rt = rates[r.currency]; return r.amount * (typeof rt === "number" && rt > 0 ? rt : 1); };
  // 下界取「上周前 4 周」和「当月1号」里更早的那个 —— 覆盖「跟平常比」和「预算」两项，仍是 string 下界、便宜。
  const base = dk(monIdx - 35);
  const lo = base < monthStart ? base : monthStart;
  const rs = await env.DB.prepare("SELECT ts, amount, currency, type, category, merchant FROM expenses WHERE ts >= ?").bind(lo).all();
  const rows = (rs.results || []).filter(r => r.type !== "income");
  const diOf = d => Math.round(Date.parse(d + "T00:00:00Z") / 86400000);
  let lw = 0, baseSum = 0; const byCat = {}, monthCat = {}; const baseWeeks = new Set(); let big = null;
  for (const r of rows) {
    const d = sgtDayKey(r.ts), v = sgd(r), di = diOf(d);
    if (d >= lwStart && d <= lwEnd) { lw += v; const c = r.category || "other"; byCat[c] = (byCat[c] || 0) + v; if (!big || v > big.v) big = { v, m: r.merchant }; }
    else if (di >= monIdx - 35 && di <= monIdx - 8) { baseSum += v; baseWeeks.add(Math.floor((monIdx - 8 - di) / 7)); }   // 上周之前 4 周
    if (d >= monthStart) { const c = r.category || "other"; monthCat[c] = (monthCat[c] || 0) + v; }                       // 当月至今按分类（预算用）
  }
  const topCat = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0] || null;
  // 「跟平常比」：上周 vs 前 4 周的每周平均（≥2 周有数据才算，避免新用户没基准）
  const wk = baseWeeks.size; const avgWk = wk >= 2 ? baseSum / wk : null;
  // 预算：当月至今哪个分类已超月上限（挑超得最多的一个）
  let budgetWarn = null;
  try { const br = await env.DB.prepare("SELECT v FROM app_settings WHERE k='budgets'").first();
    if (br) { const bud = JSON.parse(br.v) || {}; let worst = 0;
      for (const c in bud) { const lim = +bud[c], spent = monthCat[c] || 0;
        if (lim > 0 && spent > lim && (spent - lim) > worst) { worst = spent - lim; budgetWarn = { cat: c, spent, lim }; } }
    } } catch (e) {}
  return { lw, topCat, big, avgWk, budgetWarn, lwStart, lwEnd, hasData: lw > 0 };
}
/* v10.33 周报正文改成【多行】—— 以前一长串「· 」挤在一起看着乱。
   iOS 通知收起时只显示第一行，所以把「总花 + 跟平常比」这条核心放第一行，展开才看细项。 */
function weeklyBody(dg, catMap) {
  const fmt = n => (Math.round(n * 100) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  // 第一行（收起时就看这条）：上周总花 + 跟「平常」（前 4 周平均）比
  let head = `上周共花 S$${fmt(dg.lw)}`;
  if (dg.avgWk > 0) { const pc = Math.round((dg.lw - dg.avgWk) / dg.avgWk * 100);
    if (Math.abs(pc) < 5) head += "，跟平常差不多";
    else if (Math.abs(pc) >= 200) head += pc > 0 ? "，比平常多不少" : "，比平常省不少";
    else head += `，比平常${pc > 0 ? "多" : "少"} ${Math.abs(pc)}%`; }
  const lines = [head];
  if (dg.topCat) lines.push(`最多：${(catMap && catMap[dg.topCat[0]]) || "其他"} S$${fmt(dg.topCat[1])}`);
  if (dg.big) { const m = (dg.big.m || "").slice(0, 20).trim(); lines.push(`最大一笔：S$${fmt(dg.big.v)}${m ? " · " + m : ""}`); }
  if (dg.budgetWarn) { const b = dg.budgetWarn; lines.push(`⚠️ ${(catMap && catMap[b.cat]) || "某分类"}超预算 ${fmt(b.spent)}/${fmt(b.lim)}`); }
  return lines.join("\n");
}

async function dueReminders(env, fromMs, toMs) {
  /* ⚠️ v9.0：kind 的筛选拿掉 'AND notify_min IS NOT NULL' 之外还要考虑
     「某一次被改成 reminder」的情况 → 但那种情况原记录 kind 仍是 'reminder' 才谈得上，
     所以这里维持只捞 reminder，跟 v8.x 一致（「把某一次从 event 改成 reminder」不支援，
     那本来就该是另一件事）。 */
  const rs = await env.DB.prepare(
    "SELECT id, day, time, title, note, end_day, end_time, notify_min, notifs, rep_type, rep_int, rep_days, rep_until, rep_ex, rep_mod FROM events WHERE kind='reminder' AND (notify_min IS NOT NULL OR notifs IS NOT NULL)"
  ).all();
  const lo = wIso(fromMs - 8 * 86400000), hi = wIso(toMs + 2 * 86400000);
  const out = [];
  for (const x of (rs.results || [])) {
    const e = {
      id: x.id, day: x.day, time: x.time || null, title: x.title, note: x.note || null,
      notify_min: x.notify_min || 0,
      nl: nlRead(x.notifs, x.notify_min),          // v9.0 多重提醒
      rep: x.rep_type ? {
        t: x.rep_type, i: x.rep_int || 1,
        d: x.rep_days ? String(x.rep_days).split(",").filter(Boolean).map(Number) : null,
        until: x.rep_until || null,
        ex: x.rep_ex ? String(x.rep_ex).split(",").filter(Boolean) : null,
        mod: modRead(x.rep_mod),                   // v9.0「只改这一次」
      } : null,
    };
    for (const k of wOccur(e, lo, hi)) {
      /* ⚠️ 这一次如果被单独改过（时间/标题/提醒）→ 通知要照改过的来，不然会在旧时间响 */
      const o = modApply(e, k);
      const mins = (o.nl && o.nl.length) ? o.nl : [o.notify_min || 0];
      for (const m of mins) {
        const at = wNotifyAt({ time: o.time, notify_min: m }, k);
        if (at > fromMs && at <= toMs) {
          const when = o.time ? `${k} ${o.time}` : `${k} 全天`;
          const lead = wLead(m, !!o.time);
          out.push({
            /* id 里带上分钟数 → 同一件事的「前1天」和「前30分」是两则，不会互相盖掉（sw.js 拿它当 tag） */
            id: `${e.id}:${k}:${m}`,
            title: `🔔 ${o.title}`,
            body: (o.note ? `${when} · ${o.note}` : when) + (lead ? ` · ${lead}` : ""),
            day: k,
          });
        }
      }
    }
  }
  return out;
}

function merchantKey(m) {
  return (m || "").toUpperCase().replace(/[#_].*$/, "").replace(/\s+\d[\d\s-]*$/, "")
    .replace(/\b(SIN|SG|SINGAPORE|PTE|LTD)\b/g, "").replace(/\s+/g, " ").trim();
}

const MON = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
const pad = (n) => String(n).padStart(2, "0");

// 邮件里只有「12 Jul」没年份。原版用 UTC 判断当前月，新加坡 00:00–08:00 之间
// UTC 还停在昨天，月底/年底会把年份算错。改用 SGT。
function guessYear(mon) {
  const sg = new Date(Date.now() + 8 * 3600 * 1000);
  const y = sg.getUTCFullYear(), cur = sg.getUTCMonth() + 1;
  if (mon - cur > 6) return y - 1;   // 1 月收到 12 月的邮件
  if (cur - mon > 6) return y + 1;   // 12 月收到 1 月的邮件
  return y;
}

// "9:05" → "09:05"。原版不补零，ts 会变成 ...T9:05:00+08:00，
// 不是合法 ISO，iOS Safari 的 new Date() 直接 Invalid Date。
function pad2h(hm) {
  const p = hm.split(":");
  return pad(parseInt(p[0], 10)) + ":" + p[1];
}

/* ---- 邮件预处理（v4.2）----
   DBS 的通知是 **HTML 表格**邮件，长这样：
     <tr><td>To:</td><td>MING HE FISH SOUP</td></tr>
   老版本直接拿原始 MIME 去跑正则，`To:` 后面紧跟的是 `</td><td>` 而不是空格，
   所以收款人**永远抓不到**，全部退回成 "PayLah Transfer" —— 商家记忆也就永远学不会。
   现在先把 quoted-printable 解码、再把 HTML 拆成一行一行的纯文本，然后才解析。 */
function decodeQP(s, charset) {
  /* v10.11 以前只解 ASCII（32–126），非 ASCII 的 =XX 原样留着 → 中文/emoji/重音商家名会变乱码。
     改成业界标准做法（emailjs / libmime 那套）：先拿掉软换行，把 =XX 和字面字元都还原成「字节」，
     整串字节再按 UTF-8 解码。这样多字节字元（一个字 = 好几个 =XX）才能正确拼回来。 */
  s = String(s).replace(/=\r?\n/g, "");                       // 软换行
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2;   // =XX → 一个字节
    } else {
      const c = s.charCodeAt(i);
      if (c < 256) { bytes.push(c); }                         // QP 的字面部分保证是 ASCII
      else {
        /* ⚠️⚠️ v10.13 这里以前是 `charCodeAt(i) & 0xff` —— 对**真的 QP 文字**没问题（QP 的定义
           就是纯 ASCII），但这支被**重复调用**：mimeSection 已经解过一次 QP，htmlToLines 又解一次。
           第二次进来时「陈」已经是一个 U+9648 的字元，& 0xff 把它砍成 0x48 = "H" ——
           实测「陈小明」→ "H\u000f\u000e"。这就是你说的「存进邮箱是乱码」的第二个来源
           （第一个是整封信头，v10.12 已修）。现在多字节字元原样转回 UTF-8 字节，
           解码回来还是它自己 → 再解几次都不会坏。 */
        for (const b of new TextEncoder().encode(s[i])) bytes.push(b);
      }
    }
  }
  /* v10.12：多一个 charset 参数（MIME 里的 charset=）。不传 = utf-8 = 跟旧版一字不差。 */
  const out = decodeBytes(new Uint8Array(bytes), charset);
  return out === null ? s : out;
}

/* ═══════════════════════════════════════════════════════════════════
   v10.12 MIME 正文抽取 —— 这一组是「乱码 + 读不到金额 + 假重复」三个症状的共同根
   ═══════════════════════════════════════════════════════════════════
   ⚠️ 背景（实测，不是推论）：email() 从 v1 起就是把 **整封 MIME 原文**（Received / ARC-Seal /
   ARC-Message-Signature / DKIM 那一大坨信头 + 可能是 base64 的正文）直接
   ①喂给 parser、②`raw.slice(0,8000)` 存进收件箱。两个后果：

   ① 「假重复」：parsePayNow 的参考号正则 `(?:Reference…|Ref)\s*:?\s*([A-Za-z0-9]{6,})`
      扫的是整封原文，而**信头永远排在正文前面** → 正则一定先咬到信头。实测：
      ARC/DKIM 签名的 `h=to:subject:…:references:dkim-signature` 那串里，
      `Ref` 后面接 `erences` 正好 7 个字母 → 抓出参考号 `"erences"` → hash 变成
      `paynow:erences` → **每一封这种信 hash 都一样** → 第一封记进去之后，
      后面每一封都被 `INSERT OR IGNORE` 当成重复静默丢掉。跟金额、商家、时间全都无关。
   ② 「乱码 + 读不到金额」：正文若是 base64（银行信很常见），全档没有任何一处解 base64
      （只解 quoted-printable）→ 金额抓不到 → 掉进「读不到」；而给你看的原文就是
      Received/ARC-Seal 那堆信头 —— 就是你说的「我根本看不懂的乱码」。

   正解只有一个：**先把可读正文抽出来，再拿去解析和显示**。
   抽不出来（不是 MIME / 拆不动 / 解码失败）就原样退回原文 —— 保证「绝不比现在差」。 */
function decodeBytes(bytes, charset) {
  const cs = String(charset || "utf-8").toLowerCase().replace(/^["']|["']$/g, "").trim() || "utf-8";
  try { return new TextDecoder(cs).decode(bytes); }
  catch (e) { try { return new TextDecoder().decode(bytes); } catch (e2) { return null; } }
}
function decodeB64(s) {
  const clean = String(s).replace(/[^A-Za-z0-9+/=]/g, "");
  if (clean.length < 8) return null;
  try {
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch (e) { return null; }
}
/* 标题里的 `=?UTF-8?B?…?=` / `=?UTF-8?Q?…?=`（RFC 2047）。中文标题不解就是一串乱码，
   而标题是收件箱列表上你唯一看得见的东西。 */
function decodeMimeWords(s) {
  return String(s || "")
    .replace(/\?=[ \t]+=\?/g, "?==?")                       // 相邻编码词中间的空白要吃掉，不然中文会被切断
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, cs, enc, data) => {
      try {
        if (/b/i.test(enc)) { const b = decodeB64(data); return b ? (decodeBytes(b, cs) ?? m) : m; }
        return decodeQP(data.replace(/_/g, " "), cs);
      } catch (e) { return m; }
    });
}
/* 一个 MIME「段」= 信头 + 空行 + 内容。multipart 就递归拆。回空字串 = 这段没有可读文字。 */
function mimeSection(section, depth) {
  const cut = section.search(/\r?\n\r?\n/);
  if (cut < 0) return "";
  const head = section.slice(0, cut).replace(/\r?\n[ \t]+/g, " ");     // 折行接回来（信头可以跨行）
  const body = section.slice(cut).replace(/^\r?\n\r?\n/, "");
  const h = (name) => {
    const m = head.match(new RegExp("^" + name + "\\s*:\\s*(.*)$", "im"));
    return m ? m[1].trim() : "";
  };
  const ctRaw = h("Content-Type");
  const ct = ctRaw.toLowerCase();
  const cte = h("Content-Transfer-Encoding").toLowerCase();
  const csm = ctRaw.match(/charset\s*=\s*"?([\w-]+)"?/i);
  const charset = csm ? csm[1] : "utf-8";

  if (/^multipart\//.test(ct) && depth < 5) {
    const bm = ctRaw.match(/boundary\s*=\s*"?([^";]+)"?/i);
    if (!bm) return "";
    const bd = bm[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const chunks = body.split(new RegExp("\\r?\\n?--" + bd + "(?:--)?[ \\t]*\\r?\\n?"));
    const got = [];
    for (const c of chunks) {
      /* 段一定是「信头行」或「直接空行开头」；不是的话那是前言/结语那几句废话（"This is a
         multi-part message…"），丢掉。 */
      if (!/^([A-Za-z][A-Za-z0-9-]*\s*:|\r?\n)/.test(c)) continue;
      const t = mimeSection(c, depth + 1);
      if (t && t.trim()) got.push(t.trim());
    }
    return got.join("\n");
  }
  if (ct && !/^text\//.test(ct)) return "";                            // 图片 / 附件 → 不是给人看的
  if (/base64/.test(cte)) { const b = decodeB64(body); const t = b ? decodeBytes(b, charset) : null; return t || ""; }
  if (/quoted-printable/.test(cte)) return decodeQP(body, charset);
  if (/^text\//.test(ct) && charset && !/utf-?8/i.test(charset)) {      // 8bit/7bit 但不是 UTF-8（例如 big5）
    const bytes = new Uint8Array(body.length);
    for (let i = 0; i < body.length; i++) bytes[i] = body.charCodeAt(i) & 0xff;
    return decodeBytes(bytes, charset) || body;
  }
  return body;
}
/* 「这串东西是不是整封邮件原文」。两个条件都要：第一行是信头、而且有「空行」分隔头和体。
   截图 OCR 文字、粘贴的文字、以及**已经抽干净的正文**（行与行之间没有空行）都不会命中 →
   这一整套只对真的 MIME 动手，其余路径一个字节都不碰。 */
function looksLikeMime(s) {
  const t = String(s || "");
  return /^[A-Za-z][A-Za-z0-9-]*\s*:\s/.test(t) && /\r?\n\r?\n/.test(t);
}
/* ═══ v23.26 「新邮件干净、旧邮件还是一堆信头」的真正原因（node 实测复现，不是推论）═══
   之前的判断是「清理没在跑」。不是。v10.13 那条读时清洗（POST action:'raw'）确实在跑，
   但它的**开关根本按不下去**，原因是 looksLikeMime 的第二个条件：要求文字里有「空行」。

     旧存法 = 整封 MIME 的 `raw.slice(0, 8000)`。
     银行信经 Gmail 自动转发之后，光是 Received / ARC-Seal / ARC-Message-Signature /
     DKIM-Signature 这一坨信头，实测就 14000 字以上 —— **超过 8000**。
     → 存进 D1 的那 8000 字**从头到尾都是信头**，被切在信头中间，
       所以里面根本没有「信头结束的那个空行」
     → looksLikeMime() 回 false
     → mailBody 判定「这压根不是邮件原文」，原样退回
     → 你看到 Received / ARC-Seal 那一片。

   ⚠️ 残酷的结论要讲清楚：那些旧邮件的**正文当时就没有被存进数据库**，
      不是被藏起来、不是没解码 —— 是不存在，任何代码都救不回来。
      账没事（收信当下就已经解析并记好了，指纹还在）。
   ⚠️ 新邮件从 v10.12 起存的是 mailText(可读正文)，所以「新的不乱码」——跟清理无关。

   下面做三件事，全部只动**显示**这一条路：
     ① looksLikeMimeHead：专门认「只剩信头的残骸」。刻意收得很窄（要求至少 3 行
        Received/ARC-/DKIM/X- 这种**真信头**），截图 OCR 和粘贴的收据绝对撞不到。
     ② mailBodyOrNull：把「抽成功 / 抽失败」分开回报。mailBody 包在它外面，
        行为跟以前**一字不差**（失败照旧退回原文）→ 所有 parser 路径零风险。
     ③ mailForView：显示专用。抽得到正文就给正文；只剩信头就给一句人话，
        不再把 ARC-Seal 吐到你脸上。 */
const MIME_HDR_RE = /^(Received|Return-Path|Delivered-To|ARC-[A-Za-z-]+|DKIM-Signature|Authentication-Results|Message-ID|MIME-Version|Content-Type|Content-Transfer-Encoding|List-[A-Za-z-]+|Precedence|Feedback-ID|X-[A-Za-z0-9-]+)\s*:\s/i;
function looksLikeMimeHead(s) {
  const t = String(s || "");
  if (!MIME_HDR_RE.test(t)) return false;                              // 第一行就得是真信头
  let n = 0;
  for (const l of t.slice(0, 6000).split(/\r?\n/)) if (MIME_HDR_RE.test(l)) n++;
  return n >= 3;                                                       // 至少三行 → 确定是信头区，不是收据
}
/* 抽得到可读正文就回它，抽不到回 null（不做任何退路判断，留给上层决定）。 */
function mailBodyOrNull(raw) {
  const s = String(raw || "");
  if (!looksLikeMime(s)) return null;                                  // 压根不是邮件原文
  let out = "";
  try { out = mimeSection(s, 0) || ""; } catch (e) { out = ""; }
  const t = out.trim();
  return t.length >= 12 ? t : null;                                    // 抽不出像样的东西
}
/* 整封 MIME → 可读正文。不像 MIME（截图文字 / 粘贴的纯文字）原样退回。
   ⚠️ 这一支的**行为与 v10.13 完全相同**，只是内部改用 mailBodyOrNull 表达。
      全部 parser（email() / ingestRaw / parseRaw / retry）走的都是它，所以解析结果零变化。 */
function mailBody(raw) {
  const t = mailBodyOrNull(raw);
  return t === null ? String(raw || "") : t;
}
/* 显示专用（收件箱点开那个原文框）。**只有显示路径会叫它**，parser 一律不经过。 */
const MAIL_HEAD_ONLY_NOTE =
  "（这封是早期版本收到的旧邮件。当时存的是整封邮件原文的前 8000 字，" +
  "而银行信经 Gmail 转发后，光信头就超过这个长度 —— 所以正文当时没有被存下来，救不回来。\n\n" +
  "你的账不受影响：这封信收到的当下就已经解析并记进去了，指纹见上面那一行。\n\n" +
  "新收到的邮件只存可读正文，不会再有这个情况。）";
function mailForView(raw) {
  const s = String(raw || "");
  const b = mailBodyOrNull(s);
  if (b !== null) return htmlToLines(b).join("\n");                    // 正常：抽得到正文
  if (!looksLikeMimeHead(s)) return s;                                 // 截图 / 粘贴 / 新邮件 → 一个字节都不碰
  /* 只剩信头。万一切得刚好还留了一小截正文（有空行），把空行后面那截捞出来看看。 */
  const cut = s.search(/\r?\n\r?\n/);
  if (cut >= 0) {
    const tail = s.slice(cut).trim();
    if (tail.length >= 12) {
      let t = "";
      try { t = htmlToLines(tail).join("\n").trim(); } catch (e) { t = ""; }
      /* 捞出来的东西还是一片信头（多层转发常见）就不要了，宁可给人话 */
      if (t.length >= 12 && !looksLikeMimeHead(t)) return t;
    }
  }
  return MAIL_HEAD_ONLY_NOTE;
}
/* 「你在收件箱里看到的」＝「parser 真正读到的」＝ 这一支的输出。两边永远一致，
   以后再出事，你截图给我看的就是我在处理的东西。 */
function mailText(raw) {
  return htmlToLines(mailBody(raw)).join("\n");
}
/* v10.11 共用「只读正文」：甩掉 Gmail 的转发头块（每个 parser 走 htmlToLines 都会经过这里）。
   问题背景：email() 把整封 MIME 原文喂进来，双重转发（银行→朋友→你）时，上面几层转发头也带
   "From/To/Date/Subject" 行 —— 其中「朋友转给你」那行的收件人可能是你的 emoji 昵称，松形状的
   字段抓取会先抓到它 → 商家变乱码。这里在遇到「Forwarded message」分隔线后，把紧跟着的那一串
   转发抬头行丢掉，直到遇到第一行不是抬头的（正文开始）为止。
   关键分辨：转发抬头是「单词紧跟冒号」（To: / Date:），银行收据字段是「单词 空格 冒号」（To : / Date :）——
   所以收据字段绝不会被误伤。多层转发会有多个分隔线，状态机自然一层层剥掉。 */
function stripFwdHeaders(lines) {
  const out = []; let skip = false;
  for (const l of lines) {
    if (/^-{2,}\s*(Forwarded message|转发邮件|Original Message|原始邮件)\s*-{2,}$/i.test(l)) { skip = true; continue; }
    if (skip) {
      if (/^(From|To|Cc|Bcc|Date|Sent|Subject|Reply-To):(\s|$)/i.test(l)) continue;   // 转发抬头行 → 丢
      skip = false;                                                                     // 第一行非抬头 → 正文开始
    }
    out.push(l);
  }
  return out;
}
/* v10.13 「这串东西还是 quoted-printable 吗？」
   为什么要判断：htmlToLines 是全部 parser 的入口，而 v10.12 之后喂进来的正文
   **已经被 mimeSection 解过一次 QP 了**。再解一次会出事：
     · 网址 `?id=AB12` 里的 `=AB` 被当成字节 0xAB → 实测变成 `?id\uFFFD12`
     · 中文/emoji 被砍半（上面 decodeQP 那段已经补了保险，这里是第二道）
   判断依据是 RFC 2045 自己的规定：QP 的产出**保证是纯 ASCII**。
   所以只要文字里已经有真的中文/emoji，它就一定是解过码的 → 不要再碰。
   剩下纯 ASCII 的情况看 QP 的招牌：软换行 `=\n`，或至少两处 `=XX`（单独一个多半是网址参数）。 */
function looksQP(t) {
  if (/[^\x00-\x7F]/.test(t)) return false;        // 已经有真的多字节字元 → 早就解过了
  if (/=\r?\n/.test(t)) return true;               // 软换行是 QP 的招牌
  return (t.match(/=[0-9A-Fa-f]{2}/g) || []).length >= 2;
}
function htmlToLines(s) {
  let t = looksQP(String(s)) ? decodeQP(s) : String(s);
  if (/<\/?(td|tr|table|div|p|br)\b/i.test(t)) {
    t = t
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\s*br[^>]*>/gi, "\n")
      .replace(/<\/\s*(td|tr|p|div|h\d|li|table)\s*>/gi, "\n")  // 单元格结束 = 换行 ← 关键
      .replace(/<[^>]+>/g, " ")                                  // 其余标签抹掉
      .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
  }
  const lines = t.split(/\n+/).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
  return stripFwdHeaders(lines);   // ← 所有 parser 经过这里都只看正文，转发头一律甩掉
}
/* 在「一行一行」里找某个字段：值可能跟标签同一行，也可能在下一行（表格就是这种）
   ⚠️⚠️ v10.13 真实样本（OCBC / DBS 的通知都是 HTML 表格）有**三种**排版，全部要吃：
     ① `<td>Date :</td><td>04 Aug 2026</td>`  → 一行 "Date : 04 Aug 2026"
     ② `<td>Date</td><td>: 04 Aug 2026</td>`  → 两行 "Date" / ": 04 Aug 2026"   ← 以前会把冒号当成值的一部分
     ③ `<td>Date</td><td>:</td><td>值</td>`   → 三行 "Date" / ":" / "04 Aug 2026"
   ②以前的后果（实测）：DBS 那封的商家变成 "**: **SINGAPORE POOLS (PRIVATE) LIMITED."
   —— 前面多一个冒号，商家记忆就永远认不出这是同一家店。 */
function field(lines, label) {
  const re = new RegExp("^" + label + "\\s*:?\\s*(.*)$", "i");
  const strip = (v) => String(v || "").replace(/^\s*[:：]\s*/, "").trim();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    if (m[1] && m[1].trim()) return m[1].trim();
    const a = strip(lines[i + 1]);
    if (a) return a;                                 // ② 值在下一格（冒号剥掉）
    const b = strip(lines[i + 2]);
    if (b) return b;                                 // ③ 冒号自己独占一格
  }
  return "";
}

/* ═══ v10.15 「收款不记账」的唯一一把尺 —— looksIncoming(text) ═══
   使用者定的规矩：**这个 app 不记收入，只记支出。** 一笔收款被记成支出的后果不是「多一笔」，
   是当月支出凭空多一截，而且它进的是「已记录」那一栏 —— 悄无声息，你翻半天也想不到要去怀疑它。
   反过来，误挡一封支出信只会让它掉进「读不到」，红角标就挂在那里，你一眼看得见、按「重新识别」
   还能救回来。两个代价差了一个数量级，所以这把尺**刻意只看「收」不看「付」**：
   拿不准就不记 —— 不记你看得见，记错你看不见。（别为了少漏一笔把 OUT 判断加回来，
   v9.93 那段注释已经写过同一句话。）

   为什么要抽成一支函式：v10.14 以前这条守卫是**手抄**在 parsePayNow 里的一条正则，
   parseNETS 手抄了一个更窄的版本，而 parseDBS / parsePayLahShot / parseMariBank / parseMaybankShot
   **一条都没有**（实测：`You have received SGD 25.00 from ALICE` 会被 parseDBS 记成一笔 SGD 25 支出）。
   手抄的东西就是会漏抄 —— 现在全档只有这一处措辞，加一句大家一起严。

   ⚠️ 措辞是「够用的超集」，不是从真实收款邮件抄来的（我手上没有真的 DBS/PayLah 收款信）。
      收到真样本之后照真措辞收紧／补齐，并把那封信加进回归测试当永久防线。
   ⚠️ 三个刻意不收的东西，别好心加回去：
      · 中文「收款 / 已收到」—— 支付通知里「收款方：XXX」是**付款**信的标准写法，加了会天天误挡。
      · 裸 `refund` / `credit` —— 页尾的退款政策、"credit card" 全都会中。
      · `will be credited` 这种未来式**不排除**（沿用 v9.93 原句 `credited to your`）：
        排除它等于放行「SGD 50 will be credited to your account」这种真收款通知，方向错得更贵。
        代价是万一哪家银行的支出信页尾写了「退款将 credited to your account」会被误挡 ——
        那是看得见的漏，拿到那封真信再收紧。 */
const INCOMING_RE = new RegExp([
  /* ① 明说「收到了」 */
  "\\b(?:has|have|had|was|were)\\s+been\\s+received\\b",     // has been received
  "\\byou\\s*(?:'|\u2019)?(?:ve|\\s+have)?\\s+received\\b",  // you received / you've received / you have received
  "\\breceived\\s+from\\b",                                  // received from ALICE
                                                             // ↑ 信头那行是 `Received: from`（带冒号），\s 不吃冒号 → 不会中
  "\\b(?:money|funds?)\\s+received\\b",                      // Money received
  /* ② 明说「进账 / 入账」 */
  "\\bcredited\\s+to\\s+your\\b",                            // credited to your account（v9.93 原句，一字不动）
  "\\b(?:has|have|had|was|were)\\s+been\\s+credited\\b",     // has been credited
  /* ③ 明说「别人付给你」 */
  "\\byou\\s+(?:have\\s+)?been\\s+paid\\b",                  // you have been paid
  "\\b(?:has|have)\\s+paid\\s+you\\b",                       // ALICE has paid you
  /* ④ 明说「进来的 / 退回来的」 */
  "\\bincoming\\s+(?:[A-Za-z!]+\\s+){0,2}(?:transfer|payment|funds?|credit|money)\\b",   // Incoming PayNow payment
  "\\b(?:has|have|had|was|were)\\s+been\\s+refunded\\b",
  "\\bwas\\s+refunded\\b",
].join("|"), "i");
function looksIncoming(t) { return INCOMING_RE.test(String(t || "")); }

/* ═══ v11.05 判断是不是「确定的退信 / 系统信」（转发回圈会灌一堆这种垃圾进「读不到」）═══
   ⚠️ 只认 RFC 标准、真银行信**永远不可能**有的两个特征：
     ① 寄件人是 mailer-daemon / postmaster（退信系统地址；真银行信来自 maribank.sg 这类域名）
     ② Content-Type: multipart/report + delivery-status（RFC 3464 退信封装；真银行信是 multipart/alternative）
   ⚠️ 刻意**不**看 `Fwd:` 主旨（Fwd 里可能包着真退款）、**不**看 `Auto-Submitted`（真银行通知也是自动生成）。
   ⚠️ 这支只是「是不是退信」；要不要丢，调用端还加一道「解析不出交易才丢」的双保险 —— 真账永远走不到那里。 */
function isBounce(from, rawFull) {
  const f = String(from || "").toLowerCase();
  if (f.includes("mailer-daemon") || f.includes("postmaster")) return true;
  const h = String(rawFull || "").slice(0, 6000).toLowerCase();   // 只看信头区，够了
  if (h.includes("multipart/report") && h.includes("delivery-status")) return true;
  return false;
}

/* ---- DBS PayLah! 解析（v4.2 重写）---- */
function parseDBS(raw) {
  // 纯文本邮件里两笔可能挤在同一行 → 先在每个 "Transaction Ref" 前面断开
  const lines = htmlToLines(raw)
    .flatMap((l) => l.split(/(?=Transaction Ref)/i))
    .map((x) => x.trim()).filter(Boolean);
  /* ⚠️⚠️ v10.15 收款不记账（铁律2）—— 这支以前**一条守卫都没有**，
     实测 `You have received SGD 25.00 from ALICE` 会被记成一笔 SGD 25 的支出，
     而且金额是拿整封文字去 match `SGD X.XX`，连 `Amount:` 标签都不用有，正文提到钱就中。
     整封一起看（不是逐块）：一封信里只要出现收款措辞就整封退回 []，
     宁可让那封信掉进「读不到」由你自己判，也不要猜哪一块是收、哪一块是付。 */
  if (looksIncoming(lines.join(" "))) return [];
  const out = [];
  // 按 "Transaction Ref" 切块（一封信可能有多笔）
  const idx = [];
  lines.forEach((l, i) => { if (/Transaction Ref/i.test(l)) idx.push(i); });
  /* ⚠️⚠️ v10.13 这里以前是 `idx.length ? 切块 : [整封]`，也就是**只要有一行 Transaction Ref
     就从那一行切到结尾**。可是切块的用意是「一封信有好几笔时把它们分开」——
     一封信只有一笔时切了纯粹是自伤：真实的 DBS 通知常常是
        To : XXX / Amount : SGD 9.00 / Date & Time : … / Transaction Ref : IP…
     参考号在**最后一行**，切完那一块里只剩参考号，金额和日期全被留在块外 →
     `if (!amt || !dt) return;` → 整封退回 []，掉进「读不到」。
     （实测：v10.12 修好解码之后，重试一封 DBS 信照样认不出来，卡的就是这一行。）
     现在：两笔以上才切；只有一笔就整封一起看，抓不到东西的机会少一大截。
     两笔以上的行为**一个字节都没变**。 */
  const blocks = idx.length > 1
    ? idx.map((start, n) => lines.slice(start, idx[n + 1] || lines.length))
    : [lines];

  blocks.forEach((b, i) => {
    const joined = b.join(" | ");
    // ⚠️ field() 回的是**字符串**，别当数组取 [1]（第一版就是这样，hash 变成了 "dbs:L"）
    let ref = field(b, "Transaction Ref");
    if (!ref) { const rm = joined.match(/\b([A-Z]{2,}[A-Z0-9]{8,})\b/); ref = rm ? rm[1] : ""; }
    ref = (ref.match(/[A-Z0-9]{10,}/) || [""])[0];
    /* ⚠️ v10.13 参考号**必须带数字** —— 跟 parsePayNow v10.12 那条同一个理由，同一类事故：
       上面那条退路正则 `[A-Z]{2,}[A-Z0-9]{8,}` 会咬到正文里任何 10 个字母以上的大写单词，
       实测 CONFIDENTIAL / TRANSACTIONS / NOTIFICATION 全部命中 → hash 变成 `dbs:CONFIDENTIAL`
       → 所有这种信互撞 → 第一封之后每一封都被 INSERT OR IGNORE 静默丢掉。
       银行参考号没有纯字母的，抓不到就走下面「日期+时间+金额」的退路 hash，本来就够独特。 */
    if (!/\d/.test(ref)) ref = "";

    const amtStr = field(b, "Amount") || joined;
    let amt = amtStr.match(/([A-Z]{3})\s?([\d,]+\.\d{2})/);
    /* v10.15 见 isoPick 上面那段：抓不到 `Amount:` 标签时 amtStr 是**整块文字**，
       任何三个大写字母 + 金额都会中（实测 `Total XYZ 99.00 for SGD 10.00` → 记成 XYZ 99）。
       币种不合法就往下找第一组合法的；整块都没有才保留原样照记。 */
    if (amt && !isIso(amt[1])) amt = isoPick(amtStr) || amt;

    const dtStr = field(b, "Date & Time") || field(b, "Date") || joined;
    /* ⚠️ v23.26 这条以前是 /(\d{1,2})\s+([A-Za-z]{3})\s+(\d{1,2}:\d{2})/ ——
       **写死「月份后面必须紧接着时间」**，也就是只吃 `05 Aug 12:41` 这一种。
       实测（node 跑过）这四种全部认不得，而它们都是真实会出现的写法：
         05 Aug 2026 12:41       ← 带年份
         5 Aug 2026 09:05        ← 带年份 + 一位数日
         05 August 12:41         ← 月份全写
         05 Aug 2026 12:41 (SGT) ← 带年份 + 时区（同一支函式下面就有剥 (SGT) 的代码，
                                    代表这封信真的带 SGT，那年份很可能也一起带）
       认不得的下场不是少一个字段，是 `if (!amt || !dt) return;` → **整封退回 []
       → 掉进「读不到」**，一整封 DBS 消费信就这样不见。
       改成年份可有可无、月份可全写；**年份真的写在信上就用信上那个**，
       没写才退回 guessYear() 猜（跨年重新识别旧邮件时，猜会猜错年份）。
       ⚠️ 旧格式 `05 Aug 12:41` 行为一字不差 —— 下面 datefmt 那支穷举测试是专门证明这件事的。 */
    const dt = dtStr.match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(?:(\d{4})\s+)?(\d{1,2}:\d{2})/);

    let to = field(b, "To");
    // 纯文本邮件里 "To: SHOP A" 跟别的字段挤在同一行 → field() 抓不到，用整块兜底
    if (!to) {
      const tm = joined.match(/\bTo:\s*(.+?)(?:\s{2,}|\s*\||$)/i);
      if (tm) to = tm[1].trim();
    }
    // "To view your transactions..." 那段正文别当成收款人
    if (/^to view/i.test(to) || /login to your/i.test(to)) to = "";
    /* v10.13 形状校验（跟 parseNETS 同一把尺）：收款人里不会有 @ 或 <。
       双重转发（银行→朋友→你）的正文里常残留一行 `To: xxx@gmail.com`，
       上面那条整块兜底会抓到它 → 商家变成一个邮箱地址，还会被学进商家记忆。 */
    if (/[@<>]/.test(to) || to.length > 60) to = "";
    to = to.replace(/\s*\(SGT\)\s*$/i, "").trim();

    if (!amt || !dt) return;
    const mon = MON[dt[2].toLowerCase()];
    if (!mon) return;
    const year = dt[3] ? parseInt(dt[3], 10) : guessYear(mon);   // v23.26 信上写了年份就用它
    const ts = `${year}-${pad(mon)}-${pad(parseInt(dt[1], 10))}T${pad2h(dt[4])}:00+08:00`;
    const amount = parseFloat(amt[2].replace(/,/g, ""));
    const hash = ref ? `dbs:${ref}` : `dbs:${ts}:${amount}:${i}`;

    out.push({
      ts, amount, currency: amt[1],
      merchant: to || "PayLah Transfer",     // 抓不到才退回通用名（而通用名不会被学进商家记忆，见 GENERIC）
      isPerson: true,                          // v9.72 PayLah「You paid X」= 转账给人
      card_last4: null, source: "dbs", raw: `DBS ${ref}`, hash,
    });
  });
  return out;
}

/* ═══ v11.05 OCBC「Alert Withdrawal Made」提款 → 记成支出 ═══
   使用者的用法：从 OCBC 账户提款去充 Alipay / RedNote。这封信**没有商家**，只有
   「A sum of SGD 60.46 was withdrawn from your account (-857001) at 5:12 AM on 07 Aug 2026」。
   使用者要求：这类提款**一律**把商家记成 `Alipay*RED Note`（跟 MariBank 退款同一个商家名 →
   商家记忆共用：分类设一次两边都套）。付款方式用账户末四码（-857001 → 7001），
   到「付款方式」改一次名字就永久记住（paynames 机制）。
   ⚠️ 排在 parseOCBC 前面，闸门收窄（OCBC + Withdrawal），普通卡消费不含这些字 → 回 [] → 继续走 parseOCBC。
   ⚠️ 走 htmlToLines（真邮件是 HTML）。 */
function parseOCBCWithdrawal(raw) {
  const t = htmlToLines(raw).join("\n");
  if (!/OCBC/i.test(t)) return [];
  if (!/withdrawal\s+made/i.test(t) && !/withdrawn\s+from\s+your\s+account/i.test(t)) return [];
  // 金额：A sum of SGD 60.46 was withdrawn
  let am = t.match(/A\s+sum\s+of\s+([A-Z]{3})\s?([\d,]+\.\d{2})/i);
  if (am && !isIso(am[1])) am = isoPick(t) || am;
  if (!am) { const m2 = t.match(/\b([A-Z]{3})\s?([\d,]+\.\d{2})\b/); if (m2 && isIso(m2[1])) am = m2; }
  if (!am) return [];
  const currency = am[1].toUpperCase();
  const amount = parseFloat(am[2].replace(/,/g, ""));
  // 日期时间：at 5:12 AM on 07 Aug 2026（AM/PM 可有可无）
  const dt = t.match(/at\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])?\s+on\s+(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/i);
  if (!dt) return [];
  const mon = MON[dt[5].toLowerCase()];
  if (!mon) return [];
  let hh = parseInt(dt[1], 10);
  if (dt[3]) { const pm = /p/i.test(dt[3]); if (pm && hh < 12) hh += 12; else if (!pm && hh === 12) hh = 0; }
  const ts = `${dt[6]}-${pad(mon)}-${pad(+dt[4])}T${pad(hh)}:${dt[2]}:00+08:00`;
  // 账户：(-857001) → 末四码 7001（当付款方式）
  const ac = t.match(/account\s*\(\s*-?\s*(\d+)\s*\)/i);
  const acct = ac ? ac[1].slice(-4) : null;
  return [{
    ts, amount, currency,
    merchant: "Alipay*RED Note",     // 使用者要求：这类提款全部归成这个商家（无商家）
    isPerson: false,
    card_last4: acct,                // 付款方式 = 账户末四码，可到「付款方式」改名并永久记住
    source: "ocbc",
    raw: `OCBC withdrawal ${currency}${am[2]}`,
    hash: `ocbcw:${ts}:${amount}:${acct || "x"}`,   // 无参考号：时间+金额+账户 拼，独立前缀 ocbcw:（跟别支永不撞）
  }];
}

/* ═══ v10.21 收入破例④：OCBC 存款通知 → 一律记成【Refund · 收入】═══
   使用者要求（照片 IMG，OCBC「Deposit in your account」SGD 6.42）：这类**进账**邮件**没有商家**，
   一律记成商家名 "Refund"、type:income —— 跟 MariBank/PayLah 退款同一套（收入破例、可开抵扣支出）。
   真实样本：
     OCBC Alert: Deposit in your account
     A deposit was made in your account. Here are the details:
     Time of deposit: 5:23 AM
     Amount: SGD 6.42
     Account that money was deposited in: (-857001)
     Reference: 06/08/26
   ⚠️ 五个点，别改回去：
   1. 闸门钉「OCBC + deposit … (was made|in your account)」—— 只有进账通知有这句；卡消费写 "was charged"、
      提款写 "withdrawn"，都不含 → 回 []。**必须排在 parseOCBC / parseOCBCWithdrawal 前面**：那两支闸门都认 OCBC，
      虽然抓不到会回 []，但排前面才真的把这笔记成 Refund，而不是掉「读不到」。
   2. 日期唯一来源是 `Reference: 06/08/26`（**DD/MM/YY**，不是参考号！新马日期格式）—— 这封没有 "on 06 Aug 2026"
      那种写法。按 DD/MM/YY 解；解不出日期就回 []（掉读不到你自己看，**绝不瞎猜成今天**——猜错日期账就跑到别的月）。
   3. 时间 `Time of deposit: 5:23 AM`（12 小时制，跟提款同一把尺换 AM/PM；没抓到退成 12:00）。
   4. 无商家 → merchant 硬写 "Refund"（使用者指定）。固定名 → 商家记忆把所有 OCBC 存款归成同一家 "Refund"，
      你在某一笔开了「抵扣支出」，以后 OCBC 存款自动带上抵扣（offsetForMerchant，跟别的退款同一个机制）。
   5. hash 独立前缀 `ocbcrf:` + 时间+金额+账户 —— 跟 ocbc:(卡) / ocbcw:(提款) / 别支的指纹永不撞。
   ⚠️ 跟别的退款一样**不调 looksIncoming**：那把尺是挡「收款不记」的，而这里正是要记（收入破例）。 */
function parseOCBCRefund(raw) {
  const t = htmlToLines(raw).join("\n");
  if (!/OCBC/i.test(t)) return [];
  if (!/deposit\s+(?:was\s+made|in\s+your\s+account)/i.test(t)) return [];
  // 金额：Amount: SGD 6.42（一定要真 ISO 币种前缀，挡掉电话号码那种裸数字）
  let am = t.match(/Amount\s*:?\s*([A-Z]{3})\s?([\d,]+\.\d{2})/i);
  if (am && !isIso(am[1])) am = isoPick(t) || am;
  if (!am) { const m2 = t.match(/\b([A-Z]{3})\s?([\d,]+\.\d{2})\b/); if (m2 && isIso(m2[1])) am = m2; }
  if (!am || !isIso(am[1])) return [];
  const currency = am[1].toUpperCase();
  const amount = parseFloat(am[2].replace(/,/g, ""));
  // 时间：Time of deposit: 5:23 AM（12 小时制 → 24 小时）
  const tm = t.match(/Time\s+of\s+deposit\s*:?\s*(\d{1,2}):(\d{2})\s*([AaPp])[Mm]?/i)
          || t.match(/\b(\d{1,2}):(\d{2})\s*([AaPp])[Mm]\b/);
  let hh = tm ? parseInt(tm[1], 10) : 12;
  const mm = tm ? tm[2] : "00";
  if (tm && tm[3]) { const pm = /p/i.test(tm[3]); if (pm && hh < 12) hh += 12; else if (!pm && hh === 12) hh = 0; }
  // 日期：Reference: 06/08/26（DD/MM/YY）；退路 on 06 Aug 2026
  let year, mon, day;
  const dref = t.match(/Reference\s*:?\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i);
  if (dref) {
    day = parseInt(dref[1], 10); mon = parseInt(dref[2], 10);
    year = dref[3].length <= 2 ? 2000 + parseInt(dref[3], 10) : parseInt(dref[3], 10);
  } else {
    const don = t.match(/on\s+(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/i);
    if (!don) return [];
    day = parseInt(don[1], 10); mon = MON[don[2].toLowerCase()]; year = parseInt(don[3], 10);
  }
  if (!mon || mon < 1 || mon > 12 || !day || day < 1 || day > 31) return [];
  const ts = `${year}-${pad(mon)}-${pad(day)}T${pad(hh)}:${mm}:00+08:00`;
  // 账户末四码：Account … (-857001) → 7001（当付款方式显示）
  const ac = t.match(/account[^()\n]*\(\s*-?\s*(\d{3,})\s*\)/i) || t.match(/\(\s*-\s*(\d{3,})\s*\)/);
  const acct = ac ? ac[1].slice(-4) : null;
  return [{
    ts, amount, currency,
    merchant: "Refund",                 // 使用者指定：无商家 → 一律记成 "Refund"
    isPerson: false,
    card_last4: acct,
    source: "ocbc",
    type: "income",                     // ⭐ 收入（第四个记收入的地方）
    raw: `OCBC deposit ${currency}${am[2]}`,
    hash: `ocbcrf:${ts}:${amount}:${acct || "x"}`,   // 独立前缀，跟支出永不撞
  }];
}

/* ---- OCBC 卡消费 解析 ---- */
function parseOCBC(raw) {
  /* ⚠️⚠️ v10.20 改成【逐行】跑，别再 .join(" ") 成一整串。
     真实踩过（照片 IMG，OCBC 卡在 www.anywheel.sg 消费）：商家是**网址**时，旧版结尾
     `at\s+(.+?)(?:\.|$)` 里的 `.` 会咬在 "www" 后面那个点上 → 商家只剩 "www"。
     整封 join 成一串后没有换行可锚，`$` 永远是整串结尾、`.` 又抢在前面 → 网址型商家必被腰斩。
     实测 htmlToLines 里这句「…was charged at…at <商家>.」纯文字/HTML 都**独占一行**，
     所以逐行跑、用行尾 `\s*\.?\s*$`（吃掉行尾那个句号，但不碰商家名里的点）→
     "www.anywheel.sg Singapore" 完整抓下。其它银行/其它商家不经过这里，零影响。 */
  const lines = htmlToLines(raw);
  const out = [];
  // 原版用 .match() 只认第一笔，一封信里有两笔就丢一笔。改逐行 + matchAll 全收。
  const re = /([A-Z]{3})\s?([\d,]+\.\d{2})\s+was charged at\s+(\d{1,2}:\d{2})\s+on\s+(\d{1,2})-([A-Za-z]{3})-(\d{2})\s+to your card\s*\(?-?(\d{4})\)?\s+at\s+(.+?)\s*\.?\s*$/gi;
  for (const line of lines)
  for (const m of line.matchAll(re)) {
    const mon = MON[m[5].toLowerCase()];
    if (!mon) continue;
    const year = 2000 + parseInt(m[6], 10);
    const day = pad(parseInt(m[4], 10));
    const hm = pad2h(m[3]);
    const merchant = m[8].trim().replace(/\s+/g, " ");
    out.push({
      ts: `${year}-${pad(mon)}-${day}T${hm}:00+08:00`,
      amount: parseFloat(m[2].replace(/,/g, "")),
      currency: m[1],
      merchant,
      card_last4: m[7],
      source: "ocbc",
      raw: `OCBC ${m[1]}${m[2]} ${merchant}`,
      hash: `ocbc:${year}-${pad(mon)}-${day}T${hm}:${m[2]}:${m[7]}`,
    });
  }
  return out;
}
/* ⚠️ v9.93 新增闸门：「信里提到 PayNow」≠「这是一笔 PayNow 转账」。
   页尾促销、绑定成功通知都会带这个词。以前的门是 /PayNow/i.test(raw)（测的还是**整封原始
   MIME**，含页尾和 HTML alt 文本），一封普通 OCBC 卡消费信只要页尾有一句
   "top up with PayNow"，整封就被 PayNow 分支劫走，而且落回条件是 !rows.length ——
   金额抓得到就永远落不回 parseOCBC。实测那封会被记成：
       merchant "your card" / card_last4 "PayNow" / 日期 2027-01-01
   （日期正则不认 12-Jul-26 这种写法 → 退成 1 月 1 日 → guessYear 再推到隔年）。
   现在要求 PayNow 跟 transfer/payment/transaction 挨在一起才算。
   宁可漏判：漏判 → 落回银行 parser，再不行进「读不到」，你看得见。 */
function isPayNowTransfer(raw) {
  const t = htmlToLines(String(raw)).join(" ");
  return /PayNow[^.\n]{0,40}\b(transfer|payment|transaction)\b/i.test(t)
      || /\b(transfer|payment|transaction)[^.\n]{0,40}PayNow/i.test(t);
}

/* v9.86 通用 PayNow 转账解析（不分银行：OCBC/Maybank/DBS…只要有 PayNow 转账字样）。
   抓不到金额就返回 []（让路由落回银行专属 parser）。转账给人 → isPerson:true。
   ⚠️⚠️ v9.93 四处修，别改回去：
   1. 先过 htmlToLines。这以前是全档**唯一**不做邮件预处理的 parser（parseOCBC / parseDBS
      第一行都做）。真实银行信是 HTML + quoted-printable → 收款人永远退回 "PayNow Transfer"
      （而这个名字在 GENERIC 名单里，商家记忆永远学不会它，每次都得手动改）；
      QP 把金额拆成 "SGD=205.80" 时连金额都抓不到 → 掉进第 3 条那个坑。
   2. 收款不记。照既有惯例（PayLah 的「You received」、TnG 的 +RM 都刻意不记）：
      收款回 [] → 掉进「读不到」自己看。以前收款会被当成**支出**记进去（INSERT 那行
      type 写死 'expense'），250 块收款 = 当月支出多 250，而且进的是「已记录」，悄无声息。
      ⚠️ 方向词只看「收」不看「付」：拿不准的时候宁可不记 —— 不记你看得见（读不到），
         记错你看不见。别为了少漏一笔，把 OUT 判断加回来。
   3. 绝不回 null。路由那行是 `if (!rows.length)`，null.length 会把整个 email() 打掉，
      而 email() 外面没有 try/catch → 那封信连「读不到」都进不去，直接蒸发。
      违反本档地基那句：绝不静默丢账。
   4. 12 小时制换算，见下面 tm。 */
function parsePayNow(raw) {
  const lines = htmlToLines(String(raw));                 // v9.93 修 1（v10.13 留着行数组给下面的 To 兜底）
  const text = lines.join(" ");
  if (!/PayNow/i.test(text)) return [];
  /* v9.93 修 2：收款方向 → 不记，让它掉进「读不到」
     ⚠️ v10.15 改成调用 looksIncoming()（全档同一把尺）。旧的那条正则是新尺的**子集**——
        它认得 `have received` 却不认得裸的 `You received`，也不认得 `Money received` /
        `Incoming PayNow payment`（旧式 `incoming (transfer|payment)` 要求两个词紧挨着）。
        三种都实测过：改之前会被记成支出。 */
  if (looksIncoming(text)) return [];
  // 金额：SGD 5.80 / S$5.80 / MYR 10.00 / RM 10.00 都吃
  let am = text.match(/(?:Amount\s*:?\s*)?\b([A-Z]{3}|S\$|RM)\s*([\d,]+\.\d{2})/i);
  if (!am) return [];                                     // v9.93 修 3：不再回 null
  let cur = am[1].toUpperCase();
  if (cur === "S$") cur = "SGD"; else if (cur === "RM") cur = "MYR";
  /* ⚠️⚠️ v10.15 这条是全档最松的一条金额正则：`Amount` 前缀是**可选**的（等于扫整封），
     而 `i` 旗标会把 `[A-Z]{3}` 放宽成任何三个字母。两个加起来的实测后果见 isoPick 上面那段
     —— `A fee was 313.92` 会赢过后面真正的 `Amount : SGD 5.80`，记成 WAS 313.92。
     S$ / RM 走上面那两行归一化成 SGD / MYR，本来就合法，不会走进这条。 */
  if (!isIso(cur)) { const iso = isoPick(text); if (iso) { am = iso; cur = iso[1]; } }
  /* ⚠️⚠️ v11.05 日期以前**硬性要求 4 位年份** `\s+(\d{4})` —— 只吃 OCBC 那种「Date : 14 Jul 2026」。
     但 PayLah 的 PayNow 是「Date & Time:\n07 Aug 12:42 (SGT)」**没有年份** → 整条失配 →
     dm=null → 月份退成 1(一月)、年份 guessYear(1) 猜成明年、日退成 01 → **2027-01-01**（真实踩过：
     一笔 07 Aug 的 PayNow 15.20 被丢到 2027-01-01，明细里当天完全看不到）。
     改成两层：带年份的优先（OCBC，一字不差），没有再退到无年份（PayLah，年份靠 guessYear 用真实月份猜）。
     ⚠️⚠️ v11.05b 月份那截**必须钉成真月名**（Jan…Dec），不准用泛 `[A-Za-z]{3}`：金额 `15.20` 后面紧跟
        `Date & Time` → 泛正则会把「20 Dat(e)」当成「20 号 + 月份 Dat」吃掉 → MON['dat']=undefined → 月退成 1
        → 又回到 2027-01-20 那个坑（真实踩过：SGD 15.20 那笔就是这样被 20 Date 抢走）。钉死月名后
        「20 Date」不再匹配，正则往后走才咬到真正的「07 Aug」。 */
  const MON3 = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
  const dm = text.match(new RegExp(`(\\d{1,2})\\s+${MON3}[a-z]*\\s+(\\d{4})`, "i"))   // 带年份（OCBC PayNow）
          || text.match(new RegExp(`(\\d{1,2})\\s+${MON3}[a-z]*\\b`, "i"));           // 无年份退路（PayLah PayNow）
  /* v9.93 修 4：以前裸抓 (\d{1,2}):(\d{2}) 不看 AM/PM → 01:22 PM 记成凌晨 01:22。
     副作用不只是时间难看：餐饮子分类按时间算 → 午餐被标成宵夜。
     带 AM/PM 的那个优先（信里前面常有别的裸时间先撞上）；
     "13:22 PM" 这种 24 小时制硬跟个 PM 的不动（只有 h<12 才 +12）。 */
  const tm = text.match(/(?:Time\s*:?\s*)?\b(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\b\.?/)
          || text.match(/(?:Time\s*:?\s*)?\b(\d{1,2}):(\d{2})\b/);
  /* ⚠️⚠️ v10.12 两处收紧，别改回去 —— 这是「明明没重复、却被当成重复丢掉」的真凶：
     1. `Ref` 后面补词边界。旧版 `Ref` 会咬进 **References / references**（信头 ARC/DKIM 的
        `h=…:references:…` 清单里天天都有），抓出 `"erences"` 当参考号 →
        hash 全变成 `paynow:erences` → 每一封互撞，第一封之后全被当重复丢。
     2. 参考号必须**带数字**。银行参考号没有纯字母的；误抓来的都是英文单词。
        抓不到只是少去一次重（退路 hash 用日期+时间+金额+商家，本来就够独特），
        抓错是整笔账悄悄消失 —— 这两个代价不对等，所以宁可抓不到。 */
  const rm = text.match(/\b(?:Reference|Ref)\b\.?\s*(?:number|no\.?)?\s*[:#]?\s*([A-Za-z0-9]{6,})/i);
  /* ⚠️ v10.18 收款人/商家首字允许**数字**、名字里允许数字和 &：真实踩过（照片 IMG，OCBC PayNow
     付给「96SUPER GRADE PTE. LTD.」）—— 旧的 `[A-Z]` 要求首字是字母，`96…` 开头的公司名（96SUPER /
     7-Eleven / 365…）一律抓不到 → 商家掉成通用名 "PayNow Transfer"。放宽首字与字符集，但下面 nmName
     仍要求**至少一个字母**（挡掉把金额 62.00 / 账号那串纯数字误当商家）。 */
  let nm = text.match(/(?:made to|transfer to|paid to|to)\s+([A-Za-z0-9][A-Za-z0-9 .'&-]{2,40}?)\s+(?:using|via|on|at|\()/i);
  if (nm && !/[A-Za-z]/.test(nm[1])) nm = null;   // 纯数字/符号不算商家名
  const mon = dm ? MON[dm[2].toLowerCase()] : null;
  const year = (dm && dm[3]) ? parseInt(dm[3], 10) : guessYear(mon || 1);   // v11.05 信上写了年份就用它，没写靠 guessYear 用真实月份猜
  const day = dm ? pad(parseInt(dm[1], 10)) : "01";
  let hh = tm ? parseInt(tm[1], 10) : 12;
  if (tm && tm[3]) { const isPM = /p/i.test(tm[3]); if (isPM && hh < 12) hh += 12; else if (!isPM && hh === 12) hh = 0; }
  const hm = tm ? `${pad(hh)}:${tm[2]}` : "12:00";
  const ref = (rm && /\d/.test(rm[1])) ? rm[1] : "";     // v10.12 见上面第 2 条
  /* v10.13 收款人兜底：上面那条 `nm` 只吃 ASCII（`[A-Z][A-Za-z .'-]`），
     收款人是中文名 / 马来名带符号时**永远抓不到**，全部退回通用名 "PayNow Transfer" ——
     而通用名在 GENERIC 名单里，商家记忆学不会，你每次都得手动改。
     现在抓不到就看「To :」那一格（HTML 表格信最常见的写法）。
     形状校验照 parseNETS 那把尺：不准有 @ < >（挡掉转发信封那行）、不准是纯数字/金额、长度 2–40，
     再挡掉 "To view your…" 这类正文句子。过不了就还是退回通用名 —— 宁可漏，不要错。 */
  let merchant = nm ? nm[1].trim().replace(/\s+/g, " ") : "";
  if (!merchant) {
    /* ⚠️⚠️ v10.16 收款人兜底加固（真实踩过：照片 IMG_6955，一笔转发来的 PayLah PayNow
       商家记成了通用名 "PayNow Transfer"）。旧版只看 field("To") 的**第一处**：转发邮件顶上
       永远有一行邮件头 `To: spend@…`，field 先抓到它 → @ 被形状校验挡掉 → 就**停在那里**、
       退回通用名，底下真正的收款人根本没轮到。使用者原话「你不可以拿 from paynow，你要看 to 谁」。
       改成：① 多个收款人标签都认（To / Recipient / Sent to / Paid to / Transfer to / Beneficiary），
             ② 同名标签的**每一处**都收集成候选（不是只看第一处），
             ③ 逐个过形状校验，取第一个像人名的 —— 邮件头那行 @ 被跳过后，继续往下找到真人。
       形状校验照 parseNETS 那把尺：@<> / 纯数字金额 / view·login 正文 / 「PayNow」字样一律不算人名。
       全过不了才退回通用名 —— 宁可漏，不要错。 */
    const okName = (v) => v && v.length >= 2 && v.length <= 40 && !/[@<>]/.test(v)
        && !/^(view|login|your|the|dear|hi|from)\b/i.test(v) && !/^[\d.,\s]+$/.test(v)
        && !/^[A-Z]{3}\s*[\d,]+\.\d{2}$/i.test(v) && !/paynow|paylah/i.test(v);
    const cand = [];
    for (const lb of ["To", "Recipient Name", "Recipient", "Sent to", "Paid to", "Transfer to", "Beneficiary"]) {
      const re = new RegExp("^" + lb + "(?=[\\s:：]|$)\\s*[:：]?\\s*(.*)$", "i");   // 前瞻挡掉 "Total"→"To" 这类误配
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(re);
        if (!m) continue;
        let v = (m[1] && m[1].trim()) ? m[1].trim() : String(lines[i + 1] || "").replace(/^\s*[:：]\s*/, "").trim();
        /* ⚠️⚠️ v10.16 收款人尾巴的括号一律剥掉 —— 真实 DBS PayLah PayNow（照片 IMG_6955／使用者贴的原文）
           收款人写成 `MX AMMXX THXX CHX ANX (Mobile ending 4163)`，**整串 42 字 > 40 的上限** → 被形状校验
           挡掉 → 退回通用名 "PayNow Transfer"（就是这一条把那笔转账的名字吃掉的，不是邮件头遮挡）。
           括号里是打码手机号，纯噪音；剥掉后名字 `MX AMMXX THXX CHX ANX` 只有 21 字，稳稳过关。
           顺带把旧的 `(SGT)` 也并进这条通用「剥尾括号」。 */
        v = v.replace(/\s*\([^)]*\)\s*$/i, "").replace(/\s+/g, " ").trim();
        if (v) cand.push(v);
      }
    }
    const hit = cand.find(okName);
    if (hit) merchant = hit;
  }
  if (!merchant) merchant = "PayNow Transfer";
  return [{
    ts: `${year}-${pad(mon || 1)}-${day}T${hm}:00+08:00`,
    amount: parseFloat(am[2].replace(/,/g, "")),
    currency: cur,
    merchant,
    isPerson: true,                 // PayNow 转账给人：分类只当提示，不锁死
    card_last4: "PayNow",           // 哨兵值：「按卡」单独归成 PayNow，不进现金/其他
    source: "paynow",
    raw: `PayNow ${cur}${am[2]} ${merchant}`,
    /* v23.26 没参考号时的退路 hash 要够独特：以前只用「日期+金额」，同一天、同金额、都没参考号的
       两笔不同交易（例如两笔 SGD 10.00）会撞同一个 hash → 第二笔被 INSERT OR IGNORE 当成重复静默丢掉、
       不进明细（SINGAPORE POOLS 那笔就是这样丢的）。加上「时间(到分) + 商家」→ 不同交易不再互撞；
       同一封信重复转发时，时间和商家都不变，照样能被正确去重。 */
    hash: ref ? `paynow:${ref}` : `paynow:${year}-${pad(mon || 1)}-${day}T${hm}:${am[2]}:${merchant.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24)}`,
  }];
}

/* ═══ v10.10 第 8 支：NETS QR 付款（OCBC 寄的「NETS QR payment made」）═══
   ⚠️ 归类：**记成 PayNow**（`source:"paynow"` + `card_last4:"PayNow"`）—— 这是使用者指定的。
      前端认的是 `card_last4==='PayNow'`（payKey L2899 / payLabel L3352），不是 source，
      两个都写才会既进 PayNow 那一格、又能在编辑弹窗里选中自己那颗（见 index.html v9.89 那段）。
      `raw` 里留 "NETS …"，将来查得出这笔到底是哪条管道进来的。

   ⚠️⚠️ 这封信是**转发的转发**（银行 → 朋友 → 你 → spend@），前面叠了两层 MIME 头，
      里面同样有 `To:` 和 `Date:`。直接用现成的 field(lines,'To') 会抓到 spend@zhengmoney.uk、
      field(lines,'Date') 会抓到信封时间 19:10（实测，不是猜的）—— 记成的商家是你自己的信箱、
      时间差 6 小时。所以这里**每个字段都自带形状校验**：
        To   值里不准有 @ 或 <    → 信封那几行自己就出局
        Date 必须是「04 Aug 2026」→ "Tue, 4 Aug 2026 19:10:24 +0800" 开头是 Tue, 直接不匹配
      这样就算哪天信头顺序变了、或正文标记换了措辞，也不会抓错东西。

   ⚠️ 时间：正文写 "01:16pm SGT"。裸抓 \d{1,2}:\d{2} 会先撞上信头的 19:10 →
      不但时间难看，餐饮子分类是按交易时间算的（foodSub），午餐会被标成宵夜。所以锁 "Time :" 标签 + AM/PM。
   ⚠️ 抓不到金额或日期就回 []（不是 null，见 parsePayNow 修 3），让它掉进「读不到」你自己看。
      照地基那条：宁可漏也不要错 —— 漏你看得见，错你看不见。 */
function isNetsQR(raw) {
  const t = htmlToLines(String(raw)).join(" ");
  /* 两个条件都要 —— 单看 "NETS QR payment" 太松（页尾促销也会提），
     "NETS merchant ID / NETS Stan ID" 只有真的这封通知才有。够窄，所以敢放在分流第一位。 */
  return /NETS\s+QR\s+payment/i.test(t) && /NETS\s+(?:merchant|Stan)\s*ID/i.test(t);
}
function parseNETS(raw) {
  const lines = htmlToLines(String(raw));
  /* 一行一行找「标签 : 值」，值也可能落在下一行（HTML 表格那种）；shape 是该字段的形状校验，见上面
     ⚠️⚠️ v10.13：以前这里**硬性要求标签那一行有冒号**。真实的 OCBC 表格是
     `<td>Reference number</td><td>: 2608040116129894</td>` → 拆成两行时冒号跑到**值那一行**去了
     → 标签行没有冒号 → 整个 pick 全部落空 → `if (!am || !dt) return []` → **整封 NETS 通知读不到**。
     （实测：照片二那封信在表格排版 B 下就是这样死的。）
     修法是「加一条路」而不是「放宽原本那条」：原本「标签行带冒号」的判断一字不动；
     另外加一条只在「标签行**光秃秃没有冒号**、而下一行**以冒号开头**」时才走 —— 够窄，不会误伤。 */
  const pick = (label, shape) => {
    const reColon = new RegExp("^" + label + "\\s*:\\s*(.*)$", "i");
    const reBare  = new RegExp("^" + label + "\\s*$", "i");
    const strip = (x) => String(x || "").replace(/^\s*[:：]\s*/, "").trim();
    for (let i = 0; i < lines.length; i++) {
      let v = "";
      const m = lines[i].match(reColon);
      if (m) v = (m[1] || "").trim() || strip(lines[i + 1]);          // ① 标签行带冒号（原本的路，没动）
      else if (reBare.test(lines[i]) && /^\s*[:：]/.test(String(lines[i + 1] || ""))) {
        v = strip(lines[i + 1]) || strip(lines[i + 2]);               // ② 冒号在值那一行（或自己独占一格）
      }
      if (!v) continue;
      const s = v.match(shape);
      if (s) return s;
    }
    return null;
  };
  /* 收款不记 —— 跟 PayLah 的「You received」、TnG 的 +RM、PayNow 的 received 同一把尺
     下面这条原本的窄守卫留着不动（它要求 received/credited/refund 紧贴在 "NETS QR payment"
     后面 30 字内，够窄、误挡机会小）；v10.15 再叠一条全档共用的 looksIncoming ——
     窄的那条挡不住「正文写 payment has been made、另一段写 refund has been credited to your
     account」这种分开写的措辞。两条是「或」的关系，只会更严，不会更松。 */
  if (lines.some((l) => /NETS\s+QR\s+payment[^.]{0,30}\b(received|credited|refund)/i.test(l))) return [];
  if (looksIncoming(lines.join(" "))) return [];
  const am = pick("Amount", /^(?:([A-Z]{3})|(S\$))\s*([\d,]+\.\d{2})$/i);
  const dm = pick("Date", /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if (!am || !dm) return [];
  const mon = MON[dm[2].toLowerCase()];
  if (!mon) return [];
  const tm = pick("Time", /^(\d{1,2}):(\d{2})\s*(?:([AaPp])\.?[Mm]\.?)?/);
  let hh = tm ? parseInt(tm[1], 10) : 12;
  if (tm && tm[3]) { const isPM = /p/i.test(tm[3]); if (isPM && hh < 12) hh += 12; else if (!isPM && hh === 12) hh = 0; }
  const hm = tm ? `${pad(hh)}:${tm[2]}` : "12:00";
  const to = pick("To", /^([^<@]{2,60}?)$/);
  /* v10.13 参考号**必须带数字**（同 parsePayNow / parseDBS / parsePayLahShot）：
     形状 `[A-Za-z0-9]{6,}` 单看是过得了 `Successful` / `Completed` 这种值的，
     一旦命中，所有这类通知的 hash 都变成 `nets:Successful` → 互撞 → 静默丢账。 */
  const rf0 = pick("Reference\\s*(?:number|no\\.?)?", /^([A-Za-z0-9]{6,})$/i);
  const rf = (rf0 && /\d/.test(rf0[1])) ? rf0 : null;
  const ac = pick("From your account", /\(?-?(\d{4,8})\)?$/);
  const cur = am[1] ? am[1].toUpperCase() : "SGD";
  const merchant = to ? to[1].trim().replace(/\s+/g, " ") : "NETS QR";
  const ts = `${dm[3]}-${pad(mon)}-${pad(parseInt(dm[1], 10))}T${hm}:00+08:00`;
  return [{
    ts,
    amount: parseFloat(am[3].replace(/,/g, "")),
    currency: cur,
    merchant,
    isPerson: false,                // NETS QR = 商家消费，不是转账给人 → 分类照锁（跟 MariBank 同一把尺）
    card_last4: "PayNow",           // 哨兵值：前端按这个把它归进 PayNow 那一格
    source: "paynow",               // 使用者指定：NETS 归成 PayNow
    /* raw 不是邮件原文，是几十字节的来源标记（见总纲 v10.4 §二那段）。
       这里刻意写 "NETS …" 而不是 "PayNow …"：画面上归 PayNow，查起来看得出是哪条管道进来的。
       ⚠️ 这个字段 INSERT 一定会绑，漏写 = 绑到 undefined = 整笔存不进去（第一版就漏了，被回归测试抓到）。 */
    raw: `NETS ${cur}${am[3]} ${merchant}${ac ? ` (${ac[1]})` : ""}`,
    /* hash 用 nets: 前缀（不是 paynow:）—— 万一哪天一笔 PayNow 转账的参考号跟 NETS 参考号撞了，
       INSERT OR IGNORE 会**静默**跳过一笔。前缀分开就永远不会。前缀只是去重指纹，不影响归类。 */
    /* v10.13 退路 hash 补上商家（跟 parsePayNow v23.26 同一个理由）：
       以前只有「时间+金额」，同一分钟、同金额、都没参考号的两笔不同交易会互撞 → 第二笔静默丢掉。 */
    hash: rf ? `nets:${rf[1]}` : `nets:${ts}:${am[3]}:${merchant.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24)}`,
  }];
}

/* ---- v9.29 PayLah! App 截图解析（iOS 捷径 + Apple Vision OCR 出来的文字）----
   真实样本（2026-07 实跑，不是照截图猜的）：
     20:18
     •il 5G 76
     History PayLah!
     MA
     You paid MX AMMXX THXX CH
     SGD 9.00
     20 JUL • 01:30 PM
     Payment Source | Type PayLah! [PAYNOW
     Transaction Ref. No.
     IP178452545726811745
     Phone Number
     86864163

   ⚠️ 三个坑，全部踩过，别再改回去：
   1. 第一行 "20:18" 是**截图当下的状态栏时钟**，不是交易时间（交易时间是 01:30 PM）。
      所以抓时间必须「日期+时间」一起锁死，绝不能裸抓 /\d{1,2}:\d{2}/。
   2. 第二行 "•il 5G 76" 里的 76 是**电量**。金额必须锁 [A-Z]{3} 货币前缀，不能裸抓数字。
   3. 原图的分隔符 "·" 被 Vision 读成 "•"（U+2022，不同字符），两个都要容忍。

   另外：Vision 偶尔会吃掉收款人最后一个字（原图 ...CHX → OCR ...CH）。
   不影响记账，因为金额/时间/ref 都准；只是商家记忆会以 OCR 版为准。

   去重：ref 跟 DBS 邮件是同一串 → hash 都是 `dbs:${ref}` → 邮件那笔进来时
   INSERT OR IGNORE 自动跳过，同一笔不会记两次。 */
function parsePayLahShot(raw) {
  const t = String(raw).replace(/\r/g, "");
  /* ⚠️ v10.15 收款不记账（铁律2）。这支以前没有守卫。
     它现在的分流闸门是 `You paid` + `Transaction Ref` 两个词同时出现，所以纯收款截图
     多半根本轮不到它 —— 但**历史清单**那种截图（一页里既有 You paid 又有 You received）会：
     下面抓金额用的是「整段文字里第一个 SGD X.XX」，很可能抓到那笔收款的金额，
     再配上 You paid 那家店的名字 —— 一笔金额和商家对不上的假账，最难查。整段一起挡掉。 */
  if (looksIncoming(t)) return [];

  // 坑 2：必须有货币前缀
  let amt = t.match(/\b([A-Z]{3})\s*([\d,]+\.\d{2})\b/);
  /* v10.15 截图文字是**整段扫**（没有 Amount 标签可锁），跟 parseDBS 同一个病：
     OCR 出来的任何三个大写字母 + 金额都会中。币种不合法就往下找第一组合法的。 */
  if (amt && !isIso(amt[1])) amt = isoPick(t) || amt;
  // 坑 1 + 坑 3：日期和时间必须连在一起
  const dt = t.match(/(\d{1,2})\s+([A-Za-z]{3})\s*[•·・]?\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!amt || !dt) return [];

  const mon = MON[dt[2].toLowerCase()];
  if (!mon) return [];

  let h = parseInt(dt[3], 10) % 12;          // 12 小时制 → 24 小时制
  if (/pm/i.test(dt[5])) h += 12;

  const day = parseInt(dt[1], 10);
  /* ⚠️ 年份：guessYear() 是为「实时收到的邮件」设计的，只会往前后各推半年。
     但截图可以**补记很久以前**的交易 —— 7 月截一张去年 12 月的图，guessYear
     会算成「今年 12 月」，变成一笔未来的账。所以算出未来日期就往回退一年。 */
  let year = guessYear(mon);
  const sgToday = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  if (`${year}-${pad(mon)}-${pad(day)}` > sgToday) year -= 1;

  const ts = `${year}-${pad(mon)}-${pad(day)}T${pad(h)}:${dt[4]}:00+08:00`;
  const amount = parseFloat(amt[2].replace(/,/g, ""));

  /* ⚠️⚠️ v10.13 第一条以前带 `i` 旗标 —— 而 `i` 会连 `[A-Z0-9]` 一起放宽成大小写都收。
     于是「Transaction Ref. No.」下一行如果是任何 10 个字母以上的英文字（实测 `Successfully`），
     就会被当成参考号 → hash 变成 `dbs:Successfully` → 每一张这种截图互撞，
     第二笔起被 INSERT OR IGNORE 静默丢掉。跟 parsePayNow 那个 `Ref`→`erences` 是同一类事故。
     两道保险：字元类改成明确的大写英数（标签部分仍不分大小写），值再要求**带数字**。 */
  const rm = t.match(/[Tt]ransaction\s*[Rr]ef[^\n]*\n\s*([A-Z0-9]{10,})/)
          || t.match(/\b(IP[A-Z0-9]{10,})\b/);
  const ref = (rm && /\d/.test(rm[1])) ? rm[1] : "";

  // 收款人跟 "You paid" 在**同一行**（不是下一行）
  const pm = t.match(/You\s+paid\s+(.+)/i);
  let merchant = pm ? pm[1].trim() : "";
  merchant = merchant.replace(/\s{2,}/g, " ").trim();

  return [{
    ts, amount, currency: amt[1],
    merchant: merchant || "PayLah Transfer",   // 抓不到才退通用名（通用名不会被学进商家记忆）
    isPerson: true,                            // v9.72 转账给人：名字不代表分类，只当提示不锁死
    card_last4: null, source: "dbs",
    raw: `DBS ${ref || "shot"}`,
    hash: ref ? `dbs:${ref}` : `dbs:shot:${ts}:${amount}`,
  }];
}

/* ═══ v10.24 Wise 卡消费【截图】→ 支出 ═══
   跟 parsePayLahShot / parseMaybankShot / parseTnGShot 同一个概念：**截图/粘贴**那条链专用（不进 email()）。
   真实样本（Wise 交易详情页，照片 IMG）：
     01:18            ← 状态栏时钟（噪音）
     Pending
     346.91 CNY       ← 金额【数字在前、币种在后】
     Weixin Panduo Platform   ← 商家（无标签，就在金额下一行）
     Shopping         ← Wise 自己的分类（我们不用，用自家分类器）
     If the merchant doesn't claim this payment by August 21, 2026, we'll automatically return your money.
     When   August 12, 2026 at 01:03   ← 交易时间
     Which card   Infinite Canvas, 0977 ← 卡尾四码
     Authorised via   Manual entry
   ⚠️ 五个坑（跟别的截图一脉相承）：
   1. 金额【数字在前币种在后】"346.91 CNY"（跟别支相反），且必须真 ISO（挡状态栏 01:18 / 电量 39 那种裸数字）。
   2. **画面上有两个日期**：交易时间 "August 12, 2026 at 01:03" vs 自动退款期限 "by August 21, 2026, we'll…"。
      只认后面带 "at HH:MM" 的那个（交易时间）—— 绝不能抓成退款期限那个 21 号。
   3. 时间钉在日期后面的 "at 01:03"，别抓成状态栏时钟 01:18。
   4. 商家没有标签，是金额下一行 "Weixin Panduo Platform"（跳过 Pending/Shopping/分类那些噪音行）。
   5. 无交易参考号 → hash 用 时间+金额+卡尾，独立前缀 wise:（跟别支永不撞）。
   闸门钉 Wise 专有字段 "Which card" + "Authorised via"，别的银行/钱包截图都不含这两个词。
   ⚠️ 跟别的截图同一把尺：先过 looksIncoming（收款不记账，铁律2）—— 收进来的（退款那种）不在这支记。 */
function parseWiseShot(raw) {
  const t = String(raw).replace(/\r/g, "");
  if (!/Which\s+card/i.test(t) || !/Authorised\s+via/i.test(t)) return [];
  if (looksIncoming(t)) return [];
  /* 金额【数字在前币种在后】"346.91 CNY" / **"79 CNY"（整数，无小数）** / "5.72 USD"。
     ⚠️ v10.24b：小数点**可有可无** —— Wise 整数金额不带 .00，旧版硬要 `\.\d{2}` → "79 CNY" 整笔读不到（真实踩过）。
     用 matchAll **扫第一个「数字 + 真 ISO 币种」**（不是第一个三字母就要）—— 挡状态栏时钟/5G/电量，
     也挡页尾 "PDF/PNG less than 10MB" 那种三字母噪音（它们不是 ISO 币种，isIso 直接刷掉）。 */
  const NUM = "([\\d,]+(?:\\.\\d{1,2})?)";
  let currency = "", amount = NaN;
  for (const mm of t.matchAll(new RegExp(NUM + "\\s*([A-Z]{3})\\b", "g"))) {
    if (isIso(mm[2])) { currency = mm[2].toUpperCase(); amount = parseFloat(mm[1].replace(/,/g, "")); break; }
  }
  if (!currency) for (const mm of t.matchAll(new RegExp("\\b([A-Z]{3})\\s*" + NUM + "\\b", "g"))) {
    if (isIso(mm[1])) { currency = mm[1].toUpperCase(); amount = parseFloat(mm[2].replace(/,/g, "")); break; }
  }
  if (!currency || !isFinite(amount)) return [];
  // 日期时间：钉 "<Month> D, YYYY at HH:MM"（认交易时间那个，退款期限没有 "at HH:MM" → 不会被抓）
  const dt = t.match(/([A-Za-z]{3,9})\s+(\d{1,2}),\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})/);
  if (!dt) return [];
  const mon = MON[dt[1].slice(0, 3).toLowerCase()];
  if (!mon) return [];
  const ts = `${dt[3]}-${pad(mon)}-${pad(+dt[2])}T${pad(+dt[4])}:${dt[5]}:00+08:00`;
  /* 卡尾四码 "Infinite Canvas, 0977"。
     ⚠️⚠️ v10.25b 真实踩过：OCR 有时把**标签全部排在一起、值全部排在后面**（When/Where/Which card/… 一坨，
        再 August 11, 2026 at 21:55 / … / Infinite Canvas, 0977 一坨）。旧的 `Which card[\s\S]{0,40}?(\d{4})`
        于是咬到日期里的年份 **2026** 当卡号（App 里卡号那格显示成 2026 —— 使用者一眼看出来的就是这个）。
        改成钉**卡号本身的形状**：`<字母>, <四位数>` —— 卡名结尾是字母（Canvas,），而日期是 `11, 2026`
        逗号前是数字，两者天生分得开。全文只有卡这一处是「字母,四位数」，跟 OCR 排版顺序无关。
        退路才回到 Which card 近邻，且**排除 19xx/20xx 年份**，双保险。 */
  let cm = t.match(/[A-Za-z]\s*,\s*(\d{4})\b/);
  if (!cm) cm = t.match(/Which\s+card[\s\S]{0,40}?\b(?!19\d\d|20\d\d)(\d{4})\b/i);
  const last4 = cm ? cm[1] : null;
  // 商家：金额那行的**下一行**（跳过 Pending / 分类 / Wise UI 噪音）。用已抓到的 currency 精准定位金额行（整数金额也找得到）
  const lines = t.split("\n").map((s) => s.trim()).filter(Boolean);
  const NOISE = /^(Pending|Completed|Shopping|Food|Bills|Transport|Groceries|Entertainment|Travel|General|Learn more|Online|Manual entry|Saved details|Apple Pay|Google Pay|Transaction details|Where|When|Which card|Authorised via|Note|Add|Recurring payment|Add receipt|Split this transaction|Request money from others)$/i;
  const amtLineRe = new RegExp(NUM + "\\s*" + currency + "\\b|\\b" + currency + "\\s*" + NUM);
  let merchant = "";
  const ai = lines.findIndex((l) => amtLineRe.test(l));
  if (ai >= 0) for (let i = ai + 1; i < lines.length && i <= ai + 3; i++) {
    if (!NOISE.test(lines[i]) && /[A-Za-z]/.test(lines[i])) { merchant = lines[i].replace(/\s+/g, " ").trim(); break; }
  }
  return [{
    ts, amount, currency,
    merchant: merchant || "Wise",       // 抓不到才退通用名（通用名不会被学进商家记忆）
    isPerson: false,                    // 卡消费给商家，不是转账给人 → 分类照锁（跟 MariBank/NETS 同一把尺）
    card_last4: last4,
    source: "wise",
    raw: `Wise ${currency}${amount} ${merchant}`.trim(),
    hash: `wise:${ts}:${amount}:${last4 || "x"}`,   // 无参考号：时间+金额+卡尾，独立前缀 wise:
  }];
}

/* ---- v9.61 Touch 'n Go eWallet 截图解析（马来西亚，RM）----
   真实样本（2026-07 实跑，不是猜的）：
     08:44
     •ll 5G
     84)
     Details
     -RM200.00
     Transaction Type
     Transfer to Wallet
     Transfer To
     LIEW XIN YI
     ...
     Date/Time
     21/07/2026 00:37:29
     Wallet Ref
     2026072111121700010100171916968110265
     Transaction No.
     73f558f1-5ac5-4659-8e90-
     65beaf93dcc9

   ⚠️ 四个坑：
   1. **UUID 被 OCR 拆成两行**（在第 4 个 hyphen 后断行）→ 正则要允许中间有换行，接回来再用。
   2. "RM" 只有**两个字母**，PayLah 那支 parser 要求 [A-Z]{3}，永远不会命中 → 必须独立一支。
   3. Wallet Ref 是**37 位纯数字**，金额正则不锁 RM 前缀就会抓到它。
      状态栏的 08:44 和电量 84) 也在文字里，日期时间必须整串一起锁。
   4. 日期是 **DD/MM/YYYY**，绝不能当 MM/DD（21/07 会失败，但 05/06 那种会静默错掉）。

   马来西亚 UTC+8，跟 SGT 同一个时区 → 直接贴 +08:00 是对的。
   TnG 不会寄邮件给你，所以没有邮件那笔可以对撞；UUID 保证同一张图重跑不会变两笔。 */
function parseTnGShot(raw) {
  const t = String(raw).replace(/\r/g, "");

  // 坑 3：必须锁 RM 前缀
  const am = t.match(/(^|\n)\s*([-+])?\s*RM\s*([\d,]+\.\d{2})/);
  if (!am) return [];
  /* 收款（+RM）不当支出记。宁可让它掉进收件箱「读不到」让你看见，
     也不要静默记成一笔方向相反的账。
     v10.15 再加一道文字守卫：`+` 号靠 OCR 认，而 `+` 这么细的符号是 OCR 最容易吃掉的东西之一
     （吃掉就变成一笔支出，静默的）。措辞那条跟符号那条互为备份。 */
  if (am[2] === "+") return [];
  if (looksIncoming(t)) return [];

  // 坑 3 + 坑 4：日期和时间整串一起锁
  const dt = t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\b/);
  if (!dt) return [];
  const D = +dt[1], M = +dt[2], Y = +dt[3];
  if (M < 1 || M > 12 || D < 1 || D > 31) return [];

  const ts = `${Y}-${pad(M)}-${pad(D)}T${pad(+dt[4])}:${dt[5]}:${dt[6]}+08:00`;
  const amount = parseFloat(am[3].replace(/,/g, ""));

  // 坑 1：UUID 跨行接回来；接不到就退而用 Wallet Ref
  const um = t.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-\s*[0-9a-f]{12})/i);
  const wm = t.match(/Wallet\s*Ref[^\n]*\n\s*(\d{10,})/i);
  const ref = um ? um[1].replace(/\s+/g, "") : (wm ? wm[1] : "");

  /* v9.87 统一商家提取（跟 DBS/OCBC/PayNow 同一套思路，不给 TnG 开小灶）：
     按优先级找真正的商家名，绝不把「支付方式」当商家。
     ① Merchant / Merchant Name / Recipient 字段
     ② Payment Details / Transaction Detail（去掉 "DuitNow QR -" 这类固定前缀）
     ③ Transfer To 下一行（转账给人）
     都抓不到 → 空 → 退回通用名（而通用名在 GENERIC 里，绝不会被学成共用规则）。 */
  const PAY_WORDS = /^(duitnow\s*qr|duitnow|transaction type|pay via|payment method|fund transfer|ewallet balance|successful|transfer to wallet|wallet|reload|tng ewallet|touch\s*'?n\s*go)$/i;
  const stripPrefix = s => s.replace(/^\s*(duitnow\s*qr|duitnow)\s*[-:–]\s*/i, "").trim();
  // 值不能是金额、日期、纯数字、支付方式词、太短
  const badVal = v => !v || v.length < 2 || PAY_WORDS.test(v)
    || /^[-+]?\s*RM\s*[\d,]/i.test(v) || /^[-+]?[\d,]+\.\d{2}$/.test(v)
    || /^\d[\d\/:\s-]*$/.test(v) || /^[0-9a-f-]{20,}$/i.test(v);
  let merchant = "", fromPerson = false;
  // ① Merchant / Recipient 字段（标签独占一行，值在下一行）→ 商家消费
  let mm = t.match(/\n\s*(?:Merchant(?:\s*Name)?|Recipient|Paid\s*To|Pay\s*To)[ \t]*[:：]?[ \t]*\n?[ \t]*(.+)/i);
  if (mm) { const v = stripPrefix(mm[1].trim().replace(/\s{2,}/g, " ")); if (!badVal(v)) merchant = v; }
  // ② Payment Details / Transaction Detail（去 "DuitNow QR -" 前缀）→ 商家消费
  if (!merchant) {
    const pd = t.match(/\n\s*(?:Payment\s*Details?|Transaction\s*Details?)[ \t]*[:：]?[ \t]*\n?[ \t]*(.+)/i);
    if (pd) { const v = stripPrefix(pd[1].trim().replace(/\s{2,}/g, " ")); if (!badVal(v)) merchant = v; }
  }
  // ③ Transfer To 下一行 → 转账给人（分类只当提示，不锁死）
  if (!merchant) {
  /* ⚠️⚠️ v23.26 第二轮，拿到真实 TnG 收据（IMG_6774）才发现的：
     ①②两条都写成 `\n?` = 「标签和值同一行、或值在下一行」两种 OCR 形态都吃，
     只有这条③写死了一个**必须存在**的 `\n` —— 也就是只吃「值在下一行」。
     实测：同一张收据，Live Text 抄成同行时（`Transfer To    EPHRAIM LEVI SOLIBUN`）
     这条就不匹配 → 收款人退回通用名 `TnG Transfer`、`isPerson` 也变成 false。

     ⚠️ 但那个 `\n` **不是手滑，它在挡一件事**：同一张收据上面还有一行
        `Transaction Type` / `Transfer to Wallet`
     一旦允许同行，正则会先咬到 `Transfer to Wallet` 这一行、把 `Wallet` 当成收款人
     （badVal 挡不住 —— `Wallet` 不在 PAY_WORDS 里，长度也够）。
     所以放宽的同时必须补两道：
       ① 改用 matchAll 逐个试，被 badVal 挡掉就继续往下找，而不是「第一个不合格就放弃」
       ② PAY_WORDS 补一个单独的 `wallet`
     两道齐了，两种形态都能抓到真正的收款人。 */
    for (const pm of t.matchAll(/\n[ \t]*Transfer\s*To[ \t]*[:：]?[ \t]*\n?[ \t]*([^\n]+)/gi)) {
      const v = pm[1].trim().replace(/\s{2,}/g, " ");
      if (badVal(v)) continue;
      merchant = v; fromPerson = true; break;
    }
  }

  return [{
    ts, amount, currency: "MYR",
    merchant: merchant || "TnG Transfer",
    card_last4: "TnG",        // 付款方式会显示成 TnG，之后可以自己改名
    isPerson: fromPerson,                      // v9.88 只有「Transfer To 某人」才是转账给人；商家消费(Merchant字段)= false，分类照锁
    source: "tng",
    raw: `TnG ${ref || "shot"}`,
    hash: ref ? `tng:${ref}` : `tng:shot:${ts}:${amount}`,
  }];
}

/* v9.94 常见币种白名单（给 parser 的退路正则用，挡掉 SGT / REF / PIN 这种三个大写字母）。
   不求全，够覆盖你会刷到的地方就好；漏了的话那封信会掉进「读不到」收件箱，不会记错账 —— 这是安全的失败方向。 */
const ISO4217 = new Set(["SGD","USD","MYR","CNY","HKD","TWD","JPY","KRW","THB","VND","IDR","PHP",
  "INR","EUR","GBP","AUD","NZD","CAD","CHF","AED","SAR","TRY","ZAR","BRL","MXN","RUB","SEK",
  "NOK","DKK","PLN","CZK","HUF","MOP","BND","KHR","LAK","MMK","LKR","PKR","BDT","NPR"]);

/* ═══ v10.15 「币种必须是真的 ISO 4217」—— isoPick(text) ═══
   v10.14 的 ISO4217 白名单**只挂在 parseMariBank 的退路正则上**，主金额路径一条都没走它。
   以前以为这只是「币种会怪一点」（前端有 FX_MISS 红字兜底，不是静默 1:1）。实测发现更贵：
   抓错币种的同时**金额也一起抓错了**，因为币种和金额是同一条正则一起捕获的 ——

     parsePayNow 那条是 `\b([A-Z]{3}|S$|RM)\s*([\d,]+\.\d{2})` 而且带 `i` 旗标，
     `[A-Z]{3}` 在 `i` 底下连小写都吃 = **任何三个字母**。实测：
       正文 "A fee was 313.92 charged previously. … Amount : SGD 5.80"
       → 记成 **WAS 313.92**（不是 SGD 5.80）—— 一笔 54 倍的假账，进的是「已记录」。
       "Ref 20.00 … Amount : SGD 5.80" → 记成 REF 20。
     parseDBS / parsePayLahShot 抓不到 `Amount:` 标签时是**扫整段文字**，同一个病。

   规则（刻意选最不会丢东西的那条）：
     · 抓到的三码在白名单里 → 一个字节都不动（正常信 100% 走这条，行为完全没变）
     · 不在白名单 → 在**同一段文字**里往下找第一组「合法币种 + 金额」，找到就整组换掉
       （币种和金额一起换，才不会张冠李戴）
     · 整段都找不到合法币种 → **原样保留、照记**。宁可币种怪也不要整笔不记 ——
       前端 FX_MISS 会在那笔上挂红字「没有汇率 · 暂按 1:1 算」，你看得见；
       整笔不记就变成掉进「读不到」，反而多一步手工。
   回传做成跟 String.match 一样的形状 [整串, 币种, 金额]，接进去只要一行。 */
/* ⚠️⚠️【型别注解补丁 · 纯注解，WORKER_VER 刻意不动，维持 v10.15】
   Cloudflare 编辑器那 3 个红字（TS2741，出现在 3432 / 3622 / 3859 三行）根源就在这里。
   那三行都是同一个写法：`am = isoPick(...) || am`，而 `am` 是 `text.match(...)` 来的。
   编辑器的类型检查认定 `.match()` 的结果是 RegExpMatchArray（原生 match 物件，规定「第 0 格一定有」），
   而 isoPick 回的是一个**手工拼的普通阵列** —— 型别对不上，就在赋值那一格标红。

   ⚠️ 这是**纯静态检查的抱怨，不是 bug**：跑起来一直都是对的，因为所有用它的地方只读 [0]/[1]/[2]，
      普通阵列一样读得到。（全档 grep 过，没有任何一处读 .index / .input / .groups。）

   修法刻意选「只加注解、一个会执行的字元都不动」：下面加的是 JSDoc 注解 + 一对括号，
   实际跑的东西跟旧版逐字相同，解析结果不可能变。

   ⚠️ 别改成 `return m;`（直接回原生 match 物件）—— 那样 .index / .input 会从 undefined 变成真值，
      现在没人读，但以后有人读就是隐形的行为变更。维持「回三格普通阵列」这个约定。
   ⚠️ 也别把下面那行 JSDoc 删掉再「顺手」写成一般注解 —— 型别标记只有 JSDoc 形式（两个星号开头）才算数，
      删了红字就回来了。 */
/** @returns {RegExpMatchArray|null} 形状跟 String.match 一样：[整串, 币种(已转大写), 金额] */
function isoPick(text) {
  for (const m of String(text || "").matchAll(/\b([A-Za-z]{3})\s?([\d,]+\.\d{2})\b/g)) {
    if (ISO4217.has(m[1].toUpperCase()))
      return /** @type {RegExpMatchArray} */ ([m[0], m[1].toUpperCase(), m[2]]);
  }
  return null;
}
const isIso = (c) => ISO4217.has(String(c || "").toUpperCase());

/* ---- v9.91 MariBank 消费通知（**邮件和截图共用同一支**）----
   真实样本（2026-08-02 实跑，从别人手机转发两手进 spend@）：
     You have made a payment to Alipay*Taobao on your credit card ending 5831
     with 0% FX fees.
     Transaction Time:
     02 Aug 2026 16:51 SGT
     Amount:
     CNY 20.00

   ⚠️ 五个坑：
   1. **全封没有参考号**（连交易编号都没有）→ hash 只能用 时间+金额+卡号 拼。
      ✅ 好处：邮件版和截图版算出来的 hash **完全一样** → 你两边都送进来会自动去重。
      ⚠️ 代价：同一分钟、同一张卡、同一金额的两笔**会被当成一笔**。极罕见，认了。
   2. **币种是 CNY** —— 全档第一次出现 SGD/USD/MYR 以外的币。见 /api/fx 那边的 CNY 支援。
   3. 商家名和 "on your credit card" 常被邮件的 quoted-printable **折行拆开**（这次就是）
      → 正则必须吃换行，抓完再把空白压成一个空格。
   4. **标签和值分行**：`Amount:` 一行、`CNY 20.00` 在下一行 → 不能用同行正则。
   5. 截图版有状态栏 `22:42` 和电量 `67` → 时间必须**连日期一起锁**、金额必须锁三码货币前缀。
      （跟 PayLah/TnG/Maybank 那三支同一个教训，别重蹈。） */

/* ═══ v11.05 MariBank 退款 → 记成【收入】═══
   ⚠️ 这是**全 app 唯一**会主动记「收入」的地方（使用者明确要求：MariBank 退款算收入）。
   退款邮件格式跟付款不同：日期**内联**（「received a refund on 04 Aug 2026 18:57 SGT」）、
   商家在 `Merchant Name:` 下一行、金额在 `Refunded Amount:` 下一行。所以单独一支。
   ⚠️ 它**不调 looksIncoming** —— 那把尺是用来挡「收款不记」的，而退款正是要记，两者相反。
      为了不误伤，它排在 parseMariBank 前面、闸门收得很窄（必须同时是 MariBank + refund），
      普通付款邮件不含这些字 → 回 [] → 分流链继续走到 parseMariBank 照旧当支出。
   ⚠️ hash 用独立前缀 `mbkrf:` + 时间+金额+卡号 —— 跟付款的 `mbk:` 永不撞（就算退了跟原付款
      同额同卡，前缀和时间也不同），也跟别支的参考号指纹不同类。 */
function parseMariBankRefund(raw) {
  /* ⚠️ 走 htmlToLines（跟 parseDBS/parsePayNow 同一把尺）：真 MariBank 邮件是 HTML，
     `Merchant Name:` 跟值 `Alipay*RED Note` 常在同一个表格格里（<td>标签</td><td>值</td>），
     不先拆成干净的行，下面「标签换行值」的正则会跨着 HTML 标签乱抓，商家变成一坨 `<tr><td>…`。
     htmlToLines 把每个 td/p/br 拆成一行 → 标签、值各自独占一行，正则才吃得到。纯文字/截图不受影响。 */
  const t = htmlToLines(raw).join("\n");
  if (!/MariBank/i.test(t)) return [];
  if (!/received\s+a\s+refund/i.test(t) && !/Refunded\s*Amount/i.test(t)) return [];   // 必须是退款
  // 日期：优先「refund on <日期>」内联那条；退而求其次靠 SGT 后缀锁整串
  const dt = t.match(/refund\s+on\s+(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})\s+(\d{1,2}):(\d{2})/i)
          || t.match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(?:SGT|SST)/i);
  if (!dt) return [];
  const mon = MON[dt[2].toLowerCase()];
  if (!mon) return [];
  const ts = `${dt[3]}-${pad(mon)}-${pad(+dt[1])}T${pad(+dt[4])}:${dt[5]}:00+08:00`;
  // 金额：`Refunded Amount:` 下一行，一定要 ISO 币种前缀（跟付款那支同一把尺）
  let am = t.match(/Refunded\s*Amount[^\n]*\n\s*([A-Z]{3})\s*([\d,]+\.\d{2})/i);
  if (am && !isIso(am[1])) am = isoPick(t) || am;
  if (!am) { const m2 = t.match(/\b([A-Z]{3})\s*([\d,]+\.\d{2})\b/); if (m2 && ISO4217.has(m2[1].toUpperCase())) am = m2; }
  if (!am) return [];
  const currency = am[1].toUpperCase();
  const amount = parseFloat(am[2].replace(/,/g, ""));
  const nm = t.match(/Merchant\s*Name[^\n]*\n\s*([^\n]{1,60})/i);
  const merchant = nm ? nm[1].replace(/\s+/g, " ").trim() : "";
  const cm = t.match(/card\s+ending\s*(\d{4})/i);
  const last4 = cm ? cm[1] : null;
  return [{
    ts, amount, currency,
    merchant: merchant || "MariBank 退款",
    isPerson: false,
    card_last4: last4,
    source: "maribank",
    type: "income",                                    // ⭐ 退款 = 收入（唯一记收入的地方）
    raw: `MariBank refund ${currency}${am[2]} ${merchant}`.trim(),
    hash: `mbkrf:${ts}:${amount}:${last4 || "x"}`,      // 独立前缀，跟付款 mbk: 永不撞
  }];
}

function parseDBSPayNowIn(raw) {
  /* ⭐ v11.07 收入破例②：DBS / POSB PayNow「收到转账」→ 记成【收入】（照片 IMG_6963）。
     跟 MariBank 退款(mbkrf:)一样，是 looksIncoming 之外**刻意要记**的收款：独立前缀 dbspnin:、type:income，
     跟任何支出的 hash 永不撞。
     ⚠️⚠️ 闸门钉死在「received <币种><金额> via PayNow」这一句上 —— 这句只有**收到钱**才有；
        付出去的 PayNow 写的是 "transfer to / You have sent"，绝不会出现这句，所以【不可能把支出误记成收入】。
     ⚠️ 必须排在 parsePayNow / parseDBS 前面：那两支一看到 looksIncoming 就整封退 []（这封会掉进「读不到」）。
     ⚠️ htmlToLines：真邮件是 HTML，From/To 常各自独占一格，先拆行 From 才抓得到付款人。 */
  const t = htmlToLines(raw).join("\n");
  if (!/DBS|digibank|POSB/i.test(t)) return [];
  const am = t.match(/received\s+([A-Z]{3})\s*([\d,]+\.\d{2})\s+via\s+PayNow/i);   // 收到 + via PayNow，币种金额一起抓
  if (!am) return [];
  if (!isIso(am[1])) return [];                                    // 币种必须真 ISO 4217，抓错币种＝抓错钱
  const currency = am[1].toUpperCase();
  const amount = parseFloat(am[2].replace(/,/g, ""));
  const dt = t.match(/on\s+(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})\s+(\d{1,2}):(\d{2})/i);   // on 07 Aug 2026 17:18（带年份）
  if (!dt) return [];
  const mon = MON[dt[2].toLowerCase()];
  if (!mon) return [];
  const ts = `${dt[3]}-${pad(mon)}-${pad(+dt[1])}T${pad(+dt[4])}:${dt[5]}:00+08:00`;
  /* 付款人（收入的「商家」＝谁给你钱）：From: CHAN YI SHENG。真邮件常写成 *From:*（粗体星号），
     所以 From 后面允许 : / * / 空白。
     ⚠️ v10.22 首字与字符集**允许数字与 &**（跟 parsePayNow v10.18 同一把尺，别再让某一支落后）：
        付款人不只是人，也可能是数字开头的公司（96FRESH MART / 7-Eleven / 365…）在给你退钱/转账。
        旧的 `[A-Z][A-Za-z .'\-]` 首字硬要字母、名字里不许有数字 → 这类一律抓不到、掉成通用名 "PayNow 收款"。
        放宽后仍要求**至少一个字母**（挡掉把账号那串纯数字误当付款人），且保留下面 @<> 与 your/dbs/posb 守卫。 */
  const nm = t.match(/From[:*\s]+([A-Za-z0-9][A-Za-z0-9 .'&\-]{1,40})/i);
  let payer = nm ? nm[1].replace(/\s+/g, " ").trim() : "";
  if (payer && !/[A-Za-z]/.test(payer)) payer = "";                    // 纯数字/符号不算名字（同 parsePayNow）
  if (/[@<>]/.test(payer) || /^(your|dbs|posb)\b/i.test(payer)) payer = "";
  const ac = t.match(/account\s+ending\s*(\d{4})/i);
  const acct = ac ? ac[1] : null;
  const rm = t.match(/\b(PIB[A-Za-z0-9]{6,})\b/i) || t.match(/Transaction\s*Ref[^\n]*?\b([A-Za-z0-9]{8,})\b/i);
  const ref = (rm && /\d/.test(rm[1])) ? rm[1] : "";               // 参考号必须带数字（跟别的 parser 同一把尺）
  return [{
    ts, amount, currency,
    merchant: payer || "PayNow 收款",
    isPerson: false,
    card_last4: null,
    source: "dbs",
    type: "income",                                                // ⭐ 收入（第二个记收入的地方）
    raw: `DBS PayNow in ${currency}${am[2]} ${payer}`.trim(),
    hash: ref ? `dbspnin:${ref}` : `dbspnin:${ts}:${amount}:${acct || "x"}`,   // 独立前缀，跟支出永不撞
  }];
}

/* ═══ v10.20 收入破例③：PayLah! 退款 → 记成【收入】（照片 IMG，BCRS LTD SGD 0.70）═══
   跟 MariBank 退款(mbkrf:)、DBS PayNow 收款(dbspnin:) 同一类：looksIncoming 之外**刻意要记**的进账。
   真实样本：
     Transaction Ref: 260810215418MC859446
     We refer to your PayLah! refund transaction below and are pleased to confirm ...
     Date & Time: 10 Aug21:54 (SGT)
     Amount: SGD 0.70
     From: BCRS LTD
     To: PayLah! Wallet (Mobile ending 6301)
   ⚠️ 五个坑，跟前两支退款/收款一脉相承：
   1. 闸门钉死「PayLah + refund transaction」这句 —— 只有退款信才有；普通 PayLah 付款写的是
      "You paid / debited"，绝不含这句 → 回 [] → 分流链继续走 parseDBS 照旧当支出。
      ⚠️ 必须排在 parseDBS 前面（`raw.includes("PayLah")` 会被 parseDBS 认领），否则这封先被
         parseDBS 抢走当支出/或退 [] 掉进「读不到」。
   2. htmlToLines：真邮件是 HTML，From/To/Amount 各自独占一格，先拆行标签才咬得到值。
   3. 日期 **没有年份**、而且「Aug21:54」月名和时间**中间没空格**（真实就长这样）→ 月名后允许
      `\s*` 零空格再接时间；年份靠 guessYear 用真实月份猜（跟 PayLah 的 PayNow 同一个处理）。
   4. 金额一定要 ISO 币种前缀（SGD 0.70），挡掉把 "Mobile ending 6301" 那种裸数字误当金额。
   5. hash 独立前缀 `plrf:` + 参考号（带数字才算），跟支出的 `dbs:` / `paynow:` 永不撞；
      抓不到参考号退到 时间+金额，本来就够独特。 */
function parsePayLahRefund(raw) {
  const t = htmlToLines(raw).join("\n");
  if (!/PayLah/i.test(t)) return [];
  if (!/refund\s+transaction/i.test(t)) return [];                 // 必须是退款那句
  let am = t.match(/Amount\s*:?\s*([A-Z]{3})\s*([\d,]+\.\d{2})/i);
  if (am && !isIso(am[1])) am = isoPick(t) || am;
  if (!am) { const m2 = t.match(/\b([A-Z]{3})\s*([\d,]+\.\d{2})\b/); if (m2 && ISO4217.has(m2[1].toUpperCase())) am = m2; }
  if (!am || !isIso(am[1])) return [];
  const currency = am[1].toUpperCase();
  const amount = parseFloat(am[2].replace(/,/g, ""));
  // 日期：10 Aug21:54（无年份、月名紧贴时间）。月名后 \s* 允许零空格，年份 guessYear 用真实月份猜
  const dt = t.match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s*(\d{1,2}):(\d{2})/);
  if (!dt) return [];
  const mon = MON[dt[2].toLowerCase()];
  if (!mon) return [];
  const year = guessYear(mon);
  const ts = `${year}-${pad(mon)}-${pad(+dt[1])}T${pad(+dt[3])}:${dt[4]}:00+08:00`;
  // 付款方（谁退你钱）＝「From: BCRS LTD」，行尾锚，去掉可能的括号尾注
  const nm = t.match(/From\s*:?\s*([^\n]{1,60})/i);
  let merchant = nm ? nm[1].replace(/\s*\([^)]*\)\s*$/, "").replace(/\s+/g, " ").trim() : "";
  if (!/[A-Za-z]/.test(merchant)) merchant = "";
  const rm = t.match(/\b(?:Transaction\s*Ref|Reference|Ref)\b\.?\s*(?:number|no\.?)?\s*[:#]?\s*([A-Za-z0-9]{6,})/i);
  const ref = (rm && /\d/.test(rm[1])) ? rm[1] : "";
  return [{
    ts, amount, currency,
    merchant: merchant || "PayLah 退款",
    isPerson: false,
    card_last4: "PayLah",
    source: "dbs",
    type: "income",                                                // ⭐ 退款 = 收入（第三个记收入的地方）
    raw: `PayLah refund ${currency}${am[2]} ${merchant}`.trim(),
    hash: ref ? `plrf:${ref}` : `plrf:${ts}:${amount}`,            // 独立前缀，跟支出永不撞
  }];
}

function parseMariBank(raw) {
  const t = String(raw).replace(/\r/g, "");
  if (!/MariBank/i.test(t)) return [];
  /* ⚠️⚠️ v10.15 收款不记账（铁律2）。这支以前也没有守卫，而且比 DBS 那支更容易中招：
     商家名抓不到会退回通用名 "MariBank" 照样记账，等于**只要有时间和金额就记**。
     实测：`You have received SGD 50.00 from ALICE` + Transaction Time → 记成一笔 SGD 50 支出。 */
  if (looksIncoming(t)) return [];

  // 坑 4 + 坑 5：先靠 "Transaction Time" 标签锁下一行；退而求其次靠 SGT 后缀锁整串
  const dt = t.match(/Transaction\s*Time[^\n]*\n\s*(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})\s+(\d{1,2}):(\d{2})/i)
          || t.match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(?:SGT|SST)/i);
  if (!dt) return [];
  const mon = MON[dt[2].toLowerCase()];
  if (!mon) return [];
  const ts = `${dt[3]}-${pad(mon)}-${pad(+dt[1])}T${pad(+dt[4])}:${dt[5]}:00+08:00`;

  /* 坑 4 + 坑 5：Amount 标签在上一行；一定要有三码货币前缀（电量 67 那种裸数字才不会中）
     ⚠️ v9.94：第二条**退路**正则原本会把任何三个大写字母当成币种 ——
     邮件里一句 `SGT 16.51` 或 `REF 20.00` 就会被当成币种 SGT / REF，
     然后前端查不到汇率 → 静默按 1:1 记进账。加一道 ISO 白名单挡掉。
     第一条（有 `Amount:` 标签的）是可靠的，不受影响。 */
  let am = t.match(/Amount[^\n]*\n\s*([A-Z]{3})\s*([\d,]+\.\d{2})/i);
  /* v10.15 F2：白名单以前**只挂在下面那条退路上**，主路径（有 `Amount:` 标签这条）没走它。
     标签那条比较可靠，但 `Amount[^\n]*\n` 的意思只是「某一行提到 Amount，取下一行」，
     加上 `i` 旗标同样是任何三个字母 —— 挡不住 `Amount:\nSGT 16.51` 这种。
     不合法就在整封里找第一组合法的；整封都没有（例如真的只有 `SGT 16.51`）就保留原样照记，
     让前端 FX_MISS 红字去提醒你，而不是把这笔账丢掉。 */
  if (am && !isIso(am[1])) am = isoPick(t) || am;
  if (!am) {
    const m2 = t.match(/\b([A-Z]{3})\s*([\d,]+\.\d{2})\b/);
    if (m2 && ISO4217.has(m2[1].toUpperCase())) am = m2;
  }
  if (!am) return [];
  const currency = am[1].toUpperCase();
  const amount = parseFloat(am[2].replace(/,/g, ""));

  // 坑 3：商家名可能跨行 → [\s\S] 吃换行，抓完压空白
  const nm = t.match(/payment\s+to\s+([\s\S]{2,60}?)\s+on\s+your\s+(?:credit|debit)\s+card/i);
  const merchant = nm ? nm[1].replace(/\s+/g, " ").trim() : "";
  const cm = t.match(/card\s+ending\s*(\d{4})/i);
  const last4 = cm ? cm[1] : null;

  return [{
    ts, amount, currency,
    merchant: merchant || "MariBank",   // 退路名在 GENERIC 里，绝不会被学成共用规则
    isPerson: false,                    // 卡消费不是转账给人 → 分类照锁（跟 v9.88 同一把尺）
    card_last4: last4,                  // 付款方式显示成 •••• 5831
    source: "maribank",
    raw: `MariBank ${currency}${am[2]} ${merchant}`.trim(),
    hash: `mbk:${ts}:${amount}:${last4 || "x"}`,   // 坑 1：没 ref，只能这样拼（mbb: 是 Maybank，别搞混）
  }];
}

/* ---- v9.65 Maybank Debit/Credit 收据截图解析（马来西亚 RM）----
   真实样本（2026-07 实跑）：
     14:001
     Ill 4G 68
     25 Jul 2026, 1:59 PM
     GSC - SOUTHKEY JB - CONCE
     -RM 86.00
     Payment
     Reference Number
     Merchant name
     Terminal ID
     Merchant ID
     Approval Code
     Maybank Debit Card Visa
     ************ 3869
     620605020913
     GSC - SOUTHKEY JB - CONCE
     91100419
     048800001792720
     151090
     Share Receipt
     ...

   ⚠️ 五个坑：
   1. **RM 后面有空格** `-RM 86.00`（TnG 是 `RM200.00` 没空格）→ 金额正则要 RM\s* 。
   2. 日期是**第三种格式** `25 Jul 2026, 1:59 PM`（英文月 + 逗号 + 12小时制）
      —— 跟 PayLah(`20 JUL`) / TnG(`21/07/2026`) 都不同。
   3. 状态栏 `14:001`（14:00 + 讯号点连在一起）+ 电量 `68` 会混进来 → 时间必须连日期一起锁。
   4. **OCR 把标签和值拆成两块**：标签全挤中间(Payment/Reference Number/...)，值全挤下面。
      → Reference Number 不能靠「下一行」抓。改用特征：它是唯一的 **12 位纯数字**
      （Terminal ID 8 位、Merchant ID 15 位、Approval 6 位、卡号 4 位，都不撞）。
   5. 卡号 `************ 3869` → 存 last4=3869，付款方式显示得出来。

   Maybank **不发邮件** → 只能截图，不会跟邮件那笔撞。去重靠 Reference Number。 */
const MON3 = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
function parseMaybankShot(raw) {
  const t = String(raw).replace(/\r/g, "");

  /* v10.15 收款不记账（铁律2）。这支本来靠「行首 `-?RM`」挡收款（`+RM` 匹配不到 → 回 []），
     但那是**符号**守卫：OCR 把 `+` 吃掉就破功，实测 `Money received from ALICE` 配 `-RM 86.00`
     照样记成支出。跟 TnG 同样的道理，措辞和符号两道一起上。 */
  if (looksIncoming(t)) return [];

  // 坑 1：RM 后可有空格；坑 3 靠日期锁，这里金额独立锁 RM 前缀
  const am = t.match(/(^|\n)\s*-?\s*RM\s*([\d,]+\.\d{2})/);
  if (!am) return [];

  // 坑 2 + 坑 3：英文月 + 12小时制，日期时间整串一起
  const dt = t.match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!dt) return [];
  const mon = MON3[dt[2].toLowerCase()];
  if (!mon) return [];
  let h = parseInt(dt[4], 10) % 12;
  if (/pm/i.test(dt[6])) h += 12;
  const ts = `${dt[3]}-${pad(mon)}-${pad(+dt[1])}T${pad(h)}:${dt[5]}:00+08:00`;
  const amount = parseFloat(am[2].replace(/,/g, ""));

  /* ⚠️⚠️ v10.13 「Reference Number = 唯一的 12 位纯数字」以前只是**注解里的假设**，
     代码其实拿的是「**第一个**」12 位数字，从来没验证过唯一性。
     真实收据里 Terminal ID 8 位、Merchant ID 15 位、Approval 6 位，所以通常确实只有一个；
     但只要哪家店的某个编号刚好也是 12 位、而且**每张收据都一样**，
     同一家店两笔不同消费就会算出同一个 `mbb:<那串数字>` → 第二笔被 INSERT OR IGNORE 静默丢掉。
     现在真的去数：
       · 刚好一个   → 照旧用它（**跟以前一字不差**，已经存进库的旧账完全不受影响）
       · 两个以上   → 分不清哪个才是参考号，**不猜**，退回「时间+金额」指纹
       · 一个都没有 → 退回「时间+金额」（跟以前一样）
     为什么不干脆一律改成「时间+金额」：那会让已经用 `mbb:<ref>` 存进去的旧账对不上，
     重传同一张旧截图会变成一笔**重复账**。只在「有歧义」这个本来就会出错的情况下才换路，
     正常收据的行为一个字节都没变。 */
  const twelve = [...new Set(t.match(/(?<!\d)\d{12}(?!\d)/g) || [])];
  const ref = twelve.length === 1 ? twelve[0] : "";

  // 坑 5：卡号后四位
  const cm = t.match(/\*{2,}\s*(\d{4})\b/);
  const last4 = cm ? cm[1] : null;

  // 商家名：金额上面那行（Merchant name 那块 OCR 顺序不稳，用标题行最稳）
  const nm = t.match(/\n([^\n]+?)\n\s*-?\s*RM\s*[\d,]/);
  let merchant = nm ? nm[1].trim().replace(/\s{2,}/g, " ") : "";
  if (/^(payment|reference number|merchant name|details)$/i.test(merchant)) merchant = "";

  return [{
    ts, amount, currency: "MYR",
    merchant: merchant || "Maybank",
    /* v9.72 只有「Transfer to Wallet」是转账给人；其他（GSC 电影院之类）是商家消费，照常硬记分类。 */
    isPerson: /Transfer to Wallet/i.test(t),
    card_last4: last4,
    source: "mbb",
    raw: `Maybank ${ref || "shot"}`,
    hash: ref ? `mbb:${ref}` : `mbb:shot:${ts}:${amount}`,
  }];
}

/* ---- v9.67 兜底猜测 guessTxn(raw)：三支专用 parser 都不认时，尽力抓 金额+日期+参考号。
   ⚠️ 定位：**不自动记账**，只用来「预填」手动表单让用户过目 + 可改（用户要求：自动填但要能 edit）。
   规则（用户定）：一律当支出；金额优先有货币前缀的，其次最像钱的数字。
   抓不到日期就回 null（前端预填成今天，用户可改）。 */
function guessTxn(raw){
  const t=String(raw).replace(/\r/g,'');

  // 金额：先找带货币前缀的（最可靠），没有再找 xx.xx 形式里最大的一个
  let cur='SGD', amount=null;
  let m=t.match(/\b(SGD|USD|RM|MYR|S\$|US\$|\$)\s*-?\s*([\d,]+\.\d{2})\b/i);
  if(m){
    const c=m[1].toUpperCase();
    cur = c==='RM'?'MYR' : c==='S$'?'SGD' : c==='US$'?'USD' : c==='$'?'SGD' : c;
    amount=parseFloat(m[2].replace(/,/g,''));
  }else{
    // 没有货币前缀：抓所有 xx.xx，排掉一看就不是钱的（比如 4 位以上整数.2位），取最大
    const nums=[...t.matchAll(/(?<![\d.])(\d{1,6}\.\d{2})(?![\d])/g)].map(x=>parseFloat(x[1])).filter(n=>n>0&&n<1e6);
    if(nums.length)amount=Math.max(...nums);
  }
  if(amount==null)return null;

  // 日期：容忍多种格式，全部锁「日期+时间」或至少日期
  let ts=null;
  const MONx={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  let d;
  if((d=t.match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})(?:,?\s+(\d{1,2}):(\d{2})\s*(AM|PM)?)?/i))){ // 25 Jul 2026, 1:59 PM
    const mo=MONx[d[2].toLowerCase()];
    if(mo){let h=d[4]?parseInt(d[4],10)%12:12; if(d[6]&&/pm/i.test(d[6]))h+=12; else if(!d[6])h=parseInt(d[4]||'12',10);
      ts=`${d[3]}-${pad(mo)}-${pad(+d[1])}T${pad(d[4]?h:12)}:${d[5]||'00'}:00+08:00`;}
  }else if((d=t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/))){ // 21/07/2026 00:37:29 (DD/MM)
    const D=+d[1],M=+d[2]; if(M>=1&&M<=12&&D>=1&&D<=31)
      ts=`${d[3]}-${pad(M)}-${pad(D)}T${pad(+(d[4]||12))}:${d[5]||'00'}:${d[6]||'00'}+08:00`;
  }else if((d=t.match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\b/))){ // 20 Jul（没年）
    const mo=MONx[d[2].toLowerCase()];
    if(mo)ts=`${guessYear(mo)}-${pad(mo)}-${pad(+d[1])}T12:00:00+08:00`;
  }

  // 参考号：最长的那串数字/字母数字（>=8），当去重指纹用；没有就用内容拼
  const ids=[...t.matchAll(/\b([A-Za-z0-9]{8,})\b/g)].map(x=>x[1]);
  const ref=ids.sort((a,b)=>b.length-a.length)[0]||'';

  return { amount, currency:cur, ts, ref };
}

/* v6.3 ingestRaw：粘贴文字 / 手动喂邮件原文 → 和 email() 完全一样的管道。
   （email() 保留它自己的实现不动；这里是给 /api/paste 用的独立版本，逻辑镜像。）
   返回 { parsed, saved, rows }。 */
/* v9.99 纯分流解析：只解析、不写库、不记收件箱。邮件文字和截图文字都吃。
   分流顺序跟 ingestRaw 一字不差（ingestRaw 现在也调用它）。删账找来源邮件、cron 回填 hash 都复用这支。 */
function parseRaw(raw, from) {
  from = (from || "").toLowerCase();
  /* v10.12 重试／删账找来源／cron 回填 hash 喂进来的，可能是**旧收件箱存的整封 MIME 原文** →
     先抽可读正文（理由见 mailBody 上面那段）。不是 MIME 就一个字节都不动：
     截图 OCR 文字、粘贴文字、以及已经抽干净的正文，行为跟以前一字不差。
     下面整条分流链**没有任何改动**（两条链必须一字不差，见 check.mjs §11）。 */
  if (looksLikeMime(raw)) raw = mailText(raw);
  /* ⚠️⚠️ v10.13 这条链以前是一串 `else if`，**认了就没有退路**：
     谁的门先开、谁抓不到东西，整封信就直接判死（回 []）→ 掉进「读不到」。
     实测最惨的一个：一封真的 DBS PayLah 邮件同时含 "You paid" 和 "Transaction Ref"
     → 门开在第 4 支（PayLah **截图** parser）→ 那支要求 "01:30 PM" 这种带 AM/PM 的写法，
     邮件写的是 "20 Jul 01:30 (SGT)" → 回 [] → 结束。而 email() 那条链根本没有第 4 支，
     同一封信收信时走 parseDBS 是认得的 —— 所以症状是「收信记得到，按『重新识别』永远认不出来」。
     现在改成：门开了就试，**抓不到就继续往下试**，试到有东西为止。
     顺序一个字都没动（NETS 仍在第一位，DBS 仍在 OCBC 前面，见 check.mjs §11），
     只是把「死路」换成「往下走」—— 只会多认出账，不会少认。
     顺手每支包一层 try：某支 parser 万一抛错，以前会把整个 email() 打掉（外面没有 try），
     那封信连「读不到」都进不去，直接蒸发；现在只是这一支不算数，继续试下一支。 */
  const chain = [
    [() => /DBS|digibank|POSB/i.test(raw) && /received\s+[A-Z]{3}\s*[\d,]+\.\d{2}\s+via\s+PayNow/i.test(raw), () => parseDBSPayNowIn(raw)],
    [() => isNetsQR(raw), () => parseNETS(raw)],
    [() => /Reference Number/i.test(raw) && /RM\s*[\d,]+\.\d{2}/.test(raw) && /(Maybank|Terminal ID|Approval Code|Merchant ID)/i.test(raw), () => parseMaybankShot(raw)],
    [() => /(eWallet Balance|Wallet Ref|Transfer to Wallet)/i.test(raw), () => parseTnGShot(raw)],
    [() => /You\s+paid/i.test(raw) && /Transaction\s*Ref/i.test(raw), () => parsePayLahShot(raw)],
    [() => /Which\s+card/i.test(raw) && /Authorised\s+via/i.test(raw), () => parseWiseShot(raw)],
    [() => isPayNowTransfer(raw), () => parsePayNow(raw)],
    [() => /MariBank/i.test(raw) && (/received\s+a\s+refund/i.test(raw) || /Refunded\s*Amount/i.test(raw)), () => parseMariBankRefund(raw)],
    [() => /MariBank/i.test(raw) || from.includes("maribank"), () => parseMariBank(raw)],
    [() => /PayLah/i.test(raw) && /refund\s+transaction/i.test(raw), () => parsePayLahRefund(raw)],
    /* ⚠️ v10.10 落回顺序「先 DBS 再 OCBC」：选 DBS 优先是因为 "PayLah" 这个词比 "OCBC" 专一 ——
       OCBC 的信不会写 PayLah，但转发链里带到 "OCBC" 三个字是很容易的事。 */
    [() => raw.includes("PayLah") || from.includes("dbs"), () => parseDBS(raw)],
    [() => raw.includes("OCBC") && /deposit\s+(?:was\s+made|in\s+your\s+account)/i.test(raw), () => parseOCBCRefund(raw)],
    [() => raw.includes("OCBC") && /withdrawal\s+made|withdrawn\s+from\s+your\s+account/i.test(raw), () => parseOCBCWithdrawal(raw)],
    [() => raw.includes("OCBC") || from.includes("ocbc"), () => parseOCBC(raw)],
  ];
  for (const [hit, run] of chain) {
    let ok = false;
    try { ok = !!hit(); } catch (e) { ok = false; }
    if (!ok) continue;
    let r = [];
    try { r = run() || []; } catch (e) { console.log("parser threw:", e && e.message); r = []; }
    if (r.length) return r;
  }
  return [];
}
/* ═══ v10.12 「没记成」必须说清楚是哪一种、撞到谁 ═══
   以前只要 saved < rows.length，收件箱就一律写「N 笔是重复的，已跳过」。可是这个数字
   同时盖住了两件完全不同的事：
     ① 真的撞到同一笔（hash 一样，INSERT OR IGNORE 跳过）
     ② INSERT **抛错**被 catch 吞掉（v10.10 那次 parseNETS 漏写 raw 就是这样，
        收件箱照样标「已记录」「重复」，账其实一笔都没进去）
   两种长得一模一样 → 你看到「重复」就查不下去了。现在：撞到的是哪一笔、指纹是什么，
   全部写进收件箱那一行；②那种还会掉进「读不到」（红角标），不会再假装记好了。 */
async function skipNote(env, r) {
  const me = `${r.currency} ${Number(r.amount).toFixed(2)}`;
  try {
    const old = await env.DB.prepare(
      "SELECT ts, amount, currency, merchant FROM expenses WHERE hash=?").bind(r.hash).first();
    if (old) return `⚠️ ${me} 没记：跟已有的「${String(old.ts).slice(5, 16).replace("T", " ")} ${old.currency} ${Number(old.amount).toFixed(2)} · ${old.merchant || "?"}」撞同一个指纹 ${r.hash}`;
    return `⚠️ ${me} 没记：INSERT 没写进去、库里又找不到同指纹的（${r.hash}）`;
  } catch (e) { return `⚠️ ${me} 没记（指纹 ${r.hash}）`; }
}
function errNote(r, e) { return `⚠️ ${r.currency} ${Number(r.amount).toFixed(2)} 存不进去：${(e && e.message) || e}`; }
function sumLine(rows, notes) {
  return rows.map((r) => `${r.currency} ${Number(r.amount).toFixed(2)} · ${r.merchant || "?"}`).join(" ／ ")
    + (notes && notes.length ? "　" + notes.join("；") : "");
}
/* 把一批账的 hash 拼成收件箱要存的格式 ",h1,h2,"（前后加逗号，方便之后用 LIKE '%,h,%' 精确定位）。没有就回 null。 */
function hashList(rows) {
  const hs = (rows || []).map(r => r.hash).filter(Boolean);
  return hs.length ? "," + hs.join(",") + "," : null;
}
/* ═══ v10.13 同一封信里指纹相同的两笔 = 同一笔，进库前就收干净 ═══
   为什么会出现：银行信多半是 multipart/alternative —— 同一份内容寄两个版本（text/plain + text/html）。
   v10.12 抽正文时两份都抽出来（刻意的：宁可多抽也不要漏），parser 自然把同一笔读两遍。
   以前靠 INSERT OR IGNORE 挡掉第二份，但 v10.12 新增的提示会把它写成
   「⚠️ 没记：跟已有的…撞同一个指纹」→ 一封完全正常的信天天挂红字，
   真正的重复反而淹在里面看不见。现在先去重，警告只留给**跨信**的真撞车。 */
function dedupeRows(rows) {
  const seen = new Set(); const out = [];
  for (const r of (rows || [])) {
    const k = r && r.hash ? String(r.hash) : "";
    if (k && seen.has(k)) continue;
    if (k) seen.add(k);
    out.push(r);
  }
  return out;
}
/* ═══ v10.13 「读不到」的信也要在清单上留下重点 ═══
   你的话：「存起来是乱码就没有意思，要存那些重点」。
   解析成功的信一直都有 summary（金额·商家），**读不到的那些一律 null** ——
   清单上只剩一个标题，要知道里面有什么必须一封封点开。
   现在用兜底的 guessTxn 尽力抓「金额 / 时间 / 参考号」写进 summary：
   抓得到就直接看得见，抓不到就明说找不到金额，不再是一片空白。
   （前端看到开头的 ⚠️ 会自动换成警告样式、不会挂上「记了：」，不用改前端。） */
function keyPoints(text) {
  let g = null;
  try { g = guessTxn(String(text || "")); } catch (e) { g = null; }
  const bits = [];
  if (g && g.amount != null) bits.push(`${g.currency} ${Number(g.amount).toFixed(2)}`);
  if (g && g.ts) bits.push(String(g.ts).slice(0, 16).replace("T", " "));
  if (g && g.ref) bits.push("ref " + String(g.ref).slice(0, 24));
  return bits.length ? bits.join(" · ") : "";
}
function unparsedNote(text) {
  const kp = keyPoints(text);
  return kp ? `⚠️ 没读懂这封，只抓到：${kp}` : "⚠️ 没读懂这封，正文里也找不到金额";
}
/* v9.99 删一笔账 → 连它的来源邮件一起删（真正的 sync）。靠收件箱 hashes 栏定位。
   一封邮件产生多笔账时，只有它名下的账**全删光了**才删这封邮件（别把还在的账的来源也删了）。 */
async function deleteSourceEmail(env, hash) {
  try {
    const src = await env.DB.prepare("SELECT id, hashes FROM inbox WHERE hashes LIKE ?").bind("%," + hash + ",%").all();
    for (const row of (src.results || [])) {
      const hs = String(row.hashes || "").split(",").filter(Boolean);
      if (!hs.includes(hash)) continue;   // v10.0 精确确认这封确实含这个 hash —— 防 LIKE 里 _ / % 被当通配符万一误配（现有 hash 格式不含，但这样就跟 hash 内容无关、绝对不会误删）
      let othersAlive = false;
      for (const h of hs) {
        if (h === hash) continue;
        const e = await env.DB.prepare("SELECT 1 FROM expenses WHERE hash=? LIMIT 1").bind(h).first();
        if (e) { othersAlive = true; break; }
      }
      if (!othersAlive) { await env.DB.prepare("DELETE FROM inbox WHERE id=?").bind(row.id).run(); console.log("cascade-deleted source email", row.id, "for", hash); }
    }
  } catch (e) { console.log("deleteSourceEmail failed:", e.message); }
}

async function ingestRaw(env, raw, from, subject, opts) {
  const skipUnparsedLog = !!(opts && opts.skipUnparsedLog);   // v9.84 retry 时别再冒一条新的 unparsed
  /* v9.89 retry 补旧账：新写的那条收件箱记录要沿用**原邮件的时间**。
     以前一律 sgIso()（当下）→ 8 月重试一封 7 月的旧邮件，7 月那条被删掉、
     新的落在 8 月 → 回头翻 7 月收件箱什么都没有，看起来像资料不见了。 */
  const logTs = (opts && /^\d{4}-\d{2}-\d{2}/.test(String(opts.logTs || ""))) ? String(opts.logTs) : null;
  /* v10.12 是整封 MIME 才抽正文（截图/粘贴文字不动）。放在这里而不是只放 parseRaw 里，
     是因为下面 logMail 要把**同一份可读正文**存进收件箱 —— 你看到的＝我解析的。 */
  if (looksLikeMime(raw)) raw = mailText(raw);
  // v9.99 分流抽成 parseRaw（跟这里原本一字不差），删账找来源、cron 回填都复用同一支
  let rows = dedupeRows(parseRaw(raw, from));   // v10.13 同封信内指纹重复的先收干净，跟 email() 一致

  const logMail = async (kind, summary, hashes) => {
    try {
      await env.DB.prepare(
        "INSERT INTO inbox (ts, sender, subject, raw, status, kind, summary, hashes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(logTs || sgIso(), from, subject, raw.slice(0, 8000),
             kind === "parsed" ? "done" : "new", kind, summary || null, hashes || null).run();
    } catch (e) { console.log("inbox insert failed:", e.message); }
    await purgeInbox(env);
  };

  if (!rows.length) {
    /* v9.84 retry 失败：原本这条 unparsed 已经在收件箱里了，别再插一条新的（否则「读不到」变两封）。
       普通新邮件（非 retry）解析失败才照旧记一条 unparsed。 */
    if (!skipUnparsedLog) await logMail("unparsed", unparsedNote(raw));   // v10.13 跟 email() 一致
    return { parsed: 0, saved: 0, rows: [] };
  }

  let saved = 0;
  const savedRows = [];
  const notes = [];                   // v10.12 没记成的每一笔，各自写一句为什么
  for (const r of rows) {
    /** @type {any} */ let category = null;
    /** @type {any} */ let subCat = null;
    try {
      const mk = merchantKey(r.merchant);
      /* ⚠️ v9.89 跟 email() 对齐：那边 v9.77 起 sub **不再自动套**（超市一家店多种 sub，
         买包会被标成衣服），这里却还在套 —— 同一笔账走邮件和走截图会得到不一样的 sub。
         现在两条管道一致：category 自动套、sub 留空（编辑时前端拿商家记忆当预填提示）。
         餐饮的 sub 照旧按交易时间重算（下面那行）。 */
      const hit = isGeneric(mk) ? null : await env.DB.prepare(
        "SELECT category, display, sub, is_hint FROM merchant_rules WHERE merchant_key=?").bind(mk).first();
      if (hit) { if (hit.category && r.type !== "income") category = hit.category; if (hit.display) r.merchant = hit.display; }   // v10.20 收入不套支出分类记忆（同 email()，两套分类分开），只借用改名
    } catch (e) { console.log("rule lookup:", e.message); }
    if (category === FOOD_KEY) subCat = foodSub(r.ts);   // 餐饮：子分类永远按交易时间重算
    try {
      /* ⚠️⚠️ v10.17 这条 INSERT 以前**把 type 写死成 'expense'** —— ingestRaw 是「粘贴 / 重新识别」两条路
         共用的入库函式，而收入 parser（parseMariBankRefund / parseDBSPayNowIn）解出来的 type:'income'
         走到这里全被写死成支出（真实踩过：照片 IMG_6964，一笔 DBS PayNow 收款被记成 -S$30 支出）。
         email() 那条路早就读 r.type 了（rtype），这里没跟上 —— 现在对齐：一样读 r.type。 */
      const rtype = r.type === "income" ? "income" : "expense";
      const off = rtype === "income" ? await offsetForMerchant(env, r.merchant) : 0;   // v10.19 退款：按这家记忆自动带上抵扣
      const res = await env.DB.prepare(
        `INSERT OR IGNORE INTO expenses
         (ts, amount, currency, merchant, card_last4, source, raw, hash, type, category, sub, offset)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(r.ts, r.amount, r.currency, r.merchant, r.card_last4, r.source, r.raw, r.hash, rtype, category, subCat, off).run();
      if (res.meta && res.meta.changes) {
        saved++;
        savedRows.push({ id: res.meta.last_row_id, ts: r.ts, amount: r.amount, currency: r.currency,
          merchant: r.merchant, card_last4: r.card_last4, source: r.source, category, sub: subCat, type: rtype, offset: off });
      } else notes.push(await skipNote(env, r));                       // v10.12 口径跟 email() 一样
    } catch (e) { console.log("insert error", e.message); notes.push(errNote(r, e)); }
  }
  const summary = sumLine(rows, notes);
  const hardFail = saved === 0 && notes.some((n) => n.indexOf("存不进去") >= 0);
  await logMail(hardFail ? "unparsed" : "parsed", summary, hashList(rows));
  return { parsed: rows.length, saved, rows: savedRows };
}
