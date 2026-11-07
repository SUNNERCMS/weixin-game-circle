/**
 * 开放数据域单元测试（open-data/ + game.json 的 openDataContext）
 *
 * 作用：守住开放数据域的**契约**。
 *      一部分断言读的是**项目文件本身**（不需要微信环境 —— 任何机器上都能跑），
 *      一部分用假 wx 把开放数据域的拉取 / 消息 / 降级跑一遍。
 *
 * 守护的东西：
 *   1. game.json 声明了 openDataContext，且指向的目录真实存在
 *      （拼错目录名不会报错，只会让开放数据域静默不加载 —— 这种失败最难查）
 *   2. 开放数据域是独立沙盒：不得引用主域符号、不得发网络请求、
 *      require 只能指向**同目录**（主域 ↔ 开放域互相 require 是平台禁止的）
 *   3. P4 起开放数据域**必须**拉好友数据（wx.getFriendCloudStorage / wx.getUserCloudStorage）
 *   4. 拉不到 / 未授权 / 画布异常 → 都不抛错、不空白
 *   5. 打包产物不含云函数源码（P6 的前置条件，提前守）
 *
 * 运行：node unit/opendata.test.js   （退出码非 0 = 有用例失败）
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')); }
}
function section(title) { console.log('\n========== ' + title + ' =========='); }

const root = path.join(__dirname, '../../who-is-circle');
const gameJsonPath = path.join(root, 'game.json');
const gameJson = JSON.parse(fs.readFileSync(gameJsonPath, 'utf8'));

section('一、game.json 的 openDataContext');

ok(typeof gameJson.openDataContext === 'string' && gameJson.openDataContext.length > 0,
  'game.json 声明了 openDataContext',
  gameJson.openDataContext ? '值=' + gameJson.openDataContext : '缺失');

const dirName = gameJson.openDataContext;
ok(dirName && !dirName.includes('/') && !dirName.includes('\\'),
  'openDataContext 是子目录名而非路径', dirName || '(无)');

const odDir = dirName ? path.join(root, dirName) : null;
ok(odDir && fs.existsSync(odDir) && fs.statSync(odDir).isDirectory(),
  'openDataContext 指向的目录真实存在', dirName ? dirName + '/' : '(无)');

section('二、开放数据域入口文件');

const odIndex = odDir ? path.join(odDir, 'index.js') : null;
ok(odIndex && fs.existsSync(odIndex), '开放数据域入口 index.js 存在',
  odIndex ? path.basename(odIndex) : '(无)');

const odBoard = odDir ? path.join(odDir, 'board.js') : null;
ok(odBoard && fs.existsSync(odBoard), '榜面纯逻辑 board.js 存在（同目录 require，平台允许）',
  odBoard ? path.basename(odBoard) : '(无)');
ok(odBoard && odBoard !== odIndex, 'board.js 与 index.js 是两个文件（纯逻辑与 wx 管道分开）');

let odSrc = '';
if (odIndex && fs.existsSync(odIndex)) odSrc = fs.readFileSync(odIndex, 'utf8');

// 剥离注释与字符串字面量后再做"禁止出现某 API"的断言 ——
// 否则文件头那段解释沙盒限制的注释里写着 "wx.request"，会把测试自己搞红。
// 字符串字面量要保留：URL 检查得看得到代码里真实的字符串。
function stripComments(src) {
  const literals = [];
  let s = src.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, function (m) {
    literals.push(m);
    return '\u0000' + (literals.length - 1) + '\u0000';
  });
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');              // 块注释
  s = s.replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');      // 行注释
  return s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return literals[+i]; });
}
const odCode = stripComments(odSrc);

ok(/\.getSharedCanvas\s*\(/.test(odCode), 'index.js 通过 wx 的 getSharedCanvas 取离屏画布');

section('三、开放数据域的沙盒隔离');

ok(!/\bgetApp\s*\(/.test(odCode), 'index.js 不调用 getApp（主域对象）');
ok(!/\bwx\.request\b/.test(odCode), 'index.js 不发网络请求（开放数据域无此能力）');

// require 只允许同目录（./ 开头）。主域 ↔ 开放域互相 require 是平台禁止的，
// 一旦写了 '../' 就会在真机上炸（而且是整个开放数据域加载失败，榜面一片空白）。
const requires = odCode.match(/require\s*\(\s*['"][^'"]+['"]\s*\)/g) || [];
ok(requires.length > 0, 'index.js 用 require 引同目录的 board.js', requires.join(' '));
const badRequire = requires.filter(r => !/require\s*\(\s*['"]\.\//.test(r));
ok(badRequire.length === 0, '**require 只指向同目录**（没有 ../ 越界）',
  badRequire.length ? badRequire.join(' ') : requires.join(' '));

section('四、打包产物边界');

const projCfg = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'));
const ignoreVals = ((projCfg.packOptions && projCfg.packOptions.ignore) || []).map(x => x.value);

ok(ignoreVals.includes('index.html'), 'index.html 被排除出小程序包（浏览器端调试文件）');
ok(!(odDir && ignoreVals.includes(dirName)),
  '开放数据域目录未被误排除（排掉它开放数据域就不加载了）', dirName || '(无)');

// 云函数源码含服务端逻辑，不该进客户端包。
// 不变式不是"目录不存在"（P2 起它就存在了），而是"目录在，就必须被排除"。
// 靠开发者工具的隐式默认行为不算数 —— 显式声明才可验证。
ok(ignoreVals.includes('cloudfunctions'),
  'cloudfunctions/ 被显式排除出小程序包（服务端源码不进客户端包）');

section('五、sharedCanvas 的降级矩阵');

const G = require('../../who-is-circle/game.js');

ok(typeof G.resolveSharedCanvas === 'function', 'game.js 导出了 resolveSharedCanvas');

ok(G.resolveSharedCanvas(undefined) === null, '没有 wx（浏览器 / Node）→ null');
ok(G.resolveSharedCanvas(null) === null, 'wx 为 null → null');
ok(G.resolveSharedCanvas({}) === null, '老基础库没有 getOpenDataContext → null');
ok(G.resolveSharedCanvas({ getOpenDataContext: function () { throw new Error('boom'); } }) === null,
  'getOpenDataContext 抛异常 → null（不能把异常抛到主玩法里）');
ok(G.resolveSharedCanvas({ getOpenDataContext: function () { return {}; } }) === null,
  '返回对象里没有 canvas → null');

const fakeCanvas = { width: 500, height: 96 };
ok(G.resolveSharedCanvas({ getOpenDataContext: function () { return { canvas: fakeCanvas }; } }) === fakeCanvas,
  '正常情况 → 原样返回 sharedCanvas');

// ---------------------------------------------------------------------------
// 六、P4：拉好友数据 + 消息驱动（用假 wx 跑一遍）
// ---------------------------------------------------------------------------

function makeCtx() {
  const calls = [];
  return {
    calls: calls,
    font: '28px sans-serif', fillStyle: '', strokeStyle: '', globalAlpha: 1, lineWidth: 1,
    textAlign: '', textBaseline: '',
    // 记录 setTransform —— 要能断言「卡片没被平移出屏幕」
    // （setTransform 的 e 是 X 平移、f 才是 Y 平移，位置搞错过一次，
    //   真机表现为屏幕上只剩一条窄边）
    _tf: null,
    setTransform(a, b, c, d, e, f) { this._tf = { a: a, b: b, c: c, d: d, e: e, f: f }; },
    save() {}, restore() {}, translate() {}, scale() {},
    beginPath() {}, closePath() {}, fill() {}, stroke() {}, arc() {}, drawImage() {},
    // 真 canvas 有的路径与渐变 API（榜面绘制会用到；少了就 TypeError）
    moveTo() {}, lineTo() {}, arcTo() {}, quadraticCurveTo() {}, rect() {}, clip() {},
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
    setLineDash() {}, shadowBlur: 0, shadowColor: '', shadowOffsetX: 0, shadowOffsetY: 0,
    fillRect(x, y, w, h) { calls.push({ op: 'fillRect', x: x, y: y, w: w, h: h }); },
    fillText(t, x, y) { calls.push({ op: 'fillText', t: String(t), x: x, y: y }); },
    measureText(t) { return { width: String(t == null ? '' : t).length * 14 }; }
  };
}

function hosting(score, level, v) {
  const o = { wxgame: { score: Math.round(score * 10), update_time: 1780000000 }, level: level };
  if (v) o.v = v;
  return JSON.stringify(o);
}
function friendEntry(openid, nickname, score, level) {
  return {
    openid: openid, nickname: nickname, avatarUrl: 'https://wx.qlogo.cn/mmopen/' + openid + '/0',
    KVDataList: [{ key: 'circle', value: hosting(score, level) }]
  };
}

function makeFakeWx(opts) {
  opts = opts || {};
  const calls = { friend: 0, self: 0, onMessage: null, images: 0 };
  const ctx = makeCtx();
  const canvas = {
    width: 0, height: 0,
    getContext: function () { return ctx; }
  };
  const wx = {
    calls: calls,
    ctx: ctx,
    canvas: canvas,
    getFriendCloudStorage: function (o) {
      calls.friend++;
      if (opts.friendFail) { if (o.fail) o.fail({ errMsg: 'getFriendCloudStorage:fail' }); return; }
      if (o.success) o.success({ data: opts.friends || [] });
    },
    getUserCloudStorage: function (o) {
      calls.self++;
      if (opts.selfFail) { if (o.fail) o.fail({ errMsg: 'getUserCloudStorage:fail' }); return; }
      if (o.success) o.success({ data: opts.self || [] });
    },
    getSharedCanvas: function () { return canvas; },
    createImage: function () {
      calls.images++;
      const img = { src: '', onload: null, onerror: null };
      return img;
    },
    getSystemInfoSync: function () { return { pixelRatio: 2 }; },
    onMessage: function (cb) { calls.onMessage = cb; }
  };
  return wx;
}

(async function main() {
  // 先装好假 wx 再 require —— index.js 见到 wx 会自动 bootstrap
  const fake = makeFakeWx({
    friends: [friendEntry('o_1', '小明', 97.8, 11), friendEntry('o_2', '小红', 92.4, 9)],
    self: [{ KVDataList: [{ key: 'circle', value: hosting(88, 9) }] }]
  });
  global.wx = fake;
  const OD = require('../../who-is-circle/open-data/index.js');

  section('六、开放数据域的拉取');

  ok(typeof OD.pull === 'function', 'index.js 导出 pull');
  ok(typeof OD.handleMessage === 'function', 'index.js 导出 handleMessage');
  ok(typeof OD.render === 'function', 'index.js 导出 render');
  ok(!!fake.calls.onMessage, '加载时自动注册了 wx.onMessage（主域 → 开放域单向通道）');

  {
    const res = await OD.pull(fake, 'circle');
    ok(res && Array.isArray(res.rows), 'pull 返回 rows', res ? 'len=' + res.rows.length : 'null');
    ok(res && res.rows.length === 3, '两个好友 + 自己 = 3 行', res ? 'len=' + res.rows.length : 'null');
    const self = res.rows.filter(r => r.isSelf);
    ok(self.length === 1 && self[0].score === 88, '自己那行 isSelf=true 且分是 88',
      self.length ? 'score=' + self[0].score : 'null');
    ok(res.rows[0].score === 97.8 && res.rows[0].rank === 1, '排第一的是 97.8',
      res.rows[0] ? 'score=' + res.rows[0].score + ' rank=' + res.rows[0].rank : 'null');
  }
  {
    // 好友失败 → 不抛，返回 error
    const bad = makeFakeWx({ friendFail: true, self: [{ KVDataList: [{ key: 'circle', value: hosting(88, 9) }] }] });
    let res = null, threw = false;
    try { res = await OD.pull(bad, 'circle'); } catch (e) { threw = true; }
    ok(!threw, '好友拉取失败 → 不抛异常');
    ok(res && !!res.error, '好友拉取失败 → 返回 error', res && res.error ? String(res.error) : '(无)');
    ok(res && res.rows.length === 1, '好友失败不影响自己的数据', res ? 'len=' + res.rows.length : 'null');
  }
  {
    // 自己失败 → 好友照常
    const bad = makeFakeWx({ selfFail: true, friends: [friendEntry('o_1', '小明', 97.8, 11)] });
    const res = await OD.pull(bad, 'circle');
    ok(res && res.rows.length === 1, '自己拉取失败 → 好友行照常返回', res ? 'len=' + res.rows.length : 'null');
    ok(res && res.rows.filter(r => r.isSelf).length === 0, '自己那行缺失（不冒充）');
  }
  {
    // 托管数据解析不出来 → 该行跳过，不占名次
    const junk = makeFakeWx({
      friends: [
        { openid: 'o_1', nickname: '坏数据', KVDataList: [{ key: 'circle', value: 'garbage' }] },
        friendEntry('o_2', '小明', 97.8, 11)
      ],
      self: []
    });
    const res = await OD.pull(junk, 'circle');
    ok(res && res.rows.length === 1 && res.rows[0].nickname === '小明',
      '解析失败的好友被跳过（不占名次）', res ? 'len=' + res.rows.length : 'null');
  }

  section('七、消息驱动');

  {
    const before = fake.calls.friend;
    fake.calls.onMessage({
      type: 'showLeaderboard', key: 'circle', width: 700, height: 1180, scale: 2,
      rankNames: ['灾难现场', '一团面条', '土豆', '饺子', '鸡蛋', '甜甜圈', '饼干', '轮胎', '满月', '圆规', '教科书', '精密仪器', '神之圆'],
      style: {}, selfScore: 80
    });
    await new Promise(r => setTimeout(r, 10));
    ok(fake.calls.friend > before, 'showLeaderboard → 触发了一次拉取',
      'friend ' + before + ' → ' + fake.calls.friend);
    ok(fake.ctx.calls.length > 0, 'sharedCanvas 上画了东西（不是空白）', 'calls=' + fake.ctx.calls.length);
    // 画布是**固定尺寸**（700×1180 设计px × scale），不随后续帧改 ——
    // 平台对共享画布的尺寸不一定照办（实测：被裁、且只涨不缩），
    // 固定尺寸就不会出现「加载中那帧定的高度留着 → 卡片下面多一条白带」。
    ok(fake.canvas.width === 1400 && fake.canvas.height === 2360,
      '画布固定 = 700×1180 设计px × scale', fake.canvas.width + '×' + fake.canvas.height);
  }
  {
    const before = fake.calls.friend;
    fake.calls.onMessage({ type: 'hideLeaderboard' });
    await new Promise(r => setTimeout(r, 10));
    ok(fake.calls.friend === before, 'hideLeaderboard → 不再拉取');
  }
  {
    let threw = false;
    try {
      fake.calls.onMessage({});
      fake.calls.onMessage(null);
      fake.calls.onMessage({ type: 'whatever' });
    } catch (e) { threw = true; }
    ok(!threw, '未知类型 / 空消息 → 不抛异常');
  }

  section('八、渲染降级');

  {
    let threw = false;
    try {
      OD.render(fake, { msg: null, rows: [], error: '' });
      OD.render(fake, { msg: { width: 0, height: 0 }, rows: [], error: '' });
      OD.render(null, { msg: null, rows: [], error: '' });
    } catch (e) { threw = true; }
    ok(!threw, '没有消息 / 尺寸为 0 / wx 为 null → 都不抛异常');
  }
  {
    // 拉取失败 → 画「读不到」，不是空白
    const bad = makeFakeWx({ friendFail: true });
    global.wx = bad;
    const res = await OD.pull(bad, 'circle');
    const OD2 = require('../../who-is-circle/open-data/index.js');
    OD2.render(bad, { msg: { width: 700, height: 1180, pixelRatio: 2, rankNames: [] }, rows: res.rows, error: res.error });
    const texts = bad.ctx.calls.filter(c => c.op === 'fillText').map(c => c.t);
    ok(texts.some(t => t.indexOf('读不到') >= 0), '拉取失败 → 画「暂时读不到好友数据」',
      texts.join(' | ').slice(0, 60));
  }
  {
    // 头像加载失败 → 不崩
    const bad = makeFakeWx({
      friends: [friendEntry('o_1', '小明', 97.8, 11)],
      self: []
    });
    const res = await OD.pull(bad, 'circle');
    const OD3 = require('../../who-is-circle/open-data/index.js');
    let threw = false;
    try {
      OD3.render(bad, { msg: { width: 700, height: 1180, pixelRatio: 2, rankNames: [] }, rows: res.rows, error: '' });
    } catch (e) { threw = true; }
    ok(!threw, '头像加载失败 → 不崩');
  }

  section('八、画布尺寸跨帧不变（平台只涨不缩 → 卡片下面会多一条白带）');

{
  // 真机上踩过：平台对共享画布的尺寸不一定照办 —— 设了 700×1180 之后，
  // 后面再设更小的尺寸**不生效**（只涨不缩），于是"加载中"那帧定下的
  // 大画布一直留着，卡片只占上面一块 → 下面多出一条白带。
  // 所以画布必须是**固定尺寸**，每帧都一样。
  const RN = ['灾难现场', '一团面条', '土豆', '饺子', '鸡蛋', '甜甜圈', '饼干',
    '轮胎', '满月', '圆规', '教科书', '精密仪器', '神之圆'];
  const fake = makeFakeWx({
    friends: [friendEntry('o_1', '小明', 97.8, 11), friendEntry('o_2', '小红', 92.4, 9)],
    self: [{ KVDataList: [{ key: 'circle', value: hosting(88, 9) }] }]
  });
  global.wx = fake;
  delete require.cache[require.resolve('../../who-is-circle/open-data/index.js')];
  const OD = require('../../who-is-circle/open-data/index.js');
  const msg = { type: 'showLeaderboard', key: 'circle', width: 700, height: 1180, scale: 2,
    rankNames: RN, style: {} };
  OD.handleMessage(msg, fake);
  const w1 = fake.canvas.width, h1 = fake.canvas.height;
  // 数据到了之后再画一次（画布尺寸不能变）
  await new Promise((r) => setTimeout(r, 30));
  OD.handleMessage(msg, fake);
  ok(fake.canvas.width === w1 && fake.canvas.height === h1,
    '数据到了之后画布尺寸不变', w1 + '×' + h1 + ' → ' + fake.canvas.width + '×' + fake.canvas.height);
  ok(w1 === 1400 && h1 === 2360, '画布固定 = 700×1180 设计px × scale', w1 + '×' + h1);
}

section('九、跨域尺寸契约（主域 ↔ 开放域）');

{
  // ① 开放域：**不许有 X 平移**。
  //    setTransform(a,b,c,d,e,f) 里 e 是 X 平移、f 才是 Y 平移。
  //    之前把「垂直居中」的偏移塞进了 e → 整张卡片右移出屏幕，
  //    真机表现为「屏幕上只剩一条窄边」，本地完全测不出来（浏览器端没有开放数据域）。
  const RN2 = ['灾难现场', '一团面条', '土豆', '饺子', '鸡蛋', '甜甜圈', '饼干',
    '轮胎', '满月', '圆规', '教科书', '精密仪器', '神之圆'];
  const fake = makeFakeWx({
    friends: [friendEntry('o_1', '小明', 97.8, 11)],
    self: [{ KVDataList: [{ key: 'circle', value: hosting(88, 9) }] }]
  });
  global.wx = fake;
  delete require.cache[require.resolve('../../who-is-circle/open-data/index.js')];
  const OD = require('../../who-is-circle/open-data/index.js');
  OD.handleMessage({ type: 'showLeaderboard', key: 'circle', width: 700, height: 1180, scale: 2,
    rankNames: RN2, style: {} }, fake);
  await new Promise((r) => setTimeout(r, 40));
  const tf = fake.ctx._tf;
  ok(!!tf, '开放域设置过 transform');
  ok(tf && tf.e === 0, '**没有 X 平移**（卡片不会被推出屏幕）', tf ? ('e=' + tf.e) : '(无)');
  ok(tf && tf.f >= 0 && tf.f < fake.canvas.height,
    'Y 偏移在画布内（垂直居中没跑飞）', tf ? ('f=' + tf.f + ' / 画布高 ' + fake.canvas.height) : '(无)');
}

{
  // ② 主域：贴图宽度必须等于内容矩形的宽（700 设计px）。
  //    ⚠️ 不要除 view.scale —— sc.width 与 rect.w 是同一个量纲，
  //    除一次等于把卡片压扁（真机实测：卡片只有 77% 宽）。
  const G = require('../../who-is-circle/game.js');
  const rect = { x: 25, y: 210, w: 700, h: 1180 };
  // 位图 = 700×1180 设计px × 2（密度对上了）
  const pr = G.computePasteRect({ width: 1400, height: 2360 }, rect);
  ok(pr.w === 700, '贴图宽度 = 700 设计px（不缩不放）', String(pr.w));
  ok(pr.h === 1180, '贴图高度按位图宽高比 = 1180', String(pr.h));
  ok(pr.x === 25 && pr.y === 210, '贴图位置 = 内容矩形左上角', pr.x + ',' + pr.y);

  // 位图比例不一样时：等比缩进矩形，不能变形
  const pr2 = G.computePasteRect({ width: 700, height: 1180 }, rect);
  ok(pr2.w === 700 && pr2.h === 1180, '1:1 的位图 → 原尺寸贴', pr2.w + '×' + pr2.h);
  const pr3 = G.computePasteRect({ width: 700, height: 350 }, rect);
  ok(Math.abs(pr3.w / pr3.h - 2) < 0.01, '扁位图 → 等比缩（不变形）', pr3.w + '×' + pr3.h);
  const pr4 = G.computePasteRect({ width: 700, height: 5000 }, rect);
  ok(pr4.h <= 1180 && pr4.w <= 700, '高位图 → 缩进矩形内', pr4.w + '×' + pr4.h);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})();
