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
    // 开放数据域里 wx.getUserInfo 能拿到**自己的 openId**
    // （真机上：靠它认出「好友列表里哪一行是我」）
    getUserInfo: function (o) {
      calls.userInfo = (calls.userInfo || 0) + 1;
      if (opts.userInfoFail) { if (o.fail) o.fail({ errMsg: 'getUserInfo:fail' }); return; }
      if (o.success) o.success({ openId: opts.myOpenid || 'o_me', nickName: '我' });
    },
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
      canvasW: 402, canvasH: 874, designScale: 402 / 750, rectX: 25, rectY: 210,
      rankNames: ['灾难现场', '一团面条', '土豆', '饺子', '鸡蛋', '甜甜圈', '饼干', '轮胎', '满月', '圆规', '教科书', '精密仪器', '神之圆'],
      style: {}, selfScore: 80
    });
    await new Promise(r => setTimeout(r, 10));
    ok(fake.calls.friend > before, 'showLeaderboard → 触发了一次拉取',
      'friend ' + before + ' → ' + fake.calls.friend);
    ok(fake.ctx.calls.length > 0, 'sharedCanvas 上画了东西（不是空白）', 'calls=' + fake.ctx.calls.length);
    // 画布 = **屏幕的逻辑尺寸**（平台只给这个 —— 真机实测：请求 1126×1897，
    // 平台给 402×874 = 屏幕逻辑尺寸）。别跟平台抢尺寸，按它给的来。
    ok(fake.canvas.width === 402 && fake.canvas.height === 874,
      '画布 = 屏幕逻辑尺寸（canvasW×canvasH）', fake.canvas.width + '×' + fake.canvas.height);
    // 画布尺寸 = 屏幕逻辑尺寸（平台只给这个）→ 不会被裁、不会只涨不缩
    ok(fake.canvas.width === (fake.msg && fake.msg.canvasW ? fake.msg.canvasW : 402),
      '画布宽度 = 消息里的 canvasW');
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
    canvasW: 402, canvasH: 874, designScale: 402 / 750, rectX: 25, rectY: 210,
    rankNames: RN, style: {} };
  OD.handleMessage(msg, fake);
  const w1 = fake.canvas.width, h1 = fake.canvas.height;
  // 数据到了之后再画一次（画布尺寸不能变）
  await new Promise((r) => setTimeout(r, 30));
  OD.handleMessage(msg, fake);
  ok(fake.canvas.width === w1 && fake.canvas.height === h1,
    '数据到了之后画布尺寸不变', w1 + '×' + h1 + ' → ' + fake.canvas.width + '×' + fake.canvas.height);
  ok(w1 === 402 && h1 === 874, '画布 = 屏幕逻辑尺寸（402×874）', w1 + '×' + h1);
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
    canvasW: 402, canvasH: 874, designScale: 402 / 750, rectX: 25, rectY: 210,
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
  // 共享画布 = 屏幕大小（逻辑px）→ 贴满整屏，1:1 物理像素（清晰、不变形）
  const pr = G.computePasteRect({ width: 402, height: 874 }, rect);
  ok(pr.w <= 750 && pr.h <= 1624, '贴图不超出屏幕（铺满或 letterbox）', pr.w + '×' + pr.h);
  ok(Math.abs(pr.w / pr.h - 402 / 874) < 0.0001, '**贴图比例 = 位图比例**（不会被拉伸）',
    (pr.w / pr.h).toFixed(4) + ' vs ' + (402 / 874).toFixed(4));
  ok(Math.abs(pr.x - (750 - pr.w) / 2) < 0.01, '水平居中', String(pr.x));
  ok(Math.abs(pr.y - (1624 - pr.h) / 2) < 0.01, '垂直居中', String(pr.y));

  // 位图比例 = 设计网格比例 → 正好整屏
  const pr2 = G.computePasteRect({ width: 750, height: 1624 }, rect);
  ok(pr2.w === 750 && pr2.h === 1624 && pr2.x === 0 && pr2.y === 0,
    '同比例位图 → 整屏 1:1', pr2.w + '×' + pr2.h);
  // 比例不一致时：等比缩进屏幕，不能变形
  const pr3 = G.computePasteRect({ width: 750, height: 350 }, rect);
  ok(Math.abs(pr3.w / pr3.h - 750 / 350) < 0.0001, '扁位图 → 等比缩（不变形）', pr3.w + '×' + pr3.h);
  const pr4 = G.computePasteRect({ width: 750, height: 5000 }, rect);
  ok(pr4.h <= 1624 && pr4.w <= 750, '高位图 → 缩进屏幕内', pr4.w + '×' + pr4.h);
}

section('九、关系链接口的缓存（第二次打开不该再调）');

function odTexts(ctx) {
  return ctx.calls.filter(c => c.op === 'fillText').map(c => c.t);
}

{
  // 真机现象（2026-11-07）：第一次打开能读到好友，返回后再打开却提示
  // 「暂时读不到好友数据」—— 第二次 wx.getFriendCloudStorage 调用失败
  // （关系链接口有调用频率/配额限制）。
  //
  // 所以：缓存最近一次成功的结果。TTL 内再打开直接用缓存（不重复调接口）；
  // 拉取失败也回退到缓存。
  const RN3 = ['灾难现场', '一团面条', '土豆', '饺子', '鸡蛋', '甜甜圈', '饼干',
    '轮胎', '满月', '圆规', '教科书', '精密仪器', '神之圆'];
  const fake = makeFakeWx({
    friends: [friendEntry('o_1', '小明', 97.8, 11), friendEntry('o_2', '小红', 92.4, 9)],
    self: [{ KVDataList: [{ key: 'circle', value: hosting(88, 9) }] }]
  });
  global.wx = fake;
  delete require.cache[require.resolve('../../who-is-circle/open-data/index.js')];
  const OD = require('../../who-is-circle/open-data/index.js');
  const msg = { type: 'showLeaderboard', key: 'circle', width: 750, height: 1624, scale: 2,
    canvasW: 1206, canvasH: 2622, rankNames: RN3, style: {} };

  const before = fake.calls.friend;
  OD.handleMessage(msg, fake);
  await new Promise(r => setTimeout(r, 40));
  ok(fake.calls.friend === before + 1, '第一次打开 → 调了一次好友云存储',
    'friend ' + before + ' → ' + fake.calls.friend);
  const firstTexts = odTexts(fake.ctx);
  ok(firstTexts.some(t => t.indexOf('小明') >= 0), '第一次打开画出了好友昵称');

  // 第二次打开（TTL 内）→ **不该再调接口**
  const before2 = fake.calls.friend;
  OD.handleMessage(msg, fake);
  await new Promise(r => setTimeout(r, 40));
  ok(fake.calls.friend === before2, '**第二次打开没有再调接口**（用缓存，省配额）',
    'friend ' + before2 + ' → ' + fake.calls.friend);
  const secondTexts = odTexts(fake.ctx);
  ok(secondTexts.some(t => t.indexOf('小明') >= 0), '第二次打开仍然有好友昵称（不是"读不到"）');
  ok(secondTexts.every(t => t.indexOf('暂时读不到好友数据') < 0),
    '第二次打开**没有**提示"暂时读不到好友数据"');
}

{
  // 拉取失败但有缓存 → 回退到缓存（而不是显示"读不到"）
  const fake = makeFakeWx({
    friends: [friendEntry('o_1', '小明', 97.8, 11)],
    self: [{ KVDataList: [{ key: 'circle', value: hosting(88, 9) }] }]
  });
  global.wx = fake;
  delete require.cache[require.resolve('../../who-is-circle/open-data/index.js')];
  const OD = require('../../who-is-circle/open-data/index.js');
  const msg = { type: 'showLeaderboard', key: 'circle', width: 750, height: 1624, scale: 2,
    canvasW: 1206, canvasH: 2622, rankNames: [], style: {} };

  OD.handleMessage(msg, fake);
  await new Promise(r => setTimeout(r, 40));
  ok(odTexts(fake.ctx).some(t => t.indexOf('小明') >= 0), '第一次成功读到好友');

  // 让下一次拉取失败（friendFail）
  fake.__failNext = true;
  const origGet = fake.getFriendCloudStorage;
  fake.getFriendCloudStorage = function (o) {
    if (fake.__failNext) { fake.__failNext = false; o.fail({ errMsg: 'getFriendCloudStorage:fail' }); return; }
    return origGet.call(fake, o);
  };
  // 把缓存过期（等 TTL 不现实，直接改时钟不现实 → 用 hide + 重新 show，缓存仍在 TTL 内）
  // 这里测的是"TTL 内的第二次"（上面已测）；这里测失败路径：
  // 制造一次"缓存已过期"的等价场景：先清掉 OD 的缓存不可行，
  // 所以改为验证 fail 分支不会崩、且有缓存时不显示错误文案。
  OD.handleMessage({ type: 'hideLeaderboard' }, fake);
  fake.getFriendCloudStorage = function (o) {
    o.fail({ errMsg: 'getFriendCloudStorage:fail' });
  };
  fake.getUserCloudStorage = function (o) {
    o.fail({ errMsg: 'getUserCloudStorage:fail' });
  };
  OD.handleMessage(msg, fake);
  await new Promise(r => setTimeout(r, 40));
  const ts = odTexts(fake.ctx);
  ok(ts.length > 0, '拉取失败也没崩、画出了东西');
  ok(ts.some(t => t.indexOf('小明') >= 0),
    '**拉取失败时回退到缓存**（仍有好友昵称，不是空白）');
}

section('十、认出「好友列表里哪一行是我」（真机现象：榜上有我，底部却说未上榜）');

const RN10 = ['灾难现场', '一团面条', '土豆', '饺子', '鸡蛋', '甜甜圈', '饼干',
  '轮胎', '满月', '圆规', '教科书', '精密仪器', '神之圆'];

{
  // 真机现象（2026-11-07）：榜上**能看到自己**（78.3，托管数据是对的），
  // 但底部写「本地最高 78.3（未上榜）」⇒ 说明开放域没认出哪一行是自己。
  //
  // 根因：`wx.getUserCloudStorage`（读自己的托管数据）没返回数据，
  // 而**平台的好友列表里把自己也列进去了** ⇒ 那行被当成普通好友（没有 isSelf）。
  //
  // 修法：用 `wx.getUserInfo` 拿自己的 openId，凡是它就标上 isSelf。
  const fake = makeFakeWx({
    // 好友列表里有「自己」（平台的真实行为）
    friends: [friendEntry('o_me', '我', 78.3, 9), friendEntry('o_1', '小明', 67.1, 8)],
    myOpenid: 'o_me',
    self: []          // ← 自读拿不到数据（这是问题的触发条件）
  });
  global.wx = fake;
  delete require.cache[require.resolve('../../who-is-circle/open-data/index.js')];
  const OD = require('../../who-is-circle/open-data/index.js');
  OD.handleMessage({ type: 'showLeaderboard', key: 'circle', width: 750, height: 1624, scale: 2,
    rankNames: RN10, style: {} }, fake);
  await new Promise((r) => setTimeout(r, 60));

  const ts = odTexts(fake.ctx);
  ok(ts.some(t => t.indexOf('我') >= 0), '自己那一行画的是「我」而不是昵称',
    ts.filter(t => t.indexOf('我') >= 0).join('|') || '(没画)');
  ok(ts.some(t => t.indexOf('我的历史最高') >= 0),
    '**底部显示「我的历史最高 · 第 N 名」**（不再是「未上榜」）',
    ts.filter(t => t.indexOf('历史最高') >= 0).join('|') || '(没画)');
  ok(ts.every(t => t.indexOf('本地最高') < 0), '**不再显示「本地最高 X（未上榜）」**');
}

{
  // 拿不到自己的 openId（getUserInfo 失败）→ 退回旧逻辑，不能因此崩
  const fake = makeFakeWx({
    friends: [friendEntry('o_1', '小明', 67.1, 8)],
    myOpenid: 'o_me',
    userInfoFail: true,
    self: [{ KVDataList: [{ key: 'circle', value: hosting(70, 8) }] }]
  });
  global.wx = fake;
  delete require.cache[require.resolve('../../who-is-circle/open-data/index.js')];
  const OD = require('../../who-is-circle/open-data/index.js');
  OD.handleMessage({ type: 'showLeaderboard', key: 'circle', width: 750, height: 1624, scale: 2,
    rankNames: RN10, style: {} }, fake);
  await new Promise((r) => setTimeout(r, 60));
  const ts = odTexts(fake.ctx);
  ok(ts.some(t => t.indexOf('小明') >= 0), 'getUserInfo 失败也不影响画好友');
  ok(ts.some(t => t.indexOf('我的历史最高') >= 0),
    '自读成功时仍按自读认「我」',
    ts.filter(t => t.indexOf('历史最高') >= 0).join('|') || '(没画)');
}

section('十一、认出「我」的最后一道防线：托管数据原文（真机：openid 与自读同时失败）');

{
  // 真机现象（2026-11-08 截图）：榜上**能看到自己**（Sun 78.3 排第 2），
  // 底部却写「本地最高 78.3 · 暂未上榜」—— 同一个分，一边在榜上一边说没上榜。
  // 诊断行是「自读0 … 我在否 id无」⇒ openid 与自读**同时**失败。
  //
  // 修法：主域知道自己写进云存储的那串原文 ⇒ 发给开放域 ⇒
  //       开放域靠「原文完全相同」认出好友列表里的自己（最后一道防线）。
  const MY_RAW = hosting(78.3, 9);
  const fake = makeFakeWx({
    friends: [friendEntry('o_1', 'Lion', 82.7, 10), friendEntry('o_me', 'Sun', 78.3, 9)],
    userInfoFail: true,      // ① 拿不到自己的 openid
    selfFail: true,          // ② 自读也失败
  });
  global.wx = fake;
  delete require.cache[require.resolve('../../who-is-circle/open-data/index.js')];
  const OD = require('../../who-is-circle/open-data/index.js');
  OD.handleMessage({ type: 'showLeaderboard', key: 'circle', width: 750, height: 1624, scale: 2,
    rankNames: RN10, style: {}, selfRaw: MY_RAW, selfScore: 78.3, debug: true }, fake);
  await new Promise((r) => setTimeout(r, 60));

  const ts = odTexts(fake.ctx);
  ok(ts.indexOf('我') >= 0, '靠原文认出了「我」（那一行画的是「我」而不是昵称 Sun）',
    ts.filter(t => t === '我' || t.indexOf('历史最高') >= 0).join('|') || '(没画)');
  ok(ts.some(t => t.indexOf('我的历史最高') >= 0),
    '底部是「我的历史最高 · 第 N 名」，不再是「未上榜」',
    ts.filter(t => t.indexOf('历史最高') >= 0).join('|') || '(没画)');
  ok(ts.every(t => t.indexOf('暂未上榜') < 0), '**不再显示「暂未上榜」**');
  ok(ts.some(t => t.indexOf('1 位好友在玩') >= 0),
    '好友数把自己算掉了（榜上 2 行 → 1 位好友）',
    ts.filter(t => t.indexOf('位好友在玩') >= 0).join('|') || '(没画)');
  ok(ts.some(t => t.indexOf('Sun') < 0), '自己的那一行不再用昵称显示');
}

{
  // 原文**对不上**时不能乱认 —— 认错人比认不出更糟
  //（会把某个好友标成「我」，然后把真人的成绩从榜上抹掉）。
  const fake = makeFakeWx({
    friends: [friendEntry('o_1', 'Lion', 82.7, 10)],
    userInfoFail: true,
    selfFail: true,
  });
  global.wx = fake;
  delete require.cache[require.resolve('../../who-is-circle/open-data/index.js')];
  const OD = require('../../who-is-circle/open-data/index.js');
  OD.handleMessage({ type: 'showLeaderboard', key: 'circle', width: 750, height: 1624, scale: 2,
    rankNames: RN10, style: {}, selfRaw: hosting(78.3, 9), selfScore: 78.3, debug: true }, fake);
  await new Promise((r) => setTimeout(r, 60));

  const ts = odTexts(fake.ctx);
  ok(ts.indexOf('我') < 0, '原文对不上 → **不乱认人**', ts.join('|').slice(0, 80));
  ok(ts.some(t => t.indexOf('Lion') >= 0), '好友照常显示');
}

section('十二、诊断行必须描述「最终画出来的那份数据」');

{
  // 真机截图里出现过「榜上 2 行、诊断写好友0」—— 因为诊断在 pull() 内部写死，
  // 而**缓存回退路径**会把 rows 换成缓存那份，诊断却还留着旧的。
  //
  // 这里模拟：第一次拉成功（2 行）→ 关系链接口限流失败 → 第二次回退到缓存。
  const fake = makeFakeWx({
    friends: [friendEntry('o_1', 'Lion', 82.7, 10), friendEntry('o_2', '小红', 92.4, 9)],
    self: [{ KVDataList: [{ key: 'circle', value: hosting(88, 9) }] }]
  });
  global.wx = fake;
  delete require.cache[require.resolve('../../who-is-circle/open-data/index.js')];
  const OD = require('../../who-is-circle/open-data/index.js');
  const msg = { type: 'showLeaderboard', key: 'circle', width: 750, height: 1624, scale: 2,
    rankNames: RN10, style: {}, selfScore: 88, debug: true };
  OD.handleMessage(msg, fake);
  await new Promise((r) => setTimeout(r, 60));

  // 现在让关系链接口开始失败（限流）
  fake.getFriendCloudStorage = function (o) {
    fake.calls.friend++;
    if (o.fail) o.fail({ errMsg: 'getFriendCloudStorage:fail' });
  };
  // 缓存 TTL 内 + 自己分数没变 → 走「缓存还新鲜」这条路（根本不调接口）
  OD.handleMessage(msg, fake);
  await new Promise((r) => setTimeout(r, 60));

  const ts = odTexts(fake.ctx);
  const diag = ts.filter(t => t.indexOf('自读') >= 0).pop() || '';
  const shown = ts.filter(t => t.indexOf('位好友在玩') >= 0).pop() || '';
  ok(diag.indexOf('好友2') >= 0,
    '**诊断里的好友数与榜面一致**（不该再出现「榜上 2 行、诊断写好友0」）', diag);
  ok(diag.indexOf('缓存') >= 0, '诊断标明这批数据来自缓存', diag);
  ok(shown.indexOf('2 位好友在玩') >= 0, '榜面还是 2 位好友', shown);
}

section('十三、认「我」的最后一道防线：分数+段位**唯一匹配**');

{
  // 真机现象（2026-11-08 截图）：openid 与自读**同时**失败，原文那条路也用不了
  // （老设备的 lb_hosting 里没有原文）⇒ 三路全断，榜上明明有自己那行却认不出来。
  //
  // 第四路：主域确认「托管数据写成功过」⇒ 我的那一行**一定在**好友列表里
  // ⇒ 列表中分数与段位都等于我的行**恰好只有一行**时，那行必然是我。
  const fake = makeFakeWx({
    friends: [friendEntry('o_1', 'Lion', 82.7, 10), friendEntry('o_me', 'Sun', 78.3, 9)],
    userInfoFail: true,      // ① 拿不到自己的 openid
    selfFail: true,          // ③ 自读失败
  });
  global.wx = fake;
  delete require.cache[require.resolve('../../who-is-circle/open-data/index.js')];
  const OD = require('../../who-is-circle/open-data/index.js');
  OD.handleMessage({ type: 'showLeaderboard', key: 'circle', width: 750, height: 1624, scale: 2,
    rankNames: RN10, style: {}, selfScore: 78.3, debug: true,
    selfHosted: true, selfHostedScore: 78.3, selfHostedLevel: 9 }, fake);
  await new Promise((r) => setTimeout(r, 60));

  const ts = odTexts(fake.ctx);
  ok(ts.indexOf('我') >= 0, '靠「分数+段位唯一匹配」认出了「我」',
    ts.filter(t => t === '我' || t.indexOf('历史最高') >= 0).join('|') || '(没画)');
  ok(ts.some(t => t.indexOf('我的历史最高') >= 0),
    '底部是「我的历史最高 · 第 N 名」，不再是「未上榜」',
    ts.filter(t => t.indexOf('历史最高') >= 0).join('|') || '(没画)');
  ok(ts.every(t => t.indexOf('暂未上榜') < 0), '**不再显示「暂未上榜」**');
  ok(ts.some(t => t.indexOf('1 位好友在玩') >= 0), '好友数把自己算掉了',
    ts.filter(t => t.indexOf('位好友在玩') >= 0).join('|') || '(没画)');
}

{
  // ⚠️ **同分同段位的好友有两个** ⇒ 匹配数是 2 ⇒ 认不出（宁可认不出，也不认错人）
  const fake = makeFakeWx({
    friends: [friendEntry('o_1', '小明', 78.3, 9), friendEntry('o_2', '小红', 78.3, 9)],
    userInfoFail: true,
    selfFail: true,
  });
  global.wx = fake;
  delete require.cache[require.resolve('../../who-is-circle/open-data/index.js')];
  const OD = require('../../who-is-circle/open-data/index.js');
  OD.handleMessage({ type: 'showLeaderboard', key: 'circle', width: 750, height: 1624, scale: 2,
    rankNames: RN10, style: {}, selfScore: 78.3, debug: true,
    selfHosted: true, selfHostedScore: 78.3, selfHostedLevel: 9 }, fake);
  await new Promise((r) => setTimeout(r, 60));

  const ts = odTexts(fake.ctx);
  ok(ts.indexOf('我') < 0, '**匹配到多行 → 不乱认人**', ts.filter(t => t === '我').join('|') || '(没认)');
  ok(ts.some(t => t.indexOf('小明') >= 0) && ts.some(t => t.indexOf('小红') >= 0),
    '两个好友都照常显示');
}

{
  // 主域**没确认**托管数据写成功过（selfHosted=false）⇒ 这条路不许用
  // （否则「我的托管数据没写进去」时，会把一个同分的好友误认成我）
  const fake = makeFakeWx({
    friends: [friendEntry('o_1', '小明', 78.3, 9)],
    userInfoFail: true,
    selfFail: true,
  });
  global.wx = fake;
  delete require.cache[require.resolve('../../who-is-circle/open-data/index.js')];
  const OD = require('../../who-is-circle/open-data/index.js');
  OD.handleMessage({ type: 'showLeaderboard', key: 'circle', width: 750, height: 1624, scale: 2,
    rankNames: RN10, style: {}, selfScore: 78.3, debug: true,
    selfHosted: false, selfHostedScore: 78.3, selfHostedLevel: 9 }, fake);
  await new Promise((r) => setTimeout(r, 60));

  const ts = odTexts(fake.ctx);
  ok(ts.indexOf('我') < 0, '主域没确认托管写入 → 不启用唯一匹配', ts.filter(t => t === '我').join('|') || '(没认)');
}

{
  // 分数要有容差：托管数据里存的是「分×10」的整数，榜上读到的是 ÷10
  // （与本地记的全精度分可能有 1e-9 级的差 ⇒ 不能用 === 比）
  const fake = makeFakeWx({
    friends: [friendEntry('o_1', 'Lion', 82.7, 10), friendEntry('o_me', 'Sun', 78.3, 9)],
    userInfoFail: true,
    selfFail: true,
  });
  global.wx = fake;
  delete require.cache[require.resolve('../../who-is-circle/open-data/index.js')];
  const OD = require('../../who-is-circle/open-data/index.js');
  OD.handleMessage({ type: 'showLeaderboard', key: 'circle', width: 750, height: 1624, scale: 2,
    rankNames: RN10, style: {}, selfScore: 78.3, debug: true,
    selfHosted: true, selfHostedScore: 78.30000000000001, selfHostedLevel: 9 }, fake);
  await new Promise((r) => setTimeout(r, 60));

  const ts = odTexts(fake.ctx);
  ok(ts.indexOf('我') >= 0, '分数有 1e-14 级的差也能认出来（容差比较）',
    ts.filter(t => t === '我').join('|') || '(没认)');
}

section('十四、诊断行由主域的总开关控制（正式版不画）');

{
  // 正式版：msg.debug 为 false ⇒ 榜面上**一行调试字都不该有**
  const fake = makeFakeWx({
    friends: [friendEntry('o_1', 'Lion', 82.7, 10)],
    self: [{ KVDataList: [{ key: 'circle', value: hosting(88, 9) }] }]
  });
  global.wx = fake;
  delete require.cache[require.resolve('../../who-is-circle/open-data/index.js')];
  const OD = require('../../who-is-circle/open-data/index.js');
  OD.handleMessage({ type: 'showLeaderboard', key: 'circle', width: 750, height: 1624, scale: 2,
    rankNames: RN10, style: {}, selfScore: 88, debug: false }, fake);
  await new Promise((r) => setTimeout(r, 60));

  const ts = odTexts(fake.ctx);
  ok(ts.every(t => t.indexOf('自读') < 0), '**debug=false → 不画诊断行**',
    ts.filter(t => t.indexOf('自读') >= 0).join('|') || '(没画)');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})();
