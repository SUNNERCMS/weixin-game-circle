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
  ok(s.avatarR === 32, 'avatarR = 32', 'avatarR=' + s.avatarR);
  ok(s.showAvatar === true, 'showAvatar = true');
  ok(s.nameSize === 28, 'nameSize = 28', 'nameSize=' + s.nameSize);
  ok(s.scoreSize === 34, 'scoreSize = 34', 'scoreSize=' + s.scoreSize);
  ok(s.rankSize === 26, 'rankSize = 26', 'rankSize=' + s.rankSize);
  ok(s.colorText === '#2C2C2A', 'colorText = #2C2C2A', s.colorText);
  ok(s.colorDim === '#8C8A82', 'colorDim = #8C8A82', s.colorDim);
  ok(s.colorSelf === '#B4643C', 'colorSelf = #B4643C', s.colorSelf);
  ok(s.colorPanel === '#F7F5F0', 'colorPanel = #F7F5F0', s.colorPanel);
  ok(s.colorLine === '#E3E0D8', 'colorLine = #E3E0D8', s.colorLine);
  ok(Object.keys(s).length === 11, '样式项不多不少（设计文档 §6.4 的 11 项）', Object.keys(s).length + ' 项');
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

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
