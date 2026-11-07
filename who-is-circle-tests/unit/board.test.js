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
  ok(ts.some(t => t.indexOf('本地最高 77.7（未上榜）') >= 0), '底部写「本地最高 X（未上榜）」', ts.join(' | ').slice(0, 120));
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

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
