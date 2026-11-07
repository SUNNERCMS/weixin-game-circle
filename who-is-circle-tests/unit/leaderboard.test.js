/**
 * 主域榜单桥接单元测试（js/leaderboard.js，P4）
 *
 * 这一层只做三件事：
 *   1. 把「样式参数」组装成消息（样式单一来源在主域 —— 设计文档 D9）
 *   2. 把段位名表一起发过去（开放域不能 require 主域的 scoring.js，
 *      自己复制一份必然漂移）
 *   3. 把隐私设置的取值翻译成三态（granted / denied / unset）
 *
 * 纯函数，没有 wx 依赖 → 单测不需要微信环境。
 *
 * 运行：node unit/leaderboard.test.js
 */
const LB = require('../../who-is-circle/js/leaderboard.js');
const Scoring = require('../../who-is-circle/shared/scoring.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')); }
}
function section(title) { console.log('\n========== ' + title + ' =========='); }

section('一、buildStyleParams —— 样式单一来源在主域');

{
  const s = LB.buildStyleParams();
  // 设计文档 §6.4 钉死的值，逐项断言 —— 主域改了这里，开放域的默认就得跟着变
  ok(s.rowH === 96, 'rowH = 96', 'rowH=' + s.rowH);
  ok(s.avatarR === 26, 'avatarR = 26', 'avatarR=' + s.avatarR);
  ok(s.showAvatar === true, 'showAvatar = true');
  ok(s.nameSize === 28, 'nameSize = 28', 'nameSize=' + s.nameSize);
  ok(s.scoreSize === 34, 'scoreSize = 34', 'scoreSize=' + s.scoreSize);
  ok(s.rankSize === 26, 'rankSize = 26', 'rankSize=' + s.rankSize);
  ok(s.colorText === '#2C2C2A', 'colorText = #2C2C2A', s.colorText);
  ok(s.colorDim === '#8C8A82', 'colorDim = #8C8A82', s.colorDim);
  ok(s.colorSelf === '#B4643C', 'colorSelf = #B4643C', s.colorSelf);
  ok(s.colorPanel === '#F7F5F0', 'colorPanel = #F7F5F0', s.colorPanel);
  ok(s.colorLine === '#E3E0D8', 'colorLine = #E3E0D8', s.colorLine);
  ok(s.colorBadge === '#D95F28', 'colorBadge = #D95F28（前三名徽章，沿用主按钮的橙）', s.colorBadge);
  ok(s.colorSelfBg === '#F6E7DA', 'colorSelfBg = #F6E7DA（自己的那行淡底）', s.colorSelfBg);
  ok(s.colorPillBg === '#EDE9E0', 'colorPillBg = #EDE9E0（段位名胶囊底）', s.colorPillBg);
  ok(s.avatarR === 26, 'avatarR = 26（圆头像在 96 行高里刚好）', String(s.avatarR));
  ok(Object.keys(s).length === 14, '样式项不多不少（设计文档 §6.4 的 14 项）', Object.keys(s).length + ' 项');
}
{
  // 每次调用返回新对象 —— 免得主域改了返回值污染后面的消息
  const a = LB.buildStyleParams();
  const b = LB.buildStyleParams();
  ok(a !== b, '每次返回新对象（不是共享引用）');
  a.rowH = 1;
  ok(b.rowH === 96, '改一个不影响另一个');
}

section('二、resolveRankNames —— 段位名表');

{
  const names = LB.resolveRankNames(Scoring.RANKS);
  ok(Array.isArray(names), '返回数组');
  ok(names.length === Scoring.RANKS.length, '长度与段位表一致', names.length + ' vs ' + Scoring.RANKS.length);
  ok(names[0] === '灾难现场', '第一档名对得上', names[0]);
  ok(names[names.length - 1] === '神之圆', '最后一档名对得上', names[names.length - 1]);
  ok(names.every(n => typeof n === 'string' && n.length > 0), '每一项都是非空字符串');
}
{
  ok(Array.isArray(LB.resolveRankNames(null)) && LB.resolveRankNames(null).length === 0,
    '段位表为 null → 空数组（不抛）');
  ok(Array.isArray(LB.resolveRankNames([])) && LB.resolveRankNames([]).length === 0,
    '段位表为空 → 空数组');
}

section('三、buildShowMessage —— 组装给开放域的消息');

{
  const names = LB.resolveRankNames(Scoring.RANKS);
  const msg = LB.buildShowMessage({
    key: 'circle', selfScore: 92.4, selfLevel: 4,
    width: 700, height: 1180, pixelRatio: 2,
    rankNames: names, style: LB.buildStyleParams()
  });
  ok(msg && msg.type === 'showLeaderboard', "type = 'showLeaderboard'", msg && msg.type);
  ok(msg.key === 'circle', 'key 带上了', msg.key);
  ok(msg.selfScore === 92.4, 'selfScore 带上了（兜底用）', String(msg.selfScore));
  ok(msg.selfLevel === 4, 'selfLevel 带上了', String(msg.selfLevel));
  ok(msg.width === 700 && msg.height === 1180, '内容矩形尺寸带上了', msg.width + '×' + msg.height);
  ok(msg.pixelRatio === 2, 'pixelRatio 带上了', String(msg.pixelRatio));
  ok(Array.isArray(msg.rankNames) && msg.rankNames.length === names.length, '段位名表带上了');
  ok(msg.style && msg.style.rowH === 96, '样式参数带上了');
}
{
  // 缺参数 → 用默认值，不能抛（主域漏传一个字段不该让整个榜面挂掉）
  let msg = null, threw = false;
  try { msg = LB.buildShowMessage(); } catch (e) { threw = true; }
  ok(!threw, 'buildShowMessage() 不传参数 → 不抛');
  ok(msg && msg.type === 'showLeaderboard', '仍是一合法的 showLeaderboard 消息');
  ok(msg && msg.key === 'circle', "key 缺省为 'circle'（托管数据的 key）", msg && msg.key);
  ok(msg && msg.width === 700 && msg.height === 1180, '尺寸缺省 700×1180');
  ok(msg && msg.pixelRatio === 2, 'pixelRatio 缺省 2');
  ok(msg && Array.isArray(msg.rankNames) && msg.rankNames.length === 0, '缺 rankNames → 空数组（不抛）');
  ok(msg && msg.style && msg.style.rowH === 96, '缺 style → 用默认样式');
  ok(msg && msg.selfScore === null, '缺 selfScore → null（开放域据此判断「没有本地分」）');
}
{
  const msg = LB.buildShowMessage({ rankNames: ['a', 'b'] });
  ok(msg.rankNames.length === 2, '给了几个就发几个');
  ok(msg.rankNames !== LB.buildShowMessage({ rankNames: ['a', 'b'] }).rankNames,
    'rankNames 不共享引用（免得被改）');
}

section('四、buildHideMessage');

{
  const msg = LB.buildHideMessage();
  ok(msg && msg.type === 'hideLeaderboard', "type = 'hideLeaderboard'", msg && msg.type);
  ok(Object.keys(msg).length === 1, '只有一个字段（不带多余数据）', Object.keys(msg).join(','));
}

section('五、classifyPrivacy —— 隐私设置三态');

{
  ok(LB.classifyPrivacy(true) === 'granted', 'true → granted（已授权，直接拉数据）');
  ok(LB.classifyPrivacy(false) === 'denied', 'false → denied（曾拒绝，只能引导去设置页）');
  ok(LB.classifyPrivacy(undefined) === 'unset', 'undefined → unset（还没决定，要先 authorize）');
  ok(LB.classifyPrivacy(null) === 'unset', 'null → unset');
  ok(LB.classifyPrivacy('true') === 'unset', '非布尔值 → unset（不猜）');
}

section('六、game.js 的榜面接线');

// ---------------------------------------------------------------------------
// 主域这一侧：入口按钮 / overlay 页 / 隐私门禁
// ---------------------------------------------------------------------------

const G = require('../../who-is-circle/game.js');

ok(typeof G.openLeaderboard === 'function', 'game.js 导出 openLeaderboard');
ok(typeof G.closeLeaderboard === 'function', 'game.js 导出 closeLeaderboard');
ok(typeof G.rankPanelLayout === 'function', 'game.js 导出 rankPanelLayout');
ok(typeof G.resendShowOnShow === 'function', 'game.js 导出 resendShowOnShow');

{
  const L = G.rankPanelLayout();
  ok(L.content && L.content.x === 25 && L.content.y === 210 && L.content.w === 700 && L.content.h === 1180,
    '内容矩形 = (25,210,700,1180)', L.content ? JSON.stringify(L.content) : '(无)');
  ok(L.title && L.title.y < L.content.y, '标题在内容矩形上方');
  ok(L.backBtn && (L.backBtn.y - L.backBtn.h / 2) > (L.content.y + L.content.h),
    '底部「返回」按钮不与内容矩形重叠');
  ok(L.backBtn && (L.backBtn.y + L.backBtn.h / 2) <= 1624, '底部按钮在屏幕内');
  ok(G.CFG.RANK_BTN && G.CFG.RANK_BTN.w >= 88 && G.CFG.RANK_BTN.h >= 88,
    '首页入口按钮热区 ≥ 88×88', G.CFG.RANK_BTN ? (G.CFG.RANK_BTN.w + '×' + G.CFG.RANK_BTN.h) : '(无)');
}

function fakeWxApi(opts) {
  opts = opts || {};
  const rec = { messages: [], openSetting: 0, authorize: 0 };
  rec.api = {
    getSetting: function (o) {
      if (opts.getSettingThrows) throw new Error('boom');
      // key 用**真实的 scope 名** —— mock 用假名字的话，
      // 真实代码里 scope 名写错单测也发现不了（这条另有一个读源码的守卫）
      o.success({ authSetting: { 'scope.WxFriendInteraction': opts.auth } });
    },
    authorize: function (o) {
      rec.authorize++;
      if (opts.authorizeFails) o.fail({ errMsg: 'authorize:fail' });
      else o.success({});
    },
    openSetting: function (o) { rec.openSetting++; if (o && o.success) o.success({}); },
    getOpenDataContext: function () {
      return { postMessage: function (m) { rec.messages.push(m); } };
    }
  };
  return rec;
}

function resetState() {
  G.state.trans = null;
  G.state.page = 'home';
  G.state.toast = null;
  G.state.pressedBtn = null;
  G.state.rankPending = false;
}

(async function () {
  section('七、隐私门禁三态');

  {
    // 已授权 → 直接进榜面页 + 发消息
    resetState();
    const rec = fakeWxApi({ auth: true });
    const r = await G.openLeaderboard(rec.api);
    ok(r && r.status === 'opened', '已授权 → opened', r && r.status);
    ok(G.state.trans && G.state.trans.to === 'rank', '切到榜面页');
    ok(rec.messages.length === 1 && rec.messages[0].type === 'showLeaderboard',
      '向开放域发了 showLeaderboard', rec.messages.length + ' 条');
    ok(rec.messages[0].rankNames && rec.messages[0].rankNames.length === 13, '消息里带了段位名表');
    ok(rec.messages[0].style && rec.messages[0].style.rowH === 96, '消息里带了样式参数');
    ok(rec.messages[0].width === 700 && rec.messages[0].height === 1180, '内容矩形尺寸带上了');
    ok(rec.messages[0].key === 'circle', '托管数据 key 带上了', rec.messages[0].key);
  }
  {
    // 曾拒绝 → 不进榜面，引导去设置页
    resetState();
    const rec = fakeWxApi({ auth: false });
    const r = await G.openLeaderboard(rec.api);
    ok(r && r.status === 'denied', '曾拒绝 → denied（不是 opened）', r && r.status);
    ok(!G.state.trans || G.state.trans.to !== 'rank', '不进榜面页');
    ok(rec.openSetting === 1, '引导去设置页（wx.openSetting）', 'openSetting=' + rec.openSetting);
    ok(rec.authorize === 0, '曾拒绝就不该再弹 authorize（会直接失败、吓人）', 'authorize=' + rec.authorize);
    ok(G.state.toast && G.state.toast.text, '给了提示文案', G.state.toast ? G.state.toast.text : '(无)');
  }
  {
    // 还没决定 → 先 authorize
    resetState();
    const rec = fakeWxApi({ auth: undefined });
    const r = await G.openLeaderboard(rec.api);
    ok(rec.authorize === 1, '未决定 → 先 authorize', 'authorize=' + rec.authorize);
    ok(r && r.status === 'opened', 'authorize 成功 → 进榜面', r && r.status);
    ok(G.state.trans && G.state.trans.to === 'rank', '切到榜面页');
  }
  {
    // 还没决定 + authorize 失败 → 引导去设置页
    resetState();
    const rec = fakeWxApi({ auth: undefined, authorizeFails: true });
    const r = await G.openLeaderboard(rec.api);
    ok(r && r.status === 'denied', 'authorize 失败 → denied', r && r.status);
    ok(!G.state.trans || G.state.trans.to !== 'rank', '不进榜面页');
    ok(rec.openSetting === 1, '转去设置页', 'openSetting=' + rec.openSetting);
  }
  {
    // wx 抛异常 → 不崩、不进榜面
    resetState();
    let threw = false, res = null;
    try { res = await G.openLeaderboard(fakeWxApi({ getSettingThrows: true }).api); } catch (e) { threw = true; }
    ok(!threw, 'getSetting 抛异常 → 不崩');
    ok(res && res.status === 'error', '状态是 error', res && res.status);
    ok(!G.state.trans || G.state.trans.to !== 'rank', '不进榜面页');
  }
  {
    // 没有微信环境 → 什么都不做
    resetState();
    let threw = false, res = null;
    try { res = await G.openLeaderboard(null); } catch (e) { threw = true; }
    ok(!threw, '没有 wx → 不崩');
    ok(res && res.status === 'unavailable', '状态是 unavailable', res && res.status);
    ok(!G.state.trans || G.state.trans.to !== 'rank', '不进榜面页（浏览器端没有好友榜）');
  }

  section('八、关闭与补发');

  {
    resetState();
    const rec = fakeWxApi({ auth: true });
    await G.openLeaderboard(rec.api);
    const before = rec.messages.length;
    G.closeLeaderboard(rec.api);
    ok(G.state.trans && G.state.trans.to === 'home', '关闭 → 回首页');
    ok(rec.messages.length === before + 1 && rec.messages[before].type === 'hideLeaderboard',
      '向开放域发了 hideLeaderboard');
  }
  {
    // 共享画布在 onShow / 页面切换后会丢内容 → 主域要补发一次 showLeaderboard
    resetState();
    const rec = fakeWxApi({ auth: true });
    await G.openLeaderboard(rec.api);
    G.state.page = 'rank';
    const before = rec.messages.length;
    const sent = G.resendShowOnShow(rec.api);
    ok(sent === true, '在榜面页 → 补发', String(sent));
    ok(rec.messages.length === before + 1 && rec.messages[before].type === 'showLeaderboard',
      '补发的是 showLeaderboard');
  }
  {
    resetState();
    const rec = fakeWxApi({ auth: true });
    const sent = G.resendShowOnShow(rec.api);
    ok(sent === false, '不在榜面页 → 不补发', String(sent));
    ok(rec.messages.length === 0, '没有消息发出');
  }
section('九、scope 名守卫（写错了功能静默失效，单测发现不了）');

{
  // 这一条是**读源码**的断言，不是行为断言 ——
  // scope 名拼错时，行为单测全绿（mock 用什么 key 都行），但真机上：
  //   wx.authorize 必然失败 → 玩家被引导去设置页
  //   → 而设置页里根本没有「向朋友公开」这一项（从没成功请求过）
  //   → 玩家永远开不了，界面只显示一句「请在设置里开启向朋友公开」
  // 这类"名字写错"只能靠读源码守住。
  const fs = require('fs');
  const path2 = require('path');
  const rawSrc = fs.readFileSync(
    path2.join(__dirname, '../../who-is-circle/game.js'), 'utf8');
  // 剥离注释后再查 —— 注释里会**故意**写出错误的名字当反面教材，
  // 那是给人看的，不该把自己搞红。
  const gameSrc = rawSrc.replace(/\/\*[\s\S]*?\*\//g, ' ')
                       .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');

  ok(gameSrc.indexOf("'scope.WxFriendInteraction'") >= 0,
    'game.js 用的是官方 scope 名 scope.WxFriendInteraction');
  ok(gameSrc.indexOf('scope.friendCloudStorage') < 0,
    '**代码里没有** scope.friendCloudStorage（这个 scope 在官方列表里不存在）');
  ok(gameSrc.indexOf('authSetting[') >= 0 && gameSrc.indexOf('[FRIEND_SCOPE]') >= 0,
    'getSetting 读的是同一个 scope 常量（别一个地方改了一个地方没改）');
}

})().then(function () {
  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
}, function (e) {
  console.error('测试执行出错：', e);
  process.exit(1);
});
