/**
 * 开放数据域「榜面纯逻辑」单元测试（open-data/board.js，P4）
 *
 * 为什么要单独测这个文件：
 *   开放数据域是**独立沙盒**，主域 require 不到它、它也 require 不到主域。
 *   如果把解析 / 排序 / 截断 / 绘制全塞在 open-data/index.js 里，
 *   这些逻辑就只能靠真机验 —— 回归套件护不住，改一次就可能悄悄弄坏排序。
 *   所以纯逻辑拆到 open-data/board.js（同目录 require 是平台允许的），
 *   这里用假 ctx 直接断言绘制调用。
 *
 * 运行：node unit/board.test.js   （退出码非 0 = 有用例失败）
 */
const Board = require('../../who-is-circle/open-data/board.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')); }
}

function section(title) { console.log('\n========== ' + title + ' =========='); }

// 假 ctx：记录绘制调用，用来断言"画了什么"
// measureText 的宽度按 当前字号 × 字数 / 2 算 —— 够线性、够确定
function makeCtx() {
  const calls = [];
  const ctx = {
    calls: calls,
    font: '28px sans-serif', fillStyle: '', strokeStyle: '', globalAlpha: 1, lineWidth: 1,
    textAlign: '', textBaseline: '',
    setTransform() {}, save() {}, restore() {}, translate() {}, scale() {},
    beginPath() {}, closePath() {}, fill() {}, stroke() {}, arc() {}, drawImage() {},
    // 真 canvas 有的路径与渐变 API（假 ctx 少了它们，绘制代码一用就 TypeError）
    moveTo() {}, lineTo() {}, arcTo() {}, quadraticCurveTo() {}, rect() {}, clip() {},
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
    setLineDash() {}, shadowBlur: 0, shadowColor: '', shadowOffsetX: 0, shadowOffsetY: 0,
    fillRect(x, y, w, h) { calls.push({ op: 'fillRect', x: x, y: y, w: w, h: h, fillStyle: this.fillStyle }); },
    fillText(t, x, y) { calls.push({ op: 'fillText', t: String(t), x: x, y: y, fillStyle: this.fillStyle, font: this.font }); },
    measureText(t) {
      const m = /(\d+)px/.exec(this.font || '');
      const size = m ? parseInt(m[1], 10) : 28;
      return { width: String(t == null ? '' : t).length * size / 2 };
    }
  };
  return ctx;
}

function texts(ctx) { return ctx.calls.filter(c => c.op === 'fillText').map(c => c.t); }
function findText(ctx, needle) { return ctx.calls.filter(c => c.op === 'fillText' && c.t.indexOf(needle) >= 0); }

// 颜色的相对亮度（0=黑, 1=白）—— 用来断言「胶囊底色随段位单调变深」且「最深处仍够浅」
function luminance(color) {
  let r, g, b;
  if (typeof color === 'string' && color.charAt(0) === '#') {
    const n = parseInt(color.slice(1), 16);
    r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255;
  } else {
    const m = /rgb\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)\)/.exec(color || '');
    if (!m) return 0;
    r = +m[1]; g = +m[2]; b = +m[3];
  }
  const f = c => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

const RANK_NAMES = ['灾难现场', '一团面条', '土豆', '饺子', '鸡蛋', '甜甜圈', '饼干', '轮胎', '满月', '圆规', '教科书', '精密仪器', '神之圆'];

// 托管数据的 value（P3.5 定案）
function hosting(score, level, v) {
  const o = { wxgame: { score: Math.round(score * 10), update_time: 1780000000 }, level: level };
  if (v) o.v = v;
  return JSON.stringify(o);
}
function friend(openid, nickname, score, level, v) {
  return {
    openid: openid,
    nickname: nickname,
    avatarUrl: 'https://wx.qlogo.cn/mmopen/' + openid + '/0',
    KVDataList: [{ key: 'circle', value: hosting(score, level, v) }]
  };
}

section('一、parseHostingValue —— 托管数据解析');

{
  const r = Board.parseHostingValue('{"wxgame":{"score":978},"level":11}');
  ok(r && r.score === 97.8, 'score ÷ 10 = 真实分', r ? 'score=' + r.score : 'null');
  ok(r && r.level === 11, 'level 原样取出', r ? 'level=' + r.level : 'null');
  ok(r && r.verdict === 'ok', 'v 缺失 → 当 ok（P3.5 之前的旧数据）', r ? 'v=' + r.verdict : 'null');
}
{
  const r = Board.parseHostingValue(hosting(90.5, 8, 'unverified'));
  ok(r && r.verdict === 'unverified', "v='unverified' → 原样取出", r ? 'v=' + r.verdict : 'null');
}
{
  ok(Board.parseHostingValue('not json') === null, '非法 JSON → null');
  ok(Board.parseHostingValue('{"level":3}') === null, '缺 wxgame → null');
  ok(Board.parseHostingValue('{"wxgame":{}}') === null, 'wxgame 里没 score → null');
  ok(Board.parseHostingValue('') === null, '空串 → null');
  ok(Board.parseHostingValue(undefined) === null, 'undefined → null');
}
{
  // Review Focus #2：0 分要能解析出来（别用 !score 判断空）；负数/非数 → null
  const zero = Board.parseHostingValue(hosting(0, 0));
  ok(zero && zero.score === 0, 'score = 0 → 合法（0 分也是一行）', zero ? 'score=' + zero.score : 'null');
  const neg = Board.parseHostingValue('{"wxgame":{"score":-10},"level":1}');
  ok(neg === null, '负分 → null（直接跳过该行）');
  const nan = Board.parseHostingValue('{"wxgame":{"score":"abc"},"level":1}');
  ok(nan === null, 'score 不是数字 → null');
}

section('二、normalizeFriendEntry / normalizeSelfEntry');

{
  const r = Board.normalizeFriendEntry(friend('o_1', '小明', 97.8, 11), 'circle');
  ok(r && r.openid === 'o_1', 'openid 取出', r ? r.openid : 'null');
  ok(r && r.nickname === '小明', 'nickname 取出', r ? r.nickname : 'null');
  ok(r && r.score === 97.8, '分取出', r ? 'score=' + r.score : 'null');
  ok(r && r.level === 11, '段位索引取出', r ? 'level=' + r.level : 'null');
  ok(r && r.isSelf === false, '好友行 isSelf=false');
  ok(r && typeof r.avatarUrl === 'string' && r.avatarUrl.length > 0, 'avatarUrl 取出');
}
{
  const r = Board.normalizeSelfEntry({ KVDataList: [{ key: 'circle', value: hosting(88, 9) }] }, 'circle');
  ok(r && r.isSelf === true, '自己那行 isSelf=true');
  ok(r && r.score === 88, '自己的分取出', r ? 'score=' + r.score : 'null');
}
{
  ok(Board.normalizeFriendEntry(friend('o_1', 'x', 90, 5), 'other') === null, 'key 对不上 → null');
  ok(Board.normalizeFriendEntry({ KVDataList: [{ key: 'circle', value: 'garbage' }] }, 'circle') === null,
    'value 解析失败 → null（该好友直接跳过，不占名次）');
  ok(Board.normalizeFriendEntry(null, 'circle') === null, 'entry 为 null → null');
  ok(Board.normalizeFriendEntry({ KVDataList: [] }, 'circle') === null, 'KVDataList 为空 → null');
}

section('三、mergeRows —— 去重 + 排序 + 名次');

{
  const a = Board.normalizeFriendEntry(friend('o_1', '小明', 97.8, 11), 'circle');
  const b = Board.normalizeFriendEntry(friend('o_2', '小红', 92.4, 9), 'circle');
  const c = Board.normalizeFriendEntry(friend('o_3', '小刚', 97.8, 11), 'circle');
  const rows = Board.mergeRows([a, b, c], null);
  ok(rows.length === 3, '三行都在', 'len=' + rows.length);
  ok(rows[0].score === 97.8 && rows[0].rank === 1, '第一名 rank=1', rows[0].rank);
  ok(rows[2].score === 92.4 && rows[2].rank === 3, '最后一名 rank=3', rows[2].rank);
  ok(rows[0].nickname === '小明' && rows[1].nickname === '小刚',
    '同分时按输入顺序稳定（不随机换序）', rows[0].nickname + ' / ' + rows[1].nickname);
}
{
  const a = Board.normalizeFriendEntry(friend('o_1', '小明', 97.8, 11), 'circle');
  const self = Board.normalizeSelfEntry({ KVDataList: [{ key: 'circle', value: hosting(95, 10) }] }, 'circle');
  const rows = Board.mergeRows([a], self);
  ok(rows.length === 2, '自己被并进榜里', 'len=' + rows.length);
  ok(rows[0].rank === 1 && rows[0].nickname === '小明', '自己分低 → 排第 2');
  ok(rows[1].isSelf === true && rows[1].rank === 2, '自己那行 rank 正确', 'rank=' + rows[1].rank);
}
{
  // Review Focus #3：同一个 openid 出现两次 → 只留一条（保留分高的）
  const a1 = Board.normalizeFriendEntry(friend('o_1', '小明', 90, 8), 'circle');
  const a2 = Board.normalizeFriendEntry(friend('o_1', '小明', 97.8, 11), 'circle');
  const rows = Board.mergeRows([a1, a2], null);
  ok(rows.length === 1, '同 openid 只留一行', 'len=' + rows.length);
  ok(rows[0].score === 97.8, '留的是分高的那条', 'score=' + rows[0].score);
}
{
  // 好友列表里混进了自己（平台保证不会有，但要有兜底）：
  // 判据是**托管数据原文完全相同**（同一份写入：同样的分、同样的段位、同样的 update_time）
  const dup = Board.normalizeFriendEntry(friend('o_9', '我', 95, 10), 'circle');
  const self = Board.normalizeSelfEntry({ KVDataList: [{ key: 'circle', value: hosting(95, 10) }] }, 'circle');
  const rows = Board.mergeRows([dup], self);
  ok(rows.length === 1, '自己不会在榜上出现两次（托管数据原文相同 → 视为同一人）', 'len=' + rows.length);
  ok(rows[0].isSelf === true, '留下的是自己那行');
}
{
  // 分相同但托管数据不同（update_time 不同）→ 是两个不同的人，都要留
  const other = Board.normalizeFriendEntry(friend('o_8', '小红', 95, 10), 'circle');
  const self2 = Board.normalizeSelfEntry({ KVDataList: [{ key: 'circle', value: JSON.stringify({ wxgame: { score: 950, update_time: 1780000001 }, level: 10 }) }] }, 'circle');
  const rows2 = Board.mergeRows([other], self2);
  ok(rows2.length === 2, '同分但数据不同 → 两个人都留', 'len=' + rows2.length);
}
{
  const rows = Board.mergeRows([], null);
  ok(Array.isArray(rows) && rows.length === 0, '空输入 → 空数组');
  ok(Array.isArray(Board.mergeRows(null, null)), 'null 输入 → 空数组（不抛）');
}
{
  // ⚠️ **最多删一行** —— 两个好友若在同一秒写出完全相同的托管值，
  //    原文会逐字符相同。把**所有**相同的行都删掉 ⇒ 那位好友的整行
  //    会从榜上**直接消失**（比误认更严重：那是抹掉真人成绩）。
  const same = hosting(95, 10);
  const a = Board.normalizeFriendEntry({ openid: 'o_a', nickname: '小明', KVDataList: [{ key: 'circle', value: same }] }, 'circle');
  const b = Board.normalizeFriendEntry({ openid: 'o_b', nickname: '小红', KVDataList: [{ key: 'circle', value: same }] }, 'circle');
  const self = Board.normalizeSelfEntry({ KVDataList: [{ key: 'circle', value: same }] }, 'circle');
  const rows = Board.mergeRows([a, b], self);
  ok(rows.length === 2, '**好友的整行不会被抹掉**（只删自己那一份，多余的保留）', 'len=' + rows.length);
  ok(rows.filter(r => !r.isSelf).length === 1, '只留下一个好友（不是我）',
    '好友数=' + rows.filter(r => !r.isSelf).length);
  ok(rows.some(r => r.nickname === '小明' || r.nickname === '小红'), '那位好友还在榜上');
}

section('四、truncateText —— 按测量宽度截断');

{
  const ctx = makeCtx();
  ctx.font = '28px sans-serif';
  const short = Board.truncateText(ctx, '小明', 300);
  ok(short === '小明', '本来就放得下 → 原样返回', short);
  const long = Board.truncateText(ctx, '很长很长很长很长很长', 100);
  ok(long.length < '很长很长很长很长很长'.length, '放不下 → 截短', long);
  ok(long.slice(-1) === '…', '以省略号结尾', long);
  ok(ctx.measureText(long).width <= 100, '截断后宽度 ≤ 上限', 'w=' + ctx.measureText(long).width);
  ok(Board.truncateText(ctx, '', 100) === '', '空串 → 空串');
  ok(Board.truncateText(ctx, 'x', 0) === '', '上限为 0 → 空串');
}

section('五、rankNameOf —— 段位名');

{
  ok(Board.rankNameOf(11, RANK_NAMES) === '精密仪器', 'level → 段位名', Board.rankNameOf(11, RANK_NAMES));
  ok(Board.rankNameOf(99, RANK_NAMES) === '段位 ?', '越界 → 兜底', Board.rankNameOf(99, RANK_NAMES));
  ok(Board.rankNameOf(-1, RANK_NAMES) === '段位 ?', '负数 → 兜底');
  ok(Board.rankNameOf(0, []) === '段位 ?', '没有段位名表 → 兜底');
  ok(Board.rankNameOf(undefined, RANK_NAMES) === '段位 ?', 'level 缺失 → 兜底');
}

section('六、clampStyle —— 样式参数钳制');

{
  const s = Board.clampStyle({ rowH: 0, nameSize: 999, colorText: 'red' });
  ok(s.rowH === 96, 'rowH=0 → 默认 96', 'rowH=' + s.rowH);
  ok(s.nameSize === 48, 'nameSize=999 → 钳到上限 48', 'nameSize=' + s.nameSize);
  ok(s.colorText === '#2C2C2A', "colorText='red' → 默认色", s.colorText);
  ok(s.scoreSize === 34, '没传的项用默认值', 'scoreSize=' + s.scoreSize);
  ok(s.showAvatar === true, 'showAvatar 默认 true');
}
{
  const s = Board.clampStyle({ rowH: 500, avatarR: 2, scoreSize: -10 });
  ok(s.rowH === 140, 'rowH=500 → 钳到上限 140', 'rowH=' + s.rowH);
  ok(s.avatarR === 16, 'avatarR=2 → 钳到下限 16', 'avatarR=' + s.avatarR);
  ok(s.scoreSize === 34, 'scoreSize=-10 → 默认', 'scoreSize=' + s.scoreSize);
}
{
  const s = Board.clampStyle(undefined);
  ok(s && s.rowH === 96 && s.colorSelf === '#B4643C', '整个 style 缺失 → 全默认');
  ok(s && s.colorPanel === '#F7F5F0', '默认面板色');
}
{
  const s = Board.clampStyle({ colorText: '#123456' });
  ok(s.colorText === '#123456', '合法颜色原样保留', s.colorText);
  const s2 = Board.clampStyle({ colorText: '#12345' });
  ok(s2.colorText === '#2C2C2A', '长度不对的颜色 → 默认', s2.colorText);
}

section('七、drawBoard —— 画榜');

{
  const rows = [
    { openid: 'o_1', nickname: '小明', avatarUrl: '', score: 97.8, level: 11, verdict: 'ok', isSelf: false, rank: 1 },
    { openid: 'o_2', nickname: '小红', avatarUrl: '', score: 92.4, level: 9, verdict: 'ok', isSelf: false, rank: 2 },
    { openid: 'o_3', nickname: '', avatarUrl: '', score: 95, level: 10, verdict: 'unverified', isSelf: true, rank: 3 }
  ];
  const ctx = makeCtx();
  Board.drawBoard(ctx, rows, { width: 700, height: 1180, style: {}, rankNames: RANK_NAMES });
  const ts = texts(ctx);
  ok(ts.indexOf('1') >= 0 && ts.indexOf('2') >= 0 && ts.indexOf('3') >= 0,
    '名次 1/2/3 都画出来了', ts.slice(0, 6).join(' | '));
  ok(ts.indexOf('97.8') >= 0, '分数按一位小数显示', ts.join(' | ').slice(0, 80));
  ok(ts.some(t => t.indexOf('小红') >= 0), '昵称画出来了');
  ok(ts.some(t => t.indexOf('精密仪器') >= 0), '段位名取自 rankNames');
  ok(ts.some(t => t.indexOf('未完全验证') >= 0), "unverified 的行有「未完全验证」角标");
  ok(ts.indexOf('我') >= 0, '自己的行名字画成「我」（开放域拿不到自己的昵称，但我们知道那是我）',
    ts.filter(t => t === '我').join(' | ') || '(没画)');
  ok(ts.some(t => t.indexOf('我的历史最高 95.0 · 第 3 名') >= 0),
    '底部显示自己的历史最高与名次', ts.filter(t => t.indexOf('我的历史最高') >= 0).join(' | '));
  const selfRow = ctx.calls.filter(c => c.op === 'fillText' && c.t === '我');
  ok(selfRow.length > 0 && selfRow[0].fillStyle === '#B4643C', '自己的行用 colorSelf 高亮',
    selfRow.length ? selfRow[0].fillStyle : '(没画)');
}
{
  // 只有 1 个人 → 不画名次列（设计文档 §十二 风险表）
  const ctx = makeCtx();
  Board.drawBoard(ctx, [{ openid: 'o_1', nickname: '小明', score: 90, level: 8, verdict: 'ok', isSelf: false, rank: 1 }],
    { width: 700, height: 1180, style: {}, rankNames: RANK_NAMES });
  ok(texts(ctx).indexOf('1') < 0, '只有 1 人 → 不画名次列', texts(ctx).join(' | ').slice(0, 60));
}
{
  // 0 个人 → 空态文案，不是空白
  const ctx = makeCtx();
  Board.drawBoard(ctx, [], { width: 700, height: 1180, style: {}, rankNames: RANK_NAMES, emptyText: '还没有好友在玩' });
  ok(texts(ctx).some(t => t.indexOf('还没有好友在玩') >= 0), '0 人 → 画空态文案', texts(ctx).join(' | '));
}
{
  // 自己没上榜（托管数据读不到）→ 用 selfScore 兜底，但不给名次
  const ctx = makeCtx();
  Board.drawBoard(ctx, [{ openid: 'o_1', nickname: '小明', score: 90, level: 8, verdict: 'ok', isSelf: false, rank: 1 }],
    { width: 700, height: 1180, style: {}, rankNames: RANK_NAMES, selfScore: 77.7 });
  const ts = texts(ctx);
  ok(ts.some(t => t.indexOf('本地最高 77.7') >= 0), '底部写「本地最高 X（未上榜）」', ts.join(' | ').slice(0, 120));
  ok(!ts.some(t => t.indexOf('我的历史最高') >= 0), '**不冒充榜上的分**（不写「我的历史最高」）');
}
{
  // 好友太多 → 只画 10 行，但底部要说明还剩多少
  const many = [];
  for (let i = 0; i < 14; i++) {
    many.push({ openid: 'o_' + i, nickname: '好友' + i, score: 90 - i * 0.1, level: 8, verdict: 'ok', isSelf: false, rank: i + 1 });
  }
  const ctx = makeCtx();
  Board.drawBoard(ctx, many, { width: 700, height: 1180, style: {}, rankNames: RANK_NAMES });
  const ts = texts(ctx);
  ok(ts.some(t => t.indexOf('还有 4 位好友在玩') >= 0), '超出 10 行 → 底部说明还剩多少', ts.join(' | ').slice(-60));
  ok(ts.indexOf('10') >= 0 && ts.indexOf('11') < 0, '只画前 10 行');
}
{
  // 头像加载失败 → 兜底（色块 + 昵称首字），不崩、不留白
  const ctx = makeCtx();
  Board.drawBoard(ctx, [{ openid: 'o_1', nickname: '小明', avatarUrl: 'https://wx.qlogo.cn/x', score: 90, level: 8, verdict: 'ok', isSelf: false, rank: 1 }],
    { width: 700, height: 1180, style: {}, rankNames: RANK_NAMES, avatarImages: {} });
  ok(ctx.calls.some(c => c.op === 'fillText' && c.t === '小'), '头像缺失 → 画昵称首字兜底');
  ok(true, '没有图片也没崩（走到这行说明没抛异常）');
}
{
  // 空昵称 → 兜底「微信用户」
  const ctx = makeCtx();
  Board.drawBoard(ctx, [{ openid: 'o_1', nickname: '', score: 90, level: 8, verdict: 'ok', isSelf: false, rank: 1 }],
    { width: 700, height: 1180, style: {}, rankNames: RANK_NAMES });
  ok(texts(ctx).some(t => t.indexOf('微信用户') >= 0), '空昵称 → 「微信用户」', texts(ctx).join(' | ').slice(0, 60));
}
{
  // 尺寸为 0 / ctx 为 null → 不抛
  let threw = false;
  try {
    Board.drawBoard(null, [], {});
    Board.drawBoard(makeCtx(), [], { width: 0, height: 0 });
  } catch (e) { threw = true; }
  ok(!threw, 'ctx 为 null 或尺寸为 0 → 不抛异常');
}

section('十、整屏页的跨机型自适应');

{
  // 榜面页的高度 = 屏幕比例换算出来的设计px，不同机型不一样：
  //   19.5:9 / 20:9（主流）→ 1610~1670 设计px
  //   16:9（iPhone SE / 老安卓）→ **只有 1334**
  // 行高如果写死 108，16:9 机器上 10 行 + 底部那行要 1450+ ⇒ **最后几行被切掉**。
  const pl19 = Board.pageLayout(1631);
  const pl16 = Board.pageLayout(1334);
  const plTab = Board.pageLayout(1024);   // 平板：页面更矮

  ok(pl19.rowH === 108, '主流比例（1631）→ 行高保持 108', String(pl19.rowH));
  ok(pl16.rowH < 108 && pl16.rowH >= 72,
    '16:9（1334）→ 行高自动压缩，不切掉最后几行', String(pl16.rowH));
  // 预留：底部那行 90 + 返回按钮区 140（board.js 的 PAGE.bottomGap / buttonGap）
  ok(pl16.rowTop + 10 * pl16.rowH + 90 + 140 <= 1334,
    '16:9 下 10 行 + 底部 + 按钮区仍放得下',
    String(pl16.rowTop + 10 * pl16.rowH) + ' + 230 ≤ 1334');
  ok(plTab.rowH >= 72, '更矮的页面 → 行高不低于下限 72（不会挤成一团）', String(plTab.rowH));

  // 底部那行必须落在页面内
  ok(pl16.bottomY < 1334, '16:9 下底部那行仍在页面内', String(pl16.bottomY));
  ok(pl19.bottomY < 1631, '主流比例下底部那行在页面内', String(pl19.bottomY));

  // 实际绘制验证：16:9 的页面上，第 10 行与底部那行都要被画出来
  const ctx2 = makeCtx();
  const rows = [];
  for (let i = 0; i < 12; i++) {
    rows.push({ openid: 'o_' + i, nickname: '玩家' + i, score: 90 - i, level: 8,
                verdict: 'ok', isSelf: false, rank: i + 1 });
  }
  Board.drawBoard(ctx2, rows, {
    width: 750, height: 1334, page: true, pageH: 1334, style: {},
    rankNames: ['灾难现场', '一团面条', '土豆', '饺子', '鸡蛋', '甜甜圈', '饼干', '轮胎', '满月', '圆规', '教科书', '精密仪器', '神之圆']
  });
  const ts2 = texts(ctx2);
  ok(ts2.indexOf('玩家9') >= 0, '16:9 上第 10 行仍然画出来了', String(ts2.length) + ' 段文字');
  ok(ts2.some(t => t.indexOf('还有 2 位好友在玩') >= 0),
    '16:9 上「还有 2 位好友在玩」也画出来了');
}

section('十一、不在榜上时，底部那行要说清原因');

{
  // 真机现象（2026-11-07）：本地最高 76.3，榜上第一名才 67.1，
  // 底部却只写「本地最高 76.3（未上榜）」—— 看不出所以然，像功能坏了。
  // 现在按主域传来的云端结论说明原因。
  function drawBottom(opts) {
    const ctx = makeCtx();
    const rows = [{ openid: 'o_1', nickname: '小明', score: 90, level: 8,
                   verdict: 'ok', isSelf: false, rank: 1 }];
    Board.drawBoard(ctx, rows, {
      width: 750, height: 1624, page: true, pageH: 1624, style: {},
      rankNames: RANK_NAMES, selfScore: 76.3,
      lastVerdict: opts.lastVerdict, lastReason: opts.lastReason
    });
    return texts(ctx).filter(t => t.indexOf('本地最高') >= 0)[0] || '(没画)';
  }

  ok(drawBottom({}).indexOf('暂未上榜') >= 0, '没有结论 → 「暂未上榜」',
    drawBottom({}));
  ok(drawBottom({ lastVerdict: 'shadow' }).indexOf('成绩未获认可') >= 0,
    '云端判行为异常 → 「成绩未获认可」', drawBottom({ lastVerdict: 'shadow' }));
  ok(drawBottom({ lastVerdict: 'reject', lastReason: '提交过于频繁，请稍后再试' })
       .indexOf('提交过于频繁') >= 0,
    '云端限流拒绝 → 说明原因（只取第一个分句）',
    drawBottom({ lastVerdict: 'reject', lastReason: '提交过于频繁，请稍后再试' }));
  ok(drawBottom({ lastVerdict: 'unavailable' }).indexOf('云端未达') >= 0,
    '云端不可达 → 「云端未达，暂未上榜」', drawBottom({ lastVerdict: 'unavailable' }));
  ok(drawBottom({ lastVerdict: 'reject', lastReason: '' }).indexOf('成绩未获认可') >= 0,
    '有结论但没原因 → 退到通用说法');
}

section('段位胶囊按段位深浅（13 档全一样 ⇒ 等于没有段位）');

{
  // 为什么要有这个：满月(80+) 与轮胎(70+) 在榜上长得一模一样，
  // 玩家看不出高一档意味着什么。同一色相由浅到深 ⇒ 一眼看出高低，又不引入新色系。
  const st = Board.clampStyle({});
  const n = RANK_NAMES.length;

  const low = Board.rankPillBg(0, RANK_NAMES, st);
  const mid = Board.rankPillBg(7, RANK_NAMES, st);
  const high = Board.rankPillBg(12, RANK_NAMES, st);

  ok(low !== mid && mid !== high, '不同段位的胶囊底色不同', [low, mid, high].join(' / '));
  ok(low === st.colorPillBg, '最低段位保持原底色（不惊动现有视觉）', low);

  // 深浅必须单调：段位越高越**深**（亮度单调下降，不能来回跳）
  const chain = [];
  for (let i = 0; i < n; i++) chain.push(Board.rankPillBg(i, RANK_NAMES, st));
  let monotone = true;
  for (let i = 1; i < chain.length; i++) {
    if (luminance(chain[i]) > luminance(chain[i - 1]) + 0.001) monotone = false;
  }
  ok(monotone, '段位越高胶囊越深（亮度单调下降）', chain[0] + ' → ' + chain[n - 1]);

  ok(luminance(high) > 0.25, '最高段位的底色仍够浅，压得住深色文字',
    high + ' L=' + luminance(high).toFixed(3));

  // 越界/异常输入不能把颜色算坏
  ok(Board.rankPillBg(-1, RANK_NAMES, st) === low, 'level 越界 → 退到最低档');
  ok(Board.rankPillBg(undefined, RANK_NAMES, st) === low, 'level 缺失 → 退到最低档');
  ok(Board.rankPillBg(99, RANK_NAMES, st) === high, 'level 超界 → 钳到最高档');
  ok(Board.rankPillBg(5, [], st) === Board.rankPillBg(5, RANK_NAMES, st),
    '段位名表缺失时按 13 档算（不崩）');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
