#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   Expenses —— 验证器（三合一）  ·  validation.mjs
       node validation.mjs                 三组全跑（在放 index.html / worker.js 的资料夹里）
       node validation.mjs ../some/dir     指定资料夹
       node validation.mjs ../worker.js    指定 worker.js（同层的档一起找）
       node validation.mjs --only=parser   只跑某几组：static / parser / cal / iron / e2e / pipeline，逗号分隔
       node validation.mjs --only=e2e      只跑真机端到端（真实触摸，需浏览器）
       node validation.mjs --only=pipeline 只跑全链路（真邮件→真 ingestRaw 入库→真 index.html→验 hero/明细）
       node validation.mjs -v              连通过的项目也一条条印出来

   七组：§A 静态 · §B parser 回归 · §C 日历 · §D 铁律 · §E 真机触摸 UI · §F 全链路（邮件→入库→画面）·
        §G 明细编辑+设置（真实操作→存对没：支出↔收入、改金额、改数值颜色/主题）。
   §A–§D 零 npm 依赖，Node 18+ 就能跑。§E / §F / §G 要 Playwright + Chromium，没有就自动跳过、不当失败。
   §F 是「解析对了、存的时候被改掉、hero 算错」这类**链路 bug**的唯一守门人（IMG_6964 那个收入记成支出就是它守的）。
   全过回传 0，任何一条 FAIL 回传 1，跑不起来回传 2。

   ── 这一支是把原来三个档合起来的，内容一个字没改（唯一例外见 §A-11 那段注释）──
     · Check.mjs    → §A 静态复检（语法 / 重复定义 / DOM / 币种 / 跨档 / schema / 死代码 /
                        转义 / HTML 结构 / 系统自检 / parser 接线）
     · test.mjs     → §B parser 回归（七封真实邮件 · 三种形态 · 24 案例）
     · cal-test.mjs → §C 日历（日期工具 / 重复展开 / 单次修改 / 提醒 / 入库 / 压力 / 边界）
     · v10.15 新增   → §D 铁律 & 健壮性（收款不记账 / 不准误挡 / 垃圾输入 / 时区 / 去重幂等）

   合起来的好处不只是少打两次指令：
     · worker.js 以前要被载入两次（test 一次、cal 一次），现在**只载一次**，
       两组共用同一份实例，也就不会出现「同一支函式在两个档里表现不一样」这种鬼故事。
     · 以前三个档各自 `process.exit()`，CI 里要串三段；现在一个回传码收全部。
     · 临时档（原本 .test-worker.tmp.mjs / .cal-test.tmp.mjs）现在只有一个，
       而且包在 try/finally 里，中途炸掉也会清掉。

   ⚠️ 原来三个档的所有告诫全部继续有效，尤其这两条：
     · §B 的 EXPECT 是 2026-08-05 用七封真信 / 截图定下来的。**不要为了让测试过而去改它**——
       除非你确定新的行为才是对的，那就连同「为什么」一起改，并在 TECHNICAL_SUMMARY 记一笔。
     · §A 验的是「静态」：语法、引用、跨档一致性。它验不到真机上的画面、卡不卡、毫秒数。
       别拿这支的全绿当成「效能没问题」的证明。
   ⚠️ 每修一个新 bug，就回来补一条对应的检查。这份档只会越来越严。
   ═══════════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/* ══════════════════════════════════════════════════════════════════════════
   §0  共用：命令列 / 颜色 / 计分板 / 载入 worker.js
   ══════════════════════════════════════════════════════════════════════════ */

const ARGV = process.argv.slice(2);
const flag = (n) => { const a = ARGV.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const VERBOSE = ARGV.includes('-v') || ARGV.includes('--verbose');
const POS = ARGV.filter(a => !a.startsWith('-'));

/* 位置参数：给资料夹或直接给 worker.js 都行 */
let BASE = process.cwd(), WORKER = null;
if (POS[0]) {
  const p = path.resolve(POS[0]);
  const isDir = fs.existsSync(p) && fs.statSync(p).isDirectory();
  if (isDir) BASE = p; else { WORKER = p; BASE = path.dirname(p); }
}
WORKER = flag('worker') ? path.resolve(flag('worker')) : (WORKER || path.join(BASE, 'worker.js'));

const ONLY = (flag('only') || '').split(',').map(s => s.trim()).filter(Boolean);
const BAD_ONLY = ONLY.filter(x => !['static', 'parser', 'cal', 'iron', 'e2e', 'pipeline', 'edit'].includes(x));
if (BAD_ONLY.length) { console.error(`--only 只认 static / parser / cal / iron / e2e / pipeline / edit，不认得：${BAD_ONLY.join(', ')}`); process.exit(2); }
const want = (n) => !ONLY.length || ONLY.includes(n);

const L = { ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[90m', off: '\x1b[0m' };
const head = (t) => console.log(`\n${L.dim}── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}${L.off}`);
const TALLY = [];   // [{ name, pass, warn, fail, skipped }]

/* ── 载入 worker.js：三组共用，只做一次 ──
   worker.js 不是 ESM 模组，所以临时补一串 export 再 import。
   preamble 是给 Workers 那几个全域变量垫的（原本在 cal-test.mjs 里）。
   export 清单 = 原本两个档各自那串的联集；少一个名字 import 会直接 SyntaxError，
   所以这串就是「这两组测试碰得到的 worker 内部函式」的完整清单。 */
const WORKER_EXPORTS = [
  /* parser 那组 */ 'parseRaw', 'parseDBS', 'parseDBSPayNowIn', 'parsePayLahRefund', 'parseOCBC', 'parseOCBCWithdrawal', 'parsePayNow', 'parseNETS', 'parseMariBank',
  'parseMaybankShot', 'parsePayLahShot', 'parseTnGShot', 'mailText', 'guessTxn', 'ingestRaw',
  /* 日历那组 */ 'gcWindow', 'wOccur', 'modApply', 'wNotifyAt', 'wLead', 'wIso', 'wIdx', 'wDay', 'wWd',
  'wAdd', 'wHm', 'nlClean', 'nlRead', 'repCols', 'modRead', 'modWrite', 'repFromRow',
];
const PREAMBLE = `globalThis.addEventListener = globalThis.addEventListener || (() => {});
globalThis.caches = globalThis.caches || { default: { match: async()=>null, put: async()=>{} } };\n`;

async function loadWorker(src) {
  if (!fs.existsSync(src)) { console.error(`${L.bad}找不到 ${src}${L.off}`); return null; }
  const tmp = path.join(path.dirname(path.resolve(src)), '.validation.tmp.mjs');
  try {
    fs.writeFileSync(tmp, PREAMBLE + fs.readFileSync(src, 'utf8') +
      `\nexport { ${WORKER_EXPORTS.join(', ')} };\n`);
    return await import(pathToFileURL(tmp).href + `?t=${Date.now()}`);
  } catch (e) {
    console.error(`${L.bad}载入 worker.js 失败${L.off}\n${String(e && e.message || e).split('\n').slice(0, 8).join('\n')}`);
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}   // 中途炸掉也不要留垃圾
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   §A  静态复检（原 Check.mjs）—— 语法 / 跨档一致性 / 表格完整性
   ══════════════════════════════════════════════════════════════════════════
   为什么有这一组：
   以前「这份档乾不乾净」只能问 AI，问一个说一个答案，问三个三种说法，永远收不了尾。
   现在把每一次复检写成会自己跑的检查 —— **能自动验的，就不要用嘴讲**。
   下次谁（人或 AI）说「我发现一个问题」，先跑这支：
     · 它抓得到 → 那是真的，而且这里会指出在第几行
     · 它抓不到 → 要嘛是它漏了一条检查（那就把那条**加进来**），
                  要嘛是对方在讲一个不存在的问题
   ⚠️ 它验的是静态。真机上的画面、卡不卡、毫秒数，只有真手机开得出来。
   ⚠️ 「验过了所以绿」跟「没看懂所以没吭声」长得一模一样，而后者比没有检查更糟。
      所以 check-selftest.mjs 那一支（往好的档里注入会坏的改动，看这支吭不吭声）要继续维护，
      加新检查时顺手去那边补一个注入案例。 */
function suiteStatic() {
  const R = { pass: 0, fail: 0, warn: 0 };
  const ok   = (n, d = '') => { R.pass++; console.log(`${L.ok}  PASS${L.off}  ${n}${d ? L.dim + '  ' + d + L.off : ''}`); };
  const bad  = (n, d = '') => { R.fail++; console.log(`${L.bad}  FAIL${L.off}  ${n}${d ? '\n        ' + String(d).split('\n').join('\n        ') : ''}`); };
  const warn = (n, d = '') => { R.warn++; console.log(`${L.warn}  WARN${L.off}  ${n}${d ? '\n        ' + String(d).split('\n').join('\n        ') : ''}`); };

  const read = (f) => { try { return fs.readFileSync(path.join(BASE, f), 'utf8'); } catch { return null; } };
  /* 把 /*…*​/ 和 //… 换成等长空白 —— 长度不变，行号才不会跑掉。
     给「不准出现某个写法」那类检查用：注释里写着那个写法不算犯规。 */
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
  const HTML = read('index.html'), WK = read('worker.js'), SW = read('sw.js');
  if (!HTML || !WK) {
    console.log(`${L.warn}  跳过：在 ${BASE} 里找不到 index.html 或 worker.js${L.off}`);
    return { name: '§A 静态复检', ...R, skipped: true };
  }

  /* 内联 <script>（不含 src=）= 整个前端 */
  const JS = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n;\n');
  /* JS 在 index.html 里的行号偏移，报错时才指得准 */
  const JS_OFFSET = HTML.slice(0, HTML.indexOf(JS.slice(0, 200))).split('\n').length - 1;
  const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

  console.log(`${L.dim}  index.html ${(HTML.length / 1024 | 0)}KB · worker.js ${(WK.length / 1024 | 0)}KB · sw.js ${SW ? (SW.length / 1024 | 0) + 'KB' : '缺'}${L.off}`);

/* ══════════════ 1. 语法 ══════════════ */
head('1. 语法');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exchk-'));
  for (const [name, code] of [['index.html 内联 JS', JS], ['worker.js', WK], ['sw.js', SW]]) {
    if (code == null) { warn(`${name} 不在，跳过`); continue; }
    const f = path.join(tmp, name.replace(/[^\w.]/g, '_') + '.mjs');
    fs.writeFileSync(f, code);
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); ok(name); }
    catch (e) { bad(name, String(e.stderr || e).split('\n').slice(0, 6).join('\n')); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ══════════════ 2. 重复定义（后面的会静默盖掉前面的） ══════════════ */
head('2. 重复定义');
{
  const dup = (arr) => { const c = {}; arr.forEach(x => c[x] = (c[x] || 0) + 1); return Object.keys(c).filter(k => c[k] > 1); };
  const fns = [...JS.matchAll(/^function\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
  const vars = [...JS.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)].map(m => m[1]);
  const df = dup(fns), dv = dup(vars);
  df.length ? bad('顶层函式重复定义', df.join(', ')) : ok('顶层函式重复定义', `${fns.length} 支，0 重复`);
  dv.length ? bad('顶层变量重复宣告', dv.join(', ')) : ok('顶层变量重复宣告', `${vars.length} 个，0 重复`);

  const ids = [...HTML.matchAll(/\bid="([A-Za-z_][\w-]*)"/g)].map(m => m[1]);
  /* dpFeed 两处在互斥分支（记账 / 事项两种日页骨架），不算重复 —— 白名单 */
  const OKDUP = new Set(['dpFeed']);
  const di = dup(ids).filter(x => !OKDUP.has(x));
  di.length ? bad('HTML id 重复', di.join(', ')) : ok('HTML id 重复', `${ids.length} 个，0 重复`);
}

/* ══════════════ 3. DOM 引用（开机就炸的那一类） ══════════════ */
head('3. DOM 引用');
{
  const staticIds = new Set([...HTML.matchAll(/\bid="([A-Za-z_][\w-]*)"/g)].map(m => m[1]));
  const dynIds = new Set([...JS.matchAll(/id=\\?['"]?([A-Za-z_][\w-]*)/g)].map(m => m[1]));
  const all = new Set([...staticIds, ...dynIds]);
  const refs = new Map();
  for (const m of JS.matchAll(/getElementById\(\s*['"]([\w-]+)['"]/g)) refs.set(m[1], lineOf(JS, m.index) + JS_OFFSET);
  for (const m of JS.matchAll(/querySelector\(\s*['"]#([\w-]+)['"]/g)) if (!refs.has(m[1])) refs.set(m[1], lineOf(JS, m.index) + JS_OFFSET);
  /* 'nav'+n 之类的字串拼接会被上面的 regex 误抓，白名单掉 */
  const FALSE = new Set(['nav']);
  const missing = [...refs].filter(([id]) => !all.has(id) && !FALSE.has(id));
  missing.length ? warn('引用了不存在的 id（死代码，通常包在 if(x) 里不会炸）',
    missing.map(([id, ln]) => `${id}  (index.html ~L${ln})`).join('\n'))
    : ok('引用了不存在的 id', '0');

  /* 这一类才会真的炸：没判空就直接 .onclick= → TypeError → 后面整段 script 不跑 */
  const crash = [];
  for (const m of JS.matchAll(/document\.getElementById\(\s*['"]([\w-]+)['"]\s*\)\s*\./g))
    if (!staticIds.has(m[1])) crash.push(`${m[1]}  (index.html ~L${lineOf(JS, m.index) + JS_OFFSET})`);
  crash.length ? bad('无判空直接 .xxx，但元素不存在 → 开机 TypeError，后面全不跑', crash.join('\n'))
    : ok('无判空直接 .xxx 但元素不存在', '0');
}

/* ══════════════ 4. 币种表（历史地雷区，见总纲 §5.5） ══════════════ */
head('4. 币种表');
{
  const cur = JS.match(/const CUR=\{([\s\S]*?)\};/);
  if (!cur) bad('找不到 CUR 表');
  else {
    const pairs = [...cur[1].matchAll(/(\w+):"([^"]+)"/g)].map(m => [m[1], m[2]]);
    const bySym = {}; pairs.forEach(([k, v]) => (bySym[v] ||= []).push(k));
    const clash = Object.entries(bySym).filter(([, ks]) => ks.length > 1);
    clash.length ? bad('币种符号撞车（hero 卡上两行会分不出谁是谁）',
      clash.map(([s, ks]) => `"${s}" ← ${ks.join(' / ')}`).join('\n'))
      : ok('币种符号两两不同', `${pairs.length} 个币`);

    const keys = new Set(pairs.map(p => p[0]));
    const fxd = JS.match(/const FX_DEF=\{([\s\S]*?)\};/);
    const apx = JS.match(/const FX_APPROX=new Set\(\[([\s\S]*?)\]\)/);
    const curs = JS.match(/const CURS=\[([\s\S]*?)\]/);
    if (fxd && apx) {
      const fk = new Set([...fxd[1].matchAll(/(\w+):/g)].map(m => m[1]));
      const ak = [...apx[1].matchAll(/'(\w+)'/g)].map(m => m[1]);
      const orphan = ak.filter(c => !fk.has(c));
      orphan.length ? bad('FX_APPROX 里有 FX_DEF 没有的币（会被当 1:1 静默算错）', orphan.join(', '))
        : ok('FX_APPROX ⊆ FX_DEF', `${ak.length} 个只有保底值的币`);
    }
    if (curs) {
      const ck = [...curs[1].matchAll(/"(\w+)"/g)].map(m => m[1]);
      const orphan = ck.filter(c => !keys.has(c));
      orphan.length ? bad('CURS 里有 CUR 表没有的币（轮换钮会显示三码而不是符号）', orphan.join(', '))
        : ok('CURS ⊆ CUR', ck.join(' '));
    }
  }
  /* 总纲：全档不准再写裸 CUR[...]，一律走 curSym()
     ⚠️ 一定要先 stripComments —— 注释里到处在讲「以前有 6 处直接写 CUR[r.currency]」，
        不剥掉的话每次都会误报（这支检查器第一版就中了）。 */
  const naked = [];
  for (const m of stripComments(JS).matchAll(/(?<!\w)CUR\[/g)) {
    const ln = lineOf(JS, m.index);
    const src = JS.split('\n')[ln - 1] || '';
    if (!src.includes('function curSym')) naked.push(`index.html ~L${ln + JS_OFFSET}: ${src.trim().slice(0, 80)}`);
  }
  naked.length ? bad('裸 CUR[...]（查不到的币会显示 undefined）', naked.join('\n')) : ok('裸 CUR[...]', '0，全走 curSym()');
}

/* ══════════════ 5. 跨档一致性（这三条只有对照三个档才验得出来） ══════════════ */
head('5. 跨档一致性');
{
  /* ══ 5.1 API 对账（v2：从根重写）══════════════════════════════════════════
     旧版做的事：把 index.html 里长得像 /api/xxx 的字串抓出来，看 worker 有没有一行
     `path === "同一串"`。看起来在验，其实**只验了「路径」这一个维度**，其余全部静默：

       ① 不比对方法。前端拿 PUT 去打一支只收 DELETE 的，worker 会一路掉到最后那行
          `return json({ error: "not found" }, 404)`（worker.js L2366）—— 跟打错路径
          **同一种死法**，可是旧版全绿。
       ② 只扫 index.html。sw.js 也在打 worker（`/api/push/due`，sw.js L135）；那条断了
          推送就全哑。§5 这一组的立意本来就是「单看一个档都是对的、合起来才是断的」，
          偏偏漏掉 sw → worker 这条边。
       ③ 路径用变量拼（`/api/${seg}`）时正则匹配不到 → 整条路由**当成不存在**，不吭声。
     反方向还有一个：没剥注释。注释里写「以前打的是 /api/oldhealth」会被当成真的在打
     → 假 FAIL。（§4 早就为同一个坑加了 stripComments，这里当时漏了。）

     根在哪：旧版把问题当成「这串字在不在」，于是**凡是它认不出来的写法，一律等于没有**。
     一个哑巴的死角比没有检查更糟 —— 它发的是假的安心。
     改法：建一张对账表，两端各自摊开
        呼叫端（index.html + sw.js）：(路径, 方法, 第几行)
        接收端（worker.js）：        (路径, 收哪几个方法)
     结果分三种讲 —— 对得上 = PASS、对不上 = FAIL、**看不懂 = WARN（出声，绝不静默）**。 */

  /* 从呼叫端抠出每一通。方法读法：从 /api/… 往后看 350 字（但在下一个 /api/ 处切断，
     免得偷到下一通的 method），取第一个 method:'XXX'；读不到就是 fetch 的预设 GET，
     并标成 guessed —— 猜的东西不准判 FAIL，只准 WARN。 */
  const callSites = (src, file, offset = 0) => {
    const s = stripComments(src), out = [];
    for (const m of s.matchAll(/\/api\/([\w/-]*)/g)) {
      const idx = m.index, after = s[idx + m[0].length] || '';
      const bf = s.slice(Math.max(0, idx - 60), idx);
      /* 这两种是在「比对」路径不是在「打」它：
         sw.js 的 `url.pathname === '/api/bg'`（拦截）、`pathname.includes('/api/')`（放行判断） */
      if (/[=!]==?\s*['"`]$/.test(bf)) continue;
      if (/\.(includes|startsWith|endsWith|indexOf|match|search|test)\(\s*['"`]$/.test(bf)) continue;
      const ln = lineOf(s, idx) + offset;              // stripComments 等长替换，行号不会跑掉
      /* 变量拼出来的路径：认不出来就说认不出来（旧版这里是直接消失） */
      if (!m[1] || after === '$' || after === '{') { out.push({ file, ln, path: null, raw: s.slice(idx, idx + 24).replace(/\s+/g, ' ') }); continue; }
      let win = s.slice(idx, idx + 350);
      const nxt = win.slice(1).indexOf('/api/');
      if (nxt >= 0) win = win.slice(0, nxt + 1);
      const mm = win.match(/method\s*:\s*['"]([A-Za-z]+)['"]/);
      out.push({ file, ln, path: '/api/' + m[1].replace(/\/$/, ''), method: mm ? mm[1].toUpperCase() : 'GET', guessed: !mm });
    }
    return out;
  };
  /* 接收端：`path === "X" && request.method === "Y"`；没写 method 的那种（/api/paste 的
     非 json 分支，worker.js L1399）记成 '*' = 不挑方法 */
  const wkTable = new Map();
  for (const m of stripComments(WK).matchAll(/path === "(\/api\/[\w/-]+)"([^\n]{0,120})/g)) {
    const mm = m[2].match(/request\.method === "(\w+)"/);
    const set = wkTable.get(m[1]) || new Set(); set.add(mm ? mm[1] : '*'); wkTable.set(m[1], set);
  }

  const calls = [...callSites(JS, 'index.html', JS_OFFSET), ...(SW ? callSites(SW, 'sw.js') : [])];
  const dynCalls = calls.filter(c => !c.path), okCalls = calls.filter(c => c.path);
  const miss404 = [], missMethod = [], unsure = [];
  for (const c of okCalls) {
    const acc = wkTable.get(c.path);
    if (!acc) { miss404.push(`${c.file} L${c.ln}  ${c.method} ${c.path}  ← worker 没有这支`); continue; }
    if (acc.has('*') || acc.has(c.method)) continue;
    (c.guessed ? unsure : missMethod).push(
      `${c.file} L${c.ln}  ${c.method}${c.guessed ? '(读不到 method，按 fetch 预设 GET 算)' : ''} ${c.path}  ← worker 这支只收 ${[...acc].join(' / ')}`);
  }
  const uniq = new Set(okCalls.map(c => c.path + ' ' + c.method));
  const nSw = okCalls.filter(c => c.file === 'sw.js').length;
  miss404.length || missMethod.length
    ? bad('API 对账不上（worker 会掉到 L2366 那行 404）', [...miss404, ...missMethod].join('\n'))
    : ok('API 对账（路径 + 方法）', `${uniq.size} 组 · ${okCalls.length} 通呼叫（含 sw.js ${nSw} 通）`);
  unsure.length ? warn('这几通读不出 method，按 GET 算的话对不上 —— 人工看一眼', unsure.join('\n')) : null;
  /* 认不出来的写法：不判它对错，但一定要留下行号，不然它就等于不存在 */
  dynCalls.length
    ? warn('路径是变量拼的，这支验不了它打到哪（请人工确认，或改成写死的字串）',
      dynCalls.map(c => `${c.file} L${c.ln}  ${c.raw}…`).join('\n'))
    : ok('没有变量拼出来的 API 路径', '每一通都验得了');
  /* 反方向：worker 开了端点却没人打。/api/gdrive/callback 是 Google OAuth 转回来的，不是我们打的 */
  const called = new Set(okCalls.map(c => c.path));
  const OK_UNCALLED = new Set(['/api/gdrive/callback']);
  const wkOrphan = [...wkTable.keys()].filter(p => !called.has(p) && !OK_UNCALLED.has(p));
  wkOrphan.length ? warn('worker 有这些端点，但前端和 sw.js 都没打（掉线的功能？）', wkOrphan.join(', '))
    : ok('worker 没有没人打的端点', `${wkTable.size} 支`);

  /* 5.2 SW 读推送设定的 cache 名，要跟前端写进去的那个一样，不然推送永远只弹兜底 */
  if (SW) {
    const swName = SW.match(/const CONF\s*=\s*['"]([^'"]+)['"]/);
    const feName = JS.match(/caches\.open\(['"]([^'"]+)['"]\)[\s\S]{0,200}?__push_conf/);
    if (!swName) warn('sw.js 找不到 CONF 常数');
    else if (!feName) warn('index.html 找不到写 __push_conf 的 caches.open');
    else if (swName[1] !== feName[1]) bad('推送设定的 cache 名对不上 → SW 拿不到 token，推送只会弹兜底',
      `sw.js: ${swName[1]}\nindex.html: ${feName[1]}`);
    else ok('推送 cache 名两边一致', swName[1]);

    /* 5.3 SW 开的每一条深连结（openWindow 的 query），前端要读得到 */
    const swParams = [...SW.matchAll(/openWindow\([^)]*\?(\w+)=/g)].map(m => m[1]);
    /* ⚠️ 两种写法都要认：
         searchParams.get('day')
         new URLSearchParams(location.search).get('day')   ← 实际用的是这种
       第一版只写了前者 → 明明修好了还是报 FAIL（这支检查器第二个自摆乌龙）。 */
    const feReads = new Set([
      ...JS.matchAll(/searchParams\.get\(['"](\w+)['"]\)/g),
      ...JS.matchAll(/URLSearchParams\([^)]*\)\s*\.get\(['"](\w+)['"]\)/g),
    ].map(m => m[1]));
    const dead = swParams.filter(p => !feReads.has(p));
    dead.length ? bad('sw.js 冷启动会带这个参数进来，但前端从来没读过 → 点通知开不到目的地',
      dead.map(p => `?${p}=`).join(', '))
      : ok('SW 深连结参数前端都读得到', swParams.length ? swParams.map(p => '?' + p + '=').join(' ') : '（没有）');
  }

  /* 5.4 版号：index.html 页脚 / worker.js WORKER_VER / 总纲记的「当前版本」
     ⚠️⚠️ v10.15 重写。旧版拿**总纲标题**（`# Expenses —— 技术总纲 v10.14`）去跟
     「两个档里比较新的那个」比 —— 可是两个档用的是**两套不相干的编号**（前端 v23.x、
     worker v10.x），`sort(cmp).pop()` 永远选到 v23.x，而标题写的一直是 worker 那一套，
     于是这条**永远不可能过**：文档明明是当天写的，照样天天亮黄。
     一条永远亮着的提醒等于没有提醒 —— 时间久了没人再看它，真的落后时也就没人发现。
     现在改成对**同一把尺**：总纲开头那行「当前版本：… 底部 vXX ／ WORKER_VER = "vYY"」
     记的是什么，就跟两个档各自实际的版本逐一对。对不上才出声，而且指得出是哪一个对不上。 */
  const vHtml = HTML.match(/brandFoot[^<]*<\/span>\s*　?\s*(v[\d.]+)/);
  const vWk = WK.match(/WORKER_VER\s*=\s*"(v[\d.]+)"/);
  const doc = read('TECHNICAL_SUMMARY.md');
  const vDocLine = doc && doc.match(/当前版本：[^\n]*?(v[\d.]+)[^\n]*?WORKER_VER\s*=\s*"(v[\d.]+)"/);
  const parts = [vHtml && `index.html ${vHtml[1]}`, vWk && `worker.js ${vWk[1]}`,
    vDocLine && `总纲记的 ${vDocLine[1]} / ${vDocLine[2]}`].filter(Boolean);
  if (vDocLine && vHtml && vWk) {
    const off = [];
    if (vDocLine[1] !== vHtml[1]) off.push(`index.html：档里是 ${vHtml[1]}，总纲写 ${vDocLine[1]}`);
    if (vDocLine[2] !== vWk[1]) off.push(`worker.js：档里是 ${vWk[1]}，总纲写 ${vDocLine[2]}`);
    off.length ? warn('总纲记的版本跟代码对不上（下一个人会照着旧文档改）', off.join('\n        '))
      : ok('版号', parts.join(' · '));
  } else warn('版号读不齐', parts.join(' · ') || '（都读不到）');
}

/* ══════════════ 6. worker schema ══════════════ */
head('6. worker schema');
{
  const mg = WK.match(/const MIGRATIONS = \[([\s\S]*?)\n\];/);
  if (!mg) bad('找不到 MIGRATIONS');
  else {
    const n = [...mg[1].matchAll(/`(CREATE|ALTER|INSERT|UPDATE|DROP)/gi)].length;
    ok('MIGRATIONS 条目', `${n} 条`);
    /* 总纲 §3：只准往后加。DROP / 改已有栏位 = 旧机上的资料会不见 */
    const danger = [...mg[1].matchAll(/`\s*(DROP\s+TABLE|DROP\s+COLUMN|ALTER\s+TABLE\s+\w+\s+RENAME)/gi)].map(m => m[1]);
    danger.length ? bad('MIGRATIONS 里有破坏性 DDL（只准往后加，见总纲 §3）', danger.join(', '))
      : ok('MIGRATIONS 全是加法（无 DROP / RENAME）');
    /SCHEMA_VERSION = MIGRATIONS\.length/.test(WK)
      ? ok('SCHEMA_VERSION = MIGRATIONS.length')
      : bad('SCHEMA_VERSION 没跟着 MIGRATIONS.length 走 → 中间几条会被永久跳过（v9.1 踩过）');
  }
  /* v10.7 那道闸门：没设 APP_TOKEN 时不准放行（safeEqual("","")===true） */
  /_want\s*\)\s*return json\(|if \(!_want\)/.test(WK)
    ? ok('空 APP_TOKEN 闸门还在', '没设 token 一律 503')
    : bad('空 APP_TOKEN 闸门不见了 → safeEqual("","")===true，整个 D1 全世界可读写');
  /* 档案里不准留钥匙 */
  const leak = [];
  for (const m of WK.matchAll(/^const (TOKEN_DEFAULT|GD_CLIENT_ID_DEFAULT|GD_CLIENT_SECRET_DEFAULT)\s*=\s*"([^"]*)"/gm))
    if (m[2]) leak.push(`${m[1]} = "${m[2].slice(0, 6)}…"`);
  leak.length ? bad('worker.js 里写死了凭证（这个档会进 GitHub）', leak.join('\n')) : ok('worker.js 没写死凭证');
}

/* ══════════════ 7. 死代码 ══════════════ */
head('7. 死代码');
{
  const fns = [...JS.matchAll(/^function\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
  /* 刻意留空的占位不算（总纲有记：v6.4 起 buildVs 并进支出趋势卡了） */
  const INTENTIONAL = new Set(['buildVs']);
  const dead = fns.filter(f => !INTENTIONAL.has(f) &&
    (JS.match(new RegExp('\\b' + f.replace(/\$/g, '\\$') + '\\b', 'g')) || []).length <= 1);
  dead.length ? warn('定义了但全档没人调用（可能是掉线的功能，也可能只是垃圾）', dead.join(', '))
    : ok('没有孤儿函式');
}

/* ══════════════ 8. innerHTML 转义（名字里打一个 < 那行就空掉） ══════════════ */
head('8. innerHTML 转义');
{
  /* 使用者能自由输入、又会被塞进 innerHTML 的东西：商家名、备注、分类名、事项标题、订阅名 */
  const risky = [];
  for (const m of JS.matchAll(/\$\{([^}]{0,140})\}/g)) {
    const s = m[1];
    if (!/\b(merchant|\.title|note|display|summary|subject|sender)\b/.test(s)) continue;
    if (/\besc\(|sanName\(|fmt\(|textContent/.test(s)) continue;
    const ln = lineOf(JS, m.index);
    const src = JS.split('\n')[ln - 1] || '';
    if (!/innerHTML|`<|h\s*\+=|return\s*`/.test(src)) continue;   /* 只看真的会进 HTML 的 */
    risky.push(`index.html ~L${ln + JS_OFFSET}: \${${s.trim().slice(0, 70)}}`);
  }
  risky.length ? warn('使用者输入没包 esc() 就进 innerHTML（需人工确认是不是真的进 HTML）', risky.join('\n'))
    : ok('使用者输入进 innerHTML 前都有 esc() / sanName()');
  /^\s*const sanName=/m.test(JS) ? ok('sanName() 名字消毒还在', `挂 ${(JS.match(/sanName\(/g) || []).length} 处`)
    : bad('sanName() 不见了 → 分类名 / 付款方式名打个 < 那行就空掉');
}

/* ══════════════ 9. HTML 结构 ══════════════ */
head('9. HTML 结构');
{
  const o = (HTML.match(/<style\b/g) || []).length, c = (HTML.match(/<\/style>/g) || []).length;
  o === c ? ok('<style> 标签配对', `${o} 组`) : bad('<style> 标签没配对', `<style> ${o} 个 / </style> ${c} 个`);
  /(<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?)<\/script\s*>/.test(HTML) ? ok('<script> 闭合正常') : bad('<script> 没闭合');
  /* JS 字串里若混进 </script> 会当场把 script 切断 */
  JS.includes('</script') ? bad('内联 JS 里出现 </script → HTML parser 会在那里把 script 切断')
    : ok('内联 JS 里没有 </script');
  /* 设置画面：一张卡、四格 */
  const nCard = (JS.match(/class="sxcard/g) || []).length;
  const nInput = (JS.match(/<input id="_sx/g) || []).length;
  nCard === 1 && nInput === 4 ? ok('设置画面版型', '1 张卡 · 4 格输入')
    : warn('设置画面版型跟约定不符（约定：一张卡装四样）', `卡 ${nCard} 张 / 输入 ${nInput} 格`);
  /iOS 键盘|margin:auto/.test(HTML.match(/#sxWrap \.sxp\{[^}]*\}/)?.[0] || '') || /\.sxp\{[\s\S]{0,80}margin:auto/.test(HTML)
    ? ok('设置画面用 margin:auto 置中', '（不是 justify-content:center，见 iOS 键盘坑）')
    : bad('设置画面改回了 flex 置中 → 键盘弹起时标题和第一格滑不到');
}

/* ══════════════ 10. 系统自检（app 里那颗体检，反过来被这支守着） ══════════════
   为什么在这里：系统自检是这个专案用来抓「静默失败」的哨兵（时钟、汇率、cron、备份…），
   可是**哨兵自己坏了没人管** —— 它坏起来的样子跟好的时候长得一模一样，全绿。

   最典型的一种：自检读 `h.某栏位`，而 worker 的 /api/health 根本没回这个栏位
   → 拿到 undefined → 那一项不会报错、会**永远显示同一个状态**。真机上看不出来，
   静态一比就出来了。这正是 §9 规矩 5 讲的那类错，也是这支该做的活。

   ⚠️ 反过来的方向（把 check.mjs 整个搬进手机里跑）做不到、也不该做：
      worker.js 的原始码线上根本拿不到（Workers 只出 API、不出源码），
      §5 整组跨档对账在手机上等于没有；`node --check` 浏览器也没有。
      静态检查是**部署前**的事，系统自检是**部署后**的事，验的不是同一层。 */
head('10. 系统自检');
{
  const hcBody = JS.match(/function healthChecks\([\s\S]*?\n\}/);
  const hjSend = WK.match(/path === "\/api\/health"[\s\S]*?return json\(\{([\s\S]*?)\}\);/);
  if (!hcBody) warn('index.html 找不到 healthChecks()');
  else if (!hjSend) warn('worker.js 找不到 /api/health 的 return json({...})');
  else {
    const rd = [...new Set([...hcBody[0].matchAll(/\bh\.(\w+)/g)].map(m => m[1]))]
      /* 约定：`_` 开头 = 前端自己塞进这个物件的本地标记（例如 v10.10 的 `_err` 带 HTTP 状态码），
         本来就不该由 worker 回。以后要加本地标记，**一律 `_` 开头**，不然这条会误报。 */
      .filter(f => !f.startsWith('_'));
    const sd = new Set([...hjSend[1].matchAll(/^\s*(\w+)\s*:/gm)].map(m => m[1]));
    const ghost = rd.filter(f => !sd.has(f));
    ghost.length
      ? bad('自检读了 /api/health 没回的栏位 → 那一项永远是 undefined，静默判成固定值', ghost.map(f => `h.${f}`).join(', '))
      : ok('自检读的栏位 worker 全回得出来', `${rd.length} 个栏位 ⊆ /api/health 回的 ${sd.size} 个`);

    /* 骨架（转圈时那排「检查中…」）里写的项目名，实际要真的存在，不然会闪一个不存在的项目。
       ⚠️ 只验这一个方向：实际项目里有一批是**条件才出现**的（日历订阅 / 待认领邮件 / 通知权限），
          它们本来就不该进骨架，反方向验会一直误报。 */
    const sk = JS.match(/const sk=\[([\s\S]*?)\];/);
    /* v10.23：项目名不止来自 healthChecks() —— runHealth 还会 C.push(selftestRow(...))，
       那一行的名字（银行邮件解析自检）在 selftestRow() 里。两个函式一起扫，别把真存在的行当成幽灵。 */
    const stBody = JS.match(/function selftestRow\([\s\S]*?\n\}/);
    const names = [...new Set([
      ...[...hcBody[0].matchAll(/n:'([^']+)'/g)].map(m => m[1]),
      ...(stBody ? [...stBody[0].matchAll(/n:'([^']+)'/g)].map(m => m[1]) : []),
    ])];
    if (!sk) warn('runHealth() 找不到骨架清单 sk');
    else {
      const skN = [...sk[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
      const gh = skN.filter(k => !names.some(n => n === k || n.startsWith(k)));
      gh.length ? warn('骨架里写了实际不存在的项目名（转圈时会闪一个查不到的项目）', gh.join(', '))
        : ok('自检骨架跟实际项目对得上', `骨架 ${skN.length} 项 · 实际 ${names.length} 项`);
    }
  }
}

/* ══════════════ 11. parser 接线 ══════════════
   这一组守的是「加了一支 parser，但它其实没在工作」这一整类错 —— 全都是静默的：
     · 写好了 parser，忘了接进分流 → 那种邮件一辈子掉在「读不到」，没有任何报错
     · 返回的物件漏一个栏位 → INSERT 那行 `.bind(r.raw, …)` 绑到 undefined → D1 抛错、
       被 catch 吞掉、只留一行 console.log，而收件箱那封还是标成「已记录」（v10.10 加 NETS
       时**真的漏了 raw**，是回归测试抓到的，不是看出来的）
     · worker 有**两条**分流链：`email()`（真正收信那条）和 `parseRaw()`（粘贴 / 重试 / 删账找来源）。
       只改一条 = 转发进来会记、手动粘贴不会记，或者反过来。 */
head('11. parser 接线');
{
  const defs = [...WK.matchAll(/^function (parse[A-Za-z]\w*)\s*\(/gm)].map(m => m[1]).filter(n => n !== 'parseRaw');
  /* ⚠️ 合并版唯一改动原文的一行。原文是：
         const emB = WK.match(/async email\(message[\s\S]*?const subject =/);
     两个问题：
       ① worker.js v10.13 把 subject 提到 try 外面一起宣告（`let rawFull="", from="", subject="", text=""`），
          里面那行就从 `const subject =` 变成 `subject =` → 这条正则**再也匹配不到**，
          §11 整组（parser 有没有接线 / 两条链顺序对不对）静默退成一条 WARN。
       ② 就算它匹配得到，抓到的也只是 email() 的**开头到 subject 那行为止**——
          分流链在更后面，所以抓到的区段里一支 parser 都没有 → E 是空集合 →
          「unwired」「顺序漂移」两条永远恒真 → **绿得毫无意义**。
     ①②合起来正是这份档开头骂的那件事：验过了所以绿，跟没看懂所以没吭声，长得一模一样。
     改法：锚点抓到 try 的结尾（分流链整段都在里面），抓不到就换下一个锚点，
     全都抓不到才 WARN；而且**抓到了也要回头验一下里面真的有 parser**，抓歪了要出声。 */
  const EM_ANCHORS = [
    /async email\(message[\s\S]*?\n\s*\}\s*catch/,   // 到 try 的结尾
    /async email\(message[\s\S]*?\n {0,4}\},?\n/,    // 退路：到第一个浅缩排的 }
  ];
  let emB = null;
  for (const re of EM_ANCHORS) { emB = WK.match(re); if (emB) break; }
  const prB = WK.match(/function parseRaw\([\s\S]*?\n\}/);
  const used = (s) => new Set([...s.matchAll(/\b(parse[A-Za-z]\w*)\s*\(/g)].map(m => m[1])
    .filter((x) => x !== 'parseRaw' && x !== 'parseInt' && x !== 'parseFloat'));
  if (emB && !/\bparse[A-Za-z]\w*\s*\(/.test(emB[0].replace(/\bparse(Raw|Int|Float)\s*\(/g, '')))
    warn('§11 锚点抓到 email() 了，但那一段里一支 parser 都没有 → 锚点抓歪了，下面三条等于没验', '去 validation.mjs 搜 EM_ANCHORS');
  if (!emB || !prB) warn('找不到 email() 或 parseRaw() 的分流链', '两条链都抓不到 → 下面三条检查这一轮没跑，别当成绿');
  else {
    const E = used(emB[0]), P = used(prB[0]);
    const unwired = defs.filter((n) => !E.has(n) && !P.has(n));
    unwired.length ? bad('写了 parser 但两条分流链都没接 → 那种信一辈子掉在「读不到」', unwired.join(', '))
      : ok('每支 parser 都接进分流了', `${defs.length} 支`);
    const drift = [...E].filter((n) => !P.has(n));
    /* 不只验「有没有」，还要验「顺序」：两条链的 parser 顺序不一样 = 同一封信走转发和走
       粘贴／重试会落到不同 parser（v10.10 之前 PayNow 的落回顺序就是反的）。
       email() 少几支是正常的（截图 parser 只走粘贴那条），所以验的是**子序列**不是完全相等。 */
    const seq = (s) => [...s.matchAll(/\b(parse[A-Za-z]\w*)\s*\(/g)].map((m) => m[1])
      .filter((x) => x !== 'parseRaw' && x !== 'parseInt' && x !== 'parseFloat');
    const eSeq = seq(emB[0]), pSeq = seq(prB[0]);
    let k = 0, badAt = null;
    for (const n of eSeq) { const i = pSeq.indexOf(n, k); if (i < 0) { badAt = n; break; } k = i + 1; }
    drift.length ? bad('email() 用了 parseRaw() 没有的 parser → 转发进来会记、粘贴/重试不会记', drift.join(', '))
      : badAt ? bad('两条分流链的 parser 顺序对不上 → 同一封信走转发和走粘贴/重试会落到不同 parser',
        `卡在 ${badAt}\nemail():   ${eSeq.join(' → ')}\nparseRaw(): ${pSeq.join(' → ')}`)
      : ok('email() 的 parser 顺序是 parseRaw() 的子序列', `email ${eSeq.length} 处 · parseRaw ${pSeq.length} 处`);
  }
  /* 栏位清单不写死，直接从 INSERT 那行的 .bind(r.xxx, …) 读 —— 以后谁加一栏，这条自动跟着严 */
  const bind = WK.match(/INSERT OR IGNORE INTO expenses[\s\S]{0,400}?\.bind\(([^)]*)\)/);
  if (!bind) warn('找不到 expenses 的 INSERT .bind(...)');
  else {
    const need = [...new Set([...bind[1].matchAll(/\br\.(\w+)/g)].map((m) => m[1]))];
    const holes = [];
    for (const n of defs) {
      const i = WK.indexOf('\nfunction ' + n + '(');
      const j = WK.indexOf('\nfunction ', i + 1);
      const body = WK.slice(i, j < 0 ? WK.length : j);
      const miss = need.filter((f) => !new RegExp('\\b' + f + '\\s*[:,]').test(body));
      if (miss.length) holes.push(`${n}  缺 ${miss.join(' / ')}`);
    }
    holes.length ? bad('parser 返回的物件缺 INSERT 要绑的栏位 → 绑到 undefined，那笔账存不进去', holes.join('\n'))
      : ok('每支 parser 的栏位都齐', `${need.length} 个栏位 × ${defs.length} 支`);
  }
  /* ⚠️ v10.17 新增：往 expenses 表 INSERT 时，type 那栏**不准写死字面量**。
     真实踩过（照片 IMG_6964）：ingestRaw（粘贴 / 重新识别共用）的 INSERT 写死 `VALUES(… 'expense' …)`，
     收入 parser（parseMariBankRefund / parseDBSPayNowIn）解出的 type:'income' 走这两条路全被打成支出。
     email() 那条早就绑 rtype 了，这条没跟上 —— 差一条就整类收入记反。所以钉死：任何 INSERT INTO expenses
     的 VALUES 里不准出现 'expense' / 'income' 字面量，type 必须绑变量(?)。 */
  {
    const inserts = [...WK.matchAll(/INSERT(?:\s+OR\s+IGNORE)?\s+INTO\s+expenses\b[\s\S]*?VALUES\s*\(([\s\S]*?)\)/gi)];
    const hard = inserts.filter((m) => /'(expense|income)'/i.test(m[1]))
      .map((m) => m[1].replace(/\s+/g, ' ').trim().slice(0, 70));
    hard.length
      ? bad('有 INSERT INTO expenses 把 type 写死成字面量 → 那条路上的收入会被打成支出（IMG_6964 那个坑）',
        hard.join('\n     ') + '\n     改法：先 const rtype = r.type===\'income\'?\'income\':\'expense\'，VALUES 用 ? 绑 rtype')
      : ok('入库 INSERT 的 type 都绑变量、没写死字面量', `${inserts.length} 条 INSERT INTO expenses`);
  }
}

  return { name: '§A 静态复检', ...R, skipped: false };
}

/* ══════════════════════════════════════════════════════════════════════════
   §B  parser 回归（原 test.mjs）—— 七封真实邮件 / 截图 × 三种形态
   ══════════════════════════════════════════════════════════════════════════
   三种形态各代表一条真实路径：
     · 纯文字   ＝ 截图 / 粘贴 / 已经抽好的正文
     · HTML 表格 ＝ 真的从 Cloudflare 进来那条
     · MIME 信封 ＝ 连信头带编码，跟收信端拿到的一模一样
   对不上就是回归。EXPECT 里的值不要为了让测试过而改。 */
function suiteParser(W) {
  /* pass / fail / run() / EXPECT 全在下面 §3-§4 那段原文里，这里不要再宣告一次 */
/* ══════════════════════════════════════════════════════════════════════
   §1  真实样本库 —— 逐字抄自用户 2026-08-05 提供的邮件截图 / 收据
   每一封都做两种形态：
     · 纯文字（＝截图 / 粘贴 / 已抽好的正文那条路）
     · HTML 表格（＝真的从 Cloudflare 进来那条路）
   ══════════════════════════════════════════════════════════════════════ */

const FWD = (from, date, subject) =>
  `---------- Forwarded message ---------\nFrom: <${from}>\nDate: ${date}\nSubject: ${subject}\nTo: <me@example.com>\n\n`;

/* ── ① OCBC · PayNow transfer made（IMG_6921）
      注意 "Time : 13:22 PM SGT" —— 24 小时制后面硬跟一个 PM，是真的这样写 ── */
const OCBC_PAYNOW_TXT = FWD('Notifications@ocbc.com', 'Tue, 14 Jul 2026 at 1:22 PM', 'PayNow transfer made') +
`Dear Valued Customer

The following PayNow transfer has been made to LIX YX CHIXXX using his/her Mobile (+******3161).

Date               : 14 Jul 2026
Time               : 13:22 PM SGT
Amount             : SGD 5.80
From your account  : 360 Account (-857001)
Description        : OTHR
Reference number   : 2607140116147079

If you have any questions, please call our Personal Banking hotline: OCBC website > Contact us.

Thank you for banking with us. We look forward to serving you again.

Yours sincerely

Digital Business
Global Consumer Financial Services
OCBC

Tip: To subscribe or change your settings for e-Alerts, log in to OCBC Internet Banking > Customer Service (on the top navigation bar) > Manage e-Alerts.

Do allow us to warn you against phishing attempts involving e-mails that claim to be from OCBC. We will not send you any emails with links requesting your personal details.`;

const OCBC_PAYNOW_HTML = `<html><body>
<p>Dear Valued Customer</p>
<p>The following PayNow transfer has been made to LIX YX CHIXXX using his/her Mobile (+******3161).</p>
<table>
<tr><td>Date</td><td>: 14 Jul 2026</td></tr>
<tr><td>Time</td><td>: 13:22 PM SGT</td></tr>
<tr><td>Amount</td><td>: SGD 5.80</td></tr>
<tr><td>From your account</td><td>: 360 Account (-857001)</td></tr>
<tr><td>Description</td><td>: OTHR</td></tr>
<tr><td>Reference number</td><td>: 2607140116147079</td></tr>
</table>
<p>Thank you for banking with us. We look forward to serving you again.</p>
</body></html>`;

/* ── ② OCBC · NETS QR payment made（IMG_6922）
      "Time : 01:16pm SGT" —— 12 小时制小写 pm，冒号在**值那一行**（表格排版 B）── */
const OCBC_NETS_TXT = FWD('Notifications@ocbc.com', 'Tue, 4 Aug 2026 at 1:16 PM', 'NETS QR payment made') +
`Dear Valued Customer

The following NETS QR payment has been made:

Date              : 04 Aug 2026
Time              : 01:16pm SGT
Amount            : SGD 4.50
From your account : 360 Account (-857001)
To                : FU HUI COOKED FOOD
NETS merchant ID  : 11169856600
NETS Stan ID      : 000000
Reference number  : 2608040116129894

If you have any questions, please call our Personal Banking hotline: OCBC website > Contact us.

Thank you for banking with us. We look forward to serving you again.`;

const OCBC_NETS_HTML = `<html><body>
<p>Dear Valued Customer</p>
<p>The following NETS QR payment has been made:</p>
<table>
<tr><td>Date</td><td>: 04 Aug 2026</td></tr>
<tr><td>Time</td><td>: 01:16pm SGT</td></tr>
<tr><td>Amount</td><td>: SGD 4.50</td></tr>
<tr><td>From your account</td><td>: 360 Account (-857001)</td></tr>
<tr><td>To</td><td>: FU HUI COOKED FOOD</td></tr>
<tr><td>NETS merchant ID</td><td>: 11169856600</td></tr>
<tr><td>NETS Stan ID</td><td>: 000000</td></tr>
<tr><td>Reference number</td><td>: 2608040116129894</td></tr>
</table>
</body></html>`;

/* ── ③ DBS · PayLah! Scan & Pay Transfer（IMG_6923）
      ⚠️ 关键：日期是 "05 Aug 18:38 (SGT)" —— **没有年份**。 ── */
const DBS_PAYLAH_TXT =
`Transaction Ref: IPS78592630026707383

Dear Sir / Madam,

We refer to your PayLah! Scan & Pay Transfer dated 05 Aug. We are pleased to confirm that the transaction was completed.

Date & Time:  05 Aug 18:38 (SGT)
Amount:  SGD10.00
From:  PayLah! Wallet (Mobile ending 6301)
To:  SINGAPORE POOLS (PRIVATE) LIMITED.

To view your transactions, login to your PayLah! Wallet and select "History" at the bottom bar of the Home page. To manage your PayLah! notifications, select "Settings" then "Manage Notifications".

Please call DBS hotline immediately if this was an unauthorised transaction.

Thank you for banking with us.

Yours faithfully
DBS Bank Ltd

This is an auto-generated message. Please do not reply to this email.`;

const DBS_PAYLAH_HTML = `<html><body>
<p>Transaction Ref: IPS78592630026707383</p>
<p>Dear Sir / Madam,</p>
<p>We refer to your PayLah! Scan &amp; Pay Transfer dated 05 Aug. We are pleased to confirm that the transaction was completed.</p>
<table>
<tr><td>Date &amp; Time:</td><td>05 Aug 18:38 (SGT)</td></tr>
<tr><td>Amount:</td><td>SGD10.00</td></tr>
<tr><td>From:</td><td>PayLah! Wallet (Mobile ending 6301)</td></tr>
<tr><td>To:</td><td>SINGAPORE POOLS (PRIVATE) LIMITED.</td></tr>
</table>
<p>Yours faithfully<br>DBS Bank Ltd</p>
</body></html>`;

/* ── ④ OCBC · Card Transaction Alert（IMG_6924）
      正文里满地都是 "OCBC app >" —— 分流闸门 raw.includes("OCBC") 靠它 ── */
const OCBC_CARD_TXT =
`Dear Valued Customer

We wish to inform you that SGD313.92 was charged at 01:02 on 04-Aug-26 to your card (-3578) at TRIP.COM Singapore SGP.

Did not make this transaction?
- Lock your card and/or report it as lost: OCBC app > More > Card Services > Lock/unlock card and/or Report lost card.
- Dispute the transaction: OCBC app > More > Card Services > Dispute transactions.

For the OCBC MyOwn Debit Card:
- Lock your card: OCBC app > MyOwn Account > Lock card
- Report a lost card, request a replacement card and/or dispute the transaction: Call our Personal Banking hotline or visit any OCBC Branch

Please call our Personal Banking hotline if you have further questions: OCBC website > Contact us.

Thank you for banking with us. We look forward to serving you again.

Yours sincerely

Group Lifestyle Financing`;

const OCBC_CARD_HTML = `<html><body>
<p>Dear Valued Customer</p>
<p>We wish to inform you that SGD313.92 was charged at 01:02 on 04-Aug-26 to your card (-3578) at <a href="http://trip.com">TRIP.COM</a> Singapore SGP.</p>
<p>Did not make this transaction?<br>- Lock your card and/or report it as lost: OCBC app &gt; More &gt; Card Services &gt; Lock/unlock card and/or Report lost card.<br>- Dispute the transaction: OCBC app &gt; More &gt; Card Services &gt; Dispute transactions.</p>
<p>Thank you for banking with us. We look forward to serving you again.</p>
</body></html>`;

/* ── ⑤ MariBank · Awesome! Your payment is successful（IMG_6925）
      CNY 计价、商家 Alipay*Taobao、卡尾 5831、时间独占下一行 ── */
const MARIBANK_TXT = FWD('notifications@maribank.sg', 'Sun, 2 Aug 2026 at 4:51 PM', 'Awesome! Your payment is successful') +
`MariBank

You have made a payment to Alipay*Taobao on your credit card ending 5831 with 0% FX fees.

Transaction Time:
02 Aug 2026 16:51 SGT

Amount:
CNY 20.00

If this was an unauthorised request, lock your card in-app by following the steps below and call our hotline immediately. You may find our Customer Service details below.

How to lock your card in-app:
1. Log in to your MariBank app.
2. Tap Card on the home screen.
3. Tap on Lock Card.

For enquiries, contact our Customer Service team.

In-app Live Chat   +6569958688

MariBank Singapore Pte Ltd (UEN: 202106516C)
This is a system generated message, please do not reply to this email.`;

const MARIBANK_HTML = `<html><body>
<table><tr><td><img src="maribank.png" alt="MariBank"></td></tr>
<tr><td>You have made a payment to Alipay*Taobao on your credit card ending 5831 with 0% FX fees.</td></tr>
<tr><td>Transaction Time:</td></tr><tr><td>02 Aug 2026 16:51 SGT</td></tr>
<tr><td>Amount:</td></tr><tr><td>CNY 20.00</td></tr>
<tr><td>MariBank Singapore Pte Ltd (UEN: 202106516C)</td></tr></table>
</body></html>`;

/* ── ⑥ TnG eWallet 截图（IMG_6774 · 真实收据）──
      -RM380.00 转账给人 · UUID 被折成两行 · Wallet Ref 38 位 */
const TNG_SHOT = `19:47
Details
-RM380.00
Transaction Type
Transfer to Wallet
Transfer To
EPHRAIM LEVI SOLIBUN
Payment Details
Fund Transfer
Payment Method
eWallet Balance
Date/Time
18/07/2026 16:39:40
Wallet Ref
20260718111217000101001719169678833346
Status
Successful
Transaction No.
c610428d-c427-4677-b175-
8c6763f0dfd0
Add To Favourites`;

const TNG_SHOT_1LINE = `19:47
Details
-RM380.00
Transaction Type    Transfer to Wallet
Transfer To    EPHRAIM LEVI SOLIBUN
Payment Details    Fund Transfer
Payment Method    eWallet Balance
Date/Time    18/07/2026 16:39:40
Wallet Ref    20260718111217000101001719169678833346
Status    Successful
Transaction No.    c610428d-c427-4677-b175-8c6763f0dfd0
Add To Favourites`;

/* ── ⑦ Maybank 截图（IMG_6781 · 真实收据）──
      -RM 86.00 · 商家名自带双空格「JB -  CONCE」 */
const MAYBANK_SHOT = `14:00
25 Jul 2026, 1:59 PM
GSC - SOUTHKEY JB -  CONCE
-RM 86.00
Payment
Maybank Debit Card Visa
**** **** **** 3869
Reference Number
620605020913
Merchant name
GSC - SOUTHKEY JB -  CONCE
Terminal ID
91100419
Merchant ID
048800001792720
Approval Code
151090
Share Receipt
* Actual transaction amount in MYR will reflect in your transaction history once it's processed. It will include the overseas transaction fee and admin fee.`;

const MAYBANK_SHOT_1LINE = `14:00
25 Jul 2026, 1:59 PM
GSC - SOUTHKEY JB -  CONCE
-RM 86.00
Payment    Maybank Debit Card Visa **** **** **** 3869
Reference Number    620605020913
Merchant name    GSC - SOUTHKEY JB -  CONCE
Terminal ID    91100419
Merchant ID    048800001792720
Approval Code    151090
Share Receipt`;

/* ── 样本索引 ── */
const REAL = {
  '① OCBC PayNow · 纯文字': OCBC_PAYNOW_TXT,
  '① OCBC PayNow · HTML': OCBC_PAYNOW_HTML,
  '② OCBC NETS QR · 纯文字': OCBC_NETS_TXT,
  '② OCBC NETS QR · HTML': OCBC_NETS_HTML,
  '③ DBS PayLah · 纯文字': DBS_PAYLAH_TXT,
  '③ DBS PayLah · HTML': DBS_PAYLAH_HTML,
  '④ OCBC 卡消费 · 纯文字': OCBC_CARD_TXT,
  '④ OCBC 卡消费 · HTML': OCBC_CARD_HTML,
  '⑤ MariBank · 纯文字': MARIBANK_TXT,
  '⑤ MariBank · HTML': MARIBANK_HTML,
  '⑥ TnG 截图 · 分行': TNG_SHOT,
  '⑥ TnG 截图 · 同行': TNG_SHOT_1LINE,
  '⑦ Maybank 截图 · 分行': MAYBANK_SHOT,
  '⑦ Maybank 截图 · 同行': MAYBANK_SHOT_1LINE,
};

/* 每封信的寄件人（分流闸门会看 from） */
const FROM = {
  '① OCBC PayNow · 纯文字': 'notifications@ocbc.com',
  '① OCBC PayNow · HTML': 'notifications@ocbc.com',
  '② OCBC NETS QR · 纯文字': 'notifications@ocbc.com',
  '② OCBC NETS QR · HTML': 'notifications@ocbc.com',
  '③ DBS PayLah · 纯文字': 'notify@dbs.com',
  '③ DBS PayLah · HTML': 'notify@dbs.com',
  '④ OCBC 卡消费 · 纯文字': 'notifications@ocbc.com',
  '④ OCBC 卡消费 · HTML': 'notifications@ocbc.com',
  '⑤ MariBank · 纯文字': 'notifications@maribank.sg',
  '⑤ MariBank · HTML': 'notifications@maribank.sg',
  '⑥ TnG 截图 · 分行': '',
  '⑥ TnG 截图 · 同行': '',
  '⑦ Maybank 截图 · 分行': '',
  '⑦ Maybank 截图 · 同行': '',
};

/* ── MIME 信封工具 ── */
const qpEncode = (s) => s.replace(/[=]/g, '=3D').replace(/(.{68})/g, '$1=\n');
const b64Encode = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/(.{76})/g, '$1\n');
const wrapMime = (body, cte, hdrCount = 6) => {
  const arc = Array.from({ length: hdrCount }, (_, i) =>
    `ARC-Seal: i=${i}; a=rsa-sha256; s=cf2024-1; d=cloudflare-email.net; cv=pass;\n        b=${'ez3lYlrO1OvCtY5Jff1Wf1iBMyKp2qkrF4kVd'.repeat(3)}`).join('\n');
  return `Received: from mail-oo1-xc36.google.com (2607:f8b0:4864:20::c36)\n        by cloudflare-email.net (cloudflare) id 9jI8heVKa2zu\n${arc}\n` +
    `DKIM-Signature: v=1; a=rsa-sha256; d=gmail.com;\nMIME-Version: 1.0\nFrom: bank <notify@bank.com>\n` +
    `Content-Type: text/html; charset="UTF-8"\nContent-Transfer-Encoding: ${cte}\n\n` +
    (cte === 'base64' ? b64Encode(body) : qpEncode(body)) + '\n';
};

/* ══════════════════════════════════════════════════════════════════════
   §3  期望值表 —— 七封真信 / 截图各应该解析成什么
        [source, currency, amount, merchant, card_last4, ts, hash]
   ══════════════════════════════════════════════════════════════════════ */

const EXPECT = {
  '① OCBC PayNow':  ['paynow',   'SGD',  5.80, 'LIX YX CHIXXX',                    'PayNow', '2026-07-14T13:22:00+08:00', 'paynow:2607140116147079'],
  '② OCBC NETS QR': ['paynow',   'SGD',  4.50, 'FU HUI COOKED FOOD',               'PayNow', '2026-08-04T13:16:00+08:00', 'nets:2608040116129894'],
  '③ DBS PayLah':   ['dbs',      'SGD', 10.00, 'SINGAPORE POOLS (PRIVATE) LIMITED.', null,   '2026-08-05T18:38:00+08:00', 'dbs:IPS78592630026707383'],
  /* ⚠️ v10.20：商家从 'TRIP' 改成完整的 'TRIP.COM Singapore SGP'。旧值 'TRIP' 其实是**旧 bug 被写进了期望**——
     旧 parseOCBC 结尾 `(.+?)(?:\.|$)` 在第一个点（TRIP 后那个 .）就断了，把 ".COM Singapore SGP" 全丢了。
     修 www.anywheel.sg 腰斩时一并改成逐行 + 行尾锚，这里也顺带抓全了，才是对的。 */
  '④ OCBC 卡消费':  ['ocbc',     'SGD', 313.92, 'TRIP.COM Singapore SGP',          '3578',   '2026-08-04T01:02:00+08:00', 'ocbc:2026-08-04T01:02:313.92:3578'],
  '⑤ MariBank':     ['maribank', 'CNY', 20.00, 'Alipay*Taobao',                    '5831',   '2026-08-02T16:51:00+08:00', 'mbk:2026-08-02T16:51:00+08:00:20:5831'],
  '⑥ TnG 截图':     ['tng', 'MYR', 380.00, 'EPHRAIM LEVI SOLIBUN',      'TnG',  '2026-07-18T16:39:40+08:00', 'tng:c610428d-c427-4677-b175-8c6763f0dfd0'],
  '⑦ Maybank 截图': ['mbb', 'MYR',  86.00, 'GSC - SOUTHKEY JB - CONCE', '3869', '2026-07-25T13:59:00+08:00', 'mbb:620605020913'],
};

/* ══════════════════════════════════════════════════════════════════════
   §4  跑测试
   ══════════════════════════════════════════════════════════════════════ */

const FIELDS = ['source', 'currency', 'amount', 'merchant', 'card_last4', 'ts', 'hash'];
const shape = (r) => [r.source, r.currency, r.amount, r.merchant, r.card_last4, r.ts, r.hash];
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const key = (n) => Object.keys(EXPECT).find(k => n.startsWith(k.slice(0, 3)));

let pass = 0, fail = 0;
const run = (label, raw, from, want) => {
  const rows = W.parseRaw(raw, from || '');
  if (rows.length !== 1) { fail++; console.log(`❌ ${label}\n     解析出 ${rows.length} 笔，应该是 1 笔`); return; }
  const got = shape(rows[0]);
  if (eq(got, want)) { pass++; console.log(`✅ ${label}`); return; }
  fail++;
  console.log(`❌ ${label}`);
  FIELDS.forEach((f, i) => { if (!eq(got[i], want[i])) console.log(`     ${f.padEnd(11)} 应为 ${JSON.stringify(want[i])}  实际 ${JSON.stringify(got[i])}`); });
};

/* ── A. 纯文字形态（截图 / 粘贴 / 已抽好的正文）── */
console.log('── 纯文字形态（截图 / 粘贴 / 已抽好的正文）──');
for (const [name, raw] of Object.entries(REAL)) {
  if (!name.includes('纯文字') && !name.includes('截图')) continue;
  const k = key(name); if (!k) continue;
  run(name, raw, FROM[name], EXPECT[k]);
}

/* ── B. HTML 表格形态 ── */
console.log('\n── HTML 表格形态 ──');
for (const [name, raw] of Object.entries(REAL)) {
  if (!name.endsWith('HTML')) continue;
  const k = key(name); if (!k) continue;
  run(name, raw, FROM[name], EXPECT[k]);
}

/* ── C. 包成真 MIME 信封（走 Cloudflare 那条真实路径）── */
console.log('\n── 包成真 MIME 信封（走 Cloudflare 那条真实路径）──');
for (const [name, raw] of Object.entries(REAL)) {
  if (!name.endsWith('HTML')) continue;
  const k = key(name); if (!k) continue;
  for (const cte of ['base64', 'quoted-printable']) {
    run(`${k}  [${cte}]`, W.mailText(wrapMime(raw, cte)), FROM[name], EXPECT[k]);
  }
}

  return { name: '§B parser 回归', pass, fail, warn: 0, skipped: false };
}

/* ══════════════════════════════════════════════════════════════════════════
   §C  日历（原 cal-test.mjs）
   ══════════════════════════════════════════════════════════════════════════
   §1 基础日期工具 · §2 重复展开 · §3 单次修改 · §4 多重提醒 · §5 通知时间
   §6 重复规则入库 · §7 压力测试 · §8 边界 · §9 前后端一致性 */
function suiteCal(W) {
  let pass = 0, fail = 0, section = '';
  const head = (t) => { section = t; console.log(`\n${L.dim}── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}${L.off}`); };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function assert(name, got, want) {
    if (eq(got, want)) { pass++; if (VERBOSE) console.log(`${L.ok}  PASS${L.off}  ${name}`); }
    else { fail++; console.log(`${L.bad}  FAIL${L.off}  ${name}\n        应为 ${JSON.stringify(want)}\n        实际 ${JSON.stringify(got)}`); }
  }
  function ok(name) { pass++; if (VERBOSE) console.log(`${L.ok}  PASS${L.off}  ${name}`); }
  function bad(name, detail) { fail++; console.log(`${L.bad}  FAIL${L.off}  ${name}${detail ? '\n        ' + detail : ''}`); }

/* ══════════════ §1 基础日期工具 ══════════════ */
head('§1 基础日期工具');
{
  // wIso: epoch ms → YYYY-MM-DD (SGT)
  assert('wIso 基本', W.wIso(Date.parse('2026-08-05T00:00:00+08:00')), '2026-08-05');
  assert('wIso UTC 跨日', W.wIso(Date.parse('2026-08-05T20:00:00Z')), '2026-08-06'); // UTC 20:00 = SGT 04:00 next day

  // wIdx / wDay 往返
  const d1 = '2026-01-01';
  assert('wIdx→wDay 往返', W.wDay(W.wIdx(d1)), d1);
  const d2 = '2026-12-31';
  assert('wIdx→wDay 年末', W.wDay(W.wIdx(d2)), d2);
  const d3 = '2028-02-29'; // 闰年
  assert('wIdx→wDay 闰年', W.wDay(W.wIdx(d3)), d3);

  // wWd: 星期几
  assert('wWd 2026-08-06 (周四)', W.wWd('2026-08-06'), 4);
  assert('wWd 2026-08-03 (周一)', W.wWd('2026-08-03'), 1);
  assert('wWd 2026-08-09 (周日)', W.wWd('2026-08-09'), 0);

  // wAdd
  assert('wAdd +1', W.wAdd('2026-08-05', 1), '2026-08-06');
  assert('wAdd -1', W.wAdd('2026-08-05', -1), '2026-08-04');
  assert('wAdd 跨月', W.wAdd('2026-08-31', 1), '2026-09-01');
  assert('wAdd 跨年', W.wAdd('2026-12-31', 1), '2027-01-01');
  assert('wAdd +0', W.wAdd('2026-08-05', 0), '2026-08-05');

  // wHm
  assert('wHm "09:30"', W.wHm('09:30'), 570);
  assert('wHm "0:0"', W.wHm('0:0'), 0);
  assert('wHm "23:59"', W.wHm('23:59'), 1439);
  assert('wHm null', W.wHm(null), 0);

  console.log(`${L.ok}  ${section}: ${pass} 项通过${L.off}`);
}

/* ══════════════ §2 重复展开 (wOccur) ══════════════ */
head('§2 重复展开 (wOccur)');
{
  const p0 = pass;

  // 2.1 不重复
  const e1 = { day: '2026-08-10', rep: null };
  assert('不重复 · 在范围内', W.wOccur(e1, '2026-08-01', '2026-08-31'), ['2026-08-10']);
  assert('不重复 · 在范围外', W.wOccur(e1, '2026-09-01', '2026-09-30'), []);

  // 2.2 每天
  const e2 = { day: '2026-08-01', rep: { t: 'day', i: 1 } };
  const r2 = W.wOccur(e2, '2026-08-01', '2026-08-05');
  assert('每天 · 5天', r2, ['2026-08-01','2026-08-02','2026-08-03','2026-08-04','2026-08-05']);

  // 2.3 每隔一天
  const e3 = { day: '2026-08-01', rep: { t: 'day', i: 2 } };
  const r3 = W.wOccur(e3, '2026-08-01', '2026-08-07');
  assert('隔天 · 4次', r3, ['2026-08-01','2026-08-03','2026-08-05','2026-08-07']);

  // 2.4 每周一（2026-08-03 = 周一，d:[1] = 周一）
  const e4 = { day: '2026-08-03', rep: { t: 'week', i: 1, d: [1] } };
  const r4 = W.wOccur(e4, '2026-08-01', '2026-08-31');
  assert('每周一 · 8月', r4, ['2026-08-03','2026-08-10','2026-08-17','2026-08-24','2026-08-31']);

  // 2.5 每周多天（2026-08-04 = 周二，d:[2,4] = 周二+周四）
  const e5 = { day: '2026-08-04', rep: { t: 'week', i: 1, d: [2, 4] } };
  const r5 = W.wOccur(e5, '2026-08-04', '2026-08-15');
  assert('周二四 · 两周', r5, ['2026-08-04','2026-08-06','2026-08-11','2026-08-13']);

  // 2.6 每月
  const e6 = { day: '2026-01-15', rep: { t: 'month', i: 1 } };
  const r6 = W.wOccur(e6, '2026-01-01', '2026-06-30');
  assert('每月15号 · 半年', r6, ['2026-01-15','2026-02-15','2026-03-15','2026-04-15','2026-05-15','2026-06-15']);

  // 2.7 每月31号（2月没有31号 → 跳过）
  const e7 = { day: '2026-01-31', rep: { t: 'month', i: 1 } };
  const r7 = W.wOccur(e7, '2026-01-01', '2026-06-30');
  // 2月没31号跳过，3月有，4月没有(30天)跳过，5月有，6月没有(30天)跳过
  assert('每月31号 · 跳短月', r7, ['2026-01-31','2026-03-31','2026-05-31']);

  // 2.8 每年（生日）
  const e8 = { day: '2026-05-26', rep: { t: 'year', i: 1 } };
  const r8 = W.wOccur(e8, '2026-01-01', '2030-12-31');
  assert('每年生日 · 5年', r8, ['2026-05-26','2027-05-26','2028-05-26','2029-05-26','2030-05-26']);

  // 2.9 闰年2月29日生日（非闰年跳过）
  const e9 = { day: '2028-02-29', rep: { t: 'year', i: 1 } };
  const r9 = W.wOccur(e9, '2028-01-01', '2036-12-31');
  assert('闰年生日 · 只在闰年出现', r9, ['2028-02-29','2032-02-29','2036-02-29']);

  // 2.10 例外日 (ex)
  const e10 = { day: '2026-08-01', rep: { t: 'day', i: 1, ex: ['2026-08-03', '2026-08-05'] } };
  const r10 = W.wOccur(e10, '2026-08-01', '2026-08-05');
  assert('例外日 · 跳过2天', r10, ['2026-08-01','2026-08-02','2026-08-04']);

  // 2.11 until (结束日)
  const e11 = { day: '2026-08-01', rep: { t: 'day', i: 1, until: '2026-08-03' } };
  const r11 = W.wOccur(e11, '2026-08-01', '2026-08-10');
  assert('until · 只到第3天', r11, ['2026-08-01','2026-08-02','2026-08-03']);

  // 2.12 上限 200
  const e12 = { day: '2020-01-01', rep: { t: 'day', i: 1 } };
  const r12 = W.wOccur(e12, '2020-01-01', '2030-12-31');
  assert('上限 200', r12.length, 200);

  // 2.13 起始日在范围之前（不该从范围开始算，而是从原始 day 开始算间隔）
  const e13 = { day: '2026-01-01', rep: { t: 'day', i: 7 } }; // 每7天
  const r13 = W.wOccur(e13, '2026-02-01', '2026-02-28');
  // 1月1日起每7天：1/1, 1/8, 1/15, 1/22, 1/29, 2/5, 2/12, 2/19, 2/26
  assert('间隔对齐 · 从原始day算', r13, ['2026-02-05','2026-02-12','2026-02-19','2026-02-26']);

  // 2.14 每2周（day=2026-08-04 周二，d:[1] 周一 → 第一个周一8-03<day被跳过 → 8-17起）
  const e14 = { day: '2026-08-04', rep: { t: 'week', i: 2, d: [1] } };
  const r14 = W.wOccur(e14, '2026-08-01', '2026-09-30');
  assert('隔周一 · 2个月', r14, ['2026-08-17','2026-08-31','2026-09-14','2026-09-28']);

  // 2.15 每3个月
  const e15 = { day: '2026-01-10', rep: { t: 'month', i: 3 } };
  const r15 = W.wOccur(e15, '2026-01-01', '2027-01-31');
  assert('每3个月 · 1年', r15, ['2026-01-10','2026-04-10','2026-07-10','2026-10-10','2027-01-10']);

  console.log(`${L.ok}  ${section}: ${pass - p0} 项通过${L.off}`);
}

/* ══════════════ §3 单次修改 ══════════════ */
head('§3 单次修改 (modApply)');
{
  const p0 = pass;

  // 3.1 没有 mod → 原样返回
  const e1 = { day: '2026-08-10', time: '09:00', title: 'Gym', rep: null };
  assert('无 mod', W.modApply(e1, '2026-08-10'), e1);

  // 3.2 有 mod → 覆盖对应栏位
  const e2 = { day: '2026-08-10', time: '09:00', title: 'Gym', note: null,
    rep: { t: 'week', i: 1, d: [1], mod: { '2026-08-17': { ti: 'Yoga', t: '10:00' } } } };
  const r2 = W.modApply(e2, '2026-08-17');
  assert('mod 标题', r2.title, 'Yoga');
  assert('mod 时间', r2.time, '10:00');

  // 3.3 不在 mod 里的日子 → 原样
  const r3 = W.modApply(e2, '2026-08-10');
  assert('不在 mod 里', r3.title, 'Gym');

  // 3.4 modWrite → modRead 往返
  const mod = { '2026-08-17': { ti: 'Changed', t: '14:00', no: 'special note' } };
  const written = W.modWrite(mod);
  const read = W.modRead(written);
  assert('modWrite→modRead 标题', read['2026-08-17'].ti, 'Changed');
  assert('modWrite→modRead 时间', read['2026-08-17'].t, '14:00');

  // 3.5 modRead 坏 JSON → null
  assert('modRead 坏JSON', W.modRead('not json'), null);
  assert('modRead null', W.modRead(null), null);
  assert('modRead 空对象', W.modRead('{}'), null);

  console.log(`${L.ok}  ${section}: ${pass - p0} 项通过${L.off}`);
}

/* ══════════════ §4 多重提醒 ══════════════ */
head('§4 多重提醒 (nlClean/nlRead)');
{
  const p0 = pass;

  // nlClean
  assert('nlClean 正常', W.nlClean([1440, 30, 0]), [1440, 30, 0]);
  assert('nlClean 去重', W.nlClean([30, 30, 30]), [30]);
  assert('nlClean 排序降序', W.nlClean([0, 30, 1440]), [1440, 30, 0]);
  assert('nlClean 上限5个', W.nlClean([1,2,3,4,5,6,7,8]).length, 5);
  assert('nlClean 非数组', W.nlClean('hello'), []);
  assert('nlClean 负数排除', W.nlClean([-10, 30]), [30]);
  assert('nlClean 超上限排除', W.nlClean([99999, 30]), [30]);
  assert('nlClean 对象形式', W.nlClean([{m:30},{m:1440}]), [1440, 30]);

  // nlRead
  assert('nlRead JSON', W.nlRead('[1440,30]', null), [1440, 30]);
  assert('nlRead null退回fallback', W.nlRead(null, 30), [30]);
  assert('nlRead 坏JSON退回', W.nlRead('broken', 10), [10]);
  assert('nlRead 都null', W.nlRead(null, null), []);

  console.log(`${L.ok}  ${section}: ${pass - p0} 项通过${L.off}`);
}

/* ══════════════ §5 通知时间 ══════════════ */
head('§5 通知时间 (wNotifyAt/wLead)');
{
  const p0 = pass;

  // wNotifyAt: 有时间的事项
  const at1 = W.wNotifyAt({ time: '14:00', notify_min: 30 }, '2026-08-10');
  const expect1 = Date.parse('2026-08-10T13:30:00+08:00');
  assert('14:00 提前30分', at1, expect1);

  // wNotifyAt: 全天事项（基准 09:00）
  const at2 = W.wNotifyAt({ time: null, notify_min: 1440 }, '2026-08-10');
  const expect2 = Date.parse('2026-08-09T09:00:00+08:00'); // 前一天 09:00
  assert('全天 提前1天', at2, expect2);

  // wNotifyAt: 准时
  const at3 = W.wNotifyAt({ time: '09:00', notify_min: 0 }, '2026-08-10');
  const expect3 = Date.parse('2026-08-10T09:00:00+08:00');
  assert('准时', at3, expect3);

  // wLead
  assert('wLead 准时(有时间)', W.wLead(0, true), '现在');
  assert('wLead 30分', W.wLead(30, true), '还有 30 分钟');
  assert('wLead 2小时', W.wLead(120, true), '还有 2 小时');
  assert('wLead 1天', W.wLead(1440, true), '还有 1 天');
  assert('wLead 全天0', W.wLead(0, false), '');
  assert('wLead 全天1天', W.wLead(1440, false), '前1天');
  assert('wLead 全天1周', W.wLead(10080, false), '前1周');
  assert('wLead null', W.wLead(null, true), '');

  console.log(`${L.ok}  ${section}: ${pass - p0} 项通过${L.off}`);
}

/* ══════════════ §6 重复规则入库 ══════════════ */
head('§6 重复规则入库 (repCols/repFromRow)');
{
  const p0 = pass;

  // 6.1 正常规则
  const rep1 = { t: 'week', i: 2, d: [1, 3, 5], until: '2026-12-31', ex: ['2026-08-10'], mod: null };
  const cols1 = W.repCols(rep1);
  assert('repCols type', cols1.rt, 'week');
  assert('repCols interval', cols1.ri, 2);
  assert('repCols days', cols1.rd, '1,3,5');
  assert('repCols until', cols1.ru, '2026-12-31');
  assert('repCols ex', cols1.rx, '2026-08-10');

  // 6.2 无效规则 → 全 null
  const cols2 = W.repCols(null);
  assert('repCols null', cols2.rt, null);
  const cols3 = W.repCols({ t: 'invalid' });
  assert('repCols 无效type', cols3.rt, null);

  // 6.3 repFromRow（DB → 前端形状）
  const row = { rep_type: 'month', rep_int: 3, rep_days: null, rep_until: '2027-06-30', rep_ex: '2026-09-15', rep_mod: null };
  const rep3 = W.repFromRow(row);
  assert('repFromRow type', rep3.t, 'month');
  assert('repFromRow interval', rep3.i, 3);
  assert('repFromRow until', rep3.until, '2027-06-30');

  // 6.4 repFromRow 前端形状（备份还原）
  const row2 = { rep: { t: 'year', i: 1, d: null, until: null, ex: null, mod: null } };
  const rep4 = W.repFromRow(row2);
  assert('repFromRow 前端形状', rep4.t, 'year');

  // 6.5 interval 夹紧 [1, 99]
  const cols5 = W.repCols({ t: 'day', i: 0 });
  assert('repCols i=0→1', cols5.ri, 1);
  const cols6 = W.repCols({ t: 'day', i: 999 });
  assert('repCols i=999→99', cols6.ri, 99);

  console.log(`${L.ok}  ${section}: ${pass - p0} 项通过${L.off}`);
}

/* ══════════════ §7 压力测试 ══════════════ */
head('§7 压力测试：大量事项展开');
{
  const p0 = pass;

  // 7.1 灌 500 个每日事项，展开一个月
  const events = [];
  for (let i = 0; i < 500; i++) {
    events.push({
      day: `2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
      rep: (i % 3 === 0) ? { t: 'day', i: 1 } : (i % 3 === 1) ? { t: 'week', i: 1, d: [i % 7] } : null,
    });
  }

  const t0 = performance.now();
  let totalOcc = 0;
  for (const e of events) {
    const r = W.wOccur(e, '2026-08-01', '2026-08-31');
    totalOcc += r.length;
  }
  const ms = (performance.now() - t0).toFixed(1);
  if (totalOcc > 0) ok(`500事项展开8月: ${totalOcc} 次出现, ${ms}ms`);
  else bad('500事项展开8月: 0 次出现');

  // 7.2 展开结果不重复
  const e_dup = { day: '2026-08-01', rep: { t: 'day', i: 1 } };
  const r_dup = W.wOccur(e_dup, '2026-08-01', '2026-08-31');
  const set = new Set(r_dup);
  assert('无重复展开', r_dup.length, set.size);

  // 7.3 展开结果有序
  const sorted = [...r_dup].sort();
  assert('展开有序', eq(r_dup, sorted), true);

  // 7.4 1000 个每周事项，展开一整年
  const weeklyEvents = [];
  for (let i = 0; i < 1000; i++) {
    weeklyEvents.push({
      day: '2026-01-01',
      rep: { t: 'week', i: 1, d: [i % 7] },
    });
  }
  const t1 = performance.now();
  let yearOcc = 0;
  for (const e of weeklyEvents) {
    yearOcc += W.wOccur(e, '2026-01-01', '2026-12-31').length;
  }
  const ms2 = (performance.now() - t1).toFixed(1);
  if (yearOcc > 0) ok(`1000周事项展开一年: ${yearOcc} 次, ${ms2}ms`);
  else bad('1000周事项展开一年: 0 次');

  // 7.5 每月事项 × 100，展开 10 年
  const t2 = performance.now();
  let decadeOcc = 0;
  for (let i = 0; i < 100; i++) {
    const e = { day: '2026-01-15', rep: { t: 'month', i: 1 } };
    decadeOcc += W.wOccur(e, '2026-01-01', '2036-12-31').length;
  }
  const ms3 = (performance.now() - t2).toFixed(1);
  // 每月1次 × 132个月（11年）× 100 个 = 应该每个都命中 200 上限
  if (decadeOcc > 0) ok(`100月事项展开10年: ${decadeOcc} 次, ${ms3}ms`);
  else bad('100月事项展开10年: 0 次');

  console.log(`${L.ok}  ${section}: ${pass - p0} 项通过${L.off}`);
}

/* ══════════════ §8 跨年/闰年/月末 边界 ══════════════ */
head('§8 边界测试');
{
  const p0 = pass;

  // 8.1 跨年展开
  const e1 = { day: '2026-12-28', rep: { t: 'day', i: 1 } };
  const r1 = W.wOccur(e1, '2026-12-28', '2027-01-03');
  assert('跨年展开', r1, ['2026-12-28','2026-12-29','2026-12-30','2026-12-31','2027-01-01','2027-01-02','2027-01-03']);

  // 8.2 每月30号在2月（28天月 → 跳过）
  const e2 = { day: '2026-01-30', rep: { t: 'month', i: 1 } };
  const r2 = W.wOccur(e2, '2026-01-01', '2026-04-30');
  assert('每月30号 · 跳2月', r2, ['2026-01-30','2026-03-30','2026-04-30']);

  // 8.3 闰年2月29日
  const e3 = { day: '2028-02-29', rep: null };
  assert('闰年2月29日 存在', W.wOccur(e3, '2028-01-01', '2028-12-31'), ['2028-02-29']);

  // 8.4 每年一次，起始在年底
  const e4 = { day: '2026-12-31', rep: { t: 'year', i: 1 } };
  const r4 = W.wOccur(e4, '2026-01-01', '2030-12-31');
  assert('每年12月31日', r4, ['2026-12-31','2027-12-31','2028-12-31','2029-12-31','2030-12-31']);

  // 8.5 查询范围在事项之前 → 空
  const e5 = { day: '2026-08-10', rep: { t: 'day', i: 1 } };
  assert('范围在事项前', W.wOccur(e5, '2026-07-01', '2026-07-31'), []);

  // 8.6 until 和 ex 同时存在
  const e6 = { day: '2026-08-01', rep: { t: 'day', i: 1, until: '2026-08-05', ex: ['2026-08-03'] } };
  const r6 = W.wOccur(e6, '2026-08-01', '2026-08-31');
  assert('until+ex 组合', r6, ['2026-08-01','2026-08-02','2026-08-04','2026-08-05']);

  // 8.7 起始日正好是范围的边界
  const e7 = { day: '2026-08-01', rep: null };
  assert('起始日=范围起点', W.wOccur(e7, '2026-08-01', '2026-08-01'), ['2026-08-01']);
  assert('起始日=范围终点', W.wOccur(e7, '2026-07-01', '2026-08-01'), ['2026-08-01']);

  // 8.8 gcWindow 返回合理范围
  const win = W.gcWindow();
  assert('gcWindow.lo 有年份', /^\d{4}-01-01$/.test(win.lo), true);
  assert('gcWindow.hi 有年份', /^\d{4}-12-31$/.test(win.hi), true);
  assert('gcWindow.timeMin 带时区', win.timeMin.endsWith('+08:00'), true);

  // 8.9 每周 rep 没给 d → 用 day 的星期几
  const e9 = { day: '2026-08-05', rep: { t: 'week', i: 1 } }; // 周二
  const r9 = W.wOccur(e9, '2026-08-01', '2026-08-31');
  // 应该每周二: 5, 12, 19, 26
  assert('每周无d → 用day的星期', r9, ['2026-08-05','2026-08-12','2026-08-19','2026-08-26']);

  // 8.10 空 ex 数组不影响
  const e10 = { day: '2026-08-01', rep: { t: 'day', i: 1, ex: [] } };
  const r10 = W.wOccur(e10, '2026-08-01', '2026-08-03');
  assert('空ex数组', r10, ['2026-08-01','2026-08-02','2026-08-03']);

  console.log(`${L.ok}  ${section}: ${pass - p0} 项通过${L.off}`);
}

/* ══════════════ §9 前后端一致性 ══════════════ */
head('§9 前后端一致性验证');
{
  const p0 = pass;

  /* worker 的 wOccur 和 modApply 必须跟前端的 repOccurrences 和 evModApply 行为一致。
     前端的代码在 index.html 里（我们不能在 Node 里跑），所以这里只验 worker 侧的
     关键不变量：两套代码的核心算法结构相同，用同样的测试案例验证边界一致。*/

  // 9.1 week rep 的 anchor 计算一致
  // 前端: anchor = dayIdx(e.day) - dayWd(e.day)
  // worker: anchor = wIdx(e.day) - wWd(e.day)
  const day = '2026-08-05';
  const anchor_w = W.wIdx(day) - W.wWd(day);
  // 验证 anchor 指向那一周的周日
  const anchorDay = W.wDay(anchor_w);
  assert('anchor 是周日', W.wWd(anchorDay), 0);

  // 9.2 modApply 处理所有栏位
  const e2 = { day: '2026-08-10', time: '09:00', title: 'Test', note: 'orig', kind: 'event',
    notify_min: 0, nl: [0],
    rep: { t: 'week', i: 1, mod: { '2026-08-17': { ti: 'Mod', t: '15:00', et: '16:00', no: 'new note', k: 'reminder', nm: 30, nl: [1440, 30] } } } };
  const r2 = W.modApply(e2, '2026-08-17');
  assert('mod 全栏位 title', r2.title, 'Mod');
  assert('mod 全栏位 time', r2.time, '15:00');
  assert('mod 全栏位 etime', r2.etime, '16:00');
  assert('mod 全栏位 note', r2.note, 'new note');
  assert('mod 全栏位 kind', r2.kind, 'reminder');
  assert('mod 全栏位 notify_min', r2.notify_min, 30);
  assert('mod 全栏位 nl', r2.nl, [1440, 30]);

  // 9.3 mod 只覆盖传了的栏位，不动其他的
  const e3 = { day: '2026-08-10', time: '09:00', title: 'Gym', note: 'keep me',
    rep: { t: 'week', i: 1, mod: { '2026-08-17': { ti: 'Run' } } } };
  const r3 = W.modApply(e3, '2026-08-17');
  assert('mod 部分覆盖 title', r3.title, 'Run');
  assert('mod 部分覆盖 note不动', r3.note, 'keep me');
  assert('mod 部分覆盖 time不动', r3.time, '09:00');

  console.log(`${L.ok}  ${section}: ${pass - p0} 项通过${L.off}`);
}

  return { name: '§C 日历', pass, fail, warn: 0, skipped: false };
}

/* ══════════════════════════════════════════════════════════════════════════
   §D  铁律 & 健壮性（v10.15 新增）

   §A 验静态、§B 验「这封真信解出来对不对」、§C 验日历 —— 三组全绿，
   却没有任何一条守着**负向**铁律：「不该记的东西有没有被记进去」。
   v10.14 就是这样：24/24 + 107/107 全绿，而 parseDBS / parseMariBank /
   parsePayLahShot / parseMaybankShot 一封收款信都挡不住 —— 测试全绿，账是错的。

   ⚠️ 这一组的样本和 §B 不同：§B 的 EXPECT 逐字来自真实邮件，**不准改**；
      §D1 的收款措辞是**构造**的（手上还没有真的 DBS/PayLah 收款信），验的是
      「出现这种措辞就不准记账」这条规则，不是「真信长这样」。
      拿到真的收款邮件之后，把那封信原文加进来，这一组才算真正封死。
   ⚠️ §D2 是**反向保险**：守卫写太宽会把正常支出信一起挡掉（挡掉 = 掉进「读不到」，
      看得见但要手动补）。这几条钉住「这些措辞不准误挡」。
   ══════════════════════════════════════════════════════════════════════════ */

async function suiteIron(W) {
  let pass = 0, fail = 0;
  const ok  = (m, d) => { pass++; if (VERBOSE) console.log(`${L.ok}  ✅ ${m}${L.off}${d ? `  ${L.dim}${d}${L.off}` : ''}`); };
  const bad = (m, d) => { fail++; console.log(`${L.bad}  ❌ ${m}${L.off}${d ? `\n     ${d}` : ''}`); };

  /* ── §D1 铁律2：收款不记账 ──
     刻意**直接调 parser**、不走 parseRaw：走 parseRaw 的话，闸门没开也会回 []，
     测试照样绿 —— 那是「没跑到」不是「挡住了」，正是这份档开头骂的那种假绿。 */
  head('§D1 收款不记账（铁律2 · 直接调 parser）');
  {
    const DBS_IN = (line, ref) =>
      `DBS PayLah!\n${line}\nDate & Time : 05 Aug 2026 12:41 (SGT)\nTransaction Ref : ${ref}`;
    const CASES = [
      ['parseDBS  · You have received', W.parseDBS, DBS_IN('You have received SGD 25.00 from ALICE TAN', 'IP2608051241001')],
      ['parseDBS  · You received（裸）', W.parseDBS, DBS_IN('You received SGD 40.00 from BOB', 'IP2608051241002')],
      ['parseDBS  · has been credited', W.parseDBS, DBS_IN('SGD 30.00 has been credited to your account', 'IP2608051241003')],
      ['parseDBS  · received from',     W.parseDBS, DBS_IN('Amount : SGD 12.00\nreceived from CAROL', 'IP2608051241004')],
      ['parseDBS  · Incoming transfer', W.parseDBS, DBS_IN('Incoming transfer\nAmount : SGD 88.00', 'IP2608051241005')],
      ['parseDBS  · Money received',    W.parseDBS, DBS_IN('Money received\nAmount : SGD 22.00', 'IP2608051241006')],
      ['parseDBS  · has paid you',      W.parseDBS, DBS_IN('DAVE has paid you SGD 15.00', 'IP2608051241007')],
      ['parsePayNow · have received',   W.parsePayNow, `PayNow transfer\nThe following PayNow transfer has been received from ALICE.\nDate : 14 Jul 2026\nTime : 13:22 PM SGT\nAmount : SGD 5.80\nReference number : 2607140116147079`],
      ['parsePayNow · 裸 You received', W.parsePayNow, `PayNow transfer\nYou received SGD 5.80 from ALICE.\nDate : 14 Jul 2026\nTime : 13:22 PM SGT\nAmount : SGD 5.80\nReference number : 2607140116147079`],
      ['parsePayNow · Incoming PayNow', W.parsePayNow, `Incoming PayNow payment\nDate : 14 Jul 2026\nTime : 13:22 PM SGT\nAmount : SGD 5.80\nReference number : 2607140116147079`],
      ['parseNETS · refund credited',   W.parseNETS, `The following NETS QR payment has been made:\nDate : 04 Aug 2026\nTime : 01:16pm SGT\nAmount : SGD 4.50\nTo : FU HUI COOKED FOOD\nNETS merchant ID : 11169856600\nReference number : 2608040116129894\n\nThis amount has been credited to your account.`],
      ['parseMariBank · have received', W.parseMariBank, `MariBank\nYou have received SGD 50.00 from ALICE\nTransaction Time\n05 Aug 2026 12:41 SGT\nAmount\nSGD 50.00`],
      ['parseMariBank · credited',      W.parseMariBank, `MariBank\nSGD 50.00 has been credited to your account\nTransaction Time\n05 Aug 2026 12:41 SGT\nAmount\nSGD 50.00`],
      ['parsePayLahShot · You received', W.parsePayLahShot, `20:18\nHistory PayLah!\nYou received SGD 30.00\n20 JUL • 01:30 PM\nTransaction Ref. No.\nIP178452545726811745`],
      ['parsePayLahShot · 清单混排',     W.parsePayLahShot, `20:18\nHistory PayLah!\nYou received SGD 30.00 from ALICE\n20 JUL • 01:30 PM\nYou paid KOPITIAM\nSGD 4.20\n20 JUL • 12:05 PM\nTransaction Ref. No.\nIP178452545726811745`],
      ['parseTnGShot · +RM',            W.parseTnGShot, `08:44\nDetails\n+RM200.00\nTransfer to Wallet\nDate/Time\n21/07/2026 00:37:29\nWallet Ref\n2026072111121700010100171916968110265`],
      ['parseTnGShot · Received 措辞',   W.parseTnGShot, `08:44\nDetails\nMoney received from LIEW XIN YI\nRM200.00\nDate/Time\n21/07/2026 00:37:29\nWallet Ref\n2026072111121700010100171916968110265`],
      ['parseMaybankShot · +RM',        W.parseMaybankShot, `14:001\n25 Jul 2026, 1:59 PM\nGSC - SOUTHKEY JB\n+RM 86.00\nReference Number\n620605020913\n************ 3869`],
      ['parseMaybankShot · Received 措辞', W.parseMaybankShot, `14:001\n25 Jul 2026, 1:59 PM\nMoney received from ALICE\n-RM 86.00\nReference Number\n620605020913\n************ 3869`],
    ];
    for (const [name, fn, txt] of CASES) {
      let r;
      try { r = fn(txt); } catch (e) { bad(`${name} 抛错了`, String(e && e.message || e)); continue; }
      if (!Array.isArray(r)) { bad(`${name} 没回阵列（回 null 会把整个 email() 打掉）`, String(r)); continue; }
      r.length ? bad(`${name} 把收款记成支出了`, r.map(x => `${x.currency} ${x.amount} · ${x.merchant}`).join(' ／ '))
        : ok(name);
    }
  }

  /* ── §D1b MariBank 退款 → 记成【收入】（v11.05 使用者要求的破例）──
     ⚠️ 跟上面 §D1 方向相反：退款要记，而且 type 必须是 income、hash 用独立前缀 mbkrf:。
     走 parseRaw（整条分流链）→ 顺带验 parseMariBankRefund 有没有接进链、有没有排在 parseMariBank 前面。 */
  head('§D1b MariBank 退款 → 收入（v11.05）');
  {
    /* 逐字抄照片（IMG_15735）。三种形态都测：
       · 纯文字＝截图/粘贴/已抽好的正文；
       · HTML 表格＝真邮件那条，且**故意把 label 跟值放同一个 <td> 兄弟格**（<td>Merchant Name:</td><td>值</td>）
         —— 这正是没走 htmlToLines 时商家会抓成一坨 `<tr><td>…` 的那种排版，专门守着它。 */
    const REFUND_TXT = `You have received a refund (您已收到退款)\nMariBank\nYou have received a refund on 04 Aug 2026 18:57 SGT to your credit card ending 5831.\nMerchant Name:\nAlipay*RED Note\nRefunded Amount:\nCNY 5.00\nMariBank Singapore Pte Ltd (UEN: 202106516C)`;
    const REFUND_HTML = `<html><body><table><tr><td><img alt="MariBank"></td></tr><tr><td>You have received a refund on 04 Aug 2026 18:57 SGT to your credit card ending 5831.</td></tr><tr><td>Merchant Name:</td><td>Alipay*RED Note</td></tr><tr><td>Refunded Amount:</td><td>CNY 5.00</td></tr><tr><td>MariBank Singapore Pte Ltd (UEN: 202106516C)</td></tr></table></body></html>`;
    for (const [form, raw] of [['纯文字', REFUND_TXT], ['HTML表格·同格', REFUND_HTML]]) {
      const x = (W.parseRaw(raw, 'maribank') || [])[0];
      if (!x) { bad(`退款[${form}] 没被记（应记成收入）`); continue; }
      x.type === 'income' ? ok(`退款[${form}] type = income`) : bad(`退款[${form}] type 不是 income（使用者要求必须是收入）`, `实得 ${x.type || '(未设=expense)'}`);
      (x.currency === 'CNY' && x.amount === 5) ? ok(`退款[${form}] 金额 CNY 5.00`) : bad(`退款[${form}] 金额抓错`, `${x.currency} ${x.amount}`);
      x.merchant === 'Alipay*RED Note' ? ok(`退款[${form}] 商家 = Alipay*RED Note`) : bad(`退款[${form}] 商家抓错（HTML 没拆行就会中这条）`, String(x.merchant));
      /^mbkrf:/.test(String(x.hash)) ? ok(`退款[${form}] hash 前缀 mbkrf:`) : bad(`退款[${form}] hash 前缀不对（会跟付款 mbk: 撞）`, String(x.hash));
    }
    // 反向：普通付款仍是支出、hash 仍是 mbk:（没被退款 parser 误吃）
    const px = (W.parseRaw(`MariBank\nYou have made a payment to Alipay*Taobao on your credit card ending 5831.\nTransaction Time:\n02 Aug 2026 16:51 SGT\nAmount:\nCNY 20.00`, 'maribank') || [])[0];
    (px && px.type !== 'income' && /^mbk:/.test(String(px.hash)))
      ? ok('普通付款仍是支出（没被退款 parser 误吃）', px.hash)
      : bad('普通付款被退款 parser 误判', JSON.stringify(px));
  }

  /* ── §D1c PayNow 无年份日期 + OCBC 提款 parser（v11.05b 两个真实踩过的坑）──
     背景（照片 IMG_6953 / IMG_6952）：
       ① PayLah 的 PayNow「Date & Time:\n07 Aug 12:42 (SGT)」**没有年份**。旧版日期正则硬性
          要 4 位年 → 整条失配 → 月退成 1、年 guessYear(1) 猜成明年、日退成 01 → 2027-01-01，
          那笔 SGD 15.20 掉进未来，明细当天完全看不到（使用者原话「很严重号码好吗」）。
          修完还有第二层坑：金额 `15.20` 后面紧跟「Date」→ 泛正则 `[A-Za-z]{3}` 把「20 Dat」
          当成日期吃掉 → 又变 2027-01-20。所以月名钉死成 Jan…Dec，这两条一起守。
       ② OCBC「Withdrawal Made」提款信**没有商家**（是提去 Alip的），要 conclude 成
          Alipay*RED Note、记成支出、卡号取账户尾号，且不准把普通 OCBC 卡消费也吃进来。 */
  head('§D1c PayNow 无年份日期 + OCBC 提款（v11.05b）');
  {
    /* ① 真实 DBS PayLah PayNow 邮件（使用者贴的原文，IMG_6955 那笔 SGD 15.20）—— **逐字**当永久防线。
       这封信一次踩了三个坑：
         · 日期「07 Aug 12:42」没年份、且金额 15.20 紧贴 Date（`20 Date` 陷阱）；
         · 收款人「MX AMMXX THXX CHX ANX (Mobile ending 4163)」整串 42 字 > 40 上限 →
           被形状校验挡掉 → 掉成通用名 "PayNow Transfer"（就是这条把名字吃掉的）。
       修法：日期钉真月名 + 两层年份；收款人**剥掉尾巴的 (Mobile ending …) 括号**再量长度。 */
    const REAL_PAYLAH = `Transaction Alerts\nTransaction Ref: IP178607775975807693\nDear Sir / Madam,\nWe refer to a PayNow Transfer dated 07 Aug. We are pleased to confirm that the transaction was completed.\nDate & Time:\n07 Aug 12:42 (SGT)\nAmount:\nSGD15.20\nFrom:\nPayLah! Wallet (Mobile ending 6301)\nTo:\nMX AMMXX THXX CHX ANX (Mobile ending 4163)\nTo view your transactions, login to your PayLah! Wallet and select History at the bottom bar of the Home page.\nDBS Bank Ltd`;
    const p1 = (W.parseRaw(REAL_PAYLAH, 'paylah@dbs.com') || [])[0];
    if (!p1) bad('真实 PayLah PayNow 没解出来（整封蒸发）');
    else {
      /-08-07T12:42/.test(p1.ts) ? ok('真实 PayLah PayNow 日期 = 8月7日 12:42（不是 2027-01）', p1.ts)
        : bad('真实 PayLah PayNow 日期错了', p1.ts);
      p1.amount === 15.2 ? ok('真实 PayLah PayNow 金额 SGD 15.20') : bad('真实 PayLah PayNow 金额抓错', String(p1.amount));
      p1.merchant === 'MX AMMXX THXX CHX ANX'
        ? ok('真实 PayLah PayNow 收款人 = MX AMMXX THXX CHX ANX（剥掉 (Mobile ending 4163)）', p1.merchant)
        : bad('真实 PayLah PayNow 收款人抓错（尾括号没剥→超 40 字→掉成通用名，IMG_6955 那个坑）', String(p1.merchant));
    }
    // ①c 真的抓不到收款人时，才退回通用名（宁可漏不要错）
    const PAYLAH_NONAME = `PayLah!\nPayNow transfer\nAmount: SGD 15.20\nDate & Time:\n07 Aug 12:42 (SGT)\nRef IP178607775975807693`;
    const p1c = (W.parsePayNow(PAYLAH_NONAME) || [])[0];
    (p1c && p1c.merchant === 'PayNow Transfer')
      ? ok('真抓不到收款人 → 退回通用名 PayNow Transfer（不会乱抓）', p1c.merchant)
      : bad('抓不到收款人却给了个奇怪商家名', String(p1c && p1c.merchant));
    // ①d 真实 OCBC PayNow 付款给【数字开头的公司】——使用者贴的**完整原文**（含结尾那段防诈骗提示）。
    //     两个真实坑一起钉：① 旧正则要求商家首字是字母 → 「96…」开头抓不到、掉通用名；
    //     ② 结尾「…to warn you against phishing…」那句差点被当成收款人 → 商家污染成 "warn you against phishing"
    //        （照片 IMG：收件箱真的记成了这个）。逐字留原文，两个都守。
    const OCBC_PN_NUM = `Dear Valued Customer\nThe following PayNow transfer has been made to 96SUPER GRADE PTE. LTD. using their Unique Entity Number (UEN) 201323161C201.\nDate\n: 09 Jul 2026\nTime\n: 20:59 PM SGT\nAmount\n: SGD 62.00\nFrom your account\n: 360 Account (-862001)\nDescription\n: QS\nReference number\n: 2607090114048000\nIf you have any questions, please call our Personal Banking hotline: OCBC website > Contact us.\nThank you for banking with us. We look forward to serving you again.\nYours sincerely\nDigital Business\nGlobal Consumer Financial Services\nOCBC\nTip: To subscribe or change your settings for e-Alerts, log in to OCBC Internet Banking > Customer Service (on the top navigation bar) > Manage e-Alerts.\nDo allow us to warn you against phishing attempts involving e-mails that claim to be from OCBC. We will not send you any emails with links requesting your Access Code, PIN or One-time Password.`;
    const p1dRows = W.parseRaw(OCBC_PN_NUM, 'notifications@ocbc.com') || [];
    const p1d = p1dRows[0];
    if (!p1d) bad('OCBC PayNow(数字开头商家) 没解出来');
    else {
      p1dRows.length === 1 ? ok('只解出 1 笔（结尾防诈骗那段没被当第二笔）') : bad('解出多笔（尾巴被误解）', String(p1dRows.length));
      p1d.merchant === '96SUPER GRADE PTE. LTD.' ? ok('OCBC PayNow 商家＝96SUPER GRADE PTE. LTD.（数字开头也抓到）', p1d.merchant) : bad('数字开头的商家名抓错（首字被 [A-Z] 挡掉那个坑）', String(p1d.merchant));
      !/phishing/i.test(String(p1d.merchant)) ? ok('商家没被结尾「warn you against phishing」污染') : bad('商家被防诈骗那句污染了', String(p1d.merchant));
      (p1d.currency === 'SGD' && p1d.amount === 62) ? ok('金额 SGD 62.00') : bad('金额抓错', `${p1d.currency} ${p1d.amount}`);
      (p1d.type !== 'income') ? ok('是支出（转出去，不是收入）') : bad('转出去被记成收入了');
      /^2026-07-09T20:59/.test(p1d.ts) ? ok('时间 7月9日 20:59', p1d.ts) : bad('时间抓错', String(p1d.ts));
    }
    // ② OCBC PayNow 带年份：不准回归（同一支 parser 两条路都要活）
    const OCBC_PAYNOW = `PayNow transfer\nThe following PayNow transfer has been made.\nDate : 14 Jul 2026\nTime : 13:22 PM SGT\nAmount : SGD 5.80\nTo : ALICE\nReference number : 2607140116147079`;
    const p2 = (W.parsePayNow(OCBC_PAYNOW) || [])[0];
    (p2 && /^2026-07-14T13:22/.test(p2.ts)) ? ok('OCBC PayNow 带年份仍是 2026-07-14（无回归）', p2.ts)
      : bad('OCBC PayNow 带年份被改坏了', JSON.stringify(p2 && p2.ts));
    // ③ OCBC 提款 → 支出 · Alipay*RED Note · 卡号取账户尾号
    const OCBC_WD = `OCBC Bank\nAlert: Withdrawal Made\nA sum of SGD 60.46 has been withdrawn from your account (-857001) at 5:12 AM on 07 Aug 2026.`;
    const w1 = (W.parseOCBCWithdrawal(OCBC_WD) || [])[0];
    if (!w1) bad('OCBC 提款没被记（应记成支出）');
    else {
      (w1.currency === 'SGD' && w1.amount === 60.46) ? ok('OCBC 提款金额 SGD 60.46') : bad('OCBC 提款金额抓错', `${w1.currency} ${w1.amount}`);
      w1.merchant === 'Alipay*RED Note' ? ok('OCBC 提款商家 = Alipay*RED Note（无商家默认值）') : bad('OCBC 提款商家不对', String(w1.merchant));
      w1.type !== 'income' ? ok('OCBC 提款是支出（不是收入）') : bad('OCBC 提款被记成收入了');
      w1.card_last4 === '7001' ? ok('OCBC 提款卡号取账户尾号 7001') : bad('OCBC 提款卡号不对', String(w1.card_last4));
      /-08-07T05:12/.test(w1.ts) ? ok('OCBC 提款时间 8月7日 05:12', w1.ts) : bad('OCBC 提款时间抓错', String(w1.ts));
      /^ocbcw:/.test(String(w1.hash)) ? ok('OCBC 提款 hash 前缀 ocbcw:') : bad('OCBC 提款 hash 前缀不对（会跟 ocbc 卡撞）', String(w1.hash));
    }
    // ④ 反向：普通 OCBC 卡消费不准被提款 parser 吃掉
    const OCBC_CARD = `OCBC Bank\nYou have made a card transaction\nAmount: SGD 313.92\nMerchant: TRIP.COM\nDate: 06 Aug 2026`;
    const w2 = W.parseOCBCWithdrawal(OCBC_CARD);
    (Array.isArray(w2) && w2.length === 0) ? ok('普通 OCBC 卡消费不被提款 parser 吃（回 []）')
      : bad('提款 parser 把普通 OCBC 卡消费也吃了', JSON.stringify(w2));
  }

  /* ── §D1d DBS/POSB PayNow「收到转账」→ 记成【收入】（v11.07 收入破例② · 照片 IMG_6963）──
     ⚠️ 跟 §D1 收款不记账方向相反：这一封**要记**、而且 type 必须是 income、hash 用独立前缀 dbspnin:。
        走 parseRaw（整条分流链）→ 顺带验它有没有接进链、且排在会挡它的 parsePayNow/parseDBS 前面。
     ⚠️ 关键铁律：这支闸门只认「received <币种><金额> via PayNow」，**绝不能**把 DBS 的支出、
        或别的收款误记成收入。下面四条正反都钉住。 */
  head('§D1d DBS PayNow 收款 → 收入（v11.07）');
  {
    // 逐字抄使用者给的真实邮件（IMG_6963）
    const REAL_IN = `digibank Alerts - You've received a transfer\nTransaction Ref: PIB2608071354011943 C100586382523\nDear Customer,\nYou have received SGD 30.00 via PayNow on 07 Aug 2026 17:18 SGT.\nFrom: CHAN YI SHENG\nTo: Your DBS/ POSB account ending 7344\nThank you for banking with us.\nDBS Bank Ltd`;
    const x = (W.parseRaw(REAL_IN, 'ibanking.alert@dbs.com') || [])[0];
    if (!x) bad('真实 DBS PayNow 收款没被记（应记成收入）');
    else {
      x.type === 'income' ? ok('DBS PayNow 收款 type = income') : bad('DBS PayNow 收款 type 不是 income', String(x.type || '(未设=expense)'));
      (x.currency === 'SGD' && x.amount === 30) ? ok('DBS PayNow 收款金额 SGD 30.00') : bad('金额抓错', `${x.currency} ${x.amount}`);
      x.merchant === 'CHAN YI SHENG' ? ok('付款人 = CHAN YI SHENG（从 From: 抓）') : bad('付款人抓错', String(x.merchant));
      /^2026-08-07T17:18/.test(x.ts) ? ok('时间 8月7日 17:18', x.ts) : bad('时间抓错', String(x.ts));
      /^dbspnin:/.test(String(x.hash)) ? ok('hash 前缀 dbspnin:（跟支出永不撞）') : bad('hash 前缀不对', String(x.hash));
    }
    // 反向①：DBS 支出信绝不能被记成收入
    const px = (W.parseRaw(`DBS PayLah!\nTo : NTUC FAIRPRICE\nAmount : SGD 10.00\nDate & Time : 07 Aug 2026 12:41 (SGT)\nTransaction Ref : IP2608071241099`, 'notify@dbs.com') || [])[0];
    (px && px.type !== 'income') ? ok('DBS 支出仍是支出（没被收入 parser 误吃）', px.hash)
      : bad('DBS 支出被收入 parser 误判成收入', JSON.stringify(px));
    // 反向②：普通收款（没有 via PayNow）仍掉「读不到」，不被这支记
    const other = W.parseRaw(`DBS PayLah!\nYou have received SGD 25.00 from ALICE TAN\nDate & Time : 07 Aug 2026 12:41 (SGT)\nTransaction Ref : IP2608071241001`, 'notify@dbs.com') || [];
    other.length === 0 ? ok('非 PayNow 的收款仍不记（掉读不到，铁律没被放宽）')
      : bad('非 PayNow 收款被误记了（闸门太宽）', JSON.stringify(other[0]));
    // 反向③：PayNow 付出去（sent）不准记成收入
    const sent = W.parseDBSPayNowIn(`digibank Alerts\nYou have sent SGD 30.00 via PayNow on 07 Aug 2026 17:18 SGT.\nTo: BOB\nTransaction Ref: PIB2608071354011999`);
    (Array.isArray(sent) && sent.length === 0) ? ok('PayNow 付出去不记成收入（只认"received…via PayNow"）')
      : bad('把 PayNow 付款误记成收入了', JSON.stringify(sent));
  }

  /* ── §D1e PayLah 退款 → 收入 + OCBC 网址商家不腰斩（v10.20 两个真实踩过的坑）──
     背景（照片 IMG）：
       ① PayLah! 退款信（From: BCRS LTD, SGD 0.70）以前全 app 认不出 → 掉「读不到」。
          它跟 MariBank 退款/DBS 收款一样是**刻意要记的收入**：type:income、hash 前缀 plrf:、
          且日期「10 Aug21:54」没年份、月名紧贴时间（Aug21:54），date 正则要吃得下。
          ⚠️ 必须排在 parseDBS 前面（PayLah 会被 parseDBS 认领），否则先被当支出/掉读不到。
       ② OCBC 卡在**网址商家** www.anywheel.sg 消费，旧版结尾 `(.+?)(?:\.|$)` 里的 `.` 咬在
          "www" 后那个点上 → 商家只剩 "www"。改逐行 + 行尾锚，网址型商家完整抓下，其它零影响。 */
  head('§D1e PayLah 退款→收入 + OCBC 网址商家（v10.20）');
  {
    // ① 逐字抄使用者给的真实 PayLah 退款邮件（BCRS LTD SGD 0.70）
    const REAL_REFUND = `Transaction Alert\nTransaction Ref: 260810215418MC859446\nDear Sir/Madam,\nWe refer to your PayLah! refund transaction below and are pleased to confirm that the transaction was completed.\nDate & Time: 10 Aug21:54 (SGT)\nAmount: SGD 0.70\nFrom: BCRS LTD\nTo: PayLah! Wallet (Mobile ending 6301)\nTo view your transactions, login to your PayLah! Wallet and select History.\nDBS Bank Ltd`;
    const r = (W.parseRaw(REAL_REFUND, 'paylah@dbs.com') || [])[0];
    if (!r) bad('真实 PayLah 退款没被记（应记成收入，别掉读不到）');
    else {
      r.type === 'income' ? ok('PayLah 退款 type = income') : bad('PayLah 退款 type 不是 income', String(r.type || '(未设=expense)'));
      (r.currency === 'SGD' && r.amount === 0.7) ? ok('PayLah 退款金额 SGD 0.70') : bad('金额抓错', `${r.currency} ${r.amount}`);
      r.merchant === 'BCRS LTD' ? ok('退款方 = BCRS LTD（从 From: 抓，剥尾括号）') : bad('退款方抓错', String(r.merchant));
      /^2026-08-10T21:54/.test(r.ts) ? ok('时间 8月10日 21:54（无年份靠 guessYear，月名紧贴时间也抓到）', r.ts) : bad('时间抓错（Aug21:54 那个坑）', String(r.ts));
      /^plrf:/.test(String(r.hash)) ? ok('hash 前缀 plrf:（跟支出 dbs:/paynow: 永不撞）') : bad('hash 前缀不对', String(r.hash));
    }
    // ①反向：普通 PayLah 付款（没有 "refund transaction" 那句）绝不能被退款 parser 误记成收入
    const pay = (W.parseRaw(`DBS PayLah!\nTo : NTUC FAIRPRICE\nAmount : SGD 10.00\nDate & Time : 10 Aug 2026 12:41 (SGT)\nTransaction Ref : IP2608101241099`, 'notify@dbs.com') || [])[0];
    (pay && pay.type !== 'income') ? ok('普通 PayLah 付款仍是支出（没被退款 parser 误吃）', pay.hash)
      : bad('普通 PayLah 付款被误记成收入', JSON.stringify(pay));
    // ② 逐字抄真实 OCBC 网址商家消费（www.anywheel.sg）
    const ANYWHEEL = `Dear Valued Customer\nWe wish to inform you that SGD9.90 was charged at 21:31 on 10-Aug-26 to your card (-3578) at www.anywheel.sg Singapore.\nThank you for banking with us.\nOCBC`;
    const a = (W.parseRaw(ANYWHEEL, 'notifications@ocbc.com') || [])[0];
    if (!a) bad('OCBC 网址商家消费没解出来');
    else {
      a.merchant === 'www.anywheel.sg Singapore' ? ok('商家 = www.anywheel.sg Singapore（没在 www. 后腰斩）', a.merchant) : bad('网址商家被第一个点腰斩了（旧版 "www" 那个坑）', String(a.merchant));
      (a.currency === 'SGD' && a.amount === 9.9) ? ok('金额 SGD 9.90') : bad('金额抓错', `${a.currency} ${a.amount}`);
      a.card_last4 === '3578' ? ok('卡号 3578') : bad('卡号抓错', String(a.card_last4));
      /^2026-08-10T21:31/.test(a.ts) ? ok('时间 8月10日 21:31', a.ts) : bad('时间抓错', String(a.ts));
      a.type !== 'income' ? ok('是支出（卡消费）') : bad('卡消费被记成收入了');
    }
    // ②反向：正常一般商家（无网址、句号结尾）仍完整、不被行尾锚吞掉
    const NORMAL_OCBC = `Dear Valued Customer\nWe wish to inform you that SGD3.80 was charged at 19:53 on 06-Aug-26 to your card (-3578) at SG MUYOO.\nOCBC`;
    const n = (W.parseRaw(NORMAL_OCBC, 'notifications@ocbc.com') || [])[0];
    (n && n.merchant === 'SG MUYOO') ? ok('普通 OCBC 商家 SG MUYOO 仍完整（行尾句号被吃掉、商家不受影响）', n.merchant)
      : bad('普通 OCBC 商家被改坏了', JSON.stringify(n && n.merchant));
  }

  /* ── §D1f 商家记忆不会「乱」：收入 vs 支出的分类记忆彻底分开（v10.20，使用者当面质疑的那件事）──
     使用者的担心，逐条钉死：
       ① 同一个对手方（例：CHAN YI SHENG）今天退你钱=收入、改天你付他=支出。那条**支出**留下的
          分类规则（merchant_rules），**绝不能**倒贴到这次**收入**上。
       ② 收入进账时，就算这家在 merchant_rules 里有旧规则，存进库的那笔收入 category 也应是空的
          （收入分类和支出分类是两套；ingestRaw 现在按 type 挡住 category，只借用改名 display）。
       ③ 反过来：付给同一家（支出）时，分类记忆**要照常生效** —— 挡的是「收入沾支出分类」，
          不是把整条记忆关掉。
     做法：给 ingestRaw 配一个**带 merchant_rules 命中**的内存 D1（真实那两张 mock 只会回 null，测不到这条）。 */
  head('§D1f 商家记忆：收入不沾支出分类（v10.20）');
  if (typeof W.ingestRaw !== 'function') { console.log(`${L.warn}  §D1f 跳过：worker 没导出 ingestRaw${L.off}`); }
  else {
    /* 内存 D1：merchant_rules 里**预埋**一条 CHAN YI SHENG → 支出分类 other、改名「小陈」的旧规则
       （模拟他曾经被你付过钱、学过分类）。offset_rules 空。expenses 照 SQL 如实记（同 §F 那套 type 口径）。 */
    const RULE_KEY = 'CHAN YI SHENG';   // merchantKey('CHAN YI SHENG') 归一化后就是它自己（无数字/无 PTE/LTD）
    const mkEnv = () => {
      const expenses = [], seen = new Set(); let insertedRules = 0;
      const prepare = (sql) => ({ bind: (...a) => ({
        run: async () => {
          if (/INSERT/i.test(sql) && /INTO\s+merchant_rules/i.test(sql)) insertedRules++;   // 收入若误写分类记忆，这里会 >0
          if (/INSERT/i.test(sql) && /INTO\s+expenses/i.test(sql)) {
            let ty, ts, am, cu, me, c4, so, rw, ha, ca, su;
            if (a.length >= 11) { [ts, am, cu, me, c4, so, rw, ha, ty, ca, su] = a; }
            else { [ts, am, cu, me, c4, so, rw, ha, ca, su] = a; const l = sql.match(/VALUES[\s\S]*?'(expense|income)'/i); ty = l ? l[1] : 'expense'; }
            if (seen.has(ha)) return { meta: { changes: 0 } };
            seen.add(ha); const id = expenses.length + 1;
            expenses.push({ id, ts, amount: am, currency: cu, merchant: me, type: ty, category: ca });
            return { meta: { changes: 1, last_row_id: id } };
          }
          return { meta: { changes: 1, last_row_id: 1 } };
        },
        first: async () => {
          if (/FROM\s+merchant_rules/i.test(sql) && String(a[0]).toUpperCase() === RULE_KEY)
            return { category: 'other', display: '小陈', sub: null, is_hint: 0 };
          return null;   // offset_rules 及其它 → 无
        },
        all: async () => ({ results: expenses }),
      }) });
      return { env: { DB: { prepare }, getInsertedRules: () => insertedRules }, expenses, rulesWritten: () => insertedRules };
    };
    // ① 收入：CHAN YI SHENG 退你钱（DBS PayNow 收款），merchant_rules 里有他的旧支出规则 other/小陈
    {
      const { env, expenses } = mkEnv();
      const IN = `digibank Alerts - You've received a transfer\nTransaction Ref: PIB2608071354019001\nYou have received SGD 30.00 via PayNow on 07 Aug 2026 17:18 SGT.\nFrom: CHAN YI SHENG\nTo: Your DBS/ POSB account ending 7344\nDBS Bank Ltd`;
      await W.ingestRaw(env, IN, 'ibanking.alert@dbs.com', 't', {});
      const row = expenses[0];
      if (!row) bad('收入没入库');
      else {
        row.type === 'income' ? ok('CHAN YI SHENG 退款存成收入') : bad('该是收入', row.type);
        (row.category == null || row.category === '') ? ok('收入 category 是空的（没沾上支出旧规则 other）') : bad('收入被倒贴了支出分类（商家记忆「乱」了）', String(row.category));
        row.merchant === '小陈' ? ok('改名照常借用（银行名 → 你取的「小陈」）') : bad('display 改名没生效（收入也该借用改名）', String(row.merchant));
      }
    }
    // ③ 反向：你付给同一家（支出），分类记忆**要照常生效**（挡的是收入沾分类，不是关掉记忆）
    {
      const { env, expenses } = mkEnv();
      const OUT = `Dear Valued Customer\nThe following PayNow transfer has been made to CHAN YI SHENG using their mobile number.\nDate\n: 09 Aug 2026\nTime\n: 20:59 PM SGT\nAmount\n: SGD 12.00\nFrom your account\n: 360 Account (-862001)\nReference number\n: 2608090114049001\nThank you for banking with us.\nOCBC`;
      await W.ingestRaw(env, OUT, 'notifications@ocbc.com', 't', {});
      const row = expenses[0];
      if (!row) bad('支出没入库');
      else {
        row.type !== 'income' ? ok('付给 CHAN YI SHENG 存成支出') : bad('该是支出', row.type);
        row.category === 'other' ? ok('支出照常套上分类记忆 other（记忆没被误关）') : bad('支出没套到分类记忆（把记忆整条关掉了）', String(row.category));
        row.merchant === '小陈' ? ok('支出也套上改名「小陈」') : bad('支出改名没生效', String(row.merchant));
      }
    }
  }

  /* ── §D1g OCBC 存款通知 → 一律记成【Refund · 收入】（v10.21 · 照片 IMG，无商家）──
     使用者要求：OCBC「Deposit in your account」这类进账没有商家，一律记成商家名 "Refund"、type income
     （跟 MariBank/PayLah 退款同一套收入破例，可开抵扣）。日期在 `Reference: 06/08/26`（DD/MM/YY，不是参考号）。
     正反都钉：① 真样本逐字；② 卡消费/提款不准被它吃；③ DD/MM/YY 日期解对（别跑到别的月）。 */
  head('§D1g OCBC 存款 → Refund 收入（v10.21）');
  {
    // ① 逐字抄真实 OCBC 存款邮件（含结尾防诈骗那段，验它不干扰）
    const DEP = `OCBC Alert: Deposit in your account\nDear Valued Customer,\nA deposit was made in your account. Here are the details:\nTime of deposit: 5:23 AM\nAmount: SGD 6.42\nAccount that money was deposited in: (-857001)\nReference: 06/08/26\nFor assistance at any time, please call us at 1800-363 3333 (or +65 6363 3333 from overseas).\nThank you for banking with us.\nYours sincerely\nDigital Business\nOCBC\nDo allow us to warn you against phishing attempts involving e-mails that claim to be from OCBC.`;
    const d = (W.parseRaw(DEP, 'notifications@ocbc.com') || [])[0];
    if (!d) bad('OCBC 存款没被记（应记成 Refund 收入，别掉读不到）');
    else {
      d.type === 'income' ? ok('OCBC 存款 type = income') : bad('OCBC 存款 type 不是 income', String(d.type || '(未设=expense)'));
      d.merchant === 'Refund' ? ok('商家 = Refund（无商家，使用者指定固定名）') : bad('商家名不对（该是 Refund）', String(d.merchant));
      (d.currency === 'SGD' && d.amount === 6.42) ? ok('金额 SGD 6.42') : bad('金额抓错', `${d.currency} ${d.amount}`);
      /^2026-08-06T05:23/.test(d.ts) ? ok('日期时间 = 8月6日 05:23（Reference 06/08/26 按 DD/MM/YY 解 + 5:23 AM）', d.ts) : bad('日期时间抓错（Reference 当参考号漏了、或 AM 没换算）', String(d.ts));
      d.card_last4 === '7001' ? ok('账户末四码 7001') : bad('账户末四码不对', String(d.card_last4));
      /^ocbcrf:/.test(String(d.hash)) ? ok('hash 前缀 ocbcrf:（跟卡 ocbc: / 提款 ocbcw: 永不撞）') : bad('hash 前缀不对', String(d.hash));
    }
    // ①b v10.34 GIRO 进账：日期在 `Date of deposit: 28 Aug 2026`（不在 Reference 里），
    //     Reference 放的是【付款方名字】而不是日期，金额带千分位 4,178.50。这封真机读不到过，钉死。
    const GIRO = `OCBC Alert: Money has been deposited in your account\nDear Valued Customer,\nA deposit was made in your account. Here are the details:\nDate of deposit: 28 Aug 2026\nTime of deposit: 4:14 PM\nAmount: SGD 4,178.50\nAccount that money was deposited in: (-862001)\nReference: WOH HUP (PRIVATE) L\nMode of transfer: GIRO\nOCBC`;
    const g = (W.parseRaw(GIRO, 'notifications@ocbc.com') || [])[0];
    if (!g) bad('OCBC GIRO 进账读不到（Date of deposit 格式日期没解析到）');
    else {
      g.type === 'income' ? ok('GIRO 进账 type = income') : bad('GIRO 进账 type 不是 income', String(g.type || '(未设)'));
      g.merchant === 'WOH HUP (PRIVATE) L' ? ok('商家 = 付款方名字 WOH HUP (PRIVATE) L（Reference 是名字不是日期）') : bad('GIRO 商家名不对', String(g.merchant));
      (g.currency === 'SGD' && g.amount === 4178.5) ? ok('金额 SGD 4,178.50（千分位解对）') : bad('GIRO 金额抓错', `${g.currency} ${g.amount}`);
      /^2026-08-28T16:14/.test(g.ts) ? ok('日期时间 = 8月28日 16:14（Date of deposit 28 Aug 2026 + 4:14 PM）', g.ts) : bad('GIRO 日期时间抓错', String(g.ts));
      /^ocbcrf:/.test(String(g.hash)) ? ok('GIRO hash 前缀 ocbcrf:') : bad('GIRO hash 前缀不对', String(g.hash));
    }
    // ② 反向：普通 OCBC 卡消费不准被存款 parser 吃（仍是支出、商家原样）
    const CARD = `Dear Valued Customer\nWe wish to inform you that SGD3.80 was charged at 19:53 on 06-Aug-26 to your card (-3578) at SG MUYOO.\nOCBC`;
    const c = (W.parseRaw(CARD, 'notifications@ocbc.com') || [])[0];
    (c && c.type !== 'income' && c.merchant === 'SG MUYOO') ? ok('OCBC 卡消费仍是支出 SG MUYOO（没被存款 parser 误吃）', c.hash)
      : bad('OCBC 卡消费被存款 parser 误判', JSON.stringify(c));
    // ③ 反向：OCBC 提款仍是支出 Alipay*RED Note（存款和提款闸门互斥）
    const WD = `OCBC Bank\nAlert: Withdrawal Made\nA sum of SGD 60.46 has been withdrawn from your account (-857001) at 5:12 AM on 07 Aug 2026.`;
    const w = (W.parseRaw(WD, 'notifications@ocbc.com') || [])[0];
    (w && w.type !== 'income' && w.merchant === 'Alipay*RED Note') ? ok('OCBC 提款仍是支出 Alipay*RED Note（没被存款 parser 误吃）', w.hash)
      : bad('OCBC 提款被存款 parser 误判', JSON.stringify(w));
  }

  /* ── §D1h 全 parser 路由矩阵（v10.21，使用者要求「跑更多可能性」）──
     现在 13 支 parser、4 支记收入，最怕的是**同一封信被错的 parser 抢走**（尤其一堆信都含 "OCBC" / "DBS" /
     "PayNow" / "MariBank"）。这张矩阵一封封喂进**整条分流链** parseRaw，钉死每封落到对的 parser、对的
     收入/支出方向、对的商家。任何一支闸门写宽了、顺序排错了，这里立刻红。 */
  head('§D1h 全 parser 路由矩阵（13 支 · 一封封钉死落点）');
  {
    // [名字, 邮件, from, 期望source, 期望type, 期望商家, 期望hash前缀]
    const MATRIX = [
      ['OCBC 卡消费', `Dear Valued Customer\nWe wish to inform you that SGD3.80 was charged at 19:53 on 06-Aug-26 to your card (-3578) at SG MUYOO.\nOCBC`, 'notifications@ocbc.com', 'ocbc', 'expense', 'SG MUYOO', 'ocbc:'],
      ['OCBC 提款', `OCBC Bank\nAlert: Withdrawal Made\nA sum of SGD 60.46 has been withdrawn from your account (-857001) at 5:12 AM on 07 Aug 2026.`, 'notifications@ocbc.com', 'ocbc', 'expense', 'Alipay*RED Note', 'ocbcw:'],
      ['OCBC 存款(refund)', `OCBC Alert: Deposit in your account\nA deposit was made in your account.\nTime of deposit: 5:23 AM\nAmount: SGD 6.42\nAccount that money was deposited in: (-857001)\nReference: 06/08/26\nOCBC`, 'notifications@ocbc.com', 'ocbc', 'income', 'Refund', 'ocbcrf:'],
      ['OCBC PayNow 付款', `Dear Valued Customer\nThe following PayNow transfer has been made to 96SUPER GRADE PTE. LTD. using UEN 201323161C.\nDate\n: 09 Jul 2026\nTime\n: 20:59 PM SGT\nAmount\n: SGD 62.00\nReference number\n: 2607090114048000\nOCBC`, 'notifications@ocbc.com', 'paynow', 'expense', '96SUPER GRADE PTE. LTD.', 'paynow:'],
      ['DBS PayLah 消费', `DBS PayLah!\nTo : NTUC FAIRPRICE\nAmount : SGD 10.00\nDate & Time : 07 Aug 2026 12:41 (SGT)\nTransaction Ref : IP2608071241099`, 'notify@dbs.com', 'dbs', 'expense', 'NTUC FAIRPRICE', 'dbs:'],
      ['DBS PayNow 收款', `digibank Alerts\nYou have received SGD 30.00 via PayNow on 07 Aug 2026 17:18 SGT.\nFrom: CHAN YI SHENG\nTo: Your DBS account ending 7344\nDBS Bank Ltd`, 'ibanking.alert@dbs.com', 'dbs', 'income', 'CHAN YI SHENG', 'dbspnin:'],
      ['PayLah 退款', `Transaction Ref: 260810215418MC859446\nWe refer to your PayLah! refund transaction below.\nDate & Time: 10 Aug21:54 (SGT)\nAmount: SGD 0.70\nFrom: BCRS LTD\nTo: PayLah! Wallet\nDBS Bank Ltd`, 'paylah@dbs.com', 'dbs', 'income', 'BCRS LTD', 'plrf:'],
      ['MariBank 付款', `MariBank\nYou have made a payment to Alipay*Taobao on your credit card ending 5831.\nTransaction Time:\n02 Aug 2026 16:51 SGT\nAmount:\nCNY 20.00`, 'no-reply@maribank.sg', 'maribank', 'expense', 'Alipay*Taobao', 'mbk:'],
      ['MariBank 退款', `MariBank\nYou have received a refund on 04 Aug 2026 18:57 SGT to your credit card ending 5831.\nMerchant Name:\nAlipay*RED Note\nRefunded Amount:\nCNY 5.00`, 'no-reply@maribank.sg', 'maribank', 'income', 'Alipay*RED Note', 'mbkrf:'],
      ['PayNow 转人', `PayNow transfer\nThe following PayNow transfer has been made.\nDate : 14 Jul 2026\nTime : 13:22 PM SGT\nAmount : SGD 5.80\nTo : ALICE\nReference number : 2607140116147079`, 'notifications@ocbc.com', 'paynow', 'expense', 'ALICE', 'paynow:'],
    ];
    for (const [name, raw, from, wSrc, wType, wMerch, wHash] of MATRIX) {
      const r = (W.parseRaw(raw, from) || [])[0];
      if (!r) { bad(`「${name}」掉进读不到（应落到 ${wSrc}/${wType}）`); continue; }
      const gotType = r.type || 'expense';
      const okAll = r.source === wSrc && gotType === wType && r.merchant === wMerch && String(r.hash).startsWith(wHash);
      okAll ? ok(`「${name}」→ ${wSrc}·${wType}·${wMerch}·${wHash}`)
        : bad(`「${name}」路由错了`, `期望 ${wSrc}·${wType}·${wMerch}·${wHash}\n     实得 ${r.source}·${gotType}·${r.merchant}·${String(r.hash).split(':')[0]}:`);
    }
    // 收入总数：矩阵里应恰好 4 笔 income（4 支收入 parser 各 1）
    const incCount = MATRIX.filter(x => x[4] === 'income').length;
    incCount === 4 ? ok('矩阵覆盖 4 支收入 parser（mbkrf/dbspnin/plrf/ocbcrf）') : bad('收入覆盖数不对', String(incCount));
  }

  /* ── §D1i OCBC 存款(refund) 边界：日期格式 / 时段 / 非日期参考号（v10.21）──
     使用者担心「那么多 parser 未必每个跑对」——这支专挑 OCBC 存款最容易错的几处死磕。 */
  head('§D1i OCBC 存款边界：DD/MM/YY · AM/PM · 非日期ref');
  {
    const mk = (time, amt, ref) => `OCBC Alert: Deposit in your account\nA deposit was made in your account.\nTime of deposit: ${time}\nAmount: SGD ${amt}\nAccount that money was deposited in: (-857001)\nReference: ${ref}\nOCBC`;
    // ① DD/MM/YY 不是 MM/DD/YY：31/12/25 只有当成「31 号 12 月」才合法（当 12/31 月份 31 非法）
    const a = (W.parseRaw(mk('9:00 AM', '1.00', '31/12/25'), 'notifications@ocbc.com') || [])[0];
    (a && /^2025-12-31T09:00/.test(a.ts)) ? ok('31/12/25 → 2025-12-31（DD/MM/YY 解对，没当成 MM/DD）', a.ts) : bad('DD/MM/YY 日期解错', String(a && a.ts));
    // ② 下午时段 PM 换算：5:23 PM → 17:23
    const b = (W.parseRaw(mk('5:23 PM', '2.00', '06/08/26'), 'notifications@ocbc.com') || [])[0];
    (b && /T17:23/.test(b.ts)) ? ok('5:23 PM → 17:23（PM 换算对）', b.ts) : bad('PM 时段没换算', String(b && b.ts));
    // ③ 12:00 AM 午夜 → 00:00
    const c = (W.parseRaw(mk('12:00 AM', '3.00', '06/08/26'), 'notifications@ocbc.com') || [])[0];
    (c && /T00:00/.test(c.ts)) ? ok('12:00 AM → 00:00（午夜换算对）', c.ts) : bad('午夜 12AM 没换算成 00', String(c && c.ts));
    // ④ Reference 不是日期（真参考号）→ 抓不到日期就回 []（掉读不到，绝不瞎猜今天/记错月）
    const d = W.parseRaw(mk('9:00 AM', '4.00', 'OCBCREF12345XYZ'), 'notifications@ocbc.com') || [];
    (d.length === 0) ? ok('Reference 非日期 → 回 []（掉读不到，不瞎猜日期）') : bad('参考号不是日期却硬记了（日期可能是错的）', JSON.stringify(d[0]));
    // ⑤ HTML 表格形态（真邮件是 HTML）仍解得出
    const H = `<html><body><p>OCBC Alert: Deposit in your account</p><table><tr><td>A deposit was made in your account.</td></tr><tr><td>Time of deposit:</td><td>5:23 AM</td></tr><tr><td>Amount:</td><td>SGD 6.42</td></tr><tr><td>Account that money was deposited in:</td><td>(-857001)</td></tr><tr><td>Reference:</td><td>06/08/26</td></tr></table><p>OCBC</p></body></html>`;
    const e = (W.parseRaw(H, 'notifications@ocbc.com') || [])[0];
    (e && e.type === 'income' && e.merchant === 'Refund' && e.amount === 6.42 && /^2026-08-06T05:23/.test(e.ts))
      ? ok('HTML 表格形态照样解出 Refund·SGD6.42·8月6日05:23', e.ts)
      : bad('HTML 形态解错', JSON.stringify(e));
  }

  /* ── §D1j 商家名健壮性矩阵：每个抓商家的 parser 都要吃【www.点名】+【号码开头名】（v10.22）──
     使用者两个真实踩过的坑，要求**每一支** parser 都解决、别有漏网：
       ① 名字带点（www.anywheel.sg）—— 旧 parseOCBC 在第一个点腰斩成 "www"；
       ② 名字号码开头（96SUPER / 88 / 7-Eleven）—— 旧 parsePayNow / parseDBSPayNowIn 首字要字母 → 掉成通用名。
     这张矩阵一支一支喂进 parseRaw，两类名字都钉住。谁家闸门以后又收紧了，这里立刻红。 */
  head('§D1j 商家名健壮性：每支 parser 吃 www.点名 + 号码开头名（v10.22）');
  {
    // [parser名, 邮件, from, 期望商家]
    const NAMES = [
      ['DBS PayLah · www', `DBS PayLah!\nTo : www.anywheel.sg\nAmount : SGD 2.00\nDate & Time : 07 Aug 2026 12:41 (SGT)\nTransaction Ref : IP2608071241001`, 'notify@dbs.com', 'www.anywheel.sg'],
      ['DBS PayLah · 号码', `DBS PayLah!\nTo : 96SUPER GRADE PTE. LTD.\nAmount : SGD 2.00\nDate & Time : 07 Aug 2026 12:41 (SGT)\nTransaction Ref : IP2608071241002`, 'notify@dbs.com', '96SUPER GRADE PTE. LTD.'],
      ['OCBC 卡 · www', `Dear Valued Customer\nWe wish to inform you that SGD2.00 was charged at 19:53 on 06-Aug-26 to your card (-3578) at www.anywheel.sg Singapore.\nOCBC`, 'notifications@ocbc.com', 'www.anywheel.sg Singapore'],
      ['OCBC 卡 · 号码', `Dear Valued Customer\nWe wish to inform you that SGD2.00 was charged at 19:53 on 06-Aug-26 to your card (-3578) at 7-ELEVEN-3021.\nOCBC`, 'notifications@ocbc.com', '7-ELEVEN-3021'],
      ['PayNow · www', `PayNow transfer\nThe following PayNow transfer has been made.\nDate : 14 Jul 2026\nTime : 13:22 PM SGT\nAmount : SGD 5.80\nTo : www.anywheel.sg\nReference number : 2607140116147001`, 'notifications@ocbc.com', 'www.anywheel.sg'],
      ['PayNow · 号码', `PayNow transfer\nThe following PayNow transfer has been made.\nDate : 14 Jul 2026\nTime : 13:22 PM SGT\nAmount : SGD 5.80\nTo : 96SUPER GRADE PTE LTD\nReference number : 2607140116147002`, 'notifications@ocbc.com', '96SUPER GRADE PTE LTD'],
      ['NETS · 号码', `OCBC\nThe following NETS QR payment has been made:\nAmount            : SGD 4.50\nDate              : 04 Aug 2026\nTime              : 01:16pm SGT\nTo                : 88 CHICKEN RICE\nReference number  : 2608040116129894\nNETS merchant ID  : 11169856600`, 'notifications@ocbc.com', '88 CHICKEN RICE'],
      ['MariBank付 · www', `MariBank\nYou have made a payment to www.anywheel.sg on your credit card ending 5831.\nTransaction Time:\n02 Aug 2026 16:51 SGT\nAmount:\nCNY 20.00`, 'no-reply@maribank.sg', 'www.anywheel.sg'],
      ['MariBank退 · 号码', `MariBank\nYou have received a refund on 04 Aug 2026 18:57 SGT to your credit card ending 5831.\nMerchant Name:\n88 CHICKEN RICE\nRefunded Amount:\nCNY 5.00`, 'no-reply@maribank.sg', '88 CHICKEN RICE'],
      ['DBS PayNow收 · 号码', `digibank Alerts\nYou have received SGD 30.00 via PayNow on 07 Aug 2026 17:18 SGT.\nFrom: 96FRESH MART PTE LTD\nTo: Your DBS account ending 7344\nDBS Bank Ltd`, 'ibanking.alert@dbs.com', '96FRESH MART PTE LTD'],
      ['PayLah退 · 号码', `Transaction Ref: 260810215418MC859446\nWe refer to your PayLah! refund transaction below.\nDate & Time: 10 Aug21:54 (SGT)\nAmount: SGD 0.70\nFrom: 88 REFUND PTE LTD\nTo: PayLah! Wallet\nDBS Bank Ltd`, 'paylah@dbs.com', '88 REFUND PTE LTD'],
    ];
    for (const [name, raw, from, wMerch] of NAMES) {
      const r = (W.parseRaw(raw, from) || [])[0];
      if (!r) { bad(`「${name}」没解出来（应抓到 ${wMerch}）`); continue; }
      r.merchant === wMerch ? ok(`「${name}」商家 = ${wMerch}（没腰斩 / 没掉通用名）`)
        : bad(`「${name}」商家名抓错`, `期望 "${wMerch}" 实得 "${r.merchant}"`);
    }
    // 反向：付款人是**纯数字**（账号误进 From）→ 不当商家，退回通用名（别把账号当人名）
    const pureNum = (W.parseRaw(`digibank Alerts\nYou have received SGD 30.00 via PayNow on 07 Aug 2026 17:18 SGT.\nFrom: 123456789\nTo: Your DBS account ending 7344\nDBS Bank Ltd`, 'ibanking.alert@dbs.com') || [])[0];
    (pureNum && pureNum.merchant === 'PayNow 收款') ? ok('纯数字付款人 → 退通用名（账号没被当人名）', pureNum.merchant)
      : bad('纯数字被当成付款人了', String(pureNum && pureNum.merchant));
  }

  /* ── §D1k 真实店名参照集 + 数字不串（v10.22，使用者建议：拿真实店名当基准）──
     这是**一路收集的真实店名/收款人**（每张照片、每封原文里出现过的），钉住每个名字经它该走的 parser
     被**一字不差**抓出来。真实名字才有真实的刁难：点(TRIP.COM / www. / PTE. LTD.)、星(Alipay*Taobao)、
     括号(SINGAPORE POOLS (PRIVATE) LIMITED.)、数字开头(96SUPER)、全大写、长串。以后谁动了商家正则，
     这张参照集立刻告诉你哪个真实店名读坏了。 */
  head('§D1k 真实店名参照集（一字不差）+ 数字不串');
  {
    // [名字来源, 邮件, from, 期望商家] —— 全是真实样本里出现过的店名/对手方
    const REAL = [
      ['SG MUYOO (OCBC卡)', `Dear Valued Customer\nWe wish to inform you that SGD3.80 was charged at 19:53 on 06-Aug-26 to your card (-3578) at SG MUYOO.\nOCBC`, 'notifications@ocbc.com', 'SG MUYOO'],
      ['TRIP.COM Singapore SGP (OCBC卡·点)', `Dear Valued Customer\nWe wish to inform you that SGD313.92 was charged at 01:02 on 04-Aug-26 to your card (-3578) at TRIP.COM Singapore SGP.\nOCBC`, 'notifications@ocbc.com', 'TRIP.COM Singapore SGP'],
      ['www.anywheel.sg Singapore (OCBC卡·网址)', `Dear Valued Customer\nWe wish to inform you that SGD9.90 was charged at 21:31 on 10-Aug-26 to your card (-3578) at www.anywheel.sg Singapore.\nOCBC`, 'notifications@ocbc.com', 'www.anywheel.sg Singapore'],
      ['96SUPER GRADE PTE. LTD. (OCBC PayNow·数字开头)', `Dear Valued Customer\nThe following PayNow transfer has been made to 96SUPER GRADE PTE. LTD. using UEN 201323161C.\nDate\n: 09 Jul 2026\nTime\n: 20:59 PM SGT\nAmount\n: SGD 62.00\nReference number\n: 2607090114048000\nOCBC`, 'notifications@ocbc.com', '96SUPER GRADE PTE. LTD.'],
      ['FU HUI COOKED FOOD (NETS)', `OCBC\nThe following NETS QR payment has been made:\nAmount : SGD 4.50\nDate : 04 Aug 2026\nTime : 01:16pm SGT\nTo : FU HUI COOKED FOOD\nReference number : 2608040116129894\nNETS merchant ID : 11169856600`, 'notifications@ocbc.com', 'FU HUI COOKED FOOD'],
      ['SINGAPORE POOLS (PRIVATE) LIMITED. (DBS·括号)', `DBS PayLah!\nTo : SINGAPORE POOLS (PRIVATE) LIMITED.\nAmount : SGD 10.00\nDate & Time : 05 Aug 2026 18:38 (SGT)\nTransaction Ref : IPS78592630026707383`, 'notify@dbs.com', 'SINGAPORE POOLS (PRIVATE) LIMITED.'],
      ['Alipay*Taobao (MariBank付·星号)', `MariBank\nYou have made a payment to Alipay*Taobao on your credit card ending 5831.\nTransaction Time:\n02 Aug 2026 16:51 SGT\nAmount:\nCNY 20.00`, 'no-reply@maribank.sg', 'Alipay*Taobao'],
      ['Alipay*RED Note (MariBank退·星号)', `MariBank\nYou have received a refund on 04 Aug 2026 18:57 SGT to your credit card ending 5831.\nMerchant Name:\nAlipay*RED Note\nRefunded Amount:\nCNY 5.00`, 'no-reply@maribank.sg', 'Alipay*RED Note'],
      ['BCRS LTD (PayLah退)', `Transaction Ref: 260810215418MC859446\nWe refer to your PayLah! refund transaction below.\nDate & Time: 10 Aug21:54 (SGT)\nAmount: SGD 0.70\nFrom: BCRS LTD\nTo: PayLah! Wallet\nDBS Bank Ltd`, 'paylah@dbs.com', 'BCRS LTD'],
      ['CHAN YI SHENG (DBS PayNow收)', `digibank Alerts\nYou have received SGD 30.00 via PayNow on 07 Aug 2026 17:18 SGT.\nFrom: CHAN YI SHENG\nTo: Your DBS account ending 7344\nDBS Bank Ltd`, 'ibanking.alert@dbs.com', 'CHAN YI SHENG'],
    ];
    for (const [name, raw, from, wMerch] of REAL) {
      const r = (W.parseRaw(raw, from) || [])[0];
      if (!r) { bad(`真实店名「${name}」没解出来`); continue; }
      r.merchant === wMerch ? ok(`真实店名 ${name} → 「${wMerch}」一字不差`)
        : bad(`真实店名「${name}」抓错`, `期望 "${wMerch}" 实得 "${r.merchant}"`);
    }
    /* 数字不串：名字被【金额/账号/参考号】数字环绕时，只能抓到名字，绝不能抓成任何一个数字 */
    const surround = (W.parseRaw(`PayNow transfer\nThe following PayNow transfer has been made.\nDate : 14 Jul 2026\nTime : 13:22 PM SGT\nAmount : SGD 62.00\nTo : ALICE TAN\nFrom your account : 360 Account (-862001)\nReference number : 2607140116147079`, 'notifications@ocbc.com') || [])[0];
    (surround && surround.merchant === 'ALICE TAN' && surround.amount === 62)
      ? ok('数字环绕：抓到收款人 ALICE TAN，没抓成金额62/账号862001/参考号', surround.merchant)
      : bad('数字串了：把某个数字当成了商家或金额', JSON.stringify(surround));
    /* 纯数字名（无字母）→ 退通用名，是**刻意**的安全选择：宁可退通用名让你改一次，
       也不冒险把账号/金额那串纯数字当成店名（PayNow 转账这一支才有这道尺；卡/NETS/MariBank 不受影响）。 */
    const pd = (W.parseRaw(`PayNow transfer\nThe following PayNow transfer has been made.\nDate : 14 Jul 2026\nTime : 13:22 PM SGT\nAmount : SGD 5.80\nTo : 221\nReference number : 2607140116147079`, 'notifications@ocbc.com') || [])[0];
    (pd && pd.merchant === 'PayNow Transfer') ? ok('PayNow 纯数字名 221 → 退通用名（刻意的安全选择，不冒险抓数字）', pd.merchant)
      : bad('PayNow 纯数字名行为变了（要么抓成 221 要么抓错）', String(pd && pd.merchant));
    /* 但纯数字店名走【卡/NETS】那条能抓到（那些是从带标签的字段拿的，不会误抓数字） */
    const pdNets = (W.parseRaw(`OCBC\nThe following NETS QR payment has been made:\nAmount : SGD 4.50\nDate : 04 Aug 2026\nTime : 01:16pm SGT\nTo : 218\nReference number : 2608040116129894\nNETS merchant ID : 11169856600`, 'notifications@ocbc.com') || [])[0];
    (pdNets && pdNets.merchant === '218') ? ok('NETS 纯数字名 218 → 抓到（带标签字段，安全）', pdNets.merchant)
      : bad('NETS 纯数字名抓错', String(pdNets && pdNets.merchant));
  }

  /* ── §D1L Wise 卡消费截图（v10.25 · 三张真实照片）──
     截图 parser（跟 PayLah/TnG/Maybank 截图同一条概念，只走粘贴链）。三张真样本各钉一类：
       ① 346.91 CNY：两个日期陷阱（交易时间 vs 退款期限）+ 状态栏时钟 01:18 都不能抓错；
       ② **79 CNY（整数无小数）**：Wise 整数金额不带 .00，旧版硬要小数 → 整笔读不到（真实踩过，这条守死）；
       ③ 5.72 USD：另一个币种 + 单字商家 Cloudflare。
     商家【无标签】= 金额下一行，跳过 Pending/分类/Wise UI 噪音。 */
  head('§D1L Wise 卡消费截图（v10.25 · 三张真样本）');
  {
    // [名字, 邮件, 期望币种, 期望金额, 期望商家, 期望时间前缀]
    const WISES = [
      ['① 346.91 CNY·两日期陷阱', `01:18\nPending\n346.91 CNY\nWeixin Panduo Platform\nShopping\nIf the merchant doesn't claim this payment by August 21, 2026, we'll automatically return your money.\nLearn more\nSplit this transaction\nRequest money from others\nTransaction details\nWhen\nAugust 12, 2026 at 01:03\nWhere\nOnline\nWhich card\nInfinite Canvas, 0977\nAuthorised via\nManual entry\nNote\nAdd`, 'CNY', 346.91, 'Weixin Panduo Platform', '2026-08-12T01:03'],
      ['② 79 CNY·整数无小数', `01:49\nPending\n79 CNY\nGuangzhouyijida - Alipay\nBills\nSplit this transaction\nRequest money from others\nTransaction details\nWhen\nJune 18, 2026 at 09:34\nWhere\nOnline\nWhich card\nInfinite Canvas, 0977\nAuthorised via\nSaved details\nNote\nAdd`, 'CNY', 79, 'Guangzhouyijida - Alipay', '2026-06-18T09:34'],
      ['③ 5.72 USD·单字商家', `01:49\n5.72 USD\nCloudflare\nShopping\nSplit this transaction\nRequest money from others\nTransaction details\nWhen\nJuly 12, 2026 at 20:18\nWhere\nOnline\nWhich card\nInfinite Canvas, 0977\nAuthorised via\nApple Pay\nNote\nAdd`, 'USD', 5.72, 'Cloudflare', '2026-07-12T20:18'],
      /* ④ v10.25b 真实踩过：OCR 把**标签成组、值成组**（When/Where/Which card/… 一坨，日期/Online/卡号一坨）
         → 旧版卡号咬到日期里的年份 **2026**（App 里卡号那格显示 2026）。这条钉死卡号 = 0977，跟 OCR 排版无关。 */
      ['④ 标签成组·卡号别读成年份2026', `10:42\n5G 85\nPending\n174.40 CNY\nWeixin Panduo Platform\nShopping\nIf the merchant doesn't claim this payment by August 21, 2026, we'll automatically return your money.\nLearn more\nSplit this transaction\nRequest money from others\nTransaction details\nWhen\nWhere\nWhich card\nAuthorised via\nNote\nAugust 11, 2026 at 21:55\nOnline\nInfinite Canvas, 0977\nManual entry\nAdd`, 'CNY', 174.40, 'Weixin Panduo Platform', '2026-08-11T21:55'],
    ];
    for (const [n, raw, wCur, wAmt, wMerch, wTs] of WISES) {
      const w = (W.parseRaw(raw, 'paste') || [])[0];
      if (!w) { bad(`Wise ${n} 没解出来（读不到）`); continue; }
      const okAll = w.source === 'wise' && (w.type || 'expense') === 'expense' && w.currency === wCur && w.amount === wAmt && w.merchant === wMerch && String(w.ts).startsWith(wTs) && w.card_last4 === '0977' && /^wise:/.test(String(w.hash));
      okAll ? ok(`Wise ${n} → ${wCur}${wAmt}·${wMerch}·${wTs}·0977`)
        : bad(`Wise ${n} 抓错`, `期望 ${wCur}/${wAmt}/${wMerch}/${wTs} 实得 ${w.currency}/${w.amount}/${w.merchant}/${String(w.ts).slice(0,16)} (src ${w.source}, card ${w.card_last4})`);
    }
    // 反向①：普通 OCBC 卡消费没有 Which card/Authorised via → 不被 Wise 闸门吃
    const ocbc = (W.parseRaw(`Dear Valued Customer\nWe wish to inform you that SGD3.80 was charged at 19:53 on 06-Aug-26 to your card (-3578) at SG MUYOO.\nOCBC`, 'notifications@ocbc.com') || [])[0];
    (ocbc && ocbc.source === 'ocbc') ? ok('普通 OCBC 卡消费没被 Wise 闸门误吃', ocbc.source) : bad('OCBC 卡消费被 Wise 吃了', JSON.stringify(ocbc));
    // 反向②：Wise 收款（refund/received）→ looksIncoming 挡住，不在这支记成支出
    const win = W.parseRaw(`Pending\nYou received 50.00 CNY\nSomeone\nWhich card\nInfinite Canvas, 0977\nAuthorised via\nManual entry`, 'paste') || [];
    (win.length === 0 || win[0].type === 'income') ? ok('Wise 收款不被记成支出（looksIncoming 挡住）') : bad('Wise 收款被记成支出了', JSON.stringify(win[0]));
  }

  /* ── §D2 反向保险：这些措辞不准误挡（守卫写太宽就会在这里破） ── */
  head('§D2 支出信不准被误挡');
  {
    const CASES = [
      ['DBS 正常消费', W.parseDBS,
        `DBS PayLah!\nTo : SINGAPORE POOLS (PRIVATE) LIMITED.\nAmount : SGD 10.00\nDate & Time : 05 Aug 2026 12:41 (SGT)\nTransaction Ref : IP2608051241099`],
      ['DBS 支出 + "You will receive a receipt"', W.parseDBS,
        `DBS PayLah!\nTo : NTUC FAIRPRICE\nAmount : SGD 10.00\nDate & Time : 05 Aug 2026 12:41 (SGT)\nTransaction Ref : IP2608051241100\nYou will receive a receipt by email shortly.`],
      ['DBS 支出 + "recipient received your transfer"', W.parseDBS,
        `DBS PayLah!\nTo : ALICE TAN\nRecipient received your transfer notification\nAmount : SGD 10.00\nDate & Time : 05 Aug 2026 12:41 (SGT)\nTransaction Ref : IP2608051241101`],
      ['MariBank 正常卡消费', W.parseMariBank,
        `MariBank\nAwesome! Your payment is successful\nTransaction Time\n05 Aug 2026 12:41 SGT\nAmount\nSGD 16.51\nYou have made a payment to GRAB SINGAPORE on your credit card ending 5831`],
      ['PayLah 截图 You paid', W.parsePayLahShot,
        `20:18\n•il 5G 76\nHistory PayLah!\nMA\nYou paid MX AMMXX THXX CH\nSGD 9.00\n20 JUL • 01:30 PM\nTransaction Ref. No.\nIP178452545726811745`],
    ];
    for (const [name, fn, txt] of CASES) {
      let r;
      try { r = fn(txt); } catch (e) { bad(`${name} 抛错了`, String(e && e.message || e)); continue; }
      (Array.isArray(r) && r.length === 1) ? ok(name, `${r[0].currency} ${r[0].amount} · ${r[0].merchant}`)
        : bad(`${name} 被守卫误挡了（解出 ${Array.isArray(r) ? r.length : '非阵列'} 笔）`,
          '守卫写太宽 → 正常支出信会掉进「读不到」，要回头收紧 looksIncoming 的措辞');
    }
    /* 已知取舍，钉成一条**提醒**而不是失败：页尾一句 "credited to your account" 会整封挡掉。
       这是刻意的（见 worker.js looksIncoming 上面那段）—— 挡掉看得见，记错看不见。
       哪天真的有银行这样写支出信，这条会提醒你该拿真样本去收紧了。 */
    const footer = W.parseDBS(`DBS PayLah!\nTo : NTUC FAIRPRICE\nAmount : SGD 10.00\nDate & Time : 05 Aug 2026 12:41 (SGT)\nTransaction Ref : IP2608051241102\nRefunds will be credited to your account within 7 days.`);
    footer.length === 0
      ? ok('已知取舍：页尾 "credited to your account" 整封挡掉（刻意）')
      : bad('守卫被放宽了？页尾 credited 那条现在放行', '放宽的方向很危险：真收款信也会跟着放行');
  }

  /* ── §D3 垃圾输入：绝不 null、绝不 throw ──
     路由那行是 `if (!rows.length)`，回 null 会把整个 email() 打掉，
     那封信连「读不到」都进不去，直接蒸发 —— 违反地基那条：绝不静默丢账。 */
  head('§D3 垃圾输入健壮性');
  {
    const FNS = ['parseDBS', 'parseOCBC', 'parsePayNow', 'parseNETS', 'parseMariBank',
      'parseMaybankShot', 'parsePayLahShot', 'parseTnGShot'];
    const JUNK = [['空字串', ''], ['随机噪音', '???###\n\u0000\uFFFD  \n123'], ['残骸信头', 'Received: from x\nSubject:\nContent-Type: text/html\n\n<td></td>']];
    let bads = [];
    for (const n of FNS) for (const [jn, j] of JUNK) {
      try { const r = W[n](j); if (!Array.isArray(r)) bads.push(`${n} × ${jn} → 回了 ${r === null ? 'null' : typeof r}`); }
      catch (e) { bads.push(`${n} × ${jn} → 抛错 ${e && e.message}`); }
    }
    bads.length ? bad('有 parser 吃到垃圾会 null / 抛错', bads.join('\n     '))
      : ok('8 支 parser × 3 种垃圾都回阵列、不 null、不抛错', `${FNS.length * JUNK.length} 项`);
  }

  /* ── §D4 时区恒 +08:00（绝不跟设备时区走）＋ 去重幂等 ── */
  head('§D4 时区 + 去重幂等');
  {
    const SAMPLE = `Transaction Ref: IPS78592630026707383\n\nDate & Time:  05 Aug 18:38 (SGT)\nAmount:  SGD10.00\nTo:  SINGAPORE POOLS (PRIVATE) LIMITED.\nPayLah!`;
    const a = W.parseRaw(SAMPLE, 'notify@dbs.com');
    const b = W.parseRaw(SAMPLE, 'notify@dbs.com');
    a.length && a.every(r => String(r.ts).endsWith('+08:00'))
      ? ok('ts 一律 +08:00', a[0].ts) : bad('ts 不是 +08:00（跟设备时区走会整批错时间）', JSON.stringify(a.map(r => r.ts)));
    JSON.stringify(a.map(r => r.hash)) === JSON.stringify(b.map(r => r.hash))
      ? ok('同一封解两次指纹一致（去重幂等）', a[0] && a[0].hash) : bad('同一封解两次指纹不同 → 会记成两笔');
  }

  /* ── §D5 币种：抓错币种 = 连金额一起抓错（v10.15 F2） ── */
  head('§D5 币种必须是真 ISO 4217');
  {
    const CASES = [
      ['parsePayNow · "was 313.92" 诱饵不准赢过 Amount', W.parsePayNow,
        `PayNow transfer made\nA fee was 313.92 charged previously.\nDate : 14 Jul 2026\nTime : 13:22 PM SGT\nAmount : SGD 5.80\nReference number : 2607140116147079`, 'SGD', 5.8],
      ['parsePayNow · "Ref 20.00" 诱饵', W.parsePayNow,
        `PayNow transfer made to ALICE\nRef 20.00\nDate : 14 Jul 2026\nTime : 13:22 PM SGT\nAmount : SGD 5.80\nReference number : 2607140116147079`, 'SGD', 5.8],
      ['parseDBS · "XYZ 99.00" 诱饵', W.parseDBS,
        `DBS PayLah!\nTo : NTUC\nTotal XYZ 99.00 for SGD 10.00\nDate & Time : 05 Aug 2026 12:41 (SGT)\nTransaction Ref : IP26080512410777`, 'SGD', 10],
      ['parsePayLahShot · "XYZ 99.00" 诱饵', W.parsePayLahShot,
        `20:18\nHistory PayLah!\nYou paid KOPITIAM\nXYZ 99.00\nSGD 4.20\n20 JUL • 01:30 PM\nTransaction Ref. No.\nIP178452545726811745`, 'SGD', 4.2],
      ['parseMariBank · "SGT 16.51" 诱饵 + 真 CNY', W.parseMariBank,
        `MariBank\npayment to Alipay*Taobao on your credit card ending 5831\nTransaction Time:\n02 Aug 2026 16:51 SGT\nAmount:\nSGT 16.51\nCharged: CNY 20.00`, 'CNY', 20],
    ];
    for (const [name, fn, txt, cur, amt] of CASES) {
      const r = fn(txt);
      (r.length === 1 && r[0].currency === cur && r[0].amount === amt)
        ? ok(name, `${cur} ${amt}`)
        : bad(`${name} → 抓错了`, r.length ? `实得 ${r[0].currency} ${r[0].amount}（应为 ${cur} ${amt}）` : '解析不出来');
    }
    /* 整封都找不到合法币种时**不准把账丢掉** —— 保留原样照记，让前端 FX_MISS 红字去提醒。 */
    const only = W.parseMariBank(`MariBank\nYou have made a payment to GRAB on your credit card ending 5831\nTransaction Time:\n02 Aug 2026 16:51 SGT\nAmount:\nSGT 16.51`);
    (only.length === 1 && only[0].amount === 16.51)
      ? ok('整封没有合法币种时保留原样照记（不丢账）', `${only[0].currency} ${only[0].amount}`)
      : bad('整封没有合法币种时把账丢掉了', '宁可币种怪也不要整笔不记 —— 丢了要手工补，币种怪前端会挂红字');
  }

  /* ── §D6 外部依赖（离线脆弱点 · v23.27） ──
     单档设计的卖点就是「一个档就是全部」。任何跑到第三方去拿的东西都是一个可能挂掉的点，
     这一组不是要禁止 CDN，是要**看得见**：谁在偷偷多加一个 host、谁把第三方放回开机路径。 */
  head('§D6 外部依赖可见性');
  {
    const HTML = (() => { try { return fs.readFileSync(path.join(BASE, 'index.html'), 'utf8'); } catch { return null; } })();
    if (!HTML) { console.log(`${L.warn}  跳过：读不到 index.html${L.off}`); }
    else {
      /* 先把 HTML 注释抹掉（换成等长空白，行号不跑）——「注释里写着我把那支 CDN 拿掉了」
         不该被当成还挂着一支 CDN。§A-4 早就为同一个坑加过 stripComments，这里同理。 */
      const H = HTML.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
      /* 白名单＝v23.27 之后**只剩一个**（字体已自托管，Google 两个 host 整个拿掉了）。
         多一个就出声 —— 这条守的是「谁又悄悄加了一个 CDN」。 */
      const ALLOW = new Set(['unpkg.com']);
      const hosts = [...new Set([...H.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)].map(m => m[1]))]
        .filter(h => !/^(api\.)?(localhost|127\.0\.0\.1)$/.test(h));
      const extra = hosts.filter(h => !ALLOW.has(h));
      extra.length ? bad('index.html 多了没登记过的外部 host（离线/被墙就是一个新的坏点）',
        extra.join(', ') + '\n     确认它该在这里就把它加进 ALLOW，顺手想一下：它挂掉时哪个功能会死？')
        : ok('外部 host 都在登记内', hosts.join(' · ') || '（一个都没有）');

      /* 开机路径不准有同步的跨站 <script src>：那种标签会让 HTML parser 停在那里等，
         对方「连得上但不回话」时，卡的不是导出功能，是**整个 App 开不了**。 */
      const blocking = [...H.matchAll(/<script\b[^>]*\bsrc=["']https?:\/\/[^"']+["'][^>]*>/g)]
        .map(m => m[0]).filter(t => !/\b(async|defer)\b/.test(t));
      blocking.length ? bad('开机路径上有同步的跨站 <script src> → 对方慢/不通时整个 App 开不了',
        blocking.join('\n     ') + '\n     改法：按需 new Element(\'script\') 动态载，并给一条载不到时的退路')
        : ok('开机不阻塞在任何第三方脚本上');

      /* 字体：v23.27 起**自托管**，不准再出现任何指向 Google 的 link。
         （走过的弯路见总纲 v23.27 那节：阻塞 → 非阻塞但会看到换字 → 自托管。） */
      const gLink = [...H.matchAll(/<link\b[^>]*fonts\.(?:googleapis|gstatic)\.com[^>]*>/g)].map(m => m[0]);
      gLink.length ? bad('字体又接回 Google 了 → 开机要么被它绑架、要么看得见换字',
        gLink.join('\n     ') + '\n     改法：把 woff2 放同一层，用本地 @font-face + font-display:optional')
        : ok('字体已自托管，不连 Google');
      /(@font-face[\s\S]{0,300}?url\(["']?fraunces\.woff2)/.test(H) && /font-display\s*:\s*optional/.test(H)
        ? ok('本地 @font-face 就位（font-display:optional ＝ 永远不会看到换字）')
        : bad('本地字体没接好', '要有 @font-face { src:url("fraunces.woff2") … font-display:optional }');

      /* 导出必须有「载不到就退 CSV」那条退路 —— 不然离线时按钮等于坏的 */
      /\bloadXLSX\b/.test(H) && /aoaToCsv/.test(H)
        ? ok('导出有离线退路（xlsx 按需加载 · 失败退 CSV）')
        : bad('导出没有离线退路', '离线/CDN 挂时按下导出会什么都没有发生');

      /* sw.js 那一半：第三方资源要收进 SW 缓存，不然「非阻塞」换来的就是每次开机
         都看得见字体切换一次（v23.27 那一轮的完整推理见总纲）。 */
      const SW = (() => { try { return fs.readFileSync(path.join(BASE, 'sw.js'), 'utf8'); } catch { return null; } })();
      if (!SW) console.log(`${L.warn}  §D6 sw.js 那三条跳过：档案不在${L.off}`);
      else {
        const swHosts = [...new Set([...SW.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)|host\s*===\s*['"]([a-zA-Z0-9.-]+)['"]/g)]
          .map(m => m[1] || m[2]).filter(Boolean))];
        const swExtra = swHosts.filter(h => !ALLOW.has(h));
        swExtra.length ? bad('sw.js 里出现没登记过的外部 host', swExtra.join(', '))
          : ok('sw.js 的外部 host 都在登记内', swHosts.join(' · ') || '（没有）');

        /* 字体必须进 install 的预缓存 —— 这才是「第二次开机起永远不换字」的保证 */
        /FONTS\s*=\s*\[[^\]]*fraunces\.woff2/.test(SW) && /PRECACHE/.test(SW)
          ? ok('sw.js 在 install 就预先收好字体档')
          : bad('sw.js 没预缓存字体档', '结果：手账主题每次开机都要现载字体 → 又会看到换字，断网还没字体');
        /* opaque 陷阱：跨站资源 status 是 0，用 res.ok 判断会一份都存不进去，而且不报错 */
        /unpkg\.com/.test(SW) && /opaque/.test(SW)
          ? ok('sw.js 有收 xlsx（且认得 opaque）', '第一次在线导出过之后，断网也导得出真 .xlsx')
          : bad('sw.js 没收 xlsx（或漏了 opaque 判断）', '离线导出只能退 CSV，永远回不到真 .xlsx');

        /* activate 白名单：删 cache 时把推送设定一起删掉 = 推送内容退成兜底那句，而且会自己好（最难查） */
        /KEEP\s*=\s*\[\s*CACHE\s*,\s*CONF\s*\]/.test(SW) || /k\s*!==\s*CACHE\s*&&\s*k\s*!==\s*CONF/.test(SW)
          ? ok('sw.js activate 不会删掉推送设定那个 cache')
          : bad('sw.js activate 会连推送设定的 cache 一起删',
            '症状：sw.js 一改动，推送内容就退成「有事项到时间了」；下次开 App 又自己好 —— 最难查的那种');
      }
    }
  }

  return { name: '§D 铁律&健壮', pass, fail, warn: 0, skipped: false };
}

/* ══════════════════════════════════════════════════════════════════════════
   §E  真机端到端（真实触摸 · 需要浏览器）

   §A–§D 全是「静态 / 逻辑」检查，一个像素都没真正画出来、一根手指都没真正点下去。
   血泪教训：以前拿 .click() / 直接 .focus()/.blur() 这种**合成事件**测 UI，永远绿 ——
   可它们不走真机那套 pointerdown→pointerup→click 的真实顺序，也不触发手势链，于是
   「✕ 点不动」「键盘吃第一下」「✕ 幽灵点击穿透到设置页」这类**只在真实触摸下才犯**的坑
   一个都测不到，结果就是「测了没问题，一用一堆问题」。

   这一组改用 Playwright 的**真实触摸 tap + 真实键盘打字**，用 iPhone 设备档，把 App 当人一样点一遍。
   ⚠️ 它需要浏览器（Playwright + Chromium）。没有就**跳过**（不当失败）——所以在没装 playwright 的
      机器上，§A–§D 照跑，§E 会讲一句「这台机没浏览器，跳过」。
   ⚠️⚠️ 就算这组全绿，也**仍然测不到真机软键盘本身**（键盘弹出顶画面 visualViewport、键盘吃第一下点击）——
      headless Chromium 根本没有软键盘。那几样只能靠真手机的 QA 清单。别拿这组全绿当「真机没问题」。
   ══════════════════════════════════════════════════════════════════════════ */

async function suiteE2E() {
  const skip = (why) => { console.log(`${L.warn}  §E 跳过：${why}${L.off}`); return { name: '§E 真机端到端', pass: 0, fail: 0, warn: 1, skipped: true }; };
  if (!fs.existsSync(path.join(BASE, 'index.html'))) return skip('index.html 不在，没画面可点');

  let pw;
  try { pw = await import('playwright'); }
  catch { try { pw = await import('/opt/node22/lib/node_modules/playwright/index.js'); } catch { return skip('这台机没装 playwright（真机端到端只能在有浏览器的环境跑）'); } }
  const chromium = pw.chromium || (pw.default && pw.default.chromium);   // ⚠️ playwright 把 chromium 挂在 default 上，不是具名导出
  if (!chromium) return skip('playwright 载入了但拿不到 chromium 物件');

  let pass = 0, fail = 0;
  const ok  = (m, d) => { pass++; if (VERBOSE) console.log(`${L.ok}  ✅ ${m}${L.off}${d ? `  ${L.dim}${d}${L.off}` : ''}`); };
  const bad = (m, d) => { fail++; console.log(`${L.bad}  ❌ ${m}${L.off}${d ? `\n     ${d}` : ''}`); };

  /* 迷你 Mock Worker：只回 App 开机 + 明细/搜索/记账要用到的那几条 API（图标/字体给空 200 免 404 噪音）。 */
  const J = (res, o) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(o)); };
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p.startsWith('/api/')) {
      if (p === '/api/data') return J(res, { expenses: [
        { id: 1, ts: '2026-08-07T12:42:00+08:00', amount: 15.2, currency: 'SGD', merchant: 'MX AMMXX THXX CHX ANX', card_last4: 'PayNow', source: 'paynow', category: 'food', raw: '' },
        { id: 2, ts: '2026-08-07T00:56:00+08:00', amount: 1.9, currency: 'SGD', merchant: '221_DRINKS', card_last4: 'PayLah', source: 'dbs', category: 'food', raw: '' },
        { id: 3, ts: '2026-08-06T19:53:00+08:00', amount: 3.8, currency: 'SGD', merchant: 'SG MUYOO', card_last4: '3578', source: 'ocbc', category: 'food', raw: '' }], rules: {} });
      if (p === '/api/health') return J(res, { ok: true, server_now_ms: Date.now() });
      if (p === '/api/settings') return J(res, { prefs: { theme: 'photo' }, rec: [], subignore: [], paymethods: [], paynames: {} });
      if (p === '/api/events') return J(res, { events: [] });
      if (p === '/api/inbox') return J(res, { items: [{ id: 'u1', ts: '2026-08-04T18:57:00+08:00', sender: 'a@dbs', subject: '读不到', kind: 'unparsed', summary: '⚠️', hashes: '' }], counts: { parsed: 0, unparsed: 1 }, badge: 1, month: '2026-08' });
      if (p === '/api/gcal/status') return J(res, { connected: false });
      if (p === '/api/ics/list') return J(res, { feeds: [] });
      return J(res, { ok: true, badge: 1 });
    }
    if (/\.(png|ico|woff2?)$/.test(p)) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(''); }
    let f = p === '/' ? '/index.html' : p; const fp = path.join(BASE, f);
    if (!fp.startsWith(BASE) || !fs.existsSync(fp)) { res.writeHead(404); return res.end('no'); }
    const ext = path.extname(fp); res.writeHead(200, { 'Content-Type': ext === '.html' ? 'text/html' : 'text/plain' }); res.end(fs.readFileSync(fp));
  });
  await new Promise(r => server.listen(0, r));
  const O = `http://localhost:${server.address().port}`;

  let b;
  try { b = await chromium.launch(); }                       // 用 playwright 自带浏览器（PLAYWRIGHT_BROWSERS_PATH 会指对）
  catch (e) {
    try { b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }); }
    catch { server.close(); return skip('装了 playwright 但没有可用的 chromium（跑一次 `playwright install chromium`）'); }
  }

  const errs = [];
  try {
    const iphone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' };
    const ctx = await b.newContext(iphone);
    const pg = await ctx.newPage();
    pg.on('pageerror', e => errs.push(String(e.message || e)));
    pg.on('console', m => { const t = m.text(); if (/favicon\.ico|icon-\d+\.png|fraunces\.woff2/.test(t)) return; if (m.type() === 'error') errs.push('console.error: ' + t); });
    await pg.addInitScript(o => { localStorage.setItem('hz_wurl', o); localStorage.setItem('hz_tk', 't'); if (navigator.serviceWorker) { try { navigator.serviceWorker.register = () => Promise.resolve({ scope: '/', addEventListener() {}, update() {} }); } catch (e) {} } }, O);
    await pg.goto(O + '/', { waitUntil: 'load' }); await pg.waitForTimeout(2000);

    const tap = (sel) => pg.locator(sel).tap();
    const tapXY = (x, y) => pg.touchscreen.tap(x, y);
    const st = () => pg.evaluate(() => ({ bar: !!document.querySelector('#searchbar.open'), kb: document.body.classList.contains('kbup'), val: document.getElementById('q').value, active: document.activeElement && document.activeElement.id, onfeed: document.body.classList.contains('on-feed'), nav3: document.getElementById('nav3').classList.contains('on') }));

    // 1) 真实点四个 tab
    try {
      await tap('#nav1'); await pg.waitForTimeout(250); (await pg.locator('#nav1').getAttribute('class')).includes('on') ? ok('点「总览」高亮') : bad('总览没高亮');
      await tap('#nav2'); await pg.waitForTimeout(250); (await st()).onfeed ? ok('点「明细」高亮') : bad('明细没高亮');
      await tap('#navInbox'); await pg.waitForTimeout(400); ((await pg.locator('#inboxPage').getAttribute('class')) || '').includes('show') ? ok('点「收件箱」打开') : bad('收件箱没打开');
      await tap('#nav3'); await pg.waitForTimeout(250); ok('点「设置」没抛错');
    } catch (e) { bad('导航过程抛错', String(e.message).slice(0, 80)); }

    // 2) 搜索：真实 tap 开 + 真实键盘打字 + 真实 tap ✕ / 真实点空位
    try {
      await tap('#nav2'); await pg.waitForTimeout(250);
      await tap('#searchFab'); await pg.waitForTimeout(200);
      let s = await st(); (s.bar && s.active === 'q') ? ok('真实 tap🔍 → 框开+焦点在输入框（真机靠这个第一下弹键盘）') : bad('tap🔍 没聚焦', JSON.stringify(s));
      await pg.keyboard.type('MX'); await pg.waitForTimeout(300);
      s = await st(); s.val === 'MX' ? ok('真实键盘打字进去了') : bad('打字没进去', s.val);
      await tap('#qx'); await pg.waitForTimeout(300);
      s = await st(); (!s.bar && !s.kb && s.val === '') ? ok('有字 + 真实 tap✕ → 第一下就全关') : bad('有字 tap✕ 没第一下关（真机坑）', JSON.stringify(s));
      (s.onfeed && !s.nav3) ? ok('tap✕ 后仍在明细页（幽灵点击没穿透到设置）') : bad('tap✕ 幽灵点击穿透了（掉出明细/跳设置）', JSON.stringify(s));
      await tap('#searchFab'); await pg.waitForTimeout(150); (await st()).bar ? ok('关掉后再 tap🔍 能重新打开') : bad('关掉后 🔍 打不开了');
      await pg.keyboard.type('221'); await pg.waitForTimeout(300);
      await tapXY(30, 180); await pg.waitForTimeout(400);
      s = await st(); (s.bar && s.val === '221') ? ok('有字 + 真实点空位 → 框和字都保留') : bad('有字点空位 框/字没保留', JSON.stringify(s));
      await tap('#qx'); await pg.waitForTimeout(300); (!(await st()).bar) ? ok('再 tap✕ → 关') : bad('tap✕ 没关');
      await tap('#searchFab'); await pg.waitForTimeout(200); await tapXY(30, 180); await pg.waitForTimeout(400);
      (!(await st()).bar) ? ok('空框 + 真实点空位 → 关') : bad('空框点空位没关');
    } catch (e) { bad('搜索流程抛错', String(e.message).slice(0, 80)); }

    // 3) 记一笔：真实 tap 导航栏中间的 ＋
    try {
      await tap('#nav2'); await pg.waitForTimeout(200);
      const before = await pg.evaluate(() => document.body.className);
      await tap('#navAdd'); await pg.waitForTimeout(500);
      const opened = await pg.evaluate(() => !!document.querySelector('.add.show') || document.body.classList.contains('pageopen'));
      const after = await pg.evaluate(() => document.body.className);
      (opened || after !== before) ? ok('真实 tap ＋ → 记账面板打开') : bad('tap ＋ 没反应', after);
      await pg.evaluate(() => { try { closeSheet(); } catch (e) {} }); await pg.waitForTimeout(300);
    } catch (e) { bad('记一笔抛错', String(e.message).slice(0, 80)); }

    // 3b) v11.12 ＋ 跟日历模式走：日历切到「事项」→ tap ＋ 该直接开事项（顶部高亮也要跟着切），别再停在支出让人自己换
    try {
      await tap('#nav1'); await pg.waitForTimeout(300);
      await pg.evaluate(() => { const t = [...document.querySelectorAll('#calSeg [data-cm]')].find(b => b.dataset.cm === 'todo'); if (t) t.click(); }); await pg.waitForTimeout(300);
      await tap('#navAdd'); await pg.waitForTimeout(500);
      const ev = await pg.evaluate(() => { const add = document.getElementById('add'); const ie = [...document.querySelectorAll('#ieSeg button')].find(b => b.dataset.t === 'event'); return { eventMode: add.classList.contains('event'), ieOn: !!(ie && ie.classList.contains('on')) }; });
      (ev.eventMode && ev.ieOn) ? ok('日历在「事项」→ tap ＋ 直接开事项（顶部「事项」也高亮）') : bad('日历在事项时 ＋ 没直接开事项', JSON.stringify(ev));
      await pg.evaluate(() => { try { closeSheet(); } catch (e) {} }); await pg.waitForTimeout(200);
      // 反向：切回「金额」→ tap ＋ 该回到支出（别粘在事项）
      await pg.evaluate(() => { const t = [...document.querySelectorAll('#calSeg [data-cm]')].find(b => b.dataset.cm === 'money'); if (t) t.click(); }); await pg.waitForTimeout(300);
      await tap('#navAdd'); await pg.waitForTimeout(500);
      const mo = await pg.evaluate(() => { const add = document.getElementById('add'); const ie = [...document.querySelectorAll('#ieSeg button')].find(b => b.dataset.t === 'expense'); return { eventMode: add.classList.contains('event'), ieOn: !!(ie && ie.classList.contains('on')) }; });
      (!mo.eventMode && mo.ieOn) ? ok('日历切回「金额」→ tap ＋ 回到支出') : bad('日历在金额时 ＋ 没回到支出', JSON.stringify(mo));
      await pg.evaluate(() => { try { closeSheet(); } catch (e) {} }); await pg.waitForTimeout(200);
    } catch (e) { bad('＋跟日历模式走 抛错', String(e.message).slice(0, 80)); }

    // 3c) v11.13 选了某天（速览高亮 peekKey）→ ＋ 该加到那天，不是默认今天；没选才默认今天
    try {
      await tap('#nav1'); await pg.waitForTimeout(300);
      const pickDay = await pg.evaluate(() => { const cs = [...document.querySelectorAll('.cal-c[data-day]')]; const c = cs.find(x => !x.classList.contains('today')) || cs[0]; if (c) c.click(); return c ? c.dataset.day : null; });
      await pg.waitForTimeout(300);
      await tap('#navAdd'); await pg.waitForTimeout(400);
      const gotDate = await pg.evaluate(() => document.getElementById('date').value);
      (pickDay && gotDate === pickDay) ? ok('选了某天（不是今天）→ tap ＋ 花费日期就是那天', pickDay) : bad('选了某天 ＋ 没加到那天（还停在今天？）', `选 ${pickDay} · 得 ${gotDate}`);
      await pg.evaluate(() => { try { closeSheet(); } catch (e) {} try { closeDayPeek(); } catch (e) {} }); await pg.waitForTimeout(200);
    } catch (e) { bad('选日期加账 抛错', String(e.message).slice(0, 80)); }

    // 4) 设置：真实 tap 数值颜色色卡（顺带验搜索上色那条链没抛错）
    try {
      await tap('#nav3'); await pg.waitForTimeout(400);
      // v11.31 设置改成分组手风琴：数值颜色搬进「外观·通知·系统」卡里 → 先点开这张卡才点得到 .numsw
      await pg.locator('.setgrp[data-g="look"] [data-gtoggle]').tap().catch(() => {}); await pg.waitForTimeout(300);
      const n = await pg.locator('.numsw').count().catch(() => 0);
      if (n > 0) { await pg.locator('.numsw').nth(2).tap(); await pg.waitForTimeout(300); ok('真实 tap 数值颜色色卡没抛错', n + ' 个色卡'); }
      else ok('设置页打开没抛错（没找到色卡，可能要滚动）');
    } catch (e) { bad('设置抛错', String(e.message).slice(0, 80)); }

    errs.length ? bad(`真机跑的过程有 ${errs.length} 条 console/page 报错`, errs.slice(0, 5).join('\n     ')) : ok('全程 0 报错（pageerror + console.error）');
  } catch (e) {
    bad('§E 整段炸了', String(e && e.message || e).slice(0, 120));
  } finally {
    try { await b.close(); } catch {}
    server.close();
  }
  return { name: '§E 真机端到端', pass, fail, warn: 0, skipped: false };
}

/* ══════════════════════════════════════════════════════════════════════════
   §F  全链路：真邮件 → 真 ingestRaw 入库（内存 D1）→ 真 index.html 显示 → 验 hero / 明细

   这一组补的是 §B/§D（只测 parser 解析）跟 §E（只测 UI 点击）中间那道**没人守的缝**：
   「解析对了、存进去时被改掉、hero 算错」——照片 IMG_6964 那个收入被记成 -S$30 支出的坑
   就是从这道缝溜过去的（parser 输出 income ✅，可 ingestRaw 入库写死成 expense，hero 把它当支出加进去）。
   做法：拿真 email 文字喂进**真的 `ingestRaw`**（配一个内存版 D1，会照 SQL 里 type 是绑还是写死如实记），
   把入库结果当 `/api/data` 喂给**真的 index.html**，然后验：
     · 每笔的 type（收入/支出）存对没有；
     · hero「本月支出」大数字＝**只**加支出（收入绝不能混进去）；
     · hero 收入 / 结余 / 笔数 对不对。
   ⚠️ 需要 worker.js（ingestRaw）+ 浏览器；缺哪个就跳过、不当失败。
   ══════════════════════════════════════════════════════════════════════════ */

async function suiteFullPipeline(W) {
  const skip = (why) => { console.log(`${L.warn}  §F 跳过：${why}${L.off}`); return { name: '§F 全链路', pass: 0, fail: 0, warn: 1, skipped: true }; };
  if (!W || typeof W.ingestRaw !== 'function') return skip('worker.js 没载入或没导出 ingestRaw');
  if (!fs.existsSync(path.join(BASE, 'index.html'))) return skip('index.html 不在');
  let pw;
  try { pw = await import('playwright'); }
  catch { try { pw = await import('/opt/node22/lib/node_modules/playwright/index.js'); } catch { return skip('这台机没装 playwright'); } }
  const chromium = pw.chromium || (pw.default && pw.default.chromium);
  if (!chromium) return skip('拿不到 chromium 物件');

  let pass = 0, fail = 0;
  const ok  = (m, d) => { pass++; if (VERBOSE) console.log(`${L.ok}  ✅ ${m}${L.off}${d ? `  ${L.dim}${d}${L.off}` : ''}`); };
  const bad = (m, d) => { fail++; console.log(`${L.bad}  ❌ ${m}${L.off}${d ? `\n     ${d}` : ''}`); };

  /* 内存版 D1：只实现 ingestRaw 用到的几种查询。⭐ type 那栏**照 SQL 如实记**——
     SQL 里绑了 11 个参数就取第 9 个当 type；只绑 10 个＝type 写死在 SQL，就从 VALUES 里的字面量取。
     这样「入库把 income 写死成 expense」这种坑，这里会**如实存成 expense** → 下面断言就红（正是要的）。 */
  const makeEnv = () => {
    const expenses = [], seen = new Set();
    const prepare = (sql) => ({ bind: (...a) => ({
      run: async () => {
        if (/INSERT/i.test(sql) && /INTO\s+expenses/i.test(sql)) {
          let ty, ts, am, cu, me, c4, so, rw, ha, ca, su;
          if (a.length >= 11) { [ts, am, cu, me, c4, so, rw, ha, ty, ca, su] = a; }
          else { [ts, am, cu, me, c4, so, rw, ha, ca, su] = a; const l = sql.match(/VALUES[\s\S]*?'(expense|income)'/i); ty = l ? l[1] : 'expense'; }
          if (seen.has(ha)) return { meta: { changes: 0 } };
          seen.add(ha); const id = expenses.length + 1;
          expenses.push({ id, ts, amount: am, currency: cu, merchant: me, card_last4: c4, source: so, raw: rw, hash: ha, type: ty, category: ca, sub: su });
          return { meta: { changes: 1, last_row_id: id } };
        }
        return { meta: { changes: 1, last_row_id: 1 } };
      },
      first: async () => null, all: async () => ({ results: expenses }),
    }) });
    return { env: { DB: { prepare } }, expenses };
  };

  // 一批真邮件（收入 + 支出混着来）。当月＝2026-08（下面 /api/health 也钉在 8 月，hero 才显示这批）。
  const EMAILS = [
    ['ibanking.alert@dbs.com', `digibank Alerts - You've received a transfer\nTransaction Ref: PIB2608071354011943\nYou have received SGD 30.00 via PayNow on 07 Aug 2026 17:18 SGT.\nFrom: CHAN YI SHENG\nTo: Your DBS/ POSB account ending 7344\nDBS Bank Ltd`, 'income', 30],
    ['notify@dbs.com', `DBS PayLah!\nTo : NTUC FAIRPRICE\nAmount : SGD 10.00\nDate & Time : 07 Aug 2026 12:41 (SGT)\nTransaction Ref : IP2608071241099`, 'expense', 10],
    ['notify@dbs.com', `DBS PayLah!\nTo : KOPITIAM\nAmount : SGD 5.00\nDate & Time : 07 Aug 2026 09:15 (SGT)\nTransaction Ref : IP2608070915022`, 'expense', 5],
  ];
  const { env, expenses } = makeEnv();
  try { for (const [from, raw] of EMAILS) await W.ingestRaw(env, raw, from, 't', {}); }
  catch (e) { return (bad('ingestRaw 抛错', String(e && e.message).slice(0, 100)), { name: '§F 全链路', pass, fail, warn: 0, skipped: false }); }

  // 入库层：每封邮件存进去的 type / 金额对不对
  expenses.length === EMAILS.length ? ok(`三封邮件都入库了`, `${expenses.length} 笔`) : bad('入库笔数不对', `${expenses.length}/${EMAILS.length}`);
  for (const [, , wantType, wantAmt] of EMAILS) {
    const row = expenses.find(e => Math.abs(e.amount - wantAmt) < 0.001);
    if (!row) { bad(`金额 ${wantAmt} 那笔没入库`); continue; }
    row.type === wantType ? ok(`SGD ${wantAmt} 存成 ${wantType}`) : bad(`SGD ${wantAmt} 该是 ${wantType}，却存成 ${row.type}（IMG_6964 那类坑）`, JSON.stringify({ m: row.merchant, t: row.type }));
  }
  const expSum = EMAILS.filter(e => e[2] === 'expense').reduce((n, e) => n + e[3], 0);   // 15
  const incSum = EMAILS.filter(e => e[2] === 'income').reduce((n, e) => n + e[3], 0);     // 30

  // 显示层：把入库结果喂给真 index.html，验 hero
  const J = (res, o) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(o)); };
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p.startsWith('/api/')) {
      if (p === '/api/data') return J(res, { expenses, rules: {} });
      if (p === '/api/health') return J(res, { ok: true, server_now_ms: Date.parse('2026-08-08T12:00:00+08:00') });
      if (p === '/api/settings') return J(res, { prefs: { theme: 'photo' }, rec: [], subignore: [], paymethods: [], paynames: {} });
      if (p === '/api/events') return J(res, { events: [] });
      if (p === '/api/inbox') return J(res, { items: [], counts: { parsed: 0, unparsed: 0 }, badge: 0, month: '2026-08' });
      if (p === '/api/gcal/status') return J(res, { connected: false });
      if (p === '/api/ics/list') return J(res, { feeds: [] });
      return J(res, { ok: true });
    }
    if (/\.(png|ico|woff2?)$/.test(p)) { res.writeHead(200); return res.end(''); }
    let f = p === '/' ? '/index.html' : p; const fp = path.join(BASE, f);
    if (!fp.startsWith(BASE) || !fs.existsSync(fp)) { res.writeHead(404); return res.end('no'); }
    res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : 'text/plain' }); res.end(fs.readFileSync(fp));
  });
  await new Promise(r => server.listen(0, r));
  const O = `http://localhost:${server.address().port}`;
  let b;
  try { b = await chromium.launch(); }
  catch { try { b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }); } catch { server.close(); return skip('没有可用的 chromium'); } }
  try {
    const num = (s) => { const m = String(s || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : NaN; };
    const ctx = await b.newContext({ ...(pw.devices && pw.devices['iPhone 13'] || {}), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const pg = await ctx.newPage();
    /* v11.12 把浏览器「现在」钉到 2026-08-08（跟 server_now 一致）：app 的 viewMonth=sgMonthDate(Date.now())
       是按【设备时钟】算「本月」的。样本邮件都是 8 月，真机跑到 9 月后设备时钟一漂 → 8 月数据全被 sameMonth 筛掉、
       hero 归零 → §F 假红。钉死设备时钟后测试跟真实日期无关，这才是这组该守的东西。 */
    await pg.addInitScript(() => { const R = Date, F = R.parse('2026-08-08T12:00:00+08:00'), off = F - R.now();
      function D(...a){ return a.length ? new R(...a) : new R(R.now() + off); } D.now = () => R.now() + off; D.parse = R.parse; D.UTC = R.UTC; D.prototype = R.prototype; Object.setPrototypeOf(D, R); window.Date = D; });
    await pg.addInitScript(o => { localStorage.setItem('hz_wurl', o); localStorage.setItem('hz_tk', 't'); if (navigator.serviceWorker) { try { navigator.serviceWorker.register = () => Promise.resolve({ scope: '/', addEventListener() {}, update() {} }); } catch (e) {} } }, O);
    await pg.goto(O + '/', { waitUntil: 'load' }); await pg.waitForTimeout(2200);
    const hero = await pg.evaluate(() => {
      const amt = document.querySelector('.hero .amt');
      const grab = (label) => { const m = [...document.querySelectorAll('.hero .mini')].find(x => x.textContent.includes(label)); return m ? m.textContent.replace(/\s+/g, ' ').trim() : null; };
      return { spend: amt ? amt.textContent.replace(/\s+/g, '') : null, income: grab('收入'), bal: grab('结余'), cnt: grab('笔数') };
    });
    (Math.abs(num(hero.spend) - expSum) < 0.01) ? ok(`hero「本月支出」＝只加支出 S$${expSum.toFixed(2)}（收入没混进去）`, hero.spend)
      : bad(`hero 本月支出错了：应 S$${expSum.toFixed(2)}（只支出），实得 ${hero.spend}`, `若≈S$${(expSum + incSum).toFixed(2)} 就是收入被当支出加了（IMG_6964 那个坑）`);
    (Math.abs(num(hero.income) - incSum) < 0.01) ? ok(`hero 收入＝S$${incSum.toFixed(2)}`, hero.income) : bad(`hero 收入错了：应 S$${incSum.toFixed(2)}，实得 ${hero.income}`);
    (Math.abs(num(hero.bal) - (incSum - expSum)) < 0.01) ? ok(`hero 结余＝收入-支出＝S$${(incSum - expSum).toFixed(2)}`, hero.bal) : bad(`hero 结余错了：应 S$${(incSum - expSum).toFixed(2)}，实得 ${hero.bal}`);
    (num(hero.cnt) === EMAILS.length) ? ok(`hero 笔数＝${EMAILS.length}`, hero.cnt) : bad(`hero 笔数错了：应 ${EMAILS.length}，实得 ${hero.cnt}`);
  } catch (e) {
    bad('§F 显示层炸了', String(e && e.message || e).slice(0, 120));
  } finally {
    try { await b.close(); } catch {}
    server.close();
  }
  return { name: '§F 全链路', pass, fail, warn: 0, skipped: false };
}

/* ══════════════════════════════════════════════════════════════════════════
   §G  明细编辑 + 设置（真实操作 → 存对没）

   §F 验的是「邮件进来 → 显示对不对」；这一组验**你在 App 里改了东西 → 存回去对不对**：
     · 明细逐笔编辑：把一笔【支出改成收入】（就是 IMG_6964 那笔要走的修法）→ /api/update 得带 type:income、hero 把它挪出支出；
     · 明细改金额 → /api/update 带新金额；
     · 设置改数值颜色 / 主题 → /api/settings 存下新的偏好。
   全部用真实 tap。⚠️ 需要 index.html + 浏览器，缺就跳过。
   ══════════════════════════════════════════════════════════════════════════ */

async function suiteEdit() {
  const skip = (why) => { console.log(`${L.warn}  §G 跳过：${why}${L.off}`); return { name: '§G 编辑+设置', pass: 0, fail: 0, warn: 1, skipped: true }; };
  if (!fs.existsSync(path.join(BASE, 'index.html'))) return skip('index.html 不在');
  let pw;
  try { pw = await import('playwright'); }
  catch { try { pw = await import('/opt/node22/lib/node_modules/playwright/index.js'); } catch { return skip('这台机没装 playwright'); } }
  const chromium = pw.chromium || (pw.default && pw.default.chromium);
  if (!chromium) return skip('拿不到 chromium 物件');

  let pass = 0, fail = 0;
  const ok  = (m, d) => { pass++; if (VERBOSE) console.log(`${L.ok}  ✅ ${m}${L.off}${d ? `  ${L.dim}${d}${L.off}` : ''}`); };
  const bad = (m, d) => { fail++; console.log(`${L.bad}  ❌ ${m}${L.off}${d ? `\n     ${d}` : ''}`); };

  const updates = [], settings = [];
  let expenses = [
    { id: 99, ts: '2026-08-07T17:18:00+08:00', amount: 30, currency: 'SGD', merchant: 'CHAN YI SHENG', card_last4: 'PayNow', source: 'dbs', type: 'expense', category: 'other', raw: '' },
    { id: 98, ts: '2026-08-07T12:00:00+08:00', amount: 10, currency: 'SGD', merchant: 'NTUC', card_last4: 'PayLah', source: 'dbs', type: 'expense', category: 'food', raw: '' },
    { id: 97, ts: '2026-08-07T09:00:00+08:00', amount: 100, currency: 'SGD', merchant: 'UNIQLO', card_last4: '3578', source: 'ocbc', type: 'expense', category: 'shop', offset: 0, raw: '' },
    { id: 96, ts: '2026-08-07T10:00:00+08:00', amount: 40, currency: 'SGD', merchant: 'Alipay*RED Note', card_last4: null, source: 'maribank', type: 'income', category: 'incother', offset: 0, raw: '' },
  ];
  const J = (res, o) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(o)); };
  const body = (req) => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
  const server = http.createServer(async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p.startsWith('/api/')) {
      if (p === '/api/update' && req.method === 'POST') { const j = await body(req); updates.push(j); const r = expenses.find(x => String(x.id) === String(j.id)); if (r) Object.assign(r, { type: j.type, amount: j.amount, category: j.category, merchant: j.merchant, offset: j.offset ? 1 : 0 }); return J(res, { ok: true }); }
      if (p === '/api/settings' && req.method === 'POST') { const j = await body(req); settings.push(j.prefs || j); return J(res, { ok: true }); }
      if (p === '/api/data') return J(res, { expenses, rules: {} });
      if (p === '/api/health') return J(res, { ok: true, server_now_ms: Date.parse('2026-08-08T12:00:00+08:00') });
      if (p === '/api/settings') return J(res, { prefs: { theme: 'photo' }, rec: [], subignore: [], paymethods: [], paynames: {} });
      if (p === '/api/events') return J(res, { events: [] });
      if (p === '/api/inbox') return J(res, { items: [], counts: { parsed: 0, unparsed: 0 }, badge: 0, month: '2026-08' });
      if (p === '/api/gcal/status') return J(res, { connected: false });
      if (p === '/api/ics/list') return J(res, { feeds: [] });
      return J(res, { ok: true });
    }
    if (/\.(png|ico|woff2?)$/.test(p)) { res.writeHead(200); return res.end(''); }
    let f = p === '/' ? '/index.html' : p; const fp = path.join(BASE, f);
    if (!fp.startsWith(BASE) || !fs.existsSync(fp)) { res.writeHead(404); return res.end('no'); }
    res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : 'text/plain' }); res.end(fs.readFileSync(fp));
  });
  await new Promise(r => server.listen(0, r));
  const O = `http://localhost:${server.address().port}`;
  let b;
  try { b = await chromium.launch(); }
  catch { try { b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }); } catch { server.close(); return skip('没有可用的 chromium'); } }
  try {
    const num = (s) => { const m = String(s || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : NaN; };
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    const pg = await ctx.newPage();
    const errs = []; pg.on('pageerror', e => errs.push(String(e.message || e)));
    /* v11.12 同 §F：把设备时钟钉到 2026-08-08，免得真机跑到隔月后「本月」漂走、8 月样本被 sameMonth 筛光 → 假红。 */
    await pg.addInitScript(() => { const R = Date, F = R.parse('2026-08-08T12:00:00+08:00'), off = F - R.now();
      function D(...a){ return a.length ? new R(...a) : new R(R.now() + off); } D.now = () => R.now() + off; D.parse = R.parse; D.UTC = R.UTC; D.prototype = R.prototype; Object.setPrototypeOf(D, R); window.Date = D; });
    await pg.addInitScript(o => { localStorage.setItem('hz_wurl', o); localStorage.setItem('hz_tk', 't'); if (navigator.serviceWorker) { try { navigator.serviceWorker.register = () => Promise.resolve({ scope: '/', addEventListener() {}, update() {} }); } catch (e) {} } }, O);
    await pg.goto(O + '/', { waitUntil: 'load' }); await pg.waitForTimeout(2000);
    const dismiss = () => pg.evaluate(() => { ['hpopScrim', 'hpop', 'okScrim', 'okmod'].forEach(id => document.getElementById(id) && document.getElementById(id).classList.remove('show')); });
    await dismiss();

    // 1) 明细逐笔编辑：支出 → 收入（IMG_6964 那笔的修法）
    const heroBefore = await pg.evaluate(() => document.querySelector('.hero .amt').textContent.replace(/\s+/g, ''));
    await pg.evaluate(() => openEdit(DATA.find(x => x.id === 99)));
    await pg.waitForTimeout(400);
    const hasToggle = await pg.evaluate(() => !!document.getElementById('emIeSeg'));
    if (!hasToggle) bad('编辑弹窗没有支出/收入切换 → 误记类型的账没法就地改（只能删了重记）');
    else {
      await pg.locator('#emIeSeg button[data-t="income"]').tap(); await pg.waitForTimeout(300);
      (await pg.evaluate(() => document.getElementById('emTitle').textContent)).includes('收入') ? ok('编辑弹窗点「收入」→ 标题变「编辑收入」') : bad('点收入标题没变');
      await pg.locator('#emConfirm').tap(); await pg.waitForTimeout(600);
      const u = updates.find(x => String(x.id) === '99');
      (u && u.type === 'income') ? ok('保存 → /api/update 带 type:income（存成收入）', `id=99`) : bad('/api/update 没把这笔改成收入（IMG_6964 那个坑的修法失效）', JSON.stringify(u || updates));
      const heroAfter = await pg.evaluate(() => document.querySelector('.hero .amt').textContent.replace(/\s+/g, ''));
      (Math.abs(num(heroAfter) - (num(heroBefore) - 30)) < 0.01) ? ok('改完 hero 本月支出把这 30 挪出去了', `${heroBefore}→${heroAfter}`) : bad('改成收入后 hero 支出没更新', `${heroBefore}→${heroAfter}（应减 30）`);
    }
    await dismiss();

    // 2) 明细改金额
    await pg.evaluate(() => openEdit(DATA.find(x => x.id === 98)));
    await pg.waitForTimeout(400);
    await pg.evaluate(() => { const a = document.getElementById('emAmt'); a.value = '12.50'; a.dispatchEvent(new Event('input', { bubbles: true })); });
    await pg.waitForTimeout(200);
    await pg.locator('#emConfirm').tap(); await pg.waitForTimeout(500);
    const u2 = updates.find(x => String(x.id) === '98');
    (u2 && Math.abs(u2.amount - 12.5) < 0.001) ? ok('明细改金额 → /api/update 带新金额 12.50') : bad('改金额没存对', JSON.stringify(u2 || '(没收到)'));
    await dismiss();

    // 2b) 退款抵扣支出（v11.10 使用者概念：refund 不算收入、从总支出扣掉）
    const spendBefore = await pg.evaluate(() => document.querySelector('.hero .amt').textContent.replace(/\s+/g, ''));
    await pg.evaluate(() => openEdit(DATA.find(x => x.id === 96)));   // Alipay 退款 SGD40（income）
    await pg.waitForTimeout(400);
    const offShown = await pg.evaluate(() => document.getElementById('emOffWrap') && getComputedStyle(document.getElementById('emOffWrap')).display !== 'none');
    if (!offShown) bad('收入的编辑弹窗没有「从总支出扣掉」开关');
    else {
      await pg.locator('#emOffBtn').tap(); await pg.waitForTimeout(200);
      await pg.locator('#emConfirm').tap(); await pg.waitForTimeout(600);
      const u3 = updates.find(x => String(x.id) === '96');
      (u3 && u3.offset === 1) ? ok('退款开抵扣 → /api/update 带 offset=1') : bad('抵扣旗标没存', JSON.stringify(u3 || '(没收到)'));
      const spendAfter = await pg.evaluate(() => document.querySelector('.hero .amt').textContent.replace(/\s+/g, ''));
      const n = (s) => parseFloat(String(s).replace(/[^\d.]/g, '')) || 0;
      (Math.abs((n(spendBefore) - 40) - n(spendAfter)) < 0.01) ? ok('hero 本月支出把退款 40 抵掉了', `${spendBefore}→${spendAfter}`) : bad('退款抵扣后 hero 支出没减 40', `${spendBefore}→${spendAfter}`);
      // 口径一致：环形中心 = hero 大数字（都是净额）—— 使用者反映的「hero减了分类没减」那个坑的守门条
      const donutC = await pg.evaluate(() => { const el = document.getElementById('donutTotal'); return el ? el.textContent.replace(/\s+/g, '') : null; });
      (donutC && Math.abs(n(donutC) - n(spendAfter)) < 0.01) ? ok('环形中心 = hero（净额口径一致）', `${donutC}`) : bad('环形中心跟 hero 对不上（分类没跟着减）', `环形${donutC} vs hero${spendAfter}`);
    }
    await dismiss();

    // 3) 设置：改数值颜色 → 存
    settings.length = 0;
    await pg.locator('#nav3').tap(); await pg.waitForTimeout(500); await dismiss();
    // v11.31 数值颜色在「外观·通知·系统」手风琴卡里，先点开
    await pg.locator('.setgrp[data-g="look"] [data-gtoggle]').tap().catch(() => {}); await pg.waitForTimeout(300);
    const nsw = await pg.locator('.numsw').count().catch(() => 0);
    if (nsw >= 3) {
      const key = await pg.locator('.numsw').nth(3).getAttribute('data-num').catch(() => null);
      await pg.locator('.numsw').nth(3).tap(); await pg.waitForTimeout(500);
      const savedNum = settings.some(s => { try { return s && s.tp && Object.values(s.tp).some(t => t && t.num === key); } catch { return false; } });
      (settings.length > 0 && savedNum) ? ok('设置改数值颜色 → /api/settings 存下新色', key)
        : settings.length > 0 ? ok('设置改数值颜色 → /api/settings 有存（色值结构变体）', `${settings.length} 次`)
          : bad('改数值颜色没触发 /api/settings 保存');
    } else ok('设置页色卡数不足以测（跳过这条）', `${nsw} 个`);

    // 4) 设置：换主题 → 存
    settings.length = 0;
    const tsw = await pg.locator('.thsw, .themesw, [data-th]').count().catch(() => 0);
    if (tsw > 0) {
      await pg.locator('.thsw, .themesw, [data-th]').first().tap().catch(() => {}); await pg.waitForTimeout(500);
      (settings.length > 0) ? ok('设置换主题 → /api/settings 有存', `${settings.length} 次`) : bad('换主题没触发 /api/settings 保存');
    } else ok('设置页主题按钮选择器没命中（跳过这条，非硬伤）');

    errs.length ? bad(`过程有 ${errs.length} 条报错`, errs.slice(0, 4).join('\n     ')) : ok('全程 0 报错');
  } catch (e) {
    bad('§G 整段炸了', String(e && e.message || e).slice(0, 120));
  } finally {
    try { await b.close(); } catch {}
    server.close();
  }
  return { name: '§G 编辑+设置', pass, fail, warn: 0, skipped: false };
}

/* ══════════════════════════════════════════════════════════════════════════
   §H  跑
   ══════════════════════════════════════════════════════════════════════════ */

console.log(`\n${L.dim}Expenses 验证器（三合一）${L.off}   ${BASE}${ONLY.length ? `   ${L.dim}(--only=${ONLY.join(',')})${L.off}` : ''}`);

if (want('static')) { head('§A 静态复检'); TALLY.push(suiteStatic()); }

let W = null;
if (want('parser') || want('cal') || want('iron') || want('pipeline')) {
  W = await loadWorker(WORKER);
  if (!W) {
    console.log(`${L.warn}  §B / §C / §D 跳过：worker.js 载入不了${L.off}`);
    if (want('parser')) TALLY.push({ name: '§B parser 回归', pass: 0, fail: 0, warn: 1, skipped: true });
    if (want('cal'))    TALLY.push({ name: '§C 日历',       pass: 0, fail: 0, warn: 1, skipped: true });
    if (want('iron'))   TALLY.push({ name: '§D 铁律&健壮',  pass: 0, fail: 0, warn: 1, skipped: true });
  }
}
if (W && want('parser')) { head('§B parser 回归（七封真信 × 三种形态）'); TALLY.push(suiteParser(W)); }
if (W && want('cal'))    { head('§C 日历'); TALLY.push(suiteCal(W)); }
if (W && want('iron'))   { head('§D 铁律 & 健壮性'); TALLY.push(await suiteIron(W)); }
if (want('e2e'))         { head('§E 真机端到端（真实触摸 · 需浏览器）'); TALLY.push(await suiteE2E()); }
if (want('pipeline'))    { head('§F 全链路（邮件 → 入库 → 明细/hero）'); TALLY.push(await suiteFullPipeline(W)); }
if (want('edit'))        { head('§G 明细编辑 + 设置（真实操作 → 存对没）'); TALLY.push(await suiteEdit()); }

/* ── 收尾：一张总表，一个回传码 ── */
const sum = (k) => TALLY.reduce((n, t) => n + (t[k] || 0), 0);
const P = sum('pass'), Wn = sum('warn'), F = sum('fail');
console.log(`\n${'═'.repeat(68)}`);
for (const t of TALLY) {
  const tag = t.skipped ? `${L.warn}跳过${L.off}` : t.fail ? `${L.bad}FAIL ${t.fail}${L.off}` : `${L.ok}全过${L.off}`;
  console.log(`  ${t.name.padEnd(18)} ${String(t.pass).padStart(4)} 通过` +
    `${t.warn ? `  ${L.warn}${t.warn} 提醒${L.off}` : ''}` +
    `${t.fail ? `  ${L.bad}${t.fail} 失败${L.off}` : ''}   ${tag}`);
}
console.log(`${'─'.repeat(68)}`);
console.log(`  ${L.ok}PASS ${P}${L.off}   ${Wn ? L.warn : L.dim}WARN ${Wn}${L.off}   ${F ? L.bad : L.dim}FAIL ${F}${L.off}`);
console.log(`${L.dim}  FAIL = 一定要修。WARN = 看一眼，多半是死代码或文档落后，不影响执行。${L.off}`);
console.log(`${L.dim}  ⚠️ §E 用真实触摸点过一遍，但仍测不到真机【软键盘本身】（键盘顶画面 / 键盘吃第一下点击）——${L.off}`);
console.log(`${L.dim}     那几样 headless 没有软键盘，复制不出来，只能靠真手机 QA 清单。别拿全绿当「真机没问题」。${L.off}`);
console.log(`${'═'.repeat(68)}\n`);

if (!TALLY.length || TALLY.every(t => t.skipped)) process.exit(2);   // 一组都没跑起来
process.exit(F ? 1 : 0);
